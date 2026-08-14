import { describe, expect, it } from "vitest";

import {
  readDecisionEnvironment,
  readDecisionEnvironmentWithSource,
} from "../../config/decision-environment.mjs";

describe("Decision environment compatibility", () => {
  it("prefers the current name", () => {
    expect(
      readDecisionEnvironment(
        {
          DECISION_USER_DATA: "/new",
          DECISION_ISLAND_USER_DATA: "/old",
        },
        "USER_DATA",
      ),
    ).toBe("/new");
  });

  it("falls back to the legacy name throughout 1.x", () => {
    expect(
      readDecisionEnvironment(
        { DECISION_ISLAND_RUNTIME_FILE: "/old/runtime" },
        "RUNTIME_FILE",
      ),
    ).toBe("/old/runtime");
  });

  it("treats empty values as unset and reports the selected source", () => {
    expect(
      readDecisionEnvironmentWithSource(
        { DECISION_SMOKE: "", DECISION_ISLAND_SMOKE: "1" },
        "SMOKE",
      ),
    ).toEqual({ value: "1", source: "legacy" });
  });

  it("reports defaults without exposing an environment value", () => {
    expect(readDecisionEnvironmentWithSource({}, "USER_DATA")).toEqual({
      value: undefined,
      source: "default",
    });
  });
});
