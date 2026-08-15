import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { releaseTarget, supportedReleaseTargets } from "./platform-artifacts.mjs";
import {
  createReleaseDocuments,
  validateReleaseVersion,
} from "./release-artifact.mjs";

const fileSha256 = async (path) => {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk);
  }
  return digest.digest("hex");
};

const readManifest = async (path) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Invalid release manifest ${path}`, { cause: error });
  }
};

export const verifyReleaseSet = async ({
  directory,
  version,
  tag,
  sourceCommit,
}) => {
  validateReleaseVersion({
    version,
    tag,
    requireTag: tag !== undefined,
  });
  const targets = supportedReleaseTargets().map(({ platform, arch }) =>
    releaseTarget({
      repositoryRoot: directory,
      productName: "Decision",
      version,
      platform,
      arch,
    }),
  );
  const expectedFiles = new Set(
    targets.flatMap((target) => [
      target.artifactName,
      target.checksumName,
      target.manifestName,
    ]),
  );
  const entries = await readdir(directory, { withFileTypes: true });
  const actualFiles = new Set(
    entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
  );
  const missing = [...expectedFiles].filter((name) => !actualFiles.has(name));
  if (missing.length > 0) {
    throw new Error(`Missing release file: ${missing.join(", ")}`);
  }
  const unexpected = entries
    .map((entry) => entry.name)
    .filter((name) => !expectedFiles.has(name));
  if (unexpected.length > 0) {
    throw new Error(`Unexpected release file: ${unexpected.join(", ")}`);
  }

  const manifests = [];
  for (const target of targets) {
    const artifactPath = join(directory, target.artifactName);
    const manifest = await readManifest(join(directory, target.manifestName));
    const artifactStat = await stat(artifactPath);
    const sha256 = await fileSha256(artifactPath);
    const documents = createReleaseDocuments({
      productName: "Decision",
      version,
      platform: target.platform,
      arch: target.arch,
      artifactName: target.artifactName,
      bytes: artifactStat.size,
      sha256,
      signature: manifest.signature,
      sourceCommit: manifest.sourceCommit,
    });
    if (!isDeepStrictEqual(manifest, documents.manifest)) {
      throw new Error(
        `Release manifest does not match ${target.artifactName}`,
      );
    }
    const checksum = await readFile(
      join(directory, target.checksumName),
      "utf8",
    );
    if (checksum !== documents.checksum) {
      throw new Error(
        `Release checksum does not match ${target.artifactName}`,
      );
    }
    manifests.push(manifest);
  }

  const commits = [...new Set(manifests.map((manifest) => manifest.sourceCommit))];
  if (commits.length !== 1) {
    throw new Error(`Release source commits do not match: ${commits.join(", ")}`);
  }
  if (sourceCommit !== undefined && commits[0] !== sourceCommit) {
    throw new Error(
      `Expected source commit ${sourceCommit}, received ${commits[0]}`,
    );
  }
  return {
    ok: true,
    version,
    sourceCommit: commits[0],
    artifacts: targets.map((target) => target.artifactName),
  };
};

const parseArguments = (arguments_) => {
  const result = {
    directory: "out/release",
    version: undefined,
    tag: undefined,
    sourceCommit: undefined,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--directory") {
      result.directory = arguments_[index + 1];
      index += 1;
    } else if (argument?.startsWith("--directory=")) {
      result.directory = argument.slice("--directory=".length);
    } else if (argument === "--version") {
      result.version = arguments_[index + 1];
      index += 1;
    } else if (argument?.startsWith("--version=")) {
      result.version = argument.slice("--version=".length);
    } else if (argument === "--tag") {
      result.tag = arguments_[index + 1];
      index += 1;
    } else if (argument?.startsWith("--tag=")) {
      result.tag = argument.slice("--tag=".length);
    } else if (argument === "--source-commit") {
      result.sourceCommit = arguments_[index + 1];
      index += 1;
    } else if (argument?.startsWith("--source-commit=")) {
      result.sourceCommit = argument.slice("--source-commit=".length);
    } else {
      throw new Error(`Unknown release set argument: ${argument}`);
    }
  }
  return result;
};

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  const packageDocument = JSON.parse(
    await readFile(join(process.cwd(), "package.json"), "utf8"),
  );
  const version = options.version ?? packageDocument.version;
  const tag =
    options.tag ??
    (process.env.GITHUB_REF_TYPE === "tag"
      ? process.env.GITHUB_REF_NAME
      : undefined);
  const result = await verifyReleaseSet({
    directory: resolve(options.directory),
    version,
    tag,
    sourceCommit: options.sourceCommit,
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
