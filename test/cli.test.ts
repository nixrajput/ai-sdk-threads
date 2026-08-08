import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { formatImportReport, importVercelChat } from "../src/cli/import-vercel.js";
import { formatMigrateReport, migrateDatabase } from "../src/cli/migrate.js";
import { createThreadStore, messages } from "../src/drizzle/index.js";
import { migrateParts } from "../src/index.js";
import { makeDb } from "./db.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const v5Parts = (shape: string) =>
  JSON.parse(readFileSync(join(fixtures, "parts-v5", `${shape}.json`), "utf8"));

let ctx: Awaited<ReturnType<typeof makeDb>>;
let store: ReturnType<typeof createThreadStore>;

beforeEach(async () => {
  ctx = await makeDb();
  store = createThreadStore(ctx.db);
});
afterEach(() => ctx.close());

describe("migrateParts", () => {
  test("passes 5 and 6 through unchanged, which the fixtures prove is correct", () => {
    const parts = v5Parts("tool-call");
    expect(migrateParts(parts, 5)).toEqual(parts);
    expect(migrateParts(parts, 6)).toEqual(parts);
    expect(migrateParts(parts, 7)).toBe(parts);
  });

  test("refuses a major it has no evidence for rather than guessing", () => {
    expect(() => migrateParts([], 4)).toThrow(/cannot migrate/);
    expect(() => migrateParts([], 3)).toThrow(/supported majors are 5, 6, 7/);
  });
});

describe("migrate", () => {
  const seedOldRows = async () => {
    const thread = await store.createThread({ id: "t1" });
    // Written as if by ai 5: real captured parts, stamped with the older major.
    await ctx.db.insert(messages).values([
      {
        id: "m1",
        threadId: thread.id,
        parentId: null,
        role: "assistant",
        parts: v5Parts("text"),
        sdkVersion: 5,
      },
      {
        id: "m2",
        threadId: thread.id,
        parentId: "m1",
        role: "assistant",
        parts: v5Parts("tool-call"),
        sdkVersion: 6,
      },
    ]);
    return thread.id;
  };

  test("restamps old rows and reports what it found", async () => {
    await seedOldRows();
    const report = await migrateDatabase(ctx.db);

    expect(report.scanned).toEqual({ 5: 1, 6: 1 });
    expect(report.updated).toBe(2);
    expect(report.unreadable).toEqual([]);

    const rows = await ctx.db.select().from(messages);
    expect(rows.every((row) => row.sdkVersion === 7)).toBe(true);
    expect(formatMigrateReport(report)).toContain("Restamped 2");
  });

  test("a dry run writes nothing", async () => {
    await seedOldRows();
    const report = await migrateDatabase(ctx.db, { dryRun: true });

    expect(report.updated).toBe(0);
    expect(report.scanned).toEqual({ 5: 1, 6: 1 });
    const rows = await ctx.db.select().from(messages);
    expect(rows.map((row) => row.sdkVersion).sort()).toEqual([5, 6]);
    expect(formatMigrateReport(report)).toContain("Dry run: 2");
  });

  test("reports a row the current SDK cannot read instead of restamping it", async () => {
    const thread = await store.createThread({ id: "t1" });
    await ctx.db.insert(messages).values({
      id: "bad",
      threadId: thread.id,
      parentId: null,
      role: "assistant",
      parts: [{ type: "nonsense" }],
      sdkVersion: 5,
    });

    const report = await migrateDatabase(ctx.db);
    expect(report.updated).toBe(0);
    expect(report.unreadable).toHaveLength(1);
    expect(report.unreadable[0]?.id).toBe("bad");
    // Left stamped as 5, so a rerun still sees it.
    const [row] = await ctx.db.select().from(messages);
    expect(row?.sdkVersion).toBe(5);
    expect(formatMigrateReport(report)).toContain("cannot read");
  });

  test("says so when there is nothing to do", async () => {
    const report = await migrateDatabase(ctx.db);
    expect(report.updated).toBe(0);
    expect(formatMigrateReport(report)).toContain("Nothing to migrate");
  });
});

describe("import-vercel", () => {
  // DDL matching the ai-chatbot template's Chat and Message_v2 tables.
  const seedTemplate = async () => {
    await ctx.db.execute(sql`
      CREATE TABLE "Chat" (
        "id" text PRIMARY KEY,
        "createdAt" timestamptz NOT NULL,
        "title" text,
        "userId" text,
        "visibility" text
      )`);
    await ctx.db.execute(sql`
      CREATE TABLE "Message_v2" (
        "id" text PRIMARY KEY,
        "chatId" text NOT NULL,
        "role" text NOT NULL,
        "parts" jsonb NOT NULL,
        "attachments" jsonb,
        "createdAt" timestamptz NOT NULL
      )`);
    await ctx.db.execute(sql`
      INSERT INTO "Chat" VALUES
        ('c1', '2026-01-01T10:00:00Z', 'First chat', 'u1', 'private'),
        ('c2', '2026-01-02T10:00:00Z', 'Public chat', 'u1', 'public')`);
    const text = JSON.stringify(v5Parts("text"));
    const tool = JSON.stringify(v5Parts("tool-call"));
    await ctx.db.execute(sql`
      INSERT INTO "Message_v2" VALUES
        ('vm1', 'c1', 'user', ${text}::jsonb, NULL, '2026-01-01T10:00:00Z'),
        ('vm2', 'c1', 'assistant', ${tool}::jsonb, NULL, '2026-01-01T10:00:05Z'),
        ('vm3', 'c2', 'user', ${text}::jsonb, NULL, '2026-01-02T10:00:00Z')`);
  };

  test("imports threads and links messages into a readable chain", async () => {
    await seedTemplate();
    const report = await importVercelChat(ctx.db);

    expect(report).toMatchObject({ threads: 2, messages: 3, skippedThreads: 0 });

    const first = await store.getThread("c1");
    expect(first).toMatchObject({ title: "First chat", userId: "u1", visibility: "private" });
    expect((await store.getThread("c2"))?.visibility).toBe("public");

    // The imported chain loads through the normal path, which is the real test of the linking.
    const loaded = await store.loadMessages("c1");
    expect(loaded.map((m) => m.id)).toEqual(["vm1", "vm2"]);
    expect(await store.loadMessages("c2")).toHaveLength(1);
    expect(formatImportReport(report)).toContain("Imported 2 thread(s)");
  });

  test("a dry run writes nothing", async () => {
    await seedTemplate();
    const report = await importVercelChat(ctx.db, { dryRun: true });
    expect(report).toMatchObject({ threads: 2, messages: 3, dryRun: true });
    expect(await store.getThread("c1")).toBeNull();
  });

  test("stamps imported rows with the current major, not the source major", async () => {
    await seedTemplate();
    await importVercelChat(ctx.db, { sourceSdkVersion: 5 });
    const rows = await ctx.db.select().from(messages);
    // Stamped current, so a later `migrate` run cannot mistake them for un-migrated data.
    expect(rows.every((row) => row.sdkVersion === 7)).toBe(true);
    expect((await migrateDatabase(ctx.db)).scanned).toEqual({});
  });

  test("skips a row the current SDK cannot read instead of breaking the thread", async () => {
    await seedTemplate();
    await ctx.db.execute(sql`
      INSERT INTO "Message_v2" VALUES
        ('bad1', 'c1', 'user', '[{"type":"nonsense"}]'::jsonb, NULL, '2026-01-01T10:00:09Z'),
        ('bad2', 'c1', 'tool', '[]'::jsonb, NULL, '2026-01-01T10:00:10Z')`);

    const report = await importVercelChat(ctx.db);
    expect(report.skippedMessages).toHaveLength(2);
    expect(report.skippedMessages.map((m) => m.id).sort()).toEqual(["bad1", "bad2"]);

    // The imported thread is readable, which is the point of validating before writing.
    const loaded = await store.loadMessages("c1");
    expect(loaded.map((m) => m.id)).toEqual(["vm1", "vm2"]);
    expect(formatImportReport(report)).toContain("cannot read");
  });

  test("a rerun skips threads that already exist", async () => {
    await seedTemplate();
    await importVercelChat(ctx.db);
    const second = await importVercelChat(ctx.db);
    expect(second).toMatchObject({ threads: 0, skippedThreads: 2 });
    // Still exactly the original rows: no duplicates.
    expect(await ctx.db.select().from(messages)).toHaveLength(3);
    expect(formatImportReport(second)).toContain("Skipped 2");
  });
});

// Review finding: the bin's self-exec guard compared string suffixes, so when npm installs it as a
// symlink in node_modules/.bin the published CLI ran nothing and exited 0.
describe("the bin actually runs", () => {
  const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli", "bin.js");
  const run = async (args: string[], cwd?: string) => {
    const { execFile } = await import("node:child_process");
    return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, [bin, ...args], { cwd }, (error, stdout, stderr) => {
        const code = error && "code" in error ? Number(error.code) : 0;
        resolve({ code, stdout, stderr });
      });
    });
  };

  test("prints usage and exits 0 for --help", async () => {
    const result = await run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("ai-sdk-threads <command>");
  });

  test("still runs when invoked through a node_modules/.bin style symlink", async () => {
    const { mkdtemp, symlink, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "ai-sdk-threads-bin-"));
    const link = join(dir, "ai-sdk-threads");
    try {
      await symlink(bin, link);
      const { execFile } = await import("node:child_process");
      const result = await new Promise<{ code: number; stdout: string }>((resolve) => {
        execFile(process.execPath, [link, "--help"], (error, stdout) => {
          resolve({ code: error && "code" in error ? Number(error.code) : 0, stdout });
        });
      });
      // The whole point: through a symlink it must still do its job, not silently exit 0.
      expect(result.stdout).toContain("ai-sdk-threads <command>");
      expect(result.code).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test.each([
    [[], "no command"],
    [["migrate"], "no --database-url"],
    [["nope", "--database-url", "x"], "unknown command"],
  ])("exits 1 on %s", async (args) => {
    expect((await run(args as string[])).code).toBe(1);
  });
});
