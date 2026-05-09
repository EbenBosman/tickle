import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.{test,spec}.ts"],
    environment: "node",
    globals: false,
    testTimeout: 5000,
    pool: "threads",
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/__tests__/**", "src/index.ts", "src/loadEnv.ts"],
      // Per-file thresholds for modules that already have tests. If a
      // future change removes tests or guts a covered branch, the run
      // fails. Untested modules (agent.ts, browser.ts, db.ts, snapshot.ts,
      // loginDetect.ts, routes/*) are not gated yet — Phase 4–5 brings
      // them in with their per-block decompositions, and global lines
      // ratchets up as that lands.
      thresholds: {
        perFile: false,
        "src/pause.ts": { lines: 95, branches: 85, functions: 100, statements: 95 },
        "src/cancel.ts": { lines: 100, branches: 100, functions: 100, statements: 100 },
        "src/bus.ts": { lines: 90, branches: 75, functions: 100, statements: 90 },
        "src/log.ts": { lines: 90, branches: 90, functions: 100, statements: 90 },
        "src/errors.ts": { lines: 95, branches: 90, functions: 100, statements: 95 },
        "src/cors.ts": { lines: 90, branches: 80, functions: 100, statements: 90 },
        "src/paths.ts": { lines: 95, branches: 90, functions: 100, statements: 95 },
        "src/blockOutcome.ts": { lines: 95, branches: 90, functions: 100, statements: 95 },
        // blocks.ts has untested kind branches in parseBlocks/newBlock; raise
        // when the block-executor specs land.
        "src/blocks.ts": { lines: 70, branches: 70, functions: 100, statements: 70 },
      },
    },
  },
});
