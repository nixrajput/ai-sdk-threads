import type { UIMessage } from "ai";
import { generateId, validateUIMessages } from "ai";
import { and, desc, eq, lt, or } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { orderPath } from "../chain.js";
import type {
  CreateThreadInput,
  ListThreadsQuery,
  ListThreadsResult,
  StoredMessage,
  Thread,
  ThreadStore,
  UpdateThreadPatch,
} from "../types.js";
import { CURRENT_SDK_MAJOR } from "../types.js";
import { messages, threads } from "./schema.js";

/** Any drizzle Postgres database - node-postgres, postgres.js, Neon, PGlite. */
export type ThreadStoreDatabase = PgDatabase<PgQueryResultHKT>;

const DEFAULT_LIMIT = 20;

const asMetadata = (value: unknown) => value as Record<string, unknown> | null;

const toThread = (row: typeof threads.$inferSelect): Thread => ({
  ...row,
  metadata: asMetadata(row.metadata),
});

const toStoredMessage = (row: typeof messages.$inferSelect): StoredMessage => ({
  ...row,
  parts: row.parts as unknown[],
  metadata: asMetadata(row.metadata),
});

const notFound = (id: string) => new Error(`ai-sdk-threads: thread "${id}" not found`);

// Keyset cursor over (created_at, id). Deliberately not base64: encoding it would need
// either a Node global or the DOM lib, and src/ must typecheck without both.
const encodeCursor = (thread: Thread) => `${thread.createdAt.toISOString()}|${thread.id}`;

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const separator = cursor.indexOf("|");
  const createdAt = separator < 0 ? new Date(Number.NaN) : new Date(cursor.slice(0, separator));
  if (Number.isNaN(createdAt.getTime())) {
    throw new Error(`ai-sdk-threads: malformed listThreads cursor "${cursor}"`);
  }
  return { createdAt, id: cursor.slice(separator + 1) };
}

export function createThreadStore(db: ThreadStoreDatabase): ThreadStore {
  return {
    async createThread(input: CreateThreadInput = {}): Promise<Thread> {
      const [row] = await db
        .insert(threads)
        .values({
          id: input.id ?? generateId(),
          userId: input.userId ?? null,
          title: input.title ?? null,
          metadata: input.metadata ?? null,
        })
        .returning();
      return toThread(row);
    },

    async getThread(id: string): Promise<Thread | null> {
      const [row] = await db.select().from(threads).where(eq(threads.id, id)).limit(1);
      return row ? toThread(row) : null;
    },

    async listThreads(query: ListThreadsQuery = {}): Promise<ListThreadsResult> {
      const limit = query.limit ?? DEFAULT_LIMIT;
      const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
      const filters = [
        query.userId === undefined ? undefined : eq(threads.userId, query.userId),
        cursor === undefined
          ? undefined
          : or(
              lt(threads.createdAt, cursor.createdAt),
              and(eq(threads.createdAt, cursor.createdAt), lt(threads.id, cursor.id)),
            ),
      ].filter((filter) => filter !== undefined);

      // limit + 1 rows: the extra row is how we know another page exists without a count.
      const rows = await db
        .select()
        .from(threads)
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(desc(threads.createdAt), desc(threads.id))
        .limit(limit + 1);

      const page = rows.slice(0, limit).map(toThread);
      const last = page[page.length - 1];
      return {
        threads: page,
        nextCursor: rows.length > limit && last ? encodeCursor(last) : undefined,
      };
    },

    async updateThread(id: string, patch: UpdateThreadPatch): Promise<Thread> {
      const [row] = await db
        .update(threads)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(threads.id, id))
        .returning();
      if (!row) throw notFound(id);
      return toThread(row);
    },

    async deleteThread(id: string): Promise<void> {
      await db.delete(threads).where(eq(threads.id, id));
    },

    async appendMessages(threadId: string, input: UIMessage[]): Promise<StoredMessage[]> {
      if (input.length === 0) return [];
      for (const message of input) {
        // Rows are keyed by message id. The SDK leaves an assistant reply's id empty
        // unless the route passes generateMessageId, and storing "" would collide on
        // the next reply - so refuse here rather than write an unusable row.
        if (!message.id) {
          throw new Error(
            'ai-sdk-threads: message is missing an "id". If this is an assistant reply from ' +
              "toUIMessageStreamResponse, pass generateMessageId so the SDK assigns one.",
          );
        }
      }
      return db.transaction(async (tx) => {
        // FOR UPDATE: two concurrent appends that both read the same leaf would each
        // chain to it and silently fork the thread into two branches.
        const [thread] = await tx
          .select({ activeLeafId: threads.activeLeafId })
          .from(threads)
          .where(eq(threads.id, threadId))
          .limit(1)
          .for("update");
        if (!thread) throw notFound(threadId);

        let parentId = thread.activeLeafId;
        const stored: StoredMessage[] = [];
        for (const message of input) {
          const [row] = await tx
            .insert(messages)
            .values({
              id: message.id,
              threadId,
              parentId,
              role: message.role,
              parts: message.parts,
              metadata: asMetadata(message.metadata ?? null),
              sdkVersion: CURRENT_SDK_MAJOR,
            })
            .returning();
          stored.push(toStoredMessage(row));
          parentId = row.id;
        }

        await tx
          .update(threads)
          .set({ activeLeafId: parentId, updatedAt: new Date() })
          .where(eq(threads.id, threadId));

        return stored;
      });
    },

    async loadMessages(threadId: string): Promise<UIMessage[]> {
      const [thread] = await db
        .select({ activeLeafId: threads.activeLeafId })
        .from(threads)
        .where(eq(threads.id, threadId))
        .limit(1);
      if (!thread) throw notFound(threadId);

      const rows = await db.select().from(messages).where(eq(messages.threadId, threadId));
      const path = orderPath(rows.map(toStoredMessage), thread.activeLeafId);
      // validateUIMessages rejects an empty array, and a thread with no messages yet is
      // the normal state of a freshly created thread - not something to throw over.
      if (path.length === 0) return [];

      return validateUIMessages({
        messages: path.map((row) => ({
          id: row.id,
          role: row.role,
          parts: row.parts,
          ...(row.metadata === null ? {} : { metadata: row.metadata }),
        })),
      });
    },
  };
}
