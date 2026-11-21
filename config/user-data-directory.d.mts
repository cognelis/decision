import type { ParaselfEnvironmentSource } from "./paraself-environment.mjs";

export interface UserDataDirectories {
  current: string;
  /** Where it was as Decision. */
  legacy: string;
}

export declare const userDataDirectories: (
  platform?: NodeJS.Platform,
  homeDirectory?: string,
  environment?: NodeJS.ProcessEnv,
) => UserDataDirectories;

export interface UserDataResolution {
  path: string;
  /**
   * explicit: named by PARASELF_USER_DATA (or DECISION_USER_DATA); migrated: moved from Decision's folder just now;
   * legacy: still Decision's folder (not moved, or the move failed: `migrationError`).
   */
  state: "explicit" | "current" | "migrated" | "legacy";
  environmentSource: ParaselfEnvironmentSource;
  /** Why the move from Decision's folder failed: tried again at the next start. */
  migrationError?: string;
}

export interface UserDataFileSystem {
  existsSync(path: string): boolean;
  renameSync(source: string, destination: string): void;
}

export interface UserDataResolutionOptions {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  /** false: only find which folder holds the data, moving nothing (a script). */
  migrate?: boolean;
  fileSystem?: UserDataFileSystem;
}

export declare const resolveUserData: (
  environment?: NodeJS.ProcessEnv,
  options?: UserDataResolutionOptions,
) => UserDataResolution;
