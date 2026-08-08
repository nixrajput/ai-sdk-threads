import { generateId, UI_MESSAGE_STREAM_HEADERS } from "ai";
import type { Publisher, ResumableStreamContext, Subscriber } from "resumable-stream/generic";
import { createResumableStreamContext } from "resumable-stream/generic";
import type { ChatHandlerOptions } from "../handler/index.js";
import { chatHandler } from "../handler/index.js";
import type { StreamStateStore, Thread, ThreadStore } from "../types.js";

export type { ResumableStreamContext } from "resumable-stream/generic";

type Handler = (request: Request) => Promise<Response>;

export interface ResumableChatOptions extends Omit<ChatHandlerOptions, "store" | "beforeStream"> {
  /** Must also carry stream state; the drizzle store does. */
  store: ThreadStore & StreamStateStore;
  /**
   * Where in-flight streams are kept. Defaults to one process-wide in-memory context, which
   * resumes only within the instance that served the POST. Pass a Redis-backed context otherwise.
   */
  streamContext?: ResumableStreamContext;
  /** Defaults to a `?chatId=` parameter, else the `<threadId>/stream` path the SDK client uses. */
  threadIdFrom?: (request: Request) => string | null;
}

const noContent = () => new Response(null, { status: 204 });

/**
 * Query parameter first: a fixed `/stream` route with `?chatId=` would otherwise resolve its own
 * path prefix as the thread id. The SDK client sends no query and hits `{api}/{chatId}/stream`.
 */
function threadIdFromUrl(request: Request): string | null {
  const url = new URL(request.url);
  const fromQuery = url.searchParams.get("chatId");
  if (fromQuery) return fromQuery;

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[segments.length - 1] !== "stream" || segments.length < 2) return null;
  return segments[segments.length - 2] ?? null;
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
 * Built on the same `Publisher`/`Subscriber` seam a Redis client fills, so this runs the real
 * resumable-stream implementation rather than a stand-in.
 */
export function createMemoryStreamContext(): ResumableStreamContext {
  const values = new Map<string, { value: string; expiresAt: number }>();
  const channels = new Map<string, (message: string) => void>();

  const read = (key: string) => {
    const entry = values.get(key);
    if (!entry) return null;
    // resumable-stream sets a 24h TTL on its sentinels precisely so they do not accumulate.
    if (entry.expiresAt <= Date.now()) {
      values.delete(key);
      return null;
    }
    return entry.value;
  };

  // One callback per channel, matching resumable-stream's own ioredis adapter: appending would
  // diverge from that contract, and a single unsubscribe would then kill another listener.
  const subscriber: Subscriber = {
    connect: async () => {},
    subscribe: async (channel, callback) => void channels.set(channel, callback),
    unsubscribe: async (channel) => void channels.delete(channel),
  };

  const publisher: Publisher = {
    connect: async () => {},
    publish: async (channel, message) => {
      channels.get(channel)?.(message);
      return 1;
    },
    set: async (key, value, options) => {
      const ttlSeconds = options?.EX ?? 24 * 60 * 60;
      const now = Date.now();
      // Swept here because a finished stream's sentinel is never read again, and read() only
      // evicts on a hit - without this the map grows by one entry per generation, forever.
      if (values.size > 256) {
        for (const [k, entry] of values) if (entry.expiresAt <= now) values.delete(k);
      }
      values.set(key, { value, expiresAt: now + ttlSeconds * 1000 });
      return "OK";
    },
    get: async (key) => read(key),
    incr: async (key) => {
      const current = read(key);
      // Redis rejects INCR on a non-integer, and resumable-stream relies on that rejection to
      // detect a finished stream. Returning NaN instead corrupts the sentinel.
      if (current !== null && !/^-?\d+$/.test(current)) {
        throw new Error("ERR value is not an integer or out of range");
      }
      const next = Number(current ?? 0) + 1;
      await publisher.set(key, String(next));
      return next;
    },
  };

  return createResumableStreamContext({ waitUntil: null, subscriber, publisher });
}

// One context per process, created on first use. A per-call default would give the documented
// two-file Next.js layout (POST in one route, GET in another) two contexts that cannot see each
// other, so resume would never work even on a single instance.
let sharedContext: ResumableStreamContext | undefined;
const defaultContext = () => (sharedContext ??= createMemoryStreamContext());

/**
 * `chatHandler` plus the endpoints a resumable client needs: POST registers the reply stream, GET
 * replays one that is still in flight, DELETE forgets it.
 */
export function resumableChat(options: ResumableChatOptions): {
  POST: Handler;
  GET: Handler;
  DELETE: Handler;
} {
  const { store } = options;
  const context = options.streamContext ?? defaultContext();
  const resolveThreadId = options.threadIdFrom ?? threadIdFromUrl;

  const POST = chatHandler({
    ...options,
    beforeStream: async ({ threadId }) => {
      const streamId = generateId();
      // Recorded before the response is returned, so a client that reconnects immediately still
      // finds a stream to resume.
      await store.setActiveStream(threadId, streamId);

      return {
        consumeSseStream: async (stream) => {
          // The SDK discards this promise, so a rejection escaping here becomes an unhandled
          // rejection and by default takes the process down.
          try {
            const buffered = await context.resumableStream(streamId, () => stream);
            if (buffered) await drain(buffered);
          } catch (error) {
            console.error("ai-sdk-threads: the resumable stream failed", error);
          } finally {
            await store.clearActiveStream(threadId, streamId).catch((error) => {
              console.error("ai-sdk-threads: failed to clear the active stream", error);
            });
          }
        },
      };
    },
  });

  /** GET and DELETE run `authorize` themselves; chatHandler only guards the POST path. */
  const permitted = async (threadId: string, request: Request): Promise<Thread | null> => {
    const thread = await store.getThread(threadId);
    if (!thread) return null;
    const allowed = (await options.authorize?.({ thread, request })) ?? true;
    return allowed ? thread : null;
  };

  const GET: Handler = async (request) => {
    const threadId = resolveThreadId(request);
    if (!threadId) return noContent();
    if (!(await permitted(threadId, request))) return noContent();

    const streamId = await store.getActiveStream(threadId);
    if (!streamId) return noContent();

    let resumed: ReadableStream<string> | null | undefined;
    try {
      resumed = await context.resumeExistingStream(streamId);
    } catch (error) {
      // A sentinel left behind by an instance that died mid-stream makes this reject. Nothing can
      // be resumed, and the client treats 204 as "use the messages you already have".
      console.error("ai-sdk-threads: could not resume the stream", error);
      return noContent();
    }
    // null once that stream finished, undefined when the id is unknown.
    if (!resumed) return noContent();

    return new Response(resumed.pipeThrough(new TextEncoderStream()), {
      headers: UI_MESSAGE_STREAM_HEADERS,
    });
  };

  // Forgets the stream rather than killing it: resumable-stream exposes no abort, so the
  // generation runs to completion server-side and simply stops being resumable.
  const DELETE: Handler = async (request) => {
    const threadId = resolveThreadId(request);
    if (threadId && (await permitted(threadId, request))) {
      const streamId = await store.getActiveStream(threadId);
      if (streamId) {
        // Logged rather than swallowed: on a failed write the stream stays resumable, and a
        // silent 204 would tell the client it was cancelled when it was not.
        await store.clearActiveStream(threadId, streamId).catch((error) => {
          console.error("ai-sdk-threads: failed to forget the active stream", error);
        });
      }
    }
    return noContent();
  };

  return { POST, GET, DELETE };
}
