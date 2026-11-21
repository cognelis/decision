import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

// The workspace packages from this checkout's own sources, as vitest.config.ts has them: a worktree whose node_modules
// links to another checkout's took that checkout's packages, and a page using what this one added came up blank.
const source = (path: string): string => resolve(process.cwd(), path);

export default defineConfig({
  base: "./",
  root: resolve(process.cwd(), "apps/desktop/src/renderer"),
  plugins: [react()],
  resolve: {
    alias: {
      "@cognelis/decision-core/journal-entry": source("packages/core/src/journal-entry.ts"),
      "@cognelis/decision-core/todo": source("packages/core/src/todo.ts"),
      "@cognelis/decision-core/historical-decision": source("packages/core/src/historical-decision.ts"),
      "@cognelis/decision-core/todo-dependencies": source("packages/core/src/todo-dependencies.ts"),
      "@cognelis/decision-core/recommendation": source("packages/core/src/recommendation.ts"),
      "@cognelis/decision-core/rationale-factors": source("packages/core/src/rationale-factors.ts"),
      "@cognelis/decision-core": source("packages/core/src/index.ts"),
      "@cognelis/decision-protocol": source("packages/protocol/src/index.ts"),
    },
  },
  build: {
    outDir: resolve(process.cwd(), ".vite/renderer/main_window"),
  },
});
