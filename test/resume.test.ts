import { streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createThreadStore } from "../src/drizzle/index.js";
import { resumableChat } from "../src/resume/index.js";
import { makeDb } from "./db.js";

let ctx: Awaited<ReturnType<typeof makeDb>>;
let store: ReturnType<typeof createThreadStore>;

beforeEach(async () => {
  ctx = await makeDb();
  store = createThreadStore(ctx.db);
});
afterEach(() => ctx.close());

const userMsg = (id: string, text: string) => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

/** Streams deltas with a gap between each, so a test can act mid-stream. */
const slowModel = (deltas: string[], gapMs: number) =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "0" });
          for (const delta of deltas) {
            await new Promise((r) => setTimeout(r, gapMs));
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

const streamRequest = (threadId: string, method = "GET") =>
  new Request(`https://example.test/api/chat/${threadId}/stream`, { method });

async function until<T>(check: () => Promise<T | undefined>, label: string): Promise<T> {
  for (let i = 0; i < 150; i++) {
    const value = await check();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const textOf = async (response: Response) => await response.text();

const chat = (deltas = ["Hi ", "there"], gapMs = 0) =>
  resumableChat({
    store,
    execute: ({ modelMessages }) =>
      streamText({ model: slowModel(deltas, gapMs), messages: modelMessages }),
  });

describe("resumableChat POST", () => {
  test("registers a stream, still answers, and clears it afterwards", async () => {
    const { POST } = chat();
    const response = await POST(post({ id: "t1", messages: [userMsg("m1", "hello")] }));

    expect(response.status).toBe(200);
    expect(await textOf(response)).toContain("text-delta");

    // Cleared once the stream completes.
    await until(
      async () => ((await store.getActiveStream("t1")) === null ? true : undefined),
      "the active stream to clear",
    );

    const loaded = await store.loadMessages("t1");
    expect(loaded.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  test("the active stream is set while the reply is in flight", async () => {
    const { POST } = chat(["one ", "two ", "three "], 40);
    const response = await POST(post({ id: "t1", messages: [userMsg("m1", "hello")] }));

    const active = await until(
      async () => (await store.getActiveStream("t1")) ?? undefined,
      "an active stream id",
    );
    expect(active).toBeTruthy();

    await textOf(response);
  });
});

describe("resumableChat GET", () => {
  test("replays an in-flight stream to a second consumer", async () => {
    const { POST, GET } = chat(["one ", "two ", "three ", "four "], 40);
    const response = await POST(post({ id: "t1", messages: [userMsg("m1", "hello")] }));

    await until(async () => (await store.getActiveStream("t1")) ?? undefined, "an active stream");

    const resumed = await GET(streamRequest("t1"));
    expect(resumed.status).toBe(200);

    const [original, replay] = await Promise.all([textOf(response), textOf(resumed)]);
    // The resumed response carries the same answer text as the original.
    for (const delta of ["one", "two", "three", "four"]) {
      expect(original).toContain(delta);
      expect(replay).toContain(delta);
    }
  });

  test("answers 204 when the thread has no active stream", async () => {
    const { GET } = chat();
    await store.createThread({ id: "idle" });
    const response = await GET(streamRequest("idle"));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  test("answers 204 once the stream has finished", async () => {
    const { POST, GET } = chat();
    await textOf(await POST(post({ id: "t1", messages: [userMsg("m1", "hello")] })));
    await until(
      async () => ((await store.getActiveStream("t1")) === null ? true : undefined),
      "the stream to clear",
    );
    expect((await GET(streamRequest("t1"))).status).toBe(204);
  });

  test("answers 204 when the url carries no thread id", async () => {
    const { GET } = chat();
    const response = await GET(new Request("https://example.test/api/chat"));
    expect(response.status).toBe(204);
  });

  test("honours a chatId query parameter for hand-rolled clients", async () => {
    const { POST, GET } = chat(["one ", "two ", "three "], 40);
    const response = await POST(post({ id: "t1", messages: [userMsg("m1", "hello")] }));
    await until(async () => (await store.getActiveStream("t1")) ?? undefined, "an active stream");

    const byQuery = await GET(new Request("https://example.test/api/chat?chatId=t1"));
    expect(byQuery.status).toBe(200);
    await Promise.all([textOf(response), textOf(byQuery)]);
  });
});

describe("resumableChat DELETE", () => {
  test("forgets the stream so a follow-up GET answers 204", async () => {
    const { POST, GET, DELETE } = chat(["one ", "two ", "three ", "four "], 40);
    const response = await POST(post({ id: "t1", messages: [userMsg("m1", "hello")] }));
    await until(async () => (await store.getActiveStream("t1")) ?? undefined, "an active stream");

    const stopped = await DELETE(streamRequest("t1", "DELETE"));
    expect(stopped.status).toBe(204);
    expect(await store.getActiveStream("t1")).toBeNull();
    expect((await GET(streamRequest("t1"))).status).toBe(204);

    await textOf(response);
  });

  test("answers 204 for an unknown thread rather than throwing", async () => {
    const { DELETE } = chat();
    expect((await DELETE(streamRequest("nope", "DELETE"))).status).toBe(204);
  });
});
