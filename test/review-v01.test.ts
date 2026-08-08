import type { UIMessage } from "ai";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { orderPath } from "../src/chain.js";
import { convertToUIMessages } from "../src/convert.js";
import { createThreadStore, threads } from "../src/drizzle/index.js";
import type { StoredMessage } from "../src/types.js";
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

describe("listThreads pagination", () => {
  // The columns are millisecond-precision so the cursor's toISOString() round-trips exactly.
  // At Postgres' default microsecond precision the cursor rounded down and every row sharing
  // that millisecond became permanently unreachable.
  test("reaches every row when timestamps differ by microseconds", async () => {
    const base = "2026-08-08 12:00:00.123";
    const micros = ["000", "100", "200", "300", "400", "500"];
    for (const [i, suffix] of micros.entries()) {
      await ctx.db.insert(threads).values({
        id: `t${i}`,
        userId: "u1",
        createdAt: sql.raw(`'${base}${suffix}+00'::timestamptz`) as unknown as Date,
      });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await store.listThreads({ userId: "u1", limit: 2, cursor });
      seen.push(...page.threads.map((t) => t.id));
      cursor = page.nextCursor;
      pages++;
      expect(pages).toBeLessThan(20);
    } while (cursor);

    expect(new Set(seen).size).toBe(micros.length);
  });

  test.each([
    ["zero", 0],
    ["a fraction", 1.5],
    ["negative", -5],
    ["absurd", 1e9],
    ["NaN", Number.NaN],
  ])("survives %s as a limit", async (_label, limit) => {
    for (let i = 0; i < 3; i++) await store.createThread({ userId: "u1" });
    const page = await store.listThreads({ userId: "u1", limit });
    expect(page.threads.length).toBeGreaterThan(0);
  });

  test("a limit of zero does not report a finished page while rows remain", async () => {
    for (let i = 0; i < 3; i++) await store.createThread({ userId: "u1" });
    const page = await store.listThreads({ userId: "u1", limit: 0 });
    expect(page.threads.length).toBeGreaterThan(0);
  });
});

describe("orderPath cycles", () => {
  const msg = (id: string, parentId: string | null): StoredMessage => ({
    id,
    threadId: "t1",
    parentId,
    role: "user",
    parts: [],
    metadata: null,
    sdkVersion: 7,
    createdAt: new Date(),
  });

  test("throws on a self-parent instead of looping forever", () => {
    expect(() => orderPath([msg("a", "a")], "a")).toThrow(/cycles/);
  });

  test("throws on a two-node cycle", () => {
    expect(() => orderPath([msg("a", "b"), msg("b", "a")], "a")).toThrow(/cycles/);
  });
});

describe("appendMessages validation", () => {
  // The store is documented as a standalone path, so the chokepoint has to be here and not
  // only in chatHandler: an unparseable row makes every later load of the thread throw.
  test("rejects parts the SDK cannot validate", async () => {
    const t = await store.createThread({});
    const bad = { id: "m1", role: "user", parts: [{ type: "nonsense" }] } as unknown as UIMessage;
    await expect(store.appendMessages(t.id, [bad])).rejects.toThrow();
    expect(await store.loadMessages(t.id)).toEqual([]);
  });

  test("rejects non-object metadata rather than storing a lying type", async () => {
    const t = await store.createThread({});
    const msg = { ...userMsg("m1", "x"), metadata: "source-x" } as unknown as UIMessage;
    await expect(store.appendMessages(t.id, [msg])).rejects.toThrow(/metadata/);
    expect(await store.loadMessages(t.id)).toEqual([]);
  });

  test("stamps the configured sdk version", async () => {
    const v6 = createThreadStore(ctx.db, { sdkVersion: 6 });
    const t = await v6.createThread({});
    const [stored] = await v6.appendMessages(t.id, [userMsg("m1", "x")]);
    expect(stored?.sdkVersion).toBe(6);
  });

  test("a batch keeps its order and chains parents in one insert", async () => {
    const t = await store.createThread({});
    const batch = [userMsg("m1", "one"), userMsg("m2", "two"), userMsg("m3", "three")];
    const stored = await store.appendMessages(t.id, batch);
    expect(stored.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(stored.map((m) => m.parentId)).toEqual([null, "m1", "m2"]);
    expect((await store.loadMessages(t.id)).map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });
});

describe("convertToUIMessages provider-executed results", () => {
  test("a result inside the assistant message stays inline through a round-trip", async () => {
    const { convertToModelMessages, validateUIMessages } = await import("ai");
    const ui = convertToUIMessages([
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "c1", toolName: "search", input: { q: "x" } },
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "search",
            output: { type: "json", value: { hits: 2 } },
          },
        ],
      },
    ]);

    const part = ui[0]?.parts.find((p) => p.type === "tool-search") as Record<string, unknown>;
    expect(part.providerExecuted).toBe(true);

    const back = await convertToModelMessages(await validateUIMessages({ messages: ui }));
    // One assistant message, not an assistant plus a detached tool message.
    expect(back.map((m) => m.role)).toEqual(["assistant"]);
    expect(back[0]?.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "tool-result", toolCallId: "c1" })]),
    );
  });
});
