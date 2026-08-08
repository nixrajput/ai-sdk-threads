# Contributing to ai-sdk-threads

Thanks for your interest in contributing. ai-sdk-threads persists chat threads and messages for the Vercel AI SDK, and contributions that make chat persistence less painful are very welcome.

## Code of Conduct

Please review and adhere to our [Code of Conduct](CODE_OF_CONDUCT.md). We expect all contributors to be respectful, considerate, and inclusive when interacting with the project and its community.

## Getting set up

Requires Node.js `>=20`.

```bash
git clone https://github.com/nixrajput/ai-sdk-threads.git
cd ai-sdk-threads
npm install
git config core.hooksPath .githooks   # optional: runs the checks below before each push
```

The test suite runs against PGlite, an in-process Postgres, so there is no database to start and no Docker involved. `ai` and `drizzle-orm` are installed as devDependencies to exercise the real peer surface.

## The checks

Every one of these must pass before a PR can merge - CI runs exactly the same set:

```bash
npm run lint       # biome check (lint + format)
npm run ts:check   # tsc --noEmit, twice: once with Node types, once without
npm test           # vitest run
npm run build      # tsdown + publint + attw
```

`npm run format` rewrites formatting if `lint` complains.

The second `ts:check` pass typechecks `src/` with no Node types at all. AI SDK routes commonly run on edge runtimes, so an accidental `process` or `Buffer` in `src/` is a bug - it fails there rather than at a consumer whose runtime has neither.

## Workflow

1. **Fork and branch.** Branch off `main` with a descriptive name (`feat/sqlite-adapter`, `fix/leaf-advance-race`).
2. **Write the test first.** Every feature and bugfix lands with a test. Bugs get a test that reproduces them before the fix.
3. **Keep the diff surgical.** Every changed line should trace to the change you are making. No drive-by refactors, no speculative abstractions.
4. **Bump the version.** `package.json` must move in every PR that changes anything users receive - CI enforces it (`version bumped`). Patch for fixes, minor for features.
5. **Update the docs.** If behavior a user can see changes, the README changes in the same PR.
6. **Open the PR.** Fill in the template. The PR title becomes the squash commit message on merge, so write it in Conventional Commit form (`feat: add sqlite adapter`) and keep it under ~50 characters.

## Schema changes

The tables are exported for users to include in their own drizzle schema and migrations, which makes any change to them a migration event for every consumer. A PR that changes a column, index, or table name must say so explicitly in its body, and additive-and-nullable beats a rewrite. Message rows form a parent-linked tree (`parentId` plus the thread's `activeLeafId`) even where the current APIs only walk it linearly, so that branching does not become a breaking schema change later - please do not "simplify" that away.

## Conventions

- **Commits:** Conventional Commits (`feat:`, `fix:`, `docs:`, `ci:`, `chore:`, `refactor:`), imperative subject, no trailing period.
- **Style:** Biome, double quotes, semicolons, trailing commas, 100-column lines - Prettier-compatible defaults. Do not hand-format - run `npm run format`.
- **Language:** TypeScript strict, ESM only, Node `>=20`. No CJS build.
- **Dependencies:** the core ships with zero runtime dependencies, and that is a feature. `ai` and `drizzle-orm` are peers; `drizzle-orm` is optional so the core can be used without it. Please do not add a runtime dependency without discussing it in an issue first.
- **Comments:** explain why, not what. Most code needs none.

## Reporting issues

Bugs and feature requests go to [Issues](https://github.com/nixrajput/ai-sdk-threads/issues) - the templates ask for versions, your Postgres driver, and a minimal repro, which is usually enough to act on. Questions and open-ended ideas belong in [Discussions](https://github.com/nixrajput/ai-sdk-threads/discussions). Security issues follow [SECURITY.md](SECURITY.md) instead - never a public issue.

## Thank you

Every issue, repro, and PR makes this project more useful. Thanks for taking the time.
