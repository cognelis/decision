// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ModelInvocationTrace } from "@cognelis/decision-protocol";
import type {
  MethodologyQualityAssessment,
  MethodologySuggestion,
} from "@cognelis/decision-core";
import type {
  AppSnapshot,
  DecisionLibraryItem,
  DecisionApi,
  MethodologyItem,
  MethodologyValidationItem,
  PracticeAssetItem,
} from "../src/shared/renderer-api.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/renderer/App.js";
import { serverCandidateFixture, serverCaptureFixture } from "./fixtures.js";

const candidate = () => {
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

const contextualCandidate = () => {
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

const reviewCandidate = () => {
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

const rationaleSnapshot = (
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

const methodologyQuality = (
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

const acceptedMethodologyFixture = (
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

afterEach(cleanup);

const apiFixture = (
  initial: AppSnapshot,
  modelTraces: ModelInvocationTrace[] = [],
) => {
  let listener: ((snapshot: AppSnapshot) => void) | undefined;
  const api: DecisionApi = {
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
    chooseVault: vi.fn(async () => null),
    installIntegrations: vi.fn(),
    rebuildIndex: vi.fn(),
    setTheme: vi.fn(async () => undefined),
    listModelTraces: vi.fn(async () => modelTraces),
    deleteModelTrace: vi.fn(async () => false),
    deleteModelTraceRequest: vi.fn(async () => 0),
    clearModelTraces: vi.fn(async () => 0),
    setModelTraceContentEnabled: vi.fn(async () => undefined),
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
    listLocalModelClientStatuses: vi.fn(async () => []),
  };
  return {
    api,
    emit: (snapshot: AppSnapshot) => listener?.(snapshot),
  };
};

const modelTraceFixture = (): ModelInvocationTrace => ({
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

describe("App", () => {
  it("retries a failed initial snapshot without reloading the window", async () => {
    const initial = rationaleSnapshot({
      current: null,
      primarySurface: "dashboard",
    });
    const { api } = apiFixture(initial);
    vi.mocked(api.getSnapshot)
      .mockRejectedValueOnce(new Error("private /vault path"))
      .mockResolvedValueOnce(initial);
    const user = userEvent.setup();

    render(<App api={api} />);

    const alert = await screen.findByRole("alert", {
      name: "应用状态加载失败",
    });
    expect(alert).toHaveTextContent("暂时无法读取应用状态，请重试。");
    expect(alert).not.toHaveTextContent("/vault");

    await user.click(screen.getByRole("button", { name: "重试" }));

    expect(
      await screen.findByRole("region", { name: "首页" }),
    ).toBeVisible();
    expect(api.getSnapshot).toHaveBeenCalledTimes(2);
    expect(api.onSnapshot).toHaveBeenCalledOnce();
  });

  it("reviews a medium-confidence candidate without consuming it on close", async () => {
    const review = reviewCandidate();
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        candidateReviewOpen: true,
        candidateReviewProgress: {
          position: 1,
          total: 2,
        },
        decisionCandidates: {
          current: review,
          count: 2,
        },
      }),
    );
    const user = userEvent.setup();
    render(<App api={api} />);

    expect(
      await screen.findByRole("region", {
        name: "待处理决策",
      }),
    ).toBeVisible();
    expect(screen.getByText("待处理 1 / 2")).toBeVisible();
    expect(
      screen.queryByRole("heading", {
        name: "这是一个需要记录的决策吗？",
      }),
    ).toBeNull();
    expect(screen.queryByText("本地识别 · 尚未写入 Obsidian")).toBeNull();
    expect(screen.getByRole("heading", { name: "原文" })).toBeVisible();
    expect(screen.getByText("先规则后模型")).toBeVisible();
    expect(screen.getByText("继续开发 Decision。")).toBeVisible();
    expect(
      within(screen.getByLabelText("你的回答")).getByText("Loopback HTTP"),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "稍后" }));

    expect(api.closeCandidateReview).toHaveBeenCalledOnce();
    expect(api.confirmCandidate).not.toHaveBeenCalled();
    expect(api.ignoreCandidate).not.toHaveBeenCalled();
  });

  it("confirms or ignores the current review candidate", async () => {
    const firstCandidate = reviewCandidate();
    const first = apiFixture(
      rationaleSnapshot({
        current: null,
        candidateReviewOpen: true,
        candidateReviewProgress: {
          position: 1,
          total: 1,
        },
        decisionCandidates: {
          current: firstCandidate,
          count: 1,
        },
      }),
    );
    const user = userEvent.setup();
    const rendered = render(<App api={first.api} />);

    await user.click(
      await screen.findByRole("button", {
        name: "记录并补充理由",
      }),
    );
    expect(first.api.confirmCandidate).toHaveBeenCalledWith(
      firstCandidate.candidateId,
    );

    rendered.unmount();
    const secondCandidate = reviewCandidate();
    const second = apiFixture(
      rationaleSnapshot({
        current: null,
        candidateReviewOpen: true,
        candidateReviewProgress: {
          position: 1,
          total: 1,
        },
        decisionCandidates: {
          current: secondCandidate,
          count: 1,
        },
      }),
    );
    render(<App api={second.api} />);
    await user.click(
      await screen.findByRole("button", {
        name: "忽略",
      }),
    );
    expect(second.api.ignoreCandidate).toHaveBeenCalledWith(
      secondCandidate.candidateId,
    );
  });

  it("does not resubmit a candidate while its failed action is waiting to retry", async () => {
    const review = reviewCandidate();
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        candidateReviewOpen: true,
        candidateReviewProgress: { position: 1, total: 1 },
        decisionCandidates: {
          current: review,
          count: 1,
          persistenceStatus: "failed",
        },
      }),
    );
    const user = userEvent.setup();
    vi.mocked(api.retryCandidate).mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'decision:retry-candidate'",
      ),
    );

    render(<App api={api} />);

    const confirm = await screen.findByRole("button", {
      name: "记录并补充理由",
    });
    const ignore = screen.getByRole("button", { name: "忽略" });
    const retry = screen.getByRole("button", { name: "重试" });

    expect(confirm).toBeDisabled();
    expect(ignore).toBeDisabled();
    expect(retry).toBeEnabled();
    expect(
      screen.getByText(
        "候选状态暂时无法保存。可以重试，或点“稍后”退出，内容仍会保留。",
      ),
    ).toBeVisible();
    await user.click(confirm);
    expect(api.confirmCandidate).not.toHaveBeenCalled();
    await user.click(retry);
    expect(
      await screen.findByText("候选仍未保存，请重试或稍后处理。"),
    ).toBeVisible();
    expect(
      screen.queryByText(/Error invoking remote method/u),
    ).toBeNull();
  });

  it("submits a candidate action only once on rapid repeated activation", async () => {
    const review = reviewCandidate();
    let finishConfirm: (() => void) | undefined;
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        candidateReviewOpen: true,
        candidateReviewProgress: { position: 1, total: 1 },
        decisionCandidates: { current: review, count: 1 },
      }),
    );
    vi.mocked(api.confirmCandidate).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishConfirm = resolve;
        }),
    );

    render(<App api={api} />);

    const confirm = await screen.findByRole("button", {
      name: "记录并补充理由",
    });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(api.confirmCandidate).toHaveBeenCalledTimes(1);
    finishConfirm?.();
  });

  it("shows captured context in a dialog without expanding the rationale surface", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: contextualCandidate(),
      }),
    );
    const user = userEvent.setup();

    render(<App api={api} />);

    expect(await screen.findByText("继续开发 Decision。")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "任务背景" })).toBeNull();
    expect(screen.getByText("上下文已截断")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "查看完整上下文" }));
    const contextDialog = within(
      screen.getByRole("dialog", { name: "当时上下文" }),
    );
    expect(
      contextDialog.getByRole("heading", { name: "任务背景" }),
    ).toBeVisible();
    expect(
      contextDialog.getByRole("heading", { name: "约束与考虑" }),
    ).toBeVisible();

    await user.click(
      contextDialog.getByRole("button", { name: "关闭当时上下文" }),
    );
    expect(screen.queryByRole("heading", { name: "任务背景" })).toBeNull();
  });

  it("renders no empty context disclosure", async () => {
    const { api } = apiFixture(rationaleSnapshot());

    render(<App api={api} />);

    expect(await screen.findByText("为什么这样选？")).toBeVisible();
    expect(screen.queryByRole("button", { name: "查看完整上下文" })).toBeNull();
  });

  it("shows the native answer and never renders choice controls", async () => {
    const { api } = apiFixture(rationaleSnapshot());

    render(<App api={api} />);

    expect(await screen.findByText("为什么这样选？")).toBeVisible();
    expect(screen.getByText("选择本地服务协议")).toBeVisible();
    expect(
      screen.getByText(
        (_, element) =>
          element?.classList.contains("eyebrow") === true &&
          element.textContent?.includes("Loopback HTTP") === true,
      ),
    ).toBeVisible();
    expect(screen.queryByLabelText("可选方案")).toBeNull();
    expect(screen.queryByText("返回")).toBeNull();
    expect(screen.getByTestId("decision-shell")).toHaveClass(
      "desktop-view",
      "decision-workspace",
    );
    expect(screen.getByTestId("decision-shell")).toHaveAttribute(
      "data-layout",
      "desktop",
    );
  });

  it("lets the user explicitly attach a locally matched accepted principle", async () => {
    const { api } = apiFixture(rationaleSnapshot());
    const principle = acceptedMethodologyFixture();
    vi.mocked(api.getDecisionPrincipleSuggestions).mockResolvedValue([
      {
        id: principle.id,
        title: principle.title,
        principle: principle.principle,
        appliesWhen: principle.appliesWhen,
        caution: principle.caution,
        score: 31,
        strength: "strong",
        reason: "原则内容与当前决策存在文本重合。",
        matchedTerms: ["边界"],
      },
    ]);
    const user = userEvent.setup();
    render(<App api={api} />);

    expect(
      await screen.findByRole("heading", { name: "核对相关原则" }),
    ).toBeVisible();
    expect(screen.getByText("选择已完成，仅用于核对依据")).toBeVisible();
    await waitFor(() =>
      expect(api.getDecisionPrincipleSuggestions).toHaveBeenCalledWith({
        question: "选择本地服务协议",
        selectedAnswer: "Loopback HTTP",
        optionLabels: ["Loopback HTTP", "Unix Socket"],
        context: null,
      }),
    );

    await user.click(
      await screen.findByRole("button", {
        name: new RegExp(principle.title, "u"),
      }),
    );
    expect(screen.getByText("已标记 1 条，将随决策保存。")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "完成" }));

    expect(api.submitRationale).toHaveBeenCalledWith({
      candidateId: "candidate-1",
      status: "captured",
      appliedPrincipleIds: [principle.id],
    });
  });

  it("preserves typed rationale when factors are selected", async () => {
    const { api } = apiFixture(rationaleSnapshot());
    const user = userEvent.setup();
    render(<App api={api} />);

    const rationale = await screen.findByRole("textbox", {
      name: "补充说明（可选）",
    });
    await user.type(rationale, "  更容易诊断，也便于跨平台。  ");
    await user.click(screen.getByRole("button", { name: "复用现有能力" }));
    await user.click(screen.getByRole("button", { name: "完成" }));

    expect(api.submitRationale).toHaveBeenCalledWith({
      candidateId: "candidate-1",
      status: "captured",
      rationale: "  更容易诊断，也便于跨平台。  ",
      reasonFactors: ["reuse"],
    });
  });

  it("keeps factor-only rationale separate from user-authored text", async () => {
    const { api } = apiFixture(rationaleSnapshot());
    const user = userEvent.setup();
    render(<App api={api} />);

    await user.click(
      await screen.findByRole("button", { name: "遵循现有约定" }),
    );
    await user.click(screen.getByRole("button", { name: "完成" }));

    expect(api.submitRationale).toHaveBeenCalledWith({
      candidateId: "candidate-1",
      status: "captured",
      reasonFactors: ["consistency"],
    });
  });

  it("offers judgment factors derived from accumulated decision summaries", async () => {
    const { api } = apiFixture(rationaleSnapshot());
    render(<App api={api} />);

    for (const label of [
      "遵循现有约定",
      "清晰易懂",
      "简单直接",
      "复用现有能力",
      "职责边界清晰",
      "可验证可追溯",
    ]) {
      expect(
        await screen.findByRole("button", { name: label }),
      ).toBeVisible();
    }
    expect(screen.queryByRole("button", { name: "实现成本" })).toBeNull();
    expect(screen.queryByRole("button", { name: "时间" })).toBeNull();
  });

  it("discards through the required checkbox", async () => {
    const { api } = apiFixture(rationaleSnapshot());
    const user = userEvent.setup();
    render(<App api={api} />);

    const checkbox = await screen.findByRole("checkbox", {
      name: "不记录此次决策",
    });
    await user.click(checkbox);
    await user.click(checkbox);
    await user.click(checkbox);
    expect(
      screen.queryByRole("textbox", { name: "补充说明（可选）" }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "不记录" }));

    expect(api.submitRationale).toHaveBeenCalledWith({
      candidateId: "candidate-1",
      status: "not_recorded",
    });
  });

  it("allows later processing or skipping rationale", async () => {
    const first = apiFixture(rationaleSnapshot());
    const user = userEvent.setup();
    const rendered = render(<App api={first.api} />);

    await user.click(await screen.findByRole("button", { name: "稍后处理" }));
    expect(first.api.submitRationale).toHaveBeenCalledWith({
      candidateId: "candidate-1",
      status: "deferred",
    });

    rendered.unmount();
    const second = apiFixture(rationaleSnapshot());
    render(<App api={second.api} />);
    await user.click(await screen.findByRole("button", { name: "跳过理由" }));
    expect(second.api.submitRationale).toHaveBeenCalledWith({
      candidateId: "candidate-1",
      status: "skipped",
    });
  });

  it("shows complete business overview and handles work in the decision center", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "dashboard",
        dashboard: {
          totalDecisions: 28,
          recorded7d: 7,
          reviewAttention: 0,
          recentDecisions: [
            {
              id: "recent-1",
              created: "2026-07-30T08:30:00.000Z",
              sourceClient: "codex",
              project: "decision",
              question: "决策工作流应该从设置中拆出吗？",
              selectedAnswer: "建立独立决策中心",
              rationaleStatus: "captured",
            },
          ],
        },
        decisionCandidates: {
          current: reviewCandidate(),
          count: 3,
        },
        pendingRationales: [
          {
            id: "decision-pending",
            question: "选择缓存策略",
            created: "2026-07-24T01:00:00.000Z",
            project: "decision",
            sourceClient: "codex",
            selectedAnswer: "使用可清理的本地缓存",
            contextSummary: "需要兼顾启动速度与数据可恢复性。",
          },
        ],
      }),
    );
    const user = userEvent.setup();
    render(<App api={api} />);

    expect(
      await screen.findByRole("region", {
        name: "首页",
      }),
    ).toBeVisible();
    expect(screen.getAllByText("待确认")).toHaveLength(2);
    expect(screen.getByText("待补理由")).toBeVisible();
    expect(screen.getByText("需复盘")).toBeVisible();
    expect(screen.getByText("近 7 天记录")).toBeVisible();
    expect(screen.getByText("全部决策")).toBeVisible();
    expect(screen.getByText("28")).toBeVisible();
    expect(screen.getByText("7")).toBeVisible();
    expect(screen.getByText("选择本地服务协议")).toBeVisible();
    expect(screen.getByText("决策工作流应该从设置中拆出吗？")).toBeVisible();
    expect(screen.getByText("建立独立决策中心")).toBeVisible();
    expect(
      screen.getByRole("list", { name: "已记录的最近决策" }),
    ).toHaveAttribute("tabindex", "0");
    expect(screen.queryByText("处理轮次")).not.toBeInTheDocument();
    expect(screen.queryByText("直接捕获")).not.toBeInTheDocument();
    expect(screen.queryByText("候选")).not.toBeInTheDocument();
    expect(screen.queryByText("失败")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "开始处理" }));
    expect(api.openCandidateReview).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "补充理由" }));
    const rationaleDialog = within(
      screen.getByRole("dialog", { name: "补充决策理由" }),
    );
    await user.type(
      rationaleDialog.getByRole("textbox", {
        name: "补充选择缓存策略的理由",
      }),
      "因为缓存可以随时清除。",
    );
    await user.click(
      rationaleDialog.getByRole("button", { name: "保存补充理由" }),
    );

    expect(api.submitRationale).toHaveBeenCalledWith({
      candidateId: "decision-pending",
      status: "captured",
      rationale: "因为缓存可以随时清除。",
    });
    await waitFor(() => expect(api.onSnapshot).toHaveBeenCalledOnce());
  });

  it("shows enough context to judge a historical pending rationale", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "dashboard",
        pendingRationales: [
          {
            id: "decision-historical",
            question: "旧缓存应该保留多久？",
            created: "2020-01-02T03:04:00.000Z",
            project: "legacy-project",
            sourceClient: "codex",
            selectedAnswer: "保留 30 天",
            contextSummary: "迁移完成前需要保留回滚能力。",
          },
        ],
      }),
    );

    render(<App api={api} />);

    expect(await screen.findByText("已记录决策，理由尚未补充")).toBeVisible();
    expect(screen.getByText(/保留 30 天/u)).toBeVisible();
    expect(screen.getByText("legacy-project")).toBeVisible();
    expect(screen.getByText("Codex")).toBeVisible();
    expect(screen.getByText("迁移完成前需要保留回滚能力。")).toBeVisible();
    expect(screen.getByText("历史")).toBeVisible();
  });

  it("can keep a pending decision while ending its rationale task", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "dashboard",
        pendingRationales: [
          {
            id: "decision-pending",
            question: "旧缓存应该保留多久？",
            created: "2026-07-30T03:04:00.000Z",
            project: "decision",
            sourceClient: "codex",
            selectedAnswer: "保留 30 天",
            contextSummary: null,
          },
        ],
      }),
    );
    const user = userEvent.setup();

    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: "不记录" }));
    expect(api.submitRationale).not.toHaveBeenCalled();
    expect(
      screen.getByText("如果只是无需补充理由，也可以保留决策并结束这项待办。"),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "取消不记录决策" }));
    expect(
      screen.queryByText("如果只是无需补充理由，也可以保留决策并结束这项待办。"),
    ).toBeNull();

    await user.click(screen.getByRole("button", { name: "不记录" }));
    await user.click(screen.getByRole("button", { name: "保留但不补" }));

    expect(api.submitRationale).toHaveBeenCalledWith({
      candidateId: "decision-pending",
      status: "skipped",
    });
  });

  it("removes a pending decision only after explicit confirmation", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "dashboard",
        pendingRationales: [
          {
            id: "decision-pending",
            question: "旧缓存应该保留多久？",
            created: "2026-07-30T03:04:00.000Z",
            project: "decision",
            sourceClient: "codex",
            selectedAnswer: "保留 30 天",
            contextSummary: null,
          },
        ],
      }),
    );
    const user = userEvent.setup();

    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: "不记录" }));
    await user.click(screen.getByRole("button", { name: "确认不记录" }));

    expect(api.submitRationale).toHaveBeenCalledWith({
      candidateId: "decision-pending",
      status: "not_recorded",
    });
  });

  it("keeps discard confirmation visible when removing the decision fails", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "dashboard",
        pendingRationales: [
          {
            id: "decision-pending",
            question: "旧缓存应该保留多久？",
            created: "2026-07-30T03:04:00.000Z",
            project: "decision",
            sourceClient: "codex",
            selectedAnswer: "保留 30 天",
            contextSummary: null,
          },
        ],
      }),
    );
    vi.mocked(api.submitRationale).mockRejectedValueOnce(
      new Error("write failed"),
    );
    const user = userEvent.setup();

    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: "不记录" }));
    await user.click(screen.getByRole("button", { name: "确认不记录" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "暂时无法移除这条决策：write failed",
    );
    expect(
      screen.getByText("如果只是无需补充理由，也可以保留决策并结束这项待办。"),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "确认不记录" })).toBeEnabled();
  });

  it.each(["dashboard", "settings"] as const)(
    "keeps an active rationale above the %s surface",
    async (primarySurface) => {
      const { api } = apiFixture(rationaleSnapshot({ primarySurface }));

      render(<App api={api} />);

      expect(
        await screen.findByRole("region", {
          name: "待补充决策理由",
        }),
      ).toBeVisible();
      expect(screen.queryByRole("region", { name: "首页" })).toBeNull();
      expect(screen.queryByRole("group", { name: "外观" })).toBeNull();
    },
  );

  it("keeps a deferred rationale editable when saving fails", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "dashboard",
        pendingRationales: [
          {
            id: "decision-pending",
            question: "选择缓存策略",
            created: "2026-07-24T01:00:00.000Z",
            project: "decision",
            sourceClient: "codex",
            selectedAnswer: "使用可清理的本地缓存",
            contextSummary: null,
          },
        ],
      }),
    );
    vi.mocked(api.submitRationale).mockRejectedValueOnce(
      new Error("write failed"),
    );
    const user = userEvent.setup();
    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: "补充理由" }));
    const dialog = within(screen.getByRole("dialog", { name: "补充决策理由" }));
    const editor = dialog.getByRole("textbox", {
      name: "补充选择缓存策略的理由",
    });
    await user.type(editor, "因为缓存可以随时清除。");
    await user.click(dialog.getByRole("button", { name: "保存补充理由" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "理由暂时无法保存：write failed",
    );
    expect(editor).toHaveValue("因为缓存可以随时清除。");
    expect(dialog.getByRole("button", { name: "保存补充理由" })).toBeEnabled();
  });

  it("keeps model configuration focused while retaining provider status", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "models",
      }),
    );

    render(<App api={api} />);

    const card = await screen.findByRole("region", {
      name: "模型",
    });
    const semantic = within(card);
    expect(semantic.getByText("Qwen 本地模型")).toBeVisible();
    expect(semantic.getByText("可用")).toBeVisible();
    expect(semantic.getByText("混合模式")).toBeVisible();
    expect(semantic.queryByText("处理轮次")).toBeNull();
    expect(semantic.queryByText("直接捕获")).toBeNull();
    expect(semantic.queryByText("候选")).toBeNull();
    expect(semantic.queryByText("失败")).toBeNull();
    expect(screen.queryByText("待确认")).toBeNull();
    expect(screen.queryByText("待补理由")).toBeNull();
    expect(screen.queryByText("最近决策")).toBeNull();
    expect(card.textContent).not.toContain("semantic-session");
    expect(card.textContent).not.toContain("/Users/");
    expect(semantic.queryByRole("slider")).not.toBeInTheDocument();
    expect(semantic.queryByText(/阈值|置信度/u)).not.toBeInTheDocument();
  });

  it("returns from settings to the decision center", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "settings",
      }),
    );
    const user = userEvent.setup();

    render(<App api={api} />);

    await user.click(
      await screen.findByRole("button", {
        name: "首页",
      }),
    );

    expect(api.openSurface).toHaveBeenCalledWith("dashboard");
  });

  it("routes every management entry to its own desktop page", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "dashboard",
      }),
    );
    const user = userEvent.setup();

    render(<App api={api} />);

    await screen.findByRole("region", { name: "首页" });

    for (const surface of [
      ["决策库", "decisions"],
      ["方法论", "methodology"],
      ["接入", "clients"],
      ["模型", "models"],
      ["日志", "activity"],
      ["设置", "settings"],
    ] as const) {
      await user.click(screen.getByRole("button", { name: surface[0] }));
      expect(api.openSurface).toHaveBeenLastCalledWith(surface[1]);
    }
  });

  it("shows due reviews on the dashboard without auto-opening the app", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "dashboard" }),
    );
    const dueDecision = {
      id: "decision-due-1",
      created: "2026-08-01T03:04:00.000Z",
      sourceClient: "codex",
      project: "decision",
      question: "新的索引策略是否达到预期？",
      selectedAnswer: "先灰度验证",
      rationaleStatus: "captured" as const,
      rationale: "先验证风险更低。",
      context: null,
      outcome: null,
      outcomeReview: null,
      reviewDueDate: "2026-08-01",
      appliedPrincipleIds: [],
      appliedPrinciples: [],
    };
    vi.mocked(api.listDecisions).mockImplementation(async (query) =>
      query.reviewState === "attention" ? [dueDecision] : [],
    );
    const user = userEvent.setup();

    render(<App api={api} />);

    const inbox = await screen.findByRole("region", { name: "首页" });
    expect(within(inbox).getByText("复盘收件箱")).toBeVisible();
    expect(
      await within(inbox).findByText("新的索引策略是否达到预期？"),
    ).toBeVisible();
    expect(
      within(inbox).getByText("到期事项只在这里出现，不会主动弹窗唤醒应用。"),
    ).toBeVisible();
    expect(api.openSurface).not.toHaveBeenCalled();

    await user.click(
      within(inbox).getByRole("button", {
        name: /新的索引策略是否达到预期/u,
      }),
    );
    expect(api.openSurface).toHaveBeenCalledWith("decisions");
  });

  it("searches, filters, and opens decisions from the decision library", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "decisions",
        dashboard: {
          totalDecisions: 28,
          recorded7d: 7,
          reviewAttention: 0,
          recentDecisions: [],
        },
      }),
    );
    const libraryDecision: DecisionLibraryItem = {
      id: "decision-library-1",
      created: "2026-07-30T03:04:00.000Z",
      sourceClient: "codex",
      project: "decision",
      question: "缓存策略应该如何调整？",
      selectedAnswer: "使用可清理的本地缓存",
      rationaleStatus: "captured",
      rationale: "便于恢复，也不会锁死实现。",
      context: "正在收敛本地持久化方案。",
      outcome: null,
      outcomeReview: null,
      reviewDueDate: null,
      appliedPrincipleIds: [],
      appliedPrinciples: [],
    };
    vi.mocked(api.listDecisions).mockImplementation(async (query) => [
      {
        ...libraryDecision,
        ...(query.query.trim().length === 0
          ? {}
          : query.searchMode === "semantic"
            ? { searchMatch: "hybrid" as const }
            : {}),
      },
    ]);
    const acceptedPrinciple = acceptedMethodologyFixture();
    vi.mocked(api.listMethodologies).mockResolvedValue([acceptedPrinciple]);
    vi.mocked(api.updateDecisionAppliedPrinciples).mockResolvedValue([
      {
        id: acceptedPrinciple.id,
        title: acceptedPrinciple.title,
        status: "accepted",
      },
    ]);
    const user = userEvent.setup();

    render(<App api={api} />);

    const page = await screen.findByRole("region", { name: "决策库" });
    expect(
      await within(page).findByText("缓存策略应该如何调整？"),
    ).toBeVisible();
    expect(within(page).getByText("28")).toBeVisible();
    const searchbox = within(page).getByRole("searchbox", {
      name: "搜索决策",
    });
    expect(searchbox).toHaveAttribute(
      "placeholder",
      "按关键词搜索决策",
    );
    const semanticMode = within(page).getByRole("switch", {
      name: "使用语义检索",
    });
    expect(semanticMode).toBeVisible();
    expect(semanticMode).not.toBeChecked();
    expect(searchbox.closest(".decision-search-field")).not.toContainElement(
      semanticMode,
    );
    await user.type(searchbox, "缓存");
    await waitFor(() =>
      expect(api.listDecisions).toHaveBeenLastCalledWith({
        query: "缓存",
        searchMode: "keyword",
        limit: 200,
      }),
    );
    expect(within(page).getByText(/关键词匹配/u)).toBeVisible();
    expect(within(page).queryByText("综合命中")).toBeNull();
    await user.click(within(page).getByRole("button", { name: "清空搜索" }));
    await waitFor(() => expect(searchbox).toHaveValue(""));
    await user.type(searchbox, "缓存");
    await user.click(semanticMode);
    expect(semanticMode).toBeChecked();
    expect(semanticMode).toHaveAccessibleName("使用语义检索");
    expect(searchbox).toHaveAttribute(
      "placeholder",
      "按关键词或含义搜索决策",
    );
    await user.click(within(page).getByRole("button", { name: "未补理由" }));
    await user.selectOptions(
      within(page).getByRole("combobox", { name: "按来源筛选" }),
      "codex",
    );
    await user.selectOptions(
      within(page).getByRole("combobox", { name: "按复盘进度筛选" }),
      "pending_review",
    );

    await waitFor(() =>
      expect(api.listDecisions).toHaveBeenLastCalledWith({
        query: "缓存",
        rationaleStatus: "skipped",
        sourceClient: "codex",
        reviewState: "pending_review",
        searchMode: "semantic",
        limit: 200,
      }),
    );
    expect(await within(page).findByText("综合命中")).toBeVisible();
    expect(within(page).getByText(/语义参与排序/u)).toBeVisible();

    await user.click(within(page).getByText("缓存策略应该如何调整？"));
    const details = within(screen.getByRole("dialog", { name: "决策详情" }));
    expect(details.getByText("使用可清理的本地缓存")).toBeVisible();
    expect(details.getByText("便于恢复，也不会锁死实现。")).toBeVisible();
    expect(details.getByText("正在收敛本地持久化方案。")).toBeVisible();
    expect(details.getByText("尚未记录实际结果。")).toBeVisible();
    expect(
      details.getByText("尚未记录这次决策实际采用了哪些原则。"),
    ).toBeVisible();

    await user.click(details.getByRole("button", { name: "关联原则" }));
    expect(details.getByText(/不会由模型自动判断/u)).toBeVisible();
    await user.click(
      details.getByRole("checkbox", { name: acceptedPrinciple.title }),
    );
    await user.click(details.getByRole("button", { name: "保存关联" }));
    expect(api.updateDecisionAppliedPrinciples).toHaveBeenCalledWith(
      "decision-library-1",
      [acceptedPrinciple.id],
    );
    expect(await details.findByText(acceptedPrinciple.title)).toBeVisible();

    await user.click(details.getByRole("button", { name: "安排日期" }));
    fireEvent.change(details.getByLabelText("复盘日期"), {
      target: { value: "2099-12-31" },
    });
    expect(
      details.getByText("到期后只进入首页收件箱，不会自动弹出窗口。"),
    ).toBeVisible();
    await user.click(details.getByRole("button", { name: "保存日期" }));
    expect(api.updateDecisionReviewDueDate).toHaveBeenCalledWith(
      "decision-library-1",
      "2099-12-31",
    );
    expect(await details.findByText(/12月31日复盘/u)).toBeVisible();

    await user.click(details.getByRole("button", { name: "记录结果" }));
    await user.type(
      details.getByRole("textbox", { name: "结果说明" }),
      "上线一周后运行稳定。",
    );
    await user.click(details.getByRole("button", { name: "保存结果" }));

    expect(api.updateDecisionOutcome).toHaveBeenCalledWith(
      "decision-library-1",
      "上线一周后运行稳定。",
    );
    expect(await details.findByText("上线一周后运行稳定。")).toBeVisible();

    await user.click(details.getByRole("button", { name: "开始复盘" }));
    await user.click(details.getByRole("button", { name: "部分符合" }));
    await user.type(
      details.getByRole("textbox", { name: "复盘经验（可选）" }),
      "方向正确，但低估了迁移成本。",
    );
    await user.click(details.getByRole("button", { name: "保存复盘" }));

    expect(api.updateDecisionReview).toHaveBeenCalledWith(
      "decision-library-1",
      {
        verdict: "mixed",
        lesson: "方向正确，但低估了迁移成本。",
      },
    );
    expect(await details.findByText("部分符合")).toBeVisible();
    expect(details.getByText("方向正确，但低估了迁移成本。")).toBeVisible();
    expect(details.getByText("这条决策现在可作为方法论证据")).toBeVisible();
    await user.click(details.getByRole("button", { name: "用于提炼原则" }));
    expect(api.openSurface).toHaveBeenCalledWith("methodology");
  });

  it("keeps methodology views as stable, mutually exclusive tabs", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "methodology",
      }),
    );
    const user = userEvent.setup();

    render(<App api={api} />);

    const page = await screen.findByRole("region", { name: "方法论" });
    const tabs = within(page).getByRole("tablist", { name: "方法论视图" });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((tab) => tab.textContent?.trim()),
    ).toEqual(["原则", "分析", "图谱", "技能与流程"]);
    expect(within(tabs).getByRole("tab", { name: "原则" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    const principlesTab = within(tabs).getByRole("tab", { name: "原则" });
    principlesTab.focus();
    fireEvent.keyDown(principlesTab, { key: "ArrowRight" });
    const analysisTab = within(tabs).getByRole("tab", { name: "分析" });
    expect(analysisTab).toHaveAttribute("aria-selected", "true");
    expect(analysisTab).toHaveFocus();
    expect(within(tabs).getAllByRole("tab")).toHaveLength(4);
    expect(within(page).queryByRole("button", { name: "返回记录" })).toBeNull();

    await user.click(within(tabs).getByRole("tab", { name: "图谱" }));
    expect(within(tabs).getByRole("tab", { name: "图谱" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(tabs).getAllByRole("tab")).toHaveLength(4);
  });

  it("surfaces reviewed principle usage for explicit human validation", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "methodology" }),
    );
    const principle = acceptedMethodologyFixture();
    const validationItem: MethodologyValidationItem = {
      principleId: principle.id,
      title: principle.title,
      principle: principle.principle,
      newReviewedCount: 2,
      favorableCount: 1,
      attentionCount: 1,
      unclearCount: 0,
      newestReviewedAt: "2026-08-08T08:00:00.000Z",
      revisionDraftId: null,
      decisions: [
        {
          id: "decision-validation-1",
          project: "Decision",
          question: "扩大范围前是否重新核对停止条件？",
          selectedAnswer: "先补齐停止条件",
          verdict: "mixed",
          lesson: "原则仍适用，但停止条件需要写得更明确。",
          reviewedAt: "2026-08-08T08:00:00.000Z",
        },
      ],
    };
    let acknowledged = false;
    vi.mocked(api.listMethodologies).mockResolvedValue([principle]);
    vi.mocked(api.getMethodologyValidationInbox).mockImplementation(async () =>
      acknowledged ? [] : [validationItem],
    );
    vi.mocked(api.acknowledgeMethodologyValidation).mockImplementation(
      async () => {
        acknowledged = true;
        return {
          ...principle,
          usageValidation: {
            reviewedAt: validationItem.newestReviewedAt,
            decisionId: validationItem.decisions[0]!.id,
            validatedAt: "2026-08-08T09:00:00.000Z",
          },
        };
      },
    );
    const user = userEvent.setup();

    render(<App api={api} />);

    const page = await screen.findByRole("region", { name: "方法论" });
    await user.click(
      await within(page).findByRole("button", { name: /方法论工作箱/u }),
    );
    await user.click(
      within(screen.getByRole("dialog", { name: "方法论工作箱" })).getByRole(
        "button",
        { name: "原则复验 1" },
      ),
    );
    const dialog = within(screen.getByRole("dialog", { name: "原则复验" }));
    expect(dialog.getByText("只处理采用后的新增复盘")).toBeVisible();
    expect(dialog.getByText(principle.title)).toBeVisible();
    expect(dialog.getByText("扩大范围前是否重新核对停止条件？")).toBeVisible();
    expect(dialog.getByText("有偏差")).toBeVisible();
    expect(dialog.getByText(/不会自动提高可信度或改写原则/u)).toBeVisible();

    await user.click(dialog.getByRole("button", { name: "确认仍适用" }));
    await waitFor(() =>
      expect(api.acknowledgeMethodologyValidation).toHaveBeenCalledWith(
        principle.id,
      ),
    );
    expect(await dialog.findByText("没有待复验原则")).toBeVisible();
    expect(
      await within(page).findByText(/原则内容与可信度未改变/u),
    ).toBeVisible();
  });

  it("shows actual principle usage as a non-causal review distribution", async () => {
    const { api, emit } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "methodology" }),
    );
    const principle = acceptedMethodologyFixture();
    vi.mocked(api.listMethodologies).mockResolvedValue([principle]);
    vi.mocked(api.getMethodologyUsage).mockResolvedValue({
      principleId: principle.id,
      linkedDecisionCount: 3,
      outcomeRecordedCount: 2,
      reviewedCount: 1,
      pendingOutcomeCount: 1,
      pendingReviewCount: 1,
      favorableCount: 1,
      mixedCount: 0,
      attentionCount: 0,
      unclearCount: 0,
      decisions: [
        {
          id: "decision-usage-1",
          created: "2026-08-03T08:00:00.000Z",
          project: "Decision",
          question: "是否先验证关键边界？",
          selectedAnswer: "先小步验证",
          outcome: "运行符合预期。",
          outcomeReview: {
            verdict: "as_expected",
            lesson: "边界判断有效。",
            reviewedAt: "2026-08-04T08:00:00.000Z",
          },
        },
        {
          id: "decision-usage-2",
          created: "2026-08-02T08:00:00.000Z",
          project: "ClarAI",
          question: "上线前是否需要先验证兼容边界？",
          selectedAnswer: "先在小范围验证",
          outcome: null,
          outcomeReview: null,
        },
        {
          id: "decision-usage-3",
          created: "2026-08-01T08:00:00.000Z",
          project: "Decision",
          question: "是否先验证回退路径？",
          selectedAnswer: "先验证",
          outcome: "回退路径可用。",
          outcomeReview: null,
        },
      ],
      nextPendingDecision: {
        id: "decision-usage-2",
        created: "2026-08-02T08:00:00.000Z",
        project: "ClarAI",
        question: "上线前是否需要先验证兼容边界？",
        selectedAnswer: "先在小范围验证",
        outcome: null,
        outcomeReview: null,
      },
    });
    const user = userEvent.setup();

    render(<App api={api} />);

    const page = await screen.findByRole("region", { name: "方法论" });
    await user.click(await within(page).findByText(principle.title));
    const detail = within(
      await screen.findByRole("dialog", { name: "方法论详情" }),
    );
    const usage = detail.getByRole("region", { name: "实际采用情况" });
    expect(within(usage).getByText("采用后的复盘分布")).toBeVisible();
    expect(within(usage).getByText("3 次")).toBeVisible();
    expect(
      within(usage).getByText(/不能单独证明结果由这条原则造成/u),
    ).toBeVisible();
    expect(within(usage).getByText("2 条仍待验证")).toBeVisible();
    await user.click(within(usage).getByText("查看 3 条采用记录"));
    expect(within(usage).getByText("是否先验证关键边界？")).toBeVisible();
    expect(
      within(usage).getByRole("group", { name: "采用记录状态" }),
    ).toBeVisible();
    await user.selectOptions(
      within(usage).getByRole("combobox", { name: "按项目筛选采用记录" }),
      "ClarAI",
    );
    await user.click(within(usage).getByRole("button", { name: "待结果 1" }));
    expect(
      within(usage).getByText("上线前是否需要先验证兼容边界？"),
    ).toBeVisible();
    expect(within(usage).queryByText("是否先验证关键边界？")).toBeNull();
    await user.click(
      within(usage).getByRole("button", {
        name: /上线前是否需要先验证兼容边界/u,
      }),
    );
    expect(api.openSurface).toHaveBeenCalledWith("decisions");
    vi.mocked(api.listDecisions).mockResolvedValue([
      {
        id: "decision-usage-2",
        created: "2026-08-02T08:00:00.000Z",
        sourceClient: "codex",
        project: "ClarAI",
        question: "上线前是否需要先验证兼容边界？",
        selectedAnswer: "先在小范围验证",
        rationaleStatus: "captured",
        rationale: "需要确认兼容边界。",
        context: null,
        outcome: null,
        outcomeReview: null,
        reviewDueDate: null,
        appliedPrincipleIds: [principle.id],
        appliedPrinciples: [
          {
            id: principle.id,
            title: principle.title,
            status: "accepted",
          },
        ],
      },
    ]);
    emit(
      rationaleSnapshot({
        current: null,
        primarySurface: "decisions",
        dashboard: {
          totalDecisions: 1,
          recorded7d: 1,
          reviewAttention: 1,
          recentDecisions: [],
        },
      }),
    );
    await waitFor(() =>
      expect(api.listDecisions).toHaveBeenCalledWith({
        query: "",
        decisionId: "decision-usage-2",
        limit: 1,
      }),
    );
    expect(
      within(await screen.findByRole("dialog", { name: "决策详情" })).getByText(
        "上线前是否需要先验证兼容边界？",
      ),
    ).toBeVisible();
    expect(api.getMethodologyUsage).toHaveBeenCalledWith(principle.id);
  });

  it("turns reviewed usage into an explicit revision candidate with comparison and recovery", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "methodology" }),
    );
    const sourceEvidence: DecisionLibraryItem = {
      id: "decision-source-1",
      created: "2026-08-01T08:00:00.000Z",
      sourceClient: "codex",
      project: "Decision",
      question: "是否先验证可回退路径？",
      selectedAnswer: "先验证",
      rationaleStatus: "captured",
      rationale: "降低不可逆风险。",
      context: null,
      outcome: "回退路径可用。",
      outcomeReview: {
        verdict: "as_expected",
        lesson: "小步验证有效。",
        reviewedAt: "2026-08-02T08:00:00.000Z",
      },
      reviewDueDate: null,
      appliedPrincipleIds: [],
      appliedPrinciples: [],
    };
    const newEvidence: DecisionLibraryItem = {
      ...sourceEvidence,
      id: "decision-usage-reviewed-2",
      created: "2026-08-04T08:00:00.000Z",
      project: "ClarAI",
      question: "扩大范围前是否需要新的停止条件？",
      outcome: "缺少停止条件导致验证范围过大。",
      outcomeReview: {
        verdict: "mixed",
        lesson: "进入不可逆步骤前应重新核对证据。",
        reviewedAt: "2026-08-05T08:00:00.000Z",
      },
    };
    const original = acceptedMethodologyFixture({
      sourceDecisionIds: [sourceEvidence.id],
      sourceDecisions: [sourceEvidence],
      quality: methodologyQuality({ evidenceCount: 1 }),
    });
    const candidate: MethodologyItem = {
      ...original,
      id: "principle-revision-1",
      origin: "principle_revision",
      status: "candidate",
      confirmedAt: null,
      title: "先验证边界，并在不可逆步骤前停下",
      principle: "先小步验证；进入不可逆步骤前重新核对证据。",
      sourceDecisionIds: [newEvidence.id, sourceEvidence.id],
      sourceDecisions: [newEvidence, sourceEvidence],
      sourcePrincipleIds: [original.id],
      sourcePrinciples: [
        {
          id: original.id,
          status: "accepted",
          title: original.title,
          principle: original.principle,
          appliesWhen: original.appliesWhen,
          caution: original.caution,
        },
      ],
      generation: {
        requestId: "methodology-revision:1",
        profileId: "manual-principle-revision",
        provider: "人工修订",
        model: "不调用模型",
      },
      quality: methodologyQuality({
        evidenceCount: 2,
        recommendedConfidence: "medium",
        flags: [],
      }),
    };
    const applied: MethodologyItem = {
      ...original,
      updatedAt: "2026-08-06T08:00:00.000Z",
      title: candidate.title,
      principle: candidate.principle,
      caution: "不可逆步骤前必须重新核对证据。",
      evidenceSummary: candidate.evidenceSummary,
      sourceDecisionIds: candidate.sourceDecisionIds,
      sourceDecisions: candidate.sourceDecisions,
      generation: candidate.generation,
      quality: candidate.quality,
    };
    let revisionApplied = false;
    vi.mocked(api.listMethodologies).mockResolvedValue([original]);
    vi.mocked(api.getMethodologyUsage).mockResolvedValue({
      principleId: original.id,
      linkedDecisionCount: 1,
      outcomeRecordedCount: 1,
      reviewedCount: 1,
      pendingOutcomeCount: 0,
      pendingReviewCount: 0,
      favorableCount: 0,
      mixedCount: 1,
      attentionCount: 0,
      unclearCount: 0,
      decisions: [
        {
          id: newEvidence.id,
          created: newEvidence.created,
          project: newEvidence.project,
          question: newEvidence.question,
          selectedAnswer: newEvidence.selectedAnswer,
          outcome: newEvidence.outcome,
          outcomeReview: newEvidence.outcomeReview,
        },
      ],
      nextPendingDecision: null,
    });
    vi.mocked(api.createMethodologyRevisionDraft).mockImplementation(
      async (_id, input) => ({
        ...candidate,
        ...input,
        sourceDecisionIds: input.sourceDecisionIds,
      }),
    );
    vi.mocked(api.setMethodologyStatus).mockImplementation(async () => {
      revisionApplied = true;
      return applied;
    });
    vi.mocked(api.listMethodologyVersions).mockImplementation(async () =>
      revisionApplied
        ? [
            {
              version: 1,
              capturedAt: "2026-08-06T08:00:00.000Z",
              reason: "revision_applied",
              snapshot: {
                updatedAt: original.updatedAt,
                title: original.title,
                principle: original.principle,
                appliesWhen: original.appliesWhen,
                caution: original.caution,
                evidenceSummary: original.evidenceSummary,
                sourceDecisionIds: original.sourceDecisionIds,
                confidence: original.confidence,
                provider: original.generation.provider,
                model: original.generation.model,
              },
            },
          ]
        : [],
    );
    vi.mocked(api.restoreMethodologyVersion).mockResolvedValue(original);
    const user = userEvent.setup();

    render(<App api={api} />);

    const page = await screen.findByRole("region", { name: "方法论" });
    await user.click(await within(page).findByText(original.title));
    let detail = within(
      await screen.findByRole("dialog", { name: "方法论详情" }),
    );
    expect(detail.getByText("1 条采用后新复盘可用于修订")).toBeVisible();
    await user.click(detail.getByRole("button", { name: "建立修订候选" }));

    let editor = within(
      screen.getByRole("dialog", { name: "建立原则修订候选" }),
    );
    expect(editor.getByText(/原原则暂不改变/u)).toBeVisible();
    expect(
      editor.getByRole("button", { name: /采用后新复盘.*扩大范围前/u }),
    ).toHaveAttribute("aria-pressed", "true");
    const caution = editor.getByRole("textbox", { name: "注意事项" });
    await user.clear(caution);
    await user.type(caution, "不可逆步骤前必须重新核对证据。");
    await user.click(editor.getByRole("button", { name: "返回详情" }));
    await waitFor(() =>
      expect(api.saveManualFormDraft).toHaveBeenLastCalledWith({
        key: "methodology_revision",
        sourcePrincipleId: original.id,
        sourceUpdatedAt: original.updatedAt,
        sourceSnapshot: {
          title: original.title,
          principle: original.principle,
          appliesWhen: original.appliesWhen,
          caution: original.caution,
          evidenceSummary: original.evidenceSummary,
          sourceDecisionIds: [sourceEvidence.id],
        },
        input: expect.objectContaining({
          caution: "不可逆步骤前必须重新核对证据。",
          sourceDecisionIds: [newEvidence.id, sourceEvidence.id],
        }),
      }),
    );
    detail = within(
      await screen.findByRole("dialog", { name: "方法论详情" }),
    );
    await user.click(detail.getByRole("button", { name: "建立修订候选" }));
    editor = within(
      await screen.findByRole("dialog", { name: "建立原则修订候选" }),
    );
    expect(editor.getByText(/已恢复/u)).toBeVisible();
    expect(editor.getByRole("textbox", { name: "注意事项" })).toHaveValue(
      "不可逆步骤前必须重新核对证据。",
    );
    await user.click(editor.getByRole("button", { name: "保存为修订候选" }));
    expect(api.createMethodologyRevisionDraft).toHaveBeenCalledWith(
      original.id,
      expect.objectContaining({
        caution: "不可逆步骤前必须重新核对证据。",
        sourceDecisionIds: [newEvidence.id, sourceEvidence.id],
      }),
    );

    detail = within(
      await screen.findByRole("dialog", { name: "审核方法论候选" }),
    );
    expect(detail.getByText("原原则仍保持已采纳")).toBeVisible();
    expect(detail.getByText("当前版本")).toBeVisible();
    expect(detail.getByText("修订草案")).toBeVisible();
    await user.click(detail.getByRole("button", { name: "检查后应用修订" }));
    expect(detail.getByText(/历史决策关联保持不变/u)).toBeVisible();
    await user.click(detail.getByRole("button", { name: "确认应用修订" }));
    expect(api.setMethodologyStatus).toHaveBeenCalledWith(
      candidate.id,
      "accepted",
      true,
    );

    detail = within(await screen.findByRole("dialog", { name: "方法论详情" }));
    await user.click(detail.getByText("原则版本"));
    await user.click(detail.getByRole("button", { name: /版本 1/u }));
    expect(detail.getByText("应用修订前")).toBeVisible();
    await user.click(detail.getByRole("button", { name: "恢复此版本" }));
    await user.click(detail.getByRole("button", { name: "确认恢复" }));
    expect(api.restoreMethodologyVersion).toHaveBeenCalledWith(original.id, 1);
  });

  it("keeps a stale revision draft inert when its source version has changed", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "methodology" }),
    );
    const original = acceptedMethodologyFixture({
      updatedAt: "2026-08-08T10:00:00.000Z",
    });
    vi.mocked(api.listManualFormDrafts).mockResolvedValue([
      {
        key: "methodology_revision",
        sourcePrincipleId: original.id,
        sourceUpdatedAt: "2026-08-07T10:00:00.000Z",
        updatedAt: "2026-08-08T09:00:00.000Z",
        input: {
          title: "旧修订",
          principle: "旧原则内容",
          appliesWhen: "旧适用条件",
          caution: "旧注意事项",
          evidenceSummary: "旧证据摘要",
          sourceDecisionIds: [],
        },
      },
    ]);
    vi.mocked(api.listMethodologies).mockResolvedValue([original]);
    const user = userEvent.setup();

    render(<App api={api} />);

    const page = await screen.findByRole("region", { name: "方法论" });
    await user.click(
      await within(page).findByRole("button", { name: "继续修订" }),
    );
    expect(
      await within(page).findByText(/来源原则内容已更新/u),
    ).toBeVisible();
    expect(
      screen.queryByRole("dialog", { name: "建立原则修订候选" }),
    ).not.toBeInTheDocument();
    expect(api.getMethodologyUsage).not.toHaveBeenCalled();
    expect(api.createMethodologyRevisionDraft).not.toHaveBeenCalled();
    await user.click(within(page).getByRole("button", { name: "丢弃草稿" }));
    await waitFor(() =>
      expect(api.deleteManualFormDraft).toHaveBeenCalledWith(
        "methodology_revision",
      ),
    );
    expect(
      within(page).queryByRole("button", { name: "继续修订" }),
    ).not.toBeInTheDocument();
  });

  it("rebases a stale revision draft field by field without changing formal methodology", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "methodology" }),
    );
    const sourceEvidence: DecisionLibraryItem = {
      id: "decision-rebase-source",
      created: "2026-08-01T08:00:00.000Z",
      sourceClient: "codex",
      project: "Decision",
      question: "是否先验证边界？",
      selectedAnswer: "先验证",
      rationaleStatus: "captured",
      rationale: "保留回退路径。",
      context: null,
      outcome: "验证有效。",
      outcomeReview: {
        verdict: "as_expected",
        lesson: "先验证能降低返工。",
        reviewedAt: "2026-08-02T08:00:00.000Z",
      },
      reviewDueDate: null,
      appliedPrincipleIds: [],
      appliedPrinciples: [],
    };
    const newEvidence: DecisionLibraryItem = {
      ...sourceEvidence,
      id: "decision-rebase-new",
      created: "2026-08-06T08:00:00.000Z",
      project: "ClarAI",
      question: "扩大范围前是否需要重新检查？",
      outcome: "重新检查后发现停止条件不足。",
      outcomeReview: {
        verdict: "mixed",
        lesson: "扩大范围前补充停止条件。",
        reviewedAt: "2026-08-07T08:00:00.000Z",
      },
    };
    const baseline = acceptedMethodologyFixture({
      updatedAt: "2026-08-05T10:00:00.000Z",
      title: "先验证边界，再扩大投入",
      sourceDecisionIds: [sourceEvidence.id],
      sourceDecisions: [sourceEvidence],
    });
    const current = acceptedMethodologyFixture({
      ...baseline,
      updatedAt: "2026-08-08T10:00:00.000Z",
      title: "先确认停止条件，再扩大投入",
    });
    vi.mocked(api.listManualFormDrafts).mockResolvedValue([
      {
        key: "methodology_revision",
        sourcePrincipleId: current.id,
        sourceUpdatedAt: baseline.updatedAt,
        sourceSnapshot: {
          title: baseline.title,
          principle: baseline.principle,
          appliesWhen: baseline.appliesWhen,
          caution: baseline.caution,
          evidenceSummary: baseline.evidenceSummary,
          sourceDecisionIds: [sourceEvidence.id],
        },
        updatedAt: "2026-08-08T09:00:00.000Z",
        input: {
          title: "先验证关键风险，再扩大投入",
          principle: "先验证关键风险和回退路径，再扩大不可逆投入。",
          appliesWhen: baseline.appliesWhen,
          caution: baseline.caution,
          evidenceSummary: baseline.evidenceSummary,
          sourceDecisionIds: [
            newEvidence.id,
            sourceEvidence.id,
            "decision-no-longer-available",
          ],
        },
      },
    ]);
    vi.mocked(api.listMethodologies).mockResolvedValue([current]);
    vi.mocked(api.getMethodologyUsage).mockResolvedValue({
      principleId: current.id,
      linkedDecisionCount: 1,
      outcomeRecordedCount: 1,
      reviewedCount: 1,
      pendingOutcomeCount: 0,
      pendingReviewCount: 0,
      favorableCount: 0,
      mixedCount: 1,
      attentionCount: 0,
      unclearCount: 0,
      decisions: [
        {
          id: newEvidence.id,
          created: newEvidence.created,
          project: newEvidence.project,
          question: newEvidence.question,
          selectedAnswer: newEvidence.selectedAnswer,
          outcome: newEvidence.outcome,
          outcomeReview: newEvidence.outcomeReview,
        },
      ],
      nextPendingDecision: null,
    });
    const user = userEvent.setup();

    render(<App api={api} />);

    const page = await screen.findByRole("region", { name: "方法论" });
    await user.click(
      await within(page).findByRole("button", { name: "继续修订" }),
    );
    const rebase = within(
      await screen.findByRole("dialog", { name: "迁移未完成修订" }),
    );
    expect(rebase.getByText("1 项待选择")).toBeVisible();
    expect(rebase.getByText(/移除 1 条失效证据/u)).toBeVisible();
    const titleDiff = within(
      rebase.getByRole("region", { name: "标题差异" }),
    );
    expect(titleDiff.getByText(baseline.title)).toBeVisible();
    expect(titleDiff.getByText(current.title)).toBeVisible();
    expect(titleDiff.getByText("先验证关键风险，再扩大投入")).toBeVisible();
    expect(
      rebase.getByRole("button", { name: "迁移并继续编辑" }),
    ).toBeDisabled();
    await user.click(
      titleDiff.getByRole("button", { name: /未完成草稿/u }),
    );
    expect(rebase.getByText("选择已齐全")).toBeVisible();
    await user.click(
      rebase.getByRole("button", { name: "迁移并继续编辑" }),
    );

    await waitFor(() =>
      expect(api.saveManualFormDraft).toHaveBeenCalledWith({
        key: "methodology_revision",
        sourcePrincipleId: current.id,
        sourceUpdatedAt: current.updatedAt,
        sourceSnapshot: {
          title: current.title,
          principle: current.principle,
          appliesWhen: current.appliesWhen,
          caution: current.caution,
          evidenceSummary: current.evidenceSummary,
          sourceDecisionIds: [sourceEvidence.id],
        },
        input: {
          title: "先验证关键风险，再扩大投入",
          principle: "先验证关键风险和回退路径，再扩大不可逆投入。",
          appliesWhen: current.appliesWhen,
          caution: current.caution,
          evidenceSummary: current.evidenceSummary,
          sourceDecisionIds: [newEvidence.id, sourceEvidence.id],
        },
      }),
    );
    const editor = within(
      await screen.findByRole("dialog", { name: "建立原则修订候选" }),
    );
    expect(editor.getByRole("textbox", { name: "修订标题" })).toHaveValue(
      "先验证关键风险，再扩大投入",
    );
    expect(editor.getByRole("textbox", { name: "修订后的原则" })).toHaveValue(
      "先验证关键风险和回退路径，再扩大不可逆投入。",
    );
    expect(editor.getByText(/移除 1 条不再可用的证据/u)).toBeVisible();
    expect(api.createMethodologyRevisionDraft).not.toHaveBeenCalled();
    expect(api.reviseMethodology).not.toHaveBeenCalled();
  });

  it("turns an empty methodology workspace into an actionable acquisition path", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "methodology",
      }),
    );
    const user = userEvent.setup();

    render(<App api={api} />);

    const page = await screen.findByRole("region", { name: "方法论" });
    expect(
      await within(page).findByText("原则可以人工建立，也可以从复盘证据提炼"),
    ).toBeVisible();
    expect(within(page).getByText("记录实际结果并完成复盘")).toBeVisible();
    expect(within(page).getByText("从复盘证据生成原则候选")).toBeVisible();
    expect(within(page).getByText("审核并采纳可信原则")).toBeVisible();

    await user.click(
      within(page).getByRole("button", { name: "去积累复盘证据" }),
    );
    expect(api.openSurface).toHaveBeenCalledWith("decisions");

    const tabs = within(page).getByRole("tablist", { name: "方法论视图" });
    await user.click(within(tabs).getByRole("tab", { name: "图谱" }));
    await user.click(
      within(page).getByRole("button", { name: "去生成并采纳原则" }),
    );
    expect(within(tabs).getByRole("tab", { name: "原则" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("keeps a data-driven next step visible when only a few candidates exist", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "methodology" }),
    );
    const candidate = acceptedMethodologyFixture({
      id: "principle-candidate-1",
      status: "candidate",
      confirmedAt: null,
      title: "先验证真实运行边界",
    });
    vi.mocked(api.listMethodologies).mockResolvedValue([candidate]);
    vi.mocked(api.getMethodologyBuildProgress).mockResolvedValue({
      decisions: {
        total: 36,
        pendingOutcome: 12,
        pendingReview: 6,
        reviewed: 18,
      },
      principles: { candidate: 1, accepted: 3, retired: 0, dismissed: 2 },
      practiceAssets: { candidate: 1, accepted: 2, dismissed: 0 },
    });
    const user = userEvent.setup();

    render(<App api={api} />);

    const guide = await screen.findByRole("region", {
      name: "方法论建设进度",
    });
    expect(
      within(guide).getByText("把真实决策逐步变成可复用方法"),
    ).toBeVisible();
    expect(
      (await within(guide).findByText("已记录决策")).parentElement,
    ).toHaveTextContent("36");
    expect(within(guide).getByText("完整复盘").parentElement).toHaveTextContent(
      "18",
    );
    expect(
      within(guide).getByText("已采纳原则").parentElement,
    ).toHaveTextContent("3");
    expect(
      within(guide).getByText("已采纳实践").parentElement,
    ).toHaveTextContent("2");
    const path = within(guide).getByRole("list", {
      name: "方法论建设路径",
    });
    expect(within(path).getByText("18 条可用")).toBeVisible();
    expect(within(path).getByText("3 条已采纳")).toBeVisible();
    expect(within(path).getByText("2 条已采纳")).toBeVisible();

    await user.click(within(guide).getByRole("button", { name: "审核第一条" }));
    expect(
      await screen.findByRole("dialog", { name: "审核方法论候选" }),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "关闭审核方法论候选" }),
    );

    await user.click(within(guide).getByRole("button", { name: "继续提炼" }));
    expect(
      await screen.findByRole("dialog", { name: "选择复盘证据" }),
    ).toBeVisible();
  });

  it("turns reviewed decisions into explainable, preselected extraction suggestions", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "methodology" }),
    );
    const reviewed = [
      {
        id: "decision-suggestion-1",
        created: "2026-08-01T03:04:00.000Z",
        sourceClient: "codex",
        project: "Decision",
        question: "页面改造应该一次完成还是分步验证？",
        selectedAnswer: "先做可回退的小步改动",
        rationaleStatus: "captured" as const,
        rationale: "分步更容易验证和回退。",
        context: null,
        outcome: "小步上线后没有出现大范围回归。",
        outcomeReview: {
          verdict: "as_expected" as const,
          lesson: "可逆的小步提交降低了返工成本。",
          reviewedAt: "2026-08-03T03:04:00.000Z",
        },
        reviewDueDate: null,
        appliedPrincipleIds: [],
        appliedPrinciples: [],
      },
      {
        id: "decision-suggestion-2",
        created: "2026-08-02T03:04:00.000Z",
        sourceClient: "claude-code",
        project: "ClarAI",
        question: "功能重构应该一次上线还是先分步验证？",
        selectedAnswer: "先上线可回退的小范围改动",
        rationaleStatus: "captured" as const,
        rationale: "需要真实运行反馈。",
        context: null,
        outcome: "验证完成后再扩大范围，返工更少。",
        outcomeReview: {
          verdict: "better" as const,
          lesson: "小范围验证避免了错误方向扩散。",
          reviewedAt: "2026-08-04T03:04:00.000Z",
        },
        reviewDueDate: null,
        appliedPrincipleIds: [],
        appliedPrinciples: [],
      },
    ];
    vi.mocked(api.listDecisions).mockResolvedValue(reviewed);
    vi.mocked(api.getMethodologySuggestions).mockResolvedValue([
      {
        id: "suggestion:decision-suggestion-1:decision-suggestion-2",
        title: "跨 2 个项目 · 相近复盘",
        summary: "2 条相近复盘结果方向一致，可以提炼候选并继续验证。",
        readiness: "ready",
        direction: "favorable",
        evidenceCount: 2,
        projectCount: 2,
        sourceDecisionIds: reviewed.map((item) => item.id),
        sources: reviewed.map((item) => ({
          id: item.id,
          project: item.project,
          question: item.question,
          selectedAnswer: item.selectedAnswer,
          outcomeVerdict: item.outcomeReview.verdict,
          outcomeLesson: item.outcomeReview.lesson,
          reviewedAt: item.outcomeReview.reviewedAt,
        })),
      },
    ]);
    const user = userEvent.setup();

    render(<App api={api} />);

    const page = await screen.findByRole("region", { name: "方法论" });
    const inbox = await within(page).findByRole("region", {
      name: "方法论提炼建议",
    });
    expect(within(inbox).getByText("已有复盘可以开始提炼")).toBeVisible();
    expect(within(inbox).getByText("可提炼")).toBeVisible();
    expect(within(inbox).getByText(/2 条证据 · 2 个项目/u)).toBeVisible();

    await user.click(
      within(inbox).getByRole("button", { name: /跨 2 个项目 · 相近复盘/u }),
    );
    const chooser = within(
      screen.getByRole("dialog", { name: "选择复盘证据" }),
    );
    expect(await chooser.findByText("已选 2 / 5")).toBeVisible();
    const checkboxes = await chooser.findAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
    for (const checkbox of checkboxes) expect(checkbox).toBeChecked();
    expect(
      chooser.getByRole("button", { name: "模型提炼 · 1 次" }),
    ).toBeEnabled();

    vi.mocked(api.generateMethodology).mockResolvedValue({} as MethodologyItem);
    await user.click(chooser.getByRole("button", { name: "批量生成 1 条" }));
    const batchDialog = within(
      screen.getByRole("dialog", { name: "批量提炼方法论" }),
    );
    expect(batchDialog.getByText(/不会自动采纳/u)).toBeVisible();
    await user.click(
      batchDialog.getByRole("button", { name: "生成 1 条候选" }),
    );
    await waitFor(() =>
      expect(api.generateMethodology).toHaveBeenCalledWith(
        reviewed.map((item) => item.id),
      ),
    );
    expect(
      await within(page).findByText("已生成 1 条候选，等待逐条审核。"),
    ).toBeVisible();
  });

  it("keeps review material discoverable and lets a deferred group be restored", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "methodology" }),
    );
    const suggestion: MethodologySuggestion = {
      id: "suggestion:decision-material-1",
      title: "先验证再扩大",
      summary: "单条完整复盘，适合先作为探索性素材核对。",
      readiness: "exploratory",
      direction: "favorable",
      evidenceCount: 1,
      projectCount: 1,
      sourceDecisionIds: ["decision-material-1"],
      sources: [
        {
          id: "decision-material-1",
          project: "Decision",
          question: "功能应该直接铺开还是先验证？",
          selectedAnswer: "先验证",
          outcomeVerdict: "as_expected",
          outcomeLesson: "小范围验证减少了返工。",
          reviewedAt: "2026-08-08T08:00:00.000Z",
        },
      ],
    };
    let deferred = false;
    vi.mocked(api.getMethodologySuggestions).mockImplementation(async () =>
      deferred ? [] : [suggestion],
    );
    vi.mocked(api.getDeferredMethodologySuggestions).mockImplementation(
      async () => (deferred ? [suggestion] : []),
    );
    vi.mocked(api.deferMethodologySuggestion).mockImplementation(async () => {
      deferred = true;
    });
    vi.mocked(api.restoreMethodologySuggestion).mockImplementation(async () => {
      deferred = false;
    });
    const user = userEvent.setup();

    render(<App api={api} />);

    const page = await screen.findByRole("region", { name: "方法论" });
    await user.click(
      await within(page).findByRole("button", { name: /方法论工作箱/u }),
    );
    await user.click(
      within(screen.getByRole("dialog", { name: "方法论工作箱" })).getByRole(
        "button",
        { name: "复盘素材 1" },
      ),
    );
    let dialog = within(screen.getByRole("dialog", { name: "复盘素材" }));
    expect(dialog.getByText("不会自动生成原则")).toBeVisible();
    expect(dialog.getByText("功能应该直接铺开还是先验证？")).toBeVisible();

    await user.click(dialog.getByRole("button", { name: "稍后再看" }));
    await waitFor(() =>
      expect(api.deferMethodologySuggestion).toHaveBeenCalledWith(
        suggestion.id,
      ),
    );
    dialog = within(screen.getByRole("dialog", { name: "复盘素材" }));
    expect(
      await dialog.findByRole("button", { name: "恢复到可提炼" }),
    ).toBeVisible();

    await user.click(dialog.getByRole("button", { name: "恢复到可提炼" }));
    await waitFor(() =>
      expect(api.restoreMethodologySuggestion).toHaveBeenCalledWith(
        suggestion.id,
      ),
    );
    dialog = within(screen.getByRole("dialog", { name: "复盘素材" }));
    expect(
      await dialog.findByRole("button", { name: "核对证据并提炼" }),
    ).toBeVisible();
  });

  it("turns selected review evidence into a manual candidate without a model call", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "methodology" }),
    );
    const reviewed: DecisionLibraryItem[] = [
      {
        id: "decision-manual-evidence-1",
        created: "2026-08-01T03:04:00.000Z",
        sourceClient: "codex",
        project: "Decision",
        question: "功能应该直接铺开还是先验证？",
        selectedAnswer: "先验证可回退的小范围",
        rationaleStatus: "captured",
        rationale: "需要真实反馈。",
        context: null,
        outcome: "小范围验证后没有出现大面积返工。",
        outcomeReview: {
          verdict: "as_expected",
          lesson: "先验证降低了返工范围。",
          reviewedAt: "2026-08-03T03:04:00.000Z",
        },
        reviewDueDate: null,
        appliedPrincipleIds: [],
        appliedPrinciples: [],
      },
      {
        id: "decision-manual-evidence-2",
        created: "2026-08-02T03:04:00.000Z",
        sourceClient: "claude-code",
        project: "ClarAI",
        question: "重构应该一次完成还是先局部验证？",
        selectedAnswer: "先做局部验证",
        rationaleStatus: "captured",
        rationale: "避免错误方向扩散。",
        context: null,
        outcome: "验证通过后扩大范围，切换过程稳定。",
        outcomeReview: {
          verdict: "better",
          lesson: "局部验证避免了错误方向扩散。",
          reviewedAt: "2026-08-04T03:04:00.000Z",
        },
        reviewDueDate: null,
        appliedPrincipleIds: [],
        appliedPrinciples: [],
      },
    ];
    vi.mocked(api.listDecisions).mockResolvedValue(reviewed);
    const created = acceptedMethodologyFixture({
      id: "principle-manual-evidence",
      origin: "manual_entry",
      status: "candidate",
      confirmedAt: null,
      title: "先验证再扩大",
      principle: "先验证可回退的小范围，再扩大实施范围。",
      appliesWhen: "方案仍有关键未知项时。",
      caution: "验证成本超过潜在损失时重新评估。",
      evidenceSummary: "证据 1 与证据 2 都支持先验证。",
      sourceDecisionIds: reviewed.map((item) => item.id),
      sourceDecisions: reviewed,
      generation: {
        requestId: "methodology-manual-evidence:1",
        profileId: "manual-evidence-methodology",
        provider: "人工整理",
        model: "不调用模型",
      },
    });
    vi.mocked(api.createManualMethodologyFromEvidence).mockResolvedValue(
      created,
    );
    const user = userEvent.setup();

    render(<App api={api} />);

    const page = await screen.findByRole("region", { name: "方法论" });
    await user.click(
      await within(page).findByRole("button", { name: "新建原则" }),
    );
    let dialog = within(screen.getByRole("dialog", { name: "新建原则" }));
    await user.click(dialog.getByRole("button", { name: /从复盘提炼/u }));
    dialog = within(
      await screen.findByRole("dialog", { name: "选择复盘证据" }),
    );
    const evidence = await dialog.findAllByRole("checkbox");
    expect(evidence).toHaveLength(2);
    for (const checkbox of evidence) await user.click(checkbox);
    expect(
      dialog.getByRole("button", { name: "人工整理 · 0 次" }),
    ).toBeEnabled();
    expect(
      dialog.getByRole("button", { name: "模型提炼 · 1 次" }),
    ).toBeEnabled();
    await user.click(dialog.getByRole("button", { name: "人工整理 · 0 次" }));

    dialog = within(
      await screen.findByRole("dialog", { name: "人工整理原则候选" }),
    );
    expect(dialog.getByText("0 次模型调用")).toBeVisible();
    expect(dialog.getByText("证据 1")).toBeVisible();
    expect(dialog.getByText("证据 2")).toBeVisible();
    await user.type(dialog.getByLabelText("候选标题"), created.title);
    await user.type(dialog.getByLabelText("原则"), created.principle);
    await user.type(dialog.getByLabelText("适用条件"), created.appliesWhen);
    await user.type(dialog.getByLabelText("注意事项"), created.caution);
    await user.type(dialog.getByLabelText("证据摘要"), created.evidenceSummary);
    await user.click(dialog.getByRole("button", { name: "保存人工候选" }));

    await waitFor(() =>
      expect(api.createManualMethodologyFromEvidence).toHaveBeenCalledWith({
        title: created.title,
        principle: created.principle,
        appliesWhen: created.appliesWhen,
        caution: created.caution,
        evidenceSummary: created.evidenceSummary,
        sourceDecisionIds: expect.arrayContaining(
          reviewed.map((item) => item.id),
        ),
      }),
    );
    expect(api.generateMethodology).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("dialog", { name: "审核方法论候选" }),
    ).toBeVisible();
  });

  it("creates a fully manual principle candidate without invoking a model", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "methodology" }),
    );
    const input = {
      title: "先写清边界，再决定自动化",
      principle: "先明确人工流程和失败边界，再评估是否值得自动化。",
      appliesWhen: "问题仍在变化，自动化接口尚不稳定时。",
      caution: "人工执行成本已经不可接受时应重新评估。",
    };
    const manual: MethodologyItem = {
      id: "principle-manual-1",
      createdAt: "2026-08-08T09:00:00.000Z",
      updatedAt: "2026-08-08T09:00:00.000Z",
      origin: "manual_entry",
      status: "candidate",
      confirmedAt: null,
      ...input,
      evidenceSummary: "人工录入，尚未关联经过结果复盘的决策证据。",
      sourceDecisionIds: [],
      sourceDecisions: [],
      confidence: "low",
      quality: methodologyQuality({
        evidenceCount: 0,
        projectCount: 0,
        sourceCount: 0,
        favorableEvidenceCount: 0,
        flags: ["no_evidence"],
        confidenceReason:
          "尚未关联经过结果复盘的决策证据，只能作为待验证假设。",
      }),
      generation: {
        requestId: "methodology-manual:1",
        profileId: "manual-methodology-entry",
        provider: "人工录入",
        model: "不调用模型",
      },
    };
    vi.mocked(api.listMethodologies).mockResolvedValue([]);
    vi.mocked(api.createManualMethodology).mockResolvedValue(manual);
    const user = userEvent.setup();

    render(<App api={api} />);

    const page = await screen.findByRole("region", { name: "方法论" });
    await user.click(within(page).getByRole("button", { name: "新建原则" }));
    const chooser = within(screen.getByRole("dialog", { name: "新建原则" }));
    expect(chooser.getByRole("button", { name: /^人工编写/u })).toBeVisible();
    expect(chooser.getByRole("button", { name: /^从复盘提炼/u })).toBeVisible();
    expect(
      chooser.getByRole("button", { name: /^导入 Markdown/u }),
    ).toBeVisible();
    expect(chooser.getByText("不会自动采纳")).toBeVisible();
    await user.click(chooser.getByRole("button", { name: /^人工编写/u }));

    const editor = within(
      screen.getByRole("dialog", { name: "人工编写原则候选" }),
    );
    await user.type(editor.getByRole("textbox", { name: "标题" }), input.title);
    await user.type(
      editor.getByRole("textbox", { name: "原则" }),
      input.principle,
    );
    await user.type(
      editor.getByRole("textbox", { name: "适用条件" }),
      input.appliesWhen,
    );
    await user.type(
      editor.getByRole("textbox", { name: "注意事项" }),
      input.caution,
    );
    await user.click(editor.getByRole("button", { name: "保存为待确认候选" }));

    expect(api.createManualMethodology).toHaveBeenCalledWith(input);
    expect(api.generateMethodology).not.toHaveBeenCalled();
    expect(api.importMethodologyMarkdown).not.toHaveBeenCalled();
    const detail = within(
      await screen.findByRole("dialog", { name: "审核方法论候选" }),
    );
    expect(detail.getByText("人工录入 · 尚未关联复盘证据")).toBeVisible();
    expect(detail.getByText("人工录入 · 不调用模型")).toBeVisible();
    expect(detail.getByRole("button", { name: "关联复盘证据" })).toBeVisible();
    expect(detail.getByRole("region", { name: "质量检查" })).toHaveTextContent(
      "尚未关联复盘证据",
    );
  });

  it("restores and explicitly discards an unfinished private methodology draft", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "methodology" }),
    );
    vi.mocked(api.listManualFormDrafts).mockResolvedValue([
      {
        key: "methodology_manual",
        updatedAt: "2026-08-08T10:00:00.000Z",
        input: {
          title: "未完成原则",
          principle: "先保留草稿，再继续完善。",
          appliesWhen: "窗口可能被关闭时。",
          caution: "草稿不能视为正式知识。",
        },
      },
    ]);
    const user = userEvent.setup();

    render(<App api={api} />);

    const page = await screen.findByRole("region", { name: "方法论" });
    await user.click(within(page).getByRole("button", { name: "新建原则" }));
    const chooser = within(screen.getByRole("dialog", { name: "新建原则" }));
    expect(await chooser.findByText("有未完成草稿 · 点击继续")).toBeVisible();
    await user.click(chooser.getByRole("button", { name: /^人工编写/u }));

    const editor = within(
      screen.getByRole("dialog", { name: "人工编写原则候选" }),
    );
    expect(editor.getByText("已恢复未完成草稿")).toBeVisible();
    expect(editor.getByRole("textbox", { name: "标题" })).toHaveValue(
      "未完成原则",
    );
    await user.click(editor.getByRole("button", { name: "丢弃并新建" }));

    await waitFor(() =>
      expect(api.deleteManualFormDraft).toHaveBeenCalledWith(
        "methodology_manual",
      ),
    );
    expect(editor.getByRole("textbox", { name: "标题" })).toHaveValue("");
    expect(editor.queryByText("已恢复未完成草稿")).not.toBeInTheDocument();
  });

  it("imports Markdown as an explicitly unverified candidate", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "methodology" }),
    );
    const imported: MethodologyItem = {
      id: "principle-imported-1",
      createdAt: "2026-08-03T10:00:00.000Z",
      updatedAt: "2026-08-03T10:00:00.000Z",
      origin: "markdown_import",
      status: "candidate",
      confirmedAt: null,
      title: "先保留回退路径",
      principle: "先验证关键假设，再扩大不可逆投入。",
      appliesWhen: "结果仍有关键未知项时。",
      caution: "切换成本快速增长时重新评估。",
      evidenceSummary: "从本地 Markdown 导入，尚未关联 Decision 中的复盘证据。",
      sourceDecisionIds: [],
      sourceDecisions: [],
      importSource: {
        fileName: "团队方法论.md",
        contentSha256:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
      confidence: "low",
      quality: methodologyQuality({
        evidenceCount: 0,
        projectCount: 0,
        sourceCount: 0,
        favorableEvidenceCount: 0,
        flags: ["no_evidence"],
        confidenceReason:
          "尚未关联经过结果复盘的决策证据，只能作为待验证假设。",
      }),
      generation: {
        requestId: "methodology-import:1",
        profileId: "local-markdown-import",
        provider: "本地导入",
        model: "Markdown",
      },
    };
    vi.mocked(api.listMethodologies)
      .mockResolvedValueOnce([])
      .mockResolvedValue([imported]);
    vi.mocked(api.importMethodologyMarkdown).mockResolvedValue({
      cancelled: false,
      batchId: "methodology-import-batch-1",
      candidates: [
        {
          id: "methodology-import-preview-1",
          fileName: "团队方法论.md",
          title: imported.title,
          principle: imported.principle,
          appliesWhen: imported.appliesWhen,
          caution: imported.caution,
          sourceDecisionCount: 0,
          missingFields: [],
          similarTo: null,
        },
        {
          id: "methodology-import-preview-2",
          fileName: "旧规则.md",
          title: "近似旧规则",
          principle: "先验证关键假设，再逐步扩大投入。",
          appliesWhen: "需求范围仍在快速变化时。",
          caution: "切换成本快速增长时重新评估。",
          sourceDecisionCount: 0,
          missingFields: [],
          similarTo: {
            title: "已有可逆原则",
            status: "accepted",
          },
        },
      ],
      duplicates: [],
      failures: [],
    });
    vi.mocked(api.commitMethodologyMarkdownImport).mockResolvedValue({
      imported: [imported],
      duplicates: [],
      failures: [],
    });
    vi.mocked(api.setMethodologyStatus).mockResolvedValue({
      ...imported,
      status: "accepted",
      confirmedAt: "2026-08-03T10:05:00.000Z",
    });
    const user = userEvent.setup();

    render(<App api={api} />);

    const page = await screen.findByRole("region", { name: "方法论" });
    await user.click(within(page).getByRole("button", { name: "新建原则" }));
    const creation = within(screen.getByRole("dialog", { name: "新建原则" }));
    await user.click(creation.getByRole("button", { name: /^导入 Markdown/u }));
    expect(api.importMethodologyMarkdown).toHaveBeenCalledOnce();
    const preview = within(
      await screen.findByRole("dialog", { name: "预检 Markdown 导入" }),
    );
    expect(preview.getByText("团队方法论.md")).toBeVisible();
    expect(preview.getAllByText("结构完整")).toHaveLength(2);
    expect(preview.getAllByText("尚无复盘证据")).toHaveLength(2);
    const importCheckboxes = preview.getAllByRole("checkbox");
    expect(importCheckboxes).toHaveLength(2);
    expect(importCheckboxes[0]).toBeChecked();
    expect(importCheckboxes[1]).not.toBeChecked();
    expect(preview.getByText("可能重复：已有可逆原则")).toBeVisible();
    await user.click(preview.getAllByText("核对适用条件与边界")[0]!);
    expect(preview.getByText(imported.appliesWhen)).toBeVisible();
    expect(preview.getAllByText(imported.caution)[0]).toBeVisible();
    await user.click(preview.getByRole("button", { name: "导入 1 条候选" }));
    expect(api.commitMethodologyMarkdownImport).toHaveBeenCalledWith(
      "methodology-import-batch-1",
      ["methodology-import-preview-1"],
    );
    expect(await within(page).findByText("已导入 1 条候选")).toBeVisible();
    await user.click(
      within(page).getByRole("button", { name: /先保留回退路径/u }),
    );
    const dialog = within(
      screen.getByRole("dialog", { name: "审核方法论候选" }),
    );
    expect(dialog.getByText("Markdown 导入 · 尚未关联复盘证据")).toBeVisible();
    expect(dialog.getByText(/不等同于经过 Decision 复盘验证/u)).toBeVisible();
    expect(
      dialog.getByRole("region", { name: "Markdown 导入来源" }),
    ).toHaveTextContent("团队方法论.md");
    expect(dialog.getByText("待验证")).toBeVisible();
    await user.click(dialog.getByRole("button", { name: "采纳为假设" }));
    expect(dialog.getByRole("region", { name: "采纳确认" })).toHaveTextContent(
      "当前没有经过复盘的决策证据",
    );
    await user.click(dialog.getByRole("button", { name: "确认采纳为假设" }));
    expect(api.setMethodologyStatus).toHaveBeenCalledWith(
      imported.id,
      "accepted",
      true,
    );
  });

  it("links reviewed evidence to an imported candidate without rewriting it", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "methodology" }),
    );
    const evidence = {
      id: "decision-evidence-1",
      created: "2026-08-02T08:00:00.000Z",
      sourceClient: "codex",
      project: "Decision",
      question: "扩大改动前是否应该先验证关键假设？",
      selectedAnswer: "先做可回退验证",
      rationaleStatus: "captured" as const,
      rationale: "需要真实运行结果。",
      context: null,
      outcome: "验证后发现了边界问题，避免了大范围返工。",
      outcomeReview: {
        verdict: "better" as const,
        lesson: "小范围验证降低了错误扩散风险。",
        reviewedAt: "2026-08-03T08:00:00.000Z",
      },
      reviewDueDate: null,
      appliedPrincipleIds: [],
      appliedPrinciples: [],
    };
    const unrelatedEvidence = {
      ...evidence,
      id: "decision-evidence-unrelated",
      project: "Desktop",
      question: "菜单栏图标应该使用多大尺寸？",
      selectedAnswer: "遵循系统模板图标尺寸",
      rationale: "需要与系统其它菜单栏图标保持一致。",
      outcome: "图标尺寸与系统项目对齐。",
      outcomeReview: {
        verdict: "as_expected" as const,
        lesson: "模板图标应遵循系统视觉尺寸。",
        reviewedAt: "2026-08-03T09:00:00.000Z",
      },
    };
    const imported: MethodologyItem = {
      id: "principle-imported-link",
      createdAt: "2026-08-03T10:00:00.000Z",
      updatedAt: "2026-08-03T10:00:00.000Z",
      origin: "markdown_import",
      status: "candidate",
      confirmedAt: null,
      title: "先验证再扩大",
      principle: "先验证关键假设，再扩大不可逆投入。",
      appliesWhen: "结果仍有关键未知项时。",
      caution: "验证窗口不能覆盖关键风险时不适用。",
      evidenceSummary: "来自团队方法论文档。",
      sourceDecisionIds: [],
      sourceDecisions: [],
      confidence: "low",
      quality: methodologyQuality({
        evidenceCount: 0,
        projectCount: 0,
        sourceCount: 0,
        favorableEvidenceCount: 0,
        flags: ["no_evidence"],
      }),
      generation: {
        requestId: "methodology-import:link",
        profileId: "local-markdown-import",
        provider: "本地导入",
        model: "Markdown",
      },
    };
    const linked: MethodologyItem = {
      ...imported,
      updatedAt: "2026-08-03T10:05:00.000Z",
      sourceDecisionIds: [evidence.id],
      sourceDecisions: [evidence],
      quality: methodologyQuality({ flags: ["single_evidence"] }),
    };
    vi.mocked(api.listMethodologies).mockResolvedValue([imported]);
    vi.mocked(api.listDecisions).mockResolvedValue([
      evidence,
      unrelatedEvidence,
    ]);
    vi.mocked(api.getMethodologyEvidenceMatches).mockResolvedValue([
      {
        sourceDecisionId: evidence.id,
        score: 21,
        strength: "possible",
        reason:
          "原则内容、适用条件与这条复盘存在文本重合，共同出现“验证关键假设”。",
        matchedTerms: ["验证关键假设"],
        alreadyLinked: false,
      },
    ]);
    vi.mocked(api.setMethodologyEvidence).mockResolvedValue(linked);
    const user = userEvent.setup();

    render(<App api={api} />);

    const page = await screen.findByRole("region", { name: "方法论" });
    await user.click(
      await within(page).findByRole("button", { name: /先验证再扩大/u }),
    );
    let detail = within(screen.getByRole("dialog", { name: "审核方法论候选" }));
    await user.click(detail.getByRole("button", { name: "关联复盘证据" }));
    const chooser = within(
      screen.getByRole("dialog", { name: "关联复盘证据" }),
    );
    const matches = within(
      chooser.getByRole("region", { name: "证据匹配建议" }),
    );
    expect(matches.getByText("可核对")).toBeVisible();
    expect(matches.getByText(evidence.question)).toBeVisible();
    expect(matches.queryByText(unrelatedEvidence.question)).toBeNull();
    const search = chooser.getByRole("searchbox", {
      name: "搜索复盘证据",
    });
    await user.type(search, "菜单栏");
    expect(
      chooser.getByRole("checkbox", { name: /菜单栏图标/u }),
    ).toBeVisible();
    expect(chooser.queryByRole("checkbox", { name: /扩大改动前/u })).toBeNull();
    await user.clear(search);
    await user.click(
      await chooser.findByRole("checkbox", {
        name: /扩大改动前是否应该先验证关键假设/u,
      }),
    );
    await user.click(chooser.getByRole("button", { name: "保存证据关联" }));
    expect(api.setMethodologyEvidence).toHaveBeenCalledWith(imported.id, [
      evidence.id,
    ]);
    detail = within(
      await screen.findByRole("dialog", { name: "审核方法论候选" }),
    );
    expect(detail.getByText("1 条证据 · 本地导入")).toBeVisible();
    expect(detail.getByText(/原则内容不会被自动改写/u)).toBeVisible();
    await user.click(detail.getByText("来源决策"));
    expect(
      detail.getByText(/证据 1 · 扩大改动前是否应该先验证关键假设/u),
    ).toBeVisible();
  });

  it("generates, edits, and accepts a traceable methodology candidate", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "methodology",
      }),
    );
    const evidence = {
      id: "decision-reviewed-1",
      created: "2026-08-01T03:04:00.000Z",
      sourceClient: "codex",
      project: "decision",
      question: "应该一次重构还是分步调整？",
      selectedAnswer: "先做可逆的小改动",
      rationaleStatus: "captured" as const,
      rationale: "分步更容易验证和回退。",
      context: "需求边界仍在变化。",
      outcome: "分步上线后没有出现大范围回归。",
      outcomeReview: {
        verdict: "as_expected" as const,
        lesson: "可逆的小步提交降低了返工成本。",
        reviewedAt: "2026-08-02T03:04:00.000Z",
      },
      reviewDueDate: "2026-08-02",
      appliedPrincipleIds: [],
      appliedPrinciples: [],
    };
    const candidate = {
      id: "principle-1",
      createdAt: "2026-08-02T10:00:00.000Z",
      updatedAt: "2026-08-02T10:00:00.000Z",
      origin: "decision_evidence" as const,
      status: "candidate" as const,
      confirmedAt: null,
      title: "先保持可逆",
      principle: "需求仍变化时，优先实施能快速回退的小步改动。",
      appliesWhen: "方案效果仍需要真实反馈验证时。",
      caution: "小步迁移会制造长期双轨成本时，应重新评估。",
      evidenceSummary: "证据 1 显示小步上线降低了回归风险。",
      sourceDecisionIds: [evidence.id],
      sourceDecisions: [evidence],
      confidence: "low" as const,
      quality: methodologyQuality({
        flags: ["single_evidence", "similar_principle"],
        relations: [
          {
            id: "principle-accepted-1",
            title: "先验证，再扩大",
            status: "accepted",
            kind: "similar",
            score: 78,
            sharedEvidenceCount: 1,
            reason:
              "共享 1 条来源证据，且原则表达高度接近；采纳前应判断是否需要合并。",
          },
        ],
      }),
      generation: {
        requestId: "methodology:request-1",
        profileId: "builtin-qwen",
        provider: "Qwen 本地模型",
        model: "qwen3.5-2b-q4-k-m",
      },
    };
    vi.mocked(api.listMethodologies).mockResolvedValue([candidate]);
    vi.mocked(api.listDecisions).mockResolvedValue([evidence]);
    vi.mocked(api.generateMethodology).mockResolvedValue(candidate);
    vi.mocked(api.reviseMethodology).mockImplementation(async (_id, input) => ({
      ...candidate,
      ...input,
    }));
    vi.mocked(api.setMethodologyStatus).mockImplementation(
      async (_id, status) => ({
        ...candidate,
        status,
        confirmedAt: status === "accepted" ? "2026-08-03T10:00:00.000Z" : null,
      }),
    );
    const user = userEvent.setup();

    render(<App api={api} />);

    const page = await screen.findByRole("region", { name: "方法论" });
    expect(await within(page).findByText("先保持可逆")).toBeVisible();
    await user.click(within(page).getByRole("button", { name: /先保持可逆/u }));
    let dialog = within(screen.getByRole("dialog", { name: "审核方法论候选" }));
    await user.click(dialog.getByText("来源决策"));
    expect(
      dialog.getByText(/证据 1 · 应该一次重构还是分步调整/u),
    ).toBeVisible();
    expect(dialog.getByText("Qwen 本地模型 · qwen3.5-2b-q4-k-m")).toBeVisible();
    expect(dialog.getByRole("region", { name: "质量检查" })).toHaveTextContent(
      "存在相近原则",
    );

    await user.click(dialog.getByRole("button", { name: "编辑" }));
    const principleInput = dialog.getByRole("textbox", { name: "原则" });
    await user.clear(principleInput);
    await user.type(principleInput, "先验证一段可回退路径，再扩大改动范围。");
    await user.click(dialog.getByRole("button", { name: "保存修改" }));
    expect(api.reviseMethodology).toHaveBeenCalledWith(
      "principle-1",
      expect.objectContaining({
        principle: "先验证一段可回退路径，再扩大改动范围。",
      }),
    );

    dialog = within(screen.getByRole("dialog", { name: "审核方法论候选" }));
    await user.click(dialog.getByRole("button", { name: "检查后采纳" }));
    expect(api.setMethodologyStatus).not.toHaveBeenCalled();
    expect(dialog.getByRole("region", { name: "采纳确认" })).toBeVisible();
    await user.click(dialog.getByRole("button", { name: "确认仍然采纳" }));
    expect(api.setMethodologyStatus).toHaveBeenCalledWith(
      "principle-1",
      "accepted",
      true,
    );
    await user.click(screen.getByRole("button", { name: "关闭方法论详情" }));

    await user.click(within(page).getByRole("button", { name: "新建原则" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "新建原则" })).getByRole(
        "button",
        { name: /^从复盘提炼/u },
      ),
    );
    const chooser = within(
      screen.getByRole("dialog", { name: "选择复盘证据" }),
    );
    await user.click(
      await chooser.findByRole("checkbox", {
        name: /应该一次重构还是分步调整/u,
      }),
    );
    await user.click(chooser.getByRole("button", { name: "模型提炼 · 1 次" }));
    expect(api.generateMethodology).toHaveBeenCalledWith([
      "decision-reviewed-1",
    ]);
  });

  it("records, updates, and revokes a human principle relationship", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "methodology" }),
    );
    const relation = {
      id: "principle-related",
      title: "先验证，再扩大",
      status: "accepted" as const,
      kind: "similar" as const,
      score: 78,
      sharedEvidenceCount: 1,
      reason: "原则和适用条件高度接近；采纳前应判断是否为重复规则。",
      resolution: null,
      resolutionNote: null,
      resolutionUpdatedAt: null,
    };
    const candidate: MethodologyItem = {
      id: "principle-review-relation",
      createdAt: "2026-08-06T10:00:00.000Z",
      updatedAt: "2026-08-06T10:00:00.000Z",
      origin: "decision_evidence",
      status: "candidate",
      confirmedAt: null,
      title: "先验证关键假设",
      principle: "先验证关键假设，再扩大不可逆投入。",
      appliesWhen: "结果仍有关键未知项时。",
      caution: "验证成本超过潜在损失时重新评估。",
      evidenceSummary: "一条复盘支持先验证再扩大的做法。",
      sourceDecisionIds: ["decision-1"],
      sourceDecisions: [],
      confidence: "low",
      quality: methodologyQuality({
        flags: ["single_evidence", "similar_principle"],
        relations: [relation],
      }),
      generation: {
        requestId: "methodology:relation",
        profileId: "builtin-qwen",
        provider: "Qwen 本地模型",
        model: "qwen3.5-2b-q4-k-m",
      },
    };
    const resolved: MethodologyItem = {
      ...candidate,
      quality: methodologyQuality({
        flags: ["single_evidence"],
        relations: [
          {
            ...relation,
            resolution: "unrelated",
            resolutionNote: "一个约束发布范围，另一个约束迁移时机。",
            resolutionUpdatedAt: "2026-08-06T11:00:00.000Z",
          },
        ],
      }),
    };
    vi.mocked(api.listMethodologies).mockImplementation(async (status) =>
      status === undefined || status === "candidate" ? [candidate] : [],
    );
    vi.mocked(api.setMethodologyRelation).mockResolvedValue(resolved);
    vi.mocked(api.clearMethodologyRelation).mockResolvedValue(candidate);
    const user = userEvent.setup();

    render(<App api={api} />);

    const page = await screen.findByRole("region", { name: "方法论" });
    await user.click(
      await within(page).findByRole("button", { name: /先验证关键假设/u }),
    );
    let detail = within(screen.getByRole("dialog", { name: "审核方法论候选" }));
    await user.click(detail.getByRole("button", { name: "核对关系" }));
    let editor = within(screen.getByRole("dialog", { name: "核对原则关系" }));
    await user.click(editor.getByRole("radio", { name: /无关/u }));
    await user.type(
      editor.getByRole("textbox", { name: "核对说明（可选）" }),
      "一个约束发布范围，另一个约束迁移时机。",
    );
    await user.click(editor.getByRole("button", { name: "保存关系结论" }));
    expect(api.setMethodologyRelation).toHaveBeenCalledWith(
      candidate.id,
      relation.id,
      "unrelated",
      "一个约束发布范围，另一个约束迁移时机。",
    );

    detail = within(
      await screen.findByRole("dialog", { name: "审核方法论候选" }),
    );
    expect(detail.getByText("人工核对完成")).toBeVisible();
    expect(detail.getByText("确认无关")).toBeVisible();
    expect(
      detail.getByText("一个约束发布范围，另一个约束迁移时机。"),
    ).toBeVisible();
    await user.click(detail.getByRole("button", { name: "修改结论" }));
    editor = within(screen.getByRole("dialog", { name: "核对原则关系" }));
    await user.click(editor.getByRole("button", { name: "撤销结论" }));
    expect(api.clearMethodologyRelation).toHaveBeenCalledWith(
      candidate.id,
      relation.id,
    );
  });

  it("reviews unresolved principle relationships once in a continuous queue", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "methodology" }),
    );
    const base: MethodologyItem = {
      id: "principle-queue-candidate",
      createdAt: "2026-08-06T10:00:00.000Z",
      updatedAt: "2026-08-06T10:00:00.000Z",
      origin: "decision_evidence",
      status: "candidate",
      confirmedAt: null,
      title: "先验证关键假设",
      principle: "先验证关键假设，再扩大不可逆投入。",
      appliesWhen: "结果仍有关键未知项时。",
      caution: "验证成本超过潜在损失时重新评估。",
      evidenceSummary: "复盘支持先验证再扩大的做法。",
      sourceDecisionIds: ["decision-1"],
      sourceDecisions: [],
      confidence: "low",
      quality: methodologyQuality(),
      generation: {
        requestId: "methodology:relation-queue",
        profileId: "builtin-qwen",
        provider: "Qwen 本地模型",
        model: "qwen3.5-2b-q4-k-m",
      },
    };
    const similar: MethodologyItem = {
      ...base,
      id: "principle-queue-similar",
      status: "accepted",
      confirmedAt: "2026-08-05T10:00:00.000Z",
      title: "小步验证后扩大",
      principle: "先完成可回退的小步验证，再扩大改动。",
      appliesWhen: "改动效果需要运行反馈时。",
    };
    const conflict: MethodologyItem = {
      ...base,
      id: "principle-queue-conflict",
      status: "accepted",
      confirmedAt: "2026-08-05T11:00:00.000Z",
      title: "一次完成迁移",
      principle: "避免长期双轨，确认方向后一次完成迁移。",
      appliesWhen: "双轨维护成本高于回退收益时。",
    };
    const similarRelation = {
      id: similar.id,
      title: similar.title,
      status: similar.status,
      kind: "similar" as const,
      score: 78,
      sharedEvidenceCount: 1,
      reason: "两条原则都强调先验证，再扩大投入。",
      resolution: null,
      resolutionNote: null,
      resolutionUpdatedAt: null,
    };
    const conflictRelation = {
      id: conflict.id,
      title: conflict.title,
      status: conflict.status,
      kind: "potential_conflict" as const,
      score: 64,
      sharedEvidenceCount: 0,
      reason: "适用范围可能重叠，但行动方向一个强调小步，一个强调一次完成。",
      resolution: null,
      resolutionNote: null,
      resolutionUpdatedAt: null,
    };
    const candidate: MethodologyItem = {
      ...base,
      quality: methodologyQuality({
        flags: ["single_evidence", "similar_principle", "potential_conflict"],
        relations: [similarRelation, conflictRelation],
      }),
    };
    const relatedRecords = [
      {
        ...similar,
        quality: methodologyQuality({
          relations: [
            {
              ...similarRelation,
              id: candidate.id,
              title: candidate.title,
              status: candidate.status,
            },
          ],
        }),
      },
      {
        ...conflict,
        quality: methodologyQuality({
          relations: [
            {
              ...conflictRelation,
              id: candidate.id,
              title: candidate.title,
              status: candidate.status,
            },
          ],
        }),
      },
    ];
    vi.mocked(api.listMethodologies).mockImplementation(async (status) =>
      status === undefined
        ? [candidate, ...relatedRecords]
        : status === "candidate"
          ? [candidate]
          : [],
    );
    vi.mocked(api.setMethodologyRelation).mockResolvedValue(candidate);
    const user = userEvent.setup();

    render(<App api={api} />);

    const page = await screen.findByRole("region", { name: "方法论" });
    await user.click(
      await within(page).findByRole("button", { name: /方法论工作箱/u }),
    );
    await user.click(
      within(screen.getByRole("dialog", { name: "方法论工作箱" })).getByRole(
        "button",
        { name: "关系核对 2" },
      ),
    );
    let queue = within(
      await screen.findByRole("dialog", { name: "批量核对原则关系" }),
    );
    expect(queue.getByText("第 1 组，共 2 组")).toBeVisible();
    expect(queue.getByText("可能存在行动冲突")).toBeVisible();
    expect(queue.getByText(conflict.title)).toBeVisible();
    await user.click(queue.getByRole("radio", { name: /冲突/u }));
    await user.type(
      queue.getByRole("textbox", { name: "批量核对说明（可选）" }),
      "两者只在不同迁移成本下适用。",
    );
    await user.click(queue.getByRole("button", { name: "保存并继续" }));
    expect(api.setMethodologyRelation).toHaveBeenNthCalledWith(
      1,
      candidate.id,
      conflict.id,
      "conflict",
      "两者只在不同迁移成本下适用。",
    );

    queue = within(
      await screen.findByRole("dialog", { name: "批量核对原则关系" }),
    );
    expect(queue.getByText("第 2 组，共 2 组")).toBeVisible();
    expect(queue.getByText("表达可能重复")).toBeVisible();
    expect(queue.getByText(similar.title)).toBeVisible();
    await user.click(queue.getByRole("radio", { name: /无关/u }));
    await user.click(queue.getByRole("button", { name: "保存并继续" }));
    expect(api.setMethodologyRelation).toHaveBeenNthCalledWith(
      2,
      candidate.id,
      similar.id,
      "unrelated",
      null,
    );
    expect(
      await within(page).findByText("已完成 2 组原则关系核对。"),
    ).toBeVisible();
    expect(
      screen.queryByRole("dialog", { name: "批量核对原则关系" }),
    ).toBeNull();
  });

  it("shows accepted principles as project, decision, and outcome relationships", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "methodology",
      }),
    );
    const relatedPrinciple: MethodologyItem = {
      id: "principle-2",
      createdAt: "2026-08-03T08:00:00.000Z",
      updatedAt: "2026-08-03T10:00:00.000Z",
      origin: "decision_evidence",
      status: "accepted",
      confirmedAt: "2026-08-03T10:00:00.000Z",
      title: "一次完成迁移",
      principle: "双轨成本过高时，确认方向后一次完成迁移。",
      appliesWhen: "并行维护成本会持续扩大时。",
      caution: "关键风险尚未验证时不适用。",
      evidenceSummary: "复盘显示长期双轨增加了维护成本。",
      sourceDecisionIds: ["decision-1"],
      sourceDecisions: [],
      confidence: "medium",
      quality: methodologyQuality({ flags: [] }),
      generation: {
        requestId: "methodology:graph-related",
        profileId: "builtin-qwen",
        provider: "Qwen 本地模型",
        model: "qwen3.5-2b-q4-k-m",
      },
    };
    vi.mocked(api.listMethodologies).mockImplementation(async (status) =>
      status === undefined || status === "accepted" ? [relatedPrinciple] : [],
    );
    vi.mocked(api.getKnowledgeGraph).mockResolvedValue({
      projects: [
        {
          id: "project:Decision",
          name: "Decision",
          decisionIds: ["decision-1"],
          principleIds: ["principle-1", "principle-2"],
        },
      ],
      decisions: [
        {
          id: "decision-1",
          projectId: "project:Decision",
          project: "Decision",
          question: "页面改造应该一次完成还是分步验证？",
          selectedAnswer: "分步验证",
          principleIds: ["principle-1", "principle-2"],
        },
      ],
      outcomes: [
        {
          id: "outcome:decision-1",
          decisionId: "decision-1",
          summary: "分步上线后没有出现大范围回归。",
          verdict: "as_expected",
          lesson: "可逆改动降低了返工成本。",
          reviewedAt: "2026-08-03T09:00:00.000Z",
        },
      ],
      principles: [
        {
          id: "principle-1",
          title: "先验证再扩大",
          principle: "先通过可回退的小步改动验证效果，再扩大范围。",
          confidence: "medium",
          confirmedAt: "2026-08-03T10:00:00.000Z",
          sourceDecisionIds: ["decision-1"],
          projectIds: ["project:Decision"],
        },
        {
          id: "principle-2",
          title: relatedPrinciple.title,
          principle: relatedPrinciple.principle,
          confidence: relatedPrinciple.confidence,
          confirmedAt: relatedPrinciple.confirmedAt!,
          sourceDecisionIds: ["decision-1"],
          projectIds: ["project:Decision"],
        },
      ],
      principleRelations: [
        {
          id: "principle-relation-graph",
          sourcePrincipleId: "principle-1",
          targetPrincipleId: "principle-2",
          disposition: "conflict",
          note: "两条原则适用范围重叠，但对迁移节奏给出不同方向。",
          updatedAt: "2026-08-06T10:00:00.000Z",
        },
      ],
      edges: [
        {
          sourceId: "project:Decision",
          targetId: "decision-1",
          relationship: "project-decision",
        },
        {
          sourceId: "decision-1",
          targetId: "outcome:decision-1",
          relationship: "decision-outcome",
        },
        {
          sourceId: "decision-1",
          targetId: "principle-1",
          relationship: "decision-principle",
        },
        {
          sourceId: "decision-1",
          targetId: "principle-2",
          relationship: "decision-principle",
        },
        {
          sourceId: "principle-1",
          targetId: "principle-2",
          relationship: "principle-conflict",
        },
      ],
      missingSourceDecisionIds: [],
    });
    const user = userEvent.setup();

    render(<App api={api} />);

    const page = await screen.findByRole("region", { name: "方法论" });
    await user.click(within(page).getByRole("tab", { name: "图谱" }));
    const graph = await within(page).findByRole("region", {
      name: "知识关系图谱",
    });
    expect(within(graph).getByText("先验证再扩大")).toBeVisible();
    expect(within(graph).getAllByText("Decision")[0]).toBeVisible();
    expect(
      within(graph).getAllByText("页面改造应该一次完成还是分步验证？")[0],
    ).toBeVisible();
    expect(within(graph).getAllByText("符合预期")[0]).toBeVisible();
    expect(
      within(graph).getByRole("region", { name: "已确认原则关系" }),
    ).toHaveTextContent("确认冲突");
    const graphSearch = within(graph).getByRole("searchbox", {
      name: "搜索图谱",
    });
    expect(graphSearch).toBeVisible();
    await user.type(graphSearch, "一次完成");
    expect(within(graph).getByRole("status")).toHaveTextContent("1 / 2 条原则");
    await user.clear(graphSearch);
    await user.selectOptions(
      within(graph).getByRole("combobox", { name: "关系类型" }),
      "duplicate",
    );
    expect(
      within(graph).getByText("当前搜索和关系筛选下没有匹配项。"),
    ).toBeVisible();
    await user.selectOptions(
      within(graph).getByRole("combobox", { name: "关系类型" }),
      "all",
    );
    await user.click(
      within(graph).getByRole("button", {
        name: /先验证再扩大.*一次完成迁移/u,
      }),
    );
    expect(within(graph).getByText("退出成对查看")).toBeVisible();
    expect(within(graph).getByRole("status")).toHaveTextContent("2 / 2 条原则");
    await user.click(
      within(graph).getAllByRole("button", { name: "查看详情" })[1]!,
    );
    expect(
      await screen.findByRole("dialog", { name: "方法论详情" }),
    ).toHaveTextContent("一次完成迁移");
    expect(api.getKnowledgeGraph).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "关闭方法论详情" }));
    await user.click(within(page).getByRole("tab", { name: "原则" }));
    expect(
      within(page).getByRole("button", { name: "新建原则" }),
    ).toBeVisible();
  });

  it("completes a missing pairwise relation in place before adding a third merge source", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "methodology",
      }),
    );
    const evidence: DecisionLibraryItem = {
      id: "decision-merge-1",
      question: "应该一次重构，还是先验证关键路径？",
      selectedAnswer: "先验证关键路径",
      created: "2026-08-01T08:00:00.000Z",
      sourceClient: "codex",
      project: "Decision",
      rationaleStatus: "captured",
      rationale: "先降低不可逆风险。",
      context: "核心信息架构仍在调整。",
      outcome: "小步验证后没有出现大范围返工。",
      outcomeReview: {
        verdict: "as_expected",
        lesson: "可回退路径降低了返工成本。",
        reviewedAt: "2026-08-02T08:00:00.000Z",
      },
      reviewDueDate: null,
      appliedPrincipleIds: [],
      appliedPrinciples: [],
    };
    const first: MethodologyItem = {
      id: "principle-merge-a",
      createdAt: "2026-08-02T08:00:00.000Z",
      updatedAt: "2026-08-02T09:00:00.000Z",
      origin: "decision_evidence",
      status: "accepted",
      confirmedAt: "2026-08-02T09:00:00.000Z",
      title: "先验证再扩大",
      principle: "先验证一段可回退路径，再扩大不可逆投入。",
      appliesWhen: "关键结果仍有未知项时。",
      caution: "验证成本高于潜在损失时重新评估。",
      evidenceSummary: "复盘显示小步验证降低了返工成本。",
      sourceDecisionIds: [evidence.id],
      sourceDecisions: [evidence],
      confidence: "medium",
      quality: methodologyQuality({ flags: [] }),
      generation: {
        requestId: "methodology:merge-a",
        profileId: "builtin-qwen",
        provider: "Qwen 本地模型",
        model: "qwen3.5-2b-q4-k-m",
      },
    };
    const second: MethodologyItem = {
      ...first,
      id: "principle-merge-b",
      title: "保留回退路径后再扩展",
      principle: "先保留可验证、可回退的路径，再决定是否扩大范围。",
      appliesWhen: "方案效果仍需真实反馈确认时。",
      evidenceSummary: "同一条复盘支持先保留回退路径。",
      generation: {
        ...first.generation,
        requestId: "methodology:merge-b",
      },
    };
    const third: MethodologyItem = {
      ...first,
      id: "principle-merge-c",
      title: "用小范围反馈控制扩张",
      principle: "先用小范围真实反馈确认边界，再逐步扩大投入。",
      appliesWhen: "扩大范围会显著增加返工成本时。",
      evidenceSummary: "复盘支持先用真实反馈确认扩张边界。",
      quality: methodologyQuality({
        flags: [],
        relations: [first].map((item) => ({
          id: item.id,
          title: item.title,
          status: item.status,
          kind: "similar" as const,
          score: 90,
          sharedEvidenceCount: 1,
          reason: "人工确认表达同一条可回退验证规则。",
          resolution: "duplicate" as const,
        })),
      }),
      generation: {
        ...first.generation,
        requestId: "methodology:merge-c",
      },
    };
    const blocked: MethodologyItem = {
      ...third,
      id: "principle-merge-blocked",
      title: "直接扩大后再观察",
      principle: "先扩大范围，再根据整体反馈决定是否保留。",
      quality: methodologyQuality({
        flags: [],
        relations: [
          {
            id: first.id,
            title: first.title,
            status: first.status,
            kind: "similar",
            score: 82,
            sharedEvidenceCount: 1,
            reason: "人工确认存在部分表达重合。",
            resolution: "duplicate",
          },
        ],
      }),
      generation: {
        ...first.generation,
        requestId: "methodology:merge-blocked",
      },
    };
    const merged: MethodologyItem = {
      ...first,
      id: "principle-merge-draft",
      origin: "principle_merge",
      status: "candidate",
      confirmedAt: null,
      title: "先验证关键路径，再扩大范围",
      sourcePrincipleIds: [first.id, second.id, third.id],
      sourcePrinciples: [first, second, third].map((item) => ({
        id: item.id,
        status: item.status,
        title: item.title,
        principle: item.principle,
        appliesWhen: item.appliesWhen,
        caution: item.caution,
      })),
      quality: methodologyQuality({
        flags: ["similar_principle"],
        relations: [
          {
            id: first.id,
            title: first.title,
            status: first.status,
            kind: "similar",
            score: 92,
            sharedEvidenceCount: 1,
            reason: "合并草案与来源原则表达接近。",
            resolution: "duplicate",
          },
        ],
      }),
      generation: {
        requestId: "methodology-merge:draft",
        profileId: "manual-principle-merge",
        provider: "人工合并",
        model: "不调用模型",
      },
    };
    let created = false;
    vi.mocked(api.listMethodologies).mockImplementation(async (status) => {
      if (status === undefined || status === "accepted") {
        return [first, second, third, blocked];
      }
      if (status === "candidate" && created) return [merged];
      return [];
    });
    vi.mocked(api.createMethodologyMergeDraft).mockImplementation(
      async (_sourcePrincipleIds, input) => {
        created = true;
        return { ...merged, ...input };
      },
    );
    vi.mocked(api.setMethodologyRelation).mockImplementation(
      async (id, relatedId, disposition, note) => {
        if (
          id === second.id &&
          relatedId === third.id &&
          disposition === "duplicate"
        ) {
          third.quality = methodologyQuality({
            flags: [],
            relations: [first, second].map((item) => ({
              id: item.id,
              title: item.title,
              status: item.status,
              kind: "similar" as const,
              score: 90,
              sharedEvidenceCount: 1,
              reason: note ?? "人工确认表达同一规则。",
              resolution: "duplicate" as const,
            })),
          });
        }
        if (
          id === second.id &&
          relatedId === blocked.id &&
          disposition === "conflict"
        ) {
          blocked.quality = methodologyQuality({
            flags: [],
            relations: [
              ...blocked.quality.relations,
              {
                id: second.id,
                title: second.title,
                status: second.status,
                kind: "potential_conflict",
                score: 88,
                sharedEvidenceCount: 1,
                reason: note ?? "行动方向相反。",
                resolution: "conflict",
              },
            ],
          });
        }
        return id === second.id
          ? second
          : relatedId === third.id
            ? third
            : blocked;
      },
    );
    vi.mocked(api.getKnowledgeGraph).mockResolvedValue({
      projects: [],
      decisions: [],
      outcomes: [],
      principles: [first, second, third].map((item) => ({
        id: item.id,
        title: item.title,
        principle: item.principle,
        confidence: item.confidence,
        confirmedAt: item.confirmedAt!,
        sourceDecisionIds: item.sourceDecisionIds,
        projectIds: [],
      })),
      principleRelations: [
        {
          id: "relation-merge-duplicate",
          sourcePrincipleId: first.id,
          targetPrincipleId: second.id,
          disposition: "duplicate",
          note: "两条原则表达同一条可回退验证规则。",
          updatedAt: "2026-08-06T08:00:00.000Z",
        },
        {
          id: "relation-merge-first-third",
          sourcePrincipleId: first.id,
          targetPrincipleId: third.id,
          disposition: "duplicate",
          note: "同一条可回退验证规则。",
          updatedAt: "2026-08-06T08:00:00.000Z",
        },
      ],
      edges: [
        {
          sourceId: first.id,
          targetId: second.id,
          relationship: "principle-duplicate",
        },
        {
          sourceId: first.id,
          targetId: third.id,
          relationship: "principle-duplicate",
        },
      ],
      missingSourceDecisionIds: [],
    });
    const user = userEvent.setup();

    render(<App api={api} />);

    const page = await screen.findByRole("region", { name: "方法论" });
    await user.click(within(page).getByRole("tab", { name: "图谱" }));
    const graph = await within(page).findByRole("region", {
      name: "知识关系图谱",
    });
    await user.click(
      within(graph).getByRole("button", {
        name: /先验证再扩大.*保留回退路径后再扩展/u,
      }),
    );
    await user.click(
      within(graph).getByRole("button", { name: "建立合并草案" }),
    );

    const editor = within(
      await screen.findByRole("dialog", { name: "建立合并草案" }),
    );
    expect(editor.getByText("来源 1")).toBeVisible();
    expect(editor.getByText("来源 2")).toBeVisible();
    await user.click(
      editor.getByRole("button", {
        name: "核对后加入 直接扩大后再观察",
      }),
    );
    const blockedReview = within(
      editor.getByRole("region", { name: "补齐合并关系" }),
    );
    await user.click(blockedReview.getByRole("button", { name: "确认冲突" }));
    expect(api.setMethodologyRelation).toHaveBeenCalledWith(
      second.id,
      blocked.id,
      "conflict",
      null,
    );
    expect(
      await editor.findByText("已记录为冲突；这条原则不会加入当前合并组。"),
    ).toBeVisible();
    expect(editor.queryByText("来源 3")).not.toBeInTheDocument();
    expect(editor.getByText(/已确认\s*1\s*对.*待核对\s*1\s*对/u)).toBeVisible();
    await user.click(
      editor.getByRole("button", {
        name: "核对后加入 用小范围反馈控制扩张",
      }),
    );
    const relationReview = within(
      editor.getByRole("region", { name: "补齐合并关系" }),
    );
    expect(relationReview.getByText(/第\s*1\s*\/\s*1\s*对/u)).toBeVisible();
    expect(relationReview.getByText(second.title)).toBeVisible();
    const relationNote = relationReview.getByRole("textbox", {
      name: "合并关系核对说明（可选）",
    });
    await user.type(relationNote, "适用边界一致，表达的是同一规则。");
    await user.click(
      relationReview.getByRole("button", { name: "确认重复并继续" }),
    );
    expect(api.setMethodologyRelation).toHaveBeenCalledWith(
      second.id,
      third.id,
      "duplicate",
      "适用边界一致，表达的是同一规则。",
    );
    expect(editor.getByText("来源 3")).toBeVisible();
    expect(editor.getByText("3 / 5")).toBeVisible();
    expect(
      editor.getByText(/来源原则、关系结论和已有技能与流程/u),
    ).toBeVisible();
    const title = editor.getByRole("textbox", { name: "新标题" });
    await user.clear(title);
    await user.type(title, merged.title);
    await user.click(editor.getByRole("button", { name: "创建待确认草案" }));

    expect(api.createMethodologyMergeDraft).toHaveBeenCalledWith(
      [first.id, second.id, third.id],
      expect.objectContaining({
        title: merged.title,
        sourceDecisionIds: [evidence.id],
      }),
    );
    const detail = within(
      await screen.findByRole("dialog", { name: "审核方法论候选" }),
    );
    expect(detail.getByText("人工合并草案 · 3 条来源原则")).toBeVisible();
    expect(
      detail.getByText("原原则保持独立，不会被这条草案覆盖"),
    ).toBeVisible();
    expect(api.setMethodologyStatus).not.toHaveBeenCalled();
    expect(first.status).toBe("accepted");
    expect(second.status).toBe("accepted");
    expect(third.status).toBe("accepted");
  });

  it("revalidates, resumes, preserves, and explicitly discards a private merge draft", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "methodology" }),
    );
    const evidence: DecisionLibraryItem = {
      id: "decision-merge-recovery",
      question: "如何降低不可逆投入？",
      selectedAnswer: "先验证可回退路径",
      created: "2026-08-06T08:00:00.000Z",
      sourceClient: "codex",
      project: "Decision",
      rationaleStatus: "captured",
      rationale: "先校验主要假设。",
      context: "结果仍有未知项。",
      outcome: "小范围验证降低了返工成本。",
      outcomeReview: {
        verdict: "as_expected",
        lesson: "可回退路径有效。",
        reviewedAt: "2026-08-07T08:00:00.000Z",
      },
      reviewDueDate: null,
      appliedPrincipleIds: [],
      appliedPrinciples: [],
    };
    const first: MethodologyItem = {
      id: "principle-recovery-a",
      createdAt: "2026-08-06T08:00:00.000Z",
      updatedAt: "2026-08-07T08:00:00.000Z",
      origin: "decision_evidence",
      status: "accepted",
      confirmedAt: "2026-08-07T08:00:00.000Z",
      title: "先验证再扩大",
      principle: "先验证可回退路径，再扩大投入。",
      appliesWhen: "主要结果仍未知时。",
      caution: "不要让验证拖延必要行动。",
      evidenceSummary: "复盘支持先验证。",
      sourceDecisionIds: [evidence.id],
      sourceDecisions: [evidence],
      confidence: "medium",
      quality: methodologyQuality({
        flags: [],
        relations: [
          {
            id: "principle-recovery-b",
            title: "保留回退路径",
            status: "accepted",
            kind: "similar",
            score: 91,
            sharedEvidenceCount: 1,
            reason: "表达同一条规则。",
            resolution: "duplicate",
          },
        ],
      }),
      generation: {
        requestId: "methodology:recovery-a",
        profileId: "builtin-qwen",
        provider: "Qwen 本地模型",
        model: "qwen3.5-2b-q4-k-m",
      },
    };
    const second: MethodologyItem = {
      ...first,
      id: "principle-recovery-b",
      title: "保留回退路径",
      principle: "先保留可回退路径，再决定是否扩张。",
      quality: methodologyQuality({ flags: [] }),
      generation: {
        ...first.generation,
        requestId: "methodology:recovery-b",
      },
    };
    vi.mocked(api.listManualFormDrafts).mockResolvedValue([
      {
        key: "methodology_merge",
        sourcePrincipleIds: [first.id, second.id],
        updatedAt: "2026-08-08T10:00:00.000Z",
        input: {
          title: "未完成的统一原则",
          principle: "先验证和保留回退路径，再扩大投入。",
          appliesWhen: "关键结果未知时。",
          caution: "验证不能覆盖主要风险时停止。",
          evidenceSummary: "保留两条来源的复盘依据。",
          sourceDecisionIds: [evidence.id],
        },
      },
    ]);
    vi.mocked(api.listMethodologies).mockImplementation(async (status) =>
      status === undefined || status === "accepted" ? [first, second] : [],
    );
    const user = userEvent.setup();

    render(<App api={api} />);

    const page = await screen.findByRole("region", { name: "方法论" });
    await user.click(
      await within(page).findByRole("button", { name: "继续合并" }),
    );
    let editor = within(
      await screen.findByRole("dialog", { name: "建立合并草案" }),
    );
    expect(editor.getByRole("textbox", { name: "新标题" })).toHaveValue(
      "未完成的统一原则",
    );
    expect(editor.getByText(/已恢复/u)).toBeVisible();
    const title = editor.getByRole("textbox", { name: "新标题" });
    await user.clear(title);
    await user.type(title, "继续整理后的统一原则");
    await user.click(editor.getByRole("button", { name: "稍后继续" }));

    await waitFor(() =>
      expect(api.saveManualFormDraft).toHaveBeenLastCalledWith(
        expect.objectContaining({
          key: "methodology_merge",
          sourcePrincipleIds: [first.id, second.id],
          input: expect.objectContaining({ title: "继续整理后的统一原则" }),
        }),
      ),
    );
    expect(
      screen.queryByRole("dialog", { name: "建立合并草案" }),
    ).not.toBeInTheDocument();

    await user.click(within(page).getByRole("button", { name: "继续合并" }));
    editor = within(
      await screen.findByRole("dialog", { name: "建立合并草案" }),
    );
    expect(editor.getByRole("textbox", { name: "新标题" })).toHaveValue(
      "继续整理后的统一原则",
    );
    await user.click(editor.getByRole("button", { name: "丢弃草稿" }));

    await waitFor(() =>
      expect(api.deleteManualFormDraft).toHaveBeenCalledWith(
        "methodology_merge",
      ),
    );
    expect(
      within(page).queryByRole("button", { name: "继续合并" }),
    ).not.toBeInTheDocument();
  });

  it("keeps a stale merge draft inert when current pairwise facts no longer allow it", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "methodology" }),
    );
    const source = (id: string, title: string): MethodologyItem => ({
      id,
      createdAt: "2026-08-06T08:00:00.000Z",
      updatedAt: "2026-08-07T08:00:00.000Z",
      origin: "decision_evidence",
      status: "accepted",
      confirmedAt: "2026-08-07T08:00:00.000Z",
      title,
      principle: "先验证可回退路径。",
      appliesWhen: "结果未知时。",
      caution: "避免拖延。",
      evidenceSummary: "来源复盘。",
      sourceDecisionIds: [],
      sourceDecisions: [],
      confidence: "medium",
      quality: methodologyQuality({ flags: [] }),
      generation: {
        requestId: `methodology:${id}`,
        profileId: "builtin-qwen",
        provider: "Qwen 本地模型",
        model: "qwen3.5-2b-q4-k-m",
      },
    });
    const first = source("principle-stale-a", "原则 A");
    const second = source("principle-stale-b", "原则 B");
    vi.mocked(api.listManualFormDrafts).mockResolvedValue([
      {
        key: "methodology_merge",
        sourcePrincipleIds: [first.id, second.id],
        updatedAt: "2026-08-08T10:00:00.000Z",
        input: {
          title: "过期合并",
          principle: "旧内容",
          appliesWhen: "旧边界",
          caution: "旧注意事项",
          evidenceSummary: "旧证据",
          sourceDecisionIds: [],
        },
      },
    ]);
    vi.mocked(api.listMethodologies).mockImplementation(async (status) =>
      status === undefined || status === "accepted" ? [first, second] : [],
    );
    const user = userEvent.setup();

    render(<App api={api} />);

    const page = await screen.findByRole("region", { name: "方法论" });
    await user.click(
      await within(page).findByRole("button", { name: "继续合并" }),
    );
    expect(
      await within(page).findByText(/来源之间的重复关系已经变化/u),
    ).toBeVisible();
    expect(
      screen.queryByRole("dialog", { name: "建立合并草案" }),
    ).not.toBeInTheDocument();
    expect(api.setMethodologyRelation).not.toHaveBeenCalled();
    expect(api.createMethodologyMergeDraft).not.toHaveBeenCalled();
  });

  it("migrates merge references one explicit draft at a time without changing published content", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "methodology" }),
    );
    const source = (id: string, title: string): MethodologyItem => ({
      id,
      createdAt: "2026-08-01T08:00:00.000Z",
      updatedAt: "2026-08-02T08:00:00.000Z",
      origin: "decision_evidence",
      status: "accepted",
      confirmedAt: "2026-08-02T08:00:00.000Z",
      title,
      principle: "先验证可回退路径，再逐步扩大范围。",
      appliesWhen: "关键结果仍有未知项时。",
      caution: "双轨成本扩大时重新评估。",
      evidenceSummary: "复盘支持该原则。",
      sourceDecisionIds: ["decision-merge-source"],
      sourceDecisions: [],
      confidence: "medium",
      quality: methodologyQuality({ flags: [] }),
      generation: {
        requestId: `methodology:${id}`,
        profileId: "builtin-qwen",
        provider: "Qwen 本地模型",
        model: "qwen3.5-2b-q4-k-m",
      },
    });
    const first = source("principle-source-a", "先验证再扩大");
    const second = source("principle-source-b", "先保留回退路径");
    const merged: MethodologyItem = {
      ...first,
      id: "principle-merged",
      origin: "principle_merge",
      title: "先验证可回退骨架，再逐步扩展",
      sourcePrincipleIds: [first.id, second.id],
      sourcePrinciples: [first, second].map((item) => ({
        id: item.id,
        status: item.status,
        title: item.title,
        principle: item.principle,
        appliesWhen: item.appliesWhen,
        caution: item.caution,
      })),
      generation: {
        requestId: "methodology-merge:accepted",
        profileId: "manual-principle-merge",
        provider: "人工合并",
        model: "不调用模型",
      },
    };
    const originalAsset: PracticeAssetItem = {
      id: "workflow-merge-source",
      slug: "workflow-merge-source",
      kind: "workflow",
      status: "accepted",
      createdAt: "2026-08-02T09:00:00.000Z",
      updatedAt: "2026-08-02T10:00:00.000Z",
      acceptedAt: "2026-08-02T10:00:00.000Z",
      title: "来源更新后的实践校准",
      summary: "根据来源原则校准实践。",
      trigger: "来源原则变化时。",
      steps: ["核对来源。", "审核替换。"],
      checks: ["原内容保持可恢复。"],
      fallback: "恢复原内容。",
      sourcePrincipleIds: [first.id],
      sourcePrinciples: [],
      supersedesId: null,
      freshness: {
        state: "current",
        sourceCount: 1,
        updatedSourceCount: 0,
        missingSourceCount: 0,
        unacceptedSourceCount: 0,
        latestSourceUpdatedAt: first.updatedAt,
        canRegenerate: true,
        message: "内容与当前已采纳原则一致。",
      },
      sourceChanges: [],
      generation: {
        requestId: "workflow:merge-source",
        profileId: "builtin-qwen",
        provider: "Qwen 本地模型",
        model: "qwen3.5-2b-q4-k-m",
      },
    };
    let replacementReady = false;
    vi.mocked(api.listMethodologies).mockImplementation(async (status) =>
      [first, second, merged].filter(
        (item) => status === undefined || item.status === status,
      ),
    );
    vi.mocked(api.getMethodologyMergePlan).mockImplementation(async () => ({
      mergeId: merged.id,
      mergeTitle: merged.title,
      mergeStatus: "accepted",
      sources: [first, second].map((item) => ({
        id: item.id,
        title: item.title,
        status: item.status,
        retiredAt: null,
        supersededById: null,
      })),
      relationValid: true,
      retired: false,
      canRetire: false,
      canRestore: false,
      modelCallsRequired: replacementReady ? 0 : 1,
      pendingReviewCount: replacementReady ? 1 : 0,
      assets: [
        {
          id: originalAsset.id,
          title: originalAsset.title,
          kind: originalAsset.kind,
          status: originalAsset.status,
          sourcePrincipleIds: [first.id],
          targetSourcePrincipleIds: [merged.id],
          replacementId: replacementReady ? "workflow-replacement" : null,
          replacementTitle: replacementReady ? "来源迁移草案" : null,
        },
      ],
    }));
    vi.mocked(api.prepareMethodologyMergeAsset).mockImplementation(async () => {
      replacementReady = true;
      return {
        ...originalAsset,
        id: "workflow-replacement",
        status: "candidate",
        acceptedAt: null,
        sourcePrincipleIds: [merged.id],
        migrationSourcePrincipleIds: [first.id],
        supersedesId: originalAsset.id,
      };
    });
    const user = userEvent.setup();

    render(<App api={api} />);

    const page = await screen.findByRole("region", { name: "方法论" });
    await user.click(
      within(page).getByRole("button", { name: "已采纳", pressed: false }),
    );
    await user.click(
      await within(page).findByRole("button", {
        name: new RegExp(merged.title),
      }),
    );
    const detail = within(
      await screen.findByRole("dialog", { name: "方法论详情" }),
    );
    await user.click(detail.getByRole("button", { name: "整理来源" }));

    const lifecycle = within(
      await screen.findByRole("dialog", { name: "整理合并来源" }),
    );
    expect(lifecycle.getByText(/1 次模型调用/u)).toBeVisible();
    expect(lifecycle.getByText(/现有内容与发布状态保持不变/u)).toBeVisible();
    await user.click(lifecycle.getByRole("button", { name: "生成替换草案" }));

    expect(api.prepareMethodologyMergeAsset).toHaveBeenCalledOnce();
    expect(api.prepareMethodologyMergeAsset).toHaveBeenCalledWith(
      merged.id,
      originalAsset.id,
    );
    expect(
      await lifecycle.findByRole("button", { name: "去审核草案" }),
    ).toBeVisible();
    expect(api.setPracticeAssetStatus).not.toHaveBeenCalled();
    expect(api.publishPracticeAsset).not.toHaveBeenCalled();
  });

  it("shows local analytics from the rebuildable decision snapshot", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "methodology",
      }),
    );
    vi.mocked(api.getDecisionAnalytics).mockResolvedValue({
      generatedAt: "2026-08-03T10:00:00.000Z",
      engine: {
        name: "Local aggregation",
        version: "1",
        source: "SQLite snapshot",
      },
      totals: {
        decisions: 18,
        projects: 3,
        rationaleCaptured: 15,
        outcomesRecorded: 12,
        outcomesReviewed: 9,
      },
      rates: {
        rationaleCaptured: 83.3,
        outcomesRecorded: 66.7,
        outcomesReviewed: 75,
      },
      verdicts: [
        { verdict: "better", count: 2, percentage: 22.2 },
        { verdict: "as_expected", count: 5, percentage: 55.6 },
        { verdict: "mixed", count: 1, percentage: 11.1 },
        { verdict: "worse", count: 1, percentage: 11.1 },
        { verdict: "unclear", count: 0, percentage: 0 },
      ],
      projects: [
        {
          key: "Decision",
          label: "Decision",
          decisionCount: 12,
          rationaleCaptured: 10,
          outcomesRecorded: 8,
          outcomesReviewed: 6,
          favorableOutcomes: 5,
          attentionOutcomes: 1,
          latestCreated: "2026-08-03T09:00:00.000Z",
        },
      ],
      sources: [
        {
          key: "codex",
          label: "codex",
          decisionCount: 18,
          rationaleCaptured: 15,
          outcomesRecorded: 12,
          outcomesReviewed: 9,
          favorableOutcomes: 7,
          attentionOutcomes: 2,
          latestCreated: "2026-08-03T09:00:00.000Z",
        },
      ],
      trend: [
        { period: "2026-07", decisionCount: 10, outcomesReviewed: 4 },
        { period: "2026-08", decisionCount: 8, outcomesReviewed: 5 },
      ],
    });
    vi.mocked(api.getDecisionConsultationMetrics).mockResolvedValue({
      metricsVersion: 1,
      requests: 10,
      matched: 7,
      noMatch: 3,
      matches: 12,
      strongMatches: 8,
      possibleMatches: 4,
      durationMs: 70,
      byClient: { claudeCode: 4, codex: 6 },
      feedback: {
        total: 5,
        helpful: 4,
        notHelpful: 1,
        misleading: 0,
        bySource: { claudeCode: 2, codex: 2, preview: 1 },
        byResult: {
          strong: { total: 3, helpful: 3, notHelpful: 0, misleading: 0 },
          possible: { total: 1, helpful: 0, notHelpful: 1, misleading: 0 },
          noMatch: { total: 1, helpful: 1, notHelpful: 0, misleading: 0 },
        },
      },
      recent: [],
      lastConsultedAt: "2026-08-03T10:00:00.000Z",
      privacy: {
        storesQuestionText: false,
        storesOptionText: false,
        storesPrincipleIds: false,
        storesFeedbackTokens: false,
        storesIndividualEvents: false,
      },
    });
    vi.mocked(api.previewDecisionConsultation).mockResolvedValue({
      consultationVersion: 1,
      requestId: "preview-1",
      status: "matched",
      generatedBy: "deterministic_local_match",
      feedback: {
        token: "preview-feedback-token",
        expiresAt: "2026-08-03T10:30:00.000Z",
      },
      matches: [
        {
          principleId: "principle-1",
          title: "先验证再扩大",
          principle: "先小范围验证关键边界，再扩大投入。",
          appliesWhen: "真实运行效果仍不明确时。",
          caution: "验证成本过高时重新评估。",
          confidence: "medium",
          evidenceCount: 2,
          relevanceScore: 38,
          relevance: "strong",
          reason: "适用条件与当前决策存在文本重合。",
          matchedTerms: ["验证", "边界"],
        },
      ],
      boundary: {
        advisoryOnly: true,
        noDecisionWritten: true,
        noPrincipleApplied: true,
      },
    });
    const user = userEvent.setup();

    render(<App api={api} />);

    const page = await screen.findByRole("region", { name: "方法论" });
    await user.click(within(page).getByRole("tab", { name: "分析" }));
    const totalMetric = (await within(page).findByText("决策总数"))
      .parentElement;
    expect(totalMetric).not.toBeNull();
    expect(within(totalMetric as HTMLElement).getByText("18")).toBeVisible();
    expect(within(page).getByText("83.3%")).toBeVisible();
    expect(within(page).getByText("预期与实际")).toBeVisible();
    expect(within(page).getByText("Decision")).toBeVisible();
    expect(within(page).getByText("Codex")).toBeVisible();
    expect(within(page).getByText(/本地聚合 v1 · SQLite 快照/u)).toBeVisible();
    expect(api.getDecisionAnalytics).toHaveBeenCalledOnce();
    expect(within(page).getByText(/已运行 10 次 · 5 次评价/u)).toBeVisible();
    expect(within(page).getByText("70%")).toBeVisible();
    expect(within(page).getByText("80%")).toBeVisible();
    expect(within(page).getByText(/不保存输入、令牌或单次记录/u)).toBeVisible();

    await user.click(within(page).getByRole("button", { name: "试算一次" }));
    const preview = await screen.findByRole("dialog", {
      name: "试算决策前核对",
    });
    await user.type(
      within(preview).getByRole("textbox", { name: "待决定的问题" }),
      "上线前是否先验证兼容边界？",
    );
    await user.type(
      within(preview).getByRole("textbox", { name: "候选选项 1" }),
      "先验证",
    );
    await user.click(
      within(preview).getByRole("button", { name: "查看实际结果" }),
    );
    expect(api.previewDecisionConsultation).toHaveBeenCalledWith({
      question: "上线前是否先验证兼容边界？",
      options: ["先验证"],
      context: null,
    });
    expect(await within(preview).findByText("先验证再扩大")).toBeVisible();
    expect(within(preview).getByText("强匹配 · 38")).toBeVisible();
    expect(within(preview).getByText(/不写入决策/u)).toBeVisible();
    await user.click(within(preview).getByRole("button", { name: "有帮助" }));
    expect(api.submitDecisionConsultationFeedback).toHaveBeenCalledWith({
      token: "preview-feedback-token",
      rating: "helpful",
    });
    expect(
      await within(preview).findByText(/已匿名计入质量校准/u),
    ).toBeVisible();
    await user.click(within(preview).getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog", { name: "试算决策前核对" })).toBeNull();

    await user.click(within(page).getByRole("button", { name: "刷新分析" }));
    expect(api.getDecisionAnalytics).toHaveBeenCalledTimes(2);
    expect(api.getDecisionConsultationMetrics).toHaveBeenCalledTimes(3);
  });

  it("generates, edits, and accepts a skill draft from accepted principles", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "methodology",
      }),
    );
    const principle = {
      id: "principle-accepted-1",
      createdAt: "2026-08-02T08:00:00.000Z",
      updatedAt: "2026-08-02T09:00:00.000Z",
      origin: "decision_evidence" as const,
      status: "accepted" as const,
      confirmedAt: "2026-08-02T09:00:00.000Z",
      title: "先验证再扩大",
      principle: "先通过可回退的小步改动验证效果，再扩大范围。",
      appliesWhen: "仍有关键未知项时。",
      caution: "双轨成本过高时重新评估。",
      evidenceSummary: "已复盘结果支持该原则。",
      sourceDecisionIds: ["decision-1"],
      sourceDecisions: [],
      confidence: "medium" as const,
      quality: methodologyQuality({
        evidenceCount: 0,
        missingEvidenceCount: 1,
        favorableEvidenceCount: 0,
        flags: ["missing_evidence", "single_evidence"],
      }),
      generation: {
        requestId: "methodology:1",
        profileId: "builtin-qwen",
        provider: "Qwen 本地模型",
        model: "qwen3.5-2b-q4-k-m",
      },
    };
    const draft = {
      id: "skill-1",
      slug: "decision-reversible-change",
      kind: "skill" as const,
      status: "candidate" as const,
      createdAt: "2026-08-03T08:00:00.000Z",
      updatedAt: "2026-08-03T08:00:00.000Z",
      acceptedAt: null,
      title: "可逆改动验证",
      summary: "用小步、可回退的改动验证仍有未知项的实现方向。",
      trigger: "需求边界或实际效果仍需要通过运行反馈确认时。",
      steps: ["明确关键假设。", "实施最小改动。", "记录实际结果。"],
      checks: ["改动能够独立回退。", "实际结果已经记录。"],
      fallback: "验证失败时回退本轮改动，并重新界定假设。",
      sourcePrincipleIds: [principle.id],
      supersedesId: null,
      freshness: {
        state: "current" as const,
        sourceCount: 1,
        updatedSourceCount: 0,
        missingSourceCount: 0,
        unacceptedSourceCount: 0,
        latestSourceUpdatedAt: principle.updatedAt,
        canRegenerate: true,
        message: "内容与当前已采纳原则一致。",
      },
      sourceChanges: [],
      sourcePrinciples: [
        {
          id: principle.id,
          updatedAt: principle.updatedAt,
          status: principle.status,
          title: principle.title,
          principle: principle.principle,
          appliesWhen: principle.appliesWhen,
          caution: principle.caution,
          confidence: principle.confidence,
        },
      ],
      generation: {
        requestId: "skill:1",
        profileId: "builtin-qwen",
        provider: "Qwen 本地模型",
        model: "qwen3.5-2b-q4-k-m",
      },
    };
    const manualDraft: PracticeAssetItem = {
      ...draft,
      id: "workflow-manual-1",
      slug: "manual-review-workflow",
      kind: "workflow",
      title: `${principle.title} · 工作流`,
      summary: "人工整理已采纳原则，不依赖模型生成。",
      trigger: principle.appliesWhen,
      steps: ["核对来源原则。", "执行并记录实际结果。"],
      checks: ["每一步都有可观察结果。"],
      fallback: principle.caution,
      generation: {
        requestId: "manual-workflow:1",
        profileId: "manual-practice-asset",
        provider: "人工创建",
        model: "不调用模型",
      },
    };
    let assetAccepted = false;
    let publishedToCodex = false;
    let assetChangedAfterPublication = false;
    vi.mocked(api.listPracticeAssets).mockResolvedValue([draft]);
    vi.mocked(api.listMethodologies).mockResolvedValue([principle]);
    vi.mocked(api.createManualPracticeAsset).mockResolvedValue(manualDraft);
    vi.mocked(api.generatePracticeAsset).mockResolvedValue(draft);
    vi.mocked(api.revisePracticeAsset).mockImplementation(
      async (_id, input) => {
        if (assetAccepted && publishedToCodex)
          assetChangedAfterPublication = true;
        return {
          ...draft,
          ...input,
          status: assetAccepted
            ? ("accepted" as const)
            : ("candidate" as const),
          acceptedAt: assetAccepted ? "2026-08-03T10:00:00.000Z" : null,
        };
      },
    );
    vi.mocked(api.setPracticeAssetStatus).mockImplementation(
      async (_id, status) => {
        assetAccepted = status === "accepted";
        return {
          ...draft,
          status,
          acceptedAt: status === "accepted" ? "2026-08-03T10:00:00.000Z" : null,
        };
      },
    );
    vi.mocked(api.listPracticePublicationStatuses).mockImplementation(
      async () => {
        const codexState = !publishedToCodex
          ? ("not_published" as const)
          : assetChangedAfterPublication
            ? ("update_available" as const)
            : ("up_to_date" as const);
        return [
          {
            target: "codex",
            targetLabel: "Codex",
            state: codexState,
            version: publishedToCodex ? 1 : null,
            publishedAt: publishedToCodex ? "2026-08-04T10:00:00.000Z" : null,
            canPublish: !publishedToCodex || assetChangedAfterPublication,
            canRollback: publishedToCodex,
            requiresOverwriteConfirmation: false,
            message: !publishedToCodex
              ? "尚未发布到此客户端"
              : assetChangedAfterPublication
                ? "Obsidian 中的内容已有更新"
                : "已是最新版本",
          },
          {
            target: "claude-code",
            targetLabel: "Claude Code",
            state: "occupied",
            version: null,
            publishedAt: null,
            canPublish: true,
            canRollback: false,
            requiresOverwriteConfirmation: true,
            message: "存在非 Decision 管理的同名技能，覆盖前需要确认",
          },
        ];
      },
    );
    vi.mocked(api.publishPracticeAsset).mockImplementation(
      async (_id, target) => {
        if (target === "codex") {
          publishedToCodex = true;
          assetChangedAfterPublication = false;
        }
        return {
          target,
          action: "published",
          version: 1,
          publishedAt: "2026-08-04T10:00:00.000Z",
          restoredPreviousContent: false,
        };
      },
    );
    vi.mocked(api.rollbackPracticeAssetPublication).mockImplementation(
      async (_id, target) => {
        publishedToCodex = false;
        return {
          target,
          action: "rolled_back",
          version: null,
          publishedAt: null,
          restoredPreviousContent: false,
        };
      },
    );
    const user = userEvent.setup();

    render(<App api={api} />);

    const page = await screen.findByRole("region", { name: "方法论" });
    await user.click(within(page).getByRole("tab", { name: "技能与流程" }));
    const assets = await within(page).findByRole("region", {
      name: "技能与流程",
    });
    expect(await within(assets).findByText("可逆改动验证")).toBeVisible();
    await user.click(
      within(assets).getByRole("button", { name: /可逆改动验证/u }),
    );
    let dialog = within(screen.getByRole("dialog", { name: "审核实践草案" }));
    await user.click(dialog.getByText("来源原则"));
    expect(dialog.getByText("先验证再扩大")).toBeVisible();
    expect(dialog.getByText(/发布只在明确确认后执行/u)).toBeVisible();

    await user.click(dialog.getByRole("button", { name: "编辑" }));
    const summary = dialog.getByRole("textbox", { name: "简介" });
    await user.clear(summary);
    await user.type(summary, "先验证可回退路径，再决定是否扩大范围。");
    await user.click(dialog.getByRole("button", { name: "保存修改" }));
    expect(api.revisePracticeAsset).toHaveBeenCalledWith(
      "skill-1",
      expect.objectContaining({
        summary: "先验证可回退路径，再决定是否扩大范围。",
      }),
    );

    dialog = within(screen.getByRole("dialog", { name: "审核实践草案" }));
    await user.click(dialog.getByRole("button", { name: "采纳草案" }));
    expect(api.setPracticeAssetStatus).toHaveBeenCalledWith(
      "skill-1",
      "accepted",
    );
    dialog = within(
      await screen.findByRole("dialog", { name: "技能与流程详情" }),
    );
    expect(await dialog.findByText("发布到客户端")).toBeVisible();
    expect(dialog.getByText("Codex")).toBeVisible();
    await user.click(dialog.getAllByRole("button", { name: "发布" })[0]!);
    expect(api.publishPracticeAsset).toHaveBeenCalledWith(
      "skill-1",
      "codex",
      false,
    );
    expect(await dialog.findByText("已是最新版本")).toBeVisible();
    await user.click(dialog.getByRole("button", { name: "编辑内容" }));
    const acceptedSummary = dialog.getByRole("textbox", { name: "简介" });
    await user.clear(acceptedSummary);
    await user.type(
      acceptedSummary,
      "加入发布后的实际反馈，再更新客户端版本。",
    );
    await user.click(dialog.getByRole("button", { name: "保存修改" }));
    expect(await dialog.findByText("Obsidian 中的内容已有更新")).toBeVisible();
    await user.click(dialog.getByRole("button", { name: "更新" }));
    expect(api.publishPracticeAsset).toHaveBeenLastCalledWith(
      "skill-1",
      "codex",
      false,
    );
    expect(await dialog.findByText("已是最新版本")).toBeVisible();
    await user.click(dialog.getByRole("button", { name: "回滚" }));
    expect(dialog.getByText("回滚最近一次发布？")).toBeVisible();
    await user.click(dialog.getByRole("button", { name: "确认回滚" }));
    expect(api.rollbackPracticeAssetPublication).toHaveBeenCalledWith(
      "skill-1",
      "codex",
    );
    await user.click(dialog.getByRole("button", { name: "处理冲突" }));
    expect(dialog.getByText("覆盖客户端现有内容？")).toBeVisible();
    await user.click(dialog.getByRole("button", { name: "确认覆盖" }));
    expect(api.publishPracticeAsset).toHaveBeenCalledWith(
      "skill-1",
      "claude-code",
      true,
    );
    await user.click(
      screen.getByRole("button", { name: "关闭技能与流程详情" }),
    );

    await user.click(within(page).getByRole("button", { name: "新建草案" }));
    const chooser = within(
      screen.getByRole("dialog", { name: "新建技能或工作流" }),
    );
    await user.click(chooser.getByRole("button", { name: /^工作流/u }));
    await user.click(
      await chooser.findByRole("checkbox", { name: /先验证再扩大/u }),
    );
    expect(chooser.getByText("人工编写不调用模型")).toBeVisible();
    expect(chooser.getByText("模型生成会发起 1 次调用")).toBeVisible();
    await user.click(chooser.getByRole("button", { name: "手动编写" }));

    const manualEditor = within(
      screen.getByRole("dialog", { name: "人工编写工作流草案" }),
    );
    expect(manualEditor.getByRole("textbox", { name: "标题" })).toHaveValue(
      "先验证再扩大 · 工作流",
    );
    expect(manualEditor.getByRole("textbox", { name: "使用条件" })).toHaveValue(
      principle.appliesWhen,
    );
    expect(manualEditor.getByRole("textbox", { name: "失败处理" })).toHaveValue(
      principle.caution,
    );
    await user.type(
      manualEditor.getByRole("textbox", { name: "简介" }),
      manualDraft.summary,
    );
    fireEvent.change(
      manualEditor.getByRole("textbox", {
        name: "操作步骤（每行一项，2–12 项）",
      }),
      { target: { value: manualDraft.steps.join("\n") } },
    );
    fireEvent.change(
      manualEditor.getByRole("textbox", {
        name: "验收检查（每行一项，1–8 项）",
      }),
      { target: { value: manualDraft.checks.join("\n") } },
    );
    await user.click(
      manualEditor.getByRole("button", { name: "保存为待确认草案" }),
    );
    expect(api.createManualPracticeAsset).toHaveBeenCalledWith(
      "workflow",
      [principle.id],
      expect.objectContaining({
        title: manualDraft.title,
        summary: manualDraft.summary,
        steps: manualDraft.steps,
        checks: manualDraft.checks,
      }),
    );
    expect(api.generatePracticeAsset).not.toHaveBeenCalled();
    const manualDetail = within(
      await screen.findByRole("dialog", { name: "审核实践草案" }),
    );
    expect(
      manualDetail.getByText(
        (_content, element) =>
          element?.tagName === "SMALL" &&
          element.textContent?.includes("人工创建 · 不调用模型") === true,
      ),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "关闭审核实践草案" }));

    await user.click(within(page).getByRole("button", { name: "新建草案" }));
    const modelChooser = within(
      screen.getByRole("dialog", { name: "新建技能或工作流" }),
    );
    await user.click(modelChooser.getByRole("button", { name: /^工作流/u }));
    await user.click(
      await modelChooser.findByRole("checkbox", { name: /先验证再扩大/u }),
    );
    await user.click(
      modelChooser.getByRole("button", { name: "调用模型生成工作流" }),
    );
    expect(api.generatePracticeAsset).toHaveBeenCalledWith("workflow", [
      "principle-accepted-1",
    ]);
  });

  it("regenerates an accepted asset after its source changes without touching the published version", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "methodology",
      }),
    );
    const source = {
      id: "principle-updated-1",
      updatedAt: "2026-08-05T09:00:00.000Z",
      status: "accepted" as const,
      title: "先验证再扩大",
      principle: "先验证最新约束，再扩大改动范围。",
      appliesWhen: "来源原则发生变化时。",
      caution: "不要静默覆盖已经发布的实践。",
      confidence: "high" as const,
    };
    const accepted: PracticeAssetItem = {
      id: "skill-stable-1",
      slug: "decision-reversible-change",
      kind: "skill",
      status: "accepted",
      createdAt: "2026-08-03T08:00:00.000Z",
      updatedAt: "2026-08-04T08:00:00.000Z",
      acceptedAt: "2026-08-04T08:00:00.000Z",
      title: "可逆改动验证",
      summary: "旧版已采纳内容仍在使用。",
      trigger: "关键约束仍需验证时。",
      steps: ["明确假设。", "实施最小改动。"],
      checks: ["改动可以回退。"],
      fallback: "失败时恢复旧版。",
      sourcePrincipleIds: [source.id],
      supersedesId: null,
      freshness: {
        state: "sources_updated",
        sourceCount: 1,
        updatedSourceCount: 1,
        missingSourceCount: 0,
        unacceptedSourceCount: 0,
        latestSourceUpdatedAt: source.updatedAt,
        canRegenerate: true,
        message: "1 条来源原则在此资产之后更新，需要重新生成或编辑确认。",
      },
      sourceChanges: [
        {
          id: source.id,
          title: source.title,
          state: "updated",
          previousUpdatedAt: "2026-08-02T09:00:00.000Z",
          currentUpdatedAt: source.updatedAt,
          fields: [
            {
              field: "principle",
              before: "先通过可回退的小步改动验证效果，再扩大范围。",
              after: source.principle,
            },
          ],
        },
      ],
      sourcePrinciples: [source],
      generation: {
        requestId: "skill:old",
        profileId: "builtin-qwen",
        provider: "Qwen 本地模型",
        model: "qwen3.5-2b-q4-k-m",
      },
    };
    const replacement: PracticeAssetItem = {
      ...accepted,
      id: "skill-replacement-1",
      status: "candidate",
      acceptedAt: null,
      updatedAt: "2026-08-05T10:00:00.000Z",
      title: "可逆改动验证（新草案）",
      summary: "根据最新来源重新生成，尚未影响原资产。",
      supersedesId: accepted.id,
      freshness: {
        ...accepted.freshness,
        state: "current",
        updatedSourceCount: 0,
        message: "内容与当前已采纳原则一致。",
      },
      generation: {
        ...accepted.generation,
        requestId: "skill:replacement",
      },
    };
    const applied: PracticeAssetItem = {
      ...replacement,
      id: accepted.id,
      slug: accepted.slug,
      status: "accepted",
      acceptedAt: "2026-08-05T10:30:00.000Z",
      supersedesId: null,
    };
    let regenerated = false;
    let replacementApplied = false;
    vi.mocked(api.listPracticeAssets).mockImplementation(async (status) => {
      if (status === "accepted") return [accepted];
      if (status === "candidate" && regenerated) return [replacement];
      return [];
    });
    vi.mocked(api.regeneratePracticeAsset).mockImplementation(async () => {
      regenerated = true;
      return replacement;
    });
    vi.mocked(api.setPracticeAssetStatus).mockImplementation(async () => {
      replacementApplied = true;
      return applied;
    });
    vi.mocked(api.listPracticeAssetVersions).mockImplementation(async () =>
      replacementApplied
        ? [
            {
              version: 1,
              capturedAt: "2026-08-05T10:30:00.000Z",
              reason: "replacement_applied",
              snapshot: {
                updatedAt: accepted.updatedAt,
                title: accepted.title,
                summary: accepted.summary,
                trigger: accepted.trigger,
                steps: accepted.steps,
                checks: accepted.checks,
                fallback: accepted.fallback,
                sourcePrincipleIds: accepted.sourcePrincipleIds,
              },
            },
          ]
        : [],
    );
    vi.mocked(api.restorePracticeAssetVersion).mockResolvedValue({
      ...accepted,
      updatedAt: "2026-08-05T11:00:00.000Z",
    });
    vi.mocked(api.listPracticePublicationStatuses).mockResolvedValue([
      {
        target: "codex",
        targetLabel: "Codex",
        state: "up_to_date",
        version: 3,
        publishedAt: "2026-08-04T09:00:00.000Z",
        canPublish: false,
        canRollback: true,
        requiresOverwriteConfirmation: false,
        message: "客户端仍保留最近一次确认发布的版本",
      },
    ]);
    const user = userEvent.setup();

    render(<App api={api} />);

    const page = await screen.findByRole("region", { name: "方法论" });
    await user.click(within(page).getByRole("tab", { name: "技能与流程" }));
    const assets = await within(page).findByRole("region", {
      name: "技能与流程",
    });
    await user.click(within(page).getByRole("button", { name: "已采纳" }));
    expect(await within(assets).findByText("来源已更新")).toBeVisible();
    await user.click(
      within(assets).getByRole("button", { name: /可逆改动验证/u }),
    );

    let dialog = within(
      await screen.findByRole("dialog", { name: "技能与流程详情" }),
    );
    expect(dialog.getByText(/新发布已暂停/u)).toBeVisible();
    expect(dialog.getByText("原则内容")).toBeVisible();
    expect(
      dialog.getByText("先通过可回退的小步改动验证效果，再扩大范围。"),
    ).toBeVisible();
    expect(dialog.getAllByText(source.principle)[0]).toBeVisible();
    expect(dialog.getByRole("button", { name: "已发布" })).toBeDisabled();
    expect(dialog.getByRole("button", { name: "回滚" })).toBeEnabled();
    await user.click(dialog.getByRole("button", { name: "重新生成新草案" }));
    expect(api.regeneratePracticeAsset).toHaveBeenCalledWith(accepted.id);

    dialog = within(
      await screen.findByRole("dialog", { name: "审核实践草案" }),
    );
    expect(dialog.getByText("这是替换草案")).toBeVisible();
    expect(dialog.getByText(/当前客户端内容仍保持不变/u)).toBeVisible();
    await user.click(dialog.getByRole("button", { name: "应用到原资产" }));
    expect(api.setPracticeAssetStatus).toHaveBeenCalledWith(
      replacement.id,
      "accepted",
    );
    expect(
      await screen.findByRole("dialog", { name: "技能与流程详情" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(api.listPracticePublicationStatuses).toHaveBeenLastCalledWith(
        accepted.id,
      ),
    );
    dialog = within(screen.getByRole("dialog", { name: "技能与流程详情" }));
    await user.click(dialog.getByText("资产版本"));
    await user.click(await dialog.findByRole("button", { name: /版本 1/u }));
    expect(dialog.getByText("应用新草案前")).toBeVisible();
    await user.click(dialog.getByRole("button", { name: "恢复此版本" }));
    expect(dialog.getByText("恢复版本 1？")).toBeVisible();
    await user.click(dialog.getByRole("button", { name: "确认恢复" }));
    expect(api.restorePracticeAssetVersion).toHaveBeenCalledWith(
      accepted.id,
      1,
    );
  });

  it("manages capture clients on a dedicated page", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "clients",
        integrationStatus: {
          claudeCode: "installed",
          codex: "not-installed",
        },
      }),
    );
    vi.mocked(api.installIntegrations).mockResolvedValue({
      mode: "apply",
      targets: [],
      commands: [],
      restartRequired: false,
    });
    const user = userEvent.setup();

    render(<App api={api} />);

    const page = await screen.findByRole("region", { name: "接入" });
    expect(
      within(page).getByRole("heading", { name: "Claude Code" }),
    ).toBeVisible();
    expect(within(page).getByRole("heading", { name: "Codex" })).toBeVisible();
    expect(within(page).getByText("已连接")).toBeVisible();
    expect(within(page).getByText("未连接")).toBeVisible();
    expect(within(page).getAllByText("决策前核对")).toHaveLength(2);
    expect(within(page).getAllByText("只读 · 不替你选择")).toHaveLength(2);
    expect(within(page).getByText(/给出选项前读取相关原则/u)).toBeVisible();

    await user.click(within(page).getByRole("button", { name: "安装或修复" }));
    expect(api.installIntegrations).toHaveBeenCalledWith("apply");
    expect(await within(page).findByText("接入已安装或修复。")).toBeVisible();
  });

  it("adds a remote model backend without retaining its one-time API key", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "models",
      }),
    );
    const savedProfile = {
      version: 1 as const,
      profileId: "remote-openai",
      kind: "openai" as const,
      label: "OpenAI",
      enabled: true,
      priority: 40,
      model: "gpt-5-mini",
      timeoutMs: 30_000,
      baseUrl: "https://api.openai.com",
      apiProtocol: "responses" as const,
      credentialConfigured: true,
    };
    vi.mocked(api.listModelProviderProfiles).mockResolvedValue([]);
    vi.mocked(api.saveModelProviderProfile).mockResolvedValue(savedProfile);
    const user = userEvent.setup();

    render(<App api={api} />);

    const panel = await screen.findByRole("region", {
      name: "模型后端",
    });
    const addButton = within(panel).getByRole("button", {
      name: "添加模型后端",
    });
    expect(addButton).toHaveAttribute("aria-expanded", "false");
    await user.click(addButton);
    expect(addButton).toHaveAttribute("aria-expanded", "true");
    const addDialog = within(
      screen.getByRole("dialog", { name: "添加模型后端" }),
    );
    expect(
      addDialog.getByRole("form", { name: "添加模型后端表单" }),
    ).toBeVisible();
    expect(addDialog.getByLabelText("后端类型")).toHaveFocus();
    await user.selectOptions(addDialog.getByLabelText("后端类型"), "openai");
    await user.type(addDialog.getByLabelText("模型"), "gpt-5-mini");
    await user.type(addDialog.getByLabelText("API 密钥"), "sk-private");
    await user.click(
      addDialog.getByRole("button", {
        name: "保存后端",
      }),
    );

    expect(api.saveModelProviderProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({
          kind: "openai",
          model: "gpt-5-mini",
        }),
        secret: "sk-private",
      }),
    );
    expect(screen.queryByDisplayValue("sk-private")).not.toBeInTheDocument();
  });

  it("manages provider order, state, tests, edits, deletion, and URL validation", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "models",
      }),
    );
    const apple = {
      version: 1 as const,
      profileId: "builtin-apple",
      kind: "apple" as const,
      label: "Apple Foundation Models",
      enabled: true,
      priority: 0,
      model: "system-language-model",
      timeoutMs: 5_000,
      credentialConfigured: false,
    };
    const openai = {
      version: 1 as const,
      profileId: "remote-openai",
      kind: "openai" as const,
      label: "OpenAI",
      enabled: true,
      priority: 10,
      model: "gpt-5-mini",
      timeoutMs: 30_000,
      baseUrl: "https://api.openai.com",
      apiProtocol: "responses" as const,
      credentialConfigured: true,
    };
    vi.mocked(api.listModelProviderProfiles).mockResolvedValue([apple, openai]);
    vi.mocked(api.saveModelProviderProfile).mockImplementation(
      async (value) => value.profile,
    );
    vi.mocked(api.testModelProviderProfile).mockResolvedValue({
      ok: true,
      profileId: "remote-openai",
      latencyMs: 42,
      requestId: "health-check-1",
      modelVersion: "gpt-5-mini",
      tokenSource: "provider_reported",
    });
    vi.mocked(api.deleteModelProviderProfile).mockResolvedValue(true);
    const user = userEvent.setup();

    render(<App api={api} />);

    const panel = await screen.findByRole("region", {
      name: "模型后端",
    });
    expect(await within(panel).findByText("OpenAI")).toBeVisible();

    await user.click(
      within(panel).getByRole("switch", {
        name: "启用 OpenAI",
      }),
    );
    expect(api.saveModelProviderProfile).toHaveBeenCalledWith({
      profile: { ...openai, enabled: false },
    });

    const openAiDragHandle = within(panel).getByRole("button", {
      name: /拖拽排序 OpenAI/u,
    });
    const dragHandle = within(panel).getByRole("button", {
      name: /拖拽排序 Apple Foundation Models/u,
    });
    const openAiRow = openAiDragHandle.closest("li");
    const transferredData = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "none",
      dropEffect: "none",
      setData: vi.fn((type: string, value: string) => {
        transferredData.set(type, value);
      }),
      getData: vi.fn((type: string) => transferredData.get(type) ?? ""),
    };
    expect(dragHandle).toHaveAttribute("draggable", "true");
    expect(
      within(panel).queryByRole("button", { name: /上移|下移/u }),
    ).toBeNull();
    expect(openAiRow).not.toBeNull();
    vi.spyOn(openAiRow!, "getBoundingClientRect").mockReturnValue({
      bottom: 0,
      height: 0,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.dragStart(dragHandle, { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      "text/plain",
      "builtin-apple",
    );
    fireEvent.dragOver(openAiRow!, { clientY: 10, dataTransfer });
    fireEvent.drop(openAiRow!, { clientY: 10, dataTransfer });
    expect(dataTransfer.getData).toHaveBeenCalledWith("text/plain");
    await waitFor(() => {
      expect(api.reorderModelProviderProfiles).toHaveBeenCalledWith([
        "remote-openai",
        "builtin-apple",
      ]);
    });

    await user.click(
      within(panel).getByRole("button", {
        name: "测试 OpenAI",
      }),
    );
    expect(
      await within(panel).findByText(/测试通过.*42 ms.*gpt-5-mini/u),
    ).toBeVisible();

    await user.click(
      within(panel).getByRole("button", {
        name: "编辑 OpenAI",
      }),
    );
    const editDialog = within(
      screen.getByRole("dialog", { name: "编辑 OpenAI" }),
    );
    expect(editDialog.getByLabelText("API 密钥")).toHaveValue("");
    expect(editDialog.getByText("已安全保存，留空则不更换")).toBeVisible();
    await user.click(
      editDialog.getByRole("button", {
        name: "取消编辑",
      }),
    );

    await user.click(
      within(panel).getByRole("button", {
        name: "删除 OpenAI",
      }),
    );
    await user.click(
      within(panel).getByRole("button", {
        name: "确认删除 OpenAI",
      }),
    );
    expect(api.deleteModelProviderProfile).toHaveBeenCalledWith(
      "remote-openai",
    );

    await user.click(
      within(panel).getByRole("button", {
        name: "添加模型后端",
      }),
    );
    const compatibleDialog = within(
      screen.getByRole("dialog", { name: "添加模型后端" }),
    );
    await user.selectOptions(
      compatibleDialog.getByLabelText("后端类型"),
      "openai-compatible",
    );
    await user.clear(compatibleDialog.getByLabelText("服务地址"));
    await user.type(
      compatibleDialog.getByLabelText("服务地址"),
      "http://models.example.com",
    );
    await user.type(compatibleDialog.getByLabelText("模型"), "local-model");
    await user.type(
      compatibleDialog.getByLabelText("API 密钥"),
      "local-secret",
    );
    await user.click(
      compatibleDialog.getByRole("button", {
        name: "保存后端",
      }),
    );
    expect(compatibleDialog.getByRole("alert")).toHaveTextContent(
      "HTTPS 或本机回环地址",
    );
  });

  it("shows the concrete failure reason returned by a model backend test", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "models",
      }),
    );
    const openai = {
      version: 1 as const,
      profileId: "remote-openai",
      kind: "openai" as const,
      label: "OpenAI",
      enabled: false,
      priority: 0,
      model: "gpt-5-mini",
      timeoutMs: 30_000,
      baseUrl: "https://api.openai.com",
      apiProtocol: "responses" as const,
      credentialConfigured: true,
    };
    vi.mocked(api.listModelProviderProfiles).mockResolvedValue([openai]);
    vi.mocked(api.testModelProviderProfile).mockResolvedValue({
      ok: false,
      profileId: "remote-openai",
      latencyMs: 83,
      requestId: "health-check-failed",
      errorCode: "authentication_failed",
      diagnosticExcerpt: "HTTP 401：API 密钥无效",
      providerRequestId: "provider-request-401",
    });
    const user = userEvent.setup();

    render(<App api={api} />);

    const panel = await screen.findByRole("region", {
      name: "模型后端",
    });
    await user.click(
      await within(panel).findByRole("button", {
        name: "测试 OpenAI",
      }),
    );

    const result = await within(panel).findByRole("status", {
      name: "OpenAI 测试失败",
    });
    expect(result).toHaveTextContent("测试失败 · 认证失败 · 83 ms");
    expect(result).toHaveTextContent("HTTP 401：API 密钥无效");
    expect(result).toHaveTextContent("请求 ID：provider-request-401");
  });

  it("describes Qwen output exhaustion as a length limit", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "models",
      }),
    );
    const qwen = {
      version: 1 as const,
      profileId: "builtin-qwen",
      kind: "qwen" as const,
      label: "Qwen 本地模型",
      enabled: true,
      priority: 0,
      model: "qwen3.5-2b-q4-k-m",
      timeoutMs: 5_000,
      credentialConfigured: false,
    };
    vi.mocked(api.listModelProviderProfiles).mockResolvedValue([qwen]);
    vi.mocked(api.testModelProviderProfile).mockResolvedValue({
      ok: false,
      profileId: "builtin-qwen",
      latencyMs: 719,
      requestId: "qwen-health-check",
      errorCode: "output_limit",
      diagnosticExcerpt:
        "Qwen output reached the 512-token limit before completing valid JSON",
    });
    const user = userEvent.setup();

    render(<App api={api} />);

    const panel = await screen.findByRole("region", {
      name: "模型后端",
    });
    await user.click(
      await within(panel).findByRole("button", {
        name: "测试 Qwen 本地模型",
      }),
    );

    const result = await within(panel).findByRole("status", {
      name: "Qwen 本地模型 测试失败",
    });
    expect(result).toHaveTextContent("测试失败 · 输出达到长度上限 · 719 ms");
  });

  it("does not expose the internal unavailable token source after a successful Qwen test", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "models",
      }),
    );
    const qwen = {
      version: 1 as const,
      profileId: "builtin-qwen",
      kind: "qwen" as const,
      label: "Qwen 本地模型",
      enabled: true,
      priority: 0,
      model: "qwen3.5-2b-q4-k-m",
      timeoutMs: 5_000,
      credentialConfigured: false,
    };
    vi.mocked(api.listModelProviderProfiles).mockResolvedValue([qwen]);
    vi.mocked(api.testModelProviderProfile).mockResolvedValue({
      ok: true,
      profileId: "builtin-qwen",
      latencyMs: 719,
      requestId: "qwen-health-check",
      modelVersion: "qwen3.5-2b-q4-k-m",
      tokenSource: "unavailable",
    });
    const user = userEvent.setup();

    render(<App api={api} />);

    const panel = await screen.findByRole("region", {
      name: "模型后端",
    });
    await user.click(
      await within(panel).findByRole("button", {
        name: "测试 Qwen 本地模型",
      }),
    );

    const result = await within(panel).findByRole("status", {
      name: "Qwen 本地模型 测试通过",
    });
    expect(result).toHaveTextContent(
      "测试通过 · 719 ms · qwen3.5-2b-q4-k-m · Token 统计未提供",
    );
    expect(result).not.toHaveTextContent("unavailable");
  });

  it("shows detected Codex and Claude Code client readiness and enables them without losing the path", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "models",
      }),
    );
    const codex = {
      version: 1 as const,
      profileId: "builtin-codex",
      kind: "codex-cli" as const,
      label: "Codex CLI",
      enabled: false,
      priority: 20,
      timeoutMs: 30_000,
      credentialConfigured: false,
    };
    const claude = {
      version: 1 as const,
      profileId: "builtin-claude-code",
      kind: "claude-code-cli" as const,
      label: "Claude Code CLI",
      enabled: false,
      priority: 30,
      timeoutMs: 30_000,
      credentialConfigured: false,
    };
    vi.mocked(api.listModelProviderProfiles).mockResolvedValue([codex, claude]);
    vi.mocked(api.listLocalModelClientStatuses).mockResolvedValue([
      {
        kind: "codex-cli",
        executablePath: "/opt/homebrew/bin/codex",
        version: "0.146.0",
        authenticated: true,
        supported: true,
        availability: "available",
        checkedAt: "2026-07-30T00:00:00.000Z",
      },
      {
        kind: "claude-code-cli",
        executablePath: "/Users/demo/.volta/bin/claude",
        version: "2.1.220",
        authenticated: true,
        supported: true,
        availability: "available",
        checkedAt: "2026-07-30T00:00:00.000Z",
      },
    ]);
    vi.mocked(api.saveModelProviderProfile).mockImplementation(
      async (value) => value.profile,
    );
    const user = userEvent.setup();

    render(<App api={api} />);

    const panel = await screen.findByRole("region", {
      name: "模型后端",
    });
    expect(await within(panel).findByText("Codex CLI")).toBeVisible();
    expect(within(panel).getByText("Claude Code CLI")).toBeVisible();
    expect(within(panel).getByText("v0.146.0")).toBeVisible();
    expect(within(panel).getByText("v2.1.220")).toBeVisible();
    expect(within(panel).getAllByText("已登录，可用")).toHaveLength(2);

    await user.click(
      within(panel).getByRole("button", {
        name: "测试 Codex CLI",
      }),
    );
    expect(api.testModelProviderProfile).toHaveBeenCalledWith("builtin-codex");

    await user.click(
      within(panel).getByRole("switch", {
        name: "启用 Claude Code CLI",
      }),
    );
    expect(api.saveModelProviderProfile).toHaveBeenCalledWith({
      profile: {
        ...claude,
        enabled: true,
        executablePath: "/Users/demo/.volta/bin/claude",
      },
    });

    await user.click(
      within(panel).getByRole("button", {
        name: "配置 Codex CLI",
      }),
    );
    const cliDialog = within(
      screen.getByRole("dialog", { name: "配置 Codex CLI" }),
    );
    const pathInput = cliDialog.getByLabelText("客户端路径");
    expect(pathInput).toHaveValue("/opt/homebrew/bin/codex");
    await user.clear(pathInput);
    await user.type(pathInput, "relative/codex");
    await user.click(
      cliDialog.getByRole("button", {
        name: "保存客户端",
      }),
    );
    expect(cliDialog.getByRole("alert")).toHaveTextContent("绝对路径");
    await user.clear(pathInput);
    await user.type(pathInput, "/custom/bin/codex");
    await user.type(cliDialog.getByLabelText("客户端模型"), "gpt-5.6-terra");
    await user.click(
      cliDialog.getByRole("button", {
        name: "保存客户端",
      }),
    );
    expect(api.saveModelProviderProfile).toHaveBeenLastCalledWith({
      profile: {
        ...codex,
        executablePath: "/custom/bin/codex",
        model: "gpt-5.6-terra",
      },
    });
  });

  it("shows model profiles without waiting for slow local client discovery", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "models",
      }),
    );
    const codex = {
      version: 1 as const,
      profileId: "builtin-codex",
      kind: "codex-cli" as const,
      label: "Codex CLI",
      enabled: true,
      priority: 20,
      timeoutMs: 30_000,
      credentialConfigured: false,
    };
    let resolveStatuses:
      | ((
          value: Awaited<
            ReturnType<DecisionApi["listLocalModelClientStatuses"]>
          >,
        ) => void)
      | undefined;
    const statuses = new Promise<
      Awaited<ReturnType<DecisionApi["listLocalModelClientStatuses"]>>
    >((resolve) => {
      resolveStatuses = resolve;
    });
    vi.mocked(api.listModelProviderProfiles).mockResolvedValue([codex]);
    vi.mocked(api.listLocalModelClientStatuses).mockReturnValue(statuses);

    render(<App api={api} />);

    const panel = await screen.findByRole("region", {
      name: "模型后端",
    });
    expect(await within(panel).findByText("Codex CLI")).toBeVisible();
    expect(within(panel).getByText("正在检查客户端…")).toBeVisible();

    resolveStatuses?.([
      {
        kind: "codex-cli",
        executablePath: "/opt/homebrew/bin/codex",
        version: "0.146.0",
        authenticated: true,
        supported: true,
        availability: "available",
        checkedAt: "2026-07-30T00:00:00.000Z",
      },
    ]);

    expect(await within(panel).findByText("已登录，可用")).toBeVisible();
  });

  it("inspects, deletes, and disables future model trace content", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "activity",
        modelTraceContentEnabled: true,
      }),
      [modelTraceFixture()],
    );
    const user = userEvent.setup();

    render(<App api={api} />);

    const activity = await screen.findByRole("region", {
      name: "日志",
    });
    expect(
      within(activity).getByRole("heading", { name: "识别概览" }),
    ).toBeVisible();
    expect(within(activity).getByText("处理轮次")).toBeVisible();
    expect(within(activity).getByText("直接捕获")).toBeVisible();

    const panel = await screen.findByRole("region", {
      name: "模型调用记录",
    });
    const trace = within(panel);
    expect(trace.getByRole("heading", { name: "模型调用记录" })).toBeVisible();
    expect(await trace.findByText("Qwen 本地模型")).toBeVisible();
    expect(trace.getByText("54 tokens")).toBeVisible();
    expect(
      trace.getByRole("list", { name: "模型调用记录列表" }),
    ).toHaveAttribute("tabindex", "0");

    await user.click(trace.getByRole("button", { name: "查看调用详情" }));
    const detailsDialog = within(
      screen.getByRole("dialog", { name: "Qwen 本地模型 调用详情" }),
    );
    expect(detailsDialog.getByText("模型输入")).toBeVisible();
    expect(detailsDialog.getByText("模型输出")).toBeVisible();

    await user.click(
      detailsDialog.getByRole("button", { name: "删除这条记录" }),
    );
    expect(api.deleteModelTrace).toHaveBeenCalledWith("trace-1");

    await user.click(
      trace.getByRole("checkbox", {
        name: /记录模型输入和输出/u,
      }),
    );
    expect(api.setModelTraceContentEnabled).toHaveBeenCalledWith(false);
  });

  it("describes a missing token count without implying that the model failed", async () => {
    const traceWithoutTokenCount: ModelInvocationTrace = {
      ...modelTraceFixture(),
      usage: { source: "unavailable" },
    };
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "activity",
      }),
      [traceWithoutTokenCount],
    );

    render(<App api={api} />);

    const panel = await screen.findByRole("region", {
      name: "模型调用记录",
    });
    expect(await within(panel).findByText("Token 统计未提供")).toBeVisible();
    expect(within(panel).queryByText("Token 不可用")).not.toBeInTheDocument();
  });

  it("shows a friendly output-limit label in model trace details", async () => {
    const outputLimitedTrace: ModelInvocationTrace = {
      ...modelTraceFixture(),
      status: "invalid_output",
      errorCode: "output_limit",
      diagnosticExcerpt:
        "Qwen output reached the 512-token limit before completing valid JSON",
      usage: {
        source: "runtime_measured",
        inputTokens: 580,
        outputTokens: 512,
        totalTokens: 1_092,
      },
    };
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "activity",
      }),
      [outputLimitedTrace],
    );
    const user = userEvent.setup();

    render(<App api={api} />);

    const panel = await screen.findByRole("region", {
      name: "模型调用记录",
    });
    await user.click(
      await within(panel).findByRole("button", {
        name: "查看调用详情",
      }),
    );
    expect(
      within(
        screen.getByRole("dialog", { name: "Qwen 本地模型 调用详情" }),
      ).getByText("输出达到长度上限"),
    ).toBeVisible();
  });

  it("does not describe Apple model eligibility as unsupported hardware", async () => {
    const base = rationaleSnapshot({
      current: null,
      primarySurface: "models",
    });
    const { api } = apiFixture({
      ...base,
      semanticRecognition: {
        ...base.semanticRecognition,
        provider: "rules",
        providerLabel: "规则识别",
        availability: "device_not_eligible",
      },
    });

    render(<App api={api} />);

    const card = await screen.findByRole("region", {
      name: "模型",
    });
    expect(within(card).getByText("Apple 智能当前不可用")).toBeVisible();
    expect(card).not.toHaveTextContent("设备不支持");
  });

  it("describes runtime unavailability as an automatic retry", async () => {
    const base = rationaleSnapshot({
      current: null,
      primarySurface: "models",
    });
    const { api } = apiFixture({
      ...base,
      semanticRecognition: {
        ...base.semanticRecognition,
        provider: "rules",
        providerLabel: "规则识别",
        availability: "runtime_unavailable",
      },
    });

    render(<App api={api} />);

    const card = await screen.findByRole("region", {
      name: "模型",
    });
    expect(within(card).getByText("暂时不可用，将自动重试")).toBeVisible();
  });

  it("opens candidate review from the decision center", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "dashboard",
        decisionCandidates: {
          current: reviewCandidate(),
          count: 3,
        },
      }),
    );
    const user = userEvent.setup();

    render(<App api={api} />);

    expect(
      await screen.findByRole("region", {
        name: "首页",
      }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "开始处理" }));
    expect(api.openCandidateReview).toHaveBeenCalledOnce();
  });

  it("shows rationale recovery corruption in the decision center", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "dashboard",
        health: {
          index: "healthy",
          recovery: "degraded",
          recoveryMessage:
            "理由恢复日志损坏，已隔离；原始决策仍保留在待处理队列。",
        },
      }),
    );

    render(<App api={api} />);

    expect(await screen.findByText(/理由恢复日志损坏/u)).toBeVisible();
    expect(screen.queryByText("SQLite 健康")).toBeNull();
  });

  it("keeps failed persistence visible and allows retry", async () => {
    const current = {
      ...candidate(),
      status: "completed" as const,
    };
    const { api } = apiFixture(
      rationaleSnapshot({
        current,
        persistenceStatus: "failed",
      }),
    );
    const user = userEvent.setup();
    render(<App api={api} />);

    expect(
      await screen.findByText(/原生答案和理由仍保留在内存中/u),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "重试保存" }));

    expect(api.retryPersistence).toHaveBeenCalledOnce();
  });

  it("shows and changes the persisted appearance preference", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "settings",
        theme: "auto",
      }),
    );
    const user = userEvent.setup();
    render(<App api={api} />);

    expect(await screen.findByRole("button", { name: "自动" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "浅色" }));

    expect(api.setTheme).toHaveBeenCalledWith("light");
  });
});
