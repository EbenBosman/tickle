import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    include: ["src/**/__tests__/**/*.{test,spec}.{ts,tsx}"],
    environment: "jsdom",
    globals: false,
    setupFiles: ["./src/__tests__/setup.ts"],
    testTimeout: 5000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/__tests__/**", "src/main.tsx"],
      // Web has only the StatusPill primitive tested today. Per-file
      // threshold pins it; the rest follows in Phase 5 when the UI
      // decomposes into hook-shaped state and pure ui/.
      thresholds: {
        perFile: false,
        "src/components/StatusPill.tsx": {
          lines: 90,
          branches: 80,
          functions: 100,
          statements: 90,
        },
      },
    },
  },
});
