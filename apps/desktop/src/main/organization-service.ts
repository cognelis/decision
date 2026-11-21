import {
  DECISION_AMENDMENT_VERSION,
  modelKindSupportsGeneration,
  ORGANIZATION_VERSION,
  parseTodoItemSourceKey,
  SUGGESTION_TAB,
  type DecisionAmendmentRequest,
  type DecisionAmendmentResult,
  type DecisionRelationUpdate,
  type DecisionRelationUpdateResult,
  type ModelProviderProfile,
  type OrganizationForget,
  type OrganizationForgetPreview,
  type OrganizationForgetResult,
  type OrganizationQuery,
  type OrganizationRunControl,
  type OrganizationRunRequest,
  type OrganizationRunResult,
  type OrganizationRunView,
  type OrganizationSettings,
  type OrganizationSnapshot,
  type SuggestionContent,
  type SuggestionDecision,
  type SuggestionDecisionResult,
  type SuggestionDraftSave,
  type SuggestionRegenerate,
  type SuggestionsAdopt,
  type SuggestionsAdoptResult,
  type SuggestionSourceView,
  type SuggestionType,
  type SuggestionUndo,
  type SuggestionUndoResult,
  type SuggestionView,
  type TodoAnnotations,
  type TodoAnnotationsQuery,
  type TodoItemUpdateResult,
  type TodoItemChange,
} from "@cognelis/decision-protocol";
import type { TodoItemRecord, TodoListRecord } from "@cognelis/decision-core";
import type { ExperienceRecord, ExperienceRepository } from "@cognelis/decision-storage";
import { canonical } from "@cognelis/decision-storage";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { maintenanceDrafts, maintenanceOutputSchema, maintenanceSystemPrompt } from "./organization-maintenance.js";
import { organizationSourceAccess, suggestionInputKeys, suggestionDirectInputKeys } from "./organization-authorization.js";
import { terms } from "./decision-context-service.js";
import {
  allowance,
  charge,
  DEFAULT_BUDGET,
  emptyLedger,
  hashOf,
  independentEvidence,
  inputFingerprint,
  isVagueNote,
  ON_DEVICE_BACKGROUND_PROMPT_CHARS,
  recheckOf,
  reopenReason,
  sha256,
  suggestionId,
  type BudgetLedger,
  type OrganizationBudget,
} from "./organization-core.js";
import {
  conflictOutputSchema,
  conflictSystemPrompt,
  experienceOutputSchema,
  experiencePrompt,
  experienceSystemPrompt,
  ORGANIZATION_PROMPT_VERSION,
  ORGANIZATION_SCHEMA_VERSION,
  recordsPrompt,
  todoGroupOutputSchema,
  todoGroupPrompt,
  todoGroupSystemPrompt,
} from "./organization-prompt.js";
import { basisOf, inProject, readSources, type RelationSnapshot, type SourceReaders, type SourceSnapshot, type SourceUnit } from "./organization-sources.js";
import {
  OrganizationDamagedError,
  modelInputKeys,
  modelDirectInputKeys,
  type ApplyPlan,
  type ApplyStep,
  type OrganizationState,
  type OrganizationStore,
  type StoredSource,
  type StoredSuggestion,
} from "./organization-store.js";

/**
 * 整理与记忆（IMP-191）：手动或空闲时的增量整理、建议的承接与去重、采纳 / 稍后 / 不采纳 / 撤销、遗忘。
 * 写入一律经现有领域服务（待办、修订、关系）与经验笔记；建议、游标、回执只在本机。
 */

export interface OrganizationGateway {
  generate<T>(request: {
    requestId: string; purpose: "memory-organization"; locale: string; promptVersion: string; schemaVersion: string;
    systemPrompt: string; userPrompt: string; outputSchema: Record<string, unknown>; maxOutputTokens: number;
  }, parse: (value: unknown) => T, signal: AbortSignal, profileId: string): Promise<{ parsedOutput: T; model: string; requestId: string; usage: { inputTokens?: number | undefined; outputTokens?: number | undefined } }>;
  listGenerationProfiles(): Promise<ModelProviderProfile[]>;
}

export interface OrganizationServiceOptions {
  store: OrganizationStore;
  readers: SourceReaders;
  gateway: OrganizationGateway;
  /** Nearness in meaning of items to a query (the local embedding); recall only, never a judgment. */
  similar?: (query: string, items: ReadonlyArray<{ id: string; text: string }>, options: { floor: number; nearest: number }) => Promise<
    { near: Array<{ id: string; similarity: number }>; pending: number } | { unavailable: string }
  >;
  todos: { changeItemWhere(input: TodoItemChange, precondition: (item: TodoItemRecord, list: TodoListRecord) => boolean): Promise<TodoItemUpdateResult> };
  amendments: { update(input: DecisionAmendmentRequest): Promise<DecisionAmendmentResult> };
  relations: { update(input: DecisionRelationUpdate): Promise<DecisionRelationUpdateResult> };
  experiences: Pick<ExperienceRepository, "create" | "reviseProperties" | "previewProperties" | "trash" | "scan" | "find">;
  trash(path: string): Promise<void>;
  traces: { deleteRequest(requestIds: readonly string[]): Promise<number> };
  forgetVectors?(ids: readonly string[]): void;
  /** Seconds the system has been idle (Electron's powerMonitor). */
  systemIdleSeconds?(): number;
  clock?: () => Date;
  monotonic?: () => number;
  budget?: Partial<OrganizationBudget>;
  /** The background scheduler's bounds (defaults BACKGROUND); a lab run on synthetic data shortens them. */
  background?: Partial<typeof BACKGROUND>;
  /** Characters one call's prompt may hold (default PROMPT_CHARS); a background call on this machine's model holds less. */
  promptChars?: number;
  onChanged?(): void;
  /** How many reviewed decisions the methodology flow offers as principle candidates: only said, never generated here. */
  methodologyCandidates?(): Promise<number>;
}

const OUTPUT_MAX = { experience: 900, todo: 1_200, conflict: 900 } as const;
const PROMPT_CHARS = 8_000;
const HANDLED_DAYS = 30;
const BACKGROUND = { idleSeconds: 120, quietMs: 60_000, spacingMs: 30 * 60_000, tickMs: 60_000 };

type Job =
  | { kind: "experience"; groupKey: string; seed: SourceUnit; related: SourceUnit[]; members: SourceUnit[] }
  | { kind: "todo"; groupKey: string; members: SourceUnit[]; records: SourceUnit[] }
  | { kind: "conflict" | "knowledge"; groupKey: string; members: SourceUnit[] };
const jobInputs = (job: Job): SourceUnit[] => job.kind === "todo" ? [...job.members, ...job.records] : job.kind === "experience" ? [job.seed, ...job.related] : job.members;

export interface SuggestionDraftInput {
  type: SuggestionType;
  project: string | null;
  anchor: string[];
  sources: SourceUnit[];
  counter: SourceUnit[];
  content: SuggestionContent;
  title: string;
  why: string;
  effect: string;
  unchanged: string;
  model: StoredSuggestion["model"];
}

const storedSourceOf = (unit: SourceUnit): StoredSource => {
  const excerpt = basisOf(unit);
  return {
    key: unit.key, kind: unit.kind, role: unit.role, label: unit.label.slice(0, 500), rootKeys: unit.rootKeys.slice(0, 20), lineage: unit.lineage,
    fingerprint: unit.fingerprint, evidenceFingerprint: unit.evidenceFingerprint,
    basis: excerpt === "" ? null : { excerpt, excerptHash: sha256(excerpt) },
    project: unit.project, relativePath: unit.relativePath, at: unit.at,
  };
};

const itemHash = (item: TodoItemRecord): string => hashOf(item);
const today = (now: Date): string => {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
};
const dueReached = (deferUntil: string | null, now: Date): boolean =>
  deferUntil !== null && (deferUntil.length === 10 ? deferUntil <= today(now) : Date.parse(deferUntil) <= now.getTime());
/** 「暂不判断」：没有日期的稍后，和不采纳一样等新材料。 */
const held = (suggestion: StoredSuggestion): boolean => suggestion.state === "deferred" && suggestion.deferUntil === null;
// Legacy receipts have no evidence identity; keep their conservative time check.
const legacyForgottenSince = (state: OrganizationState, key: string, since: string): boolean =>
  state.ledger.forgottenEvidence[key] === undefined && (state.ledger.forgotten[key] ?? "") >= since;

const usageOf = (ledger: BudgetLedger) => ({ ...ledger });

/** A target's version as an undo checked it: what its restoring write is made against, nothing read after. */
/** The one property change an archive step makes. */
const archived = (record: ExperienceRecord): Pick<ExperienceRecord, "status" | "sources"> => ({ status: "archived", sources: record.sources });

/** What a revision card says it does, written by the App. */
const revisionWords = (revises: StoredSuggestion, type: StoredSuggestion["type"]): { effect: string; unchanged: string } => {
  const title = revises.title.slice(0, 200);
  return type === "experience"
    ? { effect: `更新后：启用新版记忆，旧版「${title}」改为已归档。`, unchanged: "旧版正文保留；外部改动会阻止覆盖，回退新版会恢复旧版。" }
    : { effect: `更新后：待办页的分组「${title}」换成这条的成员。`, unchanged: "事项本身不改；回退修订会恢复原来的分组。" };
};

/** The card a revision card revises (`<id>~r<version>`), or null for a card of its own. */
const revisedId = (id: string): string | null => {
  const at = id.lastIndexOf("~r");
  return at < 0 ? null : id.slice(0, at);
};

type Verified =
  | { kind: "todo"; itemHash: string; detail: string | null; status: TodoItemRecord["status"] }
  | { kind: "note"; noteHash: string }
  | { kind: "amendment"; contentHash: string; revision: number; source: "decisions" | "summarize" | "preferences" | "ideas" }
  | { kind: "relation"; revision: number; firstHash: string | null; secondHash: string | null };

const failureCode = (error: unknown): string =>
  typeof error === "object" && error !== null && "code" in error && typeof (error as { code: unknown }).code === "string" ? (error as { code: string }).code : "failed";

export class OrganizationService {
  readonly #options: OrganizationServiceOptions;
  readonly #clock: () => Date;
  readonly #monotonic: () => number;
  readonly #budget: OrganizationBudget;
  readonly #background: typeof BACKGROUND;
  #controller: AbortController | null = null;
  #lastForeground = -Infinity;
  #backgroundStamp: string | null | undefined;
  #backgroundAfter = 0;
  #attentionRevision = 0;
  #deferred: Array<{ until: string; due: boolean }> = [];
  #foregroundRevision = 0;
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<void> | null = null;
  #runningTrigger: OrganizationRunView["trigger"] | null = null;
  #checkingBackground = false;
  #closed = false;
  #failedRun: OrganizationRunView | null = null;
  /** What each run of this session was asked, so 继续 takes up the same scope with the same model. */
  readonly #requests = new Map<string, { request: OrganizationRunRequest; only?: readonly string[] }>();
  /** Adoptions under way, and a forget under way: each waits for the other, so neither acts on what the other changes. */
  readonly #adoptions = new Set<Promise<unknown>>();
  readonly #mutations = new Set<Promise<unknown>>();
  readonly #inFlightCalls = new Set<string>();
  #forgetting: Promise<unknown> | null = null;

  constructor(options: OrganizationServiceOptions) {
    this.#options = options;
    this.#clock = options.clock ?? (() => new Date());
    this.#monotonic = options.monotonic ?? (() => performance.now());
    this.#budget = { ...DEFAULT_BUDGET, ...options.budget };
    this.#background = { ...BACKGROUND, ...options.background };
  }

  // ------------------------------------------------------------------ reading

  async snapshot(input: OrganizationQuery): Promise<OrganizationSnapshot> {
    let state: OrganizationState;
    try {
      state = await this.#options.store.read();
    } catch (error) {
      if (!(error instanceof OrganizationDamagedError)) throw error;
      return this.#damagedSnapshot(error.message);
    }
    const sources = await readSources(this.#options.readers, this.#clock());
    state = await this.#reconcile(state, sources);
    const now = this.#clock();
    const inScope = (suggestion: StoredSuggestion) => this.#suggestionInScope(suggestion, input, sources);
    const shownState = (suggestion: StoredSuggestion) =>
      suggestion.state === "pending" || suggestion.state === "applying" || suggestion.state === "partially_applied" ||
      (suggestion.state === "deferred" && dueReached(suggestion.deferUntil, now)) ||
      (suggestion.state === "applied" && (suggestion.automatic === true || suggestion.type === "experience")) ||
      (suggestion.state === "applied" && suggestion.appliedAt !== null && now.getTime() - Date.parse(suggestion.appliedAt) < HANDLED_DAYS * 86_400_000);
    const all = Object.values(state.suggestions).filter(inScope);
    const lifecycle = organizationSourceAccess(state, sources);
    const views = all.filter(shownState).map((suggestion) => this.#view(suggestion, sources, now, lifecycle));
    const pending = views.filter((view) => (view.state === "pending" || view.state === "partially_applied") && (state.settings.automatic !== true || (view.type === "judgment" && view.stale === null)));
    const count = (tab: SuggestionView["tab"]) => pending.filter((view) => view.tab === tab).length;
    const handled = all
      .filter((suggestion) => ["deferred", "rejected", "applied", "undone"].includes(suggestion.state) && !(suggestion.state === "deferred" && dueReached(suggestion.deferUntil, now)))
      .filter((suggestion) => now.getTime() - Date.parse(suggestion.updatedAt) < HANDLED_DAYS * 86_400_000 || suggestion.state === "deferred")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 500)
      .map((suggestion) => ({
        id: suggestion.id, type: suggestion.type, tab: SUGGESTION_TAB[suggestion.type], title: suggestion.title, state: suggestion.state,
        at: suggestion.updatedAt, deferUntil: suggestion.deferUntil, reopenReason: suggestion.reopenReason, revision: suggestion.revision, evidenceVersion: suggestion.evidence.version,
      }));
    const week = now.getTime() - 7 * 86_400_000;
    const recent = [...state.runs, ...(this.#failedRun !== null && !state.runs.some((run) => run.runId === this.#failedRun!.runId) ? [this.#failedRun] : [])].filter((run) => Date.parse(run.startedAt) >= week);
    const usage7d = recent.reduce((sum, run) => ({
      runs: sum.runs + 1, calls: sum.calls + run.usage.calls, failedCalls: sum.failedCalls + run.usage.failedCalls, retries: sum.retries + run.usage.retries,
      reportedInputTokens: sum.reportedInputTokens + run.usage.reportedInputTokens, reportedOutputTokens: sum.reportedOutputTokens + run.usage.reportedOutputTokens,
      estimatedInputTokens: sum.estimatedInputTokens + run.usage.estimatedInputTokens, estimatedOutputTokens: sum.estimatedOutputTokens + run.usage.estimatedOutputTokens,
    }), { runs: 0, ...emptyLedger() });
    return {
      organizationVersion: ORGANIZATION_VERSION,
      revision: state.revision,
      damaged: null,
      counts: { todo: count("todo"), memory: count("memory"), conflict: count("conflict"), pending: pending.length },
      suggestions: views.sort((a, b) => Number(b.type === "judgment" && b.state === "pending" && b.stale === null) - Number(a.type === "judgment" && a.state === "pending" && a.stale === null) || b.updatedAt.localeCompare(a.updatedAt)).slice(0, 500),
      handled,
      run: this.#failedRun ?? state.runs.at(-1) ?? null,
      activeRun: state.activeRun?.runId === this.#failedRun?.runId ? null : state.activeRun,
      settings: state.settings,
      projects: [...new Set([...sources.units.values()].flatMap((unit) => unit.project === null ? [] : [unit.project]))].sort().slice(0, 1000),
      maintenance: {
        inputs: [...sources.units.values()].filter((unit) => unit.inactive !== true && (input.scope === "all" || inProject(unit, input.project)) && (input.source === undefined || input.source === unit.kind)).length,
        automaticUpdates: views.filter((view) => view.automatic && view.state === "applied" && view.type !== "triage").length,
        unknown: views.filter((view) => view.content?.type === "triage" && view.content.disposition === "unknown").length,
        waiting: views.filter((view) => view.content?.type === "triage" && view.content.disposition === "waiting").length,
      },
      usage7d,
      coverage: { complete: sources.incomplete.size === 0 && sources.degraded.size === 0, unreadable: sources.unreadable },
      methodologyHint: await (this.#options.methodologyCandidates?.() ?? Promise.resolve(0)).then((count) => count > 0 ? { reviewedDecisions: count } : null, () => null),
    };
  }

  /** What the entry's badge counts, without the views: all scopes. */
  async attention(): Promise<{ pending: number; automatic: boolean }> {
    const revision = ++this.#attentionRevision;
    const state = await this.#options.store.read();
    const now = this.#clock();
    const suggestions = Object.values(state.suggestions);
    if (!this.#closed && revision === this.#attentionRevision) this.#deferred = suggestions.flatMap(entry => entry.state === "deferred" && entry.deferUntil !== null ? [{ until: entry.deferUntil, due: dueReached(entry.deferUntil, now) }] : []);
    const sources = state.settings.automatic === true && suggestions.some((entry) => entry.type === "judgment" && (entry.state === "pending" || (entry.state === "deferred" && dueReached(entry.deferUntil, now)))) ? await readSources(this.#options.readers, now) : null;
    const lifecycle = sources === null ? undefined : organizationSourceAccess(state, sources);
    const pending = suggestions.filter((suggestion) =>
      (state.settings.automatic !== true || (suggestion.type === "judgment" && (sources === null || this.#staleOf(suggestion, sources, lifecycle) === null))) && (suggestion.state === "pending" || suggestion.state === "partially_applied" || (suggestion.state === "deferred" && dueReached(suggestion.deferUntil, now)))).length;
    return { pending, automatic: state.settings.automatic === true };
  }

  async pendingCount(): Promise<number> { return this.attention().then(value => value.pending, () => 0); }

  /** 来源临时不可读或已变更时，暂停派生记忆召回；原笔记与旧版本仍保留。 */
  async searchableExperiences() {
    const scan = await this.#options.experiences.scan();
    const sources = await readSources(this.#options.readers, this.#clock());
    const state = await this.#options.store.read();
    const initial = new Map(scan.experiences.map(({ record, noteHash }) => [`experience:${record.id}`, noteHash]));
    const changed = new Set([...initial].filter(([key, hash]) => sources.units.get(key)?.fingerprint !== hash).map(([key]) => key));
    for (const unit of sources.units.values()) if (unit.kind === "experience" && !initial.has(unit.key)) changed.add(unit.key);
    const access = organizationSourceAccess(state, sources, changed);
    const diagnostics = [...scan.diagnostics, ...scan.experiences.filter(({ record }) => record.status !== "pending" && access.status(`experience:${record.id}`) === "unreadable").map(({ path }) => ({ path, message: "记忆的来源暂时未能完整读取，已暂停召回。" }))];
    const changedPath = scan.experiences.find(({ record }) => changed.has(`experience:${record.id}`))?.path ?? [...sources.units.values()].find((unit) => unit.kind === "experience" && changed.has(unit.key))?.relativePath;
    if (changedPath != null) diagnostics.push({ path: changedPath, message: "记忆在读取期间发生变化，本次结果不完整，请重查。" });
    return { ...scan, diagnostics, experiences: scan.experiences.filter(({ record, noteHash }) => {
      const id = record.adoptedFrom?.split("@r")[0];
      const suggestion = id === undefined ? undefined : state.suggestions[id];
      return sources.units.get(`experience:${record.id}`)?.fingerprint === noteHash && access.allows([`experience:${record.id}`]) && access.current(record.status === "archived" ? (record.userChoice ? [] : record.directInputKeys ?? record.inputKeys ?? record.sources.map((source) => source.key)) : [`experience:${record.id}`]) && (suggestion === undefined || (!suggestion.redacted && suggestion.state === "applied" && (record.userChoice || suggestion.type === "judgment" || this.#staleOf(suggestion, sources, access) === null)));
    }) };
  }

  async #applyRoutine(runId: string, signal: AbortSignal, startedAt: number, attempted: Set<string>, sources: SourceSnapshot): Promise<void> {
    const state = await this.#options.store.read();
    if (state.settings.automatic !== true || state.activeRun?.runId !== runId) return;
    const access = organizationSourceAccess(state, sources);
    const allowed = access.usable;
    for (const suggestion of Object.values(state.suggestions)) {
      if (signal.aborted || this.#forgetting !== null || attempted.size >= this.#budget.changes || this.#monotonic() - startedAt >= this.#budget.ms) return;
      if (attempted.has(suggestion.id) || !suggestion.automatic || !["pending", "partially_applied"].includes(suggestion.state) || suggestion.draft !== null || !allowed(access.suggestionInputs(suggestion))) continue;
      attempted.add(suggestion.id);
      await this.#adopt({ id: suggestion.id, expectedRevision: suggestion.revision, expectedEvidenceVersion: suggestion.evidence.version, action: "adopt" }, signal);
    }
  }

  async annotations(input: TodoAnnotationsQuery): Promise<TodoAnnotations> {
    const sources = await readSources(this.#options.readers, this.#clock());
    const state = await this.#options.store.read();
    const access = organizationSourceAccess(state, sources);
    const allowed = access.usable;
    const lists = new Set(input.listIds);
    const ofList = (key: string) => {
      const parsed = parseTodoItemSourceKey(key);
      return parsed !== null && lists.has(parsed.listId);
    };
    // Never a cleared card's text, whatever the last look left.
    const cleared = (suggestionId: string) => {
      const suggestion = state.suggestions[suggestionId];
      return suggestion === undefined || suggestion.redacted || !allowed(access.suggestionInputs(suggestion)) || this.#staleOf(suggestion, sources, access) !== null;
    };
    return {
      groups: Object.entries(state.annotations.groups)
        // A group a revision of it took over (adopted) is shown as that one only.
        .filter(([id, group]) => group.members.some(ofList) && !cleared(id) && !Object.keys(state.annotations.groups).some((other) => (state.suggestions[other]?.revises ?? revisedId(other)) === id))
        .map(([suggestionId, group]) => ({ suggestionId, revision: group.revision, title: group.title, members: group.members })),
      beforeStart: Object.fromEntries(Object.entries(state.annotations.beforeStart).filter(([key]) => ofList(key))
        .map(([key, links]) => [key, links.filter((entry) => !cleared(entry.suggestionId)).map((entry) => ({ ...entry.link, suggestionId: entry.suggestionId, revision: entry.revision }))] as const)
        .filter(([, links]) => links.length > 0)),
    };
  }

  // ------------------------------------------------------------------ settings

  async setSettings(input: OrganizationSettings): Promise<OrganizationSettings> {
    return this.#mutation(() => this.#setSettings(input));
  }

  async #setSettings(input: OrganizationSettings): Promise<OrganizationSettings> {
    if (input.background && input.backgroundProfileId !== null) await this.#profile(input.backgroundProfileId);
    return this.#options.store.update((state) => {
      const enable = input.automatic === true && state.settings.automatic !== true;
      state.settings = { ...input };
      if (enable) {
        state.ledger.seen = {}; state.ledger.processed = {};
        for (const suggestion of Object.values(state.suggestions)) if (suggestion.state === "pending" && suggestion.draft === null && !suggestion.redacted && ["todo_group", "todo_context", "experience", "triage"].includes(suggestion.type)) suggestion.automatic = true;
      }
      this.#controller?.abort("pause");
      return { state, value: state.settings };
    }).finally(() => this.#changed());
  }

  // ------------------------------------------------------------------ running

  async run(input: OrganizationRunRequest, trigger: OrganizationRunView["trigger"] = "manual", only?: readonly string[]): Promise<OrganizationRunResult> {
    if (this.#closed) return { status: "busy", run: null };
    const foreground = this.#foregroundRevision;
    const initiallyIdle = trigger === "background" && (this.#options.systemIdleSeconds?.() ?? 0) >= this.#background.idleSeconds;
    const backgroundInterrupted = () => trigger === "background" && (foreground !== this.#foregroundRevision || (initiallyIdle && (this.#options.systemIdleSeconds?.() ?? 0) < this.#background.idleSeconds));
    const initiatedAt = this.#clock().toISOString();
    let state: OrganizationState;
    try {
      state = await this.#options.store.read();
    } catch (error) {
      if (error instanceof OrganizationDamagedError) return { status: "damaged", run: null };
      throw error;
    }
    if (this.#closed || this.#running !== null) return { status: "busy", run: this.#closed ? null : state.activeRun };
    let profile: ModelProviderProfile;
    try {
      profile = await this.#profile(input.profileId);
    } catch {
      return { status: "model_unavailable", run: null };
    }
    if (this.#closed) return { status: "busy", run: null };
    const sources = await readSources(this.#options.readers, this.#clock());
    if (this.#closed) return { status: "busy", run: null };
    const scope = this.#resolveScope(input, sources);
    const access = organizationSourceAccess(state, sources);
    const allowed = access.usable;
    if (scope !== null) for (const key of scope.keys) if (!allowed([key])) scope.keys.delete(key);
    if (scope === null) return { status: "out_of_scope", run: null };
    for (const key of scope.keys) if (state.ledger.forgottenEvidence[key] === sources.units.get(key)?.evidenceFingerprint) scope.keys.delete(key);
    const now = this.#clock();
    const run: OrganizationRunView = {
      runId: `run-${randomUUID()}`, trigger, scope: input.scope, project: input.project, startedAt: initiatedAt, endedAt: null,
      state: "running", stage: "读取变化", progress: { checked: 0, total: 0, groupsDone: 0, groupsTotal: 0 }, created: 0, updated: 0,
      partialReason: null, failure: null, usage: emptyLedger(), model: profile.model ?? profile.kind,
    };
    // The changes found, queued and written before anything else: a stop, a failure or a quit from here on loses none.
    const queued = await this.#options.store.update((current) => {
      if (this.#closed || this.#running !== null || backgroundInterrupted() || (trigger === "background" && (!current.settings.background || current.settings.backgroundProfileId !== input.profileId))) return { state: null, value: null };
      const next = this.#enqueueChanges(current, sources, scope.keys, only);
      if (this.#failedRun !== null && !next.runs.some((item) => item.runId === this.#failedRun!.runId)) next.runs = [...next.runs, this.#failedRun].slice(-300);
      next.activeRun = run;
      if (trigger === "background") next.lastBackgroundAt = now.toISOString();
      return { state: next, value: new Set(next.runs.map(item => item.runId)) };
    });
    if (this.#closed) return { status: "busy", run: null };
    if (queued === null) return { status: "busy", run: (await this.#options.store.read()).activeRun };
    if (trigger === "background") {
      this.#backgroundStamp = now.toISOString();
      this.#backgroundAfter = this.#monotonic() + this.#background.spacingMs;
    }
    this.#failedRun = null;
    for (const id of this.#requests.keys()) if (!queued.has(id)) this.#requests.delete(id);
    this.#requests.set(run.runId, { request: input, ...(only === undefined ? {} : { only }) });
    const controller = new AbortController();
    this.#controller = controller;
    this.#runningTrigger = trigger;
    if (backgroundInterrupted()) controller.abort("foreground");
    this.#running = this.#process(run, profile, sources, scope.keys, controller.signal, only)
      .catch((error: unknown) => this.#failRun(run, error))
      .finally(() => {
        if (this.#controller === controller) { this.#controller = null; this.#running = null; this.#runningTrigger = null; }
      });
    this.#changed();
    return { status: "started", run };
  }

  async control(input: OrganizationRunControl): Promise<OrganizationRunView> {
    const state = await this.#options.store.read();
    if (this.#failedRun?.runId === input.runId) return this.#failedRun;
    const active = state.activeRun;
    if (active === null || active.runId !== input.runId) {
      const last = state.runs.find((run) => run.runId === input.runId);
      if (last === undefined) throw new Error("这一轮整理已经结束或不存在。");
      if (input.action !== "resume" || (last.state !== "paused" && last.state !== "partial")) return last;
      // 继续：同一范围、同一模型再整理一次，从队列接着做（游标与队列都还在）。
      const asked = this.#requests.get(input.runId);
      if (asked === undefined) return last;
      const result = await this.run(asked.request, last.trigger, asked.only);
      return result.run ?? last;
    }
    if (input.action === "resume") return active;
    this.#controller?.abort(input.action === "pause" ? "pause" : "stop");
    await this.#running;
    const after = await this.#options.store.read();
    return after.runs.find((run) => run.runId === input.runId) ?? active;
  }

  async regenerate(input: SuggestionRegenerate): Promise<OrganizationRunResult> {
    return this.#mutation(() => this.#regenerate(input));
  }

  async #regenerate(input: SuggestionRegenerate): Promise<OrganizationRunResult> {
    const state = await this.#options.store.read();
    const suggestion = state.suggestions[input.id];
    if (suggestion === undefined) return { status: "nothing_to_do", run: null };
    const keys = [...new Set([...suggestion.anchor, ...suggestion.evidence.sources.map((source) => source.key)])];
    const todoAnchor = suggestion.anchor.map(parseTodoItemSourceKey).find((parsed) => parsed !== null);
    const request: OrganizationRunRequest | null = suggestion.project !== null
      ? { scope: "project", project: suggestion.project, profileId: input.profileId }
      : todoAnchor !== undefined && todoAnchor !== null
        ? { scope: "selection", project: null, listId: todoAnchor.listId, items: suggestion.anchor.filter((key) => parseTodoItemSourceKey(key)?.listId === todoAnchor.listId), profileId: input.profileId }
        : { scope: "all", project: null, profileId: input.profileId };
    if (request === null) return { status: "nothing_to_do", run: null };
    // The group's processed mark is cleared so its inputs, changed or not, are read and judged again.
    await this.#options.store.update((current) => {
      for (const groupKey of Object.keys(current.ledger.processed)) if (keys.some((key) => groupKey.includes(sha256(key).slice(0, 16)))) delete current.ledger.processed[groupKey];
      const at = this.#clock().toISOString();
      for (const key of keys) if (!current.ledger.queue.some((entry) => entry.key === key)) current.ledger.queue.push({ key, reason: "changed", at });
      return { state: current, value: null };
    });
    return this.run(request, "regenerate", keys);
  }

  /** Waits for the run under way, if any (tests, the app's quit). */
  async settled(): Promise<void> {
    await this.#running;
  }

  /** Something in the foreground (a search, a capture, the reader on a page): a background run gives way at once. */
  noteForeground(): void {
    if (this.#closed) return;
    this.#lastForeground = this.#monotonic();
    this.#foregroundRevision += 1;
    if (this.#runningTrigger === "background") this.#controller?.abort("foreground");
  }

  /** The background scheduler: off unless the reader turned it on with a model; runs only while the system idles. */
  start(): void {
    if (this.#timer !== null || this.#closed) return;
    this.#timer = setInterval(() => { this.checkClock(); void this.checkBackground().catch(() => undefined); }, this.#background.tickMs);
    this.#timer.unref?.();
  }

  /** Check calendar deadlines without loading the ledger on every scheduler tick. */
  checkClock(): void {
    if (this.#closed) return;
    const now = this.#clock();
    let changed = false;
    for (const entry of this.#deferred) {
      const due = dueReached(entry.until, now);
      if (due !== entry.due) { entry.due = due; changed = true; }
    }
    if (changed) this.#changed();
  }

  resume(): void {
    this.#backgroundStamp = undefined;
    this.checkClock();
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#controller?.abort("stop");
    await this.#running?.catch(() => undefined);
    await this.finishWrites();
  }

  async finishWrites(): Promise<void> {
    await Promise.allSettled([this.#forgetting, ...this.#mutations, ...this.#adoptions]);
    await this.#options.store.idle();
  }

  /** At start: a run the last quit cut short is said interrupted; an adoption half done is finished or said partial. */
  async recover(): Promise<void> {
    if (this.#closed) return;
    return this.#mutation(() => this.#recover());
  }

  async #recover(): Promise<void> {
    await this.#options.store.update((state) => {
      if (state.activeRun === null) return { state: null, value: null };
      state.runs = [...state.runs, { ...state.activeRun, state: "interrupted" as const, endedAt: this.#clock().toISOString(), stage: null }].slice(-300);
      state.activeRun = null;
      return { state, value: null };
    }).catch(async (error: unknown) => {
      const state = await this.#options.store.read().catch(() => null);
      if (state?.activeRun !== null && state?.activeRun !== undefined) await this.#failRun(state.activeRun, error);
    });
    const state = await this.#options.store.read().catch(() => null);
    if (state === null || this.#closed) return;
    if ((state.ledger.pendingTraceDeletes?.length ?? 0) > 0) await this.#clearForgottenCalls().catch(() => undefined);
    for (const suggestion of Object.values(state.suggestions)) {
      if (this.#closed) break;
      if (suggestion.state === "applying" && suggestion.apply !== null) await this.#tracked(this.#resumeApply(suggestion.id)).catch(() => undefined);
    }
  }

  /** One look of the background scheduler: runs a project's changes when on, idle, quiet and due. */
  async checkBackground(): Promise<void> {
    if (this.#closed || this.#running !== null || this.#checkingBackground) return;
    if ((this.#options.systemIdleSeconds?.() ?? 0) < this.#background.idleSeconds || this.#monotonic() - this.#lastForeground < this.#background.quietMs) return;
    this.#checkingBackground = true;
    try { await this.#checkBackground(); } finally { this.#checkingBackground = false; }
  }

  async #checkBackground(): Promise<void> {
    const state = await this.#options.store.read();
    if (this.#closed || this.#running !== null) return;
    const { background, backgroundProfileId } = state.settings;
    if (!background || backgroundProfileId === null) return;
    if ((this.#options.systemIdleSeconds?.() ?? 0) < this.#background.idleSeconds) return;
    if (this.#monotonic() - this.#lastForeground < this.#background.quietMs) return;
    if (this.#backgroundStamp !== state.lastBackgroundAt) {
      this.#backgroundStamp = state.lastBackgroundAt;
      // A persisted wall-clock timestamp converts once to a bounded elapsed-time wait.
      const remaining = state.lastBackgroundAt === null ? 0 : Math.min(this.#background.spacingMs, Math.max(0, this.#background.spacingMs - (this.#clock().getTime() - Date.parse(state.lastBackgroundAt))));
      this.#backgroundAfter = this.#monotonic() + remaining;
    }
    if (this.#monotonic() < this.#backgroundAfter) return;
    const sources = await readSources(this.#options.readers, this.#clock());
    if (this.#closed || this.#running !== null) return;
    if ((this.#options.systemIdleSeconds?.() ?? 0) < this.#background.idleSeconds || this.#monotonic() - this.#lastForeground < this.#background.quietMs) return;
    // The project whose changes waited longest; one project a run.
    // What changed since it was last read, found here: the first time on, nothing is queued yet and every record is new.
    const queued = new Set(state.ledger.queue.map((entry) => entry.key));
    const pending = [...sources.units.values()].filter((unit) => {
      if (unit.inactive === true || unit.todo?.archived === true || state.ledger.forgottenEvidence[unit.key] === unit.evidenceFingerprint) return false;
      const seen = state.ledger.seen[unit.key];
      return seen === undefined || seen.fingerprint !== unit.fingerprint || queued.has(unit.key);
    });
    const mayRetry = (entry: StoredSuggestion) => entry.automatic && entry.draft === null && (entry.state === "pending" || entry.state === "partially_applied");
    if (!pending.some(unit => unit.selfGenerated !== true) && !Object.values(state.suggestions).some(mayRetry)) return;
    const access = organizationSourceAccess(state, sources);
    const allowed = access.usable;
    const first = pending.find((unit) => unit.selfGenerated !== true && allowed([unit.key]));
    const retry = Object.values(state.suggestions).some((entry) => mayRetry(entry) && allowed(access.suggestionInputs(entry)));
    if (first === undefined && !retry) return;
    const project = first?.project ?? null;
    await this.run({ scope: project === null ? "all" : "project", project, profileId: backgroundProfileId }, "background");
  }

  async #profile(profileId: string): Promise<ModelProviderProfile> {
    const profiles = await this.#options.gateway.listGenerationProfiles();
    const profile = profiles.find((candidate) => candidate.profileId === profileId);
    if (profile === undefined || !modelKindSupportsGeneration(profile.kind)) throw new Error("所选模型不可用于整理");
    return profile;
  }

  #resolveScope(input: OrganizationRunRequest | OrganizationQuery, sources: SourceSnapshot): { keys: Set<string> } | null {
    // Withdrawn, archived, pending: no input to a new suggestion.
    const units = [...sources.units.values()].filter((unit) => unit.inactive !== true && unit.metadataUnreadable !== true && !sources.degraded.has(unit.kind));
    const project = input.project;
    if (input.scope === "all") return { keys: new Set(units.filter((unit) => unit.todo?.archived !== true).map((unit) => unit.key)) };
    if (input.scope === "project") {
      if (project === null) return null;
      return { keys: new Set(units.filter((unit) => inProject(unit, project) && unit.todo?.archived !== true).map((unit) => unit.key)) };
    }
    const listItems = units.filter((unit) => unit.todo?.listId === input.listId);
    if (input.scope === "list" && listItems.length === 0 && ![...sources.incomplete].includes("todo_item")) {
      // A list with no items has nothing to organize; one not found is not widened.
      return null;
    }
    const chosen = input.scope === "list" ? listItems : (input.items ?? []).map((key) => sources.units.get(key)).filter((unit): unit is SourceUnit => unit !== undefined);
    if (input.scope === "selection" && chosen.length !== (input.items ?? []).length) return null;
    if (chosen.some((unit) => !inProject(unit, project) || (input.listId !== undefined && unit.todo?.listId !== input.listId))) return null;
    const knowledge = units.filter((unit) => unit.kind !== "todo_item" && inProject(unit, project));
    return { keys: new Set([...chosen, ...knowledge].map((unit) => unit.key)) };
  }

  #suggestionInScope(suggestion: StoredSuggestion, query: OrganizationQuery, sources: SourceSnapshot): boolean {
    if (suggestion.state === "merged") return false;
    if (query.source !== undefined && !suggestion.evidence.sources.some((source) => source.kind === query.source)) return false;
    if (query.scope === "all") return true;
    const projectMatch = query.project === null ? suggestion.project === null : suggestion.project !== null && inProject({ project: suggestion.project }, query.project);
    if (!projectMatch) return false;
    if (query.scope === "project") return true;
    const todoAnchors = suggestion.anchor.filter((key) => key.startsWith("todo_item:"));
    if (todoAnchors.length === 0) return true;
    if (query.scope === "list") return todoAnchors.some((key) => parseTodoItemSourceKey(key)?.listId === query.listId || sources.units.get(key)?.todo?.listId === query.listId);
    return todoAnchors.some((key) => query.items?.includes(key) === true);
  }

  #enqueueChanges(state: OrganizationState, sources: SourceSnapshot, keys: Set<string>, only?: readonly string[]): OrganizationState {
    const at = this.#clock().toISOString();
    const queued = new Set(state.ledger.queue.map((entry) => entry.key));
    const access = organizationSourceAccess(state, sources);
    const allowed = access.usable;
    // 准备期间权限或遗忘回执可能改变；确定性建议和模型任务使用同一份现行允许范围。
    for (const key of keys) {
      const unit = sources.units.get(key);
      if (unit === undefined || !allowed([key]) || state.ledger.forgottenEvidence[key] === unit.evidenceFingerprint) keys.delete(key);
    }
    for (const key of only ?? keys) {
      if (!keys.has(key)) continue;
      const unit = sources.units.get(key);
      if (unit === undefined || unit.selfGenerated === true || unit.metadataUnreadable === true || sources.degraded.has(unit.kind) || queued.has(key)) continue;
      const seen = state.ledger.seen[key];
      if (seen !== undefined && seen.fingerprint === unit.fingerprint) continue;
      state.ledger.queue.push({ key, reason: seen === undefined ? "new" : "changed", at });
      queued.add(key);
    }
    if (state.settings.automatic) {
      for (const suggestion of Object.values(state.suggestions)) {
        if (!suggestion.automatic || suggestion.redacted || suggestion.state !== "applied") continue;
        const changed = suggestion.evidence.sources.some((source) => {
          const unit = sources.units.get(source.key);
          return unit !== undefined && unit.evidenceFingerprint !== source.evidenceFingerprint;
        });
        if (!changed) continue;
        for (const key of suggestion.anchor) if (keys.has(key) && sources.units.has(key) && !queued.has(key)) {
          state.ledger.queue.push({ key, reason: "changed", at }); queued.add(key);
        }
      }
    }
    return state;
  }

  /** 状态也写不下时保留进程内失败视图；绝不把已经退出的工作显示成仍在运行。 */
  async #failRun(run: OrganizationRunView, error: unknown): Promise<void> {
    const stored = await this.#options.store.read().catch(() => null);
    if (stored !== null && stored.activeRun?.runId !== run.runId) return;
    const failed: OrganizationRunView = { ...(stored?.activeRun ?? run), state: "failed", stage: null, endedAt: this.#clock().toISOString(), partialReason: null,
      usage: run.usage,
      failure: { code: failureCode(error), message: `本轮未完成，待处理进度保留：${error instanceof Error ? error.message : String(error)}`.slice(0, 1000) },
    };
    this.#failedRun = failed;
    try {
      await this.#options.store.update((state) => {
        if (state.activeRun?.runId !== run.runId) return { state: null, value: null };
        state.runs = [...state.runs.filter((item) => item.runId !== run.runId), failed].slice(-300);
        state.activeRun = null;
        return { state, value: null };
      });
      this.#failedRun = null;
    } catch {
      // 容量用尽时仍可尝试只清除运行标记；错误信息保留在当前进程，队列和用户内容不动。
      await this.#options.store.update((state) => {
        if (state.activeRun?.runId !== run.runId) return { state: null, value: null };
        state.activeRun = null;
        return { state, value: null };
      }).catch(() => undefined);
    }
    this.#changed();
  }

  async #process(run: OrganizationRunView, profile: ModelProviderProfile, sources: SourceSnapshot, keys: Set<string>, signal: AbortSignal, only?: readonly string[]): Promise<void> {
    // The reader at the keyboard or mouse (the system no longer idle) stops a background run at once. Not a page's calls:
    // the pages read again on every change this run makes, and took that for the reader, stopping it every time.
    const watch = run.trigger !== "background" ? null : setInterval(() => {
      if ((this.#options.systemIdleSeconds?.() ?? 0) < this.#background.idleSeconds) this.#controller?.abort("foreground");
    }, 1_000);
    watch?.unref?.();
    try {
      await this.#processRun(run, profile, sources, keys, signal, only);
    } finally {
      if (watch !== null) clearInterval(watch);
    }
  }

  async #processRun(run: OrganizationRunView, profile: ModelProviderProfile, sources: SourceSnapshot, keys: Set<string>, signal: AbortSignal, only?: readonly string[]): Promise<void> {
    const startedAt = this.#monotonic();
    let ledger = emptyLedger();
    let partialReason: OrganizationRunView["partialReason"] = null;
    let failure: OrganizationRunView["failure"] = null;
    let created = 0;
    let updated = 0;
    const onDevice = profile.kind === "qwen" || profile.kind === "apple";
    const promptLimit = Math.min(this.#options.promptChars ?? PROMPT_CHARS, run.trigger === "background" && onDevice ? ON_DEVICE_BACKGROUND_PROMPT_CHARS : PROMPT_CHARS);
    const state = await this.#reconcile(await this.#options.store.read(), sources);
    const automatic = state.settings.automatic === true;
    const automaticAttempts = new Set<string>();
    if (this.#adoptions.size === 0) for (const suggestion of Object.values(state.suggestions)) {
      if (signal.aborted || this.#forgetting !== null || automaticAttempts.size >= this.#budget.changes || this.#monotonic() - startedAt >= this.#budget.ms) break;
      if (suggestion.state === "applying" && suggestion.apply !== null) {
        automaticAttempts.add(suggestion.id);
        await this.#tracked(this.#resumeApply(suggestion.id));
      }
    }
    if (automatic) await this.#applyRoutine(run.runId, signal, startedAt, automaticAttempts, sources);
    const budget = { ...this.#budget, calls: state.settings.maxCalls ?? this.#budget.calls, inputTokens: state.settings.inputTokens ?? this.#budget.inputTokens };
    const batch = state.ledger.queue.filter((entry) => keys.has(entry.key) && (only === undefined || only.includes(entry.key))).slice(0, this.#budget.changes);
    const units = batch.map((entry) => sources.units.get(entry.key)).filter((unit): unit is SourceUnit => unit !== undefined);
    const vanished = batch.filter((entry) => !sources.units.has(entry.key)).map((entry) => entry.key);
    const scoped = [...keys].map((key) => sources.units.get(key)).filter((unit): unit is SourceUnit => unit !== undefined);

    // Deterministic: todo items to reconsider (overdue, untouched). Every open item in scope, not only the changed:
    // a date passing changes nothing in the note.
    const rechecks = scoped.filter((unit) => !automatic && unit.todo !== undefined).flatMap((unit) => {
      const found = recheckOf({ status: unit.todo!.item.status, due: unit.todo!.item.due, lastChangedAt: unit.todo!.lastChangedAt }, today(this.#clock()));
      if (found === null) return [];
      const similarDone = scoped.find((other) => other.todo !== undefined && other.key !== unit.key && other.todo.item.status === "done" && this.#near(unit, other));
      return [{
        type: "todo_recheck" as const, project: unit.project, anchor: [unit.key], sources: [{ ...unit, evidenceFingerprint: hashOf({ reason: found.reason, due: unit.todo!.item.due, status: unit.todo!.item.status, title: unit.title }) }], counter: [],
        content: { type: "todo_recheck" as const, item: unit.key, reason: found.reason, days: found.days, similarDone: similarDone?.key ?? null },
        title: found.reason === "overdue" ? `「${unit.title.slice(0, 40)}」逾期 ${found.days} 天` : `「${unit.title.slice(0, 40)}」${found.days} 天没有变化`,
        why: similarDone === undefined ? "需要重新判断是否仍要做、何时做。" : "清单里有相似事项已完成，但这不能证明本项完成。",
        effect: "只提示重新判断，不自动延期、完成或放弃。", unchanged: "事项的状态、优先级、期限与处理记录。", model: null,
      }];
    });
    if (rechecks.length > 0) {
      const recheckResult = await this.#commit(run.runId, signal, rechecks, []);
      if (recheckResult !== null) { created += recheckResult.created; updated += recheckResult.updated; }
    }

    // Jobs: one per changed done/dropped item with a result said (stage 1); then groups (stage 2).
    const jobs: Job[] = [];
    for (const unit of units) {
      const result = unit.todo?.result;
      if (unit.todo === undefined || result === null || result === undefined || isVagueNote(result.note)) continue;
      const related = scoped.filter((other) => other.kind === "decision" && inProject(other, unit.project) && this.#near(unit, other)).slice(0, 2);
      jobs.push({ kind: "experience", groupKey: `exp:${sha256(unit.key).slice(0, 16)}`, seed: unit, related, members: [unit] });
    }
    const grouped = new Set<string>();
    let groups = 0;
    for (const unit of units) {
      if (groups >= this.#budget.groups) break;
      if (grouped.has(unit.key)) continue;
      if (automatic && unit.todo === undefined && unit.selfGenerated !== true) {
        const others = await this.#recall(unit, scoped.filter((other) => other.key !== unit.key && other.selfGenerated !== true), 4);
        jobs.push({ kind: "knowledge", groupKey: `knowledge:${sha256(unit.key).slice(0, 24)}`, members: [unit, ...others] });
        grouped.add(unit.key);
        groups += 1;
        continue;
      }
      if (unit.todo !== undefined) {
        if (unit.todo.item.status !== "open" && unit.todo.item.status !== "in_progress") continue;
        const others = await this.#recall(unit, scoped.filter((other) => other.todo !== undefined && other.key !== unit.key && (other.todo.item.status === "open" || other.todo.item.status === "in_progress")), this.#budget.groupSize - 1);
        const members = [unit, ...others];
        for (const member of members) grouped.add(member.key);
        const records = await this.#recall(unit, scoped.filter((other) => other.todo === undefined && other.kind !== "summary"), 3);
        jobs.push({ kind: "todo", groupKey: `todo:${members.map((member) => sha256(member.key).slice(0, 16)).sort().join(".")}`, members, records });
        groups += 1;
      } else if (!automatic && unit.kind !== "summary") {
        const others = await this.#recall(unit, scoped.filter((other) => other.todo === undefined && other.kind !== "summary" && other.key !== unit.key), 4);
        if (others.length === 0) continue;
        const members = [unit, ...others];
        grouped.add(unit.key);
        jobs.push({ kind: "conflict", groupKey: `conflict:${members.map((member) => sha256(member.key).slice(0, 16)).sort().join(".")}`, members });
        groups += 1;
      }
    }

    const done = new Set<string>();
    const failedKeys = new Set<string>();
    let index = 0;
    if (jobs.length > 0 || units.length > 0 || automaticAttempts.size > 0 || created + updated > 0) {
      await this.#progress(run.runId, { stage: jobs.length === 0 ? null : `正在检查第 1/${jobs.length} 组`, progress: { checked: 0, total: units.length, groupsDone: 0, groupsTotal: jobs.length } });
    }
    for (const job of jobs) {
      index += 1;
      if (signal.aborted) break;
      const members = job.kind === "todo" ? [...job.members, ...job.records] : job.kind === "experience" ? [job.seed, ...job.related] : job.members;
      const fingerprint = inputFingerprint(members);
      if ((await this.#options.store.read()).ledger.processed[job.groupKey] === fingerprint) {
        for (const member of job.members) done.add(member.key);
        continue;
      }
      await this.#progress(run.runId, { stage: `正在检查第 ${index}/${jobs.length} 组${job.kind === "experience" ? "（经验）" : job.kind === "conflict" ? "（冲突复核）" : "相似记录"}`, progress: { checked: done.size, total: units.length, groupsDone: index - 1, groupsTotal: jobs.length } });
      // Each source whole or not at all: one too long for a call waits, said as coverage, never cut and judged.
      const fitted = this.#fitJob(job, promptLimit);
      if (fitted === null) {
        partialReason ??= "coverage";
        continue;
      }
      if (fitted.omitted.length > 0) partialReason ??= "coverage";
      const narrowed = fitted.job;
      const outcome = await this.#call(narrowed, profile, run, index, ledger, startedAt, signal, budget);
      ledger = outcome.ledger;
      if ("stop" in outcome) {
        if (outcome.stop === "aborted") break;
        if (outcome.stop === "failed") {
          failure = outcome.failure;
          for (const member of narrowed.members) failedKeys.add(member.key);
          if (outcome.failure.code === "provider_unavailable" || outcome.failure.code === "unsupported_client") break;
          continue;
        }
        partialReason = outcome.stop;
        break;
      }
      const drafts = this.#draftsOf(narrowed, outcome.output, profile, outcome.requestIds).filter((draft) => !automatic || (draft.type !== "todo_acceptance" && draft.type !== "todo_recheck" && draft.type !== "conflict"));
      // Marked processed only when every source of the group was read whole; one left out keeps the group open.
      const committed = await this.#commit(run.runId, signal, drafts, fitted.omitted.length === 0 ? [job.groupKey, fingerprint] : [], jobInputs(narrowed));
      if (committed === null) break;
      created += committed.created;
      updated += committed.updated;
      if (automatic && !signal.aborted) await this.#applyRoutine(run.runId, signal, startedAt, automaticAttempts, sources);
      for (const member of narrowed.kind === "knowledge" ? narrowed.members.slice(0, 1) : narrowed.members) done.add(member.key);
    }

    // Items no job needed (nothing to judge) are done too; those a job failed or did not reach stay queued.
    // Stopped short (aborted, out of budget, time or calls): what was not reached stays queued. Left out for coverage
    // alone, the rest was reached.
    const stoppedShort = signal.aborted || (partialReason !== null && partialReason !== "coverage");
    const reached = stoppedShort ? new Set<string>() : new Set(units.filter((unit) => !automatic || unit.selfGenerated === true || (unit.todo !== undefined && !["open", "in_progress"].includes(unit.todo.item.status) && isVagueNote(unit.todo.result?.note ?? null))).map((unit) => unit.key));
    const jobKeys = new Set(jobs.flatMap((job) => job.members.map((member) => member.key)));
    const settled = [...units.filter((unit) => done.has(unit.key) || (reached.has(unit.key) && !jobKeys.has(unit.key) && !failedKeys.has(unit.key))).map((unit) => unit.key), ...vanished];
    const reason = signal.reason as string | undefined;
    if (units.some((unit) => !settled.includes(unit.key))) partialReason ??= "budget";
    if (automatic) {
      const current = await this.#options.store.read();
      const access = organizationSourceAccess(current, sources);
      const allowed = access.usable;
      const remaining = Object.values(current.suggestions).filter((entry) => entry.automatic && entry.draft === null && ["pending", "partially_applied"].includes(entry.state) && allowed(access.suggestionInputs(entry)));
      if (remaining.length > 0) partialReason ??= automaticAttempts.size >= budget.changes || this.#monotonic() - startedAt >= budget.ms ? "budget" : "coverage";
      if (remaining.some((entry) => entry.state === "partially_applied")) failure ??= { code: "automatic_write_incomplete", message: "部分自动更新尚未写完，已保存进度，后续重试。" };
    }
    const final: OrganizationRunView["state"] = reason === "pause" || reason === "foreground" ? "paused" : reason === "stop" ? "stopped"
      : failure !== null && done.size === 0 && created + updated === 0 ? "failed" : partialReason !== null || failure !== null ? "partial" : created + updated === 0 ? "no_change" : "done";
    await this.#options.store.update((current) => {
      if (current.activeRun?.runId !== run.runId) return { state: null, value: null };
      const settledSet = new Set(settled);
      current.ledger.queue = current.ledger.queue.filter((entry) => !settledSet.has(entry.key));
      for (const key of settled) {
        const unit = sources.units.get(key);
        if (unit === undefined) delete current.ledger.seen[key];
        else current.ledger.seen[key] = { fingerprint: unit.fingerprint, evidenceFingerprint: unit.evidenceFingerprint };
      }
      const ended: OrganizationRunView = {
        ...current.activeRun, state: final, endedAt: this.#clock().toISOString(), stage: null,
        progress: { checked: settled.length, total: units.length, groupsDone: jobs.filter((job) => job.members.every((member) => done.has(member.key))).length, groupsTotal: jobs.length },
        created, updated, partialReason: final === "partial" ? partialReason : null,
        failure: final === "failed" || (final === "partial" && failure !== null) ? failure : null, usage: usageOf(ledger),
      };
      current.runs = [...current.runs, ended].slice(-300);
      current.activeRun = null;
      return { state: current, value: null };
    });
    this.#changed();
  }

  async #progress(runId: string, change: Partial<OrganizationRunView>): Promise<void> {
    await this.#options.store.update((state) => {
      if (state.activeRun?.runId !== runId) return { state: null, value: null };
      state.activeRun = { ...state.activeRun, ...change };
      return { state, value: null };
    });
    this.#changed();
  }

  async #recall(seed: SourceUnit, pool: SourceUnit[], nearest: number): Promise<SourceUnit[]> {
    pool = pool.filter((unit) => inProject(unit, seed.project) && unit.metadataUnreadable !== true && unit.inactive !== true);
    if (pool.length === 0 || nearest <= 0) return [];
    const similar = this.#options.similar;
    if (similar !== undefined) {
      const found = await similar(seed.material, pool.map((unit) => ({ id: unit.key, text: unit.material.slice(0, 700) })), { floor: 0.6, nearest }).catch(() => ({ unavailable: "failed" }));
      if (!("unavailable" in found)) return found.near.map((near) => pool.find((unit) => unit.key === near.id)).filter((unit): unit is SourceUnit => unit !== undefined);
    }
    return pool.filter((unit) => this.#near(seed, unit)).slice(0, nearest);
  }

  /** Words in common, for recall without the local embedding: a third of the shorter one's terms. */
  #near(left: SourceUnit, right: SourceUnit): boolean {
    const a = new Set(terms(`${left.title} ${left.material}`));
    const b = new Set(terms(`${right.title} ${right.material}`));
    if (a.size === 0 || b.size === 0) return false;
    let shared = 0;
    for (const term of a) if (b.has(term)) shared += 1;
    return shared / Math.min(a.size, b.size) >= 0.3;
  }

  async #call(job: Job, profile: ModelProviderProfile, run: OrganizationRunView, index: number, ledger: BudgetLedger, startedAt: number, signal: AbortSignal, budget: OrganizationBudget = this.#budget): Promise<
    | { output: unknown; ledger: BudgetLedger; requestIds: string[] }
    | { stop: "aborted" | "budget" | "time" | "calls"; ledger: BudgetLedger }
    | { stop: "failed"; failure: { code: string; message: string }; ledger: BudgetLedger }
  > {
    const { system, prompt, schema, max } = this.#promptOf(job);
    const runId = run.runId;
    const requestIds: string[] = [];
    let used = ledger;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (signal.aborted) return { stop: "aborted", ledger: used };
      const allowed = allowance(budget, used, system.length + prompt.length, max, startedAt, this.#monotonic());
      if ("stop" in allowed) return { stop: allowed.stop, ledger: used };
      const requestId = `organization:${runId}:${index}:${attempt}`;
      requestIds.push(requestId);
      // Written down before the call is made: whatever it comes to (a suggestion, none, refused, failed), the record of
      // it can be found and deleted by the sources it read when one of them is forgotten.
      const members = jobInputs(job);
      const keys = [...new Set(members.map((unit) => unit.key))];
      const sources = await readSources(this.#options.readers, this.#clock());
      const at = this.#clock().toISOString();
      const noted = await this.#options.store.update<boolean | "input_limit">((state) => {
        if (state.activeRun?.runId !== runId) return { state: null, value: false };
        const access = organizationSourceAccess(state, sources);
        if ((state.activeRun.trigger === "background" && (!state.settings.background || state.settings.backgroundProfileId !== profile.profileId)) || !access.usable(keys) || members.some((unit) => sources.units.get(unit.key)?.fingerprint !== unit.fingerprint ||
          state.ledger.forgottenEvidence[unit.key] === unit.evidenceFingerprint ||
          legacyForgottenSince(state, unit.key, state.activeRun!.startedAt))) {
          this.#controller?.abort("pause");
          return { state: null, value: false };
        }
        const inputs = access.inputs(keys);
        const types: StoredSuggestion["type"][] = job.kind === "experience" ? ["experience"] : job.kind === "todo" ? ["todo_group", "todo_context", "todo_acceptance"] : job.kind === "knowledge" ? ["experience", "triage", "judgment"] : ["conflict"];
        const anchors = new Set(job.kind === "experience" ? [job.seed.key] : job.members.map((unit) => unit.key));
        // 刷新仍保留旧草稿/计划；连同新输入放不下时，不能先付费调用再反复写失败。
        if (inputs.length > 2048 || Object.values(state.suggestions).some((suggestion) => suggestion.state !== "merged" && types.includes(suggestion.type) && suggestion.anchor.some((key) => anchors.has(key)) && new Set([...suggestionInputKeys(suggestion), ...access.suggestionInputs(suggestion), ...inputs]).size > 2048)) return { state: null, value: "input_limit" };
        state.ledger.calls = [...state.ledger.calls, { requestId, keys: inputs, directKeys: keys, at }].slice(-5_000);
        return { state, value: true };
      });
      if (noted === "input_limit") return { stop: "failed", failure: { code: "input_lineage_limit", message: "本次输入连同已有记录的来源链超过保存上限，尚未调用模型；原记录和队列已保留。" }, ledger: used };
      if (!noted || signal.aborted) return { stop: "aborted", ledger: used };
      this.#inFlightCalls.add(requestId);
      try {
        const result = await this.#options.gateway.generate({
          requestId, purpose: "memory-organization", locale: "zh-CN", promptVersion: ORGANIZATION_PROMPT_VERSION, schemaVersion: ORGANIZATION_SCHEMA_VERSION,
          systemPrompt: system, userPrompt: prompt, outputSchema: z.toJSONSchema(schema) as Record<string, unknown>, maxOutputTokens: allowed.maxOutputTokens,
        }, (value) => schema.parse(value), signal, profile.profileId);
        used = charge(used, { ok: true, retry: attempt > 0, promptChars: system.length + prompt.length, maxOutputTokens: allowed.maxOutputTokens, usage: result.usage });
        run.usage = usageOf(used);
        return { output: result.parsedOutput, ledger: used, requestIds };
      } catch (error) {
        const usage = typeof error === "object" && error !== null && "usage" in error ? (error as { usage?: { inputTokens?: number; outputTokens?: number } }).usage : undefined;
        used = charge(used, { ok: false, retry: attempt > 0, promptChars: system.length + prompt.length, maxOutputTokens: allowed.maxOutputTokens, usage });
        run.usage = usageOf(used);
        const code = failureCode(error);
        if (signal.aborted || code === "cancelled") return { stop: "aborted", ledger: used };
        if (attempt === 1 || code === "provider_unavailable" || code === "unsupported_client") {
          return { stop: "failed", failure: { code, message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) }, ledger: used };
        }
      } finally {
        // A cancelled provider can still write its trace late; keep its receipt until that output is cleared.
        await this.#clearForgottenCalls(requestId).catch(() => undefined);
        this.#inFlightCalls.delete(requestId);
      }
    }
    return { stop: "failed", failure: { code: "failed", message: "模型调用失败" }, ledger: used };
  }

  /**
   * The job as it fits one call, each source whole: none is cut short, its conditions and exceptions least of all. Those
   * that do not fit are left out whole and said (`omitted`); the one the job is about not fitting, the job waits (null).
   */
  #fitJob(job: Job, limit: number): { job: Job; omitted: SourceUnit[] } | null {
    const take = (units: SourceUnit[], room: number, render: (unit: SourceUnit, at: number) => string, first: boolean) => {
      const kept: SourceUnit[] = [];
      const omitted: SourceUnit[] = [];
      let used = 0;
      for (const unit of units) {
        const length = render(unit, kept.length).length + 2;
        if (used + length > room) {
          if (first && kept.length === 0) return null;
          omitted.push(unit);
          continue;
        }
        kept.push(unit);
        used += length;
      }
      return { kept, omitted, used };
    };
    if (job.kind === "experience") {
      const room = limit - experienceSystemPrompt.length - 60;
      const seed = take([job.seed], room, (unit) => unit.material, true);
      if (seed === null) return null;
      const related = take(job.related, room - seed.used, (unit, at) => `D${at + 1}：${unit.material}`, false)!;
      return { job: { ...job, related: related.kept }, omitted: related.omitted };
    }
    if (job.kind === "todo") {
      const room = limit - todoGroupSystemPrompt.length - 60;
      const items = take(job.members, Math.floor(room * 0.75), (unit, at) => `T${at + 1}（${unit.todo?.item.status ?? ""}）：\n${unit.material}`, true);
      if (items === null) return null;
      const records = take(job.records, room - items.used, (unit, at) => `K${at + 1}（${unit.label}）：\n${unit.material}`, false)!;
      return { job: { ...job, members: items.kept, records: records.kept }, omitted: [...items.omitted, ...records.omitted] };
    }
    const room = limit - (job.kind === "knowledge" ? maintenanceSystemPrompt : conflictSystemPrompt).length - 60;
    const members = take(job.members, room, (unit, at) => `K${at + 1}（${unit.label}；项目 ${unit.project ?? "未标明"}；${unit.at?.slice(0, 10) ?? ""}）：\n${unit.material}`, true);
    if (members === null || members.kept.length < (job.kind === "knowledge" ? 1 : 2)) return null;
    return { job: { ...job, members: members.kept }, omitted: members.omitted };
  }

  /** The prompt of a fitted job: every source in it whole. */
  #promptOf(job: Job): { system: string; prompt: string; schema: z.ZodType; max: number } {
    if (job.kind === "experience") {
      return { system: experienceSystemPrompt, prompt: experiencePrompt(job.seed.material, job.related.map((unit, at) => `D${at + 1}：${unit.material}`)), schema: experienceOutputSchema, max: OUTPUT_MAX.experience };
    }
    if (job.kind === "todo") {
      return {
        system: todoGroupSystemPrompt,
        prompt: todoGroupPrompt(job.members.map((unit, at) => `T${at + 1}（${unit.todo?.item.status ?? ""}）：\n${unit.material}`), job.records.map((unit, at) => `K${at + 1}（${unit.label}）：\n${unit.material}`)),
        schema: todoGroupOutputSchema, max: OUTPUT_MAX.todo,
      };
    }
    if (job.kind === "knowledge") return { system: maintenanceSystemPrompt, prompt: recordsPrompt(job.members.map((unit, at) => `K${at + 1}（${unit.label}；${unit.kind}；${unit.role}；项目 ${unit.project ?? "未标明"}）：\n${unit.material}`)), schema: maintenanceOutputSchema, max: 1500 };
    return { system: conflictSystemPrompt, prompt: recordsPrompt(job.members.map((unit, at) => `K${at + 1}（${unit.label}；项目 ${unit.project ?? "未标明"}；${unit.at?.slice(0, 10) ?? ""}）：\n${unit.material}`)), schema: conflictOutputSchema, max: OUTPUT_MAX.conflict };
  }

  /** The model's answer, its aliases turned back into sources; any alias not given is dropped. */
  #draftsOf(job: Job, output: unknown, profile: ModelProviderProfile, requestIds: string[]): SuggestionDraftInput[] {
    const model = { profileId: profile.profileId, model: profile.model ?? profile.kind, promptVersion: ORGANIZATION_PROMPT_VERSION, requestIds };
    if (job.kind === "experience") {
      const parsed = experienceOutputSchema.parse(output);
      const result = job.seed.todo?.result;
      const body = parsed.hasObservation && parsed.title && parsed.scene && parsed.action && parsed.observation && parsed.inference && parsed.exceptions
        ? { title: parsed.title, scene: parsed.scene, action: parsed.action, observation: parsed.observation, inference: parsed.inference, exceptions: parsed.exceptions } : null;
      if (body === null || result === null || result === undefined) return [];
      // Who said it and whether anyone checked: from the status event, never from the model's words.
      const reporter = result.by.kind === "agent" ? "agent" as const : "user" as const;
      const verification = reporter === "agent" ? "agent_reported_unverified" as const : "user_reported" as const;
      return [{
        type: "experience", project: job.seed.project, anchor: [job.seed.key], sources: [job.seed, ...job.related], counter: [],
        content: { type: "experience", body, reporter, verification, outcome: parsed.outcome ?? "mixed" },
        title: body.title, why: `${job.seed.label} ${result.status === "done" ? "完成" : "放弃"}时写了结果说明。`,
        effect: "保存为执行经验，以后可检索；不是原则，不证明因果，也不会变成偏好或待办。", unchanged: "事项、决策与偏好。", model,
      }];
    }
    if (job.kind === "todo") {
      const parsed = todoGroupOutputSchema.parse(output);
      const item = (ref: string) => /^T(\d+)$/u.exec(ref) === null ? undefined : job.members[Number(ref.slice(1)) - 1];
      const record = (ref: string) => /^K(\d+)$/u.exec(ref) === null ? undefined : job.records[Number(ref.slice(1)) - 1];
      // The aliases are the prompt's, not the reader's: any the model wrote in its words is said as the title it stands for.
      const words = (text: string) => text.replace(/(?<![A-Za-z0-9]) ?([TK]\d+)(?![0-9]) ?/gu, (_match, ref: string) => {
        const unit = ref.startsWith("T") ? item(ref) : record(ref);
        return unit === undefined ? ref : `「${unit.title.slice(0, 40)}」`;
      });
      const drafts: SuggestionDraftInput[] = [];
      for (const group of parsed.groups) {
        const members = group.members.map((member) => ({ unit: item(member.ref), difference: words(member.difference) })).filter((member): member is { unit: SourceUnit; difference: string } => member.unit !== undefined);
        const unique = [...new Map(members.map((member) => [member.unit.key, member])).values()];
        if (unique.length < 2) continue;
        const title = words(group.title);
        drafts.push({
          type: "todo_group", project: job.members[0]!.project, anchor: unique.map((member) => member.unit.key), sources: unique.map((member) => member.unit), counter: [],
          content: { type: "todo_group", title, members: unique.map((member) => ({ key: member.unit.key, difference: member.difference })) },
          title: `${unique.length} 条事项都在说「${title}」`, why: `分在 ${new Set(unique.map((member) => member.unit.todo?.listId)).size} 个清单里，容易重复处理。`,
          effect: "仅在阅读时放进一个主题组，事项本身不变；可随时取消分组。", unchanged: "各事项的状态、编号、优先级、期限、所属清单与处理记录。", model,
        });
      }
      for (const entry of parsed.acceptance) {
        const unit = item(entry.ref);
        if (unit?.todo === undefined || (unit.todo.item.status !== "open" && unit.todo.item.status !== "in_progress")) continue;
        drafts.push({
          type: "todo_acceptance", project: unit.project, anchor: [unit.key], sources: [unit], counter: [],
          content: { type: "todo_acceptance", item: unit.key, missing: words(entry.missing), currentDetail: unit.todo.item.detail, draftDetail: words(entry.draftDetail) },
          title: `「${unit.title.slice(0, 40)}」没有写完成标准`, why: `缺${words(entry.missing).slice(0, 80)}。`,
          effect: "把补充说明改成草稿里的内容；你确认后才写。", unchanged: "标题、状态、优先级、期限、标签与处置备注。", model,
        });
      }
      const linksByItem = new Map<string, { unit: SourceUnit; links: Array<{ record: SourceUnit; whyRelevant: string; scopeNote: string | null }> }>();
      for (const link of parsed.links) {
        const unit = item(link.ref);
        const target = record(link.record);
        if (unit === undefined || target === undefined) continue;
        const entry = linksByItem.get(unit.key) ?? { unit, links: [] };
        if (!entry.links.some((existing) => existing.record.key === target.key)) entry.links.push({ record: target, whyRelevant: words(link.whyRelevant), scopeNote: link.scopeNote === null ? null : words(link.scopeNote) });
        linksByItem.set(unit.key, entry);
      }
      for (const { unit, links } of linksByItem.values()) {
        drafts.push({
          type: "todo_context", project: unit.project, anchor: [unit.key], sources: [unit, ...links.map((link) => link.record)], counter: [],
          content: { type: "todo_context", item: unit.key, links: links.slice(0, 5).map((link) => ({ key: link.record.key, title: link.record.title.slice(0, 500), whyRelevant: link.whyRelevant, scopeNote: link.scopeNote })) },
          title: `「${unit.title.slice(0, 40)}」开始前要看 ${links.length} 条记录`, why: "有相关的已记录内容；相关不等于适用，请核对范围。",
          effect: "在事项详情加「开始前要看」引用，不改正文。", unchanged: "事项正文、处置备注与状态。", model,
        });
      }
      return drafts;
    }
    if (job.kind === "knowledge") return maintenanceDrafts(job.members, output, model);
    const parsed = conflictOutputSchema.parse(output);
    const record = (ref: string) => /^K(\d+)$/u.exec(ref) === null ? undefined : job.members[Number(ref.slice(1)) - 1];
    const drafts: SuggestionDraftInput[] = [];
    for (const pair of parsed.pairs) {
      if (pair.relation !== "possible_conflict" && pair.relation !== "scope_differs") continue;
      const [a, b] = [record(pair.a), record(pair.b)];
      if (a === undefined || b === undefined || a.key === b.key) continue;
      const [first, second] = a.key < b.key ? [a, b] : [b, a];
      const [conditionFirst, conditionSecond, scopeFirst, scopeSecond] = first === a ? [pair.conditionA, pair.conditionB, pair.scopeA, pair.scopeB] : [pair.conditionB, pair.conditionA, pair.scopeB, pair.scopeA];
      const side = (unit: SourceUnit, condition: string | null) => ({
        key: unit.key, title: unit.title.slice(0, 500), project: unit.project, at: unit.at?.slice(0, 10) ?? null,
        sourceLabel: unit.kind === "decision" ? "决策记录 · 你做出的选择" : unit.kind === "summary" ? "历史沉淀" : unit.kind === "preference" ? "偏好记录 · 你明确说过" : unit.kind === "idea" ? "想法记录 · 未承诺" : "执行经验",
        condition, appliesWhen: unit.scope?.appliesWhen ?? null,
        scopeEditable: unit.scope?.editable === true && (unit.kind === "decision" || unit.kind === "summary" || unit.kind === "preference"),
      });
      const bothDecisions = (first.kind === "decision" || first.kind === "summary") && (second.kind === "decision" || second.kind === "summary");
      drafts.push({
        type: "conflict", project: first.project, anchor: [first.key, second.key], sources: [first, second], counter: [],
        content: {
          type: "conflict", topic: pair.topic, sameScope: pair.relation === "possible_conflict", a: side(first, conditionFirst), b: side(second, conditionSecond),
          proposal: { a: scopeFirst, b: scopeSecond, relation: bothDecisions ? "unrelated" : null },
        },
        title: pair.topic, why: pair.relation === "scope_differs" ? "两条结论方向相反，但写明的条件不同，可能只是适用范围不同。" : "两条结论方向相反，先核对适用范围。",
        effect: "按你选的方式处理；不会按时间新旧自动选一条。", unchanged: "结论正文、时间、来源、状态；不标哪条胜出，不标「已被替代」。", model,
      });
    }
    return drafts;
  }

  /**
   * Suggestions into the store, as one write: each checked (its sources in the snapshot, excerpts from them), carried
   * onto the card its anchor already has, and the group marked processed. Not written for a run no longer the one
   * under way (stopped, paused: a late answer is dropped).
   */
  async #commit(runId: string, signal: AbortSignal, drafts: SuggestionDraftInput[], processed: [string, string] | [], inputUnits: readonly SourceUnit[] = drafts.flatMap((draft) => [...draft.sources, ...draft.counter])): Promise<{ created: number; updated: number } | null> {
    if (signal.aborted) return null;
    const sources = await readSources(this.#options.readers, this.#clock());
    const now = this.#clock().toISOString();
    return this.#options.store.update((state) => {
      if (state.activeRun?.runId !== runId || signal.aborted) return { state: null, value: null };
      const startedAt = state.activeRun.startedAt;
      // Read before a source was forgotten or found deleted: nothing made from it is written back.
      const legacyForgotten = (key: string) => legacyForgottenSince(state, key, startedAt);
      let created = 0;
      let updated = 0;
      const access = organizationSourceAccess(state, sources);
      // 过期/读失败的空回答也不是“已处理”；整组保留，恢复后重新判断。
      if (!access.usable(inputUnits.map((unit) => unit.key)) || inputUnits.some((unit) => legacyForgotten(unit.key) || sources.units.get(unit.key)?.fingerprint !== unit.fingerprint)) {
        this.#controller?.abort("pause");
        return { state: null, value: null };
      }
      for (const draft of drafts) {
        const inputs = [...draft.anchor, ...draft.sources.map((unit) => unit.key), ...draft.counter.map((unit) => unit.key), ...(modelDirectInputKeys(state, draft.model?.requestIds ?? []) ?? modelInputKeys(state, draft.model?.requestIds ?? []))];
        if (inputs.some(legacyForgotten) || !access.usable(inputs) || [...draft.sources, ...draft.counter].some((unit) => sources.units.get(unit.key)?.fingerprint !== unit.fingerprint)) {
          this.#controller?.abort("pause");
          return { state: null, value: null };
        }
        const outcome = this.#upsert(state, draft, now, access.inputs);
        if (outcome === "created") created += 1;
        if (outcome === "updated") updated += 1;
      }
      if (processed.length === 2) state.ledger.processed[processed[0]] = processed[1];
      state.activeRun = { ...state.activeRun, created: state.activeRun.created + created, updated: state.activeRun.updated + updated };
      return { state, value: { created, updated } };
    }).finally(() => this.#changed());
  }

  #upsert(state: OrganizationState, draft: SuggestionDraftInput, now: string, expanded: (keys: Iterable<string>) => string[]): "created" | "updated" | "same" {
    const sources = draft.sources.map(storedSourceOf);
    const counter = draft.counter.map(storedSourceOf);
    const inputKeys = [...new Set([...draft.anchor, ...sources.map((source) => source.key), ...counter.map((source) => source.key), ...modelInputKeys(state, draft.model?.requestIds ?? [])])];
    const directInputKeys = draft.model === null ? inputKeys : modelDirectInputKeys(state, draft.model.requestIds);
    const fingerprint = inputFingerprint(sources);
    let id = suggestionId(draft.type, draft.project, draft.anchor);
    // A group carried onto the earliest live group card any of its members is already in; the others merged into it.
    if (draft.type === "todo_group") {
      const overlapping = Object.values(state.suggestions)
        .filter((suggestion) => suggestion.type === "todo_group" && suggestion.state !== "merged" && suggestion.state !== "invalid" && revisedId(suggestion.id) === null && suggestion.anchor.some((key) => draft.anchor.includes(key)))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      if (overlapping.length > 0) {
        id = overlapping[0]!.id;
        for (const other of overlapping.slice(1)) {
          if (other.state === "applied" || other.state === "applying" || other.state === "partially_applied") continue;
          state.suggestions[other.id] = { ...other, state: "merged", mergedInto: id, updatedAt: now };
        }
      }
    }
    let existing = state.suggestions[id];
    // Adopted already, and its evidence moved on: the new reading is offered as a revision of it, for review. What was
    // adopted is left as it is until the revision is adopted (IMP-191: new evidence revises what is understood).
    let revises: StoredSuggestion | null = null;
    while (existing?.state === "applied" && !existing.redacted && existing.evidence.inputFingerprint !== fingerprint) {
      revises = existing;
      const child = Object.values(state.suggestions).reverse().find((entry) => (entry.revises ?? revisedId(entry.id)) === existing!.id);
      const root = existing.id.split("~r")[0]!;
      id = child?.id ?? `${root}~r${Object.keys(state.suggestions).filter((key) => key === root || key.startsWith(`${root}~r`)).length}`;
      existing = child;
    }
    // A cleared card only reopens for changed substance, never metadata or clock ordering.
    if (existing?.redacted === true && reopenReason(Object.fromEntries(existing.evidence.sources.map(source => [source.key, source.evidenceFingerprint])), sources, key => key) === null) return "same";
    const labels = new Map(sources.map((source) => [source.key, source.label]));
    // A revision says, in the App's words, what it revises and what adopting it does; never the model's.
    const said = revises === null ? {} : revisionWords(revises, draft.type);
    let revisionReason: string | null = null;
    if (existing === undefined && revises !== null) {
      const reason = reopenReason(Object.fromEntries(revises.evidence.sources.map((source) => [source.key, source.evidenceFingerprint])), sources, (key) => labels.get(key) ?? key);
      // Moved in what is no evidence (a summary, other words): nothing to review.
      if (reason === null) return "same";
      revisionReason = `修订已采纳的「${revises.title.slice(0, 200)}」：${reason}`.slice(0, 1_000);
    }
    if (existing === undefined) {
      state.suggestions[id] = {
        id, type: draft.type, project: draft.project, anchor: [...draft.anchor].sort(), revision: 1,
        evidence: { version: 1, inputFingerprint: fingerprint, sources, counter },
        content: draft.content, title: draft.title.slice(0, 500), why: draft.why.slice(0, 1_000), effect: draft.effect.slice(0, 1_000), unchanged: draft.unchanged.slice(0, 1_000), ...said,
        ...(revises === null ? {} : { revises: revises.id }),
        automatic: revises?.draft == null && state.settings.automatic === true && ["todo_group", "todo_context", "experience", "triage"].includes(draft.type),
        model: draft.model, inputKeys: [...new Set([...(revises?.inputKeys ?? []), ...inputKeys])], state: "pending", mergedInto: null, stale: null, deferUntil: null, draft: null, reopenReason: revisionReason, receipts: [], apply: null, appliedAt: null,
        ...(directInputKeys === undefined ? {} : { directInputKeys: [...new Set([...(revises === null ? [] : revises.directInputKeys ?? expanded(suggestionInputKeys(revises))), ...directInputKeys])] }),
        redacted: false, createdAt: now, updatedAt: now,
      };
      return "created";
    }
    if (existing.evidence.inputFingerprint === fingerprint && existing.state !== "undone" && existing.state !== "invalid") return "same";
    if (existing.state === "applying" || existing.state === "applied" || existing.state === "partially_applied") return "same";
    const refreshed: StoredSuggestion = {
      ...existing,
      anchor: draft.type === "todo_group" ? [...new Set([...existing.anchor, ...draft.anchor])].sort().slice(0, 10) : existing.anchor,
      revision: existing.revision + 1,
      evidence: { version: existing.evidence.version + 1, inputFingerprint: fingerprint, sources, counter },
      content: draft.content, title: draft.title.slice(0, 500), why: draft.why.slice(0, 1_000), effect: draft.effect.slice(0, 1_000), unchanged: draft.unchanged.slice(0, 1_000), ...said,
      model: draft.model === null ? existing.model : { ...draft.model, requestIds: [...(existing.model?.requestIds ?? []), ...draft.model.requestIds].slice(-50) },
      // 草稿、回执和旧写前计划仍在，不能丢掉它们依赖的输入。
      inputKeys: [...new Set([...(existing.inputKeys ?? []), ...inputKeys])],
      ...(directInputKeys === undefined ? {} : { directInputKeys: [...new Set([...(existing.directInputKeys ?? expanded(suggestionInputKeys(existing))), ...directInputKeys])] }),
      stale: null, redacted: false, updatedAt: now,
    };
    if (existing.state === "rejected" || (existing.automatic && existing.state === "undone") || held(existing)) {
      const receipt = [...existing.receipts].reverse().find((item) => item.action === "reject" || item.action === "hold" || item.action === "undo");
      const reason = reopenReason(receipt?.evidence ?? {}, sources, (key) => labels.get(key) ?? key);
      // Same evidence in other words, another model, a priority or a tag changed: it stays as the reader left it.
      if (reason === null) return "same";
      state.suggestions[id] = { ...refreshed, state: "pending", deferUntil: null, reopenReason: reason, receipts: [...existing.receipts, { action: "reopened_by_evidence" as const, at: now, revision: refreshed.revision, note: reason.slice(0, 1_000) }].slice(-100) };
      return "updated";
    }
    if (existing.state === "deferred") {
      state.suggestions[id] = refreshed;
      return "updated";
    }
    state.suggestions[id] = { ...refreshed, state: "pending" };
    return "updated";
  }

  // ------------------------------------------------------------------ views and staleness

  #sourceStatus(source: StoredSource, sources: SourceSnapshot): SuggestionSourceView["status"] {
    const unit = sources.units.get(source.key);
    if (unit === undefined) return sources.incomplete.has(source.kind) ? "unreadable" : "gone";
    // Its additions, rewrites or relations not read this time: it is there, but not as it stands; never current.
    if (sources.degraded.has(source.kind) || unit.metadataUnreadable === true) return "unreadable";
    return unit.evidenceFingerprint === source.evidenceFingerprint ? "current" : "changed";
  }

  #staleOf(suggestion: StoredSuggestion, sources: SourceSnapshot, lifecycle?: ReturnType<typeof organizationSourceAccess>): StoredSuggestion["stale"] {
    if (suggestion.state === "applied" && (suggestion.type === "judgment" || suggestion.apply?.steps.some((step) => step.kind === "experience_create" && sources.units.get(step.target)?.experience?.userChoice))) return null;
    const all = [...suggestion.evidence.sources, ...suggestion.evidence.counter];
    const statuses = all.map((source) => ({ key: source.key, status: this.#sourceStatus(source, sources) }));
    if (lifecycle !== undefined) for (const key of lifecycle.suggestionInputs(suggestion)) {
      const status = lifecycle.status(key);
      if (status !== "current") statuses.push({ key, status });
    }
    // The item a rewrite writes to: any change to it (title, priority) and the draft is not made against it any more.
    if (suggestion.type === "todo_acceptance" && suggestion.content?.type === "todo_acceptance") {
      const item = suggestion.content.item;
      const target = suggestion.evidence.sources.find((source) => source.key === item);
      const unit = sources.units.get(item);
      if (target !== undefined && unit !== undefined && unit.fingerprint !== target.fingerprint) statuses.push({ key: target.key, status: "changed" });
    }
    const pick = (status: SuggestionSourceView["status"]) => statuses.filter((entry) => entry.status === status).map((entry) => entry.key);
    const at = this.#clock().toISOString();
    if (pick("gone").length > 0) return { reason: "source_gone", at, keys: pick("gone").slice(0, 50) };
    if (pick("unreadable").length > 0) return { reason: "source_unreadable", at, keys: pick("unreadable").slice(0, 50) };
    if (pick("changed").length > 0) return { reason: "source_changed", at, keys: [...new Set(pick("changed"))].slice(0, 50) };
    return null;
  }

  /**
   * Brought in line with the sources as read now: a card whose source is gone is cleared of every text taken from it;
   * one whose source changed is marked stale (its text kept, for the comparison); one whose sources changed only in
   * what is no evidence (a priority, a tag) is quietly rebased. Annotations of a gone source go too.
   */
  async #reconcile(state: OrganizationState, sources: SourceSnapshot): Promise<OrganizationState> {
    if (this.#closed) return state;
    return this.#mutation(() => this.#reconcileNow(state, sources));
  }

  async #reconcileNow(state: OrganizationState, sources: SourceSnapshot): Promise<OrganizationState> {
    const at = this.#clock().toISOString();
    const gone: string[] = [];
    const vectors: string[] = [];
    let dirty = false;
    const plans = new Map<string, StoredSuggestion>();
    const lifecycle = organizationSourceAccess(state, sources);
    for (const suggestion of Object.values(state.suggestions)) {
      if (suggestion.state === "merged" || suggestion.redacted) continue;
      // An adopted experience whose note the reader deleted (in Obsidian, every note read): what was derived for it goes
      // too, its card cleared, its call records and its vector. A note not read this time is not deleted.
      const created = suggestion.apply?.steps.find((step) => step.kind === "experience_create" && step.state === "written");
      if (created !== undefined && suggestion.state !== "applying" && !sources.incomplete.has("experience") && !sources.units.has(created.target)) {
        plans.set(suggestion.id, { ...this.#redacted(suggestion, at, "forgotten"), state: "undone", receipts: [...suggestion.receipts.map(({ note: _note, ...receipt }) => receipt), { action: "forgotten" as const, at, revision: suggestion.revision, note: "经验笔记已被删除" }].slice(-100) });
        gone.push(...(suggestion.model?.requestIds ?? []));
        vectors.push(created.target);
        dirty = true;
        continue;
      }
      const stale = this.#staleOf(suggestion, sources, lifecycle);
      if (suggestion.automatic && suggestion.state === "pending" && suggestion.draft === null && stale?.reason === "source_changed") {
        plans.set(suggestion.id, { ...suggestion, state: "invalid", stale, updatedAt: at }); dirty = true; continue;
      }
      // 用户已确认的选择本身是新事实；原候选到期不撤销这次选择，显式遗忘仍会清除。
      if (suggestion.state === "applied" && (suggestion.type === "judgment" || (created !== undefined && sources.units.get(created.target)?.experience?.userChoice))) continue;
      // Moved to another project (a list's project, a record's): what was suggested for the old one is void there, and
      // the record is read again for the one it is in now. Not cleared: its sources are all still there.
      const moved = suggestion.state !== "applying" && suggestion.state !== "applied" && suggestion.state !== "invalid" && suggestion.evidence.sources.some((source) => {
        const unit = sources.units.get(source.key);
        return unit !== undefined && !inProject(unit, suggestion.project);
      });
      if (moved) {
        plans.set(suggestion.id, { ...suggestion, state: "invalid", stale: { reason: "source_changed", at, keys: [] }, receipts: [...suggestion.receipts, { action: "invalidated" as const, at, revision: suggestion.revision, note: "来源已改属其它项目" }].slice(-100), updatedAt: at });
        dirty = true;
        continue;
      }
      if (stale?.reason === "source_gone" && suggestion.state !== "applying") {
        plans.set(suggestion.id, this.#redacted(suggestion, at, "invalidated"));
        gone.push(...(suggestion.model?.requestIds ?? []));
        dirty = true;
        continue;
      }
      const rebased = stale === null && suggestion.evidence.sources.some((source) => {
        const unit = sources.units.get(source.key);
        return unit !== undefined && unit.fingerprint !== source.fingerprint;
      });
      const sameStale = JSON.stringify(stale === null ? null : [stale.reason, stale.keys]) === JSON.stringify(suggestion.stale === null ? null : [suggestion.stale.reason, suggestion.stale.keys]);
      if (!sameStale || rebased) {
        plans.set(suggestion.id, {
          ...suggestion,
          stale: stale === null ? null : sameStale ? suggestion.stale : stale,
          evidence: rebased ? { ...suggestion.evidence, sources: suggestion.evidence.sources.map((source) => {
            const unit = sources.units.get(source.key);
            return unit === undefined ? source : { ...source, fingerprint: unit.fingerprint };
          }) } : suggestion.evidence,
        });
        dirty = true;
      }
    }
    const goneKeys = (key: string) => sources.units.get(key) === undefined && !sources.incomplete.has(key.slice(0, key.indexOf(":")) as never);
    // A link to a source now gone, or one whose card was cleared, holds that source's text: it goes with it.
    const cleared = (suggestionId: string) => state.suggestions[suggestionId]?.redacted === true || plans.get(suggestionId)?.redacted === true;
    const staleLink = (key: string, entry: { suggestionId: string; link: { key: string } }) => goneKeys(key) || goneKeys(entry.link.key) || cleared(entry.suggestionId);
    const annotationsChanged = Object.entries(state.annotations.groups).some(([id, group]) => group.members.some(goneKeys) || cleared(id)) ||
      Object.entries(state.annotations.beforeStart).some(([key, links]) => links.some((entry) => staleLink(key, entry)));
    // Every call that read a source now known deleted, card or none: its record goes, and a run that read it before is
    // not let write it back.
    const pendingDeletes = new Set(state.ledger.pendingTraceDeletes ?? []);
    const goneCalls = state.ledger.calls.filter(entry => pendingDeletes.has(entry.requestId) || (entry.directKeys ?? entry.keys).some(key => lifecycle.status(key) === "gone"));
    if (goneCalls.some(entry => !this.#inFlightCalls.has(entry.requestId) || !pendingDeletes.has(entry.requestId))) dirty = true;
    if (!dirty && !annotationsChanged) return state;
    const written = await this.#options.store.update((current) => {
      for (const [id, next] of plans) {
        const now = current.suggestions[id];
        // Changed meanwhile (decided, applied): left for the next look.
        if (now === undefined || now.updatedAt !== state.suggestions[id]?.updatedAt || now.state !== state.suggestions[id]?.state) continue;
        current.suggestions[id] = next;
      }
      const clearedNow = (suggestionId: string) => current.suggestions[suggestionId]?.redacted === true;
      for (const [id, group] of Object.entries(current.annotations.groups)) if (group.members.some(goneKeys) || clearedNow(id)) delete current.annotations.groups[id];
      for (const [key, links] of Object.entries(current.annotations.beforeStart)) {
        const kept = links.filter((entry) => !goneKeys(key) && !goneKeys(entry.link.key) && !clearedNow(entry.suggestionId));
        if (kept.length === 0) delete current.annotations.beforeStart[key];
        else current.annotations.beforeStart[key] = kept;
      }
      for (const entry of goneCalls) for (const key of entry.keys) if (goneKeys(key)) current.ledger.forgotten[key] ??= at;
      const traceIds = [...new Set([...(current.ledger.pendingTraceDeletes ?? []), ...gone, ...goneCalls.map(entry => entry.requestId)])];
      if (traceIds.length > 0) current.ledger.pendingTraceDeletes = traceIds;
      return { state: current, value: current };
    }).catch(() => state);
    gone.push(...goneCalls.map((entry) => entry.requestId));
    if (gone.length > 0) {
      // The call entries go only once their records are deleted; a failure leaves them for the next look.
      const pendingCalls = new Set(this.#inFlightCalls);
      const deleted = await this.#options.traces.deleteRequest([...new Set(gone)]).then(() => true, () => false);
      if (deleted) {
        const done = new Set(gone);
        await this.#options.store.update((current) => {
          current.ledger.calls = current.ledger.calls.filter((entry) => !done.has(entry.requestId) || pendingCalls.has(entry.requestId));
          const remaining = (current.ledger.pendingTraceDeletes ?? []).filter(id => !done.has(id) || pendingCalls.has(id));
          if (remaining.length > 0) current.ledger.pendingTraceDeletes = remaining;
          else delete current.ledger.pendingTraceDeletes;
          return { state: current, value: null };
        }).catch(() => undefined);
      }
    }
    if (vectors.length > 0) this.#options.forgetVectors?.(vectors);
    return written;
  }

  /** A card with every text from its sources taken out: kept only as an id, a state and hashes. */
  #redacted(suggestion: StoredSuggestion, at: string, action: "invalidated" | "forgotten"): StoredSuggestion {
    const clear = (source: StoredSource): StoredSource => ({ ...source, basis: null, label: "来源已删除" });
    return {
      ...suggestion,
      state: suggestion.state === "applied" ? "applied" : "invalid",
      title: "来源已删除", why: "", effect: "", unchanged: "",
      content: null, draft: null, reopenReason: null,
      evidence: { ...suggestion.evidence, sources: suggestion.evidence.sources.map(clear), counter: suggestion.evidence.counter.map(clear) },
      apply: suggestion.apply === null ? null : { ...suggestion.apply, steps: suggestion.apply.steps.map((step) => ({ ...step, before: null, after: null, result: step.result === undefined ? undefined : { ...step.result, message: undefined } })) },
      model: suggestion.model === null ? null : { ...suggestion.model, requestIds: [] },
      receipts: [...suggestion.receipts.map(({ note: _note, ...receipt }) => receipt), { action: action as "invalidated" | "forgotten", at, revision: suggestion.revision }].slice(-100),
      stale: { reason: "source_gone", at, keys: [] },
      redacted: true,
      updatedAt: at,
    };
  }

  #view(suggestion: StoredSuggestion, sources: SourceSnapshot, now: Date, lifecycle: ReturnType<typeof organizationSourceAccess>): SuggestionView {
    const stale = suggestion.redacted ? suggestion.stale : this.#staleOf(suggestion, sources, lifecycle);
    const sourceView = (source: StoredSource): SuggestionSourceView => {
      const unit = sources.units.get(source.key);
      const status = suggestion.redacted ? "gone" : this.#sourceStatus(source, sources);
      return {
        key: source.key, kind: source.kind, role: source.role, label: source.label, status,
        excerpt: source.basis?.excerpt ?? null,
        currentText: status === "changed" && unit !== undefined ? basisOf(unit) : null,
        relativePath: source.relativePath, itemStatus: unit?.todo?.item.status ?? null, priority: unit?.todo?.item.priority ?? null,
        project: source.project, at: source.at,
      };
    };
    const content = suggestion.content;
    const choices: SuggestionView["choices"] = content?.type === "judgment" ? ["option_a", "option_b", "hold"] : content?.type === "conflict" ? (content.a.scopeEditable || content.b.scopeEditable ? ["keep_scopes", "hold"] : ["hold"]) : [];
    const pendingLike = suggestion.state === "pending" || (suggestion.state === "deferred" && dueReached(suggestion.deferUntil, now));
    const blockedReason = suggestion.redacted ? "来源已删除，不能采纳。"
      : stale?.reason === "source_changed" ? "来源已更新：需先重新核对来源，重新整理会生成新修订，不覆盖当前草稿。"
        : stale?.reason === "source_unreadable" ? "有来源这次没能完整读取，先不能采纳；这不代表来源已删除。"
          : stale?.reason === "dependency_changed_during_apply" ? "采纳时来源发生了变化，已写入的部分如实列在下面。"
            : suggestion.state === "partially_applied" ? "上次采纳只完成了一部分，可以重试剩下的步骤或撤销已写入的部分。"
              : !pendingLike ? null : null;
    const canAdopt = !suggestion.redacted && stale === null && (pendingLike || suggestion.state === "partially_applied");
    const applied = (suggestion.apply?.steps ?? []).filter((step) => step.state === "written" && (step.kind === "experience_create" || step.kind === "amendment_revise" || step.kind === "relation_save" || step.kind === "todo_detail"))
      .map((step) => ({ kind: step.kind, key: step.target, relativePath: step.result?.relativePath ?? null, ok: true }));
    const result = content?.type === "experience" ? content : null;
    return {
      id: suggestion.id, type: suggestion.type, tab: SUGGESTION_TAB[suggestion.type], revision: suggestion.revision, evidenceVersion: suggestion.evidence.version,
      project: suggestion.project, state: suggestion.state === "deferred" && pendingLike ? "pending" : suggestion.state,
      stale, deferUntil: suggestion.deferUntil, reopenReason: suggestion.reopenReason,
      title: suggestion.title, why: suggestion.why, effect: suggestion.effect, unchanged: suggestion.unchanged,
      sources: suggestion.evidence.sources.map(sourceView), counter: suggestion.evidence.counter.map(sourceView),
      content, draft: suggestion.draft, automatic: suggestion.automatic ?? false,
      ...((suggestion.revises ?? revisedId(suggestion.id)) === null ? {} : { revises: suggestion.revises ?? revisedId(suggestion.id)! }),
      attribution: { reporter: result?.reporter ?? null, verification: result?.verification ?? null, generated: suggestion.model === null ? null : { model: suggestion.model.model } },
      independentEvidence: independentEvidence(suggestion.evidence.sources),
      canAdopt, blockedReason: canAdopt ? null : blockedReason,
      choices,
      canUndo: (suggestion.state === "applied" || suggestion.state === "partially_applied") && suggestion.type !== "todo_recheck" && !suggestion.redacted && !suggestion.apply?.steps.some((step) => step.kind === "experience_create" && sources.units.get(step.target)?.experience?.status === "archived"),
      applied: applied.slice(0, 10),
      steps: (suggestion.apply?.steps ?? []).map((step) => ({ kind: step.kind, state: step.state, message: step.result?.message ?? null })).slice(0, 10),
      redacted: suggestion.redacted,
      createdAt: suggestion.createdAt,
      updatedAt: suggestion.updatedAt,
    };
  }

  #damagedSnapshot(message: string): OrganizationSnapshot {
    return {
      organizationVersion: ORGANIZATION_VERSION, revision: 0, damaged: message,
      counts: { todo: 0, memory: 0, conflict: 0, pending: 0 }, suggestions: [], handled: [], run: null, activeRun: null,
      settings: { background: false, backgroundProfileId: null }, usage7d: { runs: 0, ...emptyLedger() },
      coverage: { complete: false, unreadable: [] }, methodologyHint: null,
    };
  }

  #changed(): void {
    if (this.#closed) return;
    this.#options.onChanged?.();
  }

  #mutation<T>(work: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("整理服务正在退出，未开始这次操作。"));
    const task = Promise.resolve().then(work);
    this.#mutations.add(task);
    void task.finally(() => this.#mutations.delete(task)).catch(() => undefined);
    return task;
  }

  // ------------------------------------------------------------------ decisions

  async decide(input: SuggestionDecision): Promise<SuggestionDecisionResult> {
    return this.#mutation(() => this.#decide(input));
  }

  async #decide(input: SuggestionDecision): Promise<SuggestionDecisionResult> {
    if (input.action === "adopt") return this.#adopt(input);
    const now = this.#clock();
    const at = now.toISOString();
    const result = await this.#options.store.update((state): { state: OrganizationState | null; value: SuggestionDecisionResult["status"] } => {
      const suggestion = state.suggestions[input.id];
      if (suggestion === undefined || suggestion.state === "merged") return { state: null, value: "not_found" };
      if (suggestion.revision !== input.expectedRevision || suggestion.evidence.version !== input.expectedEvidenceVersion) return { state: null, value: "revision_conflict" };
      if (input.action === "reopen") {
        if (!["rejected", "deferred", "undone"].includes(suggestion.state) || suggestion.redacted) return { state: null, value: "not_allowed" };
        state.suggestions[input.id] = { ...suggestion, state: "pending", deferUntil: null, reopenReason: "你主动重新打开。", receipts: [...suggestion.receipts, { action: "reopen" as const, at, revision: suggestion.revision }].slice(-100), updatedAt: at };
        return { state, value: "saved" };
      }
      const pendingLike = suggestion.state === "pending" || (suggestion.state === "deferred" && dueReached(suggestion.deferUntil, now));
      if (!pendingLike || suggestion.redacted) return { state: null, value: "not_allowed" };
      if (input.action === "defer") {
        state.suggestions[input.id] = { ...suggestion, state: "deferred", deferUntil: input.deferUntil!, receipts: [...suggestion.receipts, { action: "defer" as const, at, revision: suggestion.revision }].slice(-100), updatedAt: at };
        return { state, value: "saved" };
      }
      // Rejected: what it rested on kept as hashes, so the same question comes back only on new evidence.
      const evidence = Object.fromEntries(suggestion.evidence.sources.map((source) => [source.key, source.evidenceFingerprint]));
      state.suggestions[input.id] = { ...suggestion, state: "rejected", reopenReason: null, receipts: [...suggestion.receipts, { action: "reject" as const, at, revision: suggestion.revision, evidence }].slice(-100), updatedAt: at };
      return { state, value: "saved" };
    }).catch((error: unknown) => {
      if (error instanceof OrganizationDamagedError) return "damaged" as const;
      throw error;
    });
    this.#changed();
    return this.#answer(input.id, result);
  }

  async adoptMany(input: SuggestionsAdopt): Promise<SuggestionsAdoptResult> {
    return this.#mutation(async () => {
      const results: SuggestionDecisionResult[] = [];
      // One at a time: each its own adoption, none undone for another's failure.
      for (const item of input.items) results.push(await this.#decide({ ...item, action: "adopt" }));
      return { results };
    });
  }

  async saveDraft(input: SuggestionDraftSave): Promise<SuggestionDecisionResult> {
    return this.#mutation(() => this.#saveDraft(input));
  }

  async #saveDraft(input: SuggestionDraftSave): Promise<SuggestionDecisionResult> {
    const at = this.#clock().toISOString();
    const status = await this.#options.store.update((state): { state: OrganizationState | null; value: SuggestionDecisionResult["status"] } => {
      const suggestion = state.suggestions[input.id];
      if (suggestion === undefined) return { state: null, value: "not_found" };
      if (suggestion.revision !== input.expectedRevision) return { state: null, value: "revision_conflict" };
      if (suggestion.content?.type !== input.draft.type || suggestion.redacted) return { state: null, value: "not_allowed" };
      state.suggestions[input.id] = { ...suggestion, draft: input.draft, updatedAt: at };
      return { state, value: "saved" };
    }).catch((error: unknown) => {
      if (error instanceof OrganizationDamagedError) return "damaged" as const;
      throw error;
    });
    this.#changed();
    return this.#answer(input.id, status);
  }

  async #answer(id: string, status: SuggestionDecisionResult["status"], message: string | null = null): Promise<SuggestionDecisionResult> {
    let suggestion: SuggestionView | null = null;
    try {
      const state = await this.#options.store.read();
      const stored = state.suggestions[id];
      if (stored !== undefined) {
        const sources = await readSources(this.#options.readers, this.#clock());
        suggestion = this.#view(stored, sources, this.#clock(), organizationSourceAccess(state, sources));
      }
    } catch {
      suggestion = null;
    }
    return { organizationVersion: ORGANIZATION_VERSION, id, status, message, suggestion };
  }

  // ------------------------------------------------------------------ adoption

  async #adopt(input: SuggestionDecision, automaticSignal?: AbortSignal): Promise<SuggestionDecisionResult> {
    if (input.draft?.type === "experience") {
      const corrected = await this.#options.store.update((state) => {
        const previous = state.suggestions[input.id];
        if (previous?.state !== "applied" || previous.revision !== input.expectedRevision || previous.evidence.version !== input.expectedEvidenceVersion || previous.redacted) return { state: null, value: null };
        const root = previous.id.split("~r")[0]!;
        if (Object.values(state.suggestions).some((entry) => (entry.revises ?? revisedId(entry.id)) === previous.id && entry.state === "applied")) return { state: null, value: null };
        const id = `${root}~r${Object.keys(state.suggestions).filter((key) => key === root || key.startsWith(`${root}~r`)).length}`;
        state.suggestions[id] = { ...previous, id, revises: previous.id, state: "pending", revision: 1, draft: input.draft!, apply: null, appliedAt: null, automatic: false, receipts: [], createdAt: this.#clock().toISOString(), updatedAt: this.#clock().toISOString() };
        return { state, value: id };
      });
      if (corrected !== null) input = { ...input, id: corrected, expectedRevision: 1 };
    }
    while (this.#forgetting !== null) await this.#forgetting.catch(() => undefined);
    return this.#tracked(this.#adoptNow(input, automaticSignal));
  }

  #tracked<T>(work: Promise<T>): Promise<T> {
    this.#adoptions.add(work);
    void work.finally(() => this.#adoptions.delete(work)).catch(() => undefined);
    return work;
  }

  async #adoptNow(input: SuggestionDecision, automaticSignal?: AbortSignal): Promise<SuggestionDecisionResult> {
    const now = this.#clock();
    const at = now.toISOString();
    const sources = await readSources(this.#options.readers, now);
    const opId = `op-${randomUUID()}`;
    // 1. In the store's queue: checked, marked applying, and the whole plan written before any target is.
    const planned = await this.#options.store.update((state): { state: OrganizationState | null; value: { status: SuggestionDecisionResult["status"]; message?: string } } => {
      const suggestion = state.suggestions[input.id];
      if (suggestion === undefined || suggestion.state === "merged") return { state: null, value: { status: "not_found" } };
      const access = organizationSourceAccess(state, sources);
      if (automaticSignal !== undefined && (automaticSignal.aborted || state.settings.automatic !== true || !access.usable(access.suggestionInputs(suggestion)))) return { state: null, value: { status: "not_allowed" } };
      if (suggestion.state === "applying") return { state: null, value: { status: "busy" } };
      if (suggestion.revision !== input.expectedRevision || suggestion.evidence.version !== input.expectedEvidenceVersion) return { state: null, value: { status: "revision_conflict" } };
      const pendingLike = suggestion.state === "pending" || (suggestion.state === "deferred" && dueReached(suggestion.deferUntil, now)) || suggestion.state === "partially_applied";
      if (!pendingLike || suggestion.redacted || suggestion.content === null) return { state: null, value: { status: "not_allowed" } };
      // 2. Every dependency read whole and as it was judged: unread is not gone, changed is stale.
      const stale = this.#staleOf(suggestion, sources, access);
      if (stale?.reason === "source_unreadable") return { state: null, value: { status: "source_unavailable", message: "有来源这次没能完整读取，没有写入任何内容。" } };
      if (stale !== null) {
        state.suggestions[input.id] = { ...suggestion, stale, updatedAt: at };
        return { state, value: { status: "stale", message: "来源已更新，没有写入任何内容；原建议和你的编辑都还在。" } };
      }
      if (suggestion.state === "partially_applied" && suggestion.apply !== null) {
        state.suggestions[input.id] = { ...suggestion, state: "applying", automatic: automaticSignal !== undefined && suggestion.automatic === true, apply: { ...suggestion.apply, phase: "writing", steps: suggestion.apply.steps.map((step) => step.state === "failed" ? { ...step, state: "planned", result: undefined } : step) }, updatedAt: at };
        return { state, value: { status: "saved" } };
      }
      const draft = input.draft ?? suggestion.draft;
      if (input.choice === "hold" || suggestion.type === "todo_recheck") {
        const evidence = Object.fromEntries(suggestion.evidence.sources.map((source) => [source.key, source.evidenceFingerprint]));
        state.suggestions[input.id] = suggestion.type === "todo_recheck"
          ? { ...suggestion, state: "applied", appliedAt: at, receipts: [...suggestion.receipts, { action: "adopt" as const, at, revision: suggestion.revision, note: "已重新判断" }].slice(-100), updatedAt: at }
          : { ...suggestion, state: "deferred", deferUntil: null, receipts: [...suggestion.receipts, { action: "hold" as const, at, revision: suggestion.revision, evidence }].slice(-100), updatedAt: at };
        return { state, value: { status: "saved" } };
      }
      const revised = suggestion.revises ?? revisedId(suggestion.id);
      const plan = this.#plan(suggestion, draft, sources, opId, at, input.choice, revised === null ? undefined : state.suggestions[revised]);
      if ("refused" in plan) return { state: null, value: { status: "not_allowed", message: plan.refused } };
      state.suggestions[input.id] = { ...suggestion, state: "applying", automatic: automaticSignal !== undefined && suggestion.automatic === true, draft: draft ?? suggestion.draft, apply: plan, updatedAt: at };
      return { state, value: { status: "saved" } };
    }).catch((error: unknown) => {
      if (error instanceof OrganizationDamagedError) return { status: "damaged" as const };
      throw error;
    });
    this.#changed();
    if (planned.status !== "saved") return this.#answer(input.id, planned.status, "message" in planned ? planned.message ?? null : null);
    const state = await this.#options.store.read();
    if (state.suggestions[input.id]?.state !== "applying") return this.#answer(input.id, "saved");
    return this.#resumeApply(input.id);
  }

  #plan(suggestion: StoredSuggestion, draft: StoredSuggestion["draft"], sources: SourceSnapshot, opId: string, at: string, choice?: "keep_scopes" | "hold" | "option_a" | "option_b", revised?: StoredSuggestion): ApplyPlan | { refused: string } {
    let content = suggestion.content!;
    if (content.type === "judgment") {
      if (choice !== "option_a" && choice !== "option_b") return { refused: "请确认一个选项，或保留待判断。" };
      content = { type: "experience", memoryKind: "knowledge", reporter: "user", verification: "user_reported", outcome: "unknown", body: {
        title: content.question, scene: content.impact, action: "只记录选择，尚未执行。", observation: `用户确认：${content.options[choice === "option_a" ? 0 : 1]}`, inference: "这是用户本次的选择，不是自动执行授权或通用原则。", exceptions: content.unknowns,
      } };
    }
    const dependencies = suggestion.evidence.sources.map((source) => ({ key: source.key, fingerprint: sources.units.get(source.key)?.fingerprint ?? source.fingerprint }));
    const step = (n: number, kind: ApplyStep["kind"], target: string, expected: ApplyStep["expected"], before: unknown, after: unknown): ApplyStep =>
      ({ stepId: `${opId}:${n}`, kind, target, expected, before, after, state: "planned" });
    const steps: ApplyStep[] = [];
    if (content.type === "triage") {
      // 分诊保存在当前记录及其版本中；不改原始队列的确认、理由或结果。
    } else if (content.type === "todo_group") {
      steps.push(step(0, "annotation_put", `group:${suggestion.id}`, {}, null, { title: content.title, members: content.members.map((member) => member.key) }));
    } else if (content.type === "todo_context") {
      steps.push(step(0, "annotation_put", `context:${content.item}`, {}, null, { links: content.links }));
    } else if (content.type === "todo_acceptance") {
      const unit = sources.units.get(content.item);
      if (unit?.todo === undefined) return { refused: "事项已不在。" };
      const detail = draft?.type === "todo_acceptance" ? draft.draftDetail : content.draftDetail;
      steps.push(step(0, "todo_detail", content.item, { itemHash: itemHash(unit.todo.item) }, { detail: unit.todo.item.detail, status: unit.todo.item.status }, { detail }));
    } else if (content.type === "experience") {
      const edits = draft?.type === "experience" ? Object.fromEntries(Object.entries(draft.body).filter(([, value]) => value !== undefined)) : {};
      const body = { ...content.body, ...edits } as typeof content.body;
      const record: ExperienceRecord = {
        id: `exp-${sha256(suggestion.id).slice(0, 24)}`, revision: 1, status: "pending", project: suggestion.project, createdAt: at, updatedAt: at,
        ...(suggestion.type === "judgment" ? { userChoice: true as const } : {}),
        reporter: content.reporter, verification: content.verification, outcome: content.outcome, adoptedFrom: `${suggestion.id}@r${suggestion.revision}`,
        generator: suggestion.model === null ? null : { model: suggestion.model.model, promptVersion: suggestion.model.promptVersion },
        body,
        sources: suggestion.evidence.sources.map((source) => ({ key: source.key, label: source.label, excerpt: source.basis?.excerpt ?? null, hash: source.basis?.excerptHash ?? null, at: source.at })),
        ...(suggestion.inputKeys === undefined ? {} : { inputKeys: suggestion.inputKeys }),
        ...(suggestion.directInputKeys === undefined ? {} : { directInputKeys: suggestion.directInputKeys }),
      };
      steps.push(step(0, "experience_create", `experience:${record.id}`, { noteHash: null }, null, record));
      steps.push(step(1, "experience_activate", `experience:${record.id}`, {}, { status: "pending" }, { status: "active" }));
      // A revision of an adopted experience: the earlier note archived (kept, its text unchanged) once the new one is active.
      const earlier = revised?.state === "applied" ? revised.apply?.steps.find((item) => item.kind === "experience_create" && item.state === "written") : undefined;
      const note = earlier === undefined ? undefined : sources.units.get(earlier.target)?.experience;
      if (earlier !== undefined) {
        // Bound to the note as the adoption left it: changed or archived outside since, nothing is written.
        const left = revised!.apply!.steps.find((item) => item.kind === "experience_activate")?.result?.hash ?? earlier.result?.hash;
        if (note === undefined) return { refused: "被修订的经验这次没能读取，没有写入。" };
        if (note.noteHash !== left || note.status !== "active") return { refused: "被修订的经验在采纳后被改过或已不在启用，没有写入；请先查看那条经验。" };
      }
      if (earlier !== undefined && note?.status === "active") steps.push(step(2, "experience_archive", earlier.target, { noteHash: note.noteHash }, { status: "active" }, { status: "archived" }));
    } else {
      if (content.type !== "conflict") return { refused: "这类建议没有可写入的内容。" };
      if (choice !== "keep_scopes" && choice !== undefined) return { refused: "未知的处理方式。" };
      const sides = [content.a, content.b] as const;
      const proposals = [draft?.type === "conflict" ? draft.a : content.proposal.a, draft?.type === "conflict" ? draft.b : content.proposal.b];
      let n = 0;
      sides.forEach((side, at) => {
        const unit = sources.units.get(side.key);
        const proposal = proposals[at];
        if (!side.scopeEditable || proposal === null || proposal === undefined || unit?.scope === undefined) return;
        steps.push(step(n++, "amendment_revise", side.key, { contentHash: unit.scope.contentHash, revision: unit.scope.amendmentRevision }, { appliesWhen: unit.scope.appliesWhen }, { appliesWhen: proposal, source: unit.scope.source }));
      });
      if (content.proposal.relation === "unrelated") {
        const [a, b] = [sources.units.get(content.a.key), sources.units.get(content.b.key)];
        const existing = a?.relations?.find((relation) => relation.other === content.b.key);
        if (a?.scope !== undefined && b?.scope !== undefined) {
          steps.push(step(n++, "relation_save", `${content.a.key}|${content.b.key}`, { revision: existing?.revision ?? 0 }, { relation: existing?.record ?? null },
            { first: { source: a.scope.source, recordId: content.a.key.slice(content.a.key.indexOf(":") + 1), contentHash: a.scope.contentHash }, second: { source: b.scope.source, recordId: content.b.key.slice(content.b.key.indexOf(":") + 1), contentHash: b.scope.contentHash }, disposition: "unrelated" }));
        }
      }
      if (steps.length === 0) return { refused: "这两条记录都不能在这里改适用范围；可以选「暂不判断」，或到记录详情里处理。" };
    }
    return { opId, action: "adopt", dependencies, steps, phase: "planned", startedAt: at };
  }

  /** Runs the plan's steps not yet written, each marked before and after its write; then the check after, then the result. */
  async #resumeApply(id: string): Promise<SuggestionDecisionResult> {
    const read = async () => (await this.#options.store.read()).suggestions[id];
    let authorizationSources = await readSources(this.#options.readers, this.#clock());
    const authorized = (state: OrganizationState): boolean => {
      const current = state.suggestions[id];
      const access = organizationSourceAccess(state, authorizationSources);
      return current !== undefined && !current.redacted && (current.automatic !== true || (state.settings.automatic === true && access.usable(access.suggestionInputs(current))));
    };
    const mark = async (stepId: string, change: Partial<ApplyStep>, phase?: ApplyPlan["phase"]) => {
      if (change.state === "writing") authorizationSources = await readSources(this.#options.readers, this.#clock());
      return this.#options.store.update((state) => {
        const suggestion = state.suggestions[id];
        if (suggestion?.apply == null) return { state: null, value: false };
        // Admission and authorization share the state write, after any asynchronous preparation.
        const allowed = change.state !== "writing" || authorized(state);
        const next: Partial<ApplyStep> = allowed ? change : { state: "failed", result: { message: "自动维护授权或来源状态已改变，未继续写入；已有进度保留。" } };
        suggestion.apply = { ...suggestion.apply, phase: phase ?? suggestion.apply.phase, steps: suggestion.apply.steps.map((step) => step.stepId === stepId ? { ...step, ...next } : step) };
        return { state, value: allowed };
      });
    };
    let suggestion = await read();
    if (suggestion?.apply == null) return this.#answer(id, "not_found");
    const forgottenDependencies = (state: OrganizationState): string[] => suggestion!.apply!.dependencies.filter(dependency => {
      const evidence = suggestion!.evidence.sources.find(source => source.key === dependency.key);
      const forgotten = state.ledger.forgottenEvidence[dependency.key];
      return legacyForgottenSince(state, dependency.key, suggestion!.apply!.startedAt) || (forgotten !== undefined && evidence?.evidenceFingerprint === forgotten);
    }).map(dependency => dependency.key);
    // A step left writing by a quit: what the target holds now says whether it was written.
    for (const step of suggestion.apply.steps.filter((item) => item.state === "writing")) {
      const settled = await this.#settle(step, id);
      await mark(step.stepId, settled);
    }
    suggestion = (await read())!;
    const activated = suggestion.apply!.steps.find((step) => step.kind === "experience_activate");
    // 笔记已确实启用、只欠最终回执的用户选择，不因之后的源失效撤销这个独立事实。
    const confirmedBeforeResume = suggestion.type === "judgment" && suggestion.apply!.steps.every((step) => step.state === "written") && activated !== undefined && (await this.#settle(activated, id)).state === "written";
    for (const step of suggestion.apply!.steps) {
      if (step.state !== "planned" || step.kind === "experience_activate" || step.kind === "experience_archive") continue;
      // A source forgotten since the plan was made: nothing more is written from it.
      const state = await this.#options.store.read();
      if (!authorized(state)) {
        await mark(step.stepId, { state: "failed", result: { message: "自动维护授权或来源状态已改变，未继续写入；已有进度保留。" } });
        break;
      }
      if (forgottenDependencies(state).length > 0) {
        await mark(step.stepId, { state: "failed", result: { message: "来源已被遗忘或删除，没有写入" } });
        break;
      }
      if (!await mark(step.stepId, { state: "writing" }, "writing")) break;
      const outcome = await this.#execute(step, id).catch((error: unknown) => ({ state: "failed" as const, result: { message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) } }));
      await mark(step.stepId, outcome);
      if (outcome.state !== "written") break;
    }
    suggestion = (await read())!;
    const written = suggestion.apply!.steps.filter((step) => step.kind !== "experience_activate" && step.kind !== "experience_archive").every((step) => step.state === "written");
    // 4. The check after: every dependency read again; only then is an experience made visible.
    const after = await readSources(this.#options.readers, this.#clock());
    const forgottenSincePlan = async () => forgottenDependencies(await this.#options.store.read());
    const forgotten = new Set(await forgottenSincePlan());
    const moved = confirmedBeforeResume ? [] : suggestion.apply!.dependencies.filter((dependency) => {
      const unit = after.units.get(dependency.key);
      if (forgotten.has(dependency.key)) return true;
      // Not readable as it stands now (its additions, scope or relations unread): not taken as unchanged.
      if (unit === undefined || after.degraded.has(unit.kind) || unit.metadataUnreadable === true) return true;
      const target = suggestion!.apply!.steps.some((step) => step.target === dependency.key);
      // A target this adoption just wrote has moved on by its own write.
      return !target && unit.fingerprint !== dependency.fingerprint;
    });
    if (written && moved.length === 0) {
      // The new note made active first, then the one it revises archived: never neither of them in force.
      for (const step of suggestion.apply!.steps.filter((item) => (item.kind === "experience_activate" || item.kind === "experience_archive") && item.state === "planned")) {
        // Forgotten in the moment since: not made visible, and the pending note, which holds its text, goes.
        if (!authorized(await this.#options.store.read())) {
          await mark(step.stepId, { state: "failed", result: { message: "自动维护授权或来源状态已改变，未继续启用或归档。" } });
          break;
        }
        const late = await forgottenSincePlan();
        if (late.length > 0) {
          moved.push(...late.map((key) => ({ key, fingerprint: "" })));
          await mark(step.stepId, { state: "failed", result: { message: "来源已被遗忘，经验没有启用" } });
          break;
        }
        let writing: ApplyStep = step;
        if (step.kind === "experience_archive") {
          // The whole note this write will leave, down before it is made: a quit after it is settled on that, nothing else.
          const preview = await this.#options.experiences.previewProperties(step.target.slice("experience:".length), step.expected.noteHash ?? "", archived, suggestion.apply!.startedAt)
            .catch((error: unknown) => ({ status: "unavailable" as const, message: error instanceof Error ? error.message : String(error) }));
          if (preview.status !== "preview") {
            await mark(step.stepId, { state: preview.status === "unavailable" ? "failed" : "conflict", result: { message: preview.status === "unavailable" ? preview.message.slice(0, 500) : "原经验笔记在归档前被改过或已不在，没有归档" } });
            break;
          }
          writing = { ...step, expected: { ...step.expected, afterHash: preview.noteHash } };
          if (!await mark(step.stepId, { state: "writing", expected: writing.expected })) break;
        } else {
          if (!await mark(step.stepId, { state: "writing" })) break;
        }
        const outcome = await this.#execute(writing, id).catch((error: unknown) => ({ state: "failed" as const, result: { message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) } }));
        await mark(step.stepId, outcome);
        if (outcome.state !== "written") break;
      }
    }
    if (moved.length > 0) {
      // An annotation put while a dependency moved is taken back: not shown on a reading the sources no longer support.
      for (const step of suggestion.apply!.steps.filter((item) => item.kind === "annotation_put" && item.state === "written")) await this.#removeAnnotation(id, step.target);
    }
    if (moved.some((dependency) => forgotten.has(dependency.key) || dependency.fingerprint === "")) {
      // A source forgotten: the pending note made from it goes too, as written (its version checked), never left behind.
      const created = (await read())!.apply!.steps.find((item) => item.kind === "experience_create" && item.state === "written");
      if (created?.result?.hash !== undefined) {
        const trashed = await this.#options.experiences.trash(created.target.slice("experience:".length), created.result.hash, this.#options.trash).catch(() => null);
        if (trashed?.status === "saved" || trashed?.status === "not_found") this.#options.forgetVectors?.([created.target]);
      }
    }
    const at = this.#clock().toISOString();
    const status = await this.#options.store.update((state): { state: OrganizationState | null; value: SuggestionDecisionResult["status"] } => {
      const current = state.suggestions[id];
      if (current?.apply == null) return { state: null, value: "not_found" };
      // Done only when every step is written and nothing it rests on moved or went unreadable meanwhile.
      const all = current.apply.steps.every((step) => step.state === "written") && moved.length === 0;
      const stale = moved.length > 0 ? { reason: "dependency_changed_during_apply" as const, at, keys: moved.map((item) => item.key).slice(0, 50) } : current.stale;
      state.suggestions[id] = {
        ...current,
        state: all ? "applied" : "partially_applied",
        appliedAt: all ? at : current.appliedAt,
        stale: all ? null : stale,
        apply: { ...current.apply, phase: all ? "done" : "partial" },
        receipts: [...current.receipts, { action: "adopt" as const, at, revision: current.revision, ...(all ? {} : { note: "只完成了一部分" }) }].slice(-100),
        updatedAt: at,
      };
      return { state, value: all ? "saved" : "partially_applied" };
    });
    this.#changed();
    return this.#answer(id, status, status === "partially_applied" ? "只完成了一部分：已写入的步骤如实列出，没有报成全部成功。" : null);
  }

  /** What a step left writing actually did, read from its target. */
  async #settle(step: ApplyStep, suggestionId: string): Promise<Partial<ApplyStep>> {
    if (step.kind === "experience_archive") {
      const found = await this.#options.experiences.find(step.target.slice("experience:".length), { sure: true }).catch(() => undefined);
      if (found === undefined) return { state: "conflict", result: { message: "原经验笔记这次没能读取，无法确认是否已归档" } };
      if (found === null) return { state: "conflict", result: { message: "原经验笔记已不在" } };
      // Written only if the note is, byte for byte, what this write was to leave (its text and the reader's included):
      // archived some other way, or edited since, is not taken for this adoption's write.
      if (step.expected.afterHash !== undefined && found.noteHash === step.expected.afterHash) return { state: "written", result: { hash: found.noteHash, relativePath: found.relativePath } };
      if (found.noteHash === step.expected.noteHash) return { state: "planned" };
      return { state: "conflict", result: { message: "原经验笔记与这次归档应写成的内容不一致，没有当作已归档，也没有恢复启用" } };
    }
    if (step.kind === "experience_create" || step.kind === "experience_activate") {
      const id = step.target.slice("experience:".length);
      const found = await this.#options.experiences.find(id, { sure: true }).catch(() => undefined);
      if (found === undefined) return { state: "conflict", result: { message: "经验笔记这次没能读取，无法确认是否已写入" } };
      // Taken as this adoption's only when it says what the plan wrote, field by field: a note changed since (another
      // observation, other sources) is not made active, nor counted as written.
      const plan = (await this.#options.store.read()).suggestions[suggestionId]?.apply;
      const planned = plan?.steps.find((item) => item.kind === "experience_create")?.after as ExperienceRecord | undefined;
      const substance = (record: ExperienceRecord) => canonical({ ...record, status: null, revision: null, updatedAt: null });
      const ours = found !== null && planned !== undefined && substance(found.record) === substance(planned);
      if (step.kind === "experience_create") {
        if (found === null) return { state: "planned" };
        return ours ? { state: "written", result: { hash: found.noteHash, relativePath: found.relativePath } } : { state: "conflict", result: { message: "同编号的经验笔记内容与采纳时不同，没有当作已写入" } };
      }
      if (found === null || !ours) return { state: "conflict", result: { message: "经验笔记已不在或内容与采纳时不同，保持未启用" } };
      if (found.record.status === "active") return { state: "written", result: { hash: found.noteHash, relativePath: found.relativePath } };
      const created = plan?.steps.find((item) => item.kind === "experience_create")?.result?.hash;
      return found.noteHash === created ? { state: "planned" } : { state: "conflict", result: { message: "经验笔记在启用前被改过，保持未启用" } };
    }
    if (step.kind === "annotation_put") {
      const state = await this.#options.store.read();
      const there = step.target.startsWith("group:") ? state.annotations.groups[step.target.slice(6)] !== undefined : state.annotations.beforeStart[step.target.slice(8)] !== undefined;
      return { state: there ? "written" : "planned" };
    }
    if (step.kind === "todo_detail") {
      const sources = await readSources(this.#options.readers, this.#clock());
      const item = sources.units.get(step.target)?.todo?.item;
      if (item === undefined) return { state: "conflict", result: { message: "事项已不在或没能读取" } };
      if (item.detail === (step.after as { detail: string }).detail) return { state: "written" };
      return itemHash(item) === step.expected.itemHash ? { state: "planned" } : { state: "conflict", result: { message: "事项在采纳过程中被改过" } };
    }
    // Amendments and relations say their own revision: written when it moved by one from what was expected.
    const sources = await readSources(this.#options.readers, this.#clock());
    if (step.kind === "amendment_revise") {
      const unit = sources.units.get(step.target);
      if (unit?.scope === undefined) return { state: "conflict", result: { message: "记录没能读取" } };
      if (unit.scope.amendmentRevision === (step.expected.revision ?? 0) + 1 && unit.scope.appliesWhen === (step.after as { appliesWhen: string }).appliesWhen) return { state: "written", result: { revision: unit.scope.amendmentRevision } };
      return unit.scope.amendmentRevision === step.expected.revision ? { state: "planned" } : { state: "conflict", result: { message: "记录在采纳过程中被改过" } };
    }
    const [first] = step.target.split("|");
    const relation = sources.units.get(first!)?.relations?.find((item) => item.other === step.target.split("|")[1]);
    if ((relation?.revision ?? 0) === (step.expected.revision ?? 0) + 1 && relation?.disposition === "unrelated") return { state: "written", result: { revision: relation.revision } };
    return (relation?.revision ?? 0) === step.expected.revision ? { state: "planned" } : { state: "conflict", result: { message: "关系在采纳过程中被改过" } };
  }

  async #execute(step: ApplyStep, suggestionId: string): Promise<Pick<ApplyStep, "state" | "result">> {
    const reason = `整理建议 ${suggestionId} 采纳（${step.stepId}）`;
    if (step.kind === "annotation_put") {
      return this.#options.store.update<Pick<ApplyStep, "state" | "result">>((state) => {
        const suggestion = state.suggestions[suggestionId];
        if (suggestion === undefined) return { state: null, value: { state: "failed" as const, result: { message: "建议已不在" } } };
        if (step.target.startsWith("group:")) {
          const after = step.after as { title: string; members: string[] };
          state.annotations.groups[suggestionId] = { revision: suggestion.revision, title: after.title, members: after.members };
        } else {
          const key = step.target.slice("context:".length);
          const after = step.after as { links: Array<{ key: string; title: string; whyRelevant: string; scopeNote: string | null }> };
          const others = (state.annotations.beforeStart[key] ?? []).filter((entry) => entry.suggestionId !== suggestionId);
          state.annotations.beforeStart[key] = [...others, ...after.links.map((link) => ({ suggestionId, revision: suggestion.revision, link }))].slice(-5);
        }
        return { state, value: { state: "written" as const } };
      });
    }
    if (step.kind === "todo_detail") {
      const parsed = parseTodoItemSourceKey(step.target)!;
      const before = step.before as { detail: string | null; status: TodoItemRecord["status"] };
      const result = await this.#options.todos.changeItemWhere(
        { listId: parsed.listId, item: parsed.item, detail: (step.after as { detail: string }).detail, expectedDetail: before.detail, expectedStatus: before.status },
        (item) => itemHash(item) === step.expected.itemHash,
      );
      if (result.status === "saved" || result.status === "unchanged") return { state: "written" };
      return { state: result.status === "status_changed" ? "conflict" : "failed", result: { message: result.status === "status_changed" ? "事项在采纳前被改过，没有写入" : `待办写入未完成：${result.status}` } };
    }
    if (step.kind === "experience_create") {
      const written = await this.#options.experiences.create(step.after as ExperienceRecord);
      if (written.status === "saved" || written.status === "unchanged") return { state: "written", result: { hash: written.stored.noteHash, relativePath: written.stored.relativePath } };
      return { state: written.status === "conflict" ? "conflict" : "failed", result: { message: written.status === "unavailable" ? written.message.slice(0, 500) : "已有同编号但内容不同的经验笔记，没有覆盖" } };
    }
    if (step.kind === "experience_archive") {
      const startedAt = (await this.#options.store.read()).suggestions[suggestionId]?.apply?.startedAt;
      const written = await this.#options.experiences.reviseProperties(step.target.slice("experience:".length), step.expected.noteHash ?? "", archived, startedAt);
      if (written.status === "saved" && written.stored.noteHash === step.expected.afterHash) return { state: "written", result: { hash: written.stored.noteHash, relativePath: written.stored.relativePath } };
      if (written.status === "saved") return { state: "conflict", result: { message: "归档写成的内容与写前核对的不一致" } };
      return { state: written.status === "unavailable" ? "failed" : "conflict", result: { message: written.status === "unavailable" ? written.message.slice(0, 500) : "原经验笔记在归档前被改过或已不在，没有归档" } };
    }
    if (step.kind === "experience_activate") {
      const state = await this.#options.store.read();
      const created = state.suggestions[suggestionId]?.apply?.steps.find((item) => item.kind === "experience_create")?.result?.hash;
      if (created === undefined) return { state: "failed", result: { message: "经验笔记还没写入" } };
      const written = await this.#options.experiences.reviseProperties(step.target.slice("experience:".length), created, (record) => ({ status: "active", sources: record.sources }));
      if (written.status === "saved" || written.status === "unchanged") return { state: "written", result: { hash: written.stored.noteHash, relativePath: written.stored.relativePath } };
      return { state: written.status === "conflict" ? "conflict" : "failed", result: { message: written.status === "conflict" ? "经验笔记在启用前被改过，保持未启用" : "经验笔记没能启用" } };
    }
    if (step.kind === "amendment_revise") {
      const after = step.after as { appliesWhen: string; source: "decisions" | "summarize" | "preferences" | "ideas" };
      const result = await this.#options.amendments.update({
        amendVersion: DECISION_AMENDMENT_VERSION, source: after.source, recordId: step.target.slice(step.target.indexOf(":") + 1), sourceClient: "manual",
        action: "revise", basis: "user_confirmed", expectedContentHash: step.expected.contentHash!, expectedRevision: step.expected.revision ?? 0,
        fields: { appliesWhen: after.appliesWhen }, reason,
      });
      if (result.status === "saved" || result.status === "unchanged") return { state: "written", result: { revision: result.revision, ...(result.relativePath === null ? {} : { relativePath: result.relativePath }) } };
      return { state: result.status === "source_changed" || result.status === "revision_conflict" ? "conflict" : "failed", result: { message: `适用范围没有写入：${result.status}` } };
    }
    const after = step.after as { first: DecisionRelationUpdate["first"]; second: DecisionRelationUpdate["second"]; disposition: "unrelated" };
    const result = await this.#options.relations.update({ first: after.first, second: after.second, disposition: after.disposition, successor: null, reason, expectedRevision: step.expected.revision ?? 0 });
    if (result.status === "saved" || result.status === "unchanged") return { state: "written", result: { revision: result.revision } };
    return { state: result.status === "revision_conflict" || result.status === "source_changed" ? "conflict" : "failed", result: { message: `关系没有写入：${result.status}` } };
  }

  async #removeAnnotation(suggestionId: string, target: string): Promise<void> {
    await this.#options.store.update((state) => {
      if (target.startsWith("group:")) delete state.annotations.groups[suggestionId];
      else {
        const key = target.slice("context:".length);
        const left = (state.annotations.beforeStart[key] ?? []).filter((entry) => entry.suggestionId !== suggestionId);
        if (left.length === 0) delete state.annotations.beforeStart[key];
        else state.annotations.beforeStart[key] = left;
      }
      return { state, value: null };
    });
  }

  // ------------------------------------------------------------------ undo

  async undo(input: SuggestionUndo): Promise<SuggestionUndoResult> {
    return this.#mutation(() => this.#undo(input));
  }

  async #undo(input: SuggestionUndo): Promise<SuggestionUndoResult> {
    const answer = async (status: SuggestionUndoResult["status"], message: string | null = null, diff: SuggestionUndoResult["diff"] = [], diffHash: string | null = null): Promise<SuggestionUndoResult> => {
      const view = await this.#answer(input.id, "saved");
      return { organizationVersion: ORGANIZATION_VERSION, id: input.id, status, message, diff, diffHash, suggestion: view.suggestion };
    };
    let state: OrganizationState;
    try {
      state = await this.#options.store.read();
    } catch (error) {
      if (error instanceof OrganizationDamagedError) return answer("damaged");
      throw error;
    }
    const suggestion = state.suggestions[input.id];
    if (suggestion === undefined) return answer("not_found");
    if (suggestion.revision !== input.expectedRevision) return answer("revision_conflict");
    if (Object.values(state.suggestions).some((entry) => (entry.revises ?? revisedId(entry.id)) === suggestion.id && entry.state === "applied" && !entry.redacted)) return answer("not_allowed", "请先回退最新版本，再处理旧版本。");
    if ((suggestion.state !== "applied" && suggestion.state !== "partially_applied") || suggestion.apply === null || suggestion.type === "todo_recheck" || suggestion.redacted) return answer("not_allowed");
    const steps = suggestion.apply.steps.filter((step) => step.state === "written").reverse();
    const sources = await readSources(this.#options.readers, this.#clock());
    // What each written target holds now, against what the adoption left there. Kept, version and all: what is restored
    // is restored on exactly that (each write conditional on it), never on what a read after this finds.
    const diff: SuggestionUndoResult["diff"] = [];
    const versions: unknown[] = [];
    const verified = new Map<string, Verified>();
    for (const step of steps) {
      if (step.kind === "todo_detail") {
        const item = sources.units.get(step.target)?.todo?.item;
        if (item === undefined) return answer(sources.incomplete.has("todo_item") ? "source_unavailable" : "not_allowed", "事项已不在或没能读取。");
        verified.set(step.stepId, { kind: "todo", itemHash: itemHash(item), detail: item.detail, status: item.status });
        versions.push(itemHash(item));
        if (item.detail !== (step.after as { detail: string }).detail) diff.push({ target: step.target, field: "补充说明", current: item.detail, restoreTo: (step.before as { detail: string | null }).detail });
      } else if (step.kind === "experience_create") {
        const id = step.target.slice("experience:".length);
        const found = await this.#options.experiences.find(id, { sure: true }).catch(() => undefined);
        if (found === undefined) return answer("source_unavailable", "经验笔记这次没能读取。");
        if (found === null) continue;
        verified.set(step.stepId, { kind: "note", noteHash: found.noteHash });
        versions.push(found.noteHash);
        const activated = suggestion.apply.steps.find((item) => item.kind === "experience_activate")?.result?.hash ?? step.result?.hash;
        if (found.noteHash !== activated) diff.push({ target: step.target, field: "经验笔记", current: "采纳后在 Obsidian 里改过", restoreTo: "移到废纸篓（连同之后的改动）" });
      } else if (step.kind === "experience_archive") {
        const found = await this.#options.experiences.find(step.target.slice("experience:".length), { sure: true }).catch(() => undefined);
        if (found === undefined) return answer("source_unavailable", "原经验笔记这次没能读取。");
        if (found === null) continue;
        verified.set(step.stepId, { kind: "note", noteHash: found.noteHash });
        versions.push(found.noteHash);
        if (found.noteHash !== step.result?.hash) diff.push({ target: step.target, field: "原经验笔记", current: "归档后在 Obsidian 里改过", restoreTo: "恢复为启用（保留之后的改动）" });
      } else if (step.kind === "amendment_revise") {
        const unit = sources.units.get(step.target);
        if (unit?.scope === undefined || sources.degraded.has(unit.kind)) return answer("source_unavailable", "记录这次没能读取。");
        verified.set(step.stepId, { kind: "amendment", contentHash: unit.scope.contentHash, revision: unit.scope.amendmentRevision, source: unit.scope.source });
        versions.push([unit.scope.contentHash, unit.scope.amendmentRevision]);
        if (unit.scope.amendmentRevision !== step.result?.revision) diff.push({ target: step.target, field: "适用范围", current: unit.scope.appliesWhen, restoreTo: (step.before as { appliesWhen: string | null }).appliesWhen });
      } else if (step.kind === "relation_save") {
        const [first, second] = step.target.split("|");
        if (sources.degraded.has("decision") || sources.degraded.has("summary")) return answer("source_unavailable", "决策关系这次没能读取。");
        const relation = sources.units.get(first!)?.relations?.find((item) => item.other === second);
        const hashOfSide = (side: { source: string; recordId: string }) => sources.units.get(`${side.source === "decisions" ? "decision" : "summary"}:${side.recordId}`)?.scope?.contentHash ?? null;
        const before = (step.before as { relation: RelationSnapshot | null }).relation;
        const after = step.after as { first: RelationSnapshot["first"]; second: RelationSnapshot["second"] };
        verified.set(step.stepId, { kind: "relation", revision: relation?.revision ?? 0, firstHash: hashOfSide(before?.first ?? after.first), secondHash: hashOfSide(before?.second ?? after.second) });
        versions.push([relation?.revision ?? 0, hashOfSide(before?.first ?? after.first), hashOfSide(before?.second ?? after.second)]);
        if ((relation?.revision ?? 0) !== step.result?.revision) diff.push({ target: step.target, field: "关系", current: relation?.disposition ?? null, restoreTo: before === null ? "（无）" : `${before.disposition}${before.successor === null ? "" : `（后继：${before.successor}）`}` });
      }
    }
    const diffHash = hashOf({ diff, versions });
    if (diff.length > 0 && input.expectedDiffHash !== diffHash) return answer("needs_review", "采纳后内容又被改过；请看过下面的差异再确认恢复，之后的新改动不会被悄悄覆盖。", diff.slice(0, 20), diffHash);
    const failures: string[] = [];
    for (const step of steps) {
      const message = await this.#revert(step, suggestion, verified.get(step.stepId)).catch((error: unknown) => error instanceof Error ? error.message : String(error));
      if (message !== null) failures.push(message);
    }
    const at = this.#clock().toISOString();
    await this.#options.store.update((current) => {
      const now = current.suggestions[input.id];
      if (now === undefined) return { state: null, value: null };
      current.suggestions[input.id] = {
        ...now,
        state: failures.length === 0 ? "undone" : "partially_applied",
        receipts: [...now.receipts, { action: "undo" as const, at, revision: now.revision, evidence: Object.fromEntries(now.evidence.sources.map((source) => [source.key, source.evidenceFingerprint])), ...(failures.length === 0 ? {} : { note: failures.join("；").slice(0, 1_000) }) }].slice(-100),
        updatedAt: at,
      };
      return { state: current, value: null };
    });
    this.#changed();
    return answer(failures.length === 0 ? "saved" : "partially_applied", failures.length === 0 ? null : `撤销只完成了一部分：${failures.join("；")}`);
  }

  /**
   * One written step taken back on the version checked (`verified`), each write conditional on it: a target changed
   * since is left as it is and said, never restored or deleted on what it has become.
   */
  async #revert(step: ApplyStep, suggestion: StoredSuggestion, verified: Verified | undefined): Promise<string | null> {
    if (step.kind === "annotation_put") {
      await this.#removeAnnotation(suggestion.id, step.target);
      return null;
    }
    if (step.kind === "experience_activate") return null;
    if (step.kind === "experience_archive") {
      if (verified === undefined) return null; // checked and found gone already
      if (verified.kind !== "note") return "原经验笔记的版本没有核对";
      const result = await this.#options.experiences.reviseProperties(step.target.slice("experience:".length), verified.noteHash, (record) => ({ status: "active", sources: record.sources }));
      return result.status === "saved" || result.status === "unchanged" ? null : "原经验笔记在核对之后又被改过，没有恢复启用";
    }
    if (step.kind === "experience_create") {
      if (verified === undefined) return null; // checked and found gone already
      if (verified.kind !== "note") return "经验笔记的版本没有核对";
      const id = step.target.slice("experience:".length);
      const result = await this.#options.experiences.trash(id, verified.noteHash, this.#options.trash);
      if (result.status === "saved" || result.status === "not_found") {
        this.#options.forgetVectors?.([step.target]);
        return null;
      }
      return "经验笔记在核对之后又被改过，没有删除";
    }
    if (verified === undefined) return "目标的版本没有核对，没有恢复";
    if (step.kind === "todo_detail") {
      if (verified.kind !== "todo") return "事项的版本没有核对";
      const parsed = parseTodoItemSourceKey(step.target)!;
      const result = await this.#options.todos.changeItemWhere(
        { listId: parsed.listId, item: parsed.item, detail: (step.before as { detail: string | null }).detail, expectedDetail: verified.detail, expectedStatus: verified.status },
        (now) => itemHash(now) === verified.itemHash,
      );
      return result.status === "saved" || result.status === "unchanged" ? null : "事项在核对之后又被改过，没有恢复";
    }
    if (step.kind === "amendment_revise") {
      if (verified.kind !== "amendment" || step.result?.revision === undefined) return "记录的版本没有核对";
      const result = await this.#options.amendments.update({
        amendVersion: DECISION_AMENDMENT_VERSION, source: verified.source, recordId: step.target.slice(step.target.indexOf(":") + 1), sourceClient: "manual",
        action: "revert", toRevision: step.result.revision, basis: "user_confirmed", expectedContentHash: verified.contentHash, expectedRevision: verified.revision,
        reason: `撤销整理建议 ${suggestion.id} 的采纳`,
      });
      return result.status === "saved" || result.status === "unchanged" ? null : `适用范围没有恢复：${result.status}`;
    }
    if (verified.kind !== "relation" || verified.firstHash === null || verified.secondHash === null) return "关系两侧的记录没有核对，没有恢复";
    const after = step.after as { first: DecisionRelationUpdate["first"]; second: DecisionRelationUpdate["second"] };
    // What there was before, all of it (a supersedes keeps which side succeeds), on the notes as they were checked.
    const before = (step.before as { relation: RelationSnapshot | null }).relation;
    const restore: DecisionRelationUpdate = before === null
      ? { first: after.first, second: after.second, disposition: "revoked", successor: null, reason: `撤销整理建议 ${suggestion.id} 的采纳`, expectedRevision: verified.revision }
      : {
          first: { ...before.first, contentHash: verified.firstHash },
          second: { ...before.second, contentHash: verified.secondHash },
          disposition: before.disposition, successor: before.successor, reason: `撤销整理建议 ${suggestion.id} 的采纳：恢复为采纳前的关系`, expectedRevision: verified.revision,
        };
    const result = await this.#options.relations.update(restore);
    return result.status === "saved" || result.status === "unchanged" ? null : `关系没有恢复：${result.status}`;
  }

  // ------------------------------------------------------------------ forgetting

  async previewForget(input: { key: string }, options: { preserveChoices?: boolean } = {}): Promise<OrganizationForgetPreview> {
    return (await this.#forgetPlan(input, options)).preview;
  }

  /** The preview, and the notes' versions it was made on: what a confirmed forget deletes, and nothing changed since. */
  async #forgetPlan(input: { key: string }, options: { preserveChoices?: boolean } = {}): Promise<{ preview: OrganizationForgetPreview; noteHashes: Map<string, string>; forgottenEvidence: Map<string, string>; preservedTargets: Set<string>; suggestionIds: Set<string> }> {
    const state = await this.#options.store.read();
    const scan = await this.#options.experiences.scan().catch(() => null);
    const sources = await readSources(this.#options.readers, this.#clock());
    const keys = new Set([input.key]);
    const independent = new Set<string>();
    if (options.preserveChoices) {
      for (const stored of scan?.experiences ?? []) if (stored.record.userChoice && stored.record.status !== "pending") independent.add(`experience:${stored.record.id}`);
      for (const suggestion of Object.values(state.suggestions)) if (suggestion.type === "judgment" && suggestion.state === "applied") for (const step of suggestion.apply?.steps ?? []) if (step.kind === "experience_create") independent.add(step.target);
      independent.delete(input.key);
    }
    const preserved = (suggestion: StoredSuggestion) => (suggestion.state === "applied" || suggestion.type === "judgment") && suggestion.apply?.steps.some((step) => step.kind === "experience_create" && independent.has(step.target));
    const access = organizationSourceAccess(state, sources);
    const inputs = (suggestion: StoredSuggestion) => options.preserveChoices ? access.suggestionInputs(suggestion) : suggestionInputKeys(suggestion);
    // 只沿派生方向清除，不把一条摘要引用的独立来源彼此当作同一件事。
    const evidence = [...sources.units.values(), ...Object.values(state.suggestions).flatMap((entry) => [...entry.evidence.sources, ...entry.evidence.counter])];
    let size = -1;
    while (size !== keys.size) {
      size = keys.size;
      for (const source of evidence) if (!independent.has(source.key) && source.rootKeys.some((key) => keys.has(key))) keys.add(source.key);
      for (const stored of scan?.experiences ?? []) if (!independent.has(`experience:${stored.record.id}`) && (stored.record.sources.some((source) => keys.has(source.key)) || (options.preserveChoices ? stored.record.directInputKeys ?? access.inputs(stored.record.inputKeys ?? stored.record.sources.map((source) => source.key)) : stored.record.inputKeys)?.some((key) => keys.has(key)))) keys.add(`experience:${stored.record.id}`);
      // 旧笔记尚无输入字段时，用保留的建议/调用账本恢复派生方向；不反向遗忘无关输入。
      for (const suggestion of Object.values(state.suggestions)) if (!preserved(suggestion) && inputs(suggestion).some((key) => keys.has(key))) {
        for (const step of suggestion.apply?.steps ?? []) if (step.kind === "experience_create" && !independent.has(step.target)) keys.add(step.target);
      }
    }
    const experiences = (scan?.experiences ?? []).filter((stored) => keys.has(`experience:${stored.record.id}`));
    const suggestions = Object.values(state.suggestions).filter((suggestion) => !suggestion.redacted && !preserved(suggestion) && (inputs(suggestion).some((key) => keys.has(key)) || suggestion.apply?.steps.some((step) => keys.has(step.target))));
    const annotations = Object.entries(state.annotations.groups).filter(([id, group]) => group.members.some((key) => keys.has(key)) || suggestions.some((item) => item.id === id)).length +
      Object.entries(state.annotations.beforeStart).filter(([key, links]) => keys.has(key) || links.some((entry) => keys.has(entry.link.key) || suggestions.some((suggestion) => suggestion.id === entry.suggestionId))).length;
    const requestIds = [...new Set([
      ...suggestions.flatMap((suggestion) => suggestion.model?.requestIds ?? []),
      ...state.ledger.calls.filter((entry) => entry.keys.some((key) => keys.has(key))).map((entry) => entry.requestId),
    ])];
    const preview = {
      key: input.key,
      experiences: experiences.map((stored) => ({ id: stored.record.id, title: stored.record.body.title, effect: "delete" as const, relativePath: stored.relativePath })),
      suggestions: suggestions.length,
      annotations,
      vectors: experiences.length,
      modelCalls: requestIds.length,
      complete: scan !== null && scan.diagnostics.length === 0 && sources.incomplete.size === 0 && sources.degraded.size === 0,
    };
    return {
      preview: { ...preview, previewHash: hashOf({ preview, preserveChoices: options.preserveChoices === true, sourceVersions: [...keys].map((key) => [key, sources.units.get(key)?.evidenceFingerprint ?? null]), notes: experiences.map((stored) => stored.noteHash), suggestions: suggestions.map((suggestion) => [suggestion.id, suggestion.revision, suggestion.updatedAt]), requestIds }) },
      preservedTargets: independent,
      suggestionIds: new Set(suggestions.map((suggestion) => suggestion.id)),
      noteHashes: new Map(experiences.map((stored) => [stored.record.id, stored.noteHash])),
      forgottenEvidence: new Map([...keys].map((key) => [key, sources.units.get(key)?.evidenceFingerprint ?? state.ledger.forgottenEvidence[key] ?? hashOf(key)])),
    };
  }

  async forget(input: OrganizationForget, options: { preserveChoices?: boolean } = {}): Promise<OrganizationForgetResult> {
    return this.#mutation(() => this.#forget(input, options));
  }

  async #forget(input: OrganizationForget, options: { preserveChoices?: boolean }): Promise<OrganizationForgetResult> {
    while (this.#forgetting !== null) await this.#forgetting.catch(() => undefined);
    const work = (async () => {
      // An adoption under way finishes first: what it writes is then in the preview, or it sees the source forgotten.
      await Promise.allSettled([...this.#adoptions]);
      return this.#forgetNow(input, options);
    })();
    this.#forgetting = work;
    try {
      return await work;
    } finally {
      if (this.#forgetting === work) this.#forgetting = null;
    }
  }

  async #forgetNow(input: OrganizationForget, options: { preserveChoices?: boolean }): Promise<OrganizationForgetResult> {
    let preview: OrganizationForgetPreview;
    let noteHashes: Map<string, string>;
    let forgottenEvidence: Map<string, string>;
    let preservedTargets: Set<string>;
    let suggestionIds: Set<string>;
    try {
      ({ preview, noteHashes, forgottenEvidence, preservedTargets, suggestionIds } = await this.#forgetPlan({ key: input.key }, options));
    } catch (error) {
      if (error instanceof OrganizationDamagedError) return { status: "damaged", failed: [] };
      throw error;
    }
    if (!preview.complete) return { status: "incomplete_preview", failed: [] };
    if (preview.previewHash !== input.expectedPreviewHash) return { status: "preview_changed", failed: [] };
    // The versions the preview was checked on, not a read after it: a note changed since stays, and is said.
    const notes = noteHashes;
    const failed: string[] = [];
    const at = this.#clock().toISOString();
    const experienceKeys = preview.experiences.map((item) => `experience:${item.id}`);
    // Abort generation without making local forgetting wait on an unresponsive provider.
    const pendingCalls = new Set(this.#inFlightCalls);
    this.#controller?.abort("stop");
    const steps = await Promise.allSettled([
      ...preview.experiences.map(async (item) => {
        const result = await this.#options.experiences.trash(item.id, notes.get(item.id) ?? null, this.#options.trash);
        if (result.status !== "saved" && result.status !== "not_found") throw new Error(`经验「${item.title}」没有删除：${result.status === "conflict" ? "预览之后被改过" : result.status}`);
      }),
      (async () => {
        let requestIds: string[] = [];
        await this.#options.store.update((state) => {
          for (const suggestion of Object.values(state.suggestions)) {
            const preserved = options.preserveChoices && (suggestion.state === "applied" || suggestion.type === "judgment") && suggestion.apply?.steps.some((step) => step.kind === "experience_create" && step.target !== input.key && (preservedTargets.has(step.target) || (suggestion.type === "judgment" && suggestion.state === "applied")));
            const hit = suggestionIds.has(suggestion.id) || (options.preserveChoices ? suggestionDirectInputKeys(suggestion) : suggestionInputKeys(suggestion)).some((key) => forgottenEvidence.has(key)) || suggestion.apply?.steps.some((step) => experienceKeys.includes(step.target));
            if (preserved || !hit || suggestion.redacted) continue;
            requestIds = [...requestIds, ...(suggestion.model?.requestIds ?? [])];
            state.suggestions[suggestion.id] = { ...this.#redacted(suggestion, at, "forgotten"), state: "invalid" };
            delete state.annotations.groups[suggestion.id];
          }
          for (const [key, links] of Object.entries(state.annotations.beforeStart)) {
            const left = forgottenEvidence.has(key) ? [] : links.filter((entry) => !forgottenEvidence.has(entry.link.key) && state.suggestions[entry.suggestionId]?.redacted !== true);
            if (left.length === 0) delete state.annotations.beforeStart[key];
            else state.annotations.beforeStart[key] = left;
          }
          for (const [id, group] of Object.entries(state.annotations.groups)) if (group.members.some((key) => forgottenEvidence.has(key))) delete state.annotations.groups[id];
          const forgotten = new Set(forgottenEvidence.keys());
          for (const key of forgotten) { state.ledger.forgotten[key] = at; state.ledger.forgottenEvidence[key] = forgottenEvidence.get(key)!; }
          // Every call that read it, whatever it came to. Its entry stays until the record is deleted: a failed delete
          // is found again by the next preview and tried again.
          requestIds = [...requestIds, ...state.ledger.calls.filter((entry) => entry.keys.some((key) => forgotten.has(key))).map((entry) => entry.requestId)];
          if (requestIds.length > 0) state.ledger.pendingTraceDeletes = [...new Set([...(state.ledger.pendingTraceDeletes ?? []), ...requestIds])];
          for (const key of forgotten) delete state.ledger.seen[key];
          state.ledger.queue = state.ledger.queue.filter((entry) => !forgotten.has(entry.key));
          return { state, value: null };
        });
        if (requestIds.length > 0) {
          const unique = new Set(requestIds);
          await this.#options.traces.deleteRequest([...unique]);
          await this.#options.store.update((state) => {
            state.ledger.calls = state.ledger.calls.filter((entry) => !unique.has(entry.requestId) || pendingCalls.has(entry.requestId));
            const remaining = (state.ledger.pendingTraceDeletes ?? []).filter(id => !unique.has(id) || pendingCalls.has(id));
            if (remaining.length > 0) state.ledger.pendingTraceDeletes = remaining;
            else delete state.ledger.pendingTraceDeletes;
            return { state, value: null };
          });
        }
      })(),
      (async () => this.#options.forgetVectors?.([...forgottenEvidence.keys()]))(),
    ]);
    for (const step of steps) if (step.status === "rejected") failed.push(step.reason instanceof Error ? step.reason.message.slice(0, 500) : String(step.reason).slice(0, 500));
    for (const id of pendingCalls) if (!this.#inFlightCalls.has(id)) await this.#clearForgottenCalls(id).catch(() => { failed.push("遗忘留痕尚未清理完，已保留回执供重试。"); });
    if ([...pendingCalls].some(id => this.#inFlightCalls.has(id))) failed.push("已记录遗忘，仍在结束的模型调用留痕会稍后清理。");
    this.#changed();
    return { status: failed.length === 0 ? "done" : "partial", failed: failed.slice(0, 50) };
  }

  async #clearForgottenCalls(completedRequestId?: string): Promise<void> {
    const state = await this.#options.store.read();
    const ids = new Set((state.ledger.pendingTraceDeletes ?? []).filter(id =>
      completedRequestId === undefined ? !this.#inFlightCalls.has(id) : id === completedRequestId));
    if (ids.size === 0) return;
    await this.#options.traces.deleteRequest([...ids]);
    await this.#options.store.update(current => {
      current.ledger.calls = current.ledger.calls.filter(entry => !ids.has(entry.requestId));
      const remaining = (current.ledger.pendingTraceDeletes ?? []).filter(id => !ids.has(id));
      if (remaining.length > 0) current.ledger.pendingTraceDeletes = remaining;
      else delete current.ledger.pendingTraceDeletes;
      return { state: current, value: null };
    });
  }
}
