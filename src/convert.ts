import type { ModelMessage, ToolResultPart, UIMessage } from "ai";
import { generateId } from "ai";

export interface ConvertToUIMessagesOptions {
  generateId?: () => string;
}

type UIPart = UIMessage["parts"][number];

/** Built loosely because the SDK's tool-part union is per-state and cannot be narrowed in place. */
interface OpenToolPart {
  type: `tool-${string}`;
  toolCallId: string;
  state: "input-available" | "output-available" | "output-error";
  input: unknown;
  output?: unknown;
  errorText?: string;
}

const unsupported = (what: string) =>
  new Error(
    `ai-sdk-threads: convertToUIMessages does not support ${what}. ` +
      "Open an issue at https://github.com/nixrajput/ai-sdk-threads/issues if you need it.",
  );

/** Reverses the SDK's own mapping, which wraps raw output as `{ type: "json" | "text", value }`. */
function applyOutput(part: OpenToolPart, output: ToolResultPart["output"]): void {
  switch (output.type) {
    case "text":
    case "json":
      part.state = "output-available";
      part.output = output.value;
      return;
    case "error-text":
      part.state = "output-error";
      part.errorText = output.value;
      return;
    case "error-json":
      part.state = "output-error";
      part.errorText = JSON.stringify(output.value);
      return;
    default:
      throw unsupported(`tool result output type "${output.type}"`);
  }
}

/**
 * `ModelMessage[]` back to the `UIMessage[]` shape `useChat` renders - the direction the SDK
 * does not ship (vercel/ai#7180). Tool results fold into the assistant message that called
 * them, and unsupported content throws so a lossy conversion cannot reach a database.
 */
export function convertToUIMessages(
  modelMessages: ModelMessage[],
  options?: ConvertToUIMessagesOptions,
): UIMessage[] {
  const nextId = options?.generateId ?? generateId;
  const messages: UIMessage[] = [];
  // Values are the same objects already pushed into `parts`, so upgrading one updates the message.
  let openToolParts = new Map<string, OpenToolPart>();

  const resolve = (toolCallId: string, output: ToolResultPart["output"]): void => {
    const part = openToolParts.get(toolCallId);
    if (!part) {
      throw new Error(
        `ai-sdk-threads: tool result "${toolCallId}" matches no tool call in the preceding message`,
      );
    }
    applyOutput(part, output);
  };

  for (const message of modelMessages) {
    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type !== "tool-result") throw unsupported(`tool content part "${part.type}"`);
        resolve(part.toolCallId, part.output);
      }
      continue;
    }

    openToolParts = new Map();
    const parts: UIPart[] = [];

    if (typeof message.content === "string") {
      parts.push({ type: "text", text: message.content });
    } else {
      for (const part of message.content) {
        switch (part.type) {
          case "text":
            parts.push({ type: "text", text: part.text });
            break;
          case "reasoning":
            parts.push({ type: "reasoning", text: part.text });
            break;
          case "tool-call": {
            const toolPart: OpenToolPart = {
              type: `tool-${part.toolName}`,
              toolCallId: part.toolCallId,
              state: "input-available",
              input: part.input,
            };
            openToolParts.set(part.toolCallId, toolPart);
            parts.push(toolPart as unknown as UIPart);
            break;
          }
          // A provider-executed tool carries its result in the assistant message itself.
          case "tool-result":
            resolve(part.toolCallId, part.output);
            break;
          default:
            throw unsupported(`${message.role} content part "${part.type}"`);
        }
      }
    }

    messages.push({ id: nextId(), role: message.role, parts });
  }

  return messages;
}
