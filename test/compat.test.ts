import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { convertToModelMessages, safeValidateUIMessages } from "ai";
import { describe, expect, test } from "vitest";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const shapesFor = (major: string) =>
  readdirSync(join(fixtures, `parts-v${major}`))
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => [file.replace(/\.json$/, ""), join(fixtures, `parts-v${major}`, file)] as const);

// The store keeps UIMessage parts verbatim, so what actually matters across an SDK upgrade is
// whether the new major still reads the old rows. These fixtures were captured by running the real
// ai@5, ai@6 and ai@7 (scripts/capture-fixtures.ts) - if a future major breaks the format, one of
// these fails and the migration story stops being "nothing to do". 7 is the current major, so its
// case is trivially true today and becomes the real test the moment 8 lands.
describe.each([["5"], ["6"], ["7"]])("parts written by ai@%s", (major) => {
  test.each(shapesFor(major))("a %s message still validates and converts", async (_shape, path) => {
    const parts = JSON.parse(readFileSync(path, "utf8"));
    const result = await safeValidateUIMessages({
      messages: [{ id: "m1", role: "assistant", parts }],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    // Readable is not enough: it also has to be sendable back to a model.
    const modelMessages = await convertToModelMessages(result.data);
    expect(modelMessages.length).toBeGreaterThan(0);
  });
});

// migrateParts is a pass-through only because the payloads genuinely match. Asserting it here means
// a future major that changes a shape fails this rather than silently storing a lossy row.
test.each(["text", "reasoning", "tool-call", "file"])(
  "a %s part is byte-identical across every supported major",
  (shape) => {
    const read = (major: string) =>
      readFileSync(join(fixtures, `parts-v${major}`, `${shape}.json`), "utf8");
    expect(read("5")).toBe(read("7"));
    expect(read("6")).toBe(read("7"));
  },
);
