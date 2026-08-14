import type { MethodologyRecord } from "@cognelis/decision-core";
import {
  MethodologyRepository,
  PracticeAssetRepository,
} from "@cognelis/decision-storage";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { ProfiledModelGateway } from "../src/main/model/profiled-model-gateway.js";
import { PracticeAssetService } from "../src/main/practice-asset-service.js";
import { PracticeAssetHistoryStore } from "../src/main/practice-asset-history-store.js";

const methodology = (
  overrides: Partial<MethodologyRecord> = {},
): MethodologyRecord => ({
  id: "principle-1",
  createdAt: "2026-08-01T08:00:00.000Z",
  updatedAt: "2026-08-02T08:00:00.000Z",
  origin: "decision_evidence",
  status: "accepted",
  confirmedAt: "2026-08-02T08:00:00.000Z",
  title: "先验证再扩大",
  principle: "先通过可回退的小步改动验证效果，再扩大范围。",
  appliesWhen: "需求或运行效果仍有关键未知项时。",
  caution: "小步迁移会制造长期双轨成本时需要重新评估。",
  evidenceSummary: "两条已复盘结果支持先验证再扩大的做法。",
  sourceDecisionIds: ["decision-1"],
  confidence: "medium",
  generation: {
    requestId: "methodology:request-1",
    profileId: "builtin-qwen",
    provider: "Qwen 本地模型",
    model: "qwen3.5-2b-q4-k-m",
  },
  ...overrides,
});

const makeService = async (principles: MethodologyRecord[]) => {
  const vault = await mkdtemp(join(tmpdir(), "practice-service-"));
  const methodologies = new MethodologyRepository(vault);
  const assets = new PracticeAssetRepository(vault);
  for (const principle of principles) await methodologies.save(principle);
  const generate = vi.fn(async (request) => ({
    requestId: request.requestId,
    attemptId: "attempt-1",
    profileId: "builtin-qwen",
    backend: "qwen" as const,
    provider: "Qwen 本地模型",
    model: "qwen3.5-2b-q4-k-m",
    visibleOutput: "{}",
    parsedOutput: {
      title: "可逆改动验证",
      summary: "用可回退的小步改动验证仍有未知项的实现方向。",
      trigger: "需求边界或实际效果仍需通过运行反馈确认时。",
      steps: [
        "明确本轮需要验证的一个关键假设。",
        "实施可独立回退的最小改动。",
        "记录结果后再决定是否扩大范围。",
      ],
      checks: ["改动能够独立回退。", "实际结果已经记录。"],
      fallback: "验证失败时回退本轮改动，并重新界定假设。",
    },
    usage: { source: "runtime_measured" as const },
    providerDurationMs: 40,
  }));
  let sequence = 0;
  let currentTime = "2026-08-03T10:00:00.000Z";
  const history = new PracticeAssetHistoryStore(join(vault, "history"));
  const service = new PracticeAssetService({
    methodologies,
    assets,
    history,
    gateway: { generate } as unknown as ProfiledModelGateway,
    now: () => new Date(currentTime),
    idFactory: () => `generated-${sequence++}`,
  });
  return {
    assets,
    generate,
    history,
    methodologies,
    service,
    setNow: (value: string) => {
      currentTime = value;
    },
  };
};

describe("PracticeAssetService", () => {
  it("generates one traceable skill draft from accepted principles", async () => {
    const { assets, generate, service } = await makeService([methodology()]);

    const record = await service.generate("skill", ["principle-1"]);

    expect(record).toMatchObject({
      id: "skill-generated-0",
      kind: "skill",
      status: "candidate",
      sourcePrincipleIds: ["principle-1"],
      generation: {
        requestId: "skill:generated-0",
        profileId: "builtin-qwen",
      },
    });
    expect(record.slug).toMatch(/^decision-skill-[a-f0-9]{12}$/u);
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "skill-drafting",
        promptVersion: "skill-drafting-v1",
        schemaVersion: "practice-asset-v1",
      }),
      expect.any(Function),
    );
    await expect(assets.find(record.id)).resolves.toEqual(record);
    await expect(service.generate("skill", ["principle-1"])).resolves.toEqual(
      record,
    );
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("creates a fully traceable manual draft without invoking a model", async () => {
    const { assets, generate, service } = await makeService([methodology()]);
    const input = {
      title: "人工复盘工作流",
      summary: "把已采纳原则整理成可人工执行的复盘流程。",
      trigger: "需要在没有可用生成模型时建立实践资产。",
      steps: ["核对来源原则。", "执行并记录实际结果。"],
      checks: ["每一步都有可观察结果。"],
      fallback: "来源或边界不清楚时停止执行并返回原则审核。",
    };

    const record = await service.createManual(
      "workflow",
      ["principle-1"],
      input,
    );

    expect(record).toMatchObject({
      kind: "workflow",
      status: "candidate",
      sourcePrincipleIds: ["principle-1"],
      ...input,
      generation: {
        requestId: "manual-workflow:generated-0",
        profileId: "manual-practice-asset",
        provider: "人工创建",
        model: "不调用模型",
      },
    });
    expect(record.sourceSnapshots).toHaveLength(1);
    expect(generate).not.toHaveBeenCalled();
    await expect(assets.find(record.id)).resolves.toEqual(record);
    await expect(
      service.createManual("workflow", ["principle-1"], input),
    ).rejects.toThrow("已经存在使用相同来源的工作流");
  });

  it("rejects incomplete manual drafts before writing anything", async () => {
    const { assets, generate, service } = await makeService([methodology()]);

    await expect(
      service.createManual("skill", ["principle-1"], {
        title: "未完成技能",
        summary: "内容尚不完整。",
        trigger: "需要测试时。",
        steps: ["只有一步。"],
        checks: [],
        fallback: "停止。",
      }),
    ).rejects.toThrow();

    expect(generate).not.toHaveBeenCalled();
    await expect(assets.list()).resolves.toEqual([]);
  });

  it("rejects candidate principles before invoking the model", async () => {
    const { generate, service } = await makeService([
      methodology({ status: "candidate", confirmedAt: null }),
    ]);

    await expect(service.generate("workflow", ["principle-1"])).rejects.toThrow(
      "只有已采纳",
    );
    expect(generate).not.toHaveBeenCalled();
  });

  it("preserves source and generation metadata across revision and acceptance", async () => {
    const { service } = await makeService([methodology()]);
    const created = await service.generate("workflow", ["principle-1"]);
    const revised = await service.revise(created.id, {
      title: "小步发布与验证",
      summary: "先验证一段可回退路径，再扩大实施范围。",
      trigger: created.trigger,
      steps: created.steps,
      checks: created.checks,
      fallback: created.fallback,
    });
    const accepted = await service.setStatus(revised.id, "accepted");

    expect(accepted).toMatchObject({
      kind: "workflow",
      status: "accepted",
      acceptedAt: "2026-08-03T10:00:00.000Z",
      title: "小步发布与验证",
      sourcePrincipleIds: created.sourcePrincipleIds,
      generation: created.generation,
    });
    await expect(service.list("accepted")).resolves.toEqual([accepted]);
  });

  it("blocks stale candidates until the user regenerates or explicitly edits them", async () => {
    const { methodologies, service, setNow } = await makeService([
      methodology(),
    ]);
    const created = await service.generate("skill", ["principle-1"]);
    await methodologies.save(
      methodology({ updatedAt: "2026-08-04T08:00:00.000Z" }),
    );

    await expect(service.setStatus(created.id, "accepted")).rejects.toThrow(
      "来源原则已更新",
    );
    setNow("2026-08-05T10:00:00.000Z");
    const reviewed = await service.revise(created.id, {
      title: created.title,
      summary: "已根据更新后的来源原则完成了人工校对。",
      trigger: created.trigger,
      steps: created.steps,
      checks: created.checks,
      fallback: created.fallback,
    });
    await expect(service.setStatus(reviewed.id, "accepted")).resolves.toMatchObject({
      status: "accepted",
      summary: "已根据更新后的来源原则完成了人工校对。",
    });
  });

  it("applies an accepted replacement draft back to the stable original asset", async () => {
    const { assets, methodologies, service, setNow } = await makeService([
      methodology(),
    ]);
    const original = await service.generate("workflow", ["principle-1"]);
    const acceptedOriginal = await service.setStatus(original.id, "accepted");
    await methodologies.save(
      methodology({
        updatedAt: "2026-08-04T08:00:00.000Z",
        principle: "先验证可逆路径，同时明确退出双轨状态的时点。",
      }),
    );
    setNow("2026-08-05T10:00:00.000Z");

    const replacement = await service.regenerate(acceptedOriginal.id);
    expect(replacement).toMatchObject({
      status: "candidate",
      supersedesId: acceptedOriginal.id,
      sourcePrincipleIds: acceptedOriginal.sourcePrincipleIds,
    });
    expect(replacement.id).not.toBe(acceptedOriginal.id);
    expect(replacement.slug).not.toBe(acceptedOriginal.slug);
    await service.revise(replacement.id, {
      title: replacement.title,
      summary: "加入明确退出双轨状态的检查。",
      trigger: replacement.trigger,
      steps: replacement.steps,
      checks: replacement.checks,
      fallback: replacement.fallback,
    });

    const applied = await service.setStatus(replacement.id, "accepted");
    expect(applied).toMatchObject({
      id: acceptedOriginal.id,
      slug: acceptedOriginal.slug,
      status: "accepted",
      acceptedAt: acceptedOriginal.acceptedAt,
      summary: "加入明确退出双轨状态的检查。",
      generation: replacement.generation,
    });
    await expect(assets.find(replacement.id)).resolves.toMatchObject({
      status: "dismissed",
      supersedesId: acceptedOriginal.id,
    });
    await expect(service.listVersions(acceptedOriginal.id)).resolves.toMatchObject([
      {
        version: 1,
        reason: "replacement_applied",
        snapshot: { id: acceptedOriginal.id, summary: acceptedOriginal.summary },
      },
    ]);
  });

  it("prepares and explicitly applies a replacement with migrated principle sources", async () => {
    const originalSource = methodology({ id: "principle-source" });
    const mergedSource = methodology({
      id: "principle-merged",
      origin: "principle_merge",
      sourcePrincipleIds: ["principle-source", "principle-other"],
      title: "先验证关键路径",
      principle: "先验证统一后的可回退路径，再扩大范围。",
    });
    const { assets, history, service } = await makeService([
      originalSource,
      mergedSource,
    ]);
    const original = await service.generate("skill", [originalSource.id]);
    const accepted = await service.setStatus(original.id, "accepted");

    const replacement = await service.createSourceMigrationDraft(
      accepted.id,
      [mergedSource.id],
    );
    expect(replacement).toMatchObject({
      status: "candidate",
      supersedesId: accepted.id,
      sourcePrincipleIds: [mergedSource.id],
      migrationSourcePrincipleIds: [originalSource.id],
    });
    await expect(
      service.createSourceMigrationDraft(accepted.id, [mergedSource.id]),
    ).resolves.toEqual(replacement);

    const applied = await service.setStatus(replacement.id, "accepted");
    expect(applied).toMatchObject({
      id: accepted.id,
      status: "accepted",
      sourcePrincipleIds: [mergedSource.id],
    });
    expect(applied).not.toHaveProperty("migrationSourcePrincipleIds");
    await expect(assets.find(replacement.id)).resolves.toMatchObject({
      status: "dismissed",
      migrationSourcePrincipleIds: [originalSource.id],
    });
    await expect(history.list(accepted.id)).resolves.toMatchObject([
      {
        reason: "replacement_applied",
        snapshot: { sourcePrincipleIds: [originalSource.id] },
      },
    ]);
  });

  it("migrates an unaccepted practice draft without creating a replacement application", async () => {
    const originalSource = methodology({ id: "principle-source" });
    const mergedSource = methodology({
      id: "principle-merged",
      origin: "principle_merge",
      sourcePrincipleIds: ["principle-source", "principle-other"],
    });
    const { assets, service } = await makeService([
      originalSource,
      mergedSource,
    ]);
    const original = await service.generate("workflow", [originalSource.id]);

    const migrated = await service.createSourceMigrationDraft(original.id, [
      mergedSource.id,
    ]);

    expect(migrated).toMatchObject({
      status: "candidate",
      sourcePrincipleIds: [mergedSource.id],
    });
    expect(migrated).not.toHaveProperty("supersedesId");
    await expect(assets.find(original.id)).resolves.toMatchObject({
      status: "dismissed",
    });
  });

  it("keeps accepted edits as restorable versions and checkpoints before restore", async () => {
    const { service, setNow } = await makeService([methodology()]);
    const candidate = await service.generate("skill", ["principle-1"]);
    const accepted = await service.setStatus(candidate.id, "accepted");
    setNow("2026-08-04T10:00:00.000Z");
    const second = await service.revise(accepted.id, {
      title: accepted.title,
      summary: "第二版内容。",
      trigger: accepted.trigger,
      steps: accepted.steps,
      checks: accepted.checks,
      fallback: accepted.fallback,
    });
    setNow("2026-08-05T10:00:00.000Z");
    const third = await service.revise(second.id, {
      title: second.title,
      summary: "第三版内容。",
      trigger: second.trigger,
      steps: second.steps,
      checks: second.checks,
      fallback: second.fallback,
    });

    expect(await service.listVersions(accepted.id)).toMatchObject([
      { version: 2, snapshot: { summary: "第二版内容。" } },
      { version: 1, snapshot: { summary: accepted.summary } },
    ]);
    setNow("2026-08-06T10:00:00.000Z");
    await expect(service.restoreVersion(third.id, 1)).resolves.toMatchObject({
      id: accepted.id,
      status: "accepted",
      summary: accepted.summary,
      updatedAt: "2026-08-06T10:00:00.000Z",
    });
    expect((await service.listVersions(accepted.id))[0]).toMatchObject({
      version: 3,
      reason: "restore_checkpoint",
      snapshot: { summary: "第三版内容。" },
    });
  });
});
