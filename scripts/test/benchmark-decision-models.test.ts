import { describe, expect, it } from "vitest";
// @ts-expect-error Directly executable benchmark ESM.
import { summarizeRows } from "../benchmark-decision-models.mjs";

describe("decision model benchmark metrics", () => {
  it("counts failed calls and false positives without presenting empty high precision as success", () => {
    const row = { expectedBand: "high", expectedRelation: "answers", prediction: { band: "low", relation: "uncertain" }, error: "timeout", inferenceMs: 5000, rssBytes: 100 };
    expect(summarizeRows([row])).toMatchObject({ successRate: 0, highPrecision: null, recall: 0, medianInferenceMs: null, errors: { timeout: 1 } });
    expect(summarizeRows([
      { ...row, error: null, inferenceMs: 100, prediction: { band: "high", relation: "answers" } },
      { ...row, expectedBand: "low", error: null, inferenceMs: 300, prediction: { band: "medium", relation: "uncertain" } },
      row,
    ])).toMatchObject({ successRate: 2 / 3, highPrecision: 1, recall: 0.5, falsePositiveRate: 1, medianInferenceMs: 100, p95InferenceMs: 300 });
  });
});
