// @vitest-environment jsdom

import type {
  MethodologyQualityAssessment,
  MethodologySuggestion,
} from "@cognelis/decision-core";
import type { ModelInvocationTrace } from "@cognelis/decision-protocol";
import { vi } from "vitest";
import { createElement } from "react";
import { act, render } from "@testing-library/react";
import { App } from "../src/renderer/App.js";

import { createEvidencePreviewApi } from "../src/renderer/evidence-preview-api.js";
import type {
  AppSnapshot,
  DecisionApi,
  DecisionLibraryItem,
  MethodologyItem,
  MethodologyValidationItem,
  PracticeAssetItem,
} from "../src/shared/renderer-api.js";
import { serverCandidateFixture, serverCaptureFixture } from "./fixtures.js";

/**
 * The snapshots and the stub API that App's own tests are built on.
 *
 * They sat at the top of a 7000-line test file, which is why every test file
 * added since re-declared its own copy of the same decision and principle
 * shapes. Guessing those shapes is the one thing a stub cannot do: a wrong one
 * crashes the render and the failure reads as "element not in the document".
 */

export const candidate = () => {
  const event = serverCaptureFixture({
    sourceClient: "codex",
  });
  return {
    status: "awaiting_rationale" as const,
    candidateId: "candidate-1",
    candidateKey: "candidate-key-1",
    event,
    question: event.questions[0]!,
  };
};

export const contextualCandidate = () => {
  const event = serverCaptureFixture({
    captureMode: "transcript",
    context: {
      taskBackground: "继续开发 Decision。",
      decisionFraming: "先规则后模型",
      truncated: true,
    },
    detection: {
      band: "high",
      score: 88,
      detectorVersion: "rules-v1",
      signals: ["answer_matches_option"],
    },
  });
  return {
    ...candidate(),
    event,
    question: event.questions[0]!,
  };
};

export const reviewCandidate = () => {
  const base = serverCandidateFixture();
  return {
    ...base,
    event: {
      ...base.event,
      context: {
        taskBackground: "继续开发 Decision。",
        decisionFraming: "先规则后模型",
      },
    },
  };
};

export const rationaleSnapshot = (
  overrides: Partial<AppSnapshot> = {},
): AppSnapshot => ({
  current: candidate(),
  waitingCount: 0,
  primarySurface: "hidden",
  dashboard: {
    totalDecisions: 0,
    recorded7d: 0,
    reviewAttention: 0,
    recentDecisions: [],
  },
  candidateReviewOpen: false,
  candidateReviewProgress: null,
  decisionCandidates: {
    current: null,
    count: 0,
  },
  theme: "auto",
  vaultPath: "/vault",
  health: { index: "healthy", recovery: "healthy" },
  integrationStatus: {
    claudeCode: "unknown",
    codex: "unknown",
  },
  pendingRationales: [],
  modelTraceContentEnabled: true,
  semanticRecognition: {
    provider: "qwen",
    providerLabel: "Qwen 本地模型",
    availability: "available",
    mode: "hybrid",
    modelVersion: "qwen3.5-2b-q4-k-m",
    promptVersion: "semantic-v1",
    processed7d: 12,
    high7d: 4,
    medium7d: 3,
    failures7d: 0,
    updatedAt: "2026-07-27T10:00:00.000Z",
  },
  ...overrides,
});

export const methodologyQuality = (
  overrides: Partial<MethodologyQualityAssessment> = {},
): MethodologyQualityAssessment => ({
  recommendedConfidence: "low",
  confidenceReason: "当前只有单条结果证据，只能视为待验证假设。",
  evidenceCount: 1,
  missingEvidenceCount: 0,
  projectCount: 1,
  sourceCount: 1,
  favorableEvidenceCount: 1,
  attentionEvidenceCount: 0,
  unclearEvidenceCount: 0,
  flags: ["single_evidence"],
  relations: [],
  ...overrides,
});

export const acceptedMethodologyFixture = (
  overrides: Partial<MethodologyItem> = {},
): MethodologyItem => ({
  id: "principle-accepted-1",
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-02T10:00:00.000Z",
  origin: "decision_evidence",
  status: "accepted",
  confirmedAt: "2026-08-02T10:00:00.000Z",
  title: "先验证边界，再扩大投入",
  principle: "先通过可回退的小步验证边界，再扩大不可逆投入。",
  appliesWhen: "关键效果仍需真实运行验证时。",
  caution: "验证成本高于潜在损失时应重新评估。",
  evidenceSummary: "两条复盘结果支持这项原则。",
  sourceDecisionIds: [],
  sourceDecisions: [],
  confidence: "medium",
  quality: methodologyQuality({
    recommendedConfidence: "medium",
    evidenceCount: 2,
    flags: [],
  }),
  generation: {
    requestId: "methodology:accepted-1",
    profileId: "builtin-qwen",
    provider: "Qwen 本地模型",
    model: "qwen3.5",
  },
  ...overrides,
});


export const apiFixture = (
  initial: AppSnapshot,
  modelTraces: ModelInvocationTrace[] = [],
) => {
  const obsidianSearchStatus = {
    state: "idle" as const,
    discoveredNotes: 0,
    indexedNotes: 0,
    chunkCount: 0,
    processedNotes: 0,
    totalNotes: 0,
    skippedNotes: 0,
    failedNotes: 0,
    synchronizedAt: null,
    semanticAvailable: false,
    message: null,
  };
  let listener: ((snapshot: AppSnapshot) => void) | undefined;
  const api: DecisionApi = {
    ...createEvidencePreviewApi(),
    listLocalDecisions: vi.fn(async () => ({ records: [], total: 0 })),
    resolveLocalDecision: vi.fn(async () => undefined),
    getSnapshot: vi.fn(async () => initial),
    onSnapshot: vi.fn((received) => {
      listener = received;
      return () => {
        listener = undefined;
      };
    }),
    submitRationale: vi.fn(async () => undefined),
    retryPersistence: vi.fn(async () => undefined),
    openCandidateReview: vi.fn(async () => undefined),
    closeCandidateReview: vi.fn(async () => undefined),
    confirmCandidate: vi.fn(async () => undefined),
    ignoreCandidate: vi.fn(async () => undefined),
    retryCandidate: vi.fn(async () => undefined),
    openSurface: vi.fn(async () => undefined),
    closePrimarySurface: vi.fn(async () => undefined),
    listDecisions: vi.fn(async () => []),
    listDecisionProjects: vi.fn(async () => []),
    createProactiveRecord: vi.fn(),
    listJournalEntries: vi.fn(async () => []),
    reviseJournalEntry: vi.fn(),
    getObsidianSearchStatus: vi.fn(async () => obsidianSearchStatus),
    searchObsidian: vi.fn(async (input) => ({
      query: input.query,
      results: [],
      status: obsidianSearchStatus,
    })),
    rebuildObsidianSearch: vi.fn(async () => obsidianSearchStatus),
    exportAssistantConversation: vi.fn(async () => ({ status: "cancelled" as const })),
    getAssistantFeedbackSummary: vi.fn(async () => ({ helpful: 0, notHelpful: 0 })),
    saveAssistantFeedback: vi.fn(async () => ({ status: "saved" as const, recorded: 1 })),
    cancelAssistantTurn: vi.fn(async () => undefined),
    onAssistantProgress: () => () => undefined,
    openObsidianNote: vi.fn(async () => undefined),
    openVaultDocument: vi.fn(async () => undefined),
    updateDecisionExpectedOutcome: vi.fn(async () => undefined),
    updateDecisionOutcome: vi.fn(async () => undefined),
    updateDecisionReviewDueDate: vi.fn(async () => undefined),
    updateDecisionReview: vi.fn(async (_decisionId, input) => ({
      ...input,
      reviewedAt: "2026-08-02T10:00:00.000Z",
    })),
    updateDecisionAppliedPrinciples: vi.fn(async () => []),
    getDecisionPrincipleSuggestions: vi.fn(async () => []),
    getMethodologyBuildProgress: vi.fn(async () => ({
      decisions: {
        total: 0,
        pendingOutcome: 0,
        pendingReview: 0,
        reviewed: 0,
      },
      principles: { candidate: 0, accepted: 0, retired: 0, dismissed: 0 },
      practiceAssets: { candidate: 0, accepted: 0, dismissed: 0 },
    })),
    listMethodologies: vi.fn(async () => []),
    createManualMethodology: vi.fn(),
    createManualMethodologyFromEvidence: vi.fn(),
    listManualFormDrafts: vi.fn(async () => []),
    saveManualFormDraft: vi.fn(async (input) => ({
      ...input,
      updatedAt: "2026-08-08T10:00:00.000Z",
    })),
    deleteManualFormDraft: vi.fn(async () => undefined),
    generateMethodology: vi.fn(),
    createMethodologyMergeDraft: vi.fn(),
    createMethodologyRevisionDraft: vi.fn(),
    reviseMethodology: vi.fn(),
    setMethodologyStatus: vi.fn(),
    listMethodologyVersions: vi.fn(async () => []),
    restoreMethodologyVersion: vi.fn(),
    getMethodologySuggestions: vi.fn(async () => []),
    getDeferredMethodologySuggestions: vi.fn(async () => []),
    deferMethodologySuggestion: vi.fn(async () => undefined),
    restoreMethodologySuggestion: vi.fn(async () => undefined),
    getMethodologyEvidenceMatches: vi.fn(async () => []),
    importMethodologyMarkdown: vi.fn(async () => ({
      cancelled: true,
      batchId: null,
      candidates: [],
      duplicates: [],
      failures: [],
    })),
    commitMethodologyMarkdownImport: vi.fn(async () => ({
      imported: [],
      duplicates: [],
      failures: [],
    })),
    setMethodologyEvidence: vi.fn(),
    setMethodologyRelation: vi.fn(),
    clearMethodologyRelation: vi.fn(),
    getMethodologyUsage: vi.fn(async (principleId) => ({
      principleId,
      linkedDecisionCount: 0,
      outcomeRecordedCount: 0,
      reviewedCount: 0,
      pendingOutcomeCount: 0,
      pendingReviewCount: 0,
      favorableCount: 0,
      mixedCount: 0,
      attentionCount: 0,
      unclearCount: 0,
      decisions: [],
      nextPendingDecision: null,
    })),
    getMethodologyValidationInbox: vi.fn(async () => []),
    acknowledgeMethodologyValidation: vi.fn(),
    getMethodologyMergePlan: vi.fn(),
    prepareMethodologyMergeAsset: vi.fn(),
    retireMethodologyMergeSources: vi.fn(),
    restoreMethodologyMergeSources: vi.fn(),
    getDecisionAnalytics: vi.fn(async () => ({
      generatedAt: "2026-08-02T10:00:00.000Z",
      engine: {
        name: "Local aggregation" as const,
        version: "1" as const,
        source: "SQLite snapshot" as const,
      },
      totals: {
        decisions: 0,
        projects: 0,
        rationaleCaptured: 0,
        outcomesRecorded: 0,
        outcomesReviewed: 0,
      },
      rates: { rationaleCaptured: 0, outcomesRecorded: 0, outcomesReviewed: 0 },
      verdicts: [],
      projects: [],
      sources: [],
      trend: [],
      retrospective: { reviewAttention: 0, periods: [] },
    })),
    getDecisionConsultationMetrics: vi.fn(async () => ({
      metricsVersion: 1 as const,
      requests: 0,
      matched: 0,
      noMatch: 0,
      matches: 0,
      strongMatches: 0,
      possibleMatches: 0,
      durationMs: 0,
      byClient: { claudeCode: 0, codex: 0 },
      feedback: {
        total: 0,
        helpful: 0,
        notHelpful: 0,
        misleading: 0,
        bySource: { claudeCode: 0, codex: 0, preview: 0 },
        byResult: {
          strong: { total: 0, helpful: 0, notHelpful: 0, misleading: 0 },
          possible: { total: 0, helpful: 0, notHelpful: 0, misleading: 0 },
          noMatch: { total: 0, helpful: 0, notHelpful: 0, misleading: 0 },
        },
      },
      recent: [],
      lastConsultedAt: null,
      privacy: {
        storesQuestionText: false as const,
        storesOptionText: false as const,
        storesPrincipleIds: false as const,
        storesFeedbackTokens: false as const,
        storesIndividualEvents: false as const,
      },
    })),
    previewDecisionConsultation: vi.fn(async () => ({
      consultationVersion: 1 as const,
      requestId: "preview",
      status: "no_match" as const,
      generatedBy: "deterministic_local_match" as const,
      matches: [],
      signals: [],
      feedback: null,
      boundary: {
        advisoryOnly: true as const,
        noDecisionWritten: true as const,
        noPrincipleApplied: true as const,
        noPreferencePromoted: true as const,
      },
    })),
    submitDecisionConsultationFeedback: vi.fn(async () => ({
      feedbackVersion: 1 as const,
      status: "accepted" as const,
    })),
    getKnowledgeGraph: vi.fn(async () => ({
      projects: [],
      decisions: [],
      outcomes: [],
      principles: [],
      principleRelations: [],
      edges: [],
      missingSourceDecisionIds: [],
    })),
    listPracticeAssets: vi.fn(async () => []),
    createManualPracticeAsset: vi.fn(),
    generatePracticeAsset: vi.fn(),
    revisePracticeAsset: vi.fn(),
    setPracticeAssetStatus: vi.fn(),
    regeneratePracticeAsset: vi.fn(),
    listPracticeAssetVersions: vi.fn(async () => []),
    restorePracticeAssetVersion: vi.fn(),
    listPracticePublicationStatuses: vi.fn(async () => []),
    publishPracticeAsset: vi.fn(),
    rollbackPracticeAssetPublication: vi.fn(),
    chooseVault: vi.fn(async () => null),
    revealVault: vi.fn(async () => false),
    installIntegrations: vi.fn(),
    removeIntegrations: vi.fn(),
    rebuildIndex: vi.fn(async () => ({ indexedCount: 0, diagnostics: [] })),
    setTheme: vi.fn(async () => undefined),
    listModelTraces: vi.fn(async () => modelTraces),
    deleteModelTrace: vi.fn(async () => false),
    deleteModelTraceRequest: vi.fn(async () => 0),
    forgetAssistantTurns: vi.fn(async () => undefined),
    clearModelTraces: vi.fn(async () => 0),
    setModelTraceContentEnabled: vi.fn(async () => undefined),
    setLocalCredentialsEnabled: vi.fn(async () => undefined),
    setReviewRemindersEnabled: vi.fn(async () => undefined),
  setCaptureClassifier: vi.fn(async () => undefined),
    listManagedQwenModels: async () => [],
    installManagedQwenModel: async () => undefined,
    listModelProviderProfiles: vi.fn(async () => []),
    saveModelProviderProfile: vi.fn(async (input) => input.profile),
    deleteModelProviderProfile: vi.fn(async () => false),
    reorderModelProviderProfiles: vi.fn(async () => undefined),
    testModelProviderProfile: vi.fn(async (profileId) => ({
      ok: true,
      profileId,
      latencyMs: 0,
      requestId: "provider-test",
      tokenSource: "unavailable" as const,
    })),
    checkAssistantSource: vi.fn(async () => ({ status: "matched" as const, content: "当前内容", truncated: false })),
  searchAssistantSources: vi.fn(async () => ({ sources: [], issues: [] })),
  runAssistantTurn: vi.fn(async () => ({
    version: 1 as const,
    status: "unavailable" as const,
    message: "测试替身未配置模型",
  })),
  listPrConnections: vi.fn(async () => []),
  savePrConnection: vi.fn(async () => []),
  removePrConnection: vi.fn(async () => []),
  checkPrConnection: vi.fn(async () => ({ account: "user" })),
  listPullRequests: vi.fn(async () => ({ items: [], nextPage: null })),
  loadPrReview: vi.fn(),
  peekPrReview: vi.fn(),
  prefetchPrReviews: vi.fn(),
  loadPrReviewDiff: vi.fn(),
  getPrActionContext: vi.fn(),
  performPrAction: vi.fn(),
  publishPrReviewComment: vi.fn(),
  publishPrGeneralComment: vi.fn(),
  reevaluatePrReviewFinding: vi.fn(),
  openReviewRulesDirectory: vi.fn(),
  listPrDiscussion: vi.fn(async () => ({ comments: [], more: false })),
  openPrLink: vi.fn(),
  openPr: vi.fn(),
  loadPrReviewFile: vi.fn(),
  runPrReview: vi.fn(),
  followUpPrReview: vi.fn(),
  cancelPrReview: vi.fn(async () => undefined),
  onPrReviewProgress: () => () => undefined,
  listAssistantModels: vi.fn(async () => []),
  listLocalModelClientStatuses: vi.fn(async () => []),
  };
  return {
    api,
    emit: (snapshot: AppSnapshot) => listener?.(snapshot),
  };
};

export const modelTraceFixture = (): ModelInvocationTrace => ({
  version: 1,
  traceId: "trace-1",
  requestId: "request-1",
  attemptId: "attempt-1",
  attemptIndex: 0,
  purpose: "semantic-classification",
  contentMode: "full",
  profile: {
    profileId: "qwen",
    backend: "qwen",
    provider: "qwen",
    model: "qwen3.5-2b-q4-k-m",
    promptVersion: "semantic-v1",
    schemaVersion: "semantic-classification-v1",
  },
  input: {
    systemPrompt: "Classify without reasoning.",
    userPrompt: "Assistant: choose A or B. User: A.",
    outputSchema: { type: "object" },
    clientSystemPromptVisibility: "visible",
  },
  output: {
    visibleText: '{"decisionIntent":"decision"}',
    parsed: { decisionIntent: "decision" },
  },
  usage: {
    source: "runtime_measured",
    inputTokens: 42,
    outputTokens: 12,
    totalTokens: 54,
  },
  timing: {
    queuedMs: 0,
    providerMs: 25,
    totalMs: 28,
  },
  status: "succeeded",
  createdAt: "2026-07-30T00:00:00.000Z",
  expiresAt: "2026-08-06T00:00:00.000Z",
});

export const renderDecisionLibrary = async (api: DecisionApi) => {
  // Settle the initial debounced query before testing keyboard and form input
  // with real user events. No waitFor deadline should race the initial load.
  vi.useFakeTimers();
  try {
    await act(async () => { render(createElement(App, { api })); });
    await act(() => vi.advanceTimersByTimeAsync(160));
  } finally {
    vi.useRealTimers();
  }
};
