import {
  PR_REVIEW_TOOLS_VERSION,
  prFindingBasis,
  prFindingBlocksByDefault,
  prFindingCanBlock,
  prFindingDuplicate,
  prPublishedFindingDraft,
  type PrConnection,
  type PrReviewCommentRequest,
  type PrReviewCommentResult,
  type PrReviewCommentsRecord,
  type PrReviewCommentsResult,
  type PrReviewFindingUpdate,
  type PrReviewFindingUpdateResult,
  type PrReviewHistorySave,
  type PrReviewStatus,
  type PrListQuery,
  type PrListResponse,
  type PrListToolQuery,
  type PrListToolResult,
  type PrReviewHistoryEntry,
  type PrReviewHistoryList,
  type PrReviewRecord,
  type PrReviewRecordSummary,
  type PrReviewRecordsQuery,
  type PrReviewRecordsResult,
} from "@cognelis/decision-protocol";

/**
 * The review history as the agent tools read it (list_prs, list_pr_reviews, get_pr_review): each record without its
 * process log, its findings with what they stand on, and which review of its PR it was. And what they write to it as
 * the review page does (update_pr_review_finding, record_pr_comments), the page told to read the records again.
 */

const counts = (entry: PrReviewHistoryEntry) => {
  const found = { P1: 0, P2: 0, P3: 0 };
  for (const finding of entry.report?.findings ?? []) found[finding.priority] += 1;
  return found;
};
const samePr = (first: PrReviewHistoryEntry, second: PrReviewHistoryEntry) =>
  first.connectionId === second.connectionId && first.snapshot.reference === second.snapshot.reference;

export const recordSummary = (entries: readonly PrReviewHistoryEntry[], entry: PrReviewHistoryEntry): PrReviewRecordSummary => ({
  id: entry.id, kind: entry.kind, at: entry.at, model: entry.model, state: entry.state, connectionId: entry.connectionId ?? null,
  reference: entry.snapshot.reference, title: entry.snapshot.title, sourceCommit: entry.snapshot.sourceCommit,
  risk: entry.snapshot.risk?.level ?? null, status: entry.report?.status ?? null, findings: counts(entry), published: entry.published.length,
  round: entry.kind === "review" ? entries.filter((item) => item.kind === "review" && samePr(item, entry) && item.at <= entry.at).length : null,
  ...(entry.auto ? { auto: true as const } : {}),
});

export const recordView = (entries: readonly PrReviewHistoryEntry[], entry: PrReviewHistoryEntry): PrReviewRecord => {
  const report = entry.report;
  const evidence = report?.evidence ?? [];
  return {
    ...recordSummary(entries, entry),
    focus: entry.focus, destinationBranch: entry.snapshot.destinationBranch ?? null, riskDetail: entry.snapshot.risk ?? null,
    guides: entry.snapshot.guides ?? [], rules: (entry.snapshot.rules ?? []).map((rule) => rule.id),
    summary: report?.summary ?? null, warnings: [...entry.snapshot.warnings, ...(report?.warnings ?? [])].slice(0, 50),
    findingsList: (report?.findings ?? []).map((finding, index) => {
      const verdict = entry.verdicts.find((item) => item.finding === index);
      return {
        ...finding, index, basis: (({ blocking, ...basis }) => basis.tier === "personal" ? { ...basis, blocking: (blocking ?? []).map((rule) => rule.id) } : basis)(
          prFindingBasis(finding, entry.snapshot.guides, entry.snapshot.rules) as ReturnType<typeof prFindingBasis> & { blocking?: Array<{ id: string }> }),
        decisions: finding.decisionIndexes.flatMap((number) => evidence.filter((item) => item.index === number).map(({ record }) => record.title)),
        verdict: verdict ? { verdict: verdict.verdict, reason: verdict.reason, by: verdict.by ?? "model", replacement: verdict.replacement } : null,
        published: entry.published.some((item) => item.finding === index),
        blocking: entry.published.some((item) => item.finding === index && item.blocking === true),
        outcome: entry.published.find((item) => item.finding === index)?.outcome ?? null,
      };
    }),
    needsContext: (report?.needsContext ?? []).map(({ finding, reason, missing }) => ({ title: finding.title, path: finding.path, line: finding.line, reason, missing })),
    setAside: { unplaced: report?.unplaced?.length ?? 0, rejected: report?.filtered?.length ?? 0 },
    turns: entry.turns.map(({ question, answer, state }) => ({ question, answer, state })),
    error: entry.error,
  };
};

/** Newest first; a reference without its "#number" is the repository, all of its PRs. */
export const queryRecords = ({ entries, unreadable }: PrReviewHistoryList, query: PrReviewRecordsQuery): PrReviewRecordsResult => {
  const found = entries.filter((entry) => (query.connectionId === undefined || entry.connectionId === query.connectionId)
    && (query.reference === undefined || entry.snapshot.reference === query.reference || entry.snapshot.reference.replace(/#\d+$/u, "") === query.reference));
  const page = found.slice(query.offset, query.offset + query.limit);
  const end = query.offset + page.length;
  return { prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, total: found.length, nextOffset: end < found.length ? end : null, unreadable, records: page.map((entry) => recordSummary(entries, entry)) };
};

export interface PrListSources {
  connections(): Promise<PrConnection[]>;
  pullRequests(query: PrListQuery): Promise<PrListResponse>;
  history(): Promise<PrReviewHistoryList>;
  /** Each open PR's build, approvals and blockers, those read in time; a PR left out was not. */
  statuses?(connectionId: string, references: string[]): Promise<Map<string, PrReviewStatus>>;
}

/** A connection's PRs as the review page lists them, each with its latest record here. A list that fails says why. */
export const listPrsForAgent = async (query: PrListToolQuery, sources: PrListSources): Promise<PrListToolResult> => {
  const connections = await sources.connections();
  const named = connections.map(({ id, label, platform }) => ({ id, label, platform }));
  const chosen = query.connection === undefined ? connections : connections.filter((item) => item.id === query.connection || item.label === query.connection);
  if (chosen.length === 0 && query.connection !== undefined) return { prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, status: "connection_not_found", connections: named, lists: [] };
  const { entries } = await sources.history();
  const page = query.connection === undefined ? 1 : query.page;
  const filters = query.view === "created" ? ["created"] as const : query.view === "merged" ? ["review-requested", "created"] as const : ["review-requested"] as const;
  const lists = await Promise.all(chosen.map(async (connection) => {
    try {
      const read = await Promise.all(filters.map((filter) => sources.pullRequests({ connectionId: connection.id, filter, page, ...(query.view === "merged" ? { state: "merged" as const } : {}) })));
      const items = [...new Map(read.flatMap((listed) => listed.items).map((item) => [item.reference, item])).values()];
      // What is merged has no build or approval left to wait for.
      const statuses = query.view === "merged" || !items.length || !sources.statuses ? new Map<string, PrReviewStatus>()
        : await sources.statuses(connection.id, items.slice(0, 30).map((item) => item.reference)).catch(() => new Map<string, PrReviewStatus>());
      return {
        connectionId: connection.id, error: null,
        nextPage: read.some((listed) => listed.nextPage !== null) ? page + 1 : null,
        prs: items.map(({ reference, title, repository, number, author, updatedAt }) => {
          const latest = entries.find((entry) => entry.connectionId === connection.id && entry.snapshot.reference === reference);
          return { reference, title, repository, number, author, updatedAt, latest: latest ? recordSummary(entries, latest) : null, status: statuses.get(reference) ?? null };
        }),
      };
    } catch (error) {
      return { connectionId: connection.id, error: (error instanceof Error ? error.message : String(error)).slice(0, 300), nextPage: null, prs: [] };
    }
  }));
  return { prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, status: "ok", connections: named, lists };
};

/** The history as the write tools reach it: the App's store. */
export interface PrHistoryStore {
  list(): Promise<PrReviewHistoryList>;
  save(input: PrReviewHistorySave): Promise<unknown>;
}
const verdictOf = (entry: PrReviewHistoryEntry, index: number) => entry.verdicts.find((item) => item.finding === index);

/**
 * 不采纳 or 撤回 for an agent, as the review page's buttons: a reviewer's drop of the finding with its reason, which
 * replaces a re-evaluation's verdict, and taking it back. A finding already posted stays posted: not dropped here, as
 * the page offers no 不采纳 for it. `changed`: the records written, for the review page to read again.
 */
export const updateFinding = async (store: PrHistoryStore, request: PrReviewFindingUpdate, changed: (ids: string[]) => void): Promise<PrReviewFindingUpdateResult> => {
  const answer = (status: PrReviewFindingUpdateResult["status"], reason: string | null, entries: readonly PrReviewHistoryEntry[] = [], entry?: PrReviewHistoryEntry) =>
    ({ prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, status, reason, record: entry ? recordView(entries, entry) : null });
  const { entries } = await store.list();
  const entry = entries.find((item) => item.id === request.id);
  if (!entry) return answer("not_found", null);
  const index = request.finding - 1;
  const finding = entry.report?.findings[index];
  if (!finding) return answer("refused", `这条记录没有第 ${request.finding} 个问题${entry.report ? `（共 ${entry.report.findings.length} 个）` : "：它没有评审结果"}。`, entries, entry);
  if (entry.state === "running") return answer("refused", "这次评审还在进行，等它结束再改。", entries, entry);
  const own = verdictOf(entry, index)?.by === "reviewer" ? verdictOf(entry, index) : undefined;
  let next: PrReviewHistoryEntry;
  if (request.action === "dismiss") {
    if (request.reason === undefined) return answer("refused", "不采纳要写明原因：以后评审这个仓库时，会把它和原因告诉模型。", entries, entry);
    if (entry.published.some((item) => item.finding === index)) return answer("refused", "这个问题已经发布为 PR 评论，发出去的不能再不采纳。", entries, entry);
    if (own?.reason === request.reason) return answer("unchanged", null, entries, entry);
    next = { ...entry, verdicts: [...entry.verdicts.filter((item) => item.finding !== index),
      { verdict: "drop", reason: request.reason, replacement: null, finding: index, at: new Date().toISOString(), model: "评审者", by: "reviewer" }] };
  } else {
    if (request.reason !== undefined) return answer("refused", "撤回不采纳不需要原因。", entries, entry);
    if (!own) return answer("unchanged", null, entries, entry);
    next = { ...entry, verdicts: entry.verdicts.filter((item) => !(item.finding === index && item.by)) };
  }
  await store.save({ entries: [next], removed: [] });
  changed([next.id]);
  return answer("updated", null, entries.map((item) => (item.id === next.id ? next : item)), next);
};

/** How record_pr_comments reaches the platform: as the review page does, one comment at a time. */
export interface PrCommentPoster {
  connections(): Promise<PrConnection[]>;
  publishComment(request: PrReviewCommentRequest): Promise<PrReviewCommentResult>;
  /** The comments on the PR, what each finding is checked against before it goes out. */
  comments(connectionId: string, reference: string): Promise<Array<{ author: string; path: string | null; line: number | null; side: "old" | "new" | null; body: string }>>;
}

/**
 * Findings of one review posted to its PR, each on its line and pinned to the review's commits, as the review page's
 * batch posts them: one after another, the first failure stopping the rest, each one posted recorded at once so it is
 * never posted twice. Every finding asked for is checked before anything goes out: an unknown, dropped or running
 * one, or blocking on a personal basis, posts nothing.
 */
export const recordComments = async (store: PrHistoryStore, poster: PrCommentPoster, request: PrReviewCommentsRecord, changed: (ids: string[]) => void): Promise<PrReviewCommentsResult> => {
  const warnings: string[] = [];
  const answer = (status: PrReviewCommentsResult["status"], reason: string | null, results: PrReviewCommentsResult["results"] = [], entries: readonly PrReviewHistoryEntry[] = [], entry?: PrReviewHistoryEntry) =>
    ({ prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, status, reason, results, warnings, record: entry ? recordView(entries, entry) : null });
  let { entries } = await store.list();
  let entry = entries.find((item) => item.id === request.id);
  if (!entry) return answer("not_found", null);
  const refuse = (reason: string) => answer("refused", reason, [], entries, entry);
  if (entry.kind !== "review" || !entry.report) return refuse("这条记录没有评审结果，没有可发布的问题。");
  if (entry.state === "running") return refuse("这次评审还在进行，等它结束再发。");
  const connectionId = entry.connectionId;
  if (!connectionId || !(await poster.connections()).some((item) => item.id === connectionId)) return refuse("这条记录的代码平台连接已不存在，请用户先在「链接」页重新添加。");
  if (new Set(request.findings.map((item) => item.finding)).size !== request.findings.length) return refuse("同一个问题列了不止一次。");
  const report = entry.report;
  const guides = entry.snapshot.guides, rules = entry.snapshot.rules;
  const asked = [];
  for (const item of request.findings) {
    const index = item.finding - 1;
    const original = report.findings[index];
    if (!original) return refuse(`这条记录没有第 ${item.finding} 个问题（共 ${report.findings.length} 个）。`);
    const verdict = verdictOf(entry, index);
    if (verdict?.verdict === "drop") return refuse(verdict.by ? `第 ${item.finding} 个问题用户不采纳过；要发布，先用 update_pr_review_finding 撤回不采纳。` : `第 ${item.finding} 个问题复评判为不成立，不发布。`);
    // As the page posts it: a replacing re-evaluation's words.
    const finding = { ...original, ...(verdict?.replacement ?? {}) };
    if (item.blocking && !prFindingCanBlock(finding, guides, rules)) return refuse(`第 ${item.finding} 个问题只有用户的个人依据，只能作建议，不能设为阻塞（只有依据标记为阻塞的本机规则的 P1 可以）。`);
    asked.push({ item, index, finding, blocking: item.blocking ?? prFindingBlocksByDefault(finding, guides, rules) });
  }
  // What is on the PR already, read once: a finding another reviewer's Paraself posted at its place is not posted again.
  const existing = await poster.comments(connectionId, entry.snapshot.reference).catch(() => {
    warnings.push("没能读到 PR 上已有的评论，这次没有按位置去重。");
    return [];
  });
  const results: PrReviewCommentsResult["results"] = [];
  let posted = 0, failed = false;
  for (const { item, index, finding, blocking } of asked) {
    if (failed) { results.push({ finding: item.finding, outcome: "not_tried", blocking, message: "前一条失败，没有尝试。" }); continue; }
    const before = entry.published.find((done) => done.finding === index);
    if (before) { results.push({ finding: item.finding, outcome: "already_posted", blocking: before.blocking === true, message: "已经发布过，没有重发。" }); continue; }
    const same = item.evenIfDuplicate ? undefined : prFindingDuplicate(finding, existing);
    if (same) { results.push({ finding: item.finding, outcome: "duplicate", blocking, message: `PR 上已有同位置的同类意见（${same.author || "未知作者"}）：${same.body.replace(/\s+/gu, " ").slice(0, 120)}` }); continue; }
    try {
      const result = await poster.publishComment({ connectionId, reference: entry.snapshot.reference, sourceCommit: entry.snapshot.sourceCommit, destinationCommit: entry.snapshot.destinationCommit,
        path: finding.path, side: finding.side, line: finding.line, body: prPublishedFindingDraft(finding, guides, item.body, rules), ...(blocking ? { blocking } : {}) });
      const held = blocking && result.blocking === true;
      // Recorded at once: a failure after it, or the App stopping, never sends it again.
      entry = { ...entry, published: [...entry.published, { finding: index, at: new Date().toISOString(), ...(held ? { blocking: true as const } : {}), ...(result.comment ? { comment: result.comment } : {}) }],
        ...(entry.listedComments === undefined ? {} : { listedComments: entry.listedComments + 1 }) };
      await store.save({ entries: [entry], removed: [] });
      posted++;
      results.push({ finding: item.finding, outcome: "posted", blocking: held, message: result.message.slice(0, 2_000) });
    } catch (error) {
      failed = true;
      results.push({ finding: item.finding, outcome: "failed", blocking, message: (error instanceof Error ? error.message : String(error)).slice(0, 2_000) });
    }
  }
  // A comment posted is no news to the PR's other records either: the list counts it, as the page's own posts do.
  const posting = entry;
  const others = posted ? entries.filter((item) => item.id !== posting.id && item.connectionId === posting.connectionId && item.snapshot.reference === posting.snapshot.reference && item.listedComments !== undefined)
    .map((item) => ({ ...item, listedComments: item.listedComments! + posted })) : [];
  if (others.length) await store.save({ entries: others, removed: [] });
  entries = entries.map((item) => (item.id === posting.id ? posting : others.find((other) => other.id === item.id) ?? item));
  if (posted) changed([posting.id, ...others.map((item) => item.id)]);
  return answer(!failed ? "posted" : posted ? "partial" : "failed", null, results, entries, posting);
};
