import { posix, win32 } from "node:path";

export const MCP_REQUEST_TIMEOUT_MS = 20_000;

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
    legacyBridgePath: paths.join(
      resourcesRoot,
      "bridge",
      platform === "win32"
        ? "decision-island-bridge.cmd"
        : "decision-island-bridge",
    ),
  };
};
