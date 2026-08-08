import type { ModelMessage } from "ai";
import { streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createThreadStore } from "../src/drizzle/index.js";
import { ChatBodyError, parseChatBody } from "../src/handler/body.js";
import { chatHandler } from "../src/handler/index.js";
import { makeDb } from "./db.js";

const userMsg = (id: string, text: string) => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

/**
 * A model that streams the given text deltas and stops. The stream is built by hand rather
 * than with simulateReadableStream so the SDK's own doStream signature types each chunk.
 */
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

/** onEnd persistence runs after the stream closes, so poll rather than guess a delay. */
async function until<T>(check: () => Promise<T | undefined>, label: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("parseChatBody", () => {
  test("accepts the default full-history shape", () => {
    const parsed = parseChatBody({
      id: "t1",
      messages: [userMsg("m1", "one"), userMsg("m2", "two")],
      trigger: "submit-message",
      messageId: undefined,
    });
    expect(parsed.threadId).toBe("t1");
    expect(parsed.incoming.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(parsed.trigger).toBe("submit-message");
    expect(parsed.messageId).toBeUndefined();
  });

  test("accepts the last-message shape from prepareSendMessagesRequest", () => {
    const parsed = parseChatBody({ id: "t1", message: userMsg("m9", "only") });
    expect(parsed.threadId).toBe("t1");
    expect(parsed.incoming.map((m) => m.id)).toEqual(["m9"]);
  });

  test("defaults a missing trigger to submit-message", () => {
    expect(parseChatBody({ id: "t1", messages: [userMsg("m1", "x")] }).trigger).toBe(
      "submit-message",
    );
  });

  test("carries the regenerate trigger and its messageId", () => {
    const parsed = parseChatBody({
      id: "t1",
      messages: [userMsg("m1", "x")],
      trigger: "regenerate-message",
      messageId: "a1",
    });
    expect(parsed.trigger).toBe("regenerate-message");
    expect(parsed.messageId).toBe("a1");
  });

  test.each([
    ["a non-object body", "nope"],
    ["null", null],
    ["an array", []],
    ["a missing id", { messages: [userMsg("m1", "x")] }],
    ["a non-string id", { id: 7, messages: [userMsg("m1", "x")] }],
    ["an empty id", { id: "", messages: [userMsg("m1", "x")] }],
    ["no messages at all", { id: "t1" }],
    ["an empty messages array", { id: "t1", messages: [] }],
    ["a non-array messages", { id: "t1", messages: "hi" }],
    ["a non-object message entry", { id: "t1", messages: ["hi"] }],
    ["a non-object single message", { id: "t1", message: "hi" }],
    ["an unknown trigger", { id: "t1", messages: [userMsg("m1", "x")], trigger: "nope" }],
    ["a non-string messageId", { id: "t1", messages: [userMsg("m1", "x")], messageId: 7 }],
  ])("rejects %s", (_label, body) => {
    expect(() => parseChatBody(body)).toThrow(ChatBodyError);
  });

  test("error messages name the offending field", () => {
    expect(() => parseChatBody({ messages: [] })).toThrow(/id/);
    expect(() => parseChatBody({ id: "t1" })).toThrow(/message/);
  });
});

describe("chatHandler", () => {
  let ctx: Awaited<ReturnType<typeof makeDb>>;
  let store: ReturnType<typeof createThreadStore>;
  let seenModelMessages: ModelMessage[][];

  beforeEach(async () => {
    ctx = await makeDb();
    store = createThreadStore(ctx.db);
    seenModelMessages = [];
  });
  afterEach(() => ctx.close());

  const handlerWith = (overrides: Partial<Parameters<typeof chatHandler>[0]> = {}) =>
    chatHandler({
      store,
      execute: ({ modelMessages }) => {
        seenModelMessages.push(modelMessages);
        return streamText({ model: textModel(["Hi ", "there"]), messages: modelMessages });
      },
      ...overrides,
    });

  const assistantOf = async (threadId: string) =>
    until(async () => {
      const loaded = await store.loadMessages(threadId);
      return loaded.find((m) => m.role === "assistant");
    }, "the assistant message to be persisted");

  test("streams a response and persists both sides of the turn", async () => {
    const handler = handlerWith();
    const response = await handler(post({ id: "t1", messages: [userMsg("m1", "hello")] }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const body = await response.text();
    expect(body).toContain("text-delta");

    const assistant = await assistantOf("t1");
    const loaded = await store.loadMessages("t1");
    expect(loaded.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(loaded[0]?.parts).toEqual([{ type: "text", text: "hello" }]);
    // A server-generated id, not one the client sent.
    expect(assistant.id).toBeTruthy();
    expect(assistant.id).not.toBe("m1");
    expect(assistant.parts).toEqual(
      expect.arrayContaining([{ type: "text", text: "Hi there", state: "done" }]),
    );
  });

  test("creates the thread on first contact and scopes it via createThread", async () => {
    const handler = handlerWith({
      createThread: () => ({ userId: "u1", metadata: { source: "test" } }),
    });
    await handler(post({ id: "fresh", messages: [userMsg("m1", "hi")] }));
    const thread = await store.getThread("fresh");
    expect(thread).toMatchObject({ id: "fresh", userId: "u1", metadata: { source: "test" } });
  });

  test("a second turn feeds prior history to execute", async () => {
    const handler = handlerWith();
    await (await handler(post({ id: "t1", messages: [userMsg("m1", "one")] }))).text();
    await assistantOf("t1");

    await (await handler(post({ id: "t1", messages: [userMsg("m2", "two")] }))).text();
    await until(async () => {
      const loaded = await store.loadMessages("t1");
      return loaded.length === 4 ? true : undefined;
    }, "four stored messages");

    expect(seenModelMessages[0]).toHaveLength(1);
    // user, assistant, user - the history grew across requests.
    expect(seenModelMessages[1]?.length).toBeGreaterThan(1);
    expect(seenModelMessages[1]?.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  // The default transport resends the whole conversation every turn, so the handler has to
  // store only what is new. Getting this wrong collides on the message primary key.
  test("stores only new messages when the client resends full history", async () => {
    const handler = handlerWith();
    await (await handler(post({ id: "t1", messages: [userMsg("m1", "one")] }))).text();
    const assistant = await assistantOf("t1");

    const fullHistory = [userMsg("m1", "one"), assistant, userMsg("m2", "two")];
    const second = await handler(post({ id: "t1", messages: fullHistory }));
    expect(second.status).toBe(200);
    await second.text();

    await until(async () => {
      const loaded = await store.loadMessages("t1");
      return loaded.length === 4 ? true : undefined;
    }, "four stored messages");

    const loaded = await store.loadMessages("t1");
    expect(loaded.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(new Set(loaded.map((m) => m.id)).size).toBe(4);
  });

  test("sets the title once, from generateTitle", async () => {
    const generateTitle = vi.fn(() => "Generated title");
    const handler = handlerWith({ generateTitle });

    await (await handler(post({ id: "t1", messages: [userMsg("m1", "hello")] }))).text();
    const titled = await until(async () => {
      const thread = await store.getThread("t1");
      return thread?.title ?? undefined;
    }, "the title to be set");
    expect(titled).toBe("Generated title");
    expect(generateTitle).toHaveBeenCalledTimes(1);

    // A later turn on the same thread must not re-title it.
    await (await handler(post({ id: "t1", messages: [userMsg("m2", "again")] }))).text();
    await assistantOf("t1");
    expect(generateTitle).toHaveBeenCalledTimes(1);
  });

  // A cancelled body leaves the SDK's responseMessage with no parts, so there is nothing
  // worth storing. The user message must survive and no empty assistant row may appear.
  test("keeps the user message and writes no empty reply when the client disconnects", async () => {
    const handler = handlerWith();
    const response = await handler(post({ id: "t1", messages: [userMsg("m1", "hello")] }));
    await response.body?.cancel();

    await new Promise((r) => setTimeout(r, 300));
    const loaded = await store.loadMessages("t1");
    expect(loaded.map((m) => m.role)).toEqual(["user"]);
    expect(loaded[0]?.parts).toEqual([{ type: "text", text: "hello" }]);
    expect((await store.getThread("t1"))?.activeLeafId).toBe("m1");
  });

  test("answers 400 on a malformed body", async () => {
    const handler = handlerWith();
    expect((await handler(post({ messages: [] }))).status).toBe(400);
    expect((await handler(post("nope"))).status).toBe(400);

    const notJson = new Request("https://example.test/api/chat", { method: "POST", body: "{oops" });
    expect((await handler(notJson)).status).toBe(400);
  });
});
