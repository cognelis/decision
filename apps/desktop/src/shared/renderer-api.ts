import type { DecisionDeletionTarget, DecisionDeletionRequest, DecisionDeletionPreview, DecisionDeletionResult, MisrecognitionSummary } from "./decision-deletion.js";
import type { CustomClient, ManagedQwenModelId, ManagedQwenModelStatus, OnboardingRequest, OnboardingView } from "@cognelis/decision-protocol";
import type { OrganizationForget, OrganizationForgetPreview, OrganizationForgetResult, OrganizationForgetTarget, OrganizationQuery, OrganizationRunControl, OrganizationRunRequest, OrganizationRunResult, OrganizationRunView, OrganizationSettings, OrganizationSnapshot, SuggestionDecision, SuggestionDecisionResult, SuggestionDraftSave, SuggestionRegenerate, SuggestionUndo, SuggestionUndoResult, SuggestionsAdopt, SuggestionsAdoptResult, TodoAnnotations, TodoAnnotationsQuery } from "@cognelis/decision-protocol";
import type { GetHistoricalDecisionResult, ListHistoricalDecisionsRequest, ListHistoricalDecisionsResult, OpenHistoricalDecisionRequest, OpenHistoricalDecisionResult, RebuildHistoricalDecisionIndexResult, RecordHistoricalDecisionRequest, RecordHistoricalDecisionResult, UpdateHistoricalDecisionRequest, UpdateHistoricalDecisionResult } from "@cognelis/decision-protocol";
import type { TodoItemChange, TodoItemMove, TodoItemsChange, TodoItemsDelete, TodoItemsMove, TodoItemsMoveResult, TodoItemsResult, TodoListDelete, TodoListDeleteResult, TodoItemUpdateResult, TodoListQuery, TodoListResponse, TodoListSettings, TodoListSettingsResult, TodoManualRecord, TodoRecordResult } from "@cognelis/decision-protocol";
import type { ReviewPromotionAction, ReviewPromotionActionResult, ReviewBenchmarkPageRequest, ReviewBenchmarkPageResult, ReviewEscapeUpdateInput, ReviewEscapeUpdateResult, ReviewQualityResult, ReviewRuleUpdateResult, PrReviewSettingsResult, PrCommentRespond, PrCommentRespondResult, PrReceivedComments, PrReceivedCommentsRequest, PrDescription, PrDescriptionRead, PrDescriptionUpdate, PrDescriptionUpdateResult, PrReviewHistoryChanged, PrReviewHistoryList, PrReviewHistorySave, PrReviewHistorySaveResult, PrReviewStatusList, PrReviewStatusRequest } from "@cognelis/decision-protocol";
import type { LocalReviewFromPr, LocalReviewState, LocalReviewSettings, LocalReviewFiles, LocalReviewAnnotate, LocalReviewAction, LocalReviewSendMessage, LocalReviewExecute, LocalReviewMarkRead, LocalReviewConversationAction } from "@cognelis/decision-protocol";
import type { PrDiscussion, PrDiscussionRecognize, PrCommentCandidates, PrActionContext, PrActionRequest, PrActionResult, PrReviewCommentRequest, PrGeneralCommentRequest, PrReviewCommentResult, PrReviewReevaluate, PrReviewVerdict, PrReviewFileRequest, PrReviewFileResponse, PrReviewDiffRequest, PrReviewDiffResponse, PrReviewFollowUp, PrReviewFollowUpResult, PrReviewLoad, PrReviewPrefetch, PrReviewSnapshot, PrReviewRun, PrReviewReport, PrReviewProgress, PrConnection, PrConnectionInput, PrListQuery, PrListResponse } from "@cognelis/decision-protocol";
import type { ProactiveRecordInput, RecordContextSummary, RecordContextSummaryRequest } from "./proactive-record.js";
export type { ProactiveRecordInput, RecordContextSummary, RecordContextSummaryRequest } from "./proactive-record.js";
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
import type { AmendableSource, AmendmentState, DecisionAmendmentRequest, DecisionAmendmentResult } from "@cognelis/decision-protocol";
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
  SelectedAnswer,
} from "@cognelis/decision-core";
import type { ClientSummary, InstallMode, InstallReport, IntegrationStatus } from "@cognelis/decision-integrations";
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

import type { AccentPreference, ThemePreference } from "./appearance.js";
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

/** 历史决定 as the page sends them: the App adds the version, and that the change came from the App itself. */
export type HistoricalDecisionListQuery = Omit<ListHistoricalDecisionsRequest, "version">;
export type HistoricalDecisionInput = Omit<RecordHistoricalDecisionRequest, "version" | "sourceClient">;
export type HistoricalDecisionChange = Omit<UpdateHistoricalDecisionRequest, "version" | "sourceClient">;
/** The record `id`'s own note, or one of the links (`link`) or related notes (`relatedNote`) it names. */
export type HistoricalDecisionOpenTarget = Omit<OpenHistoricalDecisionRequest, "version">;

export const RENDERER_METHOD_NAMES = [
  "listHistoricalDecisions", "getHistoricalDecision", "recordHistoricalDecision", "updateHistoricalDecision", "rebuildHistoricalDecisionIndex", "openHistoricalDecision",
  "listTodoLists", "recordTodoList", "changeTodoItem", "updateTodoList", "moveTodoItem", "changeTodoItems", "moveTodoItemsToList", "deleteTodoItems", "deleteTodoList",
  "getOrganization", "runOrganization", "controlOrganizationRun", "decideSuggestion", "adoptSuggestions", "saveSuggestionDraft", "undoSuggestion", "regenerateSuggestion", "setOrganizationSettings", "previewOrganizationForget", "forgetOrganizationSource", "getTodoAnnotations",
  "getLocalReviewState", "chooseLocalReviewRepository", "startLocalReviewSession", "saveLocalReviewSettings", "clearLocalReviewDependencies", "loadLocalReviewFiles", "readLocalReviewFile", "saveLocalReviewAnnotation", "removeLocalReviewAnnotation", "submitLocalReview", "submitLocalReviewFromPr", "actOnLocalReview", "sendLocalReviewMessage", "executeLocalReviewPlan", "markLocalReviewRead", "actOnLocalReviewConversation", "onLocalReviewNavigate",
  "getSnapshot",
  "onSnapshot",
  "submitRationale",
  "retryPersistence",
  "openCandidateReview",
  "closeCandidateReview",
  "confirmCandidate",
  "ignoreCandidate",
  "skipCandidate",
  "retryCandidate",
  "openSurface",
  "closePrimarySurface",
  "listDecisions",
  "listDecisionProjects",
  "listLocalDecisions",
  "resolveLocalDecision",
  "previewDecisionDeletion",
  "deleteDecision",
  "getMisrecognitionSummary",
  "createProactiveRecord",
  "summarizeRecordContext",
  "cancelRecordContextSummary",
  "listJournalEntries",
  "listDecisionAmendments",
  "updateDecisionAmendment",
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
  "listPrReviewHistory",
  "savePrReviewHistory",
  "listPrReviewStatuses",
  "getPrDescription",
  "updatePrDescription",
  "listPrReceivedComments",
  "respondToPrComment",
  "readPrReviewOutcomes",
  "getReviewQuality",
  "updateReviewRule",
  "updateReviewEscape",
  "reviewBenchmarkPage",
  "actOnReviewPromotion",
  "getPrReviewSettings",
  "loadPrReviewDiff",
  "getPrActionContext",
  "performPrAction",
  "publishPrReviewComment",
  "publishPrGeneralComment",
  "reevaluatePrReviewFinding",
  "openReviewRulesDirectory",
  "listPrDiscussion",
  "recognizePrDiscussion",
  "dismissPrCommentCandidate",
  "listPrCommentCandidates",
  "openPrLink",
  "openPr",
  "loadPrReviewFile",
  "runPrReview",
  "followUpPrReview",
  "cancelPrReview",
  "onPrReviewProgress",
  "onPrReviewHistoryChanged",
  "runAssistantTurn",
  "sendOnboarding",
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
  "listPrompts",
  "createPrompt",
  "updatePrompt",
  "deletePrompt",
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
  "listCustomClients",
  "saveCustomClient",
  "deleteCustomClient",
  "rebuildIndex",
  "setTheme",
  "setAccent",
  "listModelTraces",
  "deleteModelTrace",
  "deleteModelTraceRequest",
  "forgetAssistantTurns",
  "clearModelTraces",
  "setModelTraceContentEnabled",
  "setModelProxyUrl",
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
  listHistoricalDecisions: "decision:historical-list",
  getHistoricalDecision: "decision:historical-get",
  recordHistoricalDecision: "decision:historical-record",
  updateHistoricalDecision: "decision:historical-update",
  rebuildHistoricalDecisionIndex: "decision:historical-rebuild-index",
  openHistoricalDecision: "decision:historical-open",
  listTodoLists: "decision:todo-list",
  recordTodoList: "decision:todo-record",
  changeTodoItem: "decision:todo-change-item",
  updateTodoList: "decision:todo-list-settings",
  moveTodoItem: "decision:todo-move-item",
  changeTodoItems: "decision:todo-change-items",
  deleteTodoItems: "decision:todo-delete-items",
  moveTodoItemsToList: "decision:todo-move-items-to-list",
  deleteTodoList: "decision:todo-delete-list",
  getOrganization: "decision:organization",
  runOrganization: "decision:organization-run",
  controlOrganizationRun: "decision:organization-run-control",
  decideSuggestion: "decision:organization-decide",
  adoptSuggestions: "decision:organization-adopt",
  saveSuggestionDraft: "decision:organization-draft",
  undoSuggestion: "decision:organization-undo",
  regenerateSuggestion: "decision:organization-regenerate",
  setOrganizationSettings: "decision:organization-settings",
  previewOrganizationForget: "decision:organization-forget-preview",
  forgetOrganizationSource: "decision:organization-forget",
  getTodoAnnotations: "decision:todo-annotations",
  getLocalReviewState: "decision:local-review-state",
  chooseLocalReviewRepository: "decision:local-review-choose",
  startLocalReviewSession: "decision:local-review-session",
  saveLocalReviewSettings: "decision:local-review-settings",
  clearLocalReviewDependencies: "decision:local-review-clear-dependencies",
  loadLocalReviewFiles: "decision:local-review-files",
  readLocalReviewFile: "decision:local-review-read",
  saveLocalReviewAnnotation: "decision:local-review-annotate",
  removeLocalReviewAnnotation: "decision:local-review-remove-annotation",
  submitLocalReview: "decision:local-review-submit",
  submitLocalReviewFromPr: "decision:local-review-from-pr",
  actOnLocalReview: "decision:local-review-action",
  sendLocalReviewMessage: "decision:local-review-send-message",
  executeLocalReviewPlan: "decision:local-review-execute",
  markLocalReviewRead: "decision:local-review-mark-read",
  actOnLocalReviewConversation: "decision:local-review-conversation-action",
  localReviewNavigate: "decision:local-review-navigate",
  snapshot: "decision:get-snapshot",
  snapshotChanged: "decision:snapshot",
  rationale: "decision:submit-rationale",
  retryPersistence: "decision:retry-persistence",
  openCandidateReview: "decision:open-candidate-review",
  closeCandidateReview: "decision:close-candidate-review",
  confirmCandidate: "decision:confirm-candidate",
  ignoreCandidate: "decision:ignore-candidate",
  skipCandidate: "decision:skip-candidate",
  retryCandidate: "decision:retry-candidate",
  openSurface: "decision:open-surface",
  closePrimarySurface: "decision:close-primary-surface",
  listDecisions: "decision:list-decisions",
  listDecisionProjects: "decision:list-decision-projects",
  createProactiveRecord: "decision:create-proactive-record",
  summarizeRecordContext: "decision:record-context-summary",
  cancelRecordContextSummary: "decision:record-context-summary-cancel",
  listJournalEntries: "decision:list-journal-entries",
  listDecisionAmendments: "decision:list-decision-amendments",
  updateDecisionAmendment: "decision:update-decision-amendment",
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
  listPrReviewHistory: "decision:pr-review-history-list",
  savePrReviewHistory: "decision:pr-review-history-save",
  listPrReviewStatuses: "decision:pr-review-statuses",
  getPrDescription: "decision:pr-description",
  updatePrDescription: "decision:pr-description-update",
  listPrReceivedComments: "decision:pr-received-comments",
  respondToPrComment: "decision:pr-comment-respond",
  readPrReviewOutcomes: "decision:pr-review-outcomes",
  getReviewQuality: "decision:review-quality",
  updateReviewRule: "decision:review-rule-update",
  updateReviewEscape: "decision:review-escape-update",
  reviewBenchmarkPage: "decision:review-benchmark-page",
  actOnReviewPromotion: "decision:review-promotion",
  getPrReviewSettings: "decision:pr-review-settings",
  loadPrReviewDiff: "decision:pr-review-diff",
  getPrActionContext: "decision:pr-action-context",
  performPrAction: "decision:pr-action",
  publishPrReviewComment: "decision:pr-review-comment",
  publishPrGeneralComment: "decision:pr-general-comment",
  reevaluatePrReviewFinding: "decision:pr-review-reevaluate",
  openReviewRulesDirectory: "decision:open-review-rules-directory",
  listPrDiscussion: "decision:pr-discussion",
  recognizePrDiscussion: "decision:pr-discussion-recognize",
  dismissPrCommentCandidate: "decision:pr-comment-dismiss",
  listPrCommentCandidates: "decision:pr-comment-candidates",
  openPrLink: "decision:pr-link-open",
  openPr: "decision:pr-open",
  loadPrReviewFile: "decision:pr-review-file",
  runPrReview: "decision:pr-review-run",
  followUpPrReview: "decision:pr-review-follow-up",
  cancelPrReview: "decision:pr-review-cancel",
  prReviewProgress: "decision:pr-review-progress",
  prReviewHistoryChanged: "decision:pr-review-history-changed",
  runAssistantTurn: "decision:assistant-turn",
  sendOnboarding: "decision:assistant-onboarding",
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
  listPrompts: "decision:list-prompts",
  createPrompt: "decision:create-prompt",
  updatePrompt: "decision:update-prompt",
  deletePrompt: "decision:delete-prompt",
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
  listCustomClients: "decision:list-custom-clients",
  saveCustomClient: "decision:save-custom-client",
  deleteCustomClient: "decision:delete-custom-client",
  rebuildIndex: "decision:rebuild-index",
  listLocalDecisions: "decision:list-local-decisions",
  resolveLocalDecision: "decision:resolve-local-decision",
  previewDecisionDeletion: "decision:preview-decision-deletion",
  deleteDecision: "decision:delete-decision",
  getMisrecognitionSummary: "decision:misrecognition-summary",
  setTheme: "decision:set-theme",
  setAccent: "decision:set-accent",
  listModelTraces: "decision:list-model-traces",
  deleteModelTrace: "decision:delete-model-trace",
  deleteModelTraceRequest: "decision:delete-model-trace-request",
  forgetAssistantTurns: "decision:forget-assistant-turns",
  clearModelTraces: "decision:clear-model-traces",
  setReviewRemindersEnabled: "decision:set-review-reminders-enabled",
  setLocalCredentialsEnabled: "decision:set-local-credentials-enabled",
  setCaptureClassifier: "decision:set-capture-classifier",
  setModelProxyUrl: "decision:set-model-proxy-url",
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

export type { ClientSummary, IntegrationStatus };

export interface PendingRationaleSummary {
  id: string;
  question: string;
  created: string;
  project: string;
  sourceClient: string;
  selectedAnswer: string;
  contextSummary: string | null;
  capturedQuestion: CapturedQuestion | null;
  /** Set for one loaded from the vault (no `capturedQuestion`) whose answer is the option marked as recommended. */
  followedRecommendation?: true;
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
  "local-review",
  "todos",
  "methodology",
  "prompts",
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

/** A client's id, or `manual`, `pr-comment`, `test`. */
export type DecisionSourceFilter = string;

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
  answer?: SelectedAnswer;
  rationale: string | null;
  context: string | null;
  expectedOutcome?: string | null;
  outcome: string | null;
  outcomeReview: OutcomeReview | null;
  reviewDueDate: string | null;
  /** Why the review was scheduled as the decision was written, as shown ("发布类决策"); with no date, cleared since. */
  reviewScheduleReasons?: string[];
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

/** A prompt the reader keeps to paste into an agent: a title and its text, nothing else. */
export interface PromptItem {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface PromptInput {
  title: string;
  body: string;
}

/** An edit, refused if the prompt is no longer at the `updatedAt` it was opened at. */
export interface PromptUpdate extends PromptInput {
  id: string;
  expectedUpdatedAt: string;
}

export interface DashboardSnapshot {
  /** Moves whenever what the index holds changes (SqliteIndex.revision): pages in view read their decisions again. */
  revision?: number;
  /** Moves whenever a preference or idea is written, by an agent or in the app: the list of them in view reads again. */
  journalRevision?: number;
  /** Moves whenever a todo list is written, by an agent or on the page: the lists in view read again. */
  todoRevision?: number;
  /** Moves whenever a 历史决定 is written, by an agent, on the page or in Obsidian: the list in view reads again. */
  historicalDecisionRevision?: number;
  /** Moves whenever the organization's suggestions or runs change (IMP-191): the panel in view reads again. */
  organizationRevision?: number;
  /** Suggestions waiting for review, as the 整理 entry's badge counts them (OrganizationSnapshot.counts.pending). */
  organizationPending?: number;
  organizationAutomatic?: boolean;
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
  accent: AccentPreference;
  vaultPath: string | null;
  health: AppHealth;
  /** The clients the 接入 page lists, as the registry describes them; every label of a client comes from here. */
  clients: ClientSummary[];
  /** By client id. */
  integrationStatus: IntegrationStatus;
  /** Every one put off in a capture, and the vault's newest; pendingRationaleCount says how many in all. */
  pendingRationales: PendingRationaleSummary[];
  /** Left out, the list is all of them. */
  pendingRationaleCount?: number;
  semanticRecognition: SemanticRecognitionStatus;
  modelTraceContentEnabled?: boolean;
  modelProxyUrl?: string | null;
  modelProxyEnvironmentOverride?: boolean;
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
 * The 待处理 the home page, the sidebar and the tray each show (not the 待办 page's lists). They counted apart, the tray leaving out the reviews
 * and the home page the rationale being asked for, and said two numbers for one moment.
 */
export const pendingWorkTotal = (
  snapshot: Pick<
    AppSnapshot,
    "decisionCandidates" | "dashboard" | "pendingRationales" | "pendingRationaleCount" | "current" | "waitingCount"
  >,
): number => snapshot.dashboard.organizationAutomatic === true
  ? (snapshot.dashboard.organizationPending ?? 0) + (snapshot.current === null ? 0 : 1) + snapshot.waitingCount
  : snapshot.decisionCandidates.count + rationalesToGive(snapshot) + snapshot.dashboard.reviewAttention;

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
  costUsd?: number;
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

/** One record's amendments as the page reads them: `stale` is in `state.revised`, worked out against the note as it is now. */
export interface AmendmentRecordView {
  source: AmendableSource;
  recordId: string;
  /** The original note's hash now (what a revise is made against); null when it cannot be told. */
  contentHash: string | null;
  state: AmendmentState;
}
export interface AmendmentOverview {
  records: AmendmentRecordView[];
  /** The amendment notes could not be read: none shown is then not none kept. */
  unavailable: boolean;
}

export interface DecisionEvidenceApi {
  /** What agents added to, rewrote in or withdrew from the records (kept beside the notes); the page shows it with them. */
  listDecisionAmendments(): Promise<AmendmentOverview>;
  /** The reader's own change to an amendment (restore, withdraw, revise back): the client is the reader, 「我」. */
  updateDecisionAmendment(request: DecisionAmendmentRequest): Promise<DecisionAmendmentResult>;
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
  /** 历史决定, newest decision first: one page, the projects and tags in use, the notes that could not be read, and the index's state. */
  listHistoricalDecisions(query: HistoricalDecisionListQuery): Promise<ListHistoricalDecisionsResult>;
  /** One record with its neighbours in the chain of 替代, where its note is, and its changes kept on this machine. */
  getHistoricalDecision(id: string): Promise<GetHistoricalDecisionResult>;
  /** A record the reader writes; the same matter, decision, project and day again answers with the one kept. */
  recordHistoricalDecision(input: HistoricalDecisionInput): Promise<RecordHistoricalDecisionResult>;
  /** A change made on the revision (and, for a status, the status) the page showed; `promote` makes a decision record of it, once. */
  updateHistoricalDecision(input: HistoricalDecisionChange): Promise<UpdateHistoricalDecisionResult>;
  /** The index made again from the notes in the vault. */
  rebuildHistoricalDecisionIndex(): Promise<RebuildHistoricalDecisionIndexResult>;
  /** Opens a record's note in Obsidian, one of its own links in the browser, or one of its related notes: nothing it does not name. */
  openHistoricalDecision(target: HistoricalDecisionOpenTarget): Promise<OpenHistoricalDecisionResult>;
  /** 待办清单, those with items still to handle first; `includeClosed` lists the finished ones as well. */
  listTodoLists(query: TodoListQuery): Promise<TodoListResponse>;
  /** A list the reader writes on the page, or items they add to one (`listId`). */
  recordTodoList(input: TodoManualRecord): Promise<TodoRecordResult>;
  /** One item moved on or noted, made only on the status the page showed (`expectedStatus`). */
  changeTodoItem(input: TodoItemChange): Promise<TodoItemUpdateResult>;
  /** A list's settings: 长期清单 (kept with the unfinished ones for items added later) or not, its title, archived. */
  updateTodoList(input: TodoListSettings): Promise<TodoListSettingsResult>;
  /** An item moved in the list's order: before another item, or to the end (`before` null). */
  moveTodoItem(input: TodoItemMove): Promise<TodoListSettingsResult>;
  /** Several items of one list changed at once (status, priority, due date), each on what the page showed. */
  changeTodoItems(input: TodoItemsChange): Promise<TodoItemsResult>;
  /** Items deleted from a list. */
  deleteTodoItems(input: TodoItemsDelete): Promise<TodoItemsResult>;
  moveTodoItemsToList(input: TodoItemsMove): Promise<TodoItemsMoveResult>;
  /** A list deleted (its note to the wastebasket), its title typed. */
  deleteTodoList(input: TodoListDelete): Promise<TodoListDeleteResult>;
  /** 整理面板：当前作用域的建议、计数、最近一轮与设置（IMP-191）。 */
  getOrganization(input: OrganizationQuery): Promise<OrganizationSnapshot>;
  /** 整理一次：只用选定的模型，不回落到别的后端。 */
  runOrganization(input: OrganizationRunRequest): Promise<OrganizationRunResult>;
  /** 暂停、继续或停止正在进行的一轮。 */
  controlOrganizationRun(input: OrganizationRunControl): Promise<OrganizationRunView>;
  /** 采纳、稍后、不采纳或重新打开一条建议，按页面显示的修订与证据版本。 */
  decideSuggestion(input: SuggestionDecision): Promise<SuggestionDecisionResult>;
  /** 采纳所选：逐条独立处理，一条失败不影响其它，也不回滚已采纳的。 */
  adoptSuggestions(input: SuggestionsAdopt): Promise<SuggestionsAdoptResult>;
  /** 保存编辑草稿：取消编辑也保留，重新整理不覆盖。 */
  saveSuggestionDraft(input: SuggestionDraftSave): Promise<SuggestionDecisionResult>;
  /** 撤销一次采纳：内容没被改过才直接恢复，否则先给出恢复差异。 */
  undoSuggestion(input: SuggestionUndo): Promise<SuggestionUndoResult>;
  /** 只对这条建议的来源重新整理。 */
  regenerateSuggestion(input: SuggestionRegenerate): Promise<OrganizationRunResult>;
  /** 后台整理的开关与模型（默认关）。 */
  setOrganizationSettings(input: OrganizationSettings): Promise<OrganizationSettings>;
  /** 遗忘一条来源前：会删除或改写的经验、要清除的候选、注记、向量与调用记录。 */
  previewOrganizationForget(input: OrganizationForgetTarget): Promise<OrganizationForgetPreview>;
  /** 按预览遗忘：各项分别执行，失败的如实列出。 */
  forgetOrganizationSource(input: OrganizationForget): Promise<OrganizationForgetResult>;
  /** 待办页的阅读层：已采纳的主题组与「开始前要看」。 */
  getTodoAnnotations(input: TodoAnnotationsQuery): Promise<TodoAnnotations>;
  getLocalReviewState(): Promise<LocalReviewState>;
  chooseLocalReviewRepository(input: { baseBranch?: string | undefined }): Promise<string | null>;
  startLocalReviewSession(input: { repositoryId: string; baseBranch?: string | undefined }): Promise<string>;
  clearLocalReviewDependencies(input: { repositoryId: string }): Promise<void>;
  saveLocalReviewSettings(input: { repositoryId: string; settings: LocalReviewSettings }): Promise<void>;
  loadLocalReviewFiles(input: { repositoryId: string; sessionId: string }): Promise<LocalReviewFiles>;
  readLocalReviewFile(input: { repositoryId: string; sessionId: string; path: string; side: "old" | "new" }): Promise<string>;
  saveLocalReviewAnnotation(input: LocalReviewAnnotate): Promise<string>;
  removeLocalReviewAnnotation(input: { repositoryId: string; sessionId: string; annotationId: string }): Promise<void>;
  submitLocalReview(input: { repositoryId: string; sessionId: string; profileId: string; worker?: "codex" | "claude-code" | "pi" | undefined }): Promise<string>;
  /** 修: comments on the user's own PR handed to a local review, its fix pushed onto the PR's branch once they say so. */
  submitLocalReviewFromPr(input: LocalReviewFromPr): Promise<string>;
  actOnLocalReview(input: LocalReviewAction): Promise<void>;
  sendLocalReviewMessage(input: LocalReviewSendMessage): Promise<string>;
  executeLocalReviewPlan(input: LocalReviewExecute): Promise<string>;
  markLocalReviewRead(input: LocalReviewMarkRead): Promise<void>;
  actOnLocalReviewConversation(input: LocalReviewConversationAction): Promise<void>;
  onLocalReviewNavigate(listener: (jobId: string) => void): () => void;
  listLocalDecisions(query: string, offset: number): Promise<LocalDecisionPage>;
  resolveLocalDecision(id: string, action: "publish" | "discard"): Promise<void>;
  previewDecisionDeletion(input: DecisionDeletionTarget): Promise<DecisionDeletionPreview>;
  deleteDecision(input: DecisionDeletionRequest): Promise<DecisionDeletionResult>;
  /** Decisions deleted as 识别错误 in the last 30 days, counted by band, signal and rule version. */
  getMisrecognitionSummary(): Promise<MisrecognitionSummary>;
  getSnapshot(): Promise<AppSnapshot>;
  onSnapshot(listener: (snapshot: AppSnapshot) => void): () => void;
  submitRationale(input: RationaleInput): Promise<void>;
  retryPersistence(): Promise<void>;
  openCandidateReview(): Promise<void>;
  closeCandidateReview(): Promise<void>;
  confirmCandidate(candidateId: string): Promise<void>;
  ignoreCandidate(candidateId: string): Promise<void>;
  /** Behind the rest, unanswered: the next one comes up. */
  skipCandidate(candidateId: string): Promise<void>;
  retryCandidate(candidateId: string): Promise<void>;
  openSurface(surface: DesktopPrimarySurface): Promise<void>;
  closePrimarySurface(): Promise<void>;
  listDecisions(query: DecisionLibraryQuery): Promise<DecisionLibraryItem[]>;
  /** Named projects with decision counts, most used first, for the project filter. */
  listDecisionProjects(): Promise<DecisionProjectCount[]>;
  createProactiveRecord(
    input: ProactiveRecordInput,
  ): Promise<ProactiveRecordResult>;
  /** A model on this machine summarizes a record's context; nothing is written, the reader decides what to use. */
  summarizeRecordContext(input: RecordContextSummaryRequest): Promise<RecordContextSummary>;
  /** Stops the summary started with this id; one already finished or unknown is left alone. */
  cancelRecordContextSummary(requestId: string): Promise<void>;
  listJournalEntries(query: JournalEntryListQuery): Promise<JournalEntry[]>;
  /** As DecisionEvidenceApi's: said here too, where the surface test counts the operations. */
  listDecisionAmendments(): Promise<AmendmentOverview>;
  updateDecisionAmendment(request: DecisionAmendmentRequest): Promise<DecisionAmendmentResult>;
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
  /** 评审历史, kept by the App (pr-review-history-store.ts): newest first, with how many record files could not be read. */
  listPrReviewHistory(): Promise<PrReviewHistoryList>;
  /** The records changed since the last save, whole, and the ids of those deleted. */
  savePrReviewHistory(input: PrReviewHistorySave): Promise<PrReviewHistorySaveResult>;
  /** Each PR's build, people's approvals and open blockers as its platform has them now (pr-review-approval.ts). */
  listPrReviewStatuses(input: PrReviewStatusRequest): Promise<PrReviewStatusList>;
  /** The PR's title and description as its platform has them now, and the version a write back must match. */
  getPrDescription(input: PrDescriptionRead): Promise<PrDescription>;
  /** The description as the author confirmed it, written back over the version read (pr-review-description.ts). */
  updatePrDescription(input: PrDescriptionUpdate): Promise<PrDescriptionUpdateResult>;
  /** 作者回应: someone else's comments on the user's PR, each with the replies under it (pr-review-responses.ts). */
  listPrReceivedComments(input: PrReceivedCommentsRequest): Promise<PrReceivedComments>;
  /** 不修 or 转后续, sent as a standard reply in the comment's thread with the user's account; 转后续 files a todo first. */
  respondToPrComment(input: PrCommentRespond): Promise<PrCommentRespondResult>;
  /** 发布后跟踪结果: a record's posted findings read again from its PR; the page is told when they moved. */
  readPrReviewOutcomes(input: { id: string }): Promise<{ changed: boolean }>;
  /** 评审质量 of one link (review-quality.ts): reads its merged PRs from the platform, twenty new ones a look. */
  getReviewQuality(input: { connectionId: string }): Promise<ReviewQualityResult>;
  /** One of Paraself's own local review rules turned off, or on again. */
  updateReviewRule(input: { rule: string; enabled: boolean }): Promise<ReviewRuleUpdateResult>;
  /** 漏网复盘: its four lines written, dismissed, opened again, or made a defect benchmark candidate (review-escapes.ts). */
  updateReviewEscape(input: ReviewEscapeUpdateInput): Promise<ReviewEscapeUpdateResult>;
  /** 评测集 on the review quality page: its sets and suggestions, runs started, read, judged, adopted (review-benchmark-page.ts). */
  reviewBenchmarkPage(request: ReviewBenchmarkPageRequest): Promise<ReviewBenchmarkPageResult>;
  /** 晋升提议: one proposed, its line handed to the local review as a comment on REVIEW.md, or left (review-promotions.ts). */
  actOnReviewPromotion(action: ReviewPromotionAction): Promise<ReviewPromotionActionResult>;
  /** 自动预评审 on each link, with what it spent today (pr-auto-review.ts). */
  getPrReviewSettings(): Promise<PrReviewSettingsResult>;
  getPrActionContext(input: PrReviewDiffRequest): Promise<PrActionContext>;
  performPrAction(input: PrActionRequest): Promise<PrActionResult>;
  publishPrReviewComment(input: PrReviewCommentRequest): Promise<PrReviewCommentResult>;
  publishPrGeneralComment(input: PrGeneralCommentRequest): Promise<PrReviewCommentResult>;
  reevaluatePrReviewFinding(input: PrReviewReevaluate): Promise<PrReviewVerdict>;
  /** Opens Paraself's own review rules folder, creating it with a disabled example when empty. */
  openReviewRulesDirectory(): Promise<void>;
  /** The comments already on a PR, each with its link and the decision recorded from it, if any. */
  listPrDiscussion(input: PrReviewLoad): Promise<PrDiscussion>;
  /** Has the link's model read the PR's comments not read yet for decisions, within its calls for the day; the discussion as it now stands. */
  recognizePrDiscussion(input: PrDiscussionRecognize): Promise<PrDiscussion>;
  /** The reader says a comment the model read as a decision is not one: it is not offered again. */
  dismissPrCommentCandidate(url: string): Promise<void>;
  /** What the links following their PRs read as decisions and the reader has not handled, by PR; and each link's last look. */
  listPrCommentCandidates(): Promise<PrCommentCandidates>;
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
  /** Records an agent changed through the App: read them again before saving over them. */
  onPrReviewHistoryChanged(listener: (changed: PrReviewHistoryChanged) => void): () => void;
  runAssistantTurn(input: AssistantTurnRequest): Promise<AssistantTurnResponse>;
  /** A step of the assistant's 接入新工具 conversation: a message, or an answer to its card; never a retrieval. */
  sendOnboarding(input: OnboardingRequest): Promise<OnboardingView>;
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
  listPrompts(): Promise<PromptItem[]>;
  createPrompt(input: PromptInput): Promise<PromptItem>;
  updatePrompt(input: PromptUpdate): Promise<PromptItem>;
  deletePrompt(id: string): Promise<void>;
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
  /** Connects (or, dry-run, checks) the clients named, by id: every one unless said. */
  installIntegrations(mode: InstallMode, clients?: string[]): Promise<InstallReport>;
  /** Takes Paraself's hooks and MCP server out of the clients named, every one unless said; skills published to them stay. */
  removeIntegrations(clients?: string[]): Promise<InstallReport>;
  /** The clients the reader added on the 接入 page, as they wrote them. */
  listCustomClients(): Promise<CustomClient[]>;
  /**
   * Saves a client the reader wrote, in place of `previousId` when it is one edited: that one, connected, is first
   * disconnected where it was, and is to be connected again. Refused (an id or a hook file another client has, one in
   * Paraself's own data) with why.
   */
  saveCustomClient(input: { client: CustomClient; previousId?: string | undefined }): Promise<CustomClient[]>;
  /** Disconnects a client the reader added and, that done, deletes it; not disconnected, it is kept and the reason said. */
  deleteCustomClient(id: string): Promise<InstallReport>;
  rebuildIndex(): Promise<RebuildReport>;
  setTheme(theme: ThemePreference): Promise<void>;
  setAccent(accent: AccentPreference): Promise<void>;
  listModelTraces(): Promise<ModelInvocationTrace[]>;
  deleteModelTrace(traceId: string): Promise<boolean>;
  deleteModelTraceRequest(requestId: string): Promise<number>;
  /** A deleted conversation's turns: their model call records and the ratings given them go too. */
  forgetAssistantTurns(turnIds: string[]): Promise<void>;
  clearModelTraces(): Promise<number>;
  setModelTraceContentEnabled(enabled: boolean): Promise<void>;
  setModelProxyUrl(url: string | null): Promise<void>;
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
