import type { UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createThreadStore as createPgStore } from "../src/drizzle/index.js";
import { createThreadStore as createSqliteStore } from "../src/sqlite/index.js";
import type { BranchingStore, StreamStateStore, ThreadStore } from "../src/types.js";
import { makeDb, makeSqliteDb } from "./db.js";

type FullStore = ThreadStore & StreamStateStore & BranchingStore;
type Harness = { store: FullStore; close: () => Promise<void> };

const adapters: [string, () => Promise<Harness>][] = [
  [
    "postgres",
    async () => {
      const ctx = await makeDb();
      return { store: createPgStore(ctx.db), close: async () => void (await ctx.close()) };
    },
  ],
  [
    "sqlite",
    async () => {
      const ctx = await makeSqliteDb();
      return { store: createSqliteStore(ctx.db), close: ctx.close };
    },
  ],
];

const msg = (id: string, text: string, role: "user" | "assistant" = "user"): UIMessage =>
  ({ id, role, parts: [{ type: "text", text }] }) as UIMessage;

// One contract, asserted identically against both adapters: anything that drifts between them
// fails here rather than surfacing as a difference a consumer discovers in production.
describe.each(adapters)("ThreadStore contract (%s)", (_name, makeHarness) => {
  let harness: Harness;
  let store: FullStore;

  beforeEach(async () => {
    harness = await makeHarness();
    store = harness.store;
  });
  afterEach(() => harness.close());

  const idsOf = async (threadId: string) => (await store.loadMessages(threadId)).map((m) => m.id);

  test("threads round-trip through create, read, update and delete", async () => {
    const thread = await store.createThread({ userId: "u1", title: "First" });
    expect(thread).toMatchObject({ userId: "u1", title: "First", visibility: "private" });
    expect(thread.createdAt).toBeInstanceOf(Date);
    expect((await store.getThread(thread.id))?.id).toBe(thread.id);

    const updated = await store.updateThread(thread.id, { title: "Renamed", visibility: "public" });
    expect(updated).toMatchObject({ title: "Renamed", visibility: "public" });

    await store.deleteThread(thread.id);
    expect(await store.getThread(thread.id)).toBeNull();
    expect(await store.getThread("never-existed")).toBeNull();
  });

  test("metadata survives as an object", async () => {
    const thread = await store.createThread({ metadata: { source: "test", nested: { n: 1 } } });
    expect((await store.getThread(thread.id))?.metadata).toEqual({
      source: "test",
      nested: { n: 1 },
    });
  });

  test("listThreads scopes by user and pages by cursor, newest first", async () => {
    for (let i = 0; i < 5; i++) await store.createThread({ userId: "u1", title: `t${i}` });
    await store.createThread({ userId: "u2" });

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await store.listThreads({ userId: "u1", limit: 2, cursor });
      seen.push(...page.threads.map((t) => t.id));
      cursor = page.nextCursor;
      expect(++pages).toBeLessThan(10);
    } while (cursor);

    expect(new Set(seen).size).toBe(5);
    expect(pages).toBeGreaterThan(1);
  });

  test("an out-of-range limit is clamped rather than breaking pagination", async () => {
    for (let i = 0; i < 3; i++) await store.createThread({ userId: "u1" });
    for (const limit of [0, 1.5, -5, 1e9, Number.NaN]) {
      expect((await store.listThreads({ userId: "u1", limit })).threads.length).toBeGreaterThan(0);
    }
  });

  test("messages chain, load in order, and cascade on delete", async () => {
    const thread = await store.createThread({});
    expect(await store.loadMessages(thread.id)).toEqual([]);

    const [first] = await store.appendMessages(thread.id, [msg("m1", "one")]);
    expect(first?.parentId).toBeNull();
    const [second] = await store.appendMessages(thread.id, [msg("m2", "two")]);
    expect(second?.parentId).toBe("m1");
    expect((await store.getThread(thread.id))?.activeLeafId).toBe("m2");

    const loaded = await store.loadMessages(thread.id);
    expect(loaded.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(loaded[0]?.parts).toEqual([{ type: "text", text: "one" }]);

    // Asserted on the rows themselves: recreating the thread and checking loadMessages is empty
    // passes whether or not the messages were actually deleted, because the new leaf is null.
    await store.deleteThread(thread.id);
    const fresh = await store.createThread({ id: thread.id });
    expect(await store.getTree(fresh.id)).toEqual([]);
  });

  test("a batch is written as one chain in order", async () => {
    const thread = await store.createThread({});
    const stored = await store.appendMessages(thread.id, [
      msg("m1", "one"),
      msg("m2", "two"),
      msg("m3", "three"),
    ]);
    expect(stored.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(stored.map((m) => m.parentId)).toEqual([null, "m1", "m2"]);
  });

  test("writes are rejected before they can corrupt a thread", async () => {
    const thread = await store.createThread({});
    await expect(store.appendMessages("nope", [msg("m", "x")])).rejects.toThrow(/thread/i);
    await expect(store.appendMessages(thread.id, [msg("", "x")])).rejects.toThrow(/id/i);
    await expect(
      store.appendMessages(thread.id, [
        { id: "bad", role: "user", parts: [{ type: "nonsense" }] } as unknown as UIMessage,
      ]),
    ).rejects.toThrow();
    await expect(
      store.appendMessages(thread.id, [
        { ...msg("m9", "x"), metadata: "not-an-object" } as unknown as UIMessage,
      ]),
    ).rejects.toThrow(/metadata/);
    expect(await store.loadMessages(thread.id)).toEqual([]);
  });

  test("stream state sets, reads and clears conditionally", async () => {
    const thread = await store.createThread({});
    expect(await store.getActiveStream(thread.id)).toBeNull();
    expect(await store.getActiveStream("never-existed")).toBeNull();

    await store.setActiveStream(thread.id, "s1");
    expect(await store.getActiveStream(thread.id)).toBe("s1");

    await store.setActiveStream(thread.id, "s2");
    await store.clearActiveStream(thread.id, "s1");
    expect(await store.getActiveStream(thread.id)).toBe("s2");

    await store.clearActiveStream(thread.id, "s2");
    expect(await store.getActiveStream(thread.id)).toBeNull();
    await expect(store.setActiveStream("nope", "s1")).rejects.toThrow(/thread/i);
  });

  describe("branching", () => {
    const threeTurns = async () => {
      const thread = await store.createThread({});
      await store.appendMessages(thread.id, [msg("m1", "one")]);
      await store.appendMessages(thread.id, [msg("a1", "reply", "assistant")]);
      await store.appendMessages(thread.id, [msg("m2", "two")]);
      return thread.id;
    };

    test("forkAt branches from the target's parent and keeps the old rows", async () => {
      const threadId = await threeTurns();
      const forked = await store.forkAt(threadId, "m2", [msg("m2b", "edited")]);
      expect(forked[0]?.parentId).toBe("a1");
      expect(await idsOf(threadId)).toEqual(["m1", "a1", "m2b"]);
      expect(await store.getTree(threadId)).toHaveLength(4);
    });

    test("setActiveLeaf switches the live path both ways", async () => {
      const threadId = await threeTurns();
      await store.forkAt(threadId, "m2", [msg("m2b", "edited")]);
      await store.setActiveLeaf(threadId, "m2");
      expect(await idsOf(threadId)).toEqual(["m1", "a1", "m2"]);
      await store.setActiveLeaf(threadId, "m2b");
      expect(await idsOf(threadId)).toEqual(["m1", "a1", "m2b"]);
    });

    test("replaceMessage keeps the id and archives the old version", async () => {
      const threadId = await threeTurns();
      const updated = await store.replaceMessage(threadId, "m2", msg("m2", "edited"));
      expect(updated.id).toBe("m2");

      const live = await store.loadMessages(threadId);
      expect(live[2]?.parts).toEqual([{ type: "text", text: "edited" }]);
      const { siblings, index } = await store.siblingsOf(threadId, "m2");
      expect(siblings).toHaveLength(2);
      expect(index).toBe(1);
    });

    test("regenerateFrom targets the parent for an assistant turn and itself for a user turn", async () => {
      const threadId = await threeTurns();
      expect(await store.regenerateFrom(threadId, "a1")).toEqual({ leafId: "m1" });
      expect(await idsOf(threadId)).toEqual(["m1"]);
      expect(await store.regenerateFrom(threadId, "m1")).toEqual({ leafId: "m1" });
      expect(await idsOf(threadId)).toEqual(["m1"]);
    });

    test("every branching method refuses another thread's message", async () => {
      const threadId = await threeTurns();
      const other = await store.createThread({});
      await store.appendMessages(other.id, [msg("x1", "elsewhere")]);

      await expect(store.forkAt(threadId, "x1", [msg("y", "y")])).rejects.toThrow(/not found/);
      await expect(store.regenerateFrom(threadId, "x1")).rejects.toThrow(/not found/);
      await expect(store.siblingsOf(threadId, "x1")).rejects.toThrow(/not found/);
      await expect(store.setActiveLeaf(threadId, "x1")).rejects.toThrow(/not found/);
      await expect(store.replaceMessage(threadId, "x1", msg("x1", "no"))).rejects.toThrow(
        /not found/,
      );
    });

    test("getTree throws for a thread that does not exist", async () => {
      await expect(store.getTree("nope")).rejects.toThrow(/thread/i);
    });
  });
});
