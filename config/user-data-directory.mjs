import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

import { readParaselfEnvironmentWithSource } from "./paraself-environment.mjs";

/**
 * The App's data folder under the platform's application data, by its name now and by the one it had as Decision, in
 * the same parent: the App, the bridge and the scripts all find it here.
 */
export const userDataDirectories = (
  platform = process.platform,
  homeDirectory = homedir(),
  environment = process.env,
) => {
  if (platform === "darwin") {
    const parent = posix.join(homeDirectory, "Library", "Application Support");
    return { current: posix.join(parent, "Paraself"), legacy: posix.join(parent, "Decision") };
  }
  if (platform === "win32") {
    const parent = environment.APPDATA ?? win32.join(homeDirectory, "AppData", "Roaming");
    return { current: win32.join(parent, "Paraself"), legacy: win32.join(parent, "Decision") };
  }
  const parent = environment.XDG_CONFIG_HOME ?? posix.join(homeDirectory, ".config");
  return { current: posix.join(parent, "paraself"), legacy: posix.join(parent, "decision") };
};

/**
 * The data folder, moved once from where it was as Decision: renamed whole within its parent, one step, nothing
 * copied, merged or deleted. One of the new name already there is the one used, and the old one is left as it is.
 * Named outright (PARASELF_USER_DATA, or DECISION_USER_DATA), nothing is moved. A move another process made first is
 * that process's; one that failed otherwise keeps to the old folder, `migrationError` saying why, so nothing is
 * written into an empty new folder beside the data. `migrate: false` (a script) only finds which of the two holds it.
 */
export const resolveUserData = (environment = process.env, options = {}) => {
  const override = readParaselfEnvironmentWithSource(environment, "USER_DATA");
  if (override.value !== undefined) {
    return { path: override.value, state: "explicit", environmentSource: override.source };
  }
  const fileSystem = options.fileSystem ?? { existsSync, renameSync };
  const { current, legacy } = userDataDirectories(
    options.platform ?? process.platform,
    options.homeDirectory ?? homedir(),
    environment,
  );
  const found = (path, state, migrationError) => ({
    path,
    state,
    environmentSource: "default",
    ...(migrationError === undefined ? {} : { migrationError }),
  });
  const moved = () => fileSystem.existsSync(current) || !fileSystem.existsSync(legacy);
  if (moved()) return found(current, "current");
  if (options.migrate === false) return found(legacy, "legacy");
  try {
    fileSystem.renameSync(legacy, current);
    return found(current, "migrated");
  } catch (error) {
    // The App or a hook at the same moment moved it, or made the new folder, first: the new one is the one now.
    if (moved()) return found(current, "current");
    return found(legacy, "legacy", error instanceof Error ? error.message : String(error));
  }
};
