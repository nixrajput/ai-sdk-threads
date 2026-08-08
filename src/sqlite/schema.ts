import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { CURRENT_SDK_MAJOR } from "../types.js";

// The SQLite mirror of src/drizzle/schema.ts: same table and column names, so the store logic and
// every documented query carry over. Two type differences are unavoidable - SQLite has no jsonb
// (text with mode "json") and no timestamptz (integer milliseconds, which is exactly the precision
// the keyset cursor round-trips through a JS Date).

export const threads = sqliteTable(
  "ai_sdk_threads",
  {
    id: text("id").primaryKey(),
    userId: text("user_id"),
    title: text("title"),
    visibility: text("visibility", { enum: ["private", "public"] })
      .notNull()
      .default("private"),
    activeLeafId: text("active_leaf_id"),
    activeStreamId: text("active_stream_id"),
    metadata: text("metadata", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("ai_sdk_threads_user_created_idx").on(t.userId, t.createdAt, t.id)],
);

/** A tree: `parentId` links to the answered message, `threads.activeLeafId` picks the live path. */
export const messages = sqliteTable(
  "ai_sdk_messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    parentId: text("parent_id"),
    role: text("role", { enum: ["system", "user", "assistant"] }).notNull(),
    parts: text("parts", { mode: "json" }).notNull(),
    metadata: text("metadata", { mode: "json" }),
    sdkVersion: integer("sdk_version").notNull().default(CURRENT_SDK_MAJOR),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("ai_sdk_messages_thread_idx").on(t.threadId)],
);
