import type {
  CandidateQueueSnapshot,
  DecisionAnalyticsSnapshot,
  KnowledgeGraphSnapshot,
  MethodologyConfidence,
  MethodologyBuildProgress,
  MethodologyEvidenceMatch,
  MethodologyImportSource,
  MethodologyOrigin,
  MethodologyQualityAssessment,
  MethodologyRelationDisposition,
  MethodologyStatus,
  MethodologySuggestion,
  OutcomeReview,
  OutcomeVerdict,
  PracticeAssetKind,
  PracticeAssetFreshness,
  PracticeAssetHistoryReason,
  PracticeAssetSourceChange,
  PracticeAssetSourceSnapshot,
  PracticeAssetStatus,
  PracticePublicationReceipt,
  PracticePublicationStatus,
  PracticePublicationTarget,
  RationaleQueueSnapshot,
  RationaleSubmission,
} from "@cognelis/decision-core";
import type { InstallMode, InstallReport } from "@cognelis/decision-integrations";
import type {
  DecisionConsultationFeedbackRating,
  DecisionConsultationFeedbackResult,
  DecisionConsultationMetricsSnapshot,
  DecisionConsultationResponse,
  ModelInvocationTrace,
  ModelInvocationErrorCode,
  LocalModelClientStatus,
  NormalizedTokenUsage,
  RedactedModelProviderProfile,
  SemanticRecognitionStatus,
} from "@cognelis/decision-protocol";
import type { RebuildReport } from "@cognelis/decision-storage";

import type { ThemePreference } from "./appearance.js";

export const RENDERER_METHOD_NAMES = [
  "getSnapshot",
  "onSnapshot",
  "submitRationale",
  "retryPersistence",
  "openCandidateReview",
  "closeCandidateReview",
  "confirmCandidate",
  "ignoreCandidate",
  "retryCandidate",
  "openSurface",
  "closePrimarySurface",
  "listDecisions",
  "updateDecisionOutcome",
  "updateDecisionReviewDueDate",
  "updateDecisionReview",
  "updateDecisionAppliedPrinciples",
  "getDecisionPrincipleSuggestions",
  "getMethodologyBuildProgress",
  "listMethodologies",
  "createManualMethodology",
  "createManualMethodologyFromEvidence",
  "listManualFormDrafts",
  "saveManualFormDraft",
  "deleteManualFormDraft",
  "generateMethodology",
  "createMethodologyMergeDraft",
  "createMethodologyRevisionDraft",
  "reviseMethodology",
  "setMethodologyStatus",
  "listMethodologyVersions",
  "restoreMethodologyVersion",
  "getMethodologySuggestions",
  "getDeferredMethodologySuggestions",
  "deferMethodologySuggestion",
  "restoreMethodologySuggestion",
  "getMethodologyEvidenceMatches",
  "importMethodologyMarkdown",
  "commitMethodologyMarkdownImport",
  "setMethodologyEvidence",
  "setMethodologyRelation",
  "clearMethodologyRelation",
  "getMethodologyUsage",
  "getMethodologyValidationInbox",
  "acknowledgeMethodologyValidation",
  "getMethodologyMergePlan",
  "prepareMethodologyMergeAsset",
  "retireMethodologyMergeSources",
  "restoreMethodologyMergeSources",
  "getDecisionAnalytics",
  "getDecisionConsultationMetrics",
  "previewDecisionConsultation",
  "submitDecisionConsultationFeedback",
  "getKnowledgeGraph",
  "listPracticeAssets",
  "createManualPracticeAsset",
  "generatePracticeAsset",
  "revisePracticeAsset",
  "setPracticeAssetStatus",
  "regeneratePracticeAsset",
  "listPracticeAssetVersions",
  "restorePracticeAssetVersion",
  "listPracticePublicationStatuses",
  "publishPracticeAsset",
  "rollbackPracticeAssetPublication",
  "chooseVault",
  "installIntegrations",
  "rebuildIndex",
  "setTheme",
  "listModelTraces",
  "deleteModelTrace",
  "deleteModelTraceRequest",
  "clearModelTraces",
  "setModelTraceContentEnabled",
  "listModelProviderProfiles",
  "saveModelProviderProfile",
  "deleteModelProviderProfile",
  "reorderModelProviderProfiles",
  "testModelProviderProfile",
  "listLocalModelClientStatuses",
] as const;

export const METHODOLOGY_RECORD_METHOD_NAMES = [
  "acknowledgeMethodologyValidation",
  "clearMethodologyRelation",
  "commitMethodologyMarkdownImport",
  "createManualMethodology",
  "createManualMethodologyFromEvidence",
  "createMethodologyMergeDraft",
  "createMethodologyRevisionDraft",
  "deferMethodologySuggestion",
  "deleteManualFormDraft",
  "generateMethodology",
  "getDeferredMethodologySuggestions",
  "getKnowledgeGraph",
  "getMethodologyBuildProgress",
  "getMethodologyEvidenceMatches",
  "getMethodologyMergePlan",
  "getMethodologySuggestions",
  "getMethodologyUsage",
  "getMethodologyValidationInbox",
  "importMethodologyMarkdown",
  "listDecisions",
  "listManualFormDrafts",
  "listMethodologies",
  "listMethodologyVersions",
  "openSurface",
  "prepareMethodologyMergeAsset",
  "restoreMethodologyMergeSources",
  "restoreMethodologySuggestion",
  "restoreMethodologyVersion",
  "retireMethodologyMergeSources",
  "reviseMethodology",
  "saveManualFormDraft",
  "setMethodologyEvidence",
  "setMethodologyRelation",
  "setMethodologyStatus",
] as const satisfies readonly (keyof DecisionApi)[];

export const DECISION_ANALYTICS_METHOD_NAMES = [
  "getDecisionAnalytics",
  "getDecisionConsultationMetrics",
  "previewDecisionConsultation",
  "submitDecisionConsultationFeedback",
] as const satisfies readonly (keyof DecisionApi)[];

export const PRACTICE_ASSET_METHOD_NAMES = [
  "createManualPracticeAsset",
  "deleteManualFormDraft",
  "generatePracticeAsset",
  "listManualFormDrafts",
  "listMethodologies",
  "listPracticeAssets",
  "listPracticeAssetVersions",
  "listPracticePublicationStatuses",
  "publishPracticeAsset",
  "regeneratePracticeAsset",
  "restorePracticeAssetVersion",
  "revisePracticeAsset",
  "rollbackPracticeAssetPublication",
  "saveManualFormDraft",
  "setPracticeAssetStatus",
] as const satisfies readonly (keyof DecisionApi)[];

export const IPC_CHANNELS = {
  snapshot: "decision:get-snapshot",
  snapshotChanged: "decision:snapshot",
  rationale: "decision:submit-rationale",
  retryPersistence: "decision:retry-persistence",
  openCandidateReview: "decision:open-candidate-review",
  closeCandidateReview: "decision:close-candidate-review",
  confirmCandidate: "decision:confirm-candidate",
  ignoreCandidate: "decision:ignore-candidate",
  retryCandidate: "decision:retry-candidate",
  openSurface: "decision:open-surface",
  closePrimarySurface: "decision:close-primary-surface",
  listDecisions: "decision:list-decisions",
  updateDecisionOutcome: "decision:update-decision-outcome",
  updateDecisionReviewDueDate:
    "decision:update-decision-review-due-date",
  updateDecisionReview: "decision:update-decision-review",
  updateDecisionAppliedPrinciples:
    "decision:update-decision-applied-principles",
  getDecisionPrincipleSuggestions:
    "decision:get-decision-principle-suggestions",
  getMethodologyBuildProgress: "decision:get-methodology-build-progress",
  listMethodologies: "decision:list-methodologies",
  createManualMethodology: "decision:create-manual-methodology",
  createManualMethodologyFromEvidence:
    "decision:create-manual-methodology-from-evidence",
  listManualFormDrafts: "decision:list-manual-form-drafts",
  saveManualFormDraft: "decision:save-manual-form-draft",
  deleteManualFormDraft: "decision:delete-manual-form-draft",
  generateMethodology: "decision:generate-methodology",
  createMethodologyMergeDraft: "decision:create-methodology-merge-draft",
  createMethodologyRevisionDraft:
    "decision:create-methodology-revision-draft",
  reviseMethodology: "decision:revise-methodology",
  setMethodologyStatus: "decision:set-methodology-status",
  listMethodologyVersions: "decision:list-methodology-versions",
  restoreMethodologyVersion: "decision:restore-methodology-version",
  getMethodologySuggestions: "decision:get-methodology-suggestions",
  getDeferredMethodologySuggestions:
    "decision:get-deferred-methodology-suggestions",
  deferMethodologySuggestion: "decision:defer-methodology-suggestion",
  restoreMethodologySuggestion:
    "decision:restore-methodology-suggestion",
  getMethodologyEvidenceMatches:
    "decision:get-methodology-evidence-matches",
  importMethodologyMarkdown: "decision:import-methodology-markdown",
  commitMethodologyMarkdownImport:
    "decision:commit-methodology-markdown-import",
  setMethodologyEvidence: "decision:set-methodology-evidence",
  setMethodologyRelation: "decision:set-methodology-relation",
  clearMethodologyRelation: "decision:clear-methodology-relation",
  getMethodologyUsage: "decision:get-methodology-usage",
  getMethodologyValidationInbox:
    "decision:get-methodology-validation-inbox",
  acknowledgeMethodologyValidation:
    "decision:acknowledge-methodology-validation",
  getMethodologyMergePlan: "decision:get-methodology-merge-plan",
  prepareMethodologyMergeAsset:
    "decision:prepare-methodology-merge-asset",
  retireMethodologyMergeSources:
    "decision:retire-methodology-merge-sources",
  restoreMethodologyMergeSources:
    "decision:restore-methodology-merge-sources",
  getDecisionAnalytics: "decision:get-decision-analytics",
  getDecisionConsultationMetrics:
    "decision:get-decision-consultation-metrics",
  previewDecisionConsultation: "decision:preview-decision-consultation",
  submitDecisionConsultationFeedback:
    "decision:submit-decision-consultation-feedback",
  getKnowledgeGraph: "decision:get-knowledge-graph",
  listPracticeAssets: "decision:list-practice-assets",
  createManualPracticeAsset: "decision:create-manual-practice-asset",
  generatePracticeAsset: "decision:generate-practice-asset",
  revisePracticeAsset: "decision:revise-practice-asset",
  setPracticeAssetStatus: "decision:set-practice-asset-status",
  regeneratePracticeAsset: "decision:regenerate-practice-asset",
  listPracticeAssetVersions: "decision:list-practice-asset-versions",
  restorePracticeAssetVersion: "decision:restore-practice-asset-version",
  listPracticePublicationStatuses:
    "decision:list-practice-publication-statuses",
  publishPracticeAsset: "decision:publish-practice-asset",
  rollbackPracticeAssetPublication:
    "decision:rollback-practice-asset-publication",
  chooseVault: "decision:choose-vault",
  installIntegrations: "decision:install-integrations",
  rebuildIndex: "decision:rebuild-index",
  setTheme: "decision:set-theme",
  listModelTraces: "decision:list-model-traces",
  deleteModelTrace: "decision:delete-model-trace",
  deleteModelTraceRequest: "decision:delete-model-trace-request",
  clearModelTraces: "decision:clear-model-traces",
  setModelTraceContentEnabled:
    "decision:set-model-trace-content-enabled",
  listModelProviderProfiles: "decision:list-model-provider-profiles",
  saveModelProviderProfile: "decision:save-model-provider-profile",
  deleteModelProviderProfile: "decision:delete-model-provider-profile",
  reorderModelProviderProfiles:
    "decision:reorder-model-provider-profiles",
  testModelProviderProfile: "decision:test-model-provider-profile",
  listLocalModelClientStatuses:
    "decision:list-local-model-client-statuses",
} as const;

export interface AppHealth {
  index: "healthy" | "degraded";
  indexMessage?: string;
  recovery: "healthy" | "degraded";
  recoveryMessage?: string;
}

export interface IntegrationStatus {
  claudeCode:
    | "installed"
    | "upgrade-required"
    | "not-installed"
    | "unknown";
  codex:
    | "installed"
    | "upgrade-required"
    | "not-installed"
    | "unknown";
}

export interface PendingRationaleSummary {
  id: string;
  question: string;
  created: string;
  project: string;
  sourceClient: string;
  selectedAnswer: string;
  contextSummary: string | null;
}

export interface CandidateReviewProgress {
  position: number;
  total: number;
}

export type PrimarySurface =
  | "hidden"
  | "dashboard"
  | "decisions"
  | "methodology"
  | "clients"
  | "models"
  | "activity"
  | "settings";

export type DesktopPrimarySurface = Exclude<PrimarySurface, "hidden">;

export interface RecentDecisionSummary {
  id: string;
  created: string;
  sourceClient: string;
  project: string;
  question: string;
  selectedAnswer: string;
  rationaleStatus: "captured" | "deferred" | "skipped";
}

export type DecisionRationaleFilter = "captured" | "deferred" | "skipped";

export type DecisionSourceFilter = "claude-code" | "codex" | "test";

export interface DecisionLibraryQuery {
  query: string;
  searchMode?: "keyword" | "semantic";
  decisionId?: string;
  rationaleStatus?: DecisionRationaleFilter;
  sourceClient?: DecisionSourceFilter;
  reviewState?:
    | "pending_outcome"
    | "pending_review"
    | "reviewed"
    | "attention"
    | "due"
    | "scheduled"
    | "unscheduled";
  limit?: number;
}

export interface DecisionLibraryItem extends RecentDecisionSummary {
  rationale: string | null;
  context: string | null;
  outcome: string | null;
  outcomeReview: OutcomeReview | null;
  reviewDueDate: string | null;
  appliedPrincipleIds: string[];
  appliedPrinciples: DecisionAppliedPrinciple[];
  searchMatch?: "keyword" | "semantic" | "hybrid";
}

export interface DecisionAppliedPrinciple {
  id: string;
  title: string;
  status: MethodologyStatus;
}

export interface DecisionPrincipleSuggestionInput {
  question: string;
  selectedAnswer: string;
  optionLabels: string[];
  context: string | null;
}

export interface DecisionPrincipleSuggestion {
  id: string;
  title: string;
  principle: string;
  appliesWhen: string;
  caution: string;
  score: number;
  strength: "strong" | "possible";
  reason: string;
  matchedTerms: string[];
}

export type { MethodologyBuildProgress } from "@cognelis/decision-core";

export interface DecisionOutcomeReviewInput {
  verdict: OutcomeVerdict;
  lesson: string | null;
}

export interface MethodologyItem {
  id: string;
  createdAt: string;
  updatedAt: string;
  origin: MethodologyOrigin;
  status: MethodologyStatus;
  confirmedAt: string | null;
  retiredAt?: string;
  supersededById?: string;
  usageValidation?: {
    reviewedAt: string;
    decisionId: string;
    validatedAt: string;
  };
  title: string;
  principle: string;
  appliesWhen: string;
  caution: string;
  evidenceSummary: string;
  sourceDecisionIds: string[];
  sourcePrincipleIds?: string[];
  sourcePrinciples?: MethodologySourcePrinciple[];
  importSource?: MethodologyImportSource;
  sourceDecisions: DecisionLibraryItem[];
  confidence: MethodologyConfidence;
  quality: MethodologyQualityAssessment;
  generation: {
    requestId: string;
    profileId: string;
    provider: string;
    model: string;
  };
}

export interface MethodologySourcePrinciple {
  id: string;
  status: MethodologyStatus;
  title: string;
  principle: string;
  appliesWhen: string;
  caution: string;
  retiredAt?: string;
  supersededById?: string;
}

export interface MethodologyMergeLifecycleSource {
  id: string;
  title: string;
  status: MethodologyStatus;
  retiredAt: string | null;
  supersededById: string | null;
}

export interface MethodologyMergeLifecycleAsset {
  id: string;
  title: string;
  kind: PracticeAssetKind;
  status: PracticeAssetStatus;
  sourcePrincipleIds: string[];
  targetSourcePrincipleIds: string[];
  replacementId: string | null;
  replacementTitle: string | null;
}

export interface MethodologyMergeLifecyclePlan {
  mergeId: string;
  mergeTitle: string;
  mergeStatus: MethodologyStatus;
  sources: MethodologyMergeLifecycleSource[];
  relationValid: boolean;
  retired: boolean;
  canRetire: boolean;
  canRestore: boolean;
  modelCallsRequired: number;
  pendingReviewCount: number;
  assets: MethodologyMergeLifecycleAsset[];
}

export interface MethodologyUsageDecision {
  id: string;
  created: string;
  project: string;
  question: string;
  selectedAnswer: string;
  outcome: string | null;
  outcomeReview: OutcomeReview | null;
}

export interface MethodologyUsageSnapshot {
  principleId: string;
  linkedDecisionCount: number;
  outcomeRecordedCount: number;
  reviewedCount: number;
  pendingOutcomeCount: number;
  pendingReviewCount: number;
  favorableCount: number;
  mixedCount: number;
  attentionCount: number;
  unclearCount: number;
  decisions: MethodologyUsageDecision[];
  nextPendingDecision: MethodologyUsageDecision | null;
}

export interface MethodologyValidationDecision {
  id: string;
  project: string;
  question: string;
  selectedAnswer: string;
  verdict: OutcomeVerdict;
  lesson: string | null;
  reviewedAt: string;
}

export interface MethodologyValidationItem {
  principleId: string;
  title: string;
  principle: string;
  newReviewedCount: number;
  favorableCount: number;
  attentionCount: number;
  unclearCount: number;
  newestReviewedAt: string;
  revisionDraftId: string | null;
  decisions: MethodologyValidationDecision[];
}

export interface MethodologyImportIssue {
  fileName: string;
  title?: string;
  message: string;
}

export interface MethodologyImportDuplicate {
  fileName: string;
  title: string;
  existingTitle: string;
}

export interface MethodologyImportPreviewCandidate {
  id: string;
  fileName: string;
  title: string;
  principle: string;
  appliesWhen: string;
  caution: string;
  sourceDecisionCount: number;
  missingFields: Array<"appliesWhen" | "caution">;
  similarTo: {
    title: string;
    status: MethodologyStatus | "selection";
  } | null;
}

export interface MethodologyImportPreview {
  cancelled: boolean;
  batchId: string | null;
  candidates: MethodologyImportPreviewCandidate[];
  duplicates: MethodologyImportDuplicate[];
  failures: MethodologyImportIssue[];
}

export interface MethodologyImportReport {
  imported: MethodologyItem[];
  duplicates: MethodologyImportDuplicate[];
  failures: MethodologyImportIssue[];
}

export interface MethodologyRevisionInput {
  title: string;
  principle: string;
  appliesWhen: string;
  caution: string;
  evidenceSummary: string;
}

export type MethodologyManualInput = Omit<
  MethodologyRevisionInput,
  "evidenceSummary"
>;

export interface MethodologyEvidenceManualInput extends MethodologyRevisionInput {
  sourceDecisionIds: string[];
}

export interface MethodologyMergeInput extends MethodologyRevisionInput {
  sourceDecisionIds: string[];
}

export interface MethodologyEvolutionInput extends MethodologyRevisionInput {
  sourceDecisionIds: string[];
}

export interface MethodologyVersionItem {
  version: number;
  capturedAt: string;
  reason: "revision_applied" | "restore_checkpoint";
  snapshot: {
    updatedAt: string;
    title: string;
    principle: string;
    appliesWhen: string;
    caution: string;
    evidenceSummary: string;
    sourceDecisionIds: string[];
    confidence: MethodologyConfidence;
    provider: string;
    model: string;
  };
}

export interface PracticeAssetSourcePrinciple {
  id: string;
  updatedAt: string;
  status: MethodologyStatus;
  title: string;
  principle: string;
  appliesWhen: string;
  caution: string;
  confidence: MethodologyConfidence;
}

export interface PracticeAssetItem {
  id: string;
  slug: string;
  kind: PracticeAssetKind;
  status: PracticeAssetStatus;
  createdAt: string;
  updatedAt: string;
  acceptedAt: string | null;
  title: string;
  summary: string;
  trigger: string;
  steps: string[];
  checks: string[];
  fallback: string;
  sourcePrincipleIds: string[];
  migrationSourcePrincipleIds?: string[];
  sourcePrinciples: PracticeAssetSourcePrinciple[];
  supersedesId: string | null;
  freshness: PracticeAssetFreshness;
  sourceChanges: PracticeAssetSourceChange[];
  generation: {
    requestId: string;
    profileId: string;
    provider: string;
    model: string;
  };
}

export interface PracticeAssetVersionItem {
  version: number;
  capturedAt: string;
  reason: PracticeAssetHistoryReason;
  snapshot: {
    updatedAt: string;
    title: string;
    summary: string;
    trigger: string;
    steps: string[];
    checks: string[];
    fallback: string;
    sourcePrincipleIds: string[];
    sourceSnapshots?: PracticeAssetSourceSnapshot[];
  };
}

export interface PracticeAssetRevisionInput {
  title: string;
  summary: string;
  trigger: string;
  steps: string[];
  checks: string[];
  fallback: string;
}

export type ManualFormDraftKey =
  | "methodology_manual"
  | "methodology_evidence_manual"
  | "methodology_merge"
  | "methodology_revision"
  | "practice_asset_manual";

export type ManualFormDraftInput =
  | {
      key: "methodology_manual";
      input: MethodologyManualInput;
    }
  | {
      key: "methodology_evidence_manual";
      input: MethodologyEvidenceManualInput;
    }
  | {
      key: "methodology_merge";
      sourcePrincipleIds: string[];
      input: MethodologyMergeInput;
    }
  | {
      key: "methodology_revision";
      sourcePrincipleId: string;
      sourceUpdatedAt: string;
      sourceSnapshot?: MethodologyEvolutionInput;
      input: MethodologyEvolutionInput;
    }
  | {
      key: "practice_asset_manual";
      practiceKind: PracticeAssetKind;
      sourcePrincipleIds: string[];
      input: PracticeAssetRevisionInput;
    };

export type ManualFormDraft = ManualFormDraftInput & {
  updatedAt: string;
};

export interface DashboardSnapshot {
  totalDecisions: number;
  recorded7d: number;
  reviewAttention: number;
  recentDecisions: RecentDecisionSummary[];
}

export interface AppSnapshot extends RationaleQueueSnapshot {
  primarySurface: PrimarySurface;
  dashboard: DashboardSnapshot;
  candidateReviewOpen: boolean;
  candidateReviewProgress: CandidateReviewProgress | null;
  decisionCandidates: CandidateQueueSnapshot;
  theme: ThemePreference;
  vaultPath: string | null;
  health: AppHealth;
  integrationStatus: IntegrationStatus;
  pendingRationales: PendingRationaleSummary[];
  semanticRecognition: SemanticRecognitionStatus;
  modelTraceContentEnabled?: boolean;
}

export type RationaleInput = RationaleSubmission & {
  candidateId: string;
};

export interface ModelProviderMutationInput {
  profile: RedactedModelProviderProfile;
  secret?: string;
}

export interface ModelProviderTestResult {
  ok: boolean;
  profileId: string;
  latencyMs: number;
  requestId: string;
  modelVersion?: string;
  tokenSource?: NormalizedTokenUsage["source"];
  errorCode?: ModelInvocationErrorCode;
  availability?: SemanticRecognitionStatus["availability"];
  providerRequestId?: string;
  processExitCode?: number;
  diagnosticExcerpt?: string;
}

export interface DecisionConsultationPreviewInput {
  question: string;
  options: string[];
  context: string | null;
}

export interface DecisionConsultationFeedbackInput {
  token: string;
  rating: DecisionConsultationFeedbackRating;
}

export interface DecisionApi {
  getSnapshot(): Promise<AppSnapshot>;
  onSnapshot(listener: (snapshot: AppSnapshot) => void): () => void;
  submitRationale(input: RationaleInput): Promise<void>;
  retryPersistence(): Promise<void>;
  openCandidateReview(): Promise<void>;
  closeCandidateReview(): Promise<void>;
  confirmCandidate(candidateId: string): Promise<void>;
  ignoreCandidate(candidateId: string): Promise<void>;
  retryCandidate(candidateId: string): Promise<void>;
  openSurface(surface: DesktopPrimarySurface): Promise<void>;
  closePrimarySurface(): Promise<void>;
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
    status: Extract<MethodologyStatus, "accepted" | "dismissed">,
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
    status: Extract<PracticeAssetStatus, "accepted" | "dismissed">,
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
  installIntegrations(mode: InstallMode): Promise<InstallReport>;
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
}

export type MethodologyRecordsApi = Pick<
  DecisionApi,
  (typeof METHODOLOGY_RECORD_METHOD_NAMES)[number]
>;

export type DecisionAnalyticsApi = Pick<
  DecisionApi,
  (typeof DECISION_ANALYTICS_METHOD_NAMES)[number]
>;

export type PracticeAssetsApi = Pick<
  DecisionApi,
  (typeof PRACTICE_ASSET_METHOD_NAMES)[number]
>;

export type MethodologyWorkspaceApi = MethodologyRecordsApi &
  DecisionAnalyticsApi &
  PracticeAssetsApi;

declare global {
  interface Window {
    decision: DecisionApi;
  }
}
