import { decisionFeedbackResponseSchema, decisionContextResponseSchema, decisionContextResultSchema, decisionHandoffResponseSchema, decisionScopeSchema } from "@cognelis/decision-protocol";
import type { DecisionEvidenceApi, DecisionLibraryItem } from "../shared/renderer-api.js";

/** Browser preview only; never simulates a successful persisted write. */
export const createEvidencePreviewApi = (items: DecisionLibraryItem[] = []): DecisionEvidenceApi => {
  const unavailableWrite = async (): Promise<never> => { throw new Error("预览模式不保存修改，请在 Decision App 中操作。"); };
  const searchDecisionContext: DecisionEvidenceApi["searchDecisionContext"] = async (query) => {
    const candidates = items.length ? items : query.recordId ? [{ id: query.recordId, question: "预览决策", project: "decision", selectedAnswer: "保留已确认的选择" }] : [];
    const results = candidates.filter((item) => (query.source === undefined || query.source === "decisions") && (query.recordId === undefined || query.recordId === item.id) && (!query.query || `${item.question} ${item.id}`.includes(query.query))).map((item) => decisionContextResultSchema.parse({
      source: "decisions", kind: "recorded_decision", id: item.id, title: item.question, project: item.project, status: "completed", current: true,
      summary: item.selectedAnswer, appliesWhen: null, caution: null, tags: [], supersedes: [], supersededBy: [], successors: [], unresolvedSuccessorIds: [],
      sourceRef: { relativePath: `Decision Journal/decisions/${item.id}.md`, client: "codex", sessionId: null, excerpt: item.selectedAnswer, excerptStartLine: 12, truncated: false, contentHash: "a".repeat(64) },
      matchReason: "预览数据", warnings: [], scopeState: "unrecorded", scopeRevision: 0, lifecycleState: "current", relations: [], relationCount: 0,
      applicability: { status: "needs_review", reasons: ["尚未确认适用范围。"], scope: decisionScopeSchema.parse({}) },
    }));
    return decisionContextResponseSchema.parse({ contextVersion: 1, status: results.length ? "matched" : "no_match", coverage: "complete", sources: [{ source: "decisions", status: "ready", records: candidates.length, skipped: 0 }], results: results.slice(0, query.limit), total: results.length, nextOffset: null, guidance: "预览数据", boundary: { advisoryOnly: true, noDecisionWritten: true, noPrincipleApplied: true } });
  };
  return { saveDecisionContextFeedback: unavailableWrite,
    getDecisionContextFeedback: async () => decisionFeedbackResponseSchema.parse({ coverage: "complete", results: [], total: 0, nextOffset: null, activeCount: 0, withdrawnCount: 0, ratings: { helpful: 0, not_applicable: 0, insufficient_context: 0, irrelevant: 0 }, currentSourceRatings: { helpful: 0, not_applicable: 0, insufficient_context: 0, irrelevant: 0 }, guidance: "预览数据", noDecisionChanged: true }),
    searchDecisionContext, updateDecisionScope: unavailableWrite, updateDecisionRelation: unavailableWrite, openDecisionSource: unavailableWrite,
    prepareDecisionHandoff: async (input) => decisionHandoffResponseSchema.parse({ handoffVersion: 1, generatedAt: new Date().toISOString(), status: "needs_review", coverage: "complete", sources: [], task: { objective: input.objective, project: input.project, taskScope: input.taskScope, openQuestions: input.openQuestions, nextSteps: input.nextSteps, verification: input.verification }, evidence: [], reviewItems: ["浏览器预览；真实来源需要在 App 中核对。"], markdown: `# 交接预览\n\n当前任务：${input.objective}\n\n此页面仅展示交接界面。请在 App 中生成带来源版本的交接内容。`, truncated: false, boundary: { noNoteWritten: true, taskClaimsVerified: false, advisoryOnly: true } }),
  };
};
