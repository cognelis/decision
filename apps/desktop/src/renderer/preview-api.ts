import type {
  KnowledgeGraphSnapshot,
  RationaleCandidate,
} from "@cognelis/decision-core";
import type {
  CapturedDecisionCandidate,
  ModelInvocationTrace,
} from "@cognelis/decision-protocol";

import {
  THEME_PREFERENCES,
  type ThemePreference,
} from "../shared/appearance.js";
import type {
  AppSnapshot,
  DecisionApi,
  ManualFormDraft,
} from "../shared/renderer-api.js";

const candidate = (
  overrides: Partial<RationaleCandidate> = {},
): RationaleCandidate => {
  const question = {
    questionIndex: 0,
    header: "Storage",
    question: "这个功能应该采用哪种持久化方式？",
    options: [
      {
        id: "markdown-sqlite",
        label: "Markdown + SQLite",
        description: "兼顾人类可读、版本管理与本地全文检索。",
      },
      {
        id: "sqlite-only",
        label: "只用 SQLite",
        description: "结构化查询直接，但日常阅读不够自然。",
      },
    ],
    answer: {
      kind: "preset" as const,
      values: ["Markdown + SQLite"],
    },
    multiSelect: false,
  };
  return {
    status: "awaiting_rationale",
    candidateId: "preview-candidate",
    candidateKey: "preview-key",
    event: {
      eventVersion: 1,
      captureMode: "structured_tool",
      sourceClient: "codex",
      sessionId: "preview-session",
      batchId: "preview:batch-1",
      project: "decision",
      cwd: "/workspace/decision",
      capturedAt: "2026-07-25T00:00:00.000Z",
      questions: [question],
    },
    question,
    ...overrides,
  };
};

const reviewCandidate = (): CapturedDecisionCandidate => {
  const rationale = candidate();
  return {
    candidateVersion: 1,
    candidateId: "preview-review",
    createdAt: "2026-07-28T00:00:00.000Z",
    expiresAt: "2026-08-04T00:00:00.000Z",
    event: {
      ...rationale.event,
      captureMode: "transcript",
      detection: {
        band: "medium",
        score: 65,
        detectorVersion: "rules-v1",
        signals: ["awaits_confirmation"],
      },
      context: {
        taskBackground:
          "继续开发 Decision 的本地语义采集，并保持 Markdown 为唯一事实来源。",
        decisionFraming:
          "这是既有代码，不是本次引入。调整会涉及领域类型和 9 个既有测试。\n\n两个改动仍在 dev 分支且尚未提交。需要决定先处理技术债，还是先交付当前改动。",
      },
    },
  };
};

const previewModelTrace: ModelInvocationTrace = {
  version: 1,
  traceId: "preview-trace",
  requestId: "preview-request",
  attemptId: "preview-attempt",
  attemptIndex: 0,
  purpose: "semantic-classification",
  contentMode: "full",
  profile: {
    profileId: "builtin-qwen",
    backend: "qwen",
    provider: "qwen",
    model: "qwen3.5-2b-q4-k-m",
    promptVersion: "semantic-v1",
    schemaVersion: "semantic-classification-v1",
  },
  input: {
    systemPrompt: "Classify the captured conversation.",
    userPrompt: "Should this decision be recorded?",
    outputSchema: { type: "object" },
    clientSystemPromptVisibility: "visible",
  },
  output: {
    visibleText: '{"decisionIntent":"decision"}',
    parsed: { decisionIntent: "decision" },
  },
  usage: {
    source: "runtime_measured",
    inputTokens: 128,
    outputTokens: 36,
    totalTokens: 164,
  },
  timing: { queuedMs: 4, providerMs: 286, totalMs: 294 },
  status: "succeeded",
  createdAt: "2026-07-31T10:30:00.000Z",
  expiresAt: "2026-08-07T10:30:00.000Z",
};

const previewModelTraces: ModelInvocationTrace[] = Array.from(
  { length: 9 },
  (_, index) => ({
    ...previewModelTrace,
    traceId: `preview-trace-${index + 1}`,
    requestId: `preview-request-${index + 1}`,
    attemptId: `preview-attempt-${index + 1}`,
    createdAt: new Date(
      Date.UTC(2026, 6, 31, 10, 30 - index * 4),
    ).toISOString(),
    timing: {
      ...previewModelTrace.timing,
      providerMs: 286 + index * 17,
      totalMs:
        [294, 1142, 5165, 3872, 4692, 4009, 1863, 3196, 842][index] ??
        previewModelTrace.timing.totalMs,
    },
    usage: {
      ...previewModelTrace.usage,
      totalTokens:
        [7, 84, 164, 559, 697, 806, 1039, 1242, 1635][index] ??
        previewModelTrace.usage.totalTokens,
    },
  }),
);

const snapshotForPreview = (): AppSnapshot => {
  const parameters = new URLSearchParams(window.location.search);
  const preview = parameters.get("preview");
  const requestedTheme = parameters.get("theme");
  const theme: ThemePreference = THEME_PREFERENCES.some(
    (value) => value === requestedTheme,
  )
    ? (requestedTheme as ThemePreference)
    : "auto";
  const common = {
    primarySurface: "hidden" as const,
    waitingCount: 2,
    candidateReviewOpen: false,
    candidateReviewProgress: null,
    decisionCandidates: {
      current: null,
      count: 0,
    },
    theme,
    vaultPath: "/vault/Decision",
    health: {
      index: "healthy" as const,
      recovery: "healthy" as const,
    },
    integrationStatus: {
      claudeCode: "installed" as const,
      codex: "installed" as const,
    },
    pendingRationales: [
      {
        id: "pending-1",
        question: "代码审查应该在实现前还是实现后触发？",
        created: "2026-06-24T01:00:00.000Z",
        project: "decision",
        sourceClient: "codex",
        selectedAnswer: "实现后、提交前审查",
        contextSummary: "需要让审查覆盖完整改动，同时在推送前留下修正空间。",
      },
      {
        id: "pending-2",
        question: "模型不可用时是否继续规则识别？",
        created: "2026-08-10T08:20:00.000Z",
        project: "decision",
        sourceClient: "claude-code",
        selectedAnswer: "继续并标记降级状态",
        contextSummary: "本地模型启动失败时仍需保留基础判断能力。",
      },
      {
        id: "pending-3",
        question: "历史调用记录保留多久？",
        created: "2026-08-09T06:10:00.000Z",
        project: "local-tools",
        sourceClient: "codex",
        selectedAnswer: "默认保留七天",
        contextSummary: null,
      },
    ],
    dashboard: {
      totalDecisions: 28,
      recorded7d: 7,
      reviewAttention: 1,
      recentDecisions: Array.from({ length: 12 }, (_, index) => ({
        id: `recent-${index + 1}`,
        created: new Date(Date.UTC(2026, 6, 30 - index, 8, 30)).toISOString(),
        sourceClient: index % 2 === 0 ? "codex" : "claude-code",
        project: index % 3 === 0 ? "decision" : "local-tools",
        question:
          index % 2 === 0
            ? "决策工作流应该从设置中拆出吗？"
            : "本地模型输出达到上限时如何处理？",
        selectedAnswer:
          index % 2 === 0 ? "建立独立决策中心" : "保留输出上限诊断并回退规则",
        rationaleStatus:
          index % 3 === 0
            ? ("captured" as const)
            : index % 3 === 1
              ? ("deferred" as const)
              : ("skipped" as const),
      })),
    },
    modelTraceContentEnabled: true,
    semanticRecognition: {
      provider: "qwen" as const,
      providerLabel: "Qwen 本地模型",
      availability: "available" as const,
      mode: "hybrid" as const,
      modelVersion: "qwen3.5-2b-q4-k-m",
      promptVersion: "semantic-v1",
      processed7d: 12,
      high7d: 4,
      medium7d: 3,
      failures7d: 0,
      updatedAt: "2026-07-27T10:00:00.000Z",
    },
  };
  if (preview === "dashboard") {
    return {
      ...common,
      primarySurface: "dashboard",
      current: null,
      decisionCandidates: {
        current: reviewCandidate(),
        count: 4,
      },
    };
  }
  if (preview === "settings") {
    return {
      ...common,
      primarySurface: "settings",
      current: null,
    };
  }
  if (
    preview === "decisions" ||
    preview === "methodology" ||
    preview === "clients" ||
    preview === "models" ||
    preview === "activity"
  ) {
    return {
      ...common,
      primarySurface: preview,
      current: null,
    };
  }
  if (preview === "candidate") {
    return {
      ...common,
      current: null,
      candidateReviewOpen: true,
      candidateReviewProgress: { position: 1, total: 4 },
      decisionCandidates: {
        current: reviewCandidate(),
        count: 4,
      },
    };
  }
  if (preview === "rationale") {
    const current = candidate();
    const question = {
      ...current.question,
      question: "按这个方案实施，可以吗？",
      answer: {
        kind: "custom" as const,
        values: [
          "1. 没问题 2. 里面不要 presentDataImportTask 这样的写法 3. 改",
        ],
      },
    };
    return {
      ...common,
      current: {
        ...current,
        question,
        event: {
          ...current.event,
          context: {
            taskBackground:
              "检查后，推荐不新增文件类型依赖，使用现有解析器完成真实格式校验。",
            decisionFraming:
              "当前虽然间接安装了 file-type@21，但实测旧版 Excel 只能识别为通用 cfb，无法区分具体格式。这个决定会影响后续导入流程和错误提示。",
          },
          questions: [question],
        },
      },
    };
  }
  if (preview === "panel") {
    const current = candidate();
    const longQuestion = {
      ...current.question,
      question: current.question.question.repeat(4),
    };
    return {
      ...common,
      current: {
        ...current,
        question: longQuestion,
        event: { ...current.event, questions: [longQuestion] },
      },
    };
  }
  return {
    ...common,
    current: candidate(),
  };
};

export const createPreviewApi = (): DecisionApi => {
  document.documentElement.dataset.preview = "true";
  const parameters = new URLSearchParams(window.location.search);
  const preview = parameters.get("preview");
  const requestedTheme = parameters.get("theme");
  const requestedInteraction = parameters.get("interaction");
  const delayedModelFixture =
    parameters.get("settingsModelFixture") === "delayed";
  const showModelFixture = preview === "models" || delayedModelFixture;
  const previewProfiles: Awaited<
    ReturnType<DecisionApi["listModelProviderProfiles"]>
  > = [
    {
      version: 1,
      profileId: "builtin-qwen",
      kind: "qwen",
      label: "Qwen 本地模型",
      enabled: true,
      priority: 0,
      model: "qwen3.5-2b-q4-k-m",
      timeoutMs: 5_000,
      credentialConfigured: false,
    },
    {
      version: 1,
      profileId: "builtin-apple",
      kind: "apple",
      label: "Apple Foundation Models",
      enabled: false,
      priority: 10,
      model: "system-language-model",
      timeoutMs: 5_000,
      credentialConfigured: false,
    },
    {
      version: 1,
      profileId: "builtin-codex",
      kind: "codex-cli",
      label: "Codex CLI",
      enabled: true,
      priority: 20,
      timeoutMs: 30_000,
      credentialConfigured: false,
    },
    {
      version: 1,
      profileId: "builtin-claude-code",
      kind: "claude-code-cli",
      label: "Claude Code CLI",
      enabled: true,
      priority: 30,
      timeoutMs: 30_000,
      credentialConfigured: false,
    },
  ];
  const previewClientStatuses: Awaited<
    ReturnType<DecisionApi["listLocalModelClientStatuses"]>
  > = [
    {
      kind: "codex-cli",
      executablePath: "codex",
      version: "0.146.0",
      authenticated: true,
      supported: true,
      availability: "available",
      checkedAt: "2026-07-31T00:00:00.000Z",
    },
    {
      kind: "claude-code-cli",
      executablePath: "claude",
      version: "2.1.220",
      authenticated: true,
      supported: true,
      availability: "available",
      checkedAt: "2026-07-31T00:00:00.000Z",
    },
  ];
  if (requestedTheme === "light" || requestedTheme === "dark") {
    document.documentElement.dataset.previewTheme = requestedTheme;
  }
  const snapshot = snapshotForPreview();
  let previewManualFormDrafts: ManualFormDraft[] = [];
  const previewDecisions: Awaited<
    ReturnType<DecisionApi["listDecisions"]>
  > = snapshot.dashboard.recentDecisions.map((decision, index) => ({
    ...decision,
    rationale:
      decision.rationaleStatus === "captured"
        ? "这个方案更容易维护，也能保留清晰的回退路径。"
        : null,
    context:
      index % 2 === 0 ? "当时正在收敛桌面应用的信息架构和交互密度。" : null,
    outcome:
      index % 4 === 0 ? "上线后页面切换稳定，用户能更快定位历史记录。" : null,
    outcomeReview:
      index % 4 === 0
        ? {
            verdict: "as_expected" as const,
            lesson: "紧凑信息架构更适合高频回看。",
            reviewedAt: "2026-08-01T09:30:00.000Z",
          }
        : null,
    reviewDueDate: index === 1 || index % 4 === 0 ? "2026-08-01" : "2026-08-10",
    appliedPrincipleIds:
      index % 4 === 0 || index === 1 ? ["principle-preview-accepted"] : [],
    appliedPrinciples:
      index % 4 === 0 || index === 1
        ? [
            {
              id: "principle-preview-accepted",
              title: "先稳定骨架，再扩展功能入口",
              status: "accepted" as const,
            },
          ]
        : [],
  }));
  const previewEvidence = previewDecisions.filter(
    (decision) => decision.outcomeReview !== null,
  );
  let previewMethodology: Awaited<
    ReturnType<DecisionApi["listMethodologies"]>
  >[number] = {
    id: "principle-preview-1",
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-02T10:00:00.000Z",
    origin: "decision_evidence",
    status: "candidate",
    confirmedAt: null,
    title: "先收敛信息架构，再增加入口",
    principle:
      "当用户需要高频回看和跨页面切换时，优先建立稳定、紧凑的信息架构，再逐步增加功能入口。",
    appliesWhen:
      "桌面工具包含多个管理页面，且用户需要在历史记录、模型和设置之间频繁切换。",
    caution:
      "如果任务本身需要持续占据注意力，不应为了压缩空间而隐藏关键状态与操作反馈。",
    evidenceSummary:
      "证据 1 与证据 2 均显示，收敛页面层级和留白后，切换更稳定、历史定位更快；这是有限样本下的候选归纳。",
    sourceDecisionIds: previewEvidence.slice(0, 2).map((item) => item.id),
    sourceDecisions: previewEvidence.slice(0, 2),
    confidence: "medium",
    quality: {
      recommendedConfidence: "medium",
      confidenceReason: "2 条证据结果方向一致，但仍集中在同一项目。",
      evidenceCount: 2,
      missingEvidenceCount: 0,
      projectCount: 1,
      sourceCount: 2,
      favorableEvidenceCount: 2,
      attentionEvidenceCount: 0,
      unclearEvidenceCount: 0,
      flags: ["single_project", "similar_principle"],
      relations: [
        {
          id: "principle-preview-accepted",
          title: "先稳定骨架，再扩展功能入口",
          status: "accepted",
          kind: "similar",
          score: 76,
          sharedEvidenceCount: 1,
          reason:
            "共享 1 条来源证据，且原则表达高度接近；采纳前应判断是否需要合并。",
        },
      ],
    },
    generation: {
      requestId: "methodology:preview",
      profileId: "builtin-qwen",
      provider: "Qwen 本地模型",
      model: "qwen3.5-2b-q4-k-m",
    },
  };
  let previewAcceptedMethodology: Awaited<
    ReturnType<DecisionApi["listMethodologies"]>
  >[number] = {
    ...previewMethodology,
    id: "principle-preview-accepted",
    status: "accepted" as const,
    confirmedAt: "2026-08-02T10:00:00.000Z",
    title: "先稳定骨架，再扩展功能入口",
    principle: "先稳定页面骨架、信息层级和回退路径，再逐步扩展新的功能入口。",
    appliesWhen: "核心信息结构尚未稳定，新增入口会扩大返工范围时。",
    quality: {
      ...previewMethodology.quality,
      flags: ["single_project"],
      relations: [],
    },
  };
  let previewUsageValidationAcknowledged = false;
  let previewImportedMethodology: Awaited<
    ReturnType<DecisionApi["listMethodologies"]>
  >[number] = {
    ...previewMethodology,
    id: "principle-preview-imported",
    createdAt: "2026-08-03T11:00:00.000Z",
    updatedAt: "2026-08-03T11:00:00.000Z",
    origin: "markdown_import",
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
    quality: {
      recommendedConfidence: "low",
      confidenceReason: "尚未关联经过结果复盘的决策证据，只能作为待验证假设。",
      evidenceCount: 0,
      missingEvidenceCount: 0,
      projectCount: 0,
      sourceCount: 0,
      favorableEvidenceCount: 0,
      attentionEvidenceCount: 0,
      unclearEvidenceCount: 0,
      flags: ["no_evidence"],
      relations: [],
    },
    generation: {
      requestId: "methodology-import:preview",
      profileId: "local-markdown-import",
      provider: "本地导入",
      model: "Markdown",
    },
  };
  let previewImportedVisible = false;
  const previewMergeSource: Awaited<
    ReturnType<DecisionApi["listMethodologies"]>
  >[number] = {
    ...previewAcceptedMethodology,
    id: "principle-preview-source-2",
    title: "先验证回退路径，再扩大改动",
    principle: "通过可独立回退的小步改动验证关键假设，再决定是否扩大范围。",
    quality: {
      ...previewAcceptedMethodology.quality,
      relations: [previewMethodology, previewAcceptedMethodology].map(
        (item) => ({
          id: item.id,
          title: item.title,
          status: item.status,
          kind: "similar" as const,
          score: 88,
          sharedEvidenceCount: 1,
          reason: "人工确认表达同一条先验证再扩展的规则。",
          resolution: "duplicate" as const,
        }),
      ),
    },
  };
  let previewMergeSourceThird: Awaited<
    ReturnType<DecisionApi["listMethodologies"]>
  >[number] = {
    ...previewMergeSource,
    id: "principle-preview-source-3",
    title: "先用小范围反馈确认扩张边界",
    principle: "先用小范围真实反馈确认边界，再逐步扩大不可逆投入。",
    quality: {
      ...previewMergeSource.quality,
      relations: previewMergeSource.quality.relations.filter(
        (relation) => relation.id === previewMethodology.id,
      ),
    },
  };
  const previewMergedMethodology: Awaited<
    ReturnType<DecisionApi["listMethodologies"]>
  >[number] = {
    ...previewAcceptedMethodology,
    id: "principle-preview-merged",
    origin: "principle_merge",
    title: "先稳定可回退骨架，再逐步扩展",
    principle:
      "先建立稳定且可回退的基础骨架，验证关键假设后再逐步扩展功能入口。",
    sourcePrincipleIds: [
      previewAcceptedMethodology.id,
      previewMergeSource.id,
      previewMergeSourceThird.id,
    ],
    sourcePrinciples: [
      previewAcceptedMethodology,
      previewMergeSource,
      previewMergeSourceThird,
    ].map((item) => ({
      id: item.id,
      status: item.status,
      title: item.title,
      principle: item.principle,
      appliesWhen: item.appliesWhen,
      caution: item.caution,
    })),
    generation: {
      requestId: "methodology-merge:accepted-preview",
      profileId: "manual-principle-merge",
      provider: "人工合并",
      model: "不调用模型",
    },
  };
  let previewMergeReplacementReady = false;
  let previewMergeSourcesRetired = false;
  let previewPracticeAsset: Awaited<
    ReturnType<DecisionApi["listPracticeAssets"]>
  >[number] = {
    id: "skill-preview-1",
    slug: "decision-reversible-change",
    kind: "skill",
    status: "candidate",
    createdAt: "2026-08-02T11:00:00.000Z",
    updatedAt: "2026-08-02T11:00:00.000Z",
    acceptedAt: null,
    title: "可逆改动验证",
    summary: "用小步、可回退的改动验证仍有未知项的实现方向。",
    trigger: "需求边界或实际效果仍需要通过运行反馈确认时。",
    steps: [
      "明确本轮只验证的一个关键假设。",
      "实施可独立回退的最小改动。",
      "记录实际结果后再决定是否扩大范围。",
    ],
    checks: ["改动能够独立回退。", "实际结果已经记录。"],
    fallback: "验证失败时回退本轮改动，并根据实际结果重新界定假设。",
    sourcePrincipleIds: [previewAcceptedMethodology.id],
    supersedesId: null,
    freshness: {
      state: "current",
      sourceCount: 1,
      updatedSourceCount: 0,
      missingSourceCount: 0,
      unacceptedSourceCount: 0,
      latestSourceUpdatedAt: previewAcceptedMethodology.updatedAt,
      canRegenerate: true,
      message: "内容与当前已采纳原则一致。",
    },
    sourceChanges: [],
    sourcePrinciples: [
      {
        id: previewAcceptedMethodology.id,
        updatedAt: previewAcceptedMethodology.updatedAt,
        status: previewAcceptedMethodology.status,
        title: previewAcceptedMethodology.title,
        principle: previewAcceptedMethodology.principle,
        appliesWhen: previewAcceptedMethodology.appliesWhen,
        caution: previewAcceptedMethodology.caution,
        confidence: previewAcceptedMethodology.confidence,
      },
    ],
    generation: {
      requestId: "skill:preview",
      profileId: "builtin-qwen",
      provider: "Qwen 本地模型",
      model: "qwen3.5-2b-q4-k-m",
    },
  };
  const previewStalePracticeAsset: Awaited<
    ReturnType<DecisionApi["listPracticeAssets"]>
  >[number] = {
    ...previewPracticeAsset,
    id: "workflow-preview-stale",
    slug: "decision-source-freshness",
    kind: "workflow",
    status: "accepted",
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    acceptedAt: "2026-08-01T10:00:00.000Z",
    title: "来源更新后的实践校准",
    summary: "来源原则已经更新，原资产与客户端版本暂时保持不变。",
    supersedesId: null,
    freshness: {
      ...previewPracticeAsset.freshness,
      state: "sources_updated",
      updatedSourceCount: 1,
      message: "1 条来源原则在此资产之后更新，需要重新生成或编辑确认。",
    },
    sourceChanges: [
      {
        id: previewAcceptedMethodology.id,
        title: previewAcceptedMethodology.title,
        state: "updated",
        previousUpdatedAt: "2026-08-01T08:00:00.000Z",
        currentUpdatedAt: previewAcceptedMethodology.updatedAt,
        fields: [
          {
            field: "principle",
            before: "先稳定基础骨架，再逐步开放入口。",
            after: previewAcceptedMethodology.principle,
          },
        ],
      },
    ],
    generation: {
      ...previewPracticeAsset.generation,
      requestId: "workflow:preview-stale",
    },
  };
  const graphDecision = previewEvidence[0];
  const previewKnowledgeGraph: KnowledgeGraphSnapshot =
    graphDecision === undefined
      ? {
          projects: [],
          decisions: [],
          outcomes: [],
          principles: [],
          principleRelations: [],
          edges: [],
          missingSourceDecisionIds: [],
        }
      : {
          projects: [
            {
              id: `project:${encodeURIComponent(graphDecision.project)}`,
              name: graphDecision.project,
              decisionIds: [graphDecision.id],
              principleIds: [
                previewMethodology.id,
                previewAcceptedMethodology.id,
              ],
            },
          ],
          decisions: [
            {
              id: graphDecision.id,
              projectId: `project:${encodeURIComponent(graphDecision.project)}`,
              project: graphDecision.project,
              question: graphDecision.question,
              selectedAnswer: graphDecision.selectedAnswer,
              principleIds: [
                previewMethodology.id,
                previewAcceptedMethodology.id,
              ],
            },
          ],
          outcomes:
            graphDecision.outcome === null ||
            graphDecision.outcomeReview === null
              ? []
              : [
                  {
                    id: `outcome:${graphDecision.id}`,
                    decisionId: graphDecision.id,
                    summary: graphDecision.outcome,
                    verdict: graphDecision.outcomeReview.verdict,
                    lesson: graphDecision.outcomeReview.lesson,
                    reviewedAt: graphDecision.outcomeReview.reviewedAt,
                  },
                ],
          principles: [
            {
              id: previewMethodology.id,
              title: previewMethodology.title,
              principle: previewMethodology.principle,
              confidence: previewMethodology.confidence,
              confirmedAt: "2026-08-02T10:00:00.000Z",
              sourceDecisionIds: [graphDecision.id],
              projectIds: [
                `project:${encodeURIComponent(graphDecision.project)}`,
              ],
            },
            {
              id: previewAcceptedMethodology.id,
              title: previewAcceptedMethodology.title,
              principle: previewAcceptedMethodology.principle,
              confidence: previewAcceptedMethodology.confidence,
              confirmedAt: previewAcceptedMethodology.confirmedAt!,
              sourceDecisionIds: [graphDecision.id],
              projectIds: [
                `project:${encodeURIComponent(graphDecision.project)}`,
              ],
            },
          ],
          principleRelations: [
            {
              id: "principle-relation-preview",
              sourcePrincipleId: previewMethodology.id,
              targetPrincipleId: previewAcceptedMethodology.id,
              disposition: "duplicate",
              note: "两条原则都强调先稳定信息结构，再逐步增加入口。",
              updatedAt: "2026-08-06T10:00:00.000Z",
            },
          ],
          edges: [
            {
              sourceId: `project:${encodeURIComponent(graphDecision.project)}`,
              targetId: graphDecision.id,
              relationship: "project-decision",
            },
            {
              sourceId: graphDecision.id,
              targetId: `outcome:${graphDecision.id}`,
              relationship: "decision-outcome",
            },
            {
              sourceId: graphDecision.id,
              targetId: previewMethodology.id,
              relationship: "decision-principle",
            },
            {
              sourceId: graphDecision.id,
              targetId: previewAcceptedMethodology.id,
              relationship: "decision-principle",
            },
            {
              sourceId: previewMethodology.id,
              targetId: previewAcceptedMethodology.id,
              relationship: "principle-duplicate",
            },
          ],
          missingSourceDecisionIds: [],
        };
  const previewAnalytics: Awaited<
    ReturnType<DecisionApi["getDecisionAnalytics"]>
  > = {
    generatedAt: "2026-08-02T12:00:00.000Z",
    engine: {
      name: "Local aggregation",
      version: "1",
      source: "SQLite snapshot",
    },
    totals: {
      decisions: 36,
      projects: 4,
      rationaleCaptured: 31,
      outcomesRecorded: 24,
      outcomesReviewed: 18,
    },
    rates: {
      rationaleCaptured: 86.1,
      outcomesRecorded: 66.7,
      outcomesReviewed: 75,
    },
    verdicts: [
      { verdict: "better", count: 3, percentage: 16.7 },
      { verdict: "as_expected", count: 9, percentage: 50 },
      { verdict: "mixed", count: 4, percentage: 22.2 },
      { verdict: "worse", count: 1, percentage: 5.6 },
      { verdict: "unclear", count: 1, percentage: 5.6 },
    ],
    projects: [
      {
        key: "Decision",
        label: "Decision",
        decisionCount: 22,
        rationaleCaptured: 20,
        outcomesRecorded: 16,
        outcomesReviewed: 13,
        favorableOutcomes: 9,
        attentionOutcomes: 3,
        latestCreated: "2026-08-02T10:00:00.000Z",
      },
      {
        key: "Bridge",
        label: "Bridge",
        decisionCount: 8,
        rationaleCaptured: 7,
        outcomesRecorded: 5,
        outcomesReviewed: 3,
        favorableOutcomes: 2,
        attentionOutcomes: 1,
        latestCreated: "2026-08-01T10:00:00.000Z",
      },
    ],
    sources: [
      {
        key: "codex",
        label: "codex",
        decisionCount: 25,
        rationaleCaptured: 22,
        outcomesRecorded: 17,
        outcomesReviewed: 13,
        favorableOutcomes: 9,
        attentionOutcomes: 3,
        latestCreated: "2026-08-02T10:00:00.000Z",
      },
      {
        key: "claude-code",
        label: "claude-code",
        decisionCount: 11,
        rationaleCaptured: 9,
        outcomesRecorded: 7,
        outcomesReviewed: 5,
        favorableOutcomes: 3,
        attentionOutcomes: 2,
        latestCreated: "2026-08-01T10:00:00.000Z",
      },
    ],
    trend: [
      { period: "2026-05", decisionCount: 4, outcomesReviewed: 2 },
      { period: "2026-06", decisionCount: 9, outcomesReviewed: 5 },
      { period: "2026-07", decisionCount: 15, outcomesReviewed: 8 },
      { period: "2026-08", decisionCount: 8, outcomesReviewed: 3 },
    ],
  };
  const previewConsultationMetrics: Awaited<
    ReturnType<DecisionApi["getDecisionConsultationMetrics"]>
  > = {
    metricsVersion: 1,
    requests: 24,
    matched: 17,
    noMatch: 7,
    matches: 31,
    strongMatches: 19,
    possibleMatches: 12,
    durationMs: 168,
    byClient: { claudeCode: 9, codex: 15 },
    feedback: {
      total: 9,
      helpful: 7,
      notHelpful: 1,
      misleading: 1,
      bySource: { claudeCode: 3, codex: 4, preview: 2 },
      byResult: {
        strong: { total: 6, helpful: 5, notHelpful: 0, misleading: 1 },
        possible: { total: 2, helpful: 1, notHelpful: 1, misleading: 0 },
        noMatch: { total: 1, helpful: 1, notHelpful: 0, misleading: 0 },
      },
    },
    recent: [
      {
        date: "2026-08-08",
        requests: 8,
        matched: 6,
        noMatch: 2,
        matches: 11,
        strongMatches: 7,
        possibleMatches: 4,
        durationMs: 56,
        feedback: { total: 3, helpful: 2, notHelpful: 0, misleading: 1 },
      },
    ],
    lastConsultedAt: "2026-08-08T12:00:00.000Z",
    privacy: {
      storesQuestionText: false,
      storesOptionText: false,
      storesPrincipleIds: false,
      storesFeedbackTokens: false,
      storesIndividualEvents: false,
    },
  };
  return {
    getSnapshot: async () => snapshot,
    onSnapshot: () => () => undefined,
    submitRationale: async () => undefined,
    retryPersistence: async () => undefined,
    openCandidateReview: async () => undefined,
    closeCandidateReview: async () => undefined,
    confirmCandidate: async () => undefined,
    ignoreCandidate: async () => undefined,
    retryCandidate: async () => undefined,
    openSurface: async () => undefined,
    closePrimarySurface: async () => undefined,
    listDecisions: async (query) => {
      if (requestedInteraction === "decision-filter-stability") {
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      if (query.decisionId !== undefined) {
        return previewDecisions.filter(
          (decision) => decision.id === query.decisionId,
        );
      }
      if (query.rationaleStatus !== undefined) {
        return previewDecisions.filter(
          (decision) => decision.rationaleStatus === query.rationaleStatus,
        );
      }
      if (query.reviewState === "reviewed") {
        return previewDecisions.filter(
          (decision) => decision.outcomeReview !== null,
        );
      }
      if (query.reviewState === "pending_outcome") {
        return previewDecisions.filter((decision) => decision.outcome === null);
      }
      if (query.reviewState === "pending_review") {
        return previewDecisions.filter(
          (decision) =>
            decision.outcome !== null && decision.outcomeReview === null,
        );
      }
      if (query.reviewState === "attention" || query.reviewState === "due") {
        return previewDecisions.filter(
          (decision) =>
            decision.outcomeReview === null &&
            (decision.outcome !== null ||
              (decision.reviewDueDate !== null &&
                decision.reviewDueDate <= "2026-08-03")),
        );
      }
      if (query.reviewState === "scheduled") {
        return previewDecisions.filter(
          (decision) =>
            decision.outcomeReview === null &&
            decision.reviewDueDate !== null &&
            decision.reviewDueDate > "2026-08-03",
        );
      }
      if (query.reviewState === "unscheduled") {
        return previewDecisions.filter(
          (decision) =>
            decision.outcomeReview === null && decision.reviewDueDate === null,
        );
      }
      return previewDecisions;
    },
    updateDecisionOutcome: async () => undefined,
    updateDecisionReviewDueDate: async () => undefined,
    updateDecisionReview: async (_decisionId, input) => ({
      ...input,
      reviewedAt: "2026-08-02T10:00:00.000Z",
    }),
    updateDecisionAppliedPrinciples: async (decisionId, principleIds) => {
      const decision = previewDecisions.find((item) => item.id === decisionId);
      const records = [
        previewMethodology,
        previewAcceptedMethodology,
        previewMergeSource,
        previewMergeSourceThird,
        previewMergedMethodology,
        ...(previewImportedVisible ? [previewImportedMethodology] : []),
      ];
      const appliedPrinciples = principleIds.flatMap((id) => {
        const methodology = records.find((item) => item.id === id);
        return methodology === undefined
          ? []
          : [
              {
                id: methodology.id,
                title: methodology.title,
                status: methodology.status,
              },
            ];
      });
      if (decision !== undefined) {
        decision.appliedPrincipleIds = [...principleIds];
        decision.appliedPrinciples = appliedPrinciples;
      }
      return appliedPrinciples;
    },
    getDecisionPrincipleSuggestions: async () =>
      [
        previewAcceptedMethodology,
        previewMergeSource,
        previewMergedMethodology,
      ].map((methodology, index) => ({
        id: methodology.id,
        title: methodology.title,
        principle: methodology.principle,
        appliesWhen: methodology.appliesWhen,
        caution: methodology.caution,
        score: 34 - index * 5,
        strength: index === 0 ? ("strong" as const) : ("possible" as const),
        reason: "原则内容、适用条件与当前决策存在文本重合。",
        matchedTerms: ["验证", "边界"],
      })),
    getMethodologyBuildProgress: async () => ({
      decisions: {
        total: previewAnalytics.totals.decisions,
        pendingOutcome:
          previewAnalytics.totals.decisions -
          previewAnalytics.totals.outcomesRecorded,
        pendingReview:
          previewAnalytics.totals.outcomesRecorded -
          previewAnalytics.totals.outcomesReviewed,
        reviewed: previewAnalytics.totals.outcomesReviewed,
      },
      principles: {
        candidate: 1,
        accepted: 4,
        retired: previewMergeSourcesRetired ? 3 : 0,
        dismissed: 0,
      },
      practiceAssets: {
        candidate: previewPracticeAsset.status === "candidate" ? 1 : 0,
        accepted: 1 + (previewPracticeAsset.status === "accepted" ? 1 : 0),
        dismissed: previewPracticeAsset.status === "dismissed" ? 1 : 0,
      },
    }),
    listMethodologies: async (status) => {
      const acceptedMethodology =
        requestedInteraction === "methodology-evolution-rebase" &&
        previewManualFormDrafts.some(
          (draft) => draft.key === "methodology_revision",
        )
          ? {
              ...previewAcceptedMethodology,
              updatedAt: "2026-08-08T12:00:00.000Z",
              title: "先确认停止条件，再扩展功能入口",
              caution: "缺少明确停止条件时，不继续扩大不可逆投入。",
            }
          : previewAcceptedMethodology;
      return [
        requestedInteraction === "methodology-merge-recovery"
          ? {
              ...previewMethodology,
              status: "accepted" as const,
              confirmedAt: "2026-08-02T10:00:00.000Z",
              quality: {
                ...previewMethodology.quality,
                relations: [
                  ...previewMethodology.quality.relations.filter(
                    (relation) =>
                      relation.id !== previewAcceptedMethodology.id,
                  ),
                  {
                    id: previewAcceptedMethodology.id,
                    title: previewAcceptedMethodology.title,
                    status: previewAcceptedMethodology.status,
                    kind: "similar" as const,
                    score: 90,
                    sharedEvidenceCount: 1,
                    reason: "人工确认表达同一条先验证再扩展的规则。",
                    resolution: "duplicate" as const,
                  },
                ],
              },
            }
          : previewMethodology,
        acceptedMethodology,
        previewMergeSource,
        previewMergeSourceThird,
        previewMergedMethodology,
        ...(previewImportedVisible ? [previewImportedMethodology] : []),
      ].filter((item) => status === undefined || item.status === status);
    },
    createManualMethodology: async (input) => {
      previewMethodology = {
        ...previewMethodology,
        ...input,
        id: "principle-preview-manual",
        origin: "manual_entry",
        status: "candidate",
        confirmedAt: null,
        evidenceSummary: "人工录入，尚未关联经过结果复盘的决策证据。",
        sourceDecisionIds: [],
        sourceDecisions: [],
        confidence: "low",
        quality: {
          ...previewMethodology.quality,
          recommendedConfidence: "low",
          confidenceReason: "尚未关联经过结果复盘的决策证据。",
          evidenceCount: 0,
          missingEvidenceCount: 0,
          projectCount: 0,
          sourceCount: 0,
          favorableEvidenceCount: 0,
          attentionEvidenceCount: 0,
          unclearEvidenceCount: 0,
          flags: ["no_evidence"],
        },
        generation: {
          requestId: "methodology-manual:preview",
          profileId: "manual-methodology-entry",
          provider: "人工录入",
          model: "不调用模型",
        },
      };
      return previewMethodology;
    },
    createManualMethodologyFromEvidence: async (input) => {
      const sourceDecisions = previewEvidence.filter((decision) =>
        input.sourceDecisionIds.includes(decision.id),
      );
      previewMethodology = {
        ...previewMethodology,
        ...input,
        id: "principle-preview-manual-evidence",
        origin: "manual_entry",
        status: "candidate",
        confirmedAt: null,
        sourceDecisions,
        confidence: sourceDecisions.length > 1 ? "medium" : "low",
        quality: {
          ...previewMethodology.quality,
          recommendedConfidence: sourceDecisions.length > 1 ? "medium" : "low",
          evidenceCount: sourceDecisions.length,
          projectCount: new Set(
            sourceDecisions.map((decision) => decision.project),
          ).size,
          sourceCount: new Set(
            sourceDecisions.map((decision) => decision.sourceClient),
          ).size,
          flags: sourceDecisions.length > 1 ? [] : ["single_evidence"],
        },
        generation: {
          requestId: "methodology-manual-evidence:preview",
          profileId: "manual-evidence-methodology",
          provider: "人工整理",
          model: "不调用模型",
        },
      };
      return previewMethodology;
    },
    listManualFormDrafts: async () => structuredClone(previewManualFormDrafts),
    saveManualFormDraft: async (input) => {
      const draft = {
        ...input,
        updatedAt: new Date().toISOString(),
      } as ManualFormDraft;
      previewManualFormDrafts = [
        ...previewManualFormDrafts.filter((item) => item.key !== draft.key),
        draft,
      ];
      return structuredClone(draft);
    },
    deleteManualFormDraft: async (key) => {
      previewManualFormDrafts = previewManualFormDrafts.filter(
        (item) => item.key !== key,
      );
    },
    generateMethodology: async () => previewMethodology,
    createMethodologyMergeDraft: async (sourcePrincipleIds, input) => ({
      ...previewMethodology,
      ...input,
      id: "principle-preview-merge",
      origin: "principle_merge" as const,
      sourcePrincipleIds: [...sourcePrincipleIds].sort(),
      sourcePrinciples: [
        previewMethodology,
        previewAcceptedMethodology,
        previewMergeSource,
        previewMergeSourceThird,
      ]
        .filter((item) => sourcePrincipleIds.includes(item.id))
        .map((item) => ({
          id: item.id,
          status: item.status,
          title: item.title,
          principle: item.principle,
          appliesWhen: item.appliesWhen,
          caution: item.caution,
        })),
      generation: {
        requestId: "methodology-merge:preview",
        profileId: "manual-principle-merge",
        provider: "人工合并",
        model: "不调用模型",
      },
    }),
    createMethodologyRevisionDraft: async (id, input) => ({
      ...previewMethodology,
      ...input,
      id: "principle-preview-revision",
      origin: "principle_revision" as const,
      status: "candidate" as const,
      confirmedAt: null,
      sourcePrincipleIds: [id],
      sourcePrinciples: [
        {
          id,
          status: "accepted" as const,
          title: previewAcceptedMethodology.title,
          principle: previewAcceptedMethodology.principle,
          appliesWhen: previewAcceptedMethodology.appliesWhen,
          caution: previewAcceptedMethodology.caution,
        },
      ],
      generation: {
        requestId: "methodology-revision:preview",
        profileId: "manual-principle-revision",
        provider: "人工修订",
        model: "不调用模型",
      },
    }),
    reviseMethodology: async (_id, input) => ({
      ...previewMethodology,
      ...input,
    }),
    setMethodologyStatus: async (_id, status) => ({
      ...previewMethodology,
      status,
      confirmedAt: status === "accepted" ? "2026-08-02T10:00:00.000Z" : null,
    }),
    listMethodologyVersions: async () => [],
    restoreMethodologyVersion: async () => previewMethodology,
    getMethodologySuggestions: async () => {
      const source = previewEvidence[2];
      return source?.outcomeReview === null || source === undefined
        ? []
        : [
            {
              id: `suggestion:${source.id}`,
              title: source.question,
              summary:
                "单条完整复盘，适合先提炼为探索性假设，不应直接视为稳定规律。",
              readiness: "exploratory",
              direction: "favorable",
              evidenceCount: 1,
              projectCount: 1,
              sourceDecisionIds: [source.id],
              sources: [
                {
                  id: source.id,
                  project: source.project,
                  question: source.question,
                  selectedAnswer: source.selectedAnswer,
                  outcomeVerdict: source.outcomeReview.verdict,
                  outcomeLesson: source.outcomeReview.lesson,
                  reviewedAt: source.outcomeReview.reviewedAt,
                },
              ],
            },
          ];
    },
    getDeferredMethodologySuggestions: async () => [],
    deferMethodologySuggestion: async () => undefined,
    restoreMethodologySuggestion: async () => undefined,
    getMethodologyEvidenceMatches: async () => {
      const source = previewEvidence[0];
      return source === undefined
        ? []
        : [
            {
              sourceDecisionId: source.id,
              score: 28,
              strength: "strong" as const,
              reason:
                "原则内容与这条复盘存在文本重合，共同出现“保留回退路径”。",
              matchedTerms: ["保留回退路径"],
              alreadyLinked:
                previewImportedMethodology.sourceDecisionIds.includes(
                  source.id,
                ),
            },
          ];
    },
    importMethodologyMarkdown: async () => {
      return {
        cancelled: false,
        batchId: "methodology-import-batch-preview",
        candidates: [
          {
            id: "methodology-import-preview-1",
            fileName: "团队方法论.md",
            title: previewImportedMethodology.title,
            principle: previewImportedMethodology.principle,
            appliesWhen: previewImportedMethodology.appliesWhen,
            caution: previewImportedMethodology.caution,
            sourceDecisionCount: 0,
            missingFields: [],
            similarTo: null,
          },
        ],
        duplicates: [],
        failures: [],
      };
    },
    commitMethodologyMarkdownImport: async () => {
      previewImportedVisible = true;
      return {
        imported: [previewImportedMethodology],
        duplicates: [],
        failures: [],
      };
    },
    setMethodologyEvidence: async (_id, sourceDecisionIds) => {
      const sourceDecisions = previewEvidence.filter((decision) =>
        sourceDecisionIds.includes(decision.id),
      );
      previewImportedMethodology = {
        ...previewImportedMethodology,
        updatedAt: "2026-08-03T11:30:00.000Z",
        sourceDecisionIds,
        sourceDecisions,
        confidence: sourceDecisions.length >= 2 ? "medium" : "low",
        quality: {
          ...previewImportedMethodology.quality,
          recommendedConfidence: sourceDecisions.length >= 2 ? "medium" : "low",
          confidenceReason:
            sourceDecisions.length >= 2
              ? `${sourceDecisions.length} 条人工关联证据结果方向一致。`
              : "当前只有单条结果证据，只能视为待验证假设。",
          evidenceCount: sourceDecisions.length,
          projectCount: new Set(sourceDecisions.map((item) => item.project))
            .size,
          sourceCount: new Set(sourceDecisions.map((item) => item.sourceClient))
            .size,
          favorableEvidenceCount: sourceDecisions.length,
          flags: sourceDecisions.length === 1 ? ["single_evidence"] : [],
        },
      };
      return previewImportedMethodology;
    },
    setMethodologyRelation: async (id, relatedId, disposition, note) => {
      if (
        relatedId === previewMergeSourceThird.id &&
        (id === previewAcceptedMethodology.id || id === previewMergeSource.id)
      ) {
        const source =
          id === previewAcceptedMethodology.id
            ? previewAcceptedMethodology
            : previewMergeSource;
        previewMergeSourceThird = {
          ...previewMergeSourceThird,
          quality: {
            ...previewMergeSourceThird.quality,
            relations: [
              ...previewMergeSourceThird.quality.relations.filter(
                (relation) => relation.id !== source.id,
              ),
              {
                id: source.id,
                title: source.title,
                status: source.status,
                kind:
                  disposition === "conflict"
                    ? ("potential_conflict" as const)
                    : ("similar" as const),
                score: 88,
                sharedEvidenceCount: 1,
                reason: note ?? "人工核对合并组关系。",
                resolution: disposition,
                resolutionNote: note,
                resolutionUpdatedAt: "2026-08-06T12:00:00.000Z",
              },
            ],
          },
        };
        return source;
      }
      if (id === previewMethodology.id) {
        previewMethodology = {
          ...previewMethodology,
          quality: {
            ...previewMethodology.quality,
            relations: previewMethodology.quality.relations.map((relation) =>
              relation.id === relatedId
                ? {
                    ...relation,
                    kind:
                      disposition === "conflict"
                        ? ("potential_conflict" as const)
                        : ("similar" as const),
                    resolution: disposition,
                    resolutionNote: note,
                    resolutionUpdatedAt: "2026-08-06T12:00:00.000Z",
                  }
                : relation,
            ),
          },
        };
        return previewMethodology;
      }
      return previewImportedMethodology;
    },
    clearMethodologyRelation: async (id, relatedId) => {
      if (id === previewMethodology.id) {
        previewMethodology = {
          ...previewMethodology,
          quality: {
            ...previewMethodology.quality,
            relations: previewMethodology.quality.relations.map((relation) =>
              relation.id === relatedId
                ? {
                    ...relation,
                    resolution: null,
                    resolutionNote: null,
                    resolutionUpdatedAt: null,
                  }
                : relation,
            ),
          },
        };
        return previewMethodology;
      }
      return previewImportedMethodology;
    },
    getMethodologyMergePlan: async (mergeId) => ({
      mergeId,
      mergeTitle: previewMergedMethodology.title,
      mergeStatus: "accepted" as const,
      sources: [
        previewAcceptedMethodology,
        previewMergeSource,
        previewMergeSourceThird,
      ].map((source) => ({
        id: source.id,
        title: source.title,
        status: previewMergeSourcesRetired
          ? ("retired" as const)
          : ("accepted" as const),
        retiredAt: previewMergeSourcesRetired
          ? "2026-08-06T12:00:00.000Z"
          : null,
        supersededById: previewMergeSourcesRetired ? mergeId : null,
      })),
      relationValid: true,
      retired: previewMergeSourcesRetired,
      canRetire: false,
      canRestore: previewMergeSourcesRetired,
      modelCallsRequired: previewMergeReplacementReady ? 0 : 1,
      pendingReviewCount: previewMergeReplacementReady ? 1 : 0,
      assets: [
        {
          id: previewStalePracticeAsset.id,
          title: previewStalePracticeAsset.title,
          kind: previewStalePracticeAsset.kind,
          status: previewStalePracticeAsset.status,
          sourcePrincipleIds: [previewAcceptedMethodology.id],
          targetSourcePrincipleIds: [previewMergedMethodology.id],
          replacementId: previewMergeReplacementReady
            ? "workflow-preview-migration"
            : null,
          replacementTitle: previewMergeReplacementReady
            ? "来源更新后的实践校准（合并来源）"
            : null,
        },
      ],
    }),
    prepareMethodologyMergeAsset: async () => {
      previewMergeReplacementReady = true;
      return {
        ...previewStalePracticeAsset,
        id: "workflow-preview-migration",
        status: "candidate" as const,
        acceptedAt: null,
        sourcePrincipleIds: [previewMergedMethodology.id],
        migrationSourcePrincipleIds: [previewAcceptedMethodology.id],
        supersedesId: previewStalePracticeAsset.id,
      };
    },
    retireMethodologyMergeSources: async (mergeId) => {
      previewMergeSourcesRetired = true;
      return window.decision.getMethodologyMergePlan(mergeId);
    },
    restoreMethodologyMergeSources: async (mergeId) => {
      previewMergeSourcesRetired = false;
      return window.decision.getMethodologyMergePlan(mergeId);
    },
    getMethodologyUsage: async (principleId) => {
      const linked = previewDecisions.filter((decision) =>
        decision.appliedPrincipleIds.includes(principleId),
      );
      const reviewed = linked.filter(
        (decision) => decision.outcomeReview !== null,
      );
      const decisions = linked.map((decision) => ({
        id: decision.id,
        created: decision.created,
        project: decision.project,
        question: decision.question,
        selectedAnswer: decision.selectedAnswer,
        outcome: decision.outcome,
        outcomeReview: decision.outcomeReview,
      }));
      return {
        principleId,
        linkedDecisionCount: linked.length,
        outcomeRecordedCount: linked.filter(
          (decision) => decision.outcome !== null,
        ).length,
        reviewedCount: reviewed.length,
        pendingOutcomeCount: linked.filter(
          (decision) => decision.outcome === null,
        ).length,
        pendingReviewCount: linked.filter(
          (decision) =>
            decision.outcome !== null && decision.outcomeReview === null,
        ).length,
        favorableCount: reviewed.filter(
          (decision) =>
            decision.outcomeReview?.verdict === "better" ||
            decision.outcomeReview?.verdict === "as_expected",
        ).length,
        mixedCount: reviewed.filter(
          (decision) => decision.outcomeReview?.verdict === "mixed",
        ).length,
        attentionCount: reviewed.filter(
          (decision) => decision.outcomeReview?.verdict === "worse",
        ).length,
        unclearCount: reviewed.filter(
          (decision) => decision.outcomeReview?.verdict === "unclear",
        ).length,
        decisions,
        nextPendingDecision:
          decisions.find(
            (decision) =>
              decision.outcome === null || decision.outcomeReview === null,
          ) ?? null,
      };
    },
    getMethodologyValidationInbox: async () => {
      if (previewUsageValidationAcknowledged) return [];
      const decisions = previewDecisions
        .filter(
          (decision) =>
            decision.appliedPrincipleIds.includes(
              previewAcceptedMethodology.id,
            ) && decision.outcomeReview !== null,
        )
        .slice(0, 3)
        .map((decision) => ({
          id: decision.id,
          project: decision.project,
          question: decision.question,
          selectedAnswer: decision.selectedAnswer,
          verdict: decision.outcomeReview!.verdict,
          lesson: decision.outcomeReview!.lesson,
          reviewedAt: decision.outcomeReview!.reviewedAt,
        }));
      if (decisions.length === 0) return [];
      return [
        {
          principleId: previewAcceptedMethodology.id,
          title: previewAcceptedMethodology.title,
          principle: previewAcceptedMethodology.principle,
          newReviewedCount: decisions.length,
          favorableCount: decisions.filter(
            (decision) =>
              decision.verdict === "better" ||
              decision.verdict === "as_expected",
          ).length,
          attentionCount: decisions.filter(
            (decision) =>
              decision.verdict === "mixed" || decision.verdict === "worse",
          ).length,
          unclearCount: decisions.filter(
            (decision) => decision.verdict === "unclear",
          ).length,
          newestReviewedAt: decisions[0]!.reviewedAt,
          revisionDraftId: null,
          decisions,
        },
      ];
    },
    acknowledgeMethodologyValidation: async () => {
      previewUsageValidationAcknowledged = true;
      previewAcceptedMethodology = {
        ...previewAcceptedMethodology,
        usageValidation: {
          reviewedAt: "2026-08-01T09:30:00.000Z",
          decisionId: previewDecisions[0]?.id ?? "preview-decision",
          validatedAt: "2026-08-08T10:00:00.000Z",
        },
      };
      return previewAcceptedMethodology;
    },
    getDecisionAnalytics: async () => previewAnalytics,
    getDecisionConsultationMetrics: async () => previewConsultationMetrics,
    previewDecisionConsultation: async () => ({
      consultationVersion: 1,
      requestId: "preview-consultation",
      status: "matched",
      generatedBy: "deterministic_local_match",
      feedback: {
        token: "preview-feedback-token",
        expiresAt: "2026-08-08T12:30:00.000Z",
      },
      matches: [
        {
          principleId: previewAcceptedMethodology.id,
          title: previewAcceptedMethodology.title,
          principle: previewAcceptedMethodology.principle,
          appliesWhen: previewAcceptedMethodology.appliesWhen,
          caution: previewAcceptedMethodology.caution,
          confidence: previewAcceptedMethodology.confidence,
          evidenceCount: previewAcceptedMethodology.sourceDecisionIds.length,
          relevanceScore: 38,
          relevance: "strong",
          reason: "适用条件与当前决策存在文本重合，共同出现“验证、边界”。",
          matchedTerms: ["验证", "边界"],
        },
      ],
      boundary: {
        advisoryOnly: true,
        noDecisionWritten: true,
        noPrincipleApplied: true,
      },
    }),
    submitDecisionConsultationFeedback: async () => ({
      feedbackVersion: 1,
      status: "accepted",
    }),
    getKnowledgeGraph: async () => previewKnowledgeGraph,
    listPracticeAssets: async (status) =>
      [previewPracticeAsset, previewStalePracticeAsset].filter(
        (asset) => status === undefined || status === asset.status,
      ),
    createManualPracticeAsset: async (kind, sourcePrincipleIds, input) => {
      previewPracticeAsset = {
        ...previewPracticeAsset,
        ...input,
        id: `manual-${kind}`,
        slug: `manual-${kind}`,
        kind,
        sourcePrincipleIds,
        status: "candidate",
        acceptedAt: null,
        generation: {
          requestId: `manual-${kind}`,
          profileId: "manual-practice-asset",
          provider: "人工创建",
          model: "不调用模型",
        },
      };
      return previewPracticeAsset;
    },
    generatePracticeAsset: async () => previewPracticeAsset,
    revisePracticeAsset: async (_id, input) => {
      previewPracticeAsset = { ...previewPracticeAsset, ...input };
      return previewPracticeAsset;
    },
    setPracticeAssetStatus: async (_id, status) => {
      previewPracticeAsset = {
        ...previewPracticeAsset,
        status,
        acceptedAt: status === "accepted" ? "2026-08-03T10:00:00.000Z" : null,
      };
      return previewPracticeAsset;
    },
    regeneratePracticeAsset: async (id) => {
      const source =
        id === previewStalePracticeAsset.id
          ? previewStalePracticeAsset
          : previewPracticeAsset;
      return {
        ...source,
        id: `${id}-replacement`,
        slug: `${source.slug}-replacement`,
        status: "candidate",
        acceptedAt: null,
        supersedesId: id,
        freshness: {
          ...source.freshness,
          state: "current",
          updatedSourceCount: 0,
          message: "内容与当前已采纳原则一致。",
        },
        sourceChanges: [],
      };
    },
    listPracticeAssetVersions: async (id) =>
      id === previewStalePracticeAsset.id
        ? [
            {
              version: 2,
              capturedAt: "2026-08-02T09:30:00.000Z",
              reason: "replacement_applied",
              snapshot: {
                updatedAt: "2026-08-01T10:00:00.000Z",
                title: previewStalePracticeAsset.title,
                summary: "按旧来源原则生成并确认的实践版本。",
                trigger: previewStalePracticeAsset.trigger,
                steps: previewStalePracticeAsset.steps,
                checks: previewStalePracticeAsset.checks,
                fallback: previewStalePracticeAsset.fallback,
                sourcePrincipleIds:
                  previewStalePracticeAsset.sourcePrincipleIds,
              },
            },
            {
              version: 1,
              capturedAt: "2026-08-01T10:00:00.000Z",
              reason: "manual_edit",
              snapshot: {
                updatedAt: "2026-08-01T09:00:00.000Z",
                title: "来源变化检查",
                summary: "保存来源变化前的初始实践。",
                trigger: previewStalePracticeAsset.trigger,
                steps: previewStalePracticeAsset.steps.slice(0, 2),
                checks: previewStalePracticeAsset.checks,
                fallback: previewStalePracticeAsset.fallback,
                sourcePrincipleIds:
                  previewStalePracticeAsset.sourcePrincipleIds,
              },
            },
          ]
        : [],
    restorePracticeAssetVersion: async () => previewStalePracticeAsset,
    listPracticePublicationStatuses: async (id) => [
      {
        target: "codex",
        targetLabel: "Codex",
        state:
          id === previewStalePracticeAsset.id ? "up_to_date" : "not_published",
        version: id === previewStalePracticeAsset.id ? 2 : null,
        publishedAt:
          id === previewStalePracticeAsset.id
            ? "2026-08-01T11:00:00.000Z"
            : null,
        canPublish: id !== previewStalePracticeAsset.id,
        canRollback: id === previewStalePracticeAsset.id,
        requiresOverwriteConfirmation: false,
        message:
          id === previewStalePracticeAsset.id
            ? "客户端仍保留最近一次确认发布的版本"
            : "尚未发布到此客户端",
      },
      {
        target: "claude-code",
        targetLabel: "Claude Code",
        state: "not_published",
        version: null,
        publishedAt: null,
        canPublish: true,
        canRollback: false,
        requiresOverwriteConfirmation: false,
        message: "尚未发布到此客户端",
      },
    ],
    publishPracticeAsset: async (_id, target) => ({
      target,
      action: "published",
      version: 1,
      publishedAt: "2026-08-04T10:00:00.000Z",
      restoredPreviousContent: false,
    }),
    rollbackPracticeAssetPublication: async (_id, target) => ({
      target,
      action: "rolled_back",
      version: null,
      publishedAt: null,
      restoredPreviousContent: false,
    }),
    chooseVault: async () => null,
    installIntegrations: async (mode) => ({
      mode,
      targets: [],
      commands: [],
      restartRequired: false,
    }),
    rebuildIndex: async () => ({
      indexedCount: 0,
      diagnostics: [],
    }),
    setTheme: async () => undefined,
    listModelTraces: async () =>
      preview === "activity" ? previewModelTraces : [],
    deleteModelTrace: async () => false,
    deleteModelTraceRequest: async () => 0,
    clearModelTraces: async () => 0,
    setModelTraceContentEnabled: async () => undefined,
    listModelProviderProfiles: async () =>
      showModelFixture ? previewProfiles : [],
    saveModelProviderProfile: async (input) => input.profile,
    deleteModelProviderProfile: async () => false,
    reorderModelProviderProfiles: async () => undefined,
    testModelProviderProfile: async (profileId) => ({
      ok: true,
      profileId,
      latencyMs: 0,
      requestId: "preview-provider-test",
      tokenSource: "unavailable",
    }),
    listLocalModelClientStatuses: async () => {
      if (!showModelFixture) {
        return [];
      }
      if (delayedModelFixture) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 500);
        });
      }
      return previewClientStatuses;
    },
  };
};
