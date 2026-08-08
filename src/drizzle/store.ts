import type { UIMessage } from "ai";
import { generateId, validateUIMessages } from "ai";
import { and, asc, desc, eq, isNull, lt, ne, or } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { orderPath } from "../chain.js";
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

/** Any drizzle Postgres database: node-postgres, postgres.js, Neon, PGlite. */
export type ThreadStoreDatabase = PgDatabase<PgQueryResultHKT>;

export interface ThreadStoreOptions {
  /**
   * Stamped on written rows. Defaults to 7; set it to 6 when running on `ai` 6.x, or a future
   * migration will read the stamp and apply the wrong transform to these parts.
   */
  sdkVersion?: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const asMetadata = (value: unknown) => value as Record<string, unknown> | null;

const isPlainObject = (value: unknown) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

/** A caller-supplied limit reaches SQL, so 0, a fraction, and a huge value all need bounding. */
function pageLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(requested), 1), MAX_LIMIT);
}

// Keyset cursor over (created_at, id). Deliberately not base64: encoding it would need either a
// Node global or the DOM lib, and src/ must typecheck without both. Lossless only because the
// columns are declared at millisecond precision - see the note in schema.ts.
const encodeCursor = (thread: Thread) => `${thread.createdAt.toISOString()}|${thread.id}`;

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
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
async function forStorage(input: UIMessage[]): Promise<UIMessage[]> {
  for (const message of input) {
    if (!message.id) {
      throw new Error(
        'ai-sdk-threads: message is missing an "id". If this is an assistant reply from ' +
          "toUIMessageStreamResponse, pass generateMessageId so the SDK assigns one.",
      );
    }
    // jsonb would happily store a bare string or number here, which every reader then gets back
    // typed as an object.
    if (message.metadata != null && !isPlainObject(message.metadata)) {
      throw new Error(`ai-sdk-threads: metadata on message "${message.id}" must be an object`);
    }
  }
  return validateUIMessages({ messages: input });
}

const messageNotFound = (threadId: string, id: string) =>
  new Error(`ai-sdk-threads: message "${id}" not found in thread "${threadId}"`);

/** Locks the thread row so concurrent writers cannot both chain to the same leaf. */
async function lockThread(tx: ThreadStoreDatabase, threadId: string) {
  const [thread] = await tx
    .select({ activeLeafId: threads.activeLeafId })
    .from(threads)
    .where(eq(threads.id, threadId))
    .limit(1)
    .for("update");
  if (!thread) throw notFound(threadId);
  return thread;
}

/**
 * Message ids are a global primary key, so every branching entry point resolves them WITH the
 * thread. Looking one up by id alone would let a caller mutate or read another thread's messages.
 */
async function findMessage(db: ThreadStoreDatabase, threadId: string, messageId: string) {
  const [row] = await db
    .select({ threadId: messages.threadId, parentId: messages.parentId, role: messages.role })
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.threadId, threadId)))
    .limit(1);
  if (!row) throw messageNotFound(threadId, messageId);
  return row;
}

/**
 * Writes messages as one chain hanging off `parentId` and moves the thread's active leaf to the
 * last of them. Shared by appendMessages and forkAt, which differ only in where they attach.
 */
async function writeChain(
  tx: ThreadStoreDatabase,
  threadId: string,
  parentId: string | null,
  validated: UIMessage[],
  sdkVersion: number,
): Promise<StoredMessage[]> {
  // Every id is known up front, so the chain is computed here and written in one round-trip
  // rather than holding the lock across one INSERT per message.
  let cursor = parentId;
  const rows = validated.map((message) => {
    const row = {
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

  const returned = await tx.insert(messages).values(rows).returning();
  await tx
    .update(threads)
    .set({ activeLeafId: cursor, updatedAt: new Date() })
    .where(eq(threads.id, threadId));

  // Keyed by id rather than trusting RETURNING's order, which SQL does not guarantee.
  const byId = new Map(returned.map((row) => [row.id, row]));
  return rows.map((row) => {
    const persisted = byId.get(row.id);
    if (!persisted) throw new Error(`ai-sdk-threads: insert did not return message "${row.id}"`);
    return toStoredMessage(persisted);
  });
}

export function createThreadStore(
  db: ThreadStoreDatabase,
  options: ThreadStoreOptions = {},
): ThreadStore & StreamStateStore & BranchingStore {
  const sdkVersion = options.sdkVersion ?? CURRENT_SDK_MAJOR;

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
      const limit = pageLimit(query.limit);
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
      const validated = await forStorage(input);

      return db.transaction(async (tx) => {
        const thread = await lockThread(tx, threadId);
        return writeChain(tx, threadId, thread.activeLeafId, validated, sdkVersion);
      });
    },

    async forkAt(
      threadId: string,
      messageId: string,
      input: UIMessage[],
    ): Promise<StoredMessage[]> {
      if (input.length === 0) return [];
      const validated = await forStorage(input);

      return db.transaction(async (tx) => {
        await lockThread(tx, threadId);
        const target = await findMessage(tx, threadId, messageId);
        // Chained from the target's PARENT, which is what makes this a sibling branch rather than
        // a continuation. The old rows stay put and remain reachable via getTree.
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
        await lockThread(tx, threadId);
        const [current] = await tx
          .select()
          .from(messages)
          .where(and(eq(messages.id, messageId), eq(messages.threadId, threadId)))
          .limit(1);
        if (!current) throw messageNotFound(threadId, messageId);

        // The previous version is copied to a surrogate id, keeping its original timestamp so it
        // sorts first among siblings, and the old replies are moved onto it.
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

        // The row itself keeps its id and takes the new content, so the client's id stays valid.
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
        await lockThread(tx, threadId);
        const target = await findMessage(tx, threadId, messageId);
        // Redoing an assistant turn means answering its parent again; redoing a USER turn means
        // answering that message again, so the leaf lands on the target itself. Moving to the
        // parent in that case would drop the user's own message off the live path.
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
      // Scoped by thread as well as parent: `parent_id IS NULL` alone would match the roots of
      // every other thread too.
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
      // Throws for a missing thread, like every other read here: silently reporting "empty"
      // would let a typo'd id read as a thread with no messages.
      const [thread] = await db
        .select({ id: threads.id })
        .from(threads)
        .where(eq(threads.id, threadId))
        .limit(1);
      if (!thread) throw notFound(threadId);

      const rows = await db.select().from(messages).where(eq(messages.threadId, threadId));
      return rows.map(toStoredMessage);
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
      // Conditional on purpose: a stream finishing after a newer one started must not clear the
      // newer one's id, or the live reply becomes unresumable.
      await db
        .update(threads)
        .set({ activeStreamId: null })
        .where(and(eq(threads.id, threadId), eq(threads.activeStreamId, streamId)));
    },

    async getActiveStream(threadId: string): Promise<string | null> {
      // null rather than a throw for a missing thread, matching getThread: a resume can arrive
      // before the first POST has created the row, and that is "nothing to resume", not an error.
      const [row] = await db
        .select({ activeStreamId: threads.activeStreamId })
        .from(threads)
        .where(eq(threads.id, threadId))
        .limit(1);
      return row?.activeStreamId ?? null;
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
      // validateUIMessages rejects an empty array, which is the normal state of a new thread.
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
