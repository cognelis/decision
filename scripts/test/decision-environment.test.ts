import { describe, expect, it } from "vitest";
import { readDecisionEnvironment, readDecisionEnvironmentWithSource } from "../../config/decision-environment.mjs";

describe("Decision environment", () => {
  it("reads only the current namespace", () => {
    expect(readDecisionEnvironment({ DECISION_USER_DATA: "/current", OTHER_USER_DATA: "/other" }, "USER_DATA")).toBe("/current");
    expect(readDecisionEnvironment({ OTHER_USER_DATA: "/other" }, "USER_DATA")).toBeUndefined();
  });
  it("reports current and default values accurately", () => {
    expect(readDecisionEnvironmentWithSource({ DECISION_SMOKE: "1" }, "SMOKE")).toEqual({ value: "1", source: "current" });
    expect(readDecisionEnvironmentWithSource({ DECISION_SMOKE: "" }, "SMOKE")).toEqual({ value: undefined, source: "default" });
  });
});
