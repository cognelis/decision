import { describe, expect, it } from "vitest";
import { readParaselfEnvironment, readParaselfEnvironmentWithSource } from "../../config/paraself-environment.mjs";

describe("Paraself environment", () => {
  it("reads the current namespace first", () => {
    expect(readParaselfEnvironment({ PARASELF_USER_DATA: "/current", DECISION_USER_DATA: "/legacy", OTHER_USER_DATA: "/other" }, "USER_DATA")).toBe("/current");
    expect(readParaselfEnvironment({ OTHER_USER_DATA: "/other" }, "USER_DATA")).toBeUndefined();
  });
  it("falls back to the name it had as Decision, said apart", () => {
    expect(readParaselfEnvironmentWithSource({ DECISION_SMOKE: "1" }, "SMOKE")).toEqual({ value: "1", source: "legacy" });
    expect(readParaselfEnvironmentWithSource({ PARASELF_SMOKE: "", DECISION_SMOKE: "1" }, "SMOKE")).toEqual({ value: "1", source: "legacy" });
  });
  it("reports current and default values accurately", () => {
    expect(readParaselfEnvironmentWithSource({ PARASELF_SMOKE: "1" }, "SMOKE")).toEqual({ value: "1", source: "current" });
    expect(readParaselfEnvironmentWithSource({ PARASELF_SMOKE: "", DECISION_SMOKE: "" }, "SMOKE")).toEqual({ value: undefined, source: "default" });
  });
});
