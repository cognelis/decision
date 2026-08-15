import { posix, win32 } from "node:path";

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
    return { command: bridge, args: [...args] };
  }
  return {
    command: commandInterpreter ?? process.env.ComSpec ?? "cmd.exe",
    args: [
      "/d",
      "/s",
      "/v:off",
      "/c",
      [bridge, ...args].map(quoteWindowsCommandArgument).join(" "),
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
