export {
  MarkdownRepository,
  DecisionLifecycleWriteError,
  evictedNote,
  noteProblem,
  parseDecision,
  serializeDecision,
  skipDeferredRationaleMarkdown,
  updateDecisionAppliedPrinciplesMarkdown,
  updateDecisionExpectedOutcomeMarkdown,
  updateDecisionOutcomeMarkdown,
  updateDecisionReviewDueDateMarkdown,
  updateDeferredRationaleMarkdown,
  updateOutcomeReviewMarkdown,
} from "./markdown.js";
export type {
  DecisionLifecycleUpdate,
  AppliedPrinciplesUpdate,
  DeferredRationaleUpdate,
  NoteDiagnostic,
  OutcomeReviewUpdate,
  ReviewScheduleUpdate,
  ParsedStoredNote,
  ScanResult,
  StoredNote,
} from "./markdown.js";

export { DecisionContextRepository, mayBeSetAside, parseDecisionContextNote } from "./decision-context.js";
export { DecisionScopeRepository } from "./decision-scope.js";
export { DecisionRelationRepository } from "./decision-relation.js";
export type { StoredDecisionScope } from "./decision-scope.js";
export type { DecisionContextDocument, DecisionContextSnapshot } from "./decision-context.js";

export { SqliteIndex } from "./sqlite-index.js";
export type { DecisionQuery, IndexedDecision } from "./sqlite-index.js";

export {
  JournalEntryRepository,
  journalEntryFingerprint,
  journalEntryGone,
  parseJournalEntry,
  serializeJournalEntry,
} from "./journal-entry.js";
export type {
  JournalEntryDiagnostic,
  JournalEntryQuery,
  JournalEntryScan,
  JournalEntryWriteResult,
} from "./journal-entry.js";

export { renameReplacing } from "./replace-file.js";
export { expireQuarantined, QUARANTINE_MAXIMUM_AGE_MS } from "./quarantine.js";
export { runtimeIdentityProof } from "./runtime-identity.js";
export { SemanticVectorIndex } from "./semantic-vector-index.js";
export type {
  SemanticVectorEntityType,
  SemanticVectorMetadata,
  SemanticVectorRecord,
} from "./semantic-vector-index.js";

export { foldedText, searchTokens } from "./search-text.js";

export {
  isIndexableNotePath,
  isObsidianSearchIndexDamage,
  ObsidianSearchIndex,
  ObsidianSearchIndexSchemaError,
  ObsidianSearchIndexUnavailableError,
} from "./obsidian-search-index.js";
export type {
  ObsidianIndexedChunk,
  ObsidianIndexedNoteInput,
  ObsidianIndexedNoteMetadata,
} from "./obsidian-search-index.js";

export { CandidateSpool } from "./candidate-spool.js";

export { DecisionStore } from "./decision-store.js";
export type {
  DecisionIndex,
  RebuildReport,
  SaveResult,
} from "./decision-store.js";

export { DecisionWatcher } from "./watcher.js";

export {
  DECISION_JOURNAL_FOLDER,
  isDecisionJournalPath,
  ObsidianVaultRepository,
  ObsidianVaultWatcher,
} from "./obsidian-vault.js";
export type {
  ObsidianVaultDiagnostic,
  ObsidianVaultNote,
  ObsidianVaultScan,
  ObsidianVaultScanEntry,
  ObsidianVaultWalkEntry,
  UnchangedNote,
} from "./obsidian-vault.js";

export {
  MethodologyRepository,
  parseMethodology,
  serializeMethodology,
} from "./methodology.js";
export {
  MethodologyRelationRepository,
  parseMethodologyRelation,
  serializeMethodologyRelation,
} from "./methodology-relation.js";

export {
  PracticeAssetRepository,
  parsePracticeAsset,
  publishedPracticeAsset,
  publishedPracticeIdentity,
  serializePracticeAsset,
} from "./practice-asset.js";

export {
  CaptureSpool,
  CaptureDispositionCorruptError,
  CaptureDispositionQuarantineError,
  captureEventKey,
  captureQuestionKey,
} from "./capture-spool.js";

export { CaptureAuditStore } from "./capture-audit-store.js";
export type {
  CaptureAuditRecordInput,
  CaptureAuditSummary,
} from "./capture-audit-store.js";

export { ModelTraceStore } from "./model-trace-store.js";
export type {
  ModelTraceRecordInput,
  ModelTraceStoreOptions,
} from "./model-trace-store.js";

export { SemanticPairSpool } from "./semantic-pair-spool.js";
export type { SemanticPairAppendResult } from "./semantic-pair-spool.js";

export { createDecisionFeedbackStore } from "./decision-feedback.js";

export {
  combineReviewRules,
  loadReviewRules,
  matchReviewRules,
  MAX_MATCHED_REVIEW_RULES,
  parseReviewRule,
} from "./review-rules.js";
export type { ReviewRule, ReviewRuleTarget } from "./review-rules.js";

export { LocalDecisionStore } from "./local-decisions.js";
