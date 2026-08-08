import type { StoredMessage } from "./types.js";

/** The path from a thread's active leaf back to the root, root-first; siblings are skipped. */
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
