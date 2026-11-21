import { JOURNAL_STANDING, type JournalEntry } from "@cognelis/decision-core";
import {
  clipText,
  contextSourcesOf,
  DECISION_CONTEXT_VERSION,
  decisionContextQuerySchema,
  decisionContextResponseSchema,
  isDecisionSource,
  isSignalSource,
  SEMANTIC_MATCH_PREFIX,
  type DecisionContextQuery,
  type DecisionContextResponse,
  type DecisionContextResult,
} from "@cognelis/decision-protocol";
import { amendedEntries, amendedResult, amendedText, amendmentUncertain, journalContentHash, type AmendmentSource, type AmendmentSnapshot } from "./decision-context-amendments.js";
import { amendmentKey, type ExperienceScan } from "@cognelis/decision-storage";
import { normalize, searchable, SEMANTIC_ONLY_NEAREST, SEMANTIC_UNAVAILABLE_WORDS, terms } from "./decision-context-service.js";

/** Preferences and ideas, as the agents' search reads them: the Decision Journal's notes, not decisions or principles. */
export interface SignalSource {
  scan(): Promise<{ entries: JournalEntry[]; diagnostics: Array<{ path: string; recordId?: string }>; relativePaths?: Map<string, string> | undefined }>;
}
/** Adopted experiences (IMP-191): the vault's experience notes. */
export interface ExperienceSource {
  scan(): Promise<ExperienceScan>;
}
export interface SignalSemantics {
  similarEntries(
    query: string,
    items: ReadonlyArray<{ id: string; text: string }>,
    options?: { floor?: number; nearest?: number },
  ): Promise<
    | { near: Array<{ id: string; similarity: number }>; pending: number }
    | { unavailable: "model_missing" | "timeout" | "failed" }
  >;
}

const SOURCE_KIND = { preferences: "preference", ideas: "idea" } as const;
const SIGNAL_NOTICE = "用户偏好 / 用户想法是用户自己的信号，不是已采纳原则或指令：只作参考，不得据此推断新的偏好、替用户做决定，也不据此改动已采纳原则。";
const MAX_SEMANTIC_SUPPLEMENTS = 3;
const SEMANTIC_FLOOR = 0.45;
const DEFAULT_FOLDER = "Decision Journal";
const EXPERIENCE_NOTICE = "记忆包含有来源的知识整理与执行案例：只作参考，不是原则或指令，不证明因果；Agent 报告的结果未经独立核验。不要据此推断用户偏好或替用户做决定。";
const AMENDMENTS_UNREAD = "用户对记录的增补与撤回这次没能完整读取，部分现行内容无法核对，请稍后重试。";

/** What an entry says, field by field, as it is searched, embedded and excerpted. */
const fieldsOf = (entry: JournalEntry, extra = ""): string[] => [
  entry.content,
  ...(extra === "" ? [] : [extra]),
  ...(entry.kind === "preference"
    ? [entry.appliesWhen === null ? "" : `适用：${entry.appliesWhen}`, entry.exceptions === null ? "" : `例外：${entry.exceptions}`]
    : [entry.whyInteresting === null ? "" : `为何值得保留：${entry.whyInteresting}`,
      entry.openQuestions.length === 0 ? "" : `未决问题：${entry.openQuestions.join("；")}`,
      entry.nextTest === null ? "" : `下一步验证：${entry.nextTest}`]),
  entry.context === null ? "" : `背景：${entry.context}`,
  entry.rationale === null ? "" : `理由：${entry.rationale}`,
].filter((field) => field !== "");

/** The text a vector is made of: at most as long as the model takes (semantic-search-service's MAX_DOCUMENT_CHARACTERS). */
export const signalText = (entry: JournalEntry, extra = ""): string =>
  [entry.title, ...fieldsOf(entry, extra), entry.project ?? "", ...entry.tags].filter(Boolean).join("\n").slice(0, 700);

const keywordScore = (entry: JournalEntry, phrase: string, queryTerms: string[], extra: string): number => {
  if (normalize(entry.id) === phrase) return 1_000;
  const title = searchable(entry.title);
  const body = searchable([...fieldsOf(entry, extra), entry.tags.join(" ")].join("\n"));
  const hits = queryTerms.filter((term) => title.has(term) || body.has(term));
  const exact = (haystack: ReturnType<typeof searchable>) => haystack.text.includes(phrase) &&
    (queryTerms.length > 1 || /\p{Script=Han}/u.test(phrase) || haystack.has(phrase));
  const phraseHit = exact(title) || exact(body);
  // As the decisions' bar, without their weighting by how rare a term is: a few dozen entries have too few to weigh.
  if (!phraseHit && (hits.length === 0 || hits.length / Math.max(1, queryTerms.length) < 0.3)) return -1;
  return (exact(title) ? 40 : phraseHit ? 15 : 0) + hits.reduce((sum, term) => sum + 20 + (title.has(term) ? 8 : 1), 0) / Math.max(1, queryTerms.length);
};

const KIND_WORD = { preference: "用户偏好", idea: "用户想法" } as const;

const toResult = (
  entry: JournalEntry,
  relativePath: string,
  reason: string,
  similarity: number | undefined,
  warnings: string[],
  extra = "",
): DecisionContextResult => {
  const text = fieldsOf(entry, extra).join("\n");
  const kept = [...(entry.knowledgeStatus === "archived" ? ["已归档：用户已收起，不要当作现行偏好或想法。"] : []), ...warnings];
  return {
    source: entry.kind === "preference" ? "preferences" : "ideas",
    kind: entry.kind,
    id: entry.id,
    title: entry.title,
    project: entry.project,
    status: entry.knowledgeStatus,
    current: entry.knowledgeStatus !== "archived",
    summary: clipText(entry.content, 4_000),
    appliesWhen: entry.kind === "preference" ? entry.appliesWhen : null,
    caution: entry.kind === "preference" ? entry.exceptions : null,
    tags: entry.tags.slice(0, 30),
    supersedes: [], supersededBy: [], successors: [], unresolvedSuccessorIds: [],
    sourceRef: {
      relativePath, client: null, sessionId: null,
      excerpt: clipText(text, 3_000), excerptStartLine: 1, truncated: text.length > 3_000,
    },
    ...(similarity === undefined ? {} : { similarity: Math.round(similarity * 1000) / 1000 }),
    matchReason: reason,
    signal: {
      standing: JOURNAL_STANDING[entry.kind],
      knowledgeStatus: entry.knowledgeStatus,
      ...(entry.kind === "preference" ? { strength: entry.strength, evidenceMaturity: entry.evidenceMaturity } : { ideaForm: entry.ideaForm }),
      languages: entry.languages,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    },
    warnings: kept,
  };
};

type Group = {
  results: DecisionContextResult[];
  /** Everything the query selected, so a page can be cut from it. */
  total: number;
  sources: DecisionContextResponse["sources"];
  excludedByScope: number;
  notes: string[];
  unavailable: boolean;
};

/**
 * search_decision_context over the decision sources and, when asked for them, preferences and ideas. Those two are
 * listed after the decisions in one list, so an offset means the same on every page: decisions first as they rank, then
 * preferences and ideas together, as the mode ranks them.
 */
export class ContextSearch {
  readonly #decisions: { search(query: DecisionContextQuery): Promise<DecisionContextResponse>; revalidate?(response: DecisionContextResponse): Promise<DecisionContextResponse> };
  readonly #signals: SignalSource | undefined;
  readonly #semantics: SignalSemantics | undefined;
  readonly #amendments: AmendmentSource | undefined;
  readonly #experiences: ExperienceSource | undefined;

  constructor(decisions: { search(query: DecisionContextQuery): Promise<DecisionContextResponse>; revalidate?(response: DecisionContextResponse): Promise<DecisionContextResponse> }, signals?: SignalSource, semantics?: SignalSemantics, amendments?: AmendmentSource, experiences?: ExperienceSource) {
    this.#decisions = decisions;
    this.#signals = signals;
    this.#semantics = semantics;
    this.#amendments = amendments;
    this.#experiences = experiences;
  }

  /** What was added to, rewritten in or withdrawn from the records; unread, said by the caller (unavailable). */
  async #records(): Promise<AmendmentSnapshot> {
    if (this.#amendments === undefined) return { records: new Map(), unavailable: false };
    try {
      const scanned = await this.#amendments.scan();
      return scanned;
    } catch {
      return { records: new Map(), unavailable: true };
    }
  }

  /** The decisions' results with their additions and rewrites in. */
  async #amended(response: DecisionContextResponse): Promise<DecisionContextResponse> {
    const { records, unavailable } = await this.#records();
    if (this.#amendments === undefined) return response;
    return {
      ...response,
      results: response.results.map((result) => result.source === "principles" ? result
        : amendedResult(result, records.get(amendmentKey(result.source, result.id)), this.#amendments!.relativePath(result.source, result.id))),
      guidance: unavailable ? `${response.guidance}\n${AMENDMENTS_UNREAD}` : response.guidance,
    };
  }

  async #decisionAnswer(found: DecisionContextResponse): Promise<DecisionContextResponse> {
    const annotated = await this.#amended(found);
    const checked = await this.#decisions.revalidate?.(found);
    return checked === undefined || checked === found ? annotated : checked;
  }

  async search(input: DecisionContextQuery): Promise<DecisionContextResponse> {
    const query = decisionContextQuerySchema.parse(input);
    const asked = contextSourcesOf(query.source);
    const signalSources = (asked ?? []).filter(isSignalSource);
    const wantsExperiences = asked?.includes("experiences") === true;
    if (signalSources.length === 0 && !wantsExperiences) return this.#decisionAnswer(await this.#decisions.search(query));
    const decisionSources = (asked ?? []).filter(isDecisionSource);
    // The signals are read as the decisions' search begins: the query's embedding runs beside both.
    const [found, initialSignals, initialExperiences] = await Promise.all([
      decisionSources.length === 0 ? Promise.resolve(null) : this.#decisions.search({ ...query, source: decisionSources }),
      signalSources.length === 0 ? Promise.resolve(null) : this.#group(query, signalSources),
      wantsExperiences ? this.#experienceResults(query) : Promise.resolve(null),
    ]);
    const decision = found === null ? null : await this.#decisionAnswer(found);
    // 所有分组的慢检索完成后再回读，避免快分组在等待另一组时返回已失效的原文。
    const experiences = initialExperiences === null ? null : await this.#validateExperiences(initialExperiences, query);
    const signals = initialSignals === null ? null : await this.#validateSignals(initialSignals);
    // Preferences and ideas first, then experiences: one list, one offset, each group in its own order.
    const parts = [signals, experiences].filter((part): part is Group => part !== null);
    const group: Group = {
      results: parts.flatMap((part) => part.results), total: parts.reduce((sum, part) => sum + part.total, 0),
      excludedByScope: parts.reduce((sum, part) => sum + part.excludedByScope, 0),
      unavailable: parts.every((part) => part.unavailable),
      sources: parts.flatMap((part) => part.sources),
      notes: parts.flatMap((part) => part.notes),
    };
    const before = decision?.total ?? 0;
    const from = Math.max(0, query.offset - before);
    const room = query.limit - (decision?.results.length ?? 0);
    const mine = group.results.slice(from, from + Math.max(0, room));
    const results = [...(decision?.results ?? []), ...mine];
    const total = before + group.total;
    const sources = [...(decision?.sources ?? []), ...group.sources];
    const unavailable = sources.every((source) => source.status === "unavailable") ||
      (query.mode === "semantic" && group.unavailable && total === 0 && (decision === null || decision.status === "unavailable"));
    const readable = sources.reduce((sum, source) => sum + source.records, 0);
    const hasFailures = sources.some((source) => source.status === "partial" || source.status === "unavailable");
    return decisionContextResponseSchema.parse({
      contextVersion: DECISION_CONTEXT_VERSION,
      status: total > 0 ? "matched" : unavailable ? "unavailable" : readable === 0 ? "empty" : "no_match",
      coverage: hasFailures ? (readable > 0 ? "partial" : "unavailable") : "complete",
      sources,
      results,
      total,
      nextOffset: query.offset + results.length < total ? query.offset + results.length : null,
      guidance: [
        decision?.guidance ?? "",
        signalSources.length === 0 ? "" : SIGNAL_NOTICE,
        ...group.notes,
        total === 0 && !unavailable && signalSources.length > 0 ? "所选来源有记录或为空，但当前编号、项目或关键词没有匹配；不能断言用户没有相关偏好或想法。" : "",
      ].filter(Boolean).join("\n"),
      ...(decision?.taskScope === undefined ? {} : { taskScope: decision.taskScope }),
      excludedByScope: (decision?.excludedByScope ?? 0) + group.excludedByScope,
      boundary: { advisoryOnly: true, noDecisionWritten: true, noPrincipleApplied: true },
    });
  }

  /**
   * Adopted experiences: active ones (archived only with includeWithdrawn), never one still pending or a candidate.
   * Each says what it is: one case with its source, not a principle, and an agent's report stays unverified.
   */
  async #validateExperiences(group: Group, query: DecisionContextQuery): Promise<Group> {
    if (group.results.length === 0 || this.#experiences === undefined) return group;
    // Checked again as it is answered: one forgotten or changed while this search ran (its note gone, its text another)
    // is not answered from the read before.
    let now: ExperienceScan;
    try {
      now = await this.#experiences.scan();
    } catch {
      return { ...group, results: [], total: 0, unavailable: true, sources: group.sources.map((source) => ({ ...source, status: "unavailable" as const })), notes: [...group.notes, "执行经验这次读取失败，不能把没有结果当作没有相关经验。"] };
    }
    const current = new Map(now.experiences.map((stored) => [stored.record.id, stored]));
    const results = group.results.filter((result) => {
      const stored = current.get(result.id);
      return stored !== undefined && stored.noteHash === result.sourceRef.contentHash && (stored.record.status === "active" || (stored.record.status === "archived" && query.includeWithdrawn === true));
    });
    if (results.length === group.results.length && now.diagnostics.length === 0) return group;
    return { ...group, results, total: results.length,
      sources: group.sources.map((source) => ({ ...source, status: "partial", skipped: Math.max(source.skipped, now.diagnostics.length) })),
      notes: [...group.notes, "检索期间有记忆变化或未能读取，本次未返回相关旧版本；可重试读取当前内容。"],
    };
  }

  async #experienceResults(query: DecisionContextQuery): Promise<Group> {
    const notes = [EXPERIENCE_NOTICE];
    const source = (status: "ready" | "empty" | "partial" | "unavailable", records: number, skipped: number) => [{ source: "experiences" as const, status, records, skipped }];
    if (query.taskScope !== undefined) notes.push("执行经验不按仓库、目录、文件或层筛选，taskScope 对它们没有作用；只按 project 筛选。");
    if (query.relation !== undefined) return { results: [], total: 0, excludedByScope: 0, unavailable: false, sources: source("empty", 0, 0), notes: [...notes, "relation 筛选只适用于决策之间的关系，执行经验没有。"] };
    let scan: ExperienceScan;
    try {
      if (this.#experiences === undefined) throw new Error("no experience source");
      scan = await this.#experiences.scan();
    } catch {
      return { results: [], total: 0, excludedByScope: 0, unavailable: true, sources: source("unavailable", 0, 0), notes: [...notes, "执行经验这次读取失败，不能把没有结果当作没有相关经验。"] };
    }
    const shown = scan.experiences.filter(({ record }) => record.status === "active" || (record.status === "archived" && query.includeWithdrawn === true)).map((stored) => {
      const { record } = stored;
      if (!record.userChoice) return stored;
      // 选择是新陈述，原问题的机器背景不随它升级为用户认可的现行依据；原笔记保留。
      return { ...stored, record: { ...record, body: { ...record.body, title: clipText(record.body.observation.replace(/\s+/gu, " "), 300), scene: "用户明确确认的独立选择", action: "只记录选择，尚未执行。", inference: "这是用户本次的选择，不是通用原则或执行授权。", exceptions: "适用条件以确认原文为准；原背景不代表现行依据。" }, sources: record.sources.map((entry) => ({ ...entry, label: "原始关联，不代表现行依据" })) } };
    });
    const skipped = scan.diagnostics.length;
    if (skipped > 0) notes.push("部分经验或其来源这次未能完整读取，结果不完整。");
    let excludedByScope = 0;
    const inScope: Array<{ stored: (typeof shown)[number]; warnings: string[] }> = [];
    for (const stored of shown) {
      const { record } = stored;
      if (query.recordId !== undefined && record.id !== query.recordId) continue;
      const warnings: string[] = [];
      if (query.project !== undefined && query.recordId === undefined) {
        if (record.project === null) warnings.push("没有明确项目归属，需核对是否适用。");
        else if (normalize(record.project) !== normalize(query.project)) {
          if (!query.includeOutOfScope) { excludedByScope += 1; continue; }
          warnings.push("记录属于其它项目，项目例外不能当作通用规则。");
        }
      }
      inScope.push({ stored, warnings });
    }
    const textOf = ({ record }: (typeof shown)[number]) => [record.body.title, record.body.scene, record.body.action, record.body.observation, record.body.inference, record.body.exceptions].join("\n");
    const resultOf = ({ stored, warnings }: (typeof inScope)[number], reason: string, similarity?: number): DecisionContextResult => {
      const { record } = stored;
      const text = textOf(stored);
      return {
        source: "experiences", kind: "experience", id: record.id, title: record.body.title, project: record.project, status: record.status, current: record.status === "active",
        summary: clipText(`${record.body.observation}\n启示：${record.body.inference}`, 4_000), appliesWhen: clipText(record.body.scene, 2_000), caution: clipText(record.body.exceptions, 2_000),
        tags: [], supersedes: [], supersededBy: [], successors: [], unresolvedSuccessorIds: [],
        sourceRef: { relativePath: stored.relativePath, client: null, sessionId: null, excerpt: clipText(text, 3_000), excerptStartLine: 1, truncated: text.length > 3_000, contentHash: stored.noteHash },
        matchReason: reason,
        ...(similarity === undefined ? {} : { similarity: Math.round(similarity * 1000) / 1000 }),
        experience: {
          reporter: record.reporter, verification: record.verification === "machine_synthesis" ? "agent_reported_unverified" : record.verification, scene: clipText(record.body.scene, 2_000), observation: clipText(record.body.observation, 3_000),
          inference: clipText(record.body.inference, 2_000), exceptions: clipText(record.body.exceptions, 2_000),
          sources: record.sources.slice(0, 20).map((item) => ({ key: item.key, label: item.label, ...(item.deleted === true ? { deleted: true as const } : {}) })),
          adoptedFrom: record.adoptedFrom,
        },
        warnings: [
          ...(record.verification === "agent_reported_unverified" ? ["Agent 报告，未独立核验。"] : record.verification === "machine_synthesis" ? ["机器整理，未独立核验；推断不代表用户认可。"] : []),
          record.userChoice ? "用户本次确认的选择，仅记录，尚未执行。" : record.verification === "machine_synthesis" ? "机器记忆，不是用户采纳的原则或指令。" : "一次案例，不是原则或因果核验。",
          ...(record.status === "archived" ? ["已归档：不要当作现行经验。"] : []),
          ...warnings,
        ].slice(0, 10),
      };
    };
    const done = (results: DecisionContextResult[], extra: string[] = [], pending = 0): Group => ({
      results, total: results.length, excludedByScope, unavailable: false, notes: [...notes, ...extra],
      sources: source(skipped > 0 || pending > 0 ? "partial" : shown.length === 0 ? "empty" : "ready", shown.length, skipped),
    });
    const byRecency = (left: (typeof inScope)[number], right: (typeof inScope)[number]) => right.stored.record.updatedAt.localeCompare(left.stored.record.updatedAt) || left.stored.record.id.localeCompare(right.stored.record.id);
    const phrase = normalize(query.query);
    if (query.recordId !== undefined || phrase === "") return done([...inScope].sort(byRecency).map((item) => resultOf(item, query.recordId !== undefined ? "编号精确匹配" : "按更新时间浏览")));
    const semantic = async (items: typeof inScope, options: { floor: number; nearest: number }) => this.#semantics === undefined ? { unavailable: "failed" as const }
      : this.#semantics.similarEntries(query.query, items.map((item) => ({ id: `experience:${item.stored.record.id}`, text: textOf(item.stored).slice(0, 700) })), options).catch(() => ({ unavailable: "failed" as const }));
    const meant = (near: Array<{ id: string; similarity: number }>, items: typeof inScope) => near.flatMap(({ id, similarity }) => {
      const item = items.find((candidate) => `experience:${candidate.stored.record.id}` === id);
      return item === undefined ? [] : [resultOf(item, `${SEMANTIC_MATCH_PREFIX}（本机向量，相似度 ${Math.round(similarity * 100)}%）：按含义排序；相关不等于适用。`, similarity)];
    });
    if (query.mode === "semantic") {
      const found = await semantic(inScope, { floor: query.minSimilarity ?? SEMANTIC_FLOOR, nearest: SEMANTIC_ONLY_NEAREST });
      if ("unavailable" in found) return { ...done([], [`执行经验的语义检索这次不可用（${SEMANTIC_UNAVAILABLE_WORDS[found.unavailable]}），没有退化成关键词结果。`]), unavailable: true };
      return done(meant(found.near, inScope), [], found.pending);
    }
    const queryTerms = terms(query.query);
    const keyword = inScope.map((item) => {
      if (normalize(item.stored.record.id) === phrase) return { item, score: 1_000 };
      const haystack = searchable(textOf(item.stored));
      const hits = queryTerms.filter((term) => haystack.has(term));
      const phraseHit = haystack.text.includes(phrase);
      return { item, score: !phraseHit && (hits.length === 0 || hits.length / Math.max(1, queryTerms.length) < 0.3) ? -1 : (phraseHit ? 15 : 0) + hits.length * 20 };
    }).filter(({ score }) => score >= 0).sort((left, right) => right.score - left.score || byRecency(left.item, right.item));
    const results = keyword.map(({ item, score }) => resultOf(item, score === 1_000 ? "编号精确匹配" : "标题或正文与查询存在词面重合；相关不等于适用。"));
    if (query.mode === "keyword") return done(results);
    const rest = inScope.filter((item) => !keyword.some((hit) => hit.item === item));
    const found = await semantic(rest, { floor: SEMANTIC_FLOOR, nearest: MAX_SEMANTIC_SUPPLEMENTS });
    if ("unavailable" in found) return done(results, ["执行经验的语义补充这次不可用，只返回关键词结果。"]);
    return done([...results, ...meant(found.near.slice(0, MAX_SEMANTIC_SUPPLEMENTS), rest)], [], found.pending);
  }

  async #validateSignals(group: Group): Promise<Group> {
    if (group.results.length === 0 || this.#signals === undefined) return group;
    const [now, amendments] = await Promise.all([this.#signals.scan().catch(() => null), this.#records()]);
    if (now === null || amendments.unavailable) return { ...group, results: [], total: 0, unavailable: true,
      sources: group.sources.map((source) => ({ ...source, status: "unavailable", records: 0 })),
      notes: [...group.notes, "检索结束前没能核对偏好、想法或撤回状态，未返回旧快照；请稍后重试。"],
    };
    const current = new Map(now.entries.map((entry) => [`${entry.kind}:${entry.id}`, entry]));
    const results = group.results.filter((result) => {
      const entry = current.get(`${result.kind}:${result.id}`);
      const record = amendments.records.get(amendmentKey(result.source, result.id));
      return !now.diagnostics.some(item => item.recordId === result.id) && !amendmentUncertain(amendments, amendmentKey(result.source, result.id)) && entry !== undefined && journalContentHash(entry) === result.sourceRef.contentHash && entry.updatedAt === result.signal?.updatedAt &&
        (now.relativePaths?.get(entry.id) ?? `${DEFAULT_FOLDER}/${entry.kind === "preference" ? "preferences" : "ideas"}/${entry.id}.md`) === result.sourceRef.relativePath &&
        (record?.revision ?? 0) === (result.amendment?.revision ?? 0);
    });
    const changed = results.length !== group.results.length;
    return { ...group, results, total: results.length,
      sources: group.sources.map((source) => {
        const skipped = now.diagnostics.filter(({ path }) => path.split(/[\\/]/u).includes(source.source)).length;
        return changed || skipped > 0 ? { ...source, status: "partial", skipped: Math.max(source.skipped, skipped) } : source;
      }),
      notes: changed ? [...group.notes, "检索期间有偏好或想法发生变化，本次未返回这些旧版本；可重试读取当前内容。"] : group.notes,
    };
  }

  async #group(query: DecisionContextQuery, signalSources: Array<"preferences" | "ideas">): Promise<Group> {
    const notes: string[] = [];
    const unavailableGroup = (why: string): Group => ({
      results: [], total: 0, excludedByScope: 0, unavailable: true,
      sources: signalSources.map((source) => ({ source, status: "unavailable" as const, records: 0, skipped: 0 })),
      notes: [why],
    });
    if (query.taskScope !== undefined) notes.push("偏好与想法不按仓库、目录、文件或层筛选，taskScope 对它们没有作用；只按 project 筛选。");
    if (query.relation !== undefined) return { ...unavailableGroup(""), unavailable: false, notes: [...notes, "relation 筛选只适用于决策之间的关系，偏好与想法没有，所以没有列出它们。"],
      sources: signalSources.map((source) => ({ source, status: "empty" as const, records: 0, skipped: 0 })) };
    let scan: Awaited<ReturnType<SignalSource["scan"]>>;
    try {
      if (this.#signals === undefined) throw new Error("no signal source");
      scan = await this.#signals.scan();
    } catch {
      return unavailableGroup("偏好与想法这次读取失败（Vault 或笔记目录无法读取），不能把没有结果当作用户没有相关偏好或想法。");
    }
    const unread = (folder: string) => scan.diagnostics.filter(({ path }) => path.split(/[\\/]/u).includes(folder)).length;
    const wantedKinds = new Set(signalSources.map((source) => SOURCE_KIND[source]));
    const ambiguous = new Set(scan.diagnostics.flatMap(item => item.recordId === undefined ? [] : [item.recordId]));
    const amendmentScan = await this.#records();
    const { records } = amendmentScan;
    if (amendmentScan.unavailable) return unavailableGroup(AMENDMENTS_UNREAD);
    const uncertain = scan.entries.filter(entry => wantedKinds.has(entry.kind) && amendmentUncertain(amendmentScan, amendmentKey(entry.kind === "preference" ? "preferences" : "ideas", entry.id)));
    if (uncertain.length > 0) notes.push(AMENDMENTS_UNREAD);
    // As they stand: those the user withdrew out (unless asked for), a rewrite in, the added texts among the fields.
    const amended = amendedEntries(scan.entries.filter((entry) => wantedKinds.has(entry.kind) && !ambiguous.has(entry.id) && !uncertain.includes(entry)), records, query.includeWithdrawn === true);
    const extraOf = new Map(amended.map(({ entry, original, record }) => [entry.id, record === undefined ? "" : amendedText({ ...record, overrides: null }, journalContentHash(original))]));
    const own = amended.map(({ entry }) => entry);
    const originalOf = new Map(amended.map(({ entry, original, record }) => [entry.id, { original, record }]));
    const counted = signalSources.map((source) => {
      const records = own.filter((entry) => entry.kind === SOURCE_KIND[source]).length;
      const skipped = Math.max(unread(source), scan.entries.filter(entry => entry.kind === SOURCE_KIND[source] && ambiguous.has(entry.id)).length) + uncertain.filter(entry => entry.kind === SOURCE_KIND[source]).length;
      return { source, status: skipped > 0 ? "partial" as const : records === 0 ? "empty" as const : "ready" as const, records, skipped };
    });
    if (counted.some((source) => source.skipped > 0)) notes.push("部分偏好或想法笔记读不出来，结果不完整。");
    const resultOf = (entry: JournalEntry, reason: string, similarity: number | undefined, warnings: string[]): DecisionContextResult => {
      const { original, record } = originalOf.get(entry.id)!;
      const result = toResult(entry, pathOf(entry), reason, similarity, warnings, extraOf.get(entry.id));
      const withHash = { ...result, sourceRef: { ...result.sourceRef, contentHash: journalContentHash(original) } };
      return this.#amendments === undefined ? withHash : amendedResult(withHash, record, this.#amendments.relativePath(entry.kind === "preference" ? "preferences" : "ideas", entry.id), clipText(original.content, 4_000));
    };
    const pathOf = (entry: JournalEntry) => scan.relativePaths?.get(entry.id) ?? `${DEFAULT_FOLDER}/${entry.kind === "preference" ? "preferences" : "ideas"}/${entry.id}.md`;
    // By id, or by project: another project's is out of scope, none recorded is said and kept.
    const excluding = query.recordId === undefined && !query.includeOutOfScope;
    let excludedByScope = 0;
    const inScope: Array<{ entry: JournalEntry; warnings: string[] }> = [];
    for (const entry of own) {
      if (query.recordId !== undefined && entry.id !== query.recordId) continue;
      const warnings: string[] = [];
      if (query.project !== undefined && query.recordId === undefined) {
        if (entry.project === null) warnings.push("没有明确项目归属；不代表可无条件跨项目使用。");
        else if (normalize(entry.project) !== normalize(query.project)) {
          if (excluding) { excludedByScope += 1; continue; }
          warnings.push("记录属于其它项目，请核对适用范围。");
        }
      }
      inScope.push({ entry, warnings });
    }
    const byRecency = (left: JournalEntry, right: JournalEntry) =>
      right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
    const phrase = normalize(query.query);
    const queryTerms = terms(query.query);
    // Vectors still being made leave the semantic part of the answer short: said as partial, not complete.
    const done = (results: DecisionContextResult[], extra: string[] = [], pending = 0): Group => ({
      results, total: results.length, excludedByScope, notes: [...notes, ...extra], unavailable: false,
      sources: pending === 0 ? counted : counted.map((source) => source.status === "ready" ? { ...source, status: "partial" as const } : source),
    });

    if (query.recordId !== undefined || phrase === "") {
      const reason = query.recordId !== undefined ? "编号精确匹配" : "按更新时间浏览";
      return done(inScope.sort((l, r) => byRecency(l.entry, r.entry)).map(({ entry, warnings }) => resultOf(entry, reason, undefined, warnings)));
    }

    const semantic = async (items: typeof inScope, options: { floor: number; nearest: number }) => {
      if (this.#semantics === undefined) return { unavailable: "failed" as const };
      return this.#semantics.similarEntries(query.query, items.map(({ entry }) => ({ id: entry.id, text: signalText(entry, extraOf.get(entry.id)) })), options)
        .catch(() => ({ unavailable: "failed" as const }));
    };
    const meant = (found: Array<{ id: string; similarity: number }>, items: typeof inScope) => found.flatMap(({ id, similarity }) => {
      const item = items.find(({ entry }) => entry.id === id);
      return item === undefined ? [] : [resultOf(item.entry, `${SEMANTIC_MATCH_PREFIX}（本机向量，相似度 ${Math.round(similarity * 100)}%）：按含义排序；相关不等于适用。`, similarity, item.warnings)];
    });
    const pendingNote = (pending: number) => pending === 0 ? [] : [`还有 ${pending} 条偏好或想法的向量正在后台建立，这次语义结果没有覆盖它们。`];

    if (query.mode === "semantic") {
      const found = await semantic(inScope, { floor: query.minSimilarity ?? SEMANTIC_FLOOR, nearest: SEMANTIC_ONLY_NEAREST });
      if ("unavailable" in found) return { ...done([], [`偏好与想法的语义检索这次不可用（${SEMANTIC_UNAVAILABLE_WORDS[found.unavailable]}），没有退化成关键词结果；这不代表没有含义相近的偏好或想法。可改用 mode=keyword。`]), unavailable: true };
      return done(meant(found.near, inScope), [`偏好与想法按本机向量的相似度排序（不低于 ${query.minSimilarity ?? SEMANTIC_FLOOR}）。`, ...pendingNote(found.pending)], found.pending);
    }

    const keyword = inScope
      .map((item) => ({ ...item, score: keywordScore(item.entry, phrase, queryTerms, extraOf.get(item.entry.id) ?? "") }))
      .filter(({ score }) => score >= 0)
      .sort((l, r) => r.score - l.score || byRecency(l.entry, r.entry));
    const results = keyword.map(({ entry, warnings, score }) => resultOf(entry, score === 1_000 ? "编号精确匹配" : "标题或正文与查询存在词面重合；相关不等于适用。", undefined, warnings));
    if (query.mode === "keyword") return done(results);
    // Hybrid: those no keyword matched and close in meaning follow, as the decisions' do.
    const rest = inScope.filter(({ entry }) => !keyword.some((item) => item.entry === entry));
    const found = await semantic(rest, { floor: SEMANTIC_FLOOR, nearest: MAX_SEMANTIC_SUPPLEMENTS });
    if ("unavailable" in found) return done(results, [`偏好与想法的语义补充这次不可用（${SEMANTIC_UNAVAILABLE_WORDS[found.unavailable]}），只返回关键词结果；没有匹配不代表没有含义相近的记录。`]);
    return done([...results, ...meant(found.near.slice(0, MAX_SEMANTIC_SUPPLEMENTS), rest)], [...pendingNote(found.pending)], found.pending);
  }
}
