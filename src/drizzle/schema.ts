import { index, jsonb, pgTable, smallint, text, timestamp } from "drizzle-orm/pg-core";
import { CURRENT_SDK_MAJOR } from "../types.js";

// Table names are prefixed `ai_sdk_` because these land in the consumer's own
// database, next to their application tables.

export const threads = pgTable(
  "ai_sdk_threads",
  {
    id: text("id").primaryKey(),
    userId: text("user_id"),
    title: text("title"),
    visibility: text("visibility", { enum: ["private", "public"] })
      .notNull()
      .default("private"),
    activeLeafId: text("active_leaf_id"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ai_sdk_threads_user_idx").on(t.userId)],
);

/**
 * Messages form a tree: `parentId` links a message to the one it answers, and the
 * thread's `activeLeafId` selects which path through that tree is the live conversation.
 */
export const messages = pgTable(
  "ai_sdk_messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    parentId: text("parent_id"),
    role: text("role", { enum: ["system", "user", "assistant"] }).notNull(),
    parts: jsonb("parts").notNull(),
    metadata: jsonb("metadata"),
    sdkVersion: smallint("sdk_version").notNull().default(CURRENT_SDK_MAJOR),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ai_sdk_messages_thread_idx").on(t.threadId)],
);
