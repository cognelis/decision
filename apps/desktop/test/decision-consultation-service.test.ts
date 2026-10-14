import type { MethodologyRecord } from "@cognelis/decision-core";
import {
  DECISION_CONSULTATION_VERSION,
  consultationAsReleased,
  type DecisionConsultationRequest,
} from "@cognelis/decision-protocol";
import { describe, expect, it } from "vitest";

import { buildDecisionConsultation } from "../src/main/decision-consultation-service.js";

const methodology = (
  id: string,
  overrides: Partial<MethodologyRecord> = {},
): MethodologyRecord => ({
  id,
  createdAt: "2026-08-01T08:00:00.000Z",
  updatedAt: "2026-08-02T08:00:00.000Z",
  origin: "decision_evidence",
  status: "accepted",
  confirmedAt: "2026-08-02T08:00:00.000Z",
  title: "先验证边界，再扩大投入",
  principle: "先通过可回退的小步验证关键边界，再扩大不可逆投入。",
  appliesWhen: "兼容性和真实运行效果仍不明确时。",
  caution: "验证成本明显高于潜在返工损失时重新评估。",
  evidenceSummary: "两条复盘支持。",
  sourceDecisionIds: ["decision-1", "decision-2"],
  confidence: "medium",
  generation: {
    requestId: `methodology:${id}`,
    profileId: "builtin-qwen",
    provider: "Qwen",
    model: "qwen3.5",
  },
  ...overrides,
});

const request = (
  overrides: Partial<DecisionConsultationRequest> = {},
): DecisionConsultationRequest => ({
  consultationVersion: DECISION_CONSULTATION_VERSION,
  requestId: "consultation-1",
  sourceClient: "codex",
  project: "decision",
  question: "上线前是否先验证兼容边界？",
  options: [{ label: "直接上线" }, { label: "先小范围验证" }],
  context: "真实运行兼容性仍不明确。",
  requestedAt: "2026-08-08T10:00:00.000Z",
  ...overrides,
});

describe("decision consultation service", () => {
  it("says the reader's preferences and ideas could not be read, rather than answering as if there were none", () => {
    const result = buildDecisionConsultation(request(), [methodology("principle-1")], undefined, null);
    expect(result).toMatchObject({ signals: [], signalsUnavailable: true });
    // Answered in 1.1.0's shape to a bridge from before, which refused every key it did not know.
    expect(consultationAsReleased(result)).not.toHaveProperty("signalsUnavailable");
    expect(buildDecisionConsultation(request(), [], undefined, [])).not.toHaveProperty("signalsUnavailable");
  });

  it("distinguishes an empty adopted-principle source from an unrelated query", () => {
    expect(buildDecisionConsultation(request(), []).noMatchReason).toBe("no_accepted_principles");
    expect(buildDecisionConsultation(request(), [methodology("candidate", { status: "candidate", confirmedAt: null })]).noMatchReason).toBe("no_accepted_principles");
  });
  it("returns accepted principles and explicit non-writing boundaries", () => {
    const result = buildDecisionConsultation(request(), [
      methodology("relevant"),
      methodology("candidate", { status: "candidate", confirmedAt: null }),
    ]);

    expect(result).toMatchObject({
      status: "matched",
      generatedBy: "deterministic_local_match",
      boundary: {
        advisoryOnly: true,
        noDecisionWritten: true,
        noPrincipleApplied: true,
      },
    });
    expect(result.matches).toEqual([
      expect.objectContaining({
        principleId: "relevant",
        confidence: "medium",
        evidenceCount: 2,
        relevance: "strong",
      }),
    ]);
  });

  it("returns an honest no-match response instead of forcing a principle", () => {
    const result = buildDecisionConsultation(
      request({
        question: "应该采用哪种营销插画风格？",
        options: [{ label: "水彩" }, { label: "像素" }],
        context: "需要匹配节日活动视觉语气。",
      }),
      [methodology("unrelated")],
    );

    expect(result.status).toBe("no_match");
    expect(result.noMatchReason).toBe("no_relevant_principles");
    expect(result.matches).toEqual([]);
  });

  it("keeps preferences beside the principles, never among them", () => {
    const journal = [
      {
        id: "preference-rollback",
        kind: "preference",
        title: "先留回滚入口，再扩大发布",
        content: "不可逆的发布步骤要先有明确的回滚路径和负责人。",
        knowledgeStatus: "active",
        sourceKind: "app_manual",
        sourceForm: "user_original",
        project: "decision",
        occurredAt: null,
        sensitivity: "personal",
        context: null,
        rationale: null,
        tags: [],
        languages: [],
        appliesWhen: "改动一旦上线就难以撤回时。",
        exceptions: "只影响本机、随时可以重装的改动。",
        strength: "default",
        evidenceMaturity: "reviewed",
        createdAt: "2026-08-02T10:00:00.000Z",
        updatedAt: "2026-08-09T10:00:00.000Z",
        revision: 2,
        revisionEvents: [],
      },
    ] as unknown as Parameters<typeof buildDecisionConsultation>[3];

    // Kept for Go: not recalled for TypeScript code, recalled for Go (said by another of its names), and for code
    // whose languages a released client did not say.
    const goOnly = [{ ...journal![0]!, languages: ["go"] }] as typeof journal;
    const rollback = { ...request(), question: "这次发布要不要先留回滚入口？", context: "改动一旦上线就难以撤回。" };
    expect(buildDecisionConsultation({ ...rollback, languages: ["TypeScript"] }, [], undefined, goOnly).signals).toEqual([]);
    expect(buildDecisionConsultation({ ...rollback, languages: ["golang"] }, [], undefined, goOnly).signals).toHaveLength(1);
    expect(buildDecisionConsultation(rollback, [], undefined, goOnly).signals).toHaveLength(1);

    const result = buildDecisionConsultation(
      {
        ...request(),
        question: "这次发布要不要先留回滚入口？",
        options: [
          { label: "先留回滚入口" },
          { label: "直接全量发布" },
        ],
        context: "改动一旦上线就难以撤回。",
      },
      [],
      undefined,
      journal,
    );

    // `matches` is the answer to "is there a rule about this". A preference is
    // not one, so it must not change that answer.
    expect(result.matches).toEqual([]);
    expect(result.status).toBe("no_match");
    expect(result.noMatchReason).toBe("no_accepted_principles");
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]?.kind).toBe("preference");
    expect(result.signals[0]?.standing).toContain("不是已采纳原则");
    expect(result.boundary.noPreferencePromoted).toBe(true);

    // Longer than a consultation carries: cut and marked, rather than the consultation refused whole.
    const long = [{ ...journal![0]!, content: `不可逆的发布步骤要先有回滚路径。${"细节".repeat(2_200)}` }] as typeof journal;
    const cut = buildDecisionConsultation({ ...request(), question: "这次发布要不要先留回滚入口？", context: "改动一旦上线就难以撤回。" }, [], undefined, long);
    expect(cut.signals).toHaveLength(1);
    expect(cut.signals[0]!.summary.length).toBeLessThanOrEqual(4_000);
    expect(cut.signals[0]!.summary.endsWith("…（节选）")).toBe(true);
  });
});
