import { readFile } from "node:fs/promises";
import { posix, win32 } from "node:path";

import { atomicWrite } from "./atomic-write.js";

/**
 * Whether the app runs from where macOS put it for this launch only (opened in Downloads, not moved): a
 * bridge path given to the clients from there stops working once the system takes it away, at the latest
 * on restart, and every hook with it.
 */
export const isTranslocated = (path: string): boolean => path.includes("/AppTranslocation/");

interface BridgeExecutablePathOptions {
  packaged: boolean;
  platform: NodeJS.Platform;
  resourcesPath: string;
  appPath: string;
}

export const resolveBridgeExecutablePath = ({
  packaged,
  platform,
  resourcesPath,
  appPath,
}: BridgeExecutablePathOptions): string => {
  const paths = platform === "win32" ? win32 : posix;
  if (!packaged) {
    return paths.join(appPath, "apps", "bridge", "src", "cli.ts");
  }
  return paths.join(
    resourcesPath,
    "bridge",
    platform === "win32" ? "decision-bridge.cmd" : "decision-bridge",
  );
};

interface BridgeLauncher {
  path: string;
  content: string;
}

/**
 * The launcher a Windows install keeps of its bridge where updates leave it. Squirrel installs each version in
 * its own `app-<version>` folder beside Update.exe and removes the old one after an update: every hook and MCP
 * registration naming the old folder's bridge failed, every turn, until the reader reconnected. This one, at the
 * install root, hands on to the bridge of the version that last started. null: not installed so (a portable
 * copy, a run from source), or not Windows.
 */
export const squirrelBridgeLauncher = ({
  platform,
  execPath,
  resourcesPath,
  exists,
}: {
  platform: NodeJS.Platform;
  execPath: string;
  resourcesPath: string;
  exists(path: string): boolean;
}): BridgeLauncher | null => {
  if (platform !== "win32") return null;
  const version = win32.dirname(execPath);
  const root = win32.dirname(version);
  if (!/^app-\d+\.\d+\.\d+/u.test(win32.basename(version)) || !exists(win32.join(root, "Update.exe"))) return null;
  const target = win32.relative(root, win32.join(resourcesPath, "bridge", "decision-bridge.cmd"));
  // A quote or a percent sign in it would be cmd's own: there is none in the folders Squirrel names.
  if (target.startsWith("..") || win32.isAbsolute(target) || /["%]/u.test(target)) return null;
  return {
    path: win32.join(root, "decision-bridge.cmd"),
    // The version's wrapper in its place: no `call`, so what is piped in and the exit code pass through as they
    // are. The wrapper itself finds this launcher beside Update.exe and gives out its path to `install`: taken
    // from the environment instead, a variable anyone could set chose what every hook ran.
    content: ["@echo off", `"%~dp0${target}" %*`, ""].join("\r\n"),
  };
};

/**
 * The launcher written as the version now running names it (only when that changed), before any hook is looked
 * at or written: its path, or null when it could not be written, and hooks go on naming this version's own bridge.
 */
export const prepareBridgeLauncher = async (
  launcher: BridgeLauncher | null,
  io: { read(path: string): Promise<string>; write(path: string, content: string): Promise<void> } = {
    read: (path) => readFile(path, "utf8"),
    write: atomicWrite,
  },
): Promise<string | null> => {
  if (launcher === null) return null;
  try {
    if ((await io.read(launcher.path).catch(() => null)) !== launcher.content) await io.write(launcher.path, launcher.content);
    return launcher.path;
  } catch {
    return null;
  }
};
