import type { MethodologyRecord } from "../src/index.js";
import { assessMethodologyQuality } from "../src/index.js";
import { describe, expect, it } from "vitest";

const record = (
  overrides: Partial<MethodologyRecord> = {},
): MethodologyRecord => ({
  id: "principle-1",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  origin: "decision_evidence",
  status: "candidate",
  confirmedAt: null,
  title: "先保留回退路径",
  principle: "上线前保留旧实现，并通过分步切换验证新路径。",
  appliesWhen: "需求仍变化且结果需要真实反馈时。",
  caution: "双轨运行成本过高时需要限定过渡时间。",
  evidenceSummary: "证据支持分步验证。",
  sourceDecisionIds: ["decision-1"],
  confidence: "low",
  generation: {
    requestId: "request-1",
    profileId: "profile-1",
    provider: "Qwen",
    model: "qwen",
  },
  ...overrides,
});

describe("assessMethodologyQuality", () => {
  it("labels an imported principle without reviewed evidence as an unverified hypothesis", () => {
    const imported = record({
      origin: "markdown_import",
      sourceDecisionIds: [],
    });

    const quality = assessMethodologyQuality(imported, [imported], []);

    expect(quality).toMatchObject({
      recommendedConfidence: "low",
      evidenceCount: 0,
      missingEvidenceCount: 0,
      flags: ["no_evidence"],
    });
    expect(quality.confidenceReason).toContain("待验证假设");
  });

  it("requires consistent evidence from multiple projects for high confidence", () => {
    const candidate = record({
      sourceDecisionIds: ["decision-1", "decision-2", "decision-3"],
    });

    const quality = assessMethodologyQuality(candidate, [candidate], [
      {
        id: "decision-1",
        project: "alpha",
        sourceClient: "codex",
        outcomeVerdict: "better",
      },
      {
        id: "decision-2",
        project: "alpha",
        sourceClient: "claude-code",
        outcomeVerdict: "as_expected",
      },
      {
        id: "decision-3",
        project: "beta",
        sourceClient: "codex",
        outcomeVerdict: "as_expected",
      },
    ]);

    expect(quality).toMatchObject({
      recommendedConfidence: "high",
      evidenceCount: 3,
      projectCount: 2,
      sourceCount: 2,
      favorableEvidenceCount: 3,
      flags: [],
    });
  });

  it("keeps contradictory and unclear evidence at low confidence", () => {
    const candidate = record({
      sourceDecisionIds: ["decision-1", "decision-2", "decision-3"],
    });

    const quality = assessMethodologyQuality(candidate, [candidate], [
      {
        id: "decision-1",
        project: "alpha",
        sourceClient: "codex",
        outcomeVerdict: "better",
      },
      {
        id: "decision-2",
        project: "beta",
        sourceClient: "codex",
        outcomeVerdict: "worse",
      },
      {
        id: "decision-3",
        project: "gamma",
        sourceClient: "claude-code",
        outcomeVerdict: "unclear",
      },
    ]);

    expect(quality.recommendedConfidence).toBe("low");
    expect(quality.flags).toEqual(
      expect.arrayContaining(["mixed_outcomes", "unclear_outcomes"]),
    );
  });

  it("finds similar active principles and explains shared evidence", () => {
    const candidate = record();
    const existing = record({
      id: "principle-2",
      status: "accepted",
      confirmedAt: "2026-08-02T00:00:00.000Z",
      title: "保留回退路径后分步切换",
      principle: "上线前保留旧实现，通过分步切换逐步验证新的实现路径。",
      appliesWhen: "需求仍变化，实施效果还需要真实反馈时。",
    });

    const quality = assessMethodologyQuality(
      candidate,
      [candidate, existing],
      [
        {
          id: "decision-1",
          project: "alpha",
          sourceClient: "codex",
          outcomeVerdict: "as_expected",
        },
      ],
    );

    expect(quality.relations).toEqual([
      expect.objectContaining({
        id: "principle-2",
        kind: "similar",
        sharedEvidenceCount: 1,
      }),
    ]);
    expect(quality.flags).toContain("similar_principle");
  });

  it("marks opposing actions in overlapping principles as a potential conflict", () => {
    const candidate = record();
    const existing = record({
      id: "principle-2",
      status: "accepted",
      confirmedAt: "2026-08-02T00:00:00.000Z",
      title: "一次切换并删除旧实现",
      principle: "上线前删除旧实现，并通过一次切换完成新路径替换。",
      appliesWhen: "需求稳定且维护双轨实现的成本很高时。",
      sourceDecisionIds: ["decision-2"],
    });

    const quality = assessMethodologyQuality(
      candidate,
      [candidate, existing],
      [
        {
          id: "decision-1",
          project: "alpha",
          sourceClient: "codex",
          outcomeVerdict: "as_expected",
        },
      ],
    );

    expect(quality.relations[0]).toMatchObject({
      id: "principle-2",
      kind: "potential_conflict",
    });
    expect(quality.relations[0]?.reason).toContain("保留 / 删除");
    expect(quality.flags).toContain("potential_conflict");
  });

  it("does not report an expected revision lineage as a duplicate relation", () => {
    const accepted = record({
      id: "principle-stable",
      status: "accepted",
      confirmedAt: "2026-08-02T00:00:00.000Z",
    });
    const revision = record({
      id: "principle-revision",
      origin: "principle_revision",
      sourceDecisionIds: ["decision-1", "decision-2"],
      sourcePrincipleIds: [accepted.id],
      principle: `${accepted.principle} 进入不可逆步骤前重新核对证据。`,
    });

    const quality = assessMethodologyQuality(revision, [accepted, revision], [
      {
        id: "decision-1",
        project: "alpha",
        sourceClient: "codex",
        outcomeVerdict: "as_expected",
      },
      {
        id: "decision-2",
        project: "beta",
        sourceClient: "codex",
        outcomeVerdict: "mixed",
      },
    ]);

    expect(quality.relations).toEqual([]);
    expect(quality.flags).not.toContain("similar_principle");
  });

  it("keeps an unrelated human resolution visible without blocking quality", () => {
    const candidate = record();
    const existing = record({
      id: "principle-2",
      status: "accepted",
      confirmedAt: "2026-08-02T00:00:00.000Z",
      title: "保留回退路径后分步切换",
      principle: "上线前保留旧实现，通过分步切换逐步验证新的实现路径。",
      appliesWhen: "需求仍变化，实施效果还需要真实反馈时。",
    });

    const quality = assessMethodologyQuality(
      candidate,
      [candidate, existing],
      [],
      [
        {
          id: "relation-1",
          createdAt: "2026-08-06T10:00:00.000Z",
          updatedAt: "2026-08-06T11:00:00.000Z",
          principleIds: [candidate.id, existing.id],
          principleTitles: [candidate.title, existing.title],
          disposition: "unrelated",
          note: "一个约束发布过程，另一个约束长期迁移。",
        },
      ],
    );

    expect(quality.relations[0]).toMatchObject({
      id: existing.id,
      resolution: "unrelated",
      resolutionNote: "一个约束发布过程，另一个约束长期迁移。",
    });
    expect(quality.flags).not.toContain("similar_principle");
    expect(quality.flags).not.toContain("potential_conflict");
  });

  it("preserves a confirmed conflict after wording changes remove the heuristic signal", () => {
    const candidate = record();
    const existing = record({
      id: "principle-2",
      title: "独立审批",
      principle: "由另一名负责人完成上线审批。",
      appliesWhen: "变更涉及生产权限时。",
      sourceDecisionIds: ["decision-2"],
    });

    const quality = assessMethodologyQuality(
      candidate,
      [candidate, existing],
      [],
      [
        {
          id: "relation-1",
          createdAt: "2026-08-06T10:00:00.000Z",
          updatedAt: "2026-08-06T11:00:00.000Z",
          principleIds: [candidate.id, existing.id],
          principleTitles: [candidate.title, existing.title],
          disposition: "conflict",
          note: null,
        },
      ],
    );

    expect(quality.relations).toEqual([
      expect.objectContaining({
        id: existing.id,
        kind: "potential_conflict",
        resolution: "conflict",
        score: 0,
      }),
    ]);
    expect(quality.flags).toContain("potential_conflict");
  });
});
