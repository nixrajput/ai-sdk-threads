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
    - [`chatHandler(options)`](#chathandleroptions)
    - [Securing a thread](#securing-a-thread)
      - [Without the handler](#without-the-handler)
    - [`resumableChat(options)`](#resumablechatoptions)
    - [`createThreadStore(db)`](#createthreadstoredb)
    - [Threads](#threads)
    - [Messages](#messages)
    - [`convertToUIMessages(modelMessages, options?)`](#converttouimessagesmodelmessages-options)
    - [Branching](#branching)
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

- **One-line chat route** - `chatHandler` replaces the load/store/stream/store boilerplate every AI SDK app writes by hand.
- **Branching** - edit or regenerate a message and the old version survives as a sibling, the way ChatGPT does it ([vercel/ai#2929][issue2929]).
- **Resumable streams** - `resumableChat` ships the POST/GET/DELETE trio, so a reload mid-answer picks the stream back up.
- **`UIMessage`-native** - `parts` and `metadata` stored verbatim as `jsonb`, never flattened to text.
- **A drizzle/Postgres adapter** - works with node-postgres, postgres.js, Neon, Vercel Postgres, or PGlite.
- **Your migrations** - the tables are exported as drizzle objects and land in your own schema and migration history.
- **Keyset pagination** - `listThreads` pages by cursor, not `OFFSET`, so page 400 costs what page 1 does.
- **`convertToUIMessages`** - the `ModelMessage` to `UIMessage` direction the SDK does not ship ([vercel/ai#7180][issue7180]).
- **Zero runtime dependencies** - `ai`, `drizzle-orm` and `resumable-stream` are peers, the last two optional. Install only what you use.
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

### `chatHandler(options)`

Returns a `(request: Request) => Promise<Response>` - usable directly as a Next.js App Router `POST`, a React Router action, or any fetch-based server. It owns the persistence choreography so your route only says which model to call.

```ts
import { chatHandler } from "ai-sdk-threads/handler";

export const POST = chatHandler({
  store,
  execute: ({ modelMessages }) =>
    streamText({ model: openai("gpt-5"), messages: modelMessages }),
});
```

| Option          | Required | What it does                                                                                      |
| --------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `store`         | yes      | The `ThreadStore` to persist into.                                                                |
| `execute`       | yes      | Called with `{ threadId, uiMessages, modelMessages, request }`; return a `streamText` result.     |
| `createThread`  | no       | Called when a request names a thread that does not exist yet. Return `{ userId?, metadata? }`.    |
| `authorize`     | no       | Called with `{ thread, request }` for an **existing** thread. Return `false` to answer 403.       |
| `generateTitle` | no       | Called once per thread with `{ firstUserMessage }`. Runs detached - it never delays the response. |
| `onError`       | no       | Return a `Response` to replace the default 500, or `undefined` to keep it.                        |

What it does, in order:

1. Parses the body, answering **400** on anything malformed.
2. Loads the thread - creating it (scoped via `createThread`) if this request is the first to name it, or running `authorize` if it already exists.
3. Validates the messages this request adds, and rejects anything the SDK cannot parse with **400** rather than storing it.
4. Stores the new message **before** streaming, so a mid-stream crash cannot lose it.
5. Calls `execute` with the thread's full validated history.
6. Streams the reply and stores it on completion, with a server-generated message id.
7. Runs the model stream to completion server-side, so a slow or suspended client cannot leave the generation half-made.

### Securing a thread

**Thread ids come from the client**, so `authorize` is what stops one user reading another's conversation. Without it, any caller who knows or guesses an id can post into that thread and get the model's answer with the whole history as context. `createThread` does not cover this - it only fires for ids that do not exist yet.

```ts
export const POST = chatHandler({
  store,
  execute: ({ modelMessages }) =>
    streamText({ model: openai("gpt-5"), messages: modelMessages }),

  // New thread: record who owns it.
  createThread: async ({ request }) => ({ userId: await userIdFrom(request) }),

  // Existing thread: prove the caller owns it, or 403.
  authorize: async ({ thread, request }) =>
    thread.userId === (await userIdFrom(request)),

  generateTitle: async ({ firstUserMessage }) => {
    const { text } = await generateText({
      model: openai("gpt-5-mini"),
      prompt: `Title this in under six words:\n\n${JSON.stringify(firstUserMessage.parts)}`,
    });
    return text;
  },
});
```

Only new `user` messages are accepted. A request introducing a fresh `system` or `assistant` message is rejected with 400, so a client cannot forge context that every later turn on the thread would then inherit.

Both wire shapes work unchanged. The default transport posts the whole conversation each turn; a custom `prepareSendMessagesRequest` that posts only `{ id, message }` works too. The handler stores only messages it has not already seen, so neither shape duplicates rows.

**Errors and disconnects.** A throwing `execute` answers 500 (or whatever `onError` returns) and leaves the user's message stored with no half-written reply, so the client can retry. A client that disconnects mid-stream leaves the reply empty or truncated; the handler detects that and stores nothing rather than leaving a message that renders as forever-in-progress and feeds a half-sentence to the model on the next turn. If storing the reply fails, it is logged via `console.error` rather than thrown into stream teardown where nothing could act on it.

#### Without the handler

The store is perfectly usable on its own if you want to own the route. Two things matter: store the user message _before_ streaming, and pass `generateMessageId` - rows are keyed by message id, and the SDK leaves an assistant reply's id empty on a normal user turn.

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
    messages: await convertToModelMessages(messages),
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

### `resumableChat(options)`

A reload halfway through an answer normally loses it: the stream was tied to a request that no longer exists. `resumableChat` takes every `chatHandler` option and returns the three handlers a resuming client needs.

```ts
// app/api/chat/route.ts
export const { POST } = resumableChat({
  store,
  execute: ({ modelMessages }) =>
    streamText({ model: openai("gpt-5"), messages: modelMessages }),
});
```

```ts
// app/api/chat/[id]/stream/route.ts - the path the SDK's client resumes from
export const { GET, DELETE } = resumableChat({ store, execute });
```

Then turn resuming on in the client:

```tsx
const { messages, sendMessage } = useChat({
  id,
  messages: initialMessages,
  resume: true,
});
```

| Handler  | Behaviour                                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `chatHandler`, plus: records a stream id on the thread before answering, and clears it once the stream ends.         |
| `GET`    | Replays a stream that is still in flight. **204** when there is nothing to resume, which is what the client expects. |
| `DELETE` | Forgets the active stream, so a later `GET` answers 204. Always 204.                                                 |

Two extra options on top of `chatHandler`'s:

| Option          | Required | What it does                                                                                           |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `streamContext` | no       | Where in-flight streams live. Defaults to in-process - see below.                                      |
| `threadIdFrom`  | no       | How to read the thread id from a GET/DELETE. Defaults to the `<threadId>/stream` path the client uses. |

**The default context is in-process, and that is a real limitation.** It resumes only within the instance that served the POST, so on more than one instance (or any serverless deployment) a resume can land on a process that never saw the stream and gets a 204. Pass a Redis-backed context for those:

```ts
import { createResumableStreamContext } from "resumable-stream/ioredis";

export const { POST, GET, DELETE } = resumableChat({
  store,
  execute,
  streamContext: createResumableStreamContext({ waitUntil: null }),
});
```

`resumable-stream` is an optional peer, so add it when you use this module: `npm install resumable-stream`. Redis on top of that is your choice, not this package's - `resumable-stream` itself ships with no dependencies.

The default in-memory context is a single **process-wide** instance, so splitting POST and GET across two route files works. It still cannot cross processes: on more than one instance, a resume that lands elsewhere answers 204.

`DELETE` forgets a stream rather than killing it: `resumable-stream` exposes no abort, so the generation finishes server-side (and is still persisted) but stops being resumable. That is what a stop button wants in practice - the answer is saved, the client stops following it.

**Migration.** This version adds one nullable column:

```sql
ALTER TABLE ai_sdk_threads ADD COLUMN active_stream_id text;
```

### `createThreadStore(db)`

Returns a `ThreadStore` backed by the two tables. `db` is any drizzle Postgres database - `PgDatabase`, which covers node-postgres, postgres.js, Neon, Vercel Postgres, and PGlite.

```ts
import { createThreadStore } from "ai-sdk-threads/drizzle";

const store = createThreadStore(db);
```

If you are on `ai` 6.x, pass the major you are writing so a future migration reads the right stamp:

```ts
const store = createThreadStore(db, { sdkVersion: 6 });
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

### Branching

Messages have always formed a tree here - `parentId` on every row, `activeLeafId` on the thread. These are the operations that use it. Nothing is ever deleted: editing or regenerating leaves the old version in place as a sibling.

`chatHandler` wires the two common cases for you, from what the SDK client already sends:

| The user does           | The client sends                                    | The handler does                                     |
| ----------------------- | --------------------------------------------------- | ---------------------------------------------------- |
| `regenerate()`          | `trigger: "regenerate-message"` + `messageId`        | `regenerateFrom` - the new answer becomes a sibling   |
| Edits an earlier message | `messageId` with changed parts                      | `forkAt` - a new branch from that point               |
| Retries unchanged       | `messageId` with identical parts                    | nothing new is stored                                 |

So regenerate and edit work with no extra code. The store methods are there for the UI:

| Method                          | Returns                                    | Notes                                                          |
| ------------------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| `siblingsOf(messageId)`         | `{ siblings, index }`                      | Everything sharing that message's parent, oldest first.         |
| `setActiveLeaf(threadId, id)`   | `Promise<void>`                            | Switches which path is live. Any message in the thread will do. |
| `getTree(threadId)`             | `Promise<StoredMessage[]>`                 | Every message, flat. Walk `parentId` to rebuild the shape.      |
| `forkAt(messageId, messages)`   | `Promise<StoredMessage[]>`                 | New branch from that message's parent.                          |
| `regenerateFrom(messageId)`     | `Promise<{ parentId }>`                    | Moves the leaf to the parent so you can re-answer.              |

Previous/next buttons over an answer's variants are `siblingsOf` plus `setActiveLeaf`:

```tsx
const { siblings, index } = await store.siblingsOf(message.id);

// "< 2 / 3 >"
async function show(next: number) {
  const target = siblings[next];
  if (target) await store.setActiveLeaf(threadId, target.id);
}
```

`loadMessages` then returns the newly selected path, so re-rendering from it is all the UI has to do. This is the shape [ai-elements' `MessageBranch`](https://ai-sdk.dev/elements) expects.

**Editing changes the message id.** The SDK client reuses the edited message's id, but the original row still holds it - so the edit is stored as a new row with a new id and the old wording is kept as its sibling. Your client picks the new id up on the next `loadMessages`. Nothing is lost either way.

`setActiveLeaf` is also the repair path if a leaf ever points at a message that no longer exists: point it at any message still in the thread and the thread is readable again.

### `orderPath(rows, activeLeafId)`

Walks `parentId` links from a leaf back to the root and returns the rows oldest first. `loadMessages` uses it; it is exported for when you query the tables yourself. Returns `[]` for a `null` leaf and throws on a broken link, naming the id it could not find.

### Schema

```ts
import { messages, threads } from "ai-sdk-threads/drizzle";
```

| `ai_sdk_threads`   | Type             | Notes                                                       |
| ------------------ | ---------------- | ----------------------------------------------------------- |
| `id`               | `text` PK        |                                                             |
| `user_id`          | `text`           | Indexed. Nullable for anonymous chats.                      |
| `title`            | `text`           |                                                             |
| `visibility`       | `text`           | `'private'` (default) or `'public'`.                        |
| `active_leaf_id`   | `text`           | The last message on the live path.                          |
| `active_stream_id` | `text`           | Set while a reply streams; `resumableChat` resumes from it. |
| `metadata`         | `jsonb`          | Yours to use.                                               |
| `created_at`       | `timestamptz(3)` | Millisecond precision on purpose - see below.               |
| `updated_at`       | `timestamptz(3)` | Moved by `appendMessages` and `updateThread`.               |

| `ai_sdk_messages` | Type             | Notes                                   |
| ----------------- | ---------------- | --------------------------------------- |
| `id`              | `text` PK        | The `UIMessage` id.                     |
| `thread_id`       | `text`           | Indexed, `ON DELETE CASCADE`.           |
| `parent_id`       | `text`           | The message this one answers.           |
| `role`            | `text`           | `'system'`, `'user'`, or `'assistant'`. |
| `parts`           | `jsonb`          | `UIMessage.parts`, verbatim.            |
| `metadata`        | `jsonb`          | `UIMessage.metadata`, verbatim.         |
| `sdk_version`     | `smallint`       | The `ai` major that wrote the row.      |
| `created_at`      | `timestamptz(3)` |                                         |

The timestamp columns are **millisecond** precision, not Postgres' microsecond default. `listThreads`' cursor carries `created_at` through a JavaScript `Date`, which cannot represent microseconds; at the default precision the cursor rounds down and the following page silently skips every row sharing that millisecond. Keep the precision if you hand-write the migration.

## How messages are stored

Each message row points at its parent, so the messages of a thread form a tree rather than a flat list, and the thread's `active_leaf_id` marks which path through that tree is the live conversation. `loadMessages` returns exactly that path.

A thread is genuinely a tree once anything has been edited or regenerated, so if you query the tables directly, walk `parent_id` from `active_leaf_id` (or call `orderPath`) rather than sorting by `created_at` - a plain sort interleaves branches that were never part of the same conversation.

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
[issue2929]: https://github.com/vercel/ai/issues/2929
