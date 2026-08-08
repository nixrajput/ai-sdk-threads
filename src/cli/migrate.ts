import { safeValidateUIMessages } from "ai";
import { and, eq, lt } from "drizzle-orm";
import { messages } from "../drizzle/schema.js";
import type { ThreadStoreDatabase } from "../drizzle/store.js";
import { migrateParts } from "../migrate.js";
import { CURRENT_SDK_MAJOR } from "../types.js";

export interface MigrateReport {
  /** How many rows were written by each older major. */
  scanned: Record<number, number>;
  updated: number;
  /** How many rows a real run would write; excludes the unreadable ones. */
  pending: number;
  /** Rows the current SDK cannot read even after migrating, by message id. */
  unreadable: { id: string; reason: string }[];
  dryRun: boolean;
}

/**
 * Brings every row stamped with an older `ai` major up to the current one, verifying as it goes:
 * each row's parts are migrated, then checked against the SDK's own validator, so the run reports.
 */
export async function migrateDatabase(
  db: ThreadStoreDatabase,
  options: { dryRun?: boolean } = {},
): Promise<MigrateReport> {
  const dryRun = options.dryRun ?? false;
  const rows = await db.select().from(messages).where(lt(messages.sdkVersion, CURRENT_SDK_MAJOR));

  const report: MigrateReport = { scanned: {}, updated: 0, pending: 0, unreadable: [], dryRun };

  const pending: { id: string; parts: unknown[]; changed: boolean }[] = [];
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
    pending.push({ id: row.id, parts, changed: parts !== row.parts });
  }

  if (!dryRun && pending.length > 0) {
    await db.transaction(async (tx) => {
      for (const row of pending) {
        // `parts` is written only when the migration actually changed it. Rewriting an unchanged
        // array would clobber a concurrent edit with content read before that edit happened, and
        // the sdkVersion guard leaves alone a row another run already migrated.
        const patch = row.changed
          ? { parts: row.parts, sdkVersion: CURRENT_SDK_MAJOR }
          : { sdkVersion: CURRENT_SDK_MAJOR };
        await tx
          .update(messages)
          .set(patch)
          .where(and(eq(messages.id, row.id), lt(messages.sdkVersion, CURRENT_SDK_MAJOR)));
      }
    });
  }
  report.pending = pending.length;
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
        ? `Dry run: ${report.pending} would be restamped as ai ${CURRENT_SDK_MAJOR}.`
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
