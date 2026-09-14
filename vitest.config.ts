import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each beforeEach boots a fresh PGlite - a WASM Postgres - costing ~1s idle and several
    // seconds under vitest's default parallel forks. 10s was too tight; 30s still catches a hang.
    hookTimeout: 30_000,
  },
});
