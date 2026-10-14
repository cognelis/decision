import { createEvidencePreviewApi } from "../src/renderer/evidence-preview-api.js";
import { DecisionCandidateQueue, RationaleQueue } from "@cognelis/decision-core";
import { describe, expect, it, vi } from "vitest";

import { DESKTOP_PRIMARY_SURFACES } from "../src/shared/renderer-api.js";
import { IPC_CHANNELS, registerDecisionIpc } from "../src/main/ipc.js";
import {
  OBSIDIAN_SEARCH_METHOD_NAMES,
  RENDERER_METHOD_NAMES,
} from "../src/shared/renderer-api.js";
import { serverCandidateFixture, serverCaptureFixture } from "./fixtures.js";

class FakeIpcMain {
  readonly handlers = new Map<
    string,
    (event: unknown, input?: unknown) => Promise<unknown> | unknown
  >();

  handle(
    channel: string,
    handler: (event: unknown, input?: unknown) => Promise<unknown> | unknown,
  ): void {
    this.handlers.set(channel, handler);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  invoke(channel: string, input?: unknown): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (handler === undefined) {
      throw new Error(`Missing handler: ${channel}`);
    }
    return Promise.resolve().then(() => handler({}, input));
  }
}

const operations = (overrides: Record<string, unknown> = {}) => ({
  openSurface: vi.fn(),
  closePrimarySurface: vi.fn(),
  listDecisions: vi.fn(async () => []),
  listDecisionProjects: vi.fn(async () => []),
  createProactiveRecord: vi.fn(),
  listJournalEntries: vi.fn(async () => []),
  reviseJournalEntry: vi.fn(),
  getObsidianSearchStatus: vi.fn(async () => obsidianStatus),
  searchObsidian: vi.fn(async (input) => ({
    query: input.query,
    results: [],
    status: obsidianStatus,
  })),
  rebuildObsidianSearch: vi.fn(async () => obsidianStatus),
  openObsidianNote: vi.fn(async () => undefined),
  updateDecisionExpectedOutcome: vi.fn(async () => undefined),
  updateDecisionOutcome: vi.fn(async () => undefined),
  updateDecisionReviewDueDate: vi.fn(async () => undefined),
  updateDecisionReview: vi.fn(async (_decisionId, input) => ({
    ...input,
    reviewedAt: "2026-08-02T10:00:00.000Z",
  })),
  updateDecisionAppliedPrinciples: vi.fn(async () => []),
  getDecisionPrincipleSuggestions: vi.fn(async () => []),
  validateDecisionAppliedPrinciples: vi.fn(async () => undefined),
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
  getMethodologyUsage: vi.fn(),
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
  openCandidateReview: vi.fn(),
  closeCandidateReview: vi.fn(),
  confirmCandidate: vi.fn(),
  ignoreCandidate: vi.fn(),
  retryCandidate: vi.fn(),
  chooseVault: vi.fn(async () => null),
  revealVault: vi.fn(async () => false),
  installIntegrations: vi.fn(),
  removeIntegrations: vi.fn(),
  rebuildIndex: vi.fn(),
  setTheme: vi.fn(),
  listModelTraces: vi.fn(async () => []),
  deleteModelTrace: vi.fn(),
  deleteModelTraceRequest: vi.fn(),
  forgetAssistantTurns: vi.fn(async () => undefined),
  clearModelTraces: vi.fn(async () => 0),
  setModelTraceContentEnabled: vi.fn(),
  setLocalCredentialsEnabled: vi.fn(async () => undefined),
  setReviewRemindersEnabled: vi.fn(async () => undefined),
  setCaptureClassifier: vi.fn(async () => undefined),
  listManagedQwenModels: async () => [],
  installManagedQwenModel: async () => undefined,
  listModelProviderProfiles: vi.fn(async () => []),
  saveModelProviderProfile: vi.fn(),
  deleteModelProviderProfile: vi.fn(),
  reorderModelProviderProfiles: vi.fn(),
  testModelProviderProfile: vi.fn(),
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
  listAssistantModels: vi.fn(async () => []),
  cancelAssistantTurn: vi.fn(async () => undefined),
  saveAssistantFeedback: vi.fn(async () => ({
    status: "saved" as const,
    recorded: 1,
  })),
  exportAssistantConversation: vi.fn(async () => ({
    status: "cancelled" as const,
  })),
  getAssistantFeedbackSummary: vi.fn(async () => ({
    helpful: 0,
    notHelpful: 0,
  })),
  listLocalModelClientStatuses: vi.fn(async () => []),
  ...overrides,
});

const obsidianStatus = {
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

const obsidianSearchResult = {
  relativePath: "Notes/architecture.md",
  title: "Architecture",
  heading: null,
  snippet: "A safe preview.",
  matchKind: "keyword" as const,
};

const expectGenericObsidianFailure = async (
  invocation: Promise<unknown>,
  expectedMessage: string,
): Promise<void> => {
  const error = await invocation.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  const message = error instanceof Error ? error.message : String(error);
  expect(message).toBe(expectedMessage);
  expect(message).not.toContain("/Users/private");
};

describe("decision IPC", () => {
  it("registers a handler for every channel the renderer can invoke", () => {
    const ipcMain = new FakeIpcMain();
    registerDecisionIpc({
      ipcMain,
      queue: new RationaleQueue(),
      operations: operations(),
    });

    // Push-only channels flow main → renderer, so they carry no handler; every
    // other channel the preload can invoke must answer, or the call resolves
    // to nothing at runtime while every unit test stays green.
    const pushOnly = new Set<string>([
      IPC_CHANNELS.snapshotChanged,
      IPC_CHANNELS.assistantProgress, IPC_CHANNELS.prReviewProgress,
    ]);
    const invocable = Object.values(IPC_CHANNELS).filter(
      (channel) => !pushOnly.has(channel),
    );

    expect(
      invocable.filter((channel) => !ipcMain.handlers.has(channel)),
    ).toEqual([]);
  });

  it("exposes the complete renderer capability list", () => {
    expect(RENDERER_METHOD_NAMES).toEqual([
      "getSnapshot",
      "onSnapshot",
      "submitRationale",
      "retryPersistence",
      "openCandidateReview",
      "closeCandidateReview",
      "confirmCandidate",
      "ignoreCandidate",
      "retryCandidate",
      "openSurface",
      "closePrimarySurface",
      "listDecisions",
      "listDecisionProjects",
      "listLocalDecisions",
      "resolveLocalDecision",
      "createProactiveRecord",
      "listJournalEntries",
      "reviseJournalEntry",
      "getObsidianSearchStatus",
      "searchObsidian",
      "rebuildObsidianSearch",
      "checkAssistantSource",
      "searchAssistantSources",
      "listPrConnections",
      "savePrConnection",
      "removePrConnection",
      "checkPrConnection",
      "listPullRequests",
      "loadPrReview",
      "peekPrReview",
      "prefetchPrReviews",
      "loadPrReviewDiff",
      "getPrActionContext",
      "performPrAction",
      "publishPrReviewComment",
      "publishPrGeneralComment",
      "reevaluatePrReviewFinding",
      "openReviewRulesDirectory",
      "listPrDiscussion",
      "openPrLink",
      "openPr",
      "loadPrReviewFile",
      "runPrReview",
      "followUpPrReview",
      "cancelPrReview",
      "onPrReviewProgress",
      "runAssistantTurn",
      "listAssistantModels",
      "cancelAssistantTurn",
      "saveAssistantFeedback",
      "exportAssistantConversation",
      "getAssistantFeedbackSummary",
      "onAssistantProgress",
      "openObsidianNote",
      "openVaultDocument",
      "saveDecisionContextFeedback",
      "getDecisionContextFeedback",
      "searchDecisionContext",
      "updateDecisionScope",
      "updateDecisionRelation",
      "openDecisionSource",
      "prepareDecisionHandoff",
      "updateDecisionExpectedOutcome",
      "updateDecisionOutcome",
      "updateDecisionReviewDueDate",
      "updateDecisionReview",
      "updateDecisionAppliedPrinciples",
      "getDecisionPrincipleSuggestions",
      "getMethodologyBuildProgress",
      "listMethodologies",
      "createManualMethodology",
      "createManualMethodologyFromEvidence",
      "listManualFormDrafts",
      "saveManualFormDraft",
      "deleteManualFormDraft",
      "generateMethodology",
      "createMethodologyMergeDraft",
      "createMethodologyRevisionDraft",
      "reviseMethodology",
      "setMethodologyStatus",
      "listMethodologyVersions",
      "restoreMethodologyVersion",
      "getMethodologySuggestions",
      "getDeferredMethodologySuggestions",
      "deferMethodologySuggestion",
      "restoreMethodologySuggestion",
      "getMethodologyEvidenceMatches",
      "importMethodologyMarkdown",
      "commitMethodologyMarkdownImport",
      "setMethodologyEvidence",
      "setMethodologyRelation",
      "clearMethodologyRelation",
      "getMethodologyUsage",
      "getMethodologyValidationInbox",
      "acknowledgeMethodologyValidation",
      "getMethodologyMergePlan",
      "prepareMethodologyMergeAsset",
      "retireMethodologyMergeSources",
      "restoreMethodologyMergeSources",
      "getDecisionAnalytics",
      "getDecisionConsultationMetrics",
      "previewDecisionConsultation",
      "submitDecisionConsultationFeedback",
      "getKnowledgeGraph",
      "listPracticeAssets",
      "createManualPracticeAsset",
      "generatePracticeAsset",
      "revisePracticeAsset",
      "setPracticeAssetStatus",
      "regeneratePracticeAsset",
      "listPracticeAssetVersions",
      "restorePracticeAssetVersion",
      "listPracticePublicationStatuses",
      "publishPracticeAsset",
      "rollbackPracticeAssetPublication",
      "chooseVault",
      "revealVault",
      "installIntegrations",
      "removeIntegrations",
      "rebuildIndex",
      "setTheme",
      "listModelTraces",
      "deleteModelTrace",
      "deleteModelTraceRequest",
      "forgetAssistantTurns",
      "clearModelTraces",
      "setModelTraceContentEnabled",
      "setReviewRemindersEnabled",
      "setLocalCredentialsEnabled",
      "setCaptureClassifier",
      "listManagedQwenModels",
      "installManagedQwenModel",
      "listModelProviderProfiles",
      "saveModelProviderProfile",
      "deleteModelProviderProfile",
      "reorderModelProviderProfiles",
      "testModelProviderProfile",
      "listLocalModelClientStatuses",
    ]);
  });

  it("exposes only the Obsidian full-vault search capability", () => {
    expect(OBSIDIAN_SEARCH_METHOD_NAMES).toEqual([
      "getObsidianSearchStatus",
      "searchObsidian",
      "rebuildObsidianSearch",
      "openObsidianNote",
    ]);
  });

  it("validates desktop evidence requests and returned contracts before forwarding", async () => {
    const ipcMain = new FakeIpcMain();
    const scope = vi.fn(async () => ({ status: "saved", revision: 1, originalNoteUnchanged: true }));
    const relation = vi.fn(async () => ({ status: "saved", revision: 1, originalNotesUnchanged: true }));
    const open = vi.fn(async () => ({ status: "opened", relativePath: "Decision Journal/decisions/A.md", noNoteWritten: true }));
    const preview = createEvidencePreviewApi();
    registerDecisionIpc({ ipcMain, queue: new RationaleQueue(), operations: operations({ ...preview, updateDecisionScope: scope, updateDecisionRelation: relation, openDecisionSource: open }) });
    const reference = { source: "decisions", recordId: "A", expectedContentHash: "a".repeat(64) };
    await expect(ipcMain.invoke(IPC_CHANNELS.searchDecisionContext, { recordId: "A" })).resolves.toMatchObject({ results: [expect.objectContaining({ id: "A" })] });
    await expect(ipcMain.invoke(IPC_CHANNELS.updateDecisionScope, { ...reference, expectedRevision: 0, scope: { projects: ["demo"] }, changeReason: "明确限定项目" })).resolves.toMatchObject({ status: "saved" });
    await expect(ipcMain.invoke(IPC_CHANNELS.updateDecisionRelation, { first: { source: "decisions", recordId: "A", contentHash: "a".repeat(64) }, second: { source: "summarize", recordId: "B", contentHash: "b".repeat(64) }, disposition: "conflict", expectedRevision: 0, reason: "确认冲突" })).resolves.toMatchObject({ status: "saved" });
    await expect(ipcMain.invoke(IPC_CHANNELS.openDecisionSource, reference)).resolves.toMatchObject({ status: "opened" });
    await expect(ipcMain.invoke(IPC_CHANNELS.prepareDecisionHandoff, { objective: "继续", references: [reference] })).resolves.toMatchObject({ boundary: { noNoteWritten: true, taskClaimsVerified: false } });
    await expect(ipcMain.invoke(IPC_CHANNELS.openDecisionSource, { ...reference, path: "../../other.md" })).rejects.toThrow();
    await expect(ipcMain.invoke(IPC_CHANNELS.updateDecisionScope, { ...reference, expectedRevision: 0, scope: { paths: ["../other"] }, changeReason: "wrong" })).rejects.toThrow();
    expect(open).toHaveBeenCalledTimes(1); expect(scope).toHaveBeenCalledTimes(1);
    open.mockResolvedValueOnce({ status: "opened", relativePath: "", noNoteWritten: true });
    await expect(ipcMain.invoke(IPC_CHANNELS.openDecisionSource, reference)).rejects.toThrow();
  });

  it("validates the local credential switch at the IPC boundary", async () => {
    const ipcMain = new FakeIpcMain();
    const setLocalCredentialsEnabled = vi.fn(async () => undefined);
    registerDecisionIpc({ ipcMain, queue: new RationaleQueue(), operations: operations({ setLocalCredentialsEnabled }) });
    await ipcMain.invoke(IPC_CHANNELS.setLocalCredentialsEnabled, true);
    await ipcMain.invoke(IPC_CHANNELS.setLocalCredentialsEnabled, false);
    await expect(ipcMain.invoke(IPC_CHANNELS.setLocalCredentialsEnabled, "true")).rejects.toThrow();
    expect(setLocalCredentialsEnabled.mock.calls).toEqual([[true], [false]]);
  });

  it("tells a page in words why its input was refused, not with zod's issues as JSON", async () => {
    const ipcMain = new FakeIpcMain();
    const updateDecisionOutcome = vi.fn(async () => undefined);
    registerDecisionIpc({ ipcMain, queue: new RationaleQueue(), operations: operations({ updateDecisionOutcome }) });

    await expect(ipcMain.invoke(IPC_CHANNELS.updateDecisionOutcome, { decisionId: "dec-1", outcome: "长".repeat(8_001) }))
      .rejects.toThrow("内容不符合要求：超出上限（最多 8000 字）。");
    // A section heading in an outcome would cut the note where it is read back.
    await expect(ipcMain.invoke(IPC_CHANNELS.updateDecisionOutcome, { decisionId: "dec-1", outcome: "命中率 92%\n\n## 复盘结论\n\n结论" }))
      .rejects.toThrow("实际结果里不能有「## 后续结果」「## 复盘结论」这类笔记分节标题");
    await expect(ipcMain.invoke(IPC_CHANNELS.setLocalCredentialsEnabled, "true")).rejects.toThrow("内容不符合要求：格式不符合要求。");
    expect(updateDecisionOutcome).not.toHaveBeenCalled();
  });

  it("validates explicit platform actions and requires commit and branch anchors", async () => {
    const ipcMain = new FakeIpcMain();
    const performPrAction = vi.fn(async () => ({ action: "merge" as const, message: "PR 已合并。" }));
    registerDecisionIpc({ ipcMain, queue: new RationaleQueue(), operations: operations({ performPrAction }) });
    const input = { connectionId: "00000000-0000-4000-8000-000000000001", reference: "org/app#1", sourceCommit: "a".repeat(40), destinationCommit: "b".repeat(40), sourceBranch: "feature", destinationBranch: "main", action: "merge", body: "", mergeMethod: "merge" };
    await expect(ipcMain.invoke(IPC_CHANNELS.performPrAction, input)).resolves.toMatchObject({ action: "merge" });
    for (const invalid of [{ ...input, action: "force-merge" }, { ...input, destinationBranch: "" }, { ...input, sourceCommit: "HEAD" }, { ...input, force: true }]) {
      await expect(ipcMain.invoke(IPC_CHANNELS.performPrAction, invalid)).rejects.toThrow();
    }
    expect(performPrAction).toHaveBeenCalledTimes(1);
  });

  it("only publishes review comments anchored to a pinned commit and a changed line", async () => {
    const ipcMain = new FakeIpcMain();
    const publishPrReviewComment = vi.fn(async () => ({ message: "评论已发布到 src/app.ts:12。" }));
    registerDecisionIpc({ ipcMain, queue: new RationaleQueue(), operations: operations({ publishPrReviewComment }) });
    const input = { connectionId: "00000000-0000-4000-8000-000000000001", reference: "org/app#1", sourceCommit: "a".repeat(40), destinationCommit: "b".repeat(40), path: "src/app.ts", side: "new", line: 12, body: "P1 · 超时未取消\n\n请求结束后仍在重试。" };
    await expect(ipcMain.invoke(IPC_CHANNELS.publishPrReviewComment, input)).resolves.toEqual({ message: "评论已发布到 src/app.ts:12。" });
    for (const invalid of [{ ...input, body: "   " }, { ...input, line: 0 }, { ...input, side: "both" }, { ...input, path: "../secrets" }, { ...input, sourceCommit: "HEAD" }, { ...input, approve: true }]) {
      await expect(ipcMain.invoke(IPC_CHANNELS.publishPrReviewComment, invalid)).rejects.toThrow();
    }
    expect(publishPrReviewComment).toHaveBeenCalledTimes(1);
  });

  it("opens a PR's own page only for a linked connection and a PR reference", async () => {
    const ipcMain = new FakeIpcMain();
    const openPr = vi.fn(async () => undefined);
    registerDecisionIpc({ ipcMain, queue: new RationaleQueue(), operations: operations({ openPr }) });
    const input = { connectionId: "00000000-0000-4000-8000-000000000001", reference: "org/app#1" };
    await expect(ipcMain.invoke(IPC_CHANNELS.openPr, input)).resolves.toBeUndefined();
    for (const invalid of [{ ...input, connectionId: "not-a-uuid" }, { ...input, reference: " " }, { ...input, url: "https://evil.example" }]) {
      await expect(ipcMain.invoke(IPC_CHANNELS.openPr, invalid)).rejects.toThrow();
    }
    expect(openPr).toHaveBeenCalledWith(input);
  });

  it("checks a link only by its id and returns nothing but the account name", async () => {
    const ipcMain = new FakeIpcMain();
    const checkPrConnection = vi.fn(async () => ({ account: "octo" }));
    registerDecisionIpc({ ipcMain, queue: new RationaleQueue(), operations: operations({ checkPrConnection }) });
    const id = "00000000-0000-4000-8000-000000000001";
    await expect(ipcMain.invoke(IPC_CHANNELS.checkPrConnection, id)).resolves.toEqual({ account: "octo" });
    await expect(ipcMain.invoke(IPC_CHANNELS.checkPrConnection, "not-a-uuid")).rejects.toThrow();
    checkPrConnection.mockResolvedValueOnce({ account: "octo", token: "secret" } as never);
    await expect(ipcMain.invoke(IPC_CHANNELS.checkPrConnection, id)).rejects.toThrow();
    expect(checkPrConnection).toHaveBeenCalledTimes(2);
  });

  it("only publishes a PR-wide comment with text, pinned to the commits it was written for", async () => {
    const ipcMain = new FakeIpcMain();
    const publishPrGeneralComment = vi.fn(async () => ({ message: "评论已发布到 PR。" }));
    registerDecisionIpc({ ipcMain, queue: new RationaleQueue(), operations: operations({ publishPrGeneralComment }) });
    const input = { connectionId: "00000000-0000-4000-8000-000000000001", reference: "org/app#1", sourceCommit: "a".repeat(40), destinationCommit: "b".repeat(40), body: "## PR 概览" };
    await expect(ipcMain.invoke(IPC_CHANNELS.publishPrGeneralComment, input)).resolves.toEqual({ message: "评论已发布到 PR。" });
    for (const invalid of [{ ...input, body: "   " }, { ...input, sourceCommit: "HEAD" }, { ...input, path: "src/app.ts" }, { ...input, merge: true }]) {
      await expect(ipcMain.invoke(IPC_CHANNELS.publishPrGeneralComment, invalid)).rejects.toThrow();
    }
    expect(publishPrGeneralComment).toHaveBeenCalledTimes(1);
  });

  it("validates a finding re-evaluation and its verdict", async () => {
    const ipcMain = new FakeIpcMain();
    const reevaluatePrReviewFinding = vi.fn(async () => ({ verdict: "keep" as const, reason: "成立。", replacement: null }));
    registerDecisionIpc({ ipcMain, queue: new RationaleQueue(), operations: operations({ reevaluatePrReviewFinding }) });
    const snapshot = { snapshotId: "00000000-0000-4000-8000-000000000002", reference: "org/app#1", title: "PR", description: "", project: "app", sourceCommit: "a".repeat(40), destinationCommit: "b".repeat(40), files: [{ path: "src/app.ts", status: "modified" }], warnings: [] };
    const input = { runId: "00000000-0000-4000-8000-000000000003", profileId: "local", snapshot, finding: { priority: "P1", title: "超时", body: "未取消请求。", path: "src/app.ts", side: "new", line: 3, decisionIndexes: [] }, summary: "一处问题" };
    await expect(ipcMain.invoke(IPC_CHANNELS.reevaluatePrReviewFinding, input)).resolves.toEqual({ verdict: "keep", reason: "成立。", replacement: null });
    for (const invalid of [{ ...input, finding: { ...input.finding, line: 0 } }, { ...input, profileId: "" }, { ...input, extra: true }]) {
      await expect(ipcMain.invoke(IPC_CHANNELS.reevaluatePrReviewFinding, invalid)).rejects.toThrow();
    }
    reevaluatePrReviewFinding.mockResolvedValueOnce({ verdict: "approve" } as never);
    await expect(ipcMain.invoke(IPC_CHANNELS.reevaluatePrReviewFinding, input)).rejects.toThrow();
  });

  it("validates pinned PR diff and file requests and bounds their responses", async () => {
    const ipcMain = new FakeIpcMain();
    const loadPrReviewDiff = vi.fn(async () => ({ diff: "patch" }));
    const loadPrReviewFile = vi.fn(async () => ({ content: "source", binary: false }));
    registerDecisionIpc({ ipcMain, queue: new RationaleQueue(), operations: operations({ loadPrReviewDiff, loadPrReviewFile }) });
    const input = { connectionId: "00000000-0000-4000-8000-000000000001", reference: "org/app#1", sourceCommit: "a".repeat(40), destinationCommit: "b".repeat(40) };
    await expect(ipcMain.invoke(IPC_CHANNELS.loadPrReviewDiff, input)).resolves.toEqual({ diff: "patch" });
    await expect(ipcMain.invoke(IPC_CHANNELS.loadPrReviewDiff, { ...input, sourceCommit: "main" })).rejects.toThrow();
    await expect(ipcMain.invoke(IPC_CHANNELS.loadPrReviewFile, { ...input, path: "src/a.ts", side: "new" })).resolves.toEqual({ content: "source", binary: false });
    await expect(ipcMain.invoke(IPC_CHANNELS.loadPrReviewFile, { ...input, path: "../secret", side: "new" })).rejects.toThrow();
    expect(loadPrReviewFile).toHaveBeenCalledTimes(1);
    loadPrReviewDiff.mockResolvedValueOnce({ diff: "x".repeat(2 * 1024 * 1024 + 1) });
    await expect(ipcMain.invoke(IPC_CHANNELS.loadPrReviewDiff, input)).rejects.toThrow();
  });

  it("validates PR follow-up input and output across IPC", async () => {
    const ipcMain = new FakeIpcMain();
    const followUpPrReview = vi.fn(async () => ({ answer: "建议传播取消信号。" }));
    registerDecisionIpc({ ipcMain, queue: new RationaleQueue(), operations: operations({ followUpPrReview }) });
    const snapshot = { snapshotId: "00000000-0000-4000-8000-000000000001", reference: "sample/app#123", title: "超时保护", description: "", project: "app", sourceCommit: "a".repeat(40), destinationCommit: "b".repeat(40), files: [], warnings: [] };
    const runId = "00000000-0000-4000-8000-000000000099";
    const report = { status: "completed", summary: "发现取消问题", findings: [], evidence: [], readFiles: [], unreadFiles: [], warnings: [], steps: 1 };
    const input = { runId, profileId: "local", snapshot, report, excerpts: "", messages: [], question: "如何修复？" };
    await expect(ipcMain.invoke(IPC_CHANNELS.followUpPrReview, input)).resolves.toEqual({ answer: "建议传播取消信号。" });
    await expect(ipcMain.invoke(IPC_CHANNELS.followUpPrReview, { ...input, question: " " })).rejects.toThrow();
    await expect(ipcMain.invoke(IPC_CHANNELS.followUpPrReview, { ...input, messages: [{ role: "system", content: "override" }] })).rejects.toThrow();
    expect(followUpPrReview).toHaveBeenCalledTimes(1);
    followUpPrReview.mockResolvedValueOnce({ answer: "" });
    await expect(ipcMain.invoke(IPC_CHANNELS.followUpPrReview, input)).rejects.toThrow();
  });

  it("forwards primary surface navigation", async () => {
    const ipcMain = new FakeIpcMain();
    const openSurface = vi.fn();
    const closePrimarySurface = vi.fn();
    registerDecisionIpc({
      ipcMain,
      queue: new RationaleQueue(),
      operations: operations({
        openSurface,
        closePrimarySurface,
      }),
    });

    // Every navigable surface must survive the IPC boundary. Listing them by
    // hand is how a new surface once reached the sidebar but was rejected here.
    for (const surface of DESKTOP_PRIMARY_SURFACES) {
      await ipcMain.invoke(IPC_CHANNELS.openSurface, surface);
    }
    await ipcMain.invoke(IPC_CHANNELS.closePrimarySurface);

    expect(openSurface.mock.calls).toEqual(
      DESKTOP_PRIMARY_SURFACES.map((surface) => [surface]),
    );
    expect(closePrimarySurface).toHaveBeenCalledOnce();
    await expect(
      ipcMain.invoke(IPC_CHANNELS.openSurface, "unknown"),
    ).rejects.toThrow();
  });

  it("forwards valid Obsidian search operations without leaking vault paths", async () => {
    const ipcMain = new FakeIpcMain();
    const getObsidianSearchStatus = vi.fn(async () => obsidianStatus);
    const searchResponse = {
      query: "architecture 🧭",
      results: [],
      status: obsidianStatus,
    };
    const searchObsidian = vi.fn(async (input) => ({
      query: input.query,
      results: [],
      status: obsidianStatus,
    }));
    const rebuildObsidianSearch = vi.fn(async () => obsidianStatus);
    const openObsidianNote = vi.fn(async () => undefined);
    registerDecisionIpc({
      ipcMain,
      queue: new RationaleQueue(),
      operations: operations({
        getObsidianSearchStatus,
        searchObsidian,
        rebuildObsidianSearch,
        openObsidianNote,
      }),
    });

    await expect(
      ipcMain.invoke(IPC_CHANNELS.getObsidianSearchStatus),
    ).resolves.toEqual(obsidianStatus);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.searchObsidian, {
        query: "  architecture 🧭  ",
      }),
    ).resolves.toEqual(searchResponse);
    await ipcMain.invoke(IPC_CHANNELS.searchObsidian, {
      query: "note",
      limit: 12,
    });
    await expect(
      ipcMain.invoke(IPC_CHANNELS.rebuildObsidianSearch),
    ).resolves.toEqual(obsidianStatus);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.openObsidianNote, "目录/ 计划 #? .MD"),
    ).resolves.toBeUndefined();

    expect(getObsidianSearchStatus).toHaveBeenCalledOnce();
    expect(searchObsidian.mock.calls).toEqual([
      [{ query: "architecture 🧭" }],
      [{ query: "note", limit: 12 }],
    ]);
    expect(rebuildObsidianSearch).toHaveBeenCalledOnce();
    expect(openObsidianNote).toHaveBeenCalledOnce();
    expect(openObsidianNote).toHaveBeenCalledWith("目录/ 计划 #? .MD");
  });

  it("rejects malformed Obsidian search input before operations", async () => {
    const ipcMain = new FakeIpcMain();
    const searchObsidian = vi.fn();
    registerDecisionIpc({
      ipcMain,
      queue: new RationaleQueue(),
      operations: operations({ searchObsidian }),
    });

    for (const input of [
      null,
      [],
      "query",
      { query: "   " },
      { query: "😀".repeat(501) },
      { query: "x".repeat(1_000_000) },
      { query: "x", limit: 0 },
      { query: "x", limit: 51 },
      { query: "x", limit: 1.5 },
      { query: "x", limit: Number.NaN },
      { query: "x", extra: true },
    ]) {
      await expect(
        ipcMain.invoke(IPC_CHANNELS.searchObsidian, input),
      ).rejects.toThrow();
    }
    expect(searchObsidian).not.toHaveBeenCalled();
  });

  it("accepts exact Unicode code-point boundaries for Obsidian inputs", async () => {
    const ipcMain = new FakeIpcMain();
    const searchObsidian = vi.fn(async (input) => ({
      query: input.query,
      results: [],
      status: obsidianStatus,
    }));
    const openObsidianNote = vi.fn(async () => undefined);
    registerDecisionIpc({
      ipcMain,
      queue: new RationaleQueue(),
      operations: operations({ searchObsidian, openObsidianNote }),
    });
    const exactQuery = "😀".repeat(500);
    const exactPath = `${"😀".repeat(4_093)}.md`;

    await expect(
      ipcMain.invoke(IPC_CHANNELS.searchObsidian, { query: exactQuery }),
    ).resolves.toMatchObject({ query: exactQuery });
    await expect(
      ipcMain.invoke(IPC_CHANNELS.openObsidianNote, exactPath),
    ).resolves.toBeUndefined();
    await expect(
      ipcMain.invoke(IPC_CHANNELS.searchObsidian, {
        query: "😀".repeat(501),
      }),
    ).rejects.toThrow();
    await expect(
      ipcMain.invoke(IPC_CHANNELS.openObsidianNote, `${"😀".repeat(4_094)}.md`),
    ).rejects.toThrow();

    expect(searchObsidian).toHaveBeenCalledOnce();
    expect(openObsidianNote).toHaveBeenCalledOnce();
  });

  it("rejects unsafe Obsidian note paths before operations", async () => {
    const ipcMain = new FakeIpcMain();
    const openObsidianNote = vi.fn();
    registerDecisionIpc({
      ipcMain,
      queue: new RationaleQueue(),
      operations: operations({ openObsidianNote }),
    });

    for (const input of [
      "",
      "bad\0name.md",
      "/absolute.md",
      "C:/absolute.md",
      "C:relative.md",
      "folder\\note.md",
      ".md",
      ".MD",
      ".Md",
      "../note.md",
      "folder/./note.md",
      "folder/../note.md",
      "folder//note.md",
      "folder/note.txt",
      `${"😀".repeat(4_097)}.md`,
      { relativePath: "note.md" },
    ]) {
      await expect(
        ipcMain.invoke(IPC_CHANNELS.openObsidianNote, input),
      ).rejects.toThrow();
    }
    expect(openObsidianNote).not.toHaveBeenCalled();
  });

  it("rejects unexpected input for argument-free Obsidian operations", async () => {
    const ipcMain = new FakeIpcMain();
    const getObsidianSearchStatus = vi.fn();
    const rebuildObsidianSearch = vi.fn();
    registerDecisionIpc({
      ipcMain,
      queue: new RationaleQueue(),
      operations: operations({
        getObsidianSearchStatus,
        rebuildObsidianSearch,
      }),
    });

    await expect(
      ipcMain.invoke(IPC_CHANNELS.getObsidianSearchStatus, {}),
    ).rejects.toThrow();
    await expect(
      ipcMain.invoke(IPC_CHANNELS.rebuildObsidianSearch, "unexpected"),
    ).rejects.toThrow();
    expect(getObsidianSearchStatus).not.toHaveBeenCalled();
    expect(rebuildObsidianSearch).not.toHaveBeenCalled();
  });

  it("does not expose an unavailable Obsidian operation", async () => {
    const ipcMain = new FakeIpcMain();
    registerDecisionIpc({
      ipcMain,
      queue: new RationaleQueue(),
      operations: operations({
        getObsidianSearchStatus: undefined,
        searchObsidian: undefined,
        rebuildObsidianSearch: undefined,
        openObsidianNote: undefined,
      }),
    });

    await expectGenericObsidianFailure(
      ipcMain.invoke(IPC_CHANNELS.getObsidianSearchStatus),
      "无法获取 Obsidian 搜索状态",
    );
    await expectGenericObsidianFailure(
      ipcMain.invoke(IPC_CHANNELS.searchObsidian, { query: "note" }),
      "无法搜索 Obsidian 笔记",
    );
    await expectGenericObsidianFailure(
      ipcMain.invoke(IPC_CHANNELS.rebuildObsidianSearch),
      "无法重建 Obsidian 搜索索引",
    );
    await expectGenericObsidianFailure(
      ipcMain.invoke(IPC_CHANNELS.openObsidianNote, "Notes/note.md"),
      "无法打开 Obsidian 笔记",
    );
  });

  it("redacts malformed Obsidian operation outputs and failures", async () => {
    const ipcMain = new FakeIpcMain();
    const malformedStatus = { ...obsidianStatus, indexedNotes: -1 };
    const searchObsidian = vi
      .fn()
      .mockResolvedValueOnce({
        query: "note",
        results: [
          { ...obsidianSearchResult, relativePath: "/Users/private/note.md" },
        ],
        status: obsidianStatus,
      })
      .mockResolvedValueOnce({
        query: "note",
        results: [{ ...obsidianSearchResult, snippet: "x".repeat(261) }],
        status: obsidianStatus,
      });
    registerDecisionIpc({
      ipcMain,
      queue: new RationaleQueue(),
      operations: operations({
        getObsidianSearchStatus: vi.fn(async () => malformedStatus),
        searchObsidian,
        rebuildObsidianSearch: vi.fn(async () => {
          throw new Error("/Users/private/rebuild failure");
        }),
        openObsidianNote: vi.fn(async () => "/Users/private/opened"),
      }),
    });

    await expectGenericObsidianFailure(
      ipcMain.invoke(IPC_CHANNELS.getObsidianSearchStatus),
      "无法获取 Obsidian 搜索状态",
    );
    await expectGenericObsidianFailure(
      ipcMain.invoke(IPC_CHANNELS.searchObsidian, { query: "note" }),
      "无法搜索 Obsidian 笔记",
    );
    await expectGenericObsidianFailure(
      ipcMain.invoke(IPC_CHANNELS.searchObsidian, { query: "note" }),
      "无法搜索 Obsidian 笔记",
    );
    await expectGenericObsidianFailure(
      ipcMain.invoke(IPC_CHANNELS.rebuildObsidianSearch),
      "无法重建 Obsidian 搜索索引",
    );
    await expectGenericObsidianFailure(
      ipcMain.invoke(IPC_CHANNELS.openObsidianNote, "Notes/note.md"),
      "无法打开 Obsidian 笔记",
    );
  });

  it("accepts service snippets at the grapheme boundary", async () => {
    const ipcMain = new FakeIpcMain();
    const composedGrapheme = "e\u0301";
    const searchObsidian = vi
      .fn()
      .mockResolvedValueOnce({
        query: "note",
        results: [
          { ...obsidianSearchResult, snippet: composedGrapheme.repeat(260) },
        ],
        status: obsidianStatus,
      })
      .mockResolvedValueOnce({
        query: "note",
        results: [
          { ...obsidianSearchResult, snippet: composedGrapheme.repeat(261) },
        ],
        status: obsidianStatus,
      })
      .mockResolvedValueOnce({
        query: "note",
        results: [{ ...obsidianSearchResult, snippet: "\u0301".repeat(4_097) }],
        status: obsidianStatus,
      });
    registerDecisionIpc({
      ipcMain,
      queue: new RationaleQueue(),
      operations: operations({ searchObsidian }),
    });

    await expect(
      ipcMain.invoke(IPC_CHANNELS.searchObsidian, { query: "note" }),
    ).resolves.toMatchObject({
      results: [{ snippet: composedGrapheme.repeat(260) }],
    });
    await expectGenericObsidianFailure(
      ipcMain.invoke(IPC_CHANNELS.searchObsidian, { query: "note" }),
      "无法搜索 Obsidian 笔记",
    );
    await expectGenericObsidianFailure(
      ipcMain.invoke(IPC_CHANNELS.searchObsidian, { query: "note" }),
      "无法搜索 Obsidian 笔记",
    );
  });

  it("permits only bounded public Obsidian status messages", async () => {
    const ipcMain = new FakeIpcMain();
    const statusWithMessage = (message: string) => ({
      ...obsidianStatus,
      state: "unavailable" as const,
      message,
    });
    const getObsidianSearchStatus = vi
      .fn()
      .mockResolvedValueOnce(statusWithMessage("新的安全提示"))
      .mockResolvedValueOnce(statusWithMessage("/private/db"))
      .mockResolvedValueOnce(statusWithMessage("C:\\private"))
      .mockResolvedValueOnce(statusWithMessage("first\nsecond"));
    registerDecisionIpc({
      ipcMain,
      queue: new RationaleQueue(),
      operations: operations({ getObsidianSearchStatus }),
    });

    await expect(
      ipcMain.invoke(IPC_CHANNELS.getObsidianSearchStatus),
    ).resolves.toEqual(statusWithMessage("新的安全提示"));
    for (const _ of ["/private/db", "C:\\private", "first\nsecond"]) {
      await expectGenericObsidianFailure(
        ipcMain.invoke(IPC_CHANNELS.getObsidianSearchStatus),
        "无法获取 Obsidian 搜索状态",
      );
    }
  });

  it("unregisters every Obsidian handler", () => {
    const ipcMain = new FakeIpcMain();
    const unregister = registerDecisionIpc({
      ipcMain,
      queue: new RationaleQueue(),
      operations: operations(),
    });
    const obsidianChannels = [
      IPC_CHANNELS.getObsidianSearchStatus,
      IPC_CHANNELS.searchObsidian,
      IPC_CHANNELS.rebuildObsidianSearch,
      IPC_CHANNELS.openObsidianNote,
    ];

    expect(
      obsidianChannels.every((channel) => ipcMain.handlers.has(channel)),
    ).toBe(true);
    unregister();
    expect(
      obsidianChannels.every((channel) => ipcMain.handlers.has(channel)),
    ).toBe(false);
  });

  it("validates decision library queries before reading local history", async () => {
    const ipcMain = new FakeIpcMain();
    const listDecisions = vi.fn(async () => []);
    const updateDecisionOutcome = vi.fn(async () => undefined);
    const updateDecisionReviewDueDate = vi.fn(async () => undefined);
    const updateDecisionReview = vi.fn(async (_decisionId, input) => ({
      ...input,
      reviewedAt: "2026-08-02T10:00:00.000Z",
    }));
    const updateDecisionAppliedPrinciples = vi.fn(async () => []);
    registerDecisionIpc({
      ipcMain,
      queue: new RationaleQueue(),
      operations: operations({
        listDecisions,
        updateDecisionOutcome,
        updateDecisionReviewDueDate,
        updateDecisionReview,
        updateDecisionAppliedPrinciples,
      }),
    });

    await ipcMain.invoke(IPC_CHANNELS.listDecisions, {
      query: "缓存策略",
      rationaleStatus: "captured",
      sourceClient: "codex",
      reviewState: "pending_review",
      searchMode: "semantic",
      limit: 80,
    });

    expect(listDecisions).toHaveBeenCalledWith({
      query: "缓存策略",
      rationaleStatus: "captured",
      sourceClient: "codex",
      reviewState: "pending_review",
      searchMode: "semantic",
      limit: 80,
    });
    await ipcMain.invoke(IPC_CHANNELS.listDecisions, {
      query: "",
      decisionId: " decision-1 ",
      limit: 1,
    });
    expect(listDecisions).toHaveBeenLastCalledWith({
      query: "",
      decisionId: "decision-1",
      limit: 1,
    });
    await expect(
      ipcMain.invoke(IPC_CHANNELS.listDecisions, {
        query: "",
        decisionId: " ",
      }),
    ).rejects.toThrow();
    await expect(
      ipcMain.invoke(IPC_CHANNELS.listDecisions, {
        query: "x".repeat(201),
      }),
    ).rejects.toThrow();
    await expect(
      ipcMain.invoke(IPC_CHANNELS.listDecisions, {
        query: "",
        sourceClient: "unknown",
      }),
    ).rejects.toThrow();
    await expect(
      ipcMain.invoke(IPC_CHANNELS.listDecisions, {
        query: "缓存策略",
        searchMode: "fuzzy",
      }),
    ).rejects.toThrow();

    await ipcMain.invoke(IPC_CHANNELS.updateDecisionOutcome, {
      decisionId: "decision-1",
      outcome: "实际结果符合预期。",
    });
    expect(updateDecisionOutcome).toHaveBeenCalledWith(
      "decision-1",
      "实际结果符合预期。",
    );
    await expect(
      ipcMain.invoke(IPC_CHANNELS.updateDecisionOutcome, {
        decisionId: "decision-1",
        outcome: "   ",
      }),
    ).rejects.toThrow();

    await ipcMain.invoke(IPC_CHANNELS.updateDecisionReviewDueDate, {
      decisionId: "decision-1",
      reviewDueDate: "2026-08-15",
    });
    expect(updateDecisionReviewDueDate).toHaveBeenCalledWith(
      "decision-1",
      "2026-08-15",
    );
    await expect(
      ipcMain.invoke(IPC_CHANNELS.updateDecisionReviewDueDate, {
        decisionId: "decision-1",
        reviewDueDate: "2026-02-31",
      }),
    ).rejects.toThrow();

    await expect(
      ipcMain.invoke(IPC_CHANNELS.updateDecisionReview, {
        decisionId: "decision-1",
        verdict: "mixed",
        lesson: "方向正确，但低估了迁移成本。",
      }),
    ).resolves.toMatchObject({
      verdict: "mixed",
      reviewedAt: "2026-08-02T10:00:00.000Z",
    });
    expect(updateDecisionReview).toHaveBeenCalledWith("decision-1", {
      verdict: "mixed",
      lesson: "方向正确，但低估了迁移成本。",
    });
    await expect(
      ipcMain.invoke(IPC_CHANNELS.updateDecisionReview, {
        decisionId: "decision-1",
        verdict: "invented",
        lesson: null,
      }),
    ).rejects.toThrow();

    await ipcMain.invoke(IPC_CHANNELS.updateDecisionAppliedPrinciples, {
      decisionId: "decision-1",
      principleIds: ["principle-1", "principle-2"],
    });
    expect(updateDecisionAppliedPrinciples).toHaveBeenCalledWith("decision-1", [
      "principle-1",
      "principle-2",
    ]);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.updateDecisionAppliedPrinciples, {
        decisionId: "decision-1",
        principleIds: ["principle-1", "principle-1"],
      }),
    ).rejects.toThrow();
    await expect(
      ipcMain.invoke(IPC_CHANNELS.updateDecisionAppliedPrinciples, {
        decisionId: "decision-1",
        principleIds: ["1", "2", "3", "4", "5", "6"],
      }),
    ).rejects.toThrow();
  });

  it("validates proactive recording and journal revision inputs", async () => {
    const ipcMain = new FakeIpcMain();
    const createProactiveRecord = vi.fn(async () => ({
      recordVersion: 1,
      status: "created",
      recordKind: "preference",
      recordId: "preference-1",
      knowledgeStatus: "active",
      sensitivity: "private",
      storedTranscript: false,
    }));
    const listJournalEntries = vi.fn(async () => []);
    const reviseJournalEntry = vi.fn();
    registerDecisionIpc({
      ipcMain,
      queue: new RationaleQueue(),
      operations: operations({
        createProactiveRecord,
        listJournalEntries,
        reviseJournalEntry,
      }),
    });

    const preference = {
      kind: "preference",
      title: "常规实现决策默认由系统自主完成",
      content: "普通可逆的方向与实现由系统自行判断并交付结果。",
      sourceKind: "offline_conversation",
      sourceForm: "user_paraphrase",
      sensitivity: "private",
      project: "decision",
      appliesWhen: "既定目标和仓库范围内的普通产品与工程取舍。",
      exceptions: "权限、付费、不可逆操作、公开范围或核心验收冲突。",
      strength: "default",
      evidenceMaturity: "self_declared",
      tags: ["协作偏好"],
    };
    await ipcMain.invoke(IPC_CHANNELS.createProactiveRecord, preference);
    expect(createProactiveRecord).toHaveBeenCalledWith(preference);
    // The languages a preference is specific to cross as typed, both when it is recorded and when it is revised.
    await ipcMain.invoke(IPC_CHANNELS.createProactiveRecord, { ...preference, languages: ["Go"] });
    expect(createProactiveRecord).toHaveBeenLastCalledWith({ ...preference, languages: ["Go"] });
    const revision = {
      id: "preference-1",
      draft: { kind: "preference", title: preference.title, content: preference.content, languages: ["go", "TS"] },
      change: { changeNote: "限定语言", sourceKind: "app_manual", sourceForm: "user_original" },
    };
    await ipcMain.invoke(IPC_CHANNELS.reviseJournalEntry, revision);
    expect(reviseJournalEntry).toHaveBeenCalledWith("preference-1", { draft: revision.draft, change: revision.change });
    await expect(ipcMain.invoke(IPC_CHANNELS.reviseJournalEntry, {
      ...revision, draft: { ...revision.draft, languages: Array.from({ length: 9 }, (_, index) => `l${index}`) },
    })).rejects.toThrow();

    await ipcMain.invoke(IPC_CHANNELS.listJournalEntries, {
      query: "自主完成",
      kind: "preference",
      knowledgeStatus: "active",
      limit: 20,
    });
    expect(listJournalEntries).toHaveBeenCalledWith({
      query: "自主完成",
      kind: "preference",
      knowledgeStatus: "active",
      limit: 20,
    });

    await expect(
      ipcMain.invoke(IPC_CHANNELS.createProactiveRecord, {
        ...preference,
        transcript: "should never cross IPC",
      }),
    ).rejects.toThrow();
    // A decision's expected outcome the note would read back as one of its own sections: refused in words.
    await expect(
      ipcMain.invoke(IPC_CHANNELS.createProactiveRecord, {
        kind: "decision",
        title: "缓存怎么做",
        content: "本地缓存",
        sourceKind: "app_manual",
        sourceForm: "user_original",
        sensitivity: "private",
        options: [],
        tags: [],
        expectedOutcome: "## 复盘结论 之前先看命中率",
      }),
    ).rejects.toThrow("预期结果里不能有「## 后续结果」「## 复盘结论」这类笔记分节标题");
    expect(createProactiveRecord).toHaveBeenCalledTimes(2);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.listJournalEntries, {
        query: "",
        vaultPath: "/private/vault",
      }),
    ).rejects.toThrow();
  });

  it("validates methodology generation, revision, and confirmation inputs", async () => {
    const ipcMain = new FakeIpcMain();
    const listMethodologies = vi.fn(async () => []);
    const getMethodologyBuildProgress = vi.fn(async () => ({
      decisions: {
        total: 8,
        pendingOutcome: 3,
        pendingReview: 2,
        reviewed: 3,
      },
      principles: { candidate: 1, accepted: 2, retired: 0, dismissed: 1 },
      practiceAssets: { candidate: 1, accepted: 1, dismissed: 0 },
    }));
    const generateMethodology = vi.fn(async () => ({ id: "principle-1" }));
    const createManualMethodology = vi.fn(async () => ({
      id: "principle-manual",
    }));
    const createManualMethodologyFromEvidence = vi.fn(async () => ({
      id: "principle-manual-evidence",
    }));
    const listManualFormDrafts = vi.fn(async () => []);
    const saveManualFormDraft = vi.fn(async (input) => ({
      ...input,
      updatedAt: "2026-08-08T10:00:00.000Z",
    }));
    const deleteManualFormDraft = vi.fn(async () => undefined);
    const createMethodologyMergeDraft = vi.fn(async () => ({
      id: "principle-merge",
    }));
    const createMethodologyRevisionDraft = vi.fn(async () => ({
      id: "principle-revision",
    }));
    const reviseMethodology = vi.fn(async () => ({ id: "principle-1" }));
    const setMethodologyStatus = vi.fn(async () => ({ id: "principle-1" }));
    const listMethodologyVersions = vi.fn(async () => []);
    const restoreMethodologyVersion = vi.fn(async () => ({
      id: "principle-1",
    }));
    const getMethodologySuggestions = vi.fn(async () => []);
    const getDeferredMethodologySuggestions = vi.fn(async () => []);
    const deferMethodologySuggestion = vi.fn(async () => undefined);
    const restoreMethodologySuggestion = vi.fn(async () => undefined);
    const getMethodologyEvidenceMatches = vi.fn(async () => []);
    const importMethodologyMarkdown = vi.fn(async () => ({
      cancelled: false,
      batchId: null,
      candidates: [],
      duplicates: [],
      failures: [],
    }));
    const commitMethodologyMarkdownImport = vi.fn(async () => ({
      imported: [],
      duplicates: [],
      failures: [],
    }));
    const setMethodologyEvidence = vi.fn(async () => ({
      id: "principle-1",
    }));
    const setMethodologyRelation = vi.fn(async () => ({
      id: "principle-1",
    }));
    const clearMethodologyRelation = vi.fn(async () => ({
      id: "principle-1",
    }));
    const getMethodologyUsage = vi.fn(async () => ({
      principleId: "principle-1",
    }));
    const getMethodologyValidationInbox = vi.fn(async () => []);
    const acknowledgeMethodologyValidation = vi.fn(async () => ({
      id: "principle-1",
    }));
    const getMethodologyMergePlan = vi.fn(async () => ({
      mergeId: "principle-merge",
    }));
    const prepareMethodologyMergeAsset = vi.fn(async () => ({
      id: "workflow-replacement",
    }));
    const retireMethodologyMergeSources = vi.fn(async () => ({
      mergeId: "principle-merge",
      retired: true,
    }));
    const restoreMethodologyMergeSources = vi.fn(async () => ({
      mergeId: "principle-merge",
      retired: false,
    }));
    const getKnowledgeGraph = vi.fn(async () => ({
      projects: [],
      decisions: [],
      outcomes: [],
      principles: [],
      principleRelations: [],
      edges: [],
      missingSourceDecisionIds: [],
    }));
    registerDecisionIpc({
      ipcMain,
      queue: new RationaleQueue(),
      operations: operations({
        getMethodologyBuildProgress,
        listMethodologies,
        createManualMethodology,
        createManualMethodologyFromEvidence,
        listManualFormDrafts,
        saveManualFormDraft,
        deleteManualFormDraft,
        generateMethodology,
        createMethodologyMergeDraft,
        createMethodologyRevisionDraft,
        reviseMethodology,
        setMethodologyStatus,
        listMethodologyVersions,
        restoreMethodologyVersion,
        getMethodologySuggestions,
        getDeferredMethodologySuggestions,
        deferMethodologySuggestion,
        restoreMethodologySuggestion,
        getMethodologyEvidenceMatches,
        importMethodologyMarkdown,
        commitMethodologyMarkdownImport,
        setMethodologyEvidence,
        setMethodologyRelation,
        clearMethodologyRelation,
        getMethodologyUsage,
        getMethodologyValidationInbox,
        acknowledgeMethodologyValidation,
        getMethodologyMergePlan,
        prepareMethodologyMergeAsset,
        retireMethodologyMergeSources,
        restoreMethodologyMergeSources,
        getKnowledgeGraph,
      }),
    });

    await expect(
      ipcMain.invoke(IPC_CHANNELS.getMethodologyBuildProgress),
    ).resolves.toMatchObject({
      decisions: { total: 8, reviewed: 3 },
      principles: { candidate: 1, accepted: 2 },
    });
    expect(getMethodologyBuildProgress).toHaveBeenCalledOnce();
    await expect(
      ipcMain.invoke(IPC_CHANNELS.getMethodologyBuildProgress, {}),
    ).rejects.toThrow();

    await ipcMain.invoke(IPC_CHANNELS.listMethodologies, "candidate");
    expect(listMethodologies).toHaveBeenCalledWith("candidate");
    await expect(
      ipcMain.invoke(IPC_CHANNELS.listMethodologies, "published"),
    ).rejects.toThrow();

    const manual = {
      title: "人工原则",
      principle: "先写清边界，再决定是否自动化。",
      appliesWhen: "问题与接口仍在变化时。",
      caution: "人工成本不可接受时重新评估。",
    };
    await ipcMain.invoke(IPC_CHANNELS.createManualMethodology, manual);
    expect(createManualMethodology).toHaveBeenCalledWith(manual);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.createManualMethodology, {
        ...manual,
        principle: " ",
      }),
    ).rejects.toThrow();

    const manualEvidence = {
      ...manual,
      evidenceSummary: "两条复盘都支持先验证边界。",
      sourceDecisionIds: ["decision-1", "decision-2"],
    };
    await ipcMain.invoke(
      IPC_CHANNELS.createManualMethodologyFromEvidence,
      manualEvidence,
    );
    expect(createManualMethodologyFromEvidence).toHaveBeenCalledWith(
      manualEvidence,
    );
    await expect(
      ipcMain.invoke(IPC_CHANNELS.createManualMethodologyFromEvidence, {
        ...manualEvidence,
        sourceDecisionIds: [],
      }),
    ).rejects.toThrow();

    await expect(
      ipcMain.invoke(IPC_CHANNELS.listManualFormDrafts),
    ).resolves.toEqual([]);
    const incompleteDraft = {
      key: "methodology_manual" as const,
      input: { ...manual, principle: "" },
    };
    await ipcMain.invoke(IPC_CHANNELS.saveManualFormDraft, incompleteDraft);
    expect(saveManualFormDraft).toHaveBeenCalledWith(incompleteDraft);
    const mergeDraft = {
      key: "methodology_merge" as const,
      sourcePrincipleIds: ["principle-1", "principle-2"],
      input: {
        ...manualEvidence,
        sourceDecisionIds: [],
      },
    };
    await ipcMain.invoke(IPC_CHANNELS.saveManualFormDraft, mergeDraft);
    expect(saveManualFormDraft).toHaveBeenCalledWith(mergeDraft);
    const revisionDraft = {
      key: "methodology_revision" as const,
      sourcePrincipleId: "principle-1",
      sourceUpdatedAt: "2026-08-08T09:00:00.000Z",
      sourceSnapshot: {
        ...manualEvidence,
        title: "修订前原则",
        sourceDecisionIds: ["decision-1"],
      },
      input: {
        ...manualEvidence,
        sourceDecisionIds: [],
      },
    };
    await ipcMain.invoke(IPC_CHANNELS.saveManualFormDraft, revisionDraft);
    expect(saveManualFormDraft).toHaveBeenCalledWith(revisionDraft);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.saveManualFormDraft, {
        ...mergeDraft,
        sourcePrincipleIds: ["principle-1"],
      }),
    ).rejects.toThrow();
    await expect(
      ipcMain.invoke(IPC_CHANNELS.saveManualFormDraft, {
        ...revisionDraft,
        sourceSnapshot: {
          ...revisionDraft.sourceSnapshot,
          sourceDecisionIds: [
            "decision-1",
            "decision-2",
            "decision-3",
            "decision-4",
            "decision-5",
            "decision-6",
          ],
        },
      }),
    ).rejects.toThrow();
    await expect(
      ipcMain.invoke(IPC_CHANNELS.saveManualFormDraft, {
        ...incompleteDraft,
        unexpected: true,
      }),
    ).rejects.toThrow();
    await ipcMain.invoke(
      IPC_CHANNELS.deleteManualFormDraft,
      "methodology_manual",
    );
    expect(deleteManualFormDraft).toHaveBeenCalledWith("methodology_manual");
    await expect(
      ipcMain.invoke(IPC_CHANNELS.deleteManualFormDraft, "all"),
    ).rejects.toThrow();

    await ipcMain.invoke(IPC_CHANNELS.generateMethodology, [
      "decision-1",
      "decision-2",
    ]);
    expect(generateMethodology).toHaveBeenCalledWith([
      "decision-1",
      "decision-2",
    ]);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.generateMethodology, [
        "decision-1",
        "decision-1",
      ]),
    ).rejects.toThrow();

    const merge = {
      sourcePrincipleIds: ["principle-1", "principle-2", "principle-3"],
      title: "可逆变更验证",
      principle: "先验证可回退路径，再扩大不可逆投入。",
      appliesWhen: "关键结果仍需真实运行验证时。",
      caution: "验证窗口不能覆盖主要风险时不适用。",
      evidenceSummary: "合并保留两条原则已有的复盘依据。",
      sourceDecisionIds: ["decision-1", "decision-2"],
    };
    await ipcMain.invoke(IPC_CHANNELS.createMethodologyMergeDraft, merge);
    expect(createMethodologyMergeDraft).toHaveBeenCalledWith(
      merge.sourcePrincipleIds,
      {
        title: merge.title,
        principle: merge.principle,
        appliesWhen: merge.appliesWhen,
        caution: merge.caution,
        evidenceSummary: merge.evidenceSummary,
        sourceDecisionIds: merge.sourceDecisionIds,
      },
    );
    await expect(
      ipcMain.invoke(IPC_CHANNELS.createMethodologyMergeDraft, {
        ...merge,
        sourcePrincipleIds: ["principle-1", "principle-1"],
        sourceDecisionIds: [],
      }),
    ).rejects.toThrow();
    await expect(
      ipcMain.invoke(IPC_CHANNELS.createMethodologyMergeDraft, {
        ...merge,
        sourcePrincipleIds: [
          "principle-1",
          "principle-2",
          "principle-3",
          "principle-4",
          "principle-5",
          "principle-6",
        ],
      }),
    ).rejects.toThrow();

    const evolution = {
      id: "principle-1",
      title: "可逆优先，并增加停止条件",
      principle: "先验证可回退路径；进入不可逆步骤前重新核对证据。",
      appliesWhen: "需求仍有关键未知项且影响范围会继续扩大时。",
      caution: "硬截止时间不能替代停止条件。",
      evidenceSummary: "新增复盘补充了不可逆步骤前的边界。",
      sourceDecisionIds: ["decision-1", "decision-2"],
    };
    await ipcMain.invoke(
      IPC_CHANNELS.createMethodologyRevisionDraft,
      evolution,
    );
    expect(createMethodologyRevisionDraft).toHaveBeenCalledWith("principle-1", {
      title: evolution.title,
      principle: evolution.principle,
      appliesWhen: evolution.appliesWhen,
      caution: evolution.caution,
      evidenceSummary: evolution.evidenceSummary,
      sourceDecisionIds: evolution.sourceDecisionIds,
    });
    await expect(
      ipcMain.invoke(IPC_CHANNELS.createMethodologyRevisionDraft, {
        ...evolution,
        sourceDecisionIds: [],
      }),
    ).rejects.toThrow();

    const revision = {
      id: "principle-1",
      title: "可逆优先",
      principle: "先验证可回退路径，再扩大改动。",
      appliesWhen: "需求仍有关键未知项时。",
      caution: "切换成本快速增长时重新评估。",
      evidenceSummary: "证据 1 支持该候选原则。",
    };
    await ipcMain.invoke(IPC_CHANNELS.reviseMethodology, revision);
    expect(reviseMethodology).toHaveBeenCalledWith("principle-1", {
      title: revision.title,
      principle: revision.principle,
      appliesWhen: revision.appliesWhen,
      caution: revision.caution,
      evidenceSummary: revision.evidenceSummary,
    });
    await expect(
      ipcMain.invoke(IPC_CHANNELS.reviseMethodology, {
        ...revision,
        principle: " ",
      }),
    ).rejects.toThrow();

    await ipcMain.invoke(IPC_CHANNELS.setMethodologyStatus, {
      id: "principle-1",
      status: "accepted",
    });
    expect(setMethodologyStatus).toHaveBeenCalledWith(
      "principle-1",
      "accepted",
    );
    await ipcMain.invoke(IPC_CHANNELS.setMethodologyStatus, {
      id: "principle-1",
      status: "accepted",
      acknowledgeQualityRisks: true,
    });
    expect(setMethodologyStatus).toHaveBeenLastCalledWith(
      "principle-1",
      "accepted",
      true,
    );
    await ipcMain.invoke(IPC_CHANNELS.listMethodologyVersions, "principle-1");
    expect(listMethodologyVersions).toHaveBeenCalledWith("principle-1");
    await ipcMain.invoke(IPC_CHANNELS.restoreMethodologyVersion, {
      id: "principle-1",
      version: 2,
    });
    expect(restoreMethodologyVersion).toHaveBeenCalledWith("principle-1", 2);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.restoreMethodologyVersion, {
        id: "principle-1",
        version: 0,
      }),
    ).rejects.toThrow();
    await expect(
      ipcMain.invoke(IPC_CHANNELS.setMethodologyStatus, {
        id: "principle-1",
        status: "candidate",
      }),
    ).rejects.toThrow();

    await ipcMain.invoke(IPC_CHANNELS.getMethodologySuggestions);
    expect(getMethodologySuggestions).toHaveBeenCalledOnce();
    await ipcMain.invoke(IPC_CHANNELS.getDeferredMethodologySuggestions);
    expect(getDeferredMethodologySuggestions).toHaveBeenCalledOnce();
    await ipcMain.invoke(
      IPC_CHANNELS.deferMethodologySuggestion,
      " suggestion:decision-1 ",
    );
    expect(deferMethodologySuggestion).toHaveBeenCalledWith(
      "suggestion:decision-1",
    );
    await ipcMain.invoke(
      IPC_CHANNELS.restoreMethodologySuggestion,
      "suggestion:decision-1",
    );
    expect(restoreMethodologySuggestion).toHaveBeenCalledWith(
      "suggestion:decision-1",
    );
    await expect(
      ipcMain.invoke(IPC_CHANNELS.deferMethodologySuggestion, "decision-1"),
    ).rejects.toThrow();
    await ipcMain.invoke(
      IPC_CHANNELS.getMethodologyEvidenceMatches,
      " principle-1 ",
    );
    expect(getMethodologyEvidenceMatches).toHaveBeenCalledWith("principle-1");
    await expect(
      ipcMain.invoke(IPC_CHANNELS.getMethodologyEvidenceMatches, " "),
    ).rejects.toThrow();
    await ipcMain.invoke(IPC_CHANNELS.importMethodologyMarkdown);
    expect(importMethodologyMarkdown).toHaveBeenCalledOnce();
    await expect(
      ipcMain.invoke(IPC_CHANNELS.importMethodologyMarkdown, {
        ignored: "renderer input",
      }),
    ).rejects.toThrow();
    await ipcMain.invoke(IPC_CHANNELS.commitMethodologyMarkdownImport, {
      batchId: "methodology-import-batch-1",
      selectedCandidateIds: ["candidate-1", "candidate-2"],
    });
    expect(commitMethodologyMarkdownImport).toHaveBeenCalledWith(
      "methodology-import-batch-1",
      ["candidate-1", "candidate-2"],
    );
    await expect(
      ipcMain.invoke(IPC_CHANNELS.commitMethodologyMarkdownImport, {
        batchId: "methodology-import-batch-1",
        selectedCandidateIds: ["candidate-1", "candidate-1"],
      }),
    ).rejects.toThrow();
    await ipcMain.invoke(IPC_CHANNELS.setMethodologyEvidence, {
      id: "principle-1",
      sourceDecisionIds: ["decision-1", "decision-2"],
    });
    expect(setMethodologyEvidence).toHaveBeenCalledWith("principle-1", [
      "decision-1",
      "decision-2",
    ]);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.setMethodologyEvidence, {
        id: "principle-1",
        sourceDecisionIds: [],
      }),
    ).rejects.toThrow();

    await ipcMain.invoke(IPC_CHANNELS.setMethodologyRelation, {
      id: "principle-1",
      relatedId: "principle-2",
      disposition: "unrelated",
      note: "适用边界不同。",
    });
    expect(setMethodologyRelation).toHaveBeenCalledWith(
      "principle-1",
      "principle-2",
      "unrelated",
      "适用边界不同。",
    );
    await expect(
      ipcMain.invoke(IPC_CHANNELS.setMethodologyRelation, {
        id: "principle-1",
        relatedId: "principle-2",
        disposition: "merged",
        note: null,
      }),
    ).rejects.toThrow();
    await ipcMain.invoke(IPC_CHANNELS.clearMethodologyRelation, {
      id: "principle-1",
      relatedId: "principle-2",
    });
    expect(clearMethodologyRelation).toHaveBeenCalledWith(
      "principle-1",
      "principle-2",
    );
    await ipcMain.invoke(IPC_CHANNELS.getMethodologyUsage, " principle-1 ");
    expect(getMethodologyUsage).toHaveBeenCalledWith("principle-1");
    await expect(
      ipcMain.invoke(IPC_CHANNELS.getMethodologyUsage, " "),
    ).rejects.toThrow();
    await expect(
      ipcMain.invoke(IPC_CHANNELS.getMethodologyValidationInbox),
    ).resolves.toEqual([]);
    expect(getMethodologyValidationInbox).toHaveBeenCalledOnce();
    await expect(
      ipcMain.invoke(IPC_CHANNELS.getMethodologyValidationInbox, {}),
    ).rejects.toThrow();
    await ipcMain.invoke(
      IPC_CHANNELS.acknowledgeMethodologyValidation,
      { id: " principle-1 ", reviewedAt: "2026-08-08T08:00:00.000Z", decisionId: "decision-1" },
    );
    expect(acknowledgeMethodologyValidation).toHaveBeenCalledWith(
      "principle-1",
      { reviewedAt: "2026-08-08T08:00:00.000Z", decisionId: "decision-1" },
    );
    await expect(
      ipcMain.invoke(IPC_CHANNELS.acknowledgeMethodologyValidation, { id: " ", reviewedAt: "2026-08-08T08:00:00.000Z", decisionId: "decision-1" }),
    ).rejects.toThrow();
    // A review time as the note holds it, offset and all, is taken as written: refused, 仍适用 could never be said.
    await ipcMain.invoke(IPC_CHANNELS.acknowledgeMethodologyValidation, { id: "principle-1", reviewedAt: "2026-08-08 16:00:00+08:00", decisionId: "decision-1" });
    expect(acknowledgeMethodologyValidation).toHaveBeenLastCalledWith("principle-1", { reviewedAt: "2026-08-08 16:00:00+08:00", decisionId: "decision-1" });
    // What the reader was shown is what is acknowledged: without it, nothing is.
    await expect(
      ipcMain.invoke(IPC_CHANNELS.acknowledgeMethodologyValidation, "principle-1"),
    ).rejects.toThrow();

    await ipcMain.invoke(IPC_CHANNELS.getMethodologyMergePlan, {
      mergeId: "principle-merge",
    });
    expect(getMethodologyMergePlan).toHaveBeenCalledWith("principle-merge");
    await ipcMain.invoke(IPC_CHANNELS.prepareMethodologyMergeAsset, {
      mergeId: "principle-merge",
      assetId: "workflow-1",
    });
    expect(prepareMethodologyMergeAsset).toHaveBeenCalledWith(
      "principle-merge",
      "workflow-1",
    );
    await ipcMain.invoke(IPC_CHANNELS.retireMethodologyMergeSources, {
      mergeId: "principle-merge",
    });
    expect(retireMethodologyMergeSources).toHaveBeenCalledWith(
      "principle-merge",
    );
    await ipcMain.invoke(IPC_CHANNELS.restoreMethodologyMergeSources, {
      mergeId: "principle-merge",
    });
    expect(restoreMethodologyMergeSources).toHaveBeenCalledWith(
      "principle-merge",
    );
    await expect(
      ipcMain.invoke(IPC_CHANNELS.prepareMethodologyMergeAsset, {
        mergeId: "principle-merge",
        assetId: " ",
      }),
    ).rejects.toThrow();

    await ipcMain.invoke(IPC_CHANNELS.getKnowledgeGraph, {
      ignored: "renderer input",
    });
    expect(getKnowledgeGraph).toHaveBeenCalledOnce();
  });

  it("forwards the read-only local analytics request without renderer input", async () => {
    const ipcMain = new FakeIpcMain();
    const getDecisionAnalytics = vi.fn(async () => ({
      generatedAt: "2026-08-02T10:00:00.000Z",
      engine: {
        name: "Local aggregation" as const,
        version: "1" as const,
        source: "SQLite snapshot" as const,
      },
      totals: {
        decisions: 12,
        projects: 2,
        rationaleCaptured: 10,
        outcomesRecorded: 8,
        outcomesReviewed: 6,
      },
      rates: {
        rationaleCaptured: 83.3,
        outcomesRecorded: 66.7,
        outcomesReviewed: 75,
      },
      verdicts: [],
      projects: [],
      sources: [],
      trend: [],
      retrospective: { reviewAttention: 0, periods: [] },
    }));
    registerDecisionIpc({
      ipcMain,
      queue: new RationaleQueue(),
      operations: operations({ getDecisionAnalytics }),
    });

    await expect(
      ipcMain.invoke(IPC_CHANNELS.getDecisionAnalytics, { ignored: true }),
    ).resolves.toMatchObject({ totals: { decisions: 12 } });
    expect(getDecisionAnalytics).toHaveBeenCalledOnce();
  });

  it("validates consultation metrics, preview, and anonymous feedback requests", async () => {
    const ipcMain = new FakeIpcMain();
    const getDecisionConsultationMetrics = vi.fn(async () => ({
      metricsVersion: 1 as const,
      requests: 1,
      matched: 0,
      noMatch: 1,
      matches: 0,
      strongMatches: 0,
      possibleMatches: 0,
      durationMs: 4,
      byClient: { claudeCode: 0, codex: 1 },
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
      lastConsultedAt: "2026-08-08T10:00:00.000Z",
      privacy: {
        storesQuestionText: false as const,
        storesOptionText: false as const,
        storesPrincipleIds: false as const,
        storesFeedbackTokens: false as const,
        storesIndividualEvents: false as const,
      },
    }));
    const previewDecisionConsultation = vi.fn(async () => ({
      consultationVersion: 1 as const,
      requestId: "preview-1",
      status: "no_match" as const,
      generatedBy: "deterministic_local_match" as const,
      matches: [],
      feedback: {
        token: "opaque-feedback-token",
        expiresAt: "2026-08-08T10:30:00.000Z",
      },
      boundary: {
        advisoryOnly: true as const,
        noDecisionWritten: true as const,
        noPrincipleApplied: true as const,
      },
    }));
    const submitDecisionConsultationFeedback = vi.fn(async () => ({
      feedbackVersion: 1 as const,
      status: "accepted" as const,
    }));
    registerDecisionIpc({
      ipcMain,
      queue: new RationaleQueue(),
      operations: operations({
        getDecisionConsultationMetrics,
        previewDecisionConsultation,
        submitDecisionConsultationFeedback,
      }),
    });

    await expect(
      ipcMain.invoke(IPC_CHANNELS.getDecisionConsultationMetrics),
    ).resolves.toMatchObject({ requests: 1, noMatch: 1 });
    await expect(
      ipcMain.invoke(IPC_CHANNELS.getDecisionConsultationMetrics, {}),
    ).rejects.toThrow();
    await expect(
      ipcMain.invoke(IPC_CHANNELS.previewDecisionConsultation, {
        question: "上线前是否先验证边界？",
        options: ["先验证", "直接上线"],
        context: null,
        ignored: "renderer input",
      }),
    ).rejects.toThrow();
    expect(previewDecisionConsultation).not.toHaveBeenCalled();
    await expect(
      ipcMain.invoke(IPC_CHANNELS.previewDecisionConsultation, {
        question: "上线前是否先验证边界？",
        options: ["先验证", "直接上线"],
        context: null,
      }),
    ).resolves.toMatchObject({ status: "no_match" });
    expect(previewDecisionConsultation).toHaveBeenCalledWith({
      question: "上线前是否先验证边界？",
      options: ["先验证", "直接上线"],
      context: null,
    });
    await expect(
      ipcMain.invoke(IPC_CHANNELS.submitDecisionConsultationFeedback, {
        token: "opaque-feedback-token",
        rating: "helpful",
        comment: "must not be accepted",
      }),
    ).rejects.toThrow();
    expect(submitDecisionConsultationFeedback).not.toHaveBeenCalled();
    await expect(
      ipcMain.invoke(IPC_CHANNELS.submitDecisionConsultationFeedback, {
        token: "opaque-feedback-token",
        rating: "misleading",
      }),
    ).resolves.toEqual({ feedbackVersion: 1, status: "accepted" });
    expect(submitDecisionConsultationFeedback).toHaveBeenCalledWith({
      token: "opaque-feedback-token",
      rating: "misleading",
    });
  });

  it("validates skill and workflow draft operations", async () => {
    const ipcMain = new FakeIpcMain();
    const listPracticeAssets = vi.fn(async () => []);
    const createManualPracticeAsset = vi.fn(async () => ({
      id: "skill-manual",
    }));
    const generatePracticeAsset = vi.fn(async () => ({ id: "skill-1" }));
    const revisePracticeAsset = vi.fn(async () => ({ id: "skill-1" }));
    const setPracticeAssetStatus = vi.fn(async () => ({ id: "skill-1" }));
    const regeneratePracticeAsset = vi.fn(async () => ({
      id: "skill-replacement",
    }));
    const listPracticeAssetVersions = vi.fn(async () => []);
    const restorePracticeAssetVersion = vi.fn(async () => ({ id: "skill-1" }));
    const listPracticePublicationStatuses = vi.fn(async () => []);
    const publishPracticeAsset = vi.fn(async () => ({ action: "published" }));
    const rollbackPracticeAssetPublication = vi.fn(async () => ({
      action: "rolled_back",
    }));
    registerDecisionIpc({
      ipcMain,
      queue: new RationaleQueue(),
      operations: operations({
        listPracticeAssets,
        createManualPracticeAsset,
        generatePracticeAsset,
        revisePracticeAsset,
        setPracticeAssetStatus,
        regeneratePracticeAsset,
        listPracticeAssetVersions,
        restorePracticeAssetVersion,
        listPracticePublicationStatuses,
        publishPracticeAsset,
        rollbackPracticeAssetPublication,
      }),
    });

    await ipcMain.invoke(IPC_CHANNELS.listPracticeAssets, "candidate");
    expect(listPracticeAssets).toHaveBeenCalledWith("candidate");
    await expect(
      ipcMain.invoke(IPC_CHANNELS.listPracticeAssets, "published"),
    ).rejects.toThrow();

    const manualDraft = {
      title: "人工复盘技能",
      summary: "不调用模型也能创建可审核的实践草案。",
      trigger: "没有可用模型或希望完全人工编写时。",
      steps: ["核对来源原则。", "编写并检查执行步骤。"],
      checks: ["草案具备可观察的验收标准。"],
      fallback: "边界不清楚时返回原则审核。",
    };
    await ipcMain.invoke(IPC_CHANNELS.createManualPracticeAsset, {
      kind: "skill",
      sourcePrincipleIds: ["principle-1"],
      ...manualDraft,
    });
    expect(createManualPracticeAsset).toHaveBeenCalledWith(
      "skill",
      ["principle-1"],
      manualDraft,
    );
    await expect(
      ipcMain.invoke(IPC_CHANNELS.createManualPracticeAsset, {
        kind: "skill",
        sourcePrincipleIds: ["principle-1"],
        ...manualDraft,
        steps: ["只有一步"],
      }),
    ).rejects.toThrow();

    await ipcMain.invoke(IPC_CHANNELS.generatePracticeAsset, {
      kind: "skill",
      sourcePrincipleIds: ["principle-1"],
    });
    expect(generatePracticeAsset).toHaveBeenCalledWith("skill", [
      "principle-1",
    ]);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.generatePracticeAsset, {
        kind: "prompt",
        sourcePrincipleIds: ["principle-1"],
      }),
    ).rejects.toThrow();
    await expect(
      ipcMain.invoke(IPC_CHANNELS.generatePracticeAsset, {
        kind: "workflow",
        sourcePrincipleIds: ["principle-1", "principle-1"],
      }),
    ).rejects.toThrow();

    const revision = {
      id: "skill-1",
      title: "可逆改动验证",
      summary: "用可回退的改动验证实现方向。",
      trigger: "仍有关键未知项时。",
      steps: ["明确假设。", "实施最小改动。"],
      checks: ["改动能够回退。"],
      fallback: "失败时回退并重新评估。",
    };
    // With what the edit began from, carried to the service that compares it with the note as it now stands.
    await ipcMain.invoke(IPC_CHANNELS.revisePracticeAsset, { ...revision, basis: "[\"打开时的标题\"]" });
    expect(revisePracticeAsset).toHaveBeenCalledWith("skill-1", {
      title: revision.title,
      summary: revision.summary,
      trigger: revision.trigger,
      steps: revision.steps,
      checks: revision.checks,
      fallback: revision.fallback,
    }, "[\"打开时的标题\"]");
    await expect(
      ipcMain.invoke(IPC_CHANNELS.revisePracticeAsset, {
        ...revision,
        steps: ["只有一步"],
      }),
    ).rejects.toThrow();

    await ipcMain.invoke(IPC_CHANNELS.setPracticeAssetStatus, {
      id: "skill-1",
      status: "accepted",
    });
    expect(setPracticeAssetStatus).toHaveBeenCalledWith("skill-1", "accepted");
    await expect(
      ipcMain.invoke(IPC_CHANNELS.setPracticeAssetStatus, {
        id: "skill-1",
        status: "candidate",
      }),
    ).rejects.toThrow();

    await ipcMain.invoke(IPC_CHANNELS.regeneratePracticeAsset, "skill-1");
    expect(regeneratePracticeAsset).toHaveBeenCalledWith("skill-1");
    await expect(
      ipcMain.invoke(IPC_CHANNELS.regeneratePracticeAsset, " "),
    ).rejects.toThrow();

    await ipcMain.invoke(IPC_CHANNELS.listPracticeAssetVersions, "skill-1");
    expect(listPracticeAssetVersions).toHaveBeenCalledWith("skill-1");
    await ipcMain.invoke(IPC_CHANNELS.restorePracticeAssetVersion, {
      id: "skill-1",
      version: 2,
    });
    expect(restorePracticeAssetVersion).toHaveBeenCalledWith("skill-1", 2);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.restorePracticeAssetVersion, {
        id: "skill-1",
        version: 0,
      }),
    ).rejects.toThrow();

    await ipcMain.invoke(
      IPC_CHANNELS.listPracticePublicationStatuses,
      "skill-1",
    );
    expect(listPracticePublicationStatuses).toHaveBeenCalledWith("skill-1");
    await ipcMain.invoke(IPC_CHANNELS.publishPracticeAsset, {
      id: "skill-1",
      target: "codex",
      confirmOverwrite: true,
    });
    expect(publishPracticeAsset).toHaveBeenCalledWith("skill-1", "codex", true);
    await ipcMain.invoke(IPC_CHANNELS.rollbackPracticeAssetPublication, {
      id: "skill-1",
      target: "claude-code",
    });
    expect(rollbackPracticeAssetPublication).toHaveBeenCalledWith(
      "skill-1",
      "claude-code",
    );
    await expect(
      ipcMain.invoke(IPC_CHANNELS.publishPracticeAsset, {
        id: "skill-1",
        target: "cursor",
      }),
    ).rejects.toThrow();
    await expect(
      ipcMain.invoke(IPC_CHANNELS.rollbackPracticeAssetPublication, {
        id: "skill-1",
        target: "codex",
        force: true,
      }),
    ).rejects.toThrow();
  });

  it("restricts model installation to the pinned 2B and 4B choices", async () => {
    const ipcMain = new FakeIpcMain();
    const installManagedQwenModel = vi.fn(async () => undefined);
    registerDecisionIpc({ ipcMain, queue: new RationaleQueue(), operations: operations({ installManagedQwenModel }) });
    await expect(ipcMain.invoke(IPC_CHANNELS.installManagedQwenModel, "../../foreign.gguf")).rejects.toThrow();
    await expect(ipcMain.invoke(IPC_CHANNELS.installManagedQwenModel, "qwen3.5-9b-q4-k-m")).rejects.toThrow();
    expect(installManagedQwenModel).not.toHaveBeenCalled();
    await ipcMain.invoke(IPC_CHANNELS.installManagedQwenModel, "qwen3.5-4b-q4-k-m");
    expect(installManagedQwenModel).toHaveBeenCalledWith("qwen3.5-4b-q4-k-m");
  });

  it("validates provider controls and never returns credential material", async () => {
    const ipcMain = new FakeIpcMain();
    const redacted = {
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
    const listModelProviderProfiles = vi.fn(async () => [redacted]);
    const saveModelProviderProfile = vi.fn(async () => redacted);
    const deleteModelProviderProfile = vi.fn(async () => true);
    const reorderModelProviderProfiles = vi.fn(async () => undefined);
    const testModelProviderProfile = vi.fn(async () => ({
      ok: false,
      profileId: "remote-openai",
      latencyMs: 42,
      requestId: "health-request",
      errorCode: "authentication_failed" as const,
      diagnosticExcerpt: "HTTP 401：API 密钥无效",
      providerRequestId: "provider-request-401",
    }));
    const listLocalModelClientStatuses = vi.fn(async () => [
      {
        kind: "codex-cli" as const,
        executablePath: "/opt/homebrew/bin/codex",
        version: "0.146.0",
        authenticated: true,
        supported: true,
        availability: "available" as const,
        checkedAt: "2026-07-30T00:00:00.000Z",
      },
    ]);
    registerDecisionIpc({
      ipcMain,
      queue: new RationaleQueue(),
      operations: operations({
        listModelProviderProfiles,
        saveModelProviderProfile,
        deleteModelProviderProfile,
        reorderModelProviderProfiles,
        testModelProviderProfile,
        listLocalModelClientStatuses,
      }),
    });

    const listed = await ipcMain.invoke(IPC_CHANNELS.listModelProviderProfiles);
    expect(listed).toEqual([redacted]);
    expect(JSON.stringify(listed)).not.toContain("credentialRef");

    const saved = await ipcMain.invoke(IPC_CHANNELS.saveModelProviderProfile, {
      profile: {
        ...redacted,
        credentialConfigured: false,
      },
      secret: "sk-one-time",
    });
    expect(saved).toEqual(redacted);
    expect(JSON.stringify(saved)).not.toContain("sk-one-time");
    expect(saveModelProviderProfile).toHaveBeenCalledWith({
      profile: {
        ...redacted,
        credentialConfigured: false,
      },
      secret: "sk-one-time",
    });

    await expect(
      ipcMain.invoke(IPC_CHANNELS.saveModelProviderProfile, {
        profile: {
          ...redacted,
          credentialRef: "must-not-cross-ipc",
        },
      }),
    ).rejects.toThrow();
    await ipcMain.invoke(IPC_CHANNELS.reorderModelProviderProfiles, [
      "remote-openai",
      "builtin-apple",
    ]);
    expect(reorderModelProviderProfiles).toHaveBeenCalledWith([
      "remote-openai",
      "builtin-apple",
    ]);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.reorderModelProviderProfiles, [
        "remote-openai",
        "remote-openai",
      ]),
    ).rejects.toThrow();

    await ipcMain.invoke(
      IPC_CHANNELS.deleteModelProviderProfile,
      "remote-openai",
    );
    expect(deleteModelProviderProfile).toHaveBeenCalledWith("remote-openai");

    await expect(
      ipcMain.invoke(IPC_CHANNELS.testModelProviderProfile, "remote-openai"),
    ).resolves.toMatchObject({
      ok: false,
      requestId: "health-request",
      errorCode: "authentication_failed",
      diagnosticExcerpt: "HTTP 401：API 密钥无效",
      providerRequestId: "provider-request-401",
    });
    expect(testModelProviderProfile).toHaveBeenCalledWith("remote-openai");
    await expect(
      ipcMain.invoke(IPC_CHANNELS.listLocalModelClientStatuses),
    ).resolves.toEqual([
      expect.objectContaining({
        kind: "codex-cli",
        authenticated: true,
      }),
    ]);
  });

  it("forwards output-limit provider diagnostics", async () => {
    const ipcMain = new FakeIpcMain();
    registerDecisionIpc({
      ipcMain,
      queue: new RationaleQueue(),
      operations: operations({
        testModelProviderProfile: vi.fn(async () => ({
          ok: false,
          profileId: "builtin-qwen",
          latencyMs: 1_700,
          requestId: "health-output-limit",
          errorCode: "output_limit" as const,
          diagnosticExcerpt:
            "Qwen output reached the 512-token limit before completing valid JSON",
        })),
      }),
    });

    await expect(
      ipcMain.invoke(IPC_CHANNELS.testModelProviderProfile, "builtin-qwen"),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: "output_limit",
    });
  });

  it("forwards the turns of a deleted conversation, and refuses anything but a list of ids", async () => {
    const ipcMain = new FakeIpcMain();
    const forgetAssistantTurns = vi.fn(async () => undefined);
    registerDecisionIpc({ ipcMain, queue: new RationaleQueue(), operations: operations({ forgetAssistantTurns }) });

    await ipcMain.invoke(IPC_CHANNELS.forgetAssistantTurns, ["turn-1", "turn-2"]);
    expect(forgetAssistantTurns).toHaveBeenCalledWith(["turn-1", "turn-2"]);
    await expect(ipcMain.invoke(IPC_CHANNELS.forgetAssistantTurns, "turn-1")).rejects.toThrow();
    expect(forgetAssistantTurns).toHaveBeenCalledTimes(1);
  });

  it("validates and forwards model trace controls", async () => {
    const ipcMain = new FakeIpcMain();
    const listModelTraces = vi.fn(async () => [{ traceId: "trace-1" }]);
    const deleteModelTrace = vi.fn(async () => true);
    const deleteModelTraceRequest = vi.fn(async () => 2);
    const clearModelTraces = vi.fn(async () => 3);
    const setModelTraceContentEnabled = vi.fn(async () => undefined);
    registerDecisionIpc({
      ipcMain,
      queue: new RationaleQueue(),
      operations: operations({
        listModelTraces,
        deleteModelTrace,
        deleteModelTraceRequest,
        clearModelTraces,
        setModelTraceContentEnabled,
      }),
    });

    await expect(ipcMain.invoke(IPC_CHANNELS.listModelTraces)).resolves.toEqual(
      [{ traceId: "trace-1" }],
    );
    await expect(
      ipcMain.invoke(IPC_CHANNELS.deleteModelTrace, "trace-1"),
    ).resolves.toBe(true);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.deleteModelTraceRequest, "request-1"),
    ).resolves.toBe(2);
    await expect(ipcMain.invoke(IPC_CHANNELS.clearModelTraces)).resolves.toBe(
      3,
    );
    await ipcMain.invoke(IPC_CHANNELS.setModelTraceContentEnabled, false);

    expect(deleteModelTrace).toHaveBeenCalledWith("trace-1");
    expect(deleteModelTraceRequest).toHaveBeenCalledWith("request-1");
    expect(setModelTraceContentEnabled).toHaveBeenCalledWith(false);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.deleteModelTrace, "x".repeat(201)),
    ).rejects.toThrow();
    await expect(
      ipcMain.invoke(IPC_CHANNELS.setModelTraceContentEnabled, "false"),
    ).rejects.toThrow();
  });

  it("validates and forwards commands for the current review candidate", async () => {
    const ipcMain = new FakeIpcMain();
    const candidate = serverCandidateFixture();
    const candidates = new DecisionCandidateQueue({
      onPromote: vi.fn(async () => undefined),
      onIgnore: vi.fn(async () => undefined),
    });
    candidates.ingest(candidate);
    const confirmCandidate = vi.fn(async () => undefined);
    const ignoreCandidate = vi.fn(async () => undefined);
    const retryCandidate = vi.fn(async () => undefined);
    registerDecisionIpc({
      ipcMain,
      queue: new RationaleQueue(),
      candidates,
      operations: operations({
        confirmCandidate,
        ignoreCandidate,
        retryCandidate,
      }),
    });

    await ipcMain.invoke(IPC_CHANNELS.confirmCandidate, candidate.candidateId);
    await ipcMain.invoke(IPC_CHANNELS.ignoreCandidate, candidate.candidateId);
    await ipcMain.invoke(IPC_CHANNELS.retryCandidate, candidate.candidateId);

    expect(confirmCandidate).toHaveBeenCalledWith(candidate.candidateId);
    expect(ignoreCandidate).toHaveBeenCalledWith(candidate.candidateId);
    expect(retryCandidate).toHaveBeenCalledWith(candidate.candidateId);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.confirmCandidate, "candidate-other"),
    ).rejects.toThrow(/current decision candidate/u);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.ignoreCandidate, "x".repeat(201)),
    ).rejects.toThrow();
  });

  it("validates local storage requests and forwards deferred local retention", async () => {
    const ipcMain = new FakeIpcMain();
    const keepLocalRationale = vi.fn(async () => undefined);
    const listLocalDecisions = vi.fn(async () => ({ records: [], total: 0 }));
    const resolveLocalDecision = vi.fn(async () => undefined);
    registerDecisionIpc({ ipcMain, queue: new RationaleQueue(() => "candidate-current"), operations: operations({ keepLocalRationale, listLocalDecisions, resolveLocalDecision }) });
    await ipcMain.invoke(IPC_CHANNELS.rationale, { candidateId: "deferred-local", status: "local_only", rationale: "  原文  " });
    expect(keepLocalRationale).toHaveBeenCalledWith("deferred-local", { rationale: "  原文  " });
    await ipcMain.invoke(IPC_CHANNELS.listLocalDecisions, { query: "业务", offset: 100 });
    expect(listLocalDecisions).toHaveBeenCalledWith("业务", 100);
    await ipcMain.invoke(IPC_CHANNELS.resolveLocalDecision, { id: "local-id", action: "publish" });
    expect(resolveLocalDecision).toHaveBeenCalledWith("local-id", "publish");
    await expect(ipcMain.invoke(IPC_CHANNELS.listLocalDecisions, { query: "", offset: -1 })).rejects.toThrow();
    await expect(ipcMain.invoke(IPC_CHANNELS.resolveLocalDecision, { id: "local-id", action: "remove-all" })).rejects.toThrow();
    expect(resolveLocalDecision).toHaveBeenCalledTimes(1);
  });

  it("accepts a local-only capture with no invented rationale", async () => {
    const ipcMain = new FakeIpcMain();
    const onDisposition = vi.fn(async () => undefined);
    const queue = new RationaleQueue(() => "candidate-current", { onDisposition });
    queue.ingest(serverCaptureFixture());
    registerDecisionIpc({ ipcMain, queue, operations: operations() });
    await ipcMain.invoke(IPC_CHANNELS.rationale, { candidateId: "candidate-current", status: "local_only" });
    expect(onDisposition).toHaveBeenCalledWith(expect.anything(), { status: "local_only" });
  });

  it("validates and forwards active rationale dispositions", async () => {
    const ipcMain = new FakeIpcMain();
    const onDisposition = vi.fn(async () => undefined);
    const queue = new RationaleQueue(() => "candidate-current", {
      onDisposition,
    });
    queue.ingest(serverCaptureFixture());
    registerDecisionIpc({
      ipcMain,
      queue,
      operations: operations(),
    });

    await ipcMain.invoke(IPC_CHANNELS.rationale, {
      candidateId: "candidate-current",
      status: "captured",
      rationale: "  因为原文空格有意义。  ",
      reasonFactors: ["maintainability"],
    });

    expect(onDisposition).toHaveBeenCalledWith(expect.anything(), {
      status: "captured",
      rationale: "  因为原文空格有意义。  ",
      reasonFactors: ["maintainability"],
    });
  });

  it("validates an expected outcome written later, before the outcome", async () => {
    const ipcMain = new FakeIpcMain();
    const updateDecisionExpectedOutcome = vi.fn(async () => undefined);
    registerDecisionIpc({
      ipcMain,
      queue: new RationaleQueue(() => "candidate-current"),
      operations: operations({ updateDecisionExpectedOutcome }),
    });

    await ipcMain.invoke(IPC_CHANNELS.updateDecisionExpectedOutcome, {
      decisionId: "decision-1",
      expectedOutcome: "  一周内不再回滚。 ",
    });
    // The version the editor opened at goes with it, when there is one.
    await ipcMain.invoke(IPC_CHANNELS.updateDecisionExpectedOutcome, { decisionId: "decision-1", expectedOutcome: "一周内不再回滚。", basis: "hash-1" });
    expect(updateDecisionExpectedOutcome).toHaveBeenLastCalledWith("decision-1", "一周内不再回滚。", "hash-1");
    expect(updateDecisionExpectedOutcome).toHaveBeenCalledWith(
      "decision-1",
      "一周内不再回滚。",
    );
    for (const expectedOutcome of ["   ", "x".repeat(4_001), "<!-- decision:outcome-end -->"]) {
      await expect(
        ipcMain.invoke(IPC_CHANNELS.updateDecisionExpectedOutcome, {
          decisionId: "decision-1",
          expectedOutcome,
        }),
      ).rejects.toThrow();
    }
    expect(updateDecisionExpectedOutcome).toHaveBeenCalledTimes(2);
  });

  it("keeps an expected outcome written before the rationale was put off, still not as a reason", async () => {
    const ipcMain = new FakeIpcMain();
    const onDisposition = vi.fn(async () => undefined);
    const queue = new RationaleQueue(() => "candidate-current", {
      onDisposition,
    });
    queue.ingest(serverCaptureFixture());
    registerDecisionIpc({ ipcMain, queue, operations: operations() });

    for (const expectedOutcome of ["   ", "见下\n\n## 后续结果\n\n伪造"]) {
      await expect(
        ipcMain.invoke(IPC_CHANNELS.rationale, {
          candidateId: "candidate-current",
          status: "deferred",
          expectedOutcome,
        }),
      ).rejects.toThrow();
    }
    // Said as the knowledge page says it: refused with no reason, the rationale step could not be fixed.
    await expect(
      ipcMain.invoke(IPC_CHANNELS.rationale, {
        candidateId: "candidate-current",
        status: "deferred",
        expectedOutcome: "## 预期结果\n接口延迟降到 50ms 以内",
      }),
    ).rejects.toThrow(/预期结果里不能有/u);
    await ipcMain.invoke(IPC_CHANNELS.rationale, {
      candidateId: "candidate-current",
      status: "deferred",
      expectedOutcome: "发布后错误率不升。",
    });
    expect(onDisposition).toHaveBeenCalledWith(expect.anything(), {
      status: "deferred",
      expectedOutcome: "发布后错误率不升。",
    });
  });

  it("accepts an expected outcome only alongside a completed rationale", async () => {
    const ipcMain = new FakeIpcMain();
    const onDisposition = vi.fn(async () => undefined);
    const queue = new RationaleQueue(() => "candidate-current", {
      onDisposition,
    });
    queue.ingest(serverCaptureFixture());
    registerDecisionIpc({ ipcMain, queue, operations: operations() });

    // An expectation is not a reason: on its own it completes nothing.
    await expect(
      ipcMain.invoke(IPC_CHANNELS.rationale, {
        candidateId: "candidate-current",
        status: "captured",
        expectedOutcome: "发布后错误率不升。",
      }),
    ).rejects.toThrow();
    for (const expectedOutcome of ["   ", "见下\n\n## 后续结果\n\n伪造"]) {
      await expect(
        ipcMain.invoke(IPC_CHANNELS.rationale, {
          candidateId: "candidate-current",
          status: "captured",
          rationale: "先灰度。",
          expectedOutcome,
        }),
      ).rejects.toThrow();
    }

    await ipcMain.invoke(IPC_CHANNELS.rationale, {
      candidateId: "candidate-current",
      status: "captured",
      rationale: "先灰度。",
      expectedOutcome: "发布后错误率不升。",
    });
    expect(onDisposition).toHaveBeenCalledWith(expect.anything(), {
      status: "captured",
      rationale: "先灰度。",
      expectedOutcome: "发布后错误率不升。",
    });
  });

  it("validates principle suggestions and explicit rationale links", async () => {
    const ipcMain = new FakeIpcMain();
    const onDisposition = vi.fn(async () => undefined);
    const queue = new RationaleQueue(() => "candidate-current", {
      onDisposition,
    });
    queue.ingest(serverCaptureFixture());
    const getDecisionPrincipleSuggestions = vi.fn(async () => []);
    const validateDecisionAppliedPrinciples = vi.fn(async () => undefined);
    registerDecisionIpc({
      ipcMain,
      queue,
      operations: operations({
        getDecisionPrincipleSuggestions,
        validateDecisionAppliedPrinciples,
      }),
    });

    await ipcMain.invoke(IPC_CHANNELS.getDecisionPrincipleSuggestions, {
      question: "  是否先验证边界？  ",
      selectedAnswer: "  先验证  ",
      optionLabels: ["  先验证  ", "直接上线"],
      context: "  真实运行仍不明确。  ",
    });
    expect(getDecisionPrincipleSuggestions).toHaveBeenCalledWith({
      question: "是否先验证边界？",
      selectedAnswer: "先验证",
      optionLabels: ["先验证", "直接上线"],
      context: "真实运行仍不明确。",
    });

    await ipcMain.invoke(IPC_CHANNELS.rationale, {
      candidateId: "candidate-current",
      status: "captured",
      appliedPrincipleIds: ["principle-1", "principle-2"],
    });
    expect(validateDecisionAppliedPrinciples).toHaveBeenCalledWith([
      "principle-1",
      "principle-2",
    ]);
    expect(onDisposition).toHaveBeenCalledWith(expect.anything(), {
      status: "captured",
      appliedPrincipleIds: ["principle-1", "principle-2"],
    });
    expect(
      validateDecisionAppliedPrinciples.mock.invocationCallOrder[0],
    ).toBeLessThan(onDisposition.mock.invocationCallOrder[0]!);

    await expect(
      ipcMain.invoke(IPC_CHANNELS.getDecisionPrincipleSuggestions, {
        question: "",
        selectedAnswer: "先验证",
        optionLabels: [],
        context: null,
      }),
    ).rejects.toThrow();
    await expect(
      ipcMain.invoke(IPC_CHANNELS.rationale, {
        candidateId: "candidate-current",
        status: "not_recorded",
        appliedPrincipleIds: ["principle-1"],
      }),
    ).rejects.toThrow();
  });

  it("does not submit rationale links that are no longer accepted", async () => {
    const ipcMain = new FakeIpcMain();
    const onDisposition = vi.fn(async () => undefined);
    const queue = new RationaleQueue(() => "candidate-current", {
      onDisposition,
    });
    queue.ingest(serverCaptureFixture());
    const validateDecisionAppliedPrinciples = vi.fn(async () => {
      throw new Error("Applied principles must still be accepted");
    });
    registerDecisionIpc({
      ipcMain,
      queue,
      operations: operations({ validateDecisionAppliedPrinciples }),
    });

    await expect(
      ipcMain.invoke(IPC_CHANNELS.rationale, {
        candidateId: "candidate-current",
        status: "skipped",
        appliedPrincipleIds: ["retired-principle"],
      }),
    ).rejects.toThrow(/still be accepted/i);
    expect(onDisposition).not.toHaveBeenCalled();
    expect(queue.snapshot().current?.status).toBe("awaiting_rationale");
  });

  it("accepts structured factors without inventing rationale text", async () => {
    const ipcMain = new FakeIpcMain();
    const onDisposition = vi.fn(async () => undefined);
    const queue = new RationaleQueue(() => "candidate-current", {
      onDisposition,
    });
    queue.ingest(serverCaptureFixture());
    registerDecisionIpc({
      ipcMain,
      queue,
      operations: operations(),
    });

    await ipcMain.invoke(IPC_CHANNELS.rationale, {
      candidateId: "candidate-current",
      status: "captured",
      reasonFactors: ["risk"],
    });

    expect(onDisposition).toHaveBeenCalledWith(expect.anything(), {
      status: "captured",
      reasonFactors: ["risk"],
    });
  });

  it("rejects input targeting another active candidate", async () => {
    const ipcMain = new FakeIpcMain();
    const queue = new RationaleQueue(() => "candidate-current");
    queue.ingest(serverCaptureFixture());
    registerDecisionIpc({
      ipcMain,
      queue,
      operations: operations(),
    });

    await expect(
      ipcMain.invoke(IPC_CHANNELS.rationale, {
        candidateId: "candidate-other",
        status: "skipped",
      }),
    ).rejects.toThrow(/current rationale candidate/i);
    expect(queue.snapshot().current?.status).toBe("awaiting_rationale");
  });

  it("routes a stored deferred rationale by its decision ID", async () => {
    const ipcMain = new FakeIpcMain();
    const queue = new RationaleQueue();
    const completeDeferredRationale = vi.fn(async () => undefined);
    registerDecisionIpc({
      ipcMain,
      queue,
      operations: operations({ completeDeferredRationale }),
    });

    await ipcMain.invoke(IPC_CHANNELS.rationale, {
      candidateId: "decision-pending",
      status: "captured",
      rationale: "稍后补上的理由",
    });

    expect(completeDeferredRationale).toHaveBeenCalledWith("decision-pending", {
      rationale: "稍后补上的理由",
    });
  });

  it("routes a skipped stored rationale by its decision ID", async () => {
    const ipcMain = new FakeIpcMain();
    const queue = new RationaleQueue();
    const skipDeferredRationale = vi.fn(async () => undefined);
    registerDecisionIpc({
      ipcMain,
      queue,
      operations: operations({ skipDeferredRationale }),
    });

    const outcome = await ipcMain
      .invoke(IPC_CHANNELS.rationale, {
        candidateId: "decision-pending",
        status: "skipped",
      })
      .then(
        () => "resolved",
        (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      );

    expect(outcome).toBe("resolved");
    expect(skipDeferredRationale).toHaveBeenCalledWith("decision-pending");
  });

  it("routes an unrecorded deferred rationale by its decision ID", async () => {
    const ipcMain = new FakeIpcMain();
    const queue = new RationaleQueue();
    const discardDeferredRationale = vi.fn(async () => undefined);
    registerDecisionIpc({
      ipcMain,
      queue,
      operations: operations({ discardDeferredRationale }),
    });

    await ipcMain.invoke(IPC_CHANNELS.rationale, {
      candidateId: "decision-pending",
      status: "not_recorded",
    });

    expect(discardDeferredRationale).toHaveBeenCalledWith("decision-pending");
  });

  it("validates theme changes and oversized rationale text", async () => {
    const ipcMain = new FakeIpcMain();
    const queue = new RationaleQueue(() => "candidate-current");
    queue.ingest(serverCaptureFixture());
    const setTheme = vi.fn(async () => undefined);
    registerDecisionIpc({
      ipcMain,
      queue,
      operations: operations({ setTheme }),
    });

    await ipcMain.invoke(IPC_CHANNELS.setTheme, "dark");
    await expect(
      ipcMain.invoke(IPC_CHANNELS.setTheme, "sepia"),
    ).rejects.toThrow();
    await expect(
      ipcMain.invoke(IPC_CHANNELS.rationale, {
        candidateId: "candidate-current",
        status: "captured",
        rationale: "x".repeat(8_001),
      }),
    ).rejects.toThrow();

    expect(setTheme).toHaveBeenCalledOnce();
  });

  it("says a disk full or a folder refused in words, naming the folder, never the temporary file", async () => {
    const ipcMain = new FakeIpcMain();
    const refusal = (code: string, path: string) => Object.assign(new Error(`${code}: refused, open '${path}'`), { code, path });
    const setTheme = vi.fn()
      .mockRejectedValueOnce(refusal("ENOSPC", "/vault/Decision Journal/principles/principle-1-ab12.md.4242.7f3c.tmp"))
      .mockRejectedValueOnce(refusal("EACCES", "/vault/Decision Journal/decisions/2026"))
      .mockRejectedValueOnce(new Error("other"));
    registerDecisionIpc({ ipcMain, queue: new RationaleQueue(), operations: operations({ setTheme }) });

    // Node's own line reached the page, English and with the temporary file's name in it.
    await expect(ipcMain.invoke(IPC_CHANNELS.setTheme, "dark")).rejects.toThrow(
      "磁盘空间不足，没能写入 /vault/Decision Journal/principles，请清理出空间后再试",
    );
    await expect(ipcMain.invoke(IPC_CHANNELS.setTheme, "dark")).rejects.toThrow(
      "没有访问 /vault/Decision Journal/decisions/2026 的权限，请检查它的权限设置",
    );
    await expect(ipcMain.invoke(IPC_CHANNELS.setTheme, "dark")).rejects.toThrow("other");
  });
});
