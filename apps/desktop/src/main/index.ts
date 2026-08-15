import { installIntegrations } from "@cognelis/decision-integrations";
import squirrelStartup from "electron-squirrel-startup";
import {
  assessMethodologyQuality,
  assessPracticeAssetFreshness,
  buildMethodologyBuildProgress,
  buildMethodologyRecall,
  buildMethodologyEvidenceMatches,
  buildMethodologySuggestions,
  comparePracticeAssetSources,
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
} from "@cognelis/decision-protocol";
import {
  CandidateSpool,
  CaptureAuditStore,
  CaptureSpool,
  DecisionStore,
  DecisionWatcher,
  MarkdownRepository,
  MethodologyRelationRepository,
  MethodologyRepository,
  ModelTraceStore,
  PracticeAssetRepository,
  SemanticPairSpool,
  SemanticVectorIndex,
  SqliteIndex,
  type IndexedDecision,
} from "@cognelis/decision-storage";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  safeStorage,
  screen,
  Tray,
  type BrowserWindowConstructorOptions,
} from "electron";
import { randomBytes, randomUUID } from "node:crypto";
import { homedir, release } from "node:os";
import { join } from "node:path";

import { readDecisionEnvironment } from "../../../../config/decision-environment.mjs";

import { AppController } from "./app-controller.js";
import {
  configureElectronUserDataPath,
  resolveDefaultDecisionVaultPath,
  resolveObsidianConfigurationPath,
  type UserDataResolution,
} from "./application-paths.js";
import { CaptureRuntime } from "./capture-runtime.js";
import { resolveBridgeExecutablePath } from "./bridge-path.js";
import { readDashboardSnapshot } from "./dashboard-snapshot.js";
import { DecisionAnalyticsService } from "./decision-analytics-service.js";
import { DecisionConsultationFeedbackService } from "./decision-consultation-feedback-service.js";
import { DecisionConsultationMetricsStore } from "./decision-consultation-metrics-store.js";
import { buildDecisionConsultation } from "./decision-consultation-service.js";
import { detectIntegrationStatus } from "./integration-status.js";
import { registerDecisionIpc } from "./ipc.js";
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
import { LocalModelClientDiscovery } from "./model/cli/cli-discovery.js";
import { ModelProviderError } from "./model/http-model-transport.js";
import { ModelProviderService } from "./model/model-provider-service.js";
import { ProfiledModelGateway } from "./model/profiled-model-gateway.js";
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
  writeRuntimeDescriptor,
} from "./runtime-file.js";
import {
  discoverObsidianVaults,
  SettingsRepository,
  withModelTraceContentEnabled,
  withVaultPath,
  withTheme,
} from "./settings.js";
import { configureTray, TrayLifecycle } from "./tray.js";
import {
  WindowManager,
  type BrowserWindowLike,
  type BrowserWindowOptionsLike,
} from "./window-manager.js";
import type {
  DecisionLibraryItem,
  DecisionAppliedPrinciple,
  MethodologyItem,
  MethodologyVersionItem,
  PracticeAssetItem,
  PracticeAssetVersionItem,
} from "../shared/renderer-api.js";

const applicationSupportPaths = (
  userData: string,
  environment: NodeJS.ProcessEnv = process.env,
) => {
  return {
    settings: join(userData, "settings.json"),
    runtime:
      readDecisionEnvironment(environment, "RUNTIME_FILE") ??
      join(userData, "runtime.json"),
    index: join(userData, "index.sqlite"),
    semanticVectors: join(userData, "semantic-vectors.sqlite"),
    spool:
      readDecisionEnvironment(environment, "CAPTURE_SPOOL") ??
      join(userData, "capture-spool"),
    candidateSpool:
      readDecisionEnvironment(environment, "CANDIDATE_SPOOL") ??
      join(userData, "candidate-spool"),
    semanticPairSpool:
      readDecisionEnvironment(environment, "SEMANTIC_PAIR_SPOOL") ??
      join(userData, "semantic-pair-spool"),
    captureAudit:
      readDecisionEnvironment(environment, "CAPTURE_AUDIT") ??
      join(userData, "capture-audit"),
    modelTraces:
      readDecisionEnvironment(environment, "MODEL_TRACES") ??
      join(userData, "model-traces"),
    modelProviderProfiles: join(userData, "model-provider-profiles.json"),
    modelProviderCredentials: join(userData, "model-provider-credentials"),
    models: join(userData, "models"),
    practicePublications: join(userData, "practice-publications"),
    practiceAssetHistory: join(userData, "practice-asset-history"),
    methodologyHistory: join(userData, "methodology-history"),
    methodologySuggestionPreferences: join(
      userData,
      "methodology-suggestion-preferences.json",
    ),
    decisionConsultationMetrics: join(
      userData,
      "decision-consultation-metrics.json",
    ),
    manualFormDrafts: join(userData, "manual-form-drafts.json"),
  };
};

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
  outcome: decision.outcome,
  reviewDueDate: decision.reviewDueDate,
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

const toMethodologyItem = (
  record: MethodologyRecord,
  index: SqliteIndex,
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

const adaptWindow = (
  window: BrowserWindow,
  nativeGlass: LiquidGlassSurface | null,
): BrowserWindowLike => ({
  nativeGlassActive: nativeGlass !== null,
  webContents: {
    on: (_event, listener) => {
      window.webContents.on("will-navigate", (event) => listener(event));
    },
    setWindowOpenHandler: (handler) => {
      window.webContents.setWindowOpenHandler(() => handler());
    },
    send: (channel, value) => {
      window.webContents.send(channel, value);
    },
  },
  loadURL: (url) => window.loadURL(url),
  loadFile: (path, options) => window.loadFile(path, options),
  on: (_event, listener) => {
    window.on("close", (event) => listener(event));
  },
  show: () => window.show(),
  focus: () => window.focus(),
  hide: () => window.hide(),
  setNativeSurfaceMode: (mode) => nativeGlass?.update(mode),
  isDestroyed: () => window.isDestroyed(),
});

const bridgeExecutablePath = (): string =>
  resolveBridgeExecutablePath({
    packaged: app.isPackaged,
    platform: process.platform,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });

const trayIconPath = (): string =>
  app.isPackaged
    ? join(process.resourcesPath, "assets", "trayTemplate.png")
    : join(app.getAppPath(), "apps", "desktop", "assets", "trayTemplate.png");

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

const bootstrap = async (
  userDataResolution: UserDataResolution,
): Promise<void> => {
  const paths = applicationSupportPaths(userDataResolution.path);
  const settingsRepository = new SettingsRepository(paths.settings);
  const integrationPaths = {
    claudeSettingsPath: join(homedir(), ".claude", "settings.json"),
    codexHooksPath: join(homedir(), ".codex", "hooks.json"),
  };
  let integrationStatus = await detectIntegrationStatus(integrationPaths);
  let settings = await settingsRepository.load();
  const configuredVault = readDecisionEnvironment(
    process.env,
    "VAULT_PATH",
  );
  if (configuredVault !== undefined) {
    settings = withVaultPath(settings, configuredVault);
  } else if (settings.vaultPath === null) {
    const discovered = await discoverObsidianVaults(
      resolveObsidianConfigurationPath(),
    ).catch(() => []);
    settings = withVaultPath(
      settings,
      discovered[0] ?? resolveDefaultDecisionVaultPath(homedir()),
    );
    await settingsRepository.save(settings);
  }

  const vaultPath = settings.vaultPath;
  if (vaultPath === null) {
    throw new Error("Decision could not resolve a vault path");
  }
  nativeTheme.themeSource = ELECTRON_THEME_SOURCE[settings.theme];
  const repository = new MarkdownRepository(vaultPath);
  const methodologyRepository = new MethodologyRepository(vaultPath);
  const methodologyRelationRepository = new MethodologyRelationRepository(
    vaultPath,
  );
  const practiceAssetRepository = new PracticeAssetRepository(vaultPath);
  const index = new SqliteIndex(paths.index);
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
  );
  const localClientDiscovery = new LocalModelClientDiscovery();
  let localClientStatuses: LocalModelClientStatus[] = [];
  const refreshLocalClientStatuses = async (): Promise<
    LocalModelClientStatus[]
  > => {
    const profiles = await providerProfiles.load();
    const codex = profiles.find((profile) => profile.kind === "codex-cli");
    const claude = profiles.find(
      (profile) => profile.kind === "claude-code-cli",
    );
    const statuses = await Promise.all([
      localClientDiscovery.inspect("codex", codex?.executablePath),
      localClientDiscovery.inspect("claude-code", claude?.executablePath),
    ]);
    await providerProfiles.refreshLocalClients(statuses);
    localClientStatuses = statuses;
    return statuses;
  };
  await refreshLocalClientStatuses();
  const store = new DecisionStore(repository, index);
  const runtime = new CaptureRuntime({
    spool,
    candidateSpool,
    store,
    index,
    idFactory: randomUUID,
  });
  await runtime.rebuildIndex();
  const pendingCaptures = await spool.list();
  runtime.reportRecoveryIssue(spool.recoveryIssue());
  await runtime.resumeCandidates(await candidateSpool.list(), pendingCaptures);
  for (const event of pendingCaptures) {
    await runtime.ingest(event);
  }
  await runtime.resumePendingDispositions();
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
            "unsupported_client",
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
  const semanticSearch = new SemanticSearchService({
    vectors: new SemanticVectorIndex(paths.semanticVectors),
    gateway: new QwenEmbeddingProvider({
      modelsDirectory: paths.models,
    }),
  });
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
    const evidence = index.snapshotDecisions().flatMap((decision) => {
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
    return buildMethodologySuggestions(evidence, records, 12);
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
    },
  );
  const practicePublicationService = new PracticePublicationService({
    assets: practiceAssetRepository,
    stateRoot: paths.practicePublications,
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
  let semanticRefresh: Promise<void> | undefined;
  const refreshSemanticRecognition = (): void => {
    semanticRefresh ??= semanticGateway
      .status()
      .then((status) => {
        semanticRecognition = status;
        controller?.refresh();
      })
      .catch(() => undefined)
      .finally(() => {
        semanticRefresh = undefined;
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
  await semanticPairInbox.recover();
  const watcher = new DecisionWatcher(
    repository,
    index,
    () => undefined,
    () => controller?.refresh(),
  );
  const token = randomBytes(32).toString("base64url");
  const authenticatedServer = new LocalCaptureServer({
    queue: runtime.queue,
    ingest: (event) => runtime.ingest(event),
    ingestCandidate: (candidate) => runtime.ingestCandidate(candidate),
    ingestSemanticPair: async (pair) => {
      await semanticPairInbox.enqueue(pair);
    },
    consult: async (request) => {
      const startedAt = Date.now();
      const methodologies = await methodologyService.list();
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
      const response = buildDecisionConsultation(
        request,
        methodologies,
        recalled,
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
      return adaptWindow(browserWindow, surface);
    },
    screen,
    preloadPath: join(__dirname, "preload.cjs"),
    renderer: rendererLocation(),
    onCloseRequested: () => controller?.closePrimarySurface(),
  });
  let updateTray = (_pendingCount: number): void => undefined;
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
    removeRuntime: removeRuntimeDescriptor,
    vaultPath,
    health: () => runtime.health(),
    dashboard: () =>
      readDashboardSnapshot(index, new Date(), () => {
        runtime.reportIndexIssue(
          "SQLite 索引读取失败；请在设置中重建全文索引。",
        );
      }),
    integrationStatus: () => integrationStatus,
    pendingRationales: () => runtime.pendingRationales(),
    semanticRecognition: () => semanticRecognition,
    modelTraceContentEnabled: () => settings.modelTraceContentEnabled,
    theme: () => settings.theme,
    onSnapshot: (snapshot) =>
      updateTray(
        snapshot.decisionCandidates.count +
          snapshot.pendingRationales.length +
          snapshot.dashboard.reviewAttention,
      ),
  });
  openDesktopApplication = () => {
    windows.show();
    controller?.openSurface("dashboard");
  };
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
      retryCandidate: () => runtime.retryCurrentCandidate(),
      openSurface: (surface) => controller.openSurface(surface),
      closePrimarySurface: () => controller.closePrimarySurface(),
      listDecisions: async (query) => {
        const methodologies = await methodologyService.list();
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
        const candidates = index.queryDecisions({
          ...indexedQuery,
          query: "",
          limit: 200,
        });
        const matches = await semanticSearch
          .searchDecisions({
            query: query.query,
            candidates,
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
      updateDecisionOutcome: async (decisionId, outcome) => {
        const result = await store.updateOutcome(decisionId, outcome);
        if (!result.indexed) {
          runtime.reportIndexIssue(
            "结果已写入 Markdown，但 SQLite 索引更新失败；请在设置中重建全文索引。",
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
            "复盘日期已写入 Markdown，但 SQLite 索引更新失败；请在设置中重建全文索引。",
          );
        }
        controller.refresh();
      },
      updateDecisionReview: async (decisionId, input) => {
        const reviewedAt = new Date().toISOString();
        const result = await store.updateOutcomeReview(decisionId, {
          ...input,
          reviewedAt,
        });
        if (!result.indexed) {
          runtime.reportIndexIssue(
            "复盘已写入 Markdown，但 SQLite 索引更新失败；请在设置中重建全文索引。",
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
            "方法论采用关系已写入 Markdown，但 SQLite 索引更新失败；请在设置中重建全文索引。",
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
          index.snapshotDecisions(),
          methodologies,
          practiceAssets,
        );
      },
      listMethodologies: async (status) => {
        const [records, relations] = await Promise.all([
          methodologyService.list(),
          methodologyService.listRelations(),
        ]);
        return records
          .filter((record) => status === undefined || record.status === status)
          .map((record) =>
            toMethodologyItem(record, index, records, relations),
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
      reviseMethodology: async (id, input) => {
        const record = await methodologyService.revise(id, input);
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
        const { active } = await getMethodologySuggestionPartition();
        return active.slice(0, 6);
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
        const evidence = index
          .queryDecisions({
            query: "",
            reviewState: "reviewed",
            limit: 200,
            asOfDate: localCalendarDate(new Date()),
          })
          .flatMap((decision) => {
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
        return buildMethodologyEvidenceMatches(record, evidence);
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
        return buildMethodologyUsageSnapshot(id, index.snapshotDecisions());
      },
      getMethodologyValidationInbox: async () =>
        buildMethodologyValidationInbox(
          await methodologyService.list(),
          index.snapshotDecisions(),
        ),
      acknowledgeMethodologyValidation: async (id) => {
        const records = await methodologyService.list();
        const item = buildMethodologyValidationInbox(
          records,
          index.snapshotDecisions(),
        ).find((candidate) => candidate.principleId === id);
        if (item === undefined || item.decisions[0] === undefined) {
          throw new Error("这条原则目前没有待复验的采用结果。");
        }
        if (item.revisionDraftId !== null) {
          throw new Error("这条原则已有待确认修订，请先处理修订草案。");
        }
        const newest = item.decisions[0];
        const record = await methodologyService.acknowledgeUsageValidation(id, {
          reviewedAt: newest.reviewedAt,
          decisionId: newest.id,
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
      getDecisionAnalytics: async () =>
        decisionAnalyticsService.analyze(index.snapshotDecisions()),
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
        const [records, relations] = await Promise.all([
          methodologyService.list("accepted"),
          methodologyService.listRelations(),
        ]);
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
      revisePracticeAsset: async (id, input) => {
        const record = await practiceAssetService.revise(id, input);
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
      installIntegrations: async (mode) => {
        const report = await installIntegrations({
          mode,
          bridgePath: bridgeExecutablePath(),
          platform: process.platform,
          ...integrationPaths,
        });
        if (mode === "apply") {
          integrationStatus = await detectIntegrationStatus(integrationPaths);
          controller.openSurface("clients");
        }
        return report;
      },
      rebuildIndex: async () => {
        const report = await runtime.rebuildIndex();
        await semanticSearch
          .synchronize(
            index.snapshotDecisions(),
            await methodologyService.list(),
          )
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
      clearModelTraces: () => modelTraces.clear(),
      setModelTraceContentEnabled: async (enabled) => {
        const nextSettings = withModelTraceContentEnabled(settings, enabled);
        await settingsRepository.save(nextSettings);
        settings = nextSettings;
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
      listLocalModelClientStatuses: () => refreshLocalClientStatuses(),
      completeDeferredRationale: async (id, input) => {
        await runtime.completeDeferredRationale(id, input);
        controller.refresh();
      },
      skipDeferredRationale: async (id) => {
        await runtime.skipDeferredRationale(id);
        controller.refresh();
      },
      discardDeferredRationale: async (id) => {
        await runtime.discardDeferredRationale(id);
        controller.refresh();
      },
    },
  });

  const trayImage = nativeImage.createFromPath(trayIconPath());
  const tray = trayLifecycle.attach(new Tray(trayImage));
  updateTray = (pendingCount) => {
    configureTray({
      tray,
      image: trayImage,
      buildMenu: (template) => Menu.buildFromTemplate(template),
      pendingCount,
      openDashboard: () => {
        windows.show();
        controller.openSurface("dashboard");
      },
      openSettings: () => controller.openSurface("settings"),
      quit: () => app.quit(),
    });
  };
  const initialSnapshot = controller.snapshot();
  updateTray(
    initialSnapshot.decisionCandidates.count +
      initialSnapshot.pendingRationales.length,
  );

  let shutdownStarted = false;
  app.on("before-quit", (event) => {
    if (shutdownStarted) {
      return;
    }
    event.preventDefault();
    shutdownStarted = true;
    void semanticPairInbox
      .flush()
      .catch(() => undefined)
      .then(() => semanticCoordinator.close())
      .catch(() => undefined)
      .then(() => semanticSearch.close())
      .catch(() => undefined)
      .then(() => controller.stop())
      .finally(() => {
        trayLifecycle.dispose();
        app.quit();
      });
  });
  app.on("window-all-closed", () => undefined);
  process.once("SIGTERM", () => app.quit());
  process.once("SIGINT", () => app.quit());
  await controller.start();
  void methodologyService
    .list()
    .then((methodologies) =>
      semanticSearch.synchronize(
        index.snapshotDecisions(),
        methodologies,
      ),
    )
    .catch(() => undefined);
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
        process.stderr.write(
          `Decision failed to start: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
        app.exit(1);
      });
  }
}
