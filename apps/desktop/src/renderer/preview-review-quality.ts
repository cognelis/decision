import type { ReviewBenchmarkPageRequest, ReviewBenchmarkPageResult, ReviewBenchmarkRunCase, ReviewBenchmarkRunSummary, ReviewEscape, ReviewEscapeUpdateInput, ReviewEscapeUpdateResult, ReviewQualityResult } from "@cognelis/decision-protocol";

/** The preview's 评审质量: synthetic figures, as the design board shows them; nothing here was read from a platform. */
export const previewReviewQuality = (connectionId: string): ReviewQualityResult => ({
  prReviewToolsVersion: 1, status: "ok", connections: [{ id: connectionId, label: "示例团队", platform: "bitbucket-server" }],
  quality: {
    connectionId, label: "示例团队", platform: "bitbucket-server", days: 30,
    team: {
      current: { prs: 18, approvalsPerPr: 1.3, humanCommentsPerPr: 2.4, waitHours: 5, rollbacks: 0, escapes: 1 },
      previous: { prs: 21, approvalsPerPr: 1.6, humanCommentsPerPr: 3.1, waitHours: 9, rollbacks: 1, escapes: 0 },
      unread: 0, error: null,
    },
    outcomes: {
      rows: [
        { basis: "repository", published: 21, fixed: 16, wrong: 1, intended: 2, wontfix: 0, later: 0, none: 2 },
        { basis: "personal", published: 16, fixed: 6, wrong: 4, intended: 3, wontfix: 2, later: 0, none: 1 },
        { basis: "none", published: 9, fixed: 5, wrong: 1, intended: 2, wontfix: 1, later: 0, none: 0 },
      ],
      maybeFixed: 5, total: 51,
    },
    noise: [{ kind: "local_rule", id: "list-pagination.md", source: "decision", title: "list-pagination", notePath: null, settled: 4, wrong: 3, wontfix: 0, prs: 3, words: ["只读的小表不需要分页。"] }],
    escapes: [{ id: "00000000-0000-4000-8000-0000000000e1", connectionId, reference: "SYN/app#119", title: "导出报表加时间列", mergedAt: "2026-11-10T08:00:00.000Z",
      by: { kind: "fix", reference: "SYN/app#124", title: "修复导出时区：#119 按服务器时区格式化" }, foundAt: "2026-11-12T08:00:00.000Z", state: "open", writeup: null, dismissed: null, benchmarkCase: null }],
    promotions: [{ key: "decision|null|dec-9", kind: "decision", title: "续期失败返回 401 + SESSION_EXPIRED", repository: "SYN/app", signals: ["支撑的意见出现在 3 个 PR，修了 2 次"],
      evidence: [{ reference: "SYN/app#128", title: "续期失败返回码不对", outcome: "修了" }, { reference: "SYN/app#131", title: "续期失败返回码不对", outcome: "修了" }, { reference: "SYN/app#140", title: "续期失败没带错误码", outcome: "未回应" }],
      prs: 3, fixed: 2, draft: "- 续期失败返回 401 + SESSION_EXPIRED", proposed: null }],
  },
});

/** The preview's 漏网复盘 as updates leave it, held in memory only: nothing is written anywhere. */
const changedEscapes = new Map<string, ReviewEscape>();
export const previewEscapeUpdate = (input: ReviewEscapeUpdateInput): ReviewEscapeUpdateResult => {
  const escape = changedEscapes.get(input.id) ?? previewReviewQuality("00000000-0000-4000-8000-000000000001").quality!.escapes.find((item) => item.id === input.id);
  if (!escape) return { prReviewToolsVersion: 1, status: "not_found", reason: "没有这条漏网复盘。", escape: null };
  const writeup = input.writeup ? { ...input.writeup, changeText: input.writeup.changeText ?? "" } : escape.writeup;
  const next: ReviewEscape = input.action === "write" ? { ...escape, state: "written", writeup } : input.action === "dismiss" ? { ...escape, state: "dismissed", dismissed: input.reason ?? "" }
    : input.action === "reopen" ? escape : { ...escape, state: "written", writeup, benchmarkCase: "case-000000000119" };
  changedEscapes.set(input.id, next);
  return { prReviewToolsVersion: 1, status: "updated", reason: null, escape: next };
};

/** The preview's 评测集: synthetic sets and two runs, as the design board shows them; nothing here was reviewed. */
const PREVIEW_REPOSITORY = "/preview/app";
const previewRun = (id: string, label: string, startedAt: string, harmful: number, findings: number): ReviewBenchmarkRunSummary => ({
  id, repositoryPath: PREVIEW_REPOSITORY, project: "示例团队/app", label, split: "holdout", fixControl: true, model: "本机模型 · qwen3", profileId: "local",
  startedAt, finishedAt: startedAt, state: "finished", error: null, adopted: null,
  totals: { defect: { cases: 18, issues: 18, hit: 11, lost: 1, fixReported: 0 }, clean: { cases: 20, findings, harmful, noise: findings - harmful - 6, valid: 6, unjudged: 0, knownRepeats: 0 }, done: 38, failed: 0, total: 38 },
});
const BEFORE = previewRun("00000000-0000-4000-8000-0000000000b1", "基线：现有规则", "2026-11-17T09:00:00.000Z", 2, 32);
const AFTER = previewRun("00000000-0000-4000-8000-0000000000b2", "本机规则「列表接口都要分页」改为只管返回超过 100 条的列表", "2026-11-18T09:00:00.000Z", 0, 26);
const previewCases: ReviewBenchmarkRunCase[] = [{ caseId: "case-000000000121", set: "clean", title: "字典表接口", state: "done", error: null, issues: 0, hit: 0, lost: 0, fixReported: null, knownRepeats: 0, wallMs: 60_000,
  findings: [{ title: "列表接口没有分页", priority: "P3", path: "api/dict.ts", side: "new", line: 12, body: "字典表接口一次返回全部数据。", kept: true }], judgments: [{ finding: 0, verdict: "noise" }] }];
export const previewBenchmarkPage = (request: ReviewBenchmarkPageRequest): ReviewBenchmarkPageResult => {
  const done = (message: string | null, more: Partial<ReviewBenchmarkPageResult> = {}): ReviewBenchmarkPageResult => ({ ok: true, message, overview: null, run: null, ...more });
  const run = (id: string) => ({ reviewBenchmarkVersion: 1 as const, status: "ok" as const, run: id === BEFORE.id ? BEFORE : AFTER, cases: previewCases,
    comparison: id === BEFORE.id ? null : { before: BEFORE.id, after: AFTER.id, sameCases: true, verdict: "adopt" as const, said: "召回没降，有害意见减少：可以采用。",
      rows: [{ metric: "hit" as const, label: "缺陷命中（18 个问题）", before: 11, after: 11, change: "same" as const }, { metric: "harmful" as const, label: "有害意见（20 个 PR）", before: 2, after: 0, change: "down" as const },
        { metric: "commentsPerCase" as const, label: "每个 PR 的意见", before: 1.6, after: 1.3, change: "down" as const }, { metric: "fixReported" as const, label: "修复后再报", before: 0, after: 0, change: "same" as const }] } });
  switch (request.kind) {
    case "overview": return done(null, { overview: { active: null, models: [{ id: "local", label: "本机模型 · qwen3" }],
      repositories: [{ path: PREVIEW_REPOSITORY, project: "示例团队/app", counts: { defect: { candidate: 2, dev: 10, holdout: 18 }, clean: { candidate: 0, dev: 10, holdout: 20 } },
        candidates: [{ caseId: "case-000000000119", set: "defect", title: "导出时区换算错误", from: "SYN/app#119" }, { caseId: "case-000000000128", set: "defect", title: "续期没查吊销", from: "SYN/app#128" }],
        runs: [AFTER, BEFORE] }],
      suggestions: [
        { key: "preview-121", set: "clean", source: "wrong", reference: "SYN/app#121", title: "字典表接口的分页意见", said: "作者回复“说错了”：只读的小表不需要分页。", blocked: null },
        { key: "sample:preview|SYN/app#115", set: "clean", source: "sampling", reference: "SYN/app#115", title: "合并 60 天无修复", said: "合并 75 天，没有回滚，也没有 PR 点名修复它", blocked: null },
      ] } });
    case "get": return done(null, { run: run(request.id) });
    case "judge": return done(null, { run: run(request.id) });
    case "adopt": return done("已记为采用。", { run: { ...run(request.id), run: { ...AFTER, adopted: { at: "2026-11-19T09:00:00.000Z", note: request.note } } } });
    case "run": return done(`已开始评测：${request.label}。`, { run: { reviewBenchmarkVersion: 1, status: "ok", run: { ...AFTER, id: "00000000-0000-4000-8000-0000000000b3", label: request.label, state: "running", finishedAt: null }, cases: [], comparison: null } });
    case "cancel": return done("正在取消评测：当前样本停下后结束。");
    case "confirm": return done("已确认入集。");
    case "accept": return done("已录为候选样本 case-000000000121：核对后在“待确认的候选样本”里确认入集。");
    case "dismiss": return done("这条建议不再列出。");
  }
};
