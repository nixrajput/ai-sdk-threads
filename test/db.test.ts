import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { messages, threads } from "../src/drizzle/index.js";
import { makeDb } from "./db.js";

let ctx: Awaited<ReturnType<typeof makeDb>>;

beforeEach(async () => {
  ctx = await makeDb();
});
afterEach(() => ctx.close());

describe("schema", () => {
  test("round-trips a thread row through drizzle", async () => {
    await ctx.db.insert(threads).values({ id: "t1", userId: "u1", title: "First" });
    const [row] = await ctx.db.select().from(threads);
    expect(row).toMatchObject({ id: "t1", userId: "u1", title: "First", visibility: "private" });
    expect(row?.createdAt).toBeInstanceOf(Date);
  });

  test("stores message parts verbatim and defaults the sdk version", async () => {
    await ctx.db.insert(threads).values({ id: "t1" });
    await ctx.db.insert(messages).values({
      id: "m1",
      threadId: "t1",
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    });
    const [row] = await ctx.db.select().from(messages);
    expect(row).toMatchObject({
      id: "m1",
      parentId: null,
      role: "user",
      parts: [{ type: "text", text: "hi" }],
      sdkVersion: 7,
    });
  });

  test("deleting a thread cascades to its messages", async () => {
    await ctx.db.insert(threads).values({ id: "t1" });
    await ctx.db.insert(messages).values({ id: "m1", threadId: "t1", role: "user", parts: [] });
    await ctx.db.delete(threads);
    expect(await ctx.db.select().from(messages)).toEqual([]);
  });
});
