import type { ModelMessage, UIMessage } from "ai";
import { convertToModelMessages, generateId, safeValidateUIMessages } from "ai";
import type { BranchingStore, Thread, ThreadStore } from "../types.js";
import type { ParsedChatBody } from "./body.js";
import { ChatBodyError, parseChatBody } from "./body.js";

export type { ChatTrigger, ParsedChatBody } from "./body.js";
export { ChatBodyError, parseChatBody } from "./body.js";

/**
 * Structural rather than `StreamTextResult`: that type carries three SDK generics which move
 * between majors, and these are the only two members called.
 */
export interface ChatStreamResult {
  toUIMessageStreamResponse(options: {
    generateMessageId?: () => string;
    onEnd?: (event: { responseMessage: UIMessage }) => void | PromiseLike<void>;
    /** ai 6's name for onEnd, which ai 7 deprecated. Both are passed; only one ever fires. */
    onFinish?: (event: { responseMessage: UIMessage }) => void | PromiseLike<void>;
    consumeSseStream?: (options: { stream: ReadableStream<string> }) => void | PromiseLike<void>;
  }): Response;
  consumeStream(options?: { onError?: (error: unknown) => void }): PromiseLike<void>;
}

export interface ChatExecuteContext {
  threadId: string;
  uiMessages: UIMessage[];
  modelMessages: ModelMessage[];
  request: Request;
}

export interface ChatThreadScope {
  userId?: string;
  metadata?: Record<string, unknown>;
}

export interface ChatHandlerOptions {
  /** Branching methods are optional: without them a regenerate re-answers instead of forking. */
  store: ThreadStore & Partial<BranchingStore>;
  execute: (ctx: ChatExecuteContext) => ChatStreamResult | Promise<ChatStreamResult>;
  createThread?: (ctx: {
    threadId: string;
    request: Request;
  }) => ChatThreadScope | Promise<ChatThreadScope>;
  /**
   * Guards an existing thread; return false to answer 403. Thread ids come from the client, so
   * without this any caller can post into someone else's thread. `createThread` cannot cover it -.
   */
  authorize?: (ctx: { thread: Thread; request: Request }) => boolean | Promise<boolean>;
  generateTitle?: (ctx: { firstUserMessage: UIMessage }) => string | Promise<string>;
  onError?: (error: unknown) => Response | undefined;
  /**
   * Awaited once the thread is resolved and before the reply streams. Returning `consumeSseStream`
   * hands it a tee'd copy of the outgoing stream. `resumableChat` registers its stream through this.
   */
  beforeStream?: BeforeStreamHook;
}

export interface BeforeStream {
  consumeSseStream?: (stream: ReadableStream<string>) => void | Promise<void>;
}

export type BeforeStreamHook = (ctx: {
  threadId: string;
  request: Request;
}) => BeforeStream | void | Promise<BeforeStream | void>;

const FORBIDDEN = Symbol("forbidden");

/** Part states meaning "still arriving": a reply carrying one of them was cut short. */
const IN_FLIGHT = new Set(["streaming", "input-streaming"]);

const text = (body: string, status: number) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

const isComplete = (message: UIMessage) =>
  message.parts.length > 0 &&
  !message.parts.some(
    (part) => "state" in part && typeof part.state === "string" && IN_FLIGHT.has(part.state),
  );

/** A fetch handler owning the whole persistence choreography for a chat route. */
export function chatHandler(options: ChatHandlerOptions) {
  const { store } = options;

  return async function handleChat(request: Request): Promise<Response> {
    let rollback: (() => Promise<void>) | undefined;
    try {
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        throw new ChatBodyError("request body must be valid JSON");
      }

      const parsed = parseChatBody(raw);
      const { threadId } = parsed;

      const thread = await loadOrCreateThread(options, threadId, request);
      if (thread === FORBIDDEN) return text("Forbidden", 403);

      const isFirstTurn = thread.activeLeafId === null;
      const needsTitle =
        options.generateTitle !== undefined && isFirstTurn && thread.title === null;

      const turn = await resolveHistory(options, parsed);
      rollback = turn.rollback;
      const uiMessages = turn.history;
      const modelMessages = await convertToModelMessages(uiMessages);

      const result = await options.execute({ threadId, uiMessages, modelMessages, request });

      const hooks = (await options.beforeStream?.({ threadId, request })) ?? {};

      // `originalMessages` is omitted deliberately: given a list ending in an assistant message
      // the SDK reuses that id, colliding with the stored row and losing the reply.
      // Both callback names are passed - ai 6 fires onFinish, ai 7 onEnd - guarded to persist once.
      let persisted = false;
      const persistReply = async ({ responseMessage }: { responseMessage: UIMessage }) => {
        if (persisted) return;
        // A disconnect leaves the reply empty or half-streamed. Storing it would render as
        // forever-in-progress and feed a half-sentence to the model next turn.
        if (!isComplete(responseMessage)) {
          console.warn(
            "ai-sdk-threads: the reply did not finish streaming; not storing it",
            `(thread ${threadId})`,
          );
          return;
        }
        // Latched only once a complete reply is in hand: closing it earlier meant an incomplete
        // first callback permanently blocked a later complete one from being stored.
        persisted = true;
        try {
          await store.appendMessages(threadId, [responseMessage]);
        } catch (error) {
          // Throwing here lands in stream teardown, where nothing can act on it.
          console.error("ai-sdk-threads: failed to persist the assistant message", error);
        }
      };

      const response = result.toUIMessageStreamResponse({
        generateMessageId: generateId,
        ...(hooks.consumeSseStream && {
          consumeSseStream: ({ stream }) => hooks.consumeSseStream?.(stream),
        }),
        onEnd: persistReply,
        onFinish: persistReply,
      });

      // Runs the stream to completion server-side even if the client stalls. Needs its own
      // onError; the SDK swallows mid-stream failures otherwise.
      void result.consumeStream({
        onError: (error) =>
          console.error("ai-sdk-threads: the model stream failed before completing", error),
      });

      if (needsTitle) {
        const firstUserMessage = uiMessages.find((message) => message.role === "user");
        if (firstUserMessage) scheduleTitle(options, threadId, firstUserMessage);
      }

      return response;
    } catch (error) {
      await rollback?.().catch((failure) => {
        console.error("ai-sdk-threads: could not restore the thread's active leaf", failure);
      });
      if (error instanceof ChatBodyError) return text(error.message, 400);
      const override = options.onError?.(error);
      if (override) return override;
      console.error("ai-sdk-threads: chat handler failed", error);
      return text("Internal Server Error", 500);
    }
  };
}

/**
 * Key order is not stable across the jsonb write and the zod read, so a plain JSON.stringify
 * comparison would read an unchanged retry as an edit and fork the thread.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const sameParts = (a: UIMessage, b: UIMessage) => canonical(a.parts) === canonical(b.parts);

/** A client-supplied id that names nothing is a bad request, not a server fault. */
const asBadRequest = async <T>(work: Promise<T>): Promise<T> => {
  try {
    return await work;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not found in thread/.test(message)) throw new ChatBodyError(message);
    throw error;
  }
};

export interface ResolvedTurn {
  history: UIMessage[];
  /** Restores thread state if the request fails after it was changed. */
  rollback?: () => Promise<void>;
}

/**
 * Applies what this request means to the thread and returns the history to answer from. The shapes
 * client's shapes are told apart by `trigger` plus `messageId`; a retry - same id, same parts - adds nothing.
 */
async function resolveHistory(
  options: ChatHandlerOptions,
  parsed: ParsedChatBody,
): Promise<ResolvedTurn> {
  const { store } = options;
  const { threadId, incoming, trigger, messageId } = parsed;
  const existing = await store.loadMessages(threadId);

  if (trigger === "regenerate-message") {
    if (!store.regenerateFrom) {
      console.warn(
        "ai-sdk-threads: this store cannot branch, so the regenerate is answered as a new turn",
      );
      return { history: existing };
    }
    // `regenerate()` with no argument means the last answer, which is what the SDK client sends.
    const target = messageId ?? [...existing].reverse().find((m) => m.role === "assistant")?.id;
    if (target === undefined) return { history: existing };

    const previousLeaf = existing[existing.length - 1]?.id ?? null;
    await asBadRequest(store.regenerateFrom(threadId, target));
    return {
      history: await store.loadMessages(threadId),
      // The leaf moved before streaming, so a failed reply would otherwise leave the thread
      // truncated - worse than the pre-branching behaviour, where a failure was a no-op.
      rollback: async () => {
        if (previousLeaf && store.setActiveLeaf) {
          await store.setActiveLeaf(threadId, previousLeaf);
        }
      },
    };
  }

  const edited = messageId === undefined ? undefined : incoming.find((m) => m.id === messageId);
  const stored = messageId === undefined ? undefined : existing.find((m) => m.id === messageId);

  if (messageId !== undefined && edited && !stored && existing.length > 0) {
    // The id is not on the live path. Silently ignoring it would drop the user's edit, so say so.
    throw new ChatBodyError(
      `message "${messageId}" is not on this thread's current path; reload before editing it`,
    );
  }

  let replaced: string | undefined;
  if (edited && stored && !sameParts(edited, stored) && store.replaceMessage) {
    const [replacement] = await acceptable([edited]);
    if (replacement) {
      // Rewritten in place, keeping the id, with the old wording preserved as a sibling that
      // holds the old replies. Keeping the id is what lets the same message be edited twice.
      await asBadRequest(store.replaceMessage(threadId, messageId as string, replacement));
      replaced = messageId;
    }
  }

  // The default transport reposts the whole conversation every turn, so anything already stored
  // has to be dropped here or it collides on the message primary key.
  const known = new Set(existing.map((m) => m.id));
  const fresh = await acceptable(incoming.filter((m) => !known.has(m.id) && m.id !== replaced));

  // Stored before streaming so a mid-stream crash cannot lose the user's message. Appended even
  // on the edit path: a request can carry an edit AND a new message, and dropping the latter
  // silently would be worse than the collision the check above prevents.
  if (fresh.length > 0) await store.appendMessages(threadId, fresh);

  if (replaced !== undefined) return { history: await store.loadMessages(threadId) };

  // Assembled rather than re-read: both halves are already validated, and re-loading would
  // rescan and revalidate the entire thread on every turn.
  return { history: [...existing, ...fresh] };
}

/**
 * Vets what this request adds, before the insert: a row the SDK cannot parse would fail every
 * future load of the thread, so one bad request would brick the conversation permanently.
 */
async function acceptable(candidates: UIMessage[]): Promise<UIMessage[]> {
  if (candidates.length === 0) return [];

  // Accepting a new system or assistant message would let a client forge context that every
  // later turn on this thread inherits.
  const forged = candidates.find((message) => message.role !== "user");
  if (forged) {
    throw new ChatBodyError(`only new "user" messages are accepted, received "${forged.role}"`);
  }

  const validated = await safeValidateUIMessages({ messages: candidates });
  if (!validated.success) {
    throw new ChatBodyError(`message failed validation: ${validated.error.message}`);
  }
  return validated.data;
}

async function loadOrCreateThread(
  options: ChatHandlerOptions,
  threadId: string,
  request: Request,
): Promise<Thread | typeof FORBIDDEN> {
  const { store } = options;
  const gate = async (thread: Thread) => {
    const allowed = (await options.authorize?.({ thread, request })) ?? true;
    return allowed ? thread : FORBIDDEN;
  };

  const found = await store.getThread(threadId);
  if (found) return gate(found);

  const scope = (await options.createThread?.({ threadId, request })) ?? {};
  try {
    return await store.createThread({ id: threadId, ...scope });
  } catch (error) {
    // Read-then-create races a concurrent first request for the same id; adopt its thread.
    const raced = await store.getThread(threadId);
    if (raced) return gate(raced);
    throw error;
  }
}

/** Detached and warn-only: titling must never delay or fail the response. */
function scheduleTitle(
  options: ChatHandlerOptions,
  threadId: string,
  firstUserMessage: UIMessage,
): void {
  void (async () => {
    try {
      const title = await options.generateTitle?.({ firstUserMessage });
      if (title !== undefined) await options.store.updateThread(threadId, { title });
    } catch (error) {
      console.warn("ai-sdk-threads: title generation failed", error);
    }
  })();
}
