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

const userMsg = (id: string, text: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage;

describe("threads", () => {
  test("create, get, update, delete round-trip", async () => {
    const t = await store.createThread({ userId: "u1", title: "First" });
    expect(t).toMatchObject({ userId: "u1", title: "First", visibility: "private" });
    expect((await store.getThread(t.id))?.id).toBe(t.id);
    const updated = await store.updateThread(t.id, { title: "Renamed", visibility: "public" });
    expect(updated).toMatchObject({ title: "Renamed", visibility: "public" });
    await store.deleteThread(t.id);
    expect(await store.getThread(t.id)).toBeNull();
  });

  test("listThreads scopes by user, paginates by cursor, newest first", async () => {
    for (let i = 0; i < 5; i++) await store.createThread({ userId: "u1", title: `t${i}` });
    await store.createThread({ userId: "u2" });
    const page1 = await store.listThreads({ userId: "u1", limit: 3 });
    expect(page1.threads).toHaveLength(3);
    expect(page1.nextCursor).toBeDefined();
    const page2 = await store.listThreads({ userId: "u1", limit: 3, cursor: page1.nextCursor });
    expect(page2.threads).toHaveLength(2);
    expect(page2.nextCursor).toBeUndefined();
    const ids = [...page1.threads, ...page2.threads].map((t) => t.id);
    expect(new Set(ids).size).toBe(5);
  });

  test("updateThread rejects an unknown thread", async () => {
    await expect(store.updateThread("nope", { title: "x" })).rejects.toThrow(/thread/i);
  });
});

describe("messages", () => {
  test("append chains parents and advances the active leaf", async () => {
    const t = await store.createThread({});
    const [m1] = await store.appendMessages(t.id, [userMsg("m1", "one")]);
    expect(m1?.parentId).toBeNull();
    const [m2] = await store.appendMessages(t.id, [userMsg("m2", "two")]);
    expect(m2?.parentId).toBe("m1");
    expect((await store.getThread(t.id))?.activeLeafId).toBe("m2");
  });

  test("loadMessages returns validated UIMessages in order", async () => {
    const t = await store.createThread({});
    await store.appendMessages(t.id, [userMsg("m1", "one"), userMsg("m2", "two")]);
    const loaded = await store.loadMessages(t.id);
    expect(loaded.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(loaded[0]?.parts[0]).toMatchObject({ type: "text", text: "one" });
  });

  test("loadMessages on an empty thread returns nothing", async () => {
    const t = await store.createThread({});
    expect(await store.loadMessages(t.id)).toEqual([]);
  });

  test("deleting a thread cascades to messages", async () => {
    const t = await store.createThread({});
    await store.appendMessages(t.id, [userMsg("m1", "x")]);
    await store.deleteThread(t.id);
    const fresh = await store.createThread({ id: t.id });
    expect(await store.loadMessages(fresh.id)).toEqual([]);
  });

  test("appendMessages rejects an unknown thread", async () => {
    await expect(store.appendMessages("nope", [userMsg("m", "x")])).rejects.toThrow(/thread/i);
  });

  // The SDK leaves responseMessage.id empty unless the route passes generateMessageId.
  // Storing that would key a row on "" and collide on the next assistant message.
  test("appendMessages rejects a message with no id", async () => {
    const t = await store.createThread({});
    await expect(store.appendMessages(t.id, [userMsg("", "x")])).rejects.toThrow(/id/i);
    await expect(
      store.appendMessages(t.id, [{ role: "user", parts: [] } as unknown as UIMessage]),
    ).rejects.toThrow(/id/i);
    expect(await store.loadMessages(t.id)).toEqual([]);
  });

  test("appendMessages preserves message metadata", async () => {
    const t = await store.createThread({});
    const msg = { ...userMsg("m1", "x"), metadata: { source: "test" } } as UIMessage;
    const [stored] = await store.appendMessages(t.id, [msg]);
    expect(stored?.metadata).toEqual({ source: "test" });
    const [loaded] = await store.loadMessages(t.id);
    expect(loaded?.metadata).toEqual({ source: "test" });
  });
});

describe("stream state", () => {
  test("set, read, and clear the active stream", async () => {
    const t = await store.createThread({});
    expect(await store.getActiveStream(t.id)).toBeNull();

    await store.setActiveStream(t.id, "stream-1");
    expect(await store.getActiveStream(t.id)).toBe("stream-1");
    expect((await store.getThread(t.id))?.activeStreamId).toBe("stream-1");

    await store.clearActiveStream(t.id, "stream-1");
    expect(await store.getActiveStream(t.id)).toBeNull();
  });

  // A stream finishing after a newer one started must not clear the newer one's id, or the
  // live reply stops being resumable.
  test("clearing is conditional on still being the active stream", async () => {
    const t = await store.createThread({});
    await store.setActiveStream(t.id, "old");
    await store.setActiveStream(t.id, "new");

    await store.clearActiveStream(t.id, "old");
    expect(await store.getActiveStream(t.id)).toBe("new");

    await store.clearActiveStream(t.id, "new");
    expect(await store.getActiveStream(t.id)).toBeNull();
  });

  // A resume can arrive before the first POST created the row; that is "nothing to resume".
  test("getActiveStream returns null for an unknown thread", async () => {
    expect(await store.getActiveStream("nope")).toBeNull();
  });

  test("clearing an unknown thread is a no-op, setting one throws", async () => {
    await expect(store.clearActiveStream("nope", "s1")).resolves.toBeUndefined();
    await expect(store.setActiveStream("nope", "s1")).rejects.toThrow(/thread/i);
  });
});
