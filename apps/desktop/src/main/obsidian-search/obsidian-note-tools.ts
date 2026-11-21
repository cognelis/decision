import {
  OBSIDIAN_NOTE_MAX_TEXT,
  obsidianNoteReadRequestSchema,
  obsidianNoteSearchRequestSchema,
  type ObsidianNoteReadRequest,
  type ObsidianNoteReadResponse,
  type ObsidianNoteSearchRequest,
  type ObsidianNoteSearchResponse,
  type ObsidianNoteSearchResult,
} from "@cognelis/decision-protocol";
import { foldedText, searchTokens } from "@cognelis/decision-storage";

import type { ObsidianSearchStatus } from "../../shared/obsidian-search.js";
import { obsidianNoteHeadings } from "./markdown-chunker.js";
import type { ObsidianSearchRuntime } from "./obsidian-search-runtime.js";

type NoteRuntime = Pick<ObsidianSearchRuntime, "search" | "status" | "readIndexedNote">;

// Fixed words only: nothing of the reader's (no path, no query) is said in a message.
const UNAVAILABLE = "Obsidian 笔记索引现在不可用，没有检索；这不代表没有相关笔记。";
const NOT_BUILT = "Obsidian 笔记索引还没有建好，结果可能不全；这不代表没有相关笔记。";
const INDEXING = "Obsidian 笔记索引正在更新，结果可能不全。";
const MISSED = "有的笔记没能建立索引，结果可能不全。";
const DROPPED = "有命中的笔记现在读不到了（刚被删除、排除或改成了链接），已从结果里去掉。";
const SEMANTIC_OFF = "本地语义检索不可用，只按关键词检索。";
const READ_UNAVAILABLE = "Obsidian 笔记索引现在不可用，没有读取。";
const NOT_AVAILABLE = "这个路径不是可检索的普通笔记（不存在、被排除、在隐藏或 Decision Journal 文件夹里、是链接、过大，或尚未建立索引），没有读取。";

const coverageProblems = (status: ObsidianSearchStatus): string[] => [
  ...(status.synchronizedAt === null && status.indexedNotes === 0 ? [NOT_BUILT] : []),
  ...(status.state === "indexing" || status.state === "error" || status.indexedNotes < status.discoveredNotes ? [INDEXING] : []),
  ...(status.failedNotes > 0 || status.skippedNotes > 0 ? [MISSED] : []),
];

// Broken as the chunker breaks them, so a heading's line number is the line read here.
const linesOf = (content: string): string[] => {
  const lines = content.replace(/\r\n?/gu, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

/**
 * The 1-based line a hit is at. Under a heading: the first line of that heading's own section (up to the next heading
 * of its level or above) with a word of the query, else the heading itself; a word only in a later section is not
 * this hit's. With no heading, the first such line in the note. Null if none, or if the heading cannot be told apart:
 * not in the note as it is now, or named twice (the same path) with the words in neither or both.
 */
export const lineOfMatch = (content: string, heading: string | null, query: string): number | null => {
  const lines = linesOf(content);
  const terms = [...new Set(searchTokens(query).map((term) => foldedText(term)))].filter((term) => term.length > 0);
  const firstWith = (from: number, to: number): number | null => {
    for (let index = from; index < to; index += 1) {
      const line = foldedText(lines[index]!);
      if (terms.some((term) => line.includes(term))) return index + 1;
    }
    return null;
  };
  if (heading === null) return firstWith(0, lines.length);
  // The chunker's own headings, so a "## Verdict" inside a code fence is not taken for the one the index named.
  const headings = obsidianNoteHeadings(content);
  const sections = headings.flatMap((found, at) => {
    if (found.path !== heading) return [];
    // A subsection stays in its parent's section; the next heading of its level or above ends it.
    let next = at + 1;
    while (next < headings.length && headings[next]!.level > found.level) next += 1;
    return [{ heading: found.line, hit: firstWith(found.line - 1, next < headings.length ? headings[next]!.line - 1 : lines.length) }];
  });
  if (sections.length === 1) return sections[0]!.hit ?? sections[0]!.heading;
  const withWords = sections.filter((section) => section.hit !== null);
  return withWords.length === 1 ? withWords[0]!.hit : null;
};

export const searchObsidianNotes = async (runtime: NoteRuntime, input: ObsidianNoteSearchRequest): Promise<ObsidianNoteSearchResponse> => {
  const request = obsidianNoteSearchRequestSchema.parse(input);
  const unavailable = (status: ObsidianSearchStatus): ObsidianNoteSearchResponse => ({
    availability: "unavailable",
    semanticAvailable: false,
    indexedNotes: status.indexedNotes,
    discoveredNotes: status.discoveredNotes,
    projectScope: "none",
    message: UNAVAILABLE,
    results: [],
  });
  let response: Awaited<ReturnType<NoteRuntime["search"]>>;
  try {
    response = await runtime.search({ query: request.query, limit: request.limit });
  } catch {
    return unavailable(runtime.status());
  }
  const { status } = response;
  // The runtime that is off answers every search with none, in an error state with nothing indexed.
  if (status.state === "error" && status.indexedNotes === 0) return unavailable(status);
  const problems = coverageProblems(status);
  const results: ObsidianNoteSearchResult[] = [];
  let dropped = false;
  for (const hit of response.results) {
    // Read again now, through the same checks a read makes: a note excluded, deleted or made a link since it was
    // indexed is not shown from the index's copy of it.
    const read = await runtime.readIndexedNote(hit.relativePath).catch(() => null);
    if (read === null) {
      dropped = true;
      continue;
    }
    results.push({
      path: hit.relativePath,
      title: hit.title,
      heading: hit.heading,
      snippet: hit.snippet,
      matchKind: hit.matchKind,
      line: lineOfMatch(read.note.content, hit.heading, request.query),
      contentHash: read.note.contentHash,
      changedSinceIndexed: read.changedSinceIndexed,
    });
  }
  if (dropped) problems.push(DROPPED);
  if (!status.semanticAvailable) problems.push(SEMANTIC_OFF);
  return {
    availability: problems.some((problem) => problem !== SEMANTIC_OFF) ? "partial" : "ready",
    semanticAvailable: status.semanticAvailable,
    indexedNotes: status.indexedNotes,
    discoveredNotes: status.discoveredNotes,
    projectScope: "none",
    message: problems.join(""),
    results,
  };
};

/** A cut inside a line that does not split a surrogate pair. */
const cutAt = (text: string, at: number): number =>
  at > 0 && at < text.length && /[\uD800-\uDBFF]/u.test(text[at - 1]!) ? at - 1 : at;

export const readObsidianNote = async (runtime: NoteRuntime, input: ObsidianNoteReadRequest): Promise<ObsidianNoteReadResponse> => {
  const request = obsidianNoteReadRequestSchema.parse(input);
  const base = { path: request.path, projectScope: "none" as const };
  let read: Awaited<ReturnType<NoteRuntime["readIndexedNote"]>>;
  try {
    read = await runtime.readIndexedNote(request.path);
  } catch {
    return { ...base, status: "unavailable", message: READ_UNAVAILABLE, note: null };
  }
  if (read === null) return { ...base, status: "not_available", message: NOT_AVAILABLE, note: null };
  const lines = linesOf(read.note.content);
  const pieces: string[] = [];
  let used = 0;
  let endLine = request.startLine - 1;
  let next: { line: number; column: number } | null = null;
  for (let index = request.startLine - 1; index < lines.length; index += 1) {
    const column = index === request.startLine - 1 ? Math.min(request.startColumn, lines[index]!.length) : 0;
    if (index - (request.startLine - 1) >= request.maxLines) {
      next = { line: index + 1, column: 0 };
      break;
    }
    const piece = lines[index]!.slice(column);
    const separator = pieces.length === 0 ? 0 : 1;
    if (used + separator + piece.length <= OBSIDIAN_NOTE_MAX_TEXT) {
      pieces.push(piece);
      used += separator + piece.length;
      endLine = index + 1;
      continue;
    }
    // A line longer than what is left: as much of it as fits, the rest to go on from in the same line. The first
    // line always gives something, so a line longer than a whole read is read through in turns, never skipped.
    const fits = cutAt(piece, OBSIDIAN_NOTE_MAX_TEXT - used - separator);
    if (fits > 0) {
      pieces.push(piece.slice(0, fits));
      endLine = index + 1;
    }
    next = { line: index + 1, column: column + Math.max(fits, 0) };
    break;
  }
  const truncated = next !== null;
  return {
    ...base,
    status: "ok",
    message: truncated
      ? `只读到第 ${endLine} 行${next!.column > 0 ? "的一部分" : ""}；从 startLine ${next!.line}${next!.column > 0 ? `、startColumn ${next!.column}` : ""} 继续读。`
      : request.startLine > lines.length && lines.length > 0 ? "起始行超过了笔记末尾。" : "",
    note: {
      title: read.title,
      contentHash: read.note.contentHash,
      changedSinceIndexed: read.changedSinceIndexed,
      totalLines: lines.length,
      startLine: request.startLine,
      startColumn: Math.min(request.startColumn, lines[request.startLine - 1]?.length ?? 0),
      endLine: Math.max(endLine, 0),
      truncated,
      nextStartLine: next?.line ?? null,
      nextStartColumn: next?.column ?? null,
      text: pieces.join("\n"),
    },
  };
};
