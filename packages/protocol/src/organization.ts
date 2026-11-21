import { z } from "zod";

import { isCalendarDate } from "./todo.js";
import { experienceBodySchema, experienceReporterSchema, experienceVerificationSchema } from "./experience.js";

/**
 * 整理与记忆（IMP-191）：待办整理、经验沉淀与冲突复核的建议，App 与页面之间传递的形状。建议只存在本机；
 * 采纳的经验写进 Vault。要求（请求）严格，回答宽松读取，较新的 App 多给的字段不被拒绝。
 */
export const ORGANIZATION_VERSION = 1 as const;

const text = (maximum: number) => z.string().trim().min(1).max(maximum);
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const id = text(200);

/** 来源的种类。身份永远带种类：decision:abc 与 summary:abc 是两条来源。 */
export const organizationSourceKindSchema = z.enum(["todo_item", "decision", "summary", "preference", "idea", "experience", "pending_confirmation", "pending_rationale", "review", "principle"]);
/** `<kind>:<id>`；待办事项的 id 是 `<清单 id>#<编号>`。 */
/**
 * `<kind>:<id>`. The id is taken as the record has it, whatever it holds (spaces, 中文, `#`, `:`): ids already written are
 * never refused here. Only the kind before the first colon is read; a todo item's id is `<list id>#<number>`, its number
 * after the last `#`.
 */
export const organizationSourceKeySchema = z.string().max(260).regex(/^(todo_item|decision|summary|preference|idea|experience|pending_confirmation|pending_rationale|review|principle):[\s\S]+$/u, "must be <kind>:<id>")
  .refine((key) => key.slice(key.indexOf(":") + 1).trim().length > 0, "must name an id");

export const organizationSourceKey = (kind: z.infer<typeof organizationSourceKindSchema>, recordId: string): string => `${kind}:${recordId}`;
export const todoItemSourceKey = (listId: string, item: number): string => `todo_item:${listId}#${item}`;
export const parseOrganizationSourceKey = (key: string): { kind: z.infer<typeof organizationSourceKindSchema>; id: string } | null => {
  const match = /^(todo_item|decision|summary|preference|idea|experience|pending_confirmation|pending_rationale|review|principle):([\s\S]+)$/u.exec(key);
  return match === null ? null : { kind: match[1] as z.infer<typeof organizationSourceKindSchema>, id: match[2]! };
};
/** A todo item's key read back: the list's id as written (a `#` in it included) and the item's number. */
export const parseTodoItemSourceKey = (key: string): { listId: string; item: number } | null => {
  const parsed = parseOrganizationSourceKey(key);
  if (parsed?.kind !== "todo_item") return null;
  const at = parsed.id.lastIndexOf("#");
  const number = parsed.id.slice(at + 1);
  if (at <= 0 || !/^[1-9]\d{0,5}$/u.test(number)) return null;
  return { listId: parsed.id.slice(0, at), item: Number(number) };
};

/** 稍后到哪天：一个真实存在的日期（YYYY-MM-DD），或带时区的 ISO 时间。 */
export const deferUntilSchema = z.string().max(100).refine((value) => isCalendarDate(value) || z.iso.datetime({ offset: true }).safeParse(value).success, "must be a calendar date (YYYY-MM-DD) or an ISO datetime");

/**
 * 整理的范围：list 必须给清单，selection 必须给事项，project 不带二者。缺了不能被当成更大的范围；事项是否真属于
 * 所选清单与项目由 App 核对。
 */
const scopedTarget = <T extends { scope: "list" | "selection" | "project" | "all"; listId?: string | undefined; items?: string[] | undefined }>(value: T, context: z.RefinementCtx): void => {
  if (value.scope === "list" && value.listId === undefined) context.addIssue({ code: "custom", path: ["listId"], message: "scope list needs listId" });
  if (value.scope === "selection" && (value.items === undefined || value.items.length === 0)) context.addIssue({ code: "custom", path: ["items"], message: "scope selection needs items" });
  if (value.scope === "selection" && value.items?.some((key) => parseTodoItemSourceKey(key) === null)) context.addIssue({ code: "custom", path: ["items"], message: "selection items must be todo items" });
  if (value.scope !== "selection" && value.items !== undefined) context.addIssue({ code: "custom", path: ["items"], message: "items only with scope selection" });
  if ((value.scope === "project" || value.scope === "all") && value.listId !== undefined) context.addIssue({ code: "custom", path: ["listId"], message: "listId only with scope list or selection" });
};

export const suggestionTypeSchema = z.enum(["todo_group", "todo_context", "todo_acceptance", "todo_recheck", "experience", "conflict", "triage", "judgment"]);
/** 维护结果的三个分组；总览与设置不作为数据种类。 */
export const SUGGESTION_TAB = {
  todo_group: "todo",
  todo_context: "todo",
  todo_acceptance: "todo",
  todo_recheck: "todo",
  experience: "memory",
  conflict: "conflict",
  triage: "todo",
  judgment: "conflict",
} as const satisfies Record<z.infer<typeof suggestionTypeSchema>, "todo" | "memory" | "conflict">;

export const suggestionStateSchema = z.enum(["pending", "deferred", "rejected", "applying", "applied", "partially_applied", "undone", "merged", "invalid"]);
export const suggestionStaleReasonSchema = z.enum(["source_changed", "source_gone", "source_unreadable", "dependency_changed_during_apply"]);
/** observation：带结果说明的待办状态事件、已复盘的决策；statement：偏好、想法、决策本身；derived：摘要、候选、转述。 */
export const sourceRoleSchema = z.enum(["observation", "statement", "derived"]);

export const suggestionSourceViewSchema = z.object({
  key: organizationSourceKeySchema,
  kind: organizationSourceKindSchema,
  role: sourceRoleSchema,
  label: z.string().max(500),
  /** current：与生成时一致；changed：可读但实质内容变了；gone：确认已删除或移走；unreadable：这次没能完整读取（不是删除）。 */
  status: z.enum(["current", "changed", "gone", "unreadable"]),
  /** 生成时据以判断的原文摘录；来源删除或被遗忘后为 null。 */
  excerpt: z.string().max(600).nullable(),
  /** status=changed 时，现在的对应原文（用于「原 / 现」对照）。 */
  currentText: z.string().max(600).nullable().default(null),
  relativePath: z.string().max(2_000).nullable().default(null),
  /** 待办事项：状态与优先级，供卡片标签显示。 */
  itemStatus: z.enum(["open", "in_progress", "done", "dropped"]).nullable().default(null),
  priority: z.enum(["p0", "p1", "p2", "p3"]).nullable().default(null),
  project: z.string().max(500).nullable().default(null),
  at: z.string().max(100).nullable().default(null),
});

const memberSchema = z.object({ key: organizationSourceKeySchema, difference: z.string().max(600) });
const contextLinkSchema = z.object({
  key: organizationSourceKeySchema,
  title: z.string().max(500),
  whyRelevant: z.string().max(600),
  /** 范围、例外、现行版本的提醒；相关不等于适用。 */
  scopeNote: z.string().max(600).nullable(),
});
const conflictSideSchema = z.object({
  key: organizationSourceKeySchema,
  title: z.string().max(500),
  project: z.string().max(500).nullable(),
  at: z.string().max(100).nullable(),
  sourceLabel: z.string().max(200),
  condition: z.string().max(1_000).nullable(),
  /** 现在的适用条件；null 是未限定。 */
  appliesWhen: z.string().max(2_000).nullable(),
  /** 这一方能否在这里改适用条件（偏好、决策、历史沉淀可以；想法、经验不行）。 */
  scopeEditable: z.boolean(),
});

/** 每种建议的具体内容；采纳会改什么由 type 决定（见架构文档 §2.4）。 */
export const suggestionContentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("triage"), item: organizationSourceKeySchema, disposition: z.enum(["linked", "unknown", "waiting"]), explanation: text(1000), links: z.array(contextLinkSchema).max(5) }),
  z.object({ type: z.literal("judgment"), question: text(300), impact: text(1000), unknowns: text(1000), options: z.tuple([text(500), text(500)]), recommendation: z.enum(["option_a", "option_b"]), recommendationReason: text(1000) }),
  z.object({ type: z.literal("todo_group"), title: z.string().max(300), members: z.array(memberSchema).min(2).max(10) }),
  z.object({ type: z.literal("todo_context"), item: organizationSourceKeySchema, links: z.array(contextLinkSchema).min(1).max(5) }),
  z.object({ type: z.literal("todo_acceptance"), item: organizationSourceKeySchema, missing: z.string().max(600), currentDetail: z.string().max(4_000).nullable(), draftDetail: z.string().max(4_000) }),
  z.object({ type: z.literal("todo_recheck"), item: organizationSourceKeySchema, reason: z.enum(["overdue", "untouched"]), days: z.number().int().nonnegative(), similarDone: organizationSourceKeySchema.nullable() }),
  z.object({
    type: z.literal("experience"),
    body: experienceBodySchema,
    reporter: experienceReporterSchema,
    verification: experienceVerificationSchema,
    /** 混合结果、失败也能沉淀。 */
    outcome: z.enum(["effective", "partial", "failed", "mixed", "unknown"]),
    memoryKind: z.enum(["experience", "knowledge"]).optional(),
  }),
  z.object({
    type: z.literal("conflict"),
    topic: z.string().max(300),
    a: conflictSideSchema,
    b: conflictSideSchema,
    /** 先查作用域：两条结论是否其实在同一范围。 */
    sameScope: z.boolean(),
    proposal: z.object({ a: z.string().max(2_000).nullable(), b: z.string().max(2_000).nullable(), relation: z.literal("unrelated").nullable() }),
  }),
]);

/** 用户编辑：经验的字段，改写草稿，冲突的范围。重新生成时保留，不被覆盖。 */
export const suggestionDraftSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("experience"), body: experienceBodySchema.partial() }).strict(),
  z.object({ type: z.literal("todo_acceptance"), draftDetail: text(4_000) }).strict(),
  z.object({ type: z.literal("conflict"), a: text(2_000).nullable(), b: text(2_000).nullable() }).strict(),
]);

/** 冲突的处理方式；其它类型只有「采纳」。 */
export const suggestionChoiceSchema = z.enum(["keep_scopes", "hold", "option_a", "option_b"]);

export const suggestionViewSchema = z.object({
  id,
  type: suggestionTypeSchema,
  tab: z.enum(["todo", "memory", "conflict"]),
  revision: z.number().int().positive(),
  evidenceVersion: z.number().int().positive(),
  project: z.string().max(500).nullable(),
  state: suggestionStateSchema,
  stale: z.object({ reason: suggestionStaleReasonSchema, at: z.iso.datetime(), keys: z.array(organizationSourceKeySchema).max(50) }).nullable(),
  deferUntil: deferUntilSchema.nullable(),
  /** 重新出现的原因，由 App 按来源变化写出，不是模型的话。 */
  reopenReason: z.string().max(1_000).nullable(),
  title: z.string().max(500),
  /** 发现了什么 / 为什么现在提示 / 采纳后会改什么 / 不会改什么。 */
  why: z.string().max(1_000),
  effect: z.string().max(1_000),
  unchanged: z.string().max(1_000),
  sources: z.array(suggestionSourceViewSchema).max(20),
  counter: z.array(suggestionSourceViewSchema).max(10),
  /** null：内容已因来源删除或遗忘而清除。 */
  content: suggestionContentSchema.nullable(),
  draft: suggestionDraftSchema.nullable(),
  attribution: z.object({
    reporter: experienceReporterSchema.nullable(),
    verification: experienceVerificationSchema.nullable(),
    generated: z.object({ model: z.string().max(200) }).nullable(),
  }),
  /** 带观察的独立根来源数；转述、摘要、陈述不计。 */
  independentEvidence: z.number().int().nonnegative(),
  /** 能否采纳，以及不能时的原因；按钮照此禁用，不在页面另行推断。 */
  canAdopt: z.boolean(),
  blockedReason: z.string().max(500).nullable(),
  /** 冲突可选的处理方式；其它类型为空。 */
  choices: z.array(suggestionChoiceSchema).max(3),
  automatic: z.boolean().optional(),
  revises: z.string().max(200).optional(),
  canUndo: z.boolean(),
  /** 采纳后写下的东西（经验笔记等），供「查看」。 */
  applied: z.array(z.object({ kind: z.string().max(50), key: z.string().max(260), relativePath: z.string().max(2_000).nullable(), ok: z.boolean() })).max(10),
  /** 部分写入时各步骤如实列出。 */
  steps: z.array(z.object({ kind: z.string().max(50), state: z.enum(["planned", "writing", "written", "failed", "conflict"]), message: z.string().max(500).nullable() })).max(10),
  redacted: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/** 已处理的记录：稍后、不采纳、重新出现、已采纳（近 30 天）。 */
export const handledSuggestionViewSchema = z.object({
  id,
  type: suggestionTypeSchema,
  tab: z.enum(["todo", "memory", "conflict"]),
  title: z.string().max(500),
  state: suggestionStateSchema,
  at: z.iso.datetime(),
  deferUntil: deferUntilSchema.nullable(),
  reopenReason: z.string().max(1_000).nullable(),
  revision: z.number().int().positive(),
  /** 重新打开（decideSuggestion reopen）要原样带回。 */
  evidenceVersion: z.number().int().positive(),
});

export const organizationRunStateSchema = z.enum(["waiting_idle", "running", "paused", "partial", "no_change", "done", "failed", "stopped", "interrupted"]);
export const organizationScopeSchema = z.enum(["list", "selection", "project", "all"]);
/**
 * 用量：服务商报告的与按字数估算的分开记，不相加冒充真实值。失败调用与重试都算在 calls 里（retries 是其中的重试数）。
 * 估算是保守的上界估计，不是硬上限。
 */
export const organizationUsageSchema = z.object({
  calls: z.number().int().nonnegative(),
  failedCalls: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative(),
  /** 服务商报告了用量的调用里的 token。 */
  reportedInputTokens: z.number().int().nonnegative(),
  reportedOutputTokens: z.number().int().nonnegative(),
  /** 没报告用量的调用（失败、取消、本机未计数），按字数保守估算的 token。 */
  estimatedInputTokens: z.number().int().nonnegative(),
  estimatedOutputTokens: z.number().int().nonnegative(),
});

export const organizationRunViewSchema = z.object({
  runId: id,
  trigger: z.enum(["manual", "background", "regenerate"]),
  scope: organizationScopeSchema,
  project: z.string().max(500).nullable(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  state: organizationRunStateSchema,
  /** 「正在检查第 2/5 组相似记录」 */
  stage: z.string().max(200).nullable(),
  progress: z.object({
    checked: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    groupsDone: z.number().int().nonnegative(),
    groupsTotal: z.number().int().nonnegative(),
  }),
  /** 本轮新增的建议、本轮修订的建议。 */
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  partialReason: z.enum(["budget", "time", "calls", "coverage", "foreground"]).nullable(),
  failure: z.object({ code: z.string().max(100), message: z.string().max(1_000) }).nullable(),
  usage: organizationUsageSchema,
  model: z.string().max(200).nullable(),
});

export const organizationSettingsSchema = z.object({
  /** 后台整理：默认关；开启需同时选定后台模型。 */
  background: z.boolean(),
  backgroundProfileId: id.nullable(),
  /** 显式完成首次设置后，才自动应用常规维护；旧版仅后台生成的设置不擅自升级。 */
  automatic: z.boolean().optional(),
  sources: z.array(organizationSourceKindSchema).min(1).max(10).optional(),
  maxCalls: z.number().int().min(1).max(8).optional(),
  inputTokens: z.number().int().min(3000).max(24000).optional(),
}).strict().refine((value) => !value.background || value.backgroundProfileId !== null, "background needs a model profile");

export const organizationQuerySchema = z.object({
  project: text(500).nullable(),
  scope: organizationScopeSchema,
  listId: id.optional(),
  items: z.array(organizationSourceKeySchema).max(200).optional(),
  source: organizationSourceKindSchema.optional(),
}).strict().superRefine(scopedTarget);

export const organizationSnapshotSchema = z.object({
  organizationVersion: z.literal(ORGANIZATION_VERSION),
  revision: z.number().int().nonnegative(),
  /** 本机整理记录读不出来时的说明；这时所有写操作都不可用。 */
  damaged: z.string().max(500).nullable(),
  /**
   * pending = todo + memory + conflict = 入口徽标：state 为 pending（含来源已变化的）或 partially_applied 的建议。不计
   * applied、applying、未到期的稍后与已不采纳的。
   */
  counts: z.object({
    todo: z.number().int().nonnegative(),
    memory: z.number().int().nonnegative(),
    conflict: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
  }),
  /**
   * 当前作用域内要显示完整内容的建议：待审阅（pending，含来源已变化的）、applying、partially_applied，以及近 30 天内采纳、
   * 仍可撤销的 applied（完整 view，供「已处理记录」点开撤销）。稍后、不采纳、已撤销的只在 handled 里。
   */
  suggestions: z.array(suggestionViewSchema).max(500),
  handled: z.array(handledSuggestionViewSchema).max(500),
  run: organizationRunViewSchema.nullable(),
  /** 正在进行的一轮（等待空闲、整理中、已暂停）；没有为 null。 */
  activeRun: organizationRunViewSchema.nullable(),
  settings: organizationSettingsSchema,
  projects: z.array(z.string().max(500)).max(1000).optional(),
  maintenance: z.object({ inputs: z.number().int().nonnegative(), automaticUpdates: z.number().int().nonnegative(), unknown: z.number().int().nonnegative(), waiting: z.number().int().nonnegative() }).optional(),
  usage7d: organizationUsageSchema.extend({ runs: z.number().int().nonnegative() }),
  coverage: z.object({
    complete: z.boolean(),
    unreadable: z.array(z.object({ label: z.string().max(500), relativePath: z.string().max(2_000).nullable() })).max(50),
  }),
  /** 有完整复盘、可进入原则候选的决策数：只提示，点进原有方法论流程。 */
  methodologyHint: z.object({ reviewedDecisions: z.number().int().positive() }).nullable(),
});

export const organizationRunRequestSchema = z.object({
  scope: organizationScopeSchema,
  project: text(500).nullable(),
  listId: id.optional(),
  items: z.array(organizationSourceKeySchema).max(200).optional(),
  /** 本次选用的生成模型；只用它，不回落到别的后端。 */
  profileId: id,
}).strict().superRefine(scopedTarget);

export const organizationRunResultSchema = z.object({
  /** out_of_scope：清单或事项不属于所选项目（或已不存在），没有扩大范围去整理。 */
  status: z.enum(["started", "busy", "damaged", "model_unavailable", "nothing_to_do", "out_of_scope"]),
  run: organizationRunViewSchema.nullable(),
});

export const organizationRunControlSchema = z.object({ runId: id, action: z.enum(["pause", "resume", "stop"]) }).strict();

export const suggestionDecisionSchema = z.object({
  id,
  expectedRevision: z.number().int().positive(),
  expectedEvidenceVersion: z.number().int().positive(),
  action: z.enum(["adopt", "defer", "reject", "reopen"]),
  /** 稍后：到这一天再提示（YYYY-MM-DD 或带时间的 ISO）。 */
  deferUntil: deferUntilSchema.optional(),
  /** 编辑后采纳。 */
  draft: suggestionDraftSchema.optional(),
  /** 冲突：保留各自范围，或暂不判断。 */
  choice: suggestionChoiceSchema.optional(),
}).strict().refine((value) => value.action !== "defer" || value.deferUntil !== undefined, "defer needs deferUntil");

export const suggestionDecisionStatusSchema = z.enum([
  "saved",
  "revision_conflict",
  "stale",
  "source_unavailable",
  "busy",
  "partially_applied",
  "damaged",
  "not_allowed",
  "not_found",
]);

export const suggestionDecisionResultSchema = z.object({
  organizationVersion: z.literal(ORGANIZATION_VERSION),
  id,
  status: suggestionDecisionStatusSchema,
  message: z.string().max(1_000).nullable(),
  suggestion: suggestionViewSchema.nullable(),
});

export const suggestionsAdoptSchema = z.object({
  items: z.array(z.object({ id, expectedRevision: z.number().int().positive(), expectedEvidenceVersion: z.number().int().positive() }).strict()).min(1).max(50),
}).strict();
export const suggestionsAdoptResultSchema = z.object({ results: z.array(suggestionDecisionResultSchema).max(50) });

export const suggestionDraftSaveSchema = z.object({ id, expectedRevision: z.number().int().positive(), draft: suggestionDraftSchema }).strict();

export const suggestionUndoSchema = z.object({
  id,
  expectedRevision: z.number().int().positive(),
  /** 已看过 needs_review 给出的恢复差异，按它恢复：必须带那份差异的 diffHash，目标之后又变了就再给新差异，不覆盖。 */
  expectedDiffHash: sha.optional(),
}).strict();

export const suggestionUndoResultSchema = z.object({
  organizationVersion: z.literal(ORGANIZATION_VERSION),
  id,
  status: z.enum(["saved", "needs_review", "revision_conflict", "source_unavailable", "not_allowed", "not_found", "damaged", "partially_applied"]),
  message: z.string().max(1_000).nullable(),
  diff: z.array(z.object({ target: z.string().max(260), field: z.string().max(100), current: z.string().max(4_000).nullable(), restoreTo: z.string().max(4_000).nullable() })).max(20),
  /** needs_review 时这份差异连同各目标当前版本的哈希；确认恢复要原样带回（expectedDiffHash）。 */
  diffHash: sha.nullable(),
  suggestion: suggestionViewSchema.nullable(),
});

export const suggestionRegenerateSchema = z.object({ id, profileId: id }).strict();

export const organizationForgetTargetSchema = z.object({ key: organizationSourceKeySchema }).strict();
export const organizationForgetPreviewSchema = z.object({
  key: organizationSourceKeySchema,
  /** 会被删除（以它为唯一观察来源）或改写（去掉它的摘录）的已采纳经验。 */
  experiences: z.array(z.object({ id, title: z.string().max(500), effect: z.enum(["delete", "revise"]), relativePath: z.string().max(2_000).nullable() })).max(200),
  suggestions: z.number().int().nonnegative(),
  annotations: z.number().int().nonnegative(),
  vectors: z.number().int().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  /** 有来源这次没能完整读取：预览可能不全，确认会被拒绝。 */
  complete: z.boolean(),
  /** 预览覆盖的全部目标及其当前版本的哈希；确认时原样带回，之后任何一个变了就要重新预览。 */
  previewHash: sha,
});
export const organizationForgetSchema = z.object({ key: organizationSourceKeySchema, confirm: z.literal(true), expectedPreviewHash: sha }).strict();
export const organizationForgetResultSchema = z.object({
  /** preview_changed：预览之后有目标变了，什么都没做，请重新预览。 */
  status: z.enum(["done", "partial", "incomplete_preview", "preview_changed", "damaged"]),
  failed: z.array(z.string().max(500)).max(50),
});

export const todoAnnotationsQuerySchema = z.object({ listIds: z.array(id).max(200) }).strict();
export const todoAnnotationsSchema = z.object({
  /** 已采纳的主题组；revision 是那条 todo_group 建议的修订号，取消分组（undoSuggestion）原样带回。 */
  groups: z.array(z.object({ suggestionId: id, revision: z.number().int().positive(), title: z.string().max(300), members: z.array(organizationSourceKeySchema).max(10) })).max(200),
  /** 键是事项的 source key（todo_item:<清单 id>#<编号>）。 */
  beforeStart: z.record(z.string().max(260), z.array(contextLinkSchema.extend({ suggestionId: id, revision: z.number().int().positive() })).max(5)),
});

export type OrganizationSourceKind = z.infer<typeof organizationSourceKindSchema>;
export type SuggestionType = z.infer<typeof suggestionTypeSchema>;
export type SuggestionState = z.infer<typeof suggestionStateSchema>;
export type SuggestionStaleReason = z.infer<typeof suggestionStaleReasonSchema>;
export type SourceRole = z.infer<typeof sourceRoleSchema>;
export type SuggestionSourceView = z.infer<typeof suggestionSourceViewSchema>;
export type SuggestionContent = z.infer<typeof suggestionContentSchema>;
export type SuggestionDraft = z.infer<typeof suggestionDraftSchema>;
export type SuggestionChoice = z.infer<typeof suggestionChoiceSchema>;
export type SuggestionView = z.infer<typeof suggestionViewSchema>;
export type HandledSuggestionView = z.infer<typeof handledSuggestionViewSchema>;
export type OrganizationRunState = z.infer<typeof organizationRunStateSchema>;
export type OrganizationScope = z.infer<typeof organizationScopeSchema>;
export type OrganizationUsage = z.infer<typeof organizationUsageSchema>;
export type OrganizationRunView = z.infer<typeof organizationRunViewSchema>;
export type OrganizationSettings = z.infer<typeof organizationSettingsSchema>;
export type OrganizationQuery = z.infer<typeof organizationQuerySchema>;
export type OrganizationSnapshot = z.infer<typeof organizationSnapshotSchema>;
export type OrganizationRunRequest = z.infer<typeof organizationRunRequestSchema>;
export type OrganizationRunResult = z.infer<typeof organizationRunResultSchema>;
export type OrganizationRunControl = z.infer<typeof organizationRunControlSchema>;
export type SuggestionDecision = z.infer<typeof suggestionDecisionSchema>;
export type SuggestionDecisionResult = z.infer<typeof suggestionDecisionResultSchema>;
export type SuggestionsAdopt = z.infer<typeof suggestionsAdoptSchema>;
export type SuggestionsAdoptResult = z.infer<typeof suggestionsAdoptResultSchema>;
export type SuggestionDraftSave = z.infer<typeof suggestionDraftSaveSchema>;
export type SuggestionUndo = z.infer<typeof suggestionUndoSchema>;
export type SuggestionUndoResult = z.infer<typeof suggestionUndoResultSchema>;
export type SuggestionRegenerate = z.infer<typeof suggestionRegenerateSchema>;
export type OrganizationForgetTarget = z.infer<typeof organizationForgetTargetSchema>;
export type OrganizationForgetPreview = z.infer<typeof organizationForgetPreviewSchema>;
export type OrganizationForget = z.infer<typeof organizationForgetSchema>;
export type OrganizationForgetResult = z.infer<typeof organizationForgetResultSchema>;
export type TodoAnnotationsQuery = z.infer<typeof todoAnnotationsQuerySchema>;
export type TodoAnnotations = z.infer<typeof todoAnnotationsSchema>;
