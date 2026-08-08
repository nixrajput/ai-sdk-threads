import type { StoredMessage } from "./types.js";

/** The path from a thread's active leaf back to the root, root-first; siblings are skipped. */
export function orderPath(rows: StoredMessage[], activeLeafId: string | null): StoredMessage[] {
  if (activeLeafId === null) return [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const path: StoredMessage[] = [];
  const seen = new Set<string>();
  let cursor: string | null = activeLeafId;
  while (cursor !== null) {
    // parent_id carries no foreign key and no cycle constraint, and rows can be written by
    // hand, so a cycle is reachable - without this it would spin until the process died.
    if (seen.has(cursor)) {
      throw new Error(`ai-sdk-threads: message chain cycles at "${cursor}"`);
    }
    seen.add(cursor);
    const row = byId.get(cursor);
    if (!row) throw new Error(`ai-sdk-threads: broken message chain at "${cursor}"`);
    path.push(row);
    cursor = row.parentId;
  }
  return path.reverse();
}
