import { spawn } from "node:child_process";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const APPLE_BUILD_SCRIPTS = Object.freeze([
  "scripts/build-foundation-model-helper.sh",
  "scripts/build-liquid-glass-addon.sh",
]);

export const nativeBuildPlan = (platform = process.platform) =>
  platform === "darwin" ? [...APPLE_BUILD_SCRIPTS] : [];

const run = (command, arguments_, cwd) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `${command} ${arguments_.join(" ")} failed with ${
            signal === null ? `exit code ${code ?? 1}` : `signal ${signal}`
          }`,
        ),
      );
    });
  });

const clearAppleOutputs = async (repositoryRoot) => {
  const semanticDirectory = join(repositoryRoot, "dist", "semantic");
  const nativeDirectory = join(repositoryRoot, "dist", "native");
  await Promise.all([
    mkdir(semanticDirectory, { recursive: true }),
    mkdir(nativeDirectory, { recursive: true }),
  ]);
  await Promise.all(
    [
      join(semanticDirectory, "decision-foundation-model-helper"),
      join(semanticDirectory, "decision-island-foundation-model-helper"),
      join(nativeDirectory, "decision-liquid-glass.node"),
      join(nativeDirectory, "decision-island-liquid-glass.node"),
    ].map((path) => rm(path, { force: true })),
  );
  await copyFile(
    join(
      repositoryRoot,
      "apps",
      "desktop",
      "assets",
      "models",
      "qwen3.5-2b-q4-k-m.json",
    ),
    join(semanticDirectory, "qwen3.5-2b-q4-k-m.json"),
  );
};

export const buildNativeResources = async ({
  platform = process.platform,
  repositoryRoot = process.cwd(),
} = {}) => {
  const plan = nativeBuildPlan(platform);
  if (plan.length === 0) {
    await clearAppleOutputs(repositoryRoot);
    return;
  }
  for (const script of plan) {
    await run("sh", [join(repositoryRoot, script)], repositoryRoot);
  }
};

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  buildNativeResources().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
