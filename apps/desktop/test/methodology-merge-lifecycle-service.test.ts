import type {
  MethodologyRecord,
  MethodologyRelationRecord,
  PracticeAssetRecord,
} from "@cognelis/decision-core";
import type { IndexedDecision } from "@cognelis/decision-storage";
import { describe, expect, it, vi } from "vitest";

import { MethodologyMergeLifecycleService } from "../src/main/methodology-merge-lifecycle-service.js";

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
  title: `原则 ${id}`,
  principle: "先验证可回退路径，再逐步扩大范围。",
  appliesWhen: "关键结果仍有未知项时。",
  caution: "双轨成本开始扩大时需要重新评估。",
  evidenceSummary: "已由完整复盘支持。",
  sourceDecisionIds: [`decision-${id}`],
  confidence: "medium",
  generation: {
    requestId: `methodology:${id}`,
    profileId: "builtin-qwen",
    provider: "Qwen 本地模型",
    model: "qwen3.5-2b-q4-k-m",
  },
  ...overrides,
});

const asset = (
  id: string,
  sourcePrincipleIds: string[],
  overrides: Partial<PracticeAssetRecord> = {},
): PracticeAssetRecord => ({
  id,
  slug: id,
  kind: "workflow",
  status: "accepted",
  createdAt: "2026-08-02T09:00:00.000Z",
  updatedAt: "2026-08-02T10:00:00.000Z",
  acceptedAt: "2026-08-02T10:00:00.000Z",
  title: `流程 ${id}`,
  summary: "把原则转化为可执行步骤。",
  trigger: "需要处理关键未知项时。",
  steps: ["明确假设。", "小步验证。"],
  checks: ["可以独立回退。"],
  fallback: "回退本轮改动。",
  sourcePrincipleIds,
  generation: {
    requestId: `workflow:${id}`,
    profileId: "builtin-qwen",
    provider: "Qwen 本地模型",
    model: "qwen3.5-2b-q4-k-m",
  },
  ...overrides,
});

const completeDuplicateRelations = (
  sourcePrincipleIds: string[],
): MethodologyRelationRecord[] =>
  sourcePrincipleIds.flatMap((firstId, firstIndex) =>
    sourcePrincipleIds.slice(firstIndex + 1).map((secondId) => ({
      id: `relation-${firstId}-${secondId}`,
      createdAt: "2026-08-03T08:00:00.000Z",
      updatedAt: "2026-08-03T08:00:00.000Z",
      principleIds: [firstId, secondId],
      principleTitles: [`原则 ${firstId}`, `原则 ${secondId}`],
      disposition: "duplicate" as const,
      note: "这组原则表达的是同一条可回退路径。",
    })),
  );

const makeService = (
  initialAssets: PracticeAssetRecord[],
  sourcePrincipleIds = ["source-a", "source-b"],
  decisions: IndexedDecision[] = [],
) => {
  const methodologies = new Map<string, MethodologyRecord>([
    ["source-a", principle("source-a")],
    ["source-b", principle("source-b")],
    ["source-c", principle("source-c")],
    [
      "merged",
      principle("merged", {
        origin: "principle_merge",
        sourceDecisionIds: sourcePrincipleIds.map((id) => `decision-${id}`),
        sourcePrincipleIds,
        title: "合并原则",
      }),
    ],
  ]);
  let assets = [...initialAssets];
  let failNextSaveForId: string | null = null;
  const createSourceMigrationDraft = vi.fn(async () =>
    asset("replacement", ["merged"], {
      status: "candidate",
      acceptedAt: null,
      supersedesId: "workflow-1",
      migrationSourcePrincipleIds: ["source-a", "source-b"],
    }),
  );
  const service = new MethodologyMergeLifecycleService({
    methodologies: {
      list: async () => [...methodologies.values()],
      save: async (record) => {
        if (record.id === failNextSaveForId) {
          failNextSaveForId = null;
          throw new Error(`write failed for ${record.id}`);
        }
        methodologies.set(record.id, structuredClone(record));
      },
    },
    relations: {
      list: async () => completeDuplicateRelations(sourcePrincipleIds),
    },
    assets: { list: async () => structuredClone(assets) },
    practiceAssets: { createSourceMigrationDraft },
    decisions: () => decisions,
    now: () => new Date("2026-08-06T12:00:00.000Z"),
  });
  return {
    createSourceMigrationDraft,
    methodologies,
    service,
    setAssets: (next: PracticeAssetRecord[]) => {
      assets = next;
    },
    failNextSave: (id: string) => {
      failNextSaveForId = id;
    },
  };
};

describe("MethodologyMergeLifecycleService", () => {
  it("previews preserved sources and creates only an explicit replacement draft", async () => {
    const original = asset("workflow-1", ["source-a", "source-c"]);
    const fixture = makeService([original]);

    const plan = await fixture.service.plan("merged");

    expect(plan).toMatchObject({
      relationValid: true,
      canRetire: false,
      modelCallsRequired: 1,
      pendingReviewCount: 0,
      assets: [
        {
          id: "workflow-1",
          sourcePrincipleIds: ["source-a", "source-c"],
          targetSourcePrincipleIds: ["source-c", "merged"],
          replacementId: null,
        },
      ],
    });
    expect(fixture.createSourceMigrationDraft).not.toHaveBeenCalled();

    await fixture.service.prepareAsset("merged", "workflow-1");

    expect(fixture.createSourceMigrationDraft).toHaveBeenCalledWith(
      "workflow-1",
      ["source-c", "merged"],
    );
  });

  it("keeps accepted assets unchanged until review, then archives and restores both sources", async () => {
    const original = asset("workflow-1", ["source-a", "source-b"]);
    const fixture = makeService([original]);

    await expect(fixture.service.retireSources("merged")).rejects.toThrow(
      "仍有技能或流程引用",
    );

    const replacement = asset("replacement", ["merged"], {
      status: "candidate",
      acceptedAt: null,
      supersedesId: original.id,
      migrationSourcePrincipleIds: ["source-a", "source-b"],
    });
    fixture.setAssets([original, replacement]);
    await expect(fixture.service.plan("merged")).resolves.toMatchObject({
      modelCallsRequired: 0,
      pendingReviewCount: 1,
      assets: [{ replacementId: replacement.id }],
    });
    await expect(fixture.service.retireSources("merged")).rejects.toThrow(
      "仍有技能或流程引用",
    );

    fixture.setAssets([
      asset("workflow-1", ["merged"]),
      { ...replacement, status: "dismissed" },
    ]);
    const retired = await fixture.service.retireSources("merged");

    expect(retired).toMatchObject({
      retired: true,
      canRetire: false,
      canRestore: true,
      assets: [],
    });
    expect(fixture.methodologies.get("source-a")).toMatchObject({
      status: "retired",
      retiredAt: "2026-08-06T12:00:00.000Z",
      supersededById: "merged",
    });
    expect(fixture.methodologies.get("source-b")).toMatchObject({
      status: "retired",
      supersededById: "merged",
    });

    const restored = await fixture.service.restoreSources("merged");

    expect(restored).toMatchObject({
      retired: false,
      canRestore: false,
    });
    expect(fixture.methodologies.get("source-a")).toMatchObject({
      status: "accepted",
    });
    expect(fixture.methodologies.get("source-a")).not.toHaveProperty(
      "retiredAt",
    );
    expect(fixture.methodologies.get("source-b")).not.toHaveProperty(
      "supersededById",
    );
  });

  it("migrates references and archives a complete three-principle group as one bounded batch", async () => {
    const sourceIds = ["source-a", "source-b", "source-c"];
    const original = asset("workflow-1", sourceIds);
    const fixture = makeService([original], sourceIds);

    await expect(fixture.service.plan("merged")).resolves.toMatchObject({
      relationValid: true,
      modelCallsRequired: 1,
      sources: sourceIds.map((id) => ({ id, status: "accepted" })),
      assets: [
        {
          sourcePrincipleIds: sourceIds,
          targetSourcePrincipleIds: ["merged"],
        },
      ],
    });

    fixture.setAssets([asset("workflow-1", ["merged"])]);
    const retired = await fixture.service.retireSources("merged");
    expect(retired).toMatchObject({ retired: true, canRestore: true });
    for (const id of sourceIds) {
      expect(fixture.methodologies.get(id)).toMatchObject({
        status: "retired",
        supersededById: "merged",
      });
    }

    await fixture.service.restoreSources("merged");
    for (const id of sourceIds) {
      expect(fixture.methodologies.get(id)).toMatchObject({
        status: "accepted",
      });
      expect(fixture.methodologies.get(id)).not.toHaveProperty("retiredAt");
    }
  });

  it("holds the sources back while one has reviews since adoption unchecked, or a revision draft waiting", async () => {
    // A decision that applied source-a after it was adopted, and went worse.
    const used = {
      id: "decision-used", project: "decision", question: "这次迁移也分步做吗？", selectedAnswer: "分步",
      appliedPrincipleIds: ["source-a"], outcomeVerdict: "worse", outcomeLesson: "双轨期太长时分步反而更贵。",
      outcomeReviewedAt: "2026-08-05T08:00:00.000Z",
    } as unknown as IndexedDecision;
    const fixture = makeService([], ["source-a", "source-b"], [used]);

    // Archived, the review left 复验收件箱 for good, never checked.
    const plan = await fixture.service.plan("merged");
    expect(plan.canRetire).toBe(false);
    expect(plan.blockers).toEqual(["「原则 source-a」有 1 条采用后的复盘还没复验，请先在方法论工作箱 › 原则复验里看过"]);
    await expect(fixture.service.retireSources("merged")).rejects.toThrow("还没复验");
    expect(fixture.methodologies.get("source-a")?.status).toBe("accepted");

    // Checked; a revision draft of source-b waits in 待确认, which archiving would strand for good.
    fixture.methodologies.set("source-a", principle("source-a", {
      usageValidation: { reviewedAt: "2026-08-05T08:00:00.000Z", decisionId: "decision-used", validatedAt: "2026-08-06T08:00:00.000Z" },
    }));
    fixture.methodologies.set("revision-b", principle("revision-b", { status: "candidate", confirmedAt: null, origin: "principle_revision", sourcePrincipleIds: ["source-b"] }));
    expect((await fixture.service.plan("merged")).blockers).toEqual(["「原则 source-b」有一份待确认的修订草稿，请先应用或放弃它"]);

    fixture.methodologies.delete("revision-b");
    await expect(fixture.service.retireSources("merged")).resolves.toMatchObject({ retired: true, blockers: [] });
  });

  it("restores every earlier source when a multi-source archive write fails", async () => {
    const sourceIds = ["source-a", "source-b", "source-c"];
    const fixture = makeService([], sourceIds);
    fixture.failNextSave("source-c");

    await expect(fixture.service.retireSources("merged")).rejects.toThrow(
      "write failed for source-c",
    );
    for (const id of sourceIds) {
      expect(fixture.methodologies.get(id)).toMatchObject({
        status: "accepted",
      });
      expect(fixture.methodologies.get(id)).not.toHaveProperty("retiredAt");
    }
  });
});
