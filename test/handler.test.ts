import { describe, expect, test } from "vitest";
import { ChatBodyError, parseChatBody } from "../src/handler/body.js";

const userMsg = (id: string, text: string) => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

describe("parseChatBody", () => {
  test("accepts the default full-history shape", () => {
    const parsed = parseChatBody({
      id: "t1",
      messages: [userMsg("m1", "one"), userMsg("m2", "two")],
      trigger: "submit-message",
      messageId: undefined,
    });
    expect(parsed.threadId).toBe("t1");
    expect(parsed.incoming.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(parsed.trigger).toBe("submit-message");
    expect(parsed.messageId).toBeUndefined();
  });

  test("accepts the last-message shape from prepareSendMessagesRequest", () => {
    const parsed = parseChatBody({ id: "t1", message: userMsg("m9", "only") });
    expect(parsed.threadId).toBe("t1");
    expect(parsed.incoming.map((m) => m.id)).toEqual(["m9"]);
  });

  test("defaults a missing trigger to submit-message", () => {
    expect(parseChatBody({ id: "t1", messages: [userMsg("m1", "x")] }).trigger).toBe(
      "submit-message",
    );
  });

  test("carries the regenerate trigger and its messageId", () => {
    const parsed = parseChatBody({
      id: "t1",
      messages: [userMsg("m1", "x")],
      trigger: "regenerate-message",
      messageId: "a1",
    });
    expect(parsed.trigger).toBe("regenerate-message");
    expect(parsed.messageId).toBe("a1");
  });

  test.each([
    ["a non-object body", "nope"],
    ["null", null],
    ["an array", []],
    ["a missing id", { messages: [userMsg("m1", "x")] }],
    ["a non-string id", { id: 7, messages: [userMsg("m1", "x")] }],
    ["an empty id", { id: "", messages: [userMsg("m1", "x")] }],
    ["no messages at all", { id: "t1" }],
    ["an empty messages array", { id: "t1", messages: [] }],
    ["a non-array messages", { id: "t1", messages: "hi" }],
    ["a non-object message entry", { id: "t1", messages: ["hi"] }],
    ["a non-object single message", { id: "t1", message: "hi" }],
    ["an unknown trigger", { id: "t1", messages: [userMsg("m1", "x")], trigger: "nope" }],
    ["a non-string messageId", { id: "t1", messages: [userMsg("m1", "x")], messageId: 7 }],
  ])("rejects %s", (_label, body) => {
    expect(() => parseChatBody(body)).toThrow(ChatBodyError);
  });

  test("error messages name the offending field", () => {
    expect(() => parseChatBody({ messages: [] })).toThrow(/id/);
    expect(() => parseChatBody({ id: "t1" })).toThrow(/message/);
  });
});
