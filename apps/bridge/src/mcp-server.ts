import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  DECISION_CONSULTATION_FEEDBACK_VERSION,
  DECISION_CONSULTATION_VERSION,
  PROACTIVE_RECORD_VERSION,
  proactiveRecordRequestSchema,
  type DecisionConsultationFeedbackRequest,
  type DecisionConsultationFeedbackResult,
  type DecisionConsultationFeedbackRating,
  type DecisionConsultationRequest,
  type DecisionConsultationResponse,
  type ProactiveRecordRequest,
  type ProactiveRecordResult,
} from "@cognelis/decision-protocol";
import { RESERVED_SECTION_TEXT } from "@cognelis/decision-core";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import bridgePackage from "../package.json";
import { decisionProjectFor } from "@cognelis/decision-integrations";
import { repositoryLanguages } from "./repository-languages.js";
import { RuntimeClient, runtimeFailureText, type RuntimeFailure, type RuntimeFailureReport } from "./runtime-client.js";
import { inputReasons, registerDecisionContextTool, type DecisionContextRuntime } from "./mcp-context.js";

export type DecisionMcpClient = "claude-code" | "codex";

interface ConsultationRuntime extends DecisionContextRuntime {
  consult(
    request: DecisionConsultationRequest,
    report?: RuntimeFailureReport,
  ): Promise<DecisionConsultationResponse | null>;
  submitConsultationFeedback?(
    feedback: DecisionConsultationFeedbackRequest,
    report?: RuntimeFailureReport,
  ): Promise<DecisionConsultationFeedbackResult | null>;
  record?(
    request: ProactiveRecordRequest,
    report?: RuntimeFailureReport,
  ): Promise<ProactiveRecordResult | null>;
}

export interface DecisionConsultationToolInput {
  question: string;
  options?: Array<{ label: string; description?: string | undefined }> | undefined;
  context?: string | undefined;
  project?: string | undefined;
}

export interface DecisionConsultationFeedbackToolInput {
  token: string;
  rating: DecisionConsultationFeedbackRating;
}

interface DecisionMcpOptions {
  sourceClient: DecisionMcpClient;
  runtime?: ConsultationRuntime;
  cwd?: string;
  now?: () => Date;
  requestIdFactory?: () => string;
}

const inputSchema = z.object({
  question: z
    .string()
    .trim()
    .min(1)
    .max(4_000)
    .describe("The unresolved decision question before the user has chosen."),
  options: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(500),
        description: z.string().trim().min(1).max(2_000).optional(),
      }),
    )
    .max(8)
    .optional()
    .describe("Candidate choices being considered; omit when still open-ended."),
  context: z
    .string()
    .trim()
    .min(1)
    .max(6_000)
    .optional()
    .describe("Only the task context needed to judge applicability and cautions."),
  project: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .describe("Project name; defaults to the repository the MCP server was started in, which may not be the one you are working in: pass it when working in another repository."),
  languages: z
    .array(z.string().trim().min(1).max(40))
    .max(8)
    .optional()
    .describe("The programming languages of the code this choice is about (e.g. [\"go\"], [\"typescript\"]). Preferences the user kept for other languages are then left out; omitted, they are worked out from the repository the MCP server was started in when this is about that repository."),
});

const feedbackInputSchema = z.object({
  token: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("Opaque token returned by consult_decision_principles."),
  rating: z
    .enum(["helpful", "not_helpful", "misleading"])
    .describe(
      "The user's explicit assessment: helpful, unrelated/not useful, or potentially misleading.",
    ),
});

const journalCommon = {
  title: z.string().trim().min(1).max(500),
  content: z.string().trim().min(1).max(8_000),
  project: z.string().trim().min(1).max(500).optional().describe(
    "The project this belongs to; defaults to the repository the MCP server was started in, which may not be the one you are working in: pass it when working in another repository.",
  ),
  // With its offset as an agent writes the user's local time ("…T15:30:00+08:00"), as the app's UTC instant: refused,
  // nothing was recorded and the refusal did not say why.
  occurredAt: z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString()).optional(),
  knowledgeStatus: z.enum(["inbox", "active", "archived"]).optional(),
  context: z.string().trim().min(1).max(8_000).optional(),
  rationale: z.string().trim().min(1).max(8_000).optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(12).default([]),
};

const journalToolInputSchema = z.discriminatedUnion("kind", [
  z.object({
    ...journalCommon,
    kind: z.literal("decision"),
    options: z.array(z.string().trim().min(1).max(2_000)).max(8).default([]),
    // Refused here, as the App would refuse it, in its words rather than the App's English after the call.
    expectedOutcome: z.string().trim().min(1).max(4_000).refine((value) => !RESERVED_SECTION_TEXT.test(value), "reserved note delimiters").optional(),
    reviewDueDate: z.string().date().optional(),
  }),
  z.object({
    ...journalCommon,
    kind: z.literal("preference"),
    languages: z.array(z.string().trim().min(1).max(40)).max(8).optional(),
    appliesWhen: z.string().trim().min(1).max(4_000).optional(),
    exceptions: z.string().trim().min(1).max(4_000).optional(),
    strength: z.enum(["hard_constraint", "default", "weak_signal"]).optional(),
    evidenceMaturity: z.enum(["self_declared", "repeated", "reviewed"]).optional(),
  }),
  z.object({
    ...journalCommon,
    kind: z.literal("idea"),
    languages: z.array(z.string().trim().min(1).max(40)).max(8).optional(),
    ideaForm: z.enum(["observation", "question", "hypothesis", "possibility"]).optional(),
    whyInteresting: z.string().trim().min(1).max(4_000).optional(),
    openQuestions: z.array(z.string().trim().min(1).max(1_000)).max(8).default([]),
    nextTest: z.string().trim().min(1).max(4_000).optional(),
    incubateUntil: z.string().date().optional(),
  }),
]);

export type DecisionJournalToolInput = z.input<typeof journalToolInputSchema>;

/**
 * What a client is shown: one object, `kind` an enum. A union at the top was shown as its first branch
 * alone (Claude Code did), so a model could record nothing but a decision. Each kind's own fields are
 * checked against journalToolInputSchema when the call arrives; one sent for another kind is left out.
 * Types and words only, the limits said in them: the SDK checks this before the handler runs, and a length or
 * format checked here reached the agent as its own English issue list, never what to change.
 */
const journalToolShape = z.object({
  kind: z.enum(["decision", "preference", "idea"]).describe(
    "decision: a decision the user reported; preference: a standing preference or way of working the user stated; idea: the user's own observation, question or hypothesis.",
  ),
  title: z.string().describe("Up to 500 characters; a single line for a preference or an idea (its note's heading)."),
  content: z.string().describe("Up to 8000 characters."),
  project: z.string().optional().describe(
    "The project this belongs to, up to 500 characters; defaults to the repository the MCP server was started in, which may not be the one you are working in: pass it when working in another repository.",
  ),
  occurredAt: z.string().optional().describe("An ISO 8601 date-time."),
  knowledgeStatus: z.enum(["inbox", "active", "archived"]).optional().describe(
    "preference and idea only; a decision is recorded as active. \"active\" needs a preference's appliesWhen and exceptions, an idea's whyInteresting.",
  ),
  context: z.string().optional().describe("Up to 8000 characters."),
  rationale: z.string().optional().describe("Up to 8000 characters."),
  tags: z.array(z.string()).optional().describe("Up to 12, each up to 100 characters."),
  languages: z.array(z.string()).optional().describe(
    "preference and idea only: the programming languages the user said it applies to (e.g. \"in Go, …\" → [\"go\"]). Never from the language of the repository you are working in: a preference stated while working in Go code is general unless the user tied it to Go. Leave out otherwise. Up to 8, each up to 40 characters.",
  ),
  options: z.array(z.string()).optional().describe("decision only: the options weighed; up to 8, each up to 2000 characters."),
  expectedOutcome: z.string().optional().describe(
    "decision only; up to 4000 characters of plain text, without the note's own headings (## 预期结果, ## 后续结果, ## 复盘结论, ## 复盘经验) or its markers.",
  ),
  reviewDueDate: z.string().optional().describe("decision only; a date, YYYY-MM-DD."),
  appliesWhen: z.string().optional().describe("preference only; up to 4000 characters."),
  exceptions: z.string().optional().describe("preference only; up to 4000 characters."),
  strength: z.enum(["hard_constraint", "default", "weak_signal"]).optional().describe("preference only; default \"default\"."),
  evidenceMaturity: z.enum(["self_declared", "repeated", "reviewed"]).optional().describe("preference only; default \"self_declared\"."),
  ideaForm: z.enum(["observation", "question", "hypothesis", "possibility"]).optional().describe("idea only; default \"possibility\"."),
  whyInteresting: z.string().optional().describe("idea only; up to 4000 characters."),
  openQuestions: z.array(z.string()).optional().describe("idea only; up to 8, one line each, each up to 1000 characters."),
  nextTest: z.string().optional().describe("idea only; up to 4000 characters."),
  incubateUntil: z.string().optional().describe("idea only; a date, YYYY-MM-DD."),
});

// Worded by the decisions behind it as well: adopted at low confidence, a principle backed by none, or by three,
// read 单点证据 beside its own count.
const evidenceLabel = ({ confidence, evidenceCount }: DecisionConsultationResponse["matches"][number]): string =>
  evidenceCount === 0 ? "待验证" : evidenceCount === 1 ? "单点证据"
    : `${confidence === "high" ? "稳定模式" : confidence === "medium" ? "多条印证" : "低可信"}，${evidenceCount} 条证据`;

const MATCHED_LEAD = "在用户选择前找到了以下已采纳原则。它们只用于核对判断条件和失败边界，不代表某个选项是答案";
const MATCHED_CLOSE = "请独立比较当前选项，并把相关原则作为可核对的判断依据呈现；不要声称用户已经采用这些原则。此次查询没有写入决策，也没有建立原则采用关系。";
const SIGNALS_LEAD = "另外，用户自己记下的偏好或想法中有以下几条与当前问题相关。它们不是已采纳原则，不能当作规则，也不代表用户已经决定";
const SIGNALS_CLOSE = "呈现它们时必须说明是偏好还是想法，并保留其例外与未决问题；不要写成用户已经采用或已经决定。";
// Read as none, a hard constraint the reader had written down went unsaid, and the agent went on as if there was none.
const SIGNALS_UNREAD = "另外，用户自己记下的偏好和想法这次没能读取，所以这里没有列出任何一条；不能据此认为用户在这个问题上没有偏好或约束，涉及用户的习惯或约束时请先向用户确认。";

/**
 * The reader's own preferences and ideas, said as what they are.
 *
 * They are appended to whichever text the principles produced, including the
 * no-match one: a caller that stops reading at "no accepted principle" would
 * otherwise never see a stance the reader has actually stated.
 */
const signalText = (response: DecisionConsultationResponse): string | null => {
  if (response.signalsUnavailable === true) return SIGNALS_UNREAD;
  if (response.signals.length === 0) return null;
  const sections = response.signals.map(
    (signal, index) =>
      `${index + 1}. ${signal.title}\n` +
      `内容：${signal.summary}\n` +
      `身份：${signal.standing}\n` +
      (signal.qualifier === null ? "" : `限定：${signal.qualifier}\n`) +
      `关联依据：${signal.reason}`,
  );
  return [`${SIGNALS_LEAD}：`, ...sections, SIGNALS_CLOSE].join("\n\n");
};

const withSignals = (
  base: string,
  response: DecisionConsultationResponse,
): string => {
  const extra = signalText(response);
  return extra === null ? base : `${base}\n\n${extra}`;
};

const matchedText = (response: DecisionConsultationResponse): string => {
  const sections = response.matches.map(
    (match, index) =>
      `${index + 1}. ${match.title}（${evidenceLabel(match)}）\n` +
      `原则：${match.principle}\n` +
      `适用：${match.appliesWhen}\n` +
      `边界：${match.caution}\n` +
      `关联依据：${match.reason}`,
  );
  return [`${MATCHED_LEAD}：`, ...sections, MATCHED_CLOSE].join("\n\n");
};

const noMatchText = (reason: DecisionConsultationResponse["noMatchReason"]): string =>
  `${reason === "no_accepted_principles" ? "当前尚无可读取的已采纳原则。" : "没有找到足够明确的已采纳原则。"}这不代表没有相关历史决策；可调用 search_decision_context 检索 summarize 与决策记录。不要为了给出建议而强行套用历史原则；请继续独立分析当前选项。此次查询没有写入决策，也没有建立原则采用关系。`;

/**
 * What the text says around the principles and signals, without them. Claude Code shows a model only
 * the structuredContent of a result that has one, where they already are, so every tool's result
 * carries its text's guidance there too, as `message`.
 */
const consultationNotice = (response: DecisionConsultationResponse): string => [
  ...(response.status === "matched"
    ? [`${MATCHED_LEAD}（见 consultation.matches）。`, MATCHED_CLOSE]
    : [noMatchText(response.noMatchReason)]),
  ...(response.signalsUnavailable === true
    ? [SIGNALS_UNREAD]
    : response.signals.length === 0 ? [] : [`${SIGNALS_LEAD}（见 consultation.signals）。`, SIGNALS_CLOSE]),
].join("\n");

const unavailableText = (failure: RuntimeFailure): string =>
  `${runtimeFailureText(failure)}因此没有读取到本地已采纳原则。不要因此阻断原生决策流程，也不要假装已完成原则核对；请继续独立分析当前选项。`;

const feedbackText = (
  result: DecisionConsultationFeedbackResult | null,
  failure: RuntimeFailure,
): string => {
  if (result === null) {
    return failure.reason === "no_answer"
      ? `无法确认本次评价是否已记录：${runtimeFailureText(failure)}`
      : `没有记录本次评价：${runtimeFailureText(failure)}`;
  }
  if (result.status === "accepted") {
    return "已匿名计入核对质量统计；没有保存问题、选项、原则编号或单次反馈记录。";
  }
  return result.status === "expired"
    ? "本次匿名反馈回执已过期，未记录评价。"
    : "本次匿名反馈回执已使用或不存在，未重复记录评价。";
};

export const consultDecisionPrinciples = async (
  input: DecisionConsultationToolInput,
  options: DecisionMcpOptions,
) => {
  const parsed = inputSchema.parse(input);
  const runtime = options.runtime ?? new RuntimeClient();
  const cwd = options.cwd ?? process.cwd();
  const here = await decisionProjectFor(cwd);
  // Not said by the agent: those of the repository the server runs in, when the choice is about that one; another
  // project's are not known here, and none said recalls every preference, as before.
  const languages = parsed.languages ?? (parsed.project === undefined || parsed.project === here ? await repositoryLanguages(cwd) : []);
  // Widened, not narrowed to this first value: the report below may change it.
  let failure = { reason: "not_running" } as RuntimeFailure;
  const request = {
    consultationVersion: DECISION_CONSULTATION_VERSION,
    requestId: (options.requestIdFactory ?? randomUUID)(),
    sourceClient: options.sourceClient,
    project: parsed.project ?? here,
    question: parsed.question,
    options: parsed.options ?? [],
    context: parsed.context ?? null,
    requestedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  const ask = (withLanguages: boolean) =>
    runtime.consult({ ...request, ...(withLanguages && languages.length > 0 ? { languages } : {}) }, (reported) => {
      failure = reported;
    });
  let response = await ask(true);
  // An App older than this bridge (the .app replaced while it ran) refuses a field it does not know: asked again
  // without the languages worked out here, the consultation is not lost over them.
  if (response === null && failure.reason === "refused" && parsed.languages === undefined && languages.length > 0) {
    response = await ask(false);
  }

  if (response === null) {
    const text = unavailableText(failure);
    return {
      content: [{ type: "text" as const, text }],
      structuredContent: {
        message: text,
        availability: "unavailable",
        reason: failure.reason,
        consultation: null,
      },
    };
  }
  return {
    content: [
      {
        type: "text" as const,
        text: withSignals(
          response.status === "matched"
            ? matchedText(response)
            : noMatchText(response.noMatchReason),
          response,
        ),
      },
    ],
    structuredContent: {
      message: consultationNotice(response),
      availability: "available",
      consultation: response,
    },
  };
};

export const recordDecisionConsultationFeedback = async (
  input: DecisionConsultationFeedbackToolInput,
  options: DecisionMcpOptions,
) => {
  const parsed = feedbackInputSchema.parse(input);
  const runtime = options.runtime ?? new RuntimeClient();
  // Widened, not narrowed to this first value: the report below may change it.
  let failure = { reason: "not_running" } as RuntimeFailure;
  const result =
    runtime.submitConsultationFeedback === undefined
      ? null
      : await runtime.submitConsultationFeedback({
          feedbackVersion: DECISION_CONSULTATION_FEEDBACK_VERSION,
          token: parsed.token,
          rating: parsed.rating,
        }, (reported) => {
          failure = reported;
        });
  const text = feedbackText(result, failure);
  return {
    // Not counted (a receipt expired, used or unknown, an App not reached) is an error: read as success otherwise.
    ...(result?.status === "accepted" ? {} : { isError: true }),
    content: [{ type: "text" as const, text }],
    structuredContent: { message: text, feedback: result },
  };
};

// The rules the record keeps, said as what to change: zod's own issue list reached the agent as the whole answer.
const recordRules: Record<string, string> = {
  "must be a single line": "偏好和想法的标题、想法的每个开放问题都只能写一行",
  "active preferences require appliesWhen and exceptions": "设为 active 的偏好需要同时写明 appliesWhen 和 exceptions",
  "active ideas require whyInteresting": "设为 active 的想法需要写明 whyInteresting",
  "reserved note delimiters": "预期结果里不能有「## 预期结果」「## 后续结果」「## 复盘结论」「## 复盘经验」这类笔记自己的标题或标记",
};

// The App's words for them: the enums ran on inside the sentence the agent relays. structuredContent keeps them.
const recordKinds = { decision: "决策", preference: "偏好", idea: "想法" };
const knowledgeStatuses = { inbox: "待澄清", active: "有效", archived: "已归档" };

const refusedRecord = (error: z.ZodError) => {
  // The rest by kind, in the words the rest of the answer is in: zod's own English ran on inside it.
  const text = `没有记录这条：输入不符合要求（${inputReasons(error, recordRules)}）。按要求改正后再记录，不要声称已经沉淀。`;
  return { isError: true, content: [{ type: "text" as const, text }], structuredContent: { message: text, record: null } };
};

export const recordDecisionJournalEntry = async (
  input: DecisionJournalToolInput,
  options: DecisionMcpOptions,
) => {
  const checked = journalToolInputSchema.safeParse(input);
  if (!checked.success) return refusedRecord(checked.error);
  const parsed = checked.data;
  const runtime = options.runtime ?? new RuntimeClient();
  const cwd = options.cwd ?? process.cwd();
  const project = parsed.project ?? await decisionProjectFor(cwd);
  const built = proactiveRecordRequestSchema.safeParse({
    ...parsed,
    recordVersion: PROACTIVE_RECORD_VERSION,
    requestId: (options.requestIdFactory ?? randomUUID)(),
    sourceClient: options.sourceClient,
    sourceKind: "agent_capture",
    sourceForm: "machine_summary",
    sensitivity: "private",
    project,
  });
  if (!built.success) return refusedRecord(built.error);
  const request = built.data;
  // Named, and where it came from when the agent gave none: filed under the repository the MCP server started in,
  // a decision about another one was left out of that one's scoped searches, and nothing said which project it was.
  // Put right in the note, never by recording again: a decision recorded again under another project is a second
  // note beside the misfiled one, and a preference or idea a duplicate that stays where it was.
  const filed = parsed.project === undefined
    ? `项目 ${project}（未指定，按 MCP 服务启动所在的仓库；不对的话请用户在 Obsidian 里改这条笔记的 project 属性，不要重新记录）`
    : `项目 ${project}`;
  // Widened, not narrowed to this first value: the report below may change it.
  let failure = { reason: "not_running" } as RuntimeFailure;
  const result = runtime.record === undefined ? null : await runtime.record(request, (reported) => {
    failure = reported;
  });
  // Not known only when it was sent and nothing came back: an App that refused it, or was never reached, did not.
  const text = result === null
    ? failure.reason === "no_answer"
      ? `无法确认这条是否已记录：${runtimeFailureText(failure)}请用户在 App 中核实后再决定是否重新记录；不要声称已经沉淀。`
      : `没有记录这条：${runtimeFailureText(failure)}不要声称已经沉淀。`
    : result.status === "updated"
      ? `该${recordKinds[result.recordKind]}已存在，这次补充或修改的内容已作为一次修订保存到原记录，状态为${knowledgeStatuses[result.knowledgeStatus]}；项目和敏感级别保持原记录的设置，没有随这次记录改变；未保存原始对话。`
      // Also a preference or idea the user wrote or changed: an agent's restatement leaves it as it is.
      : result.status === "duplicate"
        ? `该${recordKinds[result.recordKind]}已存在，没有重复记录；这次的其它字段也没有写入，内容若有改动，请用户到 App 中修改原记录。`
        : `已记录${recordKinds[result.recordKind]}，${filed}，状态为${knowledgeStatuses[result.knowledgeStatus]}；未保存原始对话。`;
  return {
    ...(result === null ? { isError: true } : {}),
    content: [{ type: "text" as const, text }],
    // Only for what was written under it: a duplicate or a revision stays under the existing record's project, which
    // the App does not say, and naming this one there told the model it was filed where it is not.
    structuredContent: { message: text, record: result, ...(result?.status === "created" ? { project } : {}) },
  };
};

export const createDecisionMcpServer = (
  options: DecisionMcpOptions,
): McpServer => {
  const server = new McpServer(
    { name: "decision", version: bridgePackage.version },
    {
      capabilities: { tools: {} },
      instructions:
        "Use search_decision_context when coding or reviewing against past decisions, or preparing a decision handoff; verify project scope, source excerpts and supersession before applying historical evidence. Use consult_decision_principles before presenting meaningful choices or a recommendation. It reads adopted principles, and returns the user's own preferences and ideas that bear on the question separately labelled, never as principles; no match does not mean no relevant historical decision exists. These tools never replace current analysis or user confirmation. Use record_decision_journal_entry only for an explicit user directive, user-reported decision, or user-authored idea. An explicit standing directive may be recorded without asking a second time; never infer a stable preference from behavior. Use record_decision_consultation_feedback only after the user explicitly evaluates that consultation; never infer a rating.",
    },
  );
  server.registerTool(
    "consult_decision_principles",
    {
      title: "Consult adopted decision principles",
      description:
        "Before the user chooses, read up to three locally adopted principles related to the current decision, matched by their text and by a local embedding model (no generative model; nothing leaves this machine). The user's own preferences and ideas that bear on it come back separately labelled as signals, never as principles. It does not choose an answer, write a decision, apply a principle, or open the Decision app; each call is counted anonymously and returns a new token for record_decision_consultation_feedback.",
      inputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        // Each call counts anonymously and hands out a new feedback token.
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (input) => consultDecisionPrinciples(input, options),
  );
  server.registerTool(
    "record_decision_consultation_feedback",
    {
      title: "Record explicit consultation feedback",
      description:
        "Record only the user's explicit assessment of one recent consultation as anonymous aggregate counters. Requires the opaque token returned by consult_decision_principles. Never call based on the assistant's own judgement. It stores no question, option, principle identifier, token, or individual feedback event.",
      inputSchema: feedbackInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (input) => recordDecisionConsultationFeedback(input, options),
  );
  server.registerTool(
    "record_decision_journal_entry",
    {
      title: "Record an explicit decision journal entry",
      description:
        "Record only an explicit user directive, user-reported decision, or user-authored idea. An explicit standing directive needs no second confirmation. Never infer a stable preference from behavior, and never include secrets, a full transcript, or unnecessary third-party identity.",
      inputSchema: journalToolShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (input) => recordDecisionJournalEntry(input as DecisionJournalToolInput, options),
  );
  registerDecisionContextTool(server, options.runtime ?? new RuntimeClient());
  return server;
};

export const serveDecisionMcp = (options: DecisionMcpOptions): void => {
  serveStdio(() => createDecisionMcpServer(options), {
    onerror: () => undefined,
  });
};
