import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { CURRENT_SDK_MAJOR } from "../src/types.js";

// Mirrors src/drizzle/schema.ts. drizzle-kit is deliberately not a dependency, so the DDL lives
// here - it MUST be updated in step with the schema when a column or index changes.
const DDL = `
  CREATE TABLE ai_sdk_threads (
    id text PRIMARY KEY,
    user_id text,
    title text,
    visibility text NOT NULL DEFAULT 'private',
    active_leaf_id text,
    metadata jsonb,
    created_at timestamptz(3) NOT NULL DEFAULT now(),
    updated_at timestamptz(3) NOT NULL DEFAULT now()
  );
  CREATE INDEX ai_sdk_threads_user_created_idx
    ON ai_sdk_threads (user_id, created_at, id);

  CREATE TABLE ai_sdk_messages (
    id text PRIMARY KEY,
    thread_id text NOT NULL REFERENCES ai_sdk_threads (id) ON DELETE CASCADE,
    parent_id text,
    role text NOT NULL,
    parts jsonb NOT NULL,
    metadata jsonb,
    sdk_version smallint NOT NULL DEFAULT ${CURRENT_SDK_MAJOR},
    created_at timestamptz(3) NOT NULL DEFAULT now()
  );
  CREATE INDEX ai_sdk_messages_thread_idx ON ai_sdk_messages (thread_id);
`;

/** A fresh in-process Postgres with both tables, isolated per test. */
export async function makeDb() {
  const client = new PGlite();
  try {
    await client.exec(DDL);
  } catch (error) {
    // Otherwise a bad DDL leaks a live Postgres per failed setup, and the caller's afterEach
    // runs against a stale or undefined handle - masking this error with a TypeError.
    await client.close();
    throw error;
  }
  return { db: drizzle(client), close: () => client.close() };
}
