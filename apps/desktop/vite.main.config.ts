import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      "@cognelis/decision-protocol": fileURLToPath(
        new URL("../../packages/protocol/src/index.ts", import.meta.url),
      ),
      "@cognelis/decision-core": fileURLToPath(
        new URL("../../packages/core/src/index.ts", import.meta.url),
      ),
      "@cognelis/decision-storage": fileURLToPath(
        new URL("../../packages/storage/src/index.ts", import.meta.url),
      ),
      "@cognelis/decision-integrations": fileURLToPath(
        new URL(
          "../../packages/integrations/src/index.ts",
          import.meta.url,
        ),
      ),
    },
  },
  build: {
    rollupOptions: {
      external: ["node:sqlite", "node-llama-cpp"],
      output: {
        entryFileNames: "main.cjs",
      },
    },
  },
});
