#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_MAXIMUM_REDIRECTS = 5;

export class LocalModelPreparationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LocalModelPreparationError";
    this.code = code;
  }
}

const validateManifest = (manifest) => {
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    typeof manifest.id !== "string" ||
    typeof manifest.fileName !== "string" ||
    manifest.fileName.length === 0 ||
    manifest.fileName !== manifest.fileName.split(/[\\/]/u).at(-1) ||
    typeof manifest.url !== "string" ||
    !Number.isSafeInteger(manifest.bytes) ||
    manifest.bytes < 1 ||
    typeof manifest.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(manifest.sha256)
  ) {
    throw new LocalModelPreparationError(
      "invalid_manifest",
      "The local model manifest is invalid",
    );
  }
};

const isInside = (parent, child) => {
  const root = resolve(parent);
  const target = resolve(child);
  return target === root || target.startsWith(`${root}${sep}`);
};

const validateModelsDirectory = (
  modelsDirectory,
  resourcesPath,
) => {
  const target = resolve(modelsDirectory);
  if (
    (resourcesPath !== undefined &&
      isInside(resourcesPath, target)) ||
    /(?:^|\/)[^/]+\.app\/Contents(?:\/|$)/u.test(
      target,
    )
  ) {
    throw new LocalModelPreparationError(
      "app_bundle_path",
      "Models must not be written inside the application bundle",
    );
  }
};

const hashPath = async (path) => {
  const hash = createHash("sha256");
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stats = await file.stat();
    if (!stats.isFile()) {
      throw new Error("not a regular file");
    }
    for await (const chunk of file.createReadStream({
      autoClose: false,
    })) {
      hash.update(chunk);
    }
    return {
      bytes: stats.size,
      sha256: hash.digest("hex"),
    };
  } finally {
    await file.close();
  }
};

const removeManagedFile = async (path) => {
  await unlink(path).catch((error) => {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  });
};

export const inspectLocalModel = async ({
  manifest,
  modelsDirectory,
  resourcesPath,
}) => {
  validateManifest(manifest);
  validateModelsDirectory(modelsDirectory, resourcesPath);
  const modelPath = join(modelsDirectory, manifest.fileName);
  try {
    const pathStats = await lstat(modelPath);
    if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
      return { status: "checksum_failed" };
    }
    const actual = await hashPath(modelPath);
    if (
      actual.bytes !== manifest.bytes ||
      actual.sha256 !== manifest.sha256
    ) {
      return { status: "checksum_failed" };
    }
    return { status: "available", modelPath };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { status: "missing" };
    }
    return { status: "checksum_failed" };
  }
};

const validateDownloadUrl = (value) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new LocalModelPreparationError(
      "invalid_url",
      "The model URL is invalid",
    );
  }
  const local =
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new LocalModelPreparationError(
      "insecure_url",
      "Production model downloads require HTTPS",
    );
  }
  return url;
};

const fetchFollowingRedirects = async ({
  url,
  fetcher,
  headers,
  maximumRedirects,
}) => {
  let current = validateDownloadUrl(url);
  for (let redirect = 0; ; redirect += 1) {
    const response = await fetcher(current, {
      headers,
      redirect: "manual",
    });
    if (
      response.status < 300 ||
      response.status >= 400
    ) {
      return response;
    }
    const location = response.headers.get("location");
    if (location === null) {
      throw new LocalModelPreparationError(
        "invalid_redirect",
        "The model redirect has no location",
      );
    }
    if (redirect >= maximumRedirects) {
      throw new LocalModelPreparationError(
        "redirect_limit",
        "The model download exceeded its redirect limit",
      );
    }
    current = validateDownloadUrl(
      new URL(location, current).toString(),
    );
  }
};

const partialSize = async (partialPath, maximumBytes) => {
  try {
    const stats = await lstat(partialPath);
    if (
      stats.isSymbolicLink() ||
      !stats.isFile() ||
      stats.size > maximumBytes
    ) {
      await removeManagedFile(partialPath);
      return 0;
    }
    await chmod(partialPath, 0o600);
    return stats.size;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
};

const verifyPartial = async (
  partialPath,
  manifest,
) => {
  const actual = await hashPath(partialPath);
  if (actual.bytes !== manifest.bytes) {
    throw new LocalModelPreparationError(
      "content_length_mismatch",
      "The downloaded model size is incorrect",
    );
  }
  if (actual.sha256 !== manifest.sha256) {
    throw new LocalModelPreparationError(
      "checksum_failed",
      "The downloaded model checksum is incorrect",
    );
  }
};

export const prepareLocalModel = async ({
  manifest,
  modelsDirectory,
  fetcher = globalThis.fetch,
  onProgress = () => undefined,
  maximumRedirects = DEFAULT_MAXIMUM_REDIRECTS,
  resourcesPath,
}) => {
  validateManifest(manifest);
  validateModelsDirectory(modelsDirectory, resourcesPath);
  if (
    typeof fetcher !== "function" ||
    !Number.isInteger(maximumRedirects) ||
    maximumRedirects < 0
  ) {
    throw new LocalModelPreparationError(
      "invalid_options",
      "The local model preparation options are invalid",
    );
  }

  await mkdir(modelsDirectory, {
    recursive: true,
    mode: 0o700,
  });
  await chmod(modelsDirectory, 0o700);
  const modelPath = join(modelsDirectory, manifest.fileName);
  const partialPath = `${modelPath}.partial`;
  const existing = await inspectLocalModel({
    manifest,
    modelsDirectory,
    resourcesPath,
  });
  if (existing.status === "available") {
    return {
      status: "already_available",
      modelPath,
      downloadedBytes: manifest.bytes,
    };
  }
  if (existing.status === "checksum_failed") {
    await removeManagedFile(modelPath);
  }

  let downloadedBytes = await partialSize(
    partialPath,
    manifest.bytes,
  );
  if (downloadedBytes === manifest.bytes) {
    try {
      await verifyPartial(partialPath, manifest);
      await rename(partialPath, modelPath);
      await chmod(modelPath, 0o600);
      return {
        status: "downloaded",
        modelPath,
        downloadedBytes,
      };
    } catch (error) {
      await removeManagedFile(partialPath);
      throw error;
    }
  }

  let response = await fetchFollowingRedirects({
    url: manifest.url,
    fetcher,
    headers:
      downloadedBytes === 0
        ? {}
        : { Range: `bytes=${downloadedBytes}-` },
    maximumRedirects,
  });
  if (downloadedBytes > 0 && response.status === 200) {
    await removeManagedFile(partialPath);
    downloadedBytes = 0;
    response = await fetchFollowingRedirects({
      url: manifest.url,
      fetcher,
      headers: {},
      maximumRedirects,
    });
  }
  const expectedStatus = downloadedBytes > 0 ? 206 : 200;
  if (response.status !== expectedStatus || response.body === null) {
    throw new LocalModelPreparationError(
      "download_failed",
      `The model server returned status ${response.status}`,
    );
  }
  if (downloadedBytes > 0) {
    const contentRange = response.headers.get("content-range");
    if (
      contentRange === null ||
      !contentRange.startsWith(`bytes ${downloadedBytes}-`)
    ) {
      await removeManagedFile(partialPath);
      throw new LocalModelPreparationError(
        "content_length_mismatch",
        "The model range response is invalid",
      );
    }
  }
  const expectedRemaining = manifest.bytes - downloadedBytes;
  const contentLength = Number(
    response.headers.get("content-length"),
  );
  if (
    !Number.isSafeInteger(contentLength) ||
    contentLength !== expectedRemaining
  ) {
    await removeManagedFile(partialPath);
    throw new LocalModelPreparationError(
      "content_length_mismatch",
      "The model response length does not match the manifest",
    );
  }

  const file = await open(
    partialPath,
    downloadedBytes === 0 ? "w" : "a",
    0o600,
  );
  let streamError;
  try {
    await chmod(partialPath, 0o600);
    onProgress({
      downloadedBytes,
      totalBytes: manifest.bytes,
    });
    for await (const chunk of response.body) {
      const data = Buffer.from(chunk);
      await file.write(data);
      downloadedBytes += data.byteLength;
      onProgress({
        downloadedBytes,
        totalBytes: manifest.bytes,
      });
      if (downloadedBytes > manifest.bytes) {
        throw new LocalModelPreparationError(
          "content_length_mismatch",
          "The model response exceeded the manifest size",
        );
      }
    }
    await file.sync();
  } catch (error) {
    streamError = error;
  } finally {
    await file.close();
  }
  if (streamError !== undefined) {
    if (
      streamError instanceof LocalModelPreparationError &&
      streamError.code === "content_length_mismatch"
    ) {
      await removeManagedFile(partialPath);
    }
    throw streamError;
  }

  try {
    await verifyPartial(partialPath, manifest);
    await rename(partialPath, modelPath);
    await chmod(modelPath, 0o600);
  } catch (error) {
    await removeManagedFile(partialPath);
    throw error;
  }
  return {
    status: "downloaded",
    modelPath,
    downloadedBytes,
  };
};

export const defaultModelsDirectory = (
  environment = process.env,
  platform = process.platform,
) => {
  if (platform === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "Decision",
      "models",
    );
  }
  if (platform === "win32") {
    return join(
      environment.APPDATA ??
        join(homedir(), "AppData", "Roaming"),
      "Decision",
      "models",
    );
  }
  return join(
    environment.XDG_CONFIG_HOME ??
      join(homedir(), ".config"),
    "decision",
    "models",
  );
};

const loadBundledManifests = async () =>
  Promise.all(
    [
      "qwen3.5-2b-q4-k-m.json",
      "qwen3-embedding-0.6b-q8-0.json",
    ].map(async (fileName) => {
      const path = fileURLToPath(
        new URL(
          `../apps/desktop/assets/models/${fileName}`,
          import.meta.url,
        ),
      );
      return JSON.parse(await readFile(path, "utf8"));
    }),
  );

const CLI_HELP = `Usage: prepare-local-model.mjs [--check] [--models-dir PATH]

Prepare the immutable Qwen generation and embedding GGUFs used by Decision.
Downloads only after an explicit invocation of this command.

Options:
  --check            Verify the expected file without downloading it.
  --models-dir PATH  Use a custom model directory.
  --help, -h         Show this help.
`;

const runCli = async () => {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(CLI_HELP);
    return;
  }
  const check = args.includes("--check");
  const directoryIndex = args.indexOf("--models-dir");
  const modelsDirectory =
    directoryIndex >= 0
      ? args[directoryIndex + 1]
      : defaultModelsDirectory();
  if (
    modelsDirectory === undefined ||
    args.some(
      (argument, index) =>
        argument.startsWith("--") &&
        argument !== "--check" &&
        argument !== "--models-dir" &&
        index !== directoryIndex + 1,
    )
  ) {
    throw new LocalModelPreparationError(
      "invalid_options",
      "Usage: prepare-local-model.mjs [--check] [--models-dir PATH]",
    );
  }
  const manifests = await loadBundledManifests();
  if (check) {
    const results = await Promise.all(
      manifests.map((manifest) =>
        inspectLocalModel({ manifest, modelsDirectory }),
      ),
    );
    const status = results.every((result) => result.status === "available")
      ? "available"
      : results.some((result) => result.status === "checksum_failed")
        ? "checksum_failed"
        : "missing";
    process.stdout.write(`${status}\n`);
    process.exitCode = status === "available" ? 0 : status === "missing" ? 2 : 3;
    return;
  }

  const results = [];
  for (const manifest of manifests) {
    let lastPercentage = -1;
    results.push(
      await prepareLocalModel({
        manifest,
        modelsDirectory,
        onProgress: ({ downloadedBytes, totalBytes }) => {
          const percentage = Math.floor(
            (downloadedBytes / totalBytes) * 100,
          );
          if (percentage !== lastPercentage) {
            lastPercentage = percentage;
            process.stdout.write(
              `preparing ${manifest.id}: ${percentage}%\n`,
            );
          }
        },
      }),
    );
  }
  process.stdout.write(
    `${results.some((result) => result.status === "downloaded") ? "downloaded" : "already_available"}\n`,
  );
};

const invokedPath =
  process.argv[1] === undefined
    ? null
    : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  runCli().catch((error) => {
    process.stderr.write(
      `model preparation failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
