import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

/**
 * Flat-config ESLint for the server workspace.
 *
 * Layered as base JS recommended → typescript-eslint recommended (type-checked
 * + stylistic-type-checked) → tickle-specific overrides. Type-checked rules
 * require the project's tsconfig; we point at server/tsconfig.json so ESLint
 * can read inferred types out of the program.
 */
export default tseslint.config(
  {
    ignores: [
      "node_modules/",
      "data/",
      "screenshots/",
      "dist/",
      "build/",
      "coverage/",
      "*.config.mjs",
      "*.config.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Hard rule: no `any`. Use `unknown` and narrow.
      "@typescript-eslint/no-explicit-any": "error",
      // The codebase consistently uses inferred types on locals; force-explicit
      // would be churn for no win. Public APIs are still typed via signatures.
      "@typescript-eslint/explicit-module-boundary-types": "off",
      // Allow `_unused` parameter prefix.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Tools return `{ ok: false, error }` — synchronous throw is the rare
      // exception. Don't enforce return types as a style rule.
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],
      // Codebase consistently uses `type` for object shapes; flipping
      // half of them to `interface` is churn for no safety value.
      "@typescript-eslint/consistent-type-definitions": "off",
      // Fastify handlers are conventionally `async` even without await
      // (so `return reply.code(...)` chains are uniform); the rule
      // would force renaming many handlers for no behavioural change.
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    // Tests can be looser. Mocks and fixtures often use values typed as
    // `unknown`/`never`; assertion shapes return any from Vitest matchers.
    files: ["src/__tests__/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
);
