import { defineConfig } from "vitest/config";

// Unit tests for the pure, framework-free logic in the tasks app — the
// scheduling/calendar geometry especially (see src/app/tasks/lib/*.test.ts).
// Node environment: these helpers are plain Date/array math, no DOM.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // esbuild's JS API talks to a child process over stdio, which deadlocks in
    // the default worker_threads pool (compileArtifact.test.ts hangs on every
    // build call). Forked child processes handle that correctly.
    pool: "forks",
  },
});
