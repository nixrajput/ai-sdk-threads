# AI Agent Guidelines

Last updated: 2026-08-08

---

## Project

**ai-sdk-threads** persists chat threads and messages for the Vercel AI SDK. It stores `UIMessage` parts verbatim rather than inventing a message format of its own, so what `useChat` sends is what comes back.

| Area          | Detail                                                                            |
| ------------- | --------------------------------------------------------------------------------- |
| Language      | TypeScript strict, ESM only, Node `>=20`                                          |
| Build         | tsdown (CLI flags, not a config file) + publint + attw                            |
| Tests         | vitest against PGlite - real Postgres semantics, in-process, no Docker            |
| Lint / format | Biome - double quotes, semicolons, trailing commas, 100 columns                   |
| Peers         | `ai` (`>=6 <8`, dev-tested on 7.0.x); `drizzle-orm` `^0.45` (optional)            |
| Runtime deps  | none. `ai`, `drizzle-orm` and `resumable-stream` are peers, the last two optional |

### Layout

```
src/
  index.ts          public barrel: types, orderPath, convertToUIMessages
  types.ts          Thread, StoredMessage, ThreadStore, CURRENT_SDK_MAJOR
  chain.ts          orderPath() - walks parent links from the active leaf, root-first
  convert.ts        convertToUIMessages() - ModelMessage[] -> UIMessage[]
  drizzle/schema.ts ai_sdk_threads + ai_sdk_messages tables, exported for user schemas
  drizzle/store.ts  createThreadStore(db)
  drizzle/index.ts  the ./drizzle subpath barrel
  handler/body.ts   parseChatBody() + ChatBodyError - the request envelope
  handler/index.ts  chatHandler() - the ./handler subpath barrel
  resume/index.ts   resumableChat() + createMemoryStreamContext() - the ./resume barrel
  store-core.ts     dialect-independent store logic shared by both adapters
  migrate.ts        migrateParts() - stored-parts compatibility across ai majors
  sqlite/           the SQLite mirror of drizzle/: same tables, text-JSON and integer timestamps
  cli/              migrate + import-vercel, and the bin that drives them
test/
  db.ts             makeDb() - a fresh PGlite + drizzle database per test
```

Six build entry points, one per public subpath: `.`, `./drizzle`, `./handler`, `./resume`, `./sqlite`, `./cli`. Adding a subpath means adding it to `exports` **and** to the tsdown entry list in the `build` script.

`handler/index.ts` holds the SDK's streaming touchpoints for the POST path (`toUIMessageStreamResponse`, `onEnd`, `generateMessageId`, `consumeStream`); `resume/index.ts` owns the ones for the resume path (`UI_MESSAGE_STREAM_HEADERS` and raw SSE `Response` construction). An SDK rename is a change in those two files and nowhere else - keep it that way. Two behaviours there were established by measurement, not documentation, and both have a regression test - do not "simplify" either away. `originalMessages` is never passed (given a history ending in an assistant message the SDK reuses that id and loses the new reply), and a reply is only stored once no part is still in a streaming state (a disconnect otherwise persists a half-sentence).

### The data model

Two tables. `ai_sdk_threads` holds the thread plus an `activeLeafId`; `ai_sdk_messages` holds one row per message with a `parentId`. Messages therefore form a **tree**, and the thread's active conversation is the path from `activeLeafId` back to the root - that is what `orderPath()` walks and what `loadMessages()` returns.

The tree is fully exercised now: `forkAt`, `regenerateFrom`, `siblingsOf`, `setActiveLeaf` and `getTree` live on `BranchingStore`, and `chatHandler` routes the SDK client's regenerate and edit shapes into them. Nothing is ever deleted - editing or regenerating leaves the old version as a sibling. Do not "simplify" `parentId` or `activeLeafId` away.

Every branching method takes a **`threadId`** alongside the message id, and refuses an id that does not belong to it. Message ids are a global primary key, so an unscoped lookup let a request mutate or read another thread - do not drop the thread argument for convenience.

Editing goes through `replaceMessage`, which rewrites the row in place and archives the previous version under a surrogate id, moving the old replies onto it. Keeping the client's id is what allows a second edit without a reload. The edit-vs-retry test compares parts **canonically**: jsonb does not preserve key order, so a plain `JSON.stringify` comparison turned an unchanged retry into a spurious branch. All of this has regression tests.

Table names are prefixed `ai_sdk_` because the tables land in the consumer's own database next to their application tables.

`parts` and `metadata` are `jsonb` and store `UIMessage` shapes verbatim; `sdkVersion` records which `ai` major wrote the row, so a future major can migrate rows rather than guess at them.

### The checks

`npm run gate` runs all four: `npm run lint`, `npm run ts:check`, `npm test`, `npm run build`. Use it, and trust the **exit code** - biome's failure output ends in blank lines, so piping any of these through `tail` makes a failure look exactly like a pass. CI runs the same four in the `build` job, and repeats lint/typecheck/test on the Node 20 floor in a second job (tsdown itself needs >=22.18, so the floor job skips `build`). `.githooks/pre-push` runs them too (`git config core.hooksPath .githooks`).

`ts:check` runs `tsc` twice: once normally, once with `tsconfig.no-node.json`, which typechecks `src/` with no Node types at all. AI SDK routes commonly run on edge runtimes, so a `process` or `Buffer` reference anywhere in `src/` is a bug and fails there. If a file ever genuinely needs Node, exempt it deliberately rather than deleting the guard - `src/cli` is the one exemption, because it is a `bin` entry that only runs under Node and nothing a consumer imports reaches it.

`.githooks/pre-push` also prints an inform-only report: per-file size deltas against the published version, npm/Bundlephobia bundle metrics, benchmarks, knip, and coverage. It never blocks a push (`|| true`), skips bench and coverage when no `src/`, `test/`, `bench/`, or `package.json` file changed, and uses a short bench sample. `npm run report` runs the full-fidelity version, and CI attaches it to every PR summary.

`resumableChat` reuses `chatHandler` through its single `beforeStream` seam rather than duplicating the choreography. Three things there were established by measurement and each has a regression test: the default stream context is one **process-wide** singleton (a per-call one gives the documented two-file route layout two contexts that cannot see each other, so resume silently never works); `GET`/`DELETE` run `authorize` themselves because `chatHandler` only guards POST; and everything inside `consumeSseStream` is wrapped, because the SDK discards that promise and an escaping rejection takes the process down.

Both adapters share `src/store-core.ts` and each writes its own queries; `test/parity.test.ts` runs the whole contract against both, which is what stops them drifting. SQLite has no `SELECT ... FOR UPDATE` (a write transaction already holds the database) and needs `PRAGMA foreign_keys = ON` or the cascade silently does nothing.

`src/cli/bin.ts` is the executable and `src/cli/index.ts` is what consumers import - keep them apart, and keep index.ts free of Node APIs. The bin's self-exec guard resolves **realpaths on both sides**: npm installs it as a symlink and Node loads the module through the target, so any string comparison silently makes the whole CLI a no-op that exits 0. `test/cli.test.ts` runs it through a symlink for exactly that reason.

The SQLite adapter needs an **async** driver (libsql). Writes use interactive transactions with an async callback: better-sqlite3 rejects it, Bun's driver does not await it, and D1 has no interactive transactions - on those, atomicity would be lost silently rather than reported.

CI runs the suite against the **ai 6 floor** as well as 7, because `peerDependencies` claim `>=6 <8`. That job is not ceremony: it caught the handler passing only ai 7's `onEnd`, so no reply was ever persisted on ai 6. Both `onEnd` and `onFinish` are passed now, guarded so only one fires. The test model rig in `test/model.ts` detects which provider spec the installed major ships - keep it that way or the v6 job stops exercising the streaming code.

Stored `UIMessage.parts` are identical across ai 5, 6 and 7. That is measured: `test/fixtures/parts-v{5,6}` hold real captured payloads and `test/compat.test.ts` asserts the current SDK still reads them. `migrateParts` is therefore a pass-through today, and those fixtures are the tripwire that tells you when it stops being one.

### Conventions

- Conventional Commits, imperative subject `<=` 50 chars, no trailing period, no `Co-Authored-By` or `Generated with` trailers.
- Never use em-dashes anywhere - in code, comments, commits, docs, or PR text. Use a hyphen.
- Every PR that changes anything users receive bumps `package.json` version - CI gate `version bumped` enforces it. The gate waives itself when a PR touches only `.github`, `.claude`, `.githooks`, `scripts`, `bench`, or the governance docs; `README.md` is excluded from that waiver because it ships in the tarball.
- The PR title becomes the squash commit message.
- `main` is protected: PR required, squash-only merges.
- The README documents **shipped features only** - no roadmap, no plans. Planning artifacts live outside this repo and are never committed.
- `aliases/` holds published name reservations (`ai-threads`, `ai-sdk-persistence`). Leave them alone unless a task is explicitly about them; Biome excludes the directory for that reason.
- Biome's `noConfusingVoidType` is off: the public callback types need `void` in a union, because `undefined` there rejects a callback that just does work and returns nothing - the common case, and the shape the AI SDK's own callbacks use.
- Markdown prose is never hard-wrapped: one line per paragraph and per list item. Do not re-wrap these files to a column.

---

## Always-Active Instructions

> These apply to EVERY interaction, automatically.

### Working Discipline

> Behavioral guidelines to reduce common LLM coding mistakes. Bias toward caution over speed; for trivial tasks, use judgment.

#### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- Read existing code and understand patterns before proposing changes.
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

#### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

#### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

#### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" -> "Write tests for invalid inputs, then make them pass"
- "Fix the bug" -> "Write a test that reproduces it, then make it pass"
- "Refactor X" -> "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] -> verify: [check]
2. [Step] -> verify: [check]
3. [Step] -> verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

#### 5. Report What Was Done

After completing work, state what changed and why - not just that it's done.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

### Multi-Agent Safety Rules

- **Never** create/apply/drop git stash entries unless explicitly requested
- **Never** edit files in `node_modules/`, `vendor/`, or other dependency directories
- **Always** work on a dedicated branch when running concurrent agents
- **Never** force-push or rebase shared branches from an agent session
- **Verify** no other agent is modifying the same files before making changes

### Release Safety

- **Never** merge a PR or publish to npm without explicit approval. Merging `main` triggers the tag, the GitHub Release, and `npm publish` via OIDC in one shot - for this package **and** the two alias packages - and a published version number can never be reused.

---
