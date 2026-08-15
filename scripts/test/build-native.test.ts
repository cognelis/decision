import { describe, expect, it } from "vitest";

// @ts-expect-error The production helper is an executable ESM module.
import { nativeBuildPlan } from "../build-native.mjs";

describe("native build plan", () => {
  it("builds both Apple helpers only on macOS", () => {
    expect(nativeBuildPlan("darwin")).toEqual([
      "scripts/build-foundation-model-helper.sh",
      "scripts/build-liquid-glass-addon.sh",
    ]);
    expect(nativeBuildPlan("win32")).toEqual([]);
    expect(nativeBuildPlan("linux")).toEqual([]);
  });
});
