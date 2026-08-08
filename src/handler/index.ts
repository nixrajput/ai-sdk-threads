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
   * without this any caller can post into someone else's thread. `createThread` cannot cover
   * it - that only fires for ids which do not exist yet.
   */
  authorize?: (ctx: { thread: Thread; request: Request }) => boolean | Promise<boolean>;
  generateTitle?: (ctx: { firstUserMessage: UIMessage }) => string | Promise<string>;
  onError?: (error: unknown) => Response | undefined;
  /**
   * Awaited once the thread is resolved and before the reply streams. Returning
   * `consumeSseStream` hands it a tee'd copy of the outgoing stream; `resumableChat` uses this
   * seam to register the stream for resuming before the response can reach the client.
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

      const uiMessages = await resolveHistory(options, parsed);
      const modelMessages = await convertToModelMessages(uiMessages);

      const result = await options.execute({ threadId, uiMessages, modelMessages, request });

      const hooks = (await options.beforeStream?.({ threadId, request })) ?? {};

      // `originalMessages` is deliberately omitted: when the list it receives ends with an
      // assistant message the SDK reuses that id and reseeds the reply from its parts, which
      // collides with the stored row and loses the answer. generateMessageId is what supplies
      // an id at all - without either, the reply arrives with id "".
      const response = result.toUIMessageStreamResponse({
        generateMessageId: generateId,
        ...(hooks.consumeSseStream && {
          consumeSseStream: ({ stream }) => hooks.consumeSseStream?.(stream),
        }),
        onEnd: async ({ responseMessage }) => {
          // A disconnect leaves the reply empty or half-streamed. Storing it would render as
          // forever-in-progress and feed a half-sentence to the model next turn.
          if (!isComplete(responseMessage)) {
            console.warn(
              "ai-sdk-threads: the reply did not finish streaming; not storing it",
              `(thread ${threadId})`,
            );
            return;
          }
          try {
            await store.appendMessages(threadId, [responseMessage]);
          } catch (error) {
            // Throwing here lands in stream teardown, where nothing can act on it.
            console.error("ai-sdk-threads: failed to persist the assistant message", error);
          }
        },
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
      if (error instanceof ChatBodyError) return text(error.message, 400);
      const override = options.onError?.(error);
      if (override) return override;
      console.error("ai-sdk-threads: chat handler failed", error);
      return text("Internal Server Error", 500);
    }
  };
}

/** Parts compared as stored: an edit resend reuses the message id but changes the content. */
const sameParts = (a: UIMessage, b: UIMessage) =>
  JSON.stringify(a.parts) === JSON.stringify(b.parts);

/**
 * Applies what this request means to the thread and returns the history to answer from. The
 * three shapes the SDK client can send are told apart by `trigger` plus `messageId`: a regenerate
 * names the message to redo, an edit reuses an existing id with new parts, and anything else is
 * a new turn. A retry - same id, same parts - must add nothing.
 */
async function resolveHistory(
  options: ChatHandlerOptions,
  parsed: ParsedChatBody,
): Promise<UIMessage[]> {
  const { store } = options;
  const { threadId, incoming, trigger, messageId } = parsed;
  const existing = await store.loadMessages(threadId);

  if (trigger === "regenerate-message" && messageId !== undefined) {
    if (!store.regenerateFrom) {
      console.warn(
        "ai-sdk-threads: this store cannot branch, so the regenerate is answered as a new turn",
      );
      return existing;
    }
    // Drops the leaf back to the target's parent; the fresh answer lands as its sibling.
    await store.regenerateFrom(messageId);
    return store.loadMessages(threadId);
  }

  const edited =
    messageId === undefined ? undefined : incoming.find((message) => message.id === messageId);
  const stored =
    messageId === undefined ? undefined : existing.find((message) => message.id === messageId);

  if (edited && stored && !sameParts(edited, stored) && store.forkAt) {
    const [replacement] = await acceptable([edited]);
    if (replacement) {
      // A fresh id, because the client reuses the edited message's id and the original row still
      // holds it - the old wording is kept as a sibling rather than overwritten.
      await store.forkAt(messageId as string, [{ ...replacement, id: generateId() }]);
      return store.loadMessages(threadId);
    }
  }

  // The default transport reposts the whole conversation every turn, so anything already stored
  // has to be dropped here or it collides on the message primary key. Matched against the whole
  // tree, not the live path: after an edit the client keeps resending the id it knows, which now
  // belongs to a row sitting on an abandoned branch.
  const known = store.getTree ? await store.getTree(threadId) : existing;
  const existingIds = new Set(known.map((message) => message.id));
  const fresh = await acceptable(incoming.filter((message) => !existingIds.has(message.id)));

  // Stored before streaming so a mid-stream crash cannot lose the user's message.
  if (fresh.length > 0) await store.appendMessages(threadId, fresh);

  // Assembled rather than re-read: both halves are already validated, and re-loading would
  // rescan and revalidate the entire thread on every turn.
  return [...existing, ...fresh];
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
