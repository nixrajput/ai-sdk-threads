import type { UIMessage } from "ai";

// The wire shape, read off the installed ai 7.0.x HttpChatTransport. Its default body is
// `{ ...body, id, messages, trigger, messageId }` with the FULL history; a custom
// prepareSendMessagesRequest commonly sends `{ id, message }` with only the last one.
// `trigger` is 'submit-message' | 'regenerate-message' here - the third value the
// transport can produce, 'resume-stream', never reaches a POST body (it goes to the
// GET reconnect route instead).

export type ChatTrigger = "submit-message" | "regenerate-message";

export interface ParsedChatBody {
  threadId: string;
  incoming: UIMessage[];
  trigger: ChatTrigger;
  /** Present for regenerate, and for an edit or retry of an existing message. */
  messageId?: string;
}

/** A malformed request body. Callers should answer 400. */
export class ChatBodyError extends Error {
  constructor(message: string) {
    super(`ai-sdk-threads: ${message}`);
    this.name = "ChatBodyError";
  }
}

const TRIGGERS: ChatTrigger[] = ["submit-message", "regenerate-message"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Validates the request body's envelope only. The messages themselves are validated by
 * the SDK's `validateUIMessages` once loaded, so this checks shape and nothing more.
 */
export function parseChatBody(body: unknown): ParsedChatBody {
  if (!isRecord(body)) {
    throw new ChatBodyError("request body must be a JSON object");
  }

  const { id, messages, message, trigger, messageId } = body;

  if (typeof id !== "string" || id === "") {
    throw new ChatBodyError('request body needs a non-empty string "id" (the thread id)');
  }

  let incoming: unknown[];
  if (messages === undefined) {
    if (!isRecord(message)) {
      throw new ChatBodyError('request body needs "messages" (an array) or "message" (an object)');
    }
    incoming = [message];
  } else {
    if (!Array.isArray(messages)) {
      throw new ChatBodyError('"messages" must be an array');
    }
    if (messages.length === 0) {
      throw new ChatBodyError('"messages" must not be empty');
    }
    incoming = messages;
  }

  if (!incoming.every(isRecord)) {
    throw new ChatBodyError("every message must be an object");
  }

  if (trigger !== undefined && !TRIGGERS.includes(trigger as ChatTrigger)) {
    throw new ChatBodyError(`"trigger" must be one of ${TRIGGERS.join(", ")}`);
  }

  if (messageId !== undefined && typeof messageId !== "string") {
    throw new ChatBodyError('"messageId" must be a string when present');
  }

  return {
    threadId: id,
    incoming: incoming as unknown as UIMessage[],
    trigger: (trigger as ChatTrigger | undefined) ?? "submit-message",
    messageId,
  };
}
