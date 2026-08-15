import { describe, expect, it } from "vitest";

// @ts-expect-error The production release verifier is an executable ESM module.
import {
  createReleaseDocuments,
  findForbiddenBundleEntry,
  releaseArtifactName,
  resolveReleaseTag,
  validateArchiveEntries,
  validatePortableExecutable,
  validateReleaseVersion,
} from "../release-artifact.mjs";

describe("release artifact contract", () => {
  it("uses the Forge ZIP name and accepts a matching release tag", () => {
    expect(
      releaseArtifactName({
        productName: "Decision",
        version: "0.1.0",
        platform: "darwin",
        arch: "arm64",
      }),
    ).toBe("Decision-darwin-arm64-0.1.0.zip");
    expect(
      releaseArtifactName({
        productName: "Decision",
        version: "0.1.0",
        platform: "win32",
        arch: "x64",
      }),
    ).toBe("Decision-0.1.0-win-x64-Setup.exe");
    expect(
      validateReleaseVersion({
        version: "0.1.0",
        tag: "v0.1.0",
        requireTag: true,
      }),
    ).toBe("0.1.0");
  });

  it("rejects invalid versions, absent required tags, and mismatches", () => {
    expect(() =>
      validateReleaseVersion({ version: "next", tag: "vnext" }),
    ).toThrow(/SemVer/u);
    expect(() =>
      validateReleaseVersion({ version: "0.1.0", requireTag: true }),
    ).toThrow(/release tag/u);
    expect(() =>
      validateReleaseVersion({ version: "0.1.0", tag: "v0.2.0" }),
    ).toThrow(/does not match/u);
  });

  it("creates deterministic, redacted checksum and update metadata", () => {
    const sha256 = "a".repeat(64);
    const documents = createReleaseDocuments({
      productName: "Decision",
      version: "0.1.0",
      platform: "darwin",
      arch: "arm64",
      artifactName: "Decision-darwin-arm64-0.1.0.zip",
      bytes: 123_456,
      sha256,
      signature: "ad-hoc",
      sourceCommit: "b".repeat(40),
    });

    expect(documents.checksum).toBe(
      `${sha256}  Decision-darwin-arm64-0.1.0.zip\n`,
    );
    expect(documents.manifest).toEqual({
      schemaVersion: 2,
      product: "Decision",
      version: "0.1.0",
      platform: "darwin",
      arch: "arm64",
      artifact: {
        name: "Decision-darwin-arm64-0.1.0.zip",
        bytes: 123_456,
        sha256,
      },
      signature: "ad-hoc",
      sourceCommit: "b".repeat(40),
      updatePolicy: "manual",
    });
    expect(JSON.stringify(documents)).not.toMatch(
      /private|secret|Users|credential/u,
    );
  });

  it("rejects malformed checksum input", () => {
    expect(() =>
      createReleaseDocuments({
        productName: "Decision",
        version: "0.1.0",
        platform: "darwin",
        arch: "arm64",
        artifactName: "Decision-darwin-arm64-0.1.0.zip",
        bytes: 0,
        sha256: "not-a-digest",
        signature: "ad-hoc",
        sourceCommit: "b".repeat(40),
      }),
    ).toThrow(/artifact bytes/u);
  });

  it("validates target-specific signature states and source commits", () => {
    const base = {
      productName: "Decision",
      version: "0.1.0",
      artifactName: "Decision-0.1.0-win-x64-Setup.exe",
      bytes: 1,
      sha256: "a".repeat(64),
      sourceCommit: "b".repeat(40),
    };

    expect(() =>
      createReleaseDocuments({
        ...base,
        platform: "win32",
        arch: "x64",
        signature: "ad-hoc",
      }),
    ).toThrow(/signature/u);
    expect(() =>
      createReleaseDocuments({
        ...base,
        platform: "win32",
        arch: "x64",
        signature: "unsigned",
        sourceCommit: "not-a-commit",
      }),
    ).toThrow(/source commit/u);
  });

  it("rejects a renamed non-PE Windows installer", () => {
    const executable = Buffer.alloc(68);
    executable.write("MZ", 0, "ascii");
    executable.writeUInt32LE(64, 0x3c);
    executable.write("PE\0\0", 64, "binary");
    expect(validatePortableExecutable(executable)).toBe(true);
    expect(() =>
      validatePortableExecutable(Buffer.from("MZpayload")),
    ).toThrow(/portable executable/iu);
    expect(() =>
      validatePortableExecutable(Buffer.from("not an executable")),
    ).toThrow(/portable executable/iu);
  });

  it("binds verification to exactly one safe App inside the ZIP", () => {
    expect(
      validateArchiveEntries([
        "Decision.app/",
        "Decision.app/Contents/Info.plist",
        "Decision.app/Contents/MacOS/Decision",
      ]),
    ).toBe("Decision.app");
    expect(() =>
      validateArchiveEntries([
        "Decision.app/Contents/Info.plist",
        "Other.app/Contents/Info.plist",
      ]),
    ).toThrow(/exactly one App/u);
    expect(() =>
      validateArchiveEntries([
        "Decision.app/Contents/Info.plist",
        "../outside.txt",
      ]),
    ).toThrow(/unsafe ZIP entry/u);
    expect(() =>
      validateArchiveEntries([
        "Decision.app/Contents/Info.plist",
        "release-notes.txt",
      ]),
    ).toThrow(/outside Decision\.app/u);
  });

  it("rejects embedded model/database payloads and update metadata", () => {
    expect(
      findForbiddenBundleEntry([
        "Contents/Info.plist",
        "Contents/Resources/app.asar",
      ]),
    ).toBeUndefined();
    expect(
      findForbiddenBundleEntry(["Contents/Resources/model.gguf"]),
    ).toBe("Contents/Resources/model.gguf");
    expect(
      findForbiddenBundleEntry(["Contents/Resources/app-update.yml"]),
    ).toBe("Contents/Resources/app-update.yml");
    expect(
      findForbiddenBundleEntry(["Contents/Resources/latest-mac.yml"]),
    ).toBe("Contents/Resources/latest-mac.yml");
  });

  it("rejects conflicting release tag sources", () => {
    expect(
      resolveReleaseTag({
        argumentTag: "v1.0.0",
        environmentTag: "v1.0.0",
        ciTag: "v1.0.0",
      }),
    ).toBe("v1.0.0");
    expect(() =>
      resolveReleaseTag({
        argumentTag: "v1.0.0",
        environmentTag: "v2.0.0",
      }),
    ).toThrow(/Conflicting release tags/u);
  });
});
