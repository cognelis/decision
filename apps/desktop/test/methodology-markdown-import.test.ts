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

  it("keeps a fenced code block whole, its `#` comments and list markers included", () => {
    const drafts = parseMethodologyMarkdownDrafts({
      fileName: "deploy.md",
      markdown: `# 部署前检查

## 原则
先在预发环境验证，再发布生产：

\`\`\`bash
# 在预发执行
make deploy-staging
- 不是列表
\`\`\`

## 适用条件
任何上线前。

## 注意事项
紧急回滚除外。`,
    });

    // One principle, not a second one called "在预发执行" that took its conditions.
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ title: "部署前检查", appliesWhen: "任何上线前。", caution: "紧急回滚除外。" });
    expect(drafts[0]?.principle).toContain("# 在预发执行\nmake deploy-staging\n- 不是列表");
  });

  it("does not let a fence left open swallow the principles after it", () => {
    const drafts = parseMethodologyMarkdownDrafts({
      fileName: "team-handbook.md",
      markdown: `# 团队方法论

## 1. 先验证再扩大

### 原则
先验证关键假设，再扩大不可逆投入，例如：

\`\`\`bash
make verify

### 适用条件
结果仍有关键未知项时。

## 2. 保留回退路径

### 原则
切换新路径前保留可验证的回退方案。

### 适用条件
变更可以分阶段部署时。`,
    });

    expect(drafts.map((draft) => draft.title)).toEqual(["先验证再扩大", "保留回退路径"]);
  });

  it("marks a field it had to shorten, so the preview shows it", () => {
    const draft = parseMethodologyMarkdownDraft({
      fileName: "long.md",
      markdown: `# 长原则\n\n## 原则\n${"长".repeat(2_100)}最后一句是结论。\n\n## 适用条件\n任何时候。\n\n## 注意事项\n无。`,
    });

    expect(draft.principle).toHaveLength(2_000);
    expect(draft.principle.endsWith("…（原文更长，导入时截断）")).toBe(true);
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
    // Its reason in words: the parser's English ("Methodology note … is invalid") went on to the page.
    ).toThrow("Decision 方法论文件结构不完整：有属性的值不是 Decision 能读的格式");
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

  it("reads numbered, bold or colon field headings as the fields of one principle", () => {
    for (const markdown of [
      "# 先保持可逆\n\n## 1. 原则\n先做可回退的小步改动。\n\n## 2. 适用条件\n需求仍在变化时。\n\n## 3. 注意事项\n双轨成本高时重新评估。\n",
      "# 先保持可逆\n\n## 一、原则\n先做可回退的小步改动。\n\n## 二、适用条件\n需求仍在变化时。\n\n## 三、注意事项\n双轨成本高时重新评估。\n",
      "# 先保持可逆\n\n## 原则：\n先做可回退的小步改动。\n\n## 适用条件：\n需求仍在变化时。\n\n## 注意事项：\n双轨成本高时重新评估。\n",
      "# 先保持可逆\n\n## **原则**\n先做可回退的小步改动。\n\n## **适用条件**\n需求仍在变化时。\n\n## **注意事项**\n双轨成本高时重新评估。\n",
    ]) {
      // Split into one bogus principle per section, or the written conditions lost to 待补充 placeholders.
      expect(parseMethodologyMarkdownDrafts({ fileName: "note.md", markdown })).toEqual([expect.objectContaining({
        title: "先保持可逆", principle: "先做可回退的小步改动。", appliesWhen: "需求仍在变化时。", caution: "双轨成本高时重新评估。",
      })]);
    }
  });

  it("takes no heading that only begins with 方法 or 规则 for a principle, and no tag line for its text", () => {
    const notes = parseMethodologyMarkdownDrafts({ fileName: "读书笔记.md", markdown: "# 方法论读书笔记\n\n## 方法论的定义\n方法论是……\n\n## 规则引擎\n规则引擎是……\n" });
    expect(notes.map((draft) => draft.title)).toEqual(["方法论读书笔记"]);
    const tagged = parseMethodologyMarkdownDrafts({ fileName: "note.md", markdown: "# 先保持可逆\n#原则 #工程\n\n在需求仍变化时，先实施能快速回退的小步改动。\n" });
    expect(tagged[0]!.principle).toBe("在需求仍变化时，先实施能快速回退的小步改动。");
    // Numbered principles still split, one each.
    const listed = parseMethodologyMarkdownDrafts({ fileName: "list.md", markdown: "# 工程原则\n\n## 原则一：先保持可逆\n先做可回退的小步改动。\n\n## 原则二：先验证再扩大\n先验证关键假设。\n" });
    expect(listed.map((draft) => draft.title)).toEqual(["先保持可逆", "先验证再扩大"]);
  });

  it("says a file in another encoding is not UTF-8, in Chinese", async () => {
    const folder = await mkdtemp(join(tmpdir(), "methodology-import-gbk-"));
    const path = join(folder, "旧笔记.md");
    // "# 原则\n" saved as GBK, as older Windows editors do.
    await writeFile(path, Buffer.from("2320d4add4f20a", "hex"));
    expect((await readMethodologyMarkdownSources([path])).failures).toEqual([
      { fileName: "旧笔记.md", message: expect.stringContaining("不是 UTF-8 编码") },
    ]);
  });
});
