import type { McpServer } from "@modelcontextprotocol/server";
import { HISTORICAL_REVERSIBILITY_LABELS, HISTORICAL_SOURCE_LABELS, HISTORICAL_STATUS_LABELS } from "@cognelis/decision-core";
import { decisionProjectFor } from "@cognelis/decision-integrations";
import {
  clipText,
  getHistoricalDecisionRequestSchema,
  HISTORICAL_DECISION_LIMITS as LIMITS,
  HISTORICAL_DECISION_VERSION,
  listHistoricalDecisionsRequestSchema,
  openHistoricalDecisionRequestSchema,
  recordHistoricalDecisionRequestSchema,
  updateHistoricalDecisionRequestSchema,
  type GetHistoricalDecisionRequest,
  type GetHistoricalDecisionResult,
  type HistoricalDecision,
  type HistoricalDecisionLink,
  type ListHistoricalDecisionsRequest,
  type ListHistoricalDecisionsResult,
  type RecordHistoricalDecisionRequest,
  type RecordHistoricalDecisionResult,
  type OpenHistoricalDecisionRequest,
  type OpenHistoricalDecisionResult,
  type UpdateHistoricalDecisionRequest,
  type UpdateHistoricalDecisionResult,
} from "@cognelis/decision-protocol";
import { z } from "zod";

import { inputReasons, localTime } from "./mcp-context.js";
import { runtimeFailureText, type RuntimeFailure, type RuntimeFailureReport } from "./runtime-client.js";

/**
 * 历史决定 for agents: a choice already made, kept as a fact to trace later (record_historical_decision), listed
 * (list_historical_decisions), read whole with its chain and changes (get_historical_decision) and changed
 * (update_historical_decision), and opened on the user's machine (open_historical_decision). The App keeps each as a note of its own under Decision Journal/history; these tools
 * only ask it. They are apart from search_decision_context on purpose: nothing recorded here is found there.
 */
export interface HistoricalDecisionRuntime {
  recordHistoricalDecision?(input: RecordHistoricalDecisionRequest, report?: RuntimeFailureReport): Promise<RecordHistoricalDecisionResult | null>;
  listHistoricalDecisions?(input: ListHistoricalDecisionsRequest, report?: RuntimeFailureReport): Promise<ListHistoricalDecisionsResult | null>;
  getHistoricalDecision?(input: GetHistoricalDecisionRequest, report?: RuntimeFailureReport): Promise<GetHistoricalDecisionResult | null>;
  updateHistoricalDecision?(input: UpdateHistoricalDecisionRequest, report?: RuntimeFailureReport): Promise<UpdateHistoricalDecisionResult | null>;
  openHistoricalDecision?(input: OpenHistoricalDecisionRequest, report?: RuntimeFailureReport): Promise<OpenHistoricalDecisionResult | null>;
}

export interface HistoricalDecisionToolOptions {
  /** A client's id, as the registry names it. */
  sourceClient: string;
  /** Where the MCP server started: a new record's project when the agent names none. */
  cwd?: string;
}

/*
 * What a client is shown: one flat object for each tool, types and words only, the limits said in them. The SDK
 * checks the advertised schema before the handler runs, and a rule checked there reaches the agent as zod's English
 * issue list: each handler checks its request against the App's own schema below, and says why in its words.
 */
const STATUSES = "active (有效), superseded (已替代), ended (已结束) or withdrawn (已撤回)";
const fields = {
  title: z.string().describe(`The matter decided, one line, up to ${LIMITS.title} characters.`),
  decision: z.string().describe(`What was decided, up to ${LIMITS.decision} characters. No rationale is asked for.`),
  decidedOn: z.string().describe("The day it was decided, YYYY-MM-DD."),
  options: z.array(z.string()).describe(`The alternatives considered at the time, one line each, up to ${LIMITS.options}; no pros and cons needed.`),
  context: z.string().describe(`The circumstances and constraints at the time (not an argument), up to ${LIMITS.context} characters.`),
  project: z.string().describe(`The project or repository, up to ${LIMITS.project} characters.`),
  scope: z.string().describe(`What it affects, finer than the project (a module, a service, a version), one line, up to ${LIMITS.scope} characters.`),
  participants: z.array(z.string()).describe(`Who took part or decided, up to ${LIMITS.participants}, each up to ${LIMITS.participant} characters.`),
  sourceKind: z.string().describe("How it came to be recorded: app_manual, meeting, offline_conversation, pr_comment or agent_capture."),
  reversibility: z.string().describe("How hard it is to undo: easy (易回退), costly (改动成本高) or irreversible (难逆转)."),
  references: z.array(z.object({ url: z.string(), label: z.string().optional() })).describe(`Links (a PR, an RFC, a ticket), up to ${LIMITS.references}: HTTPS, or HTTP on localhost, with no credentials in them.`),
  relatedNotes: z.array(z.string()).describe(`Obsidian notes it relates to, by name, path or [[wikilink]], up to ${LIMITS.relatedNotes}.`),
  tags: z.array(z.string()).describe(`Up to ${LIMITS.tags} tags, each up to ${LIMITS.tag} characters.`),
  notes: z.string().describe(`Anything else worth keeping, up to ${LIMITS.notes} characters.`),
  revisitCondition: z.string().describe(`What would make it worth looking at again, one line, up to ${LIMITS.revisitCondition} characters. A note to oneself: nothing is scheduled from it.`),
  supersedesId: z.string().describe("The id of the earlier historical decision this one takes the place of: that one is marked superseded. A loop of replacements is refused."),
};

const recordToolShape = z.object({
  title: fields.title,
  decision: fields.decision,
  decidedOn: fields.decidedOn.optional().describe("The day it was decided, YYYY-MM-DD; omitted, today."),
  options: fields.options.optional(),
  context: fields.context.optional(),
  project: fields.project.optional().describe(`${fields.project.description} Omitted, the project of the directory this session runs in.`),
  scope: fields.scope.optional(),
  participants: fields.participants.optional(),
  sourceKind: fields.sourceKind.optional().describe(`${fields.sourceKind.description} Omitted, agent_capture.`),
  reversibility: fields.reversibility.optional(),
  references: fields.references.optional(),
  relatedNotes: fields.relatedNotes.optional(),
  tags: fields.tags.optional(),
  notes: fields.notes.optional(),
  revisitCondition: fields.revisitCondition.optional(),
  supersedesId: fields.supersedesId.optional(),
});

const listToolShape = z.object({
  query: z.string().optional().describe("Words that must all appear in a record's matter, decision, context, notes, project, scope, options, tags or participants; up to 500 characters."),
  project: z.string().optional().describe("Only the records of this project (its exact name)."),
  status: z.string().optional().describe(`Only this status: ${STATUSES}. Omitted, every status but withdrawn.`),
  includeWithdrawn: z.boolean().optional().describe("With no status named, also the withdrawn ones. Default false."),
  tag: z.string().optional().describe("Only the records carrying this tag."),
  reversibility: z.string().optional().describe("Only this reversibility: easy, costly or irreversible."),
  fromDate: z.string().optional().describe("Decided on or after this day, YYYY-MM-DD."),
  toDate: z.string().optional().describe("Decided on or before this day, YYYY-MM-DD."),
  limit: z.number().int().optional().describe("Records per page, 1 to 50, default 20."),
  offset: z.number().int().optional().describe("Default 0: the previous page's nextOffset, the other parameters unchanged."),
});

const getToolShape = z.object({ id: z.string().describe("The record's id, as record_historical_decision or list_historical_decisions gave it.") });

const openToolShape = z.object({
  id: getToolShape.shape.id,
  link: z.string().optional().describe("One of the record's own links (references[].url), to open in the browser instead of its note."),
  relatedNote: z.string().optional().describe("One of the record's related notes (relatedNotes), to open in Obsidian instead of its note."),
});

const cleared = <T extends z.ZodType>(field: T) => field.nullable().optional();
const updateToolShape = z.object({
  id: getToolShape.shape.id,
  expectedRevision: z.number().int().describe("The record's revision as you just read it: changed since, the update is refused and you read it again."),
  expectedStatus: z.string().optional().describe("Required with status: the status as you just read it."),
  title: fields.title.optional(),
  decision: fields.decision.optional(),
  decidedOn: fields.decidedOn.optional(),
  options: fields.options.optional().describe(`${fields.options.description} Replaced as a whole; [] clears them.`),
  context: cleared(fields.context).describe(`${fields.context.description} null clears it.`),
  project: cleared(fields.project).describe(`${fields.project.description} null clears it.`),
  scope: cleared(fields.scope).describe(`${fields.scope.description} null clears it.`),
  participants: fields.participants.optional().describe(`${fields.participants.description} Replaced as a whole.`),
  sourceKind: fields.sourceKind.optional(),
  reversibility: cleared(fields.reversibility).describe(`${fields.reversibility.description} null clears it.`),
  references: fields.references.optional().describe(`${fields.references.description} Replaced as a whole.`),
  relatedNotes: fields.relatedNotes.optional().describe(`${fields.relatedNotes.description} Replaced as a whole.`),
  tags: fields.tags.optional().describe(`${fields.tags.description} Replaced as a whole.`),
  notes: cleared(fields.notes).describe(`${fields.notes.description} null clears it.`),
  revisitCondition: cleared(fields.revisitCondition).describe(`${fields.revisitCondition.description} null clears it.`),
  supersedesId: cleared(fields.supersedesId).describe(`${fields.supersedesId.description} null takes the link off.`),
  status: z.string().optional().describe(`The new status: ${STATUSES}. withdrawn is how a record is taken back: its note and history stay, and it is read-only until given another status. Setting active on a superseded record also takes the replacement link off the records that replaced it.`),
  statusNote: cleared(z.string()).describe(`A line on why the status changed, up to ${LIMITS.statusNote} characters; null clears it.`),
  promote: z.boolean().optional().describe("true makes a formal decision record from this one, once: from then on that record takes part in search_decision_context, the rationale queue and reviews, and this one stays as it is, linked to it. Only when the user asks for exactly that."),
});

type RecordInput = z.infer<typeof recordToolShape>;
type ListInput = z.infer<typeof listToolShape>;
type UpdateInput = z.infer<typeof updateToolShape>;

// The rules the App's schemas keep, said as what to change. No rule holds a `；`: it is what separates them.
const inputRules: Record<string, string> = {
  "must be a single line": "title、scope、project、revisitCondition 以及 options、participants、tags、relatedNotes 的每一项都只能写一行",
  "links are HTTPS (or HTTP on loopback) without credentials": "references 里的 url 要是 https 链接（或本机的 http 链接），不能带账号密码",
  "a status change carries expectedStatus": "改 status 时要带 expectedStatus（刚读到的状态）",
  "nothing to change": "至少要提供一项要改的内容",
};

const refused = <S extends Record<string, unknown>>(text: string, structured: S) =>
  ({ isError: true, content: [{ type: "text" as const, text }], structuredContent: { message: text, ...structured } });

const invalid = <S extends Record<string, unknown>>(what: string, error: z.ZodError, structured: S) =>
  refused(`${what}：输入不符合要求（${inputReasons(error, inputRules)}）。按要求改正后再试。`, structured);

const asked = async <T>(call: ((report: RuntimeFailureReport) => Promise<T | null>) | undefined): Promise<{ answer: T } | { failure: RuntimeFailure }> => {
  let failure = { reason: "not_running" } as RuntimeFailure;
  const answer = await call?.((reported) => { failure = reported; }).catch(() => null) ?? null;
  return answer === null ? { failure } : { answer };
};

const clip = (text: string, length: number): string => {
  const characters = Array.from(text.replace(/\s+/gu, " "));
  return characters.length <= length ? characters.join("") : `${characters.slice(0, length).join("").trimEnd()}…`;
};

/** One line a record: enough to pick it by, and its id to read it whole. */
const line = (record: HistoricalDecision | HistoricalDecisionLink): string => {
  const more = "project" in record
    ? [record.project, record.scope, record.supersedesId === null ? null : `替代 ${record.supersedesId}`, record.promotedDecisionId === null ? null : `已转正式决策 ${record.promotedDecisionId}`].filter((part) => part !== null)
    : [];
  return `${record.id} [${HISTORICAL_STATUS_LABELS[record.status]}] ${record.decidedOn} ${record.title} → ${clip(record.decision, 120)}${more.length === 0 ? "" : `（${more.join("；")}）`}`;
};

const NOT_SEARCHED = "历史决定只是留档：不进入 search_decision_context，也不进入待补理由和复盘。";

const whole = (record: HistoricalDecision): string[] => [
  `${record.id} [${HISTORICAL_STATUS_LABELS[record.status]}] 修订 ${record.revision}`,
  `决定事项：${record.title}`,
  `最终决定：${record.decision}`,
  `决定日期：${record.decidedOn}`,
  ...(record.options.length === 0 ? [] : [`备选方案：${record.options.join("；")}`]),
  ...(record.context === null ? [] : [`当时背景：${record.context}`]),
  ...(record.project === null ? [] : [`项目：${record.project}`]),
  ...(record.scope === null ? [] : [`影响范围：${record.scope}`]),
  ...(record.participants.length === 0 ? [] : [`参与方：${record.participants.join("、")}`]),
  `来源：${HISTORICAL_SOURCE_LABELS[record.sourceKind]}${record.sourceClient === null ? "" : `（${record.sourceClient}）`}`,
  ...(record.reversibility === null ? [] : [`可逆性：${HISTORICAL_REVERSIBILITY_LABELS[record.reversibility]}`]),
  ...(record.references.length === 0 ? [] : [`相关链接：${record.references.map((reference) => (reference.label === undefined ? reference.url : `${reference.label} ${reference.url}`)).join("；")}`]),
  ...(record.relatedNotes.length === 0 ? [] : [`关联笔记：${record.relatedNotes.join("、")}`]),
  ...(record.tags.length === 0 ? [] : [`标签：${record.tags.join("、")}`]),
  ...(record.notes === null ? [] : [`补充备注：${record.notes}`]),
  ...(record.statusNote === null ? [] : [`状态说明：${record.statusNote}`]),
  ...(record.revisitCondition === null ? [] : [`重看条件（只是备忘，不会提醒）：${record.revisitCondition}`]),
  ...(record.promotedDecisionId === null ? [] : [`已转为正式决策：${record.promotedDecisionId}（理由、预期和复盘在那一条里）`]),
];

export const recordHistoricalDecision = async (input: RecordInput, runtime: HistoricalDecisionRuntime, options: HistoricalDecisionToolOptions) => {
  const none = { status: null, record: null, supersededId: null };
  const checked = recordHistoricalDecisionRequestSchema.safeParse({
    ...input,
    version: HISTORICAL_DECISION_VERSION,
    sourceClient: options.sourceClient,
    project: input.project?.trim() || await decisionProjectFor(options.cwd ?? process.cwd()),
  });
  if (!checked.success) return invalid("没有记录这条历史决定", checked.error, none);
  const result = await asked<RecordHistoricalDecisionResult>((report) => runtime.recordHistoricalDecision?.(checked.data, report) ?? Promise.resolve(null));
  if ("failure" in result) return refused(`${runtimeFailureText(result.failure)}这条历史决定没有记录。`, none);
  const { status, record, supersededId } = result.answer;
  const text = [
    status === "duplicate" ? "同样的事项、决定、项目和日期已经记录过，没有再记一条：" : "已记录为历史决定：",
    line(record),
    ...(supersededId === null ? [] : [`被它替代的 ${supersededId} 已标为「已替代」。`]),
    NOT_SEARCHED,
  ].join("\n");
  return { content: [{ type: "text" as const, text }], structuredContent: { message: text, status, record, supersededId } };
};

export const listHistoricalDecisions = async (input: ListInput, runtime: HistoricalDecisionRuntime) => {
  const none = { records: null, total: null, nextOffset: null, unreadable: null };
  const { limit = 20, offset = 0, query, ...filters } = input;
  const checked = listHistoricalDecisionsRequestSchema.extend({ limit: z.number().int().min(1).max(50) }).safeParse({
    ...filters,
    ...(query === undefined || query.trim() === "" ? {} : { query }),
    version: HISTORICAL_DECISION_VERSION,
    limit,
    offset,
  });
  if (!checked.success) return invalid("没有读取历史决定", checked.error, none);
  const result = await asked<ListHistoricalDecisionsResult>((report) => runtime.listHistoricalDecisions?.(checked.data, report) ?? Promise.resolve(null));
  if ("failure" in result) return refused(`${runtimeFailureText(result.failure)}历史决定这次没有读到；不能据此认为没有记录。`, none);
  const { records, total, diagnostics, index } = result.answer;
  // Read from nothing, an index out of reach is not an empty ledger.
  if (index.state === "unavailable") return refused("Paraself 的历史决定索引现在读不了，这次没有列出记录；不能据此认为没有记录。请用户在 App 的「知识 › 历史决定」里重建索引后再试。", none);
  const next = offset + records.length;
  const nextOffset = next < total ? next : null;
  const text = [
    total === 0 ? "没有符合条件的历史决定。" : `历史决定 ${total} 条，按决定日期从新到旧，本页 ${records.length} 条：`,
    ...records.map(line),
    ...(nextOffset === null ? [] : [`还有更多：用 offset=${nextOffset} 读下一页。`]),
    ...(diagnostics.length === 0 ? [] : [`另有 ${diagnostics.length} 篇笔记读不出来，没有列出：${diagnostics.slice(0, 5).map((item) => `${item.path}（${item.message}）`).join("；")}`]),
    ...(total === 0 ? [] : ["读某一条的全部内容、前后任和变更历史，用 get_historical_decision。"]),
  ].join("\n");
  return { content: [{ type: "text" as const, text }], structuredContent: { message: text, records, total, nextOffset, unreadable: diagnostics } };
};

export const getHistoricalDecision = async (input: z.infer<typeof getToolShape>, runtime: HistoricalDecisionRuntime) => {
  const none = { record: null, predecessor: null, successors: null, notePath: null, history: null };
  const checked = getHistoricalDecisionRequestSchema.safeParse({ version: HISTORICAL_DECISION_VERSION, id: input.id });
  if (!checked.success) return invalid("没有读取这条历史决定", checked.error, none);
  const result = await asked<GetHistoricalDecisionResult>((report) => runtime.getHistoricalDecision?.(checked.data, report) ?? Promise.resolve(null));
  if ("failure" in result) return refused(`${runtimeFailureText(result.failure)}这条历史决定没有读到。`, none);
  const { record, predecessor, successors, notePath, history } = result.answer;
  const text = [
    ...whole(record),
    `前任：${predecessor === null ? (record.supersedesId === null ? "无" : `${record.supersedesId}（笔记已找不到）`) : line(predecessor)}`,
    `后任：${successors.length === 0 ? "无" : successors.map(line).join("；")}`,
    `笔记：${notePath}`,
    ...(history.length === 0 ? [] : ["变更历史（新的在前；只有经 Paraself 做的修改，在 Obsidian 里直接改的不在其中）：", ...history.flatMap((event) => [
      `  ${localTime(event.at)} ${event.actor === "app" ? "用户（在 App 里）" : event.actor}：${event.summary}`,
      // What a rewritten field read before and after, each cut short here; the whole of it is in structuredContent.
      ...(event.changes ?? []).map((change) => `    ${change.field}：${clipText(change.before, 200) || "（空）"} → ${clipText(change.after, 200) || "（空）"}`),
    ])]),
  ].join("\n");
  return { content: [{ type: "text" as const, text }], structuredContent: { message: text, record, predecessor, successors, notePath, history } };
};

export const updateHistoricalDecision = async (input: UpdateInput, runtime: HistoricalDecisionRuntime, options: HistoricalDecisionToolOptions) => {
  const none = { record: null, supersededId: null, releasedIds: null, promotedDecisionId: null };
  // false is leaving it be, as leaving it out is.
  const { promote, ...change } = input;
  const checked = updateHistoricalDecisionRequestSchema.safeParse({ ...change, ...(promote === true ? { promote } : {}), version: HISTORICAL_DECISION_VERSION, sourceClient: options.sourceClient });
  if (!checked.success) return invalid("没有修改这条历史决定", checked.error, none);
  const result = await asked<UpdateHistoricalDecisionResult>((report) => runtime.updateHistoricalDecision?.(checked.data, report) ?? Promise.resolve(null));
  if ("failure" in result) return refused(`${runtimeFailureText(result.failure)}这条历史决定没有修改；先用 get_historical_decision 重新读取再试。`, none);
  const { record, supersededId, releasedIds, promotedDecisionId } = result.answer;
  const unchanged = record.revision === checked.data.expectedRevision;
  const text = [
    unchanged ? "内容和现有的一样，没有改动：" : "已修改：",
    line(record),
    ...(supersededId === null ? [] : [`被它替代的 ${supersededId} 已标为「已替代」。`]),
    ...(releasedIds.length === 0 ? [] : [`它恢复有效，${releasedIds.join("、")} 对它的替代关系已解除。`]),
    ...(promotedDecisionId === null ? [] : [`已转为正式决策 ${promotedDecisionId}：那一条从此参与 search_decision_context、待补理由和复盘；这条历史决定保留为留档。`]),
    ...(record.status === "withdrawn" ? ["已撤回的记录是只读的，笔记和变更历史都保留；要再改，先把 status 设回 active。"] : []),
  ].join("\n");
  return { content: [{ type: "text" as const, text }], structuredContent: { message: text, record, supersededId, releasedIds, promotedDecisionId } };
};

const OPENED = { note: "它的笔记", link: "链接", relatedNote: "关联笔记" } as const;

export const openHistoricalDecision = async (input: z.infer<typeof openToolShape>, runtime: HistoricalDecisionRuntime) => {
  const none = { opened: null, target: null };
  const checked = openHistoricalDecisionRequestSchema.safeParse({ ...input, version: HISTORICAL_DECISION_VERSION });
  if (!checked.success) return invalid("没有打开", checked.error, none);
  const result = await asked<OpenHistoricalDecisionResult>((report) => runtime.openHistoricalDecision?.(checked.data, report) ?? Promise.resolve(null));
  if ("failure" in result) return refused(`${runtimeFailureText(result.failure)}没有打开；只能打开这条记录的笔记，或它自己列出的链接和关联笔记，先用 get_historical_decision 核对。`, none);
  const { opened, target } = result.answer;
  const text = `已请求打开${OPENED[opened]}：${target}。${opened === "link" ? "在浏览器里打开。" : "在 Obsidian 里打开，笔记没有改动。"}`;
  return { content: [{ type: "text" as const, text }], structuredContent: { message: text, opened, target } };
};

const ONLY_WHEN_ASKED = "Only when the user asks for it: never record, change or withdraw one on your own judgement, and never to tidy the ledger.";
const APART = "A historical decision (历史决定) is a ledger entry kept only to trace what was decided and when; it needs no rationale, schedules no review, and is not found by search_decision_context or consult_decision_principles.";

export const registerHistoricalDecisionTools = (server: McpServer, runtime: HistoricalDecisionRuntime, options: HistoricalDecisionToolOptions): void => {
  server.registerTool("record_historical_decision", {
    title: "Record a historical decision",
    description: `Record a choice already made as a historical decision in Paraself: what was decided and when, with optional alternatives, context, scope, participants, links and tags. ${APART} ${ONLY_WHEN_ASKED} Only title and decision are required. Recording the same matter, decision, project and day again returns the record already kept (status duplicate) and makes no copy. supersedesId names the earlier record this one replaces. For a decision whose rationale and outcome should be tracked and found later, use record_decision_journal_entry instead.`,
    inputSchema: recordToolShape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => recordHistoricalDecision(input, runtime, options));
  server.registerTool("list_historical_decisions", {
    title: "List historical decisions",
    description: `List the user's historical decisions, newest decision first, a line each with its id, status, day, matter and decision; filter by words, project, status, tag, reversibility and a range of days. Withdrawn records are left out unless includeWithdrawn or status=withdrawn. ${APART} Use it only when the user asks to look up or trace such a record: it is not part of the context to check before coding or reviewing.`,
    inputSchema: listToolShape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => listHistoricalDecisions(input, runtime));
  server.registerTool("get_historical_decision", {
    title: "Read one historical decision",
    description: "Read one historical decision whole by its id: every field, the record it replaced and the ones that replaced it, where its note is in the vault, and the changes made to it (kept on the user's machine, newest first). Gives the revision and status that update_historical_decision asks for.",
    inputSchema: getToolShape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => getHistoricalDecision(input, runtime));
  server.registerTool("update_historical_decision", {
    title: "Change a historical decision",
    description: `Change a historical decision: its fields, its status (${STATUSES}), the record it replaces, or (promote) make a formal decision record from it, once. ${ONLY_WHEN_ASKED} Read it first with get_historical_decision and pass its revision as expectedRevision, and with a status change its status as expectedStatus: changed since, the update is refused. There is no delete: status withdrawn takes a record back, keeping its note and history.`,
    inputSchema: updateToolShape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => updateHistoricalDecision(input, runtime, options));
  server.registerTool("open_historical_decision", {
    title: "Open a historical decision on the user's machine",
    description: "Only when the user asks to open or jump to a historical decision: open its note in Obsidian, or with link one of its own links in the browser, or with relatedNote one of its related notes in Obsidian. Only what the record itself names can be opened; read it first with get_historical_decision. Nothing is written.",
    inputSchema: openToolShape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (input) => openHistoricalDecision(input, runtime));
};
