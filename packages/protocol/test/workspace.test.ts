import { describe, expect, it } from "vitest";

describe("workspace", () => {
  it("runs TypeScript tests", () => {
    expect("decision").toContain("decision");
  });
});
