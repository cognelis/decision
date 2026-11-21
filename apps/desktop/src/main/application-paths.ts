import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";

import { readParaselfEnvironment } from "../../../../config/paraself-environment.mjs";
import {
  resolveUserData,
  type UserDataResolution,
  type UserDataResolutionOptions,
} from "../../../../config/user-data-directory.mjs";

export type { UserDataResolution } from "../../../../config/user-data-directory.mjs";

export const applicationSupportPaths = (
  userData: string,
  environment: NodeJS.ProcessEnv = process.env,
) => ({
  settings: join(userData, "settings.json"),
  runtime:
    readParaselfEnvironment(environment, "RUNTIME_FILE") ??
    join(userData, "runtime.json"),
  index: join(userData, "index.sqlite"),
  localDecisions: join(userData, "local-decisions.sqlite"),
  obsidianSearchRoot: resolve(userData, "obsidian-search"),
  obsidianSearchShutdownMarker: resolve(
    userData,
    "obsidian-search",
    "shutdown-complete.json",
  ),
  semanticVectors: join(userData, "semantic-vectors.sqlite"),
  spool:
    readParaselfEnvironment(environment, "CAPTURE_SPOOL") ??
    join(userData, "capture-spool"),
  candidateSpool:
    readParaselfEnvironment(environment, "CANDIDATE_SPOOL") ??
    join(userData, "candidate-spool"),
  semanticPairSpool:
    readParaselfEnvironment(environment, "SEMANTIC_PAIR_SPOOL") ??
    join(userData, "semantic-pair-spool"),
  captureAudit:
    readParaselfEnvironment(environment, "CAPTURE_AUDIT") ??
    join(userData, "capture-audit"),
  modelTraces:
    readParaselfEnvironment(environment, "MODEL_TRACES") ??
    join(userData, "model-traces"),
  // jev's calls, kept apart: 90 days and their content always (IMP-166).
  decisionModelCalls: join(userData, "decision-model-calls"),
  modelProviderProfiles: join(userData, "model-provider-profiles.json"),
  modelProviderCredentials: join(userData, "model-provider-credentials"),
  models: join(userData, "models"),
  practicePublications: join(userData, "practice-publications"),
  practiceAssetHistory: join(userData, "practice-asset-history"),
  methodologyHistory: join(userData, "methodology-history"),
  // Each todo list's history of changes, kept here and not in its note (IMP-185).
  todoHistory: join(userData, "todo-history"),
  // 历史决定的本机索引与变更历史：自己的文件，不进 index.sqlite（那份会被整体重建替换）。
  historicalDecisions: join(userData, "historical-decisions.sqlite"),
  // 整理与记忆（IMP-191）：建议、拒绝回执、游标与注记，只在这台电脑上，不能从仓库重建。
  organization: join(userData, "organization", "state.json"),
  methodologySuggestionPreferences: join(
    userData,
    "methodology-suggestion-preferences.json",
  ),
  decisionConsultationMetrics: join(
    userData,
    "decision-consultation-metrics.json",
  ),
  assistantFeedback: join(userData, "assistant-feedback.json"),
  misrecognitionReceipts: join(userData, "misrecognition-receipts.json"),
  reviewReminders: join(userData, "review-reminders.json"),
  manualFormDrafts: join(userData, "manual-form-drafts.json"),
  // 提示词（PRM-I1）：只在这台电脑上，不进 Vault，所以不会被当作笔记、决策或原则召回。
  prompts: join(userData, "prompts.json"),
  // 评审评测集：每个仓库一个文件，只在这台电脑上；不进 Vault，免得笔记检索把留出集的答案交给 agent。
  reviewBenchmark: join(userData, "review-benchmark"),
  // 评审历史：一条记录一个文件；以前在评审页的 localStorage 里，第一次读取时搬过来。
  prReviewHistory: join(userData, "pr-review-history"),
  // The clients the reader added on the 接入 page: read by the bridge as well, from the same place.
  customClients:
    readParaselfEnvironment(environment, "CUSTOM_CLIENTS") ??
    join(userData, "custom-clients.json"),
  // 接入新工具 probes: their markers, and what the bridge recorded under them. Read by the bridge as well.
  clientProbes:
    readParaselfEnvironment(environment, "CLIENT_PROBES") ??
    join(userData, "client-probes"),
});

export interface ElectronPathConfigurator {
  setPath(name: "userData", path: string): void;
}

interface ObsidianConfigurationPathOptions {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  appData?: string;
  xdgConfigHome?: string;
}

export const resolveObsidianConfigurationPath = (
  options: ObsidianConfigurationPathOptions = {},
): string => {
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();
  const paths = platform === "win32" ? win32 : posix;
  if (platform === "win32") {
    const applicationData =
      options.appData ??
      process.env.APPDATA ??
      paths.join(homeDirectory, "AppData", "Roaming");
    return paths.join(applicationData, "obsidian", "obsidian.json");
  }
  if (platform === "darwin") {
    return paths.join(
      homeDirectory,
      "Library",
      "Application Support",
      "obsidian",
      "obsidian.json",
    );
  }
  const configurationHome =
    options.xdgConfigHome ??
    process.env.XDG_CONFIG_HOME ??
    paths.join(homeDirectory, ".config");
  return paths.join(configurationHome, "obsidian", "obsidian.json");
};

/**
 * A first run's vault, in the Documents folder the system names: on Windows often moved into OneDrive,
 * where a "Documents" made beside it in the home folder was one the user never opened. One made there as
 * Decision's first-run vault, with none of the new name, is kept rather than a new empty one started (its
 * settings lost, say): the vault a reader chose is never this.
 */
export const resolveDefaultVaultPath = (
  documentsDirectory: string,
  exists: (path: string) => boolean = existsSync,
): string => {
  const current = join(documentsDirectory, "Paraself Vault");
  const legacy = join(documentsDirectory, "Decision Vault");
  return exists(current) || !exists(legacy) ? current : legacy;
};

/** The data folder, moved from Decision's once before Electron or anything else here touches it (resolveUserData). */
export const configureElectronUserDataPath = (
  application: ElectronPathConfigurator,
  environment: NodeJS.ProcessEnv = process.env,
  options: UserDataResolutionOptions = {},
): UserDataResolution => {
  const resolution = resolveUserData(environment, options);
  application.setPath("userData", resolution.path);
  return resolution;
};
