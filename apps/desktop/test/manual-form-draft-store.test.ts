import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ManualFormDraftStore } from "../src/main/manual-form-draft-store.js";

describe("ManualFormDraftStore", () => {
  it("persists one bounded private draft for each manual workflow", async () => {
    const root = await mkdtemp(join(tmpdir(), "manual-form-drafts-"));
    const path = join(root, "drafts.json");
    const store = new ManualFormDraftStore(
      path,
      () => new Date("2026-08-08T12:00:00.000Z"),
    );

    await store.save({
      key: "methodology_manual",
      input: {
        title: "先验证",
        principle: "先做可逆验证",
        appliesWhen: "信息不足时",
        caution: "不要拖延必要行动",
      },
    });
    await store.save({
      key: "methodology_evidence_manual",
      input: {
        title: "复盘原则",
        principle: "从结果校准判断",
        appliesWhen: "存在完整复盘时",
        caution: "不要过度归因",
        evidenceSummary: "证据 1 显示小步验证有效",
        sourceDecisionIds: ["decision-private-1"],
      },
    });
    await store.save({
      key: "practice_asset_manual",
      practiceKind: "workflow",
      sourcePrincipleIds: ["principle-private-1"],
      input: {
        title: "验证流程",
        summary: "先验证关键假设",
        trigger: "投入不可逆之前",
        steps: ["写下假设"],
        checks: [],
        fallback: "回到人工判断",
      },
    });
    await store.save({
      key: "methodology_merge",
      sourcePrincipleIds: ["principle-private-1", "principle-private-2"],
      input: {
        title: "合并后的验证原则",
        principle: "先验证再扩大",
        appliesWhen: "关键结果未知时",
        caution: "验证不能覆盖主要风险时停止",
        evidenceSummary: "保留两条来源的复盘依据",
        sourceDecisionIds: ["decision-private-1"],
      },
    });
    await store.save({
      key: "methodology_revision",
      sourcePrincipleId: "principle-private-1",
      sourceUpdatedAt: "2026-08-07T12:00:00.000Z",
      sourceSnapshot: {
        title: "原验证原则",
        principle: "先验证再扩大",
        appliesWhen: "关键结果未知时",
        caution: "主要风险不可覆盖时停止",
        evidenceSummary: "原有复盘支持小步验证",
        sourceDecisionIds: ["decision-private-1"],
      },
      input: {
        title: "修订后的验证原则",
        principle: "先验证关键风险再扩大",
        appliesWhen: "出现新的采用后复盘时",
        caution: "保留原原则版本",
        evidenceSummary: "新增复盘要求收紧停止条件",
        sourceDecisionIds: ["decision-private-1"],
      },
    });

    const drafts = await new ManualFormDraftStore(path).list();
    expect(drafts).toHaveLength(5);
    expect(
      drafts.every(
        (draft) => draft.updatedAt === "2026-08-08T12:00:00.000Z",
      ),
    ).toBe(true);
    const written = join(root, "drafts.v2.json");
    expect((await stat(written)).mode & 0o777).toBe(0o600);
    expect(await readFile(written, "utf8")).toContain("decision-private-1");
    expect(await readFile(written, "utf8")).toContain("principle-private-2");
    expect(drafts).toContainEqual(
      expect.objectContaining({
        key: "methodology_revision",
        sourceSnapshot: expect.objectContaining({
          title: "原验证原则",
          sourceDecisionIds: ["decision-private-1"],
        }),
      }),
    );
  });

  it("keeps a practice draft with more lines than an asset takes, every draft at its fullest still readable", async () => {
    const root = await mkdtemp(join(tmpdir(), "manual-form-drafts-"));
    const store = new ManualFormDraftStore(join(root, "drafts.json"));
    const text = (length: number) => "验".repeat(length);
    const ids = Array.from({ length: 5 }, (_, index) => `${index}`.padEnd(200, "x"));
    const principle = { title: text(120), principle: text(2_000), appliesWhen: text(2_000), caution: text(2_000) };
    const withEvidence = { ...principle, evidenceSummary: text(3_000), sourceDecisionIds: ids };

    await store.save({ key: "methodology_manual", input: principle });
    await store.save({ key: "methodology_evidence_manual", input: withEvidence });
    await store.save({ key: "methodology_merge", sourcePrincipleIds: ids, input: withEvidence });
    await store.save({
      key: "methodology_revision",
      sourcePrincipleId: ids[0]!,
      sourceUpdatedAt: "2026-08-07T12:00:00.000Z",
      sourceSnapshot: withEvidence,
      input: withEvidence,
    });
    // Thirteen steps pasted in, past the twelve an asset takes, and a long line: still being written.
    await store.save({
      key: "practice_asset_manual",
      practiceKind: "skill",
      sourcePrincipleIds: ids,
      input: {
        title: text(120),
        summary: text(800),
        trigger: text(1_500),
        steps: Array.from({ length: 30 }, () => text(600)),
        checks: Array.from({ length: 20 }, () => text(600)),
        fallback: text(1_500),
      },
    });

    // All of it under the size the file is read back at.
    await expect(store.list()).resolves.toHaveLength(5);
  });

  it("replaces a draft by workflow and deletes it explicitly", async () => {
    const root = await mkdtemp(join(tmpdir(), "manual-form-drafts-"));
    const path = join(root, "drafts.json");
    const store = new ManualFormDraftStore(path);

    await store.save({
      key: "methodology_manual",
      input: { title: "一", principle: "", appliesWhen: "", caution: "" },
    });
    await store.save({
      key: "methodology_manual",
      input: { title: "二", principle: "", appliesWhen: "", caution: "" },
    });

    await expect(store.list()).resolves.toMatchObject([
      { key: "methodology_manual", input: { title: "二" } },
    ]);
    await store.delete("methodology_manual");
    await expect(store.list()).resolves.toEqual([]);
    await expect(store.delete("methodology_manual")).resolves.toBeUndefined();
  });

  it("bounds merge recovery drafts to two through five unique sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "manual-form-drafts-"));
    const store = new ManualFormDraftStore(join(root, "drafts.json"));
    const input = {
      title: "合并原则",
      principle: "先验证再扩大",
      appliesWhen: "结果未知时",
      caution: "风险不可覆盖时停止",
      evidenceSummary: "可稍后继续补充",
      sourceDecisionIds: [],
    };

    await expect(
      store.save({
        key: "methodology_merge",
        sourcePrincipleIds: ["principle-1"],
        input,
      }),
    ).rejects.toThrow();
    await expect(
      store.save({
        key: "methodology_merge",
        sourcePrincipleIds: ["principle-1", "principle-1"],
        input,
      }),
    ).rejects.toThrow("合并草稿来源不能重复");
    await expect(
      store.save({
        key: "methodology_merge",
        sourcePrincipleIds: ["principle-1", "principle-2"],
        input,
      }),
    ).resolves.toMatchObject({ key: "methodology_merge" });
  });

  it("bounds the optional revision source snapshot like a private revision draft", async () => {
    const root = await mkdtemp(join(tmpdir(), "manual-form-drafts-"));
    const store = new ManualFormDraftStore(join(root, "drafts.json"));
    const revision = {
      title: "修订原则",
      principle: "先验证关键风险再扩大",
      appliesWhen: "关键结果未知时",
      caution: "主要风险不可覆盖时停止",
      evidenceSummary: "新增复盘支持收紧边界",
      sourceDecisionIds: ["decision-1"],
    };

    await expect(
      store.save({
        key: "methodology_revision",
        sourcePrincipleId: "principle-1",
        sourceUpdatedAt: "2026-08-07T12:00:00.000Z",
        sourceSnapshot: {
          ...revision,
          title: "原原则",
        },
        input: revision,
      }),
    ).resolves.toMatchObject({
      key: "methodology_revision",
      sourceSnapshot: { title: "原原则" },
    });
    await expect(
      store.save({
        key: "methodology_revision",
        sourcePrincipleId: "principle-1",
        sourceUpdatedAt: "2026-08-07T12:00:00.000Z",
        sourceSnapshot: {
          ...revision,
          sourceDecisionIds: [
            "decision-1",
            "decision-2",
            "decision-3",
            "decision-4",
            "decision-5",
            "decision-6",
          ],
        },
        input: revision,
      }),
    ).rejects.toThrow();
  });

  it("keeps drafts past 1.1.0's limits out of 1.1.0's file, starting from what that file holds", async () => {
    const root = await mkdtemp(join(tmpdir(), "manual-form-drafts-"));
    const path = join(root, "drafts.json");
    // 1.1.0's drafts, as it wrote them.
    const earlier = `${JSON.stringify({
      version: 1,
      drafts: [{ key: "methodology_manual", input: { title: "写到一半", principle: "", appliesWhen: "", caution: "" }, updatedAt: "2026-08-01T12:00:00.000Z" }],
    }, null, 2)}\n`;
    await writeFile(path, earlier, "utf8");
    const store = new ManualFormDraftStore(path);
    await expect(store.list()).resolves.toMatchObject([{ key: "methodology_manual", input: { title: "写到一半" } }]);

    // Thirteen steps, one past what 1.1.0 takes: in its file, 1.1.0 called every form's draft corrupt.
    await store.save({
      key: "practice_asset_manual",
      practiceKind: "skill",
      sourcePrincipleIds: ["principle-1"],
      input: { title: "发布前检查", summary: "", trigger: "", steps: Array.from({ length: 13 }, (_, index) => `第 ${index + 1} 步`), checks: [], fallback: "" },
    });

    expect(await readFile(path, "utf8")).toBe(earlier);
    expect((await store.list()).map((draft) => draft.key)).toEqual(["methodology_manual", "practice_asset_manual"]);
  });

  it("takes a draft out of 1.1.0's file as well once this build ends or replaces it", async () => {
    const root = await mkdtemp(join(tmpdir(), "manual-form-drafts-"));
    const path = join(root, "drafts.json");
    // 1.1.0's drafts, as it wrote them: two forms half filled.
    await writeFile(path, `${JSON.stringify({
      version: 1,
      drafts: [
        { key: "methodology_manual", input: { title: "裁员名单的取舍", principle: "私密内容", appliesWhen: "", caution: "" }, updatedAt: "2026-08-01T12:00:00.000Z" },
        { key: "practice_asset_manual", practiceKind: "skill", sourcePrincipleIds: ["principle-1"], input: { title: "发布前检查", summary: "", trigger: "", steps: ["第 1 步"], checks: [], fallback: "" }, updatedAt: "2026-08-01T12:00:00.000Z" },
      ],
    }, null, 2)}\n`, "utf8");
    const store = new ManualFormDraftStore(path);

    // Submitted here: left in 1.1.0's file, its text stayed on disk, and 1.1.0 put it back in the form.
    await store.delete("methodology_manual");
    expect(await readFile(path, "utf8")).not.toContain("裁员名单的取舍");
    expect(await readFile(path, "utf8")).toContain("发布前检查");
    // Replaced here, past what 1.1.0 takes: 1.1.0's older one goes too.
    await store.save({
      key: "practice_asset_manual",
      practiceKind: "skill",
      sourcePrincipleIds: ["principle-1"],
      input: { title: "发布前检查", summary: "", trigger: "", steps: Array.from({ length: 13 }, (_, index) => `第 ${index + 1} 步`), checks: [], fallback: "" },
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, drafts: [] });
    expect((await store.list()).map((draft) => draft.key)).toEqual(["practice_asset_manual"]);
  });

  it("does not overwrite a corrupted draft file", async () => {
    const root = await mkdtemp(join(tmpdir(), "manual-form-drafts-"));
    const path = join(root, "drafts.json");
    const store = new ManualFormDraftStore(path);
    await writeFile(path, "not json", "utf8");

    await expect(
      store.save({
        key: "methodology_manual",
        input: { title: "一", principle: "", appliesWhen: "", caution: "" },
      }),
    ).rejects.toThrow("草稿损坏");
    await expect(readFile(path, "utf8")).resolves.toBe("not json");
  });
});
