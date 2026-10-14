import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Live evaluation of the extractor on SYNTHETIC emails only. Calls the Anthropic
// API, so it runs only when EVAL_APPROVED=yes and ANTHROPIC_API_KEY are set.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: { environment: "node", include: ["tests/eval/**/*.eval.test.ts"], testTimeout: 600_000 },
});
