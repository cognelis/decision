import { contextBridge, ipcRenderer } from "electron";

import type {
  AppSnapshot,
  DecisionApi,
  RationaleInput,
} from "../shared/renderer-api.js";
import { IPC_CHANNELS } from "../shared/renderer-api.js";

const api: DecisionApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.snapshot),
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
    ipcRenderer.invoke(IPC_CHANNELS.rationale, input),
  retryPersistence: () => ipcRenderer.invoke(IPC_CHANNELS.retryPersistence),
  openCandidateReview: () =>
    ipcRenderer.invoke(IPC_CHANNELS.openCandidateReview),
  closeCandidateReview: () =>
    ipcRenderer.invoke(IPC_CHANNELS.closeCandidateReview),
  confirmCandidate: (candidateId) =>
    ipcRenderer.invoke(IPC_CHANNELS.confirmCandidate, candidateId),
  ignoreCandidate: (candidateId) =>
    ipcRenderer.invoke(IPC_CHANNELS.ignoreCandidate, candidateId),
  retryCandidate: (candidateId) =>
    ipcRenderer.invoke(IPC_CHANNELS.retryCandidate, candidateId),
  openSurface: (surface) =>
    ipcRenderer.invoke(IPC_CHANNELS.openSurface, surface),
  closePrimarySurface: () =>
    ipcRenderer.invoke(IPC_CHANNELS.closePrimarySurface),
  listDecisions: (query) =>
    ipcRenderer.invoke(IPC_CHANNELS.listDecisions, query),
  updateDecisionOutcome: (decisionId, outcome) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateDecisionOutcome, {
      decisionId,
      outcome,
    }),
  updateDecisionReviewDueDate: (decisionId, reviewDueDate) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateDecisionReviewDueDate, {
      decisionId,
      reviewDueDate,
    }),
  updateDecisionReview: (decisionId, input) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateDecisionReview, {
      decisionId,
      ...input,
    }),
  updateDecisionAppliedPrinciples: (decisionId, principleIds) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateDecisionAppliedPrinciples, {
      decisionId,
      principleIds,
    }),
  getDecisionPrincipleSuggestions: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.getDecisionPrincipleSuggestions, input),
  getMethodologyBuildProgress: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getMethodologyBuildProgress),
  listMethodologies: (status) =>
    ipcRenderer.invoke(IPC_CHANNELS.listMethodologies, status),
  createManualMethodology: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.createManualMethodology, input),
  createManualMethodologyFromEvidence: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.createManualMethodologyFromEvidence, input),
  listManualFormDrafts: () =>
    ipcRenderer.invoke(IPC_CHANNELS.listManualFormDrafts),
  saveManualFormDraft: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveManualFormDraft, input),
  deleteManualFormDraft: (key) =>
    ipcRenderer.invoke(IPC_CHANNELS.deleteManualFormDraft, key),
  generateMethodology: (sourceDecisionIds) =>
    ipcRenderer.invoke(IPC_CHANNELS.generateMethodology, sourceDecisionIds),
  createMethodologyMergeDraft: (sourcePrincipleIds, input) =>
    ipcRenderer.invoke(IPC_CHANNELS.createMethodologyMergeDraft, {
      sourcePrincipleIds,
      ...input,
    }),
  createMethodologyRevisionDraft: (id, input) =>
    ipcRenderer.invoke(IPC_CHANNELS.createMethodologyRevisionDraft, {
      id,
      ...input,
    }),
  reviseMethodology: (id, input) =>
    ipcRenderer.invoke(IPC_CHANNELS.reviseMethodology, {
      id,
      ...input,
    }),
  setMethodologyStatus: (id, status, acknowledgeQualityRisks) =>
    ipcRenderer.invoke(IPC_CHANNELS.setMethodologyStatus, {
      id,
      status,
      ...(acknowledgeQualityRisks === undefined
        ? {}
        : { acknowledgeQualityRisks }),
    }),
  listMethodologyVersions: (id) =>
    ipcRenderer.invoke(IPC_CHANNELS.listMethodologyVersions, id),
  restoreMethodologyVersion: (id, version) =>
    ipcRenderer.invoke(IPC_CHANNELS.restoreMethodologyVersion, {
      id,
      version,
    }),
  getMethodologySuggestions: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getMethodologySuggestions),
  getDeferredMethodologySuggestions: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getDeferredMethodologySuggestions),
  deferMethodologySuggestion: (id) =>
    ipcRenderer.invoke(IPC_CHANNELS.deferMethodologySuggestion, id),
  restoreMethodologySuggestion: (id) =>
    ipcRenderer.invoke(IPC_CHANNELS.restoreMethodologySuggestion, id),
  getMethodologyEvidenceMatches: (id) =>
    ipcRenderer.invoke(IPC_CHANNELS.getMethodologyEvidenceMatches, id),
  importMethodologyMarkdown: () =>
    ipcRenderer.invoke(IPC_CHANNELS.importMethodologyMarkdown),
  commitMethodologyMarkdownImport: (batchId, selectedCandidateIds) =>
    ipcRenderer.invoke(IPC_CHANNELS.commitMethodologyMarkdownImport, {
      batchId,
      selectedCandidateIds,
    }),
  setMethodologyEvidence: (id, sourceDecisionIds) =>
    ipcRenderer.invoke(IPC_CHANNELS.setMethodologyEvidence, {
      id,
      sourceDecisionIds,
    }),
  setMethodologyRelation: (id, relatedId, disposition, note) =>
    ipcRenderer.invoke(IPC_CHANNELS.setMethodologyRelation, {
      id,
      relatedId,
      disposition,
      note,
    }),
  clearMethodologyRelation: (id, relatedId) =>
    ipcRenderer.invoke(IPC_CHANNELS.clearMethodologyRelation, {
      id,
      relatedId,
    }),
  getMethodologyUsage: (id) =>
    ipcRenderer.invoke(IPC_CHANNELS.getMethodologyUsage, id),
  getMethodologyValidationInbox: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getMethodologyValidationInbox),
  acknowledgeMethodologyValidation: (id) =>
    ipcRenderer.invoke(IPC_CHANNELS.acknowledgeMethodologyValidation, id),
  getMethodologyMergePlan: (mergeId) =>
    ipcRenderer.invoke(IPC_CHANNELS.getMethodologyMergePlan, { mergeId }),
  prepareMethodologyMergeAsset: (mergeId, assetId) =>
    ipcRenderer.invoke(IPC_CHANNELS.prepareMethodologyMergeAsset, {
      mergeId,
      assetId,
    }),
  retireMethodologyMergeSources: (mergeId) =>
    ipcRenderer.invoke(IPC_CHANNELS.retireMethodologyMergeSources, {
      mergeId,
    }),
  restoreMethodologyMergeSources: (mergeId) =>
    ipcRenderer.invoke(IPC_CHANNELS.restoreMethodologyMergeSources, {
      mergeId,
    }),
  getDecisionAnalytics: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getDecisionAnalytics),
  getDecisionConsultationMetrics: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getDecisionConsultationMetrics),
  previewDecisionConsultation: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.previewDecisionConsultation, input),
  submitDecisionConsultationFeedback: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.submitDecisionConsultationFeedback, input),
  getKnowledgeGraph: () => ipcRenderer.invoke(IPC_CHANNELS.getKnowledgeGraph),
  listPracticeAssets: (status) =>
    ipcRenderer.invoke(IPC_CHANNELS.listPracticeAssets, status),
  createManualPracticeAsset: (kind, sourcePrincipleIds, input) =>
    ipcRenderer.invoke(IPC_CHANNELS.createManualPracticeAsset, {
      kind,
      sourcePrincipleIds,
      ...input,
    }),
  generatePracticeAsset: (kind, sourcePrincipleIds) =>
    ipcRenderer.invoke(IPC_CHANNELS.generatePracticeAsset, {
      kind,
      sourcePrincipleIds,
    }),
  revisePracticeAsset: (id, input) =>
    ipcRenderer.invoke(IPC_CHANNELS.revisePracticeAsset, { id, ...input }),
  setPracticeAssetStatus: (id, status) =>
    ipcRenderer.invoke(IPC_CHANNELS.setPracticeAssetStatus, { id, status }),
  regeneratePracticeAsset: (id) =>
    ipcRenderer.invoke(IPC_CHANNELS.regeneratePracticeAsset, id),
  listPracticeAssetVersions: (id) =>
    ipcRenderer.invoke(IPC_CHANNELS.listPracticeAssetVersions, id),
  restorePracticeAssetVersion: (id, version) =>
    ipcRenderer.invoke(IPC_CHANNELS.restorePracticeAssetVersion, {
      id,
      version,
    }),
  listPracticePublicationStatuses: (id) =>
    ipcRenderer.invoke(IPC_CHANNELS.listPracticePublicationStatuses, id),
  publishPracticeAsset: (id, target, confirmOverwrite) =>
    ipcRenderer.invoke(IPC_CHANNELS.publishPracticeAsset, {
      id,
      target,
      ...(confirmOverwrite === undefined ? {} : { confirmOverwrite }),
    }),
  rollbackPracticeAssetPublication: (id, target) =>
    ipcRenderer.invoke(IPC_CHANNELS.rollbackPracticeAssetPublication, {
      id,
      target,
    }),
  chooseVault: () => ipcRenderer.invoke(IPC_CHANNELS.chooseVault),
  installIntegrations: (mode) =>
    ipcRenderer.invoke(IPC_CHANNELS.installIntegrations, mode),
  rebuildIndex: () => ipcRenderer.invoke(IPC_CHANNELS.rebuildIndex),
  setTheme: (theme) => ipcRenderer.invoke(IPC_CHANNELS.setTheme, theme),
  listModelTraces: () => ipcRenderer.invoke(IPC_CHANNELS.listModelTraces),
  deleteModelTrace: (traceId) =>
    ipcRenderer.invoke(IPC_CHANNELS.deleteModelTrace, traceId),
  deleteModelTraceRequest: (requestId) =>
    ipcRenderer.invoke(IPC_CHANNELS.deleteModelTraceRequest, requestId),
  clearModelTraces: () => ipcRenderer.invoke(IPC_CHANNELS.clearModelTraces),
  setModelTraceContentEnabled: (enabled) =>
    ipcRenderer.invoke(IPC_CHANNELS.setModelTraceContentEnabled, enabled),
  listModelProviderProfiles: () =>
    ipcRenderer.invoke(IPC_CHANNELS.listModelProviderProfiles),
  saveModelProviderProfile: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveModelProviderProfile, input),
  deleteModelProviderProfile: (profileId) =>
    ipcRenderer.invoke(IPC_CHANNELS.deleteModelProviderProfile, profileId),
  reorderModelProviderProfiles: (profileIds) =>
    ipcRenderer.invoke(IPC_CHANNELS.reorderModelProviderProfiles, profileIds),
  testModelProviderProfile: (profileId) =>
    ipcRenderer.invoke(IPC_CHANNELS.testModelProviderProfile, profileId),
  listLocalModelClientStatuses: () =>
    ipcRenderer.invoke(IPC_CHANNELS.listLocalModelClientStatuses),
};

contextBridge.exposeInMainWorld("decision", Object.freeze(api));
