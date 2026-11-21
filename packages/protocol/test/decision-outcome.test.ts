import { describe, expect, it } from "vitest";

import { decisionOutcomeStateSchema } from "../src/index.js";

describe("decisionOutcomeStateSchema", () => {
  const state = { expectedOutcome: null, outcome: null, review: null, reviewDueDate: null };

  it("carries why a review was scheduled as the decision was written, and an older state without it (IMP-123)", () => {
    expect(decisionOutcomeStateSchema.parse({ ...state, reviewScheduleReasons: ["expected_outcome", "release"] }))
      .toMatchObject({ reviewScheduleReasons: ["expected_outcome", "release"] });
    expect(decisionOutcomeStateSchema.parse(state)).toEqual(state);
    expect(() => decisionOutcomeStateSchema.parse({ ...state, reviewScheduleReasons: ["whim"] })).toThrow();
  });
});
