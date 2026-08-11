import type { UIMessage } from "ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createThreadStore } from "../src/drizzle/index.js";
import { makeDb } from "./db.js";

// An N+1 anywhere moves one of these numbers, and the README's round-trip claims are these numbers.

let queries: string[] = [];
let store: ReturnType<typeof createThreadStore>;
let close: () => Promise<unknown>;

const msg = (id: string, role: "user" | "assistant" = "user"): UIMessage =>
  ({ id, role, parts: [{ type: "text", text: `text of ${id}` }] }) as UIMessage;

async function statements(run: () => Promise<unknown>): Promise<number> {
  queries = [];
  await run();
  return queries.length;
}

// Message ids are a global key, not scoped to the thread, so each thread needs its own prefix.
async function threadOfDepth(depth: number, prefix = "m"): Promise<string> {
  const thread = await store.createThread({ userId: "u1" });
  for (let i = 0; i < depth; i++) {
    await store.appendMessages(thread.id, [
      msg(`${prefix}${i}`, i % 2 === 0 ? "user" : "assistant"),
    ]);
  }
  return thread.id;
}

beforeEach(async () => {
  const ctx = await makeDb({ logger: { logQuery: (query) => queries.push(query) } });
  store = createThreadStore(ctx.db);
  close = ctx.close;
});

afterEach(() => close());

test("every operation costs a fixed number of statements", async () => {
  const id = await threadOfDepth(20);

  expect({
    createThread: await statements(() => store.createThread()),
    getThread: await statements(() => store.getThread(id)),
    listThreads: await statements(() => store.listThreads({ userId: "u1", limit: 20 })),
    loadMessages: await statements(() => store.loadMessages(id)),
    appendMessages: await statements(() => store.appendMessages(id, [msg("new")])),
    getTree: await statements(() => store.getTree(id)),
    siblingsOf: await statements(() => store.siblingsOf(id, "m10")),
    setActiveLeaf: await statements(() => store.setActiveLeaf(id, "m10")),
    regenerateFrom: await statements(() => store.regenerateFrom(id, "m10")),
    forkAt: await statements(() => store.forkAt(id, "m10", [msg("fork")])),
    replaceMessage: await statements(() => store.replaceMessage(id, "m10", msg("m10"))),
  }).toEqual({
    createThread: 1,
    getThread: 1,
    listThreads: 1,
    loadMessages: 2,
    appendMessages: 3,
    getTree: 2,
    siblingsOf: 2,
    setActiveLeaf: 2,
    regenerateFrom: 3,
    forkAt: 4,
    replaceMessage: 6,
  });
});

// The root-to-leaf path is walked in memory (`orderPath`), not with a recursive CTE, so depth
// changes what comes back over the wire but never how many times we ask.
test("loading a thread costs the same at any depth", async () => {
  for (const depth of [1, 50, 500]) {
    const id = await threadOfDepth(depth, `d${depth}-`);
    expect(await statements(() => store.loadMessages(id))).toBe(2);
    expect(await store.loadMessages(id)).toHaveLength(depth);
  }
});
