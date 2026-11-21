import type { JournalEntry, MethodologyRecord } from "@cognelis/decision-core";
import type { TodoItemRecord, TodoListRecord } from "@cognelis/decision-core";
import { todoItemSourceKey, type OrganizationSourceKind, type TodoActor, type CapturedDecisionEvent } from "@cognelis/decision-protocol";
import { amendmentKey, type DecisionContextSnapshot, type ExperienceScan, type StoredAmendment, type TodoListScan } from "@cognelis/decision-storage";

import { amendedText, amendmentUncertain, journalContentHash, validOverrides, type AmendmentSnapshot } from "./decision-context-amendments.js";
import { normalize } from "./decision-context-service.js";
import { excerptOf, hashOf, type SourceIdentity } from "./organization-core.js";

/**
 * 整理一轮读到的全部来源（IMP-191）：待办事项、决策与历史沉淀、偏好、想法、已采纳经验，各带两种指纹、角色与血缘。
 * 读不出的另记，不当作删除：某一类没读全时，那一类的来源都不能判为「已不在」。
 */
export interface SourceUnit extends SourceIdentity {
  kind: OrganizationSourceKind;
  project: string | null;
  title: string;
  label: string;
  /** 给模型看的材料（已按来源规则裁剪，处置备注不在其中）。 */
  material: string;
  /**
   * Withdrawn, archived, not yet active (a pending experience): still there, so not gone, but no input to a new
   * suggestion; its state is part of its evidence, so a suggestion resting on it is stale until it is back.
   */
  inactive?: true;
  selfGenerated?: boolean;
  /** Its own scope or relations could not be read (scopeState unavailable): there, but not as it stands; never current. */
  metadataUnreadable?: true;
  relativePath: string | null;
  at: string | null;
  reviewDue?: string | undefined;
  todo?: {
    listId: string;
    listTitle: string;
    item: TodoItemRecord;
    /** The latest status event that closed it (done/dropped) with what was said, and who said it. */
    result: { at: string; status: string; note: string | null; by: TodoActor } | null;
    lastChangedAt: string;
    archived: boolean;
  };
  /** Decisions, summaries and preferences: the 适用条件 now in force, and what an amendment writes against. */
  scope?: { appliesWhen: string | null; contentHash: string; amendmentRevision: number; editable: boolean; source: "decisions" | "summarize" | "preferences" | "ideas" } | undefined;
  experience?: { id: string; noteHash: string; status: string; sourceKeys: string[]; inputKeys?: string[]; directInputKeys?: string[]; userChoice?: boolean };
  /** Decision relations this record takes part in, for a conflict between two decisions. */
  relations?: Array<{ other: string; disposition: string; revision: number; record: RelationSnapshot }>;
}

/** A decision relation as stored: both sides, the disposition and, for supersedes, which side succeeds. */
export interface RelationSnapshot {
  first: { source: "summarize" | "decisions"; recordId: string; contentHash: string };
  second: { source: "summarize" | "decisions"; recordId: string; contentHash: string };
  disposition: "conflict" | "supersedes" | "unrelated" | "revoked";
  successor: "first" | "second" | null;
  revision: number;
}

export interface SourceSnapshot {
  units: Map<string, SourceUnit>;
  /** Kinds not read whole this time: none of theirs can be judged gone. */
  incomplete: Set<OrganizationSourceKind>;
  /**
   * Kinds whose additions, rewrites or relations could not be read: their records are there, but not as they stand,
   * so nothing resting on one may be adopted (said unreadable, never current).
   */
  degraded: Set<OrganizationSourceKind>;
  unreadable: Array<{ label: string; relativePath: string | null }>;
  readAt: string;
}

/** 候选只传语义原文，不把会话标识、工具编号和本机路径当作知识材料。 */
export const pendingConfirmationMaterial = (event: CapturedDecisionEvent): string => [
  "待确认捕获，不代表用户已确认选择：",
  ...event.questions.map((question) => [
    `问题：${question.question}`,
    ...question.options.map((option) => `备选：${option.label}${option.description === undefined ? "" : `；${option.description}`}`),
    `候选回答：${question.answer.values.join("；")}`,
    "reply" in question.answer && question.answer.reply !== undefined ? `捕获的原回复：${question.answer.reply}` : "",
  ].filter(Boolean).join("\n")),
  event.context?.taskBackground ?? "", event.context?.decisionFraming ?? "",
  event.context?.truncated ? "原始背景不完整，不能据此补造缺失信息。" : "",
].filter(Boolean).join("\n");

export interface PendingOrganizationSource {
  kind: "pending_confirmation" | "pending_rationale";
  id: string;
  project: string | null;
  title: string;
  material: string;
  at: string;
  root?: string;
}

export interface SourceReaders {
  pending?(): Promise<{ records: PendingOrganizationSource[]; complete: boolean }>;
  principles?(): Promise<{ records: MethodologyRecord[]; complete: boolean }>;
  todos(): Promise<TodoListScan>;
  journal(): Promise<{ entries: JournalEntry[]; diagnostics: Array<{ path: string; recordId?: string }>; relativePaths?: Map<string, string> | undefined }>;
  decisions(): Promise<DecisionContextSnapshot>;
  amendments(): Promise<AmendmentSnapshot>;
  experiences(): Promise<ExperienceScan>;
  /** A vault path made relative, for what is said about a note that could not be read. */
  relative(path: string): string;
}

const clip = (text: string | null | undefined, maximum: number) => (text ?? "").trim().slice(0, maximum);
/**
 * What the model is given of a field: the whole of it. Conditions and exceptions are where a limit hides (「仅测试环境」
 * in its last line), so nothing is cut here; a source too long for a call is left out of it whole and said (promptOf).
 */
const full = (text: string | null | undefined) => (text ?? "").trim();

const todoUnit = (list: TodoListRecord, relativePath: string, item: TodoItemRecord): SourceUnit => {
  const events = list.history.filter((event) => event.item === item.number);
  const result = [...events].reverse().find((event) => event.previous !== event.status && (event.status === "done" || event.status === "dropped")) ?? null;
  // An item moved in from another list keeps its first list as its root: the same finding, renumbered.
  const origin = events.find((event) => event.moved?.direction === "in")?.moved;
  const key = todoItemSourceKey(list.id, item.number);
  // What was said from the closing event on: the result, and every correction of it made later (a note alone).
  const closedAt = result === null ? -1 : events.lastIndexOf(result);
  const saying = closedAt < 0 ? [] : events.slice(closedAt).filter((event) => event.note !== null);
  const resultNote = saying.length === 0 ? null : saying.map((event) => event.note!).join("\n");
  // Any part of it an agent's: the whole is an agent's report, unverified. The user's own only when all of it is.
  const reporter: TodoActor | null = result === null ? null : saying.find((event) => event.by.kind === "agent")?.by ?? saying[0]?.by ?? result.by;
  return {
    key,
    kind: "todo_item",
    project: list.project,
    title: item.title,
    label: `清单「${list.title}」#${item.number}`,
    // What the item says and what was reported of it; never its 处置备注, the reader's instruction to an agent.
    material: [
      `标题：${item.title}`,
      item.detail === null ? "" : `补充说明：${full(item.detail)}`,
      `状态：${item.status}${item.priority === null ? "" : `，优先级 ${item.priority}`}${item.due === null ? "" : `，期限 ${item.due}`}`,
      resultNote === null ? "" : `结果说明（${reporter!.kind === "agent" ? `agent ${reporter!.client} 报告` : "用户写的"}）：${full(resultNote)}`,
    ].filter(Boolean).join("\n"),
    relativePath,
    at: result?.at ?? events.at(-1)?.at ?? list.createdAt,
    fingerprint: hashOf({ key, listProject: list.project, item, events: events.map((event) => [event.at, event.previous, event.status, event.note, event.by]) }),
    // The substance: what it says and the result said of it. Not its priority, tags, due date, times or 处置备注; a note
    // trimmed out of the history is not a change of what was said.
    evidenceFingerprint: hashOf({ title: item.title, detail: item.detail, status: item.status, result: resultNote, project: list.project }),
    role: resultNote !== null && result !== null ? "observation" : "statement",
    rootKeys: [origin === undefined ? key : todoItemSourceKey(origin.listId, origin.item)],
    lineage: origin === undefined ? "self" : "traced",
    todo: {
      listId: list.id,
      listTitle: list.title,
      item,
      result: result === null ? null : { at: result.at, status: result.status, note: resultNote, by: reporter! },
      lastChangedAt: events.at(-1)?.at ?? list.createdAt,
      archived: list.archived,
    },
  };
};

const journalUnit = (entry: JournalEntry, relativePath: string | null, record: StoredAmendment | undefined): SourceUnit => {
  const withdrawn = record?.withdrawn != null;
  const archived = entry.knowledgeStatus === "archived";
  const source = entry.kind === "preference" ? "preferences" : "ideas";
  const hash = journalContentHash(entry);
  const fields = validOverrides(record, hash);
  const content = fields?.summary ?? entry.content;
  const appliesWhen = entry.kind === "preference" ? (fields !== null && "appliesWhen" in fields ? fields.appliesWhen ?? null : entry.appliesWhen) : null;
  const exceptions = entry.kind === "preference" ? (fields !== null && "caution" in fields ? fields.caution ?? null : entry.exceptions) : null;
  const key = `${entry.kind}:${entry.id}`;
  const context = [entry.context, entry.rationale, ...(entry.kind === "idea" ? [entry.whyInteresting, ...(entry.openQuestions ?? []), entry.nextTest] : [])].filter((value) => value != null && value !== "").join("\n");
  // What was added to it later (an exception, a correction) is part of what it says now: in the material and the substance.
  const added = record === undefined ? "" : amendedText({ ...record, overrides: null }, hash);
  return {
    key,
    kind: entry.kind,
    project: entry.project,
    title: entry.title,
    label: `${entry.kind === "preference" ? "偏好" : "想法"}「${clip(entry.title, 80)}」`,
    material: [`标题：${entry.title}`, `内容：${full(content)}`, context === "" ? "" : `已记录的背景、理由与未决问题：${context}`, appliesWhen === null ? "" : `适用：${full(appliesWhen)}`, exceptions === null ? "" : `例外：${full(exceptions)}`, added === "" ? "" : `后来的增补：${full(added)}`].filter(Boolean).join("\n"),
    relativePath,
    at: entry.updatedAt,
    fingerprint: hashOf({ hash, revision: record?.revision ?? 0, overrides: fields }),
    // The project is part of what it is: moved to another, a suggestion made for the first no longer stands.
    evidenceFingerprint: hashOf({ content, context, appliesWhen, exceptions, withdrawn, archived, added, project: entry.project }),
    ...(withdrawn || archived ? { inactive: true as const } : {}),
    // A preference or idea is the user's statement; one the model summarized is derived, never evidence of its own.
    role: entry.sourceForm === "machine_summary" ? "derived" : "statement",
    rootKeys: [key],
    lineage: "self",
    // An idea's 适用条件 is not read back by any search: a scope cannot be set on it here (IMP-191 R7).
    scope: { appliesWhen, contentHash: hash, amendmentRevision: record?.revision ?? 0, editable: entry.kind === "preference", source },
  };
};

export const readSources = async (readers: SourceReaders, now: Date): Promise<SourceSnapshot> => {
  const units = new Map<string, SourceUnit>();
  const principlePaths = new Map<string, string>();
  const incomplete = new Set<OrganizationSourceKind>();
  const unreadable: SourceSnapshot["unreadable"] = [];
  const degraded = new Set<OrganizationSourceKind>();
  const failed = (kinds: OrganizationSourceKind[], label: string) => {
    for (const kind of kinds) incomplete.add(kind);
    unreadable.push({ label, relativePath: null });
  };
  const metadataFailed = (kinds: OrganizationSourceKind[], label: string) => {
    for (const kind of kinds) degraded.add(kind);
    unreadable.push({ label, relativePath: null });
  };

  const amendments = await readers.amendments().catch(() => ({ records: new Map<string, StoredAmendment>(), unavailable: true }));
  if (amendments.unavailable) metadataFailed(["decision", "summary", "preference", "idea"], "对记录的增补与修订");

  try {
    const scan = await readers.todos();
    for (const diagnostic of scan.diagnostics) unreadable.push({ label: "待办清单", relativePath: readers.relative(diagnostic.path) });
    if (scan.diagnostics.length > 0) incomplete.add("todo_item");
    for (const stored of scan.lists) for (const item of stored.list.items) {
      const unit = todoUnit(stored.list, stored.relativePath, item);
      units.set(unit.key, unit);
    }
  } catch {
    failed(["todo_item"], "待办清单");
  }

  try {
    const scan = await readers.journal();
    for (const diagnostic of scan.diagnostics) unreadable.push({ label: "偏好或想法", relativePath: readers.relative(diagnostic.path) });
    if (scan.diagnostics.length > 0) { incomplete.add("preference"); incomplete.add("idea"); }
    for (const entry of scan.entries) {
      const unit = journalUnit(entry, scan.relativePaths?.get(entry.id) ?? null, amendments.records.get(amendmentKey(entry.kind === "preference" ? "preferences" : "ideas", entry.id)));
      if (scan.diagnostics.some(item => item.recordId === entry.id) || (!amendments.unavailable && amendmentUncertain(amendments, amendmentKey(entry.kind === "preference" ? "preferences" : "ideas", entry.id)))) {
        unit.metadataUnreadable = true; incomplete.add(unit.kind);
        unreadable.push({ label: "偏好或想法的增补与撤回", relativePath: unit.relativePath });
      }
      units.set(unit.key, unit);
    }
  } catch {
    failed(["preference", "idea"], "偏好与想法");
  }

  try {
    const snapshot = await readers.decisions();
    for (const source of snapshot.sources) {
      if (source.status === "unavailable" || source.status === "partial") {
        if (source.source === "decisions") failed(["decision"], "决策");
        if (source.source === "summarize") failed(["summary"], "历史沉淀");
      }
    }
    if (snapshot.relationsUnavailable === true) metadataFailed(["decision", "summary"], "决策关系");
    const relations = new Map<string, NonNullable<SourceUnit["relations"]>>();
    for (const relation of snapshot.relations ?? []) {
      const keyOf = (side: { source: string; recordId: string }) => `${side.source === "decisions" ? "decision" : "summary"}:${side.recordId}`;
      const [first, second] = [keyOf(relation.first), keyOf(relation.second)];
      const record: RelationSnapshot = { first: relation.first, second: relation.second, disposition: relation.disposition, successor: relation.successor, revision: relation.revision };
      relations.set(first, [...(relations.get(first) ?? []), { other: second, disposition: relation.disposition, revision: relation.revision, record }]);
      relations.set(second, [...(relations.get(second) ?? []), { other: first, disposition: relation.disposition, revision: relation.revision, record }]);
    }
    for (const document of snapshot.documents) {
      if (document.source === "principles") { principlePaths.set(document.id, document.relativePath); continue; }
      if (document.contentHash === undefined) continue;
      const kind = document.source === "decisions" ? "decision" : "summary";
      const key = `${kind}:${document.id}`;
      const record = amendments.records.get(amendmentKey(document.source, document.id));
      if (!amendments.unavailable && amendmentUncertain(amendments, amendmentKey(document.source, document.id))) {
        incomplete.add(kind); unreadable.push({ label: "决策的增补与修订", relativePath: document.relativePath });
      }
      const fields = validOverrides(record, document.contentHash);
      const summary = fields?.choice ?? fields?.summary ?? document.summary;
      const rationale = fields != null && "rationale" in fields ? fields.rationale : document.rationale;
      const context = fields != null && "context" in fields ? fields.context : document.context;
      const appliesWhen = fields !== null && "appliesWhen" in fields ? fields.appliesWhen ?? null : document.appliesWhen;
      const caution = fields !== null && "caution" in fields ? fields.caution ?? null : document.caution;
      const outcome = document.outcomeState;
      const reviewed = outcome?.outcome != null && outcome.review != null;
      const inactive = record?.withdrawn != null || document.status === "archived";
      const linked = relations.get(key) ?? [];
      const added = record === undefined ? "" : amendedText({ ...record, overrides: null }, document.contentHash);
      units.set(key, {
        key,
        kind,
        ...(outcome?.review == null && outcome?.reviewDueDate != null ? { reviewDue: outcome.reviewDueDate } : {}),
        project: document.project,
        title: fields?.question ?? document.title,
        label: `${kind === "decision" ? "决策" : "历史沉淀"}「${clip(fields?.question ?? document.title, 80)}」`,
        material: [
          `标题：${fields?.question ?? document.title}`,
          `选择：${full(summary)}`,
          rationale == null ? "理由：未记录" : `用户记录的理由：${full(rationale)}`,
          context == null ? "" : `背景：${full(context)}`,
          outcome?.expectedOutcome == null ? "" : `预期（不是实际结果）：${full(outcome.expectedOutcome)}`,
          appliesWhen === null ? "" : `适用：${full(appliesWhen)}`,
          caution === null ? "" : `注意：${full(caution)}`,
          outcome?.outcome == null ? "" : `实际结果：${full(outcome.outcome)}`,
          added === "" ? "" : `后来的增补：${full(added)}`,
        ].filter(Boolean).join("\n"),
        relativePath: document.relativePath,
        at: document.occurred ?? document.created,
        fingerprint: hashOf({ hash: document.contentHash, amendment: record?.revision ?? 0, overrides: fields, relations: linked, scope: document.scopeRevision ?? 0 }),
        // Its project and recorded scope are part of it: changed, what was suggested for the old one no longer stands.
        evidenceFingerprint: hashOf({ summary, rationale, context, expected: outcome?.expectedOutcome, appliesWhen, caution, outcome: outcome?.outcome ?? null, review: outcome?.review?.verdict ?? null, relations: linked.map((item) => [item.other, item.disposition, item.record.successor]), added, project: document.project, scope: document.scope ?? null, scopeRevision: document.scopeRevision ?? 0, ...(inactive ? { inactive: true } : {}) }),
        // A decision with its result written and reviewed is an observation; one without is a statement of what was chosen.
        role: kind === "summary" ? "derived" : reviewed ? "observation" : "statement",
        rootKeys: [key],
        lineage: "self",
        scope: { appliesWhen, contentHash: document.contentHash, amendmentRevision: record?.revision ?? 0, editable: true, source: document.source },
        relations: linked,
        ...(inactive ? { inactive: true as const } : {}),
        ...(document.scopeState === "unavailable" || amendmentUncertain(amendments, amendmentKey(document.source, document.id)) ? { metadataUnreadable: true as const } : {}),
      });
    }
  } catch {
    failed(["decision", "summary"], "决策与历史沉淀");
  }

  try {
    const scan = await readers.experiences();
    for (const diagnostic of scan.diagnostics) unreadable.push({ label: "执行经验", relativePath: readers.relative(diagnostic.path) });
    if (scan.diagnostics.length > 0) incomplete.add("experience");
    for (const stored of scan.experiences) {
      const { record } = stored;
      const key = `experience:${record.id}`;
      const sourceKeys = record.sources.map((source) => source.key);
      const title = record.userChoice ? clip(record.body.observation.replace(/\s+/gu, " "), 300) : record.body.title;
      units.set(key, {
        key,
        kind: "experience",
        project: record.project,
        title,
        label: `经验「${clip(title, 80)}」`,
        // A confirmed option is a user statement; the generated framing around it is not.
        material: record.userChoice ? full(record.body.observation) : [`标题：${record.body.title}`, `场景：${full(record.body.scene)}`, `行动：${full(record.body.action)}`, `观察：${full(record.body.observation)}`, `启示：${full(record.body.inference)}`, `例外：${full(record.body.exceptions)}`].join("\n"),
        relativePath: stored.relativePath,
        at: record.updatedAt,
        fingerprint: stored.noteHash,
        evidenceFingerprint: hashOf({ body: record.body, status: record.status, project: record.project, reporter: record.reporter, verification: record.verification, userChoice: record.userChoice, sourceKeys }),
        // Made from its sources: counted through them, never as evidence of its own.
        role: record.userChoice ? "statement" : "derived",
        rootKeys: record.userChoice || sourceKeys.length === 0 ? [key] : sourceKeys,
        lineage: record.userChoice || sourceKeys.length === 0 ? "self" : "traced",
        selfGenerated: record.adoptedFrom !== null && !record.userChoice,
        experience: { id: record.id, noteHash: stored.noteHash, status: record.status, sourceKeys, ...(record.inputKeys === undefined ? {} : { inputKeys: record.inputKeys }), ...(record.directInputKeys === undefined ? {} : { directInputKeys: record.directInputKeys }), userChoice: record.userChoice === true },
        ...(record.status === "active" ? {} : { inactive: true as const }),
      });
    }
  } catch {
    failed(["experience"], "执行经验");
  }

  if (readers.pending !== undefined) {
    try {
      const pending = await readers.pending();
      if (!pending.complete) failed(["pending_confirmation", "pending_rationale"], "待处理记录未完整读取");
      for (const entry of pending.records) {
        const key = `${entry.kind}:${entry.id}`;
        const fingerprint = hashOf(entry);
        units.set(key, {
          key, kind: entry.kind, project: entry.project, title: entry.title, label: `${entry.kind === "pending_confirmation" ? "待确认" : "待补理由"}「${clip(entry.title, 80)}」`,
          material: entry.material, at: entry.at, relativePath: entry.root === undefined ? null : units.get(entry.root)?.relativePath ?? null, fingerprint, evidenceFingerprint: fingerprint,
          role: "derived", rootKeys: [entry.root ?? key], lineage: entry.root === undefined ? "self" : "traced",
        });
      }
    } catch { failed(["pending_confirmation", "pending_rationale"], "待处理记录"); }
  }
  // 复盘日期只是等待结果的信号，不证明任务已完成或需要用户立即判断。
  for (const unit of [...units.values()]) {
    if (unit.kind !== "decision" || unit.reviewDue === undefined || unit.reviewDue > now.toISOString().slice(0, 10)) continue;
    const key = `review:${unit.key.slice("decision:".length)}`;
    units.set(key, { ...unit, key, kind: "review", role: "derived", rootKeys: [unit.key], lineage: "traced", label: `需复盘「${clip(unit.title, 80)}」`, scope: undefined });
  }
  if (incomplete.has("decision")) incomplete.add("review");
  if (degraded.has("decision")) degraded.add("review");
  if (readers.principles !== undefined) {
    try {
      const scan = await readers.principles();
      if (!scan.complete) failed(["principle"], "原则");
      for (const record of scan.records) {
        const key = `principle:${record.id}`;
        const roots = record.sourceDecisionIds.map((id) => `decision:${id}`);
        const projects = new Set(roots.map((key) => units.get(key)?.project ?? null));
        const fingerprint = hashOf(record);
        units.set(key, {
          key, kind: "principle", title: record.title, label: `原则「${clip(record.title, 80)}」`, project: projects.size === 1 ? [...projects][0]! : null,
          material: `标题：${record.title}\n原则：${record.principle}\n适用：${record.appliesWhen}\n边界：${record.caution}\n依据：${record.evidenceSummary}\n状态：${record.status}`,
          at: record.updatedAt, relativePath: principlePaths.get(record.id) ?? null, fingerprint, evidenceFingerprint: fingerprint,
          role: "statement", rootKeys: roots.length === 0 ? [key] : roots, lineage: roots.length === 0 ? "self" : "traced",
          ...(record.status === "accepted" ? {} : { inactive: true as const }),
        });
      }
    } catch { failed(["principle"], "原则"); }
  }
  return { units, incomplete, degraded, unreadable: unreadable.slice(0, 50), readAt: now.toISOString() };
};

/** Whether a unit belongs to a project as the panel names it (the same comparison the todo list's own filter makes). */
export const inProject = (unit: Pick<SourceUnit, "project">, project: string | null): boolean =>
  project === null ? unit.project === null : unit.project !== null && normalize(unit.project.trim()) === normalize(project.trim());

/** A unit's excerpt for the basis of a judgment: the result said of a todo item, else what the record says. */
export const basisOf = (unit: SourceUnit): string =>
  excerptOf(unit.todo?.result?.note ?? unit.material.replace(/^标题：.*\n?/u, ""));
