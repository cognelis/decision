import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  PR_OUTCOME_LABELS,
  PR_REVIEW_TOOLS_VERSION,
  prOutcomeSettled,
  type PrConnection,
  type PrReviewHistoryEntry,
  type ReviewPromotion,
  type ReviewPromotionAction,
  type ReviewPromotionActionResult,
  type ReviewPromotionsQuery,
  type ReviewPromotionsResult,
} from "@cognelis/decision-protocol";

import { atomicWrite } from "./atomic-write.js";
import { resolveConnection } from "./pr-description-tools.js";
import type { PrHistoryStore } from "./pr-review-records.js";
import type { ReviewEscapeStore } from "./review-escapes.js";
import { rulesBehind } from "./review-quality.js";

const said = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
const repositoryOf = (reference: string) => reference.slice(0, reference.lastIndexOf("#"));
const ledgerSchema = z.object({ version: z.literal(1), keys: z.record(z.string(), z.object({ state: z.enum(["proposed", "dismissed"]), at: z.string(), jobId: z.string().nullable() })) });

/** Promotions proposed (with the local review task they became) or left: a left one is not offered again. */
export class PromotionLedger {
  #tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}
  async read(): Promise<z.infer<typeof ledgerSchema>["keys"]> {
    try { return ledgerSchema.parse(JSON.parse(await readFile(this.path, "utf8"))).keys; } catch { return {}; }
  }
  mark(key: string, state: "proposed" | "dismissed", jobId: string | null = null): Promise<void> {
    const next = this.#tail.then(async () => {
      const keys = { ...(await this.read()), [key]: { state, at: new Date().toISOString(), jobId } };
      await atomicWrite(this.path, JSON.stringify({ version: 1, keys: Object.fromEntries(Object.entries(keys).slice(-1_000)) }));
    });
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

export interface ReviewPromotionSources {
  connections(): Promise<PrConnection[]>;
  history: PrHistoryStore;
  escapes: ReviewEscapeStore;
  ledger: PromotionLedger;
  /** A comment on the repository's rules file handed to the local review, as a task of its own: resolves to its id. */
  propose(input: { connectionId: string; repository: string; path: string; body: string }): Promise<string>;
}

// An author's answer that the repository has no such rule: a rule others cannot see was asked of them.
const NO_RULE = /没有这条规则|仓库里没有|没有(?:这个|这条)?(?:规定|约定)|不是仓库的规则|no such rule|not a (?:repo|repository) rule/iu;

/** One link's 晋升提议: rules review keeps needing that live only in the user's Paraself, and escapes' write-ups. */
export const promotionsFor = async (connectionId: string, sources: Pick<ReviewPromotionSources, "history" | "escapes" | "ledger">): Promise<ReviewPromotion[]> => {
  const [{ entries }, escapes, ledger] = await Promise.all([sources.history.list(), sources.escapes.list(), sources.ledger.read()]);
  type Tally = { kind: "decision" | "local_rule"; title: string; prs: Set<string>; fixed: number; noisy: number; p1Fixed: boolean; noRule: boolean; blocking: boolean; repositories: Map<string, number>;
    evidence: ReviewPromotion["evidence"] };
  const tallies = new Map<string, Tally>();
  const reviewed = entries.filter((entry): entry is PrReviewHistoryEntry & { report: NonNullable<PrReviewHistoryEntry["report"]> } => entry.kind === "review" && entry.connectionId === connectionId && entry.report !== null);
  for (const entry of reviewed) {
    for (const item of entry.published) {
      const finding = entry.report.findings[item.finding];
      if (!finding) continue;
      for (const rule of rulesBehind(entry, finding)) {
        const key = `${rule.kind}|${rule.source}|${rule.id}`;
        const tally: Tally = tallies.get(key) ?? { kind: rule.kind, title: rule.title, prs: new Set(), fixed: 0, noisy: 0, p1Fixed: false, noRule: false, blocking: false, repositories: new Map(), evidence: [] };
        // Marked blocking by the reviewer: holding others to a rule they cannot read belongs in the repository.
        if (rule.blocking) tally.blocking = true;
        const outcome = item.outcome?.kind;
        tally.prs.add(entry.snapshot.reference);
        const repository = repositoryOf(entry.snapshot.reference);
        tally.repositories.set(repository, (tally.repositories.get(repository) ?? 0) + 1);
        if (outcome === "fixed") { tally.fixed++; if (finding.priority === "P1") tally.p1Fixed = true; }
        if (outcome === "wrong" || outcome === "wontfix") tally.noisy++;
        if (item.outcome?.words && NO_RULE.test(item.outcome.words)) tally.noRule = true;
        if (tally.evidence.length < 5) tally.evidence.push({ reference: entry.snapshot.reference, title: finding.title.slice(0, 300), outcome: item.outcome && prOutcomeSettled(item.outcome.kind) ? PR_OUTCOME_LABELS[item.outcome.kind] : "未回应" });
        tallies.set(key, tally);
      }
    }
  }
  const found: ReviewPromotion[] = [];
  const proposedOf = (key: string) => { const kept = ledger[key]; return kept?.state === "proposed" ? { at: kept.at, jobId: kept.jobId ?? "" } : null; };
  for (const [key, tally] of tallies) {
    if (ledger[key]?.state === "dismissed") continue;
    // Called wrong as often as fixed: noise to rewrite (噪声统计), not a rule to promote.
    if (tally.noisy >= 2 && tally.noisy >= tally.fixed) continue;
    const signals = [
      ...(tally.prs.size >= 2 ? [`支撑的意见出现在 ${tally.prs.size} 个 PR，修了 ${tally.fixed} 次`] : []),
      ...(tally.p1Fixed ? ["有 P1 的问题依据它，作者修了"] : []),
      ...(tally.noRule ? ["作者回复仓库里没有这条规则"] : []),
      ...(tally.blocking ? ["你把它标记为阻塞：拿只在你这里的规则要求别人，应该写进仓库"] : []),
    ];
    if (!signals.length) continue;
    const repository = [...tally.repositories].sort((a, b) => b[1] - a[1])[0]![0];
    found.push({ key, kind: tally.kind, title: tally.title.slice(0, 500), repository, signals, evidence: tally.evidence, prs: tally.prs.size, fixed: tally.fixed,
      draft: `- ${tally.title}`.slice(0, 1_000), proposed: proposedOf(key) });
  }
  for (const escape of escapes) {
    const key = `escape|${escape.id}`;
    if (escape.connectionId !== connectionId || escape.state !== "written" || !escape.writeup || !["rule", "norm"].includes(escape.writeup.change) || ledger[key]?.state === "dismissed") continue;
    const title = escape.writeup.changeText || escape.writeup.problem;
    found.push({ key, kind: "escape", title: title.slice(0, 500), repository: repositoryOf(escape.reference), signals: [`来自 ${escape.reference} 的漏网复盘`],
      evidence: [{ reference: escape.reference, title: escape.writeup.problem.slice(0, 300), outcome: "漏网" }], prs: 1, fixed: 0,
      draft: `- ${title}（漏网复盘：${escape.reference}）`.slice(0, 1_000), proposed: proposedOf(key) });
  }
  return found.sort((a, b) => Number(a.proposed !== null) - Number(b.proposed !== null) || b.prs - a.prs).slice(0, 30);
};

export const promotionsForAgent = async (query: Omit<ReviewPromotionsQuery, "prReviewToolsVersion">, sources: ReviewPromotionSources): Promise<ReviewPromotionsResult> => {
  const { connection, connections, status } = await resolveConnection(sources, query.connection);
  const base = { prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, connections } as const;
  if (!connection) return { ...base, status, promotions: [] };
  return { ...base, status: "ok", promotions: await promotionsFor(connection.id, sources) };
};

/** The rules file a repository's reviews read, as the latest review of it named it; REVIEW.md at its root by default. */
const guideOf = (entries: readonly PrReviewHistoryEntry[], connectionId: string, repository: string) =>
  entries.find((entry) => entry.connectionId === connectionId && repositoryOf(entry.snapshot.reference) === repository)?.snapshot.guides?.find((path) => /(?:^|\/)REVIEW\.md$/u.test(path)) ?? "REVIEW.md";

/**
 * 提议写进 REVIEW.md: the line (as the user left it), its signals and examples handed to the local review as a comment on
 * the rules file. It writes it in an isolated copy, checks itself, and pushes a branch and opens a PR only once the user
 * confirms the change in the App: a rules file is a high-risk change.
 */
export const actOnPromotion = async (action: ReviewPromotionAction, sources: ReviewPromotionSources): Promise<ReviewPromotionActionResult> => {
  if (action.action === "dismiss") { await sources.ledger.mark(action.key, "dismissed"); return { ok: true, message: "这条提议不再列出。", jobId: null }; }
  const promotion = (await promotionsFor(action.connectionId, sources)).find((item) => item.key === action.key);
  if (!promotion) return { ok: false, message: "这条提议已经不在了。", jobId: null };
  if (promotion.proposed) return { ok: false, message: `已经交给本地审阅了（任务 ${promotion.proposed.jobId}）。`, jobId: promotion.proposed.jobId };
  const path = guideOf((await sources.history.list()).entries, action.connectionId, promotion.repository);
  const body = [
    `在 ${path} 的规则里加一条，写法和位置按文件里已有的来：`, "", action.draft, "",
    `依据：${promotion.signals.join("；")}。`,
    `例子：${promotion.evidence.map((item) => `${item.reference}「${item.title}」（${item.outcome}）`).join("；")}。`,
    "只改这个文件，不改代码。",
  ].join("\n");
  try {
    const jobId = await sources.propose({ connectionId: action.connectionId, repository: promotion.repository, path, body });
    await sources.ledger.mark(action.key, "proposed", jobId);
    return { ok: true, message: `已交给本地审阅（任务 ${jobId}）：改好后在“本地审阅”里确认，才会推送分支并开 PR。`, jobId };
  } catch (error) { return { ok: false, message: `没有交给本地审阅：${said(error)}`, jobId: null }; }
};
