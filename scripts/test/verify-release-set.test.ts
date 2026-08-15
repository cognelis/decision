import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error The production verifier is an executable ESM module.
import { verifyReleaseSet } from "../verify-release-set.mjs";

const temporaryDirectories: string[] = [];
const version = "1.1.0";
const sourceCommit = "b".repeat(40);

const sha256 = (input: Buffer): string =>
  createHash("sha256").update(input).digest("hex");

const makeReleaseSet = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "decision-release-set-"));
  temporaryDirectories.push(directory);
  const targets = [
    {
      platform: "win32",
      arch: "x64",
      name: `Decision-${version}-win-x64-Setup.exe`,
      signature: "unsigned",
      body: Buffer.from("MZwindows-installer"),
    },
    {
      platform: "darwin",
      arch: "arm64",
      name: `Decision-darwin-arm64-${version}.zip`,
      signature: "ad-hoc",
      body: Buffer.from("macos-zip"),
    },
  ] as const;
  for (const target of targets) {
    const digest = sha256(target.body);
    await writeFile(join(directory, target.name), target.body);
    await writeFile(
      join(directory, `${target.name}.sha256`),
      `${digest}  ${target.name}\n`,
      "utf8",
    );
    await writeFile(
      join(directory, `decision-${target.platform}-${target.arch}.json`),
      `${JSON.stringify({
        schemaVersion: 2,
        product: "Decision",
        version,
        platform: target.platform,
        arch: target.arch,
        artifact: {
          name: target.name,
          bytes: target.body.length,
          sha256: digest,
        },
        signature: target.signature,
        sourceCommit,
        updatePolicy: "manual",
      }, null, 2)}\n`,
      "utf8",
    );
  }
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("complete release set", () => {
  it("loads in the dependency-free aggregation job", async () => {
    const directory = await mkdtemp(join(tmpdir(), "decision-release-loader-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "scripts"), { recursive: true });
    await mkdir(join(directory, "config"), { recursive: true });
    for (const path of [
      "scripts/platform-artifacts.mjs",
      "scripts/release-artifact.mjs",
      "scripts/release-security-rules.mjs",
      "scripts/verify-release-set.mjs",
      "config/decision-environment.mjs",
    ]) {
      await copyFile(path, join(directory, path));
    }

    expect(() =>
      execFileSync(
        process.execPath,
        ["-e", "import('./scripts/verify-release-set.mjs')"],
        { cwd: directory, encoding: "utf8" },
      ),
    ).not.toThrow();
  });

  it("accepts exactly two artifacts bound to one version and commit", async () => {
    const directory = await makeReleaseSet();

    await expect(
      verifyReleaseSet({ directory, version, tag: `v${version}` }),
    ).resolves.toEqual({
      ok: true,
      version,
      sourceCommit,
      artifacts: [
        `Decision-${version}-win-x64-Setup.exe`,
        `Decision-darwin-arm64-${version}.zip`,
      ],
    });
  });

  it("rejects a missing Windows sidecar", async () => {
    const directory = await makeReleaseSet();
    await rm(join(directory, "decision-win32-x64.json"));

    await expect(
      verifyReleaseSet({ directory, version, tag: `v${version}` }),
    ).rejects.toThrow(/missing.*decision-win32-x64/iu);
  });

  it("rejects mismatched source commits", async () => {
    const directory = await makeReleaseSet();
    const path = join(directory, "decision-win32-x64.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.sourceCommit = "c".repeat(40);
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    await expect(
      verifyReleaseSet({ directory, version, tag: `v${version}` }),
    ).rejects.toThrow(/source commit/u);
  });

  it("rejects a release set from a different tag commit", async () => {
    const directory = await makeReleaseSet();

    await expect(
      verifyReleaseSet({
        directory,
        version,
        tag: `v${version}`,
        sourceCommit: "c".repeat(40),
      }),
    ).rejects.toThrow(/expected source commit/iu);
  });

  it("accepts semantically identical manifests with reordered keys", async () => {
    const directory = await makeReleaseSet();
    const path = join(directory, "decision-win32-x64.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    const reordered = {
      sourceCommit: manifest.sourceCommit,
      signature: manifest.signature,
      updatePolicy: manifest.updatePolicy,
      artifact: manifest.artifact,
      arch: manifest.arch,
      platform: manifest.platform,
      version: manifest.version,
      product: manifest.product,
      schemaVersion: manifest.schemaVersion,
    };
    await writeFile(path, `${JSON.stringify(reordered, null, 2)}\n`, "utf8");

    await expect(
      verifyReleaseSet({ directory, version, tag: `v${version}` }),
    ).resolves.toMatchObject({ ok: true, version, sourceCommit });
  });

  it("rejects unexpected release files", async () => {
    const directory = await makeReleaseSet();
    await writeFile(join(directory, "latest.yml"), "unexpected", "utf8");

    await expect(
      verifyReleaseSet({ directory, version, tag: `v${version}` }),
    ).rejects.toThrow(/unexpected release file/iu);
  });
});
