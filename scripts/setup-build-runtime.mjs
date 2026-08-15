import { spawn } from "node:child_process";
import { access, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SUPPORTED_7ZIP_ARCHITECTURES = new Set(["arm64", "x64"]);

const run = (command, arguments_, cwd) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, { cwd, stdio: "inherit" });
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

export const selectWinstallerSevenZip = async ({
  architecture = process.arch,
  vendorDirectory,
}) => {
  if (!SUPPORTED_7ZIP_ARCHITECTURES.has(architecture)) {
    throw new Error(
      `Unsupported electron-winstaller host architecture: ${architecture}`,
    );
  }

  const sources = [
    join(vendorDirectory, `7z-${architecture}.exe`),
    join(vendorDirectory, `7z-${architecture}.dll`),
  ];
  await Promise.all(sources.map((path) => access(path)));
  await Promise.all([
    copyFile(sources[0], join(vendorDirectory, "7z.exe")),
    copyFile(sources[1], join(vendorDirectory, "7z.dll")),
  ]);
};

export const setupBuildRuntime = async ({
  architecture = process.arch,
  repositoryRoot = process.cwd(),
} = {}) => {
  await run(
    process.execPath,
    [join(repositoryRoot, "node_modules", "electron", "install.js")],
    repositoryRoot,
  );
  await selectWinstallerSevenZip({
    architecture,
    vendorDirectory: join(
      repositoryRoot,
      "node_modules",
      "electron-winstaller",
      "vendor",
    ),
  });
};

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  setupBuildRuntime().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
