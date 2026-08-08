import { describe, expect, test } from "vitest";
import { orderPath } from "../src/chain.js";
import type { StoredMessage } from "../src/types.js";

const msg = (id: string, parentId: string | null): StoredMessage => ({
  id,
  threadId: "t1",
  parentId,
  role: "user",
  parts: [],
  metadata: null,
  sdkVersion: 7,
  createdAt: new Date(),
});

describe("orderPath", () => {
  test("orders a linear chain root-first", () => {
    const rows = [msg("c", "b"), msg("a", null), msg("b", "a")];
    expect(orderPath(rows, "c").map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  test("follows only the active branch", () => {
    // a -> b -> c   and a sibling fork  a -> b2
    const rows = [msg("a", null), msg("b", "a"), msg("c", "b"), msg("b2", "a")];
    expect(orderPath(rows, "b2").map((m) => m.id)).toEqual(["a", "b2"]);
  });

  test("null leaf yields empty, broken link throws", () => {
    expect(orderPath([msg("a", null)], null)).toEqual([]);
    expect(() => orderPath([msg("c", "missing")], "c")).toThrow(/missing/);
  });
});
