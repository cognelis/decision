import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@cognelis/decision-core/rationale-factors": new URL(
        "./packages/core/src/rationale-factors.ts",
        import.meta.url,
      ).pathname,
      "@cognelis/decision-protocol": new URL(
        "./packages/protocol/src/index.ts",
        import.meta.url,
      ).pathname,
      "@cognelis/decision-core": new URL(
        "./packages/core/src/index.ts",
        import.meta.url,
      ).pathname,
      "@cognelis/decision-storage": new URL(
        "./packages/storage/src/index.ts",
        import.meta.url,
      ).pathname,
      "@cognelis/decision-integrations": new URL(
        "./packages/integrations/src/index.ts",
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    environment: "node",
    testTimeout: 20_000,
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
