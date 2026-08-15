import { posix, win32 } from "node:path";

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
