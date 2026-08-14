// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type {
  AppSnapshot,
  DecisionApi,
} from "../src/shared/renderer-api.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/renderer/App.js";
import { serverCandidateFixture, serverCaptureFixture } from "./fixtures.js";

afterEach(cleanup);

const semanticRecognition = {
  provider: "rules" as const,
  providerLabel: "规则识别",
  availability: "model_missing" as const,
  mode: "hybrid" as const,
  processed7d: 0,
  high7d: 0,
  medium7d: 0,
  failures7d: 0,
  updatedAt: "2026-07-27T10:00:00.000Z",
};

const dashboard = {
  totalDecisions: 0,
  recorded7d: 0,
  reviewAttention: 0,
  recentDecisions: [],
};

const apiFor = (snapshot: AppSnapshot): DecisionApi => ({
  getSnapshot: vi.fn(async () => snapshot),
  onSnapshot: vi.fn(() => () => undefined),
  submitRationale: vi.fn(),
  retryPersistence: vi.fn(),
  openCandidateReview: vi.fn(),
  closeCandidateReview: vi.fn(),
  confirmCandidate: vi.fn(),
  ignoreCandidate: vi.fn(),
  retryCandidate: vi.fn(),
  openSurface: vi.fn(),
  closePrimarySurface: vi.fn(),
  listDecisions: vi.fn(async () => []),
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
    saveManualFormDraft: vi.fn(),
    deleteManualFormDraft: vi.fn(),
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
    feedback: null,
    boundary: {
      advisoryOnly: true as const,
      noDecisionWritten: true as const,
      noPrincipleApplied: true as const,
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
  chooseVault: vi.fn(),
  installIntegrations: vi.fn(),
  rebuildIndex: vi.fn(),
  setTheme: vi.fn(),
  listModelTraces: vi.fn(async () => []),
  deleteModelTrace: vi.fn(async () => false),
  deleteModelTraceRequest: vi.fn(async () => 0),
  clearModelTraces: vi.fn(async () => 0),
  setModelTraceContentEnabled: vi.fn(),
  listModelProviderProfiles: vi.fn(async () => []),
  saveModelProviderProfile: vi.fn(async (input) => input.profile),
  deleteModelProviderProfile: vi.fn(async () => false),
  reorderModelProviderProfiles: vi.fn(),
  testModelProviderProfile: vi.fn(async (profileId) => ({
    ok: true,
    profileId,
    latencyMs: 0,
    requestId: "provider-test",
    tokenSource: "unavailable" as const,
  })),
  listLocalModelClientStatuses: vi.fn(async () => []),
});

describe("renderer accessibility", () => {
  it("describes the startup failure and keeps retry keyboard-focusable", async () => {
    const api = apiFor({} as AppSnapshot);
    vi.mocked(api.getSnapshot).mockRejectedValueOnce(
      new Error("private /vault path"),
    );

    render(<App api={api} />);

    const alert = await screen.findByRole("alert", {
      name: "应用状态加载失败",
    });
    expect(alert).toHaveAccessibleDescription(
      "暂时无法读取应用状态，请重试。",
    );
    const retry = within(alert).getByRole("button", { name: "重试" });
    retry.focus();
    expect(retry).toHaveFocus();
  });

  it("names the candidate review region and text-only actions", async () => {
    const candidate = serverCandidateFixture();
    const snapshot: AppSnapshot = {
      current: null,
      waitingCount: 0,
      primarySurface: "hidden",
      dashboard,
      candidateReviewOpen: true,
      candidateReviewProgress: {
        position: 1,
        total: 1,
      },
      decisionCandidates: {
        current: candidate,
        count: 1,
      },
      theme: "auto",
      vaultPath: "/vault",
      health: { index: "healthy", recovery: "healthy" },
      integrationStatus: {
        claudeCode: "installed",
        codex: "installed",
      },
      pendingRationales: [],
      modelTraceContentEnabled: true,
      semanticRecognition,
    };

    render(<App api={apiFor(snapshot)} />);

    expect(
      await screen.findByRole("region", {
        name: "待处理决策",
      }),
    ).toBeVisible();
    for (const name of ["稍后", "忽略", "记录并补充理由"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toHaveTextContent(name);
      expect(button.textContent).toBe(name);
    }
    expect(document.body).not.toHaveTextContent("待确认候选");
  });

  it("names the rationale region and every action", async () => {
    const event = serverCaptureFixture({ sourceClient: "codex" });
    const snapshot: AppSnapshot = {
      current: {
        status: "awaiting_rationale",
        candidateId: "candidate-1",
        candidateKey: "key-1",
        event,
        question: event.questions[0]!,
      },
      waitingCount: 1,
      primarySurface: "hidden",
      dashboard,
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
        claudeCode: "installed",
        codex: "installed",
      },
      pendingRationales: [],
      semanticRecognition,
    };

    render(<App api={apiFor(snapshot)} />);

    expect(
      await screen.findByRole("region", {
        name: "待补充决策理由",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", {
        name: "选择本地服务协议",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("checkbox", {
        name: "不记录此次决策",
      }),
    ).toBeVisible();
    for (const button of screen.getAllByRole("button")) {
      expect(button).toHaveAccessibleName();
    }
  });

  it("names the general settings appearance controls and every action", async () => {
    const snapshot: AppSnapshot = {
      current: null,
      waitingCount: 0,
      primarySurface: "settings",
      dashboard,
      candidateReviewOpen: false,
      candidateReviewProgress: null,
      decisionCandidates: {
        current: null,
        count: 0,
      },
      theme: "dark",
      vaultPath: "/vault",
      health: { index: "healthy", recovery: "healthy" },
      integrationStatus: {
        claudeCode: "installed",
        codex: "installed",
      },
      pendingRationales: [],
      semanticRecognition,
    };

    render(<App api={apiFor(snapshot)} />);

    expect(await screen.findByRole("group", { name: "外观" })).toBeVisible();
    expect(screen.getByRole("button", { name: "深色" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    for (const button of screen.getAllByRole("button")) {
      expect(button).toHaveAccessibleName();
    }
  });

  it("names the activity controls and every action", async () => {
    const snapshot: AppSnapshot = {
      current: null,
      waitingCount: 0,
      primarySurface: "activity",
      dashboard,
      candidateReviewOpen: false,
      candidateReviewProgress: null,
      decisionCandidates: {
        current: null,
        count: 0,
      },
      theme: "dark",
      vaultPath: "/vault",
      health: { index: "healthy", recovery: "healthy" },
      integrationStatus: {
        claudeCode: "installed",
        codex: "installed",
      },
      pendingRationales: [],
      modelTraceContentEnabled: true,
      semanticRecognition,
    };

    render(<App api={apiFor(snapshot)} />);

    expect(
      await screen.findByRole("region", {
        name: "模型调用记录",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("checkbox", {
        name: /记录模型输入和输出/u,
      }),
    ).toBeVisible();
    for (const button of screen.getAllByRole("button")) {
      expect(button).toHaveAccessibleName();
    }
  });

  it("names every control in the Markdown import preview", async () => {
    const snapshot: AppSnapshot = {
      current: null,
      waitingCount: 0,
      primarySurface: "methodology",
      dashboard,
      candidateReviewOpen: false,
      candidateReviewProgress: null,
      decisionCandidates: { current: null, count: 0 },
      theme: "dark",
      vaultPath: "/vault",
      health: { index: "healthy", recovery: "healthy" },
      integrationStatus: { claudeCode: "installed", codex: "installed" },
      pendingRationales: [],
      modelTraceContentEnabled: true,
      semanticRecognition,
    };
    const api = apiFor(snapshot);
    vi.mocked(api.importMethodologyMarkdown).mockResolvedValue({
      cancelled: false,
      batchId: "methodology-import-batch-a11y",
      candidates: [
        {
          id: "candidate-a11y",
          fileName: "方法论.md",
          title: "保留回退路径",
          principle: "先验证关键假设，再扩大范围。",
          appliesWhen: "结果仍未知时。",
          caution: "双轨成本过高时重新评估。",
          sourceDecisionCount: 0,
          missingFields: [],
          similarTo: null,
        },
      ],
      duplicates: [],
      failures: [],
    });

    render(<App api={api} />);
    const page = await screen.findByRole("region", { name: "方法论" });
    fireEvent.click(within(page).getByRole("button", { name: "新建原则" }));
    const creationDialog = await screen.findByRole("dialog", {
      name: "新建原则",
    });
    fireEvent.click(
      within(creationDialog).getByRole("button", { name: /导入 Markdown/u }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "预检 Markdown 导入",
    });
    expect(within(dialog).getByRole("checkbox", { name: /保留回退路径/u })).toBeChecked();
    for (const button of within(dialog).getAllByRole("button")) {
      expect(button).toHaveAccessibleName();
    }
  });
});
