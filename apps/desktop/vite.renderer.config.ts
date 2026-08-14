import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  root: resolve(process.cwd(), "apps/desktop/src/renderer"),
  plugins: [react()],
  build: {
    outDir: resolve(process.cwd(), ".vite/renderer/main_window"),
  },
});
