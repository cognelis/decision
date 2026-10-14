import { managedQwenModelIdSchema, managedQwenModelStatusSchema } from "@cognelis/decision-protocol";
import { prDiscussionSchema, prActionContextSchema, prActionRequestSchema, prActionResultSchema, prReviewCommentRequestSchema, prGeneralCommentRequestSchema, prReviewCommentResultSchema, prReviewReevaluateSchema, prReviewVerdictSchema, prReviewFileRequestSchema, prReviewFileResponseSchema, prReviewDiffRequestSchema, prReviewDiffResponseSchema, prReviewFollowUpSchema, prReviewFollowUpResultSchema, prConnectionSchema, prConnectionInputSchema, prListQuerySchema, prListResponseSchema, prReviewLoadSchema, prReviewPrefetchSchema, prReviewSnapshotSchema, prReviewRunSchema, prReviewReportSchema } from "@cognelis/decision-protocol";
import { proactiveRecordInputSchema } from "../shared/proactive-record.js";
import { decisionFeedbackUpdateSchema, decisionFeedbackUpdateResultSchema, decisionFeedbackQuerySchema, decisionFeedbackResponseSchema } from "@cognelis/decision-protocol";
import { DESKTOP_PRIMARY_SURFACES } from "../shared/renderer-api.js";
import type { DecisionApi, DecisionEvidenceApi } from "../shared/renderer-api.js";
import {
  assistantSourceCheckSchema,
  assistantTurnRequestSchema,
  assistantTurnResponseSchema,
  assistantFeedbackInputSchema,
  assistantFeedbackSummarySchema,
  assistantExportResultSchema,
  assistantFeedbackResultSchema,
  retrievalAnswerProviderSchema,
  retrievalAnswerCitationSchema,
  retrievalAnswerScopeSchema,
} from "@cognelis/decision-protocol";
import type {
  AssistantExportResult,
  AssistantFeedbackInput,
  AssistantFeedbackSummary,
  AssistantFeedbackResult,
  AssistantTurnRequest,
  AssistantTurnResponse,
  RetrievalAnswerProvider,
} from "@cognelis/decision-protocol";
import { decisionContextQuerySchema, decisionContextResponseSchema, decisionScopeUpdateSchema, decisionScopeUpdateResultSchema, decisionRelationUpdateSchema, decisionRelationUpdateResultSchema, decisionSourceReferenceSchema, decisionSourceOpenResultSchema, decisionHandoffRequestSchema, decisionHandoffResponseSchema } from "@cognelis/decision-protocol";
import type {
  DecisionAnalyticsSnapshot,
  DecisionCandidateQueue,
  KnowledgeGraphSnapshot,
  MethodologyEvidenceMatch,
  MethodologyRelationDisposition,
  MethodologyStatus,
  MethodologySuggestion,
  OutcomeReview,
  PracticeAssetKind,
  PracticeAssetStatus,
  PracticePublicationReceipt,
  PracticePublicationStatus,
  PracticePublicationTarget,
  RationaleQueue,
} from "@cognelis/decision-core";
import { fileSystemRefusal, RESERVED_SECTION_TEXT } from "@cognelis/decision-core";
import type {
  DecisionConsultationFeedbackResult,
  DecisionConsultationMetricsSnapshot,
  DecisionConsultationResponse,
  ModelInvocationTrace,
  LocalModelClientStatus,
  RedactedModelProviderProfile,
} from "@cognelis/decision-protocol";
import {
  decisionConsultationFeedbackRatingSchema,
  redactedModelProviderProfileSchema,
  localModelClientStatusSchema,
  semanticRecognitionStatusSchema,
} from "@cognelis/decision-protocol";
import type { InstallMode, InstallReport } from "@cognelis/decision-integrations";
import type { RebuildReport } from "@cognelis/decision-storage";
import { z } from "zod";

import {
  THEME_PREFERENCES,
  type ThemePreference,
} from "../shared/appearance.js";
import {
  CAPTURE_CLASSIFIERS,
  type CaptureClassifier,
} from "../shared/capture-classifier.js";
import type {
  AppSnapshot,
  DecisionLibraryItem,
  DecisionAppliedPrinciple,
  DecisionConsultationFeedbackInput,
  DecisionConsultationPreviewInput,
  DecisionLibraryQuery,
  DecisionOutcomeReviewInput,
  DecisionPrincipleSuggestion,
  DecisionPrincipleSuggestionInput,
  DesktopPrimarySurface,
  MethodologyItem,
  MethodologyBuildProgress,
  MethodologyImportPreview,
  MethodologyImportReport,
  ManualFormDraft,
  ManualFormDraftInput,
  ManualFormDraftKey,
  MethodologyEvolutionInput,
  MethodologyEvidenceManualInput,
  MethodologyMergeLifecyclePlan,
  MethodologyMergeInput,
  MethodologyManualInput,
  MethodologyUsageSnapshot,
  MethodologyValidationItem,
  MethodologyVersionItem,
  MethodologyRevisionInput,
  PracticeAssetItem,
  PracticeAssetRevisionInput,
  PracticeAssetVersionItem,
  ModelProviderMutationInput,
  ModelProviderTestResult,
  RationaleInput,
  ProactiveRecordInput,
  ProactiveRecordResult,
  JournalEntry,
  JournalEntryListQuery,
  JournalEntryRevisionInput,
} from "../shared/renderer-api.js";
import { IPC_CHANNELS } from "../shared/renderer-api.js";
import type {
  ObsidianSearchResponse,
  ObsidianSearchStatus,
} from "../shared/obsidian-search.js";
import { manualFormDraftInputSchema } from "./manual-form-draft-store.js";

export { IPC_CHANNELS };

const candidateIdSchema = z.string().trim().min(1).max(200);
const appliedPrincipleIdsSchema = z
  .array(candidateIdSchema)
  .max(5)
  .refine(
    (ids) => new Set(ids).size === ids.length,
    "Applied principles cannot contain duplicates",
  );
const decisionLibraryQuerySchema = z
  .object({
    query: z.string().max(200),
    searchMode: z.enum(["keyword", "semantic"]).optional(),
    decisionId: candidateIdSchema.optional(),
    createdSince: z.string().datetime({ offset: true }).optional(),
    rationaleStatus: z.enum(["captured", "deferred", "skipped"]).optional(),
    sourceClient: z.enum(["claude-code", "codex", "manual", "pr-comment", "test"]).optional(),
    project: z.string().trim().min(1).max(500).optional(),
    outcomeVerdict: z
      .enum(["better", "as_expected", "mixed", "worse", "unclear"])
      .optional(),
    reviewState: z
      .enum([
        "pending_outcome",
        "pending_review",
        "reviewed",
        "attention",
        "due",
        "scheduled",
        "unscheduled",
        "expectation_missing",
      ])
      .optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();
const parseDecisionLibraryQuery = (input: unknown): DecisionLibraryQuery => {
  const parsed = decisionLibraryQuerySchema.parse(input);
  return {
    query: parsed.query,
    ...(parsed.searchMode === undefined
      ? {}
      : { searchMode: parsed.searchMode }),
    ...(parsed.decisionId === undefined
      ? {}
      : { decisionId: parsed.decisionId }),
    ...(parsed.createdSince === undefined
      ? {}
      : { createdSince: parsed.createdSince }),
    ...(parsed.rationaleStatus === undefined
      ? {}
      : { rationaleStatus: parsed.rationaleStatus }),
    ...(parsed.sourceClient === undefined
      ? {}
      : { sourceClient: parsed.sourceClient }),
    ...(parsed.project === undefined ? {} : { project: parsed.project }),
    ...(parsed.outcomeVerdict === undefined
      ? {}
      : { outcomeVerdict: parsed.outcomeVerdict }),
    ...(parsed.reviewState === undefined
      ? {}
      : { reviewState: parsed.reviewState }),
    ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
  };
};
const journalEntryListQuerySchema = z.object({
  query: z.string().trim().max(200).optional(),
  kind: z.enum(["preference", "idea"]).optional(),
  knowledgeStatus: z.enum(["inbox", "active", "archived"]).optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).strict();
const journalDraftCommonShape = {
  title: z.string().trim().min(1).max(500),
  content: z.string().trim().min(1).max(8_000),
  knowledgeStatus: z.enum(["inbox", "active", "archived"]).optional(),
  context: z.string().trim().min(1).max(8_000).nullable().optional(),
  rationale: z.string().trim().min(1).max(8_000).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(12).optional(),
  languages: z.array(z.string().trim().min(1).max(40)).max(8).optional(),
};
const journalEntryRevisionSchema = z.object({
  id: candidateIdSchema,
  draft: z.discriminatedUnion("kind", [
    z.object({
      ...journalDraftCommonShape,
      kind: z.literal("preference"),
      appliesWhen: z.string().trim().min(1).max(4_000).nullable().optional(),
      exceptions: z.string().trim().min(1).max(4_000).nullable().optional(),
      strength: z.enum(["hard_constraint", "default", "weak_signal"]).optional(),
      evidenceMaturity: z.enum(["self_declared", "repeated", "reviewed"]).optional(),
    }).strict(),
    z.object({
      ...journalDraftCommonShape,
      kind: z.literal("idea"),
      ideaForm: z.enum(["observation", "question", "hypothesis", "possibility"]).optional(),
      whyInteresting: z.string().trim().min(1).max(4_000).nullable().optional(),
      openQuestions: z.array(z.string().trim().min(1).max(1_000)).max(8).optional(),
      nextTest: z.string().trim().min(1).max(4_000).nullable().optional(),
      incubateUntil: z.string().date().nullable().optional(),
    }).strict(),
  ]),
  change: z.object({
    changeNote: z.string().trim().min(1).max(1_000),
    sourceKind: z.enum(["app_manual", "offline_conversation", "meeting", "observation"]),
    sourceForm: z.enum(["user_original", "user_paraphrase"]),
  }).strict(),
  basis: z.string().max(200_000).optional(),
}).strict();
const isCodePointLengthWithin = (
  value: string,
  minimum: number,
  maximum: number,
): boolean => {
  let count = 0;
  for (const _codePoint of value) {
    count += 1;
    if (count > maximum) {
      return false;
    }
  }
  return count >= minimum;
};
const boundedTextSchema = (
  rawCodeUnitMaximum: number,
  minimumCodePoints: number,
  maximumCodePoints: number,
  description: string,
) =>
  z
    .string()
    .max(rawCodeUnitMaximum)
    .refine(
      (value) =>
        isCodePointLengthWithin(value, minimumCodePoints, maximumCodePoints),
      `${description} must be ${minimumCodePoints} to ${maximumCodePoints} Unicode code points`,
    );
const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});
const isGraphemeLengthAtMost = (value: string, maximum: number): boolean => {
  let count = 0;
  for (const _grapheme of graphemeSegmenter.segment(value)) {
    count += 1;
    if (count > maximum) {
      return false;
    }
  }
  return true;
};
const boundedGraphemeTextSchema = (
  rawCodeUnitMaximum: number,
  maximumGraphemes: number,
  description: string,
) =>
  z
    .string()
    .max(rawCodeUnitMaximum)
    .refine(
      (value) => isGraphemeLengthAtMost(value, maximumGraphemes),
      `${description} must be at most ${maximumGraphemes} graphemes`,
    );
const obsidianSearchQuerySchema = z
  .string()
  .max(4_096)
  .transform((value) => value.trim())
  .refine(
    (value) => isCodePointLengthWithin(value, 1, 500),
    "Search query must be 1 to 500 Unicode code points",
  );
const obsidianSearchInputSchema = z
  .object({
    query: obsidianSearchQuerySchema,
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();
const parseObsidianSearchInput = (
  input: unknown,
): { query: string; limit?: number } => {
  const parsed = obsidianSearchInputSchema.parse(input);
  return parsed.limit === undefined
    ? { query: parsed.query }
    : { query: parsed.query, limit: parsed.limit };
};
const obsidianNotePathSchema = z
  .string()
  .max(8_192)
  .refine(
    (value) => isCodePointLengthWithin(value, 1, 4_096),
    "Note path must be 1 to 4096 Unicode code points",
  )
  .refine((value) => !value.includes("\0"), "Note path cannot contain NUL")
  .refine(
    (value) => !value.includes("\\"),
    "Note path cannot contain backslashes",
  )
  .refine((value) => !value.startsWith("/"), "Note path must be relative")
  .refine(
    (value) => !/^[A-Za-z]:/u.test(value),
    "Note path must be relative",
  )
  .refine(
    (value) =>
      value
        .split("/")
        .every(
          (segment) =>
            segment !== "" && segment !== "." && segment !== "..",
        ),
    "Note path cannot contain empty or traversal segments",
  )
  .refine(
    (value) =>
      value.toLowerCase().endsWith(".md") &&
      value.split("/").at(-1)?.toLowerCase() !== ".md",
    "Note path must name a Markdown file",
  );
const isCanonicalIsoTimestamp = (value: string): boolean => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
};
const publicObsidianStatusMessageSchema = boundedTextSchema(
  512,
  1,
  200,
  "Status message",
)
  .refine(
    (value) => !/[\0\r\n]/u.test(value),
    "Status message cannot contain NUL or newlines",
  )
  .refine(
    (value) => !/[\\/]/u.test(value),
    "Status message cannot contain path separators",
  );
const obsidianSearchStatusSchema = z
  .object({
    state: z.enum(["idle", "indexing", "ready", "unavailable", "error"]),
    discoveredNotes: z.number().int().min(0),
    indexedNotes: z.number().int().min(0),
    chunkCount: z.number().int().min(0),
    processedNotes: z.number().int().min(0),
    totalNotes: z.number().int().min(0),
    skippedNotes: z.number().int().min(0),
    failedNotes: z.number().int().min(0),
    synchronizedAt: z
      .string()
      .max(64)
      .refine(isCanonicalIsoTimestamp, "Synchronized time must be canonical")
      .nullable(),
    semanticAvailable: z.boolean(),
    message: publicObsidianStatusMessageSchema.nullable(),
  })
  .strict();
const obsidianSearchResultSchema = z
  .object({
    relativePath: obsidianNotePathSchema,
    title: boundedTextSchema(2_000, 0, 1_000, "Result title"),
    heading: boundedTextSchema(1_200, 0, 600, "Result heading").nullable(),
    snippet: boundedGraphemeTextSchema(4_096, 260, "Result snippet"),
    matchKind: z.enum(["keyword", "semantic", "hybrid"]),
  })
  .strict();
const obsidianSearchResponseSchema = z
  .object({
    query: boundedTextSchema(4_096, 1, 500, "Response query"),
    results: z.array(obsidianSearchResultSchema).max(50),
    status: obsidianSearchStatusSchema,
  })
  .strict();
const OBSIDIAN_IPC_FAILURE_MESSAGES = {
  status: "无法获取 Obsidian 搜索状态",
  search: "无法搜索 Obsidian 笔记",
  rebuild: "无法重建 Obsidian 搜索索引",
  open: "无法打开 Obsidian 笔记",
  openDocument: "无法打开这份 Vault 文档",
} as const;
const parseObsidianOperationOutput = async <Output>(
  operation: () => Promise<unknown> | unknown,
  schema: { parse(input: unknown): Output },
  failureMessage: string,
): Promise<Output> => {
  try {
    return schema.parse(await operation());
  } catch {
    throw new Error(failureMessage);
  }
};
const decisionOutcomeInputSchema = z
  .object({
    decisionId: candidateIdSchema,
    outcome: z
      .string()
      .max(8_000)
      .refine((value) => value.trim().length > 0)
      // Read back, such a line would end the section where the reader did not mean it to.
      .refine((value) => !RESERVED_SECTION_TEXT.test(value), "实际结果里不能有「## 后续结果」「## 复盘结论」这类笔记分节标题或 decision 标记，请改写后再保存"),
    // The note's hash when the editor was opened: changed since (in Obsidian), the save is refused.
    basis: z.string().min(1).max(200).optional(),
  })
  .strict();
const decisionExpectedOutcomeInputSchema = z
  .object({
    decisionId: candidateIdSchema,
    expectedOutcome: z
      .string()
      .trim()
      .min(1)
      .max(4_000)
      .refine((value) => !RESERVED_SECTION_TEXT.test(value), "预期结果里不能有「## 后续结果」「## 复盘结论」这类笔记分节标题或 decision 标记，请改写后再保存"),
    // The note's hash when the editor was opened: changed since (in Obsidian), the save is refused.
    basis: z.string().min(1).max(200).optional(),
  })
  .strict();
const isCalendarDate = (value: string): boolean => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
};
const decisionReviewDueDateInputSchema = z
  .object({
    decisionId: candidateIdSchema,
    reviewDueDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u)
      .refine(isCalendarDate, "Review due date must be a valid calendar date")
      .nullable(),
  })
  .strict();
const decisionReviewInputSchema = z
  .object({
    decisionId: candidateIdSchema,
    verdict: z.enum(["better", "as_expected", "mixed", "worse", "unclear"]),
    lesson: z.union([
      z
        .string()
        .max(8_000)
        .refine((value) => value.trim().length > 0),
      z.null(),
    ]),
    // The note's hash when the editor was opened: changed since (in Obsidian), the save is refused.
    basis: z.string().min(1).max(200).optional(),
  })
  .strict();
const decisionAppliedPrinciplesInputSchema = z
  .object({
    decisionId: candidateIdSchema,
    principleIds: appliedPrincipleIdsSchema,
  })
  .strict();
const decisionPrincipleSuggestionInputSchema = z
  .object({
    question: z.string().trim().min(1).max(8_000),
    selectedAnswer: z.string().trim().min(1).max(4_000),
    optionLabels: z.array(z.string().trim().min(1).max(2_000)).max(50),
    context: z.string().trim().min(1).max(6_000).nullable(),
  })
  .strict();
const decisionConsultationPreviewInputSchema = z
  .object({
    question: z.string().trim().min(1).max(4_000),
    options: z.array(z.string().trim().min(1).max(500)).max(8),
    context: z.string().trim().min(1).max(6_000).nullable(),
  })
  .strict();
const decisionConsultationFeedbackInputSchema = z
  .object({
    token: z.string().trim().min(1).max(200),
    rating: decisionConsultationFeedbackRatingSchema,
  })
  .strict();
const methodologyStatusSchema = z.enum([
  "candidate",
  "accepted",
  "retired",
  "dismissed",
]);
const methodologySourceIdsSchema = z
  .array(candidateIdSchema)
  .min(1)
  .max(5)
  .refine(
    (ids) => new Set(ids).size === ids.length,
    "Methodology sources cannot contain duplicates",
  );
const methodologyRevisionSchema = z
  .object({
    id: candidateIdSchema,
    title: z.string().trim().min(1).max(120),
    principle: z.string().trim().min(1).max(2_000),
    appliesWhen: z.string().trim().min(1).max(2_000),
    caution: z.string().trim().min(1).max(2_000),
    evidenceSummary: z.string().trim().min(1).max(3_000),
    basis: z.string().max(40_000).optional(),
  })
  .strict();
const methodologyManualSchema = methodologyRevisionSchema
  .omit({ id: true, evidenceSummary: true, basis: true })
  .strict();
const methodologyEvidenceManualSchema = methodologyRevisionSchema
  .omit({ id: true, basis: true })
  .extend({ sourceDecisionIds: methodologySourceIdsSchema })
  .strict();
const manualFormDraftKeySchema = z.enum([
  "methodology_manual",
  "methodology_evidence_manual",
  "methodology_merge",
  "methodology_revision",
  "practice_asset_manual",
]);
const methodologyMergeSchema = z
  .object({
    sourcePrincipleIds: z
      .array(candidateIdSchema)
      .min(2)
      .max(5)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Merge source principles cannot contain duplicates",
      ),
    title: z.string().trim().min(1).max(120),
    principle: z.string().trim().min(1).max(2_000),
    appliesWhen: z.string().trim().min(1).max(2_000),
    caution: z.string().trim().min(1).max(2_000),
    evidenceSummary: z.string().trim().min(1).max(3_000),
    sourceDecisionIds: methodologySourceIdsSchema,
  })
  .strict();
const methodologyEvolutionSchema = methodologyRevisionSchema
  .extend({ sourceDecisionIds: methodologySourceIdsSchema })
  .strict();
const methodologyVersionInputSchema = z
  .object({
    id: candidateIdSchema,
    version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const methodologySuggestionIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_200)
  .startsWith("suggestion:");
const methodologyStatusInputSchema = z
  .object({
    id: candidateIdSchema,
    status: z.enum(["accepted", "dismissed"]),
    acknowledgeQualityRisks: z.boolean().optional(),
  })
  .strict();
const methodologyEvidenceInputSchema = z
  .object({
    id: candidateIdSchema,
    sourceDecisionIds: methodologySourceIdsSchema,
  })
  .strict();
const methodologyImportCommitSchema = z
  .object({
    batchId: z.string().trim().min(1).max(200),
    selectedCandidateIds: z
      .array(z.string().trim().min(1).max(200))
      .min(1)
      .max(60)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Import candidate ids cannot contain duplicates",
      ),
  })
  .strict();
const methodologyRelationInputSchema = z
  .object({
    id: candidateIdSchema,
    relatedId: candidateIdSchema,
    disposition: z.enum(["duplicate", "conflict", "unrelated"]),
    note: z.string().max(500).nullable(),
  })
  .strict();
const methodologyRelationPairSchema = z
  .object({
    id: candidateIdSchema,
    relatedId: candidateIdSchema,
  })
  .strict();
const methodologyMergeLifecycleSchema = z
  .object({ mergeId: candidateIdSchema })
  .strict();
const methodologyMergeAssetSchema = z
  .object({
    mergeId: candidateIdSchema,
    assetId: candidateIdSchema,
  })
  .strict();
const practiceAssetKindSchema = z.enum(["skill", "workflow"]);
const practiceAssetStatusSchema = z.enum([
  "candidate",
  "accepted",
  "dismissed",
]);
const practiceAssetGenerateSchema = z
  .object({
    kind: practiceAssetKindSchema,
    sourcePrincipleIds: methodologySourceIdsSchema,
  })
  .strict();
const practiceAssetRevisionSchema = z
  .object({
    id: candidateIdSchema,
    title: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(800),
    trigger: z.string().trim().min(1).max(1_500),
    steps: z.array(z.string().trim().min(1).max(500)).min(2).max(12),
    checks: z.array(z.string().trim().min(1).max(500)).min(1).max(8),
    fallback: z.string().trim().min(1).max(1_500),
    basis: z.string().max(64_000).optional(),
  })
  .strict();
const practiceAssetManualSchema = practiceAssetRevisionSchema
  .omit({ id: true, basis: true })
  .extend({
    kind: practiceAssetKindSchema,
    sourcePrincipleIds: methodologySourceIdsSchema,
  })
  .strict();
const practiceAssetStatusInputSchema = z
  .object({
    id: candidateIdSchema,
    status: z.enum(["accepted", "dismissed"]),
  })
  .strict();
const practiceAssetVersionInputSchema = z
  .object({
    id: candidateIdSchema,
    version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const practicePublicationTargetSchema = z.enum(["codex", "claude-code"]);
const practicePublicationInputSchema = z
  .object({
    id: candidateIdSchema,
    target: practicePublicationTargetSchema,
    confirmOverwrite: z.boolean().optional(),
  })
  .strict();
const practicePublicationRollbackSchema = z
  .object({
    id: candidateIdSchema,
    target: practicePublicationTargetSchema,
  })
  .strict();
const modelTraceIdSchema = z.string().trim().min(1).max(200);
const modelProviderIdSchema = z.string().trim().min(1).max(200);
const modelProviderMutationSchema = z
  .object({
    profile: redactedModelProviderProfileSchema,
    secret: z.string().min(1).max(10_000).optional(),
  })
  .strict();
const modelProviderOrderSchema = z
  .array(modelProviderIdSchema)
  .min(1)
  .max(100)
  .refine(
    (profileIds) => new Set(profileIds).size === profileIds.length,
    "Provider order cannot contain duplicates",
  );
const modelProviderTestResultSchema = z
  .object({
    ok: z.boolean(),
    profileId: modelProviderIdSchema,
    latencyMs: z.number().int().nonnegative().max(120_000),
    requestId: modelProviderIdSchema,
    modelVersion: z.string().min(1).max(200).optional(),
    tokenSource: z
      .enum([
        "provider_reported",
        "runtime_measured",
        "estimated",
        "unavailable",
      ])
      .optional(),
    errorCode: z
      .enum([
        "timeout",
        "cancelled",
        "authentication_failed",
        "authorization_failed",
        "rate_limited",
        "quota_exhausted",
        "provider_unavailable",
        "invalid_output",
        "output_limit",
        "invalid_configuration",
        "credential_unavailable",
        "credential_decryption_failed",
        "network_error",
        "response_too_large",
        "redirect_rejected",
        "process_failed",
        "executable_missing",
        "unsupported_client",
        "trace_write_failed",
        "unknown",
      ])
      .optional(),
    availability: semanticRecognitionStatusSchema.shape.availability.optional(),
    providerRequestId: z.string().trim().min(1).max(200).optional(),
    processExitCode: z.number().int().min(-1).max(255).optional(),
    diagnosticExcerpt: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();
// Said as the knowledge page says it: refused here with no reason, the rationale step could not be fixed.
const expectedOutcomeInputSchema = z
  .string()
  .max(4_000)
  .refine((value) => value.trim().length > 0, "预期结果不能只有空白")
  .refine((value) => !RESERVED_SECTION_TEXT.test(value), "预期结果里不能有「## 后续结果」「## 复盘结论」这类笔记分节标题或 decision 标记，请改写后再保存");
const rationaleInputSchema = z.discriminatedUnion("status", [
  z.object({ candidateId: candidateIdSchema, status: z.literal("local_only"),
    rationale: z.string().max(8_000).refine(value => value.trim().length > 0).optional(),
    reasonFactors: z.array(z.string().min(1).max(64)).max(8).optional(),
    appliedPrincipleIds: appliedPrincipleIdsSchema.optional(), expectedOutcome: expectedOutcomeInputSchema.optional(),
  }).strict(),
  z
    .object({
      candidateId: candidateIdSchema,
      status: z.literal("captured"),
      rationale: z
        .string()
        .max(8_000)
        .refine((value) => value.trim().length > 0)
        .optional(),
      reasonFactors: z.array(z.string().min(1).max(64)).max(8).optional(),
      appliedPrincipleIds: appliedPrincipleIdsSchema.optional(),
      expectedOutcome: expectedOutcomeInputSchema.optional(),
    })
    .strict()
    .refine(
      (value) =>
        value.rationale !== undefined ||
        (value.reasonFactors?.length ?? 0) > 0 ||
        (value.appliedPrincipleIds?.length ?? 0) > 0,
    ),
  z
    .object({
      candidateId: candidateIdSchema,
      status: z.enum(["deferred", "skipped"]),
      appliedPrincipleIds: appliedPrincipleIdsSchema.optional(),
      expectedOutcome: expectedOutcomeInputSchema.optional(),
    })
    .strict(),
  z
    .object({
      candidateId: candidateIdSchema,
      status: z.literal("not_recorded"),
    })
    .strict(),
]);

/**
 * A refusal a page can show as it is. zod's own message is its issues as JSON, in English; a page
 * showing it told the reader nothing they could act on.
 */
const refusedInput = (error: z.ZodError): string => {
  const issue = error.issues[0];
  const reason = issue === undefined
    ? "格式不符合要求"
    : issue.code === "too_big"
      ? `超出上限（最多 ${String(issue.maximum)} ${issue.origin === "array" || issue.origin === "set" ? "项" : "字"}）`
      : issue.code === "too_small"
        ? "内容为空或太短"
        : /\p{Script=Han}/u.test(issue.message)
          ? issue.message
          : "格式不符合要求";
  return `内容不符合要求：${reason}。`;
};

interface IpcMainLike {
  handle(
    channel: string,
    handler: (event: unknown, input?: unknown) => Promise<unknown> | unknown,
  ): void;
  removeHandler(channel: string): void;
}

export interface DecisionIpcOperations extends Partial<DecisionEvidenceApi> {
  getSnapshot?(): AppSnapshot;
  openCandidateReview(): Promise<void> | void;
  closeCandidateReview(): Promise<void> | void;
  confirmCandidate(candidateId: string): Promise<void> | void;
  ignoreCandidate(candidateId: string): Promise<void> | void;
  retryCandidate(candidateId: string): Promise<void> | void;
  openSurface(surface: DesktopPrimarySurface): Promise<void> | void;
  closePrimarySurface(): Promise<void> | void;
  listDecisions(query: DecisionLibraryQuery): Promise<DecisionLibraryItem[]>;
  listDecisionProjects: DecisionApi["listDecisionProjects"];
  createProactiveRecord(input: ProactiveRecordInput): Promise<ProactiveRecordResult>;
  listJournalEntries(query: JournalEntryListQuery): Promise<JournalEntry[]>;
  reviseJournalEntry(id: string, input: JournalEntryRevisionInput): Promise<JournalEntry>;
  getObsidianSearchStatus?(): Promise<ObsidianSearchStatus>;
  searchObsidian?(input: {
    query: string;
    limit?: number;
  }): Promise<ObsidianSearchResponse>;
  rebuildObsidianSearch?(): Promise<ObsidianSearchStatus>;
  openObsidianNote?(relativePath: string): Promise<void>;
  openVaultDocument?(relativePath: string): Promise<void>;
  updateDecisionExpectedOutcome(
    decisionId: string,
    expectedOutcome: string,
    basis?: string,
  ): Promise<void>;
  updateDecisionOutcome(decisionId: string, outcome: string, basis?: string): Promise<void>;
  updateDecisionReviewDueDate(
    decisionId: string,
    reviewDueDate: string | null,
  ): Promise<void>;
  updateDecisionReview(
    decisionId: string,
    input: DecisionOutcomeReviewInput,
    basis?: string,
  ): Promise<OutcomeReview>;
  updateDecisionAppliedPrinciples(
    decisionId: string,
    principleIds: string[],
  ): Promise<DecisionAppliedPrinciple[]>;
  getDecisionPrincipleSuggestions(
    input: DecisionPrincipleSuggestionInput,
  ): Promise<DecisionPrincipleSuggestion[]>;
  validateDecisionAppliedPrinciples(principleIds: string[]): Promise<void>;
  getMethodologyBuildProgress(): Promise<MethodologyBuildProgress>;
  listMethodologies(status?: MethodologyStatus): Promise<MethodologyItem[]>;
  createManualMethodology(
    input: MethodologyManualInput,
  ): Promise<MethodologyItem>;
  createManualMethodologyFromEvidence(
    input: MethodologyEvidenceManualInput,
  ): Promise<MethodologyItem>;
  listManualFormDrafts(): Promise<ManualFormDraft[]>;
  saveManualFormDraft(input: ManualFormDraftInput): Promise<ManualFormDraft>;
  deleteManualFormDraft(key: ManualFormDraftKey): Promise<void>;
  generateMethodology(sourceDecisionIds: string[]): Promise<MethodologyItem>;
  createMethodologyMergeDraft(
    sourcePrincipleIds: string[],
    input: MethodologyMergeInput,
  ): Promise<MethodologyItem>;
  createMethodologyRevisionDraft(
    id: string,
    input: MethodologyEvolutionInput,
  ): Promise<MethodologyItem>;
  reviseMethodology(
    id: string,
    input: MethodologyRevisionInput,
    basis?: string,
  ): Promise<MethodologyItem>;
  setMethodologyStatus(
    id: string,
    status: "accepted" | "dismissed",
    acknowledgeQualityRisks?: boolean,
  ): Promise<MethodologyItem>;
  listMethodologyVersions(id: string): Promise<MethodologyVersionItem[]>;
  restoreMethodologyVersion(
    id: string,
    version: number,
  ): Promise<MethodologyItem>;
  getMethodologySuggestions(): Promise<MethodologySuggestion[]>;
  getDeferredMethodologySuggestions(): Promise<MethodologySuggestion[]>;
  deferMethodologySuggestion(id: string): Promise<void>;
  restoreMethodologySuggestion(id: string): Promise<void>;
  getMethodologyEvidenceMatches(
    id: string,
  ): Promise<MethodologyEvidenceMatch[]>;
  importMethodologyMarkdown(): Promise<MethodologyImportPreview>;
  commitMethodologyMarkdownImport(
    batchId: string,
    selectedCandidateIds: string[],
  ): Promise<MethodologyImportReport>;
  setMethodologyEvidence(
    id: string,
    sourceDecisionIds: string[],
  ): Promise<MethodologyItem>;
  setMethodologyRelation(
    id: string,
    relatedId: string,
    disposition: MethodologyRelationDisposition,
    note: string | null,
  ): Promise<MethodologyItem>;
  clearMethodologyRelation(
    id: string,
    relatedId: string,
  ): Promise<MethodologyItem>;
  getMethodologyUsage(id: string): Promise<MethodologyUsageSnapshot>;
  getMethodologyValidationInbox(): Promise<MethodologyValidationItem[]>;
  acknowledgeMethodologyValidation(id: string, seen: { reviewedAt: string; decisionId: string }): Promise<MethodologyItem>;
  getMethodologyMergePlan(
    mergeId: string,
  ): Promise<MethodologyMergeLifecyclePlan>;
  prepareMethodologyMergeAsset(
    mergeId: string,
    assetId: string,
  ): Promise<PracticeAssetItem>;
  retireMethodologyMergeSources(
    mergeId: string,
  ): Promise<MethodologyMergeLifecyclePlan>;
  restoreMethodologyMergeSources(
    mergeId: string,
  ): Promise<MethodologyMergeLifecyclePlan>;
  getDecisionAnalytics(): Promise<DecisionAnalyticsSnapshot>;
  getDecisionConsultationMetrics(): Promise<DecisionConsultationMetricsSnapshot>;
  previewDecisionConsultation(
    input: DecisionConsultationPreviewInput,
  ): Promise<DecisionConsultationResponse>;
  submitDecisionConsultationFeedback(
    input: DecisionConsultationFeedbackInput,
  ): Promise<DecisionConsultationFeedbackResult>;
  getKnowledgeGraph(): Promise<KnowledgeGraphSnapshot>;
  listPracticeAssets(
    status?: PracticeAssetStatus,
  ): Promise<PracticeAssetItem[]>;
  createManualPracticeAsset(
    kind: PracticeAssetKind,
    sourcePrincipleIds: string[],
    input: PracticeAssetRevisionInput,
  ): Promise<PracticeAssetItem>;
  generatePracticeAsset(
    kind: PracticeAssetKind,
    sourcePrincipleIds: string[],
  ): Promise<PracticeAssetItem>;
  revisePracticeAsset(
    id: string,
    input: PracticeAssetRevisionInput,
    basis?: string,
  ): Promise<PracticeAssetItem>;
  setPracticeAssetStatus(
    id: string,
    status: "accepted" | "dismissed",
  ): Promise<PracticeAssetItem>;
  regeneratePracticeAsset(id: string): Promise<PracticeAssetItem>;
  listPracticeAssetVersions(id: string): Promise<PracticeAssetVersionItem[]>;
  restorePracticeAssetVersion(
    id: string,
    version: number,
  ): Promise<PracticeAssetItem>;
  listPracticePublicationStatuses(
    id: string,
  ): Promise<PracticePublicationStatus[]>;
  publishPracticeAsset(
    id: string,
    target: PracticePublicationTarget,
    confirmOverwrite?: boolean,
  ): Promise<PracticePublicationReceipt>;
  rollbackPracticeAssetPublication(
    id: string,
    target: PracticePublicationTarget,
  ): Promise<PracticePublicationReceipt>;
  chooseVault(): Promise<string | null>;
  revealVault(): Promise<boolean>;
  installIntegrations(mode: InstallMode): Promise<InstallReport | unknown>;
  removeIntegrations(): Promise<InstallReport | unknown>;
  rebuildIndex(): Promise<RebuildReport>;
  setTheme(theme: ThemePreference): Promise<void>;
  listModelTraces(): Promise<ModelInvocationTrace[]>;
  deleteModelTrace(traceId: string): Promise<boolean>;
  deleteModelTraceRequest(requestId: string): Promise<number>;
  forgetAssistantTurns(turnIds: string[]): Promise<void>;
  clearModelTraces(): Promise<number>;
  setModelTraceContentEnabled(enabled: boolean): Promise<void>;
  setReviewRemindersEnabled(enabled: boolean): Promise<void>;
  setLocalCredentialsEnabled(enabled: boolean): Promise<void>;
  setCaptureClassifier(classifier: CaptureClassifier): Promise<void>;
  checkAssistantSource: DecisionApi["checkAssistantSource"];
  searchAssistantSources: DecisionApi["searchAssistantSources"];
  listPrConnections: DecisionApi["listPrConnections"];
  savePrConnection: DecisionApi["savePrConnection"];
  removePrConnection: DecisionApi["removePrConnection"];
  checkPrConnection: DecisionApi["checkPrConnection"];
  listPullRequests: DecisionApi["listPullRequests"];
  loadPrReview: DecisionApi["loadPrReview"];
  peekPrReview: DecisionApi["peekPrReview"];
  prefetchPrReviews: DecisionApi["prefetchPrReviews"];
  loadPrReviewDiff: DecisionApi["loadPrReviewDiff"];
  getPrActionContext: DecisionApi["getPrActionContext"];
  performPrAction: DecisionApi["performPrAction"];
  publishPrReviewComment: DecisionApi["publishPrReviewComment"];
  publishPrGeneralComment: DecisionApi["publishPrGeneralComment"];
  reevaluatePrReviewFinding: DecisionApi["reevaluatePrReviewFinding"];
  openReviewRulesDirectory: DecisionApi["openReviewRulesDirectory"];
  listPrDiscussion: DecisionApi["listPrDiscussion"];
  openPrLink: DecisionApi["openPrLink"];
  openPr: DecisionApi["openPr"];
  loadPrReviewFile: DecisionApi["loadPrReviewFile"];
  runPrReview: DecisionApi["runPrReview"];
  followUpPrReview: DecisionApi["followUpPrReview"];
  cancelPrReview: DecisionApi["cancelPrReview"];
  runAssistantTurn(
    input: AssistantTurnRequest,
  ): Promise<AssistantTurnResponse>;
  listAssistantModels(): Promise<RetrievalAnswerProvider[]>;
  cancelAssistantTurn(turnId: string): Promise<void>;
  saveAssistantFeedback(
    input: AssistantFeedbackInput,
  ): Promise<AssistantFeedbackResult>;
  exportAssistantConversation(input: {
    suggestedName: string;
    markdown: string;
  }): Promise<AssistantExportResult>;
  getAssistantFeedbackSummary(): Promise<AssistantFeedbackSummary>;
  listManagedQwenModels: DecisionApi["listManagedQwenModels"];
  installManagedQwenModel: DecisionApi["installManagedQwenModel"];
  listModelProviderProfiles(): Promise<RedactedModelProviderProfile[]>;
  saveModelProviderProfile(
    input: ModelProviderMutationInput,
  ): Promise<RedactedModelProviderProfile>;
  deleteModelProviderProfile(profileId: string): Promise<boolean>;
  reorderModelProviderProfiles(profileIds: string[]): Promise<void>;
  testModelProviderProfile(profileId: string): Promise<ModelProviderTestResult>;
  listLocalModelClientStatuses(): Promise<LocalModelClientStatus[]>;
  completeDeferredRationale?(
    id: string,
    input: { rationale: string; reasonFactors?: string[] },
  ): Promise<void>;
  skipDeferredRationale?(id: string): Promise<void>;
  discardDeferredRationale?(id: string): Promise<void>;
  keepLocalRationale?(id: string, input: { rationale?: string; reasonFactors?: string[] }): Promise<void>;
  listLocalDecisions?(query: string, offset: number): Promise<import("../shared/renderer-api.js").LocalDecisionPage>;
  resolveLocalDecision?(id: string, action: "publish" | "discard"): Promise<void>;
}

interface RegisterDecisionIpcOptions {
  ipcMain: IpcMainLike;
  queue: RationaleQueue;
  candidates?: DecisionCandidateQueue;
  operations: DecisionIpcOperations;
}

export const registerDecisionIpc = (
  options: RegisterDecisionIpcOptions,
): (() => void) => {
  const currentCandidateId = (input: unknown): string => {
    const candidateId = candidateIdSchema.parse(input);
    if (options.candidates?.snapshot().current?.candidateId !== candidateId) {
      throw new Error("Input does not target the current decision candidate");
    }
    return candidateId;
  };
  const handlers: Array<
    readonly [
      string,
      (event: unknown, input?: unknown) => Promise<unknown> | unknown,
    ]
  > = [
    [
      IPC_CHANNELS.snapshot,
      () => options.operations.getSnapshot?.() ?? options.queue.snapshot(),
    ],
    [
      IPC_CHANNELS.rationale,
      async (_event, input) => {
        const parsed = rationaleInputSchema.parse(input);
        if (
          parsed.status !== "not_recorded" &&
          (parsed.appliedPrincipleIds?.length ?? 0) > 0
        ) {
          await options.operations.validateDecisionAppliedPrinciples(
            parsed.appliedPrincipleIds ?? [],
          );
        }
        const current = options.queue.snapshot().current;
        if (current?.candidateId !== parsed.candidateId) {
          if (parsed.status === "local_only" && options.operations.keepLocalRationale) {
            const { candidateId, status: _status, ...completion } = parsed;
            return options.operations.keepLocalRationale(candidateId, {
              ...(completion.rationale === undefined ? {} : { rationale: completion.rationale }),
              ...(completion.reasonFactors === undefined ? {} : { reasonFactors: completion.reasonFactors }),
            });
          }
          if (
            parsed.status === "captured" &&
            options.operations.completeDeferredRationale !== undefined
          ) {
            if (parsed.rationale === undefined) {
              throw new Error("Deferred rationale completion requires text");
            }
            return options.operations.completeDeferredRationale(
              parsed.candidateId,
              {
                rationale: parsed.rationale,
                ...(parsed.reasonFactors === undefined
                  ? {}
                  : { reasonFactors: parsed.reasonFactors }),
              },
            );
          }
          if (
            parsed.status === "skipped" &&
            options.operations.skipDeferredRationale !== undefined
          ) {
            return options.operations.skipDeferredRationale(parsed.candidateId);
          }
          if (
            parsed.status === "not_recorded" &&
            options.operations.discardDeferredRationale !== undefined
          ) {
            return options.operations.discardDeferredRationale(
              parsed.candidateId,
            );
          }
          throw new Error(
            "Input does not target the current rationale candidate",
          );
        }
        const { candidateId: _candidateId, ...submission } =
          parsed as RationaleInput;
        return options.queue.submit(submission);
      },
    ],
    [
      IPC_CHANNELS.retryPersistence,
      () => options.queue.retryCurrentPersistence(),
    ],
    [
      IPC_CHANNELS.openCandidateReview,
      () => options.operations.openCandidateReview(),
    ],
    [
      IPC_CHANNELS.closeCandidateReview,
      () => options.operations.closeCandidateReview(),
    ],
    [
      IPC_CHANNELS.confirmCandidate,
      (_event, input) =>
        options.operations.confirmCandidate(currentCandidateId(input)),
    ],
    [
      IPC_CHANNELS.ignoreCandidate,
      (_event, input) =>
        options.operations.ignoreCandidate(currentCandidateId(input)),
    ],
    [
      IPC_CHANNELS.retryCandidate,
      (_event, input) =>
        options.operations.retryCandidate(currentCandidateId(input)),
    ],
    [
      IPC_CHANNELS.openSurface,
      (_event, input) =>
        options.operations.openSurface(
          z.enum(DESKTOP_PRIMARY_SURFACES).parse(input),
        ),
    ],
    [
      IPC_CHANNELS.closePrimarySurface,
      () => options.operations.closePrimarySurface(),
    ],
    [
      IPC_CHANNELS.listDecisions,
      (_event, input) =>
        options.operations.listDecisions(parseDecisionLibraryQuery(input)),
    ],
    [
      IPC_CHANNELS.listDecisionProjects,
      async () =>
        z
          .array(z.object({ project: z.string().min(1).max(500), count: z.number().int().positive() }).strict())
          .max(200)
          .parse(await options.operations.listDecisionProjects()),
    ],
    [
      IPC_CHANNELS.createProactiveRecord,
      (_event, input) =>
        options.operations.createProactiveRecord(
          proactiveRecordInputSchema
            // Here, not in the shared schema: the renderer cannot load the record module this comes from.
            // Refused only when the note was written, it came back as an English internal message.
            .refine(
              (record) =>
                record.kind !== "decision" ||
                record.expectedOutcome === undefined ||
                !RESERVED_SECTION_TEXT.test(record.expectedOutcome),
              {
                path: ["expectedOutcome"],
                message:
                  "预期结果里不能有「## 后续结果」「## 复盘结论」这类笔记分节标题或 decision 标记，请改写后再保存",
              },
            )
            .parse(input),
        ),
    ],
    [
      IPC_CHANNELS.listJournalEntries,
      (_event, input) =>
        options.operations.listJournalEntries(
          journalEntryListQuerySchema.parse(input) as JournalEntryListQuery,
        ),
    ],
    [
      IPC_CHANNELS.reviseJournalEntry,
      (_event, input) => {
        const parsed = journalEntryRevisionSchema.parse(input);
        return options.operations.reviseJournalEntry(parsed.id, {
          draft: parsed.draft,
          change: parsed.change,
          ...(parsed.basis === undefined ? {} : { basis: parsed.basis }),
        } as JournalEntryRevisionInput);
      },
    ],
    [
      IPC_CHANNELS.getObsidianSearchStatus,
      async (_event, input) => {
        z.undefined().parse(input);
        return parseObsidianOperationOutput(
          () => {
            if (options.operations.getObsidianSearchStatus === undefined) {
              throw new Error();
            }
            return options.operations.getObsidianSearchStatus();
          },
          obsidianSearchStatusSchema,
          OBSIDIAN_IPC_FAILURE_MESSAGES.status,
        );
      },
    ],
    [
      IPC_CHANNELS.searchObsidian,
      async (_event, input) => {
        const parsed = parseObsidianSearchInput(input);
        return parseObsidianOperationOutput(
          () => {
            if (options.operations.searchObsidian === undefined) {
              throw new Error();
            }
            return options.operations.searchObsidian(parsed);
          },
          obsidianSearchResponseSchema,
          OBSIDIAN_IPC_FAILURE_MESSAGES.search,
        );
      },
    ],
    [
      IPC_CHANNELS.rebuildObsidianSearch,
      async (_event, input) => {
        z.undefined().parse(input);
        return parseObsidianOperationOutput(
          () => {
            if (options.operations.rebuildObsidianSearch === undefined) {
              throw new Error();
            }
            return options.operations.rebuildObsidianSearch();
          },
          obsidianSearchStatusSchema,
          OBSIDIAN_IPC_FAILURE_MESSAGES.rebuild,
        );
      },
    ],
    [
      IPC_CHANNELS.searchDecisionContext,
      async (_event, input) => {
        const parsed = decisionContextQuerySchema.parse(input);
        const operation = options.operations.searchDecisionContext;
        if (operation === undefined) throw new Error("请更新 App 后重试此操作。");
        return decisionContextResponseSchema.parse(await operation(parsed));
      },
    ],
    [
      IPC_CHANNELS.updateDecisionScope,
      async (_event, input) => {
        const parsed = decisionScopeUpdateSchema.parse(input);
        const operation = options.operations.updateDecisionScope;
        if (operation === undefined) throw new Error("请更新 App 后重试此操作。");
        return decisionScopeUpdateResultSchema.parse(await operation(parsed));
      },
    ],
    [
      IPC_CHANNELS.updateDecisionRelation,
      async (_event, input) => {
        const parsed = decisionRelationUpdateSchema.parse(input);
        const operation = options.operations.updateDecisionRelation;
        if (operation === undefined) throw new Error("请更新 App 后重试此操作。");
        return decisionRelationUpdateResultSchema.parse(await operation(parsed));
      },
    ],
    [
      IPC_CHANNELS.openDecisionSource,
      async (_event, input) => {
        const parsed = decisionSourceReferenceSchema.parse(input);
        const operation = options.operations.openDecisionSource;
        if (operation === undefined) throw new Error("请更新 App 后重试此操作。");
        return decisionSourceOpenResultSchema.parse(await operation(parsed));
      },
    ],
    [
      IPC_CHANNELS.prepareDecisionHandoff,
      async (_event, input) => {
        const parsed = decisionHandoffRequestSchema.parse(input);
        const operation = options.operations.prepareDecisionHandoff;
        if (operation === undefined) throw new Error("请更新 App 后重试此操作。");
        return decisionHandoffResponseSchema.parse(await operation(parsed));
      },
    ],
    [IPC_CHANNELS.saveDecisionContextFeedback, async (_event, input) => {
      const parsed = decisionFeedbackUpdateSchema.parse(input);
      const operation = options.operations.saveDecisionContextFeedback;
      if (operation === undefined) throw new Error("请更新 App 后重试此操作。");
      return decisionFeedbackUpdateResultSchema.parse(await operation(parsed));
    }],
    [IPC_CHANNELS.getDecisionContextFeedback, async (_event, input) => {
      const parsed = decisionFeedbackQuerySchema.parse(input);
      const operation = options.operations.getDecisionContextFeedback;
      if (operation === undefined) throw new Error("请更新 App 后重试此操作。");
      return decisionFeedbackResponseSchema.parse(await operation(parsed));
    }],
    [
      IPC_CHANNELS.openObsidianNote,
      async (_event, input) => {
        const relativePath = obsidianNotePathSchema.parse(input);
        return parseObsidianOperationOutput(
          () => {
            if (options.operations.openObsidianNote === undefined) {
              throw new Error();
            }
            return options.operations.openObsidianNote(relativePath);
          },
          z.undefined(),
          OBSIDIAN_IPC_FAILURE_MESSAGES.open,
        );
      },
    ],
    [
      IPC_CHANNELS.saveAssistantFeedback,
      async (_event, input) =>
        assistantFeedbackResultSchema.parse(
          await options.operations.saveAssistantFeedback(
            assistantFeedbackInputSchema.parse(input),
          ),
        ),
    ],
    [
      IPC_CHANNELS.exportAssistantConversation,
      async (_event, input) => {
        const parsed = z
          .object({
            suggestedName: z.string().trim().min(1).max(200),
            markdown: z.string().min(1).max(2_000_000),
          })
          .strict()
          .parse(input);
        return assistantExportResultSchema.parse(
          await options.operations.exportAssistantConversation(parsed),
        );
      },
    ],
    [
      IPC_CHANNELS.getAssistantFeedbackSummary,
      async () =>
        assistantFeedbackSummarySchema.parse(
          await options.operations.getAssistantFeedbackSummary(),
        ),
    ],
    [
      IPC_CHANNELS.cancelAssistantTurn,
      async (_event, input) => {
        await options.operations.cancelAssistantTurn(
          z.string().trim().min(1).max(200).parse(input),
        );
        return undefined;
      },
    ],
    [
      IPC_CHANNELS.openVaultDocument,
      async (_event, input) => {
        const relativePath = obsidianNotePathSchema.parse(input);
        return parseObsidianOperationOutput(
          () => {
            if (options.operations.openVaultDocument === undefined) {
              throw new Error();
            }
            return options.operations.openVaultDocument(relativePath);
          },
          z.undefined(),
          OBSIDIAN_IPC_FAILURE_MESSAGES.openDocument,
        );
      },
    ],
    [
      IPC_CHANNELS.updateDecisionExpectedOutcome,
      (_event, input) => {
        const parsed = decisionExpectedOutcomeInputSchema.parse(input);
        return options.operations.updateDecisionExpectedOutcome(
          parsed.decisionId,
          parsed.expectedOutcome,
          ...(parsed.basis === undefined ? [] as const : [parsed.basis] as const),
        );
      },
    ],
    [
      IPC_CHANNELS.updateDecisionOutcome,
      (_event, input) => {
        const parsed = decisionOutcomeInputSchema.parse(input);
        return options.operations.updateDecisionOutcome(
          parsed.decisionId,
          parsed.outcome,
          ...(parsed.basis === undefined ? [] as const : [parsed.basis] as const),
        );
      },
    ],
    [
      IPC_CHANNELS.updateDecisionReview,
      (_event, input) => {
        const parsed = decisionReviewInputSchema.parse(input);
        return options.operations.updateDecisionReview(parsed.decisionId, {
          verdict: parsed.verdict,
          lesson: parsed.lesson,
        }, ...(parsed.basis === undefined ? [] as const : [parsed.basis] as const));
      },
    ],
    [
      IPC_CHANNELS.updateDecisionAppliedPrinciples,
      (_event, input) => {
        const parsed = decisionAppliedPrinciplesInputSchema.parse(input);
        return options.operations.updateDecisionAppliedPrinciples(
          parsed.decisionId,
          parsed.principleIds,
        );
      },
    ],
    [
      IPC_CHANNELS.getDecisionPrincipleSuggestions,
      (_event, input) =>
        options.operations.getDecisionPrincipleSuggestions(
          decisionPrincipleSuggestionInputSchema.parse(input),
        ),
    ],
    [
      IPC_CHANNELS.getMethodologyBuildProgress,
      (_event, input) => {
        z.undefined().parse(input);
        return options.operations.getMethodologyBuildProgress();
      },
    ],
    [
      IPC_CHANNELS.updateDecisionReviewDueDate,
      (_event, input) => {
        const parsed = decisionReviewDueDateInputSchema.parse(input);
        return options.operations.updateDecisionReviewDueDate(
          parsed.decisionId,
          parsed.reviewDueDate,
        );
      },
    ],
    [
      IPC_CHANNELS.listMethodologies,
      (_event, input) =>
        options.operations.listMethodologies(
          methodologyStatusSchema.optional().parse(input),
        ),
    ],
    [
      IPC_CHANNELS.createManualMethodology,
      (_event, input) =>
        options.operations.createManualMethodology(
          methodologyManualSchema.parse(input),
        ),
    ],
    [
      IPC_CHANNELS.createManualMethodologyFromEvidence,
      (_event, input) =>
        options.operations.createManualMethodologyFromEvidence(
          methodologyEvidenceManualSchema.parse(input),
        ),
    ],
    [
      IPC_CHANNELS.listManualFormDrafts,
      (_event, input) => {
        z.undefined().parse(input);
        return options.operations.listManualFormDrafts();
      },
    ],
    [
      IPC_CHANNELS.saveManualFormDraft,
      (_event, input) =>
        options.operations.saveManualFormDraft(
          manualFormDraftInputSchema.parse(input) as ManualFormDraftInput,
        ),
    ],
    [
      IPC_CHANNELS.deleteManualFormDraft,
      (_event, input) =>
        options.operations.deleteManualFormDraft(
          manualFormDraftKeySchema.parse(input),
        ),
    ],
    [
      IPC_CHANNELS.generateMethodology,
      (_event, input) =>
        options.operations.generateMethodology(
          methodologySourceIdsSchema.parse(input),
        ),
    ],
    [
      IPC_CHANNELS.createMethodologyMergeDraft,
      (_event, input) => {
        const parsed = methodologyMergeSchema.parse(input);
        return options.operations.createMethodologyMergeDraft(
          parsed.sourcePrincipleIds,
          {
            title: parsed.title,
            principle: parsed.principle,
            appliesWhen: parsed.appliesWhen,
            caution: parsed.caution,
            evidenceSummary: parsed.evidenceSummary,
            sourceDecisionIds: parsed.sourceDecisionIds,
          },
        );
      },
    ],
    [
      IPC_CHANNELS.createMethodologyRevisionDraft,
      (_event, input) => {
        const parsed = methodologyEvolutionSchema.parse(input);
        return options.operations.createMethodologyRevisionDraft(parsed.id, {
          title: parsed.title,
          principle: parsed.principle,
          appliesWhen: parsed.appliesWhen,
          caution: parsed.caution,
          evidenceSummary: parsed.evidenceSummary,
          sourceDecisionIds: parsed.sourceDecisionIds,
        });
      },
    ],
    [
      IPC_CHANNELS.reviseMethodology,
      (_event, input) => {
        const parsed = methodologyRevisionSchema.parse(input);
        const revision = {
          title: parsed.title,
          principle: parsed.principle,
          appliesWhen: parsed.appliesWhen,
          caution: parsed.caution,
          evidenceSummary: parsed.evidenceSummary,
        };
        return parsed.basis === undefined
          ? options.operations.reviseMethodology(parsed.id, revision)
          : options.operations.reviseMethodology(parsed.id, revision, parsed.basis);
      },
    ],
    [
      IPC_CHANNELS.setMethodologyStatus,
      (_event, input) => {
        const parsed = methodologyStatusInputSchema.parse(input);
        return parsed.acknowledgeQualityRisks === undefined
          ? options.operations.setMethodologyStatus(parsed.id, parsed.status)
          : options.operations.setMethodologyStatus(
              parsed.id,
              parsed.status,
              parsed.acknowledgeQualityRisks,
            );
      },
    ],
    [
      IPC_CHANNELS.listMethodologyVersions,
      (_event, input) =>
        options.operations.listMethodologyVersions(
          candidateIdSchema.parse(input),
        ),
    ],
    [
      IPC_CHANNELS.restoreMethodologyVersion,
      (_event, input) => {
        const parsed = methodologyVersionInputSchema.parse(input);
        return options.operations.restoreMethodologyVersion(
          parsed.id,
          parsed.version,
        );
      },
    ],
    [
      IPC_CHANNELS.getMethodologySuggestions,
      () => options.operations.getMethodologySuggestions(),
    ],
    [
      IPC_CHANNELS.getDeferredMethodologySuggestions,
      () => options.operations.getDeferredMethodologySuggestions(),
    ],
    [
      IPC_CHANNELS.deferMethodologySuggestion,
      (_event, input) =>
        options.operations.deferMethodologySuggestion(
          methodologySuggestionIdSchema.parse(input),
        ),
    ],
    [
      IPC_CHANNELS.restoreMethodologySuggestion,
      (_event, input) =>
        options.operations.restoreMethodologySuggestion(
          methodologySuggestionIdSchema.parse(input),
        ),
    ],
    [
      IPC_CHANNELS.getMethodologyEvidenceMatches,
      (_event, input) =>
        options.operations.getMethodologyEvidenceMatches(
          candidateIdSchema.parse(input),
        ),
    ],
    [
      IPC_CHANNELS.importMethodologyMarkdown,
      (_event, input) => {
        z.undefined().parse(input);
        return options.operations.importMethodologyMarkdown();
      },
    ],
    [
      IPC_CHANNELS.commitMethodologyMarkdownImport,
      (_event, input) => {
        const parsed = methodologyImportCommitSchema.parse(input);
        return options.operations.commitMethodologyMarkdownImport(
          parsed.batchId,
          parsed.selectedCandidateIds,
        );
      },
    ],
    [
      IPC_CHANNELS.setMethodologyEvidence,
      (_event, input) => {
        const parsed = methodologyEvidenceInputSchema.parse(input);
        return options.operations.setMethodologyEvidence(
          parsed.id,
          parsed.sourceDecisionIds,
        );
      },
    ],
    [
      IPC_CHANNELS.setMethodologyRelation,
      (_event, input) => {
        const parsed = methodologyRelationInputSchema.parse(input);
        return options.operations.setMethodologyRelation(
          parsed.id,
          parsed.relatedId,
          parsed.disposition,
          parsed.note,
        );
      },
    ],
    [
      IPC_CHANNELS.clearMethodologyRelation,
      (_event, input) => {
        const parsed = methodologyRelationPairSchema.parse(input);
        return options.operations.clearMethodologyRelation(
          parsed.id,
          parsed.relatedId,
        );
      },
    ],
    [
      IPC_CHANNELS.getMethodologyMergePlan,
      (_event, input) =>
        options.operations.getMethodologyMergePlan(
          methodologyMergeLifecycleSchema.parse(input).mergeId,
        ),
    ],
    [
      IPC_CHANNELS.getMethodologyUsage,
      (_event, input) =>
        options.operations.getMethodologyUsage(candidateIdSchema.parse(input)),
    ],
    [
      IPC_CHANNELS.getMethodologyValidationInbox,
      (_event, input) => {
        z.undefined().parse(input);
        return options.operations.getMethodologyValidationInbox();
      },
    ],
    [
      IPC_CHANNELS.acknowledgeMethodologyValidation,
      (_event, input) => {
        // As the note holds it (an offset, no milliseconds, typed in Obsidian): main compares it as written.
        const parsed = z.object({ id: candidateIdSchema, reviewedAt: z.string().min(1).max(100), decisionId: candidateIdSchema })
          .strict().parse(input);
        return options.operations.acknowledgeMethodologyValidation(parsed.id, {
          reviewedAt: parsed.reviewedAt,
          decisionId: parsed.decisionId,
        });
      },
    ],
    [
      IPC_CHANNELS.prepareMethodologyMergeAsset,
      (_event, input) => {
        const parsed = methodologyMergeAssetSchema.parse(input);
        return options.operations.prepareMethodologyMergeAsset(
          parsed.mergeId,
          parsed.assetId,
        );
      },
    ],
    [
      IPC_CHANNELS.retireMethodologyMergeSources,
      (_event, input) =>
        options.operations.retireMethodologyMergeSources(
          methodologyMergeLifecycleSchema.parse(input).mergeId,
        ),
    ],
    [
      IPC_CHANNELS.restoreMethodologyMergeSources,
      (_event, input) =>
        options.operations.restoreMethodologyMergeSources(
          methodologyMergeLifecycleSchema.parse(input).mergeId,
        ),
    ],
    [
      IPC_CHANNELS.getDecisionAnalytics,
      () => options.operations.getDecisionAnalytics(),
    ],
    [
      IPC_CHANNELS.getDecisionConsultationMetrics,
      (_event, input) => {
        z.undefined().parse(input);
        return options.operations.getDecisionConsultationMetrics();
      },
    ],
    [
      IPC_CHANNELS.previewDecisionConsultation,
      (_event, input) =>
        options.operations.previewDecisionConsultation(
          decisionConsultationPreviewInputSchema.parse(input),
        ),
    ],
    [
      IPC_CHANNELS.submitDecisionConsultationFeedback,
      (_event, input) =>
        options.operations.submitDecisionConsultationFeedback(
          decisionConsultationFeedbackInputSchema.parse(input),
        ),
    ],
    [
      IPC_CHANNELS.getKnowledgeGraph,
      () => options.operations.getKnowledgeGraph(),
    ],
    [
      IPC_CHANNELS.listPracticeAssets,
      (_event, input) =>
        options.operations.listPracticeAssets(
          practiceAssetStatusSchema.optional().parse(input),
        ),
    ],
    [
      IPC_CHANNELS.createManualPracticeAsset,
      (_event, input) => {
        const parsed = practiceAssetManualSchema.parse(input);
        return options.operations.createManualPracticeAsset(
          parsed.kind,
          parsed.sourcePrincipleIds,
          {
            title: parsed.title,
            summary: parsed.summary,
            trigger: parsed.trigger,
            steps: parsed.steps,
            checks: parsed.checks,
            fallback: parsed.fallback,
          },
        );
      },
    ],
    [
      IPC_CHANNELS.generatePracticeAsset,
      (_event, input) => {
        const parsed = practiceAssetGenerateSchema.parse(input);
        return options.operations.generatePracticeAsset(
          parsed.kind,
          parsed.sourcePrincipleIds,
        );
      },
    ],
    [
      IPC_CHANNELS.revisePracticeAsset,
      (_event, input) => {
        const parsed = practiceAssetRevisionSchema.parse(input);
        return options.operations.revisePracticeAsset(parsed.id, {
          title: parsed.title,
          summary: parsed.summary,
          trigger: parsed.trigger,
          steps: parsed.steps,
          checks: parsed.checks,
          fallback: parsed.fallback,
        }, parsed.basis);
      },
    ],
    [
      IPC_CHANNELS.setPracticeAssetStatus,
      (_event, input) => {
        const parsed = practiceAssetStatusInputSchema.parse(input);
        return options.operations.setPracticeAssetStatus(
          parsed.id,
          parsed.status,
        );
      },
    ],
    [
      IPC_CHANNELS.regeneratePracticeAsset,
      (_event, input) =>
        options.operations.regeneratePracticeAsset(
          candidateIdSchema.parse(input),
        ),
    ],
    [
      IPC_CHANNELS.listPracticeAssetVersions,
      (_event, input) =>
        options.operations.listPracticeAssetVersions(
          candidateIdSchema.parse(input),
        ),
    ],
    [
      IPC_CHANNELS.restorePracticeAssetVersion,
      (_event, input) => {
        const parsed = practiceAssetVersionInputSchema.parse(input);
        return options.operations.restorePracticeAssetVersion(
          parsed.id,
          parsed.version,
        );
      },
    ],
    [
      IPC_CHANNELS.listPracticePublicationStatuses,
      (_event, input) =>
        options.operations.listPracticePublicationStatuses(
          candidateIdSchema.parse(input),
        ),
    ],
    [
      IPC_CHANNELS.publishPracticeAsset,
      (_event, input) => {
        const parsed = practicePublicationInputSchema.parse(input);
        return options.operations.publishPracticeAsset(
          parsed.id,
          parsed.target,
          parsed.confirmOverwrite,
        );
      },
    ],
    [
      IPC_CHANNELS.rollbackPracticeAssetPublication,
      (_event, input) => {
        const parsed = practicePublicationRollbackSchema.parse(input);
        return options.operations.rollbackPracticeAssetPublication(
          parsed.id,
          parsed.target,
        );
      },
    ],
    [IPC_CHANNELS.chooseVault, () => options.operations.chooseVault()],
    [IPC_CHANNELS.revealVault, () => options.operations.revealVault()],
    [
      IPC_CHANNELS.installIntegrations,
      (_event, input) =>
        options.operations.installIntegrations(
          z.enum(["dry-run", "apply"]).parse(input),
        ),
    ],
    [IPC_CHANNELS.removeIntegrations, () => options.operations.removeIntegrations()],
    [IPC_CHANNELS.listLocalDecisions, (_event, input) => {
      const value = z.object({ query: z.string().max(200), offset: z.number().int().min(0).max(1_000_000) }).strict().parse(input);
      if (!options.operations.listLocalDecisions) throw new Error("本机记录不可用。");
      return options.operations.listLocalDecisions(value.query, value.offset);
    }],
    [IPC_CHANNELS.resolveLocalDecision, (_event, input) => {
      const value = z.object({ id: candidateIdSchema, action: z.enum(["publish", "discard"]) }).strict().parse(input);
      if (!options.operations.resolveLocalDecision) throw new Error("本机记录不可用。");
      return options.operations.resolveLocalDecision(value.id, value.action);
    }],
    [IPC_CHANNELS.rebuildIndex, () => options.operations.rebuildIndex()],
    [
      IPC_CHANNELS.setTheme,
      (_event, input) =>
        options.operations.setTheme(z.enum(THEME_PREFERENCES).parse(input)),
    ],
    [IPC_CHANNELS.listModelTraces, () => options.operations.listModelTraces()],
    [
      IPC_CHANNELS.deleteModelTrace,
      (_event, input) =>
        options.operations.deleteModelTrace(modelTraceIdSchema.parse(input)),
    ],
    [
      IPC_CHANNELS.deleteModelTraceRequest,
      (_event, input) =>
        options.operations.deleteModelTraceRequest(
          modelTraceIdSchema.parse(input),
        ),
    ],
    [
      IPC_CHANNELS.forgetAssistantTurns,
      (_event, input) =>
        options.operations.forgetAssistantTurns(
          z.array(modelTraceIdSchema).max(1_000).parse(input),
        ),
    ],
    [
      IPC_CHANNELS.clearModelTraces,
      () => options.operations.clearModelTraces(),
    ],
    [
      IPC_CHANNELS.setModelTraceContentEnabled,
      (_event, input) =>
        options.operations.setModelTraceContentEnabled(
          z.boolean().parse(input),
        ),
    ],
    [
      IPC_CHANNELS.setLocalCredentialsEnabled,
      (_event, input) =>
        options.operations.setLocalCredentialsEnabled(z.boolean().parse(input)),
    ],
    [
      IPC_CHANNELS.setReviewRemindersEnabled,
      (_event, input) =>
        options.operations.setReviewRemindersEnabled(z.boolean().parse(input)),
    ],
    [
      IPC_CHANNELS.setCaptureClassifier,
      (_event, input) =>
        options.operations.setCaptureClassifier(
          z.enum(CAPTURE_CLASSIFIERS).parse(input),
        ),
    ],
    [
      IPC_CHANNELS.checkAssistantSource,
      async (_event, input) => assistantSourceCheckSchema.parse(await options.operations.checkAssistantSource(retrievalAnswerCitationSchema.parse(input))),
    ],
    [
      IPC_CHANNELS.searchAssistantSources,
      async (_event, input: unknown) => {
        const parsed = z.object({ query: z.string().trim().min(1).max(500), scope: retrievalAnswerScopeSchema }).strict().parse(input);
        return z.object({ sources: z.array(retrievalAnswerCitationSchema).max(12), issues: z.array(z.string().max(1000)).max(20) }).strict().parse(await options.operations.searchAssistantSources(parsed));
      },
    ],
    [IPC_CHANNELS.listPrConnections, async () => z.array(prConnectionSchema).max(20).parse(await options.operations.listPrConnections())],
    [IPC_CHANNELS.savePrConnection, async (_event, input) => z.array(prConnectionSchema).max(20).parse(await options.operations.savePrConnection(prConnectionInputSchema.parse(input)))],
    [IPC_CHANNELS.removePrConnection, async (_event, input) => z.array(prConnectionSchema).max(20).parse(await options.operations.removePrConnection(z.string().uuid().parse(input)))],
    [IPC_CHANNELS.checkPrConnection, async (_event, input) => z.object({ account: z.string().min(1).max(300) }).strict().parse(await options.operations.checkPrConnection(z.string().uuid().parse(input)))],
    [IPC_CHANNELS.listPullRequests, async (_event, input) => prListResponseSchema.parse(await options.operations.listPullRequests(prListQuerySchema.parse(input)))],
    [IPC_CHANNELS.loadPrReviewFile, async (_event, input) => prReviewFileResponseSchema.parse(await options.operations.loadPrReviewFile(prReviewFileRequestSchema.parse(input)))],
    [IPC_CHANNELS.getPrActionContext, async (_event, input) => prActionContextSchema.parse(await options.operations.getPrActionContext(prReviewDiffRequestSchema.parse(input)))],
    [IPC_CHANNELS.performPrAction, async (_event, input) => prActionResultSchema.parse(await options.operations.performPrAction(prActionRequestSchema.parse(input)))],
    [IPC_CHANNELS.publishPrReviewComment, async (_event, input) => prReviewCommentResultSchema.parse(await options.operations.publishPrReviewComment(prReviewCommentRequestSchema.parse(input)))],
    [IPC_CHANNELS.publishPrGeneralComment, async (_event, input) => prReviewCommentResultSchema.parse(await options.operations.publishPrGeneralComment(prGeneralCommentRequestSchema.parse(input)))],
    [IPC_CHANNELS.reevaluatePrReviewFinding, async (_event, input) => prReviewVerdictSchema.parse(await options.operations.reevaluatePrReviewFinding(prReviewReevaluateSchema.parse(input)))],
    [IPC_CHANNELS.openReviewRulesDirectory, async () => { await options.operations.openReviewRulesDirectory(); }],
    [IPC_CHANNELS.listPrDiscussion, async (_event, input) => prDiscussionSchema.parse(await options.operations.listPrDiscussion(prReviewLoadSchema.parse(input)))],
    [IPC_CHANNELS.openPrLink, async (_event, url) => { await options.operations.openPrLink(z.string().url().max(2_000).parse(url)); }],
    [IPC_CHANNELS.openPr, async (_event, input) => { await options.operations.openPr(prReviewLoadSchema.parse(input)); }],
    [IPC_CHANNELS.loadPrReviewDiff, async (_event, input) => prReviewDiffResponseSchema.parse(await options.operations.loadPrReviewDiff(prReviewDiffRequestSchema.parse(input)))],
    [IPC_CHANNELS.loadPrReview, async (_event, input) => prReviewSnapshotSchema.parse(await options.operations.loadPrReview(prReviewLoadSchema.parse(input)))],
    [IPC_CHANNELS.peekPrReview, async (_event, input) => prReviewSnapshotSchema.nullable().parse(await options.operations.peekPrReview(prReviewLoadSchema.parse(input)))],
    [IPC_CHANNELS.prefetchPrReviews, async (_event, input) => { await options.operations.prefetchPrReviews(prReviewPrefetchSchema.parse(input)); }],
    [IPC_CHANNELS.runPrReview, async (_event, input) => prReviewReportSchema.parse(await options.operations.runPrReview(prReviewRunSchema.parse(input)))],
    [IPC_CHANNELS.followUpPrReview, async (_event, input) => prReviewFollowUpResultSchema.parse(await options.operations.followUpPrReview(prReviewFollowUpSchema.parse(input)))],
    [IPC_CHANNELS.cancelPrReview, async (_event, input) => options.operations.cancelPrReview(z.string().uuid().parse(input))],
    [
      IPC_CHANNELS.runAssistantTurn,
      async (_event, input) =>
        assistantTurnResponseSchema.parse(
          await options.operations.runAssistantTurn(
            assistantTurnRequestSchema.parse(input),
          ),
        ),
    ],
    [
      IPC_CHANNELS.listAssistantModels,
      async () =>
        z
          .array(retrievalAnswerProviderSchema)
          .max(100)
          .parse(await options.operations.listAssistantModels()),
    ],
    [
      IPC_CHANNELS.listManagedQwenModels,
      async () => z.array(managedQwenModelStatusSchema).max(2).parse(await options.operations.listManagedQwenModels()),
    ],
    [
      IPC_CHANNELS.installManagedQwenModel,
      async (_event, input) => options.operations.installManagedQwenModel(managedQwenModelIdSchema.parse(input)),
    ],
    [
      IPC_CHANNELS.listModelProviderProfiles,
      async () =>
        z
          .array(redactedModelProviderProfileSchema)
          .max(100)
          .parse(await options.operations.listModelProviderProfiles()),
    ],
    [
      IPC_CHANNELS.saveModelProviderProfile,
      async (_event, input) => {
        const parsed = modelProviderMutationSchema.parse(input);
        return redactedModelProviderProfileSchema.parse(
          await options.operations.saveModelProviderProfile({
            profile: parsed.profile,
            ...(parsed.secret === undefined ? {} : { secret: parsed.secret }),
          }),
        );
      },
    ],
    [
      IPC_CHANNELS.deleteModelProviderProfile,
      (_event, input) =>
        options.operations.deleteModelProviderProfile(
          modelProviderIdSchema.parse(input),
        ),
    ],
    [
      IPC_CHANNELS.reorderModelProviderProfiles,
      (_event, input) =>
        options.operations.reorderModelProviderProfiles(
          modelProviderOrderSchema.parse(input),
        ),
    ],
    [
      IPC_CHANNELS.testModelProviderProfile,
      async (_event, input) =>
        modelProviderTestResultSchema.parse(
          await options.operations.testModelProviderProfile(
            modelProviderIdSchema.parse(input),
          ),
        ),
    ],
    [
      IPC_CHANNELS.listLocalModelClientStatuses,
      async () =>
        z
          .array(localModelClientStatusSchema)
          .max(2)
          .parse(await options.operations.listLocalModelClientStatuses()),
    ],
  ];

  for (const [channel, handler] of handlers) {
    options.ipcMain.handle(channel, async (event, input) => {
      try {
        return await handler(event, input);
      } catch (error) {
        if (error instanceof z.ZodError) throw new Error(refusedInput(error));
        // A disk full or a folder refused, in words: from every write but a capture's, the page showed Node's own
        // English line, with a temporary file's name in it.
        const refusal = fileSystemRefusal(error);
        throw refusal === null ? error : new Error(refusal, { cause: error });
      }
    });
  }
  return () => {
    for (const [channel] of handlers) {
      options.ipcMain.removeHandler(channel);
    }
  };
};
