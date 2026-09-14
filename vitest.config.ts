import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each beforeEach boots a fresh PGlite - a WASM Postgres - which costs about a second idle and
    // several under the parallel forks vitest runs by default. The 10s default left too little room
    // and failed the first test of seven files on a loaded machine, always in the hook, never in an
    // assertion. 30s still catches a genuine hang.
    hookTimeout: 30_000,
  },
});
