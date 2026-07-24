import { defineConfig } from "vitest/config";

// Unit tests for the pure, framework-free logic in the tasks app — the
// scheduling/calendar geometry especially (see src/app/tasks/lib/*.test.ts).
// Node environment: these helpers are plain Date/array math, no DOM.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
