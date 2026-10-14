import { LocalModelInstaller } from "./semantic/local-model-installer.js";
import { PrConnections } from "./pr-connections.js";
import { PrReviewService } from "./pr-review-service.js";
import { combineReviewRules, createDecisionFeedbackStore, loadReviewRules, matchReviewRules, MAX_MATCHED_REVIEW_RULES } from "@cognelis/decision-storage";
import { DecisionFeedbackService } from "./decision-feedback-service.js";
import { hookBridgeReference, installIntegrations, removeIntegrations } from "@cognelis/decision-integrations";
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
  type MethodologyQualityAssessment,
  type MethodologyHistoryEntry,
  type MethodologyRelationRecord,
  type MethodologyRecord,
  type PracticeAssetRecord,
  type PracticeAssetHistoryEntry,
} from "@cognelis/decision-core";
import type {
  LocalModelClientStatus,
  ModelProviderProfile,
  SemanticRecognitionStatus,
} from "@cognelis/decision-protocol";
import {
  DECISION_CONSULTATION_FEEDBACK_VERSION,
  DECISION_CONSULTATION_VERSION,
  PROACTIVE_RECORD_VERSION,
  decisionContextQuerySchema,
  proactiveRecordRequestSchema,
} from "@cognelis/decision-protocol";
import {
  CandidateSpool,
  CaptureAuditStore,
  CaptureSpool,
  DecisionStore,
  LocalDecisionStore,
  DecisionWatcher,
  JournalEntryRepository,
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
  type BrowserWindowConstructorOptions,
} from "electron";
import { randomBytes, randomUUID } from "node:crypto";
import { homedir, release } from "node:os";
import { basename, dirname, join } from "node:path";

import { readDecisionEnvironment } from "../../../../config/decision-environment.mjs";

import { AppController } from "./app-controller.js";
import { atomicWrite } from "./atomic-write.js";
import { ActiveRecordService, journalNotice } from "./active-record-service.js";
import { shutdownApplication } from "./application-shutdown.js";
import {
  applicationSupportPaths,
  configureElectronUserDataPath,
  resolveDefaultDecisionVaultPath,
  resolveObsidianConfigurationPath,
  type UserDataResolution,
} from "./application-paths.js";
import { CaptureRuntime } from "./capture-runtime.js";
import { isTranslocated, prepareBridgeLauncher, resolveBridgeExecutablePath, squirrelBridgeLauncher } from "./bridge-path.js";
import { readDashboardSnapshot } from "./dashboard-snapshot.js";
import { DecisionAnalyticsService } from "./decision-analytics-service.js";
import { DecisionConsultationFeedbackService } from "./decision-consultation-feedback-service.js";
import { DecisionConsultationMetricsStore } from "./decision-consultation-metrics-store.js";
import { buildDecisionConsultation } from "./decision-consultation-service.js";
import { DecisionHandoffService } from "./decision-handoff-service.js";
import { DecisionOutcomeService } from "./decision-outcome-service.js";
import { DecisionContextService } from "./decision-context-service.js";
import { ObsidianVaultRepository, DecisionContextRepository, DecisionScopeRepository, DecisionRelationRepository } from "@cognelis/decision-storage";
import { detectIntegrationStatus } from "./integration-status.js";
import { loginShellEnvironment } from "./login-shell-path.js";
import { watchForNewDay } from "./new-day.js";
import { registerDecisionIpc } from "./ipc.js";
import { createObsidianSearchRuntime } from "./obsidian-search/obsidian-search-runtime.js";
import { buildKnowledgeGraph } from "./knowledge-graph-service.js";
import { LocalCaptureServer } from "./local-server.js";
import { ManualFormDraftStore } from "./manual-form-draft-store.js";
import {
  loadLiquidGlassRuntime,
  type LiquidGlassSurface,
} from "./liquid-glass.js";
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
import { ModelProviderError } from "./model/http-model-transport.js";
import { ModelProviderService } from "./model/model-provider-service.js";
import { ProfiledModelGateway } from "./model/profiled-model-gateway.js";
import { DecisionAssistantService } from "./decision-assistant-service.js";
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
import { QwenEmbeddingProvider } from "./semantic/qwen-embedding-provider.js";
import { QwenModelProvider } from "./semantic/qwen-provider.js";
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
  withReviewRemindersEnabled,
  withVaultPath,
  withTheme,
} from "./settings.js";
import { stopManagedProcesses } from "./model/cli/managed-child-process.js";
import { reviewReminderNotifier } from "./review-notifications.js";
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
): DecisionLibraryItem => ({
  id: decision.id,
  created: decision.created,
  sourceClient: decision.sourceClient,
  project: decision.project,
  question: decision.question,
  selectedAnswer: decision.selectedAnswer,
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

const foundationModelHelperPath = (): string =>
  app.isPackaged
    ? join(
        process.resourcesPath,
        "semantic",
        "decision-foundation-model-helper",
      )
    : join(
        app.getAppPath(),
        "dist",
        "semantic",
        "decision-foundation-model-helper",
      );

const liquidGlassAddonPath = (): string =>
  app.isPackaged
    ? join(process.resourcesPath, "native", "decision-liquid-glass.node")
    : join(
        app.getAppPath(),
        "dist",
        "native",
        "decision-liquid-glass.node",
      );

// Started from Finder or the Dock, the app has launchd's PATH, without claude or codex on it: see
// login-shell-path.ts. Begun now and awaited only where a client's command runs, so startup does not wait.
const loginPathReady: Promise<void> =
  process.platform === "win32"
    ? Promise.resolve()
    : loginShellEnvironment().then((login) => {
        process.env.PATH = login.PATH;
        // Moved in the shell's files, where a terminal has them; one set for the app itself still wins.
        for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const) {
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
  const settingsRepository = new SettingsRepository(paths.settings);
  // Where each client reads its settings: CLAUDE_CONFIG_DIR and CODEX_HOME move them, as they move where
  // `claude mcp add` and `codex mcp add` register the server.
  // Read when used: the login shell's CLAUDE_CONFIG_DIR and CODEX_HOME arrive a moment after startup.
  const integrationPaths = () => ({
    claudeSettingsPath: join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json"),
    codexHooksPath: join(process.env.CODEX_HOME || join(homedir(), ".codex"), "hooks.json"),
  });
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
  let integrationStatus = await detectIntegrationStatus(integrationPaths(), currentBridgeReference());
  let settings = await settingsRepository.load();
  if (settingsRepository.setAside !== null && readDecisionEnvironment(process.env, "SMOKE") !== "1") {
    // Started from the defaults rather than not at all; said once, so the reset is not a mystery.
    void dialog.showMessageBox({
      type: "warning",
      message: "设置文件读不出来，这次用默认设置启动",
      detail: `原来的文件已另存为 ${settingsRepository.setAside}。仓库按 Obsidian 最近打开的那个选取，不对的话请在设置里重新选择；外观、模型记录和提醒等也回到了默认。`,
    });
  }
  const configuredVault = readDecisionEnvironment(
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
    const fallback = resolveDefaultDecisionVaultPath(app.getPath("documents"));
    settings = withVaultPath(settings, discovered[0] ?? fallback);
    await settingsRepository.save(settings);
    // A first run's default vault is made here, where it is chosen, rather than by the first save into it:
    // the decision watcher then has a folder to watch from the start. A vault found in Obsidian's list is there
    // already; made, one gone since would have been put back empty, and the missing vault never said.
    if (discovered[0] === undefined) await mkdir(fallback, { recursive: true }).catch(() => undefined);
  }

  const vaultPath = settings.vaultPath;
  if (vaultPath === null) {
    throw new Error("Decision could not resolve a vault path");
  }
  const obsidianSearch = await createObsidianSearchRuntime({
    vaultPath,
    indexRoot: paths.obsidianSearchRoot,
    modelsDirectory: paths.models,
    openExternal: (uri) => shell.openExternal(uri),
  });
  nativeTheme.themeSource = ELECTRON_THEME_SOURCE[settings.theme];
  // One for the app: each keeps the notes of every folder it reads in memory, and the decisions' repository and
  // the agents' search both read the decisions folder.
  const vault = new ObsidianVaultRepository(vaultPath);
  const index = new SqliteIndex(paths.index);
  const localDecisions = new LocalDecisionStore(paths.localDecisions);
  // A vault folder that has gone (moved, a drive not connected) is not made up again empty by a write:
  // the write is refused, saying so, and a capture waits in the recovery queue.
  const repository = new MarkdownRepository(vaultPath, { existingVault: true, vault, locate: (id) => index.pathOf(id) });
  const decisionScopes = new DecisionScopeRepository(vaultPath);
  const decisionRelations = new DecisionRelationRepository(vaultPath);
  const contextRepository = new DecisionContextRepository(vaultPath, decisionScopes, decisionRelations, vault);
  const decisionFeedback = new DecisionFeedbackService(contextRepository, createDecisionFeedbackStore(vaultPath));
  const decisionContext = new DecisionContextService(contextRepository, decisionScopes, decisionRelations);
  const decisionHandoff = new DecisionHandoffService(contextRepository, vault, (uri) => shell.openExternal(uri));
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
  if (settingsRepository.addedSetAside !== null && readDecisionEnvironment(process.env, "SMOKE") !== "1") {
    // Said, as for the settings file: set aside without a word, the settings it held went back to their defaults.
    void dialog.showMessageBox({
      type: "warning",
      message: "部分设置读不出来，这次按默认值启动",
      detail: `原来的文件已另存为 ${settingsRepository.addedSetAside}。${localCredentials ? "复盘提醒和采集分类回到了默认，已保存的密钥仍留在本机" : "复盘提醒、采集分类和本机保存密钥回到了默认"}，需要的话请在设置里重新选择。`,
    });
  }
  const localClientDiscovery = new LocalModelClientDiscovery({ cacheDirectory: join(dirname(paths.modelProviderProfiles), "cli-model-catalogs") });
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
  if (providerProfiles.setAside !== null && readDecisionEnvironment(process.env, "SMOKE") !== "1") {
    // Started from the built-ins rather than not at all; said once, as for settings.
    void dialog.showMessageBox({
      type: "warning",
      message: "模型服务配置读不出来，这次用内置的模型服务启动",
      detail: `原来的文件已另存为 ${providerProfiles.setAside}。自己添加的模型服务需要在设置里重新添加。`,
    });
  }
  if (providerProfiles.addedSetAside !== null && readDecisionEnvironment(process.env, "SMOKE") !== "1") {
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
  const store = new DecisionStore(repository, index);
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
  let localRecordTail: Promise<void> = Promise.resolve();
  const serializeLocalWrite = (write: () => Promise<void>): Promise<void> => {
    const run = localRecordTail.then(write);
    localRecordTail = run.catch(() => undefined);
    return run;
  };
  const runtime = new CaptureRuntime({
    spool,
    candidateSpool,
    store,
    index,
    localDecisions,
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
        return new QwenModelProvider({
          modelsDirectory: paths.models,
          ...(profile.model === undefined ? {} : { model: profile.model }),
          timeoutMs: profile.timeoutMs,
        });
      }
      if (profile.kind === "openai") {
        return new OpenAIResponsesAdapter({
          profile,
          credentials: providerCredentials,
        });
      }
      if (profile.kind === "anthropic") {
        return new AnthropicMessagesAdapter({
          profile,
          credentials: providerCredentials,
        });
      }
      if (profile.kind === "openai-compatible") {
        return new OpenAICompatibleAdapter({
          profile,
          credentials: providerCredentials,
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
            "The configured local model client is not ready",
          );
        }
        return profile.kind === "codex-cli"
          ? new CodexCliAdapter({ profile })
          : new ClaudeCodeCliAdapter({ profile });
      }
      throw new ModelProviderError(
        "unsupported_client",
        "The configured CLI model provider is not available yet",
      );
    },
    traces: modelTraces,
    audit: captureAudit,
  });
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
    notify: (notice) => reminderNotices.notify(notice),
  });
  /** In-flight turns, so a cancel from the renderer can reach the right one. */
  const assistantTurns = new Map<string, AbortController>();
  const prConnections = new PrConnections(join(app.getPath("userData"), "pr-connections.json"), providerCredentials);
  // Decision's own rules plus the ones already written for code-meeseeks, same format; re-read on every PR load.
  const reviewRuleSources = [
    { source: "decision" as const, label: "Decision", directory: join(app.getPath("userData"), "review-rules") },
    { source: "code-meeseeks" as const, label: "code-meeseeks", directory: join(homedir(), ".code-meeseeks", "agent", "rules") },
  ];
  const exampleReviewRule = [
    "---", "applies_to:", '  repo: "^example-repo$"', '  target_branch: "^(main|master)$"', "tools: [review]", "priority: 0", "enabled: false", "---", "",
    "# 示例规则（未启用）", "",
    "正文就是追加给 PR 评审的检查要求，例如：", "", "- 金额一律用整数分，不用浮点数。", "- 对外接口的错误必须带错误码。", "",
    "把 enabled 改为 true、调整 applies_to 后生效。applies_to 下的 project、repo、target_branch 都是正则，省略即不限制；priority 越大越靠前。", "",
  ].join("\n");
  const prReview = new PrReviewService({
    createClient: (input) => prConnections.client(input.connectionId),
    cacheDirectory: join(app.getPath("userData"), "pr-review-cache"),
    gateway: semanticGateway,
    searchDecisions: (query) => decisionContext.search(query),
    loadRules: async (target) => {
      const loaded = await Promise.all(reviewRuleSources.map(async (item) => ({ ...item, ...(await loadReviewRules(item.directory)) })));
      const matched = loaded
        .flatMap(({ source, rules }) => matchReviewRules(rules, target).map((rule) => ({ rule, source })))
        .sort((left, right) => right.rule.priority - left.rule.priority || left.rule.id.localeCompare(right.rule.id))
        .slice(0, MAX_MATCHED_REVIEW_RULES);
      return {
        instructions: combineReviewRules(matched.map(({ rule }) => rule)),
        rules: matched.map(({ rule, source }) => ({ id: rule.id.slice(0, 500), source })),
        warnings: loaded.flatMap(({ label, warnings }) => warnings.map((warning) => `${label} ${warning}`)),
      };
    },
    onProgress: (event) => windows.send(IPC_CHANNELS.prReviewProgress, event),
  });
  const assistant = new DecisionAssistantService({
    gateway: semanticGateway,
    searchDecisions: (query) => decisionContext.search(query),
    searchNotes: (input) => obsidianSearch.search(input),
    searchJournal: (input) => journalRepository.list(input),
    // Not found is "deleted" to the assistant: a note it could not read just now (iCloud, busy) is no answer.
    readJournalEntry: (id) => journalRepository.find(id, { sure: true }),
    readDocument: async (relativePath) =>
      readFile(await vault.resolveNotePath(relativePath), "utf8"),
    noteExists: (relativePath) => vault.noteExists(relativePath),
    // `windows` is created further down; the callback only runs once a turn is
    // under way, by which time it exists.
    onStep: (turnId, step) => {
      windows.send(IPC_CHANNELS.assistantProgress, { turnId, step });
    },
  });
  const semanticSearch = new SemanticSearchService({
    vectors: new SemanticVectorIndex(paths.semanticVectors),
    gateway: new QwenEmbeddingProvider({
      modelsDirectory: paths.models,
    }),
  });
  // What a semantic sync reads: every decision by its note's hash, and whole only those whose notes changed.
  const indexedDecisions = {
    stamps: () => index.queryDecisionStamps({ everything: true }),
    load: (ids: string[]) => index.findDecisions(ids),
  };
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
      get codex() { return join(dirname(integrationPaths().codexHooksPath), "skills"); },
      get "claude-code"() { return join(dirname(integrationPaths().claudeSettingsPath), "skills"); },
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
    modelEnabled: () => settings.captureClassifier === "models",
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
    semanticRefresh = (settings.captureClassifier === "models"
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
  const modelProviderService = new ModelProviderService({
    repository: providerProfiles,
    credentials: providerCredentials,
    credentialReferenceFactory: () => `provider:${randomUUID()}`,
    refresh: () => {
      semanticGateway.refresh();
      refreshSemanticRecognition();
      controller?.refresh();
    },
    testProfile: (profileId) => semanticGateway.testProfile(profileId),
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
  const token = randomBytes(32).toString("base64url");
  const authenticatedServer = new LocalCaptureServer({
    queue: runtime.queue,
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
    recordJournalEntry: (request) => activeRecordService.create(request),
    prepareDecisionHandoff: (input) => decisionHandoff.prepare(input),
    openDecisionSource: (input) => decisionHandoff.openSource(input),
    saveDecisionContextFeedback: (input) => decisionFeedback.save(input),
    getDecisionContextFeedback: (input) => decisionFeedback.list(input),
    searchContext: (query) => decisionContext.search(query),
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
        )
        .catch(() => undefined);
      // The reader's own preferences and ideas, recalled beside the
      // principles. A failure here must not cost the caller its principles,
      // which are the part it asked for; it is said (null), not taken for none.
      // All of them: the 200 last updated left out an older preference that still stands as soon as newer
      // ideas (or an archiving sweep, which updates them) came in on top of it.
      const journal = await activeRecordService
        .listJournalEntries({ everything: true })
        .catch(() => null);
      const response = buildDecisionConsultation(
        request,
        methodologies,
        recalled,
        journal,
      );
      if (
        request.sourceClient === "claude-code" ||
        request.sourceClient === "codex"
      ) {
        void decisionConsultationMetrics
          .record({
            sourceClient: request.sourceClient,
            response,
            durationMs: Math.max(0, Date.now() - startedAt),
            recordedAt: new Date().toISOString(),
          })
          .catch(() => undefined);
      }
      return request.sourceClient === "claude-code" ||
        request.sourceClient === "codex"
        ? decisionConsultationFeedback.issue(response, request.sourceClient)
        : response;
    },
    submitConsultationFeedback: (feedback) =>
      decisionConsultationFeedback.submit(feedback),
    token,
    smokeMode: readDecisionEnvironment(process.env, "SMOKE") === "1",
    smokeShutdown: () => app.quit(),
  });
  const liquidGlass = loadLiquidGlassRuntime({
    addonPath: liquidGlassAddonPath(),
    platform: process.platform,
    darwinRelease: release(),
  });
  const windows = new WindowManager({
    createWindow: (options: BrowserWindowOptionsLike) => {
      const browserWindow = new BrowserWindow(
        options as BrowserWindowConstructorOptions,
      );
      let surface: LiquidGlassSurface | null = null;
      if (liquidGlass !== null) {
        browserWindow.setVibrancy(null);
        surface = liquidGlass.attach(
          browserWindow.getNativeWindowHandle(),
          "desktop",
        );
        if (surface === null) {
          browserWindow.setVibrancy("under-window");
        }
      }
      return adaptWindow(browserWindow, surface, process.platform === "darwin" ? () => app.isHidden() : undefined);
    },
    screen,
    preloadPath: join(__dirname, "preload.cjs"),
    renderer: rendererLocation(),
    onCloseRequested: () => controller?.closePrimarySurface(),
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
        message: "Decision 的窗口无法显示",
        detail: `显示窗口的进程在一分钟内反复意外退出（${reason}），已停止自动重新加载。捕获仍会照常记下；再次打开 Decision 时会重新加载一次，仍然空白请退出后重启。`,
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
      close: () => watcher.close(),
    },
    index,
    windows,
    runtimeFile: paths.runtime,
    token,
    writeRuntime: writeRuntimeDescriptor,
    onRuntimeUnwritable: (error) => {
      runtime.reportRecoveryIssue(`本机服务信息写不进数据目录（${error instanceof Error ? error.message : String(error)}），智能体暂时连不上 Decision。清出磁盘空间或修好权限后重启 Decision。`);
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
    }),
    integrationStatus: () => integrationStatus,
    pendingRationales: () => runtime.pendingRationales(),
    pendingRationaleCount: () => runtime.pendingRationaleCount(),
    semanticRecognition: () => semanticRecognition,
    modelTraceContentEnabled: () => settings.modelTraceContentEnabled,
    reviewRemindersEnabled: () => settings.reviewRemindersEnabled,
    localCredentialsEnabled: () => settings.localCredentialsEnabled,
    captureClassifier: () => settings.captureClassifier,
    theme: () => settings.theme,
    onSnapshot: (snapshot) => {
      // The rationale asked for now and those waiting behind it are to do as well: "暂无待办" was wrong.
      updateTray(pendingWorkTotal(snapshot), snapshot.dashboard.reviewAttention);
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
    integrationStatus = await detectIntegrationStatus(integrationPaths(), currentBridgeReference());
    controller?.refresh();
  });
  refreshSemanticRecognition();

  registerDecisionIpc({
    ipcMain,
    queue: runtime.queue,
    candidates: runtime.candidates,
    operations: {
      getSnapshot: () => controller.snapshot(),
      openCandidateReview: () => controller.openCandidateReview(),
      closeCandidateReview: () => controller.closeCandidateReview(),
      confirmCandidate: (candidateId) =>
        controller.confirmCandidate(candidateId),
      ignoreCandidate: (candidateId) => controller.ignoreCandidate(candidateId),
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
        const lexical = index.queryDecisions(indexedQuery);
        if (
          query.query.trim().length === 0 ||
          query.searchMode !== "semantic"
        ) {
          return lexical.map((decision) =>
            toDecisionLibraryItem(decision, methodologies),
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
      listJournalEntries: (query) =>
        activeRecordService.listJournalEntries(query),
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
        const saved = await prConnections.save(input);
        // A new token (which any change of site requires) retires what the old one read, and its client.
        if (input.id !== undefined && input.token !== undefined && input.token.length > 0) await prReview.forget(input.id);
        return saved;
      },
      removePrConnection: async (id) => {
        const remaining = await prConnections.remove(id);
        // Its cached PR diffs go with it.
        await prReview.forget(id);
        return remaining;
      },
      checkPrConnection: async (id) => ({ account: await prConnections.account(id) }),
      listPullRequests: (input) => prConnections.pullRequests(input),
      loadPrReviewFile: (input) => prReview.loadFile(input),
      getPrActionContext: (input) => prConnections.actionContext(input),
      performPrAction: (input) => prConnections.performAction(input),
      publishPrReviewComment: (input) => prConnections.publishComment(input),
      publishPrGeneralComment: (input) => prConnections.publishGeneralComment(input),
      listPrDiscussion: async (input) => {
        const { comments, more } = await prConnections.discussion(input);
        return {
          more,
          comments: comments.map((comment) => {
            const url = new URL(comment.url).href;
            // A decision holds at most 8,000 characters; mark the cut rather than hide it.
            return { ...comment, url, author: comment.author.slice(0, 300),
              body: comment.body.length > 8_000 ? `${comment.body.slice(0, 7_999)}…` : comment.body,
              decisionId: index.findByCaptureSemanticKey(prCommentSemanticKey(url))?.id ?? null };
          }),
        };
      },
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
        return decisionAnalyticsService.analyze(
          index.snapshotDecisions(),
          new Map(methodologies.map((item) => [item.id, item.title])),
        );
      },
      getDecisionConsultationMetrics: () =>
        decisionConsultationMetrics.snapshot(),
      previewDecisionConsultation: async (input) => {
        const methodologies = await methodologyService.list();
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
        const nextSettings = withVaultPath(settings, vaultPath);
        await settingsRepository.save(nextSettings);
        settings = nextSettings;
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
      installIntegrations: async (mode) => {
        const bridgePath = bridgeExecutablePath();
        if (mode === "apply" && isTranslocated(bridgePath)) {
          throw new Error("Decision 正从系统临时放置的位置运行（在“下载”里直接打开时会这样），这时连接的客户端会在这个位置被移走后全部失效。请先把 Decision 移到“应用程序”文件夹并重新打开，再连接客户端。");
        }
        // A client's command is found as a terminal finds it: see login-shell-path.ts.
        await loginPathReady;
        try {
          return await installIntegrations({
            mode,
            bridgePath,
            platform: process.platform,
            ...integrationPaths(),
          });
        } finally {
          // Whatever came of it, the cards say what the files now hold: a check finds hooks left naming a
          // moved app, and an attempt that connected one client and not the other is shown as it is.
          integrationStatus = await detectIntegrationStatus(integrationPaths(), currentBridgeReference());
          controller.refresh();
        }
      },
      removeIntegrations: async () => {
        await loginPathReady;
        try {
          return await removeIntegrations({ mode: "apply", bridgePath: bridgeExecutablePath(), platform: process.platform, ...integrationPaths() });
        } finally {
          integrationStatus = await detectIntegrationStatus(integrationPaths(), currentBridgeReference());
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
        const nextSettings = withTheme(settings, theme);
        await settingsRepository.save(nextSettings);
        settings = nextSettings;
        nativeTheme.themeSource = ELECTRON_THEME_SOURCE[theme];
        controller.refresh();
      },
      listModelTraces: () => modelTraces.list(),
      deleteModelTrace: (traceId) => modelTraces.deleteTrace(traceId),
      deleteModelTraceRequest: (requestId) =>
        modelTraces.deleteRequest(requestId),
      // A conversation deleted: its question and the notes it read stayed in the ratings and the call records.
      forgetAssistantTurns: (turnIds) => forgetAssistantTurns(turnIds, assistantFeedback, modelTraces),
      clearModelTraces: () => modelTraces.clear(),
      setModelTraceContentEnabled: async (enabled) => {
        const nextSettings = withModelTraceContentEnabled(settings, enabled);
        await settingsRepository.save(nextSettings);
        settings = nextSettings;
        controller.refresh();
      },
      setLocalCredentialsEnabled: async (enabled) => {
        await providerCredentials.setLocalMode(enabled, async () => {
          const nextSettings = { ...settings, localCredentialsEnabled: enabled };
          await settingsRepository.save(nextSettings);
          settings = nextSettings;
        });
        controller.refresh();
      },
      setReviewRemindersEnabled: async (enabled) => {
        const nextSettings = withReviewRemindersEnabled(settings, enabled);
        await settingsRepository.save(nextSettings);
        settings = nextSettings;
        controller.refresh();
      },
      setCaptureClassifier: async (classifier) => {
        const nextSettings = withCaptureClassifier(settings, classifier);
        await settingsRepository.save(nextSettings);
        settings = nextSettings;
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
  const initialSnapshot = controller.snapshot();
  updateTray(pendingWorkTotal(initialSnapshot), initialSnapshot.dashboard.reviewAttention);
  // A review that came due while the app was closed should say so on startup,
  // not wait for the next snapshot to happen to arrive.
  void reviewReminders.check();
  // Nor one that comes due overnight while the app idles in the tray: a new day refreshes the snapshot,
  // and with it the tray, the home inbox and the reminders (new-day.ts).
  const newDay = watchForNewDay(() => controller.refresh());
  powerMonitor.on("resume", () => newDay.check());

  let shutdownStarted = false;
  app.on("before-quit", (event) => {
    if (shutdownStarted) {
      return;
    }
    event.preventDefault();
    shutdownStarted = true;
    newDay.stop();
    prReview.cancel();
    // Cut short with the rest: an assistant turn under way, and every model process (started detached, a CLI call
    // ran on after the quit, billed, for nobody).
    for (const turn of assistantTurns.values()) turn.abort();
    stopManagedProcesses();
    void shutdownApplication({
      closeObsidian: () => obsidianSearch.close(),
      ...(readDecisionEnvironment(process.env, "SMOKE") === "1"
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
      stopController: async () => { await localRecordTail; await controller.stop(); localDecisions.close(); },
    })
      .finally(() => {
        trayLifecycle.dispose();
        app.quit();
      });
  });
  app.on("window-all-closed", () => undefined);
  process.once("SIGTERM", () => app.quit());
  process.once("SIGINT", () => app.quit());
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
    void candidateSpool.list().catch(() => undefined);
  };
  sweepRetention();
  setInterval(sweepRetention, 24 * 60 * 60 * 1_000).unref();
  // The day's timer runs only while the Mac is awake: one asleep most of the week swept days late.
  powerMonitor.on("resume", sweepRetention);
  try {
    obsidianSearch.start();
  } catch {
    // Obsidian search is optional and cannot interrupt Decision startup.
  }
  void methodologyService
    .list()
    .then((methodologies) => semanticSearch.synchronize(indexedDecisions, methodologies))
    .catch(() => undefined);
  // An agent's first search otherwise found a large vault unread, ran out of time and answered with part of it.
  void decisionContext.warm().catch(() => undefined);
  if (
    readDecisionEnvironment(process.env, "SMOKE") === "1" &&
    readDecisionEnvironment(process.env, "START_SETTINGS") === "1"
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
        process.stderr.write(`Decision failed to start: ${reason}\n`);
        // Opened from the Dock, the app otherwise just vanished, with the reason in a log nobody sees.
        if (readDecisionEnvironment(process.env, "SMOKE") !== "1") {
          dialog.showErrorBox("Decision 无法启动", reason);
        }
        app.exit(1);
      });
  }
}
