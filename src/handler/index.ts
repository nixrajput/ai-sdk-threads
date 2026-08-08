import type { ModelMessage, UIMessage } from "ai";
import { convertToModelMessages, generateId, safeValidateUIMessages } from "ai";
import type { Thread, ThreadStore } from "../types.js";
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
  store: ThreadStore;
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

      // `trigger` and `messageId` are parsed but not acted on until branching lands: a
      // regenerate re-answers instead of forking, and an edit resend is treated as nothing new.
      const { threadId, incoming } = parseChatBody(raw);

      const thread = await loadOrCreateThread(options, threadId, request);
      if (thread === FORBIDDEN) return text("Forbidden", 403);

      const isFirstTurn = thread.activeLeafId === null;
      const needsTitle =
        options.generateTitle !== undefined && isFirstTurn && thread.title === null;

      // The default transport reposts the whole conversation every turn, so anything already
      // stored has to be dropped here or it collides on the message primary key.
      const existing = await store.loadMessages(threadId);
      const existingIds = new Set(existing.map((message) => message.id));
      const fresh = await acceptable(incoming.filter((m) => !existingIds.has(m.id)));

      // Stored before streaming so a mid-stream crash cannot lose the user's message.
      if (fresh.length > 0) await store.appendMessages(threadId, fresh);

      // Assembled rather than re-read: both halves are already validated, and re-loading would
      // rescan and revalidate the entire thread on every turn.
      const uiMessages = [...existing, ...fresh];
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
