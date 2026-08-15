import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SUPPORTED_RUNTIME = ">=22.13.0 <26";

export const assertSupportedBuildRuntime = (version) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version);
  if (match === null) {
    throw new Error(
      `Unable to determine whether Node.js ${version} can package Decision. ` +
        `Use Node.js ${SUPPORTED_RUNTIME} (Node.js 22 LTS is recommended).`,
    );
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 22 || major >= 26 || (major === 22 && minor < 13)) {
    throw new Error(
      `Native packaging requires Node.js ${SUPPORTED_RUNTIME}; current runtime is ${version}. ` +
        "Use Node.js 22 LTS, reinstall dependencies, and run the build again.",
    );
  }
};

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  try {
    assertSupportedBuildRuntime(process.versions.node);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
