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
  test("a failing execute yields 500 and leaves the thread uncorrupted", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = handlerWith({
      execute: () => {
        throw new Error("model exploded");
      },
    });

    const response = await handler(post({ id: "t1", messages: [userMsg("m1", "hello")] }));
    expect(response.status).toBe(500);

    // The user message survives; no partial assistant row was written.
    const loaded = await store.loadMessages("t1");
    expect(loaded.map((m) => m.role)).toEqual(["user"]);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  test("onError can override the 500", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = handlerWith({
      execute: () => {
        throw new Error("model exploded");
      },
      onError: (error) => new Response(`handled: ${(error as Error).message}`, { status: 503 }),
    });

    const response = await handler(post({ id: "t1", messages: [userMsg("m1", "hi")] }));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("handled: model exploded");
    errors.mockRestore();
  });

  test("onError returning undefined keeps the default 500", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = handlerWith({
      execute: () => {
        throw new Error("boom");
      },
      onError: () => undefined,
    });
    expect((await handler(post({ id: "t1", messages: [userMsg("m1", "hi")] }))).status).toBe(500);
    errors.mockRestore();
  });

  // Throwing inside onEnd would surface during stream teardown where nothing can act on it.
  test("a persistence failure logs instead of breaking the stream", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const brittle = {
      ...store,
      appendMessages: async (
        threadId: string,
        messages: Parameters<typeof store.appendMessages>[1],
      ) => {
        if (messages.some((m) => m.role === "assistant")) throw new Error("db down");
        return store.appendMessages(threadId, messages);
      },
    };

    const handler = handlerWith({ store: brittle });
    const response = await handler(post({ id: "t1", messages: [userMsg("m1", "hello")] }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("text-delta");

    await until(
      async () => (errors.mock.calls.length > 0 ? true : undefined),
      "the persistence failure to be logged",
    );
    expect(errors.mock.calls.flat().join(" ")).toContain("failed to persist");
    // The user turn is still intact.
    expect((await store.loadMessages("t1")).map((m) => m.role)).toEqual(["user"]);
    errors.mockRestore();
  });

  test("a title failure never breaks the response", async () => {
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = handlerWith({
      generateTitle: () => {
        throw new Error("no title for you");
      },
    });

    const response = await handler(post({ id: "t1", messages: [userMsg("m1", "hello")] }));
    expect(response.status).toBe(200);
    await response.text();
    await assistantOf("t1");

    await until(async () => (warns.mock.calls.length > 0 ? true : undefined), "the title warning");
    expect((await store.getThread("t1"))?.title).toBeNull();
    warns.mockRestore();
  });
  // Review finding: an unvalidated row bricks the thread - every later load 500s forever.
  test("rejects a message the SDK cannot validate, leaving the thread usable", async () => {
    const handler = handlerWith();
    const bad = { id: "bad1", role: "user", parts: [{ type: "nonsense" }] };
    const response = await handler(post({ id: "t1", messages: [bad] }));
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/validation/i);

    // Nothing was written, so a legitimate request still works.
    expect(await store.loadMessages("t1")).toEqual([]);
    const ok = await handler(post({ id: "t1", messages: [userMsg("m1", "hello")] }));
    expect(ok.status).toBe(200);
    await ok.text();
    await assistantOf("t1");
  });

  // Review finding: a client must not be able to forge system/assistant context.
  test.each([["system"], ["assistant"]])(
    "rejects a new %s message from the client",
    async (role) => {
      const handler = handlerWith();
      const response = await handler(
        post({ id: "t1", messages: [{ id: "x1", role, parts: [{ type: "text", text: "evil" }] }] }),
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toMatch(/only new "user" messages/);
      expect(await store.loadMessages("t1")).toEqual([]);
    },
  );

  // Review finding: reusing the previous assistant id collided on the primary key and the
  // new reply was lost. Retrying a turn whose messages are all stored must still work.
  test("a retry with nothing new still stores a fresh reply", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = handlerWith();
    await (await handler(post({ id: "t1", messages: [userMsg("m1", "hello")] }))).text();
    const first = await assistantOf("t1");

    // Same request again: every message is already stored, so fresh is empty.
    const retry = await handler(post({ id: "t1", messages: [userMsg("m1", "hello")] }));
    expect(retry.status).toBe(200);
    await retry.text();

    await until(async () => {
      const loaded = await store.loadMessages("t1");
      return loaded.length === 3 ? true : undefined;
    }, "the retried reply to be stored");

    const loaded = await store.loadMessages("t1");
    const assistants = loaded.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(2);
    // A distinct id, not the earlier reply's.
    expect(assistants[1]?.id).not.toBe(first.id);
    expect(new Set(loaded.map((m) => m.id)).size).toBe(3);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  // Review finding: a partial reply was stored with a part still marked state "streaming".
  test("does not store a reply that was cut off mid-stream", async () => {
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = handlerWith({
      execute: ({ modelMessages }) =>
        streamText({
          model: textModel(["one ", "two ", "three ", "four ", "five"]),
          messages: modelMessages,
        }),
    });

    const response = await handler(post({ id: "t1", messages: [userMsg("m1", "hello")] }));
    const reader = response.body?.getReader();
    await reader?.read();
    await reader?.cancel();

    await until(async () => (warns.mock.calls.length > 0 ? true : undefined), "the warning");
    const loaded = await store.loadMessages("t1");
    expect(loaded.map((m) => m.role)).toEqual(["user"]);
    expect(warns.mock.calls.flat().join(" ")).toContain("did not finish streaming");
    warns.mockRestore();
  });

  // Review finding: thread ids are client-chosen, so an existing thread needs a guard.
  test("authorize gates an existing thread with 403", async () => {
    await store.createThread({ id: "owned", userId: "owner" });
    const handler = handlerWith({
      authorize: ({ thread }) => thread.userId === "owner-request",
    });

    const response = await handler(post({ id: "owned", messages: [userMsg("m1", "peek")] }));
    expect(response.status).toBe(403);
    // Nothing was appended to someone else's thread.
    expect(await store.loadMessages("owned")).toEqual([]);
  });

  test("authorize allows the owner through", async () => {
    await store.createThread({ id: "owned", userId: "owner" });
    const handler = handlerWith({ authorize: ({ thread }) => thread.userId === "owner" });
    const response = await handler(post({ id: "owned", messages: [userMsg("m1", "hi")] }));
    expect(response.status).toBe(200);
    await response.text();
    await assistantOf("owned");
  });

  // Review finding: getThread-then-createThread raced and one concurrent request 500d.
  test("two concurrent first requests both succeed", async () => {
    const handler = handlerWith();
    const [a, b] = await Promise.all([
      handler(post({ id: "race", messages: [userMsg("m1", "one")] })),
      handler(post({ id: "race", messages: [userMsg("m2", "two")] })),
    ]);
    expect([a?.status, b?.status]).toEqual([200, 200]);
    await Promise.all([a?.text(), b?.text()]);
    expect(await store.getThread("race")).not.toBeNull();
  });

  test("answers 400 on duplicate or missing message ids", async () => {
    const handler = handlerWith();
    const dup = userMsg("same", "x");
    expect((await handler(post({ id: "t1", messages: [dup, dup] }))).status).toBe(400);
    expect(
      (await handler(post({ id: "t1", messages: [{ role: "user", parts: [] }] }))).status,
    ).toBe(400);
  });
});

// v0.4: the wire shapes the SDK client actually sends for regenerate and edit, established by
// reading AbstractChat.regenerate and sendMessage in the installed ai package.
describe("chatHandler branching", () => {
  let ctx2: Awaited<ReturnType<typeof makeDb>>;
  let branchStore: ReturnType<typeof createThreadStore>;

  beforeEach(async () => {
    ctx2 = await makeDb();
    branchStore = createThreadStore(ctx2.db);
  });
  afterEach(() => ctx2.close());

  const handlerFor = (reply: string) =>
    chatHandler({
      store: branchStore,
      execute: ({ modelMessages }) =>
        streamText({ model: textModel([reply]), messages: modelMessages }),
    });

  const settled = (threadId: string, count: number) =>
    until(async () => {
      const loaded = await branchStore.loadMessages(threadId);
      return loaded.length === count ? loaded : undefined;
    }, `${count} messages on the live path`);

  const firstTurn = async () => {
    const handler = handlerFor("first answer");
    await (await handler(post({ id: "t1", messages: [userMsg("m1", "hello")] }))).text();
    const [, assistant] = await settled("t1", 2);
    return assistant;
  };

  test("a regenerate answers again as a sibling, not a continuation", async () => {
    const original = await firstTurn();

    // regenerate() truncates the history client-side and names the message to redo.
    const handler = handlerFor("second answer");
    const response = await handler(
      post({
        id: "t1",
        messages: [userMsg("m1", "hello")],
        trigger: "regenerate-message",
        messageId: original?.id,
      }),
    );
    expect(response.status).toBe(200);
    await response.text();

    const loaded = await settled("t1", 2);
    const replacement = loaded[1];
    expect(replacement?.id).not.toBe(original?.id);
    expect(JSON.stringify(replacement?.parts)).toContain("second answer");

    // Both answers exist, as siblings under the same user message.
    const { siblings } = await branchStore.siblingsOf(original?.id as string);
    expect(siblings).toHaveLength(2);
    expect(await branchStore.getTree("t1")).toHaveLength(3);
  });

  test("an edit forks instead of appending", async () => {
    await firstTurn();

    // sendMessage({ messageId }) replaces that user message, keeping its id, and truncates after.
    const handler = handlerFor("answer to the edit");
    const response = await handler(
      post({ id: "t1", messages: [userMsg("m1", "hello, edited")], messageId: "m1" }),
    );
    // Asserted: without this, a 500 from a failed fork looked like a passing test.
    expect(response.status).toBe(200);
    await response.text();

    const loaded = await settled("t1", 2);
    expect(loaded[0]?.parts).toEqual([{ type: "text", text: "hello, edited" }]);
    // The edited message is a new row; the client's id still names the original wording.
    expect(loaded[0]?.id).not.toBe("m1");
    expect(JSON.stringify(loaded[1]?.parts)).toContain("answer to the edit");

    // The original question and its answer are still there, off the live path.
    const tree = await branchStore.getTree("t1");
    expect(tree).toHaveLength(4);
    expect(tree.some((m) => JSON.stringify(m.parts).includes("hello, edited"))).toBe(true);
    expect(tree.some((m) => JSON.stringify(m.parts).includes("first answer"))).toBe(true);
  });

  // Bare sendMessage() resends the last message unchanged with its id, which must not fork.
  test("a retry with the same id and same parts adds nothing", async () => {
    const original = await firstTurn();
    const before = await branchStore.getTree("t1");

    const handler = handlerFor("retried answer");
    await (
      await handler(post({ id: "t1", messages: [userMsg("m1", "hello")], messageId: "m1" }))
    ).text();

    await until(async () => {
      const tree = await branchStore.getTree("t1");
      return tree.length === before.length + 1 ? true : undefined;
    }, "one new reply");

    // No forked user message: only the extra answer.
    const tree = await branchStore.getTree("t1");
    expect(tree.filter((m) => m.role === "user")).toHaveLength(1);
    expect(original?.id).toBeTruthy();
  });

  test("a store without branching answers a regenerate as a new turn, with a warning", async () => {
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    const original = await firstTurn();

    const { forkAt, regenerateFrom, siblingsOf, setActiveLeaf, getTree, ...plain } = branchStore;
    const handler = chatHandler({
      store: plain,
      execute: ({ modelMessages }) =>
        streamText({ model: textModel(["plain answer"]), messages: modelMessages }),
    });

    const response = await handler(
      post({
        id: "t1",
        messages: [userMsg("m1", "hello")],
        trigger: "regenerate-message",
        messageId: original?.id,
      }),
    );
    expect(response.status).toBe(200);
    await response.text();

    expect(warns.mock.calls.flat().join(" ")).toContain("cannot branch");
    expect(forkAt && regenerateFrom && siblingsOf && setActiveLeaf && getTree).toBeTruthy();
    warns.mockRestore();
  });
  // After an edit the client still knows the original id, and resends it every turn. Matching
  // against the whole tree (not the live path) is what stops that becoming a duplicate row.
  test("a turn after an edit does not resurrect the replaced message", async () => {
    await firstTurn();
    const handler = handlerFor("answer to the edit");
    await (
      await handler(post({ id: "t1", messages: [userMsg("m1", "hello, edited")], messageId: "m1" }))
    ).text();
    await settled("t1", 2);
    const afterEdit = await branchStore.getTree("t1");

    // The client resends its full history, including the id it still believes in.
    const next = await handler(
      post({ id: "t1", messages: [userMsg("m1", "hello, edited"), userMsg("m3", "next")] }),
    );
    expect(next.status).toBe(200);
    await next.text();

    await until(async () => {
      const tree = await branchStore.getTree("t1");
      return tree.length === afterEdit.length + 2 ? true : undefined;
    }, "the new turn to be stored");

    const tree = await branchStore.getTree("t1");
    // Exactly one row per id: nothing was re-inserted.
    expect(new Set(tree.map((m) => m.id)).size).toBe(tree.length);
    expect(tree.filter((m) => JSON.stringify(m.parts).includes("hello, edited"))).toHaveLength(1);
  });
});
