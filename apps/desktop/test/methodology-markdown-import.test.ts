import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  parseMethodologyMarkdownDraft,
  parseMethodologyMarkdownDrafts,
  readMethodologyMarkdownSources,
} from "../src/main/methodology-markdown-import.js";

describe("methodology Markdown import", () => {
  it("maps explicit Markdown sections into a reviewable draft", () => {
    const draft = parseMethodologyMarkdownDraft({
      fileName: "delivery.md",
      markdown: `# 先小范围验证

## 原则

先验证关键假设，再扩大不可逆投入。

## 适用场景

需求与效果仍有关键未知项时。

## 边界

切换成本会快速增长时，需要重新评估。

## 依据

来自团队过去的交付复盘。`,
    });

    expect(draft).toEqual({
      title: "先小范围验证",
      principle: "先验证关键假设，再扩大不可逆投入。",
      appliesWhen: "需求与效果仍有关键未知项时。",
      caution: "切换成本会快速增长时，需要重新评估。",
      evidenceSummary: "来自团队过去的交付复盘。",
      sourceDecisionIds: [],
    });
  });

  it("splits a structured handbook into multiple principle drafts", () => {
    const drafts = parseMethodologyMarkdownDrafts({
      fileName: "team-handbook.md",
      markdown: `# 团队方法论

## 1. 先验证再扩大

### 原则
先验证关键假设，再扩大不可逆投入。

### 适用条件
结果仍有关键未知项时。

### 边界
验证窗口不能覆盖关键风险时不适用。

## 2. 保留回退路径

### 原则
切换新路径前保留可验证的回退方案。

### 适用条件
变更可以分阶段部署时。

### 注意事项
长期双轨成本过高时应设置退出期限。`,
    });

    expect(drafts).toHaveLength(2);
    expect(drafts).toEqual([
      expect.objectContaining({
        title: "先验证再扩大",
        principle: "先验证关键假设，再扩大不可逆投入。",
        appliesWhen: "结果仍有关键未知项时。",
      }),
      expect.objectContaining({
        title: "保留回退路径",
        principle: "切换新路径前保留可验证的回退方案。",
        caution: "长期双轨成本过高时应设置退出期限。",
      }),
    ]);
  });

  it("does not split ordinary document sections into fake principles", () => {
    const drafts = parseMethodologyMarkdownDrafts({
      fileName: "single.md",
      markdown: `# 先验证再扩大

## 原则
先验证关键假设。

## 适用条件
仍有未知项时。

## 注意事项
不可逆投入已经发生时重新评估。`,
    });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.title).toBe("先验证再扩大");
  });

  it("rejects handbooks that would flood the review queue", () => {
    const sections = Array.from(
      { length: 13 },
      (_, index) => `## ${index + 1}. 原则 ${index + 1}\n\n正文 ${index + 1}。`,
    ).join("\n\n");

    expect(() =>
      parseMethodologyMarkdownDrafts({
        fileName: "too-many.md",
        markdown: `# 方法论\n\n${sections}`,
      }),
    ).toThrow("最多拆分 12 条原则");
  });

  it("keeps sparse notes honest by inserting visible review placeholders", () => {
    const draft = parseMethodologyMarkdownDraft({
      fileName: "reversible-change.md",
      markdown: "先保留回退路径，再逐步切换。",
    });

    expect(draft.title).toBe("reversible-change");
    expect(draft.principle).toBe("先保留回退路径，再逐步切换。");
    expect(draft.appliesWhen).toMatch(/^待补充/u);
    expect(draft.caution).toMatch(/^待补充/u);
    expect(draft.evidenceSummary).toContain("尚未关联");
  });

  it("does not disguise a broken Decision note as generic Markdown", () => {
    expect(() =>
      parseMethodologyMarkdownDraft({
        fileName: "broken.md",
        markdown: `---
type: decision-methodology
version: 1
---

# 缺少内部结构`,
      }),
    ).toThrow("结构不完整");
  });

  it("reads only bounded regular Markdown files and rejects symlinks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "methodology-import-"));
    const valid = join(directory, "valid.md");
    const link = join(directory, "linked.md");
    const large = join(directory, "large.md");
    await writeFile(valid, "# 原则\n\n先验证。", "utf8");
    await symlink(valid, link);
    await writeFile(large, Buffer.alloc(512 * 1024 + 1, 97));

    const result = await readMethodologyMarkdownSources([valid, link, large]);

    expect(result.sources).toEqual([
      { fileName: "valid.md", markdown: "# 原则\n\n先验证。" },
    ]);
    expect(result.failures).toEqual([
      expect.objectContaining({ fileName: "linked.md", message: expect.stringContaining("符号链接") }),
      expect.objectContaining({ fileName: "large.md", message: expect.stringContaining("512 KiB") }),
    ]);
  });
});
