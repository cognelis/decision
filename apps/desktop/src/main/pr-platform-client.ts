import { fetch as proxyFetch } from "undici";
import { z } from "zod";
import { clipText, prActionContextSchema, prActionRequestSchema, prReviewCommentRequestSchema, prGeneralCommentRequestSchema, prReviewDiffRequestSchema, type PrGeneralCommentRequest, type PrActionContext, type PrActionRequest, type PrActionResult, type PrReviewCommentRequest, type PrReviewCommentResult, type PrReviewDiffRequest, prConnectionSchema, prListResponseSchema, repositoryRelativePathSchema, PR_REVIEW_MAX_FILES, type PrConnection, type PrListQuery, type PrListResponse } from "@cognelis/decision-protocol";
import { createProviderDispatcher } from "./model/provider-network.js";

/** Renamed files' old names per connection, PR and commit pair, the newest few kept: see previousPath(). */
const renamesRead = new Map<string, Map<string, string>>();
/** Each PR commit pair's merge base, `null` where the platform has none to give: see mergeBase(). */
const basesRead = new Map<string, string | null>();

/** A write the platform refused and said why (Bitbucket's merge checks): its words, not "result unconfirmed". */
export class PrPlatformRefusal extends Error {}

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
export interface PrReviewClient {
  get(reference: string, signal?: AbortSignal): Promise<PrDetails>;
  /** `unsupported`: a name the review cannot carry as given, to be named in a warning and left out. */
  files(reference: string, signal?: AbortSignal): Promise<Array<{ path: string; status: string; unsupported?: true }>>;
  diff(reference: string, signal?: AbortSignal): Promise<string>;
  readFileContent(pr: PrDetails, path: string, side: "old" | "new", signal?: AbortSignal): Promise<string>;
  readFile(pr: PrDetails, path: string, start: number, signal?: AbortSignal): Promise<string>;
  /** Newest comments already on the PR; optional so a client without it simply reviews without them. */
  comments?(reference: string, signal?: AbortSignal): Promise<PrExistingComment[]>;
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

/** `clipped`: the response ran past the read's cap and holds only what came before it. */
interface Page { text: string; next: boolean; username?: string | undefined; clipped?: boolean }
export type PrWrite = (path: string, method: "POST" | "PUT", body: Record<string, unknown>) => Promise<Page>;
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
const bbPr = z.object({ id: z.number().int().positive(), title: label, description: z.string().nullish(), updatedDate: z.number(), author: z.object({ user }), fromRef: bbRef, toRef: bbRef });
const ghPr = z.object({ title: label, body: z.string().nullish(), head: z.object({ sha, repo: z.object({ full_name: repoName }).nullable() }), base: z.object({ sha, repo: z.object({ full_name: repoName }) }) });
const glPr = z.object({ title: label, description: z.string().nullish(), source_project_id: z.number().int().positive().nullable(), target_project_id: z.number().int().positive(), diff_refs: z.object({ head_sha: sha, start_sha: sha, base_sha: sha }).nullable() });

/** Requests stay on the configured origin; redirects never receive credentials. */
export class HostedPrClient implements PrReviewClient {
  private readonly contents = new Map<string, string>();
  constructor(readonly connection: PrConnection, private readonly read: PrRead, private readonly write?: PrWrite) {}

  static create(connection: PrConnection, token: string): HostedPrClient {
    const base = prApiBase(connection);
    const request = async (path: string, accept: string, signal?: AbortSignal, mutation?: { method: "POST" | "PUT"; body: Record<string, unknown> }, cap: ReadCap = {}): Promise<Page> => {
      const limit = cap.bytes ?? MAX_RESPONSE;
      if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) throw new Error("平台请求路径无效。");
      const target = new URL(connection.platform === "gitlab" && path === "/graphql" ? base.replace(/\/v4$/u, "/graphql") : base + path);
      if (target.origin !== new URL(base).origin) throw new Error("拒绝跨站发送平台凭据。");
      const dispatcher = createProviderDispatcher(undefined, process.env, target);
      const timeout = AbortSignal.timeout(30_000);
      try {
        const response = await proxyFetch(target, {
          method: mutation?.method ?? "GET", redirect: "error", dispatcher,
          ...(mutation ? { body: JSON.stringify(mutation.body) } : {}),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          headers: { accept, ...(mutation ? { "content-type": "application/json" } : {}), ...(connection.platform === "gitlab" ? { "PRIVATE-TOKEN": token } : { authorization: `Bearer ${token}` }),
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
        return { username: response.headers.get("x-ausername") ?? undefined, text: Buffer.concat(chunks).toString("utf8"), next: /rel="next"/u.test(response.headers.get("link") ?? "") || !!response.headers.get("x-next-page"), ...(clipped ? { clipped } : {}) };
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof PrPlatformError || error instanceof PrPlatformRefusal) throw error;
        if (mutation) throw new Error("操作结果未确认，请先到代码平台核对状态，避免重复提交。");
        if (error instanceof Error && /^平台响应超过/u.test(error.message)) throw error;
        throw new PrPlatformUnreachable(timeout.aborted ? "代码平台请求超时，请重试。": "代码平台连接失败，请检查地址、网络和系统代理；不允许重定向凭据。");
      } finally { await dispatcher.close(); }
    };
    return new HostedPrClient(connection, (path, accept, signal, cap) => request(path, accept, signal, undefined, cap),
      (path, method, body) => request(path, "application/json", undefined, { method, body }));
  }
  private async json(path: string, signal?: AbortSignal, cap?: ReadCap) {
    const response = await this.read(path, "application/json", signal, cap);
    try { return { data: JSON.parse(response.text) as unknown, next: response.next, username: response.username }; }
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
    if (context.sourceCommit !== request.sourceCommit || context.destinationCommit !== request.destinationCommit) throw new PrCommitsMovedError();
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
    try {
      if (this.connection.platform === "github") {
        z.object({ id: z.number() }).parse(await submit(`${endpoint}/comments`, { body: request.body, commit_id: request.sourceCommit, path: request.path, line: request.line, side: added ? "RIGHT" : "LEFT" }));
      } else if (this.connection.platform === "gitlab") {
        // base_sha is part of a GitLab diff position but not of the commits the review pins.
        const refs = glPr.parse((await this.json(endpoint)).data).diff_refs;
        if (!refs || refs.head_sha !== request.sourceCommit || refs.start_sha !== request.destinationCommit) throw new Error("PR 提交已变化，请读取最新提交后再发布。");
        const oldPath = await this.previousPath(endpoint, request.path, request);
        z.object({ id: z.string() }).parse(await submit(`${endpoint}/discussions`, { body: request.body, position: { position_type: "text", base_sha: refs.base_sha, start_sha: refs.start_sha, head_sha: refs.head_sha, old_path: oldPath ?? request.path, new_path: request.path, ...(added ? { new_line: request.line } : { old_line: request.line }) } }));
      } else {
        const srcPath = await this.previousPath(endpoint, request.path, request);
        z.object({ id: z.number() }).parse(await submit(`${endpoint}/comments`, { text: request.body, anchor: { path: request.path, ...(srcPath && srcPath !== request.path ? { srcPath } : {}), line: request.line, lineType: added ? "ADDED" : "REMOVED", fileType: added ? "TO" : "FROM", diffType: "EFFECTIVE" } }));
        // Unlike GitHub and GitLab this anchor names no commit: a push racing the post would move the line. Say so rather
        // than report a clean post; a read that failed is not a push, and said as one sent the reader to look for it.
        const after = await this.actionContext(pinned).then(() => "same", (error: unknown) => (error instanceof PrCommitsMovedError ? "moved" : "unknown"));
        if (after === "moved") return { message: "评论已发布，但 PR 随后有新的提交；请到平台核对评论是否仍在原来的行上。" };
        if (after === "unknown") return { message: `评论已发布到 ${request.path}:${request.line}；发布后没能确认 PR 是否又有新的提交，如有疑问请到平台核对评论位置。` };
      }
    } catch (error) {
      if (error instanceof z.ZodError) throw new Error("平台已返回响应，但无法确认评论已发布。请先到平台核对，避免重复发布。");
      if (error instanceof PrPlatformError && (error.status === 400 || error.status === 422)) throw new Error(`平台拒绝了这条行内评论（HTTP ${error.status}）：该行可能已不在 PR 的 diff 中，或文件经过重命名。可以复制内容到平台手动评论。`);
      throw error;
    }
    return { message: `评论已发布到 ${request.path}:${request.line}。` };
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
    const [path, body] = this.connection.platform === "github" ? [`${endpoint.replace(/\/pulls\//u, "/issues/")}/comments`, { body: request.body }]
      : this.connection.platform === "gitlab" ? [`${endpoint}/notes`, { body: request.body }]
        : [`${endpoint}/comments`, { text: request.body }];
    const response = await this.write(path, "POST", body);
    try {
      z.object({ id: z.number() }).parse(JSON.parse(response.text));
    } catch {
      throw new Error("平台已返回响应，但无法确认评论已发布。请先到平台核对，避免重复发布。");
    }
    return { message: "评论已发布到 PR。" };
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
      const items = z.array(z.object({ iid: z.number().int().positive(), web_url: z.string().url(), title: label, author: user, updated_at: z.string() })).parse(response.data);
      const base = new URL(prApiBase(this.connection).replace(/\/api\/v4$/u, ""));
      return prListResponseSchema.parse({ items: items.map((item) => {
        const url = new URL(item.web_url);
        const prefix = base.pathname.replace(/\/$/u, "") + "/";
        if (url.origin !== base.origin || !url.pathname.startsWith(prefix) || !url.pathname.includes("/-/merge_requests/")) throw new Error("平台返回了不属于此连接的合并请求。");
        const repository = repoName.parse(decodeURIComponent(url.pathname.slice(prefix.length).split("/-/merge_requests/")[0]!));
        return { reference: `${repository}#${item.iid}`, repository, number: String(item.iid), title: item.title, author: item.author.name ?? "", updatedAt: item.updated_at };
      }), nextPage: response.next ? input.page + 1 : null });
    }
    const response = await this.json(`/rest/api/1.0/dashboard/pull-requests?role=${input.filter === "created" ? "AUTHOR" : "REVIEWER"}&state=${merged ? "MERGED" : "OPEN"}&limit=30&start=${input.page - 1}`, undefined, { bytes: MAX_LIST_PAGE });
    const data = z.object({ values: z.array(bbPr), isLastPage: z.boolean(), nextPageStart: z.number().int().nonnegative().optional() }).parse(response.data);
    if (!data.isLastPage && data.nextPageStart === undefined) throw new Error("平台分页信息缺失，请刷新重试。");
    return prListResponseSchema.parse({ items: data.values.map((item) => {
      const repository = `${item.toRef.repository.project.key}/${item.toRef.repository.slug}`;
      return { reference: `${repository}#${item.id}`, repository, number: String(item.id), title: item.title, author: item.author.user.displayName ?? item.author.user.name ?? "", updatedAt: new Date(item.updatedDate).toISOString() };
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
    return (await this.commentPages(reference, 1, signal)).comments;
  }
  /** Up to `pages` pages of comments, newest first; `more` when older ones were left unread. */
  async commentPages(reference: string, pages: number, signal?: AbortSignal): Promise<{ comments: PrExistingComment[]; more: boolean }> {
    const endpoint = this.endpoint(reference);
    const { repository, number } = parsePrReference(reference);
    const web = prWebBase(this.connection);
    const id = z.number().int().positive();
    const items = (data: unknown) => z.array(z.unknown()).parse(data);
    const [projectKey, slug] = repository.split("/") as [string, string];
    // Bitbucket activities come newest first and repeat a comment when it is edited or deleted: its first entry is its current state.
    const seen = new Set<number>();
    // GitHub and GitLab page from 1, Bitbucket from item 0.
    const page = async (cursor: number): Promise<{ comments: PrExistingComment[]; next: number | null }> => {
      if (this.connection.platform === "github") {
        // Inline review comments; general conversation comments cannot be sorted newest first.
        const response = await this.json(`${endpoint}/comments?per_page=50&sort=created&direction=desc${cursor > 1 ? `&page=${cursor}` : ""}`, signal);
        return { next: response.next ? cursor + 1 : null, comments: items(response.data).flatMap((item) => {
          const parsed = z.object({ id, body: z.string(), created_at: z.string(), path: z.string().nullish(), line: z.number().int().nullish(), original_line: z.number().int().nullish(), user: z.object({ login: z.string() }).nullish() }).safeParse(item);
          return parsed.success ? [{ id: String(parsed.data.id), url: `${web}/${repoPath(repository)}/pull/${number}#discussion_r${parsed.data.id}`, author: parsed.data.user?.login ?? "", path: parsed.data.path ?? null, line: parsed.data.line ?? parsed.data.original_line ?? null, body: parsed.data.body, createdAt: parsed.data.created_at }] : [];
        }) };
      }
      if (this.connection.platform === "gitlab") {
        const response = await this.json(`${endpoint}/notes?per_page=50&sort=desc&order_by=created_at${cursor > 1 ? `&page=${cursor}` : ""}`, signal);
        return { next: response.next ? cursor + 1 : null, comments: items(response.data).flatMap((item) => {
          const parsed = z.object({ id, body: z.string(), created_at: z.string(), system: z.boolean().optional(), author: z.object({ username: z.string().optional(), name: z.string().optional() }).nullish(),
            position: z.object({ new_path: z.string().nullish(), old_path: z.string().nullish(), new_line: z.number().int().nullish(), old_line: z.number().int().nullish() }).nullish() }).safeParse(item);
          if (!parsed.success || parsed.data.system) return [];
          const position = parsed.data.position;
          return [{ id: String(parsed.data.id), url: `${web}/${repoPath(repository)}/-/merge_requests/${number}#note_${parsed.data.id}`, author: parsed.data.author?.username ?? parsed.data.author?.name ?? "", path: position?.new_path ?? position?.old_path ?? null, line: position?.new_line ?? position?.old_line ?? null, body: parsed.data.body, createdAt: parsed.data.created_at }];
        }) };
      }
      const data = z.object({ values: z.unknown(), isLastPage: z.boolean().optional(), nextPageStart: z.number().int().nonnegative().nullish() })
        .parse((await this.json(`${endpoint}/activities?limit=50${cursor > 0 ? `&start=${cursor}` : ""}`, signal)).data);
      return { next: data.isLastPage === false ? data.nextPageStart ?? null : null, comments: items(data.values).flatMap((item) => {
        const parsed = z.object({ action: z.literal("COMMENTED"), commentAction: z.string().optional(), comment: z.object({ id, text: z.string(), createdDate: z.number(), author: z.object({ displayName: z.string().optional(), name: z.string().optional() }).nullish() }),
          commentAnchor: z.object({ path: z.string().nullish(), line: z.number().int().nullish() }).nullish() }).safeParse(item);
        if (!parsed.success || seen.has(parsed.data.comment.id)) return [];
        seen.add(parsed.data.comment.id);
        return parsed.data.commentAction !== "DELETED" ? [{ id: String(parsed.data.comment.id), url: `${web}/projects/${enc(projectKey)}/repos/${enc(slug)}/pull-requests/${number}/overview?commentId=${parsed.data.comment.id}`, author: parsed.data.comment.author?.displayName ?? parsed.data.comment.author?.name ?? "", path: parsed.data.commentAnchor?.path ?? null, line: parsed.data.commentAnchor?.line ?? null, body: parsed.data.comment.text, createdAt: new Date(parsed.data.comment.createdDate).toISOString() }] : [];
      }) };
    };
    const comments: PrExistingComment[] = [];
    for (let read = 1, cursor = this.connection.platform === "bitbucket-server" ? 0 : 1; ; read++) {
      const result = await page(cursor);
      comments.push(...result.comments);
      if (result.next === null || read >= pages) return { comments, more: result.next !== null };
      cursor = result.next;
    }
  }
  async readFile(pr: PrDetails, path: string, start: number, signal?: AbortSignal): Promise<string> {
    z.number().int().min(1).max(1_000_000).parse(start);
    return (await this.readFileContent(pr, path, "new", signal)).split("\n").slice(start - 1, start + 79).join("\n");
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
