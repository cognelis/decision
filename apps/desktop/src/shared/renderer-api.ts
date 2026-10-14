import type { ManagedQwenModelId, ManagedQwenModelStatus } from "@cognelis/decision-protocol";
import type { PrDiscussion, PrActionContext, PrActionRequest, PrActionResult, PrReviewCommentRequest, PrGeneralCommentRequest, PrReviewCommentResult, PrReviewReevaluate, PrReviewVerdict, PrReviewFileRequest, PrReviewFileResponse, PrReviewDiffRequest, PrReviewDiffResponse, PrReviewFollowUp, PrReviewFollowUpResult, PrReviewLoad, PrReviewPrefetch, PrReviewSnapshot, PrReviewRun, PrReviewReport, PrReviewProgress, PrConnection, PrConnectionInput, PrListQuery, PrListResponse } from "@cognelis/decision-protocol";
import type { ProactiveRecordInput } from "./proactive-record.js";
export type { ProactiveRecordInput } from "./proactive-record.js";
import type { DecisionFeedbackUpdate, DecisionFeedbackUpdateResult, DecisionFeedbackQuery, DecisionFeedbackResponse } from "@cognelis/decision-protocol";
import type {
  AssistantSourceCheck,
  AssistantExportResult,
  AssistantFeedbackInput,
  AssistantFeedbackSummary,
  AssistantFeedbackResult,
  AssistantProgress,
  AssistantTurnRequest,
  AssistantTurnResponse,
  RetrievalAnswerProvider,
  RetrievalAnswerCitation,
  RetrievalAnswerScope,
} from "@cognelis/decision-protocol";
import type { DecisionContextQuery, DecisionContextResponse, DecisionScopeUpdate, DecisionScopeUpdateResult, DecisionRelationUpdate, DecisionRelationUpdateResult, DecisionSourceReference, DecisionSourceOpenResult, DecisionHandoffRequest, DecisionHandoffResponse } from "@cognelis/decision-protocol";
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
  JournalEntry,
  JournalEntryChange,
  JournalEntryDraft,
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
import type { InstallMode, InstallReport, IntegrationStatus } from "@cognelis/decision-integrations";
import type {
  CapturedQuestion,
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
  ProactiveRecordResult,
} from "@cognelis/decision-protocol";
import type { RebuildReport } from "@cognelis/decision-storage";

import type { ThemePreference } from "./appearance.js";
import type { CaptureClassifier } from "./capture-classifier.js";
import type {
  ObsidianSearchResponse,
  ObsidianSearchResult,
  ObsidianSearchStatus,
} from "./obsidian-search.js";

export type {
  ObsidianSearchResponse,
  ObsidianSearchResult,
  ObsidianSearchStatus,
} from "./obsidian-search.js";

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
  "listDecisionProjects",
  "listLocalDecisions",
  "resolveLocalDecision",
  "createProactiveRecord",
  "listJournalEntries",
  "reviseJournalEntry",
  "getObsidianSearchStatus",
  "searchObsidian",
  "rebuildObsidianSearch",
  "checkAssistantSource",
  "searchAssistantSources",
  "listPrConnections",
  "savePrConnection",
  "removePrConnection",
  "checkPrConnection",
  "listPullRequests",
  "loadPrReview",
  "peekPrReview",
  "prefetchPrReviews",
  "loadPrReviewDiff",
  "getPrActionContext",
  "performPrAction",
  "publishPrReviewComment",
  "publishPrGeneralComment",
  "reevaluatePrReviewFinding",
  "openReviewRulesDirectory",
  "listPrDiscussion",
  "openPrLink",
  "openPr",
  "loadPrReviewFile",
  "runPrReview",
  "followUpPrReview",
  "cancelPrReview",
  "onPrReviewProgress",
  "runAssistantTurn",
  "listAssistantModels",
  "cancelAssistantTurn",
  "saveAssistantFeedback",
  "exportAssistantConversation",
  "getAssistantFeedbackSummary",
  "onAssistantProgress",
  "openObsidianNote",
  "openVaultDocument",
  "saveDecisionContextFeedback",
  "getDecisionContextFeedback",

  "searchDecisionContext",
  "updateDecisionScope",
  "updateDecisionRelation",
  "openDecisionSource",
  "prepareDecisionHandoff",

  "updateDecisionExpectedOutcome",
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
  "revealVault",
  "installIntegrations",
  "removeIntegrations",
  "rebuildIndex",
  "setTheme",
  "listModelTraces",
  "deleteModelTrace",
  "deleteModelTraceRequest",
  "forgetAssistantTurns",
  "clearModelTraces",
  "setModelTraceContentEnabled",
  "setReviewRemindersEnabled",
  "setLocalCredentialsEnabled",
  "setCaptureClassifier",
  "listManagedQwenModels",
  "installManagedQwenModel",
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

export const OBSIDIAN_SEARCH_METHOD_NAMES = [
  "getObsidianSearchStatus",
  "searchObsidian",
  "rebuildObsidianSearch",
  "openObsidianNote",
] as const;

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
  listDecisionProjects: "decision:list-decision-projects",
  createProactiveRecord: "decision:create-proactive-record",
  listJournalEntries: "decision:list-journal-entries",
  reviseJournalEntry: "decision:revise-journal-entry",
  getObsidianSearchStatus: "decision:obsidian-search-status",
  searchObsidian: "decision:obsidian-search",
  rebuildObsidianSearch: "decision:obsidian-rebuild-search",
  checkAssistantSource: "decision:assistant-source-check",
  searchAssistantSources: "decision:assistant-sources",
  listPrConnections: "decision:pr-connections",
  savePrConnection: "decision:pr-connection-save",
  removePrConnection: "decision:pr-connection-remove",
  checkPrConnection: "decision:pr-connection-check",
  listPullRequests: "decision:pr-list",
  loadPrReview: "decision:pr-review-load",
  peekPrReview: "decision:pr-review-peek",
  prefetchPrReviews: "decision:pr-review-prefetch",
  loadPrReviewDiff: "decision:pr-review-diff",
  getPrActionContext: "decision:pr-action-context",
  performPrAction: "decision:pr-action",
  publishPrReviewComment: "decision:pr-review-comment",
  publishPrGeneralComment: "decision:pr-general-comment",
  reevaluatePrReviewFinding: "decision:pr-review-reevaluate",
  openReviewRulesDirectory: "decision:open-review-rules-directory",
  listPrDiscussion: "decision:pr-discussion",
  openPrLink: "decision:pr-link-open",
  openPr: "decision:pr-open",
  loadPrReviewFile: "decision:pr-review-file",
  runPrReview: "decision:pr-review-run",
  followUpPrReview: "decision:pr-review-follow-up",
  cancelPrReview: "decision:pr-review-cancel",
  prReviewProgress: "decision:pr-review-progress",
  runAssistantTurn: "decision:assistant-turn",
  listAssistantModels: "decision:assistant-models",
  cancelAssistantTurn: "decision:assistant-cancel",
  saveAssistantFeedback: "decision:assistant-feedback",
  exportAssistantConversation: "decision:assistant-export",
  getAssistantFeedbackSummary: "decision:assistant-feedback-summary",
  assistantProgress: "decision:assistant-progress",
  openObsidianNote: "decision:obsidian-open-note",
  openVaultDocument: "decision:vault-open-document",
  saveDecisionContextFeedback: "decision:evidence-saveDecisionContextFeedback",
  getDecisionContextFeedback: "decision:evidence-getDecisionContextFeedback",

  searchDecisionContext: "decision:evidence-searchDecisionContext",
  updateDecisionScope: "decision:evidence-updateDecisionScope",
  updateDecisionRelation: "decision:evidence-updateDecisionRelation",
  openDecisionSource: "decision:evidence-openDecisionSource",
  prepareDecisionHandoff: "decision:evidence-prepareDecisionHandoff",

  updateDecisionExpectedOutcome: "decision:update-decision-expected-outcome",
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
  revealVault: "decision:reveal-vault",
  installIntegrations: "decision:install-integrations",
  removeIntegrations: "decision:remove-integrations",
  rebuildIndex: "decision:rebuild-index",
  listLocalDecisions: "decision:list-local-decisions",
  resolveLocalDecision: "decision:resolve-local-decision",
  setTheme: "decision:set-theme",
  listModelTraces: "decision:list-model-traces",
  deleteModelTrace: "decision:delete-model-trace",
  deleteModelTraceRequest: "decision:delete-model-trace-request",
  forgetAssistantTurns: "decision:forget-assistant-turns",
  clearModelTraces: "decision:clear-model-traces",
  setReviewRemindersEnabled: "decision:set-review-reminders-enabled",
  setLocalCredentialsEnabled: "decision:set-local-credentials-enabled",
  setCaptureClassifier: "decision:set-capture-classifier",
  setModelTraceContentEnabled:
    "decision:set-model-trace-content-enabled",
  listManagedQwenModels: "decision:list-managed-qwen-models",
  installManagedQwenModel: "decision:install-managed-qwen-model",
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
  /** Preference or idea notes that could not be read when the list was last read, and so are not in it. */
  journalMessage?: string;
  /** Principle notes that could not be read when they were last read, and so are in no list. */
  methodologyMessage?: string;
}

export type { IntegrationStatus };

export interface PendingRationaleSummary {
  id: string;
  question: string;
  created: string;
  project: string;
  sourceClient: string;
  selectedAnswer: string;
  contextSummary: string | null;
  capturedQuestion: CapturedQuestion | null;
  /**
   * False for one put off in a capture and held in the app's recovery queue alone: written to Obsidian only once its
   * rationale is completed (or 保留但不补), and 不记录 never writes it. Absent for a note in the vault.
   */
  inVault?: false;
}

export interface CandidateReviewProgress {
  position: number;
  total: number;
}

/**
 * Single source of truth for the navigable surfaces. The IPC validator builds
 * its enum from this list, so a surface added here cannot be silently rejected
 * at the process boundary.
 */
export const DESKTOP_PRIMARY_SURFACES = [
  "dashboard",
  // "decisions" is the knowledge surface: decisions, principles and the vault's
  // notes are the same Markdown in the same vault, so they search as one.
  "decisions",
  "assistant",
  "pr-review",
  "methodology",
  "clients",
  "connections",
  "models",
  "activity",
  "settings",
] as const;

export type DesktopPrimarySurface = (typeof DESKTOP_PRIMARY_SURFACES)[number];

export type PrimarySurface = DesktopPrimarySurface | "hidden";

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

export type DecisionSourceFilter = "claude-code" | "codex" | "manual" | "pr-comment" | "test";

export type UserJournalSourceKind =
  | "app_manual"
  | "offline_conversation"
  | "meeting"
  | "observation";
export type UserJournalSourceForm = "user_original" | "user_paraphrase";

export interface JournalEntryListQuery {
  query?: string;
  kind?: "preference" | "idea";
  knowledgeStatus?: "inbox" | "active" | "archived";
  limit?: number;
}

export interface JournalEntryRevisionInput {
  draft: JournalEntryDraft;
  change: JournalEntryChange;
  /** The entry as the page showed it (journalEntryBasis): a change made since then refuses the revision. */
  basis?: string;
}

export type { JournalEntry, ProactiveRecordResult };

export interface DecisionLibraryQuery {
  query: string;
  searchMode?: "keyword" | "semantic";
  decisionId?: string;
  /** An ISO timestamp; only decisions created at or after it. */
  createdSince?: string;
  rationaleStatus?: DecisionRationaleFilter;
  sourceClient?: DecisionSourceFilter;
  /** Trimmed, as the retrospective labels projects. */
  project?: string;
  /** Reviewed with this verdict. */
  outcomeVerdict?: OutcomeVerdict;
  reviewState?:
    | "pending_outcome"
    | "pending_review"
    | "reviewed"
    | "attention"
    | "due"
    | "scheduled"
    | "unscheduled"
    | "expectation_missing";
  limit?: number;
}

export interface DecisionProjectCount {
  project: string;
  count: number;
}

export interface DecisionLibraryItem extends RecentDecisionSummary {
  rationale: string | null;
  context: string | null;
  expectedOutcome?: string | null;
  outcome: string | null;
  outcomeReview: OutcomeReview | null;
  reviewDueDate: string | null;
  appliedPrincipleIds: string[];
  appliedPrinciples: DecisionAppliedPrinciple[];
  searchMatch?: "keyword" | "semantic" | "hybrid";
  /** The PR comment a "pr-comment" decision was taken from. */
  sourceUrl?: string;
  /** The note as it was read: an edit saved with it is refused if the note changed since. Null: not known. */
  contentHash?: string | null;
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
  /** What holds the sources back from being archived, said as the reader is to act on it. */
  blockers: string[];
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
  reason: "revision_applied" | "restore_checkpoint" | "evidence_changed";
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

/**
 * What an edit of a skill or workflow started from: its text as the page opened it. Sent with the edit and compared
 * with the note as it now stands, so a step saved in Obsidian meanwhile is noticed rather than written over.
 */
export const practiceAssetBasis = (asset: PracticeAssetRevisionInput): string =>
  JSON.stringify([asset.title, asset.summary, asset.trigger, asset.steps, asset.checks, asset.fallback]);

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
  /** Moves whenever what the index holds changes (SqliteIndex.revision): pages in view read their decisions again. */
  revision?: number;
  /** Moves whenever a preference or idea is written, by an agent or in the app: the list of them in view reads again. */
  journalRevision?: number;
  totalDecisions: number;
  recorded7d: number;
  reviewAttention: number;
  recentDecisions: RecentDecisionSummary[];
  /** The index could not be read: the zeros are not counts. */
  unavailable?: true;
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
  /** Every one put off in a capture, and the vault's newest; pendingRationaleCount says how many in all. */
  pendingRationales: PendingRationaleSummary[];
  /** Left out, the list is all of them. */
  pendingRationaleCount?: number;
  semanticRecognition: SemanticRecognitionStatus;
  modelTraceContentEnabled?: boolean;
  reviewRemindersEnabled?: boolean;
  localCredentialsEnabled?: boolean;
  captureClassifier?: CaptureClassifier;
}

/** How many decisions wait for a rationale: a snapshot lists the most recent alone. */
export const pendingRationaleTotal = (
  snapshot: Pick<AppSnapshot, "pendingRationales" | "pendingRationaleCount">,
): number => Math.max(snapshot.pendingRationaleCount ?? 0, snapshot.pendingRationales.length);

/** Rationales still to give: those put off, and the one asked for now with those queued behind it. */
export const rationalesToGive = (
  snapshot: Pick<AppSnapshot, "pendingRationales" | "pendingRationaleCount" | "current" | "waitingCount">,
): number => pendingRationaleTotal(snapshot) + (snapshot.current === null ? 0 : 1) + snapshot.waitingCount;

/**
 * The 待办 the home page, the sidebar and the tray each show. They counted apart, the tray leaving out the reviews
 * and the home page the rationale being asked for, and said two numbers for one moment.
 */
export const pendingWorkTotal = (
  snapshot: Pick<
    AppSnapshot,
    "decisionCandidates" | "dashboard" | "pendingRationales" | "pendingRationaleCount" | "current" | "waitingCount"
  >,
): number => snapshot.decisionCandidates.count + rationalesToGive(snapshot) + snapshot.dashboard.reviewAttention;

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

export interface DecisionEvidenceApi {
  saveDecisionContextFeedback(input: DecisionFeedbackUpdate): Promise<DecisionFeedbackUpdateResult>;
  getDecisionContextFeedback(input: DecisionFeedbackQuery): Promise<DecisionFeedbackResponse>;

  searchDecisionContext(input: DecisionContextQuery): Promise<DecisionContextResponse>;
  updateDecisionScope(input: DecisionScopeUpdate): Promise<DecisionScopeUpdateResult>;
  updateDecisionRelation(input: DecisionRelationUpdate): Promise<DecisionRelationUpdateResult>;
  openDecisionSource(input: DecisionSourceReference): Promise<DecisionSourceOpenResult>;
  prepareDecisionHandoff(input: DecisionHandoffRequest): Promise<DecisionHandoffResponse>;
}

export interface LocalDecisionPage { records: import("@cognelis/decision-core").DecisionRecord[]; total: number }

export interface DecisionApi extends DecisionEvidenceApi {
  listLocalDecisions(query: string, offset: number): Promise<LocalDecisionPage>;
  resolveLocalDecision(id: string, action: "publish" | "discard"): Promise<void>;
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
  /** Named projects with decision counts, most used first, for the project filter. */
  listDecisionProjects(): Promise<DecisionProjectCount[]>;
  createProactiveRecord(
    input: ProactiveRecordInput,
  ): Promise<ProactiveRecordResult>;
  listJournalEntries(query: JournalEntryListQuery): Promise<JournalEntry[]>;
  reviseJournalEntry(
    id: string,
    input: JournalEntryRevisionInput,
  ): Promise<JournalEntry>;
  getObsidianSearchStatus(): Promise<ObsidianSearchStatus>;
  searchObsidian(input: {
    query: string;
    limit?: number;
  }): Promise<ObsidianSearchResponse>;
  rebuildObsidianSearch(): Promise<ObsidianSearchStatus>;
  /**
   * Steps pushed while a turn runs. Returns an unsubscribe function; events
   * carry the caller's own `turnId` so a late event from an abandoned turn
   * cannot be mistaken for the current one.
   */
  onAssistantProgress(
    listener: (progress: AssistantProgress) => void,
  ): () => void;
  openObsidianNote(relativePath: string): Promise<void>;
  /**
   * Opens any Markdown in the vault by its relative path. Unlike
   * `openObsidianNote` this asks nothing of the note index, so it reaches the
   * decisions and principles this app writes itself — the ones the note index
   * deliberately leaves out.
   */
  openVaultDocument(relativePath: string): Promise<void>;
  /** Runs one assistant turn: the agent searches, then answers with citations. */
  checkAssistantSource(source: RetrievalAnswerCitation): Promise<AssistantSourceCheck>;
  searchAssistantSources(input: { query: string; scope: RetrievalAnswerScope }): Promise<{ sources: RetrievalAnswerCitation[]; issues: string[] }>;
  listPrConnections(): Promise<PrConnection[]>;
  savePrConnection(input: PrConnectionInput): Promise<PrConnection[]>;
  removePrConnection(id: string): Promise<PrConnection[]>;
  /** Signs in with the link's own token and names the account it belongs to. */
  checkPrConnection(id: string): Promise<{ account: string }>;
  listPullRequests(input: PrListQuery): Promise<PrListResponse>;
  loadPrReview(input: PrReviewLoad): Promise<PrReviewSnapshot>;
  /** The last snapshot read for this PR, without asking the platform; null when never read. */
  peekPrReview(input: PrReviewLoad): Promise<PrReviewSnapshot | null>;
  /** Reads the listed PRs ahead in the background; resolves when the round ends. */
  prefetchPrReviews(input: PrReviewPrefetch): Promise<void>;
  getPrActionContext(input: PrReviewDiffRequest): Promise<PrActionContext>;
  performPrAction(input: PrActionRequest): Promise<PrActionResult>;
  publishPrReviewComment(input: PrReviewCommentRequest): Promise<PrReviewCommentResult>;
  publishPrGeneralComment(input: PrGeneralCommentRequest): Promise<PrReviewCommentResult>;
  reevaluatePrReviewFinding(input: PrReviewReevaluate): Promise<PrReviewVerdict>;
  /** Opens Decision's own review rules folder, creating it with a disabled example when empty. */
  openReviewRulesDirectory(): Promise<void>;
  /** The comments already on a PR, each with its link and the decision recorded from it, if any. */
  listPrDiscussion(input: PrReviewLoad): Promise<PrDiscussion>;
  /** Opens a PR comment link in the browser, only when it belongs to a connected platform. */
  openPrLink(url: string): Promise<void>;
  /** Opens the PR's own page on its platform in the browser. */
  openPr(input: PrReviewLoad): Promise<void>;
  loadPrReviewDiff(input: PrReviewDiffRequest): Promise<PrReviewDiffResponse>;
  loadPrReviewFile(input: PrReviewFileRequest): Promise<PrReviewFileResponse>;
  runPrReview(input: PrReviewRun): Promise<PrReviewReport>;
  followUpPrReview(input: PrReviewFollowUp): Promise<PrReviewFollowUpResult>;
  cancelPrReview(runId: string): Promise<void>;
  onPrReviewProgress(listener: (progress: PrReviewProgress) => void): () => void;
  runAssistantTurn(input: AssistantTurnRequest): Promise<AssistantTurnResponse>;
  /**
   * Stops the turn with this id. Unknown or finished ids are a no-op: the
   * reader clicking "停止" as the answer lands must not raise an error.
   */
  cancelAssistantTurn(turnId: string): Promise<void>;
  /** Records what the reader thought of one answer. Never throws on the caller. */
  saveAssistantFeedback(
    input: AssistantFeedbackInput,
  ): Promise<AssistantFeedbackResult>;
  /** What the reader has thought of answers so far; zeroes when nothing rated. */
  getAssistantFeedbackSummary(): Promise<AssistantFeedbackSummary>;
  /** Writes one conversation as Markdown wherever the reader chooses. */
  exportAssistantConversation(input: {
    suggestedName: string;
    markdown: string;
  }): Promise<AssistantExportResult>;
  /** Models that can drive the assistant, in priority order. */
  listAssistantModels(): Promise<RetrievalAnswerProvider[]>;
  /** Refused once an outcome is recorded: it would only restate it. */
  updateDecisionExpectedOutcome(
    decisionId: string,
    expectedOutcome: string,
    basis?: string | null,
  ): Promise<void>;
  /** `basis`: the note's hash when the editor was opened; changed since, the save is refused. */
  updateDecisionOutcome(decisionId: string, outcome: string, basis?: string | null): Promise<void>;
  updateDecisionReviewDueDate(
    decisionId: string,
    reviewDueDate: string | null,
  ): Promise<void>;
  updateDecisionReview(
    decisionId: string,
    input: DecisionOutcomeReviewInput,
    basis?: string | null,
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
    /** methodologyRevisionBasis of the principle the edit began from: refused once the note has changed since. */
    basis?: string,
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
  /** Acknowledged up to `seen`, the newest review the reader was shown: one recorded since stays to be checked. */
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
    /** practiceAssetBasis of the asset as the edit began. */
    basis?: string,
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
  /**
   * Shows the configured vault in the file manager. It takes no path: the
   * renderer may ask for this one folder and cannot name another.
   */
  revealVault(): Promise<boolean>;
  installIntegrations(mode: InstallMode): Promise<InstallReport>;
  /** Takes Decision's hooks and MCP server out of both clients; skills published to them stay. */
  removeIntegrations(): Promise<InstallReport>;
  rebuildIndex(): Promise<RebuildReport>;
  setTheme(theme: ThemePreference): Promise<void>;
  listModelTraces(): Promise<ModelInvocationTrace[]>;
  deleteModelTrace(traceId: string): Promise<boolean>;
  deleteModelTraceRequest(requestId: string): Promise<number>;
  /** A deleted conversation's turns: their model call records and the ratings given them go too. */
  forgetAssistantTurns(turnIds: string[]): Promise<void>;
  clearModelTraces(): Promise<number>;
  setModelTraceContentEnabled(enabled: boolean): Promise<void>;
  setReviewRemindersEnabled(enabled: boolean): Promise<void>;
  setLocalCredentialsEnabled(enabled: boolean): Promise<void>;
  setCaptureClassifier(classifier: CaptureClassifier): Promise<void>;
  listManagedQwenModels(): Promise<ManagedQwenModelStatus[]>;
  installManagedQwenModel(modelId: ManagedQwenModelId): Promise<void>;
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

export type ObsidianSearchApi = Pick<
  DecisionApi,
  (typeof OBSIDIAN_SEARCH_METHOD_NAMES)[number]
>;

export type MethodologyWorkspaceApi = MethodologyRecordsApi &
  DecisionAnalyticsApi &
  PracticeAssetsApi;

declare global {
  interface Window {
    decision: DecisionApi;
  }
}
