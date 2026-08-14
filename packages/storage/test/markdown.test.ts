import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  MarkdownRepository,
  parseDecision,
  serializeDecision,
  updateDecisionOutcomeMarkdown,
  updateDecisionAppliedPrinciplesMarkdown,
  updateDecisionReviewDueDateMarkdown,
  updateOutcomeReviewMarkdown,
} from "../src/index.js";
import { recordFixture } from "./fixtures.js";

const makeVault = () => mkdtemp(join(tmpdir(), "decision-vault-"));

describe("decision Markdown", () => {
  it("writes current markers and reads legacy markers without changing content", () => {
    const record = recordFixture();
    const current = serializeDecision(record);
    const legacy = current.replaceAll(
      "<!-- decision:",
      "<!-- decision-island:",
    );

    expect(current).toContain("<!-- decision:selection-base64 ");
    expect(current).not.toContain("<!-- decision-island:");
    expect(parseDecision(legacy)).toEqual(record);
  });

  it("serializes flat Obsidian properties and readable sections", () => {
    const markdown = serializeDecision(recordFixture());
    const frontmatter = markdown.slice(4, markdown.indexOf("\n---", 4));
    const properties = parseYaml(frontmatter) as Record<string, unknown>;

    expect(properties).toMatchObject({
      id: "018f-example-decision",
      created: "2026-07-24T01:02:03.000Z",
      status: "completed",
      source_client: "codex",
      project: "decision",
      workflow: "superpowers",
      decision_type: "architecture",
      selected_option: "Markdown",
      llm_recommendation: "markdown",
      rationale_status: "captured",
      reason_factors: ["maintainability", "reversibility"],
      tags: ["storage"],
      related: [],
      applied_principles: [],
      supersedes: null,
    });
    for (const value of Object.values(properties)) {
      expect(
        value === null || Array.isArray(value) || typeof value !== "object",
      ).toBe(true);
    }
    expect(markdown).toContain("# 决策点\n\nMarkdown 还是数据库？");
    expect(markdown).toContain("## 可选方案");
    expect(markdown).toContain("```decision-options");
    expect(markdown).toContain("## 我的选择\n\nMarkdown");
    expect(markdown).toContain(
      "## 我的理由（原文）\n\n  因为它对人友好。\n\n而且能直接在 Obsidian 编辑。  ",
    );
    expect(markdown).toContain("## 当时上下文");
    expect(markdown).toContain("## 后续结果");
  });

  it("round-trips a decision without changing the original rationale", () => {
    const record = recordFixture();

    expect(parseDecision(serializeDecision(record))).toEqual(record);
  });

  it("updates the outcome without rewriting earlier user-authored sections", () => {
    const original = serializeDecision(recordFixture()).replace(
      "## 后续结果",
      "## 我的补充\n\n保留这段人工笔记。\n\n## 后续结果",
    );
    const outcome = "上线后验证通过。\n\n### 偏差\n\n耗时比预期多一天。";

    const updated = updateDecisionOutcomeMarkdown(original, outcome);

    expect(updated).toContain("## 我的补充\n\n保留这段人工笔记。");
    expect(parseDecision(updated).outcome).toBe(outcome);
  });

  it("schedules and clears a review without rewriting decision content", () => {
    const original = serializeDecision(recordFixture()).replace(
      "## 后续结果",
      "## 我的补充\n\n保留这段人工笔记。\n\n## 后续结果",
    );

    const scheduled = updateDecisionReviewDueDateMarkdown(
      original,
      "2026-08-15",
    );
    expect(parseDecision(scheduled).reviewDueDate).toBe("2026-08-15");
    expect(scheduled).toContain("## 我的补充\n\n保留这段人工笔记。");

    const cleared = updateDecisionReviewDueDateMarkdown(scheduled, null);
    expect(parseDecision(cleared).reviewDueDate).toBeNull();
    expect(() =>
      updateDecisionReviewDueDateMarkdown(original, "2026-02-31"),
    ).toThrow(/valid YYYY-MM-DD/u);
  });

  it("updates applied principles in frontmatter without rewriting decision content", () => {
    const original = serializeDecision(recordFixture()).replace(
      "## 后续结果",
      "## 我的补充\n\n保留这段人工笔记。\n\n## 后续结果",
    );

    const updated = updateDecisionAppliedPrinciplesMarkdown(original, {
      appliedPrincipleIds: ["principle-1", "principle-2"],
    });

    expect(parseDecision(updated).appliedPrincipleIds).toEqual([
      "principle-1",
      "principle-2",
    ]);
    expect(updated).toContain("## 我的补充\n\n保留这段人工笔记。");
    expect(() =>
      updateDecisionAppliedPrinciplesMarkdown(original, {
        appliedPrincipleIds: ["principle-1", "principle-1"],
      }),
    ).toThrow(/unique identifiers/u);
  });

  it("reads legacy decisions without applied-principle metadata", () => {
    const legacy = serializeDecision(recordFixture()).replace(
      "applied_principles: []\n",
      "",
    );

    expect(parseDecision(legacy).appliedPrincipleIds).toEqual([]);
  });

  it("round-trips a structured outcome review and preserves lesson Markdown", () => {
    const record = recordFixture({
      outcome: "上线后稳定运行一周。",
      outcomeReview: {
        verdict: "mixed",
        lesson: "方向正确。\n\n### 偏差\n\n低估了迁移成本。",
        reviewedAt: "2026-08-02T10:00:00.000Z",
      },
    });

    const markdown = serializeDecision(record);

    expect(markdown).toContain('outcome_verdict: "mixed"');
    expect(markdown).toContain("### 评价\n\n部分符合");
    expect(parseDecision(markdown)).toEqual(record);
  });

  it("adds a structured review to a legacy outcome section", () => {
    const legacy = serializeDecision(
      recordFixture({ outcome: "旧版实际结果。" }),
    )
      .replace(`\n\n<!-- decision:outcome-end -->`, "")
      .replace("\n\n## 复盘结论\n\n（尚未复盘）", "");

    const updated = updateOutcomeReviewMarkdown(legacy, {
      verdict: "as_expected",
      lesson: null,
      reviewedAt: "2026-08-02T10:00:00.000Z",
    });

    expect(parseDecision(updated)).toMatchObject({
      outcome: "旧版实际结果。",
      outcomeReview: {
        verdict: "as_expected",
        lesson: null,
        reviewedAt: "2026-08-02T10:00:00.000Z",
      },
    });
  });

  it("renders selected rationale factors as readable Obsidian content", () => {
    const markdown = serializeDecision(recordFixture());

    expect(markdown).toContain(
      "## 判断依据\n\n- 可维护性\n- 可逆性",
    );
    expect(markdown).toContain(
      "## 我的理由（原文）\n\n  因为它对人友好。",
    );
  });

  it("renders the current accumulated-knowledge factors while preserving legacy labels", () => {
    const current = serializeDecision(
      recordFixture({
        reasonFactors: ["consistency", "simplicity", "auditability"],
      }),
    );
    const legacy = serializeDecision(recordFixture());

    expect(current).toContain(
      "## 判断依据\n\n- 遵循现有约定\n- 简单直接\n- 可验证可追溯",
    );
    expect(legacy).toContain(
      "## 判断依据\n\n- 可维护性\n- 可逆性",
    );
  });

  it("round-trips factor-only rationale without fabricating original text", () => {
    const record = recordFixture({
      rationaleOriginal: null,
      reasonFactors: ["risk"],
    });
    const markdown = serializeDecision(record);

    expect(markdown).toContain(
      "## 我的理由（原文）\n\n（未填写自由输入理由）",
    );
    expect(parseDecision(markdown)).toEqual(record);
  });

  it("preserves user text that matches the factor-only display placeholder", () => {
    const record = recordFixture({
      rationaleOriginal: "（未填写自由输入理由）",
    });

    expect(
      parseDecision(serializeDecision(record)).rationaleOriginal,
    ).toBe("（未填写自由输入理由）");
  });

  it("preserves Markdown subheadings inside the user's rationale", () => {
    const record = recordFixture({
      rationaleOriginal:
        "先看可逆性。\n\n## 我的补充\n\n再看维护成本。",
    });

    expect(
      parseDecision(serializeDecision(record)).rationaleOriginal,
    ).toBe(record.rationaleOriginal);
  });

  it("round-trips a custom answer and deferred rationale", () => {
    const record = recordFixture({
      status: "deferred_rationale",
      selectedAnswer: {
        kind: "custom",
        values: ["先保留两个索引适配器"],
      },
      rationaleStatus: "deferred",
      rationaleOriginal: null,
      reasonFactors: [],
    });

    expect(parseDecision(serializeDecision(record))).toEqual(record);
  });

  it("round-trips passive provenance and a multi-select answer", () => {
    const record = recordFixture({
      captureMode: "structured_tool",
      sourceEventId: "event-1",
      batchId: "batch-1",
      questionIndex: 1,
      contextSummary: null,
      selectedAnswer: {
        kind: "multiple",
        values: ["Risk", "Time"],
      },
    });

    const markdown = serializeDecision(record);

    expect(parseDecision(markdown)).toEqual(record);
    expect(markdown).toContain('capture_mode: "structured_tool"');
    expect(markdown).toContain('selected_option: "Risk、Time"');
    expect(markdown).toContain("（原生问答未提供额外上下文）");
  });

  it("round-trips structured context and detection metadata", () => {
    const record = recordFixture({
      captureMode: "transcript",
      contextSummary: null,
      context: {
        taskBackground: "继续开发 Decision。",
        decisionFraming:
          "先提高采集质量，再做方法论提炼。",
        truncated: false,
      },
      detection: {
        band: "high",
        score: 88,
        detectorVersion: "rules-v1",
      },
    });

    const markdown = serializeDecision(record);
    const parsed = parseDecision(markdown);

    expect(markdown).toContain("### 任务背景");
    expect(markdown).toContain("继续开发 Decision。");
    expect(markdown).toContain("### 约束与考虑");
    expect(markdown).toContain(
      "先提高采集质量，再做方法论提炼。",
    );
    expect(markdown).toContain('capture_confidence: "high"');
    expect(markdown).toContain("capture_score: 88");
    expect(markdown).toContain('capture_detector: "rules-v1"');
    expect(markdown).not.toContain("answer_matches_option");
    expect(parsed).toEqual(record);
  });

  it("round-trips reserved Markdown headings inside structured context", () => {
    const record = recordFixture({
      contextSummary: null,
      context: {
        taskBackground:
          "准备任务。\n\n### 约束与考虑\n\n这是任务原文。\n\n<!-- decision-island:task-background-end -->\n\n## 后续结果\n\n还不是结果。",
        decisionFraming:
          "先比较方案。\n\n### 任务背景\n\n这是约束原文。",
        truncated: false,
      },
    });

    expect(parseDecision(serializeDecision(record))).toEqual(record);
  });

  it("continues to parse a legacy plain-text context section", () => {
    const record = recordFixture({
      contextSummary: "旧笔记里只有一段上下文。",
      context: null,
      detection: null,
    });

    const parsed = parseDecision(serializeDecision(record));

    expect(parsed.contextSummary).toBe(
      "旧笔记里只有一段上下文。",
    );
    expect(parsed.context).toBeNull();
    expect(parsed.detection).toBeNull();
  });

  it("reads a legacy selection marker into the new selected answer", () => {
    const legacySelection = Buffer.from(
      JSON.stringify({
        kind: "preset",
        id: "markdown",
        label: "Markdown",
      }),
      "utf8",
    ).toString("base64url");
    const markdown = serializeDecision(recordFixture()).replace(
      /<!-- decision:selection-base64 [A-Za-z0-9_-]+ -->/u,
      `<!-- decision-island:selection-base64 ${legacySelection} -->`,
    );

    expect(parseDecision(markdown).selectedAnswer).toEqual({
      kind: "preset",
      values: ["Markdown"],
    });
  });
});

describe("MarkdownRepository", () => {
  it("writes the note atomically under the monthly Obsidian folder", async () => {
    const vault = await makeVault();
    const repository = new MarkdownRepository(vault);

    const stored = await repository.write(recordFixture());
    const relativePath = relative(vault, stored.path);
    const files = await readdir(join(vault, "Decision Journal/decisions/2026/07"));

    expect(relativePath).toMatch(
      /^Decision Journal\/decisions\/2026\/07\/20260724T010203000Z-markdown-还是数据库-018f-example-[a-f0-9]{8}\.md$/u,
    );
    expect(stored.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(files).toEqual([relativePath.split("/").at(-1)]);
    expect(await readFile(stored.path, "utf8")).toBe(
      serializeDecision(recordFixture()),
    );
  });

  it("removes the temporary file and does not claim success when rename fails", async () => {
    const vault = await makeVault();
    const repository = new MarkdownRepository(vault, {
      rename: async () => {
        throw new Error("simulated rename failure");
      },
    });

    await expect(repository.write(recordFixture())).rejects.toThrow(
      /simulated rename failure/,
    );

    const month = join(vault, "Decision Journal/decisions/2026/07");
    expect(await readdir(month)).toEqual([]);
  });

  it("scans valid notes and reports malformed notes without changing them", async () => {
    const vault = await makeVault();
    const repository = new MarkdownRepository(vault);
    const stored = await repository.write(recordFixture());
    const malformedPath = join(
      vault,
      "Decision Journal/decisions/2026/07/broken.md",
    );
    const malformed = "---\nid: broken\n---\nnot a decision";
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(malformedPath, malformed, "utf8"),
    );

    const scan = await repository.scan();

    expect(scan.notes.map((note) => note.record.id)).toEqual([
      "018f-example-decision",
    ]);
    expect(scan.diagnostics).toEqual([
      expect.objectContaining({ path: malformedPath }),
    ]);
    expect(await readFile(malformedPath, "utf8")).toBe(malformed);
    expect(await readFile(stored.path, "utf8")).toContain(
      "018f-example-decision",
    );
  });

  it("does not collide when IDs share the same readable prefix", async () => {
    const vault = await makeVault();
    const repository = new MarkdownRepository(vault);
    const first = await repository.write(
      recordFixture({ id: "decision-prefix-one" }),
    );
    const second = await repository.write(
      recordFixture({ id: "decision-prefix-two" }),
    );

    expect(first.path).not.toBe(second.path);
    expect((await repository.scan()).notes).toHaveLength(2);
  });

  it("writes an outcome back to the existing decision note", async () => {
    const vault = await makeVault();
    const repository = new MarkdownRepository(vault);
    const stored = await repository.write(recordFixture());

    const updated = await repository.updateOutcome(
      "018f-example-decision",
      "实际运行一周后保持稳定。",
    );

    expect(updated.path).toBe(stored.path);
    expect(updated.record.outcome).toBe("实际运行一周后保持稳定。");
    expect(await readFile(stored.path, "utf8")).toContain(
      "## 后续结果\n\n实际运行一周后保持稳定。",
    );
  });

  it("writes a structured review after an outcome exists", async () => {
    const vault = await makeVault();
    const repository = new MarkdownRepository(vault);
    await repository.write(
      recordFixture({ outcome: "上线后稳定运行一周。" }),
    );

    const updated = await repository.updateOutcomeReview(
      "018f-example-decision",
      {
        verdict: "better",
        lesson: "小步上线降低了风险。",
        reviewedAt: "2026-08-02T10:00:00.000Z",
      },
    );

    expect(updated.record.outcomeReview).toEqual({
      verdict: "better",
      lesson: "小步上线降低了风险。",
      reviewedAt: "2026-08-02T10:00:00.000Z",
    });
  });
});
