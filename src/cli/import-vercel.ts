import { sql } from "drizzle-orm";
import { messages, threads } from "../drizzle/schema.js";
import type { ThreadStoreDatabase } from "../drizzle/store.js";
import { migrateParts } from "../migrate.js";
import { CURRENT_SDK_MAJOR } from "../types.js";

// Column mapping taken from the ai-chatbot template's lib/db/schema.ts: `Chat` holds
// (id, createdAt, title, userId, visibility) and `Message_v2` holds
// (id, chatId, role, parts, attachments, createdAt). Its parts are already UIMessage parts, which
// is why an import is a copy plus a parent chain rather than a reshape.

export interface ImportReport {
  threads: number;
  messages: number;
  skippedThreads: number;
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
  options: { dryRun?: boolean; sdkVersion?: number } = {},
): Promise<ImportReport> {
  const dryRun = options.dryRun ?? false;
  const sdkVersion = options.sdkVersion ?? CURRENT_SDK_MAJOR;

  const chats = (await db.execute(
    sql`select "id", "title", "userId", "visibility", "createdAt" from "Chat" order by "createdAt" asc`,
  )) as unknown as { rows?: TemplateChat[] } | TemplateChat[];
  const chatRows: TemplateChat[] = Array.isArray(chats) ? chats : (chats.rows ?? []);

  const report: ImportReport = { threads: 0, messages: 0, skippedThreads: 0, dryRun };

  for (const chat of chatRows) {
    const existing = await db
      .select({ id: threads.id })
      .from(threads)
      .where(sql`${threads.id} = ${chat.id}`)
      .limit(1);
    if (existing.length > 0) {
      report.skippedThreads++;
      continue;
    }

    const raw = (await db.execute(
      sql`select "id", "chatId", "role", "parts", "createdAt" from "Message_v2"
          where "chatId" = ${chat.id} order by "createdAt" asc`,
    )) as unknown as { rows?: TemplateMessage[] } | TemplateMessage[];
    const messageRows: TemplateMessage[] = Array.isArray(raw) ? raw : (raw.rows ?? []);

    report.threads++;
    report.messages += messageRows.length;
    if (dryRun) continue;

    let parentId: string | null = null;
    const rows = messageRows.map((message) => {
      const row = {
        id: message.id,
        threadId: chat.id,
        parentId,
        role: message.role as "system" | "user" | "assistant",
        parts: migrateParts(message.parts as unknown[], sdkVersion),
        metadata: null,
        sdkVersion,
        createdAt: asDate(message.createdAt),
      };
      parentId = message.id;
      return row;
    });

    await db.transaction(async (tx) => {
      await tx.insert(threads).values({
        id: chat.id,
        userId: chat.userId,
        title: chat.title,
        visibility: chat.visibility === "public" ? "public" : "private",
        activeLeafId: parentId,
        createdAt: asDate(chat.createdAt),
      });
      if (rows.length > 0) await tx.insert(messages).values(rows);
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
  return lines.join("\n");
}
