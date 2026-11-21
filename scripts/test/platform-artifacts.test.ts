import { join } from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error The production helper is an executable ESM module.
import {
  releaseTarget,
  supportedReleaseTargets,
} from "../platform-artifacts.mjs";

describe("release platform contract", () => {
  it("supports exactly Windows x64 and Apple Silicon macOS", () => {
    expect(supportedReleaseTargets()).toEqual([
      { platform: "win32", arch: "x64" },
      { platform: "darwin", arch: "arm64" },
    ]);
  });

  it("uses deterministic Forge and public artifact paths", () => {
    expect(
      releaseTarget({
        repositoryRoot: "/repo",
        productName: "Paraself",
        version: "1.1.0",
        platform: "win32",
        arch: "x64",
      }),
    ).toMatchObject({
      artifactName: "Paraself-1.1.0-win-x64-Setup.exe",
      artifactPath: join(
        "/repo",
        "out",
        "make",
        "squirrel.windows",
        "x64",
        "Paraself-1.1.0-win-x64-Setup.exe",
      ),
      manifestName: "paraself-win32-x64.json",
      signature: "unsigned",
      packagedExecutable: join(
        "/repo",
        "out",
        "Paraself-win32-x64",
        "Paraself.exe",
      ),
      bridgePath: join(
        "/repo",
        "out",
        "Paraself-win32-x64",
        "resources",
        "bridge",
        "paraself-bridge.cmd",
      ),
    });
    expect(
      releaseTarget({
        repositoryRoot: "/repo",
        productName: "Paraself",
        version: "1.1.0",
        platform: "darwin",
        arch: "arm64",
      }),
    ).toMatchObject({
      artifactName: "Paraself-darwin-arm64-1.1.0.zip",
      artifactPath: join(
        "/repo",
        "out",
        "make",
        "zip",
        "darwin",
        "arm64",
        "Paraself-darwin-arm64-1.1.0.zip",
      ),
      manifestName: "paraself-darwin-arm64.json",
      signature: "ad-hoc",
      packagedExecutable: join(
        "/repo",
        "out",
        "Paraself-darwin-arm64",
        "Paraself.app",
        "Contents",
        "MacOS",
        "Paraself",
      ),
    });
  });

  it("rejects every unsupported target", () => {
    expect(() =>
      releaseTarget({
        repositoryRoot: "/repo",
        productName: "Paraself",
        version: "1.1.0",
        platform: "linux",
        arch: "x64",
      }),
    ).toThrow(/unsupported release target/i);
    expect(() =>
      releaseTarget({
        repositoryRoot: "/repo",
        productName: "Paraself",
        version: "1.1.0",
        platform: "darwin",
        arch: "x64",
      }),
    ).toThrow(/unsupported release target/i);
  });
});
