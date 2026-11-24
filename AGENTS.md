# AI Agent Guidelines

Last updated: 2026-10-07

---

## Project

**ai-sdk-threads** persists chat threads and messages for the Vercel AI SDK. It stores `UIMessage` parts verbatim rather than inventing a message format of its own, so what `useChat` sends is what comes back.

| Area          | Detail                                                                                         |
| ------------- | ---------------------------------------------------------------------------------------------- |
| Language      | TypeScript strict, ESM only, Node `>=20`                                                       |
| Build         | tsdown (CLI flags, not a config file) + publint + attw                                         |
| Tests         | vitest against PGlite - real Postgres semantics, in-process, no Docker                         |
| Lint / format | Biome - double quotes, semicolons, trailing commas, 100 columns                                |
| Peers         | `ai` (`>=6.0.214 <7 \|\| >=7.0.4 <8`, dev-tested on 7.0.x); `drizzle-orm` `^0.45.2` (optional) |
| Runtime deps  | none. `ai`, `drizzle-orm` and `resumable-stream` are peers, the last two optional              |

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

`handler/index.ts` holds the SDK's streaming touchpoints for the POST path: `toUIMessageStreamResponse`, `onEnd`, `generateMessageId`, `consumeStream`. `resume/index.ts` owns the ones for the resume path: `UI_MESSAGE_STREAM_HEADERS` and raw SSE `Response` construction. An SDK rename is a change in those two files and nowhere else. Keep it that way. Measurement, not documentation, established two behaviours there, and both have a regression test. Do not "simplify" either away:

- `originalMessages` is never passed. Given a history that ends in an assistant message, the SDK reuses that id and loses the new reply.
- A reply is stored only once no part is still in a streaming state. Otherwise a disconnect persists a half-sentence.

### The data model

Two tables. `ai_sdk_threads` holds the thread plus an `activeLeafId`. `ai_sdk_messages` holds one row per message with a `parentId`. Messages therefore form a **tree**. The thread's active conversation is the path from `activeLeafId` back to the root. That path is what `orderPath()` walks and what `loadMessages()` returns.

The tree is fully exercised now: `forkAt`, `regenerateFrom`, `siblingsOf`, `setActiveLeaf` and `getTree` live on `BranchingStore`. `chatHandler` routes the SDK client's regenerate and edit shapes into them. Nothing is ever deleted. Editing or regenerating leaves the old version as a sibling. Do not "simplify" `parentId` or `activeLeafId` away.

Every branching method takes a **`threadId`** alongside the message id, and refuses an id that does not belong to it. WARNING: Do not drop the thread argument for convenience. Message ids are a global primary key, so an unscoped lookup let a request mutate or read another thread.

Editing goes through `replaceMessage`, which rewrites the row in place and archives the previous version under a surrogate id, moving the old replies onto it. Keeping the client's id is what allows a second edit without a reload. The edit-vs-retry test compares parts **canonically**: jsonb does not preserve key order, so a plain `JSON.stringify` comparison turned an unchanged retry into a spurious branch. All of this has regression tests.

Table names are prefixed `ai_sdk_` because the tables land in the consumer's own database next to their application tables.

`parts` and `metadata` are `jsonb` and store `UIMessage` shapes verbatim. `sdkVersion` records which `ai` major wrote the row, so a future major can migrate rows rather than guess at them.

### The checks

`npm run gate` runs all four: `npm run lint`, `npm run ts:check`, `npm test`, `npm run build`. Use it, and trust the **exit code**. Biome's failure output ends in blank lines, so if you pipe any of these through `tail`, a failure looks exactly like a pass. CI runs the same four in the `build` job. A second job repeats lint/typecheck/test on the Node 20 floor (tsdown itself needs >=22.18, so the floor job skips `build`). `.githooks/pre-push` runs them too (`git config core.hooksPath .githooks`).

`ts:check` runs `tsc` twice: once normally, once with `tsconfig.no-node.json`, which typechecks `src/` with no Node types at all. AI SDK routes commonly run on edge runtimes, so a `process` or `Buffer` reference anywhere in `src/` is a bug and fails there. If a file ever genuinely needs Node, exempt it deliberately. Do not delete the guard. `src/cli` is the one exemption, because it is a `bin` entry that only runs under Node, and nothing that a consumer imports reaches it.

`.githooks/pre-push` also prints an inform-only report: per-file size deltas against the published version, npm/Bundlephobia bundle metrics, benchmarks, knip, and coverage. It never blocks a push (`|| true`), skips bench and coverage when no `src/`, `test/`, `bench/`, or `package.json` file changed, and uses a short bench sample. `npm run report` runs the full-fidelity version, and CI attaches it to every PR summary.

`resumableChat` reuses `chatHandler` through its single `beforeStream` seam rather than duplicating the choreography. Measurement established three things there, and each has a regression test:

- The default stream context is one **process-wide** singleton. A per-call context gives the documented two-file route layout two contexts that cannot see each other, so resume silently never works.
- `GET`/`DELETE` run `authorize` themselves, because `chatHandler` only guards POST.
- Everything inside `consumeSseStream` is wrapped, because the SDK discards that promise and an escaping rejection takes the process down.

`test/queries.test.ts` pins how many statements every operation sends. The README's round-trip claims are those exact numbers, so if a query count changes, both must change. Wall-clock belongs in `bench/`, which says of itself that its numbers are indicative rather than publication grade. The statement counts, not the wall-clock numbers, are deterministic enough to publish.

Both adapters share `src/store-core.ts`, and each writes its own queries. `test/parity.test.ts` runs the whole contract against both, which is what stops them drifting. SQLite has no `SELECT ... FOR UPDATE` (a write transaction already holds the database). It needs `PRAGMA foreign_keys = ON`, or the cascade silently does nothing.

`src/cli/bin.ts` is the executable and `src/cli/index.ts` is what consumers import. Keep them apart, and keep index.ts free of Node APIs. The bin's self-exec guard resolves **realpaths on both sides**. npm installs the bin as a symlink, and Node loads the module through the target. So any string comparison silently makes the whole CLI a no-op that exits 0. `test/cli.test.ts` runs it through a symlink for exactly that reason.

The SQLite adapter needs an **async** driver (libsql). Writes use interactive transactions with an async callback. The better-sqlite3 driver rejects that callback, Bun's driver does not await it, and D1 has no interactive transactions. On those drivers, atomicity would be lost silently rather than reported.

CI runs the suite against the **ai 6 floor** as well as 7, because `peerDependencies` claim `>=6.0.214 <7 || >=7.0.4 <8`. That job is not ceremony. It caught the handler passing only ai 7's `onEnd`, so no reply was ever persisted on ai 6. The handler now passes both `onEnd` and `onFinish`, guarded so only one fires. The test model rig in `test/model.ts` detects which provider spec the installed major ships. Keep it that way, or the v6 job stops exercising the streaming code.

Stored `UIMessage.parts` are identical across ai 5, 6 and 7. That is measured: `test/fixtures/parts-v{5,6}` hold real captured payloads and `test/compat.test.ts` asserts the current SDK still reads them. `migrateParts` is therefore a pass-through today, and those fixtures are the tripwire that tells you when it stops being one.

### Conventions

- Conventional Commits, imperative subject `<=` 50 chars, no trailing period, no `Co-Authored-By` or `Generated with` trailers.
- Never use em-dashes anywhere - in code, comments, commits, docs, or PR text. Use a hyphen.
- Every PR that changes anything users receive bumps `package.json` version. The CI gate `version bumped` enforces it. The gate waives itself when a PR touches only `.github`, `.claude`, `.githooks`, `scripts`, `bench`, or the governance docs. `README.md` is excluded from that waiver, because it ships in the tarball.
- The PR title becomes the squash commit message.
- `main` is protected: PR required, squash-only merges.
- The README documents **shipped features only** - no roadmap, no plans. Planning artifacts live outside this repo and are never committed.
- `aliases/` holds published name reservations (`ai-threads`, `ai-sdk-persistence`). Leave them alone unless a task is explicitly about them. Biome excludes the directory for that reason.
- Biome's `noConfusingVoidType` is off. The public callback types need `void` in a union, because `undefined` there rejects a callback that just does work and returns nothing. That is the common case, and the shape that the AI SDK's own callbacks use.
- Markdown prose is never hard-wrapped: one line per paragraph and per list item. Do not re-wrap these files to a column.

---

## Always-Active Instructions

> These apply to EVERY interaction, automatically.

### Writing Style

Never use em-dashes (`—`). Always use a hyphen (`-`) instead - in code comments, commit messages, PR/issue text, chat responses, and any file content.

#### Plain technical English (adapted from ASD-STE100)

Write text that has exactly one reading. The goal is to remove ambiguity, not words. Stop when a sentence cannot be misread, not when it is shortest.

**Everywhere** (chat, commits, PR and issue text, docs, code comments). Aim for about 80% of strict STE. Follow these rules, but treat the word limits as targets and skip the strict-mode extras.

- Active voice. Name who acts: "The job deletes the file", not "The file is deleted". Use passive only when the actor is unknown or irrelevant.
- One idea per sentence. Aim for 20 words or fewer in instructions and 25 or fewer in descriptions.
- No semicolons in prose. Where a semicolon or a dash would join two clauses, prefer two sentences.
- Use a numbered or bulleted list for 3+ steps, conditions or options. Keep one topic and 6 sentences max per paragraph.
- One name per thing. Pick one term (e.g. "user" or "account", not both) and keep it for the whole text. Rotating synonyms makes the reader ask if they are different things.
- One meaning and one part of speech per word. If "store" names a storage layer, do not also use it to mean "save".
- Plain words, not formal ones: use, start, before, about, to, make sure - not utilize, leverage, commence, prior to, approximately, in order to, ensure.
- Verbs, not nominalizations: "analyze the log", not "perform an analysis of the log".
- Plain verbs, not soft phrasal verbs: start, contact, read, begin - not spin up, reach out, dive into, kick off.
- No marketing adjectives (seamless, robust, powerful, blazing-fast, effortless). Delete them or give the number that earns the claim.
- No hedge stacking ("it is worth noting that this may potentially help"). State the claim or cut it.
- Keep subjects, verbs and articles. Do not drop words to save space ("Files not backed up will be lost" - which files?).
- Noun stacks of 3 words max: "the handler that sets task-queue priority", not "the agent task queue priority handler".
- Define a domain term once, on first use, if it is not common English.
- Label a risky step WARNING (irreversible: data loss, money, production, real users) or CAUTION (recoverable). Give the command first, then the risk: "WARNING: Do not run this on production. It deletes all sessions."

**Keep modality. Confidence is content.** "May have failed" never becomes "failed". "Could be caused by X" never becomes "X is the cause". Never upgrade a hedge to a fact, and never add a cause, frequency or mechanism the evidence does not show. Never drop a condition, exception or scope qualifier to shorten a sentence. If a rule would cost precision, keep the longer wording. When you rewrite someone else's text, name any content you added.

**Strict mode** applies to text that an agent or program reads with no human to resolve ambiguity. That includes AGENTS.md, CLAUDE.md, skills, agent and subagent prompts, tool descriptions, hook output, error and log messages, and reports that one agent writes for another.

- The 20/25-word limits are hard caps. One instruction per sentence, unless two actions happen at the same time.
- Write instructions in the imperative. Keep descriptions as descriptions. Do not turn a fact into a command.
- Put the condition first: "If the app is uninstalled, skip the sync." Do not put it at the end.
- Use one verb for one action in the whole file. Do not mix "check", "verify" and "confirm" for the same action. If "check" is already a noun in the file (a CI check), use "verify" for the action.
- Use simple tenses by default: "the job completed", not "the job is completing". Keep a compound form only when it carries meaning: "is running" (still in progress), "has completed" (done and available now), "may have failed" (uncertain). When tense and modality conflict, modality wins.

**Exempt:** creative or persuasive copy, code, and quoted or verbatim text (error strings, the user's words).

**Pick the format before the words.** Some explanations cover a flow, a structure or 3+ interacting parts. For these, draw a diagram (ASCII in chat) or offer an HTML page instead of a long block of text.

These rules fix form, not substance. Leave text that already follows them unchanged. If a paragraph has nothing to say, delete it instead of polishing it.

### Working Discipline

#### 1. Understand Before Acting

**Reach 95% certainty about what the user wants before you write code, a plan or a design. Below that bar, ask.**

**The 95% gate**

- Before you start, state in one or two concrete sentences what "done" looks like. If you cannot, you are below the bar. Ask.
- Ask all clarifying questions in one batch, up front. Do not spread them across turns, one question at a time.
- Ask only questions whose answers change the outcome. If an answer would not change what you build, pick the sensible default, name it and continue.
- A question costs one message. Building the wrong thing costs the whole implementation. Never trade a question for a guess.
- Skip the gate only for trivial, reversible, unambiguous work: a typo, a rename, a one-line fix, a command given verbatim.
- The gate applies BEFORE you start. When the task is clear, execute it end to end. Do not stop mid-flow to ask approval for steps that the request already implies.

**Map the blast radius**

- Before you start, find every place that depends on what you will change. The request names one surface. Shared logic, shared data and shared formats usually feed several.
- Trace it. Do not guess. Grep every caller, reader, subscriber and consumer of the function, field, rule, default, format or schema that you change.
- Look past the screen in front of you. Look for:
  - other views of the same data
  - exports and reports
  - background jobs and schedulers
  - public APIs and webhooks
  - caches and derived or stored state
  - permissions, analytics, tests and docs
- Give the user the list of dependents that you found. Ask which of them must change with your change, and which must keep their current behavior exactly. Ask this in the same up-front batch as your other questions, not after you start.
- If you cannot check what a consumer expects, say so. Do not silently change its behavior, and do not silently keep it.
- Record the affected areas in the plan, ticket and PR description. Reviewers and QA use this record to know what to test again.
- A map of the impact does not give permission to widen the change. Rule 3 still applies: report what is affected, and edit only what the user's answer says to edit.

**No unverified assumptions**

- An assumption is anything without evidence: you did not read it, did not run it, and nobody told you. Treat it as unknown, not as "probably fine".
- Valid evidence is:
  - the actual code, schema, config or migration
  - a command that you ran, and its output
  - docs for the exact version in use
  - the user's own words
- These are NOT evidence: a file or function name, "this is how these projects usually work", or memory of a similar codebase.
- Read the real implementation of anything that you call, extend, override or depend on. A signature or a name does not show behavior.
- Treat second-hand claims as unverified: stale comments, outdated docs, a subagent's summary, a review bot's finding, an old ticket. Check each claim against the current code before you act on it.
- If you must continue without evidence, say so openly: "Assuming X because I could not check Y." Never leave an assumption silent.
- Never call something done, fixed, working or passing unless you ran the check and saw it pass. Show the output.

**Before you implement**

- Read the existing code and follow its patterns. Do not invent new ones.
- If the request has more than one reasonable reading, present all readings. Do not silently pick one.
- If a simpler approach exists, say so. Disagree when you have a reason.
- If something is unclear, stop and name exactly what is unclear.

#### 2. Simplicity First

**Write the minimum code that solves the problem. Write nothing speculative.**

- No features beyond the request.
- No abstractions for code with one use.
- No "flexibility" or "configurability" that the user did not request.
- No error handling for impossible scenarios.
- If you write 200 lines and 50 lines can do the same work, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

#### 3. Surgical Changes

**Change only what you must. Remove only the mess that you made.**

When you edit existing code:

- Do not "improve" adjacent code, comments or formatting.
- Do not refactor code that works.
- Match the existing style, even if you would write it differently.
- If you see unrelated dead code, mention it. Do not delete it.

When your changes create orphans:

- Remove the imports, variables and functions that YOUR changes made unused.
- Do not remove dead code that existed before your change, unless the user asks.

The test: every changed line traces directly to the user's request.

#### 3a. Code Comments

**Comment the why and the how, never the what. Most code needs no comment.**

- Code shows what it does. Add a comment only when the why or the how is hard to follow. Examples: non-obvious logic, a deliberate tradeoff, or a constraint that the code cannot show.
- Do NOT add routine comments on methods, classes, variables, props, components or PropTypes. Prop-type and type comments are noise, except for a special case or an explicit user request.
- Write a comment only if it does one of these:
  - prevents a real misunderstanding
  - marks significant or surprising behavior
  - documents a cross-file side effect: a hook, mutation or edit in one file that changes another file. These cross-file couplings ARE worth a comment.
- Length: 3 lines max, 120 characters max per line. Prefer one line. If one line cannot hold it, ask yourself if the comment is necessary.
- When you edit existing code, do not add comments that the user did not ask for just to "explain" your change. The diff and the commit message carry that.
- Such comments are the most common drift. A one-line fix does NOT need a comment that says why it is correct or what the old code did wrong.
- Default to ZERO comments on a change. The exceptions are a genuine cross-file coupling, a non-obvious constraint, or surprising behavior that would confuse a future reader. When in doubt, add no comment.
- Comments are for non-obvious handling in a method, class, library integration or cross-file side effect. They are not for variables, props, local assignments, or a restatement of what the code plainly does.

#### 4. Goal-Driven Execution

**Define success criteria. Repeat until the check passes.**

Change each task into a goal that you can check:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Make sure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → check: [how]
2. [Step] → check: [how]
3. [Step] → check: [how]
```

Strong success criteria let you repeat the loop without help. Weak criteria ("make it work") need constant clarification.

#### 5. Report What Was Done

When the work is complete, state what changed and why. Do not only say that it is done.

---

**These guidelines work if** diffs have fewer unnecessary changes, fewer rewrites come from overcomplication, and clarifying questions come before implementation, not after mistakes.

---

### Multi-Agent Safety Rules

- **Never** create, apply or drop git stash entries, unless the user explicitly asks.
- **Never** edit files in `node_modules/`, `vendor/` or other dependency directories.
- **Always** work on a dedicated branch when concurrent agents run.
- **Never** force-push or rebase shared branches from an agent session.
- **Check** that no other agent is changing the same files before you change them.

### Release Safety

- WARNING: **Never** merge a PR or publish to npm without explicit approval. Merging `main` triggers the tag, the GitHub Release and `npm publish` via OIDC in one shot. The release covers this package **and** the two alias packages. A published version number can never be reused.

---
