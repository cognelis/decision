export {
  CandidatePersistenceError,
  DecisionCandidateQueue,
} from "./candidate-queue.js";
export type {
  CandidateQueueOptions,
  CandidateQueueSnapshot,
} from "./candidate-queue.js";

export {
  DecisionPersistenceError,
  RationaleQueue,
  rationaleCandidateKey,
  rationaleSemanticKey,
} from "./rationale-queue.js";
export type {
  CrossModeDuplicate,
  RationaleCandidate,
  RationaleIngestResult,
  RationaleQueueOptions,
  RationaleQueueSnapshot,
  RationaleSubmission,
} from "./rationale-queue.js";

export { createDecisionRecord } from "./record.js";
export type {
  DecisionRecord,
  DecisionType,
  OutcomeReview,
  OutcomeVerdict,
  PersistedDecisionStatus,
  PersistableRationaleSubmission,
  RecordedCaptureDetection,
  RecordedDecisionOption,
  RationaleStatus,
  SelectedAnswer,
} from "./record.js";

export type {
  MethodologyConfidence,
  MethodologyDraft,
  MethodologyGeneration,
  MethodologyHistoryEntry,
  MethodologyHistoryReason,
  MethodologyImportSource,
  MethodologyOrigin,
  MethodologyRecord,
  MethodologyStatus,
} from "./methodology.js";

export { buildMethodologyBuildProgress } from "./methodology-build-progress.js";
export type {
  MethodologyBuildProgress,
  MethodologyDecisionProgressFact,
} from "./methodology-build-progress.js";

export { assessMethodologyQuality } from "./methodology-quality.js";
export type {
  MethodologyEvidenceSignal,
  MethodologyQualityAssessment,
  MethodologyQualityFlag,
  MethodologyQualityRelation,
  MethodologyRelationKind,
} from "./methodology-quality.js";

export type {
  KnowledgeGraphDecision,
  KnowledgeGraphEdge,
  KnowledgeGraphOutcome,
  KnowledgeGraphPrinciple,
  KnowledgeGraphPrincipleRelation,
  KnowledgeGraphProject,
  KnowledgeGraphRelationship,
  KnowledgeGraphSnapshot,
} from "./knowledge-graph.js";

export type {
  PracticeAssetHistoryEntry,
  PracticeAssetHistoryReason,
  PracticeAssetDraft,
  PracticeAssetGeneration,
  PracticeAssetKind,
  PracticeAssetRecord,
  PracticeAssetSourceSnapshot,
  PracticeAssetStatus,
} from "./practice-asset.js";
export {
  comparePracticeAssetSources,
  snapshotPracticeAssetSources,
} from "./practice-asset-source-diff.js";
export type {
  PracticeAssetSourceChange,
  PracticeAssetSourceChangeState,
  PracticeAssetSourceField,
  PracticeAssetSourceFieldChange,
} from "./practice-asset-source-diff.js";

export { assessPracticeAssetFreshness } from "./practice-asset-freshness.js";
export type {
  PracticeAssetFreshness,
  PracticeAssetFreshnessState,
} from "./practice-asset-freshness.js";

export type {
  PracticePublicationReceipt,
  PracticePublicationState,
  PracticePublicationStatus,
  PracticePublicationTarget,
} from "./practice-publication.js";

export { buildMethodologySuggestions } from "./methodology-suggestion.js";
export type {
  MethodologySuggestion,
  MethodologySuggestionDirection,
  MethodologySuggestionEvidence,
  MethodologySuggestionReadiness,
} from "./methodology-suggestion.js";
export { buildMethodologyEvidenceMatches } from "./methodology-evidence-match.js";
export type {
  MethodologyEvidenceMatch,
  MethodologyEvidenceMatchInput,
  MethodologyEvidenceMatchStrength,
} from "./methodology-evidence-match.js";
export { buildMethodologyRecall } from "./methodology-recall.js";
export type {
  MethodologyRecallInput,
  MethodologyRecallMatch,
  MethodologyRecallStrength,
} from "./methodology-recall.js";
export {
  assessMethodologyDuplicateGroup,
  canonicalMethodologyPair,
} from "./methodology-relation.js";
export type {
  MethodologyDuplicateGroupCoverage,
  MethodologyRelationDisposition,
  MethodologyRelationRecord,
} from "./methodology-relation.js";

export type {
  DecisionAnalyticsGroup,
  DecisionAnalyticsRates,
  DecisionAnalyticsSnapshot,
  DecisionAnalyticsTotals,
  DecisionAnalyticsTrend,
  DecisionAnalyticsVerdict,
} from "./decision-analytics.js";

export {
  RATIONALE_FACTORS,
  rationaleFactorLabel,
} from "./rationale-factors.js";

export { TextDecisionAnalyzer } from "./text-decision-analyzer.js";
export type {
  CompletedDecisionAnalysis,
  DecisionBand,
  DecisionTurnExcerpt,
  PendingDecisionAnalysis,
} from "./text-decision-analyzer.js";

export {
  routeSemanticDecision,
  validateSemanticClassification,
} from "./semantic-router.js";
export type {
  SemanticRoutingInput,
  ValidatedSemanticClassification,
} from "./semantic-router.js";
