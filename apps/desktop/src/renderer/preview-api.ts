import { createEvidencePreviewApi } from "./evidence-preview-api.js";
import { createJournalEntry, reviseJournalEntry } from "@cognelis/decision-core/journal-entry";
import type { RetrievalAnswerProvider } from "@cognelis/decision-protocol";
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
  DecisionLibraryItem,
  JournalEntry,
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

/**
 * Real runs mix purposes; on a single one the 用途 filter never renders, which
 * is why no screenshot or layout check had ever drawn it.
 */
const previewModelTracePurposes: ModelInvocationTrace["purpose"][] = [
  "semantic-classification",
  "retrieval-answer",
  "methodology-extraction",
];

const previewModelTraces: ModelInvocationTrace[] = Array.from(
  { length: 9 },
  (_, index) => ({
    ...previewModelTrace,
    traceId: `preview-trace-${index + 1}`,
    requestId: `preview-request-${index + 1}`,
    attemptId: `preview-attempt-${index + 1}`,
    purpose:
      previewModelTracePurposes[index % previewModelTracePurposes.length] ??
      previewModelTrace.purpose,
    // One call timed out, as some do: the "only failed" switch only shows when there is one.
    ...(index === 6 ? { status: "timed_out" as const, errorCode: "timeout" as const } : {}),
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

const previewObsidianSearchStatus = {
  state: "ready" as const,
  discoveredNotes: 352,
  indexedNotes: 349,
  chunkCount: 1_274,
  processedNotes: 352,
  totalNotes: 352,
  skippedNotes: 3,
  failedNotes: 0,
  synchronizedAt: "2026-08-18T08:30:00.000Z",
  semanticAvailable: true,
  message: null,
};

/**
 * Preferences and ideas are the fourth kind of sedimented knowledge, and the
 * preview answered with none of them — so no capture and no layout check ever
 * rendered the journal view or the group quick jump gives it.
 */
const previewJournalEntryFixtures: JournalEntry[] = [
  {
    id: "preference-rollback",
    kind: "preference",
    title: "先留回滚入口，再扩大发布",
    content: "不可逆的发布步骤要先有明确的回滚路径和负责人。",
    knowledgeStatus: "active",
    sourceKind: "app_manual",
    sourceForm: "user_original",
    project: "decision",
    occurredAt: null,
    sensitivity: "personal",
    context: null,
    rationale: null,
    tags: [],
    languages: [],
    appliesWhen: "改动一旦上线就难以撤回时。",
    exceptions: "只影响本机、随时可以重装的改动。",
    strength: "default",
    evidenceMaturity: "reviewed",
    createdAt: "2026-08-02T10:00:00.000Z",
    updatedAt: "2026-08-09T10:00:00.000Z",
    revision: 2,
    revisionEvents: [],
  },
  {
    id: "idea-event-driven-cache",
    kind: "idea",
    title: "缓存失效可以改成事件驱动",
    content: "与其定时清理，不如让写入端在提交后发一个失效事件。",
    knowledgeStatus: "inbox",
    sourceKind: "observation",
    sourceForm: "user_original",
    project: "local-tools",
    occurredAt: null,
    sensitivity: "personal",
    context: null,
    rationale: null,
    tags: [],
    languages: [],
    ideaForm: "hypothesis",
    whyInteresting: "定时清理的窗口期一直是排查问题时的干扰项。",
    openQuestions: ["写入端能否可靠拿到受影响的键？"],
    nextTest: null,
    incubateUntil: null,
    createdAt: "2026-08-11T10:00:00.000Z",
    updatedAt: "2026-08-11T10:00:00.000Z",
    revision: 1,
    revisionEvents: [],
  },
];

const previewObsidianSearchResults = [
  {
    relativePath: "运维/发布回滚.md",
    title: "发布回滚检查清单",
    heading: "开始发布前",
    snippet: "确认回滚入口、观察窗口与负责人，再逐步扩大发布范围。",
    matchKind: "hybrid" as const,
  },
  {
    relativePath: "项目/桌面检索方案.md",
    title: "桌面全库检索方案",
    heading: "本地语义检索",
    snippet:
      "索引和查询只在本机完成，并保留关键词降级路径。synthetic-layout-segment-" +
      "0123456789abcdefghijklmnopqrstuvwxyz".repeat(15),
    matchKind: "semantic" as const,
  },
  {
    relativePath: "Decision Journal/索引权衡.md",
    title: "索引更新与回退权衡",
    heading: null,
    snippet: "重建索引不改变 Markdown 事实源，失败时仍可保留已有结果。",
    matchKind: "keyword" as const,
  },
  {
    relativePath:
      "研究/跨语言知识网络/" +
      "synthetic-unbroken-path-0123456789abcdefghijklmnopqrstuvwxyz".repeat(10) +
      ".md",
    title:
      "跨语言知识网络与本地检索边界——用于验证超长 Unicode 标题在窄窗口中仍能完整换行",
    heading: "没有字面重合时的召回",
    snippet:
      "synthetic-unbroken-snippet-0123456789abcdefghijklmnopqrstuvwxyz".repeat(
        10,
      ),
    matchKind: "semantic" as const,
  },
  ...[
    { relativePath: "架构/离线优先.md", title: "离线优先的桌面架构", heading: "资源边界" },
    { relativePath: "项目/迁移复盘.md", title: "迁移窗口复盘", heading: "可逆步骤" },
    { relativePath: "学习/信息检索.md", title: "个人知识库检索笔记", heading: "排序与去重" },
    { relativePath: "会议/产品讨论.md", title: "工作区信息层级讨论", heading: "状态表达" },
    { relativePath: "运维/索引恢复.md", title: "索引恢复演练", heading: "故障隔离" },
    { relativePath: "设计/键盘导航.md", title: "桌面端键盘导航", heading: "焦点顺序" },
    { relativePath: "资料/Markdown 约定.md", title: "Markdown 内容边界", heading: "附件排除" },
    { relativePath: "日志/本地模型准备.md", title: "本地嵌入模型准备记录", heading: "启动前检查" },
  ].map((result, index) => ({
    ...result,
    snippet: `这是第 ${index + 1} 条纯合成布局结果，用来确认单列卡片、摘要截断和结果区内部滚动。`,
    matchKind: "semantic" as const,
  })),
];

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
        capturedQuestion: {
          questionIndex: 0,
          question: "代码审查应该在实现前还是实现后触发？",
          options: [
            {
              label: "实现后、提交前审查",
              description: "覆盖完整改动，并在进入远端前保留修正空间。",
            },
            {
              label: "实现前先审查方案",
              description: "更早发现方向问题，但无法覆盖最终代码细节。",
            },
            {
              label: "提交后再审查",
              description: "流程简单，但问题已经进入共享历史。",
            },
          ],
          answer: {
            kind: "preset" as const,
            values: ["实现后、提交前审查"],
          },
          multiSelect: false,
        },
      },
      {
        id: "pending-2",
        question: "模型不可用时是否继续规则识别？",
        created: "2026-08-10T08:20:00.000Z",
        project: "decision",
        sourceClient: "claude-code",
        selectedAnswer: "继续并标记降级状态",
        contextSummary: "本地模型启动失败时仍需保留基础判断能力。",
        capturedQuestion: null,
      },
      {
        id: "pending-3",
        question: "历史调用记录保留多久？",
        created: "2026-08-09T06:10:00.000Z",
        project: "local-tools",
        sourceClient: "codex",
        selectedAnswer: "默认保留七天",
        contextSummary: null,
        capturedQuestion: null,
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
    captureClassifier: "rules" as const,
    // Coherent with `captureClassifier` above: with the capture path on rules
    // the engine really is the rules, and showing a model name beside a
    // control that says no model runs is the kind of gap a preview exists to
    // stop shipping.
    semanticRecognition: {
      provider: "rules" as const,
      providerLabel: "规则识别",
      availability: "available" as const,
      mode: "rules_only" as const,
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
  if (preview === "first-run") {
    // Fresh install: no clients connected and nothing recorded yet.
    return {
      ...common,
      primarySurface: "dashboard",
      current: null,
      integrationStatus: {
        claudeCode: "not-installed" as const,
        codex: "not-installed" as const,
      },
      pendingRationales: [],
      dashboard: {
        totalDecisions: 0,
        recorded7d: 0,
        reviewAttention: 0,
        recentDecisions: [],
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
    preview === "assistant" ||
    preview === "pr-review" ||
    preview === "methodology" ||
    preview === "clients" ||
    preview === "connections" ||
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
      header: "价格同步",
      question:
        "你新加的那批模型价格，本轮要同步到其它配置吗？（目前只在 dev 一份里，production/conf.d/ci 只有 3 条规则）",
      options: [
        {
          label: "先只留测试环境（推荐）",
          description:
            "本轮只保证 dev 环境完整可验；production 等真正开放这些模型时再随开放动作一起配。",
        },
        {
          label: "一并同步 production",
          description:
            "本轮把 11 个模型的价格规则同步进 production 配置，一步到位但会携带暂未开放模型的规则。",
        },
        {
          label: "只同步 CI",
          description: "先让持续集成使用新价格，线上配置保持不动。",
        },
        {
          label: "只补齐 conf.d 模板",
          description:
            "保留 production 现状，只更新 production/conf.d/model-pricing-overrides-with-a-deliberately-long-path.yaml。",
        },
        {
          label: "本轮不处理",
          description: "等待统一配置服务接管价格规则后再迁移。",
        },
      ],
      answer: {
        kind: "preset" as const,
        values: ["先只留测试环境（推荐）"],
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
  const previewJournalEntries = structuredClone(previewJournalEntryFixtures);
  document.documentElement.dataset.preview = "true";
  const parameters = new URLSearchParams(window.location.search);
  const preview = parameters.get("preview");
  const requestedTheme = parameters.get("theme");
  const requestedInteraction = parameters.get("interaction");
  const obsidianPreviewStatus =
    requestedInteraction === "indexing"
      ? {
          ...previewObsidianSearchStatus,
          state: "indexing" as const,
          discoveredNotes: 352,
          indexedNotes: 0,
          chunkCount: 0,
          processedNotes: 86,
          totalNotes: 352,
          synchronizedAt: null,
          semanticAvailable: false,
        }
      : requestedInteraction === "semantic-unavailable"
        ? {
            ...previewObsidianSearchStatus,
            state: "unavailable" as const,
            semanticAvailable: false,
            message: "语义检索暂不可用。",
          }
        : previewObsidianSearchStatus;
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
    // The only saved remote backend. Without one the page never draws a row
    // that leaves the machine, and the editor that opens for a saved remote —
    // its locked kind, its key field, its proxy fieldset — is unreachable.
    {
      version: 1,
      profileId: "remote-preview",
      kind: "openai-compatible",
      label: "DeepSeek",
      enabled: true,
      priority: 15,
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
      apiProtocol: "chat-completions" as const,
      timeoutMs: 30_000,
      credentialConfigured: true,
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
    // Deliberately not the healthy state, and deliberately the longest copy of
    // the six: with every client available the degraded rows are never drawn,
    // and the column that has to hold them is never measured against the worst
    // string it can be given.
    {
      kind: "claude-code-cli",
      executablePath: "claude",
      version: "2.1.220",
      authenticated: true,
      supported: false,
      availability: "unsupported",
      checkedAt: "2026-07-31T00:00:00.000Z",
    },
  ];
  if (requestedTheme === "light" || requestedTheme === "dark") {
    document.documentElement.dataset.previewTheme = requestedTheme;
  }
  let snapshot = snapshotForPreview();
  const snapshotListeners = new Set<(value: AppSnapshot) => void>();
  let previewManualFormDrafts: ManualFormDraft[] = [];
  // Comment link → decision recorded from it, as the real index answers for the PR discussion.
  const previewCommentDecisions = new Map([["https://github.com/sample/app/pull/123#discussion_r1", "preview-decision"]]);
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
  // The rationale surface's question was answered once before, so the recall
  // of earlier answers is drawn, and measured, in the preview as well.
  if (preview === "rationale" && snapshot.current !== null) {
    previewDecisions.push({
      ...previewDecisions[0]!,
      id: "preview-earlier-pricing",
      created: "2026-07-18T08:30:00.000Z",
      project: "local-tools",
      question: snapshot.current.question.question,
      selectedAnswer: "一并同步 production",
      outcome: "production 带上了尚未开放模型的价格规则，回滚了一次。",
      outcomeReview: {
        verdict: "worse",
        lesson: "价格规则跟着模型开放走，不提前同步到线上配置。",
        reviewedAt: "2026-07-25T09:00:00.000Z",
      },
    });
  }
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
    // Every verdict tone, a review without a lesson, and more reviews than the
    // list shows: the retrospective's branches all draw in the preview.
    retrospective: {
      reviewAttention: 1,
      periods: [
        {
          days: 7,
          startDate: "2026-07-27",
          endDate: "2026-08-02",
          decisions: 7,
          previousDecisions: 5,
          rationaleCaptured: 5,
          rationaleDeferred: 2,
          expectationMissing: 3,
          reviews: 3,
          previousReviews: 2,
          lessons: [
            {
              decisionId: "recent-2",
              question: "本地模型输出达到上限时如何处理？",
              project: "local-tools",
              sourceClient: "claude-code",
              verdict: "worse",
              lesson:
                "只加一句提示词约束没有用，2B 模型照样写满输出上限；下次先量输入长度，再决定要不要放宽上限。",
              expectedOutcome: "加一句提示词约束后，输出不再写满上限。",
              reviewedAt: "2026-08-01T09:30:00.000Z",
            },
            {
              decisionId: "recent-4",
              question: "本地模型输出达到上限时如何处理？",
              project: "decision",
              sourceClient: "claude-code",
              verdict: "mixed",
              lesson: null,
              expectedOutcome: null,
              reviewedAt: "2026-07-31T09:30:00.000Z",
            },
            {
              decisionId: "recent-1",
              question: "决策工作流应该从设置中拆出吗？",
              project: "decision",
              sourceClient: "codex",
              verdict: "as_expected",
              lesson: "紧凑信息架构更适合高频回看。",
              expectedOutcome: null,
              reviewedAt: "2026-07-30T09:30:00.000Z",
            },
          ],
          repeats: [
            {
              question: "决策工作流应该从设置中拆出吗？",
              decisionIds: ["recent-1", "recent-3", "recent-5"],
              projects: 2,
              consistentAnswers: true,
            },
            {
              question: "本地模型输出达到上限时如何处理？",
              decisionIds: ["recent-2", "recent-4"],
              projects: 2,
              consistentAnswers: true,
            },
          ],
          projects: [
            { label: "local-tools", count: 4 },
            { label: "decision", count: 3 },
          ],
          principles: [
            {
              id: "principle-preview-accepted",
              title: "先稳定骨架，再扩展功能入口",
              count: 3,
            },
          ],
        },
        {
          days: 30,
          startDate: "2026-07-04",
          endDate: "2026-08-02",
          decisions: 19,
          previousDecisions: 12,
          rationaleCaptured: 15,
          rationaleDeferred: 3,
          expectationMissing: 6,
          reviews: 9,
          previousReviews: 6,
          lessons: [
            {
              decisionId: "recent-2",
              question: "本地模型输出达到上限时如何处理？",
              project: "local-tools",
              sourceClient: "claude-code",
              verdict: "worse",
              lesson:
                "只加一句提示词约束没有用，2B 模型照样写满输出上限；下次先量输入长度，再决定要不要放宽上限。",
              expectedOutcome: "加一句提示词约束后，输出不再写满上限。",
              reviewedAt: "2026-08-01T09:30:00.000Z",
            },
            {
              decisionId: "recent-1",
              question: "决策工作流应该从设置中拆出吗？",
              project: "decision",
              sourceClient: "codex",
              verdict: "better",
              lesson: "紧凑信息架构更适合高频回看。",
              expectedOutcome: null,
              reviewedAt: "2026-07-30T09:30:00.000Z",
            },
          ],
          repeats: [
            {
              question: "决策工作流应该从设置中拆出吗？",
              decisionIds: ["recent-1", "recent-3", "recent-5", "recent-7"],
              projects: 2,
              consistentAnswers: true,
            },
          ],
          projects: [
            { label: "decision", count: 9 },
            { label: "local-tools", count: 7 },
            { label: "bridge", count: 3 },
          ],
          principles: [
            {
              id: "principle-preview-accepted",
              title: "先稳定骨架，再扩展功能入口",
              count: 7,
            },
          ],
        },
      ],
    },
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
  const previewProviders: RetrievalAnswerProvider[] = [
    {
      profileId: "qwen-local",
      label: "Qwen 本地模型",
      kind: "qwen",
      model: "Qwen3.5-2B",
      leavesDevice: false,
    },
    {
      profileId: "openai-remote",
      label: "OpenAI",
      kind: "openai",
      model: "gpt-5",
      leavesDevice: true,
    },
  ];
  const previewCitations = [
    {
      index: 1,
      kind: "principle" as const,
      title: "配置变更先在可验证环境落地",
      reference: "Decision Journal/methodology/配置变更先在可验证环境落地.md",
      excerpt:
        "一次变更同时影响 dev 与 production 时，先在可验证环境落地，再随真正开放动作推进线上。",
      matchReason: "综合命中",
    },
    {
      index: 2,
      kind: "decision" as const,
      title: "模型价格本轮要同步到其它配置吗？",
      reference: "decisions/2026/07/模型价格同步范围.md",
      excerpt: "不把暂未开放的能力写进线上配置；本轮只保证 dev 环境完整可验。",
      matchReason: "关键词命中",
    },
    {
      index: 3,
      kind: "decision" as const,
      title: "模型价格覆盖放在 conf.d 还是主配置？",
      reference: "decisions/2026/08/价格覆盖存放位置.md",
      excerpt: "覆盖文件独立存放，回滚时不牵动主配置。",
      matchReason: "语义相关",
    },
    {
      index: 4,
      kind: "note" as const,
      title: "发布窗口与配置变更的关系 · 未决",
      reference: "Decision Journal/ideas/2026/08/发布窗口与配置.md",
      excerpt: "还没想清楚灰度期间两份配置怎么对账，先记下来。",
      matchReason: "语义相关",
    },
  ];
  if (preview === "assistant") {
    // Conversations live in local storage, so an untouched preview opens on an
    // empty page — the one place the answer, its citations and the footer are
    // drawn would never be rendered by a screenshot or a layout check.
    window.localStorage.setItem(
      "decision.assistant.sessions.v2",
      JSON.stringify({
        activeId: "preview-conversation",
        conversations: [
          {
            id: "preview-conversation",
            title: "",
            updatedAt: Date.parse("2026-07-31T10:30:00.000Z"),
            profileId: previewProviders[0]!.profileId,
            scope: "all",
            messages: [
              { role: "user", content: "配置变更这件事我之前是怎么决定的？" },
              {
                role: "assistant",
                content:
                  "两条历史决策指向同一条判断：配置变更先在可验证环境落地，再随真正开放动作推进线上[1]。7 月 30 日那次写的理由是「不把暂未开放的能力写进线上配置」[2]。",
                citations: previewCitations,
                turnId: "preview-turn",
                provider: previewProviders[0],
                steps: [
                  { kind: "search", query: "配置变更 测试环境", scope: "all", hits: 3 },
                  { kind: "read", title: "模型价格本轮要同步到其它配置吗？" },
                  { kind: "answer" },
                ],
                tokens: {
                  input: 18_400,
                  output: 1_200,
                  unreportedSteps: 0,
                  cost: { currency: "¥", amount: 0.42 },
                },
              },
            ],
          },
        ],
      }),
    );
  }

  return {
    ...createEvidencePreviewApi(previewDecisions),
    getSnapshot: async () => snapshot,
    listPrConnections: async () => [{ id: "00000000-0000-4000-8000-000000000011", label: "示例 GitHub", platform: "github", baseUrl: "https://github.com" }],
    savePrConnection: async (input) => [{ id: input.id ?? "00000000-0000-4000-8000-000000000012", label: input.label, platform: input.platform, baseUrl: input.baseUrl }],
    removePrConnection: async () => [],
    checkPrConnection: async () => ({ account: "preview-user" }),
    listPullRequests: async () => ({ items: [{ reference: "sample/app#123", number: "123", repository: "sample/app", title: "示例：调整请求超时", author: "Example", updatedAt: "2026-09-21T10:00:00Z" }], nextPage: null }),
    loadPrReviewFile: async input => ({ content: input.side === "old" ? "export async function request(url: string) {\n  return fetch(url);\n}\n// Requests have no timeout\n" : "// Requests to the upstream service, with a deadline.\nimport { config } from \"./config\";\n\nexport interface RequestOptions {\n  /** How long to wait, in milliseconds. */\n  timeoutMs?: number;\n}\n\nexport async function request(url: string, options: RequestOptions = {}) {\n  const controller = new AbortController();\n  const timeoutMs = options.timeoutMs ?? config.timeoutMs;\n  setTimeout(() => controller.abort(), timeoutMs);\n  return fetch(url, { signal: controller.signal });\n}\n\nexport const DEFAULT_TIMEOUT_MS = 5000;\n", binary: false }),
    getPrActionContext: async input => ({ ...input, platform: "github", title: "示例：调整请求超时", sourceBranch: "feature/timeout", destinationBranch: "main", state: "open", canReview: true }),
    performPrAction: async input => ({ action: input.action, message: "界面预览：操作已模拟，未写入代码平台。" }),
    publishPrReviewComment: async () => ({ message: "界面预览：评论已模拟，未写入代码平台。" }),
    publishPrGeneralComment: async () => ({ message: "界面预览：评论已模拟，未写入代码平台。" }),
    openReviewRulesDirectory: async () => undefined,
    listPrDiscussion: async () => ({ more: false, comments: [
      { id: "2", url: "https://github.com/sample/app/pull/123#discussion_r2", author: "Example", path: "src/request.ts", line: 12, body: "超时统一放在请求层处理，调用方不再各自设置；这样重试和取消只有一处。", createdAt: "2026-09-21T10:40:00Z" },
      { id: "1", url: "https://github.com/sample/app/pull/123#discussion_r1", author: "Reviewer", path: null, line: null, body: "整体思路没问题。", createdAt: "2026-09-21T10:30:00Z" },
    ].map((comment) => ({ ...comment, decisionId: previewCommentDecisions.get(comment.url) ?? null })) }),
    openPrLink: async () => undefined,
    openPr: async () => undefined,
    reevaluatePrReviewFinding: async () => ({ verdict: "replace", reason: "预览示例：问题成立，但原文没有说明结束时要清理计时器。", replacement: { title: "超时后应取消底层请求并清理计时器", body: "超时只拒绝了等待中的 Promise，底层请求仍在运行，会继续占用连接。\n\n请把 AbortSignal 传给请求，并在请求结束或超时时清理计时器。" } }),
    peekPrReview: async () => null,
    prefetchPrReviews: async () => undefined,
    loadPrReviewDiff: async () => ({ diff: "diff --git a/src/request.ts b/src/request.ts\nindex 1111111..2222222 100644\n--- a/src/request.ts\n+++ b/src/request.ts\n@@ -1,4 +1,5 @@\n export async function request(url: string) {\n-  return fetch(url);\n+  const controller = new AbortController();\n+  setTimeout(() => controller.abort(), 5000);\n+  return fetch(url, { signal: controller.signal });\n }\n-// Requests have no timeout\n" }),
    loadPrReview: async (input) => ({ snapshotId: "00000000-0000-4000-8000-000000000001", reference: input.reference, batchCount: 1, title: "示例：调整请求超时", description: "为请求添加超时保护。", project: "sample", sourceCommit: "a".repeat(40), destinationCommit: "b".repeat(40), files: [{ path: "src/request.ts", status: "modified" }], fileBatches: { "src/request.ts": 1 }, fileHunks: { "src/request.ts": [420] }, changeSize: { added: 12, removed: 4, testFiles: 0, codeFiles: 1 }, warnings: [], rules: [{ id: "team/timeout.md", source: "code-meeseeks" }], existingComments: 2 }),
    runPrReview: async (input) => ({ reviewedFiles: ["src/request.ts"], unreviewedFiles: [], history: [
      { runId: input.runId, id: "batch-0", at: "2026-09-21T10:00:00Z", kind: "status", status: "done", group: 0, message: "评审分组 1/1：src/request.ts" },
      { runId: input.runId, id: "preview-step-1", at: "2026-09-21T10:00:00Z", kind: "tool", status: "done", group: 0, message: "检索与本组相关的决策：没有相关决策", detail: "当前预览没有真实证据。" },
      { runId: input.runId, id: "preview-step-2", at: "2026-09-21T10:00:01Z", kind: "tool", status: "done", group: 0, message: "读取源码 src/request.ts 第 1–80 行" },
      { runId: input.runId, id: "preview-step-3", at: "2026-09-21T10:00:02Z", kind: "tool", status: "done", group: 0, message: "提交本组结论：1 个问题" },
      { runId: input.runId, id: "verify-0", at: "2026-09-21T10:00:03Z", kind: "model", status: "done", message: "核验候选问题 1/1" }], status: "completed", summary: "预览示例：应核对超时后是否释放资源。", findings: [{ priority: "P2", title: "超时后请求仍在运行", body: "计时器只拒绝等待中的 Promise，底层请求不会取消。应将 AbortSignal 传入请求，并在结束时清理计时器。", path: "src/request.ts", side: "new", line: 12, decisionIndexes: [] }], evidence: [], readFiles: ["src/request.ts"], unreadFiles: [], warnings: ["此为界面预览，未连接代码平台或调用模型。"], steps: 3, groups: 1, filtered: [{ finding: { priority: "P3", title: "超时时间写死", body: "超时值写成常量，调用方无法调整。", path: "src/request.ts", side: "new", line: 11, decisionIndexes: [] }, score: 45, reason: "超时值本来就由调用方传入，变更前也是这样，不是这次引入的问题。" }] }),
    followUpPrReview: async () => ({ answer: "可以将取消信号传给底层请求，并在超时时调用 `abort()`。这项建议针对本次提交，尚未运行测试。" }),
    cancelPrReview: async () => undefined,
    onPrReviewProgress: () => () => undefined,
    listAssistantModels: async () => previewProviders,
    checkAssistantSource: async () => ({ status: "review", content: "当前笔记：配置变更需经过验证，再逐步放开。", truncated: false }),
    searchAssistantSources: async () => ({ sources: previewCitations, issues: [] }),
    runAssistantTurn: async (input) => {
      const provider =
        previewProviders.find(
          (candidate) => candidate.profileId === input.profileId,
        ) ?? previewProviders[0]!;
      return {
        version: 1,
        status: "answered",
        message: {
          role: "assistant",
          content:
            "两条历史决策指向同一条判断：配置变更先在可验证环境落地，再随真正开放动作推进线上[1]。7 月 30 日那次写的理由是「不把暂未开放的能力写进线上配置」[2]。",
          citations: previewCitations,
          steps: [
            { kind: "search", query: "配置变更 测试环境", scope: input.scope, hits: 3 },
            { kind: "search", query: "线上配置 未开放能力", scope: input.scope, hits: 2 },
            { kind: "answer" },
          ],
        },
        provider,
        durationMs: provider.leavesDevice ? 2_100 : 1_400,
        requestId: "assistant:preview",
        truncated: false,
      };
    },
    onSnapshot: (listener) => {
      snapshotListeners.add(listener);
      return () => { snapshotListeners.delete(listener); };
    },
    submitRationale: async () => undefined,
    retryPersistence: async () => undefined,
    openCandidateReview: async () => undefined,
    closeCandidateReview: async () => undefined,
    confirmCandidate: async () => undefined,
    ignoreCandidate: async () => undefined,
    retryCandidate: async () => undefined,
    openSurface: async (primarySurface) => {
      snapshot = { ...snapshot, primarySurface };
      for (const listener of snapshotListeners) listener(snapshot);
    },
    closePrimarySurface: async () => undefined,
    listDecisionProjects: async () => {
      const counts = new Map<string, number>();
      for (const decision of previewDecisions) {
        const project = decision.project.trim();
        if (project) counts.set(project, (counts.get(project) ?? 0) + 1);
      }
      return [...counts].map(([project, count]) => ({ project, count }))
        .sort((left, right) => right.count - left.count || left.project.localeCompare(right.project));
    },
    listDecisions: async (query) => {
      // The real index caps every read; a preview that hands back the whole
      // fixture measures layouts against row counts the app never produces.
      const matched = await (async (): Promise<DecisionLibraryItem[]> => {
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
        if (query.reviewState === "expectation_missing") {
          return previewDecisions.filter(
            (decision) => !decision.expectedOutcome && decision.outcome === null,
          );
        }
        if (query.reviewState === "unscheduled") {
          return previewDecisions.filter(
            (decision) =>
              decision.outcomeReview === null && decision.reviewDueDate === null,
          );
        }
        return previewDecisions;
      })();
      const since =
        query.createdSince === undefined ? null : Date.parse(query.createdSince);
      const windowed = matched.filter(
        (decision) =>
          (since === null || Date.parse(decision.created) >= since) &&
          (query.project === undefined || decision.project.trim() === query.project) &&
          (query.outcomeVerdict === undefined ||
            decision.outcomeReview?.verdict === query.outcomeVerdict),
      );
      return query.limit === undefined
        ? windowed
        : windowed.slice(0, Math.max(0, Math.trunc(query.limit)));
    },
    createProactiveRecord: async (input) => {
      const recordId = `preview-${input.kind}-${crypto.randomUUID()}`;
      if (input.kind === "decision") {
        if (input.sourceUrl !== undefined) previewCommentDecisions.set(input.sourceUrl, recordId);
        previewDecisions.unshift({
          id: recordId, created: new Date().toISOString(), sourceClient: input.sourceUrl === undefined ? "manual" : "pr-comment",
          ...(input.sourceUrl === undefined ? {} : { sourceUrl: input.sourceUrl }),
          project: input.project ?? "", question: input.title, selectedAnswer: input.content,
          rationaleStatus: input.rationale ? "captured" : "skipped",
          rationale: input.rationale ?? null, context: input.context ?? null,
          expectedOutcome: input.expectedOutcome ?? null,
          outcome: null, outcomeReview: null, reviewDueDate: input.reviewDueDate ?? null,
          appliedPrincipleIds: [], appliedPrinciples: [],
        });
      } else {
        previewJournalEntries.unshift(createJournalEntry({
          title: input.title, content: input.content, tags: input.tags,
          context: input.context ?? null, rationale: input.rationale ?? null,
          ...(input.languages === undefined ? {} : { languages: input.languages }),
          ...(input.knowledgeStatus === undefined ? {} : { knowledgeStatus: input.knowledgeStatus }),
          ...(input.kind === "preference" ? {
            kind: input.kind, appliesWhen: input.appliesWhen ?? null, exceptions: input.exceptions ?? null,
            ...(input.strength === undefined ? {} : { strength: input.strength }),
            ...(input.evidenceMaturity === undefined ? {} : { evidenceMaturity: input.evidenceMaturity }),
          } : {
            kind: input.kind, whyInteresting: input.whyInteresting ?? null, nextTest: input.nextTest ?? null,
            ...(input.ideaForm === undefined ? {} : { ideaForm: input.ideaForm }),
            openQuestions: input.openQuestions, incubateUntil: input.incubateUntil ?? null,
          }),
        }, {
          sourceKind: input.sourceKind, sourceForm: input.sourceForm,
          sensitivity: input.sensitivity, project: input.project ?? null,
        }, recordId, new Date()));
      }
      return {
      recordVersion: 1,
      status: "created",
      recordKind: input.kind,
      recordId,
      knowledgeStatus:
        input.kind === "preference" && input.appliesWhen !== undefined && input.exceptions !== undefined
          ? "active"
          : input.kind === "idea" && input.whyInteresting !== undefined
            ? "active"
            : input.kind === "decision"
              ? "active"
              : "inbox",
      sensitivity: input.sensitivity,
      storedTranscript: false,
      };
    },
    listJournalEntries: async (query) => {
      const wanted =
        query.query === undefined ? "" : query.query.trim().toLowerCase();
      return previewJournalEntries
        .filter(
          (entry) =>
            (query.kind === undefined || entry.kind === query.kind) &&
            (query.knowledgeStatus === undefined ||
              entry.knowledgeStatus === query.knowledgeStatus) &&
            (wanted.length === 0 ||
              JSON.stringify(entry)
                .toLowerCase()
                .includes(wanted)),
        )
        .slice(0, Math.max(0, Math.trunc(query.limit ?? 200)));
    },
    reviseJournalEntry: async (id, input) => {
      const index = previewJournalEntries.findIndex((entry) => entry.id === id);
      if (index < 0) throw new Error("记录不存在");
      const revised = reviseJournalEntry(previewJournalEntries[index]!, input.draft, input.change, new Date());
      previewJournalEntries[index] = revised;
      return revised;
    },
    getObsidianSearchStatus: async () => obsidianPreviewStatus,
    searchObsidian: async (input) => ({
      query: input.query,
      results:
        requestedInteraction === "indexing"
          ? []
          : previewObsidianSearchResults.map((result) =>
              requestedInteraction === "semantic-unavailable"
                ? { ...result, matchKind: "keyword" as const }
                : result,
            ),
      status: obsidianPreviewStatus,
    }),
    rebuildObsidianSearch: async () => ({
      ...obsidianPreviewStatus,
      state: "indexing",
      processedNotes: 0,
    }),
    exportAssistantConversation: async () => ({ status: "cancelled" as const }),
    getAssistantFeedbackSummary: async () => ({ helpful: 0, notHelpful: 0 }),
    saveAssistantFeedback: async () => ({ status: "saved" as const, recorded: 1 }),
    cancelAssistantTurn: async () => undefined,
    onAssistantProgress: () => () => undefined,
    openObsidianNote: async () => undefined,
    openVaultDocument: async () => undefined,
    updateDecisionExpectedOutcome: async (decisionId, expectedOutcome) => {
      const decision = previewDecisions.find((item) => item.id === decisionId);
      if (decision === undefined) throw new Error("记录不存在");
      if (decision.outcome !== null) throw new Error("已记录实际结果，不能再补写预期");
      decision.expectedOutcome = expectedOutcome;
    },
    updateDecisionOutcome: async (decisionId, outcome) => {
      const decision = previewDecisions.find((item) => item.id === decisionId);
      if (decision === undefined) throw new Error("记录不存在");
      decision.outcome = outcome;
    },
    updateDecisionReviewDueDate: async () => undefined,
    updateDecisionReview: async (decisionId, input) => {
      const decision = previewDecisions.find((item) => item.id === decisionId);
      if (decision === undefined) throw new Error("记录不存在");
      const review = { ...input, reviewedAt: "2026-08-02T10:00:00.000Z" };
      decision.outcomeReview = review;
      return review;
    },
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
              matchKind: "keyword" as const,
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
      blockers: [],
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
      signals: [
        {
          recordId: previewJournalEntries[0]?.id ?? "preference-rollback",
          kind: "preference" as const,
          title: "先留回滚入口，再扩大发布",
          summary: "不可逆的发布步骤要先有明确的回滚路径和负责人。",
          standing:
            "偏好：当前立场，允许例外；未经方法论流程确认前不是已采纳原则",
          qualifier:
            "适用：改动一旦上线就难以撤回时。｜例外：只影响本机、随时可以重装的改动。",
          relevanceScore: 21,
          relevance: "possible" as const,
          reason:
            "偏好与当前决策存在文本重合，共同出现“回滚”。它不是已采纳原则，只作为用户自己的偏好提醒。",
          matchedTerms: ["回滚"],
        },
      ],
      boundary: {
        advisoryOnly: true,
        noDecisionWritten: true,
        noPrincipleApplied: true,
        noPreferencePromoted: true,
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
    revealVault: async () => false,
    installIntegrations: async (mode) => ({
      mode,
      targets: [],
      commands: [],
      restartRequired: false,
    }),
    removeIntegrations: async () => ({ mode: "apply", targets: [], commands: [], restartRequired: false }),
    listLocalDecisions: async () => ({ records: [], total: 0 }),
    resolveLocalDecision: async () => undefined,
    rebuildIndex: async () => ({
      indexedCount: 0,
      diagnostics: [],
    }),
    setTheme: async () => undefined,
    listModelTraces: async () => {
      const { output: _output, ...base } = previewModelTrace;
      return preview === "activity" ? [{
      ...base, traceId: "preview-schema-failure", requestId: previewModelTraces[0]!.requestId,
      purpose: "pr-review", status: "failed", errorCode: "process_failed", processExitCode: 1,
      diagnosticExcerpt: JSON.stringify({ error: { code: "invalid_json_schema", message: "Invalid schema for response_format: actions.items.required is missing path." }, status: 400 }),
      profile: { ...previewModelTrace.profile, profileId: "builtin-codex", backend: "codex-cli", provider: "Codex CLI", model: "codex-default", promptVersion: "pr-review-v9", schemaVersion: "pr-review-action-batch-v2" },
      request: { configuredTimeoutMs: 30000, generationTimeoutMs: 30000, requestedMaxOutputTokens: 8192, systemPromptChars: "Review only the supplied changes.".length, userPromptChars: "Synthetic preview input.".length },
      input: { systemPrompt: "Review only the supplied changes.", userPrompt: "Synthetic preview input.", outputSchema: { type: "object", properties: { actions: { type: "array", items: { type: "object", properties: { action: { type: "string" }, path: { type: "string" } }, required: ["action"] } } } }, clientSystemPromptVisibility: "opaque" },
      usage: { source: "unavailable" }, timing: { queuedMs: 0, providerMs: 5000, totalMs: 5200 },
      createdAt: "2026-07-31T10:31:00.000Z",
    }, ...previewModelTraces] : [];
    },
    deleteModelTrace: async () => false,
    deleteModelTraceRequest: async () => 0,
    forgetAssistantTurns: async () => undefined,
    clearModelTraces: async () => 0,
    setModelTraceContentEnabled: async (modelTraceContentEnabled) => {
      snapshot = { ...snapshot, modelTraceContentEnabled };
      for (const listener of snapshotListeners) listener(snapshot);
    },
    setLocalCredentialsEnabled: async (localCredentialsEnabled) => {
      snapshot = { ...snapshot, localCredentialsEnabled };
      for (const listener of snapshotListeners) listener(snapshot);
    },
    setReviewRemindersEnabled: async (reviewRemindersEnabled) => {
      snapshot = { ...snapshot, reviewRemindersEnabled };
      for (const listener of snapshotListeners) listener(snapshot);
    },
    setCaptureClassifier: async () => undefined,
    listManagedQwenModels: async () => [
      { modelId: "qwen3.5-2b-q4-k-m", status: "available", downloadedBytes: 1329766560, totalBytes: 1329766560 },
      { modelId: "qwen3.5-4b-q4-k-m", status: "available", downloadedBytes: 3013027808, totalBytes: 3013027808 },
    ],
    installManagedQwenModel: async () => undefined,
    listModelProviderProfiles: async () =>
      showModelFixture ? previewProfiles : [],
    saveModelProviderProfile: async (input) => {
      const index = previewProfiles.findIndex((profile) => profile.profileId === input.profile.profileId);
      if (index < 0) previewProfiles.push(input.profile);
      else previewProfiles[index] = input.profile;
      return input.profile;
    },
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
