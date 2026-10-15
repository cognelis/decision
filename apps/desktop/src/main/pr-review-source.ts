import { z } from "zod";
import { repositoryRelativePathSchema } from "@cognelis/decision-protocol";
import { PrPlatformError, type PrDetails, type PrReviewClient } from "./pr-platform-client.js";
import { fitJson } from "./pr-review-plan.js";

export const sourceActionSchema = z.object({
  action: z.enum(["find_files", "search_code", "read_file"]),
  path: repositoryRelativePathSchema.optional(),
  query: z.string().min(1).max(500).optional(),
  side: z.enum(["old", "new"]).optional(),
  offset: z.number().int().min(0).max(20_000).optional(),
  startLine: z.number().int().min(1).max(1_000_000).optional(),
  endLine: z.number().int().min(1).max(1_000_000).optional(),
}).strict();
export type SourceAction = z.infer<typeof sourceActionSchema>;
export interface PrSourceEvidence { path: string; side: "old" | "new"; commit: string; startLine: number; text: string; truncated: boolean }

const SOURCE_FILE = /(?:\.(?:[cm]?[jt]sx?|py|go|rs|java|kts?|swift|rb|php|cs|c|cc|cpp|h|hpp|mm?|scala|vue|svelte|dart|lua|exs?|clj|hs|sql|sh|bash|zsh|json|ya?ml|toml|xml|md|html|css|scss|graphql|proto|properties|ini|conf)|(?:^|\/)(?:Dockerfile|Makefile))$/iu;
const GENERATED = /(?:^|\/)(?:node_modules|vendor|dist|build|\.git)(?:\/|$)|(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock)$|\.min\.[jc]ss?$/u;
const scoped = (path: string, scope?: string) => !scope || path === scope || path.startsWith(`${scope}/`);

/** A bounded page of literal search, always over the same commit as the review, never a default-branch index. */
export async function readReviewSource(client: PrReviewClient, pr: PrDetails, input: SourceAction, signal: AbortSignal, room = 12_000): Promise<{
  evidence: PrSourceEvidence[];
  result: Record<string, unknown>;
}> {
  const args = sourceActionSchema.parse(input);
  signal.throwIfAborted();
  const side = args.side ?? "new";
  const commit = side === "old" ? pr.base ?? pr.destination.commit : pr.source.commit;
  if (args.action === "read_file") {
    const path = repositoryRelativePathSchema.parse(args.path);
    const start = args.startLine ?? 1, end = args.endLine ?? start + 79;
    if (end < start || end - start >= 400) throw new Error("一次读取 1–400 行，endLine 不得早于 startLine。");
    const text = side === "new" && args.endLine === undefined
      ? await client.readFile(pr, path, start, signal)
      : (await client.readFileContent(pr, path, side, signal)).split("\n").slice(start - 1, end).join("\n");
    if (text.includes("\0") || text.includes("\uFFFD")) throw new Error("文件不是可读取的 UTF-8 源码。");
    const fitted = fitJson(text, Math.max(2, room - JSON.stringify({ path, side, commit, startLine: start }).length - 200));
    const excerpt: PrSourceEvidence = { path, side, commit, startLine: start, text: fitted, truncated: fitted !== text };
    return { evidence: [excerpt], result: { ...excerpt, requestedEndLine: end, nextLine: excerpt.truncated ? start + excerpt.text.split("\n").length - 1 : end + 1 } };
  }
  if (!client.repositoryFiles) return { evidence: [], result: { available: false, complete: false, reason: "当前来源不支持固定提交的仓库文件搜索。" } };
  const query = z.string().min(1).max(500).parse(args.query);
  const inventory = await client.repositoryFiles(pr, side, signal);
  const paths = inventory.paths.filter((path) => scoped(path, args.path));
  const offset = args.offset ?? 0;
  if (args.action === "find_files") {
    const matches = paths.filter((path) => path.toLowerCase().includes(query.toLowerCase()));
    let end = Math.min(offset + 100, matches.length);
    while (end > offset + 1 && JSON.stringify(matches.slice(offset, end)).length > room - 300) end--;
    return { evidence: [], result: { side, commit, paths: matches.slice(offset, end), total: matches.length,
      nextOffset: end < matches.length ? end : null, complete: inventory.complete, inventoryComplete: inventory.complete } };
  }
  const searchable = paths.filter((path) => SOURCE_FILE.test(path) && !GENERATED.test(path));
  const evidence: PrSourceEvidence[] = [], unread: Array<{ path: string; reason: string }> = [];
  let end = Math.min(offset + 60, searchable.length);
  // shortcut: scan bounded file pages through the platform, add a local fixed-revision index if network cost dominates.
  for (let index = offset; index < end; index++) {
    if (evidence.length >= 20) { end = index; break; }
    signal.throwIfAborted();
    const path = searchable[index]!;
    let text: string;
    try { text = await client.readFileContent(pr, path, side, signal); }
    catch (error) {
      if (signal.aborted || (error instanceof PrPlatformError && [401, 403, 429].includes(error.status))) throw error;
      unread.push({ path, reason: error instanceof Error ? error.message.slice(0, 200) : "读取失败" });
      continue;
    }
    if (text.includes("\0") || text.includes("\uFFFD")) { unread.push({ path, reason: "非 UTF-8 文本" }); continue; }
    const lines = text.split("\n");
    const matches: PrSourceEvidence[] = [];
    for (let line = 0; line < lines.length; line++) {
      if (!lines[line]!.includes(query)) continue;
      const start = Math.max(0, line - 1), excerpt = lines.slice(start, line + 2).join("\n");
      const fitted = fitJson(excerpt, 600);
      matches.push({ path, side, commit, startLine: start + 1, text: fitted, truncated: fitted !== excerpt });
      if (matches.length === 3) break;
    }
    if (evidence.length && JSON.stringify([...evidence, ...matches]).length > room - 1_000) { end = index; break; }
    while (matches.length > 1 && JSON.stringify(matches).length > room - 1_000) matches.pop();
    evidence.push(...matches);
  }
  return { evidence, result: { side, commit, matches: evidence, scannedFiles: end - Math.min(offset, end), totalFiles: searchable.length,
    nextOffset: end < searchable.length ? end : null, complete: inventory.complete && end === searchable.length && unread.length === 0,
    inventoryComplete: inventory.complete, unread: unread.slice(0, 3), unreadFiles: unread.length, excludedFiles: paths.length - searchable.length,
    guidance: "只搜索源码、配置和文档，排除生成文件。每文件最多展示前 3 处命中；用 read_file 查看上下文。nextOffset 非空时尚未搜索完，不能当作全仓无引用。" } };
}

/** Keep source evidence outside the model transcript, which may drop earlier tool results. */
export function rememberSource(target: PrSourceEvidence[], entries: PrSourceEvidence[]): number {
  for (const entry of entries) {
    const previous = target.findIndex((item) => item.path === entry.path && item.side === entry.side && item.startLine === entry.startLine);
    const prior = previous >= 0 ? target.splice(previous, 1)[0] : undefined;
    target.push(prior && prior.commit === entry.commit && prior.text.startsWith(entry.text) ? prior : entry);
  }
  let dropped = 0;
  while (target.length > 40 || target.reduce((size, item) => size + item.text.length, 0) > 120_000) { target.shift(); dropped++; }
  return dropped;
}

export function sourceEvidenceContext(entries: PrSourceEvidence[], room: number): { sourceEvidence: PrSourceEvidence[]; sourceEvidenceOmitted: number } {
  const sources: PrSourceEvidence[] = [];
  rememberSource(sources, entries);
  let selected = [...sources].reverse().slice(0, 12);
  const fit = () => selected.map((entry) => {
    const space = Math.max(2, Math.floor(room / Math.max(1, selected.length)) - JSON.stringify({ ...entry, text: "" }).length - 10);
    const text = fitJson(entry.text, space);
    return { ...entry, text, truncated: entry.truncated || text !== entry.text };
  });
  let sourceEvidence = fit();
  while (sourceEvidence.length && JSON.stringify(sourceEvidence).length > room) { selected.pop(); sourceEvidence = fit(); }
  return { sourceEvidence, sourceEvidenceOmitted: entries.length - sourceEvidence.length };
}
