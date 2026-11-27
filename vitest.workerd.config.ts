import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          MCP_RESOURCE: "https://ega-plugin.test/mcp",
          GITHUB_CLIENT_ID: "local-test-client",
          GITHUB_CLIENT_SECRET: "synthetic-client-secret",
          GITHUB_OWNER_ID: "1",
        },
      },
    }),
  ],
  resolve: {
    alias: {
      "ega-plugin/generated-catalog": new URL("./generated/skills.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: ["tests/worker.test.ts"],
  },
});
