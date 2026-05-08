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
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/__tests__/**",
        "src/index.ts",
        "src/loadEnv.ts",
      ],
    },
  },
});
