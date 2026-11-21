import { defineConfig, mergeConfig } from "vite";

import main from "./vite.main.config";

// The local models' process (semantic/local-model-host.ts), built beside main.cjs with the same aliases and externals:
// node-llama-cpp is loaded from node_modules, its native libraries from app.asar.unpacked.
export default mergeConfig(main, defineConfig({
  build: {
    rollupOptions: {
      output: {
        entryFileNames: "local-model-host.cjs",
      },
    },
  },
}));
