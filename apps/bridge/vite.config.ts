import { builtinModules } from "node:module";
import {
  chmod,
  copyFile,
  mkdir,
} from "node:fs/promises";
import { defineConfig } from "vite";

const outputDirectory = "dist/bridge";

export default defineConfig({
  resolve: {
    conditions: ["node"],
  },
  build: {
    target: "node20",
    emptyOutDir: true,
    minify: false,
    outDir: outputDirectory,
    lib: {
      entry: "apps/bridge/src/cli.ts",
      formats: ["es"],
      fileName: () => "decision-bridge.mjs",
    },
    rollupOptions: {
      preserveEntrySignatures: "strict",
      external: [
        ...builtinModules,
        ...builtinModules.map((module) => `node:${module}`),
        "node:sqlite",
      ],
    },
  },
  plugins: [
    {
      name: "decision-bridge-wrappers",
      closeBundle: async () => {
        await mkdir(outputDirectory, { recursive: true });
        const wrappers = ["decision-bridge", "decision-island-bridge"];
        await Promise.all(
          wrappers.map(async (wrapper) => {
            const target = `${outputDirectory}/${wrapper}`;
            await copyFile(`apps/bridge/resources/${wrapper}`, target);
            await chmod(target, 0o755);
          }),
        );
      },
    },
  ],
});
