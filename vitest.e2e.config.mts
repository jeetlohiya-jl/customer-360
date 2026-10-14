import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// End-to-end tests against a temporary local PostgreSQL (scripts/scan-e2e-local.sh).
export default defineConfig({
  cacheDir: "/tmp/c360-vitest-e2e-cache",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: { environment: "node", include: ["tests/e2e/**/*.e2e.test.ts"], testTimeout: 60_000, fileParallelism: false },
});
