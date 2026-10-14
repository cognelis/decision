import { prReviewProgressSchema } from "@cognelis/decision-protocol";
import { contextBridge, ipcRenderer } from "electron";

import type { AssistantProgress } from "@cognelis/decision-protocol";

import type {
  AppSnapshot,
  DecisionApi,
  RationaleInput,
} from "../shared/renderer-api.js";
import { IPC_CHANNELS } from "../shared/renderer-api.js";

/**
 * A failure in the main process reaches the page as "Error invoking remote method '<channel>':
 * Error: <what went wrong>". Pages show the reader what went wrong, so they get it in the main
 * process's own words.
 */
const invoke = (
  channel: string,
  ...args: unknown[]
): ReturnType<typeof ipcRenderer.invoke> =>
  ipcRenderer.invoke(channel, ...args).catch((error: unknown) => {
    throw error instanceof Error
      ? new Error(
          error.message.replace(
            /^Error invoking remote method '[^']*': (?:\w*Error: )?/u,
            "",
          ),
        )
      : error;
  });

const api: DecisionApi = {
  saveDecisionContextFeedback: (input) => invoke(IPC_CHANNELS.saveDecisionContextFeedback, input),
  getDecisionContextFeedback: (input) => invoke(IPC_CHANNELS.getDecisionContextFeedback, input),

  searchDecisionContext: (input) => invoke(IPC_CHANNELS.searchDecisionContext, input),
  updateDecisionScope: (input) => invoke(IPC_CHANNELS.updateDecisionScope, input),
  updateDecisionRelation: (input) => invoke(IPC_CHANNELS.updateDecisionRelation, input),
  openDecisionSource: (input) => invoke(IPC_CHANNELS.openDecisionSource, input),
  prepareDecisionHandoff: (input) => invoke(IPC_CHANNELS.prepareDecisionHandoff, input),

  getSnapshot: () => invoke(IPC_CHANNELS.snapshot),
  onSnapshot: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      snapshot: AppSnapshot,
    ) => {
      listener(snapshot);
    };
    ipcRenderer.on(IPC_CHANNELS.snapshotChanged, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.snapshotChanged, handler);
    };
  },
  submitRationale: (input: RationaleInput) =>
    invoke(IPC_CHANNELS.rationale, input),
  retryPersistence: () => invoke(IPC_CHANNELS.retryPersistence),
  openCandidateReview: () =>
    invoke(IPC_CHANNELS.openCandidateReview),
  closeCandidateReview: () =>
    invoke(IPC_CHANNELS.closeCandidateReview),
  confirmCandidate: (candidateId) =>
    invoke(IPC_CHANNELS.confirmCandidate, candidateId),
  ignoreCandidate: (candidateId) =>
    invoke(IPC_CHANNELS.ignoreCandidate, candidateId),
  retryCandidate: (candidateId) =>
    invoke(IPC_CHANNELS.retryCandidate, candidateId),
  openSurface: (surface) =>
    invoke(IPC_CHANNELS.openSurface, surface),
  closePrimarySurface: () =>
    invoke(IPC_CHANNELS.closePrimarySurface),
  listDecisions: (query) =>
    invoke(IPC_CHANNELS.listDecisions, query),
  listDecisionProjects: () =>
    invoke(IPC_CHANNELS.listDecisionProjects),
  createProactiveRecord: (input) =>
    invoke(IPC_CHANNELS.createProactiveRecord, input),
  listJournalEntries: (query) =>
    invoke(IPC_CHANNELS.listJournalEntries, query),
  reviseJournalEntry: (id, input) =>
    invoke(IPC_CHANNELS.reviseJournalEntry, { id, ...input }),
  getObsidianSearchStatus: () =>
    invoke(IPC_CHANNELS.getObsidianSearchStatus),
  searchObsidian: (input) =>
    invoke(IPC_CHANNELS.searchObsidian, input),
  rebuildObsidianSearch: () =>
    invoke(IPC_CHANNELS.rebuildObsidianSearch),
  cancelAssistantTurn: (turnId) =>
    invoke(IPC_CHANNELS.cancelAssistantTurn, turnId),
  saveAssistantFeedback: (input) =>
    invoke(IPC_CHANNELS.saveAssistantFeedback, input),
  exportAssistantConversation: (input) =>
    invoke(IPC_CHANNELS.exportAssistantConversation, input),
  getAssistantFeedbackSummary: () =>
    invoke(IPC_CHANNELS.getAssistantFeedbackSummary),
  onAssistantProgress: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      progress: AssistantProgress,
    ) => {
      listener(progress);
    };
    ipcRenderer.on(IPC_CHANNELS.assistantProgress, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.assistantProgress, handler);
    };
  },
  openObsidianNote: (relativePath) =>
    invoke(IPC_CHANNELS.openObsidianNote, relativePath),
  openVaultDocument: (relativePath) =>
    invoke(IPC_CHANNELS.openVaultDocument, relativePath),
  updateDecisionExpectedOutcome: (decisionId, expectedOutcome, basis) =>
    invoke(IPC_CHANNELS.updateDecisionExpectedOutcome, {
      decisionId,
      expectedOutcome,
      ...(basis ? { basis } : {}),
    }),
  updateDecisionOutcome: (decisionId, outcome, basis) =>
    invoke(IPC_CHANNELS.updateDecisionOutcome, {
      decisionId,
      outcome,
      ...(basis ? { basis } : {}),
    }),
  updateDecisionReviewDueDate: (decisionId, reviewDueDate) =>
    invoke(IPC_CHANNELS.updateDecisionReviewDueDate, {
      decisionId,
      reviewDueDate,
    }),
  updateDecisionReview: (decisionId, input, basis) =>
    invoke(IPC_CHANNELS.updateDecisionReview, {
      decisionId,
      ...input,
      ...(basis ? { basis } : {}),
    }),
  updateDecisionAppliedPrinciples: (decisionId, principleIds) =>
    invoke(IPC_CHANNELS.updateDecisionAppliedPrinciples, {
      decisionId,
      principleIds,
    }),
  getDecisionPrincipleSuggestions: (input) =>
    invoke(IPC_CHANNELS.getDecisionPrincipleSuggestions, input),
  getMethodologyBuildProgress: () =>
    invoke(IPC_CHANNELS.getMethodologyBuildProgress),
  listMethodologies: (status) =>
    invoke(IPC_CHANNELS.listMethodologies, status),
  createManualMethodology: (input) =>
    invoke(IPC_CHANNELS.createManualMethodology, input),
  createManualMethodologyFromEvidence: (input) =>
    invoke(IPC_CHANNELS.createManualMethodologyFromEvidence, input),
  listManualFormDrafts: () =>
    invoke(IPC_CHANNELS.listManualFormDrafts),
  saveManualFormDraft: (input) =>
    invoke(IPC_CHANNELS.saveManualFormDraft, input),
  deleteManualFormDraft: (key) =>
    invoke(IPC_CHANNELS.deleteManualFormDraft, key),
  generateMethodology: (sourceDecisionIds) =>
    invoke(IPC_CHANNELS.generateMethodology, sourceDecisionIds),
  createMethodologyMergeDraft: (sourcePrincipleIds, input) =>
    invoke(IPC_CHANNELS.createMethodologyMergeDraft, {
      sourcePrincipleIds,
      ...input,
    }),
  createMethodologyRevisionDraft: (id, input) =>
    invoke(IPC_CHANNELS.createMethodologyRevisionDraft, {
      id,
      ...input,
    }),
  reviseMethodology: (id, input, basis) =>
    invoke(IPC_CHANNELS.reviseMethodology, {
      id,
      ...input,
      ...(basis === undefined ? {} : { basis }),
    }),
  setMethodologyStatus: (id, status, acknowledgeQualityRisks) =>
    invoke(IPC_CHANNELS.setMethodologyStatus, {
      id,
      status,
      ...(acknowledgeQualityRisks === undefined
        ? {}
        : { acknowledgeQualityRisks }),
    }),
  listMethodologyVersions: (id) =>
    invoke(IPC_CHANNELS.listMethodologyVersions, id),
  restoreMethodologyVersion: (id, version) =>
    invoke(IPC_CHANNELS.restoreMethodologyVersion, {
      id,
      version,
    }),
  getMethodologySuggestions: () =>
    invoke(IPC_CHANNELS.getMethodologySuggestions),
  getDeferredMethodologySuggestions: () =>
    invoke(IPC_CHANNELS.getDeferredMethodologySuggestions),
  deferMethodologySuggestion: (id) =>
    invoke(IPC_CHANNELS.deferMethodologySuggestion, id),
  restoreMethodologySuggestion: (id) =>
    invoke(IPC_CHANNELS.restoreMethodologySuggestion, id),
  getMethodologyEvidenceMatches: (id) =>
    invoke(IPC_CHANNELS.getMethodologyEvidenceMatches, id),
  importMethodologyMarkdown: () =>
    invoke(IPC_CHANNELS.importMethodologyMarkdown),
  commitMethodologyMarkdownImport: (batchId, selectedCandidateIds) =>
    invoke(IPC_CHANNELS.commitMethodologyMarkdownImport, {
      batchId,
      selectedCandidateIds,
    }),
  setMethodologyEvidence: (id, sourceDecisionIds) =>
    invoke(IPC_CHANNELS.setMethodologyEvidence, {
      id,
      sourceDecisionIds,
    }),
  setMethodologyRelation: (id, relatedId, disposition, note) =>
    invoke(IPC_CHANNELS.setMethodologyRelation, {
      id,
      relatedId,
      disposition,
      note,
    }),
  clearMethodologyRelation: (id, relatedId) =>
    invoke(IPC_CHANNELS.clearMethodologyRelation, {
      id,
      relatedId,
    }),
  getMethodologyUsage: (id) =>
    invoke(IPC_CHANNELS.getMethodologyUsage, id),
  getMethodologyValidationInbox: () =>
    invoke(IPC_CHANNELS.getMethodologyValidationInbox),
  acknowledgeMethodologyValidation: (id, seen) =>
    invoke(IPC_CHANNELS.acknowledgeMethodologyValidation, { id, ...seen }),
  getMethodologyMergePlan: (mergeId) =>
    invoke(IPC_CHANNELS.getMethodologyMergePlan, { mergeId }),
  prepareMethodologyMergeAsset: (mergeId, assetId) =>
    invoke(IPC_CHANNELS.prepareMethodologyMergeAsset, {
      mergeId,
      assetId,
    }),
  retireMethodologyMergeSources: (mergeId) =>
    invoke(IPC_CHANNELS.retireMethodologyMergeSources, {
      mergeId,
    }),
  restoreMethodologyMergeSources: (mergeId) =>
    invoke(IPC_CHANNELS.restoreMethodologyMergeSources, {
      mergeId,
    }),
  getDecisionAnalytics: () =>
    invoke(IPC_CHANNELS.getDecisionAnalytics),
  getDecisionConsultationMetrics: () =>
    invoke(IPC_CHANNELS.getDecisionConsultationMetrics),
  previewDecisionConsultation: (input) =>
    invoke(IPC_CHANNELS.previewDecisionConsultation, input),
  submitDecisionConsultationFeedback: (input) =>
    invoke(IPC_CHANNELS.submitDecisionConsultationFeedback, input),
  getKnowledgeGraph: () => invoke(IPC_CHANNELS.getKnowledgeGraph),
  listPracticeAssets: (status) =>
    invoke(IPC_CHANNELS.listPracticeAssets, status),
  createManualPracticeAsset: (kind, sourcePrincipleIds, input) =>
    invoke(IPC_CHANNELS.createManualPracticeAsset, {
      kind,
      sourcePrincipleIds,
      ...input,
    }),
  generatePracticeAsset: (kind, sourcePrincipleIds) =>
    invoke(IPC_CHANNELS.generatePracticeAsset, {
      kind,
      sourcePrincipleIds,
    }),
  revisePracticeAsset: (id, input, basis) =>
    invoke(IPC_CHANNELS.revisePracticeAsset, { id, ...input, ...(basis === undefined ? {} : { basis }) }),
  setPracticeAssetStatus: (id, status) =>
    invoke(IPC_CHANNELS.setPracticeAssetStatus, { id, status }),
  regeneratePracticeAsset: (id) =>
    invoke(IPC_CHANNELS.regeneratePracticeAsset, id),
  listPracticeAssetVersions: (id) =>
    invoke(IPC_CHANNELS.listPracticeAssetVersions, id),
  restorePracticeAssetVersion: (id, version) =>
    invoke(IPC_CHANNELS.restorePracticeAssetVersion, {
      id,
      version,
    }),
  listPracticePublicationStatuses: (id) =>
    invoke(IPC_CHANNELS.listPracticePublicationStatuses, id),
  publishPracticeAsset: (id, target, confirmOverwrite) =>
    invoke(IPC_CHANNELS.publishPracticeAsset, {
      id,
      target,
      ...(confirmOverwrite === undefined ? {} : { confirmOverwrite }),
    }),
  rollbackPracticeAssetPublication: (id, target) =>
    invoke(IPC_CHANNELS.rollbackPracticeAssetPublication, {
      id,
      target,
    }),
  chooseVault: () => invoke(IPC_CHANNELS.chooseVault),
  revealVault: () => invoke(IPC_CHANNELS.revealVault),
  installIntegrations: (mode) =>
    invoke(IPC_CHANNELS.installIntegrations, mode),
  removeIntegrations: () => invoke(IPC_CHANNELS.removeIntegrations),
  rebuildIndex: () => invoke(IPC_CHANNELS.rebuildIndex),
  listLocalDecisions: (query, offset) => invoke(IPC_CHANNELS.listLocalDecisions, { query, offset }),
  resolveLocalDecision: (id, action) => invoke(IPC_CHANNELS.resolveLocalDecision, { id, action }),
  setTheme: (theme) => invoke(IPC_CHANNELS.setTheme, theme),
  listModelTraces: () => invoke(IPC_CHANNELS.listModelTraces),
  deleteModelTrace: (traceId) =>
    invoke(IPC_CHANNELS.deleteModelTrace, traceId),
  deleteModelTraceRequest: (requestId) =>
    invoke(IPC_CHANNELS.deleteModelTraceRequest, requestId),
  forgetAssistantTurns: (turnIds) =>
    invoke(IPC_CHANNELS.forgetAssistantTurns, turnIds),
  clearModelTraces: () => invoke(IPC_CHANNELS.clearModelTraces),
  setModelTraceContentEnabled: (enabled) =>
    invoke(IPC_CHANNELS.setModelTraceContentEnabled, enabled),
  setLocalCredentialsEnabled: (enabled) =>
    invoke(IPC_CHANNELS.setLocalCredentialsEnabled, enabled),
  setReviewRemindersEnabled: (enabled) =>
    invoke(IPC_CHANNELS.setReviewRemindersEnabled, enabled),
  setCaptureClassifier: (classifier) =>
    invoke(IPC_CHANNELS.setCaptureClassifier, classifier),
  checkAssistantSource: (source) => invoke(IPC_CHANNELS.checkAssistantSource, source),
  searchAssistantSources: (input) => invoke(IPC_CHANNELS.searchAssistantSources, input),
  listPrConnections: () => invoke(IPC_CHANNELS.listPrConnections),
  savePrConnection: (input) => invoke(IPC_CHANNELS.savePrConnection, input),
  removePrConnection: (id) => invoke(IPC_CHANNELS.removePrConnection, id),
  checkPrConnection: (id) => invoke(IPC_CHANNELS.checkPrConnection, id),
  listPullRequests: (input) => invoke(IPC_CHANNELS.listPullRequests, input),
  loadPrReviewFile: (input) => invoke(IPC_CHANNELS.loadPrReviewFile, input),
  getPrActionContext: (input) => invoke(IPC_CHANNELS.getPrActionContext, input),
  performPrAction: (input) => invoke(IPC_CHANNELS.performPrAction, input),
  publishPrReviewComment: (input) => invoke(IPC_CHANNELS.publishPrReviewComment, input),
  publishPrGeneralComment: (input) => invoke(IPC_CHANNELS.publishPrGeneralComment, input),
  reevaluatePrReviewFinding: (input) => invoke(IPC_CHANNELS.reevaluatePrReviewFinding, input),
  openReviewRulesDirectory: () => invoke(IPC_CHANNELS.openReviewRulesDirectory),
  listPrDiscussion: (input) => invoke(IPC_CHANNELS.listPrDiscussion, input),
  openPrLink: (url) => invoke(IPC_CHANNELS.openPrLink, url),
  openPr: (input) => invoke(IPC_CHANNELS.openPr, input),
  loadPrReviewDiff: (input) => invoke(IPC_CHANNELS.loadPrReviewDiff, input),
  loadPrReview: (input) => invoke(IPC_CHANNELS.loadPrReview, input),
  peekPrReview: (input) => invoke(IPC_CHANNELS.peekPrReview, input),
  prefetchPrReviews: (input) => invoke(IPC_CHANNELS.prefetchPrReviews, input),
  runPrReview: (input) => invoke(IPC_CHANNELS.runPrReview, input),
  followUpPrReview: (input) => invoke(IPC_CHANNELS.followUpPrReview, input),
  cancelPrReview: (id) => invoke(IPC_CHANNELS.cancelPrReview, id),
  onPrReviewProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, input: unknown) => {
      const parsed = prReviewProgressSchema.safeParse(input);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on(IPC_CHANNELS.prReviewProgress, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.prReviewProgress, handler);
  },
  runAssistantTurn: (input) =>
    invoke(IPC_CHANNELS.runAssistantTurn, input),
  listAssistantModels: () =>
    invoke(IPC_CHANNELS.listAssistantModels),
  listManagedQwenModels: () => invoke(IPC_CHANNELS.listManagedQwenModels),
  installManagedQwenModel: (modelId) => invoke(IPC_CHANNELS.installManagedQwenModel, modelId),
  listModelProviderProfiles: () =>
    invoke(IPC_CHANNELS.listModelProviderProfiles),
  saveModelProviderProfile: (input) =>
    invoke(IPC_CHANNELS.saveModelProviderProfile, input),
  deleteModelProviderProfile: (profileId) =>
    invoke(IPC_CHANNELS.deleteModelProviderProfile, profileId),
  reorderModelProviderProfiles: (profileIds) =>
    invoke(IPC_CHANNELS.reorderModelProviderProfiles, profileIds),
  testModelProviderProfile: (profileId) =>
    invoke(IPC_CHANNELS.testModelProviderProfile, profileId),
  listLocalModelClientStatuses: () =>
    invoke(IPC_CHANNELS.listLocalModelClientStatuses),
};

contextBridge.exposeInMainWorld("decision", Object.freeze(api));
