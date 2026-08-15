import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflowPath = ".github/workflows/release.yml";
const notesPath = "docs/release-notes.md";

const read = (path: string): string => readFileSync(path, "utf8");

describe("native GitHub release workflow", () => {
  it("builds and verifies both supported native targets", () => {
    const workflow = read(workflowPath);
    const windowsSmoke = read("scripts/smoke-installed-windows.ps1");

    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("macos-26");
    expect(workflow).toContain("--platform=win32 --arch=x64");
    expect(workflow).toContain("--platform=darwin --arch=arm64");
    expect(workflow).toContain("npm run smoke");
    expect(workflow).toContain("npm ci --ignore-scripts");
    expect(workflow.match(/npm run setup:build-runtime/gu)).toHaveLength(3);
    expect(workflow).toContain("node-version: 22");
    expect(workflow.match(/actions\/checkout@v7/gu)).toHaveLength(4);
    expect(workflow.match(/actions\/setup-node@v7/gu)).toHaveLength(3);
    expect(workflow.match(/actions\/upload-artifact@v7/gu)).toHaveLength(2);
    expect(workflow).toContain("actions/download-artifact@v8");
    expect(workflow).not.toContain("@v4");
    expect(workflow).toContain(
      "npx vitest run apps/desktop/test/brand-migration.test.ts",
    );
    expect(workflow).toContain("scripts/verify-release-set.mjs");
    expect(workflow).toContain("scripts/smoke-installed-windows.ps1");
    expect(windowsSmoke).toContain('ArgumentList "--silent"');
    expect(windowsSmoke).toContain("Stop-Process -Force");
    expect(windowsSmoke).toContain("DECISION_SMOKE_PACKAGE_ROOT");
    expect(windowsSmoke).toContain('ArgumentList "--uninstall", "-s"');
  });

  it("keeps Release mutation in one tag-only aggregation job", () => {
    const workflow = read(workflowPath);

    expect(workflow.match(/contents: write/gu)).toHaveLength(1);
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain(
      "needs: [quality, build-windows, build-macos]",
    );
    expect(workflow).toContain("github.ref_type == 'tag'");
    expect(workflow).toContain("release-${{ github.ref }}");
    expect(workflow).toContain("merge-multiple: true");
    expect(workflow).toContain("gh release create");
    expect(workflow).toContain("--draft");
    expect(workflow).toContain("gh release delete-asset");
    expect(workflow).toContain("gh release download");
    expect(workflow).toContain("--draft=false");
    expect(workflow).toContain("--source-commit=${{ github.sha }}");
    expect(workflow.match(/--source-commit="\$GITHUB_SHA"/gu)).toHaveLength(2);
    expect(workflow).not.toContain("--clobber");
    expect(workflow).not.toMatch(/secrets\./u);
  });

  it("documents unsigned first-run warnings without weakening security", () => {
    const notes = read(notesPath);

    expect(notes).toContain("Decision-<version>-win-x64-Setup.exe");
    expect(notes).toContain("Decision-darwin-arm64-<version>.zip");
    expect(notes).toMatch(/Windows[\s\S]*unsigned/iu);
    expect(notes).toMatch(/SmartScreen/iu);
    expect(notes).toMatch(/macOS[\s\S]*ad-hoc/iu);
    expect(notes).toMatch(/not notarized/iu);
    expect(notes).toMatch(/System Settings[\s\S]*Privacy & Security/iu);
    expect(notes).toMatch(/SHA-256[\s\S]*integrity[\s\S]*not[\s\S]*publisher identity/iu);
    expect(notes).toContain("Do not disable Gatekeeper globally.");
    expect(notes).not.toMatch(
      /(?:please|should|must|choose to) disable (?:all |global )?(?:SmartScreen|Gatekeeper)/iu,
    );
    expect(notes).not.toMatch(/spctl\s+--master-disable/iu);
  });
});
