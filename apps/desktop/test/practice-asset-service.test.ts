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
import { practiceAssetBasis } from "../src/shared/renderer-api.js";

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

  it("says an adopted asset of the same sources exists when asked to generate, as manual drafting does", async () => {
    const { generate, service } = await makeService([methodology()]);
    await service.setStatus((await service.generate("skill", ["principle-1"])).id, "accepted");

    // Returned as if just drafted: opened without a word, the list behind it switched to 待确认 where it is not.
    await expect(service.generate("skill", ["principle-1"])).rejects.toThrow("已经存在使用相同来源的技能");
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

  it("creates an asset with a long English title, its slug within 64 characters", async () => {
    const { service } = await makeService([methodology()]);
    const record = await service.createManual("skill", ["principle-1"], {
      title: "Handle optimistic UI updates with useOptimistic in React nineteen",
      summary: "用 useOptimistic 处理乐观更新。",
      trigger: "界面需要在请求返回前先显示结果时。",
      steps: ["先渲染乐观状态。", "请求返回后换成真实状态。"],
      checks: ["失败时能回到真实状态。"],
      fallback: "回退到等待请求完成再更新。",
    });
    expect(record.slug.length).toBeLessThanOrEqual(64);
  });

  it("keeps a regenerated replacement draft replacing its asset", async () => {
    const { methodologies, service, setNow } = await makeService([methodology()]);
    const accepted = await service.setStatus((await service.generate("workflow", ["principle-1"])).id, "accepted");
    await methodologies.save(methodology({ updatedAt: "2026-08-04T08:00:00.000Z", principle: "第二版：先验证，再明确退出双轨的时点。" }));
    setNow("2026-08-05T10:00:00.000Z");
    const replacement = await service.regenerate(accepted.id);
    // The principle moves on again before the replacement is taken: it is regenerated in its turn.
    await methodologies.save(methodology({ updatedAt: "2026-08-06T08:00:00.000Z", principle: "第三版：先验证，再限定双轨的期限。" }));
    setNow("2026-08-07T10:00:00.000Z");

    const again = await service.regenerate(replacement.id);

    expect(again.supersedesId).toBe(accepted.id);
  });

  it("adds no restore point for an asset saved as it was", async () => {
    const { service } = await makeService([methodology()]);
    const accepted = await service.setStatus((await service.generate("workflow", ["principle-1"])).id, "accepted");
    const draft = {
      title: accepted.title,
      summary: accepted.summary,
      trigger: accepted.trigger,
      steps: accepted.steps,
      checks: accepted.checks,
      fallback: accepted.fallback,
    };

    await expect(service.revise(accepted.id, draft)).resolves.toEqual(accepted);
    await expect(service.listVersions(accepted.id)).resolves.toEqual([]);
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

  it("adopts or dismisses drafts only, as the page offers", async () => {
    const { assets, service } = await makeService([methodology()]);
    const accepted = await service.setStatus((await service.generate("workflow", ["principle-1"])).id, "accepted");

    // Adopted: dismissed, its published skill stayed loaded in the clients with no way to withdraw it; adopted again,
    // its date moved and every client copy read as out of date.
    await expect(service.setStatus(accepted.id, "dismissed")).rejects.toThrow("已采纳的技能或工作流不能忽略");
    await expect(service.setStatus(accepted.id, "accepted")).rejects.toThrow("已经采纳");
    await expect(assets.find(accepted.id)).resolves.toMatchObject({ status: "accepted", acceptedAt: accepted.acceptedAt });

    const draft = await service.createManual("skill", ["principle-1"], {
      title: "另一份草案",
      summary: "先确认回退入口。",
      trigger: "扩大发布之前。",
      steps: ["确认回退入口。", "确认负责人。"],
      checks: ["回退入口可用。"],
      fallback: "回退入口不可用时停止。",
    });
    await service.setStatus(draft.id, "dismissed");
    // Dismissed: adopted past its review, which the page never offers.
    await expect(service.setStatus(draft.id, "accepted")).rejects.toThrow("已忽略的草案不能直接采纳");
    await expect(service.setStatus(draft.id, "dismissed")).rejects.toThrow("已经忽略");
  });

  it("dismisses a draft whose replacement was drafted as it now stands, keeping a step saved meanwhile", async () => {
    const { assets, generate, methodologies, service } = await makeService([methodology()]);
    const draft = await service.generate("skill", ["principle-1"]);
    await methodologies.save(methodology({ updatedAt: "2026-08-04T08:00:00.000Z", principle: "第二版：先验证，再扩大范围。" }));
    const drafting = generate.getMockImplementation()!;
    const edited = [...draft.steps, "读者在 Obsidian 里补充的一步。"];
    generate.mockImplementationOnce(async (request) => {
      // Saved in Obsidian while the model drafts the replacement.
      await assets.save({ ...(await assets.find(draft.id))!, steps: edited });
      return drafting(request);
    });

    await service.regenerate(draft.id);

    // Written back as read before the call, the draft lost the step without a word.
    await expect(assets.find(draft.id)).resolves.toMatchObject({ status: "dismissed", steps: edited });
  });

  it("refuses an edit begun before the asset was changed in Obsidian, rather than write its old steps back", async () => {
    const { assets, service } = await makeService([methodology()]);
    const accepted = await service.setStatus((await service.generate("workflow", ["principle-1"])).id, "accepted");
    const opened = practiceAssetBasis(accepted);
    // A step saved in Obsidian after the page opened the asset.
    const edited = [...accepted.steps, "读者在 Obsidian 里补充的一步。"];
    await assets.save({ ...accepted, steps: edited });
    const { title: _title, ...shown } = accepted;
    const form = { title: "新标题", summary: shown.summary, trigger: shown.trigger, steps: shown.steps, checks: shown.checks, fallback: shown.fallback };

    // Only the title meant to change: every field was written back as the page had it, the step gone.
    await expect(service.revise(accepted.id, form, opened)).rejects.toThrow("刚在 Obsidian 里被改过");
    await expect(assets.find(accepted.id)).resolves.toMatchObject({ title: accepted.title, steps: edited });
    // Opened again, the edit goes through.
    const reopened = (await assets.find(accepted.id))!;
    await expect(service.revise(accepted.id, { ...form, steps: edited }, practiceAssetBasis(reopened))).resolves.toMatchObject({ title: "新标题", steps: edited });
  });

  it("hands back each draft as the note holds it, so an edit begun from it is not refused as changed in Obsidian", async () => {
    const { service } = await makeService([methodology()]);
    // A double space and a tab in a step: the note keeps them as one space each.
    const created = await service.createManual("skill", ["principle-1"], {
      title: "手写技能", summary: "先确认回退入口。", trigger: "扩大发布之前。",
      steps: ["确认回退入口。", "确认  负责人。"], checks: ["回退入口可用。"], fallback: "回退入口不可用时停止。",
    });
    const form = (from: typeof created, title: string, steps = from.steps) =>
      ({ title, summary: from.summary, trigger: from.trigger, steps, checks: from.checks, fallback: from.fallback });

    // Handed back as built, its basis never matched the note: the first edit, nothing touched in Obsidian, refused.
    const renamed = await service.revise(created.id, form(created, "新标题", [...created.steps, "确认\t记录。"]), practiceAssetBasis(created));
    // And the next one too, from what that save handed back.
    await expect(service.revise(created.id, form(renamed, "再改标题"), practiceAssetBasis(renamed))).resolves.toMatchObject({ title: "再改标题" });
    const drafted = await service.generate("workflow", ["principle-1"]);
    await expect(service.revise(drafted.id, form(drafted, "生成后改标题"), practiceAssetBasis(drafted))).resolves.toMatchObject({ title: "生成后改标题" });
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

  it("restores an earlier wording without its sources once they were retired by a merge", async () => {
    const originalSource = methodology({ id: "principle-source" });
    const mergedSource = methodology({ id: "principle-merged", origin: "principle_merge", sourcePrincipleIds: ["principle-source", "principle-other"] });
    const { methodologies, service } = await makeService([originalSource, mergedSource]);
    const accepted = await service.setStatus((await service.generate("skill", [originalSource.id])).id, "accepted");
    await service.setStatus((await service.createSourceMigrationDraft(accepted.id, [mergedSource.id])).id, "accepted");
    // The merge's sources archived, as 整理来源 does once every reference has moved.
    await methodologies.save({ ...originalSource, status: "retired", retiredAt: "2026-08-04T10:00:00.000Z", supersededById: mergedSource.id });

    // Back on the retired principle, it could not be published, and the merge listed it to migrate again.
    await expect(service.restoreVersion(accepted.id, 1)).resolves.toMatchObject({
      summary: accepted.summary,
      sourcePrincipleIds: [mergedSource.id],
    });
  });

  it("sets aside a waiting replacement drafted from the sources an asset has since moved off", async () => {
    const originalSource = methodology({ id: "principle-source" });
    const mergedSource = methodology({ id: "principle-merged", origin: "principle_merge", sourcePrincipleIds: ["principle-source", "principle-other"] });
    const { assets, methodologies, service, setNow } = await makeService([originalSource, mergedSource]);
    const accepted = await service.setStatus((await service.generate("skill", [originalSource.id])).id, "accepted");
    // The source revised: a regenerated replacement waits, drafted from it.
    setNow("2026-08-04T10:00:00.000Z");
    await methodologies.save({ ...originalSource, principle: "先验证可回退路径，并记录回退条件。", updatedAt: "2026-08-04T10:00:00.000Z" });
    const waiting = await service.regenerate(accepted.id);
    // Then the asset moved to the merge.
    await service.setStatus((await service.createSourceMigrationDraft(accepted.id, [mergedSource.id])).id, "accepted");

    // Left waiting, it held the merge's sources back from archiving, and moving it paid a model call to fail.
    await expect(assets.find(waiting.id)).resolves.toMatchObject({ status: "dismissed" });
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
