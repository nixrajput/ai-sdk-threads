import { describe, expect, test } from "vitest";
import { convertToUIMessages } from "../src/convert.js";

describe("convertToUIMessages", () => {
  test("maps simple text turns", () => {
    const ui = convertToUIMessages([
      { role: "system", content: "be nice" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello!" },
    ]);
    expect(ui).toHaveLength(3);
    expect(ui[1]).toMatchObject({
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    });
    expect(ui.every((m) => typeof m.id === "string" && m.id.length > 0)).toBe(true);
  });

  test("folds tool results into the assistant message", () => {
    const ui = convertToUIMessages([
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "checking" },
          { type: "tool-call", toolCallId: "call1", toolName: "getWeather", input: { city: "x" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call1",
            toolName: "getWeather",
            output: { type: "json", value: { temp: 21 } },
          },
        ],
      },
    ]);
    expect(ui).toHaveLength(2);
    const toolPart = ui[1].parts.find((p) => p.type === "tool-getWeather") as Record<
      string,
      unknown
    >;
    expect(toolPart).toMatchObject({
      toolCallId: "call1",
      state: "output-available",
      input: { city: "x" },
      output: { temp: 21 },
    });
  });

  test("tool call without result stays input-available", () => {
    const ui = convertToUIMessages([
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "f", input: {} }],
      },
    ]);
    const part = ui[0].parts[0] as Record<string, unknown>;
    expect(part).toMatchObject({ type: "tool-f", state: "input-available" });
  });

  test("maps reasoning parts and a failed tool call", () => {
    const ui = convertToUIMessages([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking" },
          { type: "tool-call", toolCallId: "c1", toolName: "f", input: { a: 1 } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "f",
            output: { type: "error-text", value: "boom" },
          },
        ],
      },
    ]);
    expect(ui[0].parts[0]).toMatchObject({ type: "reasoning", text: "thinking" });
    expect(ui[0].parts[1]).toMatchObject({ state: "output-error", errorText: "boom" });
  });

  test("throws on an unsupported content part rather than guessing", () => {
    expect(() =>
      convertToUIMessages([
        {
          role: "user",
          content: [{ type: "file", mediaType: "image/png", data: "AAAA" }],
        },
      ]),
    ).toThrow(/file/);
  });

  test("throws when a tool result matches no pending tool call", () => {
    expect(() =>
      convertToUIMessages([
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "nope",
              toolName: "f",
              output: { type: "json", value: 1 },
            },
          ],
        },
      ]),
    ).toThrow(/nope/);
  });

  test("uses the supplied id generator", () => {
    let n = 0;
    const ui = convertToUIMessages([{ role: "user", content: "hi" }], {
      generateId: () => `m${++n}`,
    });
    expect(ui[0].id).toBe("m1");
  });

  test("round-trips through the official converter", async () => {
    const { convertToModelMessages, validateUIMessages } = await import("ai");
    const ui = convertToUIMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello!" },
    ]);
    const validated = await validateUIMessages({ messages: ui });
    const back = await convertToModelMessages(validated);
    expect(back).toMatchObject([{ role: "user" }, { role: "assistant" }]);
  });

  test("round-trips a tool call through the official converter", async () => {
    const { convertToModelMessages, validateUIMessages } = await import("ai");
    const original = [
      { role: "user" as const, content: "weather?" },
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "c1",
            toolName: "getWeather",
            input: { city: "x" },
          },
        ],
      },
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: "c1",
            toolName: "getWeather",
            output: { type: "json" as const, value: { temp: 21 } },
          },
        ],
      },
    ];
    const validated = await validateUIMessages({ messages: convertToUIMessages(original) });
    const back = await convertToModelMessages(validated);
    // The SDK canonicalizes a string content into a single text part on the way back.
    expect(back).toMatchObject([
      { role: "user", content: [{ type: "text", text: "weather?" }] },
      original[1],
      original[2],
    ]);
  });
});
