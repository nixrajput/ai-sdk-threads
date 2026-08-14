<div align="center">

<img src="https://raw.githubusercontent.com/nixrajput/ai-sdk-threads/main/assets/logo.svg" width="76" alt="ai-sdk-threads">

# ai-sdk-threads

<em>The AI SDK gives you <code>useChat</code>. This gives you somewhere to put it.</em>

<br />

[![CI](https://github.com/nixrajput/ai-sdk-threads/actions/workflows/ci.yml/badge.svg)][ci]
[![npm](https://img.shields.io/npm/v/ai-sdk-threads?color=159F7C)][npm]
[![Stars](https://img.shields.io/github/stars/nixrajput/ai-sdk-threads?color=159F7C)][repo]
[![Contributors](https://img.shields.io/github/contributors/nixrajput/ai-sdk-threads?color=159F7C)][contributors]
[![License: MIT](https://img.shields.io/github/license/nixrajput/ai-sdk-threads?color=159F7C)][license]
[![Last commit](https://img.shields.io/github/last-commit/nixrajput/ai-sdk-threads?label=last%20commit)][repo]
[![Issues](https://img.shields.io/github/issues/nixrajput/ai-sdk-threads?label=issues)][issues]
[![PRs](https://img.shields.io/github/issues-pr/nixrajput/ai-sdk-threads?label=PRs)][pulls]

<strong>Threads &middot; message trees &middot; branching &middot; resumable streams &middot; Postgres or SQLite &middot; zero runtime dependencies</strong><br>
<sub><strong>Loading a thread is 2 queries</strong> whether it holds 1 message or 500 - the root-to-leaf path is walked in memory, not with a recursive CTE - and <code>listThreads</code> is <strong>one query per page at any depth</strong>: page 400 measured at <strong>1.00x</strong> the median of page 1 across 4,000 threads. Every operation's query count is <a href="https://github.com/nixrajput/ai-sdk-threads/blob/main/test/queries.test.ts">pinned by a test</a>, so an N+1 fails CI. Also checkable: <strong>197 tests</strong>, 30 running the identical contract against both databases; <code>ai</code> <strong>6 and 7 both gated in CI</strong>, which caught the handler storing nothing on the older major; <strong>no Node globals in <code>src/</code></strong>, enforced by a second typecheck. <a href="https://github.com/nixrajput/ai-sdk-threads/actions/workflows/ci.yml">See the runs</a>.</sub>

<br />

**[Documentation][docs]** &middot; [Getting started][docs-start] &middot; [API reference][docs-api] &middot; [Playground][docs-playground]

<sub><b>AI agents / LLMs:</b> the documentation is machine-readable at <a href="https://ai-sdk-threads.nixrajput.com/llms.txt"><code>llms.txt</code></a>, or as one blob at <a href="https://ai-sdk-threads.nixrajput.com/llms-full.txt"><code>llms-full.txt</code></a>.</sub>

</div>

---

## Contents

- [ai-sdk-threads](#ai-sdk-threads)
  - [Contents](#contents)
  - [Before and after](#before-and-after)
  - [Overview](#overview)
  - [Features](#features)
  - [Getting started](#getting-started)
    - [Prerequisites](#prerequisites)
    - [Install](#install)
    - [Add the tables to your schema](#add-the-tables-to-your-schema)
    - [Quickstart](#quickstart)
  - [How branching is stored](#how-branching-is-stored)
  - [Documentation](#documentation)
  - [Is this for you](#is-this-for-you)
  - [Compared to](#compared-to)
  - [FAQ](#faq)
  - [Contributing](#contributing)
  - [Contributors](#contributors)
  - [License](#license)
  - [Support the project](#support-the-project)
  - [Connect](#connect)

## Before and after

The AI SDK's own persistence guide has you hand-roll the choreography in your route: load the thread, filter what is new, store it before streaming, generate an id, register the finish callback under both of its names, store the reply.

```ts
const { id, messages } = await req.json();

const existing = await store.loadMessages(id);
const known = new Set(existing.map((m) => m.id));
const fresh = messages.filter((m) => m.role === "user" && !known.has(m.id));
if (fresh.length > 0) await store.appendMessages(id, fresh);

const result = streamText({
  model: openai("gpt-5"),
  messages: await convertToModelMessages([...existing, ...fresh]),
});

let persisted = false;
const persist = async ({ responseMessage }) => {
  if (persisted || responseMessage.parts.length === 0) return;
  persisted = true;
  await store.appendMessages(id, [responseMessage]);
};

return result.toUIMessageStreamResponse({
  generateMessageId: generateId,
  onEnd: persist,
  onFinish: persist,
});
```

With `chatHandler`:

```ts
export const POST = chatHandler({
  store,
  execute: ({ modelMessages }) =>
    streamText({ model: openai("gpt-5"), messages: modelMessages }),
});
```

25 lines to 8 - and the short one also does authorization, branching, and the truncated-reply handling the long one does not attempt. Both samples are published in [the docs][docs-api] and typechecked against this package on every build, so neither can drift into a strawman.

## Overview

Every AI SDK chat app ends up writing the same two tables, the same append-on-finish hook, and the same load-on-mount query - and usually flattens `UIMessage.parts` into a `content` string on the way in, which quietly loses tool calls, reasoning, and files.

ai-sdk-threads is those two tables and a small typed store over them. Message `parts` go into the database as JSON exactly as the SDK produced them, so what comes back out is what `useChat` rendered - tool invocations and their outputs included. It is your database and your rows; this package owns no service and phones nothing home.

```text
  useChat ──── POST /api/chat ────▶ chatHandler ────▶ ThreadStore ────▶ your database
     ▲                                   │                 │
     └───────── UIMessage stream ────────┘                 ├── ai_sdk_threads    active_leaf_id
                                                           └── ai_sdk_messages   parent_id, parts
```

## Features

- **One-line chat route** - `chatHandler` replaces the load/store/stream/store boilerplate every AI SDK app writes by hand.
- **Postgres or SQLite** - the same `ThreadStore` contract over either, verified by one parity suite run against both.
- **Branching** - edit or regenerate a message and the old version survives as a sibling, the way ChatGPT does it ([vercel/ai#2929][issue2929], open since 2024).
- **Resumable streams** - `resumableChat` ships the POST/GET/DELETE trio, so a reload mid-answer picks the stream back up.
- **`UIMessage`-native** - `parts` and `metadata` stored verbatim (`jsonb` on Postgres, text JSON on SQLite), never flattened to a content string.
- **A drizzle/Postgres adapter** - works with node-postgres, postgres.js, Neon, Vercel Postgres, or PGlite.
- **Your migrations** - the tables are exported as drizzle objects and land in your own schema and migration history.
- **Keyset pagination** - `listThreads` pages by cursor, not `OFFSET`, so page 400 costs what page 1 does.
- **`convertToUIMessages`** - the `ModelMessage` to `UIMessage` direction the SDK still does not ship as of `ai` 7 ([vercel/ai#7180][issue7180], open).
- **Zero runtime dependencies** - `ai`, `drizzle-orm` and `resumable-stream` are peers, the last two optional. Install only what you use.
- **Edge-safe core** - no Node globals anywhere in `src/`, enforced by a second typecheck in CI.

## Getting started

### Prerequisites

- Node.js `>=20`
- `ai` `>=6 <8` - CI runs the whole suite against both **7.0.x** and the **6.x** floor
- Postgres with a drizzle instance pointed at it, or SQLite via [`./sqlite`][docs-sqlite]
- `drizzle-orm` `^0.45` for the `./drizzle` and `./sqlite` adapters, and `resumable-stream` `^2.2` for `./resume` - both optional peers, so you install only what you use
- ESM only, with no CJS build

### Install

```bash
npm install ai-sdk-threads drizzle-orm
```

`ai-threads` and `ai-sdk-persistence` on npm are name reservations only - they contain no code and are not maintained. Install `ai-sdk-threads`.

### Add the tables to your schema

The two tables are plain drizzle `pgTable` objects. Re-export them from your schema file so your existing migration tooling picks them up:

```ts
// db/schema.ts
export { messages, threads } from "ai-sdk-threads/drizzle";
```

Then generate and run a migration the way you already do, for example with drizzle-kit:

```bash
npx drizzle-kit generate
npx drizzle-kit migrate
```

This creates `ai_sdk_threads` and `ai_sdk_messages`. The `ai_sdk_` prefix keeps them from colliding with your application tables.

### Quickstart

Create the store once and share it:

```ts
// lib/threads.ts
import { createThreadStore } from "ai-sdk-threads/drizzle";
import { db } from "./db";

export const store = createThreadStore(db);
```

Then your whole chat route is the handler. It loads the thread, stores the incoming message before streaming, streams the answer, and stores the reply:

```ts
// app/api/chat/route.ts
import { openai } from "@ai-sdk/openai";
import { streamText } from "ai";
import { chatHandler } from "ai-sdk-threads/handler";
import { store } from "@/lib/threads";

export const POST = chatHandler({
  store,
  execute: ({ modelMessages }) =>
    streamText({ model: openai("gpt-5"), messages: modelMessages }),
});
```

Load the history when the page renders and hand it straight to `useChat`:

```tsx
// app/chat/[id]/page.tsx
import { notFound } from "next/navigation";
import { currentUserId } from "@/lib/auth";
import { store } from "@/lib/threads";
import { Chat } from "./chat";

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const thread = await store.getThread(id);

  // The id comes from the URL, so the page needs its own ownership check: `authorize` guards
  // chatHandler, not this render. 404 rather than 403, so a stranger cannot tell an existing
  // thread from a missing one. loadMessages then throws for an id with no thread yet.
  if (thread && thread.userId !== (await currentUserId())) notFound();

  const messages = thread ? await store.loadMessages(id) : [];
  return <Chat id={id} initialMessages={messages} />;
}
```

**Before you deploy, add authorization in both places.** Thread ids come from the client, so `chatHandler` needs an `authorize` callback and any page that renders a thread needs the same ownership check - `authorize` does not run on a server render. See [Securing a thread][docs-secure].

## How branching is stored

Every message row points at its parent, and the thread records which leaf is live. Regenerating does not overwrite - it adds a sibling.

```text
ai_sdk_threads.active_leaf_id = "a2"

m1  user       "Explain closures, briefly."
├── a1  assistant  "A function bundled with the variables…"     sibling, still stored
└── a2  assistant  "Think of a backpack the function carries…"  live path
```

`loadMessages` returns the root-to-leaf path, so the conversation reads as one thread while every abandoned branch stays queryable. Point `setActiveLeaf` at `a1` and the older answer is live again, with whatever replies hung off it.

You can [run this against a real Postgres in your browser][docs-playground] - the playground compiles the database to WebAssembly and drives this package's published build, showing the call it made and the rows it produced.

## Documentation

Full documentation lives at **[ai-sdk-threads.nixrajput.com][docs]**.

|                                       |                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------- |
| [Getting started][docs-start]         | Install, schema, and a persisted `useChat` conversation                 |
| [`chatHandler`][docs-api]             | Every option, what it does in order, and securing a thread              |
| [`resumableChat`][docs-resume]        | The POST/GET/DELETE trio, and the Redis-backed context                  |
| [The store][docs-store]               | Thread and message methods, keyset pagination, `orderPath`              |
| [Branching][docs-branching]           | Regenerate, edit-and-fork, sibling navigation                           |
| [`convertToUIMessages`][docs-convert] | The `ModelMessage` to `UIMessage` direction                             |
| [SQLite][docs-sqlite]                 | The same contract, and the three constraints that are not optional      |
| [Schema][docs-schema]                 | Both tables, every column, and why timestamps are millisecond precision |
| [Migrating][docs-migrating]           | `sdk_version` on every row, and the `migrate` CLI                       |
| [Importing][docs-importing]           | Bringing over Vercel's `ai-chatbot` template tables                     |
| [Playground][docs-playground]         | Branching in a real Postgres running in your browser                    |

## Is this for you

**Good fit if you…**

- build on `useChat` and are about to write the persistence layer by hand
- want branching - regenerate and edit-and-fork - stored rather than faked in component state
- need the conversation in **your** database, for compliance, for joins, or because you already run Postgres
- expect to survive the AI SDK's next major without inventing a `Message_v2` table

**Skip it if you…**

- want a managed service with hosted sync, search and analytics today. [assistant-ui](https://www.assistant-ui.com) and [Convex](https://www.convex.dev) do that properly; this is the self-hosted core, and the store, both adapters, branching, resumable streams and the migration tooling are MIT and stay that way.
- need vector or semantic memory. Different problem: this stores conversations, it does not retrieve over them.
- are on `ai` 4 or older. `ai` 5 was a rewrite, and the supported range is `>=6 <8`.
- want chat UI components. [ai-elements](https://ai-sdk.dev/elements) and assistant-ui own that layer; this stores what they render.

## Compared to

Nothing below is a like-for-like competitor, which is rather the point.

|                                                    | Scope                                           | Where the data lives    | Branching stored | Cost                  |
| -------------------------------------------------- | ----------------------------------------------- | ----------------------- | ---------------- | --------------------- |
| **ai-sdk-threads**                                 | Threads, messages, branching, resumable streams | Your Postgres or SQLite | Yes              | MIT core, self-hosted |
| The AI SDK's persistence guide                     | A pattern to copy per app                       | Yours                   | No               | Free, hand-maintained |
| [assistant-ui](https://www.assistant-ui.com) cloud | UI plus hosted persistence                      | Their infrastructure    | No               | Per active user       |
| [Convex](https://www.convex.dev)                   | A whole reactive backend                        | Their platform          | No               | Per usage             |
| Vercel's `ai-chatbot` template                     | An app to fork                                  | Yours                   | No               | Free, fork-and-own    |

This exists for the case where the conversation has to stay in a database you control, and where regenerate and edit need to survive a reload. If you started from the Vercel template, its tables [import straight across][docs-importing].

<sub>Not affiliated with Vercel. "AI SDK" refers to the [`ai` package](https://ai-sdk.dev).</sub>

## FAQ

**Why not just follow the SDK's persistence guide?**
You can, and for one simple app you probably should. The reasons people stop: it silently stores an empty id if you forget `generateMessageId`, it stores nothing at all on `ai` 6 if you register only `onEnd`, it duplicates rows if you forget to filter what the transport reposts, and it has no answer for branching. Each of those is a real bug with a test in this repo.

**Do I need Redis?**
Only for resumable streams across more than one instance. The default stream context is in-process, which is genuinely enough in development and on a single server, and documented as insufficient beyond that rather than quietly failing.

**What happens when `ai` 8 breaks the message shape?**
Every row records the major that wrote it in `sdk_version`, and real captured payloads from `ai` 5, 6 and 7 are committed as fixtures, so the suite reports the day a format actually changes. As of `ai` 7 stored `parts` are byte-identical across all three majors, so there is nothing to convert yet - `migrateParts` is a pass-through and says so, rather than pretending to work.

**Is SQLite a second-class adapter?**
No - the parity suite runs the identical contract against both, so behaviour that holds on Postgres but not SQLite fails the build. It does carry three hard constraints, all documented: an async driver, no bare `:memory:`, and `PRAGMA foreign_keys = ON`.

**Can I use it without the handler?**
Yes - the store is the product and works alone. [The docs show the hand-written route][docs-api] and name the three things that are easy to get wrong.

## Contributing

Contributions are welcome. Fork, branch, and open a PR - see [CONTRIBUTING.md](CONTRIBUTING.md) for the checks a PR has to pass. Bugs and ideas go to [Issues][issues]; questions to [Discussions][discussions]; vulnerabilities follow [SECURITY.md](SECURITY.md).

Documentation changes belong in [nixrajput/ai-sdk-threads-docs][docs-repo], which owns the site's content. When a public API changes here, the matching docs change is a separate PR there.

## Contributors

Thanks to everyone who has contributed to ai-sdk-threads.

<a href="https://github.com/nixrajput/ai-sdk-threads/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=nixrajput/ai-sdk-threads" alt="Contributors" />
</a>

## License

Licensed under the **MIT** license - see [LICENSE](LICENSE).

## Support the project

<div align="center">

ai-sdk-threads is MIT licensed and free to use, always. If it saves you writing those two tables again, sponsorship is welcome.

<br />

<a href="https://github.com/sponsors/nixrajput">
  <img src="https://img.shields.io/badge/Sponsor_on_GitHub-EA4AAA?style=for-the-badge&logo=githubsponsors&logoColor=white" alt="GitHub Sponsors" />
</a>
<a href="https://ko-fi.com/nixrajput">
  <img src="https://img.shields.io/badge/Ko--fi-FF5E5B?style=for-the-badge&logo=kofi&logoColor=white" alt="Ko-fi" />
</a>
<a href="https://www.buymeacoffee.com/nixrajput">
  <img src="https://img.shields.io/badge/Buy_Me_a_Coffee-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black" alt="Buy Me a Coffee" />
</a>

</div>

## Connect

<div align="center">

**Nikhil Rajput**

<a href="https://github.com/nixrajput"><img src="https://img.shields.io/badge/GitHub-181717?style=for-the-badge&logo=github&logoColor=white" alt="GitHub" /></a>
<a href="https://linkedin.com/in/nixrajput"><img src="https://img.shields.io/badge/LinkedIn-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white" alt="LinkedIn" /></a>
<a href="https://x.com/nixrajput"><img src="https://img.shields.io/badge/X-000000?style=for-the-badge&logo=x&logoColor=white" alt="X" /></a>
<a href="https://instagram.com/nixrajput"><img src="https://img.shields.io/badge/Instagram-E4405F?style=for-the-badge&logo=instagram&logoColor=white" alt="Instagram" /></a>
<a href="https://telegram.me/nixrajput"><img src="https://img.shields.io/badge/Telegram-26A5E4?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram" /></a>
<a href="mailto:nkr.nikhil.nkr@gmail.com"><img src="https://img.shields.io/badge/Email-EA4335?style=for-the-badge&logo=gmail&logoColor=white" alt="Email" /></a>

</div>

[ci]: https://github.com/nixrajput/ai-sdk-threads/actions/workflows/ci.yml
[npm]: https://www.npmjs.com/package/ai-sdk-threads
[repo]: https://github.com/nixrajput/ai-sdk-threads
[issues]: https://github.com/nixrajput/ai-sdk-threads/issues
[pulls]: https://github.com/nixrajput/ai-sdk-threads/pulls
[discussions]: https://github.com/nixrajput/ai-sdk-threads/discussions
[contributors]: https://github.com/nixrajput/ai-sdk-threads/graphs/contributors
[license]: https://github.com/nixrajput/ai-sdk-threads/blob/main/LICENSE
[issue7180]: https://github.com/vercel/ai/issues/7180
[issue2929]: https://github.com/vercel/ai/issues/2929
[docs]: https://ai-sdk-threads.nixrajput.com
[docs-repo]: https://github.com/nixrajput/ai-sdk-threads-docs
[docs-start]: https://ai-sdk-threads.nixrajput.com/en/docs/getting-started
[docs-api]: https://ai-sdk-threads.nixrajput.com/en/docs/api/chat-handler
[docs-secure]: https://ai-sdk-threads.nixrajput.com/en/docs/api/chat-handler#securing-a-thread
[docs-resume]: https://ai-sdk-threads.nixrajput.com/en/docs/api/resumable-chat
[docs-store]: https://ai-sdk-threads.nixrajput.com/en/docs/api/store
[docs-branching]: https://ai-sdk-threads.nixrajput.com/en/docs/api/branching
[docs-convert]: https://ai-sdk-threads.nixrajput.com/en/docs/api/convert
[docs-sqlite]: https://ai-sdk-threads.nixrajput.com/en/docs/api/sqlite
[docs-schema]: https://ai-sdk-threads.nixrajput.com/en/docs/api/schema
[docs-migrating]: https://ai-sdk-threads.nixrajput.com/en/docs/migrating
[docs-importing]: https://ai-sdk-threads.nixrajput.com/en/docs/importing
[docs-playground]: https://ai-sdk-threads.nixrajput.com/en/playground
