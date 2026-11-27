import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "tests/worker.test.ts",
      "tests/security/authorization.test.ts",
    ],
  },
  resolve: {
    alias: {
      "ega-plugin/generated-catalog": new URL("./generated/skills.ts", import.meta.url).pathname,
    },
  },
});
