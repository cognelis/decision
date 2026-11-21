import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  PR_REVIEW_TOOLS_VERSION,
  REVIEW_BASIS_ROWS,
  REVIEW_QUALITY_DAYS,
  prFindingBasis,
  prOutcomeSettled,
  type PrConnection,
  type PrListQuery,
  type PrListResponse,
  type PrReviewHistoryEntry,
  type ReviewNoisyRule,
  type ReviewOutcomeRow,
  type ReviewPromotion,
  type ReviewQuality,
  type ReviewQualityQuery,
  type ReviewQualityResult,
  type ReviewRuleUpdateResult,
  type ReviewTeamWindow,
} from "@cognelis/decision-protocol";

import { atomicWrite } from "./atomic-write.js";
import { findEscapes, keepFound, type ReviewEscapeStore } from "./review-escapes.js";
import { resolveConnection } from "./pr-description-tools.js";
import type { PrTeamFacts } from "./pr-platform-client.js";
import type { PrHistoryStore } from "./pr-review-records.js";

const DAY = 86_400_000;
const said = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
const factsSchema = z.object({ title: z.string(), description: z.string(), createdAt: z.string(), mergedAt: z.string().nullable(),
  approvals: z.array(z.object({ login: z.string(), at: z.string() })), humanComments: z.number().int().nonnegative() });
// Version 2 keeps each PR's description, which 漏网 is found by: a version 1 file is read again from the platform.
const cacheSchema = z.object({ version: z.literal(2), facts: z.record(z.string(), factsSchema) });

/** Merged PRs' figures by link and PR: read once, as a merged PR does not change. The newest 500 kept. */
export class PrTeamFactsCache {
  #tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}
  async read(): Promise<Record<string, PrTeamFacts>> {
    try { return cacheSchema.parse(JSON.parse(await readFile(this.path, "utf8"))).facts; } catch { return {}; }
  }
  add(found: Record<string, PrTeamFacts>): Promise<void> {
    const next = this.#tail.then(async () => {
      const kept = Object.entries({ ...(await this.read()), ...found })
        .sort(([, a], [, b]) => (b.mergedAt ?? b.createdAt).localeCompare(a.mergedAt ?? a.createdAt)).slice(0, 500);
      await atomicWrite(this.path, JSON.stringify({ version: 2, facts: Object.fromEntries(kept) }));
    });
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

export interface ReviewQualitySources {
  connections(): Promise<PrConnection[]>;
  history: PrHistoryStore;
  pullRequests(query: PrListQuery): Promise<PrListResponse>;
  facts(connectionId: string, reference: string): Promise<PrTeamFacts>;
  cache: PrTeamFactsCache;
  /** 漏网复盘: found among the merged PRs read, and kept. */
  escapes?: ReviewEscapeStore;
  /** 晋升提议 of the link (review-promotions.ts). */
  promotions?(connectionId: string): Promise<ReviewPromotion[]>;
  now?(): number;
}

/** New merged PRs read a look at most, four at a time: the rest on the next look. */
const FACTS_PER_LOOK = 20;
const REVERT = /^(?:revert\b|回滚|撤回)/iu;
const mean = (values: number[]) => (values.length ? values.reduce((total, value) => total + value, 0) / values.length : null);
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const tenths = (value: number | null) => (value === null ? null : Math.round(value * 10) / 10);

export const teamWindow = (facts: readonly PrTeamFacts[], escapes = 0): ReviewTeamWindow => ({
  prs: facts.length,
  approvalsPerPr: tenths(mean(facts.map((item) => new Set(item.approvals.map((approval) => approval.login)).size))),
  humanCommentsPerPr: tenths(mean(facts.map((item) => item.humanComments))),
  waitHours: tenths(median(facts.flatMap((item) => {
    const first = Math.min(...item.approvals.map((approval) => Date.parse(approval.at)).filter(Number.isFinite));
    return Number.isFinite(first) ? [Math.max(0, first - Date.parse(item.createdAt)) / 3_600_000] : [];
  }))),
  rollbacks: facts.filter((item) => REVERT.test(item.title)).length,
  escapes,
});

/** The link's PRs the user reviewed or wrote that merged since `since`, by the list's update times. */
const mergedSince = async (sources: ReviewQualitySources, connectionId: string, since: number) => {
  const found = new Map<string, string>();
  for (const filter of ["review-requested", "created"] as const) {
    let page = 1;
    for (let read = 0; read < 5; read++) {
      const listed = await sources.pullRequests({ connectionId, filter, state: "merged", page });
      for (const item of listed.items) if (Date.parse(item.updatedAt) >= since) found.set(item.reference, item.updatedAt);
      const oldest = listed.items.at(-1);
      if (!listed.nextPage || !oldest || Date.parse(oldest.updatedAt) < since) break;
      page = listed.nextPage;
    }
  }
  return [...found.keys()];
};

const teamOf = async (sources: ReviewQualitySources, connectionId: string, now: number): Promise<ReviewQuality["team"] & { read: Array<{ reference: string; facts: PrTeamFacts }> }> => {
  const since = now - 2 * REVIEW_QUALITY_DAYS * DAY, split = now - REVIEW_QUALITY_DAYS * DAY;
  const merged = await mergedSince(sources, connectionId, since);
  const key = (reference: string) => `${connectionId}|${reference}`;
  const cached = await sources.cache.read(), found: Record<string, PrTeamFacts> = {};
  const missing = merged.filter((reference) => !cached[key(reference)]).slice(0, FACTS_PER_LOOK);
  let error: string | null = null;
  for (let index = 0; index < missing.length; index += 4) {
    await Promise.all(missing.slice(index, index + 4).map(async (reference) => {
      try { found[key(reference)] = await sources.facts(connectionId, reference); } catch (caught) { error ??= said(caught); }
    }));
  }
  if (Object.keys(found).length) await sources.cache.add(found);
  const read = merged.flatMap((reference) => { const item = found[key(reference)] ?? cached[key(reference)]; return item ? [{ reference, facts: item }] : []; });
  const facts = read.map((item) => item.facts);
  const at = (item: PrTeamFacts) => Date.parse(item.mergedAt ?? item.createdAt);
  return { current: teamWindow(facts.filter((item) => at(item) >= split)), previous: teamWindow(facts.filter((item) => at(item) < split && at(item) >= since)),
    unread: merged.length - facts.length, error, read };
};

const reviewsOn = (entries: readonly PrReviewHistoryEntry[], connectionId: string) =>
  entries.filter((entry): entry is PrReviewHistoryEntry & { report: NonNullable<PrReviewHistoryEntry["report"]> } => entry.kind === "review" && entry.connectionId === connectionId && entry.report !== null);

/** What became of the findings posted since `since`, by what each stood on. 可能修了 is kept out of the rows. */
export const outcomesOf = (entries: readonly PrReviewHistoryEntry[], connectionId: string, since: number): ReviewQuality["outcomes"] => {
  const rows = new Map(REVIEW_BASIS_ROWS.map((basis): [string, ReviewOutcomeRow] => [basis, { basis, published: 0, fixed: 0, wrong: 0, intended: 0, wontfix: 0, later: 0, none: 0 }]));
  let maybeFixed = 0;
  for (const entry of reviewsOn(entries, connectionId)) {
    for (const item of entry.published) {
      const finding = entry.report.findings[item.finding];
      if (!finding || Date.parse(item.at) < since) continue;
      const kind = item.outcome?.kind ?? "none";
      if (kind === "maybe_fixed") { maybeFixed++; continue; }
      const row = rows.get(prFindingBasis(finding, entry.snapshot.guides).tier)!;
      row.published++;
      row[kind]++;
    }
  }
  const list = [...rows.values()];
  return { rows: list, maybeFixed, total: list.reduce((total, row) => total + row.published, 0) + maybeFixed };
};

/**
 * What a finding stood on of the user's own: the decisions it cites (decisionIndexes, by the report's evidence) and the
 * local rules it names ("Ruleset N", the N-th rule the review was given), each once.
 */
export const rulesBehind = (entry: Pick<PrReviewHistoryEntry, "snapshot"> & { report: NonNullable<PrReviewHistoryEntry["report"]> }, finding: { body: string; decisionIndexes: readonly number[] }) => {
  const rules = [
    ...finding.decisionIndexes.flatMap((index) => {
      const record = entry.report.evidence.find((evidence) => evidence.index === index)?.record;
      return record ? [{ kind: "decision" as const, id: record.id, source: null, title: record.title, notePath: record.sourceRef?.relativePath ?? null, blocking: false }] : [];
    }),
    ...[...finding.body.matchAll(/\bRuleset\s*(\d+)/gu)].flatMap(([, number]) => {
      const rule = entry.snapshot.rules?.[Number(number) - 1];
      return rule ? [{ kind: "local_rule" as const, id: rule.id, source: rule.source, title: rule.id.replace(/\.md$/u, ""), notePath: null, blocking: rule.enforcement === "blocking" }] : [];
    }),
  ];
  return [...new Map(rules.map((item) => [`${item.kind}|${item.source}|${item.id}`, item])).values()];
};

/**
 * Rules whose posted findings were answered, most of them 说错了 or 无所谓, twice or more: what stood behind each finding is
 * the decisions it cites and the local rules it names (its "Ruleset N", the N-th rule the review was given).
 */
export const noiseOf = (entries: readonly PrReviewHistoryEntry[], connectionId: string): ReviewNoisyRule[] => {
  const tallies = new Map<string, ReviewNoisyRule & { prsSeen: Set<string>; reasons: Array<{ at: string; words: string }> }>();
  for (const entry of reviewsOn(entries, connectionId)) {
    for (const item of entry.published) {
      const finding = entry.report.findings[item.finding], outcome = item.outcome;
      if (!finding || !outcome || !prOutcomeSettled(outcome.kind)) continue;
      for (const rule of rulesBehind(entry, finding)) {
        const key = `${rule.kind}|${rule.source}|${rule.id}`;
        const { blocking: _, ...named } = rule;
        const tally = tallies.get(key) ?? { ...named, settled: 0, wrong: 0, wontfix: 0, prs: 0, words: [], prsSeen: new Set<string>(), reasons: [] };
        tally.settled++;
        if (outcome.kind === "wrong" || outcome.kind === "wontfix") {
          tally[outcome.kind]++;
          tally.prsSeen.add(entry.snapshot.reference);
          if (outcome.words) tally.reasons.push({ at: outcome.at, words: outcome.words.slice(0, 500) });
        }
        tallies.set(key, tally);
      }
    }
  }
  return [...tallies.values()]
    .filter((item) => item.wrong + item.wontfix >= 2 && (item.wrong + item.wontfix) * 2 >= item.settled)
    .sort((a, b) => b.wrong + b.wontfix - (a.wrong + a.wontfix))
    .slice(0, 20)
    .map(({ prsSeen, reasons, ...item }) => ({ ...item, prs: prsSeen.size, words: reasons.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 3).map((reason) => reason.words) }));
};

/** One link's 评审质量 (the only one, when there is one). The team's figures failing to read leave the rest standing. */
export const reviewQualityFor = async (query: Omit<ReviewQualityQuery, "prReviewToolsVersion">, sources: ReviewQualitySources): Promise<ReviewQualityResult> => {
  const { connection, connections, status } = await resolveConnection(sources, query.connection);
  const base = { prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, connections } as const;
  if (!connection) return { ...base, status, quality: null };
  const now = sources.now?.() ?? Date.now();
  const { entries } = await sources.history.list();
  const { read, ...team } = await teamOf(sources, connection.id, now)
    .catch((error: unknown) => ({ current: teamWindow([]), previous: teamWindow([]), unread: 0, error: said(error), read: [] }));
  // 漏网: what a later revert or fix among the merged PRs showed, kept once; counted in the window the escaped PR merged in.
  if (sources.escapes) await keepFound(sources.escapes, connection.id, findEscapes(read), now).catch(() => 0);
  const escapes = (await sources.escapes?.list() ?? []).filter((item) => item.connectionId === connection.id && item.state !== "dismissed");
  const merged = (from: number, to: number) => escapes.filter((item) => { const at = Date.parse(item.mergedAt ?? item.foundAt); return at >= from && at < to; }).length;
  const split = now - REVIEW_QUALITY_DAYS * DAY;
  team.current.escapes = merged(split, Infinity);
  team.previous.escapes = merged(split - REVIEW_QUALITY_DAYS * DAY, split);
  return { ...base, status: "ok", quality: { connectionId: connection.id, label: connection.label, platform: connection.platform, days: REVIEW_QUALITY_DAYS, team,
    outcomes: outcomesOf(entries, connection.id, split), noise: noiseOf(entries, connection.id), escapes: escapes.slice(0, 50),
    promotions: await sources.promotions?.(connection.id).catch(() => []) ?? [] } };
};

/** One of Paraself's own rules turned off (`enabled: false` in its frontmatter) or on again; the rest of the file as written. */
export const setReviewRuleEnabled = async (directory: string, rule: string, enabled: boolean): Promise<ReviewRuleUpdateResult> => {
  const answer = (status: ReviewRuleUpdateResult["status"], reason: string | null = null) => ({ prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, status, reason });
  const path = resolve(directory, rule);
  if (!rule.endsWith(".md") || relative(directory, path).startsWith("..") || !path.startsWith(`${resolve(directory)}${sep}`)) return answer("not_found", `Paraself 的评审规则目录里没有「${rule}」。`);
  let text: string;
  try { text = await readFile(path, "utf8"); } catch { return answer("not_found", `Paraself 的评审规则目录里没有「${rule}」。`); }
  const front = /^(---\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/u.exec(text);
  const next = front
    ? `${front[1]}${/^enabled:.*$/mu.test(front[2]!) ? front[2]!.replace(/^enabled:.*$/mu, `enabled: ${enabled}`) : `${front[2]}\nenabled: ${enabled}`}${front[3]}${text.slice(front[0].length)}`
    : enabled ? text : `---\nenabled: false\n---\n${text}`;
  try { if (next !== text) await atomicWrite(path, next); }
  catch (error) { return answer("failed", said(error)); }
  return answer("updated");
};
