import { createEvidencePreviewApi } from "../src/renderer/evidence-preview-api.js";
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

// Something recorded, so the dashboard shows its cards rather than the first-run steps.
const dashboard = {
  totalDecisions: 3,
  recorded7d: 0,
  reviewAttention: 0,
  recentDecisions: [],
};

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

const apiFor = (snapshot: AppSnapshot): DecisionApi => ({
  ...createEvidencePreviewApi(),
  listLocalDecisions: vi.fn(async () => ({ records: [], total: 0 })),
  resolveLocalDecision: vi.fn(async () => undefined),
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
  chooseVault: vi.fn(),
  revealVault: vi.fn(async () => false),
  installIntegrations: vi.fn(),
  removeIntegrations: vi.fn(),
  rebuildIndex: vi.fn(),
  setTheme: vi.fn(),
  listModelTraces: vi.fn(async () => []),
  deleteModelTrace: vi.fn(async () => false),
  deleteModelTraceRequest: vi.fn(async () => 0),
  forgetAssistantTurns: vi.fn(async () => undefined),
  clearModelTraces: vi.fn(async () => 0),
  setModelTraceContentEnabled: vi.fn(),
  setLocalCredentialsEnabled: vi.fn(async () => undefined),
  setReviewRemindersEnabled: vi.fn(async () => undefined),
  setCaptureClassifier: vi.fn(async () => undefined),
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
  listManagedQwenModels: vi.fn(async () => []),
  installManagedQwenModel: vi.fn(async () => undefined),
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
      expect(button).toHaveAccessibleName(name);
      // The label itself stays plain text; only an aria-hidden shortcut hint
      // may sit next to it.
      const visibleLabel = [...button.childNodes]
        .filter(
          (node) =>
            !(
              node instanceof HTMLElement &&
              node.getAttribute("aria-hidden") === "true"
            ),
        )
        .map((node) => node.textContent ?? "")
        .join("")
        .trim();
      expect(visibleLabel).toBe(name);
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
      screen.getByRole("region", {
        name: "已选答案",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", {
        name: "选择本地服务协议",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("list", {
        name: "已选答案",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("list", {
        name: "当时的其它候选",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "不保留",
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

  it("names the knowledge workspace and every control", async () => {
    const snapshot: AppSnapshot = {
      current: null,
      waitingCount: 0,
      primarySurface: "decisions",
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

    render(<App api={apiFor(snapshot)} />);

    const page = await screen.findByRole("region", { name: "知识" });
    expect(
      within(page).getByRole("searchbox", { name: "搜索决策与笔记" }),
    ).toBeVisible();
    expect(
      within(page).getByRole("region", { name: "Vault 笔记" }),
    ).toBeVisible();
    for (const button of screen.getAllByRole("button")) {
      expect(button).toHaveAccessibleName();
    }
    for (const textbox of screen.getAllByRole("searchbox")) {
      expect(textbox).toHaveAccessibleName();
    }
  });

  it("names every control on the dashboard, review inbox included", async () => {
    const snapshot: AppSnapshot = {
      current: null,
      waitingCount: 0,
      primarySurface: "dashboard",
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
    vi.mocked(api.listDecisions).mockImplementation(async (query) =>
      query.reviewState === "attention"
        ? [
            {
              id: "decision-due",
              created: "2026-07-30T03:04:00.000Z",
              sourceClient: "codex",
              project: "decision",
              question: "索引重建应该自动还是手动？",
              selectedAnswer: "保持手动重建",
              rationaleStatus: "captured",
              rationale: null,
              context: null,
              outcome: null,
              outcomeReview: null,
              reviewDueDate: "2026-08-30",
              appliedPrincipleIds: [],
              appliedPrinciples: [],
            },
          ]
        : [],
    );

    render(<App api={api} />);

    const page = await screen.findByRole("region", { name: "首页" });
    // The row carries two controls: open the decision, and finish the step it
    // is waiting on. Neither may be an unnamed icon.
    expect(
      await within(page).findByRole("button", { name: "回填结果" }),
    ).toBeVisible();
    for (const button of screen.getAllByRole("button")) {
      expect(button).toHaveAccessibleName();
    }
  });

  it("names every control in quick jump", async () => {
    const snapshot: AppSnapshot = {
      current: null,
      waitingCount: 0,
      primarySurface: "dashboard",
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

    render(<App api={apiFor(snapshot)} />);

    await screen.findByRole("region", { name: "首页" });
    fireEvent.click(screen.getByRole("button", { name: /快速跳转/u }));

    const dialog = await screen.findByRole("dialog", { name: "快速跳转" });
    // The options are not focusable: the field keeps focus and points at the
    // active one, so the field is what a screen reader has to be able to name.
    expect(
      within(dialog).getByRole("combobox", {
        name: "搜索决策、想法、笔记、原则、问答与评审",
      }),
    ).toHaveAccessibleName();
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
      screen.getByRole("switch", {
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
