import { describe, expect, it } from "vitest";
import { modelPricingSchema } from "@cognelis/decision-protocol";
import { DEEPSEEK_2026_HOLIDAYS, estimateModelCost, traceCost } from "../src/shared/model-pricing.js";
import { modelTraceFixture } from "./app-fixtures.js";

const price = { currency: "¥", inputPerMillion: 1, cachedInputPerMillion: 0.02, outputPerMillion: 4, peak: { inputPerMillion: 2, cachedInputPerMillion: 0.04, outputPerMillion: 8, holidayYear: 2026, holidays: DEEPSEEK_2026_HOLIDAYS } };
const usage = { source: "provider_reported" as const, inputTokens: 1000000, cachedInputTokens: 500000, outputTokens: 1000000, reasoningOutputTokens: 750000 };

describe("DeepSeek pricing", () => {
  it.each([["00:59", 4.51], ["01:00", 9.02], ["03:59", 9.02], ["04:00", 4.51], ["05:59", 4.51], ["06:00", 9.02], ["09:59", 9.02], ["10:00", 4.51]])("uses Beijing time boundaries at UTC %s", (time, cost) => {
    const result = estimateModelCost(usage, price, `2026-10-12T${time}:00Z`)!;
    expect(result.minimum).toBeCloseTo(cost); expect(result.maximum).toBeCloseTo(cost);
  });
  it("does not treat a Saturday make-up workday or a holiday as peak", () => {
    for (const date of ["2026-10-10", "2026-10-05", "2026-02-20"]) expect(estimateModelCost(usage, price, `${date}T01:00:00Z`)).toMatchObject({ period: "off-peak", minimum: 4.51 });
  });
  it("reports bounds for missing cache statistics and an uncovered holiday year", () => {
    const { cachedInputTokens: _, ...unknownCache } = usage;
    expect(estimateModelCost(unknownCache, price, "2026-10-12T00:00:00Z")).toMatchObject({ minimum: 4.02, maximum: 5, cacheKnown: false });
    expect(estimateModelCost(usage, price, "2027-01-12T01:00:00Z")).toMatchObject({ minimum: 4.51, maximum: 9.02, period: "unknown-calendar" });
  });
  it("uses the call's price snapshot and estimated start instead of current prices or completion time", () => {
    const trace = { ...modelTraceFixture(), createdAt: "2026-10-12T04:00:01Z", timing: { queuedMs: 0, providerMs: 2000, totalMs: 2000 }, usage, profile: { ...modelTraceFixture().profile, pricing: price } };
    expect(traceCost(trace, { currency: "¥", inputPerMillion: 99, outputPerMillion: 99 })).toMatchObject({ minimum: 9.02, period: "peak" });
  });
  it("keeps legacy flat prices and rejects inconsistent cache counts or invalid calendars", () => {
    expect(estimateModelCost(usage, { currency: "¥", inputPerMillion: 2, outputPerMillion: 8 }, "2026-10-12T01:00:00Z")).toMatchObject({ minimum: 10, maximum: 10 });
    expect(estimateModelCost({ ...usage, cachedInputTokens: 2000000 }, price, "2026-10-12T01:00:00Z")).toBeNull();
    expect(modelPricingSchema.safeParse({ ...price, peak: { ...price.peak, holidays: ["2026-02-30"] } }).success).toBe(false);
    expect(modelPricingSchema.safeParse({ ...price, peak: { ...price.peak, holidays: ["2027-01-01"] } }).success).toBe(false);
  });
});
