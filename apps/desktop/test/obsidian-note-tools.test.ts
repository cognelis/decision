import { describe, expect, it } from "vitest";

import { buildObsidianMarkdownDocument } from "../src/main/obsidian-search/markdown-chunker.js";
import { lineOfMatch, readObsidianNote } from "../src/main/obsidian-search/obsidian-note-tools.js";

/** The heading the index names the chunk holding `text` by, as the chunker gives it. */
const headingOf = (content: string, text: string): string | null =>
  buildObsidianMarkdownDocument({ relativePath: "n.md", content, contentHash: "a".repeat(64), size: content.length, modifiedAtMs: 0 })
    .chunks.find((chunk) => chunk.text.includes(text))!.heading;

describe("lineOfMatch", () => {
  const note = "# 方案\n\n## 背景\n\nRedis 曾经出过事。\n\n## 结论\n\n不用 Memcached，改用 Redis。\n";

  it("places a hit under its section's heading path, at the first line there with a word of the query", () => {
    expect(lineOfMatch(note, "方案 > 结论", "redis")).toBe(9);
    expect(lineOfMatch(note, "方案 > 背景", "Redis")).toBe(5);
    expect(lineOfMatch(note, null, "Memcached")).toBe(9);
  });

  it("falls back to the heading for a hit by meaning alone, and to none without either", () => {
    expect(lineOfMatch(note, "方案 > 结论", "缓存选型")).toBe(7);
    expect(lineOfMatch(note, null, "缓存选型")).toBeNull();
  });

  it("does not place a hit in one section at a word that appears only in a later one", () => {
    // 背景 matched by meaning; "Memcached" is written only under 结论.
    expect(lineOfMatch(note, "方案 > 背景", "Memcached")).toBe(3);
    // A subsection belongs to its parent's section; the next heading of the same level ends it.
    expect(lineOfMatch("# A\n## A1\n\nRedis\n# B\nRedis\n", "A", "Redis")).toBe(4);
  });

  it("places a hit by the chunker's own headings: not at a same-named one in a code fence", () => {
    const content = "# Design\n\n```markdown\n## Verdict\nRedis is rejected in this example.\n```\n\n## Verdict\nUse Redis in production.\n";
    const heading = headingOf(content, "Use Redis");
    expect(heading).toBe("Design > Verdict");
    // Taken for the real one, the fenced example's line 5 was given as where Redis was adopted.
    expect(lineOfMatch(content, heading, "Redis")).toBe(9);
    const tilde = "# D\n\n~~~\n## V\nRedis no\n~~~\n\n## V\nRedis yes\n";
    expect(lineOfMatch(tilde, headingOf(tilde, "Redis yes"), "Redis")).toBe(9);
  });

  it("counts lines past the frontmatter and finds a setext heading, as the chunker does", () => {
    const content = "---\ntitle: x\n---\nIntro\n\nVerdict\n-------\nUse Redis.\n";
    const heading = headingOf(content, "Use Redis");
    expect(heading).toBe("Verdict");
    expect(lineOfMatch(content, heading, "Redis")).toBe(8);
  });

  it("still finds a word in a code block under the real heading", () => {
    const content = "# D\n\n## V\n\n```yaml\ncache: Redis\n```\n";
    expect(lineOfMatch(content, headingOf(content, "cache: Redis"), "Redis")).toBe(6);
  });

  it("counts \\r\\n and a lone \\r as line breaks, as the chunker does", () => {
    for (const eol of ["\r\n", "\r"]) {
      const content = ["# Design", "", "```", "## Verdict", "Redis rejected", "```", "", "## Verdict", "Use Redis."].join(eol) + eol;
      expect(lineOfMatch(content, headingOf(content, "Use Redis"), "Redis"), JSON.stringify(eol)).toBe(9);
    }
  });

  it("reads the lines a lone \\r breaks, so the line a hit is placed at is the line read", async () => {
    const content = "# Design\r```\r## Verdict\rRedis rejected\r```\r## Verdict\rUse Redis.\r";
    const line = lineOfMatch(content, headingOf(content, "Use Redis"), "Redis")!;
    const runtime = {
      search: async () => { throw new Error("unused"); },
      status: () => { throw new Error("unused"); },
      readIndexedNote: async () => ({ title: "n", changedSinceIndexed: false, note: { relativePath: "n.md", content, contentHash: "a".repeat(64), size: content.length, modifiedAtMs: 0 } }),
    } as unknown as Parameters<typeof readObsidianNote>[0];
    const read = await readObsidianNote(runtime, { path: "n.md", startLine: line, maxLines: 1 });
    expect(read.note).toMatchObject({ totalLines: 7, text: "Use Redis." });
  });

  it("says no line where the heading cannot be told apart, rather than a wrong one", () => {
    const twice = "# D\n## V\nRedis one\n## V\nRedis two\n";
    expect(lineOfMatch(twice, "D > V", "Redis")).toBeNull();
    // Named twice, the words in one of them only: that one.
    expect(lineOfMatch("# D\n## V\nnothing\n## V\nRedis\n", "D > V", "Redis")).toBe(5);
    // A heading no longer in the note (changed since it was indexed).
    expect(lineOfMatch(twice, "D > Gone", "Redis")).toBeNull();
  });
});
