import type { ModelMessage, UIMessage } from "ai";
import { afterAll, bench, describe } from "vitest";
import { createThreadStore } from "../src/drizzle/index.js";
import { convertToUIMessages } from "../src/index.js";
import { makeDb } from "../test/db.js";

// Kept short in hook mode: these numbers are indicative, not publication grade.
const time = Number(process.env.AI_SDK_THREADS_BENCH_TIME_MS ?? 500);
const opts = { time, warmupTime: Math.min(100, time) };

const uiMsg = (id: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text: `message ${id}` }] }) as UIMessage;

let ctx: Awaited<ReturnType<typeof makeDb>> | undefined;
let store: ReturnType<typeof createThreadStore>;
let seededThreadId: string;
let counter = 0;

// One database for the file: measuring the operations, not PGlite startup.
async function ready() {
  if (ctx) return;
  ctx = await makeDb();
  store = createThreadStore(ctx.db);
  const thread = await store.createThread({ userId: "bench" });
  seededThreadId = thread.id;
  await store.appendMessages(
    thread.id,
    Array.from({ length: 20 }, (_, i) => uiMsg(`seed${i}`)),
  );
}

describe("store", () => {
  bench("createThread", async () => void (await store.createThread({ userId: "bench" })), {
    ...opts,
    setup: ready,
  });

  bench(
    "appendMessages (1 message)",
    async () => void (await store.appendMessages(seededThreadId, [uiMsg(`b${counter++}`)])),
    { ...opts, setup: ready },
  );

  bench("loadMessages (20 messages)", async () => void (await store.loadMessages(seededThreadId)), {
    ...opts,
    setup: ready,
  });

  afterAll(async () => {
    await ctx?.close();
  });
});

describe("convert", () => {
  const turns: ModelMessage[] = Array.from({ length: 10 }, (_, i) =>
    i % 2 === 0
      ? { role: "user", content: `question ${i}` }
      : { role: "assistant", content: `answer ${i}` },
  );

  bench("convertToUIMessages (10 turns)", () => void convertToUIMessages(turns), opts);
});
