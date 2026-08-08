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
  - [API](#api)
    - [`createThreadStore(db)`](#createthreadstoredb)
    - [Threads](#threads)
    - [Messages](#messages)
    - [`convertToUIMessages(modelMessages, options?)`](#converttouimessagesmodelmessages-options)
    - [`orderPath(rows, activeLeafId)`](#orderpathrows-activeleafid)
    - [Schema](#schema)
  - [How messages are stored](#how-messages-are-stored)
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

- **`UIMessage`-native** - `parts` and `metadata` stored verbatim as `jsonb`, never flattened to text.
- **A drizzle/Postgres adapter** - works with node-postgres, postgres.js, Neon, Vercel Postgres, or PGlite.
- **Your migrations** - the tables are exported as drizzle objects and land in your own schema and migration history.
- **Keyset pagination** - `listThreads` pages by cursor, not `OFFSET`, so page 400 costs what page 1 does.
- **`convertToUIMessages`** - the `ModelMessage` to `UIMessage` direction the SDK does not ship ([vercel/ai#7180][issue7180]).
- **Zero runtime dependencies** - the core and the adapter both. `ai` and `drizzle-orm` are peers.
- **Edge-safe core** - no Node globals anywhere in `src/`, enforced by a second typecheck in CI.

## Getting started

### Prerequisites

- Node.js `>=20`
- A Postgres database and a drizzle instance pointed at it
- `ai` `>=6 <8` (developed and tested against 7.0.x)

### Install

```bash
npm install ai-sdk-threads drizzle-orm
```

`ai-threads` and `ai-sdk-persistence` on npm are reserved aliases of this package - install `ai-sdk-threads` itself.

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

Persist both sides of a turn in your chat route. `onEnd` fires once the stream is complete, and `generateMessageId` is what gives the assistant reply its id - pass it, because the store keys rows by message id and the SDK otherwise leaves the id empty on a normal user turn:

```ts
// app/api/chat/route.ts
import { openai } from "@ai-sdk/openai";
import { convertToModelMessages, generateId, streamText } from "ai";
import { store } from "@/lib/threads";

export async function POST(req: Request) {
  const { id, messages } = await req.json();

  // The user's newest message; the rest are already stored.
  await store.appendMessages(id, messages.slice(-1));

  const result = streamText({
    model: openai("gpt-5"),
    messages: convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse({
    originalMessages: messages,
    generateMessageId: generateId,
    onEnd: async ({ responseMessage }) => {
      await store.appendMessages(id, [responseMessage]);
    },
  });
}
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

```tsx
// app/chat/[id]/chat.tsx
"use client";
import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";

export function Chat({
  id,
  initialMessages,
}: {
  id: string;
  initialMessages: UIMessage[];
}) {
  const { messages, sendMessage } = useChat({ id, messages: initialMessages });
  // ...
}
```

Creating a thread before the first message:

```ts
const thread = await store.createThread({
  userId: session.user.id,
  title: "New chat",
});
redirect(`/chat/${thread.id}`);
```

## API

### `createThreadStore(db)`

Returns a `ThreadStore` backed by the two tables. `db` is any drizzle Postgres database - `PgDatabase`, which covers node-postgres, postgres.js, Neon, Vercel Postgres, and PGlite.

```ts
import { createThreadStore } from "ai-sdk-threads/drizzle";

const store = createThreadStore(db);
```

### Threads

| Method                    | Returns                             | Notes                                                                               |
| ------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------- |
| `createThread(input?)`    | `Promise<Thread>`                   | `input`: `{ id?, userId?, title?, metadata? }`. An id is generated when omitted.    |
| `getThread(id)`           | `Promise<Thread \| null>`           | `null` rather than a throw, so a missing thread is a 404 you handle.                |
| `listThreads(query?)`     | `Promise<{ threads, nextCursor? }>` | `query`: `{ userId?, limit?, cursor? }`. Newest first, default limit 20.            |
| `updateThread(id, patch)` | `Promise<Thread>`                   | `patch`: `{ title?, visibility?, metadata? }`. Throws if the thread does not exist. |
| `deleteThread(id)`        | `Promise<void>`                     | Messages cascade with it. Deleting an absent thread is a no-op.                     |

`listThreads` pages with a keyset cursor over `(createdAt, id)`, so pass `nextCursor` back to get the next page and stop when it comes back `undefined`:

```ts
let cursor: string | undefined;
do {
  const page = await store.listThreads({ userId, limit: 20, cursor });
  render(page.threads);
  cursor = page.nextCursor;
} while (cursor);
```

A `Thread` is `{ id, userId, title, visibility, activeLeafId, metadata, createdAt, updatedAt }`.

### Messages

| Method                           | Returns                    | Notes                                                               |
| -------------------------------- | -------------------------- | ------------------------------------------------------------------- |
| `appendMessages(threadId, msgs)` | `Promise<StoredMessage[]>` | Takes `UIMessage[]`. Transactional. Throws if the thread is absent. |
| `loadMessages(threadId)`         | `Promise<UIMessage[]>`     | Ordered oldest first, validated by the SDK before it is returned.   |

`appendMessages` uses each `UIMessage`'s own `id` as the row's primary key, because `useChat` already owns message ids. Messages are chained to the end of the thread and the thread's `activeLeafId` moves to the last one, inside one transaction that locks the thread row - so two concurrent appends cannot interleave.

`loadMessages` returns `[]` for a thread with no messages yet. Before returning, rows pass through the SDK's own `validateUIMessages`, so a row that no longer matches the SDK's shape fails loudly here rather than in your renderer.

### `convertToUIMessages(modelMessages, options?)`

The AI SDK converts `UIMessage[]` to `ModelMessage[]`. It does not ship the reverse, which is what you need when the messages you have came from a provider, a log, or an older table ([vercel/ai#7180][issue7180]).

```ts
import { convertToUIMessages } from "ai-sdk-threads";

const uiMessages = convertToUIMessages([
  { role: "user", content: "weather?" },
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "getWeather",
        input: { city: "x" },
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "getWeather",
        output: { type: "json", value: { temp: 21 } },
      },
    ],
  },
]);
// -> 2 messages. The tool result is folded into the assistant message as a
//    `tool-getWeather` part with state 'output-available'.
```

- `text` and `reasoning` content becomes `text` and `reasoning` parts.
- A `tool-call` becomes a `tool-<name>` part, `input-available` until its result arrives, then `output-available` (or `output-error` for a failure).
- `tool` role messages are folded into the assistant message that called them, never emitted on their own.
- Ids come from `options.generateId`, defaulting to the SDK's `generateId`.
- Content this version does not model - `file`, `image`, and provider-specific parts - **throws** rather than being guessed at, so a lossy conversion cannot reach your database.

### `orderPath(rows, activeLeafId)`

Walks `parentId` links from a leaf back to the root and returns the rows oldest first. `loadMessages` uses it; it is exported for when you query the tables yourself. Returns `[]` for a `null` leaf and throws on a broken link, naming the id it could not find.

### Schema

```ts
import { messages, threads } from "ai-sdk-threads/drizzle";
```

| `ai_sdk_threads` | Type          | Notes                                         |
| ---------------- | ------------- | --------------------------------------------- |
| `id`             | `text` PK     |                                               |
| `user_id`        | `text`        | Indexed. Nullable for anonymous chats.        |
| `title`          | `text`        |                                               |
| `visibility`     | `text`        | `'private'` (default) or `'public'`.          |
| `active_leaf_id` | `text`        | The last message on the live path.            |
| `metadata`       | `jsonb`       | Yours to use.                                 |
| `created_at`     | `timestamptz` |                                               |
| `updated_at`     | `timestamptz` | Moved by `appendMessages` and `updateThread`. |

| `ai_sdk_messages` | Type          | Notes                                   |
| ----------------- | ------------- | --------------------------------------- |
| `id`              | `text` PK     | The `UIMessage` id.                     |
| `thread_id`       | `text`        | Indexed, `ON DELETE CASCADE`.           |
| `parent_id`       | `text`        | The message this one answers.           |
| `role`            | `text`        | `'system'`, `'user'`, or `'assistant'`. |
| `parts`           | `jsonb`       | `UIMessage.parts`, verbatim.            |
| `metadata`        | `jsonb`       | `UIMessage.metadata`, verbatim.         |
| `sdk_version`     | `smallint`    | The `ai` major that wrote the row.      |
| `created_at`      | `timestamptz` |                                         |

## How messages are stored

Each message row points at its parent, so the messages of a thread form a tree rather than a flat list, and the thread's `active_leaf_id` marks which path through that tree is the live conversation. `loadMessages` returns exactly that path.

Today every write extends one path, so the tree is a straight line and this is just a linked list with extra columns. It is shaped this way from the start so that the columns do not have to change later. If you query the tables directly, walk `parent_id` from `active_leaf_id` (or call `orderPath`) rather than sorting by `created_at`.

`sdk_version` records which `ai` major wrote each row. Nothing reads it yet; it is there so a future SDK major can migrate stored parts instead of guessing what shape they are in.

## Requirements

- Node.js `>=20`
- `ai` `>=6 <8` (developed and tested against 7.0.x)
- `drizzle-orm` `^0.45` for the `./drizzle` adapter (optional peer - the core does not need it)
- Postgres
- ESM only (no CJS build)

Not affiliated with Vercel. "AI SDK" refers to the [`ai` package](https://ai-sdk.dev).

## Contributing

Contributions are welcome. Fork, branch, and open a PR - see [CONTRIBUTING.md](CONTRIBUTING.md) for the checks a PR has to pass. Bugs and ideas go to [Issues][issues]; questions to [Discussions][discussions]; vulnerabilities follow [SECURITY.md](SECURITY.md).

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
