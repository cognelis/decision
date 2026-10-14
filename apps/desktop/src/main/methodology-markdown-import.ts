import type { MethodologyRecord } from "@cognelis/decision-core";
import { clipText } from "@cognelis/decision-protocol";
import { noteProblem, parseMethodology } from "@cognelis/decision-storage";
import { lstat, readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

const MAX_IMPORT_FILES = 20;
const MAX_IMPORT_BYTES = 512 * 1024;
const MAX_DRAFTS_PER_FILE = 12;

export interface MethodologyMarkdownSource {
  fileName: string;
  markdown: string;
}

export interface MethodologyMarkdownDraft {
  title: string;
  principle: string;
  appliesWhen: string;
  caution: string;
  evidenceSummary: string;
  sourceDecisionIds: string[];
}

export interface MethodologyMarkdownReadFailure {
  fileName: string;
  message: string;
}

export interface MethodologyMarkdownReadResult {
  sources: MethodologyMarkdownSource[];
  failures: MethodologyMarkdownReadFailure[];
}

const TRUNCATED = "…（原文更长，导入时截断）";
/** Within the field's limit, and saying so when the text was cut: the preview is where it is caught. */
const bounded = (value: string, maximum: number): string => {
  const trimmed = value.trim();
  return trimmed.length <= maximum ? trimmed : `${clipText(trimmed, maximum - TRUNCATED.length)}${TRUNCATED}`;
};

/**
 * Where fenced code sits. A `# comment` in a ```bash block is code, not a heading: read as one, it
 * split a principle in two and cut the command out of it. A fence never closed is no fence: taken to
 * the end of the file, it hid every heading after it, and merged the principles under them into one.
 */
const fencedRanges = (body: string): Array<[number, number]> => {
  const ranges: Array<[number, number]> = [];
  let open: { start: number; marker: string } | null = null;
  for (const match of body.matchAll(/^ {0,3}(`{3,}|~{3,})(.*)$/gmu)) {
    const marker = match[1]!;
    const at = match.index ?? 0;
    if (open === null) open = { start: at, marker };
    else if (marker[0] === open.marker[0] && marker.length >= open.marker.length && match[2]!.trim() === "") {
      ranges.push([open.start, at + match[0].length]);
      open = null;
    }
  }
  return ranges;
};

const insideRanges = (ranges: Array<[number, number]>, offset: number): boolean =>
  ranges.some(([start, end]) => offset >= start && offset < end);

const headingsOf = (body: string): RegExpMatchArray[] => {
  const fenced = fencedRanges(body);
  return [...body.matchAll(/^(#{1,6})\s+(.+?)\s*$/gmu)].filter((match) => !insideRanges(fenced, match.index ?? 0));
};

const stripFrontmatter = (markdown: string): string => {
  if (!markdown.startsWith("---\n")) return markdown;
  const boundary = markdown.indexOf("\n---\n", 4);
  return boundary < 0 ? markdown : markdown.slice(boundary + 5);
};

const cleanMarkdownText = (value: string): string => {
  const text = value.replace(/<!--[^]*?-->/gu, "");
  const fenced = fencedRanges(text);
  let offset = 0;
  return text
    .split("\n")
    .map((line) => {
      const start = offset;
      offset += line.length + 1;
      // Code stays as written: a `#`, `-` or `1.` at the start of a line is part of it.
      if (insideRanges(fenced, start)) return line;
      return line.replace(/^\s*#{1,6}\s+/u, "").replace(/^\s*[-*+]\s+/u, "").replace(/^\s*\d+[.)]\s+/u, "");
    })
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
};

interface MarkdownSection {
  heading: string;
  level: number;
  content: string;
}

interface MarkdownHeadingBlock {
  heading: string;
  level: number;
  content: string;
}

const fieldHeadingPattern =
  /^(?:(?:核心)?原则|方法|做法|规则|适用条件|适用场景|使用条件|何时使用|适用范围|注意事项|边界|限制|例外|不适用场景|风险|证据摘要|证据|来源|依据|验证记录)$/u;

/**
 * A heading as the field it names: "1. 原则", "一、适用条件", "**注意事项**" and "适用条件：" are those fields.
 * Taken as written, a numbered note split into one bogus principle per section, and a colon or bold
 * heading lost the text under it to a 待补充 placeholder.
 */
const fieldName = (heading: string): string =>
  heading
    .replace(/^(?:\d+|[一二三四五六七八九十]+)[.、)）]\s*/u, "")
    .replace(/^(\*\*|__)(.+)\1$/u, "$2")
    .replace(/\s*[:：]$/u, "")
    .trim();

// 原则, 规则 or 方法 followed by its number or a separator: "方法论的定义" and "规则引擎" are not principles.
const NAMED_CANDIDATE = /^(?:原则|规则|方法)(?:\s*[一二三四五六七八九十\d]+\s*[:：、.)）-]?|\s*[:：、.)）-])\s*/u;

const candidateHeadingPattern =
  /^(?:(?:原则|规则|方法)(?:\s*[一二三四五六七八九十\d]+\s*[:：、.)）-]?|\s*[:：、.)）-])\s*\S.+|(?:\d+|[一二三四五六七八九十]+)[.、)）]\s*\S.+)$/u;

const sectionsFrom = (body: string): MarkdownSection[] => {
  const headings = headingsOf(body);
  return headings.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = headings[index + 1]?.index ?? body.length;
    return {
      heading: (match[2] ?? "").trim(),
      level: match[1]?.length ?? 1,
      content: body.slice(start, end),
    };
  });
};

const headingBlocksFrom = (body: string): MarkdownHeadingBlock[] => {
  const headings = headingsOf(body);
  return headings.map((match, index) => {
    const level = match[1]?.length ?? 1;
    const start = (match.index ?? 0) + match[0].length;
    const nextBoundary = headings
      .slice(index + 1)
      .find((candidate) => (candidate[1]?.length ?? 1) <= level)?.index;
    return {
      heading: (match[2] ?? "").trim(),
      level,
      content: body.slice(start, nextBoundary ?? body.length),
    };
  });
};

const matchingSection = (
  sections: MarkdownSection[],
  pattern: RegExp,
): string | null => {
  const section = sections.find((item) => pattern.test(fieldName(item.heading)));
  if (section === undefined) return null;
  const content = cleanMarkdownText(section.content);
  return content.length === 0 ? null : content;
};

const fallbackPrinciple = (body: string): string => {
  const fenced = fencedRanges(body);
  const withoutHeadings = body
    .replace(/^\s*#{1,6}\s+.*$/gmu, (line, offset: number) => (insideRanges(fenced, offset) ? line : ""))
    // A line of Obsidian tags ("#原则 #工程") files the note; it is not what the principle says.
    .replace(/^\s*(?:#[^\s#]+\s*)+$/gmu, (line, offset: number) => (insideRanges(fenced, offset) ? line : ""))
    .split(/\n\s*\n/gu)
    .map(cleanMarkdownText)
    .find((value) => value.length > 0);
  return withoutHeadings ?? "";
};

const structuredImport = (markdown: string): MethodologyRecord | null => {
  try {
    return parseMethodology(markdown);
  } catch (error) {
    if (/^type:\s*decision-methodology\s*$/mu.test(markdown)) {
      throw new Error(
        `Decision 方法论文件结构不完整：${noteProblem(
          error instanceof Error ? error.message : String(error),
        )}`,
      );
    }
    return null;
  }
};

const genericDraft = (
  source: MethodologyMarkdownSource,
  markdown: string,
): MethodologyMarkdownDraft => {
  const body = stripFrontmatter(markdown);
  const sections = sectionsFrom(body);
  const h1 = sections.find((section) => section.level === 1)?.heading;
  const fileTitle = basename(source.fileName, extname(source.fileName));
  const title = bounded(h1 ?? fileTitle, 120);
  const principle = bounded(
    matchingSection(
      sections,
      /^(?:(?:核心)?原则|方法|做法|规则)$/u,
    ) ?? fallbackPrinciple(body),
    2_000,
  );
  if (title.length === 0 || principle.length === 0) {
    throw new Error("没有识别到标题或原则正文。");
  }
  return {
    title,
    principle,
    appliesWhen: bounded(
      matchingSection(
        sections,
        /^(适用条件|适用场景|使用条件|何时使用|适用范围)$/u,
      ) ?? "待补充：说明这条原则适用的场景与前提。",
      2_000,
    ),
    caution: bounded(
      matchingSection(
        sections,
        /^(注意事项|边界|限制|例外|不适用场景|风险)$/u,
      ) ?? "待补充：说明不应套用这条原则的情况与风险。",
      2_000,
    ),
    evidenceSummary: bounded(
      matchingSection(
        sections,
        /^(证据摘要|证据|来源|依据|验证记录)$/u,
      ) ?? "从本地 Markdown 导入，尚未关联 Decision 中的复盘证据。",
      3_000,
    ),
    sourceDecisionIds: [],
  };
};

const splitCandidateBlocks = (body: string): MarkdownHeadingBlock[] => {
  const blocks = headingBlocksFrom(body).filter((block) => {
    if (fieldHeadingPattern.test(fieldName(block.heading))) return false;
    const hasNamedChild = sectionsFrom(block.content).some((section) =>
      fieldHeadingPattern.test(fieldName(section.heading)),
    );
    return (
      cleanMarkdownText(block.content).length > 0 &&
      (candidateHeadingPattern.test(block.heading) || hasNamedChild)
    );
  });
  const byLevel = new Map<number, MarkdownHeadingBlock[]>();
  for (const block of blocks) {
    const current = byLevel.get(block.level) ?? [];
    current.push(block);
    byLevel.set(block.level, current);
  }
  const level = [...byLevel.entries()]
    .filter(([, candidates]) => candidates.length >= 2)
    .sort(([left], [right]) => left - right)[0];
  return level?.[1] ?? [];
};

const candidateTitle = (heading: string): string =>
  heading
    .replace(/^(?:\d+|[一二三四五六七八九十]+)[.、)）]\s*/u, "")
    .replace(NAMED_CANDIDATE, "")
    .trim() || heading.trim();

export const parseMethodologyMarkdownDrafts = (
  source: MethodologyMarkdownSource,
): MethodologyMarkdownDraft[] => {
  const markdown = source.markdown.replace(/\r\n?/gu, "\n").trim();
  if (markdown.length === 0) {
    throw new Error("文件内容为空。");
  }
  const structured = structuredImport(markdown);
  if (structured !== null) {
    return [
      {
        title: structured.title,
        principle: structured.principle,
        appliesWhen: structured.appliesWhen,
        caution: structured.caution,
        evidenceSummary: structured.evidenceSummary,
        sourceDecisionIds: structured.sourceDecisionIds,
      },
    ];
  }
  const body = stripFrontmatter(markdown);
  const blocks = splitCandidateBlocks(body);
  if (blocks.length > MAX_DRAFTS_PER_FILE) {
    throw new Error(
      `单个文件最多拆分 ${MAX_DRAFTS_PER_FILE} 条原则，请先缩小导入范围。`,
    );
  }
  if (blocks.length >= 2) {
    return blocks.map((block) =>
      genericDraft(
        source,
        `# ${candidateTitle(block.heading)}\n${block.content}`,
      ),
    );
  }
  return [genericDraft(source, markdown)];
};

export const parseMethodologyMarkdownDraft = (
  source: MethodologyMarkdownSource,
): MethodologyMarkdownDraft => parseMethodologyMarkdownDrafts(source)[0]!;

export const readMethodologyMarkdownSources = async (
  paths: string[],
): Promise<MethodologyMarkdownReadResult> => {
  const uniquePaths = [...new Set(paths)];
  if (uniquePaths.length > MAX_IMPORT_FILES) {
    throw new Error(`一次最多导入 ${MAX_IMPORT_FILES} 个 Markdown 文件。`);
  }
  const result: MethodologyMarkdownReadResult = {
    sources: [],
    failures: [],
  };
  for (const path of uniquePaths) {
    const fileName = basename(path).slice(0, 240) || "未命名文件";
    try {
      const extension = extname(path).toLocaleLowerCase("en-US");
      if (extension !== ".md" && extension !== ".markdown") {
        throw new Error("只支持 .md 或 .markdown 文件。");
      }
      const details = await lstat(path);
      if (details.isSymbolicLink() || !details.isFile()) {
        throw new Error("只支持普通文件，不读取符号链接或目录。");
      }
      if (details.size > MAX_IMPORT_BYTES) {
        throw new Error("文件超过 512 KiB 限制。");
      }
      const buffer = await readFile(path);
      let markdown: string;
      try {
        markdown = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } catch {
        throw new Error("文件不是 UTF-8 编码（可能是 GBK 等旧编码），请在编辑器里另存为 UTF-8 后再导入。");
      }
      result.sources.push({ fileName, markdown });
    } catch (error) {
      result.failures.push({
        fileName,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
};
