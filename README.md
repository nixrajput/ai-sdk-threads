<div align="center">

# ai-sdk-threads

Chat thread and message persistence for the **Vercel AI SDK** - `UIMessage` parts stored verbatim, in your own Postgres.

<br />

[![npm](https://img.shields.io/npm/v/ai-sdk-threads?color=159F7C)][npm]
[![Stars](https://img.shields.io/github/stars/nixrajput/ai-sdk-threads?color=159F7C)][repo]
[![Contributors](https://img.shields.io/github/contributors/nixrajput/ai-sdk-threads?color=159F7C)][contributors]
[![License: MIT](https://img.shields.io/github/license/nixrajput/ai-sdk-threads?color=159F7C)][license]
[![Last commit](https://img.shields.io/github/last-commit/nixrajput/ai-sdk-threads?label=last%20commit)][repo]
[![Issues](https://img.shields.io/github/issues/nixrajput/ai-sdk-threads?label=issues)][issues]
[![PRs](https://img.shields.io/github/issues-pr/nixrajput/ai-sdk-threads?label=PRs)][pulls]

**[Documentation][docs]** - [Getting started][docs-start] - [API reference][docs-api] - [Playground][docs-playground]

</div>

---

## Contents

- [ai-sdk-threads](#ai-sdk-threads)
  - [Contents](#contents)
  - [Overview](#overview)
  - [Features](#features)
  - [Getting started](#getting-started)
    - [Prerequisites](#prerequisites)
    - [Install](#install)
    - [Add the tables to your schema](#add-the-tables-to-your-schema)
    - [Quickstart](#quickstart)
  - [Documentation](#documentation)
  - [Requirements](#requirements)
  - [Contributing](#contributing)
  - [Contributors](#contributors)
  - [License](#license)
  - [Support the project](#support-the-project)
  - [Connect](#connect)

## Overview

The AI SDK gives you `useChat` and a streaming route. It does not give you anywhere to put the conversation. Every project ends up writing the same two tables, the same append-on-finish hook, and the same load-on-mount query - and usually flattens `UIMessage.parts` into a `content` string on the way in, which quietly loses tool calls, reasoning, and files.

ai-sdk-threads is those two tables and a small typed store over them. Message `parts` go into `jsonb` exactly as the SDK produced them, so what comes back out is what `useChat` rendered - tool invocations and their outputs included. It is your database and your rows; this package owns no service and phones nothing home.

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
- A Postgres database and a drizzle instance pointed at it
- `ai` `>=6 <8` (CI runs the suite against both 7.0.x and the 6.x floor)

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
import { store } from "@/lib/threads";
import { Chat } from "./chat";

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const messages = await store.loadMessages(id);
  return <Chat id={id} initialMessages={messages} />;
}
```

**Before you deploy, add authorization.** Thread ids come from the client, so without an `authorize` callback anyone who guesses an id can read that conversation - see [Securing a thread][docs-secure].

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

## Requirements

- Node.js `>=20`
- `ai` `>=6 <8` - CI runs the whole suite against both **7.0.x** and the **6.x** floor
- `drizzle-orm` `^0.45` for the `./drizzle` and `./sqlite` adapters (optional peer)
- `resumable-stream` `^2.2` for the `./resume` module (optional peer)
- Postgres, or SQLite via `./sqlite`
- ESM only (no CJS build)

Not affiliated with Vercel. "AI SDK" refers to the [`ai` package](https://ai-sdk.dev).

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
