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
    const forked = await store.forkAt(threadId, "m2", [msg("m2b", "two-edited")]);
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
    const forked = await store.forkAt(threadId, "m1", [msg("m1b", "different opening")]);
    expect(forked[0]?.parentId).toBeNull();
    expect(await idsOf(threadId)).toEqual(["m1b"]);
    expect(await store.getTree(threadId)).toHaveLength(4);
  });

  test("writes a multi-message branch as one chain", async () => {
    const threadId = await threeTurnThread();
    const forked = await store.forkAt(threadId, "m2", [
      msg("m2b", "edited"),
      msg("a2", "new", "assistant"),
    ]);
    expect(forked.map((m) => m.id)).toEqual(["m2b", "a2"]);
    expect(forked.map((m) => m.parentId)).toEqual(["a1", "m2b"]);
    expect(await idsOf(threadId)).toEqual(["m1", "a1", "m2b", "a2"]);
  });

  test("rejects an unknown message", async () => {
    const threadId = await threeTurnThread();
    await expect(store.forkAt(threadId, "nope", [msg("x", "x")])).rejects.toThrow(/message/i);
  });
});

describe("setActiveLeaf", () => {
  test("switching back restores the abandoned branch's view", async () => {
    const threadId = await threeTurnThread();
    await store.forkAt(threadId, "m2", [msg("m2b", "two-edited")]);
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

    await expect(store.setActiveLeaf(threadId, "x1")).rejects.toThrow(/not found in thread/);
    await expect(store.setActiveLeaf(threadId, "nope")).rejects.toThrow(/message/i);
    // The live path is untouched.
    expect(await idsOf(threadId)).toEqual(["m1", "a1", "m2"]);
  });
});

describe("siblingsOf", () => {
  test("reports both branches at a fork point, with the index", async () => {
    const threadId = await threeTurnThread();
    await store.forkAt(threadId, "m2", [msg("m2b", "two-edited")]);

    const forOriginal = await store.siblingsOf(threadId, "m2");
    expect(forOriginal.siblings.map((m) => m.id)).toEqual(["m2", "m2b"]);
    expect(forOriginal.index).toBe(0);

    const forFork = await store.siblingsOf(threadId, "m2b");
    expect(forFork.index).toBe(1);
  });

  test("a message with no siblings reports itself", async () => {
    const threadId = await threeTurnThread();
    const { siblings, index } = await store.siblingsOf(threadId, "a1");
    expect(siblings.map((m) => m.id)).toEqual(["a1"]);
    expect(index).toBe(0);
    expect(await store.getTree(threadId)).toHaveLength(3);
  });

  // parent_id IS NULL matches the roots of every thread, so this must be thread-scoped.
  test("root siblings do not leak across threads", async () => {
    const threadId = await threeTurnThread();
    const other = await store.createThread({});
    await store.appendMessages(other.id, [msg("x1", "elsewhere")]);

    const { siblings } = await store.siblingsOf(threadId, "m1");
    expect(siblings.map((m) => m.id)).toEqual(["m1"]);
    // The other thread's root is not reachable from this thread at all.
    await expect(store.siblingsOf(threadId, "x1")).rejects.toThrow(/not found in thread/);
    expect(await store.getTree(threadId)).toHaveLength(3);
  });
});

describe("regenerateFrom", () => {
  test("moves the leaf to the parent so the caller can re-answer", async () => {
    const threadId = await threeTurnThread();
    const { leafId } = await store.regenerateFrom(threadId, "a1");
    expect(leafId).toBe("m1");
    expect(await idsOf(threadId)).toEqual(["m1"]);

    // Answering again produces a sibling of the original reply.
    await store.appendMessages(threadId, [msg("a1b", "different reply", "assistant")]);
    expect(await idsOf(threadId)).toEqual(["m1", "a1b"]);
    const { siblings } = await store.siblingsOf(threadId, "a1");
    expect(siblings.map((m) => m.id)).toEqual(["a1", "a1b"]);
  });

  // Redoing a USER message must answer it again, not drop it: moving the leaf to its parent
  // emptied the live path and lost the user's turn.
  test("regenerating a user message keeps it on the live path", async () => {
    const threadId = await threeTurnThread();
    const { leafId } = await store.regenerateFrom(threadId, "m1");
    expect(leafId).toBe("m1");
    expect(await idsOf(threadId)).toEqual(["m1"]);
    expect(await store.getTree(threadId)).toHaveLength(3);
  });

  test("rejects an unknown message", async () => {
    const threadId = await threeTurnThread();
    await expect(store.regenerateFrom(threadId, "nope")).rejects.toThrow(/message/i);
  });
});

describe("getTree", () => {
  test("returns every message flat, and nothing from other threads", async () => {
    const threadId = await threeTurnThread();
    const other = await store.createThread({});
    await store.appendMessages(other.id, [msg("x1", "elsewhere")]);
    await store.forkAt(threadId, "m2", [msg("m2b", "two-edited")]);

    const tree = await store.getTree(threadId);
    expect(tree.map((m) => m.id).sort()).toEqual(["a1", "m1", "m2", "m2b"]);
    expect(await store.getTree(other.id)).toHaveLength(1);
  });

  test("is empty for a thread with no messages", async () => {
    const thread = await store.createThread({});
    expect(await store.getTree(thread.id)).toEqual([]);
  });
});

// Message ids are a global primary key, so an id from another thread must never be usable.
describe("cross-thread safety", () => {
  const otherThread = async () => {
    const other = await store.createThread({});
    await store.appendMessages(other.id, [msg("o1", "private words")]);
    await store.appendMessages(other.id, [msg("oa1", "private reply", "assistant")]);
    return other.id;
  };

  test("regenerateFrom cannot touch another thread", async () => {
    const threadId = await threeTurnThread();
    const otherId = await otherThread();

    await expect(store.regenerateFrom(threadId, "oa1")).rejects.toThrow(/not found in thread/);
    // The other thread's live path is untouched.
    expect(await idsOf(otherId)).toEqual(["o1", "oa1"]);
  });

  test("forkAt cannot graft onto another thread", async () => {
    const threadId = await threeTurnThread();
    const otherId = await otherThread();

    await expect(store.forkAt(threadId, "o1", [msg("x", "x")])).rejects.toThrow(
      /not found in thread/,
    );
    expect(await store.getTree(otherId)).toHaveLength(2);
  });

  test("siblingsOf cannot read another thread's messages", async () => {
    const threadId = await threeTurnThread();
    await otherThread();

    await expect(store.siblingsOf(threadId, "o1")).rejects.toThrow(/not found in thread/);
  });

  test("replaceMessage cannot rewrite another thread's message", async () => {
    const threadId = await threeTurnThread();
    const otherId = await otherThread();

    await expect(store.replaceMessage(threadId, "o1", msg("o1", "hijacked"))).rejects.toThrow(
      /not found in thread/,
    );
    const tree = await store.getTree(otherId);
    expect(JSON.stringify(tree)).toContain("private words");
    expect(JSON.stringify(tree)).not.toContain("hijacked");
  });

  test("getTree throws for a thread that does not exist", async () => {
    await expect(store.getTree("nope")).rejects.toThrow(/thread/i);
  });
});

describe("replaceMessage", () => {
  test("keeps the id, archives the old version as a sibling with its replies", async () => {
    const threadId = await threeTurnThread();
    const updated = await store.replaceMessage(threadId, "m2", msg("m2", "two-edited"));

    expect(updated.id).toBe("m2");
    expect(await idsOf(threadId)).toEqual(["m1", "a1", "m2"]);
    const live = await store.loadMessages(threadId);
    expect(live[2]?.parts).toEqual([{ type: "text", text: "two-edited" }]);

    // The old wording survives under a surrogate id, as a sibling.
    const { siblings } = await store.siblingsOf(threadId, "m2");
    expect(siblings).toHaveLength(2);
    expect(JSON.stringify(siblings)).toContain("two");
    // Archived first, edited second: the archive keeps its original timestamp.
    expect(siblings[1]?.id).toBe("m2");
  });

  test("the archived version keeps the replies that answered it", async () => {
    const threadId = await threeTurnThread();
    await store.appendMessages(threadId, [msg("a2", "answer to two", "assistant")]);

    await store.replaceMessage(threadId, "m2", msg("m2", "two-edited"));

    // The old answer moved onto the archived question rather than hanging off the edited one.
    expect(await idsOf(threadId)).toEqual(["m1", "a1", "m2"]);
    const archived = (await store.siblingsOf(threadId, "m2")).siblings.find((m) => m.id !== "m2");
    const tree = await store.getTree(threadId);
    expect(tree.find((m) => m.id === "a2")?.parentId).toBe(archived?.id);
  });

  // The whole point of keeping the id: a client can edit the same message repeatedly.
  test("the same message can be edited twice", async () => {
    const threadId = await threeTurnThread();
    await store.replaceMessage(threadId, "m2", msg("m2", "edit one"));
    await store.replaceMessage(threadId, "m2", msg("m2", "edit two"));

    const live = await store.loadMessages(threadId);
    expect(live[2]?.parts).toEqual([{ type: "text", text: "edit two" }]);
    // Three versions in total, all preserved.
    expect((await store.siblingsOf(threadId, "m2")).siblings).toHaveLength(3);
  });
});
