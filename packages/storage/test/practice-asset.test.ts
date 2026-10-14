import type { PracticeAssetRecord } from "@cognelis/decision-core";
import { mkdir, mkdtemp, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  parsePracticeAsset,
  PracticeAssetRepository,
  publishedPracticeAsset,
  serializePracticeAsset,
} from "../src/index.js";

const fixture = (
  overrides: Partial<PracticeAssetRecord> = {},
): PracticeAssetRecord => ({
  id: "skill-018f",
  slug: "decision-reversible-change",
  kind: "skill",
  status: "candidate",
  createdAt: "2026-08-03T08:00:00.000Z",
  updatedAt: "2026-08-03T08:00:00.000Z",
  acceptedAt: null,
  title: "可逆改动验证",
  summary: "用小步、可回退的改动验证仍有未知项的实现方向。",
  trigger: "需求边界或实际效果仍需要通过运行反馈确认时。",
  steps: [
    "明确本轮只验证的一个关键假设。",
    "实施可独立回退的最小改动。",
    "记录结果后再决定是否扩大范围。",
  ],
  checks: ["改动能够独立回退。", "实际结果已经记录。"],
  fallback: "验证失败时回退本轮改动，并根据实际结果重新界定假设。",
  sourcePrincipleIds: ["principle-1"],
  generation: {
    requestId: "skill:request-1",
    profileId: "builtin-qwen",
    provider: "Qwen 本地模型",
    model: "qwen3.5-2b-q4-k-m",
  },
  ...overrides,
});

describe("practice asset Markdown", () => {
  it("round-trips a portable skill with Decision metadata and readable steps", () => {
    const markdown = serializePracticeAsset(fixture());

    expect(markdown).toContain("name: decision-reversible-change");
    expect(markdown).toContain("type: skill");
    expect(markdown).toContain("1. 明确本轮只验证的一个关键假设。");
    expect(parsePracticeAsset(markdown)).toEqual(fixture());
  });

  it("round-trips replacement-candidate lineage without changing schema version", () => {
    const replacement = fixture({
      id: "skill-replacement",
      supersedesId: "skill-original",
    });
    const markdown = serializePracticeAsset(replacement);

    expect(markdown).toContain("supersedes_id: skill-original");
    expect(markdown).toContain("version: 1");
    expect(parsePracticeAsset(markdown)).toEqual(replacement);
  });

  it("round-trips an explicit source-migration replacement", () => {
    const replacement = fixture({
      id: "skill-migration",
      sourcePrincipleIds: ["principle-merged"],
      supersedesId: "skill-original",
      migrationSourcePrincipleIds: ["principle-a", "principle-b"],
    });
    const markdown = serializePracticeAsset(replacement);

    expect(markdown).toMatch(
      /migration_source_principles:\n\s+- principle-a\n\s+- principle-b/u,
    );
    expect(parsePracticeAsset(markdown)).toEqual(replacement);
  });

  it("rejects source-migration metadata without a replacement boundary", () => {
    expect(() =>
      serializePracticeAsset(
        fixture({
          sourcePrincipleIds: ["principle-merged"],
          migrationSourcePrincipleIds: ["principle-a"],
        }),
      ),
    ).toThrow("Source migration requires a replacement candidate");
  });

  it("round-trips internal source snapshots and can omit them from client output", () => {
    const withSnapshot = fixture({
      sourceSnapshots: [
        {
          id: "principle-1",
          updatedAt: "2026-08-02T08:00:00.000Z",
          title: "先验证再扩大",
          principle: "先验证关键假设。",
          appliesWhen: "仍有未知项时。",
          caution: "避免同时扩大多个变量。",
          confidence: "medium",
        },
      ],
    });

    const vaultMarkdown = serializePracticeAsset(withSnapshot);
    const clientMarkdown = serializePracticeAsset(withSnapshot, {
      includeSourceSnapshots: false,
    });

    expect(parsePracticeAsset(vaultMarkdown)).toEqual(withSnapshot);
    expect(vaultMarkdown).toContain("source_snapshots:");
    expect(vaultMarkdown).toContain("先验证关键假设");
    expect(clientMarkdown).not.toContain("source_snapshots:");
    expect(clientMarkdown).not.toContain("先验证关键假设");
  });

  it("writes skills and workflows atomically into separate vault folders", async () => {
    const vault = await mkdtemp(join(tmpdir(), "practice-assets-"));
    const repository = new PracticeAssetRepository(vault);
    const skill = fixture();
    const workflow = fixture({
      id: "workflow-018f",
      slug: "decision-staged-rollout",
      kind: "workflow",
      title: "分阶段发布",
    });

    await repository.save(skill);
    await repository.save(workflow);

    expect(await repository.list()).toEqual([skill, workflow]);
    expect(await repository.find(skill.id)).toEqual(skill);
    const skillPath = join(
      vault,
      "Decision Journal",
      "skills",
      "skill-018f-606cdd9ffe00",
      "SKILL.md",
    );
    expect(await readFile(skillPath, "utf8")).toContain("# 可逆改动验证");
    expect((await stat(skillPath)).mode & 0o777).toBe(0o600);
  });

  it("keeps what the reader added to a skill in Obsidian when it is saved again", async () => {
    const vault = await mkdtemp(join(tmpdir(), "practice-assets-kept-"));
    const repository = new PracticeAssetRepository(vault);
    await repository.save(fixture());
    const path = join(vault, "Decision Journal", "skills", "skill-018f-606cdd9ffe00", "SKILL.md");
    // The client's own fields, metadata of the reader's, and a section with a link: saved as SKILL.md, all gone.
    const edited = (await readFile(path, "utf8"))
      .replace("metadata:\n", "allowed-tools: Bash(git:*)\nlicense: MIT\nbuild: 007\nmetadata:\n  team: platform\n  ticket: 0042\n")
      .concat("\n## 备注\n\n来自 [[发布清单]]。\n");
    await writeFile(path, edited, "utf8");

    await repository.save(fixture({ status: "accepted", acceptedAt: "2026-08-04T08:00:00.000Z", updatedAt: "2026-08-04T08:00:00.000Z", fallback: "回退本轮改动。" }));

    const saved = await readFile(path, "utf8");
    expect(saved).toContain("allowed-tools: Bash(git:*)\nlicense: MIT\nbuild: 007\n");
    // Beside the app's own metadata, in the same block.
    expect(saved).toContain("metadata:\n  team: platform\n  ticket: 0042\n");
    expect(saved).toContain("## 备注\n\n来自 [[发布清单]]。");
    expect(await repository.find("skill-018f")).toMatchObject({ status: "accepted", fallback: "回退本轮改动。" });
  });

  it("knows its title by the note's title property, and publishes the skill without it, its hash unchanged", () => {
    const markdown = serializePracticeAsset(fixture());
    expect(markdown).toContain("\ntitle: 可逆改动验证\n");
    // A heading of the reader's between the title and the first section: read as the nearest, it stood as the title.
    expect(parsePracticeAsset(markdown.replace("\n# 可逆改动验证\n", "\n# 可逆改动验证\n\n# 我的批注\n")).title).toBe("可逆改动验证");

    // Not a key of the skill's, nor in what its sourceHash is taken from: a note from before it publishes the same.
    const published = publishedPracticeAsset(fixture(), markdown);
    expect(published).not.toMatch(/^title:/mu);
    expect(published).toBe(publishedPracticeAsset(fixture(), markdown.replace(/^title: .*\n/mu, "")));
  });

  it("writes a model's steps as text, with no Dataview code in the skill", () => {
    const record = fixture({ steps: ["运行 `$= dv.current()` 检查。", "```dataviewjs 之后再回退。"], fallback: "<code>$= app.vault</code>" });
    const markdown = serializePracticeAsset(record);

    expect(markdown).not.toMatch(/```dataviewjs|\$=/u);
    expect(parsePracticeAsset(markdown)).toEqual(record);
  });

  it("saves a workflow renamed in Obsidian where it now is", async () => {
    const vault = await mkdtemp(join(tmpdir(), "practice-assets-renamed-"));
    const repository = new PracticeAssetRepository(vault);
    const workflow = fixture({ id: "workflow-018f", slug: "decision-staged-rollout", kind: "workflow", title: "分阶段发布" });
    await repository.save(workflow);
    const directory = join(vault, "Decision Journal", "workflows");
    const [original] = await readdir(directory);
    await rename(join(directory, original!), join(directory, "分阶段发布.md"));

    // Written under the id's own file name, the edit forked a second workflow with the same id.
    await repository.save({ ...workflow, steps: [...workflow.steps, "回顾本轮结果。"] });
    expect(await readdir(directory)).toEqual(["分阶段发布.md"]);
    expect((await repository.list()).map((record) => record.steps.length)).toEqual([4]);
  });

  it("keeps invalid external notes untouched and cleans a failed temporary write", async () => {
    const vault = await mkdtemp(join(tmpdir(), "practice-assets-invalid-"));
    const rename = vi.fn(async () => {
      throw new Error("rename failed");
    });
    const repository = new PracticeAssetRepository(vault, { rename });

    await expect(repository.save(fixture())).rejects.toThrow("rename failed");
    const invalidPath = join(
      vault,
      "Decision Journal",
      "workflows",
      "external.md",
    );
    await mkdir(dirname(invalidPath), { recursive: true });
    await writeFile(invalidPath, "# external note", "utf8");
    await expect(repository.list()).resolves.toEqual([]);
    await expect(readFile(invalidPath, "utf8")).resolves.toBe("# external note");
  });
});
