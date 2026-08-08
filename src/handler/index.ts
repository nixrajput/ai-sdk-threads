import type { ModelMessage, UIMessage } from "ai";
import { convertToModelMessages, generateId } from "ai";
import type { ThreadStore } from "../types.js";
import { ChatBodyError, parseChatBody } from "./body.js";

// Every AI SDK touchpoint the route needs lives in this module, so an SDK major that moves
// these names is a change here and nowhere else. Verified against the installed ai 7.0.x:
// - `toUIMessageStreamResponse` is the response builder; its `onFinish` option is
//   deprecated in favour of `onEnd`.
// - `onEnd` receives { responseMessage, messages, isAborted, isContinuation, finishReason }.
// - `generateMessageId` is REQUIRED for the assistant reply to get an id: passing
//   `originalMessages` alone leaves it as "" unless the last original message is itself an
//   assistant message. Rows are keyed by message id, so an empty one is unusable.
// - `consumeStream()` runs the model stream to completion server-side. Measured: it does
//   NOT preserve the reply's content once the HTTP body is cancelled - onEnd then reports
//   empty parts with isAborted still false, which is why the guard below checks parts.

/**
 * The slice of a `streamText` result the handler uses. Structural on purpose: naming
 * `StreamTextResult` would pin three SDK generics that move between majors, and these are
 * the only two members called.
 */
export interface ChatStreamResult {
  toUIMessageStreamResponse(options: {
    originalMessages?: UIMessage[];
    generateMessageId?: () => string;
    onEnd?: (event: { responseMessage: UIMessage }) => void | PromiseLike<void>;
  }): Response;
  consumeStream(): PromiseLike<void>;
}

export interface ChatExecuteContext {
  threadId: string;
  /** The thread's full history, validated, including the incoming message. */
  uiMessages: UIMessage[];
  /** The same history converted for `streamText`. */
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
  /** Scoping for a thread this request is the first to mention. */
  createThread?: (ctx: {
    threadId: string;
    request: Request;
  }) => ChatThreadScope | Promise<ChatThreadScope>;
  generateTitle?: (ctx: { firstUserMessage: UIMessage }) => string | Promise<string>;
  /** Return a Response to override the default 500, or undefined to keep it. */
  onError?: (error: unknown) => Response | undefined;
}

const text = (body: string, status: number) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

/**
 * A fetch handler that owns the whole persistence choreography for a chat route: load the
 * thread, store the incoming message, stream the answer, and store the reply.
 */
export function chatHandler(options: ChatHandlerOptions) {
  const { store } = options;

  return async function handleChat(request: Request): Promise<Response> {
    let parsed: ReturnType<typeof parseChatBody>;
    try {
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        throw new ChatBodyError("request body must be valid JSON");
      }
      parsed = parseChatBody(raw);
    } catch (error) {
      if (error instanceof ChatBodyError) return text(error.message, 400);
      throw error;
    }

    const { threadId, incoming } = parsed;

    try {
      let thread = await store.getThread(threadId);
      if (!thread) {
        const scope = (await options.createThread?.({ threadId, request })) ?? {};
        thread = await store.createThread({ id: threadId, ...scope });
      }
      const isFirstTurn = thread.activeLeafId === null;
      const needsTitle =
        options.generateTitle !== undefined && isFirstTurn && thread.title === null;

      // The default transport posts the FULL history, a custom prepareSendMessagesRequest
      // posts only the last message. Storing whatever arrives would re-insert rows that are
      // already here and collide on the message id, so keep only what is genuinely new.
      const existing = await store.loadMessages(threadId);
      const existingIds = new Set(existing.map((message) => message.id));
      const fresh = incoming.filter((message) => !existingIds.has(message.id));
      // Before streaming, deliberately: a crash mid-stream must not lose the user's message.
      if (fresh.length > 0) await store.appendMessages(threadId, fresh);

      const uiMessages = fresh.length > 0 ? await store.loadMessages(threadId) : existing;
      const modelMessages = await convertToModelMessages(uiMessages);

      const result = await options.execute({ threadId, uiMessages, modelMessages, request });

      const response = result.toUIMessageStreamResponse({
        originalMessages: uiMessages,
        generateMessageId: generateId,
        onEnd: async ({ responseMessage }) => {
          // A client that disconnects mid-stream leaves responseMessage with no parts.
          // Storing it would put an empty assistant row at the head of the thread, so the
          // turn is left as just the user message and the client can retry.
          if (responseMessage.parts.length === 0) return;
          try {
            await store.appendMessages(threadId, [responseMessage]);
          } catch (error) {
            // Throwing here would surface during stream teardown, where nothing can act on
            // it. Loud logging is the only useful option left.
            console.error("ai-sdk-threads: failed to persist the assistant message", error);
          }
        },
      });

      // Not awaited: runs the model stream to completion server-side so a suspended or
      // slow client cannot leave it half-generated. Note it does NOT rescue the reply's
      // content once the HTTP body itself is cancelled - the UI stream that assembles
      // responseMessage is downstream of that body, hence the empty-parts guard above.
      void result.consumeStream();

      if (needsTitle) {
        const firstUserMessage = uiMessages.find((message) => message.role === "user");
        if (firstUserMessage) scheduleTitle(options, threadId, firstUserMessage);
      }

      return response;
    } catch (error) {
      const override = options.onError?.(error);
      if (override) return override;
      console.error("ai-sdk-threads: chat handler failed", error);
      return text("Internal Server Error", 500);
    }
  };
}

/** Titling must never delay or fail the response, so it runs detached and only warns. */
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
