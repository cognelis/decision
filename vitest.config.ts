import { defaultExclude, defineConfig } from "vitest/config";

/**
 * The suites that drive a real Electron process, each with a Vite dev server of
 * its own. Five of them starting at once starve each other: three different
 * ones failed under full-suite load in a single day, every one of them passing
 * alone. A gate that cries wolf stops being read — one of those runs was
 * shipped on because the failure scrolled past — so these run one at a time.
 */
const ELECTRON_SUITES = [
  "apps/desktop/test/electron-check-cleanup.test.ts",
  "apps/desktop/test/dashboard-layout.test.ts",
  "apps/desktop/test/knowledge-layout.test.ts",
  "apps/desktop/test/rationale-layout.test.ts",
  "apps/desktop/test/settings-layout.test.ts",
  "apps/desktop/test/surface-overflow.test.ts",
];

export default defineConfig({
  resolve: {
    alias: {
      "@cognelis/decision-core/journal-entry": new URL(
        "./packages/core/src/journal-entry.ts",
        import.meta.url,
      ).pathname,
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
    coverage: {
      reporter: ["text", "html"],
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          testTimeout: 20_000,
          exclude: [...defaultExclude, ".claude/worktrees/**", ...ELECTRON_SUITES],
        },
      },
      {
        extends: true,
        test: {
          name: "electron",
          environment: "node",
          include: ELECTRON_SUITES,
          // One Electron process on the machine at a time.
          fileParallelism: false,
          testTimeout: 360_000,
        },
      },
    ],
  },
});
