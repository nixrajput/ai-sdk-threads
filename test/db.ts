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
    active_stream_id text,
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
export async function makeDb(options?: { logger?: { logQuery(query: string): void } }) {
  const client = new PGlite();
  try {
    await client.exec(DDL);
  } catch (error) {
    // Otherwise a bad DDL leaks a live Postgres per failed setup, and the caller's afterEach
    // runs against a stale or undefined handle - masking this error with a TypeError.
    await client.close();
    throw error;
  }
  return { db: drizzle(client, options ?? {}), close: () => client.close() };
}

// Mirrors src/sqlite/schema.ts. Integer millisecond timestamps and text-JSON columns are the
// only shape differences; the timestamps are supplied by the schema's $defaultFn, not by SQL.
const SQLITE_DDL = [
  `CREATE TABLE ai_sdk_threads (
    id text PRIMARY KEY,
    user_id text,
    title text,
    visibility text NOT NULL DEFAULT 'private',
    active_leaf_id text,
    active_stream_id text,
    metadata text,
    created_at integer NOT NULL,
    updated_at integer NOT NULL
  )`,
  `CREATE INDEX ai_sdk_threads_user_created_idx ON ai_sdk_threads (user_id, created_at, id)`,
  `CREATE TABLE ai_sdk_messages (
    id text PRIMARY KEY,
    thread_id text NOT NULL REFERENCES ai_sdk_threads (id) ON DELETE CASCADE,
    parent_id text,
    role text NOT NULL,
    parts text NOT NULL,
    metadata text,
    sdk_version integer NOT NULL DEFAULT ${CURRENT_SDK_MAJOR},
    created_at integer NOT NULL
  )`,
  `CREATE INDEX ai_sdk_messages_thread_idx ON ai_sdk_messages (thread_id)`,
];

// A plain ":memory:" database belongs to one connection, and drizzle's transaction opens another -
// which then sees no tables at all. libsql rejects the shared-cache URL form, so each harness gets
// its own temp file and deletes it on close.
let sqliteDatabaseCount = 0;

/** A fresh SQLite database with both tables, isolated per test. */
export async function makeSqliteDb() {
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");
  const { rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const file = join(tmpdir(), `ai-sdk-threads-test-${process.pid}-${++sqliteDatabaseCount}.db`);
  const client = createClient({ url: `file:${file}` });
  const cleanup = async () => {
    client.close();
    await Promise.all(
      [file, `${file}-wal`, `${file}-shm`].map((path) => rm(path, { force: true })),
    );
  };

  try {
    // Off by default in SQLite, and the messages cascade depends on it.
    await client.execute("PRAGMA foreign_keys = ON");
    for (const statement of SQLITE_DDL) await client.execute(statement);
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { db: drizzle(client), close: cleanup };
}
