import { homedir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";

import {
  readDecisionEnvironment,
  readDecisionEnvironmentWithSource,
} from "../../../../config/decision-environment.mjs";

export const applicationSupportPaths = (
  userData: string,
  environment: NodeJS.ProcessEnv = process.env,
) => ({
  settings: join(userData, "settings.json"),
  runtime:
    readDecisionEnvironment(environment, "RUNTIME_FILE") ??
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
  assistantFeedback: join(userData, "assistant-feedback.json"),
  reviewReminders: join(userData, "review-reminders.json"),
  manualFormDrafts: join(userData, "manual-form-drafts.json"),
});

export interface ElectronPathConfigurator {
  setPath(name: "userData", path: string): void;
}

export interface UserDataResolution {
  path: string;
  state: "explicit" | "current";
  environmentSource: "current" | "default";
}

interface UserDataResolutionOptions {
  homeDirectory?: string;
  platform?: NodeJS.Platform;
}

const defaultDirectory = (platform: NodeJS.Platform, homeDirectory: string, environment: NodeJS.ProcessEnv): string => {
  if (platform === "darwin") return posix.join(homeDirectory, "Library", "Application Support", "Decision");
  if (platform === "win32") return win32.join(environment.APPDATA ?? win32.join(homeDirectory, "AppData", "Roaming"), "Decision");
  return posix.join(environment.XDG_CONFIG_HOME ?? posix.join(homeDirectory, ".config"), "decision");
};

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
 * where a "Documents" made beside it in the home folder was one the user never opened.
 */
export const resolveDefaultDecisionVaultPath = (documentsDirectory: string): string =>
  join(documentsDirectory, "Decision Vault");

export const resolveDecisionUserData = (
  environment: NodeJS.ProcessEnv = process.env,
  options: UserDataResolutionOptions = {},
): UserDataResolution => {
  const override = readDecisionEnvironmentWithSource(environment, "USER_DATA");
  return override.value === undefined
    ? { environmentSource: "default", path: defaultDirectory(options.platform ?? process.platform, options.homeDirectory ?? homedir(), environment), state: "current" }
    : { environmentSource: "current", path: override.value, state: "explicit" };
};

export const configureElectronUserDataPath = (
  application: ElectronPathConfigurator,
  environment: NodeJS.ProcessEnv = process.env,
  options: UserDataResolutionOptions = {},
): UserDataResolution => {
  const resolution = resolveDecisionUserData(environment, options);
  application.setPath("userData", resolution.path);
  return resolution;
};
