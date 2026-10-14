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
import { createHash } from "node:crypto";

import type {
  ProactiveSourceKind,
  RecordSensitivity,
  SourceForm,
} from "./journal-entry.js";

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
  sourceClient: DecisionRecordSourceClient;
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
  sourceKind?: ProactiveSourceKind | null;
  sourceForm?: SourceForm | null;
  occurredAt?: string | null;
  sensitivity?: RecordSensitivity;
  expectedOutcome?: string | null;
}

export type DecisionRecordSourceClient = SourceClient | "manual" | "pr-comment";

export interface ManualDecisionInput {
  question: string;
  decision: string;
  project: string;
  rationale?: string | null;
  contextSummary?: string | null;
  options?: string[];
  expectedOutcome?: string | null;
  reviewDueDate?: string | null;
  occurredAt?: string | null;
  sourceKind: ProactiveSourceKind;
  sourceForm: SourceForm;
  sensitivity?: RecordSensitivity;
  tags?: string[];
  /** The PR comment the decision was taken from; present exactly when sourceKind is "pr_comment". */
  sourceUrl?: string | null;
  /** Who wrote it down: the app's own form, unless an agent relayed it. */
  sourceClient?: SourceClient | "manual";
}

/** One PR comment settles at most one decision, so its link is the capture key. */
export const prCommentSemanticKey = (url: string): string =>
  createHash("sha256").update(`pr-comment\n${url}`).digest("hex");

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** The same rule as a platform connection's address: HTTPS, loopback HTTP, no credentials. */
const commentLink = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Source URL must be an absolute link");
  }
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname))) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("Source URL must be an HTTPS link without credentials");
  }
  return url.href;
};

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
    sourceKind: null,
    sourceForm: null,
    occurredAt: null,
    sensitivity: "private",
    // Written while the choice was fresh, whether or not the rationale was given then.
    expectedOutcome: expectedOutcomeText(submission.expectedOutcome),
  };
};

const manualText = (value: string, label: string, maximum: number): string => {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new Error(`${label} must contain 1 to ${maximum} characters`);
  }
  return normalized;
};

const manualOptionalText = (
  value: string | null | undefined,
  label: string,
  maximum: number,
): string | null =>
  value === null || value === undefined || value.trim().length === 0
    ? null
    : manualText(value, label, maximum);

/** Text a note would read back as a delimiter or as a lifecycle section. */
export const RESERVED_SECTION_TEXT =
  /<!--\s*decision:|#{2,3} (?:预期结果|后续结果|复盘结论|复盘经验)/u;

const expectedOutcomeText = (value: string | null | undefined): string | null => {
  const text = manualOptionalText(value, "Expected outcome", 4_000);
  if (text !== null && RESERVED_SECTION_TEXT.test(text)) {
    throw new Error("Expected outcome contains reserved note delimiters");
  }
  return text;
};

const manualCalendarDate = (value: string | null): string | null => {
  if (value === null) return null;
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value
  ) {
    throw new Error("Review due date must be a calendar date");
  }
  return value;
};

export const createManualDecisionRecord = (
  input: ManualDecisionInput,
  id: string,
  now: Date,
): DecisionRecord => {
  const question = manualText(input.question, "Question", 4_000);
  const decision = manualText(input.decision, "Decision", 8_000);
  const project = manualText(input.project, "Project", 500);
  const rationale = manualOptionalText(input.rationale, "Rationale", 8_000);
  const contextSummary = manualOptionalText(
    input.contextSummary,
    "Context",
    8_000,
  );
  const expectedOutcome = expectedOutcomeText(input.expectedOutcome);
  const occurredAt = manualOptionalText(input.occurredAt, "Occurred at", 40);
  if (occurredAt !== null && !Number.isFinite(Date.parse(occurredAt))) {
    throw new Error("Occurred at must be an ISO date time");
  }
  const options = (input.options ?? []).map((label) => ({
    label: manualText(label, "Option", 2_000),
    tradeoffs: [],
  }));
  if (options.length > 8) throw new Error("Options must contain at most 8 values");
  // A tag is there or not: one named twice is one tag, not a reason to refuse the record.
  const tags = [...new Set((input.tags ?? []).map((tag) => manualText(tag, "Tag", 100)))];
  if (tags.length > 12) {
    throw new Error("Tags must contain at most 12 unique values");
  }
  const normalizedId = manualText(id, "Decision ID", 200);
  const sourceText = manualOptionalText(input.sourceUrl, "Source URL", 2_000);
  if ((input.sourceKind === "pr_comment") !== (sourceText !== null)) {
    throw new Error("Only a PR comment decision carries a source URL, and it must");
  }
  const sourceUrl = sourceText === null ? null : commentLink(sourceText);
  const semanticKey =
    sourceUrl !== null
      ? prCommentSemanticKey(sourceUrl)
      // The same call made again in another project is another decision, not a duplicate to refuse.
      : createHash("sha256")
          .update(`manual\n${project.normalize("NFKC")}\n${question.normalize("NFKC")}\n${decision.normalize("NFKC")}`)
          .digest("hex");
  const rationaleStatus = rationale === null ? "deferred" : "captured";
  return {
    id: normalizedId,
    created: now.toISOString(),
    status: rationale === null ? "deferred_rationale" : "completed",
    sourceClient: sourceUrl === null ? input.sourceClient ?? "manual" : "pr-comment",
    project,
    workflow: null,
    decisionType: "other",
    question,
    contextSummary,
    context: null,
    detection: null,
    options,
    selectedAnswer: { kind: "custom", values: [decision] },
    llmRecommendation: null,
    rationaleStatus,
    rationaleOriginal: rationale,
    reasonFactors: [],
    captureMode: null,
    captureSemanticKey: semanticKey,
    // The comment's link identifies the event the decision came from.
    sourceEventId: sourceUrl,
    batchId: null,
    questionIndex: null,
    tags,
    related: [],
    appliedPrincipleIds: [],
    supersedes: null,
    reviewDueDate: manualCalendarDate(input.reviewDueDate ?? null),
    outcome: null,
    outcomeReview: null,
    sourceKind: input.sourceKind,
    sourceForm: input.sourceForm,
    occurredAt,
    sensitivity: input.sensitivity ?? "private",
    expectedOutcome,
  };
};
