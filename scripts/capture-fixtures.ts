// Captures real UIMessage.parts from whichever `ai` major is installed, by streaming each shape
// through the SDK's own readUIMessageStream. Run it again under the next major to produce the
// fixture that proves the one after it can still read these rows:
//
//   npx tsx scripts/capture-fixtures.ts
//
// Writes test/fixtures/parts-v<major>/. Never hand-author these - the point is that they are what
// the SDK actually produced.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { convertToModelMessages, readUIMessageStream, streamText, tool } from "ai";
import * as testUtils from "ai/test";
import { z } from "zod";

const mocks = testUtils as unknown as Record<string, unknown>;
// v7 ships MockLanguageModelV4, v6 MockLanguageModelV3 - the same detection test/model.ts uses.
const isV4 = mocks.MockLanguageModelV4 !== undefined;
const MockModel = (mocks.MockLanguageModelV4 ?? mocks.MockLanguageModelV3) as new (o: {
  doStream: () => Promise<{ stream: ReadableStream<unknown> }>;
}) => never;

const finish = isV4
  ? {
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 2, text: 2, reasoning: 0 },
      },
    }
  : {
      type: "finish",
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    };

const model = (chunks: unknown[]) =>
  new MockModel({
    doStream: async () => ({
      stream: new ReadableStream({
        start(c) {
          c.enqueue({ type: "stream-start", warnings: [] });
          for (const chunk of chunks) c.enqueue(chunk);
          c.enqueue(finish);
          c.close();
        },
      }),
    }),
  });

const text = (t: string) => [
  { type: "text-start", id: "0" },
  { type: "text-delta", id: "0", delta: t },
  { type: "text-end", id: "0" },
];

const SHAPES: Record<string, unknown[]> = {
  text: text("Hello world"),
  reasoning: [
    { type: "reasoning-start", id: "r0" },
    { type: "reasoning-delta", id: "r0", delta: "thinking hard" },
    { type: "reasoning-end", id: "r0" },
    ...text("the answer"),
  ],
  "tool-call": [
    {
      type: "tool-call",
      toolCallId: "c1",
      toolName: "getWeather",
      input: JSON.stringify({ city: "Berlin" }),
    },
  ],
  file: [
    // The provider-level shape changed: v4 wraps the payload in a tagged union, v3 is flat.
    // The stored UIMessage part comes out identical either way, which is the point of the fixture.
    isV4
      ? { type: "file", mediaType: "image/png", data: { type: "data", data: "iVBORw0KGgo=" } }
      : { type: "file", mediaType: "image/png", data: "iVBORw0KGgo=" },
    ...text("here it is"),
  ],
};

const tools = {
  getWeather: tool({
    description: "weather",
    inputSchema: z.object({ city: z.string() }),
    execute: async ({ city }: { city: string }) => ({ city, temp: 21 }),
  }),
};

const major = (await import("ai/package.json", { with: { type: "json" } })).default.version.split(
  ".",
)[0];
const out = join(process.cwd(), `test/fixtures/parts-v${major}`);
console.log(`capturing from ai@${major} into ${out}`);
mkdirSync(out, { recursive: true });

for (const [shape, chunks] of Object.entries(SHAPES)) {
  const result = streamText({ model: model(chunks) as never, prompt: "go", tools });
  let last: unknown;
  for await (const message of readUIMessageStream({ stream: result.toUIMessageStream() })) {
    last = message;
  }
  const parts = (last as { parts: unknown[] }).parts;
  writeFileSync(join(out, `${shape}.json`), `${JSON.stringify(parts, null, 2)}\n`);
  // Proves the captured shape is not merely well-formed but sendable back to a model.
  await convertToModelMessages([last as never]);
  console.log(`${shape.padEnd(10)} ${JSON.stringify(parts).length} bytes`);
}
