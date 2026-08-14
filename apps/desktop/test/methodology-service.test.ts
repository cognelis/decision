import {
  MethodologyRelationRepository,
  MethodologyRepository,
  type IndexedDecision,
} from "@cognelis/decision-storage";
import {
  assessPracticeAssetFreshness,
  type PracticeAssetRecord,
} from "@cognelis/decision-core";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { MethodologyService } from "../src/main/methodology-service.js";
import { MethodologyHistoryStore } from "../src/main/methodology-history-store.js";
import {
  ProfiledModelGatewayError,
  type ProfiledModelGateway,
} from "../src/main/model/profiled-model-gateway.js";

const reviewedDecision = (
  overrides: Partial<IndexedDecision> = {},
): IndexedDecision => ({
  id: "decision-1",
  created: "2026-08-01T08:00:00.000Z",
  status: "completed",
  sourceClient: "codex",
  project: "decision",
  workflow: null,
  decisionType: "implementation",
  selectedAnswer: "先做可逆的小改动",
  captureMode: "text",
  captureSemanticKey: null,
  sourceEventId: null,
  batchId: null,
  questionIndex: null,
  rationaleStatus: "captured",
  filePath: "/vault/decision-1.md",
  contentHash: "hash",
  question: "应该一次重构还是分步调整？",
  rationale: "分步更容易验证和回退。",
  context: "需求边界仍在变化。",
  outcome: "分步上线后没有出现大范围回归。",
  outcomeVerdict: "as_expected",
  outcomeLesson: "可逆的小步提交降低了返工成本。",
  outcomeReviewedAt: "2026-08-02T08:00:00.000Z",
  reviewDueDate: null,
  appliedPrincipleIds: [],
  ...overrides,
});

const makeService = async (decisions: IndexedDecision[]) => {
  const vault = await mkdtemp(join(tmpdir(), "methodology-service-"));
  const repository = new MethodologyRepository(vault);
  const relationRepository = new MethodologyRelationRepository(vault);
  const generate = vi.fn(async (request) => ({
    requestId: request.requestId,
    attemptId: "attempt-1",
    profileId: "builtin-qwen",
    backend: "qwen" as const,
    provider: "Qwen 本地模型",
    model: "qwen3.5-2b-q4-k-m",
    visibleOutput: "{}",
    parsedOutput: {
      title: "先保持可逆",
      principle: "在需求仍变化时，先实施能快速回退的小步改动。",
      appliesWhen: "方案效果需要通过上线反馈继续验证时。",
      caution: "若小步迁移会制造长期双轨成本，应重新评估。",
      evidenceSummary: "证据 1 显示小步上线降低了回归和返工风险。",
      confidence: "high" as const,
    },
    usage: { source: "runtime_measured" as const },
    providerDurationMs: 32,
  }));
  let sequence = 0;
  const service = new MethodologyService({
    repository,
    relationRepository,
    index: {
      findDecisions: (ids) =>
        ids
          .map((id) => decisions.find((decision) => decision.id === id))
          .filter((value): value is IndexedDecision => value !== undefined),
    },
    history: new MethodologyHistoryStore(join(vault, ".methodology-history")),
    gateway: { generate } as unknown as ProfiledModelGateway,
    now: () => new Date("2026-08-03T10:00:00.000Z"),
    idFactory: () => `generated-${sequence++}`,
  });
  return { generate, relationRepository, repository, service };
};

describe("MethodologyService", () => {
  it("generates a traceable candidate and clamps one-decision confidence", async () => {
    const { generate, repository, service } = await makeService([
      reviewedDecision(),
    ]);

    const record = await service.generate(["decision-1"]);

    expect(record).toMatchObject({
      status: "candidate",
      confidence: "low",
      sourceDecisionIds: ["decision-1"],
      generation: {
        requestId: "methodology:generated-0",
        profileId: "builtin-qwen",
      },
    });
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "methodology-extraction",
        promptVersion: "methodology-extraction-v1",
        maxOutputTokens: 768,
      }),
      expect.any(Function),
    );
    expect(await repository.find(record.id)).toEqual(record);

    await expect(service.generate(["decision-1"])).resolves.toEqual(record);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("creates a model-free manual candidate and lets evidence be linked later", async () => {
    const { generate, repository, service } = await makeService([
      reviewedDecision(),
    ]);
    const input = {
      title: "先写清边界，再决定自动化",
      principle: "先明确人工流程和失败边界，再评估是否值得自动化。",
      appliesWhen: "问题仍在变化，自动化接口尚不稳定时。",
      caution: "人工执行成本已经不可接受时应重新评估。",
    };

    const created = await service.createManual(input);

    expect(created).toMatchObject({
      origin: "manual_entry",
      status: "candidate",
      sourceDecisionIds: [],
      confidence: "low",
      ...input,
      generation: {
        requestId: "methodology-manual:generated-0",
        profileId: "manual-methodology-entry",
        provider: "人工录入",
        model: "不调用模型",
      },
    });
    expect(generate).not.toHaveBeenCalled();
    await expect(repository.find(created.id)).resolves.toEqual(created);
    await expect(service.createManual(input)).rejects.toThrow("内容相同");
    await expect(service.setStatus(created.id, "accepted")).rejects.toThrow(
      "尚未关联经过复盘的决策证据",
    );

    const linked = await service.setEvidence(created.id, ["decision-1"]);
    expect(linked.sourceDecisionIds).toEqual(["decision-1"]);
    await expect(
      service.setStatus(linked.id, "accepted"),
    ).resolves.toMatchObject({
      status: "accepted",
      confidence: "low",
    });
  });

  it("creates an evidence-backed manual candidate without invoking a model", async () => {
    const { generate, repository, service } = await makeService([
      reviewedDecision({ id: "decision-1", project: "alpha" }),
      reviewedDecision({
        id: "decision-2",
        project: "beta",
        sourceClient: "claude-code",
        outcomeVerdict: "better",
      }),
    ]);
    const input = {
      title: "先验证再扩大",
      principle: "先用可回退的小范围改动验证效果，再扩大实施范围。",
      appliesWhen: "方案仍有关键未知项并且可以分段实施时。",
      caution: "长期双轨成本高于验证收益时不应机械套用。",
      evidenceSummary:
        "证据 1 和证据 2 都观察到小范围验证减少了返工；跨项目一致性仍需继续观察。",
      sourceDecisionIds: ["decision-1", "decision-2"],
    };

    const created = await service.createManualFromEvidence(input);

    expect(created).toMatchObject({
      origin: "manual_entry",
      status: "candidate",
      confidence: "medium",
      ...input,
      generation: {
        requestId: "methodology-manual-evidence:generated-0",
        profileId: "manual-evidence-methodology",
        provider: "人工整理",
        model: "不调用模型",
      },
    });
    expect(generate).not.toHaveBeenCalled();
    await expect(repository.find(created.id)).resolves.toEqual(created);
    await expect(service.createManualFromEvidence(input)).rejects.toThrow(
      "这组复盘证据已经用于候选",
    );
  });

  it("persists an explicit usage-validation cursor without making practice sources stale", async () => {
    const { repository, service } = await makeService([
      reviewedDecision({ id: "decision-1" }),
      reviewedDecision({
        id: "decision-usage-2",
        outcomeReviewedAt: "2026-08-03T09:00:00.000Z",
        appliedPrincipleIds: ["principle-generated-1"],
      }),
    ]);
    const candidate = await service.generate(["decision-1"]);
    const accepted = await service.setStatus(candidate.id, "accepted");
    expect(accepted.id).toBe("principle-generated-1");

    const validated = await service.acknowledgeUsageValidation(accepted.id, {
      reviewedAt: "2026-08-03T09:00:00.000Z",
      decisionId: "decision-usage-2",
    });

    expect(validated.updatedAt).toBe(accepted.updatedAt);
    expect(validated.usageValidation).toEqual({
      reviewedAt: "2026-08-03T09:00:00.000Z",
      decisionId: "decision-usage-2",
      validatedAt: "2026-08-03T10:00:00.000Z",
    });
    await expect(repository.find(accepted.id)).resolves.toEqual(validated);
    await expect(
      service.acknowledgeUsageValidation(accepted.id, {
        reviewedAt: "2026-08-02T08:00:00.000Z",
        decisionId: "decision-1",
      }),
    ).rejects.toThrow("复验结果已经变化");
  });

  it("rejects incomplete evidence before creating a manual candidate", async () => {
    const { generate, service } = await makeService([
      reviewedDecision({ outcomeReviewedAt: null, outcomeVerdict: null }),
    ]);

    await expect(
      service.createManualFromEvidence({
        title: "先验证",
        principle: "先验证再扩大。",
        appliesWhen: "结果未知时。",
        caution: "成本过高时停止。",
        evidenceSummary: "人工归纳。",
        sourceDecisionIds: ["decision-1"],
      }),
    ).rejects.toThrow("完成实际结果与复盘");
    expect(generate).not.toHaveBeenCalled();
  });

  it("requires completed human review before invoking a model", async () => {
    const { generate, service } = await makeService([
      reviewedDecision({ outcomeVerdict: null, outcomeReviewedAt: null }),
    ]);

    await expect(service.generate(["decision-1"])).rejects.toThrow(
      "完成实际结果与复盘",
    );
    expect(generate).not.toHaveBeenCalled();
  });

  it("derives high confidence only from consistent cross-project evidence", async () => {
    const { service } = await makeService([
      reviewedDecision({ id: "decision-1", project: "alpha" }),
      reviewedDecision({
        id: "decision-2",
        project: "alpha",
        sourceClient: "claude-code",
        outcomeVerdict: "better",
      }),
      reviewedDecision({
        id: "decision-3",
        project: "beta",
        outcomeVerdict: "as_expected",
      }),
    ]);

    const record = await service.generate([
      "decision-1",
      "decision-2",
      "decision-3",
    ]);

    expect(record.confidence).toBe("high");
  });

  it("turns an unavailable generation route into an actionable message", async () => {
    const { generate, service } = await makeService([reviewedDecision()]);
    generate.mockRejectedValueOnce(
      new ProfiledModelGatewayError("No configured provider could generate"),
    );

    await expect(service.generate(["decision-1"])).rejects.toThrow(
      "请先在“模型”中启用并确认 Qwen、API 或终端模型可用",
    );
  });

  it("preserves evidence and generation metadata across revision and acceptance", async () => {
    const { service } = await makeService([reviewedDecision()]);
    const created = await service.generate(["decision-1"]);
    const revised = await service.revise(created.id, {
      title: "小步验证后再扩大",
      principle: "先完成一段可回退的验证，再扩大实施范围。",
      appliesWhen: "需求、性能或用户反馈仍有关键未知项时。",
      caution: "已存在硬截止时间时，需要同时评估切换成本。",
      evidenceSummary: "证据 1 支持先验证再扩大的做法。",
    });
    const accepted = await service.setStatus(revised.id, "accepted");

    expect(accepted).toMatchObject({
      status: "accepted",
      confirmedAt: "2026-08-03T10:00:00.000Z",
      sourceDecisionIds: created.sourceDecisionIds,
      generation: created.generation,
      title: "小步验证后再扩大",
    });
    await expect(service.list("accepted")).resolves.toEqual([accepted]);
  });

  it("applies a reviewed evolution draft to the stable accepted principle and preserves history", async () => {
    const decisions = [reviewedDecision()];
    const { generate, repository, service } = await makeService(decisions);
    const originalCandidate = await service.generate(["decision-1"]);
    const original = await service.setStatus(originalCandidate.id, "accepted");
    const downstreamAsset: PracticeAssetRecord = {
      id: "workflow-stable",
      slug: "workflow-stable",
      kind: "workflow",
      status: "accepted",
      createdAt: original.confirmedAt!,
      updatedAt: original.confirmedAt!,
      acceptedAt: original.confirmedAt,
      title: "验证后扩大",
      summary: "把原则落成可执行流程。",
      trigger: original.appliesWhen,
      steps: ["验证边界。", "扩大范围。"],
      checks: ["回退路径可用。"],
      fallback: original.caution,
      sourcePrincipleIds: [original.id],
      sourceSnapshots: [
        {
          id: original.id,
          updatedAt: original.updatedAt,
          title: original.title,
          principle: original.principle,
          appliesWhen: original.appliesWhen,
          caution: original.caution,
          confidence: original.confidence,
        },
      ],
      generation: {
        requestId: "workflow:stable",
        profileId: "manual-practice-asset",
        provider: "人工创建",
        model: "不调用模型",
      },
    };
    decisions.push(
      reviewedDecision({
        id: "decision-2",
        project: "beta",
        question: "扩展后如何收紧边界？",
        outcome: "复盘发现需要增加停止条件。",
        outcomeVerdict: "mixed",
        outcomeLesson: "不可逆步骤前必须重新确认。",
        appliedPrincipleIds: [original.id],
      }),
    );

    const revision = await service.createRevisionDraft(original.id, {
      title: "小步验证，并在不可逆步骤前停下",
      principle: "先完成可回退验证；进入不可逆步骤前重新核对证据。",
      appliesWhen: "方案仍有未知项，且后续步骤会扩大影响范围时。",
      caution: "硬截止时间不应成为跳过停止条件的理由。",
      evidenceSummary:
        "证据 1 支持小步验证；证据 2 补充了不可逆步骤前的停止条件。",
      sourceDecisionIds: ["decision-1", "decision-2"],
    });

    expect(revision).toMatchObject({
      origin: "principle_revision",
      status: "candidate",
      sourcePrincipleIds: [original.id],
      sourceDecisionIds: ["decision-1", "decision-2"],
      generation: {
        provider: "人工修订",
        model: "不调用模型",
      },
    });
    expect(generate).toHaveBeenCalledTimes(1);
    await expect(
      service.revise(original.id, {
        title: original.title,
        principle: original.principle,
        appliesWhen: original.appliesWhen,
        caution: original.caution,
        evidenceSummary: original.evidenceSummary,
      }),
    ).rejects.toThrow("已采纳原则请建立修订草案");

    await expect(service.setStatus(revision.id, "accepted")).rejects.toThrow(
      "核对差异并明确确认",
    );
    const applied = await service.setStatus(revision.id, "accepted", {
      acknowledgeQualityRisks: true,
    });
    expect(applied).toMatchObject({
      id: original.id,
      status: "accepted",
      title: "小步验证，并在不可逆步骤前停下",
      sourceDecisionIds: ["decision-1", "decision-2"],
      generation: revision.generation,
    });
    expect(
      assessPracticeAssetFreshness(downstreamAsset, [applied]),
    ).toMatchObject({ state: "sources_updated" });
    await expect(repository.find(revision.id)).resolves.toMatchObject({
      status: "dismissed",
      appliedAt: "2026-08-03T10:00:00.000Z",
      appliedToId: original.id,
    });
    await expect(service.list("dismissed")).resolves.not.toContainEqual(
      expect.objectContaining({ id: revision.id }),
    );
    const versions = await service.listHistory(original.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      version: 1,
      reason: "revision_applied",
      snapshot: { id: original.id, title: original.title },
    });

    const restored = await service.restoreVersion(original.id, 1);
    expect(restored).toMatchObject({
      id: original.id,
      status: "accepted",
      title: original.title,
      sourceDecisionIds: ["decision-1"],
    });
    await expect(service.listHistory(original.id)).resolves.toHaveLength(2);
  });

  it("requires at least one reviewed adoption record in an evolution draft", async () => {
    const decisions = [
      reviewedDecision(),
      reviewedDecision({ id: "decision-unrelated" }),
    ];
    const { service } = await makeService(decisions);
    const candidate = await service.generate(["decision-1"]);
    const accepted = await service.setStatus(candidate.id, "accepted");

    await expect(
      service.createRevisionDraft(accepted.id, {
        title: accepted.title,
        principle: accepted.principle,
        appliesWhen: accepted.appliesWhen,
        caution: accepted.caution,
        evidenceSummary: accepted.evidenceSummary,
        sourceDecisionIds: ["decision-1", "decision-unrelated"],
      }),
    ).rejects.toThrow("必须明确记录采用了这条原则");
  });

  it("requires explicit acknowledgement before accepting a similar principle", async () => {
    const { service } = await makeService([
      reviewedDecision({ id: "decision-1", project: "alpha" }),
      reviewedDecision({ id: "decision-2", project: "beta" }),
    ]);
    const accepted = await service.generate(["decision-1"]);
    await service.setStatus(accepted.id, "accepted");
    const similar = await service.generate(["decision-2"]);

    await expect(service.setStatus(similar.id, "accepted")).rejects.toThrow(
      "相近原则或潜在冲突",
    );
    await expect(
      service.setStatus(similar.id, "accepted", {
        acknowledgeQualityRisks: true,
      }),
    ).resolves.toMatchObject({
      id: similar.id,
      status: "accepted",
      confidence: "low",
    });
  });

  it("does not accept a principle after its source evidence disappears", async () => {
    const decisions = [reviewedDecision()];
    const { service } = await makeService(decisions);
    const candidate = await service.generate(["decision-1"]);
    decisions.length = 0;

    await expect(service.setStatus(candidate.id, "accepted")).rejects.toThrow(
      "来源证据不完整",
    );
  });

  it("imports Markdown as a low-confidence candidate requiring explicit acknowledgement", async () => {
    const { repository, service } = await makeService([]);

    const report = await service.importMarkdown([
      {
        fileName: "reversible.md",
        markdown: `# 先验证再扩大

## 原则
先验证关键假设，再扩大范围。

## 适用条件
结果仍有关键未知项时。

## 注意事项
双轨成本过高时重新评估。`,
      },
    ]);

    expect(report.failures).toEqual([]);
    expect(report.imported).toHaveLength(1);
    const imported = report.imported[0]!;
    expect(imported).toMatchObject({
      origin: "markdown_import",
      status: "candidate",
      confidence: "low",
      sourceDecisionIds: [],
      generation: {
        profileId: "local-markdown-import",
        provider: "本地导入",
        model: "Markdown",
      },
    });
    await expect(service.setStatus(imported.id, "accepted")).rejects.toThrow(
      "尚未关联经过复盘的决策证据",
    );
    await expect(
      service.setStatus(imported.id, "accepted", {
        acknowledgeQualityRisks: true,
      }),
    ).resolves.toMatchObject({ status: "accepted", confidence: "low" });
    await expect(repository.find(imported.id)).resolves.toMatchObject({
      origin: "markdown_import",
    });
  });

  it("previews without writing, flags same-principle candidates, and commits only the selection", async () => {
    const { repository, service } = await makeService([]);
    await service.importMarkdown([
      {
        fileName: "existing.md",
        markdown: `# 已有原则\n\n## 原则\n先验证关键假设。\n\n## 适用条件\n上线风险未知时。\n\n## 注意事项\n验证不足时不要扩大。`,
      },
    ]);
    const source = {
      fileName: "团队手册.md",
      markdown: `# 团队手册\n\n## 1. 相近表达\n### 原则\n先验证关键假设。\n### 适用条件\n需求边界不稳定时。\n### 注意事项\n验证成本过高时重新评估。\n\n## 2. 新原则\n### 原则\n保留明确的回退路径。\n### 适用条件\n变更可以分阶段发布时。\n### 注意事项\n双轨运行需要设置截止时间。`,
    };

    const preview = await service.previewMarkdown([source]);

    expect(preview.failures).toEqual([]);
    expect(preview.candidates).toHaveLength(2);
    expect(preview.candidates[0]).toMatchObject({
      title: "相近表达",
      fileName: "团队手册.md",
      similarTo: { title: "已有原则", status: "candidate" },
    });
    expect(preview.candidates[1]).toMatchObject({
      title: "新原则",
      similarTo: null,
      missingFields: [],
    });
    await expect(repository.list()).resolves.toHaveLength(1);

    const report = await service.importMarkdownCandidates(preview.candidates, [
      preview.candidates[1]!.id,
    ]);

    expect(report.imported).toHaveLength(1);
    expect(report.imported[0]).toMatchObject({
      title: "新原则",
      importSource: { fileName: "团队手册.md" },
    });
    expect(report.imported[0]?.importSource?.contentSha256).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    await expect(repository.list()).resolves.toHaveLength(2);
  });

  it("skips duplicate imports and reports invalid files without discarding valid ones", async () => {
    const { service } = await makeService([]);
    const valid = {
      fileName: "first.md",
      markdown: "# 可逆变更\n\n## 原则\n\n先保留回退路径。",
    };
    await service.importMarkdown([valid]);

    const report = await service.importMarkdown([
      { ...valid, fileName: "duplicate.md" },
      { fileName: "empty.md", markdown: "" },
      {
        fileName: "second.md",
        markdown: "# 小步发布\n\n## 原则\n\n逐步扩大范围。",
      },
    ]);

    expect(report.duplicates).toEqual([
      {
        fileName: "duplicate.md",
        title: "可逆变更",
        existingTitle: "可逆变更",
      },
    ]);
    expect(report.failures).toEqual([
      expect.objectContaining({
        fileName: "empty.md",
        message: "文件内容为空。",
      }),
    ]);
    expect(report.imported).toHaveLength(1);
    expect(report.imported[0]?.title).toBe("小步发布");
    await expect(
      service.setStatus(report.imported[0]!.id, "accepted", {
        acknowledgeQualityRisks: true,
      }),
    ).rejects.toThrow("先补充导入候选的适用条件与注意事项");
  });

  it("persists every principle split from a structured handbook", async () => {
    const { service } = await makeService([]);

    const report = await service.importMarkdown([
      {
        fileName: "handbook.md",
        markdown: `# 团队方法论

## 1. 先验证
### 原则
先验证关键假设。
### 适用条件
结果仍未知时。
### 注意事项
验证样本不足时继续观察。

## 2. 可回退
### 原则
变更前保留回退路径。
### 适用条件
可以分阶段部署时。
### 注意事项
双轨成本过高时设置期限。`,
      },
    ]);

    expect(report.failures).toEqual([]);
    expect(report.imported.map((record) => record.title)).toEqual([
      "先验证",
      "可回退",
    ]);
    await expect(service.list("candidate")).resolves.toHaveLength(2);
  });

  it("does not let duplicate drafts consume the per-operation import limit", async () => {
    const { service } = await makeService([]);
    const handbook = (fileIndex: number) => ({
      fileName: `handbook-${fileIndex}.md`,
      markdown: [
        `# 手册 ${fileIndex}`,
        ...Array.from({ length: 12 }, (_, itemIndex) => {
          const sequence = fileIndex * 12 + itemIndex + 1;
          return `## ${sequence}. 原则 ${sequence}\n### 原则\n先验证假设 ${sequence}。\n### 适用条件\n结果 ${sequence} 仍未知时。\n### 注意事项\n样本 ${sequence} 不足时继续观察。`;
        }),
      ].join("\n\n"),
    });
    const first = handbook(0);

    const report = await service.importMarkdown([
      first,
      handbook(1),
      handbook(2),
      handbook(3),
      handbook(4),
      {
        fileName: "duplicate.md",
        markdown: `# 原则 1\n\n## 原则\n先验证假设 1。\n\n## 适用条件\n结果 1 仍未知时。\n\n## 注意事项\n样本 1 不足时继续观察。`,
      },
    ]);

    expect(report.imported).toHaveLength(60);
    expect(report.duplicates).toEqual([
      {
        fileName: "duplicate.md",
        title: "原则 1",
        existingTitle: "1. 原则 1",
      },
    ]);
    expect(report.failures).toEqual([]);
  });

  it("links reviewed decisions to an imported candidate and refreshes confidence", async () => {
    const { service } = await makeService([
      reviewedDecision({ id: "decision-1", project: "alpha" }),
      reviewedDecision({
        id: "decision-2",
        project: "alpha",
        sourceClient: "claude-code",
        outcomeVerdict: "better",
      }),
      reviewedDecision({
        id: "decision-3",
        project: "beta",
        outcomeVerdict: "as_expected",
      }),
    ]);
    const imported = (
      await service.importMarkdown([
        {
          fileName: "principle.md",
          markdown: `# 先验证再扩大

## 原则
先验证关键假设，再扩大范围。
## 适用条件
结果仍未知时。
## 注意事项
验证样本不足时继续观察。`,
        },
      ])
    ).imported[0]!;

    const linked = await service.setEvidence(imported.id, [
      "decision-1",
      "decision-2",
      "decision-3",
    ]);

    expect(linked).toMatchObject({
      origin: "markdown_import",
      sourceDecisionIds: ["decision-1", "decision-2", "decision-3"],
      confidence: "high",
    });
    await expect(
      service.setStatus(linked.id, "accepted"),
    ).resolves.toMatchObject({
      status: "accepted",
      confidence: "high",
    });
  });

  it("does not rewrite the lineage of generated principles", async () => {
    const { service } = await makeService([
      reviewedDecision({ id: "decision-1" }),
      reviewedDecision({ id: "decision-2" }),
    ]);
    const generated = await service.generate(["decision-1"]);

    await expect(
      service.setEvidence(generated.id, ["decision-2"]),
    ).rejects.toThrow("只有 Markdown 导入或人工录入的原则");
  });

  it("rejects incomplete decisions when linking imported evidence", async () => {
    const { service } = await makeService([
      reviewedDecision({
        id: "decision-1",
        outcomeVerdict: null,
        outcomeReviewedAt: null,
      }),
    ]);
    const imported = (
      await service.importMarkdown([
        { fileName: "principle.md", markdown: "先验证再扩大。" },
      ])
    ).imported[0]!;

    await expect(
      service.setEvidence(imported.id, ["decision-1"]),
    ).rejects.toThrow("完成实际结果与复盘");
  });

  it("persists one symmetric human relationship and lets unrelated clear the warning", async () => {
    const { relationRepository, service } = await makeService([
      reviewedDecision({ id: "decision-1", project: "alpha" }),
      reviewedDecision({ id: "decision-2", project: "beta" }),
    ]);
    const first = await service.generate(["decision-1"]);
    const second = await service.generate(["decision-2"]);

    await service.setRelation(
      second.id,
      first.id,
      "duplicate",
      "两条原则约束相同的发布动作。",
    );
    await expect(service.setStatus(first.id, "accepted")).rejects.toThrow(
      "相近原则或潜在冲突",
    );
    await service.setRelation(
      first.id,
      second.id,
      "unrelated",
      "一个约束发布范围，另一个约束迁移时机。",
    );

    await expect(relationRepository.list()).resolves.toEqual([
      expect.objectContaining({
        principleIds: [first.id, second.id].sort(),
        disposition: "unrelated",
        note: "一个约束发布范围，另一个约束迁移时机。",
      }),
    ]);
    await expect(
      service.setStatus(first.id, "accepted"),
    ).resolves.toMatchObject({
      id: first.id,
      status: "accepted",
    });
  });

  it("can revoke a human relationship so deterministic quality checks apply again", async () => {
    const { relationRepository, service } = await makeService([
      reviewedDecision({ id: "decision-1" }),
      reviewedDecision({ id: "decision-2" }),
    ]);
    const first = await service.generate(["decision-1"]);
    const second = await service.generate(["decision-2"]);
    await service.setRelation(first.id, second.id, "unrelated", null);

    await service.clearRelation(second.id, first.id);

    await expect(relationRepository.list()).resolves.toEqual([]);
    await expect(service.setStatus(first.id, "accepted")).rejects.toThrow(
      "相近原则或潜在冲突",
    );
  });

  it("creates a traceable manual merge candidate without changing its sources", async () => {
    const { generate, repository, service } = await makeService([
      reviewedDecision({ id: "decision-1", project: "alpha" }),
      reviewedDecision({ id: "decision-2", project: "beta" }),
    ]);
    const first = await service.generate(["decision-1"]);
    await service.setStatus(first.id, "accepted");
    const second = await service.generate(["decision-2"]);
    await service.setRelation(
      first.id,
      second.id,
      "duplicate",
      "表达同一规则。",
    );
    await service.setStatus(second.id, "accepted", {
      acknowledgeQualityRisks: true,
    });

    const merged = await service.createMergeDraft([first.id, second.id], {
      title: "先验证再扩大",
      principle: "先验证一段可回退路径，再扩大不可逆投入。",
      appliesWhen: "关键结果仍需真实反馈验证时。",
      caution: "双轨成本高于验证收益时重新评估。",
      evidenceSummary: "保留来源原则 A 与 B 的两条复盘证据。",
      sourceDecisionIds: ["decision-1", "decision-2"],
    });

    expect(merged).toMatchObject({
      origin: "principle_merge",
      status: "candidate",
      sourcePrincipleIds: [first.id, second.id].sort(),
      sourceDecisionIds: ["decision-1", "decision-2"],
      generation: {
        profileId: "manual-principle-merge",
        provider: "人工合并",
        model: "不调用模型",
      },
    });
    expect(generate).toHaveBeenCalledTimes(2);
    expect((await repository.find(first.id))?.status).toBe("accepted");
    expect((await repository.find(second.id))?.status).toBe("accepted");
    await expect(
      service.setStatus(merged.id, "accepted", {
        acknowledgeQualityRisks: true,
      }),
    ).resolves.toMatchObject({ status: "accepted" });
  });

  it("rejects merge evidence outside the sources and rechecks the duplicate fact on acceptance", async () => {
    const { service } = await makeService([
      reviewedDecision({ id: "decision-1" }),
      reviewedDecision({ id: "decision-2" }),
      reviewedDecision({ id: "decision-3" }),
    ]);
    const first = await service.generate(["decision-1"]);
    await service.setStatus(first.id, "accepted");
    const second = await service.generate(["decision-2"]);
    await service.setRelation(first.id, second.id, "duplicate", null);
    await service.setStatus(second.id, "accepted", {
      acknowledgeQualityRisks: true,
    });
    const input = {
      title: "合并原则",
      principle: "先验证再扩大。",
      appliesWhen: "关键结果未知时。",
      caution: "验证无法覆盖风险时不适用。",
      evidenceSummary: "保留来源原则证据。",
      sourceDecisionIds: ["decision-1", "decision-2"],
    };

    await expect(
      service.createMergeDraft([first.id, second.id], {
        ...input,
        sourceDecisionIds: ["decision-3"],
      }),
    ).rejects.toThrow("只能保留来源原则已有的复盘证据");
    const merged = await service.createMergeDraft([first.id, second.id], input);
    await service.setRelation(first.id, second.id, "unrelated", null);

    await expect(
      service.setStatus(merged.id, "accepted", {
        acknowledgeQualityRisks: true,
      }),
    ).rejects.toThrow("合并来源已变化");
  });

  it("requires complete pairwise confirmation for a three-principle merge", async () => {
    const { service } = await makeService([
      reviewedDecision({ id: "decision-1", project: "alpha" }),
      reviewedDecision({ id: "decision-2", project: "beta" }),
      reviewedDecision({ id: "decision-3", project: "gamma" }),
    ]);
    const first = await service.generate(["decision-1"]);
    await service.setStatus(first.id, "accepted");
    const second = await service.generate(["decision-2"]);
    await service.setRelation(first.id, second.id, "duplicate", null);
    await service.setStatus(second.id, "accepted", {
      acknowledgeQualityRisks: true,
    });
    const third = await service.generate(["decision-3"]);
    await service.setRelation(second.id, third.id, "duplicate", null);
    await service.setStatus(third.id, "accepted", {
      acknowledgeQualityRisks: true,
    });
    const input = {
      title: "三项统一原则",
      principle: "先验证关键边界，再逐步扩大范围。",
      appliesWhen: "存在多个表达相近的已验证原则时。",
      caution: "任一来源边界不同则不应合并。",
      evidenceSummary: "保留三条来源的复盘证据。",
      sourceDecisionIds: ["decision-1", "decision-2", "decision-3"],
    };

    await expect(
      service.createMergeDraft([first.id, second.id, third.id], input),
    ).rejects.toThrow("还缺少 1 对人工重复结论");
    await service.setRelation(first.id, third.id, "duplicate", null);
    const merged = await service.createMergeDraft(
      [first.id, second.id, third.id],
      input,
    );

    expect(merged.sourcePrincipleIds).toEqual(
      [first.id, second.id, third.id].sort(),
    );
    await expect(
      service.setStatus(merged.id, "accepted", {
        acknowledgeQualityRisks: true,
      }),
    ).resolves.toMatchObject({ status: "accepted" });
  });
});
