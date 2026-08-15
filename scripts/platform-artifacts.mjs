import { join } from "node:path";

const TARGETS = Object.freeze([
  Object.freeze({ platform: "win32", arch: "x64" }),
  Object.freeze({ platform: "darwin", arch: "arm64" }),
]);

export const supportedReleaseTargets = () =>
  TARGETS.map((target) => ({ ...target }));

const assertSupportedTarget = (platform, arch) => {
  if (
    !TARGETS.some(
      (target) => target.platform === platform && target.arch === arch,
    )
  ) {
    throw new Error(`Unsupported release target: ${platform}/${arch}`);
  }
};

export const releaseTarget = ({
  repositoryRoot,
  productName,
  version,
  platform,
  arch,
}) => {
  assertSupportedTarget(platform, arch);
  const packageRoot =
    platform === "win32"
      ? join(repositoryRoot, "out", `${productName}-win32-${arch}`)
      : join(
          repositoryRoot,
          "out",
          `${productName}-darwin-${arch}`,
          `${productName}.app`,
        );
  const artifactName =
    platform === "win32"
      ? `${productName}-${version}-win-${arch}-Setup.exe`
      : `${productName}-darwin-${arch}-${version}.zip`;
  const artifactPath =
    platform === "win32"
      ? join(
          repositoryRoot,
          "out",
          "make",
          "squirrel.windows",
          arch,
          artifactName,
        )
      : join(
          repositoryRoot,
          "out",
          "make",
          "zip",
          platform,
          arch,
          artifactName,
        );
  const bridgeName =
    platform === "win32" ? "decision-bridge.cmd" : "decision-bridge";
  const legacyBridgeName =
    platform === "win32"
      ? "decision-island-bridge.cmd"
      : "decision-island-bridge";
  const resourcesRoot =
    platform === "win32"
      ? join(packageRoot, "resources")
      : join(packageRoot, "Contents", "Resources");

  return {
    platform,
    arch,
    signature: platform === "win32" ? "unsigned" : "ad-hoc",
    artifactName,
    artifactPath,
    checksumName: `${artifactName}.sha256`,
    manifestName: `decision-${platform}-${arch}.json`,
    packageRoot,
    packagedExecutable:
      platform === "win32"
        ? join(packageRoot, `${productName}.exe`)
        : join(packageRoot, "Contents", "MacOS", productName),
    bridgePath: join(resourcesRoot, "bridge", bridgeName),
    legacyBridgePath: join(resourcesRoot, "bridge", legacyBridgeName),
  };
};
