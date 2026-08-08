import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// Mirrors src/drizzle/schema.ts. drizzle-kit is deliberately not a dependency, so the
// DDL lives here - it MUST be updated in step with the schema when a column changes.
const DDL = `
  CREATE TABLE ai_sdk_threads (
    id text PRIMARY KEY,
    user_id text,
    title text,
    visibility text NOT NULL DEFAULT 'private',
    active_leaf_id text,
    metadata jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX ai_sdk_threads_user_idx ON ai_sdk_threads (user_id);

  CREATE TABLE ai_sdk_messages (
    id text PRIMARY KEY,
    thread_id text NOT NULL REFERENCES ai_sdk_threads (id) ON DELETE CASCADE,
    parent_id text,
    role text NOT NULL,
    parts jsonb NOT NULL,
    metadata jsonb,
    sdk_version smallint NOT NULL DEFAULT 7,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX ai_sdk_messages_thread_idx ON ai_sdk_messages (thread_id);
`;

/** A fresh in-process Postgres with both tables, isolated per test. */
export async function makeDb() {
  const client = new PGlite();
  await client.exec(DDL);
  return { db: drizzle(client), close: () => client.close() };
}
