import type { McpServer } from "@modelcontextprotocol/server";
import { decisionHandoffRequestSchema, decisionHandoffResponseSchema, decisionSourceReferenceSchema, decisionSourceOpenResultSchema, type DecisionHandoffRequest, type DecisionHandoffResponse, type DecisionSourceReference, type DecisionSourceOpenResult } from "@cognelis/decision-protocol";

import { runtimeFailureText, type RuntimeFailure, type RuntimeFailureReport } from "./runtime-client.js";

export interface DecisionHandoffRuntime {
  prepareDecisionHandoff?(input: DecisionHandoffRequest, report?: RuntimeFailureReport): Promise<DecisionHandoffResponse | null>;
  openDecisionSource?(input: DecisionSourceReference, report?: RuntimeFailureReport): Promise<DecisionSourceOpenResult | null>;
}

// Said, where the status alone ran on inside the sentence; it stays in structuredContent.
const notOpened = {
  source_changed: "原文已改变，请重新检索核对内容版本后再打开。",
  source_unavailable: "来源不可读取或编号不唯一，请检查原笔记是否缺失、重复或损坏。",
  open_failed: "没能请求 Obsidian 打开原文，请检查 Obsidian 是否可用。",
};

export const registerDecisionHandoffTools = (server: McpServer, runtime: DecisionHandoffRuntime): void => {
  server.registerTool("prepare_decision_handoff", {
    title: "Prepare a source-verified decision handoff",
    description: "Prepare read-only Markdown and structured evidence for continuing a task. First search_decision_context, then select 1-10 relevant references with source, recordId and expectedContentHash from sourceRef.contentHash. Reuse the actual taskScope returned by the search and explicit project when applicable. The App verifies all references against one scan, preserving scoped-out, superseded or conflicting evidence as historical only; changed or missing sources remain explicit review items. Supply objective and optional openQuestions, verification, nextSteps from current task context; these caller-supplied claims are separated from historical facts and are not independently verified. It does not summarize with a model, invent rejected alternatives, create a task, save notes, or send a message. Return the Markdown or save it to the requested local artifact only within user authorization. Recheck sources and relationship revisions before relying on a saved snapshot.",
    inputSchema: decisionHandoffRequestSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => {
    let failure = { reason: "not_running" } as RuntimeFailure;
    const response = await runtime.prepareDecisionHandoff?.(decisionHandoffRequestSchema.parse(input), (reported) => {
      failure = reported;
    }).catch(() => null);
    const handoff = response == null ? null : decisionHandoffResponseSchema.parse(response);
    const text = handoff?.markdown ?? `${runtimeFailureText(failure)}交接没有生成，未完成来源核对，不能当作没有相关决定。`;
    return {
      ...(handoff === null || handoff.status === "unavailable" ? { isError: true } : {}),
      content: [{ type: "text" as const, text }],
      // Claude Code shows a model only the structuredContent of a result that has one: the markdown is
      // there already; when there is none, what the text says goes there too.
      structuredContent: { ...(handoff === null ? { message: text } : {}), handoff },
    };
  });
  server.registerTool("open_decision_source", {
    title: "Open a verified decision source in Obsidian",
    description: "Only when the user asks to open or jump to a decision source, open the original local Markdown note in Obsidian. First retrieve the exact source, recordId and sourceRef.contentHash; supply the hash as expectedContentHash. The App resolves and validates the note internally; arbitrary paths, URLs and shell commands are not accepted. Missing, duplicate or changed sources are rejected. Does not edit notes or open a conversation; retained session IDs are provenance, not fabricated chat links. A successful result means the local open request was accepted, not proof the user viewed the note.",
    inputSchema: decisionSourceReferenceSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => {
    let failure = { reason: "not_running" } as RuntimeFailure;
    const response = await runtime.openDecisionSource?.(decisionSourceReferenceSchema.parse(input), (reported) => {
      failure = reported;
    }).catch(() => null);
    const result = response == null ? null : decisionSourceOpenResultSchema.parse(response);
    const text = result === null ? `${runtimeFailureText(failure)}来源没有打开或状态不确定；请先检查 App 和当前打开状态。`
      : result.status === "opened" ? `已向 Obsidian 请求打开来源：${result.relativePath}。原文未改写。`
      : `未打开来源：${notOpened[result.status]}`;
    return {
      ...(result?.status === "opened" ? {} : { isError: true }),
      content: [{ type: "text" as const, text }],
      structuredContent: { message: text, sourceOpen: result },
    };
  });
};
