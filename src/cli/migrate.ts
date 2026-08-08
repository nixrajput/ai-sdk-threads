import { safeValidateUIMessages } from "ai";
import { eq, lt } from "drizzle-orm";
import { messages } from "../drizzle/schema.js";
import type { ThreadStoreDatabase } from "../drizzle/store.js";
import { migrateParts } from "../migrate.js";
import { CURRENT_SDK_MAJOR } from "../types.js";

export interface MigrateReport {
  /** How many rows were written by each older major. */
  scanned: Record<number, number>;
  updated: number;
  /** Rows the current SDK cannot read even after migrating, by message id. */
  unreadable: { id: string; reason: string }[];
  dryRun: boolean;
}

/**
 * Brings every row stamped with an older `ai` major up to the current one, verifying as it goes:
 * each row's parts are migrated, then checked against the SDK's own validator, so the run reports
 * what is actually readable rather than only what it rewrote. Nothing is written on a dry run, and
 * the whole pass is one transaction so a failure leaves the table as it was.
 */
export async function migrateDatabase(
  db: ThreadStoreDatabase,
  options: { dryRun?: boolean } = {},
): Promise<MigrateReport> {
  const dryRun = options.dryRun ?? false;
  const rows = await db.select().from(messages).where(lt(messages.sdkVersion, CURRENT_SDK_MAJOR));

  const report: MigrateReport = { scanned: {}, updated: 0, unreadable: [], dryRun };

  const pending: { id: string; parts: unknown[] }[] = [];
  for (const row of rows) {
    report.scanned[row.sdkVersion] = (report.scanned[row.sdkVersion] ?? 0) + 1;

    let parts: unknown[];
    try {
      parts = migrateParts(row.parts as unknown[], row.sdkVersion);
    } catch (error) {
      report.unreadable.push({
        id: row.id,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    // Verified before it is written: a row the current SDK cannot parse would break every later
    // load of its thread, and reporting it is more useful than restamping it as if it were fine.
    const validated = await safeValidateUIMessages({
      messages: [{ id: row.id, role: row.role, parts }],
    });
    if (!validated.success) {
      report.unreadable.push({ id: row.id, reason: validated.error.message });
      continue;
    }
    pending.push({ id: row.id, parts });
  }

  if (!dryRun && pending.length > 0) {
    await db.transaction(async (tx) => {
      for (const row of pending) {
        await tx
          .update(messages)
          .set({ parts: row.parts, sdkVersion: CURRENT_SDK_MAJOR })
          .where(eq(messages.id, row.id));
      }
    });
  }
  report.updated = dryRun ? 0 : pending.length;
  return report;
}

export function formatMigrateReport(report: MigrateReport): string {
  const lines: string[] = [];
  const scanned = Object.entries(report.scanned).sort(([a], [b]) => Number(a) - Number(b));
  if (scanned.length === 0) {
    lines.push(`Nothing to migrate: every row is already stamped ai ${CURRENT_SDK_MAJOR}.`);
  } else {
    for (const [major, count] of scanned) {
      lines.push(`  ai ${major}: ${count} message${count === 1 ? "" : "s"}`);
    }
    lines.push(
      report.dryRun
        ? `Dry run: ${scanned.reduce((n, [, c]) => n + c, 0)} would be restamped as ai ${CURRENT_SDK_MAJOR}.`
        : `Restamped ${report.updated} message${report.updated === 1 ? "" : "s"} as ai ${CURRENT_SDK_MAJOR}.`,
    );
  }
  if (report.unreadable.length > 0) {
    lines.push(`${report.unreadable.length} message(s) the current SDK cannot read:`);
    for (const row of report.unreadable.slice(0, 20)) {
      lines.push(`  ${row.id}: ${row.reason.split("\n")[0]}`);
    }
  }
  return lines.join("\n");
}
