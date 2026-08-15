import {
  existsSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";

import { readDecisionEnvironmentWithSource } from "../../../../config/decision-environment.mjs";

export interface ElectronPathConfigurator {
  setPath(name: "userData", path: string): void;
}

export interface UserDataFileSystem {
  existsSync(path: string): boolean;
  renameSync(source: string, destination: string): void;
  writeFileSync(
    path: string,
    data: string,
    options: { encoding: "utf8"; mode: number },
  ): void;
}

export type UserDataMigrationState =
  | "explicit"
  | "current"
  | "migrated"
  | "legacy-fallback"
  | "conflict";

export interface UserDataResolution {
  path: string;
  state: UserDataMigrationState;
  environmentSource: "current" | "legacy" | "default";
  migrationError?: string;
}

interface UserDataResolutionOptions {
  fileSystem?: UserDataFileSystem;
  homeDirectory?: string;
  now?: () => string;
  platform?: NodeJS.Platform;
}

const defaultFileSystem: UserDataFileSystem = {
  existsSync,
  renameSync,
  writeFileSync,
};

const defaultDirectories = (
  platform: NodeJS.Platform,
  homeDirectory: string,
  environment: NodeJS.ProcessEnv,
): { current: string; legacy: string } => {
  const paths = platform === "win32" ? win32 : posix;
  if (platform === "darwin") {
    const applicationSupport = paths.join(
      homeDirectory,
      "Library",
      "Application Support",
    );
    return {
      current: paths.join(applicationSupport, "Decision"),
      legacy: paths.join(applicationSupport, "Decision Island"),
    };
  }
  if (platform === "win32") {
    const applicationData =
      environment.APPDATA ?? paths.join(homeDirectory, "AppData", "Roaming");
    return {
      current: paths.join(applicationData, "Decision"),
      legacy: paths.join(applicationData, "Decision Island"),
    };
  }
  const configurationHome =
    environment.XDG_CONFIG_HOME ?? paths.join(homeDirectory, ".config");
  return {
    current: paths.join(configurationHome, "decision"),
    legacy: paths.join(configurationHome, "decision-island"),
  };
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

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const resolveDefaultDecisionVaultPath = (
  homeDirectory: string = homedir(),
  pathExists: (path: string) => boolean = existsSync,
): string => {
  const current = join(homeDirectory, "Documents", "Decision Vault");
  const legacy = join(homeDirectory, "Documents", "Decision Island Vault");
  return pathExists(current) || !pathExists(legacy) ? current : legacy;
};

export const resolveDecisionUserData = (
  environment: NodeJS.ProcessEnv = process.env,
  options: UserDataResolutionOptions = {},
): UserDataResolution => {
  const override = readDecisionEnvironmentWithSource(environment, "USER_DATA");
  if (override.value !== undefined) {
    return {
      environmentSource: override.source,
      path: override.value,
      state: "explicit",
    };
  }

  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const directories = defaultDirectories(
    options.platform ?? process.platform,
    options.homeDirectory ?? homedir(),
    environment,
  );
  const currentExists = fileSystem.existsSync(directories.current);
  const legacyExists = fileSystem.existsSync(directories.legacy);

  if (currentExists && legacyExists) {
    return {
      environmentSource: "default",
      path: directories.current,
      state: "conflict",
    };
  }
  if (currentExists || !legacyExists) {
    return {
      environmentSource: "default",
      path: directories.current,
      state: "current",
    };
  }

  try {
    fileSystem.renameSync(directories.legacy, directories.current);
  } catch (error) {
    return {
      environmentSource: "default",
      migrationError: errorMessage(error),
      path: directories.legacy,
      state: "legacy-fallback",
    };
  }

  try {
    fileSystem.writeFileSync(
      join(directories.current, ".cognelis-migration-v1.json"),
      `${JSON.stringify({
        migratedAt: (options.now ?? (() => new Date().toISOString()))(),
        sourceDirectory: "Decision Island",
        targetDirectory: "Decision",
        version: 1,
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    // The directory rename is the atomic migration boundary. A diagnostic
    // marker failure must not make the App look for data at the old path.
  }

  return {
    environmentSource: "default",
    path: directories.current,
    state: "migrated",
  };
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
