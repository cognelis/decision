import { decisionFeedbackRecordSchema, type DecisionFeedbackRecord } from "@cognelis/decision-protocol";
import { MarkdownFactStore } from "./markdown-fact-store.js";

export const createDecisionFeedbackStore = (vaultPath: string): MarkdownFactStore<DecisionFeedbackRecord> => new MarkdownFactStore(vaultPath, "decision-feedback", {
  parse: (input) => decisionFeedbackRecordSchema.parse(input), key: (record) => record.feedbackId, heading: "决策使用反馈",
});
