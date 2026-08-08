import { safeValidateUIMessages } from "ai";
import { eq, sql } from "drizzle-orm";
import { messages, threads } from "../drizzle/schema.js";
import type { ThreadStoreDatabase } from "../drizzle/store.js";
import { migrateParts } from "../migrate.js";
import { chainRows } from "../store-core.js";
import { CURRENT_SDK_MAJOR } from "../types.js";

// Column mapping taken from the ai-chatbot template's lib/db/schema.ts: `Chat` holds
// (id, createdAt, title, userId, visibility) and `Message_v2` holds
// (id, chatId, role, parts, attachments, createdAt). Its parts are already UIMessage parts, which
// is why an import is a copy plus a parent chain rather than a reshape.

export interface ImportReport {
  threads: number;
  messages: number;
  skippedThreads: number;
  /** Rows the current SDK cannot read; imported threads never contain them. */
  skippedMessages: { id: string; reason: string }[];
  dryRun: boolean;
}

interface TemplateChat {
  id: string;
  title: string | null;
  userId: string | null;
  visibility: string | null;
  createdAt: Date | string;
}

interface TemplateMessage {
  id: string;
  chatId: string;
  role: string;
  parts: unknown;
  createdAt: Date | string;
}

const asDate = (value: Date | string) => (value instanceof Date ? value : new Date(value));

/**
 * Copies the Vercel ai-chatbot template's tables into this package's. Messages arrive as a flat
 * list ordered by time, so they are linked into the single parent chain this schema expects and the
 * thread's leaf is set to the last one. Threads already present are skipped, which makes a rerun
 * after a partial import safe.
 */
export async function importVercelChat(
  db: ThreadStoreDatabase,
  options: { dryRun?: boolean; sourceSdkVersion?: number } = {},
): Promise<ImportReport> {
  const dryRun = options.dryRun ?? false;
  // Which major WROTE the template rows, which is a different question from what to stamp them
  // with. Imported rows are always stamped as the current major after migrating, so a later
  // `migrate` run cannot mistake them for un-migrated data - and cannot migrate them twice.
  const sourceSdkVersion = options.sourceSdkVersion ?? CURRENT_SDK_MAJOR;

  const chats = (await db.execute(
    sql`select "id", "title", "userId", "visibility", "createdAt" from "Chat" order by "createdAt" asc`,
  )) as unknown as { rows?: TemplateChat[] } | TemplateChat[];
  const chatRows: TemplateChat[] = Array.isArray(chats) ? chats : (chats.rows ?? []);

  const report: ImportReport = {
    threads: 0,
    messages: 0,
    skippedThreads: 0,
    skippedMessages: [],
    dryRun,
  };

  for (const chat of chatRows) {
    const existing = await db
      .select({ id: threads.id })
      .from(threads)
      .where(eq(threads.id, chat.id))
      .limit(1);
    if (existing.length > 0) {
      report.skippedThreads++;
      continue;
    }

    const raw = (await db.execute(
      sql`select "id", "chatId", "role", "parts", "createdAt" from "Message_v2"
          where "chatId" = ${chat.id} order by "createdAt" asc, "id" asc`,
    )) as unknown as { rows?: TemplateMessage[] } | TemplateMessage[];
    const messageRows: TemplateMessage[] = Array.isArray(raw) ? raw : (raw.rows ?? []);

    // Validated before anything is written: this is the one command importing data this package
    // did not create, and an unparseable row would make the imported thread unreadable forever.
    const accepted: { id: string; role: "system" | "user" | "assistant"; parts: unknown[] }[] = [];
    for (const message of messageRows) {
      if (message.role !== "user" && message.role !== "assistant" && message.role !== "system") {
        report.skippedMessages.push({
          id: message.id,
          reason: `unsupported role "${message.role}"`,
        });
        continue;
      }
      let parts: unknown[];
      try {
        parts = migrateParts(message.parts as unknown[], sourceSdkVersion);
      } catch (error) {
        report.skippedMessages.push({
          id: message.id,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const validated = await safeValidateUIMessages({
        messages: [{ id: message.id, role: message.role, parts }],
      });
      if (!validated.success) {
        report.skippedMessages.push({ id: message.id, reason: validated.error.message });
        continue;
      }
      accepted.push({ id: message.id, role: message.role, parts });
    }

    report.threads++;
    report.messages += accepted.length;
    if (dryRun) continue;

    const { rows, leafId } = chainRows(
      chat.id,
      null,
      accepted.map((message) => ({
        id: message.id,
        role: message.role,
        parts: message.parts,
      })) as never,
      CURRENT_SDK_MAJOR,
    );
    const timestamps = new Map(
      messageRows.map((message) => [message.id, asDate(message.createdAt)]),
    );

    await db.transaction(async (tx) => {
      await tx.insert(threads).values({
        id: chat.id,
        userId: chat.userId,
        title: chat.title,
        visibility: chat.visibility === "public" ? "public" : "private",
        activeLeafId: leafId,
        createdAt: asDate(chat.createdAt),
      });
      if (rows.length > 0) {
        await tx
          .insert(messages)
          .values(rows.map((row) => ({ ...row, createdAt: timestamps.get(row.id) })));
      }
    });
  }

  return report;
}

export function formatImportReport(report: ImportReport): string {
  const verb = report.dryRun ? "Would import" : "Imported";
  const lines = [`${verb} ${report.threads} thread(s) and ${report.messages} message(s).`];
  if (report.skippedThreads > 0) {
    lines.push(`Skipped ${report.skippedThreads} thread(s) that already exist.`);
  }
  if (report.skippedMessages.length > 0) {
    lines.push(`Skipped ${report.skippedMessages.length} message(s) the current SDK cannot read:`);
    for (const row of report.skippedMessages.slice(0, 20)) {
      lines.push(`  ${row.id}: ${row.reason.split("\n")[0]}`);
    }
  }
  return lines.join("\n");
}
