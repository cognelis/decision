import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  PR_REVIEW_TOOLS_VERSION,
  REVIEW_BENCHMARK_LIMITS,
  REVIEW_BENCHMARK_VERSION,
  reviewEscapeSchema,
  type PrConnection,
  type ReviewBenchmarkRecordRequest,
  type ReviewBenchmarkRecordResult,
  type ReviewEscape,
  type ReviewEscapeRecord,
  type ReviewEscapeRecordResult,
  type ReviewEscapesQuery,
  type ReviewEscapesResult,
  type ReviewEscapeUpdate,
  type ReviewEscapeUpdateResult,
} from "@cognelis/decision-protocol";

import { atomicWrite } from "./atomic-write.js";
import { resolveConnection } from "./pr-description-tools.js";
import type { PrDetails, PrTeamFacts } from "./pr-platform-client.js";
import type { PrHistoryStore } from "./pr-review-records.js";

const said = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
const storeSchema = z.object({ version: z.literal(1), escapes: z.array(reviewEscapeSchema) });

/** 漏网复盘, every link's, kept on this Mac: the newest 500. */
export class ReviewEscapeStore {
  #tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}
  async list(): Promise<ReviewEscape[]> {
    try { return storeSchema.parse(JSON.parse(await readFile(this.path, "utf8"))).escapes; } catch { return []; }
  }
  /** Changes them one writer at a time; resolves to what the change returned. */
  change<T>(apply: (escapes: ReviewEscape[]) => T): Promise<T> {
    const next = this.#tail.then(async () => {
      const escapes = await this.list();
      const result = apply(escapes);
      await atomicWrite(this.path, JSON.stringify({ version: 1, escapes: escapes.sort((a, b) => b.foundAt.localeCompare(a.foundAt)).slice(0, 500) }));
      return result;
    });
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

const repositoryOf = (reference: string) => reference.slice(0, reference.lastIndexOf("#"));
const numberOf = (reference: string) => reference.slice(reference.lastIndexOf("#") + 1);
const REVERTED = /^revert\b[\s:]*"?(.+?)"?\s*$/iu;
const FIXING = /修复|修正|回滚|撤回|\bfix(?:es|ed)?\b|\bhotfix\b|\bbug\b|\brevert/iu;

/**
 * Escapes among merged PRs: a later one reverting one (`Revert "<its title>"`), or naming it (#12, !12, pull-requests/12)
 * and saying it fixes or reverts it. Same repository only; the first later one found for each.
 */
export const findEscapes = (merged: ReadonlyArray<{ reference: string; facts: PrTeamFacts }>): Array<Pick<ReviewEscape, "reference" | "title" | "mergedAt" | "by">> =>
  merged.flatMap(({ reference, facts }) => {
    const at = Date.parse(facts.mergedAt ?? "");
    if (!Number.isFinite(at)) return [];
    const names = new RegExp(`(?:#|!|pull-requests/|pull/|merge_requests/|\\bPR\\s*)${numberOf(reference)}(?!\\d)`, "iu");
    const later = merged.filter((other) => other.reference !== reference && repositoryOf(other.reference) === repositoryOf(reference) && Date.parse(other.facts.mergedAt ?? "") > at)
      .sort((a, b) => Date.parse(a.facts.mergedAt!) - Date.parse(b.facts.mergedAt!));
    for (const other of later) {
      const reverted = REVERTED.exec(other.facts.title)?.[1];
      const text = `${other.facts.title}\n${other.facts.description ?? ""}`;
      const kind = reverted === facts.title ? "revert" : names.test(text) && FIXING.test(text) ? /revert|回滚|撤回/iu.test(text) ? "revert" : "fix" : null;
      if (kind) return [{ reference, title: facts.title, mergedAt: facts.mergedAt, by: { kind, reference: other.reference, title: other.facts.title } }];
    }
    return [];
  });

export interface ReviewEscapeSources {
  connections(): Promise<PrConnection[]>;
  store: ReviewEscapeStore;
  history: PrHistoryStore;
  /** The PR as its platform has it now. */
  get(connectionId: string, reference: string): Promise<PrDetails>;
  /** The local clone whose push remote is this repository on the link, if one was added in 本地审阅. */
  localPath(connectionId: string, repository: string): Promise<string | null>;
  benchmark: { record(request: ReviewBenchmarkRecordRequest): Promise<ReviewBenchmarkRecordResult> };
  now?(): number;
}

/** New escapes found on a link, each PR once: one dismissed stays dismissed. */
export const keepFound = (store: ReviewEscapeStore, connectionId: string, found: ReturnType<typeof findEscapes>, now = Date.now()) =>
  found.length === 0 ? Promise.resolve(0) : store.change((escapes) => {
    const fresh = found.filter((item) => !escapes.some((known) => known.connectionId === connectionId && known.reference === item.reference));
    escapes.push(...fresh.map((item): ReviewEscape => ({ ...item, id: randomUUID(), connectionId, foundAt: new Date(now).toISOString(), state: "open", writeup: null, dismissed: null, benchmarkCase: null })));
    return fresh.length;
  });

const prOf = (reference: string, repository?: string) => {
  const match = /^(?:(.+))?#(\d+)$/u.exec(reference.trim());
  return match ? `${match[1] ?? repository}#${match[2]}` : null;
};

/** record_review_escape: a PR the user says a later PR or commit fixed or reverted. */
export const recordEscape = async (request: Omit<ReviewEscapeRecord, "prReviewToolsVersion">, sources: ReviewEscapeSources): Promise<ReviewEscapeRecordResult> => {
  const { connection, connections, status } = await resolveConnection(sources, request.connection);
  const base = { prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, connections } as const;
  if (!connection) return { ...base, status, reason: null, escape: null };
  const reference = prOf(request.reference);
  if (!reference || reference.startsWith("undefined#")) return { ...base, status: "failed", reason: "reference 要写成平台上的样子，如 owner/repo#12。", escape: null };
  const known = (await sources.store.list()).find((item) => item.connectionId === connection.id && item.reference === reference);
  if (known) return { ...base, status: "exists", reason: null, escape: known };
  let details: PrDetails;
  try { details = await sources.get(connection.id, reference); } catch (error) { return { ...base, status: "failed", reason: `读不到 ${reference}：${said(error)}`, escape: null }; }
  // By a PR: its title read too; by a commit or in words: kept as said.
  const byPr = prOf(request.by, repositoryOf(reference));
  const byTitle = byPr ? await sources.get(connection.id, byPr).then((item) => item.title, () => "") : "";
  const escape: ReviewEscape = { id: randomUUID(), connectionId: connection.id, reference, title: details.title, mergedAt: null,
    by: { kind: request.kind, reference: byPr && byTitle ? byPr : request.by, title: byTitle }, foundAt: new Date(sources.now?.() ?? Date.now()).toISOString(),
    state: request.writeup ? "written" : "open", writeup: request.writeup ?? null, dismissed: null, benchmarkCase: null };
  await sources.store.change((escapes) => { escapes.push(escape); });
  return { ...base, status: "recorded", reason: null, escape };
};

export const escapesFor = async (query: Omit<ReviewEscapesQuery, "prReviewToolsVersion">, sources: Pick<ReviewEscapeSources, "connections" | "store">): Promise<ReviewEscapesResult> => {
  const { connection, connections, status } = await resolveConnection(sources, query.connection);
  const base = { prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, connections } as const;
  if (!connection) return { ...base, status, escapes: [] };
  const escapes = (await sources.store.list()).filter((item) => item.connectionId === connection.id && (query.state === undefined || item.state === query.state));
  return { ...base, status: "ok", escapes: escapes.slice(0, 200) };
};

const SHA = /^[a-f0-9]{40,64}$/u;
/** The four lines written, dismissed or opened again; or, from where the problem sat, a defect benchmark candidate. */
export const updateEscape = async (request: Omit<ReviewEscapeUpdate, "prReviewToolsVersion">, sources: ReviewEscapeSources): Promise<ReviewEscapeUpdateResult> => {
  const answer = (status: ReviewEscapeUpdateResult["status"], reason: string | null, escape: ReviewEscape | null = null): ReviewEscapeUpdateResult => ({ prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, status, reason, escape });
  const escape = (await sources.store.list()).find((item) => item.id === request.id);
  if (!escape) return answer("not_found", `没有 id 为 ${request.id} 的漏网复盘。`);
  const save = async (change: (item: ReviewEscape) => void) => answer("updated", null, await sources.store.change((escapes) => {
    const item = escapes.find((known) => known.id === request.id)!;
    change(item);
    return { ...item };
  }));
  if (request.action === "write") return save((item) => { item.writeup = request.writeup!; item.state = "written"; item.dismissed = null; });
  if (request.action === "dismiss") return save((item) => { item.state = "dismissed"; item.dismissed = request.reason!; });
  if (request.action === "reopen") return save((item) => { item.state = item.writeup ? "written" : "open"; item.dismissed = null; });
  // add_to_benchmark: the version Paraself reviewed (its target then gives the merge base), the fix, where the problem sat.
  const writeup = request.writeup ?? escape.writeup;
  if (!writeup) return answer("refused", "先写复盘的四行，问题和原因会成为样本的标题和证据。", escape);
  if (escape.benchmarkCase) return answer("refused", `已经是评测集样本 ${escape.benchmarkCase}。`, escape);
  const reviewed = (await sources.history.list()).entries.find((entry) => entry.kind === "review" && entry.connectionId === escape.connectionId && entry.snapshot.reference === escape.reference);
  if (!reviewed) return answer("refused", "这个 PR 没有在 Paraself 里评审过，不知道它当时的目标分支；请用 record_review_benchmark_cases 手动录入。", escape);
  let fix = SHA.test(escape.by.reference) ? escape.by.reference : null;
  if (!fix && prOf(escape.by.reference)) fix = await sources.get(escape.connectionId, escape.by.reference).then((item) => item.source.commit, () => null);
  if (!fix) return answer("refused", `读不到修复它的提交（${escape.by.reference}）。`, escape);
  const repository = repositoryOf(escape.reference);
  const path = await sources.localPath(escape.connectionId, repository).catch(() => null);
  if (!path) return answer("refused", `本地审阅里没有 ${repository} 的本地仓库：先在“本地审阅”里添加它，并拉取修复提交。`, escape);
  const connection = (await sources.connections()).find((item) => item.id === escape.connectionId);
  const location = request.location!;
  const L = REVIEW_BENCHMARK_LIMITS;
  try {
    const result = await sources.benchmark.record({ reviewBenchmarkVersion: REVIEW_BENCHMARK_VERSION, sourceClient: "paraself", repositoryPath: path, cases: [{
      set: "defect", title: escape.title.slice(0, L.title) || writeup.problem.slice(0, L.title),
      pr: { ...(connection ? { platform: connection.platform } : {}), repository, number: Number(numberOf(escape.reference)) },
      headSha: reviewed.snapshot.sourceCommit, targetSha: reviewed.snapshot.destinationCommit,
      provenance: [{ kind: "incident", reference: `漏网复盘：${writeup.problem}`.slice(0, L.reference) }, { kind: escape.by.kind === "revert" ? "revert" : "fix_commit", reference: fix }],
      issues: [{ title: writeup.problem.slice(0, L.issueTitle), priority: request.priority, evidence: `${writeup.why}`.slice(0, L.evidence), fixShas: [fix], tradeoff: false,
        locations: [{ path: location.path, side: "new", startLine: location.startLine, endLine: location.endLine ?? location.startLine }] }],
    }] });
    const item = result.cases[0];
    if (result.status === "repository_not_found" || !item) return answer("refused", `${path} 不是 Git 仓库。`, escape);
    if (item.outcome === "rejected" || !item.caseId) return answer("refused", `评测集没有收下：${item.reasons.join("；") || "原因不明"}`, escape);
    const caseId = item.caseId;
    return save((saved) => { saved.benchmarkCase = caseId; if (!saved.writeup) { saved.writeup = writeup; saved.state = "written"; } });
  } catch (error) { return answer("failed", said(error), escape); }
};
