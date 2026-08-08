import { describe, expect, test } from "vitest";

describe("peer imports", () => {
  test("ai exposes UIMessage tooling", async () => {
    const m: Record<string, unknown> = await import("ai");
    expect(m.validateUIMessages).toBeTypeOf("function");
    expect(m.convertToModelMessages).toBeTypeOf("function");
  });

  test("pglite + drizzle work in-process", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const db = drizzle(new PGlite());
    expect(db).toBeDefined();
  });
});
