import type {
  MethodologyRecord,
  PracticeAssetRecord,
} from "@cognelis/decision-core";
import { assessPracticeAssetFreshness } from "@cognelis/decision-core";
import { snapshotPracticeAssetSources } from "@cognelis/decision-core";
import { describe, expect, it } from "vitest";

const principle = (
  id: string,
  overrides: Partial<MethodologyRecord> = {},
): MethodologyRecord => ({
  id,
  createdAt: "2026-08-01T08:00:00.000Z",
  updatedAt: "2026-08-02T08:00:00.000Z",
  origin: "decision_evidence",
  status: "accepted",
  confirmedAt: "2026-08-02T08:00:00.000Z",
  title: "先验证再扩大",
  principle: "先通过可回退的小步改动验证效果，再扩大范围。",
  appliesWhen: "仍有关键未知项时。",
  caution: "双轨成本过高时重新评估。",
  evidenceSummary: "复盘结果支持这项原则。",
  sourceDecisionIds: ["decision-1"],
  confidence: "medium",
  generation: {
    requestId: "methodology:1",
    profileId: "builtin-qwen",
    provider: "Qwen 本地模型",
    model: "qwen3.5-2b-q4-k-m",
  },
  ...overrides,
});

const asset = (
  overrides: Partial<PracticeAssetRecord> = {},
): PracticeAssetRecord => ({
  id: "skill-1",
  slug: "decision-reversible-change",
  kind: "skill",
  status: "accepted",
  createdAt: "2026-08-03T08:00:00.000Z",
  updatedAt: "2026-08-03T08:00:00.000Z",
  acceptedAt: "2026-08-03T08:00:00.000Z",
  title: "可逆改动验证",
  summary: "用小步改动验证方向。",
  trigger: "仍有未知项时。",
  steps: ["明确假设。", "实施可回退改动。"],
  checks: ["改动可以回退。"],
  fallback: "失败时回退。",
  sourcePrincipleIds: ["principle-1"],
  generation: {
    requestId: "skill:1",
    profileId: "builtin-qwen",
    provider: "Qwen 本地模型",
    model: "qwen3.5-2b-q4-k-m",
  },
  ...overrides,
});

describe("assessPracticeAssetFreshness", () => {
  it("marks an asset current when all accepted sources are no newer", () => {
    expect(
      assessPracticeAssetFreshness(asset(), [principle("principle-1")]),
    ).toMatchObject({
      state: "current",
      updatedSourceCount: 0,
      missingSourceCount: 0,
      unacceptedSourceCount: 0,
      canRegenerate: true,
    });
  });

  it("detects source principles updated after the asset", () => {
    expect(
      assessPracticeAssetFreshness(asset(), [
        principle("principle-1", {
          updatedAt: "2026-08-04T08:00:00.000Z",
        }),
      ]),
    ).toMatchObject({
      state: "sources_updated",
      updatedSourceCount: 1,
      canRegenerate: true,
    });
  });

  it("uses a stored source snapshot instead of trusting a manually advanced asset time", () => {
    const original = principle("principle-1");
    const changed = principle("principle-1", {
      updatedAt: "2026-08-04T08:00:00.000Z",
      principle: "先验证最新约束，再扩大范围。",
    });
    expect(
      assessPracticeAssetFreshness(
        asset({
          updatedAt: "2026-08-05T08:00:00.000Z",
          sourceSnapshots: snapshotPracticeAssetSources([original]),
        }),
        [changed],
      ),
    ).toMatchObject({ state: "sources_updated", updatedSourceCount: 1 });
  });

  it("distinguishes missing and no-longer-accepted sources", () => {
    expect(
      assessPracticeAssetFreshness(
        asset({ sourcePrincipleIds: ["principle-1", "principle-missing"] }),
        [
          principle("principle-1", {
            status: "candidate",
            confirmedAt: null,
          }),
        ],
      ),
    ).toMatchObject({
      state: "sources_unavailable",
      missingSourceCount: 1,
      unacceptedSourceCount: 1,
      canRegenerate: false,
    });
  });
});
