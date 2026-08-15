import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

interface PackageDocument {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  engines?: Record<string, string>;
  scripts?: Record<string, string>;
}

const readPackage = (path: string): PackageDocument =>
  JSON.parse(
    readFileSync(new URL(path, import.meta.url), "utf8"),
  ) as PackageDocument;

const packageDocument = readPackage("../../package.json");

const workspacePackages = [
  readPackage("../../apps/bridge/package.json"),
  readPackage("../../apps/desktop/package.json"),
  readPackage("../../packages/core/package.json"),
  readPackage("../../packages/integrations/package.json"),
  readPackage("../../packages/protocol/package.json"),
  readPackage("../../packages/storage/package.json"),
];

describe("root quality scripts", () => {
  it("keeps every release workspace on the exact 1.1.0 contract", () => {
    expect(packageDocument.version).toBe("1.1.0");
    expect(workspacePackages.map(({ version }) => version)).toEqual([
      "1.1.0",
      "1.1.0",
      "1.1.0",
      "1.1.0",
      "1.1.0",
      "1.1.0",
    ]);

    for (const workspace of workspacePackages) {
      for (const [name, version] of Object.entries(
        workspace.dependencies ?? {},
      )) {
        if (name.startsWith("@cognelis/decision-")) {
          expect(version, `${workspace.name} -> ${name}`).toBe("1.1.0");
        }
      }
    }
  });

  it("keeps passing checks separate from semantic readiness", () => {
    expect(packageDocument.scripts).toMatchObject({
      check: "npm run typecheck && npm test",
      "check:semantic": "npm run evaluate:semantic",
      "report:semantic": "npm run evaluate:semantic -- --report-only",
    });
  });

  it("exposes provider-neutral quality and explicit release boundaries", () => {
    expect(packageDocument.scripts).toMatchObject({
      quality: "npm run check && npm run check:semantic",
      "audit:runtime": "npm audit --omit=dev --audit-level=low",
      "setup:build-runtime": "node scripts/setup-build-runtime.mjs",
      "setup:electron": "node node_modules/electron/install.js",
      "release:verify": "node scripts/release-artifact.mjs",
      "release:verify:set": "node scripts/verify-release-set.mjs",
      "release:verify:distribution":
        "node scripts/release-artifact.mjs --distribution --require-tag",
      "release:local":
        "npm run quality && npm run make && npm run smoke && npm run release:verify",
      "release:distribution":
        "npm run audit:runtime && npm run quality && npm run make && npm run smoke && npm run release:verify:distribution",
    });
  });

  it.each(["build", "make"])(
    "dispatches native resources without invoking a shell in %s",
    (script) => {
      const command = packageDocument.scripts?.[script];
      expect(command).toContain("npm run build:native");
      expect(command).not.toContain("build:foundation-helper");
      expect(command).not.toContain("build:liquid-glass");
    },
  );

  it("rejects unsupported runtimes before native packaging starts", () => {
    expect(packageDocument.engines?.node).toBe(">=22.13.0 <26");
    expect(packageDocument.scripts).toMatchObject({
      prebuild: "node scripts/check-build-runtime.mjs",
      premake: "node scripts/check-build-runtime.mjs",
    });
  });
});
