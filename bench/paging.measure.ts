// Does a deep keyset page cost what the first page costs? The README claimed a measured ratio
// with no harness behind it, so this is the harness. Set PG_URL to measure a real server over
// TCP; without it the same run happens in PGlite.
//
//   RUNS=5 SAMPLES=200 npx tsx bench/paging.measure.ts
//   PG_URL=postgres://localhost:5432/paging_bench npx tsx bench/paging.measure.ts
//
// Method notes, because the first attempt at this got them wrong: page 1 and the deep page are
// sampled in randomised order (measuring page 1 first every time hands it the cold-cache cost),
// both are warmed before timing, and created_at is spread so the index has no ties to break.
import { sql } from "drizzle-orm";
import { createThreadStore } from "../src/drizzle/index.js";
import { threads } from "../src/drizzle/schema.js";

const THREADS = Number(process.env.THREADS ?? 4000);
const LIMIT = Number(process.env.LIMIT ?? 10);
const TARGET_PAGE = Number(process.env.TARGET_PAGE ?? 400);
const RUNS = Number(process.env.RUNS ?? 5);
const SAMPLES = Number(process.env.SAMPLES ?? 200);
const WARMUP = Number(process.env.WARMUP ?? 200);
const PG_URL = process.env.PG_URL;

const DDL = `
  DROP TABLE IF EXISTS ai_sdk_messages;
  DROP TABLE IF EXISTS ai_sdk_threads;
  CREATE TABLE ai_sdk_threads (
    id text PRIMARY KEY,
    user_id text,
    title text,
    visibility text NOT NULL DEFAULT 'private',
    active_leaf_id text,
    active_stream_id text,
    metadata jsonb,
    created_at timestamptz(3) NOT NULL DEFAULT now(),
    updated_at timestamptz(3) NOT NULL DEFAULT now()
  );
  CREATE INDEX ai_sdk_threads_user_created_idx ON ai_sdk_threads (user_id, created_at, id);
  CREATE TABLE ai_sdk_messages (
    id text PRIMARY KEY,
    thread_id text NOT NULL REFERENCES ai_sdk_threads (id) ON DELETE CASCADE,
    parent_id text,
    role text NOT NULL,
    parts jsonb NOT NULL,
    metadata jsonb,
    sdk_version smallint NOT NULL DEFAULT 7,
    created_at timestamptz(3) NOT NULL DEFAULT now()
  );
  CREATE INDEX ai_sdk_messages_thread_idx ON ai_sdk_messages (thread_id);
`;

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const median = (xs: number[]) => quantile(xs, 0.5);

async function connect() {
  if (PG_URL) {
    // Only needed for a PG_URL run; install it unsaved with `npm i pg --no-save`. The specifier
    // is a variable so neither the dependency lint nor the typecheck demands a driver and its
    // types that the package deliberately does not ship.
    const driver = "pg";
    const { Pool } = (await import(driver)) as {
      Pool: new (config: { connectionString: string; max: number }) => { end(): Promise<void> };
    };
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const pool = new Pool({ connectionString: PG_URL, max: 1 });
    const db = drizzle(pool);
    return {
      db,
      exec: (q: string) => db.execute(sql.raw(q)),
      close: () => pool.end(),
      kind: "real Postgres over TCP",
    };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  const db = drizzle(client);
  return {
    db,
    exec: (q: string) => client.exec(q),
    close: () => client.close(),
    kind: "PGlite (in-process)",
  };
}

const conn = await connect();
console.log(
  `${conn.kind} | ${THREADS} threads | limit ${LIMIT} | page ${TARGET_PAGE} | ${RUNS} runs x ${SAMPLES} samples\n`,
);

const ratios: number[] = [];
for (let run = 1; run <= RUNS; run++) {
  await conn.exec(DDL);
  const store = createThreadStore(conn.db as never);

  // One minute apart, newest first, so the keyset index has distinct keys - a tight seeding loop
  // puts thousands of rows in the same millisecond and measures tie-breaking instead of paging.
  const base = Date.UTC(2026, 0, 1);
  for (let i = 0; i < THREADS; i += 500) {
    const batch = Array.from({ length: Math.min(500, THREADS - i) }, (_, k) => {
      const n = i + k;
      return {
        id: `t${String(n).padStart(6, "0")}`,
        userId: "u1",
        createdAt: new Date(base + n * 60_000),
        updatedAt: new Date(base + n * 60_000),
      };
    });
    await conn.db.insert(threads).values(batch);
  }

  let cursor: string | undefined;
  for (let page = 1; page < TARGET_PAGE; page++) {
    const res = await store.listThreads({ userId: "u1", limit: LIMIT, cursor });
    cursor = res.nextCursor;
    if (!cursor)
      throw new Error(`ran out of pages at ${page}: ${THREADS} threads / limit ${LIMIT}`);
  }
  const deep = cursor;

  const first = () => store.listThreads({ userId: "u1", limit: LIMIT });
  const deepPage = () => store.listThreads({ userId: "u1", limit: LIMIT, cursor: deep });
  for (let i = 0; i < WARMUP; i++) await (i % 2 ? first() : deepPage());

  const t1: number[] = [];
  const tN: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const firstFirst = Math.random() < 0.5;
    for (const which of firstFirst ? ["1", "N"] : ["N", "1"]) {
      const start = performance.now();
      await (which === "1" ? first() : deepPage());
      (which === "1" ? t1 : tN).push(performance.now() - start);
    }
  }

  const m1 = median(t1);
  const mN = median(tN);
  ratios.push(mN / m1);
  console.log(
    `run ${run}: page 1 p50 ${m1.toFixed(3)}ms p95 ${quantile(t1, 0.95).toFixed(3)} | ` +
      `page ${TARGET_PAGE} p50 ${mN.toFixed(3)}ms p95 ${quantile(tN, 0.95).toFixed(3)} | ` +
      `ratio ${(mN / m1).toFixed(2)}x`,
  );
}

console.log(
  `\nacross ${RUNS} runs: median ratio ${median(ratios).toFixed(2)}x, ` +
    `min ${Math.min(...ratios).toFixed(2)}x, max ${Math.max(...ratios).toFixed(2)}x`,
);
await conn.close();
