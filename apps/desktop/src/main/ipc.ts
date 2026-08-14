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
} from "../shared/renderer-api.js";
import { IPC_CHANNELS } from "../shared/renderer-api.js";
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
    rationaleStatus: z.enum(["captured", "deferred", "skipped"]).optional(),
    sourceClient: z.enum(["claude-code", "codex", "test"]).optional(),
    reviewState: z
      .enum([
        "pending_outcome",
        "pending_review",
        "reviewed",
        "attention",
        "due",
        "scheduled",
        "unscheduled",
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
    ...(parsed.rationaleStatus === undefined
      ? {}
      : { rationaleStatus: parsed.rationaleStatus }),
    ...(parsed.sourceClient === undefined
      ? {}
      : { sourceClient: parsed.sourceClient }),
    ...(parsed.reviewState === undefined
      ? {}
      : { reviewState: parsed.reviewState }),
    ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
  };
};
const decisionOutcomeInputSchema = z
  .object({
    decisionId: candidateIdSchema,
    outcome: z
      .string()
      .max(8_000)
      .refine((value) => value.trim().length > 0),
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
  })
  .strict();
const methodologyManualSchema = methodologyRevisionSchema
  .omit({ id: true, evidenceSummary: true })
  .strict();
const methodologyEvidenceManualSchema = methodologyRevisionSchema
  .omit({ id: true })
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
  })
  .strict();
const practiceAssetManualSchema = practiceAssetRevisionSchema
  .omit({ id: true })
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
const rationaleInputSchema = z.discriminatedUnion("status", [
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
    })
    .strict(),
  z
    .object({
      candidateId: candidateIdSchema,
      status: z.literal("not_recorded"),
    })
    .strict(),
]);

interface IpcMainLike {
  handle(
    channel: string,
    handler: (event: unknown, input?: unknown) => Promise<unknown> | unknown,
  ): void;
  removeHandler(channel: string): void;
}

export interface DecisionIpcOperations {
  getSnapshot?(): AppSnapshot;
  openCandidateReview(): Promise<void> | void;
  closeCandidateReview(): Promise<void> | void;
  confirmCandidate(candidateId: string): Promise<void> | void;
  ignoreCandidate(candidateId: string): Promise<void> | void;
  retryCandidate(candidateId: string): Promise<void> | void;
  openSurface(surface: DesktopPrimarySurface): Promise<void> | void;
  closePrimarySurface(): Promise<void> | void;
  listDecisions(query: DecisionLibraryQuery): Promise<DecisionLibraryItem[]>;
  updateDecisionOutcome(decisionId: string, outcome: string): Promise<void>;
  updateDecisionReviewDueDate(
    decisionId: string,
    reviewDueDate: string | null,
  ): Promise<void>;
  updateDecisionReview(
    decisionId: string,
    input: DecisionOutcomeReviewInput,
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
  acknowledgeMethodologyValidation(id: string): Promise<MethodologyItem>;
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
  installIntegrations(mode: InstallMode): Promise<InstallReport | unknown>;
  rebuildIndex(): Promise<RebuildReport>;
  setTheme(theme: ThemePreference): Promise<void>;
  listModelTraces(): Promise<ModelInvocationTrace[]>;
  deleteModelTrace(traceId: string): Promise<boolean>;
  deleteModelTraceRequest(requestId: string): Promise<number>;
  clearModelTraces(): Promise<number>;
  setModelTraceContentEnabled(enabled: boolean): Promise<void>;
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
          z
            .enum([
              "dashboard",
              "decisions",
              "methodology",
              "clients",
              "models",
              "activity",
              "settings",
            ])
            .parse(input),
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
      IPC_CHANNELS.updateDecisionOutcome,
      (_event, input) => {
        const parsed = decisionOutcomeInputSchema.parse(input);
        return options.operations.updateDecisionOutcome(
          parsed.decisionId,
          parsed.outcome,
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
        });
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
        return options.operations.reviseMethodology(parsed.id, {
          title: parsed.title,
          principle: parsed.principle,
          appliesWhen: parsed.appliesWhen,
          caution: parsed.caution,
          evidenceSummary: parsed.evidenceSummary,
        });
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
      (_event, input) =>
        options.operations.acknowledgeMethodologyValidation(
          candidateIdSchema.parse(input),
        ),
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
        });
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
    [
      IPC_CHANNELS.installIntegrations,
      (_event, input) =>
        options.operations.installIntegrations(
          z.enum(["dry-run", "apply"]).parse(input),
        ),
    ],
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
    options.ipcMain.handle(channel, handler);
  }
  return () => {
    for (const [channel] of handlers) {
      options.ipcMain.removeHandler(channel);
    }
  };
};
