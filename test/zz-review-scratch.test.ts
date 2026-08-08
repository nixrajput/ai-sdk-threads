import { streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createThreadStore } from "../src/drizzle/index.js";
import { chatHandler } from "../src/handler/index.js";
import { makeDb } from "./db.js";

const userMsg = (id: string, text: string) => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

const textModel = (deltas: string[]) =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "0" });
          for (const delta of deltas) {
            controller.enqueue({ type: "text-delta", id: "0", delta });
          }
          controller.enqueue({ type: "text-end", id: "0" });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 2, text: 2, reasoning: 0 },
            },
          });
          controller.close();
        },
      }),
    }),
  });

const post = (body: unknown) =>
  new Request("https://example.test/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

async function until<T>(check: () => Promise<T | undefined>, label: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("review scratch round 2", () => {
  let ctx: Awaited<ReturnType<typeof makeDb>>;
  let store: ReturnType<typeof createThreadStore>;

  beforeEach(async () => {
    ctx = await makeDb();
    store = createThreadStore(ctx.db);
  });
  afterEach(() => ctx.close());

  const handlerFor = (reply: string) =>
    chatHandler({
      store,
      execute: ({ modelMessages }) =>
        streamText({ model: textModel([reply]), messages: modelMessages }),
    });

  const settled = (threadId: string, count: number) =>
    until(async () => {
      const loaded = await store.loadMessages(threadId);
      return loaded.length === count ? loaded : undefined;
    }, `${count} messages on the live path`);

  const firstTurn = async () => {
    const handler = handlerFor("first answer");
    await (await handler(post({ id: "t1", messages: [userMsg("m1", "hello")] }))).text();
    return (await settled("t1", 2))[1];
  };

  test("H6: retry whose part keys arrive in a different order", async () => {
    await firstTurn();
    const handler = handlerFor("retried answer");
    // Same content, keys reversed - what a hand-rolled client or a re-serialised body can send.
    const res = await handler(
      post({
        id: "t1",
        messages: [{ role: "user", id: "m1", parts: [{ text: "hello", type: "text" }] }],
        messageId: "m1",
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 400));
    const tree = await store.getTree("t1");
    // biome-ignore lint/suspicious/noConsole: scratch
    console.log(
      "H6 user rows:",
      tree.filter((m) => m.role === "user").length,
      "tree size",
      tree.length,
    );
    expect(true).toBe(true);
  });

  test("H7: regenerate naming an unknown message", async () => {
    await firstTurn();
    const handler = handlerFor("x");
    const res = await handler(
      post({
        id: "t1",
        messages: [userMsg("m1", "hello")],
        trigger: "regenerate-message",
        messageId: "does-not-exist",
      }),
    );
    // biome-ignore lint/suspicious/noConsole: scratch
    console.log("H7 status", res.status, JSON.stringify(await res.text()).slice(0, 80));
    expect(true).toBe(true);
  });

  test("H8: edit request carrying an additional brand-new message", async () => {
    await firstTurn();
    const handler = handlerFor("answer");
    const res = await handler(
      post({
        id: "t1",
        messages: [userMsg("m1", "edited"), userMsg("m9", "also new")],
        messageId: "m1",
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 400));
    // biome-ignore lint/suspicious/noConsole: scratch
    console.log(
      "H8 tree:",
      (await store.getTree("t1")).map((m) => `${m.role}:${JSON.stringify(m.parts).slice(0, 30)}`),
    );
    expect(true).toBe(true);
  });

  test("H9: getTree / siblingsOf on an unknown thread or foreign message", async () => {
    // biome-ignore lint/suspicious/noConsole: scratch
    console.log("H9 getTree(unknown):", await store.getTree("nope"));
    const other = await store.createThread({ id: "o1" });
    await store.appendMessages(other.id, [userMsg("o-m1", "private words") as never]);
    // No thread scoping on siblingsOf: any id in the database is readable.
    // biome-ignore lint/suspicious/noConsole: scratch
    console.log("H9 siblingsOf foreign:", JSON.stringify(await store.siblingsOf("o-m1")));
    expect(true).toBe(true);
  });
});
