import "./script-run-dock.js";
import { DecisionDeletionService } from "./decision-deletion-service.js";
import { MisrecognitionReceiptStore } from "./misrecognition-receipts.js";
import { LocalModelInstaller } from "./semantic/local-model-installer.js";
import { PrConnections } from "./pr-connections.js";
import { PrCommentCandidates, PrCommentVerdicts } from "./pr-comment-candidates.js";
import { PrReviewService } from "./pr-review-service.js";
import { combineReviewRules, createDecisionFeedbackStore, loadReviewRules, matchReviewRules, MAX_MATCHED_REVIEW_RULES } from "@cognelis/decision-storage";
import { DecisionFeedbackService } from "./decision-feedback-service.js";
import {
  BUILT_IN_CLIENTS,
  catalogSummaries,
  KNOWN_CLIENTS,
  clientHookPaths,
  clientSummary,
  hookBridgeReference,
  inIntegrationsTurn,
  installIntegrationsWithinTurn,
  removeIntegrationsWithinTurn,
  SKILL_CLIENTS,
  clientsBehindOnSkills,
  syncBundledSkills,
  type ClientDescriptor,
  type SkillInstallReport,
} from "@cognelis/decision-integrations";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import squirrelStartup from "electron-squirrel-startup";
import {
  assessMethodologyQuality,
  assessPracticeAssetFreshness,
  buildMethodologyBuildProgress,
  buildMethodologyRecall,
  buildMethodologyEvidenceMatches,
  withSemanticEvidenceMatches,
  buildMethodologySuggestions,
  comparePracticeAssetSources,
  prCommentSemanticKey,
  REVIEW_SCHEDULE_REASON_LABELS,
  type MethodologyQualityAssessment,
  type ReviewScheduleReason,
  type MethodologyHistoryEntry,
  type MethodologyRelationRecord,
  type MethodologyRecord,
  type PracticeAssetRecord,
  type PracticeAssetHistoryEntry,
  type SelectedAnswer,
  recommendationFollow,
  relatedNoteLink,
} from "@cognelis/decision-core";
import type {
  LocalModelClientStatus,
  ModelProviderProfile,
  SemanticRecognitionStatus,
} from "@cognelis/decision-protocol";
import {
  DECISION_CONSULTATION_FEEDBACK_VERSION,
  DECISION_CONSULTATION_VERSION,
  LOCAL_REVIEW_TOOLS_VERSION,
  PROACTIVE_RECORD_VERSION,
  HISTORICAL_DECISION_VERSION,
  decisionContextQuerySchema,
  proactiveRecordRequestSchema,
  type OpenHistoricalDecisionRequest,
  type OpenHistoricalDecisionResult,
} from "@cognelis/decision-protocol";
import {
  CandidateSpool,
  CaptureAuditStore,
  CaptureSpool,
  DecisionStore,
  LocalDecisionStore,
  DecisionWatcher,
  ExperienceRepository,
  JournalEntryRepository,
  TodoHistoryStore,
  TODO_FOLDER,
  HISTORICAL_DECISION_FOLDER,
  HistoricalDecisionRepository,
  TodoListRepository,
  MarkdownRepository,
  MethodologyRelationRepository,
  MethodologyRepository,
  ModelTraceStore,
  PracticeAssetRepository,
  SemanticPairSpool,
  SemanticVectorIndex,
  SqliteIndex,
  noteProblem,
  type IndexedDecision,
} from "@cognelis/decision-storage";
import {
  app,
  BrowserWindow,
  dialog,
  Notification,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  powerMonitor,
  safeStorage,
  screen,
  shell,
  Tray,
  utilityProcess,
  type BrowserWindowConstructorOptions,
} from "electron";
import { randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";

import { readParaselfEnvironment } from "../../../../config/paraself-environment.mjs";

import { AppController } from "./app-controller.js";
import { atomicWrite } from "./atomic-write.js";
import { ActiveRecordService, journalNotice, userWrote } from "./active-record-service.js";
import { TodoService } from "./todo-service.js";
import { TodoNoteWatcher } from "./todo-watch.js";
import { HistoricalDecisionService } from "./historical-decision-service.js";
import { summarizeRecordContext } from "./record-context-summary.js";
import { shutdownApplication } from "./application-shutdown.js";
import {
  applicationSupportPaths,
  configureElectronUserDataPath,
  resolveDefaultVaultPath,
  resolveObsidianConfigurationPath,
  type UserDataResolution,
} from "./application-paths.js";
import { CaptureRuntime } from "./capture-runtime.js";
import { isTranslocated, prepareBridgeLauncher, resolveBridgeExecutablePath, squirrelBridgeLauncher } from "./bridge-path.js";
import { readDashboardSnapshot } from "./dashboard-snapshot.js";
import { DecisionAnswerCache, queryDecisionsWithReplies } from "./decision-library-query.js";
import { createNoteFollow } from "./note-follow.js";
import { DecisionAnalyticsService, RETROSPECTIVE_WINDOWS } from "./decision-analytics-service.js";
import { DecisionConsultationFeedbackService } from "./decision-consultation-feedback-service.js";
import { DecisionConsultationMetricsStore } from "./decision-consultation-metrics-store.js";
import { buildDecisionConsultation } from "./decision-consultation-service.js";
import { DecisionHandoffService } from "./decision-handoff-service.js";
import { DecisionOutcomeService } from "./decision-outcome-service.js";
import { DecisionContextService } from "./decision-context-service.js";
import { ContextSearch } from "./decision-context-signals.js";
import { pendingConfirmationMaterial } from "./organization-sources.js";
import { OrganizationService } from "./organization-service.js";
import { OrganizationStore } from "./organization-store.js";
import { CurrentJournal } from "./current-journal.js";
import { amendedRepository, annotateResults, amendedText, amendmentOverview, DecisionAmendmentService, journalContentHash } from "./decision-context-amendments.js";
import { possibleDuplicates } from "./possible-duplicates.js";
import { SemanticDecisionIndex } from "./semantic-decision-index.js";
import { ObsidianVaultRepository, DecisionContextRepository, DecisionScopeRepository, DecisionRelationRepository, DecisionAmendmentRepository, amendmentKey, type StoredAmendment } from "@cognelis/decision-storage";
import { detectIntegrationStatus, withCommandsLookedFor } from "./integration-status.js";
import { CustomClientService } from "./custom-client-service.js";
import { CLIENT_HOMES, loginShellEnvironment } from "./login-shell-path.js";
import { watchForNewDay } from "./new-day.js";
import { registerDecisionIpc } from "./ipc.js";
import { createObsidianSearchRuntime } from "./obsidian-search/obsidian-search-runtime.js";
import { readObsidianNote, searchObsidianNotes } from "./obsidian-search/obsidian-note-tools.js";
import { buildKnowledgeGraph } from "./knowledge-graph-service.js";
import { LocalCaptureServer } from "./local-server.js";
import { ManualFormDraftStore } from "./manual-form-draft-store.js";
import { PromptLibraryStore } from "./prompt-library-store.js";
import { AnthropicMessagesAdapter } from "./model/adapters/anthropic-messages-adapter.js";
import { ClaudeCodeCliAdapter } from "./model/adapters/claude-code-cli-adapter.js";
import { CodexCliAdapter } from "./model/adapters/codex-cli-adapter.js";
import { OpenAICompatibleAdapter } from "./model/adapters/openai-compatible-adapter.js";
import { OpenAIResponsesAdapter } from "./model/adapters/openai-responses-adapter.js";
import { CredentialVault } from "./model/credential-vault.js";
import {
  LocalModelClientDiscovery,
  localModelClientErrorCode,
} from "./model/cli/cli-discovery.js";
import { HttpModelTransport, ModelProviderError } from "./model/http-model-transport.js";
import { modelNetworkEnvironment } from "./model/provider-network.js";
import { ModelProviderService } from "./model/model-provider-service.js";
import { OpenRouterDecisionClient } from "./model/openrouter-decision-client.js";
import { combinedTraces, createDecisionCallStore } from "./model/decision-call-log.js";
import { ProfiledModelGateway } from "./model/profiled-model-gateway.js";
import { DecisionAssistantService } from "./decision-assistant-service.js";
import { ClientOnboardingService } from "./client-onboarding-service.js";
import { AssistantFeedbackStore, forgetAssistantTurns } from "./assistant-feedback-store.js";
import { ReviewReminderService } from "./review-reminder-service.js";
import { ProviderProfileRepository } from "./model/provider-profile-repository.js";
import {
  MethodologyService,
  type MethodologyImportCandidate,
} from "./methodology-service.js";
import { MethodologyHistoryStore } from "./methodology-history-store.js";
import { MethodologyMergeLifecycleService } from "./methodology-merge-lifecycle-service.js";
import { readMethodologyMarkdownSources } from "./methodology-markdown-import.js";
import { MethodologySuggestionPreferenceStore } from "./methodology-suggestion-preference-store.js";
import {
  buildMethodologyUsageSnapshot,
  buildMethodologyValidationInbox,
} from "./methodology-usage-service.js";
import { PracticeAssetService } from "./practice-asset-service.js";
import { PracticeAssetHistoryStore } from "./practice-asset-history-store.js";
import { PracticePublicationService } from "./practice-publication-service.js";
import { SemanticPairInbox } from "./semantic-pair-inbox.js";
import { SemanticSearchService } from "./semantic-search-service.js";
import { AppleFoundationModelProvider } from "./semantic/apple-foundation-provider.js";
import { LocalClassifierClient, LocalEmbeddingClient, LocalModelHost, localModelEnvironment } from "./semantic/local-model-client.js";
import { qwenModelMissing } from "./semantic/model-manifest.js";
import { SemanticDecisionCoordinator } from "./semantic/semantic-coordinator.js";
import {
  removeRuntimeDescriptor,
  writeObsidianSearchShutdownMarker,
  writeRuntimeDescriptor,
} from "./runtime-file.js";
import {
  discoverObsidianVaults,
  SettingsRepository,
  withModelTraceContentEnabled,
  withCaptureClassifier,
  captureClassifierMoveFailedMessage,
  withReviewRemindersEnabled,
  withVaultPath,
  withTheme,
  withAccent,
  serializeSettingsChanges,
} from "./settings.js";
import { stopManagedProcesses } from "./model/cli/managed-child-process.js";
import { reviewReminderNotifier } from "./review-notifications.js";
import { LocalReviewService, localReviewSummary, localReviewNotification } from "./local-review-service.js";
import { LocalReviewGit } from "./local-review-git.js";
import { ReviewBenchmarkService } from "./review-benchmark-service.js";
import { PrReviewHistoryStore } from "./pr-review-history-store.js";
import { listPrsForAgent, queryRecords, recordComments, recordView, updateFinding } from "./pr-review-records.js";
import { descriptionDraftForAgent, updatePrForAgent, type PrDescriptionToolSources } from "./pr-description-tools.js";
import { startReviewForAgent } from "./pr-review-runs.js";
import { commentsForAgent, receivedComments, respondToComment, updateCommentForAgent, type PrResponseSources } from "./pr-comment-responses.js";
import { getLocalReviewJob, listLocalReviewJobs, recordLocalReviewJob, updateLocalReviewJob, type LocalReviewToolSources } from "./local-review-agent-tools.js";
import { followOutcomes, readOutcomes, type PrOutcomeSources } from "./pr-review-outcomes.js";
import { PrAutoReviewUsage, autoReviewPass, reviewSettingsFor, updateReviewSettings, type PrAutoReviewSources, type PrReviewSettingsSources } from "./pr-auto-review.js";
import { PrTeamFactsCache, reviewQualityFor, setReviewRuleEnabled, type ReviewQualitySources } from "./review-quality.js";
import { ReviewEscapeStore, escapesFor, recordEscape, updateEscape, type ReviewEscapeSources } from "./review-escapes.js";
import { ReviewBenchmarkRuns } from "./review-benchmark-runs.js";
import { SuggestionLedger, benchmarkPage, type ReviewBenchmarkPageSources } from "./review-benchmark-page.js";
import { PromotionLedger, actOnPromotion, promotionsFor, promotionsForAgent, type ReviewPromotionSources } from "./review-promotions.js";
import type { PrReviewRunSources } from "./pr-review-runs.js";
import { configureTray, TrayLifecycle } from "./tray.js";
import { adaptWindow } from "./window-adapter.js";
import {
  WindowManager,
  type BrowserWindowOptionsLike,
} from "./window-manager.js";
import { IPC_CHANNELS, pendingWorkTotal } from "../shared/renderer-api.js";
import type {
  DecisionLibraryItem,
  DecisionAppliedPrinciple,
  MethodologyItem,
  MethodologyVersionItem,
  PracticeAssetItem,
  PracticeAssetVersionItem,
} from "../shared/renderer-api.js";

const toDecisionLibraryItem = (
  decision: IndexedDecision,
  methodologies: MethodologyRecord[] = [],
  searchMatch?: DecisionLibraryItem["searchMatch"],
  answer?: SelectedAnswer,
): DecisionLibraryItem => ({
  id: decision.id,
  created: decision.created,
  sourceClient: decision.sourceClient,
  project: decision.project,
  question: decision.question,
  selectedAnswer: answer === undefined || answer.kind === "custom" ? decision.selectedAnswer : answer.values.join("、"),
  ...(answer === undefined ? {} : { answer }),
  rationaleStatus:
    decision.rationaleStatus === "captured" ||
    decision.rationaleStatus === "deferred" ||
    decision.rationaleStatus === "skipped"
      ? decision.rationaleStatus
      : "skipped",
  rationale: decision.rationale,
  context: decision.context,
  expectedOutcome: decision.expectedOutcome ?? null,
  outcome: decision.outcome,
  reviewDueDate: decision.reviewDueDate,
  // A reason a later version wrote, read here from a shared index, has no label: left out, never shown as "undefined".
  ...((labels) => (labels.length > 0 ? { reviewScheduleReasons: labels } : {}))(
    (decision.reviewScheduleReasons ?? []).flatMap((reason) => REVIEW_SCHEDULE_REASON_LABELS[reason as ReviewScheduleReason] ?? []),
  ),
  contentHash: decision.contentHash,
  outcomeReview:
    (decision.outcomeVerdict === "better" ||
      decision.outcomeVerdict === "as_expected" ||
      decision.outcomeVerdict === "mixed" ||
      decision.outcomeVerdict === "worse" ||
      decision.outcomeVerdict === "unclear") &&
    decision.outcomeReviewedAt !== null
      ? {
          verdict: decision.outcomeVerdict,
          lesson: decision.outcomeLesson,
          reviewedAt: decision.outcomeReviewedAt,
        }
      : null,
  ...(decision.sourceClient === "pr-comment" && decision.sourceEventId !== null
    ? { sourceUrl: decision.sourceEventId }
    : {}),
  appliedPrincipleIds: [...decision.appliedPrincipleIds],
  appliedPrinciples: decision.appliedPrincipleIds.flatMap((id) => {
    const methodology = methodologies.find((item) => item.id === id);
    return methodology === undefined
      ? []
      : [
          {
            id: methodology.id,
            title: methodology.title,
            status: methodology.status,
          },
        ];
  }),
  ...(searchMatch === undefined ? {} : { searchMatch }),
});

const toDecisionAppliedPrinciples = (
  ids: string[],
  methodologies: MethodologyRecord[],
): DecisionAppliedPrinciple[] =>
  ids.flatMap((id) => {
    const methodology = methodologies.find((item) => item.id === id);
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

const localCalendarDate = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

/**
 * The decisions every one of these principles cites, looked up at once: looked up per principle, a list or an
 * agent's consultation asked the index a thousand times.
 */
const citedDecisions = (index: SqliteIndex, records: MethodologyRecord[]): Pick<SqliteIndex, "findDecisions"> => {
  const found = new Map(index.findDecisions(records.flatMap((record) => record.sourceDecisionIds)).map((decision) => [decision.id, decision]));
  return { findDecisions: (ids) => [...new Set(ids)].flatMap((id) => found.get(id) ?? []) };
};

const toMethodologyItem = (
  record: MethodologyRecord,
  index: Pick<SqliteIndex, "findDecisions">,
  records: MethodologyRecord[],
  relations: MethodologyRelationRecord[] = [],
): MethodologyItem => {
  const sourceDecisions = index
    .findDecisions(record.sourceDecisionIds)
    .map((decision) => toDecisionLibraryItem(decision));
  const quality: MethodologyQualityAssessment = assessMethodologyQuality(
    record,
    records,
    sourceDecisions.map((decision) => ({
      id: decision.id,
      project: decision.project,
      sourceClient: decision.sourceClient,
      outcomeVerdict: decision.outcomeReview?.verdict ?? null,
    })),
    relations,
  );
  return {
    ...record,
    ...(record.sourcePrincipleIds === undefined
      ? {}
      : {
          sourcePrinciples: record.sourcePrincipleIds.flatMap((id) => {
            const source = records.find((candidate) => candidate.id === id);
            return source === undefined
              ? []
              : [
                  {
                    id: source.id,
                    status: source.status,
                    title: source.title,
                    principle: source.principle,
                    appliesWhen: source.appliesWhen,
                    caution: source.caution,
                    ...(source.retiredAt === undefined
                      ? {}
                      : { retiredAt: source.retiredAt }),
                    ...(source.supersededById === undefined
                      ? {}
                      : { supersededById: source.supersededById }),
                  },
                ];
          }),
        }),
    sourceDecisions,
    quality,
  };
};

const toMethodologyVersionItem = (
  entry: MethodologyHistoryEntry,
): MethodologyVersionItem => ({
  version: entry.version,
  capturedAt: entry.capturedAt,
  reason: entry.reason,
  snapshot: {
    updatedAt: entry.snapshot.updatedAt,
    title: entry.snapshot.title,
    principle: entry.snapshot.principle,
    appliesWhen: entry.snapshot.appliesWhen,
    caution: entry.snapshot.caution,
    evidenceSummary: entry.snapshot.evidenceSummary,
    sourceDecisionIds: entry.snapshot.sourceDecisionIds,
    confidence: entry.snapshot.confidence,
    provider: entry.snapshot.generation.provider,
    model: entry.snapshot.generation.model,
  },
});

const toPracticeAssetItem = (
  record: PracticeAssetRecord,
  methodologies: MethodologyRecord[],
): PracticeAssetItem => {
  const byId = new Map(methodologies.map((item) => [item.id, item]));
  return {
    ...record,
    supersedesId: record.supersedesId ?? null,
    freshness: assessPracticeAssetFreshness(record, methodologies),
    sourceChanges: comparePracticeAssetSources(record, methodologies),
    sourcePrinciples: record.sourcePrincipleIds.flatMap((id) => {
      const source = byId.get(id);
      return source === undefined
        ? []
        : [
            {
              id: source.id,
              updatedAt: source.updatedAt,
              status: source.status,
              title: source.title,
              principle: source.principle,
              appliesWhen: source.appliesWhen,
              caution: source.caution,
              confidence: source.confidence,
            },
          ];
    }),
  };
};

const toPracticeAssetVersionItem = (
  entry: PracticeAssetHistoryEntry,
): PracticeAssetVersionItem => ({
  version: entry.version,
  capturedAt: entry.capturedAt,
  reason: entry.reason,
  snapshot: {
    updatedAt: entry.snapshot.updatedAt,
    title: entry.snapshot.title,
    summary: entry.snapshot.summary,
    trigger: entry.snapshot.trigger,
    steps: entry.snapshot.steps,
    checks: entry.snapshot.checks,
    fallback: entry.snapshot.fallback,
    sourcePrincipleIds: entry.snapshot.sourcePrincipleIds,
    ...(entry.snapshot.sourceSnapshots === undefined
      ? {}
      : { sourceSnapshots: entry.snapshot.sourceSnapshots }),
  },
});

const rendererLocation = ():
  { kind: "url"; value: string } | { kind: "file"; value: string } =>
  MAIN_WINDOW_VITE_DEV_SERVER_URL
    ? { kind: "url", value: MAIN_WINDOW_VITE_DEV_SERVER_URL }
    : {
        kind: "file",
        value: join(
          __dirname,
          `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
        ),
      };

const ELECTRON_THEME_SOURCE = {
  auto: "system",
  light: "light",
  dark: "dark",
} as const;

const trayLifecycle = new TrayLifecycle<Tray>();
let openDesktopApplication = (): void => undefined;

// A Windows install's launcher of the bridge at the install root, which updates leave in place (bridge-path.ts):
// once written, what the hooks and MCP registrations name, so an update no longer breaks them.
let bridgeLauncher: string | null = null;
const bridgeExecutablePath = (): string =>
  bridgeLauncher ??
  resolveBridgeExecutablePath({
    packaged: app.isPackaged,
    platform: process.platform,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });

// Windows draws a tray icon as it is: macOS's template (black, recoloured by the menu bar) was not to be seen
// on a dark taskbar. The app's own icon there.
const trayIconName = process.platform === "win32" ? "app-icon.ico" : "trayTemplate.png";
const trayIconPath = (): string =>
  app.isPackaged
    ? join(process.resourcesPath, "assets", trayIconName)
    : join(app.getAppPath(), "apps", "desktop", "assets", trayIconName);

// The skills shipped with this version, which an install puts in Codex's and Claude Code's skills folders.
const bundledSkillsPath = (): string =>
  app.isPackaged ? join(process.resourcesPath, "skills") : join(app.getAppPath(), "skills");

const foundationModelHelperPath = (): string =>
  app.isPackaged
    ? join(
        process.resourcesPath,
        "semantic",
        "paraself-foundation-model-helper",
      )
    : join(
        app.getAppPath(),
        "dist",
        "semantic",
        "paraself-foundation-model-helper",
      );

// Started from Finder or the Dock, the app has launchd's PATH, without claude or codex on it: see
// login-shell-path.ts. Begun now and awaited only where a client's command runs, so startup does not wait.
const loginPathReady: Promise<void> =
  process.platform === "win32"
    ? Promise.resolve()
    : loginShellEnvironment().then((login) => {
        process.env.PATH = login.PATH;
        // Moved in the shell's files, where a terminal has them; one set for the app itself still wins.
        for (const name of CLIENT_HOMES) {
          if (!process.env[name] && login[name] !== undefined) process.env[name] = login[name];
        }
      }, () => undefined);

const currentBridgeReference = (): string | undefined => {
  try {
    return hookBridgeReference(bridgeExecutablePath(), process.platform);
  } catch {
    return undefined;
  }
};

const bootstrap = async (
  userDataResolution: UserDataResolution,
): Promise<void> => {
  const paths = applicationSupportPaths(userDataResolution.path);
  // Electron's default menu has Reload (⌘R) and the developer tools: a reload took whatever was being
  // written with it, a rationale half written among it. Packaged, the menus a reader needs stay (Edit
  // above all, which copy and paste in a text field go through on macOS) and those go.
  if (app.isPackaged) {
    Menu.setApplicationMenu(
      process.platform === "darwin"
        ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "fileMenu" }, { role: "editMenu" }, { role: "windowMenu" }])
        : null,
    );
  }
  if (userDataResolution.migrationError !== undefined) {
    // Decision's data folder could not be renamed (on Windows, while the older App still has a file in it open): this
    // run keeps to it, as do the hooks, and the next start tries again.
    console.error(`[paraself] data folder not moved from ${userDataResolution.path}: ${userDataResolution.migrationError}`);
    if (readParaselfEnvironment(process.env, "SMOKE") !== "1") {
      void dialog.showMessageBox({
        type: "warning",
        message: "数据文件夹没能改名为 Paraself",
        detail: `这次仍在使用原来的 ${userDataResolution.path}，数据都在（${userDataResolution.migrationError}）。退出旧版 Decision 等可能占用它的程序后重新打开 Paraself，会再改名一次。`,
      });
    }
  }
  const settingsRepository = new SettingsRepository(paths.settings);
  // Each client's hook file, by id, where the registry says it keeps its settings: CLAUDE_CONFIG_DIR, CODEX_HOME and
  // GROK_HOME move them, as they move where its `mcp add` registers the server.
  // Read when used: the login shell's variables arrive a moment after startup.
  // The clients the reader added on the 接入 page beside the built-in ones. A file that cannot be read is set aside
  // and the App starts with none of them, rather than not at all.
  // A client of the reader's is checked where its hook file really is again just before that file is written: a link
  // along its path may have moved since it was saved.
  const checkTarget = (client: string, path: string, stage: "check" | "write") => customClients.checkTarget(client, path, stage);
  const customClients: CustomClientService = new CustomClientService({
    path: paths.customClients,
    builtInPaths: () => clientHookPaths(KNOWN_CLIENTS, process.env, homedir()),
    protectedDirectories: () => [userDataResolution.path, dirname(paths.runtime)],
    platform: process.platform,
    // Saves and deletes wait in the queue installs and removals run in; the disconnect inside one queues no further.
    serialize: inIntegrationsTurn,
    disconnect: (client) =>
      removeIntegrationsWithinTurn({
        mode: "apply",
        bridgePath: bridgeExecutablePath(),
        platform: process.platform,
        clients: [client],
        paths: clientHookPaths([client], process.env, homedir()),
        checkTarget,
      }),
  });
  // Nothing of the reader's clients keeps the App from starting: a file not read at all starts it with the built-in
  // ones alone, said so.
  const customClientsAside = await customClients.load().then(
    ({ setAside }) => setAside,
    (error: unknown) => {
      console.error(`[paraself] custom clients not loaded: ${error instanceof Error ? error.message : String(error)}`);
      return "（没能挪开）";
    },
  );
  if (customClientsAside !== null) {
    console.error(`[paraself] custom clients unreadable, set aside as ${customClientsAside}`);
    if (readParaselfEnvironment(process.env, "SMOKE") !== "1") {
      void dialog.showMessageBox({ type: "warning", message: "自定义客户端的配置读不出来", detail: `已挪到 ${customClientsAside}，接入页里暂时没有自定义客户端；可以重新添加。` });
    }
  }
  // Those written in code, then the catalog's, then the reader's own: the order a hook's client id is looked up in.
  const allClients = () => [...KNOWN_CLIENTS, ...customClients.descriptors()];
  // The clients a row's 接入 or the page's 全部修复 named, by id: every one where none is named.
  const clientsNamed = (ids?: string[]) => (ids === undefined ? allClients() : allClients().filter((client) => ids.includes(client.id)));
  const integrationPaths = (): Record<string, string> => clientHookPaths(allClients(), process.env, homedir());
  // Pointed at this version before any hook is looked at: hooks naming an earlier version's folder then read as
  // needing a reconnect, once, and after it name the launcher.
  if (app.isPackaged) {
    bridgeLauncher = await prepareBridgeLauncher(squirrelBridgeLauncher({
      platform: process.platform,
      execPath: process.execPath,
      resourcesPath: process.resourcesPath,
      exists: existsSync,
    }));
  }
  // Read in the installer's queue too: a slower pre-save check must not publish an older status afterward.
  // Connected clients whose bundled skills could not be brought up to this version: shown as needing a reconnect, which
  // runs the install again and says, in its report, what of the skills was and was not done.
  const skillsBehind = new Set<string>();
  const noteSkills = (reports: readonly SkillInstallReport[] | undefined, clients: readonly string[]) => {
    for (const client of clients) skillsBehind.delete(client);
    for (const client of clientsBehindOnSkills(reports ?? [])) skillsBehind.add(client);
  };
  const detectedIntegrationStatus = () => customClients.inTurn(async () => {
    const status = await withCommandsLookedFor(await detectIntegrationStatus(integrationPaths(), currentBridgeReference(), process.platform, allClients()), allClients());
    for (const client of skillsBehind) if (status[client] === "installed") status[client] = "upgrade-required";
    return status;
  });
  let integrationStatus = await detectedIntegrationStatus();
  let settings = await settingsRepository.moveCaptureClassifier(await settingsRepository.load());
  if (settingsRepository.captureClassifierMoveFailed !== null) {
    // Kept as it was rather than used unsaved: said, as it was kept.
    const failure = captureClassifierMoveFailedMessage(settings.captureClassifier, settingsRepository.captureClassifierMoveFailed);
    console.error(`[paraself] capture classifier default not moved: ${failure}`);
    if (readParaselfEnvironment(process.env, "SMOKE") !== "1") {
      void dialog.showMessageBox({ type: "warning", message: "采集分类的设置没能保存", detail: failure });
    }
  }
  if (settingsRepository.setAside !== null && readParaselfEnvironment(process.env, "SMOKE") !== "1") {
    // Started from the defaults rather than not at all; said once, so the reset is not a mystery.
    void dialog.showMessageBox({
      type: "warning",
      message: "设置文件读不出来，这次用默认设置启动",
      detail: `原来的文件已另存为 ${settingsRepository.setAside}。仓库按 Obsidian 最近打开的那个选取，不对的话请在设置里重新选择；外观、模型记录和提醒等也回到了默认。`,
    });
  }
  const configuredVault = readParaselfEnvironment(
    process.env,
    "VAULT_PATH",
  );
  if (configuredVault !== undefined) {
    settings = withVaultPath(settings, configuredVault);
    // Named outright by the environment: made if it is not there yet, as the first run's vault is below.
    await mkdir(configuredVault, { recursive: true }).catch(() => undefined);
  } else if (settings.vaultPath === null) {
    const discovered = await discoverObsidianVaults(
      resolveObsidianConfigurationPath(),
    ).catch(() => []);
    const fallback = resolveDefaultVaultPath(app.getPath("documents"));
    settings = withVaultPath(settings, discovered[0] ?? fallback);
    await settingsRepository.save(settings);
    // A first run's default vault is made here, where it is chosen, rather than by the first save into it:
    // the decision watcher then has a folder to watch from the start. A vault found in Obsidian's list is there
    // already; made, one gone since would have been put back empty, and the missing vault never said.
    if (discovered[0] === undefined) await mkdir(fallback, { recursive: true }).catch(() => undefined);
  }

  const vaultPath = settings.vaultPath;
  if (vaultPath === null) {
    throw new Error("Paraself could not resolve a vault path");
  }
  // Every llama call runs in the local models' own process, started by the first call that needs it (IMP-135).
  const localModels = new LocalModelHost({
    spawn: () => {
      const child = utilityProcess.fork(join(__dirname, "local-model-host.cjs"), [], {
        serviceName: "Paraself Local Models",
        env: localModelEnvironment(process.env),
      });
      return {
        postMessage: (message) => child.postMessage(message),
        onMessage: (listener) => child.on("message", listener),
        onExit: (listener) => child.on("exit", listener),
        kill: () => { if (child.pid !== undefined) process.kill(child.pid, "SIGKILL"); },
      };
    },
  });
  const obsidianSearch = await createObsidianSearchRuntime({
    vaultPath,
    indexRoot: paths.obsidianSearchRoot,
    modelsDirectory: paths.models,
    openExternal: (uri) => shell.openExternal(uri),
    factories: {
      embedding: (options) => new LocalEmbeddingClient(localModels, options),
    },
  });
  nativeTheme.themeSource = ELECTRON_THEME_SOURCE[settings.theme];
  // Every change the reader makes from here goes through this, one at a time, each to what the one before left.
  const changeSettings = serializeSettingsChanges(
    () => settings,
    async (next) => {
      await settingsRepository.save(next);
      settings = next;
    },
  );
  // One for the app: each keeps the notes of every folder it reads in memory, and the decisions' repository and
  // the agents' search both read the decisions folder.
  const vault = new ObsidianVaultRepository(vaultPath);
  let synchronizeVectors = (): void => undefined;
  const index = new SemanticDecisionIndex(paths.index, () => synchronizeVectors());
  const localDecisions = new LocalDecisionStore(paths.localDecisions);
  // A vault folder that has gone (moved, a drive not connected) is not made up again empty by a write:
  // the write is refused, saying so, and a capture waits in the recovery queue.
  const repository = new MarkdownRepository(vaultPath, { existingVault: true, vault, locate: (id) => index.pathOf(id) });
  const decisionScopes = new DecisionScopeRepository(vaultPath);
  const decisionAmendments = new DecisionAmendmentRepository(vaultPath);
  // Adopted execution experiences (IMP-191): notes in the vault, searched when an agent names them.
  const experienceRepository = new ExperienceRepository(vaultPath, { existingVault: true });
  const decisionRelations = new DecisionRelationRepository(vaultPath);
  const contextRepository = new DecisionContextRepository(vaultPath, decisionScopes, decisionRelations, vault);
  const decisionAnswers = new DecisionAnswerCache(contextRepository, index);
  const decisionFeedback = new DecisionFeedbackService(contextRepository, createDecisionFeedbackStore(vaultPath));
  // What a semantic sync reads: every decision by its note's hash, and whole only those whose notes changed.
  const indexedDecisions = {
    stamps: () => index.queryDecisionStamps({ everything: true }),
    load: (ids: string[]) => index.findDecisions(ids),
  };
  const semanticSearch = new SemanticSearchService({
    vectors: new SemanticVectorIndex(paths.semanticVectors),
    gateway: new LocalEmbeddingClient(localModels, {
      modelsDirectory: paths.models,
    }),
    contextSnapshot: () => contextRepository.scan(),
    currentSources: async () => ({ decisions: indexedDecisions, methodologies: await methodologyService.list() }),
    decisions: indexedDecisions,
    // A search's own records on another context of the same model, behind no query's vector (IMP-137).
    freshGateway: new LocalEmbeddingClient(localModels, {
      modelsDirectory: paths.models,
    }),
  });
  const decisionContext = new DecisionContextService(contextRepository, decisionScopes, decisionRelations, semanticSearch);
  // The handoff tells a decision as it stands: its additions and rewrites in, the first words said beside them.
  const decisionHandoff = new DecisionHandoffService(amendedRepository(contextRepository, decisionAmendments), vault, (uri) => shell.openExternal(uri), undefined,
    (results) => annotateResults(results, decisionAmendments));
  // Principle and relation notes the last reads could not read: in no list, so the page says which
  // (health.methodologyMessage).
  let methodologyMessage: string | undefined;
  // The controller comes later; a read before it only keeps the message.
  let methodologyMessageChanged = (): void => undefined;
  const unreadableNotes = { principles: [] as string[], relations: [] as string[] };
  const sayUnreadable = (kind: keyof typeof unreadableNotes) => (notes: Array<{ path: string }>): void => {
    unreadableNotes[kind] = notes.map((note) => basename(note.path));
    const names = [...unreadableNotes.principles, ...unreadableNotes.relations];
    const message = names.length === 0
      ? undefined
      : `${names.length} 篇原则或原则关系笔记读不出来，或是同步冲突留下的同编号副本，没有出现在任何列表里：${names.slice(0, 3).join("、")}${names.length > 3 ? " 等" : ""}。在 Obsidian 中修正或删掉多余的那篇后会自动出现。`;
    if (message === methodologyMessage) return;
    methodologyMessage = message;
    methodologyMessageChanged();
  };
  // As with decisions: a vault folder that has gone is not made up again empty by a write.
  const methodologyRepository = new MethodologyRepository(vaultPath, {
    existingVault: true,
    onUnreadable: sayUnreadable("principles"),
  });
  const methodologyRelationRepository = new MethodologyRelationRepository(vaultPath, {
    existingVault: true,
    onUnreadable: sayUnreadable("relations"),
  });
  const practiceAssetRepository = new PracticeAssetRepository(vaultPath, { existingVault: true });
  // What a principle's validation reads: only reviewed decisions count, where every decision was read whole.
  const reviewedDecisions = () => index.queryDecisions({ reviewState: "reviewed", everything: true });
  const spool = new CaptureSpool(paths.spool);
  const candidateSpool = new CandidateSpool(paths.candidateSpool);
  const semanticPairSpool = new SemanticPairSpool(paths.semanticPairSpool);
  const captureAudit = new CaptureAuditStore(paths.captureAudit);
  const modelTraces = new ModelTraceStore(paths.modelTraces, {
    contentMode: () =>
      settings.modelTraceContentEnabled ? "full" : "metadata-only",
  });
  const decisionCalls = createDecisionCallStore(paths.decisionModelCalls);
  // The log page reads, deletes and clears jev's records with the rest.
  const allModelTraces = combinedTraces(modelTraces, [decisionCalls], (error) => {
    console.error(`[paraself] decision-model call records unavailable: ${error instanceof Error ? error.message : String(error)}`);
  });
  const providerProfiles = new ProviderProfileRepository(
    paths.modelProviderProfiles,
  );
  const providerCredentials = new CredentialVault(
    paths.modelProviderCredentials,
    {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (value) => safeStorage.encryptString(value),
      decryptString: (value) => safeStorage.decryptString(value),
    },
    settings.localCredentialsEnabled,
  );
  // Reconcile files after an interrupted mode switch before serving credentials. The setting says the mode, except
  // where it cannot be trusted: a switch cut short after moving keys but before its setting was saved (its mark still
  // there), or the file beside the settings set aside (the setting a default). Then the keys say it, where they agree:
  // read as off while every key was kept here, they went to the keychain against the reader's choice, or, the
  // keychain refusing, the app could not start; read as on after a switch to off, they came back out in plain text.
  // Asked of the keys at every start, keys filled in again under 1.1.0 (into the keychain) turned the mode off.
  const fromKeys = (await providerCredentials.switchCutShort()) || settingsRepository.addedSetAside !== null;
  const localCredentials = (fromKeys ? await providerCredentials.keptMode() : null) ?? settings.localCredentialsEnabled;
  const corrected = localCredentials !== settings.localCredentialsEnabled;
  try {
    // Saved before the switch's mark is cleared: not saved, the keys say the mode again at the next start.
    await providerCredentials.setLocalMode(localCredentials, async () => {
      if (corrected) await settingsRepository.save({ ...settings, localCredentialsEnabled: localCredentials });
    });
    settings = { ...settings, localCredentialsEnabled: localCredentials };
  } catch (error) {
    if (!corrected) throw error;
  }
  if (settingsRepository.addedSetAside !== null && readParaselfEnvironment(process.env, "SMOKE") !== "1") {
    // Said, as for the settings file: set aside without a word, the settings it held went back to their defaults.
    void dialog.showMessageBox({
      type: "warning",
      message: "部分设置读不出来，这次按默认值启动",
      detail: `原来的文件已另存为 ${settingsRepository.addedSetAside}。${localCredentials ? "复盘提醒和采集分类回到了默认，已保存的密钥仍留在本机" : "复盘提醒、采集分类和本机保存密钥回到了默认"}，需要的话请在设置里重新选择。`,
    });
  }
  const modelEnvironment = modelNetworkEnvironment(process.env, () => settings.modelProxyUrl);
  const modelTransport = new HttpModelTransport(modelEnvironment);
  const localClientDiscovery = new LocalModelClientDiscovery({ environment: modelEnvironment, cacheDirectory: join(dirname(paths.modelProviderProfiles), "cli-model-catalogs") });
  let localClientStatuses: LocalModelClientStatus[] = [];
  // At launch, only the clients of enabled profiles (inspectProfiles); the models page asks for both.
  const refreshLocalClientStatuses = async (onlyEnabled = false): Promise<
    LocalModelClientStatus[]
  > => {
    const statuses = await localClientDiscovery.inspectProfiles(await providerProfiles.load(), {
      onlyEnabled,
      known: localClientStatuses,
    });
    await providerProfiles.refreshLocalClients(statuses);
    localClientStatuses = statuses;
    return statuses;
  };
  await refreshLocalClientStatuses(true);
  if (providerProfiles.setAside !== null && readParaselfEnvironment(process.env, "SMOKE") !== "1") {
    // Started from the built-ins rather than not at all; said once, as for settings.
    void dialog.showMessageBox({
      type: "warning",
      message: "模型服务配置读不出来，这次用内置的模型服务启动",
      detail: `原来的文件已另存为 ${providerProfiles.setAside}。自己添加的模型服务需要在设置里重新添加。`,
    });
  }
  if (providerProfiles.addedSetAside !== null && readParaselfEnvironment(process.env, "SMOKE") !== "1") {
    // Set aside without a word, a backend set to connect directly went through the environment's proxy.
    void dialog.showMessageBox({
      type: "warning",
      message: "模型服务的部分设置读不出来，这次按默认值启动",
      detail: `原来的文件已另存为 ${providerProfiles.addedSetAside}。各个模型服务的代理、JSON 输出方式、失败时是否换用下一个和计价回到了默认，请在“模型”里检查后重新设置。`,
    });
  }
  // Looked for again once the login shell's PATH is in (login-shell-path.ts): started from the Dock, the
  // first look ran on launchd's, which has neither CLI on it. Startup does not wait for it.
  void loginPathReady.then(() => refreshLocalClientStatuses(true)).catch(() => undefined);
  // A review the App writes keeps the scope and relations bound to the decision's version (IMP-128).
  const store = new DecisionStore(repository, index, undefined, async (id, from, to) => {
    const [scope, relations, rewrites] = await Promise.all([
      decisionScopes.rebind({ source: "decisions", recordId: id }, from, to),
      decisionRelations.rebind({ source: "decisions", recordId: id }, from, to),
      // What an agent or the reader rewrote of the decision holds across a review, as scope does.
      decisionAmendments.rebind({ source: "decisions", recordId: id }, from, to),
    ]);
    return scope < 0 || relations < 0 || rewrites < 0 ? -1 : scope + relations + rewrites;
  });
  const journalRepository = new JournalEntryRepository(vaultPath, { existingVault: true });
  // Preference or idea notes the last read of the list could not read: they are not in it, so the list
  // says which, until they read again (health.journalMessage).
  let journalMessage: string | undefined;
  // Moved at each preference or idea written (DashboardSnapshot.journalRevision): the list in view reads again.
  let journalRevision = 0;
  const activeRecordService = new ActiveRecordService({
    decisionStore: store,
    decisionIndex: index,
    journalRepository,
    idFactory: randomUUID,
    onJournalWritten: () => {
      journalRevision += 1;
      controller?.refresh();
    },
    onJournalScan: (diagnostics) => {
      const message = journalNotice(diagnostics);
      if (message === journalMessage) return;
      journalMessage = message;
      controller?.refresh();
    },
  });
  // Preferences and ideas beside the decisions for the agents' search (source=preferences|ideas).
  // What agents search reads the notes with their additions in; the pages and the outcome write read them as they are.
  const agentDecisionContext = new DecisionContextService(amendedRepository(contextRepository, decisionAmendments), decisionScopes, decisionRelations, semanticSearch);
  const contextSearch = new ContextSearch(
    agentDecisionContext,
    { scan: () => activeRecordService.scanJournalEntries({ everything: true }) },
    semanticSearch,
    decisionAmendments,
    { scan: () => organization.searchableExperiences() },
  );
  const decisionAmendment = new DecisionAmendmentService(decisionAmendments, {
    find: async (source, recordId) => {
      if (source === "preferences" || source === "ideas") {
        const entry = (await activeRecordService.scanJournalEntries({ everything: true })).entries.find((item) => item.id === recordId && item.kind === (source === "preferences" ? "preference" : "idea"));
        if (entry === undefined) return null;
        return { contentHash: journalContentHash(entry), userWrote: userWrote(entry), summary: entry.content, appliesWhen: entry.kind === "preference" ? entry.appliesWhen : null, caution: entry.kind === "preference" ? entry.exceptions : null };
      }
      const snapshot = await contextRepository.scan(true);
      if (snapshot.sources.some((item) => item.source === source && item.status === "unavailable")) return "unavailable";
      const document = snapshot.documents.find((item) => item.source === source && item.id === recordId);
      if (document?.contentHash === undefined) return null;
      // A decision's own words, as its note has them: what a rewrite of them is made against.
      const row = source === "decisions" ? index.findDecisions([recordId])[0] : undefined;
      return {
        contentHash: document.contentHash, summary: document.summary, appliesWhen: document.appliesWhen, caution: document.caution,
        ...(row === undefined ? {} : { decision: { question: row.question, choice: row.selectedAnswer, rationale: row.rationale, context: row.context, expectedOutcome: row.expectedOutcome ?? null } }),
      };
    },
  });
  // 历史决定: notes under their own folder, an index and history in their own file. A record reaches the decision
  // records only by 转为正式决策, which writes one through the same path a decision typed in the App takes.
  let historicalDecisionRevision = 0;
  const historicalDecisions = new HistoricalDecisionService({
    repository: new HistoricalDecisionRepository(vaultPath, { existingVault: true }),
    indexPath: paths.historicalDecisions,
    idFactory: randomUUID,
    promote: async (record) => (await activeRecordService.create(proactiveRecordRequestSchema.parse({
      recordVersion: PROACTIVE_RECORD_VERSION,
      requestId: `historical-${record.id}`,
      sourceClient: "manual",
      kind: "decision",
      // A PR comment decision carries its comment's link, which this record does not keep as one.
      sourceKind: record.sourceKind === "pr_comment" ? "app_manual" : record.sourceKind,
      sourceForm: "user_paraphrase",
      title: record.title,
      content: record.decision,
      options: record.options,
      tags: record.tags,
      knowledgeStatus: "active",
      // Noon of the day it was decided, on this machine's calendar.
      occurredAt: new Date(`${record.decidedOn}T12:00:00`).toISOString(),
      ...(record.context === null ? {} : { context: record.context }),
      ...(record.project === null ? {} : { project: record.project }),
    }))).recordId,
    onWritten: () => {
      historicalDecisionRevision += 1;
      // The first record makes the folder: from then on notes changed in Obsidian are watched too.
      historicalDecisionNotes.ensure();
      controller?.refresh();
    },
  });
  // A note changed outside the App (Obsidian, a sync) moves the revision as a write does: the list reads again.
  const historicalDecisionNotes = new TodoNoteWatcher(join(vaultPath, ...HISTORICAL_DECISION_FOLDER.split("/")), () => {
    historicalDecisionRevision += 1;
    controller?.refresh();
  });
  historicalDecisionNotes.ensure();
  /** A record's note, or one of the links or related notes it names: for the page and for agents (open_historical_decision) alike. */
  const openHistoricalDecision = async ({ id, link, relatedNote }: Omit<OpenHistoricalDecisionRequest, "version">): Promise<OpenHistoricalDecisionResult> => {
    // Only what the record itself names is opened: no caller can ask for any other address or note.
    const { record, notePath } = await historicalDecisions.get({ version: HISTORICAL_DECISION_VERSION, id });
    if (link !== undefined) {
      if (!record.references.some((reference) => reference.url === link)) throw new Error("这条历史决定里没有这个链接，可能刚被改过；请重新读取它再试。");
      await shell.openExternal(link);
      return { version: HISTORICAL_DECISION_VERSION, opened: "link", target: link };
    }
    const named = relatedNote === undefined ? undefined : relatedNoteLink(relatedNote);
    if (named !== undefined && !record.relatedNotes.includes(named)) throw new Error("这条历史决定里没有这篇关联笔记，可能刚被改过；请重新读取它再试。");
    const uri = new URL("obsidian://open");
    if (named === undefined) {
      // resolveNotePath keeps it to a regular note inside the vault, as for every note the App opens.
      uri.searchParams.set("path", await vault.resolveNotePath(notePath));
    } else {
      // By name, as Obsidian follows a [[link]]: without its alias or heading.
      uri.searchParams.set("vault", basename(vaultPath));
      uri.searchParams.set("file", named.replace(/^\[\[|\]\]$/gu, "").split(/[|#]/u)[0]!.trim());
    }
    await shell.openExternal(uri.toString().replace(/\+/gu, "%20"));
    return { version: HISTORICAL_DECISION_VERSION, opened: named === undefined ? "note" : "relatedNote", target: named ?? notePath };
  };
  // Moved at each todo list written (DashboardSnapshot.todoRevision), by an agent or on the page: the lists in view read again.
  let todoRevision = 0;
  const todoRepository = new TodoListRepository(vaultPath, { existingVault: true, history: new TodoHistoryStore(paths.todoHistory) });
  const todos = new TodoService({
    repository: todoRepository,
    idFactory: randomUUID,
    // The system's wastebasket, never a plain delete: a failure reaches the page as an error.
    trash: (path) => shell.trashItem(path),
    onWritten: () => {
      todoRevision += 1;
      // The first list makes the folder: from then on notes changed in Obsidian are watched too.
      todoNotes.ensure();
      controller?.refresh();
    },
  });
  // A todo note changed outside the App (Obsidian, a sync, a hand edit) moves the revision as a write does: the page reads again.
  const todoNotes = new TodoNoteWatcher(join(vaultPath, "Decision Journal", TODO_FOLDER), () => {
    todoRevision += 1;
    controller?.refresh();
  });
  todoNotes.ensure();
  // Lists saved before IMP-185 kept their history in the note: moved to this machine once, without holding up the start.
  void todos.migrateLegacy().then(
    ({ left }) => {
      for (const note of left) console.error(`[paraself] todo history left in ${basename(note.path)}: ${note.message}`);
    },
    (error: unknown) => console.error(`[paraself] todo history migration failed: ${error instanceof Error ? error.message : String(error)}`),
  );
  let localRecordTail: Promise<void> = Promise.resolve();
  const serializeLocalWrite = <T>(write: () => Promise<T>): Promise<T> => {
    const run = localRecordTail.then(write);
    localRecordTail = run.then(() => undefined, () => undefined);
    return run;
  };
  const noteFollow = createNoteFollow();
  const runtime = new CaptureRuntime({
    spool,
    candidateSpool,
    store,
    index,
    localDecisions,
    followOf: noteFollow,
    idFactory: randomUUID,
  });
  // A vault that is not there (moved, renamed, on a drive not connected) would rebuild as empty and wipe
  // the index while calling it healthy; one that cannot be read would end the app. Either is said instead,
  // and the last index is kept.
  if (!existsSync(vaultPath)) {
    runtime.reportIndexIssue(`找不到仓库目录 ${vaultPath}：它可能被移动、改名，或所在的磁盘没有连接。列表保留上次的索引；接回仓库后在设置里重建索引，或在设置里更换仓库后重启。`);
  } else {
    await runtime.rebuildIndex("reconcile").catch((error: unknown) => {
      runtime.reportIndexIssue(`决策索引没能从仓库重建：${error instanceof Error ? error.message : String(error)}。列表保留上次的索引。`);
    });
  }
  // Replayed at startup, as later: one capture that cannot be taken in (a full disk, an unreadable file)
  // stays in the recovery queue and is said, rather than ending the app before it opens.
  const pendingCaptures = await spool.list().catch((error: unknown) => {
    runtime.reportRecoveryIssue(`捕获恢复队列暂时无法读取（${error instanceof Error ? error.message : String(error)}）；内容已保留，问题解决后重启即可重试。`);
    return [];
  });
  runtime.reportRecoveryIssue(spool.recoveryIssue());
  await runtime.resumeCandidates(await candidateSpool.list(), pendingCaptures);
  for (const event of pendingCaptures) {
    await runtime.ingest(event).catch(() => {
      runtime.reportRecoveryIssue("部分待恢复的捕获暂时无法载入，已保留在恢复队列，下次启动时重试。");
    });
  }
  const localModelInstaller = new LocalModelInstaller(paths.models);
  const semanticGateway = new ProfiledModelGateway({
    profiles: providerProfiles,
    providerFactory: (profile: ModelProviderProfile) => {
      if (profile.kind === "apple") {
        return new AppleFoundationModelProvider({
          helperPath: foundationModelHelperPath(),
          timeoutMs: profile.timeoutMs,
        });
      }
      if (profile.kind === "qwen") {
        return new LocalClassifierClient(localModels, {
          modelsDirectory: paths.models,
          ...(profile.model === undefined ? {} : { model: profile.model }),
          timeoutMs: profile.timeoutMs,
        });
      }
      if (profile.kind === "openai") {
        return new OpenAIResponsesAdapter({
          profile,
          credentials: providerCredentials,
          transport: modelTransport,
        });
      }
      if (profile.kind === "anthropic") {
        return new AnthropicMessagesAdapter({
          profile,
          credentials: providerCredentials,
          transport: modelTransport,
        });
      }
      if (profile.kind === "openai-compatible") {
        return new OpenAICompatibleAdapter({
          profile,
          credentials: providerCredentials,
          transport: modelTransport,
        });
      }
      if (profile.kind === "codex-cli" || profile.kind === "claude-code-cli") {
        const status = localClientStatuses.find(
          (candidate) => candidate.kind === profile.kind,
        );
        if (
          status?.availability !== "available" ||
          status.executablePath === undefined ||
          status.executablePath !== profile.executablePath
        ) {
          throw new ModelProviderError(
            localModelClientErrorCode(
              status?.availability,
            ),
            status?.availability === "proxy_required" ? "请先为这个客户端配置有效的网络代理，再重试。" : "The configured local model client is not ready",
          );
        }
        return profile.kind === "codex-cli"
          ? new CodexCliAdapter({ profile, environment: modelEnvironment })
          : new ClaudeCodeCliAdapter({ profile, environment: modelEnvironment });
      }
      throw new ModelProviderError(
        "unsupported_client",
        "The configured CLI model provider is not available yet",
      );
    },
    traces: modelTraces,
    audit: captureAudit,
    onDeviceClassificationOnly: () => settings.captureClassifier === "local",
    onDeviceModelMissing: (profile) => qwenModelMissing(paths.models, profile.model ?? ""),
    // Any call of the foreground's: a background organization run gives way at once.
    onCall: (purpose) => { if (purpose !== "memory-organization") organization.noteForeground(); },
  });
  // 整理与记忆（IMP-191）: suggestions and their receipts on this machine, adopted experiences in the vault, every write
  // through the services that own it. The badge's count kept here, read again whenever the organization changes.
  const organizationLabIdle = readParaselfEnvironment(process.env, "SMOKE") === "1" && readParaselfEnvironment(process.env, "ORGANIZATION_LAB_IDLE") === "1";
  let organizationRevision = 0;
  let organizationPending = 0;
  let organizationAutomatic = false;
  const organization: OrganizationService = new OrganizationService({
    store: new OrganizationStore(paths.organization),
    readers: {
      pending: async () => {
        const rationales = runtime.pendingRationales(20_000);
        return {
          complete: rationales.length >= runtime.pendingRationaleCount(),
          records: [
            ...runtime.candidates.list().map((candidate) => ({ kind: "pending_confirmation" as const, id: candidate.candidateId, project: candidate.event.project, title: candidate.event.questions[0]?.question ?? "待确认记录", material: pendingConfirmationMaterial(candidate.event), at: candidate.createdAt })),
            ...rationales.map((entry) => ({ kind: "pending_rationale" as const, id: entry.id, project: entry.project, title: entry.question, material: `标题：${entry.question}\n已记录选择：${entry.selectedAnswer}\n背景：${entry.contextSummary ?? "未知"}\n理由：未记录，不允许猜测`, at: entry.created, root: `decision:${entry.id}` })),
          ],
        };
      },
      principles: async () => ({ records: await methodologyRepository.list(), complete: unreadableNotes.principles.length === 0 }),
      todos: () => todoRepository.scan(),
      journal: () => activeRecordService.scanJournalEntries({ everything: true }),
      decisions: () => contextRepository.scan(),
      amendments: () => decisionAmendments.scan(),
      experiences: () => experienceRepository.scan(),
      relative: (path) => relative(vaultPath, path).split(sep).join("/"),
    },
    gateway: semanticGateway,
    similar: (query, items, options) => semanticSearch.similarEntries(query, items, options),
    todos,
    amendments: decisionAmendment,
    relations: { update: (input) => decisionContext.updateRelation(input) },
    experiences: experienceRepository,
    trash: (path) => shell.trashItem(path),
    traces: modelTraces,
    forgetVectors: (ids) => semanticSearch.forgetEntries(ids),
    systemIdleSeconds: () => organizationLabIdle ? 86_400 : powerMonitor.getSystemIdleTime(),
    // A lab run on synthetic data (PARASELF_SMOKE and PARASELF_ORGANIZATION_LAB_IDLE both set) sees the machine idle and
    // looks every two seconds, so the background's first discovery and its giving way can be checked while a person
    // works at the machine. Never on without SMOKE.
    ...(organizationLabIdle ? { background: { tickMs: 2_000, quietMs: 3_000, spacingMs: 0 } } : {}),
    // The methodology flow's own candidates (complete reviews only): counted for the panel's hint, its bar untouched.
    methodologyCandidates: async () => new Set((await getMethodologySuggestionPartition()).active.flatMap((suggestion) => suggestion.sourceDecisionIds)).size,
    onChanged: () => {
      const revision = ++organizationRevision;
      void organization.attention().then(({ pending, automatic }) => {
        if (revision !== organizationRevision) return;
        organizationPending = pending;
        organizationAutomatic = automatic;
        controller?.refresh();
      }, () => undefined);
    },
  });
  void organization.recover().then(async () => {
    const revision = organizationRevision;
    const attention = await organization.attention();
    if (revision === organizationRevision) {
      organizationPending = attention.pending;
      organizationAutomatic = attention.automatic;
    }
    organization.start();
  }).catch((error: unknown) => console.error(`[paraself] organization recovery failed: ${error instanceof Error ? error.message : String(error)}`));
  const methodologyService = new MethodologyService({
    repository: methodologyRepository,
    relationRepository: methodologyRelationRepository,
    index,
    history: new MethodologyHistoryStore(paths.methodologyHistory),
    gateway: semanticGateway,
  });
  const assistantFeedback = new AssistantFeedbackStore(paths.assistantFeedback);
  const reminderNotices = reviewReminderNotifier(Notification, () => {
    windows.show();
    controller?.openSurface("decisions");
  });
  const reviewReminders = new ReviewReminderService({
    path: paths.reviewReminders,
    enabled: () => settings.reviewRemindersEnabled,
    listDue: (asOfDate, limit) =>
      index.listReviewDue(asOfDate, limit).map((decision) => ({
        id: decision.id,
        question: decision.question,
        reviewDueDate: decision.reviewDueDate ?? asOfDate,
      })),
    // A run started by a script posts nothing to Notification Center (IMP-133).
    notify: (notice) => {
      if (readParaselfEnvironment(process.env, "SMOKE") !== "1") reminderNotices.notify(notice);
    },
  });
  /** In-flight turns, so a cancel from the renderer can reach the right one. */
  const assistantTurns = new Map<string, AbortController>();
  /** Context summaries under way, by the id the form gave each, for its cancel to reach. */
  const contextSummaries = new Map<string, AbortController>();
  const prConnections = new PrConnections(join(app.getPath("userData"), "pr-connections.json"), providerCredentials);
  const localReviewNotices = new Map<string, ReturnType<typeof reviewReminderNotifier>>();
  const localReviewNotice = (id: string) => {
    let notifier = localReviewNotices.get(id);
    if (!notifier) {
      notifier = reviewReminderNotifier(Notification, () => {
        windows.show(); controller?.openSurface("local-review");
        for (const window of BrowserWindow.getAllWindows()) {
          const send = () => { if (!window.isDestroyed()) window.webContents.send("decision:local-review-navigate", id); };
          if (window.webContents.isLoadingMainFrame()) window.webContents.once("did-finish-load", send);
          else send();
        }
      }, `paraself-local-review-${id}`);
      localReviewNotices.set(id, notifier);
    }
    return notifier;
  };
  const localReview = new LocalReviewService(join(app.getPath("userData"), "local-review"), new LocalReviewGit(), prConnections, () => providerProfiles.load(), modelEnvironment, job => {
    if (readParaselfEnvironment(process.env, "SMOKE") === "1") return;
    localReviewNotice(job.id).notify(localReviewNotification(job));
  }, semanticGateway);
  await localReview.start();
  // 本地审阅 for agents, through the service the page uses: what a push needs stays the user's, in the App.
  const localReviewTools: LocalReviewToolSources = { state: () => localReview.state(), newSession: (id) => localReview.newSession(id), annotate: (input) => localReview.annotate(input),
    submit: (repositoryId, sessionId, profileId, worker) => localReview.submit(repositoryId, sessionId, profileId, worker), submitFromPr: (input) => localReview.submitFromPr(input),
    action: (input) => localReview.action(input), profiles: () => providerProfiles.load(), connections: () => prConnections.list() };
  if (readParaselfEnvironment(process.env, "SMOKE") !== "1") for (const job of localReview.state().jobs) void localReviewNotice(job.id).reattach();
  const prComments = new PrCommentCandidates({
    verdicts: new PrCommentVerdicts(join(app.getPath("userData"), "pr-comment-verdicts.json")),
    connections: prConnections,
    gateway: semanticGateway,
    recorded: (url) => index.findByCaptureSemanticKey(prCommentSemanticKey(url))?.id ?? null,
  });
  // Paraself's own rules plus the ones already written for code-meeseeks, same format; re-read on every PR load.
  const reviewRuleSources = [
    { source: "decision" as const, label: "Paraself", directory: join(app.getPath("userData"), "review-rules") },
    { source: "code-meeseeks" as const, label: "code-meeseeks", directory: join(homedir(), ".code-meeseeks", "agent", "rules") },
  ];
  const exampleReviewRule = [
    "---", "applies_to:", '  repo: "^example-repo$"', '  target_branch: "^(main|master)$"', "tools: [review]", "priority: 0", "enabled: false", "enforcement: advisory", "---", "",
    "# 示例规则（未启用）", "",
    "正文就是追加给 PR 评审的检查要求，例如：", "", "- 金额一律用整数分，不用浮点数。", "- 对外接口的错误必须带错误码。", "",
    "把 enabled 改为 true、调整 applies_to 后生效。applies_to 下的 project、repo、target_branch 都是正则，省略即不限制；priority 越大越靠前。", "",
    "enforcement 是依据这条规则的意见能压多重：advisory（默认）只作建议；blocking 时依据它的 P1 可以设为阻塞，评论里会完整引用规则原文，让作者知道要守什么。不认识的值按 advisory 处理。", "",
  ].join("\n");
  // The rules a PR is reviewed with, read again each time: the review page's, an agent's and a benchmark run's alike.
  const loadPrReviewRules = async (target: { project: string; repo: string; targetBranch: string | null }) => {
    const loaded = await Promise.all(reviewRuleSources.map(async (item) => ({ ...item, ...(await loadReviewRules(item.directory)) })));
    const matched = loaded
      .flatMap(({ source, rules }) => matchReviewRules(rules, target).map((rule) => ({ rule, source })))
      .sort((left, right) => right.rule.priority - left.rule.priority || left.rule.id.localeCompare(right.rule.id))
      .slice(0, MAX_MATCHED_REVIEW_RULES);
    return {
      instructions: combineReviewRules(matched.map(({ rule }) => rule)),
      rules: matched.map(({ rule, source }) => ({ id: rule.id.slice(0, 500), source, ...(rule.enforcement === "blocking" ? { enforcement: "blocking" as const, text: rule.instructions.slice(0, 2_000) } : {}) })),
      warnings: loaded.flatMap(({ label, warnings }) => warnings.map((warning) => `${label} ${warning}`)),
    };
  };
  const prReview = new PrReviewService({
    createClient: (input) => prConnections.client(input.connectionId),
    cacheDirectory: join(app.getPath("userData"), "pr-review-cache"),
    gateway: semanticGateway,
    searchDecisions: (query) => contextSearch.search(query),
    loadRules: loadPrReviewRules,
    onProgress: (event) => windows.send(IPC_CHANNELS.prReviewProgress, event),
  });
  const currentJournal = new CurrentJournal(journalRepository, decisionAmendments);
  const assistant = new DecisionAssistantService({
    gateway: semanticGateway,
    searchDecisions: (query) => contextSearch.search(query),
    searchNotes: (input) => obsidianSearch.search(input),
    searchJournal: (input) => currentJournal.list(input),
    // Not found is "deleted" to the assistant: a note it could not read just now (iCloud, busy) is no answer.
    readJournalEntry: (id) => currentJournal.find(id),
    readDocument: async (relativePath) =>
      readFile(await vault.resolveNotePath(relativePath), "utf8"),
    noteExists: (relativePath) => vault.noteExists(relativePath),
    // `windows` is created further down; the callback only runs once a turn is
    // under way, by which time it exists.
    onStep: (turnId, step) => {
      windows.send(IPC_CHANNELS.assistantProgress, { turnId, step });
    },
  });
  // The assistant's 接入新工具 conversation: probes and the client it connects go through the installer's queue.
  const onboardingInstall = (mode: "install" | "remove") =>
    (client: ClientDescriptor, path: string, checkTarget: NonNullable<Parameters<typeof installIntegrationsWithinTurn>[0]["checkTarget"]>) =>
      customClients.inTurn(() => (mode === "install" ? installIntegrationsWithinTurn : removeIntegrationsWithinTurn)({
        mode: "apply", bridgePath: bridgeExecutablePath(), platform: process.platform, clients: [client], paths: { [client.id]: path }, checkTarget,
      }));
  const onboarding = new ClientOnboardingService({
    gateway: semanticGateway,
    probesDirectory: paths.clientProbes,
    environment: () => process.env,
    protectedDirectories: () => [userDataResolution.path, dirname(paths.runtime), vaultPath],
    customClients: () => customClients.list(),
    install: onboardingInstall("install"),
    remove: onboardingInstall("remove"),
    connect: async (client) => {
      await loginPathReady;
      try {
        await customClients.save(client);
        const added = customClients.descriptors().filter((descriptor) => descriptor.id === client.id);
        const report = await customClients.inTurn(() => installIntegrationsWithinTurn({
          mode: "apply", bridgePath: bridgeExecutablePath(), platform: process.platform, clients: added, paths: clientHookPaths(added, process.env, homedir()), checkTarget,
        }));
        const target = report.targets.find((entry) => entry.client === client.id);
        return target?.status === "installed"
          ? { connected: true, detail: target.detail ?? "以后在这个工具里的对话会自动记录；它在「接入」页里可以编辑和删除。" }
          : { connected: false, detail: `已保存，但没有接上：${target?.detail ?? "原因未知"}；可以在「接入」页点「安装或修复」再试` };
      } catch (error) {
        return { connected: false, detail: error instanceof Error ? error.message : String(error) };
      } finally {
        integrationStatus = await detectedIntegrationStatus();
        controller?.refresh();
      }
    },
  });
  // A probe a quit or a crash left in a tool's hook file is taken out first thing: the first in the onboarding's lane,
  // asked for before anything else can be, so a probe asked for later waits until it is done. Its result is logged.
  const leftoverProbes = onboarding.cleanupLeftovers().then(({ failed }) => {
    if (failed.length > 0) console.error(`[paraself] leftover client probes not removed: ${failed.join("; ")}`);
  }, (error: unknown) => {
    console.error(`[paraself] leftover client probes not checked: ${error instanceof Error ? error.message : String(error)}`);
  });
  synchronizeVectors = () => semanticSearch.scheduleSynchronization();
  const methodologySuggestionPreferences =
    new MethodologySuggestionPreferenceStore(
      paths.methodologySuggestionPreferences,
    );
  const decisionConsultationMetrics = new DecisionConsultationMetricsStore(
    paths.decisionConsultationMetrics,
  );
  const decisionConsultationFeedback = new DecisionConsultationFeedbackService({
    metrics: decisionConsultationMetrics,
  });
  const manualFormDrafts = new ManualFormDraftStore(paths.manualFormDrafts);
  const prompts = new PromptLibraryStore(paths.prompts);
  const listMethodologySuggestionGroups = async () => {
    const records = await methodologyService.list();
    const evidence = reviewedDecisions().flatMap((decision) => {
      const item = toDecisionLibraryItem(decision);
      return item.outcomeReview === null
        ? []
        : [
            {
              id: item.id,
              project: item.project,
              question: item.question,
              selectedAnswer: item.selectedAnswer,
              outcomeVerdict: item.outcomeReview.verdict,
              outcomeLesson: item.outcomeReview.lesson,
              reviewedAt: item.outcomeReview.reviewedAt,
            },
          ];
    });
    return buildMethodologySuggestions(evidence, records, 12, await methodologySuggestionPreferences.deferredTest());
  };
  const getMethodologySuggestionPartition = async () =>
    methodologySuggestionPreferences.partition(
      await listMethodologySuggestionGroups(),
    );
  const pendingMethodologyImports = new Map<
    string,
    { createdAt: number; candidates: MethodologyImportCandidate[] }
  >();
  const prunePendingMethodologyImports = (): void => {
    const cutoff = Date.now() - 10 * 60 * 1_000;
    for (const [id, batch] of pendingMethodologyImports) {
      if (batch.createdAt < cutoff) pendingMethodologyImports.delete(id);
    }
  };
  const practiceAssetService = new PracticeAssetService({
    methodologies: methodologyRepository,
    assets: practiceAssetRepository,
    history: new PracticeAssetHistoryStore(paths.practiceAssetHistory),
    gateway: semanticGateway,
  });
  const methodologyMergeLifecycleService = new MethodologyMergeLifecycleService(
    {
      methodologies: methodologyRepository,
      relations: methodologyRelationRepository,
      assets: practiceAssetRepository,
      practiceAssets: practiceAssetService,
      decisions: () => reviewedDecisions(),
    },
  );
  const practicePublicationService = new PracticePublicationService({
    assets: practiceAssetRepository,
    stateRoot: paths.practicePublications,
    // Where the clients look, as their hooks and MCP are found (integrationPaths): with CODEX_HOME or
    // CLAUDE_CONFIG_DIR set, a skill went to ~/.codex or ~/.claude and the client never saw it.
    targetRoots: {
      get codex() { return join(dirname(integrationPaths().codex!), "skills"); },
      get "claude-code"() { return join(dirname(integrationPaths()["claude-code"]!), "skills"); },
    },
    validateBeforePublish: async (asset) => {
      const freshness = assessPracticeAssetFreshness(
        asset,
        await methodologyRepository.list(),
      );
      if (freshness.state !== "current") {
        throw new Error(
          freshness.state === "sources_updated"
            ? "来源原则已更新，请先重新生成，或编辑并保存资产后再发布。"
            : freshness.message,
        );
      }
    },
  });
  const decisionAnalyticsService = new DecisionAnalyticsService();
  const semanticCoordinator = new SemanticDecisionCoordinator({
    runtime,
    audit: captureAudit,
    classifier: semanticGateway,
    // On the default, a turn with Qwen 4B not downloaded, set to 2B or turned off reads as the rules alone do.
    modelEnabled: async () =>
      settings.captureClassifier === "models" ||
      (settings.captureClassifier === "local" && (await semanticGateway.onDeviceClassifierInstalled())),
  });
  let semanticRecognition: SemanticRecognitionStatus = {
    provider: "rules",
    providerLabel: "规则识别",
    availability: "loading",
    mode: "hybrid",
    processed7d: 0,
    high7d: 0,
    medium7d: 0,
    failures7d: 0,
    updatedAt: new Date().toISOString(),
  };
  let controller: AppController | undefined;
  methodologyMessageChanged = () => controller?.refresh();
  let semanticRefresh: Promise<void> | undefined;
  /*
   * A probe can take seconds — loading the local model is the slow part — and
   * what it answers is only true of the settings it started under. Dropping a
   * request that arrives mid-probe leaves the card naming an engine the reader
   * has already switched away from, so the request waits its turn instead.
   */
  let semanticRefreshPending = false;
  const refreshSemanticRecognition = (): void => {
    if (semanticRefresh !== undefined) {
      semanticRefreshPending = true;
      return;
    }
    semanticRefresh = (settings.captureClassifier !== "rules"
      ? semanticGateway.status()
      : semanticGateway.statusWithoutModel())
      .then((status) => {
        semanticRecognition = status;
        controller?.refresh();
      })
      .catch(() => undefined)
      .finally(() => {
        semanticRefresh = undefined;
        if (semanticRefreshPending) {
          semanticRefreshPending = false;
          refreshSemanticRecognition();
        }
      });
  };
  // Only the connection test asks it this round: no feature calls decide() (IMP-166).
  const decisionClient = new OpenRouterDecisionClient({
    profiles: providerProfiles,
    credentials: providerCredentials,
    traces: decisionCalls,
    transport: modelTransport,
  });
  const modelProviderService = new ModelProviderService({
    repository: providerProfiles,
    credentials: providerCredentials,
    credentialReferenceFactory: () => `provider:${randomUUID()}`,
    refresh: () => {
      semanticGateway.refresh();
      refreshSemanticRecognition();
      controller?.refresh();
    },
    // A decisions backend (jev) is tested with its own fixed question: it generates nothing for the gateway's probe.
    testProfile: async (profileId) =>
      (await providerProfiles.load()).find((profile) => profile.profileId === profileId)?.kind === "openrouter-decisions"
        ? decisionClient.test(profileId)
        : semanticGateway.testProfile(profileId),
  });
  const semanticPairInbox = new SemanticPairInbox({
    spool: semanticPairSpool,
    consume: async (pair) => {
      try {
        return await semanticCoordinator.process(pair);
      } finally {
        refreshSemanticRecognition();
      }
    },
  });
  await semanticPairInbox.recover().catch(() => undefined);
  // A burst of changes (a sync bringing hundreds of notes, a folder moved) is one refresh, not one each: each
  // pushed the whole snapshot to the window, and three hundred held it for seconds.
  let watcherRefresh: ReturnType<typeof setTimeout> | undefined;
  const refreshAfterChanges = (): void => {
    clearTimeout(watcherRefresh);
    watcherRefresh = setTimeout(() => controller?.refresh(), 250);
  };
  const watcher = new DecisionWatcher(
    repository,
    store.watchedIndex,
    // Edited in Obsidian into a note the index cannot read: the list keeps what it last read, and says so.
    (diagnostic) => {
      runtime.reportIndexIssue(`决策笔记 ${basename(diagnostic.path)} 无法读取（${noteProblem(diagnostic.message)}），列表里仍是它上次读到的内容；修正后可以重建索引。`);
      refreshAfterChanges();
    },
    refreshAfterChanges,
  );
  const reviewBenchmark = new ReviewBenchmarkService(paths.reviewBenchmark);
  const reviewHistory = new PrReviewHistoryStore(paths.prReviewHistory);
  // Reviews agents started, which this process runs to the end and records; with the one under way now, a record still
  // running is running, and any other was left behind by a process gone since.
  const agentReviews = new Set<string>();
  // A review started away from the page (an agent's, 自动预评审's): the PR read fresh, its record kept from the start.
  const reviewRunSources: PrReviewRunSources = { connections: () => prConnections.list(), models: () => assistant.listModels(), load: (input) => prReview.load(input),
    run: (input) => prReview.run(input), running: () => prReview.activeRun !== undefined, underWay: agentReviews, history: reviewHistory, changed: (ids) => windows.send(IPC_CHANNELS.prReviewHistoryChanged, { ids }) };
  // 自动预评审: off unless the user turns it on for a link; its day's reviews counted across restarts.
  const autoReviewUsage = new PrAutoReviewUsage(join(app.getPath("userData"), "pr-auto-review.json"));
  const autoReviewSources: PrAutoReviewSources = { connections: () => prConnections.list(), pullRequests: (query) => prConnections.pullRequests(query),
    head: async (connectionId, reference) => (await (await prConnections.client(connectionId)).get(reference)).source.commit, history: reviewHistory,
    running: () => prReview.activeRun !== undefined || agentReviews.size > 0, start: (request) => startReviewForAgent(request, reviewRunSources, { auto: true }), usage: autoReviewUsage };
  // Turned on, it takes its first look now rather than in half an hour.
  const settingsSources: PrReviewSettingsSources = { connections: () => prConnections.list(), models: () => assistant.listModels(), usage: autoReviewUsage,
    save: async (input) => { const saved = await prConnections.save(input); if (input.autoReview) void autoReviewPass(autoReviewSources).catch(() => undefined); return saved; } };
  // 评审质量: the user's records, and the link's merged PRs read from the platform, each once; 漏网 found among them.
  const reviewEscapes = new ReviewEscapeStore(join(app.getPath("userData"), "review-escapes.json"));
  // 晋升提议: proposed by handing the line to the local review as a comment on the repository's REVIEW.md.
  const promotionSources: ReviewPromotionSources = { connections: () => prConnections.list(), history: reviewHistory, escapes: reviewEscapes,
    ledger: new PromotionLedger(join(app.getPath("userData"), "review-promotions.json")),
    propose: async ({ connectionId, repository, path, body }) => {
      const local = await localReview.localPathFor(connectionId, repository);
      if (!local) throw new Error(`本地审阅里没有 ${repository} 的本地仓库：先在“本地审阅”里添加它`);
      const result = await recordLocalReviewJob({ localReviewToolsVersion: LOCAL_REVIEW_TOOLS_VERSION, repository: local, annotations: [{ path, line: 1, side: "new", body }] }, localReviewTools);
      if (result.status !== "submitted" || !result.jobId) throw new Error(result.reason ?? "本地审阅没有收下");
      return result.jobId;
    } };
  const qualitySources: ReviewQualitySources = { connections: () => prConnections.list(), history: reviewHistory, pullRequests: (query) => prConnections.pullRequests(query),
    facts: async (connectionId, reference) => (await prConnections.client(connectionId)).teamFacts(reference), cache: new PrTeamFactsCache(join(app.getPath("userData"), "pr-team-facts.json")), escapes: reviewEscapes,
    promotions: (connectionId) => promotionsFor(connectionId, promotionSources) };
  // 评测集进 App: the confirmed cases replayed from the local repository with the App's own review, one run at a time.
  const benchmarkRuns = new ReviewBenchmarkRuns({ directory: join(app.getPath("userData"), "review-benchmark-runs"),
    cases: (path, split, set) => reviewBenchmark.exportCases(path, split, set), models: () => assistant.listModels(),
    reviewer: (client, onCandidates) => new PrReviewService({ createClient: async () => client, gateway: semanticGateway, searchDecisions: (query) => contextSearch.search(query), loadRules: loadPrReviewRules, onCandidates }) });
  const benchmarkPageSources: ReviewBenchmarkPageSources = { runs: benchmarkRuns, benchmark: reviewBenchmark, repositories: async () => localReview.state().repositories.map((item) => item.snapshot.path),
    connections: () => prConnections.list(), history: reviewHistory, facts: qualitySources.cache, escapes: reviewEscapes,
    get: async (connectionId, reference) => (await prConnections.client(connectionId)).get(reference), localPath: (connectionId, repository) => localReview.localPathFor(connectionId, repository),
    models: () => assistant.listModels(), ledger: new SuggestionLedger(join(app.getPath("userData"), "review-benchmark-suggestions.json")) };
  const escapeSources: ReviewEscapeSources = { connections: () => prConnections.list(), store: reviewEscapes, history: reviewHistory,
    get: async (connectionId, reference) => (await prConnections.client(connectionId)).get(reference), localPath: (connectionId, repository) => localReview.localPathFor(connectionId, repository), benchmark: reviewBenchmark };
  // 发布后跟踪结果: each posted finding's thread read again, the page told of what moved.
  const outcomeSources: PrOutcomeSources = { client: (id) => prConnections.client(id), store: reviewHistory, changed: (ids) => windows.send(IPC_CHANNELS.prReviewHistoryChanged, { ids }) };
  // 作者回应: the platform's threads through the link's client, 转后续's todos in the user's lists.
  const responseSources: PrResponseSources = { client: (id) => prConnections.client(id), todos };
  const recordsForAgents = async () => {
    const list = await reviewHistory.list();
    const live = new Set([...agentReviews, prReview.activeRun]);
    return { ...list, entries: list.entries.map((entry) => entry.state === "running" && !live.has(entry.id) ? { ...entry, state: "interrupted" as const } : entry) };
  };
  // The description tools read the PR fresh from its platform, Paraself's records for what it knows of it.
  const descriptionSources: PrDescriptionToolSources = {
    connections: () => prConnections.list(), read: (request) => prConnections.description(request), update: (request) => prConnections.updateDescription(request),
    status: async (connectionId, reference) => (await prConnections.statuses({ connectionId, references: [reference] }, 4_000)).statuses[0]?.status ?? null,
    history: () => reviewHistory.list(), snapshot: (connectionId, reference) => prReview.peek({ connectionId, reference }),
  };
  const token = randomBytes(32).toString("base64url");
  const authenticatedServer = new LocalCaptureServer({
    queue: runtime.queue,
    onRequest: () => organization.noteForeground(),
    vaultPath,
    // Each capture that comes in takes in with it any its hook could only spool (the app too busy to answer).
    ingest: async (event) => {
      const receipt = await runtime.ingest(event);
      void runtime.recoverSpooled();
      return receipt;
    },
    ingestCandidate: (candidate) => runtime.ingestCandidate(candidate),
    ingestSemanticPair: async (pair) => {
      await semanticPairInbox.enqueue(pair);
    },
    recordJournalEntry: async (request) => {
      const result = await activeRecordService.create(request);
      // Said again, a preference or idea the user withdrew is back: it is the user's explicit word once more.
      if (result.status !== "created" && result.recordKind !== "decision") {
        await decisionAmendments.clearWithdrawal(result.recordKind === "preference" ? "preferences" : "ideas", result.recordId, request.sourceClient).catch(() => false);
      }
      if (result.status !== "created") return result;
      const duplicates = await possibleDuplicates((query) => contextSearch.search(query), request, result.recordId);
      return duplicates.length === 0 ? result : { ...result, possibleDuplicates: duplicates };
    },
    updateDecisionAmendment: (input) => decisionAmendment.update(input),
    recordHistoricalDecision: (request) => historicalDecisions.record(request),
    listHistoricalDecisions: (request) => historicalDecisions.list(request),
    getHistoricalDecision: (request) => historicalDecisions.get(request),
    updateHistoricalDecision: (request) => historicalDecisions.update(request),
    openHistoricalDecision: (request) => openHistoricalDecision(request),
    listTodos: (query) => todos.list(query),
    recordTodos: (request) => todos.record(request),
    updateTodoItem: (request, context) => todos.updateItem(request, context),
    recordReviewBenchmarkCases: (request) => reviewBenchmark.record(request),
    listReviewBenchmarkCases: (request) => reviewBenchmark.list(request),
    getReviewBenchmarkCase: (request) => reviewBenchmark.get(request),
    updateReviewBenchmarkCase: (request) => reviewBenchmark.update(request),
    listPrsForAgent: (query) => listPrsForAgent(query, { connections: () => prConnections.list(), pullRequests: (listing) => prConnections.pullRequests(listing), history: recordsForAgents,
      // Within the bridge's nine seconds for the whole list: what is not read in four is left out.
      statuses: async (connectionId, references) => new Map((await prConnections.statuses({ connectionId, references }, 4_000)).statuses.flatMap((item) => item.status ? [[item.reference, item.status] as const] : [])) }),
    listPrReviewRecords: async (query) => queryRecords(await recordsForAgents(), query),
    getPrReviewRecord: async ({ id }) => {
      const list = await recordsForAgents();
      const entry = list.entries.find((item) => item.id === id);
      return { prReviewToolsVersion: 1, record: entry === undefined ? null : recordView(list.entries, entry) };
    },
    // The review page holds the records it shows: told which changed, it reads them again rather than save over them.
    updatePrReviewFinding: (request) => updateFinding(reviewHistory, request, (ids) => windows.send(IPC_CHANNELS.prReviewHistoryChanged, { ids })),
    prDescriptionDraft: (query) => descriptionDraftForAgent(query, descriptionSources),
    runPrReview: (request) => startReviewForAgent(request, reviewRunSources),
    getPrReviewSettings: (query) => reviewSettingsFor(query, settingsSources),
    updatePrReviewSettings: (request) => updateReviewSettings(request, settingsSources),
    getReviewQuality: (query) => reviewQualityFor(query, qualitySources),
    updateReviewRule: (request) => setReviewRuleEnabled(reviewRuleSources[0]!.directory, request.rule, request.enabled),
    recordReviewEscape: (request) => recordEscape(request, escapeSources),
    listReviewEscapes: (query) => escapesFor(query, escapeSources),
    updateReviewEscape: (request) => updateEscape(request, escapeSources),
    runReviewBenchmark: ({ reviewBenchmarkVersion: _, ...request }) => benchmarkRuns.start(request),
    listReviewBenchmarkRuns: (query) => benchmarkRuns.summaries(query.repositoryPath),
    getReviewBenchmarkRun: (query) => benchmarkRuns.result(query.id, query.compareTo),
    listRulePromotionCandidates: (query) => promotionsForAgent(query, promotionSources),
    updatePr: (request) => updatePrForAgent(request, descriptionSources),
    listPrComments: (query) => commentsForAgent(query, { ...responseSources, connections: () => prConnections.list(), exclusive: (operation) => prConnections.exclusive(operation) }),
    updatePrComment: (request) => updateCommentForAgent(request, { ...responseSources, connections: () => prConnections.list(), exclusive: (operation) => prConnections.exclusive(operation) }),
    recordLocalReviewJob: (request) => recordLocalReviewJob(request, localReviewTools),
    listLocalReviewJobs: async (query) => listLocalReviewJobs(query, localReviewTools),
    getLocalReviewJob: async (request) => getLocalReviewJob(request, localReviewTools),
    updateLocalReviewJob: (request) => updateLocalReviewJob(request, localReviewTools),
    recordPrComments: (request) => recordComments(reviewHistory, { connections: () => prConnections.list(), publishComment: (comment) => prConnections.publishComment(comment),
      comments: async (connectionId, reference) => (await (await prConnections.client(connectionId)).commentPages(reference, 10)).comments }, request,
      (ids) => windows.send(IPC_CHANNELS.prReviewHistoryChanged, { ids })),
    prepareDecisionHandoff: (input) => decisionHandoff.prepare(input),
    openDecisionSource: (input) => decisionHandoff.openSource(input),
    searchObsidianNotes: (input) => searchObsidianNotes(obsidianSearch, input),
    readObsidianNote: (input) => readObsidianNote(obsidianSearch, input),
    saveDecisionContextFeedback: (input) => decisionFeedback.save(input),
    getDecisionContextFeedback: (input) => decisionFeedback.list(input),
    searchContext: (query) => contextSearch.search(query),
    updateContextScope: (input) => decisionContext.updateScope(input),
    updateContextRelation: (input) => decisionContext.updateRelation(input),
    updateDecisionOutcome: (input) => new DecisionOutcomeService(store, vaultPath, (indexed) => {
      if (!indexed) runtime.reportIndexIssue("结果已写入 Markdown，但决策索引更新失败；请在设置中重建决策索引。");
      controller?.refresh();
    }, undefined, (recordId) => decisionContext.search(decisionContextQuerySchema.parse({ source: "decisions", recordId })).then((found) => found.results[0] ?? null)).update(input),
    consult: async (request) => {
      const startedAt = Date.now();
      const [stored, relations] = await Promise.all([
        methodologyService.list(),
        methodologyService.listRelations(),
      ]);
      // As this list left it: read after the recall below, another list meanwhile (the page's) could have changed it.
      const principlesUnread = unreadableNotes.principles.length > 0;
      // As the app shows them: confidence from the evidence still there, and only that evidence counted.
      // Stored when written, it went on saying "high" to an agent after a source decision was deleted.
      const cited = citedDecisions(index, stored);
      const methodologies = stored.map((record) => {
        // Confidence and the evidence still there are all it uses: compared with every other principle as well,
        // a library of a thousand stalled the app for half a minute and the agent was told it was unavailable.
        const item = toMethodologyItem(record, cited, []);
        const present = new Set(item.sourceDecisions.map((decision) => decision.id));
        return {
          ...record,
          confidence: item.quality.recommendedConfidence,
          sourceDecisionIds: record.sourceDecisionIds.filter((id) => present.has(id)),
        };
      });
      // Within a second and a half, or by the principles' words alone (undefined, to buildDecisionConsultation): waiting
      // on a sync or a model loading, the bridge's five seconds ran out and the agent heard nothing at all.
      const recalled = await semanticSearch
        .recallMethodologies(
          methodologies,
          {
            question: request.question,
            selectedAnswer: null,
            optionLabels: request.options.map((option) => option.label),
            context: request.context,
          },
          3,
          1_500,
        )
        .catch(() => undefined);
      // The reader's own preferences and ideas, recalled beside the
      // principles. A failure here must not cost the caller its principles,
      // which are the part it asked for; it is said (null), not taken for none.
      // All of them: the 200 last updated left out an older preference that still stands as soon as newer
      // ideas (or an archiving sweep, which updates them) came in on top of it.
      // Those the user withdrew left out, what was added to the rest at their end; unread, as they are.
      const journal = await currentJournal.list({ everything: true }).catch(() => null);
      const response = buildDecisionConsultation(
        request,
        methodologies,
        recalled,
        journal?.entries ?? null,
        // Said to the pages by these reads (a note in no list): told only them, an agent heard the reader had adopted
        // no principle, and a hard constraint in a preference note iCloud held went without a word.
        { principles: principlesUnread, journal: (journal?.diagnostics.length ?? 0) > 0 },
      );
      // Every client's but a test's: the pages count consultations by client.
      const fromClient = request.sourceClient !== "test";
      if (fromClient) {
        void decisionConsultationMetrics
          .record({
            sourceClient: request.sourceClient,
            response,
            durationMs: Math.max(0, Date.now() - startedAt),
            recordedAt: new Date().toISOString(),
          })
          .catch(() => undefined);
      }
      return fromClient
        ? decisionConsultationFeedback.issue(response, request.sourceClient)
        : response;
    },
    submitConsultationFeedback: (feedback) =>
      decisionConsultationFeedback.submit(feedback),
    token,
    smokeMode: readParaselfEnvironment(process.env, "SMOKE") === "1",
    smokeShutdown: () => app.quit(),
  });
  const windows = new WindowManager({
    // Opaque, without vibrancy or Liquid Glass (IMP-139): a transparent window, or a material, had WindowServer
    // recompose it all the time, even with other windows covering it. The page paints over this colour; it shows
    // only before the page does, and while the window is resized, so it follows the theme as the page does.
    createWindow: (options: BrowserWindowOptionsLike) => {
      const background = (): string => (nativeTheme.shouldUseDarkColors ? "#0f1115" : "#eef0f3");
      const browserWindow = new BrowserWindow({
        ...(options as BrowserWindowConstructorOptions),
        backgroundColor: background(),
      });
      const followTheme = (): void => browserWindow.setBackgroundColor(background());
      nativeTheme.on("updated", followTheme);
      browserWindow.once("closed", () => nativeTheme.off("updated", followTheme));
      return adaptWindow(browserWindow, process.platform === "darwin" ? () => app.isHidden() : undefined);
    },
    screen,
    preloadPath: join(__dirname, "preload.cjs"),
    renderer: rendererLocation(),
    onCloseRequested: () => controller?.closePrimarySurface(),
    // A run started by a script (smoke, the lab runs, the visual fixtures) came up maximized in front of the reader,
    // focus taken, every few seconds (IMP-133): kept off screen, or shown behind when asked to be seen.
    presentation: readParaselfEnvironment(process.env, "SMOKE") !== "1"
      ? "visible"
      : readParaselfEnvironment(process.env, "SMOKE_SHOW_WINDOW") === "1" ? "inactive" : "hidden",
    // Its review or turn has no one to answer: stopped, a review begun from the page reloaded is not refused as
    // "已有评审正在运行", and no model is called for an answer nobody will see.
    onPageLeft: () => {
      prReview.cancel();
      for (const turn of assistantTurns.values()) turn.abort();
    },
    // Not modal to the main process (showErrorBox is): captures go on being taken in while it is up.
    onRendererGone: (reason) => {
      void dialog.showMessageBox({
        type: "error",
        message: "Paraself 的窗口无法显示",
        detail: `显示窗口的进程在一分钟内反复意外退出（${reason}），已停止自动重新加载。捕获仍会照常记下；再次打开 Paraself 时会重新加载一次，仍然空白请退出后重启。`,
      });
    },
  });
  // Reminders left in Notification Center by a run before this one: their clicks open the decisions again.
  if (process.platform === "darwin") void reminderNotices.reattach();
  let updateTray = (
    _pendingCount: number,
    _reviewDueCount: number,
  ): void => undefined;
  controller = new AppController({
    queue: runtime.queue,
    candidates: runtime.candidates,
    server: authenticatedServer,
    watcher: {
      start: async () => {
        watcher.start();
      },
      close: () => {
        todoNotes.close();
        historicalDecisionNotes.close();
        historicalDecisions.close();
        return watcher.close();
      },
    },
    index,
    windows,
    runtimeFile: paths.runtime,
    token,
    writeRuntime: writeRuntimeDescriptor,
    onRuntimeUnwritable: (error) => {
      runtime.reportRecoveryIssue(`本机服务信息写不进数据目录（${error instanceof Error ? error.message : String(error)}），智能体暂时连不上 Paraself。清出磁盘空间或修好权限后重启 Paraself。`);
    },
    removeRuntime: removeRuntimeDescriptor,
    vaultPath,
    health: () => ({
      ...runtime.health(),
      ...(journalMessage === undefined ? {} : { journalMessage }),
      ...(methodologyMessage === undefined ? {} : { methodologyMessage }),
    }),
    dashboard: () => ({
      ...readDashboardSnapshot(index, new Date(), () => {
        runtime.reportIndexIssue(
          "决策索引读取失败；请在设置中重建决策索引。",
        );
      }),
      journalRevision,
      todoRevision,
      historicalDecisionRevision,
      organizationRevision,
      organizationPending,
      organizationAutomatic,
    }),
    integrationStatus: () => integrationStatus,
    clients: () => [...BUILT_IN_CLIENTS.map(clientSummary), ...catalogSummaries(), ...customClients.summaries()],
    pendingRationales: () => runtime.pendingRationales(),
    pendingRationaleCount: () => runtime.pendingRationaleCount(),
    semanticRecognition: () => semanticRecognition,
    modelProxyUrl: () => settings.modelProxyUrl ?? null,
    modelProxyEnvironmentOverride: () => process.env.MODEL_PROXY_URL !== undefined,
    modelTraceContentEnabled: () => settings.modelTraceContentEnabled,
    reviewRemindersEnabled: () => settings.reviewRemindersEnabled,
    localCredentialsEnabled: () => settings.localCredentialsEnabled,
    captureClassifier: () => settings.captureClassifier,
    theme: () => settings.theme,
    accent: () => settings.accent,
    onSnapshot: (snapshot) => {
      // The rationale asked for now and those waiting behind it are to do as well: "暂无待处理" was wrong.
      updateTray(pendingWorkTotal(snapshot), snapshot.dashboard.organizationAutomatic ? 0 : snapshot.dashboard.reviewAttention);
      void reviewReminders.check();
    },
  });
  openDesktopApplication = () => {
    windows.show();
    controller?.reopen();
  };
  // The login shell answers a moment after startup, perhaps with CLAUDE_CONFIG_DIR or CODEX_HOME: the
  // client cards then say what the files those clients really read hold.
  void loginPathReady.then(async () => {
    integrationStatus = await detectedIntegrationStatus();
    controller?.refresh();
    // Brought up to this version's bundled skills, in the clients already connected and nowhere else. Not in a smoke
    // or lab run: those keep the reader's HOME, and their skills folders are the reader's own.
    if (readParaselfEnvironment(process.env, "SMOKE") === "1") return;
    const connected = SKILL_CLIENTS.filter((client) => integrationStatus[client] === "installed");
    if (connected.length === 0) return;
    try {
      const reports = await customClients.inTurn(() => syncBundledSkills({ source: bundledSkillsPath(), clients: connected, mode: "apply" }));
      noteSkills(reports, connected);
      for (const report of reports) {
        if (report.status !== "unchanged") console.error(`[paraself] bundled skill ${report.skill} for ${report.client}: ${report.status}${report.detail === undefined ? "" : ` (${report.detail})`}`);
      }
    } catch (error) {
      for (const client of connected) skillsBehind.add(client);
      console.error(`[paraself] bundled skills not synced: ${error instanceof Error ? error.message : String(error)}`);
    }
    integrationStatus = await detectedIntegrationStatus();
    controller?.refresh();
  });
  refreshSemanticRecognition();

  const misrecognitions = new MisrecognitionReceiptStore(paths.misrecognitionReceipts);
  const decisionDeletion = new DecisionDeletionService({
    repository, store, local: localDecisions, relations: decisionRelations,
    methodologies: async () => {
      const principles = await methodologyService.list();
      if (unreadableNotes.principles.length > 0) throw new Error("部分原则暂时读不出来，无法完整核对删除影响，请先检查知识库。");
      return principles;
    },
    trashItem: (path) => shell.trashItem(path),
    removeVector: (id) => semanticSearch.removeDecision(id),
    deferred: { holds: (id) => runtime.holdsDeferredRationale(id), discard: (id) => runtime.discardDeferredRationale(id) },
    misrecognitions,
    batchSiblings: (batchId, id) => index.countBatch(batchId, id) + localDecisions.countBatch(batchId, id),
    organization,
    onDeleted: (warnings) => {
      if (warnings.length > 0) runtime.reportIndexIssue(warnings.join(" "));
      controller.refresh();
    },
  });

  // Declared before the IPC that reads it: a page's call may come before the rest of the start has run.
  let shutdownStarted = false;
  registerDecisionIpc({
    ipcMain,
    quitting: () => shutdownStarted,
    queue: runtime.queue,
    candidates: runtime.candidates,
    operations: {
      listHistoricalDecisions: (query) => historicalDecisions.list({ ...query, version: HISTORICAL_DECISION_VERSION }),
      getHistoricalDecision: (id) => historicalDecisions.get({ version: HISTORICAL_DECISION_VERSION, id }),
      recordHistoricalDecision: (input) => historicalDecisions.record({ ...input, version: HISTORICAL_DECISION_VERSION, sourceClient: null }),
      updateHistoricalDecision: (input) => historicalDecisions.update({ ...input, version: HISTORICAL_DECISION_VERSION, sourceClient: null }),
      rebuildHistoricalDecisionIndex: () => historicalDecisions.rebuildIndex(),
      openHistoricalDecision: (target) => openHistoricalDecision(target),
      listTodoLists: (query) => todos.list(query),
      recordTodoList: (input) => todos.recordManual(input),
      changeTodoItem: (input) => todos.changeItem(input),
      updateTodoList: (input) => todos.updateList(input),
      moveTodoItem: (input) => todos.moveItem(input),
      changeTodoItems: (input) => todos.changeItems(input),
      deleteTodoItems: (input) => todos.deleteItems(input),
      moveTodoItemsToList: (input) => todos.moveItemsToList(input),
      deleteTodoList: (input) => todos.deleteList(input),
      getOrganization: (input) => organization.snapshot(input),
      runOrganization: (input) => organization.run(input),
      controlOrganizationRun: (input) => organization.control(input),
      decideSuggestion: (input) => organization.decide(input),
      adoptSuggestions: (input) => organization.adoptMany(input),
      saveSuggestionDraft: (input) => organization.saveDraft(input),
      undoSuggestion: (input) => organization.undo(input),
      regenerateSuggestion: (input) => organization.regenerate(input),
      setOrganizationSettings: (input) => organization.setSettings(input),
      previewOrganizationForget: (input) => organization.previewForget(input),
      forgetOrganizationSource: (input) => organization.forget(input),
      getTodoAnnotations: (input) => organization.annotations(input),
      getLocalReviewState: async () => localReview.state(),
      chooseLocalReviewRepository: async (input) => {
        const selection = await dialog.showOpenDialog({ title: "选择本地审阅工程", properties: ["openDirectory"] });
        if (selection.canceled || !selection.filePaths[0]) return null;
        return localReview.register(selection.filePaths[0], input.baseBranch);
      },
      startLocalReviewSession: input => localReview.newSession(input.repositoryId, input.baseBranch),
      clearLocalReviewDependencies: input => localReview.clearDependencies(input.repositoryId),
      saveLocalReviewSettings: input => localReview.saveSettings(input.repositoryId, input.settings),
      loadLocalReviewFiles: input => localReview.files(input.repositoryId, input.sessionId),
      readLocalReviewFile: input => localReview.read(input.repositoryId, input.sessionId, input.path, input.side),
      saveLocalReviewAnnotation: input => localReview.annotate(input),
      removeLocalReviewAnnotation: input => localReview.removeAnnotation(input.repositoryId, input.sessionId, input.annotationId),
      submitLocalReview: input => localReview.submit(input.repositoryId, input.sessionId, input.profileId, input.worker),
      submitLocalReviewFromPr: input => localReview.submitFromPr(input),
      actOnLocalReview: input => localReview.action(input),
      sendLocalReviewMessage: input => localReview.sendMessage(input),
      executeLocalReviewPlan: input => localReview.execute(input),
      markLocalReviewRead: input => localReview.markRead(input),
      actOnLocalReviewConversation: input => localReview.conversationAction(input),
      getSnapshot: () => controller.snapshot(),
      openCandidateReview: () => controller.openCandidateReview(),
      closeCandidateReview: () => controller.closeCandidateReview(),
      confirmCandidate: (candidateId) =>
        controller.confirmCandidate(candidateId),
      ignoreCandidate: (candidateId) => controller.ignoreCandidate(candidateId),
      skipCandidate: (candidateId) => controller.skipCandidate(candidateId),
      retryCandidate: () => controller.retryCandidate(),
      openSurface: (surface) => controller.openSurface(surface),
      closePrimarySurface: () => controller.closePrimarySurface(),
      // The library query caps a project at 500 characters; a longer one could not be
      // filtered on, so it is left out rather than failing the whole list.
      listDecisionProjects: async () => index.listProjects().filter(({ project }) => project.length <= 500),
      listDecisions: async (query) => {
        // What labels the decisions, not what they are: a vault that is not there (its disk ejected) made principles
        // unreadable, and with them the whole list, though the index still held every decision.
        const methodologies = await methodologyService.list().catch(() => []);
        const indexedQuery = {
          ...query,
          asOfDate: localCalendarDate(new Date()),
        };
        const answers = await decisionAnswers.read()
          .catch(() => new Map<string, SelectedAnswer>());
        const lexical = queryDecisionsWithReplies(index, indexedQuery, answers);
        if (
          query.query.trim().length === 0 ||
          query.searchMode !== "semantic"
        ) {
          return lexical.map((decision) =>
            toDecisionLibraryItem(decision, methodologies, undefined, answers.get(decision.id)),
          );
        }
        // Every decision the filters let through: only the newest 200 were ranked by meaning, and an
        // older one could not be found that way at all, nor by quick jump's semantic fallback.
        const candidates = index.queryDecisionStamps({
          ...indexedQuery,
          query: "",
          everything: true,
        });
        const matches = await semanticSearch
          .searchDecisions({
            query: query.query,
            candidates,
            load: (ids) => index.findDecisions(ids),
            lexical,
            limit: query.limit ?? 100,
          })
          .catch(() =>
            lexical.map((decision) => ({
              decision,
              matchKind: "keyword" as const,
              relevance: 1,
            })),
          );
        return matches.map((match) =>
          toDecisionLibraryItem(
            match.decision,
            methodologies,
            match.matchKind,
            answers.get(match.decision.id),
          ),
        );
      },
      createProactiveRecord: async (input) => {
        const result = await activeRecordService.create(
          proactiveRecordRequestSchema.parse({
            ...input,
            recordVersion: PROACTIVE_RECORD_VERSION,
            requestId: `renderer-${randomUUID()}`,
            sourceClient: "manual",
          }),
        );
        controller.refresh();
        return result;
      },
      summarizeRecordContext: async (input) => {
        const summary = new AbortController();
        contextSummaries.set(input.requestId, summary);
        try {
          return await summarizeRecordContext(semanticGateway, input, summary.signal);
        } finally {
          contextSummaries.delete(input.requestId);
        }
      },
      cancelRecordContextSummary: async (requestId) => {
        contextSummaries.get(requestId)?.abort();
      },
      // What was added to an entry is searched with it: the page's search finds the words an agent put there.
      listJournalEntries: async (query) => {
        const found = await activeRecordService.listJournalEntries(query);
        const words = (query.query ?? "").normalize("NFKC").toLowerCase().split(/\s+/u).filter(Boolean);
        if (words.length === 0) return found;
        const { records } = await decisionAmendments.scan().catch(() => ({ records: new Map<string, StoredAmendment>() }));
        if (records.size === 0) return found;
        const { query: _query, limit: _limit, ...rest } = query;
        const have = new Set(found.map((entry) => entry.id));
        const added = (await activeRecordService.listJournalEntries({ ...rest, everything: true })).filter((entry) => {
          if (have.has(entry.id)) return false;
          const record = records.get(amendmentKey(entry.kind === "preference" ? "preferences" : "ideas", entry.id));
          const text = (record === undefined ? "" : amendedText(record, journalContentHash(entry))).normalize("NFKC").toLowerCase();
          return text !== "" && words.every((word) => text.includes(word));
        });
        return [...found, ...added];
      },
      listDecisionAmendments: () => amendmentOverview(decisionAmendments, async () => {
        const hashes = new Map<string, string>();
        for (const entry of (await activeRecordService.scanJournalEntries({ everything: true })).entries) hashes.set(amendmentKey(entry.kind === "preference" ? "preferences" : "ideas", entry.id), journalContentHash(entry));
        for (const document of (await contextRepository.scan()).documents) if (document.source !== "principles" && document.contentHash !== undefined) hashes.set(amendmentKey(document.source, document.id), document.contentHash);
        return hashes;
      }),
      updateDecisionAmendment: async (request) => {
        const result = await decisionAmendment.update(request);
        if (result.status === "saved") controller.refresh();
        return result;
      },
      reviseJournalEntry: async (id, input) => {
        const entry = await activeRecordService.reviseJournalEntry(id, input);
        controller.refresh();
        return entry;
      },
      getObsidianSearchStatus: async () => obsidianSearch.status(),
      searchObsidian: (input) => obsidianSearch.search(input),
      rebuildObsidianSearch: () => obsidianSearch.rebuild(),
      openObsidianNote: (relativePath) => obsidianSearch.openNote(relativePath),
      openVaultDocument: async (relativePath) => {
        // resolveNotePath is the security boundary: it rejects absolute paths,
        // traversal, symlinks and anything that is not a regular .md file
        // inside the vault. The path itself always comes from our own search
        // results, never from a model.
        const absolute = await vault.resolveNotePath(relativePath);
        const uri = new URL("obsidian://open");
        uri.searchParams.set("path", absolute);
        await shell.openExternal(uri.toString().replace(/\+/gu, "%20"));
      },
      checkAssistantSource: (source) => assistant.checkSource(source),
      searchAssistantSources: (input) => assistant.searchSources(input),
      listPrConnections: () => prConnections.list(),
      savePrConnection: async (input) => {
        const before = await prConnections.list();
        const saved = await prConnections.save(input);
        // A new token (which any change of site requires) retires what the old one read, and its client.
        if (input.id !== undefined && input.token !== undefined && input.token.length > 0) await prReview.forget(input.id);
        // What its comments were read from starts over or carries on; one reading them takes a look now.
        const current = saved.find((item) => input.id === undefined ? !before.some((old) => old.id === item.id) : item.id === input.id);
        if (current) await prComments.linkSaved(before.find((item) => item.id === current.id), current, Boolean(input.token));
        if (input.recognition) void prComments.follow().catch(() => undefined);
        if (input.autoReview) void autoReviewPass(autoReviewSources).catch(() => undefined);
        return saved;
      },
      removePrConnection: async (id) => {
        const remaining = await prConnections.remove(id);
        // Its cached PR diffs go with it, and what it last saw of its PRs.
        await prReview.forget(id);
        await prComments.linkRemoved(id);
        return remaining;
      },
      checkPrConnection: async (id) => ({ account: await prConnections.account(id) }),
      listPullRequests: (input) => prConnections.pullRequests(input),
      loadPrReviewFile: (input) => prReview.loadFile(input),
      getPrActionContext: (input) => prConnections.actionContext(input),
      performPrAction: (input) => prConnections.performAction(input),
      publishPrReviewComment: (input) => prConnections.publishComment(input),
      publishPrGeneralComment: (input) => prConnections.publishGeneralComment(input),
      listPrDiscussion: (input) => prComments.discussion(input),
      recognizePrDiscussion: (input) => prComments.recognize(input),
      dismissPrCommentCandidate: (url) => prComments.dismiss(url),
      listPrCommentCandidates: () => prComments.candidates(),
      openPrLink: async (url) => { await shell.openExternal(await prConnections.webLink(url)); },
      openPr: async (input) => { await shell.openExternal(await prConnections.prWebUrl(input)); },
      reevaluatePrReviewFinding: (input) => prReview.reevaluate(input),
      openReviewRulesDirectory: async () => {
        const directory = reviewRuleSources[0]!.directory;
        await mkdir(directory, { recursive: true });
        // An empty folder explains nothing; start it with a disabled example, as code-meeseeks does.
        // "Empty" as the loader sees it: rules may sit in subfolders, hidden entries do not count.
        const hasRules = (await readdir(directory, { recursive: true })).some((name) => name.endsWith(".md") && !name.split(/[\\/]/u).some((part) => part.startsWith(".")));
        if (!hasRules) {
          await writeFile(join(directory, "example.md"), exampleReviewRule, { flag: "wx" }).catch((error: unknown) => {
            if (!(error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
          });
        }
        if (await shell.openPath(directory)) throw new Error("无法打开评审规则目录。");
      },
      loadPrReviewDiff: (input) => prReview.loadDiff(input),
      loadPrReview: (input) => prReview.load(input),
      peekPrReview: (input) => prReview.peek(input),
      prefetchPrReviews: (input) => prReview.prefetch(input),
      listPrReviewHistory: async () => ({ ...(await reviewHistory.list()), running: [...agentReviews] }),
      savePrReviewHistory: (input) => reviewHistory.save(input),
      listPrReviewStatuses: (input) => prConnections.statuses(input),
      getPrDescription: (input) => prConnections.description(input),
      updatePrDescription: (input) => prConnections.updateDescription(input),
      listPrReceivedComments: (input) => receivedComments(input, responseSources),
      respondToPrComment: (input) => prConnections.exclusive(() => respondToComment(input, responseSources)),
      getPrReviewSettings: () => reviewSettingsFor({}, settingsSources),
      getReviewQuality: ({ connectionId }) => reviewQualityFor({ connection: connectionId }, qualitySources),
      updateReviewRule: ({ rule, enabled }) => setReviewRuleEnabled(reviewRuleSources[0]!.directory, rule, enabled),
      updateReviewEscape: (input) => updateEscape(input, escapeSources),
      reviewBenchmarkPage: (request) => benchmarkPage(request, benchmarkPageSources),
      actOnReviewPromotion: (action) => actOnPromotion(action, promotionSources),
      readPrReviewOutcomes: async ({ id }) => {
        const entry = (await reviewHistory.list()).entries.find((item) => item.id === id);
        const next = entry ? await readOutcomes(entry, outcomeSources) : null;
        if (next) { await reviewHistory.save({ entries: [next], removed: [] }); outcomeSources.changed([id]); }
        return { changed: next !== null };
      },
      runPrReview: (input) => prReview.run(input),
      followUpPrReview: (input) => prReview.followUp(input),
      cancelPrReview: async (id) => prReview.cancel(id),
      runAssistantTurn: async (input) => {
        const turnId = input.turnId;
        if (turnId === undefined) return assistant.runTurn(input);
        const controller = new AbortController();
        assistantTurns.set(turnId, controller);
        try {
          return await assistant.runTurn(input, controller.signal);
        } finally {
          assistantTurns.delete(turnId);
        }
      },
      sendOnboarding: (input) => onboarding.handle(input),
      cancelAssistantTurn: async (turnId) => {
        assistantTurns.get(turnId)?.abort();
      },
      saveAssistantFeedback: (input) => assistantFeedback.record(input),
      getAssistantFeedbackSummary: () => assistantFeedback.summary(),
      exportAssistantConversation: async ({ suggestedName, markdown }) => {
        // Outside the vault by default: a conversation is not a record, and
        // filing it beside the decisions would make it look like one.
        const selection = await dialog.showSaveDialog({
          title: "导出对话",
          buttonLabel: "导出",
          defaultPath: suggestedName,
          filters: [{ name: "Markdown", extensions: ["md"] }],
        });
        if (selection.canceled || selection.filePath === undefined) {
          return { status: "cancelled" as const };
        }
        try {
          await atomicWrite(selection.filePath, markdown);
          return { status: "saved" as const, path: selection.filePath };
        } catch {
          return { status: "failed" as const };
        }
      },
      listAssistantModels: () => assistant.listModels(),
      saveDecisionContextFeedback: (input) => decisionFeedback.save(input),
      getDecisionContextFeedback: (input) => decisionFeedback.list(input),
      searchDecisionContext: (input) => decisionContext.search(input),
      updateDecisionScope: (input) => decisionContext.updateScope(input),
      updateDecisionRelation: (input) => decisionContext.updateRelation(input),
      openDecisionSource: (input) => decisionHandoff.openSource(input),
      prepareDecisionHandoff: (input) => decisionHandoff.prepare(input),
      updateDecisionExpectedOutcome: async (decisionId, expectedOutcome, basis) => {
        const result = await store.updateExpectedOutcome(
          decisionId,
          expectedOutcome,
          basis,
        );
        if (!result.indexed) {
          runtime.reportIndexIssue(
            "预期结果已写入 Markdown，但决策索引更新失败；请在设置中重建决策索引。",
          );
        }
        controller.refresh();
      },
      updateDecisionOutcome: async (decisionId, outcome, basis) => {
        const result = await store.updateOutcome(decisionId, outcome, basis);
        if (!result.indexed) {
          runtime.reportIndexIssue(
            "结果已写入 Markdown，但决策索引更新失败；请在设置中重建决策索引。",
          );
        }
        controller.refresh();
      },
      updateDecisionReviewDueDate: async (decisionId, reviewDueDate) => {
        const result = await store.updateReviewDueDate(
          decisionId,
          reviewDueDate,
        );
        if (!result.indexed) {
          runtime.reportIndexIssue(
            "复盘日期已写入 Markdown，但决策索引更新失败；请在设置中重建决策索引。",
          );
        }
        controller.refresh();
      },
      updateDecisionReview: async (decisionId, input, basis) => {
        const reviewedAt = new Date().toISOString();
        const result = await store.updateOutcomeReview(decisionId, {
          ...input,
          reviewedAt,
        }, basis);
        if (!result.indexed) {
          runtime.reportIndexIssue(
            "复盘已写入 Markdown，但决策索引更新失败；请在设置中重建决策索引。",
          );
        }
        controller.refresh();
        return { ...input, reviewedAt };
      },
      updateDecisionAppliedPrinciples: async (decisionId, principleIds) => {
        const current = index.findDecisions([decisionId])[0];
        if (current === undefined) {
          throw new Error("决策记录不存在，请重建索引后重试。");
        }
        const methodologies = await methodologyService.list();
        const byId = new Map(methodologies.map((item) => [item.id, item]));
        const existing = new Set(current.appliedPrincipleIds);
        for (const id of principleIds) {
          const methodology = byId.get(id);
          if (existing.has(id)) continue;
          if (methodology === undefined || methodology.status !== "accepted") {
            throw new Error("只能新增当前已采纳的方法论原则。");
          }
        }
        const result = await store.updateAppliedPrinciples(decisionId, {
          appliedPrincipleIds: principleIds,
        });
        if (!result.indexed) {
          runtime.reportIndexIssue(
            "方法论采用关系已写入 Markdown，但决策索引更新失败；请在设置中重建决策索引。",
          );
        }
        controller.refresh();
        return toDecisionAppliedPrinciples(principleIds, methodologies);
      },
      getDecisionPrincipleSuggestions: async (input) => {
        const methodologies = await methodologyService.list();
        const byId = new Map(methodologies.map((item) => [item.id, item]));
        const recalled = await semanticSearch
          .recallMethodologies(methodologies, input, 3)
          .catch(() => buildMethodologyRecall(methodologies, input, 3));
        return recalled.flatMap(
          (match) => {
            const methodology = byId.get(match.principleId);
            return methodology === undefined ||
              methodology.status !== "accepted"
              ? []
              : [
                  {
                    id: methodology.id,
                    title: methodology.title,
                    principle: methodology.principle,
                    appliesWhen: methodology.appliesWhen,
                    caution: methodology.caution,
                    score: match.score,
                    strength: match.strength,
                    reason: match.reason,
                    matchedTerms: match.matchedTerms,
                  },
                ];
          },
        );
      },
      validateDecisionAppliedPrinciples: async (principleIds) => {
        const accepted = new Set(
          (await methodologyService.list())
            .filter((item) => item.status === "accepted")
            .map((item) => item.id),
        );
        if (principleIds.some((id) => !accepted.has(id))) {
          throw new Error("只能记录当前已采纳的方法论原则。");
        }
      },
      getMethodologyBuildProgress: async () => {
        const [methodologies, practiceAssets] = await Promise.all([
          methodologyService.list(),
          practiceAssetService.list(),
        ]);
        return buildMethodologyBuildProgress(
          index.progressFacts(),
          methodologies,
          practiceAssets,
        );
      },
      listMethodologies: async (status) => {
        const [records, relations] = await Promise.all([
          methodologyService.list(),
          methodologyService.listRelations(),
        ]);
        const listed = records.filter((record) => status === undefined || record.status === status);
        const cited = citedDecisions(index, listed);
        return listed.map((record) =>
          toMethodologyItem(record, cited, records, relations),
        );
      },
      createManualMethodology: async (input) => {
        const record = await methodologyService.createManual(input);
        const [records, relations] = await Promise.all([
          methodologyService.list(),
          methodologyService.listRelations(),
        ]);
        controller.refresh();
        return toMethodologyItem(record, index, records, relations);
      },
      createManualMethodologyFromEvidence: async (input) => {
        const record = await methodologyService.createManualFromEvidence(input);
        const [records, relations] = await Promise.all([
          methodologyService.list(),
          methodologyService.listRelations(),
        ]);
        controller.refresh();
        return toMethodologyItem(record, index, records, relations);
      },
      listManualFormDrafts: () => manualFormDrafts.list(),
      saveManualFormDraft: (input) => manualFormDrafts.save(input),
      deleteManualFormDraft: (key) => manualFormDrafts.delete(key),
      listPrompts: () => prompts.list(),
      createPrompt: (input) => prompts.create(input),
      updatePrompt: (input) => prompts.update(input),
      deletePrompt: (id) => prompts.delete(id),
      generateMethodology: async (sourceDecisionIds) => {
        const record = await methodologyService.generate(sourceDecisionIds);
        const [records, relations] = await Promise.all([
          methodologyService.list(),
          methodologyService.listRelations(),
        ]);
        controller.refresh();
        return toMethodologyItem(record, index, records, relations);
      },
      createMethodologyMergeDraft: async (sourcePrincipleIds, input) => {
        const record = await methodologyService.createMergeDraft(
          sourcePrincipleIds,
          input,
        );
        const [records, relations] = await Promise.all([
          methodologyService.list(),
          methodologyService.listRelations(),
        ]);
        controller.refresh();
        return toMethodologyItem(record, index, records, relations);
      },
      createMethodologyRevisionDraft: async (id, input) => {
        const record = await methodologyService.createRevisionDraft(id, input);
        const [records, relations] = await Promise.all([
          methodologyService.list(),
          methodologyService.listRelations(),
        ]);
        controller.refresh();
        return toMethodologyItem(record, index, records, relations);
      },
      reviseMethodology: async (id, input, basis) => {
        const record = await methodologyService.revise(id, input, basis);
        const [records, relations] = await Promise.all([
          methodologyService.list(),
          methodologyService.listRelations(),
        ]);
        controller.refresh();
        return toMethodologyItem(record, index, records, relations);
      },
      setMethodologyStatus: async (id, status, acknowledgeQualityRisks) => {
        const record = await methodologyService.setStatus(id, status, {
          ...(acknowledgeQualityRisks === undefined
            ? {}
            : { acknowledgeQualityRisks }),
        });
        const [records, relations] = await Promise.all([
          methodologyService.list(),
          methodologyService.listRelations(),
        ]);
        controller.refresh();
        return toMethodologyItem(record, index, records, relations);
      },
      listMethodologyVersions: async (id) =>
        (await methodologyService.listHistory(id)).map(
          toMethodologyVersionItem,
        ),
      restoreMethodologyVersion: async (id, version) => {
        const record = await methodologyService.restoreVersion(id, version);
        const [records, relations] = await Promise.all([
          methodologyService.list(),
          methodologyService.listRelations(),
        ]);
        controller.refresh();
        return toMethodologyItem(record, index, records, relations);
      },
      getMethodologySuggestions: async () => {
        // Every group offered (12 at most, buildMethodologySuggestions): the panel generates six at a time and
        // counts the rest for the next batch. Cut to six here, it had none to count, and the workbox said six.
        const { active } = await getMethodologySuggestionPartition();
        return active;
      },
      getDeferredMethodologySuggestions: async () => {
        const { deferred } = await getMethodologySuggestionPartition();
        return deferred;
      },
      deferMethodologySuggestion: async (id) => {
        const { active } = await getMethodologySuggestionPartition();
        if (!active.some((suggestion) => suggestion.id === id)) {
          throw new Error("这组复盘素材已变化，请刷新后再操作。");
        }
        await methodologySuggestionPreferences.defer(
          id,
          new Date().toISOString(),
        );
        controller.refresh();
      },
      restoreMethodologySuggestion: async (id) => {
        const { deferred } = await getMethodologySuggestionPartition();
        if (!deferred.some((suggestion) => suggestion.id === id)) {
          throw new Error("这组已搁置素材已变化，请刷新后再操作。");
        }
        await methodologySuggestionPreferences.restore(id);
        controller.refresh();
      },
      getMethodologyEvidenceMatches: async (id) => {
        const records = await methodologyService.list();
        const record = records.find((item) => item.id === id);
        if (record === undefined) {
          throw new Error("方法论记录不存在。");
        }
        const reviewed = index.queryDecisions({
          query: "",
          reviewState: "reviewed",
          limit: 200,
          asOfDate: localCalendarDate(new Date()),
        });
        const evidence = reviewed.flatMap((decision) => {
          const item = toDecisionLibraryItem(decision);
          return item.outcome === null || item.outcomeReview === null
            ? []
            : [
                {
                  id: item.id,
                  project: item.project,
                  question: item.question,
                  selectedAnswer: item.selectedAnswer,
                  rationale: item.rationale,
                  context: item.context,
                  outcome: item.outcome,
                  outcomeVerdict: item.outcomeReview.verdict,
                  outcomeLesson: item.outcomeReview.lesson,
                  reviewedAt: item.outcomeReview.reviewedAt,
                },
              ];
        });
        const matches = buildMethodologyEvidenceMatches(record, evidence);
        const reviewedById = new Map(
          reviewed.map((decision) => [decision.id, decision]),
        );
        const candidates = evidence.flatMap((item) => {
          const decision = reviewedById.get(item.id);
          return decision === undefined ? [] : [decision];
        });
        // The overlap matches go in as the lexical side, so anything the
        // embedding adds on top is by definition what the words missed.
        const semantic = await semanticSearch
          .searchDecisions({
            query: `${record.title}\n${record.principle}`,
            candidates,
            load: (ids) => {
              const wanted = new Set(ids);
              return candidates.filter((decision) => wanted.has(decision.id));
            },
            lexical: matches.flatMap((match) => {
              const decision = reviewedById.get(match.sourceDecisionId);
              return decision === undefined ? [] : [decision];
            }),
            limit: matches.length + 3,
          })
          .catch(() => []);
        return withSemanticEvidenceMatches(
          matches,
          // searchDecisions already returns them best first.
          semantic.flatMap((match, rank) =>
            match.matchKind === "semantic"
              ? [{ sourceDecisionId: match.decision.id, rank }]
              : [],
          ),
          new Set(record.sourceDecisionIds),
        );
      },
      importMethodologyMarkdown: async () => {
        const selection = await dialog.showOpenDialog({
          title: "导入方法论 Markdown",
          buttonLabel: "导入为候选",
          properties: ["openFile", "multiSelections"],
          filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
        });
        if (selection.canceled || selection.filePaths.length === 0) {
          return {
            cancelled: true,
            batchId: null,
            candidates: [],
            duplicates: [],
            failures: [],
          };
        }
        const readable = await readMethodologyMarkdownSources(
          selection.filePaths,
        );
        const preview =
          readable.sources.length === 0
            ? { candidates: [], duplicates: [], failures: [] }
            : await methodologyService.previewMarkdown(readable.sources);
        prunePendingMethodologyImports();
        while (pendingMethodologyImports.size >= 8) {
          const oldest = pendingMethodologyImports.keys().next().value;
          if (oldest === undefined) break;
          pendingMethodologyImports.delete(oldest);
        }
        const batchId =
          preview.candidates.length === 0
            ? null
            : `methodology-import-batch-${randomUUID()}`;
        if (batchId !== null) {
          pendingMethodologyImports.set(batchId, {
            createdAt: Date.now(),
            candidates: preview.candidates,
          });
        }
        return {
          cancelled: false,
          batchId,
          candidates: preview.candidates.map((candidate) => ({
            id: candidate.id,
            fileName: candidate.fileName,
            title: candidate.title,
            principle: candidate.principle,
            appliesWhen: candidate.appliesWhen,
            caution: candidate.caution,
            sourceDecisionCount: candidate.sourceDecisionIds.length,
            missingFields: candidate.missingFields,
            similarTo: candidate.similarTo,
          })),
          duplicates: preview.duplicates,
          failures: [...readable.failures, ...preview.failures],
        };
      },
      commitMethodologyMarkdownImport: async (
        batchId,
        selectedCandidateIds,
      ) => {
        prunePendingMethodologyImports();
        const batch = pendingMethodologyImports.get(batchId);
        if (batch === undefined) {
          throw new Error("导入预检已过期，请重新选择 Markdown 文件。");
        }
        pendingMethodologyImports.delete(batchId);
        const imported = await methodologyService.importMarkdownCandidates(
          batch.candidates,
          selectedCandidateIds,
        );
        const [records, relations] = await Promise.all([
          methodologyService.list(),
          methodologyService.listRelations(),
        ]);
        if (imported.imported.length > 0) controller.refresh();
        return {
          imported: imported.imported.map((record) =>
            toMethodologyItem(record, index, records, relations),
          ),
          duplicates: imported.duplicates,
          failures: imported.failures,
        };
      },
      setMethodologyEvidence: async (id, sourceDecisionIds) => {
        const record = await methodologyService.setEvidence(
          id,
          sourceDecisionIds,
        );
        const [records, relations] = await Promise.all([
          methodologyService.list(),
          methodologyService.listRelations(),
        ]);
        controller.refresh();
        return toMethodologyItem(record, index, records, relations);
      },
      setMethodologyRelation: async (id, relatedId, disposition, note) => {
        const record = await methodologyService.setRelation(
          id,
          relatedId,
          disposition,
          note,
        );
        const [records, relations] = await Promise.all([
          methodologyService.list(),
          methodologyService.listRelations(),
        ]);
        controller.refresh();
        return toMethodologyItem(record, index, records, relations);
      },
      clearMethodologyRelation: async (id, relatedId) => {
        const record = await methodologyService.clearRelation(id, relatedId);
        const [records, relations] = await Promise.all([
          methodologyService.list(),
          methodologyService.listRelations(),
        ]);
        controller.refresh();
        return toMethodologyItem(record, index, records, relations);
      },
      getMethodologyUsage: async (id) => {
        const methodology = (await methodologyService.list()).find(
          (item) => item.id === id,
        );
        if (methodology === undefined) {
          throw new Error("方法论记录不存在。");
        }
        return buildMethodologyUsageSnapshot(id, index.decisionsApplying(id));
      },
      getMethodologyValidationInbox: async () =>
        buildMethodologyValidationInbox(
          await methodologyService.list(),
          reviewedDecisions(),
        ),
      acknowledgeMethodologyValidation: async (id, seen) => {
        const records = await methodologyService.list();
        const item = buildMethodologyValidationInbox(
          records,
          reviewedDecisions(),
        ).find((candidate) => candidate.principleId === id);
        if (item === undefined || item.decisions[0] === undefined) {
          throw new Error("这条原则目前没有待复验的采用结果。");
        }
        if (item.revisionDraftId !== null) {
          throw new Error("这条原则已有待确认修订，请先处理修订草案。");
        }
        // Only as far as the reader was shown: acknowledged at the newest review found now, one recorded since
        // (an agent's 变差 over MCP) was confirmed unseen and left the inbox.
        const shown = item.decisions.find((decision) => decision.id === seen.decisionId && decision.reviewedAt === seen.reviewedAt);
        if (shown === undefined) {
          throw new Error("待复验的复盘已经变化，请重新打开原则复验后再确认。");
        }
        const record = await methodologyService.acknowledgeUsageValidation(id, {
          reviewedAt: shown.reviewedAt,
          decisionId: shown.id,
        });
        const [nextRecords, relations] = await Promise.all([
          methodologyService.list(),
          methodologyService.listRelations(),
        ]);
        controller.refresh();
        return toMethodologyItem(record, index, nextRecords, relations);
      },
      getMethodologyMergePlan: (mergeId) =>
        methodologyMergeLifecycleService.plan(mergeId),
      prepareMethodologyMergeAsset: async (mergeId, assetId) => {
        const record = await methodologyMergeLifecycleService.prepareAsset(
          mergeId,
          assetId,
        );
        controller.refresh();
        return toPracticeAssetItem(record, await methodologyService.list());
      },
      retireMethodologyMergeSources: async (mergeId) => {
        const plan =
          await methodologyMergeLifecycleService.retireSources(mergeId);
        controller.refresh();
        return plan;
      },
      restoreMethodologyMergeSources: async (mergeId) => {
        const plan =
          await methodologyMergeLifecycleService.restoreSources(mergeId);
        controller.refresh();
        return plan;
      },
      getDecisionAnalytics: async () => {
        // Principles name the patterns; the decisions are the index's (as listDecisions).
        const methodologies = await methodologyService.list().catch(() => []);
        const decisions = index.snapshotDecisions();
        // The index keeps no structured options: read the notes of the longest window (and a day's margin) only.
        const since = Date.now() - (Math.max(...RETROSPECTIVE_WINDOWS) + 1) * 24 * 60 * 60 * 1000;
        const follows = new Map<string, "followed" | "not_followed">();
        // ponytail: unbounded reads, about 80 ms for a few hundred notes; a concurrency limit or an index column if it grows.
        await Promise.all(
          decisions
            .filter((decision) => Date.parse(decision.created) >= since)
            .map(async (decision) => {
              const note = await repository.read(decision.filePath).catch(() => null);
              const follow = note === null ? null : recommendationFollow(note.record.options, note.record.selectedAnswer);
              if (follow !== null) follows.set(decision.id, follow);
            }),
        );
        return decisionAnalyticsService.analyze(
          decisions,
          new Map(methodologies.map((item) => [item.id, item.title])),
          follows,
        );
      },
      getDecisionConsultationMetrics: () =>
        decisionConsultationMetrics.snapshot(),
      previewDecisionConsultation: async (input) => {
        const methodologies = await methodologyService.list();
        // Taken as this list left it (see consult).
        const principlesUnread = unreadableNotes.principles.length > 0;
        const recalled = await semanticSearch
          .recallMethodologies(
            methodologies,
            {
              question: input.question,
              selectedAnswer: null,
              optionLabels: input.options,
              context: input.context,
            },
            3,
          )
          .catch(() => undefined);
        return decisionConsultationFeedback.issue(
          buildDecisionConsultation(
            {
              consultationVersion: DECISION_CONSULTATION_VERSION,
              requestId: `preview-${randomUUID()}`,
              sourceClient: "test",
              project: "local-preview",
              question: input.question,
              options: input.options.map((label) => ({ label })),
              context: input.context,
              requestedAt: new Date().toISOString(),
            },
            methodologies,
            recalled,
            [],
            { principles: principlesUnread },
          ),
          "preview",
        );
      },
      submitDecisionConsultationFeedback: (input) =>
        decisionConsultationFeedback.submit({
          feedbackVersion: DECISION_CONSULTATION_FEEDBACK_VERSION,
          token: input.token,
          rating: input.rating,
        }),
      getKnowledgeGraph: async () => {
        const [all, relations] = await Promise.all([
          methodologyService.list(),
          methodologyService.listRelations(),
        ]);
        // The confidence the app shows, from the evidence still there; missing evidence is listed apart.
        // It reads that evidence alone: comparing every pair of principles here stalls the window for hundreds.
        const accepted = all.filter((record) => record.status === "accepted");
        const cited = citedDecisions(index, accepted);
        const records = accepted.map((record) => ({ ...record, confidence: toMethodologyItem(record, cited, []).quality.recommendedConfidence }));
        const sourceIds = [
          ...new Set(records.flatMap((record) => record.sourceDecisionIds)),
        ];
        return buildKnowledgeGraph(
          records,
          index.findDecisions(sourceIds),
          relations,
        );
      },
      listPracticeAssets: async (status) => {
        const [records, methodologies] = await Promise.all([
          practiceAssetService.list(status),
          methodologyService.list(),
        ]);
        return records.map((record) =>
          toPracticeAssetItem(record, methodologies),
        );
      },
      createManualPracticeAsset: async (kind, sourcePrincipleIds, input) => {
        const record = await practiceAssetService.createManual(
          kind,
          sourcePrincipleIds,
          input,
        );
        controller.refresh();
        return toPracticeAssetItem(record, await methodologyService.list());
      },
      generatePracticeAsset: async (kind, sourcePrincipleIds) => {
        const record = await practiceAssetService.generate(
          kind,
          sourcePrincipleIds,
        );
        controller.refresh();
        return toPracticeAssetItem(record, await methodologyService.list());
      },
      revisePracticeAsset: async (id, input, basis) => {
        const record = await practiceAssetService.revise(id, input, basis);
        controller.refresh();
        return toPracticeAssetItem(record, await methodologyService.list());
      },
      setPracticeAssetStatus: async (id, status) => {
        const record = await practiceAssetService.setStatus(id, status);
        controller.refresh();
        return toPracticeAssetItem(record, await methodologyService.list());
      },
      regeneratePracticeAsset: async (id) => {
        const record = await practiceAssetService.regenerate(id);
        controller.refresh();
        return toPracticeAssetItem(record, await methodologyService.list());
      },
      listPracticeAssetVersions: async (id) =>
        (await practiceAssetService.listVersions(id)).map(
          toPracticeAssetVersionItem,
        ),
      restorePracticeAssetVersion: async (id, version) => {
        const record = await practiceAssetService.restoreVersion(id, version);
        controller.refresh();
        return toPracticeAssetItem(record, await methodologyService.list());
      },
      listPracticePublicationStatuses: (id) =>
        practicePublicationService.listStatuses(id),
      publishPracticeAsset: (id, target, confirmOverwrite) =>
        practicePublicationService.publish(id, target, {
          ...(confirmOverwrite === undefined ? {} : { confirmOverwrite }),
        }),
      rollbackPracticeAssetPublication: (id, target) =>
        practicePublicationService.rollback(id, target),
      chooseVault: async () => {
        const selection = await dialog.showOpenDialog({
          title: "选择 Obsidian 仓库",
          properties: ["openDirectory", "createDirectory"],
        });
        const vaultPath = selection.filePaths[0] ?? null;
        if (selection.canceled || vaultPath === null) {
          return null;
        }
        await changeSettings((current) => withVaultPath(current, vaultPath));
        return vaultPath;
      },
      revealVault: async () => {
        // The renderer never names a path here, so nothing it can say reaches
        // the file manager. A vault that has been moved away reports false
        // rather than opening whatever now sits at that path's parent.
        // The vault in use, which the page names: one chosen since takes over at the next start, and
        // showing it opened a folder the captures were not yet going into.
        const current = vaultPath;
        if (!existsSync(current)) return false;
        shell.showItemInFolder(current);
        return true;
      },
      installIntegrations: async (mode, ids) => {
        const bridgePath = bridgeExecutablePath();
        if (mode === "apply" && isTranslocated(bridgePath)) {
          throw new Error("Paraself 正从系统临时放置的位置运行（在“下载”里直接打开时会这样），这时连接的客户端会在这个位置被移走后全部失效。请先把 Paraself 移到“应用程序”文件夹并重新打开，再连接客户端。");
        }
        // A client's command is found as a terminal finds it: see login-shell-path.ts.
        await loginPathReady;
        try {
          // In the queue, its clients and paths read once its turn comes: a client deleted or moved meanwhile is as it now is.
          const report = await customClients.inTurn(() => installIntegrationsWithinTurn({
            mode,
            bridgePath,
            platform: process.platform,
            clients: clientsNamed(ids),
            paths: integrationPaths(),
            checkTarget,
            skillsSource: bundledSkillsPath(),
          }));
          if (mode === "apply") noteSkills(report.skills, report.targets.filter((target) => target.status === "installed").map((target) => target.client));
          return report;
        } finally {
          // Whatever came of it, the cards say what the files now hold: a check finds hooks left naming a
          // moved app, and an attempt that connected one client and not the other is shown as it is.
          integrationStatus = await detectedIntegrationStatus();
          controller.refresh();
        }
      },
      removeIntegrations: async (ids) => {
        await loginPathReady;
        try {
          return await customClients.inTurn(() =>
            removeIntegrationsWithinTurn({ mode: "apply", bridgePath: bridgeExecutablePath(), platform: process.platform, clients: clientsNamed(ids), paths: integrationPaths(), checkTarget }),
          );
        } finally {
          integrationStatus = await detectedIntegrationStatus();
          controller.refresh();
        }
      },
      listCustomClients: async () => customClients.list(),
      saveCustomClient: async ({ client, previousId }) => {
        await loginPathReady;
        try {
          return await customClients.save(client, previousId);
        } finally {
          integrationStatus = await detectedIntegrationStatus();
          controller.refresh();
        }
      },
      deleteCustomClient: async (id) => {
        await loginPathReady;
        try {
          return await customClients.delete(id);
        } finally {
          integrationStatus = await detectedIntegrationStatus();
          controller.refresh();
        }
      },
      rebuildIndex: async () => {
        const report = await runtime.rebuildIndex();
        // A vault not there at start (a drive connected later), or a watch an error ended, is watched from now on:
        // rebuilt and called healthy, every edit made in Obsidian after it was missing until a restart.
        watcher.start();
        controller.refresh();
        await semanticSearch
          .synchronize(indexedDecisions, await methodologyService.list())
          .catch(() => undefined);
        return report;
      },
      setTheme: async (theme) => {
        await changeSettings((current) => withTheme(current, theme));
        nativeTheme.themeSource = ELECTRON_THEME_SOURCE[theme];
        controller.refresh();
      },
      setAccent: async (accent) => {
        await changeSettings((current) => withAccent(current, accent));
        controller.refresh();
      },
      listModelTraces: () => allModelTraces.list(),
      deleteModelTrace: (traceId) => allModelTraces.deleteTrace(traceId),
      deleteModelTraceRequest: (requestId) =>
        allModelTraces.deleteRequest(requestId),
      // A conversation deleted: its question and the notes it read stayed in the ratings and the call records.
      forgetAssistantTurns: (turnIds) => forgetAssistantTurns(turnIds, assistantFeedback, modelTraces),
      clearModelTraces: () => allModelTraces.clear(),
      setModelProxyUrl: async (modelProxyUrl) => {
        await changeSettings((current) => ({ ...current, modelProxyUrl }));
        await refreshLocalClientStatuses(true);
        semanticGateway.refresh();
        refreshSemanticRecognition();
        controller.refresh();
      },
      setModelTraceContentEnabled: async (enabled) => {
        await changeSettings((current) => withModelTraceContentEnabled(current, enabled));
        controller.refresh();
      },
      setLocalCredentialsEnabled: async (enabled) => {
        await providerCredentials.setLocalMode(enabled, async () => {
          await changeSettings((current) => ({ ...current, localCredentialsEnabled: enabled }));
        });
        controller.refresh();
      },
      setReviewRemindersEnabled: async (enabled) => {
        await changeSettings((current) => withReviewRemindersEnabled(current, enabled));
        controller.refresh();
      },
      setCaptureClassifier: async (classifier) => {
        // The reader's decision recorded first: a `rules` chosen after a move that failed stays at the next start.
        await settingsRepository.recordCaptureClassifierDecided();
        await changeSettings((current) => withCaptureClassifier(current, classifier));
        refreshSemanticRecognition();
        controller.refresh();
      },
      listModelProviderProfiles: () => modelProviderService.list(),
      saveModelProviderProfile: (input) => modelProviderService.save(input),
      deleteModelProviderProfile: (profileId) =>
        modelProviderService.delete(profileId),
      reorderModelProviderProfiles: (profileIds) =>
        modelProviderService.reorder(profileIds),
      testModelProviderProfile: async (profileId) => {
        const profile = (await providerProfiles.load()).find(
          (candidate) => candidate.profileId === profileId,
        );
        if (
          profile?.kind === "codex-cli" ||
          profile?.kind === "claude-code-cli"
        ) {
          await refreshLocalClientStatuses();
        }
        const result = await modelProviderService.test(profileId);
        refreshSemanticRecognition();
        controller.refresh();
        return result;
      },
      listManagedQwenModels: () => localModelInstaller.list(),
      installManagedQwenModel: (modelId) => localModelInstaller.install(modelId),
      listLocalModelClientStatuses: () => refreshLocalClientStatuses(),
      completeDeferredRationale: async (id, input) => {
        await runtime.completeDeferredRationale(id, input);
        controller.refresh();
      },
      skipDeferredRationale: async (id) => {
        await runtime.skipDeferredRationale(id);
        controller.refresh();
      },
      keepLocalRationale: (id, input) => serializeLocalWrite(async () => {
        await runtime.keepLocalRationale(id, input);
        controller.refresh();
      }),
      previewDecisionDeletion: (input) => decisionDeletion.preview(input),
      deleteDecision: (input) => serializeLocalWrite(() => decisionDeletion.delete(input)),
      getMisrecognitionSummary: () => misrecognitions.summary(),
      listLocalDecisions: async (query, offset) => localDecisions.list(query, offset),
      resolveLocalDecision: (id, action) => serializeLocalWrite(async () => {
        const record = localDecisions.get(id);
        if (!record) return;
        if (action === "publish") {
          const result = await store.publishLocal(record, localDecisions.content(id) ?? undefined);
          if (!result.indexed) runtime.reportIndexIssue("记录已写入知识库，但索引更新失败，请重建索引。");
        }
        localDecisions.resolve(id, action === "publish" ? "published" : "discarded");
        controller.refresh();
      }),
      discardDeferredRationale: async (id) => {
        await runtime.discardDeferredRationale(id);
        controller.refresh();
      },
    },
  });

  // Nor in the menu bar, for a run started by a script (IMP-133): one more icon there every few seconds.
  if (readParaselfEnvironment(process.env, "SMOKE") !== "1") {
    const trayImage = nativeImage.createFromPath(trayIconPath());
    const tray = trayLifecycle.attach(new Tray(trayImage));
    // On Windows the menu is on the right button, and the left did nothing: closed to the tray, the window
    // could only come back through that menu. It brings the window back where it was, as the Dock does: sent
    // to the home page, a review half written went with the page it was on.
    if (process.platform === "win32") {
      tray.on("click", () => openDesktopApplication());
    }
    updateTray = (pendingCount, reviewDueCount) => {
      configureTray({
        tray,
        image: trayImage,
        buildMenu: (template) => Menu.buildFromTemplate(template),
        pendingCount,
        reviewDueCount,
        openDashboard: () => {
          windows.show();
          controller.openSurface("dashboard");
        },
        // Shown as the home page is: a window already up but behind other apps' stayed there.
        openSettings: () => {
          windows.show();
          controller.openSurface("settings");
        },
        quit: () => app.quit(),
      });
    };
  }
  const initialSnapshot = controller.snapshot();
  updateTray(pendingWorkTotal(initialSnapshot), initialSnapshot.dashboard.organizationAutomatic ? 0 : initialSnapshot.dashboard.reviewAttention);
  // A review that came due while the app was closed should say so on startup,
  // not wait for the next snapshot to happen to arrive.
  void reviewReminders.check();
  // Nor one that comes due overnight while the app idles in the tray: a new day refreshes the snapshot,
  // and with it the tray, the home inbox and the reminders (new-day.ts).
  const newDay = watchForNewDay(() => controller.refresh());
  powerMonitor.on("resume", () => { organization.resume(); newDay.check(); });

  let shutdownDone = false;
  app.on("before-quit", (event) => {
    if (shutdownDone) {
      return;
    }
    event.preventDefault();
    // A second quit (Cmd+Q again, a SIGTERM) waits with the first: let through, it quit under a model call still
    // running, the crash IMP-127 waits for.
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;
    // Close the queue before aborting processes: no new Git, model or platform operation
    // may start while other services are being taken down.
    const localReviewClosed = localReview.close();
    // A background organization run stopped first: its late answers are dropped, its queue kept for the next start.
    const organizationClosed = organization.close().catch((error: unknown) => console.error("organization shutdown", error));
    newDay.stop();
    prReview.cancel();
    // Cut short with the rest: an assistant turn under way, and every model process (started detached, a CLI call
    // ran on after the quit, billed, for nobody).
    for (const turn of assistantTurns.values()) turn.abort();
    stopManagedProcesses();
    // Out of sight at once: a model close can hold the quit past the server's stop (IMP-127), and a window left up
    // that long answered nothing.
    for (const window of BrowserWindow.getAllWindows()) window.hide();
    // Every probe still waiting taken out of its tool's hook file before anything else closes (a few seconds at most).
    void localReviewClosed.catch(error => console.error("local-review shutdown", error)).then(() => Promise.race([leftoverProbes.then(() => onboarding.shutdown()).catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 5_000))])).then(() => shutdownApplication({
      closeObsidian: () => obsidianSearch.close(),
      ...(readParaselfEnvironment(process.env, "SMOKE") === "1"
        ? {
            writeObsidianMarker: () =>
              writeObsidianSearchShutdownMarker(
                paths.obsidianSearchShutdownMarker,
              ),
          }
        : {}),
      flushSemanticPairs: () => semanticPairInbox.close(),
      closeSemanticCoordinator: () => semanticCoordinator.close(),
      closeDecisionSemanticSearch: () => semanticSearch.close(),
      closeLocalModels: () => localModels.shutdown(),
      flushOrganization: () => organization.finishWrites(),
      stopController: async () => { await organizationClosed; await localRecordTail; await controller.stop(); localDecisions.close(); },
    }))
      .finally(() => {
        shutdownDone = true;
        trayLifecycle.dispose();
        app.quit();
      });
  });
  app.on("window-all-closed", () => undefined);
  // Kept for every signal, not once: with the last listener gone Node gave the signal back to its default, and a second
  // SIGTERM (a logout's, a lab runner's) killed the app halfway through its quit. A quit under way ignores the next.
  process.on("SIGTERM", () => app.quit());
  process.on("SIGINT", () => app.quit());
  await controller.start();
  // Answered while the app was starting, after the spool was read and before the service listened: the
  // bridge could only spool it, and nothing would read it again until the next start. What is in the
  // queue or done already is left as it is. So, every ten minutes, is one a hook spooled while the app was
  // too busy to answer it, should no capture come after it to take it in.
  await runtime.recoverSpooled();
  setInterval(() => void runtime.recoverSpooled(), 10 * 60 * 1_000).unref();
  // The same window for an answer the text hooks paired.
  await semanticPairInbox.recover().catch(() => undefined);
  // Kept 7 days means gone after 7 days, not at the next model call or a visit to the log page: a reader who
  // stopped using models kept every prompt, and a candidate dropped from the queue stayed on disk until a restart.
  const sweepRetention = (): void => {
    void modelTraces.list().catch(() => undefined);
    void decisionCalls.list().catch(() => undefined);
    void candidateSpool.list().catch(() => undefined);
  };
  sweepRetention();
  setInterval(sweepRetention, 24 * 60 * 60 * 1_000).unref();
  // Links reading their PR comments look at the open PRs they review or created: a minute after start, then every half
  // hour while the app runs. What they find waits on the home page for the reader; nothing is recorded from it.
  const followPrComments = (): void => {
    void prComments.follow().then((found) => { if (found) controller?.refresh(); }, () => undefined);
    // The same half hour: what became of the findings posted lately, and (where the user turned it on) the next PR to pre-review.
    void followOutcomes(outcomeSources).catch(() => undefined);
    void autoReviewPass(autoReviewSources).catch(() => undefined);
  };
  setTimeout(followPrComments, 60_000).unref();
  setInterval(followPrComments, 30 * 60 * 1_000).unref();
  // The day's timer runs only while the Mac is awake: one asleep most of the week swept days late.
  powerMonitor.on("resume", sweepRetention);
  try {
    obsidianSearch.start();
  } catch {
    // Obsidian search is optional and cannot interrupt Paraself startup.
  }
  // Loaded at once, beside the syncs: with no decision or principle to sync, they never asked the model.
  void semanticSearch.warmQueries();
  void methodologyService
    .list()
    .then((methodologies) => semanticSearch.synchronize(indexedDecisions, methodologies))
    .catch(() => undefined)
    // Then the summaries, in the background as well: every one at the first start after the upgrade.
    .then(() => semanticSearch.synchronizeSummaries())
    .catch(() => undefined);
  // An agent's first search otherwise found a large vault unread, ran out of time and answered with part of it.
  void decisionContext.warm().catch(() => undefined);
  if (
    readParaselfEnvironment(process.env, "SMOKE") === "1" &&
    readParaselfEnvironment(process.env, "START_SETTINGS") === "1"
  ) {
    controller.openSurface("settings");
  }
};

if (squirrelStartup) {
  app.quit();
} else {
  const userDataResolution = configureElectronUserDataPath(app);

  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    app.on("second-instance", () => openDesktopApplication());
    app.on("activate", () => openDesktopApplication());
    void app
      .whenReady()
      .then(() => bootstrap(userDataResolution))
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Paraself failed to start: ${reason}\n`);
        // Opened from the Dock, the app otherwise just vanished, with the reason in a log nobody sees.
        if (readParaselfEnvironment(process.env, "SMOKE") !== "1") {
          dialog.showErrorBox("Paraself 无法启动", reason);
        }
        app.exit(1);
      });
  }
}
