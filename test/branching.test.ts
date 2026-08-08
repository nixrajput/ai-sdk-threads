import type { UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createThreadStore } from "../src/drizzle/index.js";
import { makeDb } from "./db.js";

let ctx: Awaited<ReturnType<typeof makeDb>>;
let store: ReturnType<typeof createThreadStore>;

beforeEach(async () => {
  ctx = await makeDb();
  store = createThreadStore(ctx.db);
});
afterEach(() => ctx.close());

const msg = (id: string, text: string, role: "user" | "assistant" = "user"): UIMessage =>
  ({ id, role, parts: [{ type: "text", text }] }) as UIMessage;

/** user "one" -> assistant "reply" -> user "two", built through the public API only. */
async function threeTurnThread() {
  const thread = await store.createThread({});
  await store.appendMessages(thread.id, [msg("m1", "one")]);
  await store.appendMessages(thread.id, [msg("a1", "reply", "assistant")]);
  await store.appendMessages(thread.id, [msg("m2", "two")]);
  return thread.id;
}

const idsOf = async (threadId: string) => (await store.loadMessages(threadId)).map((m) => m.id);

describe("forkAt", () => {
  test("replaces a message on the live path without deleting it", async () => {
    const threadId = await threeTurnThread();
    expect(await idsOf(threadId)).toEqual(["m1", "a1", "m2"]);

    // Edit "two" into "two-edited": the new message hangs off m2's parent, a1.
    const forked = await store.forkAt("m2", [msg("m2b", "two-edited")]);
    expect(forked[0]?.parentId).toBe("a1");

    expect(await idsOf(threadId)).toEqual(["m1", "a1", "m2b"]);
    // The abandoned message still exists.
    expect((await store.getTree(threadId)).map((m) => m.id).sort()).toEqual([
      "a1",
      "m1",
      "m2",
      "m2b",
    ]);
  });

  test("forking the root starts a parallel conversation", async () => {
    const threadId = await threeTurnThread();
    const forked = await store.forkAt("m1", [msg("m1b", "different opening")]);
    expect(forked[0]?.parentId).toBeNull();
    expect(await idsOf(threadId)).toEqual(["m1b"]);
    expect(await store.getTree(threadId)).toHaveLength(4);
  });

  test("writes a multi-message branch as one chain", async () => {
    const threadId = await threeTurnThread();
    const forked = await store.forkAt("m2", [msg("m2b", "edited"), msg("a2", "new", "assistant")]);
    expect(forked.map((m) => m.id)).toEqual(["m2b", "a2"]);
    expect(forked.map((m) => m.parentId)).toEqual(["a1", "m2b"]);
    expect(await idsOf(threadId)).toEqual(["m1", "a1", "m2b", "a2"]);
  });

  test("rejects an unknown message", async () => {
    await expect(store.forkAt("nope", [msg("x", "x")])).rejects.toThrow(/message/i);
  });
});

describe("setActiveLeaf", () => {
  test("switching back restores the abandoned branch's view", async () => {
    const threadId = await threeTurnThread();
    await store.forkAt("m2", [msg("m2b", "two-edited")]);
    expect(await idsOf(threadId)).toEqual(["m1", "a1", "m2b"]);

    await store.setActiveLeaf(threadId, "m2");
    expect(await idsOf(threadId)).toEqual(["m1", "a1", "m2"]);

    await store.setActiveLeaf(threadId, "m2b");
    expect(await idsOf(threadId)).toEqual(["m1", "a1", "m2b"]);
  });

  test("can point at an interior message, truncating the view", async () => {
    const threadId = await threeTurnThread();
    await store.setActiveLeaf(threadId, "m1");
    expect(await idsOf(threadId)).toEqual(["m1"]);
  });

  test("rejects a message from another thread", async () => {
    const threadId = await threeTurnThread();
    const other = await store.createThread({});
    await store.appendMessages(other.id, [msg("x1", "elsewhere")]);

    await expect(store.setActiveLeaf(threadId, "x1")).rejects.toThrow(/does not belong/);
    await expect(store.setActiveLeaf(threadId, "nope")).rejects.toThrow(/message/i);
    // The live path is untouched.
    expect(await idsOf(threadId)).toEqual(["m1", "a1", "m2"]);
  });
});

describe("siblingsOf", () => {
  test("reports both branches at a fork point, with the index", async () => {
    const threadId = await threeTurnThread();
    await store.forkAt("m2", [msg("m2b", "two-edited")]);

    const forOriginal = await store.siblingsOf("m2");
    expect(forOriginal.siblings.map((m) => m.id)).toEqual(["m2", "m2b"]);
    expect(forOriginal.index).toBe(0);

    const forFork = await store.siblingsOf("m2b");
    expect(forFork.index).toBe(1);
  });

  test("a message with no siblings reports itself", async () => {
    const threadId = await threeTurnThread();
    const { siblings, index } = await store.siblingsOf("a1");
    expect(siblings.map((m) => m.id)).toEqual(["a1"]);
    expect(index).toBe(0);
    expect(threadId).toBeTruthy();
  });

  // parent_id IS NULL matches the roots of every thread, so this must be thread-scoped.
  test("root siblings do not leak across threads", async () => {
    const threadId = await threeTurnThread();
    const other = await store.createThread({});
    await store.appendMessages(other.id, [msg("x1", "elsewhere")]);

    const { siblings } = await store.siblingsOf("m1");
    expect(siblings.map((m) => m.id)).toEqual(["m1"]);
    expect(await store.siblingsOf("x1")).toMatchObject({ index: 0 });
    expect(threadId).toBeTruthy();
  });
});

describe("regenerateFrom", () => {
  test("moves the leaf to the parent so the caller can re-answer", async () => {
    const threadId = await threeTurnThread();
    const { parentId } = await store.regenerateFrom("a1");
    expect(parentId).toBe("m1");
    expect(await idsOf(threadId)).toEqual(["m1"]);

    // Answering again produces a sibling of the original reply.
    await store.appendMessages(threadId, [msg("a1b", "different reply", "assistant")]);
    expect(await idsOf(threadId)).toEqual(["m1", "a1b"]);
    const { siblings } = await store.siblingsOf("a1");
    expect(siblings.map((m) => m.id)).toEqual(["a1", "a1b"]);
  });

  test("regenerating the root empties the live path", async () => {
    const threadId = await threeTurnThread();
    const { parentId } = await store.regenerateFrom("m1");
    expect(parentId).toBeNull();
    expect(await store.loadMessages(threadId)).toEqual([]);
    // Nothing was deleted.
    expect(await store.getTree(threadId)).toHaveLength(3);
  });

  test("rejects an unknown message", async () => {
    await expect(store.regenerateFrom("nope")).rejects.toThrow(/message/i);
  });
});

describe("getTree", () => {
  test("returns every message flat, and nothing from other threads", async () => {
    const threadId = await threeTurnThread();
    const other = await store.createThread({});
    await store.appendMessages(other.id, [msg("x1", "elsewhere")]);
    await store.forkAt("m2", [msg("m2b", "two-edited")]);

    const tree = await store.getTree(threadId);
    expect(tree.map((m) => m.id).sort()).toEqual(["a1", "m1", "m2", "m2b"]);
    expect(await store.getTree(other.id)).toHaveLength(1);
  });

  test("is empty for a thread with no messages", async () => {
    const thread = await store.createThread({});
    expect(await store.getTree(thread.id)).toEqual([]);
  });
});
