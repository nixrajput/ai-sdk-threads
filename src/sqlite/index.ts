import type { UIMessage } from "ai";
import { generateId, validateUIMessages } from "ai";
import { and, asc, desc, eq, isNull, ne, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { orderPath } from "../chain.js";
import { migrateParts } from "../migrate.js";
import {
  asMetadata,
  assertThreadMetadata,
  chainRows,
  decodeCursor,
  encodeCursor,
  forStorage,
  inOrder,
  messageNotFound,
  notFound,
  pageLimit,
} from "../store-core.js";
import type {
  BranchingStore,
  CreateThreadInput,
  ListThreadsQuery,
  ListThreadsResult,
  StoredMessage,
  StreamStateStore,
  Thread,
  ThreadStore,
  UpdateThreadPatch,
} from "../types.js";
import { CURRENT_SDK_MAJOR } from "../types.js";
import { messages, threads } from "./schema.js";

export { messages, threads } from "./schema.js";

/**
 * A drizzle SQLite database on an **async** driver - libsql is what CI runs. Writes use
 * interactive transactions with an async callback, which better-sqlite3 rejects outright, Bun's
 * driver does not await, and D1 does not support at all.
 */
export type SqliteThreadStoreDatabase = BaseSQLiteDatabase<"sync" | "async", unknown>;

export interface SqliteThreadStoreOptions {
  /**
   * Stamped on written rows. Defaults to 7; set it to 6 when running on `ai` 6.x, or a future
   * migration will read the stamp and apply the wrong transform to these parts.
   */
  sdkVersion?: number;
}

const toThread = (row: typeof threads.$inferSelect): Thread => ({
  ...row,
  metadata: asMetadata(row.metadata),
});

const toStoredMessage = (row: typeof messages.$inferSelect): StoredMessage => ({
  ...row,
  parts: row.parts as unknown[],
  metadata: asMetadata(row.metadata),
});

/**
 * SQLite has no `SELECT ... FOR UPDATE` and needs none: libsql's default transaction mode is
 * "write", which emits BEGIN IMMEDIATE and takes the write lock up front, serialising concurrent
 * appends the way Postgres's FOR UPDATE does. On a driver that begins deferred, this would race.
 */
async function readThread(db: SqliteThreadStoreDatabase, threadId: string) {
  const [thread] = await db
    .select({ activeLeafId: threads.activeLeafId })
    .from(threads)
    .where(eq(threads.id, threadId))
    .limit(1);
  if (!thread) throw notFound(threadId);
  return thread;
}

async function findMessage(db: SqliteThreadStoreDatabase, threadId: string, messageId: string) {
  const [row] = await db
    .select({ threadId: messages.threadId, parentId: messages.parentId, role: messages.role })
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.threadId, threadId)))
    .limit(1);
  if (!row) throw messageNotFound(threadId, messageId);
  return row;
}

async function writeChain(
  tx: SqliteThreadStoreDatabase,
  threadId: string,
  parentId: string | null,
  validated: UIMessage[],
  sdkVersion: number,
): Promise<StoredMessage[]> {
  const { rows, leafId } = chainRows(threadId, parentId, validated, sdkVersion);
  const returned = await tx.insert(messages).values(rows).returning();
  await tx
    .update(threads)
    .set({ activeLeafId: leafId, updatedAt: new Date() })
    .where(eq(threads.id, threadId));
  return inOrder(rows, returned, toStoredMessage);
}

/** The same `ThreadStore` contract as the Postgres adapter, over a drizzle SQLite database. */
export function createThreadStore(
  db: SqliteThreadStoreDatabase,
  options: SqliteThreadStoreOptions = {},
): ThreadStore & StreamStateStore & BranchingStore {
  const sdkVersion = options.sdkVersion ?? CURRENT_SDK_MAJOR;

  return {
    async createThread(input: CreateThreadInput = {}): Promise<Thread> {
      assertThreadMetadata(input.metadata);
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
      const limit = pageLimit(query.limit);
      const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
      const filters = [
        query.userId === undefined ? undefined : eq(threads.userId, query.userId),
        cursor === undefined
          ? undefined
          : // A row-value comparison, not the OR form it replaces: only this shape becomes an index
            // bound, so a deep page stays O(limit). The OR form is an index *filter* - SQLite
            // scans the user's range from the top and discards, measured at 9.2ms with 50,000 rows
            // before the cursor against 0.01ms here (bench/paging.measure.ts).
            sql`(${threads.createdAt}, ${threads.id}) < (${cursor.createdAt.getTime()}, ${cursor.id})`,
      ].filter((filter) => filter !== undefined);

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
      assertThreadMetadata(patch.metadata, id);
      const [row] = await db
        .update(threads)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(threads.id, id))
        .returning();
      if (!row) throw notFound(id);
      return toThread(row);
    },

    async deleteThread(id: string): Promise<void> {
      // Messages are deleted explicitly rather than by cascade: SQLite has foreign keys OFF by
      // default per connection, so relying on it would silently leave the conversation on disk.
      await db.transaction(async (tx) => {
        await tx.delete(messages).where(eq(messages.threadId, id));
        await tx.delete(threads).where(eq(threads.id, id));
      });
    },

    async appendMessages(threadId: string, input: UIMessage[]): Promise<StoredMessage[]> {
      if (input.length === 0) return [];
      const validated = await forStorage(input);
      return db.transaction(async (tx) => {
        const thread = await readThread(tx, threadId);
        return writeChain(tx, threadId, thread.activeLeafId, validated, sdkVersion);
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
      if (path.length === 0) return [];

      return validateUIMessages({
        // Parts pass through migrateParts on the way out, keyed by the major that wrote each row.
        // It is a no-op today; wiring it here means a thread mixing majors stays readable through
        // the supported API rather than only for consumers who query the tables themselves.
        messages: path.map((row) => ({
          id: row.id,
          role: row.role,
          parts: migrateParts(row.parts, row.sdkVersion),
          ...(row.metadata === null ? {} : { metadata: row.metadata }),
        })),
      });
    },

    async setActiveStream(threadId: string, streamId: string): Promise<void> {
      const [row] = await db
        .update(threads)
        .set({ activeStreamId: streamId })
        .where(eq(threads.id, threadId))
        .returning({ id: threads.id });
      if (!row) throw notFound(threadId);
    },

    async clearActiveStream(threadId: string, streamId: string): Promise<void> {
      await db
        .update(threads)
        .set({ activeStreamId: null })
        .where(and(eq(threads.id, threadId), eq(threads.activeStreamId, streamId)));
    },

    async getActiveStream(threadId: string): Promise<string | null> {
      const [row] = await db
        .select({ activeStreamId: threads.activeStreamId })
        .from(threads)
        .where(eq(threads.id, threadId))
        .limit(1);
      return row?.activeStreamId ?? null;
    },

    async forkAt(
      threadId: string,
      messageId: string,
      input: UIMessage[],
    ): Promise<StoredMessage[]> {
      if (input.length === 0) return [];
      const validated = await forStorage(input);
      return db.transaction(async (tx) => {
        await readThread(tx, threadId);
        const target = await findMessage(tx, threadId, messageId);
        return writeChain(tx, threadId, target.parentId, validated, sdkVersion);
      });
    },

    async replaceMessage(
      threadId: string,
      messageId: string,
      message: UIMessage,
    ): Promise<StoredMessage> {
      const [validated] = await forStorage([message]);
      if (!validated) throw new Error("ai-sdk-threads: no message to store");

      return db.transaction(async (tx) => {
        await readThread(tx, threadId);
        const [current] = await tx
          .select()
          .from(messages)
          .where(and(eq(messages.id, messageId), eq(messages.threadId, threadId)))
          .limit(1);
        if (!current) throw messageNotFound(threadId, messageId);
        // A replacement may not change a row's role, so a caller cannot rewrite an assistant or
        // system turn by submitting it as a user message.
        if (current.role !== validated.role) {
          throw new Error(
            `ai-sdk-threads: cannot replace a "${current.role}" message with a "${validated.role}" one`,
          );
        }

        const archiveId = generateId();
        await tx.insert(messages).values({ ...current, id: archiveId });
        await tx
          .update(messages)
          .set({ parentId: archiveId })
          .where(
            and(
              eq(messages.threadId, threadId),
              eq(messages.parentId, messageId),
              ne(messages.id, archiveId),
            ),
          );

        const [updated] = await tx
          .update(messages)
          .set({
            parts: validated.parts,
            metadata: asMetadata(validated.metadata ?? null),
            sdkVersion,
            createdAt: new Date(),
          })
          .where(eq(messages.id, messageId))
          .returning();
        if (!updated) throw messageNotFound(threadId, messageId);

        await tx
          .update(threads)
          .set({ activeLeafId: messageId, updatedAt: new Date() })
          .where(eq(threads.id, threadId));

        return toStoredMessage(updated);
      });
    },

    async regenerateFrom(threadId: string, messageId: string): Promise<{ leafId: string | null }> {
      return db.transaction(async (tx) => {
        await readThread(tx, threadId);
        const target = await findMessage(tx, threadId, messageId);
        const leafId = target.role === "assistant" ? target.parentId : messageId;
        await tx
          .update(threads)
          .set({ activeLeafId: leafId, updatedAt: new Date() })
          .where(eq(threads.id, threadId));
        return { leafId };
      });
    },

    async siblingsOf(
      threadId: string,
      messageId: string,
    ): Promise<{ siblings: StoredMessage[]; index: number }> {
      const target = await findMessage(db, threadId, messageId);
      const rows = await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.threadId, threadId),
            target.parentId === null
              ? isNull(messages.parentId)
              : eq(messages.parentId, target.parentId),
          ),
        )
        .orderBy(asc(messages.createdAt), asc(messages.id));

      const siblings = rows.map(toStoredMessage);
      return { siblings, index: siblings.findIndex((row) => row.id === messageId) };
    },

    async setActiveLeaf(threadId: string, messageId: string): Promise<void> {
      await findMessage(db, threadId, messageId);
      await db
        .update(threads)
        .set({ activeLeafId: messageId, updatedAt: new Date() })
        .where(eq(threads.id, threadId));
    },

    async getTree(threadId: string): Promise<StoredMessage[]> {
      const [thread] = await db
        .select({ id: threads.id })
        .from(threads)
        .where(eq(threads.id, threadId))
        .limit(1);
      if (!thread) throw notFound(threadId);

      const rows = await db.select().from(messages).where(eq(messages.threadId, threadId));
      return rows.map(toStoredMessage);
    },
  };
}
