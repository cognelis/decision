import { prReviewHistoryChangedSchema, prReviewProgressSchema } from "@cognelis/decision-protocol";
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
  listHistoricalDecisions: input => invoke(IPC_CHANNELS.listHistoricalDecisions, input),
  getHistoricalDecision: id => invoke(IPC_CHANNELS.getHistoricalDecision, id),
  recordHistoricalDecision: input => invoke(IPC_CHANNELS.recordHistoricalDecision, input),
  updateHistoricalDecision: input => invoke(IPC_CHANNELS.updateHistoricalDecision, input),
  rebuildHistoricalDecisionIndex: () => invoke(IPC_CHANNELS.rebuildHistoricalDecisionIndex),
  openHistoricalDecision: target => invoke(IPC_CHANNELS.openHistoricalDecision, target),
  listTodoLists: input => invoke(IPC_CHANNELS.listTodoLists, input),
  recordTodoList: input => invoke(IPC_CHANNELS.recordTodoList, input),
  changeTodoItem: input => invoke(IPC_CHANNELS.changeTodoItem, input),
  updateTodoList: input => invoke(IPC_CHANNELS.updateTodoList, input),
  moveTodoItem: input => invoke(IPC_CHANNELS.moveTodoItem, input),
  changeTodoItems: input => invoke(IPC_CHANNELS.changeTodoItems, input),
  deleteTodoItems: input => invoke(IPC_CHANNELS.deleteTodoItems, input),
  moveTodoItemsToList: input => invoke(IPC_CHANNELS.moveTodoItemsToList, input),
  deleteTodoList: input => invoke(IPC_CHANNELS.deleteTodoList, input),
  getOrganization: input => invoke(IPC_CHANNELS.getOrganization, input),
  runOrganization: input => invoke(IPC_CHANNELS.runOrganization, input),
  controlOrganizationRun: input => invoke(IPC_CHANNELS.controlOrganizationRun, input),
  decideSuggestion: input => invoke(IPC_CHANNELS.decideSuggestion, input),
  adoptSuggestions: input => invoke(IPC_CHANNELS.adoptSuggestions, input),
  saveSuggestionDraft: input => invoke(IPC_CHANNELS.saveSuggestionDraft, input),
  undoSuggestion: input => invoke(IPC_CHANNELS.undoSuggestion, input),
  regenerateSuggestion: input => invoke(IPC_CHANNELS.regenerateSuggestion, input),
  setOrganizationSettings: input => invoke(IPC_CHANNELS.setOrganizationSettings, input),
  previewOrganizationForget: input => invoke(IPC_CHANNELS.previewOrganizationForget, input),
  forgetOrganizationSource: input => invoke(IPC_CHANNELS.forgetOrganizationSource, input),
  getTodoAnnotations: input => invoke(IPC_CHANNELS.getTodoAnnotations, input),
  getLocalReviewState: () => invoke(IPC_CHANNELS.getLocalReviewState),
  chooseLocalReviewRepository: input => invoke(IPC_CHANNELS.chooseLocalReviewRepository, input),
  startLocalReviewSession: input => invoke(IPC_CHANNELS.startLocalReviewSession, input),
  clearLocalReviewDependencies: input => invoke(IPC_CHANNELS.clearLocalReviewDependencies, input),
  saveLocalReviewSettings: input => invoke(IPC_CHANNELS.saveLocalReviewSettings, input),
  loadLocalReviewFiles: input => invoke(IPC_CHANNELS.loadLocalReviewFiles, input),
  readLocalReviewFile: input => invoke(IPC_CHANNELS.readLocalReviewFile, input),
  saveLocalReviewAnnotation: input => invoke(IPC_CHANNELS.saveLocalReviewAnnotation, input),
  removeLocalReviewAnnotation: input => invoke(IPC_CHANNELS.removeLocalReviewAnnotation, input),
  submitLocalReview: input => invoke(IPC_CHANNELS.submitLocalReview, input),
  submitLocalReviewFromPr: input => invoke(IPC_CHANNELS.submitLocalReviewFromPr, input),
  actOnLocalReview: input => invoke(IPC_CHANNELS.actOnLocalReview, input),
  sendLocalReviewMessage: input => invoke(IPC_CHANNELS.sendLocalReviewMessage, input),
  executeLocalReviewPlan: input => invoke(IPC_CHANNELS.executeLocalReviewPlan, input),
  markLocalReviewRead: input => invoke(IPC_CHANNELS.markLocalReviewRead, input),
  actOnLocalReviewConversation: input => invoke(IPC_CHANNELS.actOnLocalReviewConversation, input),
  onLocalReviewNavigate: listener => {
    const handler = (_event: Electron.IpcRendererEvent, id: unknown) => { if (typeof id === "string" && /^[a-f0-9-]{36}$/u.test(id)) listener(id); };
    ipcRenderer.on(IPC_CHANNELS.localReviewNavigate, handler);
    return () => { ipcRenderer.removeListener(IPC_CHANNELS.localReviewNavigate, handler); };
  },
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
  skipCandidate: (candidateId) =>
    invoke(IPC_CHANNELS.skipCandidate, candidateId),
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
  summarizeRecordContext: (input) => invoke(IPC_CHANNELS.summarizeRecordContext, input),
  cancelRecordContextSummary: (requestId) => invoke(IPC_CHANNELS.cancelRecordContextSummary, requestId),
  listJournalEntries: (query) =>
    invoke(IPC_CHANNELS.listJournalEntries, query),
  listDecisionAmendments: () => invoke(IPC_CHANNELS.listDecisionAmendments),
  updateDecisionAmendment: (request) => invoke(IPC_CHANNELS.updateDecisionAmendment, request),
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
  listPrompts: () => invoke(IPC_CHANNELS.listPrompts),
  createPrompt: (input) => invoke(IPC_CHANNELS.createPrompt, input),
  updatePrompt: (input) => invoke(IPC_CHANNELS.updatePrompt, input),
  deletePrompt: (id) => invoke(IPC_CHANNELS.deletePrompt, id),
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
  installIntegrations: (mode, clients) =>
    invoke(IPC_CHANNELS.installIntegrations, clients === undefined ? mode : { mode, clients }),
  removeIntegrations: (clients) => invoke(IPC_CHANNELS.removeIntegrations, clients),
  listCustomClients: () => invoke(IPC_CHANNELS.listCustomClients),
  saveCustomClient: (input) => invoke(IPC_CHANNELS.saveCustomClient, input),
  deleteCustomClient: (id) => invoke(IPC_CHANNELS.deleteCustomClient, id),
  rebuildIndex: () => invoke(IPC_CHANNELS.rebuildIndex),
  previewDecisionDeletion: (input) => invoke(IPC_CHANNELS.previewDecisionDeletion, input),
  deleteDecision: (input) => invoke(IPC_CHANNELS.deleteDecision, input),
  getMisrecognitionSummary: () => invoke(IPC_CHANNELS.getMisrecognitionSummary),
  listLocalDecisions: (query, offset) => invoke(IPC_CHANNELS.listLocalDecisions, { query, offset }),
  resolveLocalDecision: (id, action) => invoke(IPC_CHANNELS.resolveLocalDecision, { id, action }),
  setTheme: (theme) => invoke(IPC_CHANNELS.setTheme, theme),
  setAccent: (accent) => invoke(IPC_CHANNELS.setAccent, accent),
  listModelTraces: () => invoke(IPC_CHANNELS.listModelTraces),
  deleteModelTrace: (traceId) =>
    invoke(IPC_CHANNELS.deleteModelTrace, traceId),
  deleteModelTraceRequest: (requestId) =>
    invoke(IPC_CHANNELS.deleteModelTraceRequest, requestId),
  forgetAssistantTurns: (turnIds) =>
    invoke(IPC_CHANNELS.forgetAssistantTurns, turnIds),
  clearModelTraces: () => invoke(IPC_CHANNELS.clearModelTraces),
  setModelProxyUrl: (url) => invoke(IPC_CHANNELS.setModelProxyUrl, url),
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
  recognizePrDiscussion: (input) => invoke(IPC_CHANNELS.recognizePrDiscussion, input),
  dismissPrCommentCandidate: (url) => invoke(IPC_CHANNELS.dismissPrCommentCandidate, url),
  listPrCommentCandidates: () => invoke(IPC_CHANNELS.listPrCommentCandidates),
  openPrLink: (url) => invoke(IPC_CHANNELS.openPrLink, url),
  openPr: (input) => invoke(IPC_CHANNELS.openPr, input),
  loadPrReviewDiff: (input) => invoke(IPC_CHANNELS.loadPrReviewDiff, input),
  loadPrReview: (input) => invoke(IPC_CHANNELS.loadPrReview, input),
  peekPrReview: (input) => invoke(IPC_CHANNELS.peekPrReview, input),
  prefetchPrReviews: (input) => invoke(IPC_CHANNELS.prefetchPrReviews, input),
  listPrReviewHistory: () => invoke(IPC_CHANNELS.listPrReviewHistory),
  savePrReviewHistory: (input) => invoke(IPC_CHANNELS.savePrReviewHistory, input),
  listPrReviewStatuses: (input) => invoke(IPC_CHANNELS.listPrReviewStatuses, input),
  getPrDescription: (input) => invoke(IPC_CHANNELS.getPrDescription, input),
  updatePrDescription: (input) => invoke(IPC_CHANNELS.updatePrDescription, input),
  listPrReceivedComments: (input) => invoke(IPC_CHANNELS.listPrReceivedComments, input),
  respondToPrComment: (input) => invoke(IPC_CHANNELS.respondToPrComment, input),
  readPrReviewOutcomes: (input) => invoke(IPC_CHANNELS.readPrReviewOutcomes, input),
  getReviewQuality: (input) => invoke(IPC_CHANNELS.getReviewQuality, input),
  updateReviewRule: (input) => invoke(IPC_CHANNELS.updateReviewRule, input),
  updateReviewEscape: (input) => invoke(IPC_CHANNELS.updateReviewEscape, input),
  reviewBenchmarkPage: (request) => invoke(IPC_CHANNELS.reviewBenchmarkPage, request),
  actOnReviewPromotion: (action) => invoke(IPC_CHANNELS.actOnReviewPromotion, action),
  getPrReviewSettings: () => invoke(IPC_CHANNELS.getPrReviewSettings),
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
  onPrReviewHistoryChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, input: unknown) => {
      const parsed = prReviewHistoryChangedSchema.safeParse(input);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on(IPC_CHANNELS.prReviewHistoryChanged, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.prReviewHistoryChanged, handler);
  },
  runAssistantTurn: (input) =>
    invoke(IPC_CHANNELS.runAssistantTurn, input),
  sendOnboarding: (input) => invoke(IPC_CHANNELS.sendOnboarding, input),
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
