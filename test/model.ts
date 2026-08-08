import type { LanguageModel } from "ai";
import * as testUtils from "ai/test";

// The mock model and its stream-part shapes are the only things in these tests that differ between
// `ai` majors: v7 ships MockLanguageModelV4 (provider spec v4), v6 ships MockLanguageModelV3, and
// the finish chunk changed from a plain reason plus flat usage to nested objects. Detecting it here
// keeps the handler and resume suites runnable on both, which is what makes the ai@6 CI job
// exercise the streaming code rather than just the store.

const mocks = testUtils as unknown as Record<string, unknown>;
const MockModel = (mocks.MockLanguageModelV4 ?? mocks.MockLanguageModelV3) as new (options: {
  doStream: () => Promise<{ stream: ReadableStream<unknown> }>;
}) => LanguageModel;

const isV4 = mocks.MockLanguageModelV4 !== undefined;

const finishChunk = () =>
  isV4
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

/** Streams the given text deltas and stops. `gapMs` leaves room to act mid-stream. */
export function textModel(deltas: string[], gapMs = 0): LanguageModel {
  return new MockModel({
    doStream: async () => ({
      stream: new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "0" });
          for (const delta of deltas) {
            if (gapMs > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
            controller.enqueue({ type: "text-delta", id: "0", delta });
          }
          controller.enqueue({ type: "text-end", id: "0" });
          controller.enqueue(finishChunk());
          controller.close();
        },
      }),
    }),
  });
}
