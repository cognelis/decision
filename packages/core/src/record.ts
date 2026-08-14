import type {
  CaptureMode,
  CapturedAnswer,
  CapturedDecisionContext,
  SourceClient,
} from "@cognelis/decision-protocol";

import type {
  RationaleCandidate,
  RationaleSubmission,
} from "./rationale-queue.js";
import { rationaleSemanticKey } from "./rationale-queue.js";

export type PersistedDecisionStatus =
  | "completed"
  | "deferred_rationale"
  | "rationale_skipped";

export type DecisionType =
  | "architecture"
  | "scope"
  | "implementation"
  | "tradeoff"
  | "workflow"
  | "risk"
  | "other";

export type RationaleStatus =
  | "captured"
  | "deferred"
  | "skipped"
  | "not_recorded";

export type OutcomeVerdict =
  | "better"
  | "as_expected"
  | "mixed"
  | "worse"
  | "unclear";

export interface OutcomeReview {
  verdict: OutcomeVerdict;
  lesson: string | null;
  reviewedAt: string;
}

export interface RecordedDecisionOption {
  id?: string;
  label: string;
  description?: string;
  tradeoffs: string[];
}

export type SelectedAnswer = CapturedAnswer;

export interface RecordedCaptureDetection {
  band: "high" | "medium";
  score: number;
  detectorVersion: string;
}

export interface DecisionRecord {
  id: string;
  created: string;
  status: PersistedDecisionStatus;
  sourceClient: SourceClient;
  project: string;
  workflow: string | null;
  decisionType: DecisionType;
  question: string;
  contextSummary: string | null;
  context: CapturedDecisionContext | null;
  detection: RecordedCaptureDetection | null;
  options: RecordedDecisionOption[];
  selectedAnswer: SelectedAnswer;
  llmRecommendation: string | null;
  rationaleStatus: Exclude<RationaleStatus, "not_recorded">;
  rationaleOriginal: string | null;
  reasonFactors: string[];
  captureMode: CaptureMode | null;
  captureSemanticKey: string | null;
  sourceEventId: string | null;
  batchId: string | null;
  questionIndex: number | null;
  tags: string[];
  related: string[];
  appliedPrincipleIds: string[];
  supersedes: string | null;
  reviewDueDate: string | null;
  outcome: string | null;
  outcomeReview: OutcomeReview | null;
}

export type PersistableRationaleSubmission =
  | Extract<RationaleSubmission, { status: "captured" }>
  | Extract<RationaleSubmission, { status: "deferred" | "skipped" }>;

const persistentStatus = (
  status: PersistableRationaleSubmission["status"],
): PersistedDecisionStatus => {
  if (status === "deferred") {
    return "deferred_rationale";
  }
  if (status === "skipped") {
    return "rationale_skipped";
  }
  return "completed";
};

export const createDecisionRecord = (
  candidate: RationaleCandidate,
  submission: PersistableRationaleSubmission,
  id: string,
  now: Date,
): DecisionRecord => {
  if (
    (submission as RationaleSubmission).status === "not_recorded"
  ) {
    throw new Error("Cannot persist a not-recorded decision");
  }

  const rationaleStatus = submission.status;
  const appliedPrincipleIds = [...(submission.appliedPrincipleIds ?? [])];
  if (
    appliedPrincipleIds.length > 5 ||
    new Set(appliedPrincipleIds).size !== appliedPrincipleIds.length ||
    appliedPrincipleIds.some(
      (id) =>
        id.trim().length === 0 || id !== id.trim() || id.length > 200,
    )
  ) {
    throw new Error("Applied principle IDs are invalid");
  }
  return {
    id,
    created: now.toISOString(),
    status: persistentStatus(submission.status),
    sourceClient: candidate.event.sourceClient,
    project: candidate.event.project,
    workflow: null,
    decisionType: "other",
    question: candidate.question.question,
    contextSummary: null,
    context:
      candidate.event.context === undefined
        ? null
        : { ...candidate.event.context },
    detection:
      candidate.event.detection === undefined
        ? null
        : {
            band: candidate.event.detection.band,
            score: candidate.event.detection.score,
            detectorVersion:
              candidate.event.detection.detectorVersion,
          },
    options: candidate.question.options.map((option) => ({
      ...(option.id === undefined ? {} : { id: option.id }),
      label: option.label,
      ...(option.description === undefined
        ? {}
        : { description: option.description }),
      tradeoffs: [],
    })),
    selectedAnswer: {
      kind: candidate.question.answer.kind,
      values: [...candidate.question.answer.values],
    },
    llmRecommendation: null,
    rationaleStatus,
    rationaleOriginal:
      submission.status === "captured"
        ? submission.rationale ?? null
        : null,
    reasonFactors:
      submission.status === "captured"
        ? [...(submission.reasonFactors ?? [])]
        : [],
    captureMode: candidate.event.captureMode,
    captureSemanticKey: rationaleSemanticKey(
      candidate.event,
      candidate.question,
    ),
    sourceEventId: candidate.event.sourceEventId ?? null,
    batchId: candidate.event.batchId,
    questionIndex: candidate.question.questionIndex,
    tags: [],
    related: [],
    appliedPrincipleIds,
    supersedes: null,
    reviewDueDate: null,
    outcome: null,
    outcomeReview: null,
  };
};
