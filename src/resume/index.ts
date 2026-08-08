import { generateId, UI_MESSAGE_STREAM_HEADERS } from "ai";
import type { Publisher, ResumableStreamContext, Subscriber } from "resumable-stream/generic";
import { createResumableStreamContext } from "resumable-stream/generic";
import type { ChatHandlerOptions } from "../handler/index.js";
import { chatHandler } from "../handler/index.js";

export type { ResumableStreamContext } from "resumable-stream/generic";

type Handler = (request: Request) => Promise<Response>;

export interface ResumableChatOptions extends ChatHandlerOptions {
  /**
   * Where in-flight streams are kept. Defaults to an in-process context, which only resumes
   * within the instance that served the POST - pass a Redis-backed one for multi-instance
   * deployments, built with `createResumableStreamContext` from `resumable-stream`.
   */
  streamContext?: ResumableStreamContext;
  /** Defaults to the `<threadId>/stream` path shape the SDK's client requests. */
  threadIdFrom?: (request: Request) => string | null;
}

const noContent = () => new Response(null, { status: 204 });

/**
 * The SDK's client resumes at `GET {api}/{chatId}/stream`, so the id is the segment before the
 * last. A `?chatId=` query parameter is honoured as a fallback for hand-rolled clients.
 */
function threadIdFromUrl(request: Request): string | null {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (last === "stream" && segments.length >= 2) return segments[segments.length - 2] ?? null;
  return url.searchParams.get("chatId");
}

/** Reads a stream to completion; resumable-stream only publishes what is pulled. */
async function drain(stream: ReadableStream<string>): Promise<void> {
  const reader = stream.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) return;
  }
}

/**
 * An in-process context built on the same `Publisher`/`Subscriber` seam a Redis client fills, so
 * tests and single-instance deployments run the real resumable-stream implementation.
 */
export function createMemoryStreamContext(): ResumableStreamContext {
  const values = new Map<string, string>();
  const channels = new Map<string, ((message: string) => void)[]>();

  const subscriber: Subscriber = {
    connect: async () => {},
    subscribe: async (channel, callback) => {
      channels.set(channel, [...(channels.get(channel) ?? []), callback]);
    },
    unsubscribe: async (channel) => void channels.delete(channel),
  };

  const publisher: Publisher = {
    connect: async () => {},
    publish: async (channel, message) => {
      for (const callback of channels.get(channel) ?? []) callback(message);
      return 1;
    },
    set: async (key, value) => {
      values.set(key, value);
      return "OK";
    },
    get: async (key) => values.get(key) ?? null,
    incr: async (key) => {
      const next = Number(values.get(key) ?? 0) + 1;
      values.set(key, String(next));
      return next;
    },
  };

  return createResumableStreamContext({ waitUntil: null, subscriber, publisher });
}

/**
 * `chatHandler` plus the endpoints a resumable client needs: POST registers the reply stream,
 * GET replays one that is still in flight, DELETE forgets it.
 */
export function resumableChat(options: ResumableChatOptions): {
  POST: Handler;
  GET: Handler;
  DELETE: Handler;
} {
  const { store } = options;
  const context = options.streamContext ?? createMemoryStreamContext();
  const resolveThreadId = options.threadIdFrom ?? threadIdFromUrl;

  const POST = chatHandler({
    ...options,
    beforeStream: async ({ threadId }) => {
      const streamId = generateId();
      // Recorded before the response is returned, so a client that reconnects immediately
      // still finds a stream to resume.
      await store.setActiveStream(threadId, streamId);

      return {
        consumeSseStream: async (stream) => {
          try {
            const buffered = await context.resumableStream(streamId, () => stream);
            if (buffered) await drain(buffered);
          } finally {
            // Cleared whether the stream finished or threw; a stale id would make every later
            // GET try to resume something that can never produce more output.
            await store.setActiveStream(threadId, null).catch((error) => {
              console.error("ai-sdk-threads: failed to clear the active stream", error);
            });
          }
        },
      };
    },
  });

  const GET: Handler = async (request) => {
    const threadId = resolveThreadId(request);
    if (!threadId) return noContent();

    const streamId = await store.getActiveStream(threadId);
    if (!streamId) return noContent();

    const resumed = await context.resumeExistingStream(streamId);
    // null when that stream already finished, undefined when the id is unknown; the client
    // treats 204 as "nothing to resume" and falls back to the messages it has.
    if (!resumed) return noContent();

    return new Response(resumed.pipeThrough(new TextEncoderStream()), {
      headers: UI_MESSAGE_STREAM_HEADERS,
    });
  };

  // Forgets the stream rather than killing it: resumable-stream exposes no abort, so the
  // generation runs to completion server-side and simply stops being resumable.
  const DELETE: Handler = async (request) => {
    const threadId = resolveThreadId(request);
    if (threadId) {
      await store.setActiveStream(threadId, null).catch(() => {});
    }
    return noContent();
  };

  return { POST, GET, DELETE };
}
