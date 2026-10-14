import { createHash } from "node:crypto";
import { realpath as canonicalizePath } from "node:fs/promises";
import { posix, win32 } from "node:path";

export const MCP_REQUEST_TIMEOUT_MS = 20_000;

export const obsidianSearchDatabaseFiles = (databasePath) => [
  databasePath,
  `${databasePath}-wal`,
  `${databasePath}-shm`,
];

export const isObsidianSearchShutdownMarker = (value, expectedPid) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === "closed,pid,version" &&
  value.closed === true &&
  Number.isSafeInteger(value.pid) &&
  value.pid === expectedPid &&
  value.version === 1;

export const waitForShutdownMarkerBeforeExit = async ({
  applicationProcess,
  readMarker,
  validateMarker,
  poll = () => new Promise((resolve) => setTimeout(resolve, 100)),
  timeoutMs = 20_000,
}) => {
  const deadline = Date.now() + timeoutMs;
  const readValidMarker = async () => {
    try {
      return validateMarker(await readMarker());
    } catch {
      return false;
    }
  };
  const finishAfterExit = async () => {
    if (await readValidMarker()) return true;
    throw new Error(
      "Packaged application exited before a valid Obsidian shutdown marker",
    );
  };
  while (Date.now() < deadline) {
    if (applicationProcess.exitCode !== null) {
      return finishAfterExit();
    }
    if (await readValidMarker()) return true;
    if (applicationProcess.exitCode !== null) return finishAfterExit();
    await poll();
    if (applicationProcess.exitCode !== null) return finishAfterExit();
  }
  throw new Error("Obsidian shutdown marker timed out");
};

export const obsidianVaultIdentity = (
  canonicalPath,
  platform = process.platform,
) => {
  const paths = platform === "win32" ? win32 : posix;
  if (!paths.isAbsolute(canonicalPath)) {
    throw new Error("Invalid canonical Obsidian Vault path");
  }
  const normalized =
    platform === "win32"
      ? canonicalPath.replaceAll("\\", "/")
      : canonicalPath;
  return createHash("sha256").update(normalized, "utf8").digest("hex");
};

export const obsidianSearchIndexPath = (
  indexRoot,
  identity,
  platform = process.platform,
) => {
  if (!/^[a-f0-9]{64}$/u.test(identity)) {
    throw new Error("Invalid Obsidian Vault identity");
  }
  const paths = platform === "win32" ? win32 : posix;
  if (!paths.isAbsolute(indexRoot)) {
    throw new Error("Invalid Obsidian search root");
  }
  return paths.resolve(indexRoot, "vaults", identity, "index.sqlite");
};

export const resolveObsidianSearchDatabasePath = async ({
  indexRoot,
  vaultPath,
  platform = process.platform,
  realpath = canonicalizePath,
}) => {
  const canonical = await realpath(vaultPath);
  return obsidianSearchIndexPath(
    indexRoot,
    obsidianVaultIdentity(canonical, platform),
    platform,
  );
};

export const createMcpRequestManager = ({
  write,
  timeoutMs = MCP_REQUEST_TIMEOUT_MS,
}) => {
  if (typeof write !== "function") {
    throw new Error("MCP request manager requires a writer");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("MCP request timeout must be a positive integer");
  }

  const pending = new Map();
  const accept = (message) => {
    const request = pending.get(message?.id);
    if (request === undefined) {
      return false;
    }
    pending.delete(message.id);
    clearTimeout(request.timer);
    request.resolve(message);
    return true;
  };
  const rejectAll = (error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  const request = (id, method, params = {}) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(
            `packaged MCP ${method} timed out after ${timeoutMs} ms`,
          ),
        );
      }, timeoutMs);
      pending.set(id, { reject, resolve, timer });
      try {
        write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        );
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });

  return { accept, rejectAll, request };
};

const quoteWindowsCommandArgument = (value) => {
  if (typeof value !== "string" || /\0|\r|\n/u.test(value)) {
    throw new Error("Windows smoke arguments must be single-line strings");
  }
  return `"${value.replaceAll("%", "%%").replaceAll('"', '""')}"`;
};

export const bridgeProcessInvocation = ({
  platform,
  bridge,
  args,
  commandInterpreter,
}) => {
  if (platform !== "win32") {
    return {
      command: bridge,
      args: [...args],
      windowsVerbatimArguments: false,
    };
  }
  const commandLine = [bridge, ...args]
    .map(quoteWindowsCommandArgument)
    .join(" ");
  return {
    command: commandInterpreter ?? process.env.ComSpec ?? "cmd.exe",
    windowsVerbatimArguments: true,
    args: [
      "/d",
      "/s",
      "/v:off",
      "/c",
      `"${commandLine}"`,
    ],
  };
};

export const resolvePackagedSmokeTarget = ({
  target,
  platform,
  productName,
  packageRoot,
}) => {
  if (typeof packageRoot !== "string" || packageRoot.trim().length === 0) {
    return target;
  }
  const paths = platform === "win32" ? win32 : posix;
  const resolvedRoot = paths.normalize(packageRoot);
  const resourcesRoot =
    platform === "win32"
      ? paths.join(resolvedRoot, "resources")
      : paths.join(resolvedRoot, "Contents", "Resources");
  return {
    ...target,
    packageRoot: resolvedRoot,
    packagedExecutable:
      platform === "win32"
        ? paths.join(resolvedRoot, `${productName}.exe`)
        : paths.join(resolvedRoot, "Contents", "MacOS", productName),
    bridgePath: paths.join(
      resourcesRoot,
      "bridge",
      platform === "win32" ? "decision-bridge.cmd" : "decision-bridge",
    ),

  };
};
