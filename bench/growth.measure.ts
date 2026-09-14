// What do abandoned branches cost a read? Backs the pruneBranches docs.
//
//   npx tsx bench/growth.measure.ts
//   TURNS=25 REGENERATIONS=20 EDIT_AT=5 npx tsx bench/growth.measure.ts
//
// loadMessages runs two queries at any depth, but the second fetches every row in the thread and
// walks the path in memory - so the query count is flat while the payload is not. This measures the
// gap between rows fetched and rows used as a thread accumulates branches.
import type { UIMessage } from "ai";
import { createThreadStore } from "../src/sqlite/index.js";
import { CURRENT_SDK_MAJOR } from "../src/types.js";

const TURNS = Number(process.env.TURNS ?? 25);
const REGENERATIONS = Number(process.env.REGENERATIONS ?? 20);
const EDIT_AT = Number(process.env.EDIT_AT ?? 5);

const DDL = [
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

const msg = (id: string, role: "user" | "assistant", text: string): UIMessage =>
  ({ id, role, parts: [{ type: "text", text }] }) as UIMessage;

async function main(): Promise<void> {
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");
  const { rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const file = join(tmpdir(), `ai-sdk-threads-growth-${process.pid}.db`);
  const client = createClient({ url: `file:${file}` });
  await client.execute("PRAGMA foreign_keys = ON");
  for (const statement of DDL) await client.execute(statement);

  const store = createThreadStore(drizzle(client));
  const id = "growth";
  await store.createThread({ id });

  const report = async (label: string) => {
    const [path, tree] = await Promise.all([store.loadMessages(id), store.getTree(id)]);
    const ratio = path.length === 0 ? 0 : tree.length / path.length;
    console.log(
      `${label.padEnd(36)} live ${String(path.length).padStart(3)}` +
        `  stored ${String(tree.length).padStart(3)}` +
        `  fetched-to-used ${ratio.toFixed(2)}x`,
    );
  };

  for (let i = 0; i < TURNS; i++) {
    await store.appendMessages(id, [msg(`u${i}`, "user", `question ${i}`)]);
    await store.appendMessages(id, [msg(`a${i}`, "assistant", `answer ${i}`)]);
  }
  await report(`${TURNS} turns, never branched`);

  const last = `a${TURNS - 1}`;
  for (let i = 0; i < REGENERATIONS; i++) {
    await store.regenerateFrom(id, last);
    await store.appendMessages(id, [msg(`${last}-r${i}`, "assistant", `retry ${i}`)]);
  }
  await report(`after ${REGENERATIONS} regenerations of the last answer`);

  await store.replaceMessage(id, `u${EDIT_AT}`, msg(`u${EDIT_AT}`, "user", "rewritten"));
  await store.appendMessages(id, [msg("edit-answer", "assistant", "fresh answer")]);
  await report(`after editing question ${EDIT_AT}`);

  const pruned = await store.pruneBranches(id);
  await report(`after pruneBranches (${pruned.length} rows dropped)`);

  client.close();
  await Promise.all([file, `${file}-wal`, `${file}-shm`].map((p) => rm(p, { force: true })));
}

await main();
