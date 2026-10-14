import { describe, expect, it } from "vitest";

import { boundObsidianMetadata, buildObsidianMarkdownDocument } from "../src/main/obsidian-search/markdown-chunker.js";
import type { ObsidianVaultNote } from "@cognelis/decision-storage";

const note = (content: string, relativePath = "notes/部署.md", sourceHash = "source-hash"): ObsidianVaultNote => ({
  relativePath,
  content,
  contentHash: sourceHash,
  size: content.length,
  modifiedAtMs: 0,
});

describe("buildObsidianMarkdownDocument", () => {
  it("keeps a heading with no text of its own in a chunk, where the next heading does not name it", () => {
    const content = "# 季度计划\n## 招聘冻结\n## 预算\n下季度预算削减一成\n## 待定";
    const everything = buildObsidianMarkdownDocument(note(content)).chunks
      .map((chunk) => `${chunk.heading ?? ""}\n${chunk.text}`).join("\n");
    // Dropped as an empty section, and popped from the next one's breadcrumb, it was in no chunk at all.
    expect(everything).toContain("招聘冻结");
    expect(everything).toContain("待定");
    // A parent heading is in its children's breadcrumbs, and is not made a chunk of its own.
    expect(buildObsidianMarkdownDocument(note(content)).chunks.map((chunk) => chunk.text)).not.toContain("季度计划");
  });

  it("keeps an empty heading as most are written: a blank line under it, the note ending in a newline, a setext one", () => {
    const words = (content: string): string => buildObsidianMarkdownDocument(note(content)).chunks
      .map((chunk) => `${chunk.heading ?? ""}\n${chunk.text}`).join("\n");
    // A blank line counted as text of its own: still dropped, wherever a blank line was left under the heading.
    expect(words("# 季度计划\n## 招聘冻结\n\n## 预算\n下季度预算削减一成\n\n## 待定")).toContain("招聘冻结");
    expect(words("# 季度计划\n## 预算\n正文\n## 待定\n")).toContain("待定");
    expect(words("# 季度计划\n## 冻结\n\n预算\n---\n下季度预算削减一成")).toContain("冻结");
  });

  it("indexes properties named in Chinese and aliases and tags written as lists", () => {
    const content = "---\n负责人: 王小明\naliases: [回滚预案, \"灰度方案\"]\ntags:\n  - 发布流程\n  - 上线\nstatus: done\n---\n正文";
    const text = buildObsidianMarkdownDocument(note(content)).chunks.map((chunk) => chunk.text).join("\n");
    // The key pattern was ASCII only, and list values were dropped: none of these found the note.
    for (const word of ["王小明", "回滚预案", "灰度方案", "发布流程", "上线", "done"]) expect(text).toContain(word);
  });

  it("takes a quoted list item whole, its comma and all", () => {
    const text = buildObsidianMarkdownDocument(note("---\naliases: [\"回滚, 预案\", '灰度, 方案', 上线]\n---\n正文")).chunks
      .map((chunk) => chunk.text).join("\n");
    // Split at every comma: `"回滚` and `预案"`, neither a word anyone searches.
    expect(text).toContain("回滚, 预案");
    expect(text).toContain("灰度, 方案");
    expect(text).toContain("上线");
    expect(text).not.toMatch(/预案"|'灰度/u);
  });

  it("chooses a scalar frontmatter title before H1 and basename", () => {
    expect(buildObsidianMarkdownDocument(note("---\ntitle: \"前置标题\"\n---\n# 正文标题\n内容")).title).toBe("前置标题");
    expect(buildObsidianMarkdownDocument(note("---\ntitle: plain title\n---\n# 正文标题\n内容")).title).toBe("plain title");
    expect(buildObsidianMarkdownDocument(note("# 文档标题\n内容")).title).toBe("文档标题");
    expect(buildObsidianMarkdownDocument(note("正文", "Folder/ReadMe.MD")).title).toBe("ReadMe");
  });

  it("decodes scalar quoting, comments, and normalizes title whitespace", () => {
    expect(buildObsidianMarkdownDocument(note("---\ntitle: 'Don''t  stop'\n---\nBody")).title).toBe("Don't stop");
    expect(buildObsidianMarkdownDocument(note("---\ntitle: \"A # real\\n title\" # comment\n---\nBody")).title).toBe("A # real title");
    expect(buildObsidianMarkdownDocument(note("---\ntitle: Plain title # comment\n---\nBody")).title).toBe("Plain title");
    expect(buildObsidianMarkdownDocument(note("---\ntitle: Today's  Note\nteam: Ada's Team\nquote: say \"hello\"\n---\nBody")).title).toBe("Today's Note");
    expect(buildObsidianMarkdownDocument(note("---\ntitle: -Draft\n---\nBody")).title).toBe("-Draft");
    expect(buildObsidianMarkdownDocument(note("---\ntitle: -\n---\n# Fallback\nBody")).title).toBe("Fallback");
    expect(buildObsidianMarkdownDocument(note("---\ntitle: 'unclosed\n---\n# Fallback\nBody")).title).toBe("Fallback");
    expect(buildObsidianMarkdownDocument(note("---\ntitle: \"mismatch'\n---\n# Fallback\nBody")).title).toBe("Fallback");
    expect(buildObsidianMarkdownDocument(note("   #   H1   With   Spaces   \nBody", "Folder/My   Note.md")).title).toBe("H1 With Spaces");
    expect(buildObsidianMarkdownDocument(note("Body", "Folder/My   Note.md")).title).toBe("My Note");
  });

  it("ignores H1 markers in fenced code and tolerates malformed frontmatter", () => {
    const fenced = buildObsidianMarkdownDocument(note("```md\n# 假标题\n```\n正文", "x.md"));
    expect(fenced.title).toBe("x");
    expect(() => buildObsidianMarkdownDocument(note("---\ntitle: [broken\n---\n# 真实标题\n内容"))).not.toThrow();
    expect(buildObsidianMarkdownDocument(note("---\ntitle: [broken\n---\n# 真实标题\n内容")).title).toBe("真实标题");
  });

  it("tracks nested heading breadcrumbs and excludes heading markers in fences", () => {
    const document = buildObsidianMarkdownDocument(note("# 部署\n介绍\n## 回滚\n步骤\n```\n### 假\n```\n命令\n### 验证\n结果"));
    expect(document.chunks.map((chunk) => chunk.heading)).toContain("部署");
    expect(document.chunks.map((chunk) => chunk.heading)).toContain("部署 > 回滚");
    expect(document.chunks.map((chunk) => chunk.heading)).toContain("部署 > 回滚 > 验证");
    expect(document.chunks.some((chunk) => chunk.heading?.includes("假"))).toBe(false);
  });

  it("matches fenced markers by character and opening length", () => {
    const document = buildObsidianMarkdownDocument(note("# Real\n````\n# hidden\n```\n# still hidden\n````\n## Child\ntext\n~~~\n### also hidden\n```\n### still hidden\n~~~\n### Visible\ntext"));
    expect(document.title).toBe("Real");
    expect(document.chunks.map((chunk) => chunk.heading)).toContain("Real > Child");
    expect(document.chunks.map((chunk) => chunk.heading)).toContain("Real > Child > Visible");
    expect(document.chunks.some((chunk) => chunk.heading?.includes("hidden"))).toBe(false);
  });

  it("requires CommonMark fence indentation and valid closing tails", () => {
    const document = buildObsidianMarkdownDocument(note("    ```\n    # fake\n    # also fake\n# Real\n```js\n# hidden\n```not-close\n# still hidden\n```\n## Child\ntext"));
    expect(document.title).toBe("Real");
    expect(document.chunks.map((chunk) => chunk.heading)).toContain("Real");
    expect(document.chunks.map((chunk) => chunk.heading)).toContain("Real > Child");
    expect(document.chunks.some((chunk) => chunk.heading?.includes("still"))).toBe(false);
  });

  it("recognizes ATX headings only with up to three spaces and preserves C#", () => {
    const document = buildObsidianMarkdownDocument(note("    # fake\n# C#\nBody\n## Title ##\nMore\n    ## not heading"));
    expect(document.title).toBe("C#");
    expect(document.chunks.map((chunk) => chunk.heading)).toContain("C#");
    expect(document.chunks.map((chunk) => chunk.heading)).toContain("C# > Title");
  });

  it("recognizes Setext headings and ignores them in fences or as standalone rules", () => {
    const document = buildObsidianMarkdownDocument(note("Setext Title\n=====\nIntro\n\nSection\n-----\nBody\n```\nFake\n=====\n```\n---\n-\n"));
    expect(document.title).toBe("Setext Title");
    expect(document.chunks.map((chunk) => chunk.heading)).toContain("Setext Title");
    expect(document.chunks.map((chunk) => chunk.heading)).toContain("Setext Title > Section");
    expect(document.chunks.some((chunk) => chunk.heading?.includes("Fake"))).toBe(false);
    expect(buildObsidianMarkdownDocument(note("    Indented\n=====\nBody", "indented.md")).title).toBe("indented");
  });

  it("does not turn list or quote containers into Setext headings", () => {
    const document = buildObsidianMarkdownDocument(note("- item\n---\n> quote\n---\n1. ordered\n---\nBody", "containers.md"));
    expect(document.title).toBe("containers");
    expect(document.chunks.some((chunk) => chunk.text.includes("- item"))).toBe(true);
    expect(document.chunks.every((chunk) => !chunk.heading)).toBe(true);
  });

  it("keeps loose list continuations as list body text", () => {
    const unordered = buildObsidianMarkdownDocument(note("- item\n\n  continuation\n---\nBody", "loose-ul.md"));
    const ordered = buildObsidianMarkdownDocument(note("1. item\n\n   continuation\n---\nBody", "loose-ol.md"));
    expect(unordered.chunks.every((chunk) => !chunk.heading)).toBe(true);
    expect(ordered.chunks.every((chunk) => !chunk.heading)).toBe(true);
    expect(unordered.chunks.map((chunk) => chunk.text).join(" ")).toContain("continuation");
    expect(ordered.chunks.map((chunk) => chunk.text).join(" ")).toContain("continuation");
  });

  it("tracks loose list containers across multiple indented paragraphs", () => {
    const unordered = buildObsidianMarkdownDocument(note("- item\n\n  first continuation\n\n  second continuation\n---\nBody", "loose-ul-2.md"));
    const ordered = buildObsidianMarkdownDocument(note("1. item\n\n   first continuation\n\n   second continuation\n---\nBody", "loose-ol-2.md"));
    expect(unordered.chunks.every((chunk) => !chunk.heading)).toBe(true);
    expect(ordered.chunks.every((chunk) => !chunk.heading)).toBe(true);
  });

  it("removes Setext title source lines from the preceding body", () => {
    const document = buildObsidianMarkdownDocument(note("# Parent\nParent body\n\nChild\n---\nChild body", "parent.md"));
    expect(document.chunks.find((chunk) => chunk.heading === "Parent")?.text).toBe("Parent body");
    expect(document.chunks.find((chunk) => chunk.heading === "Parent > Child")?.text).toBe("Child body");
  });

  it("joins consecutive paragraph lines into multiline Setext breadcrumbs", () => {
    const document = buildObsidianMarkdownDocument(note("First line\nSecond line\n===\nIntro\n\nChild line one\nChild line two\n---\nBody"));
    expect(document.title).toBe("First line Second line");
    expect(document.chunks.map((chunk) => chunk.heading)).toContain("First line Second line");
    expect(document.chunks.map((chunk) => chunk.heading)).toContain("First line Second line > Child line one Child line two");
  });

  it("keeps searchable scalar frontmatter without dumping delimiters or plugin structures", () => {
    const document = buildObsidianMarkdownDocument(note("---\ntitle: Guide\nauthor: Ada Lovelace\ntags:\n  - private\ncustom: true\n---\nBody"));
    const text = document.chunks.map((chunk) => chunk.text).join("\n");
    expect(text).toContain("Ada Lovelace");
    expect(text).toContain("true");
    expect(text).not.toContain("---");
    expect(text).not.toContain("tags:");
  });

  it("normalizes line endings and preserves lists, links, and code", () => {
    const document = buildObsidianMarkdownDocument(note("# 标题\r\n- 一个\r- [链接](https://example.test)\r\n```js\r\nconst x = 1;\r\n```"));
    const text = document.chunks.map((chunk) => chunk.text).join("\n");
    expect(text).toContain("一个");
    expect(text).toContain("[链接](https://example.test)");
    expect(text).toContain("const x = 1;");
    expect(text).not.toContain("\r");
  });

  it("splits long paragraphs with maximum code-point length and overlap", () => {
    const paragraph = "甲".repeat(4100);
    const document = buildObsidianMarkdownDocument(note(paragraph, "long.md"));
    expect(document.chunks.length).toBeGreaterThan(2);
    for (const chunk of document.chunks) {
      expect(Array.from(chunk.text).length).toBeLessThanOrEqual(1800);
      expect(chunk.text.length).toBeGreaterThan(0);
    }
    const first = document.chunks[0]!.text;
    expect(document.chunks[1]!.text.startsWith(first.slice(-160))).toBe(true);
    for (const chunk of document.chunks) expect(chunk.text).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it("splits emoji paragraphs on code-point boundaries with 160-point overlap", () => {
    const paragraph = "🙂".repeat(2100);
    const document = buildObsidianMarkdownDocument(note(paragraph, "emoji.md"));
    const first = Array.from(document.chunks[0]!.text);
    const second = Array.from(document.chunks[1]!.text);
    expect(first.length).toBeLessThanOrEqual(1800);
    expect(second.length).toBeLessThanOrEqual(1800);
    expect(second.slice(0, 160)).toEqual(first.slice(-160));
    for (const chunk of document.chunks) {
      expect(chunk.text).not.toMatch(/^[\uDC00-\uDFFF]/u);
      expect(chunk.text).not.toMatch(/[\uD800-\uDBFF]$/u);
    }
  });

  it("emits a discoverable chunk for an empty note and constructs exact embedding text", () => {
    const document = buildObsidianMarkdownDocument(note("", "empty.md"));
    expect(document.chunks).toHaveLength(1);
    expect(document.chunks[0]!.text).toContain("empty");
    expect(document.chunks[0]!.embeddingText).toBe("Title: empty\nPath: empty.md\n" + document.chunks[0]!.text);
  });

  it("emits one discoverable chunk for a title-only note", () => {
    const document = buildObsidianMarkdownDocument(note("# Only Title\n", "title-only.md"));
    expect(document.chunks).toHaveLength(1);
    expect(document.chunks[0]!.text).toContain("Only Title");
    expect(document.chunks[0]!.text).toContain("title-only.md");
  });

  it("keeps one bounded fallback chunk for long titles and paths", () => {
    const title = "# " + "长".repeat(2400);
    const document = buildObsidianMarkdownDocument(note(title, `${"目录/".repeat(500)}标题.md`));
    expect(document.chunks).toHaveLength(1);
    for (const chunk of document.chunks) {
      expect(Array.from(chunk.text).length).toBeLessThanOrEqual(1800);
      expect(chunk.text.length).toBeGreaterThan(0);
    }
  });

  it("bounds embedding metadata and the public title while preserving the relative path", () => {
    const huge = "H".repeat(2_000_000);
    const document = buildObsidianMarkdownDocument(note(`# ${huge}\nBody\n## ${huge}\nBody`, `${"path/".repeat(1000)}note.md`));
    expect(document.title.length).toBe(1_000);
    expect(document.relativePath.length).toBeGreaterThan(4000);
    expect(document.chunks.every((chunk) => (chunk.heading?.length ?? 0) <= 600)).toBe(true);
    expect(document.chunks.length).toBeLessThan(20);
    for (const chunk of document.chunks) expect(Array.from(chunk.embeddingText).length).toBeLessThanOrEqual(4000);
  });

  it("bounds metadata prefixes for many chunks with a large heading", () => {
    const heading = "H".repeat(100_000);
    const document = buildObsidianMarkdownDocument(note(`# ${heading}\n${("p".repeat(1201) + "\n\n").repeat(1200)}`, "stress.md"));
    expect(document.chunks.length).toBeGreaterThan(1000);
    expect(boundObsidianMetadata(heading, 300)).toHaveLength(300);
    for (const chunk of document.chunks) expect(Array.from(chunk.embeddingText).length).toBeLessThanOrEqual(4000);
  });

  it("bounds public breadcrumbs while retaining root and leaf context", () => {
    const ancestor = "Root " + "A".repeat(50_000);
    const children = Array.from({ length: 550 }, (_, index) => `## Child ${index}\nBody`).join("\n");
    const document = buildObsidianMarkdownDocument(note(`# ${ancestor}\n${children}\n---\nBody`, "hierarchy.md"));
    expect(document.chunks.length).toBeGreaterThan(500);
    for (const chunk of document.chunks) {
      if (!chunk.heading) continue;
      expect(Array.from(chunk.heading).length).toBeLessThanOrEqual(600);
      expect(chunk.heading).toContain("Root");
      if (chunk.heading.includes("Child")) expect(chunk.heading).toMatch(/Child \d+$/u);
    }
    expect(document.chunks.every((chunk) => Array.from(chunk.embeddingText).length <= 4000)).toBe(true);
  });

  it("changes hierarchy hashes when truncated ancestor text changes", () => {
    const first = buildObsidianMarkdownDocument(note("# Root " + "A".repeat(1000) + "x\n## Child\nBody", "ancestor.md", "source-a"));
    const changed = buildObsidianMarkdownDocument(note("# Root " + "A".repeat(1000) + "y\n## Child\nBody", "ancestor.md", "source-b"));
    expect(first.contentHash).not.toBe(changed.contentHash);
    expect(first.chunks.find((chunk) => chunk.heading?.includes("Child"))?.contentHash).not.toBe(changed.chunks.find((chunk) => chunk.heading?.includes("Child"))?.contentHash);
  });

  it("preserves emoji code points in truncated heading suffixes", () => {
    const document = buildObsidianMarkdownDocument(note(`# ${"Root ".repeat(2000)}\n## Child 🙂\nBody`, "emoji-heading.md"));
    const chunk = document.chunks.find((candidate) => candidate.heading?.includes("Child"));
    expect(chunk?.heading).toMatch(/Child 🙂$/u);
    expect(Array.from(chunk?.heading ?? "").filter((character) => character === "🙂")).toHaveLength(1);
    expect(chunk?.heading).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(chunk?.embeddingText).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it("includes the exact section line in embedding text", () => {
    const document = buildObsidianMarkdownDocument(note("# Top\n\nBody", "top.md"));
    const chunk = document.chunks.find((candidate) => candidate.heading === "Top");
    expect(chunk?.embeddingText).toBe("Title: Top\nPath: top.md\nSection: Top\nBody");
  });

  it("uses stable IDs and content hashes, while content changes affect hashes", () => {
    const first = buildObsidianMarkdownDocument(note("# A\nold", "same.md", "hash-a"));
    const again = buildObsidianMarkdownDocument(note("# A\nold", "same.md", "hash-a"));
    const changed = buildObsidianMarkdownDocument(note("# A\nnew", "same.md", "hash-b"));
    expect(first).toEqual(again);
    expect(first.chunks[0]!.id).toBe(again.chunks[0]!.id);
    expect(first.contentHash).toBe(again.contentHash);
    expect(first.chunks[0]!.id).toBe(changed.chunks[0]!.id);
    expect(first.chunks[0]!.contentHash).not.toBe(changed.chunks[0]!.contentHash);
    expect(first.contentHash).not.toBe(changed.contentHash);
    expect(first.chunks[0]!.id).toBe("e4649c5547a998bbbaa4ad8698192b1bccd25f97b786d712e2e8427f6857a3a3");
    expect(first.chunks[0]!.contentHash).toBe("9b1ac8a65642f9aaf3dc9933dc3c382028a995153ea2931b7ceb268e69f06abd");
  });

  it("excludes comment-only YAML values", () => {
    const document = buildObsidianMarkdownDocument(note("---\ntitle: # comment\nauthor: # hidden\n---\n# Fallback\nBody", "metadata.md"));
    expect(document.title).toBe("Fallback");
    expect(document.chunks.map((chunk) => `${chunk.text} ${chunk.embeddingText}`).join(" ")).not.toContain("comment");
  });

  it("preserves the scanner source content hash on the document", () => {
    const document = buildObsidianMarkdownDocument(note("# A\nBody", "source.md"));
    expect(document.contentHash).toBe("source-hash");
  });
});
