import type { UIMessage } from "ai";
import { validateUIMessages } from "ai";
import type { StoredMessage } from "./types.js";

// Everything here is dialect-independent: the pieces that are easy to get subtly wrong
// (cursor encoding, limit bounds, write validation, parent linking) are written once and
// shared by the Postgres and SQLite adapters, which differ only in their queries.

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export const notFound = (id: string) => new Error(`ai-sdk-threads: thread "${id}" not found`);

export const messageNotFound = (threadId: string, id: string) =>
  new Error(`ai-sdk-threads: message "${id}" not found in thread "${threadId}"`);

export const asMetadata = (value: unknown) => value as Record<string, unknown> | null;

const isPlainObject = (value: unknown) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Thread metadata needs the same guard message metadata has: the column is json, so a bare string
 * or number stores happily and then comes back typed as an object to every reader.
 */
export function assertThreadMetadata(value: unknown, threadId?: string): void {
  if (value != null && !isPlainObject(value)) {
    const where = threadId === undefined ? "" : ` on thread "${threadId}"`;
    throw new Error(`ai-sdk-threads: thread metadata${where} must be an object`);
  }
}

/** A caller-supplied limit reaches SQL, so 0, a fraction, and a huge value all need bounding. */
export function pageLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(requested), 1), MAX_LIMIT);
}

// Keyset cursor over (created_at, id). Deliberately not base64: encoding it would need either a
// Node global or the DOM lib, and src/ must typecheck without both. Lossless only because the
// columns are declared at millisecond precision - see the note in the schemas.
export const encodeCursor = (thread: { createdAt: Date; id: string }) =>
  `${thread.createdAt.toISOString()}|${thread.id}`;

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const separator = cursor.indexOf("|");
  const createdAt = separator < 0 ? new Date(Number.NaN) : new Date(cursor.slice(0, separator));
  if (Number.isNaN(createdAt.getTime())) {
    throw new Error(`ai-sdk-threads: malformed listThreads cursor "${cursor}"`);
  }
  return { createdAt, id: cursor.slice(separator + 1) };
}

/**
 * Validated on the way IN, not only on the way out: an unparseable row would fail every future
 * load of the thread, so one bad append would make the conversation permanently unreadable.
 */
export async function forStorage(input: UIMessage[]): Promise<UIMessage[]> {
  for (const message of input) {
    if (!message.id) {
      throw new Error(
        'ai-sdk-threads: message is missing an "id". If this is an assistant reply from ' +
          "toUIMessageStreamResponse, pass generateMessageId so the SDK assigns one.",
      );
    }
    // jsonb (or a text-JSON column) would happily store a bare string or number here, which
    // every reader then gets back typed as an object.
    if (message.metadata != null && !isPlainObject(message.metadata)) {
      throw new Error(`ai-sdk-threads: metadata on message "${message.id}" must be an object`);
    }
  }
  return validateUIMessages({ messages: input });
}

export interface MessageRowInput {
  id: string;
  threadId: string;
  parentId: string | null;
  role: "system" | "user" | "assistant";
  parts: unknown;
  metadata: Record<string, unknown> | null;
  sdkVersion: number;
}

/**
 * Turns validated messages into rows linked as one chain hanging off `parentId`, and reports the
 * id that becomes the thread's new leaf. Ids are known up front, so callers write one round-trip.
 */
export function chainRows(
  threadId: string,
  parentId: string | null,
  validated: UIMessage[],
  sdkVersion: number,
): { rows: MessageRowInput[]; leafId: string | null } {
  let cursor = parentId;
  const rows = validated.map((message) => {
    const row: MessageRowInput = {
      id: message.id,
      threadId,
      parentId: cursor,
      role: message.role,
      parts: message.parts,
      metadata: asMetadata(message.metadata ?? null),
      sdkVersion,
    };
    cursor = message.id;
    return row;
  });
  return { rows, leafId: cursor };
}

/** Keyed by id rather than trusting RETURNING's order, which SQL does not guarantee. */
export function inOrder<T extends { id: string }>(
  wanted: { id: string }[],
  returned: T[],
  toStored: (row: T) => StoredMessage,
): StoredMessage[] {
  const byId = new Map(returned.map((row) => [row.id, row]));
  return wanted.map((row) => {
    const persisted = byId.get(row.id);
    if (!persisted) throw new Error(`ai-sdk-threads: insert did not return message "${row.id}"`);
    return toStored(persisted);
  });
}
