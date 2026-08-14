import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { readDecisionEnvironment } from "../config/decision-environment.mjs";

const execFileAsync = promisify(execFile);
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export const validateReleaseVersion = ({
  version,
  tag,
  requireTag = false,
}) => {
  if (typeof version !== "string" || !SEMVER.test(version)) {
    throw new Error(`Release version must be valid SemVer; received ${version}`);
  }
  if (requireTag && (typeof tag !== "string" || tag.length === 0)) {
    throw new Error("A release tag is required for distribution verification");
  }
  if (tag !== undefined && tag !== `v${version}`) {
    throw new Error(`Release tag ${tag} does not match package version ${version}`);
  }
  return version;
};

export const releaseArtifactName = ({
  productName,
  version,
  platform,
  arch,
}) => `${productName}-${platform}-${arch}-${version}.zip`;

export const createReleaseDocuments = ({
  productName,
  version,
  platform,
  arch,
  artifactName,
  bytes,
  sha256,
}) => {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error("Release artifact bytes must be a positive safe integer");
  }
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new Error("Release artifact SHA-256 must be a lowercase hex digest");
  }
  return {
    manifest: {
      schemaVersion: 1,
      product: productName,
      version,
      platform,
      arch,
      artifact: {
        name: artifactName,
        bytes,
        sha256,
      },
      updatePolicy: "manual",
    },
    checksum: `${sha256}  ${artifactName}\n`,
  };
};

export const resolveReleaseTag = ({
  argumentTag,
  environmentTag,
  ciTag,
}) => {
  const tags = [argumentTag, environmentTag, ciTag].filter(
    (tag) => typeof tag === "string" && tag.length > 0,
  );
  const uniqueTags = [...new Set(tags)];
  if (uniqueTags.length > 1) {
    throw new Error(
      `Conflicting release tags: ${uniqueTags.join(", ")}`,
    );
  }
  return uniqueTags[0];
};

export const validateArchiveEntries = (entries) => {
  const archiveEntries = entries.filter((entry) => entry.length > 0);
  if (archiveEntries.length === 0) {
    throw new Error("Release ZIP is empty");
  }
  for (const entry of archiveEntries) {
    const components = entry.split("/");
    if (
      entry.startsWith("/") ||
      /^[A-Za-z]:/u.test(entry) ||
      entry.includes("\\") ||
      components.some((component) => component === "." || component === "..")
    ) {
      throw new Error(`Release ZIP contains unsafe ZIP entry: ${entry}`);
    }
  }

  const appNames = new Set(
    archiveEntries
      .map((entry) => entry.split("/")[0])
      .filter((entry) => entry.toLowerCase().endsWith(".app")),
  );
  if (appNames.size !== 1) {
    throw new Error("Release ZIP must contain exactly one App");
  }
  const [appName] = appNames;
  const outsideApp = archiveEntries.find(
    (entry) => entry !== appName && !entry.startsWith(`${appName}/`),
  );
  if (outsideApp !== undefined) {
    throw new Error(`Release ZIP entry is outside ${appName}: ${outsideApp}`);
  }
  return appName;
};

export const findForbiddenBundleEntry = (entries) =>
  entries.find((entry) => {
    const normalized = String(entry).toLowerCase();
    const file = basename(normalized);
    return (
      normalized.includes("duckdb") ||
      normalized.endsWith(".gguf") ||
      normalized.endsWith(".blockmap") ||
      [
        "app-update.yaml",
        "app-update.yml",
        "dev-app-update.yaml",
        "dev-app-update.yml",
        "latest-mac.yaml",
        "latest-mac.yml",
        "latest.json",
        "latest.yaml",
        "latest.yml",
        "releases",
        "releases.json",
      ].includes(file)
    );
  });

const parseArguments = (arguments_) => {
  const result = {
    distribution: false,
    requireTag: false,
    tag: undefined,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--distribution") {
      result.distribution = true;
    } else if (argument === "--require-tag") {
      result.requireTag = true;
    } else if (argument === "--tag") {
      result.tag = arguments_[index + 1];
      index += 1;
    } else if (argument?.startsWith("--tag=")) {
      result.tag = argument.slice("--tag=".length);
    } else {
      throw new Error(`Unknown release verifier argument: ${argument}`);
    }
  }
  return result;
};

const run = async (command, arguments_) => {
  try {
    return await execFileAsync(command, arguments_, {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    const detail =
      typeof error?.stderr === "string" && error.stderr.trim().length > 0
        ? `: ${error.stderr.trim()}`
        : "";
    throw new Error(`${command} ${arguments_.join(" ")} failed${detail}`, {
      cause: error,
    });
  }
};

const fileSha256 = async (path) => {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk);
  }
  return digest.digest("hex");
};

const writeAtomic = async (path, contents) => {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, contents, { mode: 0o644 });
  await rename(temporary, path);
};

const plistValue = async (appPath, key) => {
  const { stdout } = await run("plutil", [
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    join(appPath, "Contents", "Info.plist"),
  ]);
  return stdout.trim();
};

const validateBundleContents = async (appPath) => {
  const entries = await readdir(appPath, { recursive: true });
  const forbidden = findForbiddenBundleEntry(entries);
  if (forbidden !== undefined) {
    throw new Error(`Forbidden release bundle content: ${forbidden}`);
  }
};

export const verifyReleaseArtifact = async ({
  repositoryRoot,
  distribution,
  requireTag,
  tag,
}) => {
  const packageDocument = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  );
  const productName = packageDocument.productName;
  const version = validateReleaseVersion({
    version: packageDocument.version,
    tag,
    requireTag,
  });
  if (typeof productName !== "string" || productName.trim().length === 0) {
    throw new Error("package.json productName is required for release");
  }

  const platform = "darwin";
  const arch = "arm64";
  const artifactName = releaseArtifactName({
    productName,
    version,
    platform,
    arch,
  });
  const artifactPath = join(
    repositoryRoot,
    "out",
    "make",
    "zip",
    platform,
    arch,
    artifactName,
  );

  if (requireTag) {
    const { stdout } = await run("git", [
      "-C",
      repositoryRoot,
      "describe",
      "--tags",
      "--exact-match",
      "--match",
      tag,
      "HEAD",
    ]);
    if (stdout.trim() !== tag) {
      throw new Error(`Release tag ${tag} does not point to HEAD`);
    }
  }

  await run("unzip", ["-t", artifactPath]);
  const archiveListing = await run("unzip", ["-Z1", artifactPath]);
  const archiveAppName = validateArchiveEntries(
    archiveListing.stdout.split(/\r?\n/u),
  );
  const extractionDirectory = await mkdtemp(
    join(tmpdir(), "decision-release-verify-"),
  );
  try {
    await run("unzip", ["-qq", artifactPath, "-d", extractionDirectory]);
    const appPath = join(extractionDirectory, archiveAppName);
    const [shortVersion, bundleVersion] = await Promise.all([
      plistValue(appPath, "CFBundleShortVersionString"),
      plistValue(appPath, "CFBundleVersion"),
    ]);
    if (shortVersion !== version || bundleVersion !== version) {
      throw new Error(
        `App bundle version ${shortVersion}/${bundleVersion} does not match ${version}`,
      );
    }

    await validateBundleContents(appPath);
    await run("codesign", [
      "--verify",
      "--deep",
      "--strict",
      "--verbose=2",
      appPath,
    ]);
    const signature = await run("codesign", [
      "-dv",
      "--verbose=4",
      appPath,
    ]);
    const signatureDetail = `${signature.stdout}\n${signature.stderr}`;
    if (distribution) {
      if (!signatureDetail.includes("Authority=Developer ID Application:")) {
        throw new Error(
          "Distribution artifact is not signed by a Developer ID Application",
        );
      }
      await run("spctl", [
        "--assess",
        "--type",
        "execute",
        "--verbose=4",
        appPath,
      ]);
      await run("xcrun", ["stapler", "validate", appPath]);
    }
  } finally {
    await rm(extractionDirectory, { recursive: true, force: true });
  }

  const artifactStat = await stat(artifactPath);
  const sha256 = await fileSha256(artifactPath);
  const documents = createReleaseDocuments({
    productName,
    version,
    platform,
    arch,
    artifactName,
    bytes: artifactStat.size,
    sha256,
  });
  const releaseDirectory = join(repositoryRoot, "out", "release");
  await mkdir(releaseDirectory, { recursive: true });
  const checksumName = `${artifactName}.sha256`;
  const manifestName = `decision-${platform}-${arch}.json`;
  await Promise.all([
    writeAtomic(join(releaseDirectory, checksumName), documents.checksum),
    writeAtomic(
      join(releaseDirectory, manifestName),
      `${JSON.stringify(documents.manifest, null, 2)}\n`,
    ),
  ]);

  return {
    ok: true,
    distribution,
    artifact: artifactName,
    bytes: artifactStat.size,
    sha256,
    checksum: checksumName,
    manifest: manifestName,
  };
};

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  if (
    options.distribution &&
    readDecisionEnvironment(process.env, "RELEASE") !== "1"
  ) {
    throw new Error(
      "Distribution verification requires DECISION_RELEASE=1",
    );
  }
  const tag = resolveReleaseTag({
    argumentTag: options.tag,
    environmentTag: readDecisionEnvironment(process.env, "RELEASE_TAG"),
    ciTag: process.env.GITHUB_REF_TYPE === "tag"
      ? process.env.GITHUB_REF_NAME
      : undefined,
  });
  const result = await verifyReleaseArtifact({
    repositoryRoot: process.cwd(),
    distribution: options.distribution,
    requireTag: options.requireTag,
    tag,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
};

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
