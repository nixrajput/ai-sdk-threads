import type { StoredMessage } from "./types.js";

/**
 * The active conversation of a thread: the path from its active leaf back to the
 * root, returned root-first. Rows form a tree, so siblings off the path are skipped.
 */
export function orderPath(rows: StoredMessage[], activeLeafId: string | null): StoredMessage[] {
  if (activeLeafId === null) return [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const path: StoredMessage[] = [];
  let cursor: string | null = activeLeafId;
  while (cursor !== null) {
    const row = byId.get(cursor);
    if (!row) throw new Error(`ai-sdk-threads: broken message chain at "${cursor}"`);
    path.push(row);
    cursor = row.parentId;
  }
  return path.reverse();
}
