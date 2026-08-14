import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import type { UserConfig } from "vite";

import mainConfig from "../vite.main.config.js";

describe("desktop main Vite config", () => {
  it("resolves workspace packages from the current checkout", () => {
    const config = mainConfig as UserConfig;

    expect(config.resolve?.alias).toMatchObject({
      "@cognelis/decision-protocol": fileURLToPath(
        new URL("../../../packages/protocol/src/index.ts", import.meta.url),
      ),
      "@cognelis/decision-core": fileURLToPath(
        new URL("../../../packages/core/src/index.ts", import.meta.url),
      ),
      "@cognelis/decision-storage": fileURLToPath(
        new URL("../../../packages/storage/src/index.ts", import.meta.url),
      ),
      "@cognelis/decision-integrations": fileURLToPath(
        new URL(
          "../../../packages/integrations/src/index.ts",
          import.meta.url,
        ),
      ),
    });
  });

  it("keeps native runtime modules external for packaged Electron", () => {
    const config = mainConfig as UserConfig;
    const external = config.build?.rollupOptions?.external;

    expect(external).toBeInstanceOf(Array);
    expect(external).toContain("node:sqlite");
    expect(external).toContain("node-llama-cpp");
    expect(external).not.toContain("@duckdb/node-api");
  });
});
