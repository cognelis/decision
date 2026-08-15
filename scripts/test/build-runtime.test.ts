import { describe, expect, it } from "vitest";

// @ts-expect-error The production helper is an executable ESM module.
import { assertSupportedBuildRuntime } from "../check-build-runtime.mjs";

describe("native build runtime", () => {
  it.each(["22.13.0", "22.22.1", "24.19.0", "25.0.0"])(
    "accepts supported Node %s",
    (version) => {
      expect(() => assertSupportedBuildRuntime(version)).not.toThrow();
    },
  );

  it.each(["21.7.3", "22.12.0", "26.0.0", "27.1.0"])(
    "rejects unsupported Node %s with an actionable message",
    (version) => {
      expect(() => assertSupportedBuildRuntime(version)).toThrow(
        /Node\.js >=22\.13\.0 <26/u,
      );
    },
  );

  it("rejects malformed runtime versions", () => {
    expect(() => assertSupportedBuildRuntime("current")).toThrow(
      /Unable to determine/u,
    );
  });
});
