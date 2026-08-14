import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

interface PackageDocument {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
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
  it("keeps every release workspace on the exact 1.0.0 contract", () => {
    expect(packageDocument.version).toBe("1.0.0");
    expect(workspacePackages.map(({ version }) => version)).toEqual([
      "1.0.0",
      "1.0.0",
      "1.0.0",
      "1.0.0",
      "1.0.0",
      "1.0.0",
    ]);

    for (const workspace of workspacePackages) {
      for (const [name, version] of Object.entries(
        workspace.dependencies ?? {},
      )) {
        if (name.startsWith("@cognelis/decision-")) {
          expect(version, `${workspace.name} -> ${name}`).toBe("1.0.0");
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
      "release:verify": "node scripts/release-artifact.mjs",
      "release:verify:distribution":
        "node scripts/release-artifact.mjs --distribution --require-tag",
      "release:local":
        "npm run quality && npm run make && npm run smoke && npm run release:verify",
      "release:distribution":
        "npm run audit:runtime && npm run quality && npm run make && npm run smoke && npm run release:verify:distribution",
    });
  });
});
