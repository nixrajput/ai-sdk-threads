# AI Agent Guidelines

Last updated: 2026-08-08

---

## Project

**ai-sdk-threads** persists chat threads and messages for the Vercel AI SDK. It stores `UIMessage` parts verbatim rather than inventing a message format of its own, so what `useChat` sends is what comes back.

| Area          | Detail                                                                 |
| ------------- | ---------------------------------------------------------------------- |
| Language      | TypeScript strict, ESM only, Node `>=20`                               |
| Build         | tsdown (CLI flags, not a config file) + publint + attw                 |
| Tests         | vitest against PGlite - real Postgres semantics, in-process, no Docker |
| Lint / format | Biome - double quotes, semicolons, trailing commas, 100 columns        |
| Peers         | `ai` (`>=6 <8`, dev-tested on 7.0.x); `drizzle-orm` `^0.45` (optional) |
| Runtime deps  | none, in the core or the adapter - this is a feature, not an accident  |

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
test/
  db.ts             makeDb() - a fresh PGlite + drizzle database per test
```

Three build entry points, one per public subpath: `.`, `./drizzle`, `./handler`. Adding a subpath means adding it to `exports` **and** to the tsdown entry list in the `build` script.

`handler/index.ts` is where every AI SDK streaming touchpoint lives, deliberately: an SDK major that renames `toUIMessageStreamResponse`, `onEnd`, `generateMessageId`, or `consumeStream` is a change in that one file. Two behaviours there were established by measurement, not documentation, and both have a regression test - do not "simplify" either away. `originalMessages` is never passed (given a history ending in an assistant message the SDK reuses that id and loses the new reply), and a reply is only stored once no part is still in a streaming state (a disconnect otherwise persists a half-sentence).

### The data model

Two tables. `ai_sdk_threads` holds the thread plus an `activeLeafId`; `ai_sdk_messages` holds one row per message with a `parentId`. Messages therefore form a **tree**, and the thread's active conversation is the path from `activeLeafId` back to the root - that is what `orderPath()` walks and what `loadMessages()` returns.

The current APIs only ever use that tree linearly (append chains to the leaf, the leaf advances). The tree exists from v0.1 anyway so that branching does not require a breaking schema change later. Do not "simplify" `parentId` or `activeLeafId` away - and do not add branching APIs before the plan says to.

Table names are prefixed `ai_sdk_` because the tables land in the consumer's own database next to their application tables.

`parts` and `metadata` are `jsonb` and store `UIMessage` shapes verbatim; `sdkVersion` records which `ai` major wrote the row, so a future major can migrate rows rather than guess at them.

### The checks

`npm run lint`, `npm run ts:check`, `npm test`, `npm run build`. CI runs exactly these four in the `build` job, and repeats lint/typecheck/test on the Node 20 floor in a second job (tsdown itself needs >=22.18, so the floor job skips `build`). `.githooks/pre-push` runs them too (`git config core.hooksPath .githooks`).

`ts:check` runs `tsc` twice: once normally, once with `tsconfig.no-node.json`, which typechecks `src/` with no Node types at all. AI SDK routes commonly run on edge runtimes, so a `process` or `Buffer` reference anywhere in `src/` is a bug and fails there. If a file ever genuinely needs Node, exempt it deliberately rather than deleting the guard.

`.githooks/pre-push` also prints an inform-only report: per-file size deltas against the published version, npm/Bundlephobia bundle metrics, benchmarks, knip, and coverage. It never blocks a push (`|| true`), skips bench and coverage when no `src/`, `test/`, `bench/`, or `package.json` file changed, and uses a short bench sample. `npm run report` runs the full-fidelity version, and CI attaches it to every PR summary.

### Conventions

- Conventional Commits, imperative subject `<=` 50 chars, no trailing period, no `Co-Authored-By` or `Generated with` trailers.
- Never use em-dashes anywhere - in code, comments, commits, docs, or PR text. Use a hyphen.
- Every PR that changes anything users receive bumps `package.json` version - CI gate `version bumped` enforces it. The gate waives itself when a PR touches only `.github`, `.claude`, `.githooks`, `scripts`, `bench`, or the governance docs; `README.md` is excluded from that waiver because it ships in the tarball.
- The PR title becomes the squash commit message.
- `main` is protected: PR required, squash-only merges.
- The README documents **shipped features only** - no roadmap, no plans. Planning artifacts live outside this repo and are never committed.
- `aliases/` holds published name reservations (`ai-threads`, `ai-sdk-persistence`). Leave them alone unless a task is explicitly about them; Biome excludes the directory for that reason.
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
