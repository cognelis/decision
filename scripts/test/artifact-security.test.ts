import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error The production scanner is an executable ESM module.
import {
  findForbiddenReleasePath,
  findSensitiveReleaseText,
  normalizeAsarEntry,
  scanReleasePayload,
} from "../artifact-security.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("packaged payload security", () => {
  it("normalizes ASAR entries emitted with either host separator", () => {
    expect(normalizeAsarEntry("/.vite/build/main.cjs")).toBe(
      ".vite/build/main.cjs",
    );
    expect(normalizeAsarEntry("\\.vite\\build\\main.cjs")).toBe(
      ".vite/build/main.cjs",
    );
  });

  it("rejects credential, source-map, fixture, database, and model paths", () => {
    expect(
      findForbiddenReleasePath(["Contents/Resources/app.asar"]),
    ).toBeUndefined();
    for (const path of [
      "resources/.env.production",
      "resources/AuthKey_release.p8",
      "resources/main.js.map",
      "resources/fixtures/private.json",
      "resources/local.sqlite",
      "resources/model.gguf",
    ]) {
      expect(findForbiddenReleasePath([path])).toBe(path);
    }
  });

  it("rejects recognizable secrets, password URLs, and user-home paths", () => {
    const token = ["sk", "proj", "A".repeat(24)].join("-");
    expect(findSensitiveReleaseText("const safe = true;")).toBeUndefined();
    expect(findSensitiveReleaseText(`token=${token}`)).toMatch(/token/iu);
    const passwordUrl = ["https://account", "password@example.invalid"].join(
      ":",
    );
    expect(
      findSensitiveReleaseText(passwordUrl),
    ).toMatch(/password URL/iu);
    expect(
      findSensitiveReleaseText("built at /Users/example-builder/project"),
    ).toMatch(/user-home path/iu);
  });

  it("scans textual files in the packaged payload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "decision-payload-scan-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "runtime.json");
    await writeFile(path, '{"status":"clean"}\n', "utf8");
    await expect(scanReleasePayload(directory)).resolves.toMatchObject({
      filesScanned: 1,
    });

    await writeFile(
      path,
      "built at C:\\Users\\release-builder\\decision\n",
      "utf8",
    );
    await expect(scanReleasePayload(directory)).rejects.toThrow(
      /user-home path/iu,
    );
  });

  it("inspects first-party code and paths inside app.asar", async () => {
    const directory = await mkdtemp(join(tmpdir(), "decision-asar-scan-"));
    temporaryDirectories.push(directory);
    const source = join(directory, "source");
    await mkdir(join(source, ".vite", "build"), { recursive: true });
    await mkdir(join(source, "node_modules", "dependency"), {
      recursive: true,
    });
    await writeFile(
      join(source, ".vite", "build", "main.cjs"),
      "const build = 'portable';\n",
      "utf8",
    );
    await writeFile(
      join(source, "node_modules", "dependency", "index.js"),
      'const buildPath = "/Users/release-builder/decision";\n',
      "utf8",
    );
    const { createPackage } = await import("@electron/asar");
    await createPackage(source, join(directory, "app.asar"));
    await rm(source, { recursive: true, force: true });

    await expect(scanReleasePayload(directory)).rejects.toThrow(
      /user-home path.*app\.asar.*node_modules.*dependency/iu,
    );
  });

  it("scans large textual files instead of skipping them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "decision-large-scan-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "large-runtime.js");
    await writeFile(
      path,
      `${"a".repeat(8 * 1024 * 1024 + 128)}\n/Users/large-builder/decision\n`,
      "utf8",
    );

    await expect(scanReleasePayload(directory)).rejects.toThrow(
      /user-home path.*large-runtime\.js/iu,
    );
  });
});
