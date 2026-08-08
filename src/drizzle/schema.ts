import { index, jsonb, pgTable, smallint, text, timestamp } from "drizzle-orm/pg-core";
import { CURRENT_SDK_MAJOR } from "../types.js";

// Prefixed `ai_sdk_`: these land in the consumer's own database beside their app tables.

// Millisecond precision, deliberately: listThreads' keyset cursor carries created_at through a
// JS Date, which cannot hold Postgres' default microseconds. At the default precision the
// cursor rounds down and the page after it silently skips every row sharing that millisecond.
const TIMESTAMP_PRECISION = 3;

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
    activeStreamId: text("active_stream_id"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true, precision: TIMESTAMP_PRECISION })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: TIMESTAMP_PRECISION })
      .notNull()
      .defaultNow(),
  },
  // Ordered to match listThreads' keyset page exactly, so the ORDER BY is served by the index
  // instead of sorting the user's whole thread set per page. Postgres scans it backwards for
  // the DESC direction, so no descending index is needed. It also serves plain user_id lookups.
  (t) => [index("ai_sdk_threads_user_created_idx").on(t.userId, t.createdAt, t.id)],
);

/** A tree: `parentId` links to the answered message, `threads.activeLeafId` picks the live path. */
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
    createdAt: timestamp("created_at", { withTimezone: true, precision: TIMESTAMP_PRECISION })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("ai_sdk_messages_thread_idx").on(t.threadId)],
);
