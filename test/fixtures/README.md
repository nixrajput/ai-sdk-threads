# Stored-message fixtures

Real `UIMessage.parts` captured by streaming each shape through the SDK's own `readUIMessageStream` under `ai@5`, `ai@6` and `ai@7` - never hand-authored from changelogs. They are the evidence behind the compatibility claim in `test/compat.test.ts`: the parts this package stores are accepted unchanged by the current SDK, and are byte-identical across every supported major.

That identity is what lets `migrateParts` be a pass-through, and `compat.test.ts` asserts it rather than trusting the comment - so a future major that changes a part shape fails the suite instead of quietly storing a lossy row.

The provider-level stream part is *not* stable, which is the point. `ai@7` emits a file as `{ type: "file", mediaType, data: { type: "data", data } }` where `ai@5` emitted a flat `data`; both land in storage as the same `{ type: "file", mediaType, url }`. The SDK's internals move, the persisted shape does not.

## Re-capturing

```bash
npx tsx scripts/capture-fixtures.ts
```

It reads the installed `ai` major and writes `parts-v<major>/`. Run it once under each new major - under `ai@8`, it produces `parts-v8` and turns the existing `parts-v7` case in `compat.test.ts` from a tautology into the real backward-compatibility test.
