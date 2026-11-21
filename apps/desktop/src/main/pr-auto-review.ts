import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  PR_REVIEW_TOOLS_VERSION,
  modelKindSupportsGeneration,
  type PrConnection,
  type PrConnectionInput,
  type PrListQuery,
  type PrListResponse,
  type PrReviewHistoryEntry,
  type PrReviewRunToolRequest,
  type PrReviewRunToolResult,
  type PrReviewSettingsItem,
  type PrReviewSettingsQuery,
  type PrReviewSettingsResult,
  type PrReviewSettingsUpdate,
  type PrReviewSettingsUpdateResult,
  type RetrievalAnswerProvider,
} from "@cognelis/decision-protocol";

import { atomicWrite } from "./atomic-write.js";
import { resolveConnection } from "./pr-description-tools.js";
import type { PrHistoryStore } from "./pr-review-records.js";

/**
 * 自动预评审 (docs/review-collaboration-design.md「预评审与发布」): on a link where the user turned it on, what waits for
 * their review is reviewed as it comes, new or with new commits, so that it is ready when they open it. Off by default,
 * as it spends model calls; held to the link's reviews a day; never past a PR's third round (收敛), where talking it
 * over beats another review; nothing is posted to the PR.
 */
export const AUTO_REVIEW_ROUNDS = 3;

const usageSchema = z.object({ version: z.literal(1), days: z.record(z.string(), z.object({ day: z.string(), reviews: z.number().int().nonnegative() })) });
/** Each link's reviews started today, kept across restarts: a day's limit is not reset by quitting. */
export class PrAutoReviewUsage {
  #tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}
  async #read() {
    try { return usageSchema.parse(JSON.parse(await readFile(this.path, "utf8"))); }
    catch { return { version: 1 as const, days: {} as Record<string, { day: string; reviews: number }> }; }
  }
  async used(connectionId: string, day: string): Promise<number> {
    const kept = (await this.#read()).days[connectionId];
    return kept?.day === day ? kept.reviews : 0;
  }
  spend(connectionId: string, day: string): Promise<void> {
    const next = this.#tail.then(async () => {
      const usage = await this.#read();
      const kept = usage.days[connectionId];
      usage.days[connectionId] = { day, reviews: (kept?.day === day ? kept.reviews : 0) + 1 };
      await atomicWrite(this.path, JSON.stringify(usage));
    });
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

/** The App's local day, as the limit counts it. */
export const localDay = (now: number) => { const date = new Date(now); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };

export interface PrAutoReviewSources {
  connections(): Promise<PrConnection[]>;
  pullRequests(query: PrListQuery): Promise<PrListResponse>;
  /** The PR's head commit now. */
  head(connectionId: string, reference: string): Promise<string>;
  history: PrHistoryStore;
  /** A review is running (the page's, an agent's, or one started here). */
  running(): boolean;
  start(request: PrReviewRunToolRequest): Promise<PrReviewRunToolResult>;
  usage: PrAutoReviewUsage;
  now?(): number;
}

const reviewsOf = (entries: readonly PrReviewHistoryEntry[], connectionId: string, reference: string) =>
  entries.filter((entry) => entry.kind === "review" && entry.connectionId === connectionId && entry.snapshot.reference === reference);

/**
 * One pass: the links with 自动预评审 on, their PRs waiting for the user's review, newest first; the first that is new or
 * moved on since its last review, within the link's day and before its third round, is reviewed. One review runs at a
 * time, so one is started a pass at most; the rest wait for the next. Resolves to what was started, if anything.
 */
export const autoReviewPass = async (sources: PrAutoReviewSources): Promise<{ connectionId: string; reference: string; id: string } | null> => {
  if (sources.running()) return null;
  const day = localDay(sources.now?.() ?? Date.now());
  for (const connection of await sources.connections()) {
    const settings = connection.autoReview;
    if (!settings || await sources.usage.used(connection.id, day) >= settings.dailyReviews) continue;
    const listed = await sources.pullRequests({ connectionId: connection.id, filter: "review-requested", page: 1 }).catch(() => null);
    if (!listed) continue;
    const { entries } = await sources.history.list();
    for (const item of listed.items) {
      // Newest first. A round is a review that came back with a report; one that failed is not a round.
      const reviews = reviewsOf(entries, connection.id, item.reference);
      if (reviews.filter((entry) => entry.report).length >= AUTO_REVIEW_ROUNDS || reviews.some((entry) => entry.state === "running")) continue;
      // Not updated since its last review: not read again. Updated, its head says whether the commits moved.
      const last = reviews.find((entry) => entry.report);
      if (last && item.updatedAt && Date.parse(item.updatedAt) <= Date.parse(last.at)) continue;
      const head = await sources.head(connection.id, item.reference).catch(() => null);
      if (!head || last?.snapshot.sourceCommit === head) continue;
      // Tried here at this commit and failed: not again by itself, or a PR that cannot be reviewed spends the day.
      if (reviews.some((entry) => entry.auto && entry.state === "failed" && entry.snapshot.sourceCommit === head)) continue;
      const result = await sources.start({ prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, connection: connection.id, reference: item.reference, scope: "since_last_review", focus: "", model: settings.profileId });
      if (result.status === "started" && result.run) {
        await sources.usage.spend(connection.id, day);
        return { connectionId: connection.id, reference: item.reference, id: result.run.id };
      }
      // Busy (one started elsewhere meanwhile), or the model is gone: nothing more this pass for this link.
      if (result.status === "busy") return null;
      if (result.status === "model_not_found" || result.status === "no_model") break;
    }
  }
  return null;
};

export interface PrReviewSettingsSources {
  connections(): Promise<PrConnection[]>;
  save(input: PrConnectionInput): Promise<PrConnection[]>;
  models(): Promise<RetrievalAnswerProvider[]>;
  usage: PrAutoReviewUsage;
  now?(): number;
}

const label = (model: RetrievalAnswerProvider) => [model.label, model.model].filter(Boolean).join(" · ");
const usable = async (sources: Pick<PrReviewSettingsSources, "models">) => (await sources.models().catch(() => [])).filter((model) => modelKindSupportsGeneration(model.kind));
const itemOf = async (connection: PrConnection, models: readonly RetrievalAnswerProvider[], sources: Pick<PrReviewSettingsSources, "usage" | "now">): Promise<PrReviewSettingsItem> => {
  const model = connection.autoReview ? models.find((item) => item.profileId === connection.autoReview!.profileId) : undefined;
  return { connectionId: connection.id, label: connection.label, platform: connection.platform,
    autoReview: connection.autoReview ? { profileId: connection.autoReview.profileId, model: model ? label(model) : "已停用的模型", dailyReviews: connection.autoReview.dailyReviews } : null,
    usedToday: await sources.usage.used(connection.id, localDay(sources.now?.() ?? Date.now())) };
};

/** Each link's 自动预评审 (one link's, when named), with what it spent today. */
export const reviewSettingsFor = async (query: Omit<PrReviewSettingsQuery, "prReviewToolsVersion">, sources: PrReviewSettingsSources): Promise<PrReviewSettingsResult> => {
  const all = await sources.connections(), models = await usable(sources);
  const connections = all.map(({ id, label: name, platform }) => ({ id, label: name, platform }));
  const named = query.connection === undefined ? all : all.filter((item) => item.id === query.connection || item.label === query.connection);
  const base = { prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, connections, models: models.map((model) => ({ id: model.profileId, label: label(model) })) } as const;
  if (query.connection !== undefined && !named.length) return { ...base, status: "connection_not_found", settings: [] };
  return { ...base, status: "ok", settings: await Promise.all(named.map((connection) => itemOf(connection, models, sources))) };
};

/** 自动预评审 on (a model, a daily limit) or off for one link: the rest of its settings stay as they are. */
export const updateReviewSettings = async (request: PrReviewSettingsUpdate, sources: PrReviewSettingsSources): Promise<PrReviewSettingsUpdateResult> => {
  const models = await usable(sources);
  const { connection, connections, status } = await resolveConnection(sources, request.connection);
  const base = { prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, connections, models: models.map((model) => ({ id: model.profileId, label: label(model) })) } as const;
  if (!connection) return { ...base, status, reason: null, settings: null };
  const { autoReview: before, ...rest } = connection;
  let autoReview: PrConnection["autoReview"];
  if (request.autoReview) {
    const model = request.model === undefined
      ? models.find((item) => item.profileId === before?.profileId) ?? models[0]
      : models.find((item) => item.profileId === request.model || item.label === request.model || label(item) === request.model);
    if (!model) return { ...base, status: "model_not_found", reason: request.model === undefined ? "没有可用的模型：先在 Paraself 的模型设置里启用一个。" : null, settings: null };
    autoReview = { profileId: model.profileId, dailyReviews: request.dailyReviews ?? before?.dailyReviews ?? 5 };
  }
  try {
    const saved = (await sources.save({ ...rest, ...(autoReview ? { autoReview } : {}) })).find((item) => item.id === connection.id) ?? { ...rest, ...(autoReview ? { autoReview } : {}) };
    return { ...base, status: "updated", reason: null, settings: await itemOf(saved, models, sources) };
  } catch (error) {
    return { ...base, status: "failed", reason: (error instanceof Error ? error.message : String(error)).slice(0, 1_000), settings: null };
  }
};
