import { builtinModules } from "node:module";
import {
  chmod,
  copyFile,
  mkdir,
} from "node:fs/promises";
import { defineConfig } from "vite";

const outputDirectory = "dist/bridge";

export const bridgeWrapperNames = [
  "paraself-bridge",
  "paraself-bridge.cmd",
] as const;

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
      fileName: () => "paraself-bridge.mjs",
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
      name: "paraself-bridge-wrappers",
      closeBundle: async () => {
        await mkdir(outputDirectory, { recursive: true });
        await Promise.all(
          bridgeWrapperNames.map(async (wrapper) => {
            const target = `${outputDirectory}/${wrapper}`;
            await copyFile(`apps/bridge/resources/${wrapper}`, target);
            if (!wrapper.endsWith(".cmd")) {
              await chmod(target, 0o755);
            }
          }),
        );
      },
    },
  ],
});
