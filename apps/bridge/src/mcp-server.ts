import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  DECISION_CONSULTATION_FEEDBACK_VERSION,
  DECISION_CONSULTATION_VERSION,
  type DecisionConsultationFeedbackRequest,
  type DecisionConsultationFeedbackResult,
  type DecisionConsultationFeedbackRating,
  type DecisionConsultationRequest,
  type DecisionConsultationResponse,
} from "@cognelis/decision-protocol";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { z } from "zod";

import bridgePackage from "../package.json";
import { RuntimeClient } from "./runtime-client.js";

export type DecisionMcpClient = "claude-code" | "codex";

interface ConsultationRuntime {
  consult(
    request: DecisionConsultationRequest,
  ): Promise<DecisionConsultationResponse | null>;
  submitConsultationFeedback?(
    feedback: DecisionConsultationFeedbackRequest,
  ): Promise<DecisionConsultationFeedbackResult | null>;
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
    .describe("Project name; defaults to the current working directory name."),
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

const confidenceLabel = (value: "low" | "medium" | "high"): string =>
  value === "high" ? "稳定模式" : value === "medium" ? "多条印证" : "单点证据";

const matchedText = (response: DecisionConsultationResponse): string => {
  const sections = response.matches.map(
    (match, index) =>
      `${index + 1}. ${match.title}（${confidenceLabel(match.confidence)}，${match.evidenceCount} 条证据）\n` +
      `原则：${match.principle}\n` +
      `适用：${match.appliesWhen}\n` +
      `边界：${match.caution}\n` +
      `关联依据：${match.reason}`,
  );
  return [
    "在用户选择前找到了以下已采纳原则。它们只用于核对判断条件和失败边界，不代表某个选项是答案：",
    ...sections,
    "请独立比较当前选项，并把相关原则作为可核对的判断依据呈现；不要声称用户已经采用这些原则。此次查询没有写入决策，也没有建立原则采用关系。",
  ].join("\n\n");
};

const noMatchText = (): string =>
  "没有找到足够明确的已采纳原则。不要为了给出建议而强行套用历史原则；请继续独立分析当前选项。此次查询没有写入决策，也没有建立原则采用关系。";

const unavailableText = (): string =>
  "Decision 当前不可用，因此没有读取到本地已采纳原则。不要因此阻断原生决策流程，也不要假装已完成原则核对；请继续独立分析当前选项。";

const feedbackText = (
  result: DecisionConsultationFeedbackResult | null,
): string => {
  if (result === null) return "Decision 当前不可用，未记录本次评价。";
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
  const response = await runtime.consult({
    consultationVersion: DECISION_CONSULTATION_VERSION,
    requestId: (options.requestIdFactory ?? randomUUID)(),
    sourceClient: options.sourceClient,
    project: parsed.project ?? (basename(cwd) || "unknown-project"),
    question: parsed.question,
    options: parsed.options ?? [],
    context: parsed.context ?? null,
    requestedAt: (options.now ?? (() => new Date()))().toISOString(),
  });

  if (response === null) {
    return {
      content: [{ type: "text" as const, text: unavailableText() }],
      structuredContent: {
        availability: "unavailable",
        consultation: null,
      },
    };
  }
  return {
    content: [
      {
        type: "text" as const,
        text: response.status === "matched" ? matchedText(response) : noMatchText(),
      },
    ],
    structuredContent: {
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
  const result =
    runtime.submitConsultationFeedback === undefined
      ? null
      : await runtime.submitConsultationFeedback({
          feedbackVersion: DECISION_CONSULTATION_FEEDBACK_VERSION,
          token: parsed.token,
          rating: parsed.rating,
        });
  return {
    content: [{ type: "text" as const, text: feedbackText(result) }],
    structuredContent: { feedback: result },
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
        "Use consult_decision_principles before presenting meaningful choices or a recommendation. It is read-only historical context, never a substitute for current analysis or user confirmation. Use record_decision_consultation_feedback only after the user explicitly evaluates that consultation; never infer a rating.",
    },
  );
  server.registerTool(
    "consult_decision_principles",
    {
      title: "Consult adopted decision principles",
      description:
        "Before the user chooses, read up to three locally adopted principles whose applicability or caution text overlaps the current decision. Read-only: it does not choose an answer, write a decision, apply a principle, call a model, or open the Decision app.",
      inputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
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
  return server;
};

export const serveDecisionMcp = (options: DecisionMcpOptions): void => {
  serveStdio(() => createDecisionMcpServer(options), {
    onerror: () => undefined,
  });
};
