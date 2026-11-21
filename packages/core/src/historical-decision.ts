import { clipText } from "@cognelis/decision-protocol";
import type {
  HistoricalDecision,
  HistoricalDecisionChange,
  HistoricalDecisionLink,
  HistoricalDecisionReference,
  HistoricalDecisionStatus,
  RecordHistoricalDecisionRequest,
  UpdateHistoricalDecisionRequest,
} from "@cognelis/decision-protocol";

/**
 * 历史决定 (Historical Decision): a choice already made, kept as a fact to trace later. No rationale is asked of
 * it, and nothing here schedules a review or reads it into the decision search: see CONTEXT.md.
 */

export const HISTORICAL_STATUS_LABELS: Readonly<Record<HistoricalDecisionStatus, string>> = {
  active: "有效",
  superseded: "已替代",
  ended: "已结束",
  withdrawn: "已撤回",
};

export const HISTORICAL_REVERSIBILITY_LABELS: Readonly<Record<NonNullable<HistoricalDecision["reversibility"]>, string>> = {
  easy: "易回退",
  costly: "改动成本高",
  irreversible: "难逆转",
};

export const HISTORICAL_SOURCE_LABELS: Readonly<Record<HistoricalDecision["sourceKind"], string>> = {
  app_manual: "手动记录",
  meeting: "会议",
  offline_conversation: "线下沟通",
  pr_comment: "PR 评论",
  agent_capture: "Agent 采集",
};

/** The fields a change may name, as a person reads them in a change's summary. */
const FIELD_LABELS = {
  title: "决定事项",
  decision: "最终决定",
  decidedOn: "决定日期",
  options: "备选方案",
  context: "当时背景",
  project: "项目",
  scope: "影响范围",
  participants: "参与方",
  sourceKind: "来源",
  reversibility: "可逆性",
  references: "相关链接",
  relatedNotes: "关联笔记",
  tags: "标签",
  notes: "补充备注",
  revisitCondition: "重看条件",
  supersedesId: "替代关系",
  statusNote: "状态说明",
} as const satisfies Partial<Record<keyof HistoricalDecision, string>>;

type WrittenField = keyof typeof FIELD_LABELS;

/** A field's value as one line of a change: lists joined, a choice by its name, nothing written as "". */
const shown = (field: WrittenField, value: HistoricalDecision[WrittenField]): string => clipText(
  value === null ? ""
    : field === "sourceKind" ? HISTORICAL_SOURCE_LABELS[value as HistoricalDecision["sourceKind"]]
    : field === "reversibility" ? HISTORICAL_REVERSIBILITY_LABELS[value as NonNullable<HistoricalDecision["reversibility"]>]
    : field === "references" ? (value as HistoricalDecisionReference[]).map((reference) => (reference.label === undefined ? reference.url : `${reference.label}（${reference.url}）`)).join("、")
    : Array.isArray(value) ? value.join("、") : String(value),
  1_000,
);

/** One of each, in the order first given: a tag or a participant is there or not. */
const unique = (values: readonly string[] | undefined): string[] => [...new Set((values ?? []).map((value) => value.trim()))];

/**
 * A related note as Obsidian links it from a property: `[[name]]`. A path or a bare name is wrapped (its `.md`
 * dropped); one already a wikilink is kept as written.
 */
export const relatedNoteLink = (value: string): string => {
  const note = value.trim();
  return /^\[\[.+\]\]$/u.test(note) ? note : `[[${note.replace(/\.md$/iu, "")}]]`;
};

const references = (values: readonly HistoricalDecisionReference[] | undefined): HistoricalDecisionReference[] => {
  const seen = new Set<string>();
  return (values ?? []).filter((reference) => !seen.has(reference.url) && seen.add(reference.url) !== undefined)
    .map((reference) => (reference.label === undefined ? { url: reference.url } : { url: reference.url, label: reference.label }));
};

/** Today on this machine's calendar: a decision is dated by the day its maker lived it, not by UTC's. */
export const localCalendarDate = (now: Date): string =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

export const createHistoricalDecision = (
  request: Omit<RecordHistoricalDecisionRequest, "version">,
  id: string,
  now: Date,
): HistoricalDecision => {
  const timestamp = now.toISOString();
  return {
    id,
    title: request.title,
    decision: request.decision,
    decidedOn: request.decidedOn ?? localCalendarDate(now),
    options: unique(request.options),
    context: request.context ?? null,
    project: request.project ?? null,
    scope: request.scope ?? null,
    participants: unique(request.participants),
    sourceKind: request.sourceKind ?? (request.sourceClient === null ? "app_manual" : "agent_capture"),
    sourceClient: request.sourceClient,
    reversibility: request.reversibility ?? null,
    references: references(request.references),
    relatedNotes: unique(request.relatedNotes?.map(relatedNoteLink)),
    tags: unique(request.tags),
    notes: request.notes ?? null,
    status: "active",
    supersedesId: request.supersedesId ?? null,
    statusNote: null,
    revisitCondition: request.revisitCondition ?? null,
    promotedDecisionId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 1,
  };
};

const folded = (value: string | null): string => (value ?? "").normalize("NFKC").trim().toLocaleLowerCase("zh-CN").replace(/\s+/gu, " ");

/**
 * What makes two records the same record: the same matter, decided the same way, on the same day, in the same
 * project. An agent asked twice to record it, or a save pressed twice, gets the one already kept.
 */
export const historicalDecisionKey = (record: Pick<HistoricalDecision, "project" | "title" | "decision" | "decidedOn">): string =>
  [record.project, record.title, record.decision, record.decidedOn].map(folded).join("\n");

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

export interface HistoricalDecisionRevision {
  record: HistoricalDecision;
  /** The fields that now read differently, as a person names them. */
  changed: string[];
  /** What those fields read before and after, for the record's history. The link to the record replaced is said, not shown as ids. */
  changes: HistoricalDecisionChange[];
}

/**
 * The record with a change applied and its revision advanced. Status and the link to a decision record are the
 * caller's to set (`status`, `promotedDecisionId`): what they mean for other records is decided where all of them
 * are in view.
 */
export const reviseHistoricalDecision = (
  current: HistoricalDecision,
  change: Omit<UpdateHistoricalDecisionRequest, "version" | "sourceClient" | "id" | "expectedRevision" | "expectedStatus" | "promote">,
  now: Date,
  system: { promotedDecisionId?: string } = {},
): HistoricalDecisionRevision => {
  const next: HistoricalDecision = { ...current };
  const changed: string[] = [];
  const changes: HistoricalDecisionChange[] = [];
  const set = <Field extends WrittenField>(field: Field, value: HistoricalDecision[Field] | undefined): void => {
    if (value === undefined || same(current[field], value)) return;
    next[field] = value;
    changed.push(FIELD_LABELS[field]);
    if (field !== "supersedesId") changes.push({ field: FIELD_LABELS[field], before: shown(field, current[field]), after: shown(field, value) });
  };
  set("title", change.title);
  set("decision", change.decision);
  set("decidedOn", change.decidedOn);
  set("options", change.options === undefined ? undefined : unique(change.options));
  set("context", change.context);
  set("project", change.project);
  set("scope", change.scope);
  set("participants", change.participants === undefined ? undefined : unique(change.participants));
  set("sourceKind", change.sourceKind);
  set("reversibility", change.reversibility);
  set("references", change.references === undefined ? undefined : references(change.references));
  set("relatedNotes", change.relatedNotes === undefined ? undefined : unique(change.relatedNotes.map(relatedNoteLink)));
  set("tags", change.tags === undefined ? undefined : unique(change.tags));
  set("notes", change.notes);
  set("revisitCondition", change.revisitCondition);
  set("supersedesId", change.supersedesId);
  set("statusNote", change.statusNote);
  if (change.status !== undefined && change.status !== current.status) {
    next.status = change.status;
    changed.push(`状态：${HISTORICAL_STATUS_LABELS[current.status]} → ${HISTORICAL_STATUS_LABELS[change.status]}`);
  }
  if (system.promotedDecisionId !== undefined) {
    next.promotedDecisionId = system.promotedDecisionId;
    changed.push("转为正式决策");
  }
  if (changed.length === 0) return { record: current, changed, changes };
  return { record: { ...next, updatedAt: now.toISOString(), revision: current.revision + 1 }, changed, changes };
};

/**
 * A change's line in a record's history, as the page and agents read it: 转为正式决策 and a new status first, then
 * the fields it rewrote (a status's note is part of the status). `changed` is a revision's, never empty.
 */
export const historicalChangeSummary = (changed: readonly string[]): string => {
  const status = changed.find((item) => item.startsWith("状态："));
  const promoted = changed.includes("转为正式决策");
  const fields = changed.filter((item) => item !== status && item !== "转为正式决策" && !(status !== undefined && item === FIELD_LABELS.statusNote));
  return [promoted ? "转为正式决策" : null, status ?? null, fields.length > 0 ? `修改：${fields.join("、")}` : null].filter((part) => part !== null).join("；");
};

/**
 * Whether naming `supersedesId` as the record `id` takes the place of would close a loop: followed from the one
 * named, the chain of 替代 comes back to `id`. A record taking its own place is the shortest such loop.
 */
export const supersedesLoop = (
  records: ReadonlyMap<string, Pick<HistoricalDecision, "supersedesId">>,
  id: string,
  supersedesId: string,
): boolean => {
  const seen = new Set<string>();
  for (let at: string | null = supersedesId; at !== null; at = records.get(at)?.supersedesId ?? null) {
    if (at === id) return true;
    // A loop already in the notes (written by hand): not this change's to make worse, and not one to walk for ever.
    if (seen.has(at)) return false;
    seen.add(at);
  }
  return false;
};

/** Each is said to a person on the page and to an agent alike: a change is refused whole, never half made. */
export const HISTORICAL_DECISION_REFUSALS = {
  /** Gone from the vault since the page listed it (deleted, moved away, or edited past reading). */
  gone: "这条历史决定在 Obsidian 里已经找不到了（可能已被删除、移走或改坏），列表已重新读取。",
  changedSince: "这条历史决定在你打开之后又被改过，已重新读取，请在最新内容上再改。",
  readOnly: "已撤回的记录是只读的，先恢复有效再修改。",
  promotedAlready: "这条历史决定已经转为正式决策，只能转一次。",
  targetGone: "要替代的那条历史决定找不到了，请重新选择。",
  targetWithdrawn: "已撤回的记录不能被替代，先恢复有效再试。",
  loop: "这样会让替代关系绕成一圈：被替代的那条（或它的前任）正是这一条的后任。",
} as const;

type Kept = readonly HistoricalDecision[];

/** Refused unless `supersedesId` names a record that `id` may take the place of. */
const replaceable = (records: Kept, id: string, supersedesId: string): void => {
  const target = records.find((record) => record.id === supersedesId);
  if (target === undefined) throw new Error(HISTORICAL_DECISION_REFUSALS.targetGone);
  if (target.status === "withdrawn") throw new Error(HISTORICAL_DECISION_REFUSALS.targetWithdrawn);
  if (supersedesLoop(new Map(records.map((record) => [record.id, record])), id, supersedesId)) throw new Error(HISTORICAL_DECISION_REFUSALS.loop);
};

/** The record `successor` takes the place of, as it reads once marked 已替代; null when there is none to mark. */
const supersededBy = (records: Kept, successor: HistoricalDecision, now: Date): HistoricalDecision | null => {
  const target = successor.supersedesId === null ? undefined : records.find((record) => record.id === successor.supersedesId);
  return target === undefined || target.status === "superseded" || target.status === "withdrawn"
    ? null
    : reviseHistoricalDecision(target, { status: "superseded" }, now).record;
};

export interface HistoricalDecisionRecordPlan {
  /** duplicate: the same matter, decision, project and day is already kept, and `record` is that one. */
  status: "created" | "duplicate";
  record: HistoricalDecision;
  /** The earlier record to write as 已替代 along with it. */
  superseded: HistoricalDecision | null;
}

/**
 * What recording `request` writes, given every record kept. Asked twice (an agent's retry, a save pressed again),
 * it is the one already kept, and whatever the first time left undone for the record it replaces.
 */
export const planHistoricalDecisionRecord = (
  records: Kept,
  request: Omit<RecordHistoricalDecisionRequest, "version">,
  id: string,
  now: Date,
): HistoricalDecisionRecordPlan => {
  const fresh = createHistoricalDecision(request, id, now);
  const duplicate = records.find((record) => record.status !== "withdrawn" && historicalDecisionKey(record) === historicalDecisionKey(fresh));
  if (duplicate !== undefined) return { status: "duplicate", record: duplicate, superseded: supersededBy(records, duplicate, now) };
  if (fresh.supersedesId !== null) replaceable(records, fresh.id, fresh.supersedesId);
  return { status: "created", record: fresh, superseded: supersededBy(records, fresh, now) };
};

export interface HistoricalDecisionUpdatePlan {
  /** The record as it reads after the change; the one kept, unchanged, when the change changes nothing. */
  record: HistoricalDecision;
  changed: string[];
  changes: HistoricalDecisionChange[];
  statusChanged: boolean;
  superseded: HistoricalDecision | null;
  /** Records that named this one as replaced, each with that link taken off: it is 有效 again. */
  released: HistoricalDecision[];
}

/**
 * What a change writes, given every record kept, or why it is refused. `promotedDecisionId` is the decision record
 * already made for a `promote`: planned once without it to see the record a decision is to be made from, then with.
 */
export const planHistoricalDecisionUpdate = (
  records: Kept,
  request: Omit<UpdateHistoricalDecisionRequest, "version" | "sourceClient">,
  now: Date,
  system: { promotedDecisionId?: string } = {},
): HistoricalDecisionUpdatePlan => {
  const { id, expectedRevision, expectedStatus, promote, ...change } = request;
  const current = records.find((record) => record.id === id);
  if (current === undefined) throw new Error(HISTORICAL_DECISION_REFUSALS.gone);
  if (current.revision !== expectedRevision || (expectedStatus !== undefined && expectedStatus !== current.status)) throw new Error(HISTORICAL_DECISION_REFUSALS.changedSince);
  // 已撤回 is read-only until it is given another status; the same change may then say more.
  if (current.status === "withdrawn" && (change.status === undefined || change.status === "withdrawn")) throw new Error(HISTORICAL_DECISION_REFUSALS.readOnly);
  if (change.supersedesId !== undefined && change.supersedesId !== null && change.supersedesId !== current.supersedesId) replaceable(records, id, change.supersedesId);
  if (promote === true && current.promotedDecisionId !== null) throw new Error(HISTORICAL_DECISION_REFUSALS.promotedAlready);
  const revised = reviseHistoricalDecision(current, change, now, system);
  const statusChanged = revised.record.status !== current.status;
  return {
    record: revised.record,
    changed: revised.changed,
    changes: revised.changes,
    statusChanged,
    superseded: revised.record.supersedesId !== current.supersedesId ? supersededBy(records, revised.record, now) : null,
    released: statusChanged && revised.record.status === "active"
      ? records.filter((record) => record.supersedesId === id).slice(0, 20).map((record) => reviseHistoricalDecision(record, { supersedesId: null }, now).record)
      : [],
  };
};

/** A record as its neighbours in a chain show it. */
export const historicalDecisionLink = ({ id, title, decision, decidedOn, status }: HistoricalDecision): HistoricalDecisionLink => ({ id, title, decision, decidedOn, status });
