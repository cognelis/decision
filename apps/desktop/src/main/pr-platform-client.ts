import { fetch as proxyFetch } from "undici";
import { z } from "zod";
import { clipText, prDescriptionSections, prDescriptionSchema, prDescriptionUpdateSchema, prDescriptionVersion, type PrDescription, type PrDescriptionUpdate, type PrDescriptionUpdateResult, prReviewStatusSchema, type PrBuildState, type PrReviewStatus, prActionContextSchema, prActionRequestSchema, prReviewCommentRequestSchema, prGeneralCommentRequestSchema, prReviewDiffRequestSchema, type PrGeneralCommentRequest, type PrActionContext, type PrActionRequest, type PrActionResult, type PrReviewCommentRequest, type PrReviewCommentResult, type PrReviewDiffRequest, prConnectionSchema, prListResponseSchema, repositoryRelativePathSchema, PR_REVIEW_MAX_FILES, type PrConnection, type PrListQuery, type PrListResponse } from "@cognelis/decision-protocol";
import { createPlatformDispatcher } from "./model/provider-network.js";

/** Renamed files' old names per connection, PR and commit pair, the newest few kept: see previousPath(). */
const renamesRead = new Map<string, Map<string, string>>();
/** Each PR commit pair's merge base, `null` where the platform has none to give: see mergeBase(). */
const basesRead = new Map<string, string | null>();
/** GitLab MR diff versions' file diffs notes were made on, by connection, MR and version, the newest few: see versionDiffs(). */
const versionsRead = new Map<string, Map<string, string>>();

/** A write the platform refused and said why (Bitbucket's merge checks): its words, not "result unconfirmed". */
export class PrPlatformRefusal extends Error {}

/** The description moved after it was read: written over, someone's edit would be lost. */
export class PrDescriptionMovedError extends Error {
  constructor() { super("PR 描述在读取之后被改过（作者或别的审阅人），没有写回。请重新读取，在最新的描述上再改。"); }
}

/** Bitbucket stores text in 3-byte UTF-8: a character past U+FFFF (an emoji) fails the whole write, so it is left out. */
const bitbucketText = (value: string) => Array.from(value).filter((char) => char.codePointAt(0)! <= 0xffff).join("");

/** No answer at all (connection failed, timed out): told apart from what the platform answered. */
export class PrPlatformUnreachable extends Error {}

/** The PR's commits are no longer the ones an action was asked for: told apart from a read that failed. */
export class PrCommitsMovedError extends Error {
  constructor() { super("PR 提交已变化，请读取最新提交后再操作。"); }
}

export class PrPlatformError extends Error {
  /** `wait`: the seconds the platform asked for before the next request, when it said. */
  constructor(readonly status: number, wait: number | null = null) {
    super(status === 401 ? "代码平台拒绝了此资源的身份认证（HTTP 401），请检查连接凭据或仓库授权。" :
      status === 403 ? "没有执行此操作的权限（HTTP 403），请确认账号和令牌授权。" :
      status === 429 ? `代码平台请求被限流（HTTP 429），请${wait !== null && wait > 0 ? `约 ${wait} 秒后` : "稍后"}重试。` :
      status === 404 ? "代码平台未找到请求的资源（HTTP 404），也可能是服务器版本不支持此操作。" :
      status === 409 ? "PR 版本或状态已变化（HTTP 409），请刷新后重新确认。" :
      status === 405 ? "平台不允许此操作（HTTP 405），请检查 PR 状态和合并条件。" :
      status === 422 ? "平台拒绝此操作（HTTP 422），请检查评审身份、意见和 PR 状态。" :
      status >= 500 ? `代码平台返回 HTTP ${status}，请稍后重试。` : `代码平台拒绝了这个请求（HTTP ${status}）。`);
    this.name = "PrPlatformError";
  }
}

/** The seconds a platform asks for: `retry-after` (seconds or an HTTP date), else GitHub's `x-ratelimit-reset` (epoch seconds). */
const waitSeconds = (headers: { get(name: string): string | null }): number | null => {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = /^\d+$/u.test(retryAfter.trim()) ? Number(retryAfter) : (Date.parse(retryAfter) - Date.now()) / 1000;
    if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
  }
  const reset = Number(headers.get("x-ratelimit-reset"));
  return reset > 0 ? Math.max(0, Math.ceil(reset - Date.now() / 1000)) : null;
};
/** The page number a Link header calls last (GitHub's, on every page but the last), if it names one. */
const lastPage = (link: string): number | undefined => {
  const page = Number(/<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="last"/u.exec(link)?.[1]);
  return Number.isSafeInteger(page) && page > 0 ? page : undefined;
};

const sha = z.string().regex(/^[a-f0-9]{40,64}$/u);
const label = z.string().max(2_000);
const segment = z.string().regex(/^[\p{L}\p{N}_.~@-]+$/u).refine((value) => value !== "." && value !== "..");
const repoName = z.string().max(1_000).refine((value) => value.split("/").every((part) => segment.safeParse(part).success));
const branch = z.object({ repository: repoName, commit: sha });
// The description as the platform has it (the response is capped at 2 MiB): a long one is the review's to shorten, not a PR that will not open.
// `base`: where the platform's diff starts (the merge base), which the old side is read at; set by the commit pair, it
// is not part of the version samePrVersion compares. Absent, the old side is the target's tip, as before.
export const prDetailsSchema = z.object({ title: label, description: z.string().nullish(), source: branch, destination: branch, base: sha.optional(), destinationBranch: z.string().max(500).optional() });
export type PrDetails = z.infer<typeof prDetailsSchema>;
/** `url` is where a person reads the comment on the platform; decisions taken from it link back there. */
export interface PrExistingComment { id: string; url: string; author: string; path: string | null; line: number | null; body: string; createdAt: string }
/**
 * A comment as the discussion lists it. `replyTo` is the comment opening the thread it answers in, null for one that opens
 * a thread or a platform that does not say. `side` is which version of the file its line is on, null when there is no
 * line in the PR as it stands to read (a general comment, an outdated one, or a platform that cannot tell).
 */
export interface PrDiscussionEntry extends PrExistingComment { replyTo: string | null; side: "old" | "new" | null }
/** A reply in a comment's thread, by whom: `login` the account name, to tell the author's own replies by. */
export interface PrThreadReply { id: string; author: string; login: string; body: string; createdAt: string }
/**
 * A comment opening a thread, with what was said under it (作者回应). `task`: a Bitbucket task, open or done; `resolved`:
 * the thread, where the platform says; `discussion`: GitLab's thread, which a reply goes into.
 */
/** A merged PR as 评审质量 counts it (teamFacts). */
export interface PrTeamFacts { title: string; description: string; createdAt: string; mergedAt: string | null; approvals: Array<{ login: string; at: string }>; humanComments: number }
export interface PrThread extends PrExistingComment {
  login: string; task: "open" | "resolved" | null; resolved: boolean | null; replies: PrThreadReply[]; discussion?: string;
  /** Which version of the file its line is on; null for a comment without one. */
  side: "old" | "new" | null;
}
/**
 * A comment's code: the change as it stood when the comment was made (`hunk`, unified diff with a header over each
 * stretch, `from` its first line on `side`), or the lines around it in the file as the PR has it now (`file`, from line
 * `from`).
 */
export interface PrCommentCode { kind: "hunk" | "file"; side: "old" | "new"; from: number; text: string }
/** Where a line comment was made: its side and lines (`start` to `line`) in the change it was made on, and that change. */
interface CommentMade {
  side: "old" | "new"; start: number; line: number;
  /** The change as unified diff, where the platform gives it: with the comment (GitHub, Bitbucket) or by version (GitLab). */
  diff?: string | undefined;
  /** GitLab's notes name the MR's diff version they were made on, by its three commits, instead of carrying the diff. */
  version?: string | undefined;
}
/** What discussion() reads a line comment's code by besides its entry: `from`, the first line of one over several. */
interface CommentAnchor { from?: number | undefined; made?: CommentMade | undefined }

/** A line of code in a comment's context: a minified line cut to its first 300 characters. */
const codeLine = (text: string): string => (text.length > 300 ? `${clipText(text, 299)}…` : text);
/** About how much code a comment's context holds: what a reviewer reads around it, not the file. */
const CODE_CHARS = 2_000;
/**
 * The lines kept around a comment's own (indexes `from` to `to` of `sizes`): those, its last ones if they alone run past
 * CODE_CHARS, then one above and one below in turn while the whole fits, so the comment stays in the middle.
 */
const around = (sizes: readonly number[], from: number, to: number): [number, number] => {
  let lo = to, hi = to, used = sizes[to]!;
  while (lo > from && used + sizes[lo - 1]! <= CODE_CHARS) used += sizes[--lo]!;
  for (let up = lo === from, down = up; up || down;) {
    if (up && lo > 0 && used + sizes[lo - 1]! <= CODE_CHARS) used += sizes[--lo]!; else up = false;
    if (down && hi < sizes.length - 1 && used + sizes[hi + 1]! <= CODE_CHARS) used += sizes[++hi]!; else down = false;
  }
  return [lo, hi];
};
/**
 * A comment's lines (`start` to `line`) in the file as the PR has it now, with the ten above and the five below. With
 * only the three above its last line, a comment on the head of a call or a condition was recorded without the code it
 * was about, and one over twenty lines without most of them.
 */
const fileCode = (file: readonly string[], side: "old" | "new", start: number, line: number): PrCommentCode | null => {
  if (line < 1 || line > file.length) return null;
  const first = start >= 1 && start < line ? start : line, base = Math.max(0, first - 11);
  const lines = file.slice(base, line + 5).map(codeLine);
  const [lo, hi] = around(lines.map((text) => text.length + 1), first - 1 - base, line - 1 - base);
  return { kind: "file", side, from: base + lo + 1, text: lines.slice(lo, hi + 1).join("\n") };
};
/** A line of a change as unified diff gives it (`+`, `-` or ` ` first), with where it sits in the old file and the new. */
interface ChangeLine { text: string; old: number; new: number }
/** Its number in the file on `side`; null for a line only the other side has. */
const lineOn = (line: ChangeLine, side: "old" | "new"): number | null => (line.text[0] === (side === "new" ? "-" : "+") ? null : line[side]);
/** Whether `next` comes right after `line` in both files: the same hunk goes on, else another starts. */
const follows = (line: ChangeLine, next: ChangeLine): boolean =>
  next.old === line.old + (line.text[0] === "+" ? 0 : 1) && next.new === line.new + (line.text[0] === "-" ? 0 : 1);
/**
 * Unified diff text as lines with where they sit: GitHub's diff_hunk (which stops at the comment's line), a GitLab file's
 * diff, Bitbucket's hunks written out. A side a hunk leaves empty (`-0,0`) names the line before it.
 */
const changeLines = (diff: string): ChangeLine[] => {
  const lines: ChangeLine[] = [];
  let old = 0, next = 0, open = false;
  for (const text of diff.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(text);
    if (header) {
      old = Number(header[1]) + (header[2] === "0" ? 1 : 0); next = Number(header[3]) + (header[4] === "0" ? 1 : 0); open = true;
      continue;
    }
    if (!open || !/^[ +-]/u.test(text)) continue;
    lines.push({ text: codeLine(text), old, new: next });
    if (text[0] !== "+") old++;
    if (text[0] !== "-") next++;
  }
  return lines;
};
/** Lines of a change as unified diff again: a header over each stretch, which says where it is once lines between are left out. */
const unified = (lines: readonly ChangeLine[]): string => {
  const runs: ChangeLine[][] = [];
  for (const line of lines) {
    const run = runs.at(-1);
    if (run && follows(run.at(-1)!, line)) run.push(line); else runs.push([line]);
  }
  return runs.flatMap((run) => {
    const olds = run.filter((line) => line.text[0] !== "+").length, news = run.filter((line) => line.text[0] !== "-").length;
    return [`@@ -${run[0]!.old - (olds ? 0 : 1)},${olds} +${run[0]!.new - (news ? 0 : 1)},${news} @@`, ...run.map((line) => line.text)];
  }).join("\n");
};
/**
 * A comment's code as the change stood when it was made, which is what the reviewer answered: the lines of its diff
 * around its own, removed ones too. Null when its line is not among them, to be read from the file instead.
 */
const hunkCode = ({ side, start, line, diff = "" }: CommentMade): PrCommentCode | null => {
  const lines = changeLines(diff);
  const to = lines.findIndex((item) => lineOn(item, side) === line), first = lines.findIndex((item) => lineOn(item, side) === start);
  if (to < 0) return null;
  // A stretch's header counts too: a diff of many small hunks ran headers past what the comment can carry.
  const [lo, hi] = around(lines.map((item, index) => item.text.length + 1 + (index && !follows(lines[index - 1]!, item) ? 30 : 0)), first >= 0 && first < to ? first : to, to);
  const kept = lines.slice(lo, hi + 1);
  return { kind: "hunk", side, from: kept.map((item) => lineOn(item, side)).find((number) => number !== null) ?? line, text: unified(kept) };
};
/**
 * Bitbucket's diff of a comment's file around it: hunks of added, removed and context lines, as unified diff. Each line
 * is placed by its own number on its side, counted from the hunk's header only where it has none: cut to the lines
 * around a comment, a hunk keeps the whole hunk's header, and counted from there its lines were numbered as others.
 */
const bitbucketDiff = z.object({
  hunks: z.array(z.object({ sourceLine: z.number().int(), sourceSpan: z.number().int(), destinationLine: z.number().int(), destinationSpan: z.number().int(),
    segments: z.array(z.object({ type: z.string(), lines: z.array(z.object({ line: z.string(), source: z.number().int().nullish(), destination: z.number().int().nullish() })) })) })),
}).transform(({ hunks }) => unified(hunks.flatMap((hunk) => {
  // An empty side's header names the line before it, as git's does.
  let old = hunk.sourceLine + (hunk.sourceSpan ? 0 : 1), next = hunk.destinationLine + (hunk.destinationSpan ? 0 : 1);
  return hunk.segments.flatMap((segment) => segment.lines.map((line): ChangeLine => {
    const mark = segment.type === "ADDED" ? "+" : segment.type === "REMOVED" ? "-" : " ";
    const at = { text: codeLine(`${mark}${line.line}`), old: mark === "+" ? old : line.source ?? old, new: mark === "-" ? next : line.destination ?? next };
    old = at.old + (mark === "+" ? 0 : 1);
    next = at.new + (mark === "-" ? 0 : 1);
    return at;
  }));
})));
export interface PrRepositoryFiles { paths: string[]; complete: boolean }
export interface PrReviewClient {
  get(reference: string, signal?: AbortSignal): Promise<PrDetails>;
  /** `unsupported`: a name the review cannot carry as given, to be named in a warning and left out. */
  files(reference: string, signal?: AbortSignal): Promise<Array<{ path: string; status: string; unsupported?: true }>>;
  diff(reference: string, signal?: AbortSignal): Promise<string>;
  readFileContent(pr: PrDetails, path: string, side: "old" | "new", signal?: AbortSignal): Promise<string>;
  readFile(pr: PrDetails, path: string, start: number, signal?: AbortSignal): Promise<string>;
  /** Fixed-revision repository inventory, including files outside the PR. Missing capability is not an empty repository. */
  repositoryFiles?(pr: PrDetails, side: "old" | "new", signal?: AbortSignal): Promise<PrRepositoryFiles>;
  /** Newest comments already on the PR; optional so a client without it simply reviews without them. */
  comments?(reference: string, signal?: AbortSignal): Promise<PrExistingComment[]>;
  /** What changed between two commits of the PR's source, as unified diff: a later round's new commits. */
  rangeDiff?(pr: PrDetails, from: string, to: string, signal?: AbortSignal): Promise<string>;
}
/**
 * A changed file as listed. A name git allows but a review path cannot carry as given (`?`, `*`, `\`,
 * a line break, space at either end, which the path schema would trim into another file's name) is
 * marked, not the reason the whole PR will not open.
 */
const listedFile = (path: string, status: string): { path: string; status: string; unsupported?: true } =>
  repositoryRelativePathSchema.safeParse(path).data === path ? { path, status } : { path, status, unsupported: true };
export const samePrVersion = (a: PrDetails, b: PrDetails): boolean =>
  a.source.commit === b.source.commit && a.destination.commit === b.destination.commit &&
  a.source.repository === b.source.repository && a.destination.repository === b.destination.repository;

export function parsePrReference(reference: string): { repository: string; number: string } {
  const match = /^(.*)#([1-9]\d*)$/u.exec(reference);
  if (!match) throw new Error("PR 标识无效，请从列表重新选择。");
  return { repository: repoName.parse(match[1]), number: match[2]! };
}
export function prApiBase(input: PrConnection): string {
  const connection = prConnectionSchema.parse(input);
  const url = new URL(connection.baseUrl);
  const base = url.href.replace(/\/+$/u, "");
  if (connection.platform === "github") {
    if (["github.com", "www.github.com", "api.github.com"].includes(url.hostname)) return "https://api.github.com";
    return /\/api\/v3$/u.test(base) ? base : `${base}/api/v3`;
  }
  if (connection.platform === "gitlab") return /\/api\/v4$/u.test(base) ? base : `${base}/api/v4`;
  return base.replace(/\/rest\/api\/(?:1\.0|latest)$/u, "");
}
/** Where a person reads PRs in a browser, which is not always where the API lives. */
export function prWebBase(input: PrConnection): string {
  const api = prApiBase(input);
  if (input.platform === "bitbucket-server") return api;
  return api === "https://api.github.com" ? "https://github.com" : api.replace(input.platform === "github" ? /\/api\/v3$/u : /\/api\/v4$/u, "");
}
/** A link belongs to a connection when it sits under that platform's web base. */
export function ownsWebLink(connection: PrConnection, link: string): boolean {
  const url = new URL(link), base = new URL(`${prWebBase(connection)}/`);
  return url.origin === base.origin && url.pathname.startsWith(base.pathname) && !url.username && !url.password;
}

/** `clipped`: the response ran past the read's cap and holds only what came before it. `last`: see lastPage(). */
interface Page { text: string; next: boolean; last?: number | undefined; username?: string | undefined; clipped?: boolean }
export type PrWrite = (path: string, method: "POST" | "PUT" | "PATCH", body: Record<string, unknown>, signal?: AbortSignal) => Promise<Page>;
/** A read that has to be posted (GraphQL): failing, it is a read that failed, not a write whose outcome is unknown. */
export type PrQuery = (path: string, body: Record<string, unknown>, signal?: AbortSignal) => Promise<Page>;
export interface PrCreationTarget { sourceRepository: string; destinationRepository: string; sourceBranch: string; destinationBranch: string }
export interface CreatedPullRequest { id: string; url: string }
export interface PrCreation extends PrCreationTarget { title: string; description: string; reviewers: string[] }
/**
 * How much one response may hold (`bytes`, 2 MiB unless said), and whether past it what was read is kept instead of the
 * read refused (`clip`: a diff, cut back to whole files by its reader).
 */
export interface ReadCap { bytes?: number; clip?: boolean }
export type PrRead = (path: string, accept: string, signal?: AbortSignal, cap?: ReadCap) => Promise<Page>;
const MAX_RESPONSE = 2 * 1024 * 1024;
/**
 * A page of a list: a file list's (GitHub's and GitLab's carry every file's patch: a hundred of a large PR's ran past
 * 2 MiB) and a PR list's (each PR with its whole description: thirty with long release notes did too).
 */
const MAX_LIST_PAGE = 32 * 1024 * 1024;
/**
 * A diff read up to its cap, cut back to the last file it holds whole: those after it have no diff, and are named as not
 * reviewed, as pr-agent (code-meeseeks' reviewer) leaves out what its budget cannot hold rather than refuse the PR.
 */
const wholeFiles = (diff: string): string => {
  const end = diff.lastIndexOf("\ndiff --git ");
  return end < 0 ? "" : diff.slice(0, end + 1);
};
const enc = encodeURIComponent;
const repoPath = (repo: string) => repoName.parse(repo).split("/").map(enc).join("/");
const user = z.object({ login: z.string().optional(), name: z.string().optional(), displayName: z.string().optional() }).passthrough();
const bbRepository = z.object({ slug: z.string(), project: z.object({ key: z.string() }) });
const bbRef = z.object({ latestCommit: sha, repository: bbRepository });
const bbPr = z.object({ id: z.number().int().positive(), title: label, description: z.string().nullish(), updatedDate: z.number(), author: z.object({ user }), fromRef: bbRef, toRef: bbRef,
  properties: z.object({ commentCount: z.number().int().nonnegative().optional() }).nullish() });
const ghPr = z.object({ title: label, body: z.string().nullish(), head: z.object({ sha, repo: z.object({ full_name: repoName }).nullable() }), base: z.object({ sha, repo: z.object({ full_name: repoName }) }) });
const glPr = z.object({ title: label, description: z.string().nullish(), source_project_id: z.number().int().positive().nullable(), target_project_id: z.number().int().positive(), diff_refs: z.object({ head_sha: sha, start_sha: sha, base_sha: sha }).nullable() });

/** Requests stay on the configured origin; redirects never receive credentials. */
export class HostedPrClient implements PrReviewClient {
  private readonly contents = new Map<string, string>();
  private readonly inventories = new Map<string, PrRepositoryFiles>();
  constructor(readonly connection: PrConnection, private readonly read: PrRead, private readonly write?: PrWrite, private readonly query?: PrQuery) {}

  static create(connection: PrConnection, token: string): HostedPrClient {
    const base = prApiBase(connection);
    const request = async (path: string, accept: string, signal?: AbortSignal, sent?: { method: "POST" | "PUT" | "PATCH"; body: Record<string, unknown>; query?: true }, cap: ReadCap = {}): Promise<Page> => {
      const limit = cap.bytes ?? MAX_RESPONSE;
      // A query is posted but changes nothing: its failures are a read's.
      const mutation = sent?.query ? undefined : sent;
      if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) throw new Error("平台请求路径无效。");
      // GraphQL sits beside the REST API: GitLab's /api/graphql, GitHub Enterprise's /api/graphql, github.com's /graphql.
      const target = new URL(path === "/graphql" && connection.platform !== "bitbucket-server" ? `${base.replace(/\/v[34]$/u, "")}/graphql` : base + path);
      if (target.origin !== new URL(base).origin) throw new Error("拒绝跨站发送平台凭据。");
      const dispatcher = createPlatformDispatcher(undefined, process.env, target);
      const timeout = AbortSignal.timeout(30_000);
      try {
        const response = await proxyFetch(target, {
          method: sent?.method ?? "GET", redirect: "error", dispatcher,
          ...(sent ? { body: JSON.stringify(sent.body) } : {}),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          headers: { accept, ...(sent ? { "content-type": "application/json" } : {}), ...(connection.platform === "gitlab" ? { "PRIVATE-TOKEN": token } : { authorization: `Bearer ${token}` }),
            ...(connection.platform === "github" ? { "X-GitHub-Api-Version": "2022-11-28" } : {}) },
        });
        if (!response.ok) {
          // GitHub says an exhausted limit (primary or secondary) with HTTP 403 as well: a wait, not a token to check.
          // Its headers alone do not tell: `x-ratelimit-remaining` counts the request just refused, so a window's
          // last one refused for its token reads 0 too, and the body says which ("API rate limit exceeded").
          const limited = response.status === 429 || (response.status === 403 && (response.headers.has("retry-after") ||
            (response.headers.get("x-ratelimit-remaining") === "0" && /rate limit/iu.test((await response.text().catch(() => "")).slice(0, 4096)))));
          // A merge Bitbucket's merge checks refuse comes back 409 with their reasons ("至少需要 2 个批准"): said, not as
          // the version having changed, which a refresh showed it had not, and the same refusal came back.
          if (mutation && response.status === 409 && connection.platform === "bitbucket-server") {
            const text = (await response.text().catch(() => "")).slice(0, 65_536);
            const vetoes = (() => {
              try {
                const body = JSON.parse(text) as { errors?: Array<{ vetoes?: Array<{ summaryMessage?: unknown; detailedMessage?: unknown }> }> };
                return (body.errors ?? []).flatMap((error) => error.vetoes ?? [])
                  .map((veto) => [veto.detailedMessage, veto.summaryMessage].find((said): said is string => typeof said === "string" && said.length > 0) ?? "").filter(Boolean);
              } catch { return []; }
            })();
            if (vetoes.length) throw new PrPlatformRefusal(`平台拒绝了这次操作（HTTP 409）：${clipText(vetoes.join("；"), 1_000)}`);
          }
          await response.body?.cancel().catch(() => undefined);
          // A write behind a failing gateway may well have been carried out: "try again" would post it twice.
          throw mutation && response.status >= 500 ? new Error("操作结果未确认，请先到代码平台核对状态，避免重复提交。")
            : new PrPlatformError(limited ? 429 : response.status, limited ? waitSeconds(response.headers) : null);
        }
        let bytes = 0, clipped = false;
        const chunks: Uint8Array[] = [];
        if (response.body) for await (const chunk of response.body) {
          if (bytes + chunk.byteLength > limit) {
            if (!cap.clip) throw new Error(`平台响应超过 ${limit / 1024 / 1024} MiB，请缩小变更范围。`);
            chunks.push(chunk.subarray(0, limit - bytes));
            clipped = true;
            break;
          }
          bytes += chunk.byteLength;
          chunks.push(chunk);
        }
        const link = response.headers.get("link") ?? "";
        return { username: response.headers.get("x-ausername") ?? undefined, text: Buffer.concat(chunks).toString("utf8"), next: /rel="next"/u.test(link) || !!response.headers.get("x-next-page"), last: lastPage(link), ...(clipped ? { clipped } : {}) };
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof PrPlatformError || error instanceof PrPlatformRefusal) throw error;
        if (mutation) throw new Error("操作结果未确认，请先到代码平台核对状态，避免重复提交。");
        if (error instanceof Error && /^平台响应超过/u.test(error.message)) throw error;
        throw new PrPlatformUnreachable(timeout.aborted ? "代码平台请求超时，请重试。": "代码平台连接失败，请检查地址、网络和系统代理；不允许重定向凭据。");
      } finally { await dispatcher.close(); }
    };
    return new HostedPrClient(connection, (path, accept, signal, cap) => request(path, accept, signal, undefined, cap),
      (path, method, body, signal) => request(path, "application/json", signal, { method, body }),
      (path, body, signal) => request(path, "application/json", signal, { method: "POST", body, query: true }));
  }
  private creationTarget(target: PrCreationTarget) {
    repoName.parse(target.sourceRepository); repoName.parse(target.destinationRepository);
    if (![target.sourceBranch, target.destinationBranch].every(b => b.length > 0 && b.length <= 500 && !/[\0\r\n]/u.test(b))) throw new Error("PR 分支无效。");
    if (this.connection.platform === "gitlab" && target.sourceRepository !== target.destinationRepository) throw new Error("本地审阅暂不支持 GitLab 跨 fork PR。");
  }
  private created(value: unknown, target: PrCreationTarget): CreatedPullRequest {
    const record = z.object({ id: z.union([z.number(), z.string()]).optional(), number: z.number().optional(), iid: z.number().optional(), html_url: z.string().optional(), web_url: z.string().optional() }).passthrough().parse(value);
    const id = record.number ?? record.iid ?? record.id;
    if (id === undefined) throw new Error("平台创建结果未确认，请先查询已有 PR。");
    const url = record.html_url ?? record.web_url ?? this.webUrl(`${target.destinationRepository}#${String(id)}`);
    if (!ownsWebLink(this.connection, url)) throw new Error("平台返回了不属于当前链接的 PR 地址。");
    return { id: String(id), url };
  }
  /** Reconcile by all four identities, including closed and merged pull requests. */
  async findPullRequest(target: PrCreationTarget, signal?: AbortSignal): Promise<CreatedPullRequest | null> {
    this.creationTarget(target);
    const platform = this.connection.platform;
    const endpoint = this.endpoint(`${target.destinationRepository}#1`).replace(/\/1$/u, "");
    const sourceOwner = target.sourceRepository.split("/")[0]!;
    for (let cursor = 0, page = 1; page <= 100; page++) {
      const path = platform === "github" ? `${endpoint}?state=all&head=${enc(`${sourceOwner}:${target.sourceBranch}`)}&base=${enc(target.destinationBranch)}&per_page=100&page=${page}`
        : platform === "gitlab" ? `${endpoint}?state=all&source_branch=${enc(target.sourceBranch)}&target_branch=${enc(target.destinationBranch)}&per_page=100&page=${page}`
        : `${endpoint}?state=ALL&direction=INCOMING&at=${enc(`refs/heads/${target.destinationBranch}`)}&limit=100&start=${cursor}`;
      const response = await this.json(path, signal, { bytes: MAX_LIST_PAGE });
      const bb = platform === "bitbucket-server" ? z.object({ values: z.array(z.any()), isLastPage: z.boolean(), nextPageStart: z.number().optional() }).parse(response.data) : null;
      const values = bb?.values ?? z.array(z.any()).parse(response.data);
      const match = values.find(item => platform === "github" ? item.head?.ref === target.sourceBranch && item.base?.ref === target.destinationBranch && item.head?.repo?.full_name === target.sourceRepository && item.base?.repo?.full_name === target.destinationRepository
        : platform === "gitlab" ? item.source_branch === target.sourceBranch && item.target_branch === target.destinationBranch && item.source_project_id === item.target_project_id
        : item.fromRef?.id === `refs/heads/${target.sourceBranch}` && item.toRef?.id === `refs/heads/${target.destinationBranch}` && `${item.fromRef?.repository?.project?.key}/${item.fromRef?.repository?.slug}` === target.sourceRepository && `${item.toRef?.repository?.project?.key}/${item.toRef?.repository?.slug}` === target.destinationRepository);
      if (match) return this.created(match, target);
      if (bb ? bb.isLastPage : !response.next) return null;
      if (bb) { if (bb.nextPageStart === undefined || bb.nextPageStart <= cursor) throw new Error("PR 查询分页无效，未创建重复 PR。"); cursor = bb.nextPageStart; }
    }
    throw new Error("PR 查询超过分页上限，未创建重复 PR。");
  }
  async createPullRequest(input: PrCreation, signal?: AbortSignal): Promise<CreatedPullRequest> {
    this.creationTarget(input);
    if (!this.write) throw new Error("平台写入不可用。");
    signal?.throwIfAborted();
    const platform = this.connection.platform;
    const endpoint = this.endpoint(`${input.destinationRepository}#1`).replace(/\/1$/u, "");
    const clean = bitbucketText;
    const ref = (repository: string, branch: string) => { const [project, slug] = repository.split("/"); return { id: `refs/heads/${branch}`, repository: { slug, project: { key: project } } }; };
    const body = platform === "github" ? { title: input.title, body: input.description, head: input.sourceRepository === input.destinationRepository ? input.sourceBranch : `${input.sourceRepository.split("/")[0]}:${input.sourceBranch}`, base: input.destinationBranch, draft: true }
      : platform === "gitlab" ? { title: input.title.startsWith("Draft:") ? input.title : `Draft: ${input.title}`, description: input.description, source_branch: input.sourceBranch, target_branch: input.destinationBranch }
      : { title: clean(input.title).trim() || "本地审阅修复", description: clean(input.description), fromRef: ref(input.sourceRepository, input.sourceBranch), toRef: ref(input.destinationRepository, input.destinationBranch), reviewers: input.reviewers.map(name => ({ user: { name } })) };
    const response = await this.write(endpoint, "POST", body, signal);
    try { return this.created(JSON.parse(response.text), input); }
    catch { throw new Error("平台创建结果未确认，请先查询已有 PR，避免重复提交。"); }
  }
  private async json(path: string, signal?: AbortSignal, cap?: ReadCap) {
    const response = await this.read(path, "application/json", signal, cap);
    try { return { data: JSON.parse(response.text) as unknown, next: response.next, last: response.last, username: response.username }; }
    catch { throw new Error("代码平台返回了非 JSON 数据，请检查 API 地址与登录状态。"); }
  }
  /** The account the token signs in as: proof that both the address and the token work. */
  async account(): Promise<string> {
    const response = await this.json(this.connection.platform === "bitbucket-server" ? "/rest/api/1.0/application-properties" : "/user");
    // Bitbucket Server names the signed-in user in a header on every REST response.
    const name = this.connection.platform === "bitbucket-server" ? response.username
      : z.object({ login: z.string().optional(), username: z.string().optional() }).safeParse(response.data).data?.[this.connection.platform === "github" ? "login" : "username"];
    if (!name || name === "anonymous") throw new Error("代码平台没有认出令牌对应的账号，请检查服务地址与访问令牌。");
    return name.slice(0, 300);
  }
  private endpoint(reference: string): string {
    const { repository, number } = parsePrReference(reference);
    if (this.connection.platform === "github") {
      if (repository.split("/").length !== 2) throw new Error("GitHub 仓库标识无效。");
      return `/repos/${repoPath(repository)}/pulls/${number}`;
    }
    if (this.connection.platform === "gitlab") return `/projects/${enc(repository)}/merge_requests/${number}`;
    const parts = repository.split("/");
    if (parts.length !== 2) throw new Error("Bitbucket 仓库标识无效。");
    return `/rest/api/1.0/projects/${enc(parts[0]!)}/repos/${enc(parts[1]!)}/pull-requests/${number}`;
  }

  async actionContext(input: PrReviewDiffRequest): Promise<PrActionContext> {
    const request = prReviewDiffRequestSchema.parse(input);
    const context = await this.readContext(request);
    if (context.sourceCommit !== request.sourceCommit || context.destinationCommit !== request.destinationCommit) throw new PrCommitsMovedError();
    return context;
  }
  /** The commits the platform reports for a PR right now (no comparison with what the caller expected). */
  currentCommits(connectionId: string, reference: string): Promise<PrActionContext> {
    return this.readContext(prReviewDiffRequestSchema.parse({ connectionId, reference, sourceCommit: "0".repeat(40), destinationCommit: "0".repeat(40) }));
  }
  private async readContext(request: PrReviewDiffRequest): Promise<PrActionContext> {
    const response = await this.json(this.endpoint(request.reference));
    const base = { ...request, platform: this.connection.platform, canReview: true };
    let context: PrActionContext;
    if (this.connection.platform === "github") {
      const pr = ghPr.extend({ state: z.enum(["open", "closed"]), merged: z.boolean(), head: ghPr.shape.head.extend({ ref: z.string() }), base: ghPr.shape.base.extend({ ref: z.string() }) }).parse(response.data);
      context = prActionContextSchema.parse({ ...base, title: pr.title, sourceCommit: pr.head.sha, destinationCommit: pr.base.sha, sourceBranch: pr.head.ref, destinationBranch: pr.base.ref, state: pr.merged ? "merged" : pr.state });
    } else if (this.connection.platform === "gitlab") {
      const pr = glPr.extend({ state: z.enum(["opened", "closed", "merged", "locked"]), source_branch: z.string(), target_branch: z.string() }).parse(response.data);
      if (!pr.diff_refs) throw new Error("合并请求的提交尚未准备好，请刷新。");
      context = prActionContextSchema.parse({ ...base, title: pr.title, sourceCommit: pr.diff_refs.head_sha, destinationCommit: pr.diff_refs.start_sha, sourceBranch: pr.source_branch, destinationBranch: pr.target_branch, state: pr.state === "opened" ? "open" : pr.state === "merged" ? "merged" : "closed" });
    } else {
      const pr = bbPr.extend({ version: z.number().int().nonnegative(), state: z.enum(["OPEN", "DECLINED", "MERGED"]), fromRef: bbRef.extend({ displayId: z.string() }), toRef: bbRef.extend({ displayId: z.string() }) }).parse(response.data);
      // The slug approving and needs-work take: by the name the server says the token is, else among the users that name
      // filters to. Not found, those two are not offered; looked up by name alone and refused (an SSO name such as
      // zhang.san@corp has the slug zhang.san_corp), every write, merge and comments with it, failed on a 404.
      const username = response.username && response.username !== "anonymous" ? response.username : undefined;
      const slugOf = z.object({ slug: z.string().min(1).max(300) });
      // Not found by name, it is looked for among users; any failure leaves only approving and needs-work out (said on
      // them as a lookup that did not answer), never the comment or merge that needs no slug.
      const reviewerSlug = username === undefined ? undefined : await this.json(`/rest/api/1.0/users/${enc(username)}`).then((found) => slugOf.parse(found.data).slug)
        .catch(() => this.json(`/rest/api/1.0/users?filter=${enc(username)}&limit=25`).then((found) =>
          z.object({ values: z.array(slugOf.extend({ name: z.string() })) }).parse(found.data).values.find((user) => user.name === username)?.slug))
        .catch(() => undefined);
      context = prActionContextSchema.parse({ ...base, title: pr.title, sourceCommit: pr.fromRef.latestCommit, destinationCommit: pr.toRef.latestCommit, sourceBranch: pr.fromRef.displayId, destinationBranch: pr.toRef.displayId, state: pr.state === "OPEN" ? "open" : pr.state === "MERGED" ? "merged" : "closed", version: pr.version, ...(reviewerSlug ? { reviewerSlug } : {}), canReview: Boolean(reviewerSlug) });
    }
    return context;
  }

  async performAction(input: PrActionRequest): Promise<PrActionResult> {
    const request = prActionRequestSchema.parse(input);
    if (!this.write) throw new Error("当前连接未启用平台写入。");
    const expected = { connectionId: request.connectionId, reference: request.reference, sourceCommit: request.sourceCommit, destinationCommit: request.destinationCommit };
    const context = await this.actionContext(expected);
    if (context.state !== "open") throw new Error(context.state === "merged" ? "PR 已合并。" : "PR 已关闭或锁定。");
    if (context.sourceBranch !== request.sourceBranch || context.destinationBranch !== request.destinationBranch) throw new Error("PR 分支已变化，请重新确认操作。");
    if (request.action !== "merge" && !context.canReview) throw new Error("没能读取当前平台账号（账号信息读取失败或被限流），无法确认评审人。请稍后重试或在平台操作；一直如此时检查代理是否保留 X-AUSERNAME 响应头。");
    const endpoint = this.endpoint(request.reference);
    const submit = async (path: string, method: "POST" | "PUT", body: Record<string, unknown>) => {
      const response = await this.write!(path, method, body);
      try { return JSON.parse(response.text) as unknown; }
      catch { throw new Error("平台已接收请求，但返回结果无法确认。请先到平台核对状态，避免重复提交。"); }
    };
    if (this.connection.platform !== "github" && request.mergeMethod !== "merge") throw new Error("此平台的合并方式由项目设置决定。");
    try {
    if (this.connection.platform === "github") {
      if (request.action === "merge") {
        const result = z.object({ merged: z.boolean() }).parse(await submit(`${endpoint}/merge`, "PUT", { sha: request.sourceCommit, merge_method: request.mergeMethod }));
        if (!result.merged) throw new Error("平台未合并此 PR，请检查合并条件。");
      } else {
        if (request.action === "need-work" && !request.body) throw new Error("Need work 需要填写修改意见。");
        const result = z.object({ state: z.string(), commit_id: sha }).parse(await submit(`${endpoint}/reviews`, "POST", { commit_id: request.sourceCommit, event: request.action === "approve" ? "APPROVE" : "REQUEST_CHANGES", ...(request.body ? { body: request.body } : {}) }));
        if (result.state !== (request.action === "approve" ? "APPROVED" : "CHANGES_REQUESTED") || result.commit_id !== request.sourceCommit) throw new Error("返回的评审状态或提交不匹配，请到平台核对。");
      }
    } else if (this.connection.platform === "gitlab") {
      if (request.body) throw new Error("此平台操作只更新状态，不附带评论。");
      if (request.action === "merge") {
        const result = z.object({ state: z.string() }).parse(await submit(`${endpoint}/merge`, "PUT", { sha: request.sourceCommit }));
        if (result.state !== "merged") throw new Error("平台尚未完成合并，请在平台核对合并条件或队列状态。");
      } else if (request.action === "approve") {
        z.object({ approved_by: z.array(z.object({ user: z.object({ id: z.number().int().positive() }) })).min(1) }).parse(await submit(`${endpoint}/approve`, "POST", { sha: request.sourceCommit }));
      } else {
        const { repository, number } = parsePrReference(request.reference);
        const result = z.object({ errors: z.array(z.object({ message: z.string() })).optional(), data: z.object({ mergeRequestRequestChanges: z.object({ errors: z.array(z.string()), mergeRequest: z.object({ iid: z.string() }).nullable() }).nullable() }).nullable().optional() }).parse(await submit("/graphql", "POST", {
          query: "mutation RequestChanges($projectPath: ID!, $iid: String!) { mergeRequestRequestChanges(input: { projectPath: $projectPath, iid: $iid }) { errors mergeRequest { iid } } }",
          variables: { projectPath: repository, iid: number },
        }));
        const payload = result.data?.mergeRequestRequestChanges;
        if (result.errors?.length || !payload || payload.errors.length || payload.mergeRequest?.iid !== number) throw new Error("GitLab 未确认请求修改状态；请检查权限或服务器是否支持 mergeRequestRequestChanges。");
        // This API has no SHA precondition. Do not claim the old commit was reviewed if it raced.
        try { await this.actionContext(expected); } catch { throw new Error("请求修改已提交，但 PR 随后发生变化。请到平台核对评审状态。"); }
      }
    } else {
      if (request.body) throw new Error("此平台操作只更新状态，不发布评论或草稿。");
      if (request.action === "merge") {
        const result = z.object({ state: z.string() }).parse(await submit(`${endpoint}/merge`, "POST", { version: context.version }));
        if (result.state !== "MERGED") throw new Error("平台未确认合并完成，请到平台核对。");
      } else {
        const status = request.action === "approve" ? "APPROVED" : "NEEDS_WORK";
        const result = z.object({ status: z.string(), lastReviewedCommit: sha.optional() }).parse(await submit(`${endpoint}/participants/${enc(context.reviewerSlug!)}?version=${context.version}`, "PUT", { status, lastReviewedCommit: request.sourceCommit }));
        if (result.status !== status || (result.lastReviewedCommit && result.lastReviewedCommit !== request.sourceCommit)) throw new Error("平台返回的评审状态不匹配，请到平台核对。");
      }
    }
    } catch (error) {
      if (error instanceof z.ZodError) throw new Error("平台已返回响应，但无法确认操作结果。请先到平台核对状态。");
      throw error;
    }
    return { action: request.action, message: request.action === "merge" ? "PR 已合并。" : request.action === "approve" ? "已提交 Approve。" : "已提交 Need work。" };
  }

  /**
   * Posts one reviewer-confirmed comment on a changed line of the reviewed commits.
   * The model only drafts; nothing reaches the platform without this explicit call.
   */
  async publishComment(input: PrReviewCommentRequest): Promise<PrReviewCommentResult> {
    const request = prReviewCommentRequestSchema.parse(input);
    if (!this.write) throw new Error("当前连接未启用平台写入。");
    const pinned = { connectionId: request.connectionId, reference: request.reference, sourceCommit: request.sourceCommit, destinationCommit: request.destinationCommit };
    const context = await this.actionContext(pinned);
    if (context.state !== "open") throw new Error(context.state === "merged" ? "PR 已合并。" : "PR 已关闭或锁定。");
    const endpoint = this.endpoint(request.reference);
    const added = request.side === "new";
    const submit = async (path: string, body: Record<string, unknown>) => {
      const response = await this.write!(path, "POST", body);
      try { return JSON.parse(response.text) as unknown; }
      catch { throw new Error("平台已接收请求，但返回结果无法确认。请先到平台核对，避免重复发布。"); }
    };
    // The posted comment's id, as threads() names it: its thread is read by it later (发布后跟踪结果).
    let comment: string | undefined;
    try {
      if (this.connection.platform === "github") {
        comment = String(z.object({ id: z.number() }).parse(await submit(`${endpoint}/comments`, { body: request.body, commit_id: request.sourceCommit, path: request.path, line: request.line, side: added ? "RIGHT" : "LEFT" })).id);
      } else if (this.connection.platform === "gitlab") {
        // base_sha is part of a GitLab diff position but not of the commits the review pins.
        const refs = glPr.parse((await this.json(endpoint)).data).diff_refs;
        if (!refs || refs.head_sha !== request.sourceCommit || refs.start_sha !== request.destinationCommit) throw new Error("PR 提交已变化，请读取最新提交后再发布。");
        const oldPath = await this.previousPath(endpoint, request.path, request);
        const discussion = z.object({ id: z.string(), notes: z.array(z.object({ id: z.number() })).optional() }).parse(await submit(`${endpoint}/discussions`, { body: request.body, position: { position_type: "text", base_sha: refs.base_sha, start_sha: refs.start_sha, head_sha: refs.head_sha, old_path: oldPath ?? request.path, new_path: request.path, ...(added ? { new_line: request.line } : { old_line: request.line }) } }));
        comment = discussion.notes?.[0] ? String(discussion.notes[0].id) : undefined;
      } else {
        const srcPath = await this.previousPath(endpoint, request.path, request);
        // A blocking one is a task (a BLOCKER comment, Bitbucket 7.2 on), which the "no open tasks" merge check holds on.
        const posted = z.object({ id: z.number(), severity: z.string().optional() }).parse(await submit(`${endpoint}/comments`, { text: request.body, ...(request.blocking ? { severity: "BLOCKER" } : {}), anchor: { path: request.path, ...(srcPath && srcPath !== request.path ? { srcPath } : {}), line: request.line, lineType: added ? "ADDED" : "REMOVED", fileType: added ? "TO" : "FROM", diffType: "EFFECTIVE" } }));
        const task = { ...(request.blocking ? { blocking: posted.severity === "BLOCKER" } : {}), comment: String(posted.id) };
        const notTask = request.blocking && posted.severity !== "BLOCKER" ? "平台没有把它设为任务（Bitbucket 7.2 以下不支持），它是一条普通评论。" : "";
        // Unlike GitHub and GitLab this anchor names no commit: a push racing the post would move the line. Say so rather
        // than report a clean post; a read that failed is not a push, and said as one sent the reader to look for it.
        const after = await this.actionContext(pinned).then(() => "same", (error: unknown) => (error instanceof PrCommitsMovedError ? "moved" : "unknown"));
        if (after === "moved") return { message: `评论已发布，但 PR 随后有新的提交；请到平台核对评论是否仍在原来的行上。${notTask}`, ...task };
        if (after === "unknown") return { message: `评论已发布到 ${request.path}:${request.line}；发布后没能确认 PR 是否又有新的提交，如有疑问请到平台核对评论位置。${notTask}`, ...task };
        return { message: `${request.blocking && !notTask ? "任务" : "评论"}已发布到 ${request.path}:${request.line}。${notTask}`, ...task };
      }
    } catch (error) {
      if (error instanceof z.ZodError) throw new Error("平台已返回响应，但无法确认评论已发布。请先到平台核对，避免重复发布。");
      if (error instanceof PrPlatformError && (error.status === 400 || error.status === 422)) throw new Error(`平台拒绝了这条行内评论（HTTP ${error.status}）：该行可能已不在 PR 的 diff 中，或文件经过重命名。可以复制内容到平台手动评论。`);
      throw error;
    }
    // No tasks here: a blocking one is an ordinary comment, held by the repository's "resolve discussions first".
    return { message: `评论已发布到 ${request.path}:${request.line}。`, ...(request.blocking ? { blocking: true } : {}), ...(comment ? { comment } : {}) };
  }

  /**
   * A comment on the PR as a whole: an overview, suggestions or an answer the reader chose to post.
   * It speaks about the commits it was written for, so it is refused once the PR has moved on.
   */
  async publishGeneralComment(input: PrGeneralCommentRequest): Promise<PrReviewCommentResult> {
    const request = prGeneralCommentRequestSchema.parse(input);
    if (!this.write) throw new Error("当前连接未启用平台写入。");
    const context = await this.actionContext({ connectionId: request.connectionId, reference: request.reference, sourceCommit: request.sourceCommit, destinationCommit: request.destinationCommit });
    if (context.state !== "open") throw new Error(context.state === "merged" ? "PR 已合并。" : "PR 已关闭或锁定。");
    const endpoint = this.endpoint(request.reference);
    // GitHub keeps a PR's conversation on its issue; GitLab calls it notes; Bitbucket Server takes text.
    // Only Bitbucket threads a comment on the PR as a whole: elsewhere one cannot answer under another.
    if (request.replyTo && this.connection.platform !== "bitbucket-server") throw new Error("这个平台的整体评论不能接在已有评论下面。");
    const [path, body] = this.connection.platform === "github" ? [`${endpoint.replace(/\/pulls\//u, "/issues/")}/comments`, { body: request.body }]
      : this.connection.platform === "gitlab" ? [`${endpoint}/notes`, { body: request.body }]
        : [`${endpoint}/comments`, { text: request.body, ...(request.replyTo ? { parent: { id: Number(request.replyTo) } } : {}) }];
    const response = await this.write(path, "POST", body);
    try {
      z.object({ id: z.number() }).parse(JSON.parse(response.text));
    } catch {
      throw new Error("平台已返回响应，但无法确认评论已发布。请先到平台核对，避免重复发布。");
    }
    return { message: "评论已发布到 PR。" };
  }

  /**
   * The comments on a PR that open a thread, each with the replies under it: Bitbucket's activities (a task's state on
   * it), GitHub's line comments by what they answer and its conversation (each comment a thread of its own; resolution by
   * GraphQL, unknown when that cannot be read), GitLab's discussions. Ten pages at most; `more`: some left unread.
   */
  async threads(reference: string, signal?: AbortSignal): Promise<{ threads: PrThread[]; more: boolean }> {
    const endpoint = this.endpoint(reference);
    const { repository, number } = parsePrReference(reference);
    const web = prWebBase(this.connection);
    const id = z.number().int().positive();
    const threads: PrThread[] = [];
    let more = false;
    if (this.connection.platform === "bitbucket-server") {
      const [projectKey, slug] = repository.split("/") as [string, string];
      const said = z.object({ id, text: z.string(), createdDate: z.number(), author: z.object({ name: z.string().optional(), displayName: z.string().optional() }).nullish(),
        severity: z.string().optional(), state: z.string().optional(), threadResolved: z.boolean().optional(), comments: z.array(z.unknown()).optional() });
      type Said = z.infer<typeof said>;
      // Activities come newest first and repeat a comment when it is edited or deleted: its first entry is its current state.
      const seen = new Set<number>();
      const by = (comment: Said) => ({ author: comment.author?.displayName ?? comment.author?.name ?? "", login: comment.author?.name ?? "" });
      const under = (comment: Said): PrThreadReply[] => (comment.comments ?? []).flatMap((item) => {
        const reply = said.safeParse(item);
        if (!reply.success || seen.has(reply.data.id)) return [];
        seen.add(reply.data.id);
        return [{ id: String(reply.data.id), ...by(reply.data), body: reply.data.text, createdAt: new Date(reply.data.createdDate).toISOString() }, ...under(reply.data)];
      });
      for (let start = 0, read = 0; ; read++) {
        if (read === 10) { more = true; break; }
        const data = z.object({ values: z.array(z.unknown()), isLastPage: z.boolean().optional(), nextPageStart: z.number().int().nonnegative().nullish() })
          .parse((await this.json(`${endpoint}/activities?limit=50${start ? `&start=${start}` : ""}`, signal)).data);
        for (const item of data.values) {
          const parsed = z.object({ action: z.literal("COMMENTED"), commentAction: z.string().optional(), comment: said,
            commentAnchor: z.object({ path: z.string().nullish(), line: z.number().int().nullish(), fileType: z.string().nullish() }).nullish() }).safeParse(item);
          if (!parsed.success || seen.has(parsed.data.comment.id)) continue;
          seen.add(parsed.data.comment.id);
          if (parsed.data.commentAction === "DELETED") continue;
          const comment = parsed.data.comment, anchor = parsed.data.commentAnchor;
          threads.push({ id: String(comment.id), url: `${web}/projects/${enc(projectKey)}/repos/${enc(slug)}/pull-requests/${number}/overview?commentId=${comment.id}`, ...by(comment),
            path: anchor?.path ?? null, line: anchor?.line ?? null, side: anchor?.path && anchor.line ? anchor.fileType === "FROM" ? "old" : "new" : null, body: comment.text, createdAt: new Date(comment.createdDate).toISOString(),
            task: comment.severity === "BLOCKER" ? comment.state === "RESOLVED" ? "resolved" : "open" : null, resolved: comment.threadResolved ?? null, replies: under(comment) });
        }
        if (data.isLastPage !== false || data.nextPageStart == null || data.nextPageStart <= start) break;
        start = data.nextPageStart;
      }
      return { threads, more };
    }
    // GitHub's and GitLab's numbered pages, ten at most.
    const pages = async (path: string, each: (item: unknown) => void) => {
      for (let page = 1; ; page++) {
        if (page > 10) { more = true; return; }
        const response = await this.json(`${path}${path.includes("?") ? "&" : "?"}per_page=100${page > 1 ? `&page=${page}` : ""}`, signal, { bytes: MAX_LIST_PAGE });
        for (const item of z.array(z.unknown()).parse(response.data)) each(item);
        if (!response.next) return;
      }
    };
    if (this.connection.platform === "gitlab") {
      const note = z.object({ id, body: z.string(), created_at: z.string(), system: z.boolean().optional(), author: z.object({ username: z.string().optional(), name: z.string().optional() }).nullish(),
        position: z.object({ new_path: z.string().nullish(), old_path: z.string().nullish(), new_line: z.number().int().nullish(), old_line: z.number().int().nullish() }).nullish().catch(null),
        resolvable: z.boolean().optional(), resolved: z.boolean().optional() });
      type Note = z.infer<typeof note>;
      const by = (item: Note) => ({ author: item.author?.name ?? item.author?.username ?? "", login: item.author?.username ?? "" });
      await pages(`${endpoint}/discussions`, (item) => {
        const discussion = z.object({ id: z.string(), notes: z.array(z.unknown()) }).safeParse(item);
        if (!discussion.success) return;
        const notes = discussion.data.notes.flatMap((value) => { const parsed = note.safeParse(value); return parsed.success && !parsed.data.system ? [parsed.data] : []; });
        const [root, ...rest] = notes;
        if (!root) return;
        threads.push({ id: String(root.id), url: `${web}/${repoPath(repository)}/-/merge_requests/${number}#note_${root.id}`, ...by(root),
          path: root.position?.new_path ?? root.position?.old_path ?? null, line: root.position?.new_line ?? root.position?.old_line ?? null,
          side: root.position?.new_line ? "new" : root.position?.old_line ? "old" : null, body: root.body, createdAt: root.created_at,
          task: null, resolved: root.resolvable ? root.resolved ?? false : null, discussion: discussion.data.id,
          replies: rest.map((reply) => ({ id: String(reply.id), ...by(reply), body: reply.body, createdAt: reply.created_at })) });
      });
      return { threads, more };
    }
    // GitHub: a line comment answers the one opening its thread (in_reply_to_id); the conversation has no threads.
    const said = z.object({ id, body: z.string().nullish(), created_at: z.string(), path: z.string().nullish(), line: z.number().int().nullish(), original_line: z.number().int().nullish(),
      side: z.string().nullish(), in_reply_to_id: id.nullish(), user: z.object({ login: z.string() }).nullish() });
    const roots = new Map<string, PrThread>();
    const answers: Array<[string, PrThreadReply]> = [];
    await pages(`${endpoint}/comments`, (item) => {
      const parsed = said.safeParse(item);
      if (!parsed.success) return;
      const comment = parsed.data, login = comment.user?.login ?? "";
      if (comment.in_reply_to_id) { answers.push([String(comment.in_reply_to_id), { id: String(comment.id), author: login, login, body: comment.body ?? "", createdAt: comment.created_at }]); return; }
      roots.set(String(comment.id), { id: String(comment.id), url: `${web}/${repoPath(repository)}/pull/${number}#discussion_r${comment.id}`, author: login, login,
        path: comment.path ?? null, line: comment.line ?? comment.original_line ?? null, side: comment.path ? comment.side === "LEFT" ? "old" : "new" : null,
        body: comment.body ?? "", createdAt: comment.created_at, task: null, resolved: null, replies: [] });
    });
    for (const [root, reply] of answers) roots.get(root)?.replies.push(reply);
    await pages(`/repos/${repoPath(repository)}/issues/${number}/comments`, (item) => {
      const parsed = said.safeParse(item);
      if (!parsed.success) return;
      const comment = parsed.data, login = comment.user?.login ?? "";
      roots.set(`issuecomment-${comment.id}`, { id: `issuecomment-${comment.id}`, url: `${web}/${repoPath(repository)}/pull/${number}#issuecomment-${comment.id}`, author: login, login,
        path: null, line: null, side: null, body: comment.body ?? "", createdAt: comment.created_at, task: null, resolved: null, replies: [] });
    });
    // Which threads are resolved, by the first comment of each: not read (no GraphQL, a failure), they stay unknown.
    if (this.query) {
      const [owner, name] = repository.split("/");
      try {
        const response = await this.query("/graphql", { query: "query Resolved($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes { isResolved comments(first: 1) { nodes { databaseId } } } } } } }", variables: { owner, name, number: Number(number) } }, signal);
        const nodes = z.object({ data: z.object({ repository: z.object({ pullRequest: z.object({ reviewThreads: z.object({ nodes: z.array(z.object({ isResolved: z.boolean(), comments: z.object({ nodes: z.array(z.object({ databaseId: z.number().nullable() })) }) })) }) }) }) }) })
          .parse(JSON.parse(response.text)).data.repository.pullRequest.reviewThreads.nodes;
        for (const node of nodes) { const first = node.comments.nodes[0]?.databaseId; const thread = first ? roots.get(String(first)) : undefined; if (thread) thread.resolved = node.isResolved; }
      } catch (error) { signal?.throwIfAborted(); }
    }
    return { threads: [...roots.values()], more };
  }

  /**
   * What 评审质量's team figures count of a PR: when it opened and merged, each person's approvals and when, and how many
   * comments people wrote on it (Paraself's own, signed "— Paraself …", and bots' are not people's). Read once it merged.
   */
  async teamFacts(reference: string, signal?: AbortSignal): Promise<PrTeamFacts> {
    const endpoint = this.endpoint(reference);
    const { data } = await this.json(endpoint, signal);
    const approvals: PrTeamFacts["approvals"] = [];
    const iso = (at: number) => new Date(at).toISOString();
    // Ten pages of each at most, as the threads are read.
    const numbered = async (path: string, each: (item: unknown) => void) => {
      for (let page = 1; page <= 10; page++) {
        const response = await this.json(`${path}${path.includes("?") ? "&" : "?"}per_page=100${page > 1 ? `&page=${page}` : ""}`, signal, { bytes: MAX_LIST_PAGE });
        for (const item of z.array(z.unknown()).parse(response.data)) each(item);
        if (!response.next) return;
      }
    };
    let facts: Omit<PrTeamFacts, "approvals" | "humanComments">;
    if (this.connection.platform === "bitbucket-server") {
      const pr = z.object({ title: z.string(), description: z.string().nullish(), createdDate: z.number(), closedDate: z.number().nullish(), state: z.string() }).parse(data);
      facts = { title: pr.title, description: (pr.description ?? "").slice(0, 2_000), createdAt: iso(pr.createdDate), mergedAt: pr.state === "MERGED" && pr.closedDate ? iso(pr.closedDate) : null };
      for (let start = 0, read = 0; read < 10; read++) {
        const page = z.object({ values: z.array(z.unknown()), isLastPage: z.boolean().optional(), nextPageStart: z.number().int().nonnegative().nullish() })
          .parse((await this.json(`${endpoint}/activities?limit=50${start ? `&start=${start}` : ""}`, signal)).data);
        for (const item of page.values) {
          const approved = z.object({ action: z.literal("APPROVED"), createdDate: z.number(), user: z.object({ name: z.string(), type: z.string().optional() }) }).safeParse(item);
          if (approved.success && approved.data.user.type !== "SERVICE") approvals.push({ login: approved.data.user.name, at: iso(approved.data.createdDate) });
        }
        if (page.isLastPage !== false || page.nextPageStart == null || page.nextPageStart <= start) break;
        start = page.nextPageStart;
      }
    } else if (this.connection.platform === "github") {
      const pr = z.object({ title: z.string(), body: z.string().nullish(), created_at: z.string(), merged_at: z.string().nullable() }).parse(data);
      facts = { title: pr.title, description: (pr.body ?? "").slice(0, 2_000), createdAt: pr.created_at, mergedAt: pr.merged_at };
      await numbered(`${endpoint}/reviews`, (item) => {
        const review = z.object({ state: z.string(), submitted_at: z.string().nullish(), user: z.object({ login: z.string(), type: z.string().optional() }).nullish() }).safeParse(item);
        if (review.success && review.data.state === "APPROVED" && review.data.user && review.data.user.type !== "Bot" && review.data.submitted_at) approvals.push({ login: review.data.user.login, at: review.data.submitted_at });
      });
    } else {
      const pr = z.object({ title: z.string(), description: z.string().nullish(), created_at: z.string(), merged_at: z.string().nullish() }).parse(data);
      facts = { title: pr.title, description: (pr.description ?? "").slice(0, 2_000), createdAt: pr.created_at, mergedAt: pr.merged_at ?? null };
      // GitLab says an approval as a system note.
      await numbered(`${endpoint}/notes?sort=asc&order_by=created_at`, (item) => {
        const note = z.object({ system: z.boolean().optional(), body: z.string(), created_at: z.string(), author: z.object({ username: z.string(), bot: z.boolean().optional() }).nullish() }).safeParse(item);
        if (note.success && note.data.system && /^approved this merge request/u.test(note.data.body) && note.data.author && !note.data.author.bot) approvals.push({ login: note.data.author.username, at: note.data.created_at });
      });
    }
    const { threads } = await this.threads(reference, signal);
    const humanComments = threads.flatMap((thread) => [thread, ...thread.replies]).filter((item) => !/^— Paraself /mu.test(item.body) && !/\[bot\]$/u.test(item.login)).length;
    return { ...facts, approvals: approvals.slice(0, 200), humanComments };
  }

  /**
   * A reply in a comment's thread, with the user's account. GitHub's conversation has no threads: there the reply is a
   * new comment quoting the one it answers. Resolves to the reply's id.
   */
  async reply(reference: string, thread: Pick<PrThread, "id" | "author" | "body" | "discussion">, body: string): Promise<string> {
    if (!this.write) throw new Error("当前连接未启用平台写入。");
    const endpoint = this.endpoint(reference);
    const platform = this.connection.platform;
    if (platform === "gitlab" && !thread.discussion) throw new Error("没有读到这条意见所在的讨论，无法回复。");
    const quoted = `> ${thread.author}：${clipText(thread.body.trim().split("\n")[0] ?? "", 120)}\n\n${body}`;
    const [path, payload] = platform === "bitbucket-server" ? [`${endpoint}/comments`, { text: bitbucketText(body), parent: { id: Number(thread.id) } }]
      : platform === "gitlab" ? [`${endpoint}/discussions/${enc(thread.discussion!)}/notes`, { body }]
        : thread.id.startsWith("issuecomment-") ? [`${endpoint.replace(/\/pulls\//u, "/issues/")}/comments`, { body: quoted }]
          : [`${endpoint}/comments/${enc(thread.id)}/replies`, { body }];
    const response = await this.write(path, "POST", payload);
    let posted: unknown;
    try { posted = JSON.parse(response.text); } catch { posted = null; }
    const said = z.object({ id: z.union([z.number(), z.string()]) }).safeParse(posted);
    if (!said.success) throw new Error("平台已返回响应，但无法确认回复已发出。请先到平台核对，避免重复回复。");
    return String(said.data.id);
  }

  /** The PR's title and description as its platform has them now, and their version, which a write back must match. */
  async readDescription(reference: string): Promise<PrDescription> {
    const read = this.descriptionOf((await this.json(this.endpoint(reference))).data);
    return prDescriptionSchema.parse({ title: read.title, description: read.description.slice(0, 65_536), version: prDescriptionVersion(read.description) });
  }
  private descriptionOf(data: unknown) {
    const platform = this.connection.platform;
    const pr = z.object({ title: label, body: z.string().nullish(), description: z.string().nullish(),
      state: z.string(), merged: z.boolean().optional() }).passthrough().parse(data);
    const open = platform === "github" ? pr.state === "open" && !pr.merged : platform === "gitlab" ? pr.state === "opened" : pr.state === "OPEN";
    return { title: pr.title, description: (platform === "github" ? pr.body : pr.description) ?? "", open, raw: data };
  }
  /**
   * The description written back, as the author confirmed it, over the version read: one changed since is not written
   * over. Bitbucket's write carries the PR's title and reviewers as they are (left out, its reviewers went with them).
   */
  async updateDescription(input: PrDescriptionUpdate): Promise<PrDescriptionUpdateResult> {
    const request = prDescriptionUpdateSchema.parse(input);
    if (!this.write) throw new Error("当前连接未启用平台写入。");
    const endpoint = this.endpoint(request.reference);
    const now = this.descriptionOf((await this.json(endpoint)).data);
    if (!now.open) throw new Error("PR 已合并或关闭，不再改描述。");
    if (prDescriptionVersion(now.description) !== request.baseVersion) throw new PrDescriptionMovedError();
    const platform = this.connection.platform;
    const description = platform === "bitbucket-server" ? bitbucketText(request.description) : request.description;
    const dropped = description !== request.description;
    const submit = async (method: "PUT" | "PATCH", body: Record<string, unknown>) => {
      const response = await this.write!(endpoint, method, body);
      try { return JSON.parse(response.text) as unknown; }
      catch { throw new Error("平台已接收请求，但返回结果无法确认。请先到平台核对 PR 描述。"); }
    };
    try {
      let written: string | null | undefined;
      if (platform === "github") written = z.object({ body: z.string().nullable() }).parse(await submit("PATCH", { body: description })).body;
      else if (platform === "gitlab") written = z.object({ description: z.string().nullable() }).parse(await submit("PUT", { description })).description;
      else {
        const pr = z.object({ version: z.number().int().nonnegative(), reviewers: z.array(z.object({ user: z.object({ name: z.string() }) })).default([]) }).parse(now.raw);
        written = z.object({ description: z.string().nullish() }).parse(await submit("PUT", { version: pr.version, title: now.title, description, reviewers: pr.reviewers.map((reviewer) => ({ user: { name: reviewer.user.name } })) })).description;
      }
      const same = (text: string) => text.replace(/\r\n/gu, "\n").trim();
      if (same(written ?? "") !== same(description)) throw new Error("平台返回的 PR 描述和写回的不一致，请到平台核对。");
    } catch (error) {
      if (error instanceof z.ZodError) throw new Error("平台已返回响应，但无法确认 PR 描述已更新。请先到平台核对。");
      throw error;
    }
    return { message: `PR 描述已更新。${dropped ? "Bitbucket 存不下表情符号，已去掉。" : ""}` };
  }

  /**
   * What stands between the PR and its merge as its platform keeps it now: its head commit's checks, who approved it
   * (people only: a bot's or a service account's approval is no person's), and what is still open that blocks it. A
   * part that cannot be read is said in `problems` and left unknown, never shown as none; only the PR itself not read
   * fails the whole.
   */
  async status(reference: string, signal?: AbortSignal): Promise<PrReviewStatus> {
    const endpoint = this.endpoint(reference);
    const { data } = await this.json(endpoint, signal);
    const problems: string[] = [];
    // The description as it stands, read with the rest: written back since the review, the template's parts are seen at once.
    const sections = (() => {
      const text = z.object({ body: z.string().nullish(), description: z.string().nullish() }).safeParse(data);
      return text.success ? prDescriptionSections((this.connection.platform === "github" ? text.data.body : text.data.description) ?? "") : null;
    })();
    const part = async <T,>(what: string, read: () => Promise<T>): Promise<T | null> => {
      try { return await read(); } catch (error) {
        signal?.throwIfAborted();
        problems.push(clipText(`${what}读不到：${error instanceof z.ZodError ? "平台返回的内容格式不认识。" : error instanceof Error ? error.message : String(error)}`, 300));
        return null;
      }
    };
    const count = z.number().int().nonnegative();
    // Failed if any failed, running if any still runs; passed only when every source was read and something passed.
    const combined = (states: PrBuildState[], unread: boolean): PrBuildState =>
      states.includes("failed") ? "failed" : states.includes("running") ? "running" : unread ? "unknown" : states.length ? "passed" : "none";
    // Each approver as shown and as the platform names them; `on` the commit they approved, where the platform says.
    type Approver = { shown: string; login: string; on?: string | undefined };
    const done = (sourceCommit: string, build: PrBuildState, approvers: Approver[] | null, blockers: number | null, blocking: PrReviewStatus["blocking"], blockersHold: boolean | null) => {
      const fresh = approvers?.filter((item) => !item.on || item.on === sourceCommit) ?? [];
      const names = (items: Approver[], key: "shown" | "login") => items.slice(0, 50).map((item) => item[key].slice(0, 200));
      return prReviewStatusSchema.parse({ sourceCommit, build, blockers, blocking, blockersHold, sections, problems: problems.slice(0, 10),
        approvals: approvers && { count: fresh.length, users: names(fresh, "shown"), logins: names(fresh, "login"), stale: names(approvers.filter((item) => !fresh.includes(item)), "shown") } });
    };
    // A setting the token may not read (most are an administrator's): unknown, never said as off.
    const setting = async <T,>(read: () => Promise<T | null>): Promise<T | null> => {
      try { return await read(); } catch { signal?.throwIfAborted(); return null; }
    };
    if (this.connection.platform === "bitbucket-server") {
      const person = z.object({ user: z.object({ name: z.string(), displayName: z.string().optional(), type: z.string().optional() }), approved: z.boolean(), lastReviewedCommit: sha.optional().catch(undefined) });
      const pr = z.object({ fromRef: z.object({ latestCommit: sha }), reviewers: z.array(person).default([]), participants: z.array(person).default([]),
        properties: z.object({ openTaskCount: count.optional() }).nullish() }).parse(data);
      const approvers = [...new Map([...pr.reviewers, ...pr.participants].filter((item) => item.approved && item.user.type !== "SERVICE")
        .map((item) => [item.user.name, { shown: item.user.displayName ?? item.user.name, login: item.user.name, on: item.lastReviewedCommit }])).values()];
      // Tasks are blocker comments since 7.2; a server that no longer counts them on the PR is asked for them.
      const blockers = pr.properties?.openTaskCount ?? await part("未完成的任务", async () => {
        const page = z.object({ size: count, isLastPage: z.boolean() }).parse((await this.json(`${endpoint}/blocker-comments?state=OPEN&limit=1000`, signal, { bytes: MAX_LIST_PAGE })).data);
        if (!page.isLastPage) throw new Error("超过 1000 项。");
        return page.size;
      });
      const stats = await part("构建状态", async () => z.object({ successful: count, inProgress: count, failed: count, cancelled: count.optional(), unknown: count.optional() })
        .parse((await this.json(`/rest/build-status/1.0/commits/stats/${pr.fromRef.latestCommit}`, signal)).data));
      const build = stats === null ? "unknown" : combined([...(stats.failed + (stats.cancelled ?? 0) ? ["failed" as const] : []), ...(stats.inProgress ? ["running" as const] : []), ...(stats.successful ? ["passed" as const] : [])], (stats.unknown ?? 0) > 0);
      // The "no incomplete tasks" merge check: a bundled hook since 5, a pull request setting before.
      const repository = endpoint.replace(/\/pull-requests\/\d+$/u, "");
      const hold = await setting(async () => z.object({ enabled: z.boolean() }).parse((await this.json(`${repository}/settings/hooks/${enc("com.atlassian.bitbucket.server.bitbucket-bundled-hooks:incomplete-tasks-merge-check")}`, signal)).data).enabled)
        ?? await setting(async () => z.object({ requiredAllTasksComplete: z.boolean() }).parse((await this.json(`${repository}/settings/pull-requests`, signal)).data).requiredAllTasksComplete);
      return done(pr.fromRef.latestCommit, build, approvers, blockers, "tasks", hold);
    }
    if (this.connection.platform === "github") {
      const pr = ghPr.extend({ base: ghPr.shape.base.extend({ ref: z.string() }) }).parse(data);
      const head = pr.head.sha;
      const { repository, number } = parsePrReference(reference);
      const repo = `/repos/${repoPath(repository)}`;
      // A person's latest review that decides (not a comment) is where they stand, on the commit it was given on; a bot's is no person's.
      const approvers = await part("批准", async () => {
        const latest = new Map<string, { state: string; on: string | undefined }>();
        for (let page = 1; page <= 10; page++) {
          const read = await this.json(`${endpoint}/reviews?per_page=100&page=${page}`, signal, { bytes: MAX_LIST_PAGE });
          for (const review of z.array(z.object({ user: z.object({ login: z.string(), type: z.string().optional() }).nullable(), state: z.string(), commit_id: sha.nullish().catch(null) })).parse(read.data)) {
            if (review.user && review.user.type !== "Bot" && review.state !== "COMMENTED" && review.state !== "PENDING") latest.set(review.user.login, { state: review.state, on: review.commit_id ?? undefined });
          }
          if (!read.next) break;
        }
        return [...latest].filter(([, review]) => review.state === "APPROVED").map(([login, review]) => ({ shown: login, login, on: review.on }));
      });
      // Commit statuses (combined, "pending" with none at all) and check runs, both.
      const statuses = await part("提交状态", async () => z.object({ state: z.string(), total_count: count }).parse((await this.json(`${repo}/commits/${head}/status`, signal)).data));
      const checks = await part("检查", async () => z.object({ total_count: count, check_runs: z.array(z.object({ status: z.string(), conclusion: z.string().nullable() })) })
        .parse((await this.json(`${repo}/commits/${head}/check-runs?per_page=100`, signal, { bytes: MAX_LIST_PAGE })).data));
      const build = combined([
        ...(statuses?.total_count ? [statuses.state === "success" ? "passed" as const : statuses.state === "pending" ? "running" as const : "failed" as const] : []),
        ...(checks?.check_runs ?? []).map((run): PrBuildState => run.status !== "completed" ? "running" : ["success", "neutral", "skipped"].includes(run.conclusion ?? "") ? "passed" : "failed"),
      ], statuses === null || checks === null || checks.total_count > checks.check_runs.length);
      const blockers = await part("未解决的讨论", async () => {
        if (!this.query) throw new Error("平台查询不可用。");
        const [owner, name] = repository.split("/");
        const response = await this.query("/graphql", { query: "query Threads($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100) { totalCount nodes { isResolved } } } } }", variables: { owner, name, number: Number(number) } }, signal);
        const threads = z.object({ data: z.object({ repository: z.object({ pullRequest: z.object({ reviewThreads: z.object({ totalCount: count, nodes: z.array(z.object({ isResolved: z.boolean() })) }) }) }) }) })
          .parse(JSON.parse(response.text)).data.repository.pullRequest.reviewThreads;
        if (threads.totalCount > threads.nodes.length) throw new Error(`讨论超过 ${threads.nodes.length} 个。`);
        return threads.nodes.filter((thread) => !thread.isResolved).length;
      });
      // "Require conversation resolution": a ruleset anyone reading the repository sees, or classic protection an administrator does.
      const branch = enc(pr.base.ref);
      const ruled = await setting(async () => z.array(z.object({ type: z.string(), parameters: z.object({ required_review_thread_resolution: z.boolean().optional() }).passthrough().optional() }))
        .parse((await this.json(`${repo}/rules/branches/${branch}`, signal)).data).some((rule) => rule.type === "pull_request" && rule.parameters?.required_review_thread_resolution === true));
      const hold = ruled === true ? true : await setting(async () => z.object({ required_conversation_resolution: z.object({ enabled: z.boolean() }).nullish() })
        .parse((await this.json(`${repo}/branches/${branch}/protection`, signal)).data).required_conversation_resolution?.enabled ?? false);
      return done(head, build, approvers, blockers, "discussions", hold);
    }
    const pr = z.object({ diff_refs: z.object({ head_sha: sha }).nullable(), head_pipeline: z.object({ sha, status: z.string() }).nullish() }).parse(data);
    if (!pr.diff_refs) throw new Error("合并请求的提交尚未准备好，请刷新。");
    const head = pr.diff_refs.head_sha;
    const pipeline = pr.head_pipeline;
    if (pipeline && pipeline.sha !== head) problems.push("最新提交的流水线还没有结果。");
    const build: PrBuildState = !pipeline ? "none" : pipeline.sha !== head ? "unknown" : pipeline.status === "success" ? "passed"
      : ["failed", "canceled"].includes(pipeline.status) ? "failed" : pipeline.status === "skipped" ? "none" : "running";
    const approvers = await part("批准", async () => z.object({ approved_by: z.array(z.object({ user: z.object({ username: z.string(), name: z.string().optional() }) })) })
      .parse((await this.json(`${endpoint}/approvals`, signal)).data).approved_by.map(({ user }) => ({ shown: user.name ?? user.username, login: user.username })));
    const blockers = await part("未解决的讨论", async () => {
      let open = 0;
      for (let page = 1; ; page++) {
        if (page > 10) throw new Error("讨论超过 1000 个。");
        const read = await this.json(`${endpoint}/discussions?per_page=100&page=${page}`, signal, { bytes: MAX_LIST_PAGE });
        open += z.array(z.object({ notes: z.array(z.object({ resolvable: z.boolean().optional(), resolved: z.boolean().optional() })) })).parse(read.data)
          .filter((discussion) => discussion.notes.some((note) => note.resolvable && !note.resolved)).length;
        if (!read.next) return open;
      }
    });
    const hold = await setting(async () => z.object({ only_allow_merge_if_all_discussions_are_resolved: z.boolean() })
      .parse((await this.json(`/projects/${enc(parsePrReference(reference).repository)}`, signal)).data).only_allow_merge_if_all_discussions_are_resolved);
    return done(head, build, approvers, blockers, "discussions", hold);
  }

  async list(input: PrListQuery): Promise<PrListResponse> {
    const merged = input.state === "merged";
    if (this.connection.platform === "github") {
      // Once merged, a review request is gone; who reviewed it is what remains.
      const role = input.filter === "created" ? "author:@me" : merged ? "reviewed-by:@me" : "review-requested:@me";
      const response = await this.json(`/search/issues?q=${enc(`is:pr is:${merged ? "merged" : "open"} ${role}`)}&sort=updated&order=desc&per_page=30&page=${input.page}`, undefined, { bytes: MAX_LIST_PAGE });
      const data = z.object({ incomplete_results: z.boolean(), total_count: z.number(), items: z.array(z.object({ number: z.number().int().positive(), title: label, repository_url: z.string().url(), user, updated_at: z.string() })) }).parse(response.data);
      if (data.incomplete_results) throw new Error("平台搜索未完整完成，请刷新列表重试。");
      return prListResponseSchema.parse({ items: data.items.map((item) => {
        const url = new URL(item.repository_url);
        const api = new URL(prApiBase(this.connection));
        if (url.origin !== api.origin || !url.pathname.startsWith(`${api.pathname.replace(/\/$/u, "")}/repos/`)) throw new Error("平台返回了不属于此连接的仓库。");
        const repository = repoName.parse(decodeURIComponent(url.pathname.split("/repos/")[1]!));
        return { reference: `${repository}#${item.number}`, repository, number: String(item.number), title: item.title, author: item.user.login ?? "", updatedAt: item.updated_at };
      }), nextPage: response.next || input.page * 30 < Math.min(data.total_count, 1_000) ? input.page + 1 : null });
    }
    if (this.connection.platform === "gitlab") {
      const me = z.object({ id: z.number().int().positive() }).parse((await this.json("/user")).data);
      const response = await this.json(`/merge_requests?scope=all&state=${merged ? "merged" : "opened"}&${input.filter === "created" ? "author_id" : "reviewer_id"}=${me.id}&order_by=updated_at&per_page=30&page=${input.page}`, undefined, { bytes: MAX_LIST_PAGE });
      const items = z.array(z.object({ iid: z.number().int().positive(), web_url: z.string().url(), title: label, author: user, updated_at: z.string(), user_notes_count: z.number().int().nonnegative().optional() })).parse(response.data);
      const base = new URL(prApiBase(this.connection).replace(/\/api\/v4$/u, ""));
      return prListResponseSchema.parse({ items: items.map((item) => {
        const url = new URL(item.web_url);
        const prefix = base.pathname.replace(/\/$/u, "") + "/";
        if (url.origin !== base.origin || !url.pathname.startsWith(prefix) || !url.pathname.includes("/-/merge_requests/")) throw new Error("平台返回了不属于此连接的合并请求。");
        const repository = repoName.parse(decodeURIComponent(url.pathname.slice(prefix.length).split("/-/merge_requests/")[0]!));
        return { reference: `${repository}#${item.iid}`, repository, number: String(item.iid), title: item.title, author: item.author.name ?? "", updatedAt: item.updated_at,
          ...(item.user_notes_count === undefined ? {} : { comments: item.user_notes_count }) };
      }), nextPage: response.next ? input.page + 1 : null });
    }
    const response = await this.json(`/rest/api/1.0/dashboard/pull-requests?role=${input.filter === "created" ? "AUTHOR" : "REVIEWER"}&state=${merged ? "MERGED" : "OPEN"}&limit=30&start=${input.page - 1}`, undefined, { bytes: MAX_LIST_PAGE });
    const data = z.object({ values: z.array(bbPr), isLastPage: z.boolean(), nextPageStart: z.number().int().nonnegative().optional() }).parse(response.data);
    if (!data.isLastPage && data.nextPageStart === undefined) throw new Error("平台分页信息缺失，请刷新重试。");
    return prListResponseSchema.parse({ items: data.values.map((item) => {
      const repository = `${item.toRef.repository.project.key}/${item.toRef.repository.slug}`;
      // Properties without a count read as none, so a PR's first comment moves it too.
      return { reference: `${repository}#${item.id}`, repository, number: String(item.id), title: item.title, author: item.author.user.displayName ?? item.author.user.name ?? "", updatedAt: new Date(item.updatedDate).toISOString(),
        ...(item.properties ? { comments: item.properties.commentCount ?? 0 } : {}) };
    }), nextPage: data.isLastPage ? null : data.nextPageStart! + 1 });
  }

  async get(reference: string, signal?: AbortSignal): Promise<PrDetails> {
    const { data } = await this.json(this.endpoint(reference), signal);
    // Only review rules scoped to a target branch need the name; its absence is not an error.
    const destinationBranch = (this.connection.platform === "github" ? z.object({ base: z.object({ ref: z.string() }) }).safeParse(data).data?.base.ref :
      this.connection.platform === "gitlab" ? z.object({ target_branch: z.string() }).safeParse(data).data?.target_branch :
        z.object({ toRef: z.object({ displayId: z.string() }) }).safeParse(data).data?.toRef.displayId)?.slice(0, 500);
    const branchName = destinationBranch ? { destinationBranch } : {};
    if (this.connection.platform === "github") {
      const pr = ghPr.parse(data);
      if (!pr.head.repo) throw new Error("PR 的来源仓库已不可用。");
      const base = await this.mergeBase(reference, pr.head.sha, pr.base.sha, signal);
      return prDetailsSchema.parse({ title: pr.title, description: pr.body, source: { repository: pr.head.repo.full_name, commit: pr.head.sha }, destination: { repository: pr.base.repo.full_name, commit: pr.base.sha }, ...(base ? { base } : {}), ...branchName });
    }
    if (this.connection.platform === "gitlab") {
      const pr = glPr.parse(data);
      if (!pr.diff_refs || !pr.source_project_id) throw new Error("合并请求的提交快照尚不可用，请稍后刷新。");
      return prDetailsSchema.parse({ title: pr.title, description: pr.description, source: { repository: String(pr.source_project_id), commit: pr.diff_refs.head_sha }, destination: { repository: parsePrReference(reference).repository, commit: pr.diff_refs.start_sha }, base: pr.diff_refs.base_sha, ...branchName });
    }
    const pr = bbPr.parse(data);
    const map = (ref: z.infer<typeof bbRef>) => ({ repository: `${ref.repository.project.key}/${ref.repository.slug}`, commit: ref.latestCommit });
    const base = await this.mergeBase(reference, pr.fromRef.latestCommit, pr.toRef.latestCommit, signal);
    return prDetailsSchema.parse({ title: pr.title, description: pr.description, source: map(pr.fromRef), destination: map(pr.toRef), ...(base ? { base } : {}), ...branchName });
  }
  /**
   * Where the platform's diff starts: the merge base, which the "-" lines and their numbers belong to (GitHub and
   * Bitbucket diff a PR from it). The target's tip moves on after the PR branched: read there, the old side was another
   * file, or none. Read once per commit pair. Not to be had (Bitbucket before 8.16 has no such endpoint, a comparison
   * past the response cap), the old side is read at the tip as before; a passing outage is asked again next time.
   */
  private async mergeBase(reference: string, source: string, destination: string, signal?: AbortSignal): Promise<string | undefined> {
    const endpoint = this.endpoint(reference);
    const key = `${this.connection.id}\n${endpoint}\n${source}\n${destination}`;
    if (!basesRead.has(key)) {
      const github = this.connection.platform === "github";
      const found = await this.json(github ? `/repos/${repoPath(parsePrReference(reference).repository)}/compare/${destination}...${source}?per_page=1` : `${endpoint}/merge-base`, signal)
        .then((response) => github ? z.object({ merge_base_commit: z.object({ sha }) }).parse(response.data).merge_base_commit.sha : z.object({ id: sha }).parse(response.data).id)
        .catch((error: unknown) => {
          signal?.throwIfAborted();
          // A rate limit passes too: kept as "none", the old side was read at the tip for as long as the App ran.
          return error instanceof PrPlatformUnreachable || (error instanceof PrPlatformError && (error.status >= 500 || error.status === 429)) ? undefined : null;
        });
      if (found === undefined) return undefined;
      basesRead.set(key, found);
      while (basesRead.size > 16) basesRead.delete(basesRead.keys().next().value!);
    }
    return basesRead.get(key) ?? undefined;
  }

  /** GitHub's and GitLab's numbered pages of 100 files, each with its patch, as many as PR_REVIEW_MAX_FILES takes. */
  private async *numbered(path: string, signal?: AbortSignal): AsyncGenerator<unknown> {
    for (let page = 1; page <= PR_REVIEW_MAX_FILES / 100; page++) {
      const response = await this.json(`${path}?per_page=100${page > 1 ? `&page=${page}` : ""}`, signal, { bytes: MAX_LIST_PAGE });
      yield response.data;
      if (!response.next) return;
    }
  }
  /**
   * Every changed file, page by page, up to PR_REVIEW_MAX_FILES. Refused past 100, a large PR could not be opened at all;
   * a file whose diff the platform cut (GitLab's too_large or collapsed) is listed still, and named as not reviewed when
   * the diff has none for it.
   */
  async files(reference: string, signal?: AbortSignal) {
    const endpoint = this.endpoint(reference);
    const listed: Array<{ path: string; status: string; unsupported?: true }> = [];
    if (this.connection.platform === "bitbucket-server") {
      for (let start = 0; listed.length < PR_REVIEW_MAX_FILES;) {
        const data = z.object({ isLastPage: z.boolean(), nextPageStart: z.number().int().nonnegative().nullish(), values: z.array(z.object({ path: z.object({ toString: z.string() }), type: z.string() })) })
          .parse((await this.json(`${endpoint}/changes?limit=500${start ? `&start=${start}` : ""}`, signal)).data);
        listed.push(...data.values.map((item) => listedFile(item.path.toString, item.type)));
        if (data.isLastPage) break;
        if (data.nextPageStart == null || data.nextPageStart <= start) throw new Error("平台分页信息缺失，请刷新重试。");
        start = data.nextPageStart;
      }
    } else if (this.connection.platform === "github") {
      const read = await this.githubFiles(endpoint, signal);
      listed.push(...read.files);
      this.listedDiff = { endpoint, diff: read.diff };
    } else {
      for await (const data of this.numbered(`${endpoint}/diffs`, signal)) {
        listed.push(...z.array(z.object({ new_path: z.string(), deleted_file: z.boolean(), new_file: z.boolean() })).parse(data)
          .map((item) => listedFile(item.new_path, item.deleted_file ? "deleted" : item.new_file ? "added" : "modified")));
      }
    }
    return listed.slice(0, PR_REVIEW_MAX_FILES);
  }
  async diff(reference: string, signal?: AbortSignal): Promise<string> {
    const endpoint = this.endpoint(reference);
    const github = this.connection.platform === "github";
    const listed = this.listedDiff;
    this.listedDiff = undefined;
    const suffix = github ? "" : this.connection.platform === "gitlab" ? "/raw_diffs" : "/diff";
    const page = await this.read(endpoint + suffix, github ? "application/vnd.github.diff" : "text/plain", signal, { clip: true }).catch(async (error: unknown): Promise<Page> => {
      // GitHub gives no whole diff past 300 files or 20,000 lines (HTTP 406); its file list still carries each file's
      // patch, which is how pr-agent reads a GitHub PR. The list just read is not read again.
      if (!github || !(error instanceof PrPlatformError) || error.status !== 406) throw error;
      return { text: listed?.endpoint === endpoint ? listed.diff : (await this.githubFiles(endpoint, signal)).diff, next: false };
    });
    return page.clipped ? wholeFiles(page.text) : page.text;
  }
  /**
   * What changed between two commits of the PR's source repository (from the commit a review read to the head now), as
   * unified diff, cut back to whole files past the cap: what a later round reviews. Read where the commits are, a
   * fork's included.
   */
  async rangeDiff(pr: PrDetails, from: string, to: string, signal?: AbortSignal): Promise<string> {
    sha.parse(from); sha.parse(to);
    const source = pr.source.repository;
    if (this.connection.platform === "gitlab") {
      const data = z.object({ diffs: z.array(z.object({ old_path: z.string(), new_path: z.string(), diff: z.string() })) })
        .parse((await this.json(`/projects/${enc(source)}/repository/compare?from=${from}&to=${to}`, signal, { bytes: MAX_LIST_PAGE })).data);
      return data.diffs.map((file) => `diff --git a/${file.old_path} b/${file.new_path}\n--- a/${file.old_path}\n+++ b/${file.new_path}\n${file.diff}`).join("\n");
    }
    const [project, slug] = source.split("/");
    const page = this.connection.platform === "github"
      ? await this.read(`/repos/${repoPath(source)}/compare/${from}...${to}`, "application/vnd.github.diff", signal, { clip: true })
      : await this.read(`/rest/api/1.0/projects/${enc(project!)}/repos/${enc(slug!)}/diff?since=${from}&until=${to}`, "text/plain", signal, { clip: true });
    return page.clipped ? wholeFiles(page.text) : page.text;
  }
  /** The diff files() put together from GitHub's patches, for the diff() that follows it; dropped by that diff(). */
  private listedDiff: { endpoint: string; diff: string } | undefined;
  /**
   * A renamed file's name before the change, which GitLab's position (old_path) and Bitbucket's anchor (srcPath) take
   * for its old side; a review names every file by its new name. Sent as the new name, GitLab found no such old line
   * and refused the comment. GitHub needs none: it addresses both sides by the new name. Not found or not read, the
   * comment goes as before.
   */
  private async previousPath(endpoint: string, path: string, commits: { sourceCommit: string; destinationCommit: string }): Promise<string | undefined> {
    // Read once per PR commit pair for every comment posted on it (a client is made for each post): read for each, a
    // batch of 30 on a 300-file GitLab MR fetched every file's diff 30 times over.
    const key = `${this.connection.id}\n${endpoint}\n${commits.sourceCommit}\n${commits.destinationCommit}`;
    let renames = renamesRead.get(key);
    if (!renames) {
      try { renames = await this.renames(endpoint); } catch { return undefined; }
      renamesRead.set(key, renames);
      while (renamesRead.size > 8) renamesRead.delete(renamesRead.keys().next().value!);
    }
    return renames.get(path);
  }
  /** Each renamed file's new name to its old one, from the platform's own file list. */
  private async renames(endpoint: string): Promise<Map<string, string>> {
    const renames = new Map<string, string>();
    if (this.connection.platform === "bitbucket-server") {
      for (let start = 0; ;) {
        const data = z.object({ isLastPage: z.boolean(), nextPageStart: z.number().int().nonnegative().nullish(), values: z.array(z.object({ path: z.object({ toString: z.string() }), srcPath: z.object({ toString: z.string() }).nullish() })) })
          .parse((await this.json(`${endpoint}/changes?limit=500${start ? `&start=${start}` : ""}`)).data);
        for (const item of data.values) if (item.srcPath && item.srcPath.toString !== item.path.toString) renames.set(item.path.toString, item.srcPath.toString);
        if (data.isLastPage || data.nextPageStart == null || data.nextPageStart <= start) return renames;
        start = data.nextPageStart;
      }
    }
    for await (const data of this.numbered(`${endpoint}/diffs`)) {
      for (const item of z.array(z.object({ new_path: z.string(), old_path: z.string() })).parse(data)) if (item.old_path !== item.new_path) renames.set(item.new_path, item.old_path);
    }
    return renames;
  }
  /**
   * A GitHub PR's changed files, and the diff their patches make up to the read cap: a file GitHub gives no patch
   * (binary, too large) has none there, and is named as not reviewed.
   */
  private async githubFiles(endpoint: string, signal?: AbortSignal) {
    const files: Array<{ path: string; status: string; unsupported?: true }> = [];
    const parts: string[] = [];
    let bytes = 0;
    for await (const data of this.numbered(`${endpoint}/files`, signal)) {
      for (const file of z.array(z.object({ filename: z.string(), status: z.string(), previous_filename: z.string().optional(), patch: z.string().optional() })).parse(data)) {
        files.push(listedFile(file.filename, file.status));
        if (file.patch === undefined || bytes > MAX_RESPONSE) continue;
        const from = file.previous_filename ?? file.filename;
        const part = `diff --git a/${from} b/${file.filename}\n--- ${file.status === "added" ? "/dev/null" : `a/${from}`}\n+++ ${file.status === "removed" ? "/dev/null" : `b/${file.filename}`}\n${file.patch}\n`;
        bytes += Buffer.byteLength(part);
        if (bytes <= MAX_RESPONSE) parts.push(part);
      }
    }
    return { files, diff: parts.join("") };
  }
  /**
   * What reviewers already said, newest first, as code-meeseeks feeds pr-agent: a
   * review should not raise it again. A comment of unexpected shape is dropped, not fatal.
   */
  /** Where the PR is read in a browser: the same shapes the comment links use. */
  webUrl(reference: string): string {
    const { repository, number } = parsePrReference(reference);
    const web = prWebBase(this.connection);
    if (this.connection.platform === "github") return `${web}/${repoPath(repository)}/pull/${number}`;
    if (this.connection.platform === "gitlab") return `${web}/${repoPath(repository)}/-/merge_requests/${number}`;
    const [projectKey, slug] = repository.split("/") as [string, string];
    return `${web}/projects/${enc(projectKey)}/repos/${enc(slug)}/pull-requests/${number}/overview`;
  }

  async comments(reference: string, signal?: AbortSignal): Promise<PrExistingComment[]> {
    // What the review is told and its snapshot cache keeps, field for field.
    return (await this.commentPages(reference, 1, signal)).comments.map(({ replyTo: _replyTo, side: _side, ...comment }) => comment);
  }
  /**
   * The discussion as a person reads it on the platform: up to `pages` pages of comments, each line comment with its code.
   * That is the change it was made on where the platform gives it, which is what the reviewer answered (a comment the PR
   * has since moved past included); else the lines around it in the file as the PR has it now, read once a file. A file
   * that cannot be read leaves its comments without.
   */
  async discussion(reference: string, pages: number): Promise<{ comments: Array<PrDiscussionEntry & { code: PrCommentCode | null }>; more: boolean }> {
    const anchors = new Map<string, CommentAnchor>();
    const { comments, more } = await this.commentPages(reference, pages, undefined, anchors);
    if (this.connection.platform === "gitlab") await this.versionDiffs(this.endpoint(reference), comments, anchors);
    const hunks = new Map(comments.flatMap((comment) => {
      const made = anchors.get(comment.id)?.made, code = made?.diff ? hunkCode(made) : null;
      return code ? [[comment.id, code] as const] : [];
    }));
    // A GitLab note is read from the file only when made on the diff as the MR has it now: on an earlier push, its line
    // numbers were another version's.
    const rest = comments.filter((comment) => !hunks.has(comment.id) && comment.path && (comment.side || anchors.get(comment.id)?.made?.version));
    const pr = rest.length ? await this.get(reference).catch(() => null) : null;
    const now = pr && `${pr.base}:${pr.destination.commit}:${pr.source.commit}`;
    const sideOf = (comment: PrDiscussionEntry) => comment.side ?? (anchors.get(comment.id)?.made?.version === now ? anchors.get(comment.id)!.made!.side : null);
    const wanted = new Map(rest.flatMap((comment) => { const side = sideOf(comment); return side ? [[`${side}:${comment.path}`, { side, path: comment.path! }] as const] : []; }));
    const files = new Map<string, string[]>();
    // ponytail: the first 20 files commented on; comments on more files than that go without code.
    for (const [key, { side, path }] of pr ? [...wanted].slice(0, 20) : []) {
      const text = await this.readFileContent(pr!, path, side).catch(() => null);
      // The last line break ends the last line: split as it is, a comment on the last line showed an empty one below it.
      if (text !== null && !text.includes("\0")) files.set(key, text.replace(/\r?\n$/u, "").split("\n"));
    }
    return { more, comments: comments.map((comment) => {
      // Shown with the change it was made on, a comment is placed as that change numbers it: GitHub moves a comment's line
      // with later commits, and the line it has now matched none of the code shown with it.
      const hunk = hunks.get(comment.id);
      if (hunk) return { ...comment, line: anchors.get(comment.id)!.made!.line, code: hunk };
      const side = sideOf(comment), file = side ? files.get(`${side}:${comment.path}`) : undefined, line = comment.line ?? 0;
      return { ...comment, code: side && file ? fileCode(file, side, anchors.get(comment.id)?.from ?? line, line) : null };
    }) };
  }
  /**
   * The diff each GitLab note was made on, which its note does not carry: the MR's diff versions name the same three
   * commits its position does. A version never changes, so the files notes were made on are kept from its read (every
   * file's diff, up to 32 MiB): read at each open of the discussion, they were all fetched again every time. ponytail:
   * the five newest versions notes were made on are read; a note on an older one, past the list's 100, or on a file
   * GitLab gives no diff for, goes without (to the file, if made on the version as it is now).
   */
  private async versionDiffs(endpoint: string, comments: readonly PrDiscussionEntry[], anchors: Map<string, CommentAnchor>): Promise<void> {
    const notes = comments.flatMap((comment) => { const made = anchors.get(comment.id)?.made; return made?.version && comment.path ? [{ made, path: comment.path }] : []; });
    const kept = (version: string) => `${this.connection.id}\n${endpoint}\n${version}`;
    const missing = notes.filter((note) => !versionsRead.get(kept(note.made.version!))?.has(note.path));
    if (missing.length) {
      const key = (version: { base_commit_sha: string; start_commit_sha: string; head_commit_sha: string }) => `${version.base_commit_sha}:${version.start_commit_sha}:${version.head_commit_sha}`;
      const versions = await this.json(`${endpoint}/versions?per_page=100`).then((response) =>
        z.array(z.object({ id: z.number().int().positive(), base_commit_sha: z.string(), start_commit_sha: z.string(), head_commit_sha: z.string() })).parse(response.data), () => []);
      for (const version of versions.filter((item) => missing.some((note) => note.made.version === key(item))).slice(0, 5)) {
        // Every file's diff of the version, as GitLab's own diffs read is: a large MR's runs past 2 MiB.
        const diffs = await this.json(`${endpoint}/versions/${version.id}`, undefined, { bytes: MAX_LIST_PAGE }).then((response) =>
          z.object({ diffs: z.array(z.object({ old_path: z.string(), new_path: z.string(), diff: z.string().nullish() })) }).parse(response.data).diffs, () => null);
        // A read that failed is asked again next time; a file the version has no diff for is kept as none.
        if (!diffs) continue;
        const files = versionsRead.get(kept(key(version))) ?? new Map<string, string>();
        for (const note of missing) if (note.made.version === key(version)) files.set(note.path, diffs.find((file) => file.new_path === note.path || file.old_path === note.path)?.diff ?? "");
        versionsRead.delete(kept(key(version)));
        versionsRead.set(kept(key(version)), files);
        while (versionsRead.size > 16) versionsRead.delete(versionsRead.keys().next().value!);
      }
    }
    for (const note of notes) note.made.diff = versionsRead.get(kept(note.made.version!))?.get(note.path) || undefined;
  }
  /**
   * Up to `pages` pages of comments, newest first; `more` when older ones were left unread. `anchors`, when given, takes
   * what discussion() reads a line comment's code by, by comment.
   */
  async commentPages(reference: string, pages: number, signal?: AbortSignal, anchors?: Map<string, CommentAnchor>): Promise<{ comments: PrDiscussionEntry[]; more: boolean; unparsed: number }> {
    // Comment entries the platform sent that did not parse are dropped from the list but counted: a reader that must be sure
    // a comment is absent (recovery of a lost receipt) cannot treat "not seen" as "not there" while any were dropped.
    let unparsed = 0;
    const endpoint = this.endpoint(reference);
    const { repository, number } = parsePrReference(reference);
    const web = prWebBase(this.connection);
    const id = z.number().int().positive();
    const items = (data: unknown) => z.array(z.unknown()).parse(data);
    if (this.connection.platform === "github") {
      // Line comments are the pull's and the conversation's its issue's, each numbered on its own: one number can be both,
      // so a conversation comment goes by its anchor's name.
      const read = async (path: string, anchor: "discussion_r" | "issuecomment-") => {
        const response = await this.json(path, signal);
        return { ...response, comments: items(response.data).flatMap((item) => {
          const parsed = z.object({ id, body: z.string(), created_at: z.string(), path: z.string().nullish(), line: z.number().int().nullish(), original_line: z.number().int().nullish(),
            start_line: z.number().int().nullish(), original_start_line: z.number().int().nullish(), side: z.string().nullish(), start_side: z.string().nullish(),
            diff_hunk: z.string().nullish(), in_reply_to_id: id.nullish(), user: z.object({ login: z.string() }).nullish() }).safeParse(item);
          if (!parsed.success) { unparsed++; return []; }
          const comment = parsed.data, key = anchor === "discussion_r" ? String(comment.id) : `${anchor}${comment.id}`;
          const side = comment.side === "LEFT" ? "old" as const : "new" as const, ranged = (comment.start_side ?? comment.side) === comment.side;
          // A comment over several lines starts at start_line; one starting on the diff's other side, from its own line. The
          // change it was made on is its diff_hunk, numbered as the diff was then (original_*), outdated or not.
          if (comment.path) anchors?.set(key, { from: ranged ? comment.start_line ?? undefined : undefined,
            made: comment.original_line ? { side, line: comment.original_line, start: (ranged && comment.original_start_line) || comment.original_line, diff: comment.diff_hunk ?? undefined } : undefined });
          // GitHub's threads are flat, every reply answering the first; an outdated comment has no line in the PR as it stands.
          return [{ id: key, url: `${web}/${repoPath(repository)}/pull/${number}#${anchor}${comment.id}`, author: comment.user?.login ?? "", path: comment.path ?? null, line: comment.line ?? comment.original_line ?? null, body: comment.body, createdAt: comment.created_at,
            replyTo: comment.in_reply_to_id ? String(comment.in_reply_to_id) : null, side: comment.path && comment.line ? side : null }];
        }) };
      };
      // The conversation lists oldest first only: its first page names the last (Link header), read from there back, each
      // page reversed and the first one last.
      const conversation = `/repos/${repoPath(repository)}/issues/${number}/comments?per_page=50`;
      const first = await read(conversation, "issuecomment-");
      if (first.next && first.last === undefined) throw new Error("平台分页信息缺失，请刷新重试。");
      const sources = [
        { queue: [] as PrDiscussionEntry[], next: 1 as number | null, reads: 0, page: async (cursor: number) => {
          const response = await read(`${endpoint}/comments?per_page=50&sort=created&direction=desc${cursor > 1 ? `&page=${cursor}` : ""}`, "discussion_r");
          return { comments: response.comments, next: response.next ? cursor + 1 : null };
        } },
        { queue: [] as PrDiscussionEntry[], next: (first.last ?? 1) as number | null, reads: 0, page: async (cursor: number) =>
          ({ comments: (cursor === 1 ? first : await read(`${conversation}&page=${cursor}`, "issuecomment-")).comments.reverse(), next: cursor > 1 ? cursor - 1 : null }) },
      ];
      // A page of either is read only once the one before it is used up, so each comment taken is the newest left of both:
      // none is skipped or taken twice, and a page holds 50 as on the other platforms.
      const comments: PrDiscussionEntry[] = [];
      const taken = new Set<string>();
      while (comments.length < pages * 50) {
        for (const source of sources) {
          // Full pages never take more than `pages` and one reads: a platform still saying there is more past that is not
          // believed, and what is older stays unread.
          while (!source.queue.length && source.next !== null && source.reads <= pages) {
            signal?.throwIfAborted();
            source.reads++;
            const got = await source.page(source.next);
            source.queue.push(...got.comments);
            source.next = got.next;
          }
        }
        if (sources.some((source) => !source.queue.length && source.next !== null)) break;
        const newest = sources.filter((source) => source.queue.length).sort((a, b) => Date.parse(b.queue[0]!.createdAt) - Date.parse(a.queue[0]!.createdAt))[0];
        if (!newest) break;
        const comment = newest.queue.shift()!;
        if (!taken.has(comment.id)) { taken.add(comment.id); comments.push(comment); }
      }
      return { comments, more: sources.some((source) => source.queue.length > 0 || source.next !== null), unparsed };
    }
    const [projectKey, slug] = repository.split("/") as [string, string];
    // Bitbucket activities come newest first and repeat a comment when it is edited or deleted: its first entry is its current state.
    const seen = new Set<number>();
    // GitLab pages from 1, Bitbucket from item 0.
    const page = async (cursor: number): Promise<{ comments: PrDiscussionEntry[]; next: number | null }> => {
      if (this.connection.platform === "gitlab") {
        const response = await this.json(`${endpoint}/notes?per_page=50&sort=desc&order_by=created_at${cursor > 1 ? `&page=${cursor}` : ""}`, signal);
        return { next: response.next ? cursor + 1 : null, comments: items(response.data).flatMap((item) => {
          const parsed = z.object({ id, body: z.string(), created_at: z.string(), system: z.boolean().optional(), author: z.object({ username: z.string().optional(), name: z.string().optional() }).nullish(),
            position: z.object({ new_path: z.string().nullish(), old_path: z.string().nullish(), new_line: z.number().int().nullish(), old_line: z.number().int().nullish(),
              base_sha: z.string().nullish(), start_sha: z.string().nullish(), head_sha: z.string().nullish(),
              line_range: z.object({ start: z.object({ new_line: z.number().int().nullish(), old_line: z.number().int().nullish() }).nullish() }).nullish().catch(null) }).nullish() }).safeParse(item);
          if (!parsed.success) { unparsed++; return []; }
          if (parsed.data.system) return [];
          const position = parsed.data.position, path = position?.new_path ?? position?.old_path ?? null, line = position?.new_line ?? position?.old_line ?? null;
          // Notes say neither which thread they are in nor whether their line is still the PR's, only the version of the MR's
          // diff they were made on: discussion() reads the code from that version.
          if (position && path && line) {
            const side = position.new_line ? "new" as const : "old" as const, start = (side === "new" ? position.line_range?.start?.new_line : position.line_range?.start?.old_line) || line;
            anchors?.set(String(parsed.data.id), { from: start, made: { side, start, line, version: `${position.base_sha}:${position.start_sha}:${position.head_sha}` } });
          }
          return [{ id: String(parsed.data.id), url: `${web}/${repoPath(repository)}/-/merge_requests/${number}#note_${parsed.data.id}`, author: parsed.data.author?.username ?? parsed.data.author?.name ?? "", path, line, body: parsed.data.body, createdAt: parsed.data.created_at, replyTo: null, side: null }];
        }) };
      }
      const data = z.object({ values: z.unknown(), isLastPage: z.boolean().optional(), nextPageStart: z.number().int().nonnegative().nullish() })
        .parse((await this.json(`${endpoint}/activities?limit=50${cursor > 0 ? `&start=${cursor}` : ""}`, signal)).data);
      const said = z.object({ id, text: z.string(), createdDate: z.number(), author: z.object({ displayName: z.string().optional(), name: z.string().optional() }).nullish(), comments: z.array(z.unknown()).optional() });
      return { next: data.isLastPage === false ? data.nextPageStart ?? null : null, comments: items(data.values).flatMap((item) => {
        // What says where a comment over several lines starts, and the diff it was made on, are read when they are there,
        // never the reason a comment is dropped.
        const parsed = z.object({ action: z.literal("COMMENTED"), commentAction: z.string().optional(), comment: said,
          commentAnchor: z.object({ path: z.string().nullish(), line: z.number().int().nullish(), fileType: z.string().nullish(), orphaned: z.boolean().nullish().catch(null),
            multilineMarker: z.object({ startLine: z.number().int(), startLineType: z.string().nullish() }).nullish().catch(null),
            multilineSpan: z.object({ srcSpanStart: z.number().int().nullish(), dstSpanStart: z.number().int().nullish() }).nullish().catch(null) }).nullish(),
          diff: bitbucketDiff.nullish().catch(null) }).safeParse(item);
        if (!parsed.success) { if ((item as { action?: unknown } | null)?.action === "COMMENTED") unparsed++; return []; }
        if (seen.has(parsed.data.comment.id)) return [];
        seen.add(parsed.data.comment.id);
        if (parsed.data.commentAction === "DELETED") return [];
        const anchor = parsed.data.commentAnchor, root = String(parsed.data.comment.id);
        const path = anchor?.path ?? null, line = anchor?.line ?? null, on = anchor?.fileType === "FROM" ? "old" as const : "new" as const;
        // An orphaned anchor's line is no longer in the PR as it stands: read there, the file showed whatever came to sit on it.
        const side = path && line && !anchor?.orphaned ? on : null;
        // Where a comment over several lines starts on its side, or (9.2 and before) where it starts, on the side its type
        // says: from a removed line to an added one, the start is an old line's number, and taken for a new one it brought in
        // dozens of lines the comment is not about.
        const marker = anchor?.multilineMarker, markerOn = marker?.startLineType === "REMOVED" ? "old" : marker?.startLineType === "ADDED" ? "new" : on;
        const start = (on === "old" ? anchor?.multilineSpan?.srcSpanStart : anchor?.multilineSpan?.dstSpanStart) || (markerOn === on ? marker?.startLine : null) || line;
        // The activity of a line comment carries its file's diff around it as the comment was made, which its replies share.
        const at: CommentAnchor = { from: start ?? undefined, made: path && line ? { side: on, start: start ?? line, line, diff: parsed.data.diff ?? undefined } : undefined };
        // Replies have no activity of their own: they come inside the comment opening their thread, on its line, as they are now.
        const thread = (comment: z.infer<typeof said>, replyTo: string | null): PrDiscussionEntry[] => {
          anchors?.set(String(comment.id), at);
          return [
            { id: String(comment.id), url: `${web}/projects/${enc(projectKey)}/repos/${enc(slug)}/pull-requests/${number}/overview?commentId=${comment.id}`, author: comment.author?.displayName ?? comment.author?.name ?? "", path, line, body: comment.text, createdAt: new Date(comment.createdDate).toISOString(), replyTo, side },
            ...(comment.comments ?? []).flatMap((item) => {
              const reply = said.safeParse(item);
              if (!reply.success) { unparsed++; return []; }
              if (seen.has(reply.data.id)) return [];
              seen.add(reply.data.id);
              return thread(reply.data, root);
            }),
          ];
        };
        return thread(parsed.data.comment, null);
      }) };
    };
    const comments: PrDiscussionEntry[] = [];
    for (let read = 1, cursor = this.connection.platform === "bitbucket-server" ? 0 : 1; ; read++) {
      const result = await page(cursor);
      comments.push(...result.comments);
      if (result.next === null || read >= pages) return { comments, more: result.next !== null, unparsed };
      cursor = result.next;
    }
  }
  async readFile(pr: PrDetails, path: string, start: number, signal?: AbortSignal): Promise<string> {
    z.number().int().min(1).max(1_000_000).parse(start);
    return (await this.readFileContent(pr, path, "new", signal)).split("\n").slice(start - 1, start + 79).join("\n");
  }
  async repositoryFiles(pr: PrDetails, side: "old" | "new", signal?: AbortSignal): Promise<PrRepositoryFiles> {
    prDetailsSchema.parse(pr);
    const ref = side === "old" ? pr.destination : pr.source;
    const repository = this.connection.platform === "bitbucket-server" ? pr.destination.repository : ref.repository;
    const commit = side === "old" ? pr.base ?? ref.commit : ref.commit;
    const key = `${repository}@${commit}`;
    signal?.throwIfAborted();
    const cached = this.inventories.get(key);
    if (cached) return cached;
    const paths: string[] = [];
    let complete = false, unsupported = false;
    const add = (path: string) => {
      if (repositoryRelativePathSchema.safeParse(path).data === path) paths.push(path);
      else unsupported = true;
    };
    if (this.connection.platform === "github") {
      const tree = z.object({ tree: z.array(z.object({ path: z.string(), type: z.string(), mode: z.string() })), truncated: z.boolean() })
        .parse((await this.json(`/repos/${repoPath(repository)}/git/trees/${commit}?recursive=1`, signal, { bytes: MAX_LIST_PAGE })).data);
      for (const entry of tree.tree) if (entry.type === "blob" && entry.mode !== "120000") add(entry.path);
      complete = !tree.truncated;
    } else {
      let start = 0;
      for (let page = 1; page <= 100; page++) {
        signal?.throwIfAborted();
        if (this.connection.platform === "gitlab") {
          const response = await this.json(`/projects/${enc(repository)}/repository/tree?ref=${commit}&recursive=true&per_page=100&page=${page}`, signal, { bytes: MAX_LIST_PAGE });
          const entries = z.array(z.object({ path: z.string(), type: z.string(), mode: z.string() })).parse(response.data);
          for (const entry of entries) if (entry.type === "blob" && entry.mode !== "120000") add(entry.path);
          if (!response.next) { complete = true; break; }
        } else {
          const [project, slug] = repository.split("/");
          const response = z.object({ values: z.array(z.string()), isLastPage: z.boolean(), nextPageStart: z.number().int().nonnegative().optional() })
            .parse((await this.json(`/rest/api/1.0/projects/${enc(project!)}/repos/${enc(slug!)}/files?at=${commit}&limit=1000&start=${start}`, signal, { bytes: MAX_LIST_PAGE })).data);
          response.values.forEach(add);
          if (response.isLastPage) { complete = true; break; }
          if (response.nextPageStart === undefined || response.nextPageStart <= start) break;
          start = response.nextPageStart;
        }
        if (paths.length >= 20_000) break;
      }
    }
    const result = { paths: [...new Set(paths)].sort().slice(0, 20_000), complete: complete && !unsupported && paths.length <= 20_000 };
    this.inventories.set(key, result);
    while (this.inventories.size > 4) this.inventories.delete(this.inventories.keys().next().value!);
    return result;
  }
  async readFileContent(pr: PrDetails, path: string, side: "old" | "new", signal?: AbortSignal): Promise<string> {
    prDetailsSchema.parse(pr);
    // Bitbucket exposes the PR head in the target repository even when the author's fork is private.
    const ref = side === "old" ? pr.destination : pr.source;
    const repository = this.connection.platform === "bitbucket-server" ? pr.destination.repository : ref.repository;
    const commit = side === "old" ? pr.base ?? ref.commit : ref.commit;
    repoName.parse(repository); sha.parse(commit); repositoryRelativePathSchema.parse(path);
    const file = path.split("/").map(enc).join("/");
    const endpoint = this.connection.platform === "github" ? `/repos/${repoPath(repository)}/contents/${file}?ref=${commit}` :
      this.connection.platform === "gitlab" ? `/projects/${enc(repository)}/repository/files/${enc(path)}/raw?ref=${commit}` :
        `/rest/api/1.0/projects/${enc(repository.split("/")[0]!)}/repos/${enc(repository.split("/")[1]!)}/raw/${file}?at=${commit}`;
    // A file at a commit never changes: a review paging through it, or the file viewer, fetches it once.
    const key = `${repository}@${commit}:${path}`;
    const known = this.contents.get(key);
    if (known !== undefined) return known;
    // Only a finished read is kept, so a stopped review never fails the file viewer's read of the same file.
    const { text } = await this.read(endpoint, this.connection.platform === "github" ? "application/vnd.github.raw+json" : "text/plain", signal);
    this.contents.set(key, text);
    // ponytail: bounded by count; add a byte budget if very large files show up in practice.
    for (const oldest of this.contents.keys()) {
      if (this.contents.size <= 50) break;
      this.contents.delete(oldest);
    }
    return text;
  }
}
