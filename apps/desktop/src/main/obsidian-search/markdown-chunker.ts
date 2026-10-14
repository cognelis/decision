import { createHash } from "node:crypto";
import type { ObsidianVaultNote } from "@cognelis/decision-storage";

export interface ObsidianMarkdownChunk {
  id: string;
  ordinal: number;
  heading: string | null;
  text: string;
  embeddingText: string;
  contentHash: string;
}

export interface ObsidianMarkdownDocument {
  relativePath: string;
  title: string;
  contentHash: string;
  chunks: ObsidianMarkdownChunk[];
}

const TARGET_CHUNK_POINTS = 1200;
const CHUNK_OVERLAP_POINTS = 160;
const MAX_CHUNK_POINTS = 1800;
const MAX_EMBEDDING_POINTS = 4000;
const MAX_PUBLIC_TITLE_CODE_UNITS = 1000;
const MAX_TITLE_METADATA_POINTS = 300;
const MAX_PATH_METADATA_POINTS = 800;
const MAX_HEADING_METADATA_POINTS = 500;
const MAX_PUBLIC_HEADING_POINTS = 600;
const hash = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const EMPTY_DIGEST = hash("");
const points = (value: string): string[] => Array.from(value);
const fromPoints = (value: string[], start: number, end: number): string => value.slice(start, end).join("");
const bounded = (value: string, limit: number): string => {
  let result = "";
  let count = 0;
  for (const character of value) {
    if (count >= limit) break;
    result += character;
    count += 1;
  }
  return result;
};
const boundedCodeUnits = (value: string, limit: number): string => {
  const characters: string[] = [];
  let units = 0;
  for (const character of value) {
    if (units + character.length > limit) break;
    characters.push(character);
    units += character.length;
  }
  return characters.join("");
};
export const boundObsidianMetadata = bounded;
const oneLine = (value: string): string => value.replace(/\s+/gu, " ").trim();
const cleanScalar = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed || /^[\[{|>]/u.test(trimmed) || /^(?:-\s|-$|#)/u.test(trimmed)) return null;
  if (trimmed.startsWith("'")) {
    let end = -1;
    for (let index = 1; index < trimmed.length; index += 1) {
      if (trimmed[index] !== "'") continue;
      if (trimmed[index + 1] === "'") { index += 1; continue; }
      end = index;
      break;
    }
    if (end < 0 || !/^(?:\s*|\s+#.*)$/u.test(trimmed.slice(end + 1))) return null;
    return oneLine(trimmed.slice(1, end).replace(/''/gu, "'")) || null;
  }
  if (trimmed.startsWith("\"")) {
    let end = -1;
    for (let index = 1; index < trimmed.length; index += 1) {
      if (trimmed[index] === "\\") { index += 1; continue; }
      if (trimmed[index] === "\"") { end = index; break; }
    }
    if (end < 0 || !/^(?:\s*|\s+#.*)$/u.test(trimmed.slice(end + 1))) return null;
    try { return oneLine(JSON.parse(trimmed.slice(0, end + 1)) as string) || null; } catch { return null; }
  }
  return oneLine(trimmed.replace(/\s+#.*$/u, "")) || null;
};

interface Frontmatter {
  title: string | null;
  values: string[];
  body: string;
}

// The properties Obsidian keeps as lists of words a note is known by: written `[a, b]` or one `- a` per line.
const LIST_KEYS = new Set(["aliases", "alias", "tags", "tag"]);

const parseFrontmatter = (content: string): Frontmatter => {
  if (!content.startsWith("---\n")) return { title: null, values: [], body: content };
  const end = content.indexOf("\n---", 4);
  if (end < 0 || !["", "\n"].includes(content.slice(end + 4, end + 5))) return { title: null, values: [], body: content };
  const values: string[] = [];
  let title: string | null = null;
  // Under a list key with nothing after it: its `- item` lines. Dropped, with every aliases and tags written as a
  // list, and every property named in Chinese (负责人), a note was not found by any of them.
  let listing = false;
  for (const line of content.slice(4, end).split("\n")) {
    if (listing) {
      const item = /^\s*-\s+(.+?)\s*$/u.exec(line);
      if (item) {
        const value = cleanScalar(item[1]!);
        if (value) values.push(value);
        continue;
      }
      listing = false;
    }
    const match = /^(\s*)([\p{L}_][\p{L}\p{N}_-]*):\s*(.*?)\s*$/u.exec(line);
    if (!match || match[1]) continue;
    const listKey = LIST_KEYS.has(match[2]!.toLowerCase());
    if (!match[3]) {
      listing = listKey;
      continue;
    }
    if (listKey && match[3].startsWith("[") && match[3].endsWith("]")) {
      // Item by item, a quoted one whole: split at every comma, ["a, b", c] gave `"a` and `b"`, neither a word.
      for (const part of match[3].slice(1, -1).match(/\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,]+)/gu) ?? []) {
        const value = cleanScalar(part);
        if (value) values.push(value);
      }
      continue;
    }
    const value = cleanScalar(match[3]);
    if (!value) continue;
    values.push(value);
    if (match[2]!.toLowerCase() === "title") title = value;
  }
  return { title, values, body: content.slice(end + (content[end + 4] === "\n" ? 5 : 4)) };
};

const basename = (path: string): string => {
  const name = path.replace(/\\/gu, "/").split("/").pop() ?? path;
  return name.replace(/\.md$/iu, "") || path;
};

interface Fence { char: "`" | "~"; length: number; tail: string; }
const fenceMarker = (line: string): Fence | null => {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/u.exec(line);
  if (!match || (match[2]![0] === "`" && match[3]!.includes("`"))) return null;
  return { char: match[2]![0] as "`" | "~", length: match[2]!.length, tail: match[3]! };
};
const sameFence = (marker: Fence | null, opening: Fence): boolean =>
  marker?.char === opening.char && marker.length >= opening.length && /^[ \t]*$/u.test(marker.tail);

const atxHeading = (line: string): { level: number; title: string } | null => {
  const match = /^( {0,3})(#{1,6})[ \t]+(.+?)\s*$/u.exec(line);
  if (!match) return null;
  let title = match[3]!;
  title = title.replace(/[ \t]+#+[ \t]*$/u, "").trim();
  return title ? { level: match[2]!.length, title: oneLine(title) } : null;
};
const setextHeading = (lines: string[], underlineIndex: number): { level: number; title: string; start: number; end: number } | null => {
  const underline = lines[underlineIndex];
  const marker = underline === undefined ? null : /^( {0,3})(=+|-+)[ \t]*$/u.exec(underline);
  if (!marker) return null;
  const candidate = lines[underlineIndex - 1] ?? "";
  const continuationIndent = /^( *)\S/u.exec(candidate)?.[1]?.length ?? 0;
  if (continuationIndent > 0) {
    for (let probe = underlineIndex - 1; probe >= 0;) {
      const line = lines[probe]!;
      if (!line.trim()) { probe -= 1; continue; }
      const indent = /^( *)\S/u.exec(line)?.[1]?.length ?? 0;
      if (indent >= continuationIndent) { probe -= 1; continue; }
      if (/^( {0,3})(?:[-+*]\s+|\d+[.)]\s+|>\s*)/u.test(line)) return null;
      break;
    }
  }
  let start = underlineIndex - 1;
  let container = false;
  while (start >= 0) {
    const line = lines[start]!;
    if (/^( {0,3})(?:[-+*]\s+|\d+[.)]\s+|>\s*)/u.test(line)) container = true;
    if (!line.trim() || !/^ {0,3}\S/u.test(line) || fenceMarker(line) || atxHeading(line) || /^( {0,3})(=+|-+)[ \t]*$/u.test(line)) break;
    start -= 1;
  }
  if (container) return null;
  start += 1;
  if (start >= underlineIndex) return null;
  for (let index = start - 1; index >= 0 && !lines[index]!.trim(); index -= 1) {
    if (index > 0 && /^( {0,3})(?:[-+*]\s+|\d+[.)]\s+|>\s*)/u.test(lines[index - 1]!)) return null;
  }
  const titleLines = lines.slice(start, underlineIndex);
  if (titleLines.some((line) => /^(?: {0,3})(?:[-*_][ \t]*){3,}$/u.test(line) || /^( {0,3})(?:[-+*]\s+|\d+[.)]\s+|>\s*)/u.test(line))) return null;
  const title = oneLine(titleLines.map((line) => line.trim()).join(" "));
  return title ? { level: marker[2]![0] === "=" ? 1 : 2, title, start, end: underlineIndex } : null;
};

const firstH1 = (content: string): string | null => {
  let opening: Fence | null = null;
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const marker = fenceMarker(line);
    if (opening) { if (sameFence(marker, opening)) opening = null; continue; }
    if (marker) { opening = marker; continue; }
    if (!opening) {
      const match = atxHeading(line);
      if (match?.level === 1) return match.title;
      const setext = setextHeading(lines, index);
      if (setext?.level === 1) return setext.title;
    }
  }
  return null;
};

interface HeadingEntry { title: string; digest: string; }
interface Section { heading: string | null; headingDigest: string; lines: string[]; }
const suffixBounded = (value: string, limit: number): string => {
  const chars: string[] = [];
  for (let index = value.length - 1; index >= 0 && chars.length < limit;) {
    const unit = value.charCodeAt(index);
    const startsPair = unit >= 0xdc00 && unit <= 0xdfff && index > 0 && value.charCodeAt(index - 1) >= 0xd800 && value.charCodeAt(index - 1) <= 0xdbff;
    const code = value.codePointAt(startsPair ? index - 1 : index)!;
    const character = String.fromCodePoint(code);
    chars.push(character);
    index -= startsPair ? 2 : 1;
  }
  return chars.reverse().join("");
};
const breadcrumb = (stack: HeadingEntry[]): string => {
  const estimated = stack.reduce((total, entry) => total + entry.title.length + 3, -3);
  if (estimated <= MAX_PUBLIC_HEADING_POINTS) return stack.map((entry) => entry.title).join(" > ");
  const root = bounded(stack[0]!.title, Math.floor((MAX_PUBLIC_HEADING_POINTS - 1) / 2));
  const leaf = suffixBounded(stack[stack.length - 1]!.title, MAX_PUBLIC_HEADING_POINTS - root.length - 1);
  return `${root}…${leaf}`;
};

const sections = (body: string): Section[] => {
  const result: Section[] = [];
  const stack: Array<HeadingEntry & { level: number }> = [];
  let current: Section = { heading: null, headingDigest: EMPTY_DIGEST, lines: [] };
  let opening: Fence | null = null;
  const flush = (): void => { if (current.lines.length) result.push(current); current = { heading: stack.length ? breadcrumb(stack) : null, headingDigest: stack.length ? stack[stack.length - 1]!.digest : EMPTY_DIGEST, lines: [] }; };
  const lines = body.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const marker = fenceMarker(line);
    if (opening) { current.lines.push(line); if (sameFence(marker, opening)) opening = null; continue; }
    if (marker) { opening = marker; current.lines.push(line); continue; }
    const atx = atxHeading(line);
    const setext = atx ? null : setextHeading(lines, index);
    const match = atx ? { ...atx, start: index, end: index } : setext;
    if (!opening && match) {
      if (match.end > match.start) current.lines.splice(- (match.end - match.start), match.end - match.start);
      // A heading with no text of its own, which this one replaces (a sibling, not a child that names it in its
      // breadcrumb): kept as a chunk of its title. Dropped, "## 招聘冻结" followed by "## 预算" was in no chunk.
      // Blank lines are no text of its own: counted as some, the heading with a blank line under it (as most are
      // written) was dropped still.
      const top = stack[stack.length - 1];
      if (current.lines.every((text) => !text.trim()) && current.heading !== null && top !== undefined && top.level >= match.level) current.lines.push(top.title);
      flush();
      const level = match.level;
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      const parentDigest = stack.length ? stack[stack.length - 1]!.digest : EMPTY_DIGEST;
      stack.push({ level, title: match.title, digest: hash(`heading\0${parentDigest}\0${match.title}`) });
      current = { heading: breadcrumb(stack), headingDigest: stack[stack.length - 1]!.digest, lines: [] };
      index = match.end;
    } else current.lines.push(line);
  }
  // The note's last heading, with nothing after it, as one another replaces; a note of headings alone keeps its
  // one fallback chunk (its title and path).
  const last = stack[stack.length - 1];
  if (current.lines.every((text) => !text.trim()) && current.heading !== null && last !== undefined && result.length > 0) current.lines.push(last.title);
  flush();
  return result;
};

const splitText = (raw: string): string[] => {
  const normalized = raw.replace(/[ \t]+\n/gu, "\n").trim();
  if (!normalized) return [];
  const paragraphs = normalized.split(/\n{2,}/u).map((part) => part.trim()).filter(Boolean);
  const output: string[] = [];
  let pending = "";
  const append = (value: string): void => {
    const candidate = pending ? `${pending}\n\n${value}` : value;
    if (points(candidate).length <= TARGET_CHUNK_POINTS) { pending = candidate; return; }
    if (pending) output.push(pending);
    pending = value;
  };
  for (const paragraph of paragraphs) {
    const chars = points(paragraph);
    if (chars.length <= TARGET_CHUNK_POINTS) { append(paragraph); continue; }
    if (pending) { output.push(pending); pending = ""; }
    let start = 0;
    while (start < chars.length) {
      const end = Math.min(start + TARGET_CHUNK_POINTS, chars.length);
      output.push(fromPoints(chars, start, end));
      if (end === chars.length) break;
      start = end - CHUNK_OVERLAP_POINTS;
    }
  }
  if (pending) output.push(pending);
  return output;
};

export const buildObsidianMarkdownDocument = (note: ObsidianVaultNote): ObsidianMarkdownDocument => {
  const content = note.content.replace(/\r\n?/gu, "\n");
  const frontmatter = parseFrontmatter(content);
  const title = boundedCodeUnits(
    oneLine(frontmatter.title ?? firstH1(frontmatter.body) ?? basename(note.relativePath)),
    MAX_PUBLIC_TITLE_CODE_UNITS,
  );
  const scalarText = frontmatter.values.join("\n");
  const body = scalarText ? `${scalarText}\n\n${frontmatter.body}` : frontmatter.body;
  const parsedSections = sections(body);
  const rawChunks: Array<{ heading: string | null; headingDigest: string; text: string }> = [];
  for (const section of parsedSections) for (const text of splitText(section.lines.join("\n"))) rawChunks.push({ heading: section.heading, headingDigest: section.headingDigest, text });
  if (!rawChunks.length) {
    const fallback = bounded(`${title}\n${note.relativePath}`, MAX_CHUNK_POINTS);
    if (fallback) rawChunks.push({ heading: null, headingDigest: EMPTY_DIGEST, text: fallback });
  }
  const titleMetadata = bounded(title, MAX_TITLE_METADATA_POINTS);
  const pathMetadata = bounded(note.relativePath, MAX_PATH_METADATA_POINTS);
  const headingMetadataCache = new Map<string, string>();
  const titleDigest = hash(title);
  const pathDigest = hash(note.relativePath);
  const chunks = rawChunks.map(({ heading, headingDigest, text }, ordinal) => {
    const headingMetadata = heading ? (headingMetadataCache.get(heading) ?? (() => {
      const value = bounded(heading, MAX_HEADING_METADATA_POINTS);
      headingMetadataCache.set(heading, value);
      return value;
    })()) : null;
    const prefix = `Title: ${titleMetadata}\nPath: ${pathMetadata}${headingMetadata ? `\nSection: ${headingMetadata}` : ""}\n`;
    const embeddingText = `${prefix}${bounded(text, Math.max(0, MAX_EMBEDDING_POINTS - points(prefix).length))}`;
    return { id: hash(`${note.relativePath}\0${ordinal}`), ordinal, heading, text, embeddingText, contentHash: hash(`chunk\0${titleDigest}\0${pathDigest}\0${headingDigest}\0${text}`) };
  });
  return { relativePath: note.relativePath, title, contentHash: note.contentHash, chunks };
};
