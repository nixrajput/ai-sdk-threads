import type { UIMessage } from "ai";

// Read off the installed ai 7.0.x HttpChatTransport: its default body is `{ id, messages, trigger,
// messageId }` carrying the FULL history, while a custom prepareSendMessagesRequest commonly sends
// `{ id, message }`. The transport's third trigger, 'resume-stream', never reaches a POST body -.

export type ChatTrigger = "submit-message" | "regenerate-message";

export interface ParsedChatBody {
  threadId: string;
  incoming: UIMessage[];
  trigger: ChatTrigger;
  messageId?: string;
}

/** Malformed request body; callers answer 400. */
export class ChatBodyError extends Error {
  constructor(message: string) {
    super(`ai-sdk-threads: ${message}`);
    this.name = "ChatBodyError";
  }
}

const TRIGGERS: ChatTrigger[] = ["submit-message", "regenerate-message"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Envelope only; message contents are validated against the SDK's schema by the caller. */
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

  // Rows are keyed by message id, so both of these would otherwise reach the database and
  // come back as a primary-key violation - a 500 for what is a malformed request.
  const ids = new Set<string>();
  for (const message of incoming) {
    const { id: messageId } = message;
    if (typeof messageId !== "string" || messageId === "") {
      throw new ChatBodyError('every message needs a non-empty string "id"');
    }
    if (ids.has(messageId)) {
      throw new ChatBodyError(`duplicate message id "${messageId}" in one request`);
    }
    ids.add(messageId);
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
