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
    updateThread: await statements(() => store.updateThread(id, { title: "renamed" })),
    // Last: the cascade takes its own messages with it.
    deleteThread: await statements(() => store.deleteThread(id)),
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
    updateThread: 1,
    deleteThread: 1,
  });
});

// The count is not the whole story: `a < x OR (a = x AND b < y)` costs one statement too, but it is
// an index *filter*, so Postgres walks the user's range from the top and discards - measured at
// 9.2ms with 50,000 rows before the cursor, against 0.012ms for the row-value form, which the index
// can bound (bench/paging.measure.ts). Pin the shape or the cost silently returns.
test("the cursor page compares row values, so the index can bound it", async () => {
  for (let i = 0; i < 3; i++) await store.createThread({ userId: "u1" });
  const first = await store.listThreads({ userId: "u1", limit: 1 });
  expect(first.nextCursor).toBeDefined();

  queries = [];
  await store.listThreads({ userId: "u1", limit: 1, cursor: first.nextCursor });
  const [page] = queries;

  expect(page).toMatch(
    /\("ai_sdk_threads"\."created_at", "ai_sdk_threads"\."id"\) < \(\$\d+, \$\d+\)/,
  );
  expect(page).not.toMatch(/\bor\b/);
});

// A deep page is where an OFFSET scan would show up, so the cursor case is the one worth pinning.
// Every page, not a sampled pair: the README claims one query per page, and a claim is only worth
// what the test behind it asserts.
test("paging deeper costs the same as the first page", async () => {
  const pageSize = 5;
  const pages = 12;
  for (let i = 0; i < pageSize * pages; i++) await store.createThread({ userId: "u1" });

  expect(await statements(() => store.listThreads({ userId: "u1", limit: pageSize }))).toBe(1);

  let cursor = (await store.listThreads({ userId: "u1", limit: pageSize })).nextCursor;
  // Without this the loop passes vacuously: an undefined cursor is treated as an initial page.
  expect(cursor).toBeDefined();

  let walked = 0;
  while (cursor) {
    const counted = await statements(() =>
      store.listThreads({ userId: "u1", limit: pageSize, cursor }),
    );
    expect(counted).toBe(1);
    cursor = (await store.listThreads({ userId: "u1", limit: pageSize, cursor })).nextCursor;
    walked += 1;
  }
  // The walk has to actually reach the end, or a cursor bug that stops early looks like a pass.
  expect(walked).toBe(pages - 1);
});

// The root-to-leaf path is walked in memory (`orderPath`), not with a recursive CTE, so depth
// changes what comes back over the wire but never how many times we ask.
test("loading a thread costs the same at any depth", async () => {
  for (const depth of [1, 50, 100, 500]) {
    const id = await threadOfDepth(depth, `d${depth}-`);
    expect(await statements(() => store.loadMessages(id))).toBe(2);
    expect(await store.loadMessages(id)).toHaveLength(depth);
  }
});
