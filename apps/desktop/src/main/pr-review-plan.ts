import { prReviewFileOverhead, prReviewOrder } from "@cognelis/decision-protocol";
import type { DiffLine } from "./pr-review-diff.js";

// The review order and what counts as a test are shared with the page, which counts a selection's groups with them.
export { isPrReviewTestPath as isTestPath, prReviewOrder as reviewOrder } from "@cognelis/decision-protocol";
const reviewOrder = prReviewOrder;

/** A diff line as every prompt shows it: old and new line numbers, then the line with its +/-/space. */
export const renderDiffLine = (line: DiffLine): string => `${line.old ?? "-"}/${line.new ?? "-"} ${line.text}`;
// As the prompt's JSON holds it, line break included: a quote, a backslash or a tab counts twice, a control character
// six times. Counted raw, a group of JSON-in-JSON or a colored log ran past the prompt's limit and was not reviewed.
const lineSize = (line: DiffLine): number => JSON.stringify(renderDiffLine(line)).length - 1;

/**
 * Longest prefix whose JSON encoding fits the room, found by halving: shortened a character at a time, a
 * file of quotes (each escaped to two characters) held the main process for seconds. Never half a pair.
 */
export const fitJson = (text: string, room: number): string => {
  if (JSON.stringify(text).length <= room) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (JSON.stringify(text.slice(0, middle)).length <= room) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low).replace(/[\uD800-\uDBFF]$/, "");
};

/**
 * A line no group can hold (a minified bundle, a data blob): its head as fits, saying how much is left out, as Claude
 * Code's Read cuts a long line. Sent whole, its group was over the prompt's limit and failed without a model call.
 */
const clipLine = (line: DiffLine, room: number): DiffLine => {
  // Where it was cut said as well as how much is left: a verifier reads on from there (from=K), it could not count it.
  const note = (given: number, left: number) => `…（本行过长，只给出前 ${given} 字符，另有 ${left} 字符未给出）`;
  const kept = fitJson(line.text, room + 1 - lineSize({ ...line, text: note(line.text.length, line.text.length) }));
  return { ...line, text: kept + note(kept.length, line.text.length - kept.length), clipped: true };
};
/** The line as it fits `room` in a prompt's JSON: itself, or cut as clipLine cuts it. */
export const fitLine = (line: DiffLine, room: number): DiffLine => lineSize(line) > room ? clipLine(line, room) : line;
export const diffSize = (lines: DiffLine[]): number => lines.reduce((sum, line) => sum + lineSize(line), 0);
/** A file's place in a group's prompt, as the review page's estimate of the groups counts it too. */
const fileOverhead = prReviewFileOverhead;


/** Where a new hunk starts: a jump in either side's line numbers. */
export function splitHunks(lines: DiffLine[]): DiffLine[][] {
  const hunks: DiffLine[][] = [];
  let lastOld: number | null = null, lastNew: number | null = null;
  for (const line of lines) {
    const jump = (line.old !== null && lastOld !== null && line.old !== lastOld + 1) || (line.new !== null && lastNew !== null && line.new !== lastNew + 1);
    if (!hunks.length || jump) hunks.push([]);
    hunks.at(-1)!.push(line);
    if (line.old !== null) lastOld = line.old;
    if (line.new !== null) lastNew = line.new;
  }
  return hunks;
}

/**
 * The whole PR's diff in about `budget` characters. When all of it fits it is all there; when not, every file keeps
 * a fair share from its top (small files whole, what they leave to the large ones) and says how much it left out, so
 * an overview still sees every file — PR-Agent's compression, spread over the files instead of dropping the last ones.
 */
export function diffDigest(files: Array<{ path: string; lines: DiffLine[] }>, budget: number): { text: string; complete: boolean } {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const size = new Map(files.map((file) => [file.path, diffSize(file.lines)]));
  const ordered = reviewOrder(files.map((file) => file.path)).map((path) => byPath.get(path)!).filter((file) => file.lines.length);
  const head = (path: string) => `### ${path}\n`;
  const total = ordered.reduce((sum, file) => sum + head(file.path).length + size.get(file.path)!, 0);
  if (total <= budget) return { text: ordered.map((file) => head(file.path) + file.lines.map(renderDiffLine).join("\n")).join("\n"), complete: true };
  // More files than the budget gives a few lines each (a PR of thousands): the first in review order, and how many
  // others. Every one named, the digest ran far past its budget with not a line of diff left in it.
  let reserved = 0;
  const cut = ordered.findIndex((file) => (reserved += head(file.path).length + 240) > budget);
  const named = cut < 0 ? ordered : ordered.slice(0, cut);
  const share = new Map<string, number>();
  let room = budget - named.reduce((sum, file) => sum + head(file.path).length + 40, 0);
  const bySize = [...named].sort((a, b) => size.get(a.path)! - size.get(b.path)!);
  bySize.forEach((file, index) => {
    const fair = Math.max(0, Math.floor(room / (bySize.length - index)));
    const given = Math.min(size.get(file.path)!, fair);
    share.set(file.path, given); room -= given;
  });
  const unnamed = ordered.length - named.length;
  const text = [...named.map((file) => {
    const shown: string[] = [];
    let used = 0;
    for (const line of file.lines) {
      const rendered = renderDiffLine(line);
      if (used + rendered.length + 1 > share.get(file.path)!) break;
      shown.push(rendered); used += rendered.length + 1;
    }
    const left = file.lines.length - shown.length;
    return head(file.path) + [...shown, ...(left ? [`…（本文件另有 ${left} 行 diff 未列出）`] : [])].join("\n");
  }), ...(unnamed ? [`…（另有 ${unnamed} 个文件的 diff 未列出）`] : [])].join("\n");
  return { text, complete: false };
}

/** The diff lines within `radius` lines of any of the targets, in order: what a finding is about, and around it. */
export function excerptAround(lines: DiffLine[], targets: Array<{ side: "old" | "new"; line: number }>, radius: number): DiffLine[] {
  const hits = lines.map((line, index) => targets.some((target) => line[target.side] === target.line) ? index : -1).filter((index) => index >= 0);
  return lines.filter((_line, index) => hits.some((hit) => Math.abs(hit - index) <= radius));
}

const titleKey = (title: string) => title.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
/**
 * One finding per problem: two groups (or a group that read another's diff) raising the same title on the same side
 * of a file within three lines are one problem; the more severe word, and every decision either cites, stands.
 */
export function dedupeFindings<T extends { priority: "P1" | "P2" | "P3"; title: string; path: string; side: "old" | "new"; line: number; decisionIndexes: number[] }>(findings: T[]): T[] {
  const kept: T[] = [];
  for (const finding of findings) {
    const index = kept.findIndex((item) => item.path === finding.path && item.side === finding.side && Math.abs(item.line - finding.line) <= 3
      && (titleKey(item.title) === titleKey(finding.title) || titleKey(item.title).includes(titleKey(finding.title)) || titleKey(finding.title).includes(titleKey(item.title))));
    if (index < 0) { kept.push(finding); continue; }
    const twin = kept[index]!;
    const decisionIndexes = [...new Set([...twin.decisionIndexes, ...finding.decisionIndexes])].slice(0, 5);
    kept[index] = { ...(finding.priority < twin.priority ? finding : twin), decisionIndexes };
  }
  return kept;
}

/**
 * A line that opens a function, method, class or type in the usual languages: where a hunk's context reaches up to.
 * A method is a name, its parameters and a brace; `if (…) {` and the like have the same shape and are not one.
 */
const HEADER = /^\s*(?:export\s+)?(?:default\s+)?(?:(?:public|private|protected|internal|static|async|abstract|override|final|pub(?:\([\w:]+\))?|unsafe|extern)\s+)*(?:function\b|class\b|interface\b|struct\b|enum\b|trait\b|impl\b|def\b|fn\b|func\b|type\s+\w+|(?:const|let|var)\s+[\w$]+\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[\w$]+\s*=>)|(?:get\s+|set\s+)?(?!(?:if|for|while|switch|catch|with|return|typeof|await|else)\b)[\w$]+\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$)/u;

/**
 * pr-agent's dynamic context: each hunk with a few of the file's own lines around it, as unchanged lines — `before`
 * above, and further up (at most `reach` more) to the function or class the hunk sits in, `after` below — never into a
 * neighbouring hunk. `source` is the file at the new side; a hunk with no new side (a deletion) keeps its diff alone,
 * as does a hunk whose context would take more than what is left of `room` diff characters.
 */
export function withContext(lines: DiffLine[], source: string[], { before = 3, after = 1, reach = 10, room = Number.POSITIVE_INFINITY } = {}): DiffLine[] {
  const hunks = splitHunks(lines);
  const firstNew = (hunk: DiffLine[]) => hunk.find((line) => line.new !== null)?.new ?? null;
  const lastNew = (hunk: DiffLine[]) => [...hunk].reverse().find((line) => line.new !== null)?.new ?? null;
  const context = (at: number, offset: number | null): DiffLine => ({ text: ` ${source[at - 1] ?? ""}`, old: offset === null ? null : at + offset, new: at, changed: false });
  const result: DiffLine[] = [];
  let covered = 0;
  hunks.forEach((hunk, index) => {
    const top = firstNew(hunk), bottom = lastNew(hunk);
    if (top === null || bottom === null) { result.push(...hunk); return; }
    const firstOld = hunk.find((line) => line.old !== null)?.old ?? null;
    const lastOld = [...hunk].reverse().find((line) => line.old !== null)?.old ?? null;
    let start = Math.max(covered + 1, top - before);
    for (let at = start - 1; at >= Math.max(covered + 1, start - reach); at--) {
      if (HEADER.test(source[at - 1] ?? "")) { start = at; break; }
    }
    const next = hunks.slice(index + 1).map(firstNew).find((line) => line !== null) ?? Number.POSITIVE_INFINITY;
    const end = Math.min(bottom + after, next - 1, source.length);
    const above: DiffLine[] = [], below: DiffLine[] = [];
    for (let at = start; at < top; at++) above.push(context(at, firstOld === null ? null : firstOld - top));
    for (let at = bottom + 1; at <= end; at++) below.push(context(at, lastOld === null ? null : lastOld - bottom));
    const size = diffSize([...above, ...below]);
    if (size > room) { result.push(...hunk); covered = Math.max(covered, bottom); return; }
    room -= size;
    result.push(...above, ...hunk, ...below);
    covered = Math.max(covered, end, bottom);
  });
  return result;
}

export interface ReviewSegment {
  path: string;
  lines: DiffLine[];
  /** Which piece of a file too large for one group this is. */
  part?: { index: number; total: number };
}
export interface ReviewUnit { segments: ReviewSegment[]; size: number }

/**
 * Review groups of at most `unitChars` diff characters. Whole files go together while they fit — a small PR is
 * one group, read whole, as PR-Agent and Claude Code read it — and a file larger than a group is cut between
 * hunks (inside a hunk only when one hunk alone is too large), its last piece sharing a group with what follows.
 */
export function planReviewUnits(files: Array<{ path: string; lines: DiffLine[] }>, unitChars: number): ReviewUnit[] {
  const byPath = new Map(files.map((file) => [file.path, file.lines]));
  const units: ReviewUnit[] = [];
  let current: ReviewUnit = { segments: [], size: 0 };
  const flush = () => { if (current.segments.length) units.push(current); current = { segments: [], size: 0 }; };
  for (const path of reviewOrder([...byPath.keys()])) {
    const lines = byPath.get(path)!;
    if (!lines.length) continue;
    const size = diffSize(lines) + fileOverhead(path);
    if (current.size + size <= unitChars) { current.segments.push({ path, lines }); current.size += size; continue; }
    flush();
    if (size <= unitChars) { current = { segments: [{ path, lines }], size }; continue; }
    const pieces: DiffLine[][] = [];
    const room = unitChars - fileOverhead(path);
    let piece: DiffLine[] = [], pieceSize = 0;
    const cut = () => { if (piece.length) pieces.push(piece); piece = []; pieceSize = 0; };
    for (const hunk of splitHunks(lines)) {
      const hunkSize = diffSize(hunk);
      if (pieceSize + hunkSize > room) cut();
      if (hunkSize <= room) { piece.push(...hunk); pieceSize += hunkSize; continue; }
      for (const line of hunk) {
        if (pieceSize + lineSize(line) > room) cut();
        const fitted = lineSize(line) > room ? clipLine(line, room) : line;
        piece.push(fitted); pieceSize += lineSize(fitted);
      }
    }
    cut();
    pieces.forEach((lines, index) => {
      const unit = { segments: [{ path, lines, part: { index: index + 1, total: pieces.length } }], size: diffSize(lines) + fileOverhead(path) };
      if (index < pieces.length - 1) units.push(unit);
      else current = unit;
    });
  }
  flush();
  return units;
}
