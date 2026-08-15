import { describe, expect, it } from "vitest";
import type { UserConfig } from "vite";

import bridgeConfig, { bridgeWrapperNames } from "../vite.config.js";

describe("bridge Vite config", () => {
  it("bundles stdio dependencies for the Node runtime", () => {
    const config = bridgeConfig as UserConfig;

    expect(config.resolve?.conditions).toContain("node");
    expect(config.build?.target).toBe("node20");
  });

  it("keeps node:sqlite native on build hosts that do not list it yet", () => {
    const config = bridgeConfig as UserConfig;
    const external = config.build?.rollupOptions?.external;

    expect(external).toBeInstanceOf(Array);
    expect(external).toContain("node:sqlite");
  });

  it("packages current and 1.x-compatible wrappers for both shell families", () => {
    expect(bridgeWrapperNames).toEqual([
      "decision-bridge",
      "decision-island-bridge",
      "decision-bridge.cmd",
      "decision-island-bridge.cmd",
    ]);
  });
});
