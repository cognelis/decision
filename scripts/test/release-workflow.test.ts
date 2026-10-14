import { existsSync, readFileSync } from "node:fs";

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
      "npx vitest run apps/desktop/test/data-preservation.test.ts",
    );
    const macosJob = workflow.slice(
      workflow.indexOf("  build-macos:"),
      workflow.indexOf("  release:"),
    );
    const installDependencies = macosJob.indexOf("npm ci --ignore-scripts");
    const setupRuntime = macosJob.indexOf("npm run setup:build-runtime");
    const setupElectron = macosJob.indexOf("npm run setup:electron");
    const verifyObsidianLayout = macosJob.indexOf(
      "npx vitest run apps/desktop/test/knowledge-layout.test.ts",
    );
    const buildMacos = macosJob.indexOf(
      "npm run make -- --platform=darwin --arch=arm64",
    );
    expect(installDependencies).toBeGreaterThanOrEqual(0);
    expect(setupRuntime).toBeGreaterThan(installDependencies);
    expect(setupElectron).toBeGreaterThan(setupRuntime);
    expect(verifyObsidianLayout).toBeGreaterThan(setupElectron);
    expect(buildMacos).toBeGreaterThan(verifyObsidianLayout);
    expect(workflow.match(/npm run setup:electron/gu)).toHaveLength(1);
    expect(
      workflow.match(
        /npx vitest run apps\/desktop\/test\/knowledge-layout\.test\.ts/gu,
      ),
    ).toHaveLength(1);
    expect(macosJob).not.toMatch(/xvfb|fake display/iu);
    // A test file renamed in the repository left its old path here, and vitest ends a run that finds none with a
    // failure: both native builds failed on it before building anything. Every file a step runs has to be there.
    const runTests = [...workflow.matchAll(/npx vitest run ([^\n]+)/gu)].flatMap((match) => match[1]!.trim().split(/\s+/u));
    expect(runTests.length).toBeGreaterThan(0);
    for (const path of runTests) expect(existsSync(path), path).toBe(true);
    expect(workflow).toContain("scripts/verify-release-set.mjs");
    expect(workflow).toContain("scripts/smoke-installed-windows.ps1");
    expect(windowsSmoke).toContain('ArgumentList "--silent"');
    expect(windowsSmoke).toContain("Stop-Process -Force");
    expect(windowsSmoke).toContain(
      '$squirrelLog = Join-Path $packageRoot "Squirrel-UpdateSelf.log"',
    );
    const stopInstalledApp = windowsSmoke.indexOf("Stop-Process -Force");
    const removeRuntimeLog = windowsSmoke.indexOf(
      "Remove-Item -LiteralPath $squirrelLog -Force",
    );
    const beginPayloadSmoke = windowsSmoke.indexOf(
      "$env:DECISION_SMOKE_PACKAGE_ROOT = $packageRoot",
    );
    expect(removeRuntimeLog).toBeGreaterThan(stopInstalledApp);
    expect(removeRuntimeLog).toBeLessThan(beginPayloadSmoke);
    expect(windowsSmoke).toContain("DECISION_SMOKE_PACKAGE_ROOT");
    expect(windowsSmoke).toContain('ArgumentList "--uninstall", "-s"');
    // The install root's launcher, run as the hooks run it, and giving out its own path: cmd's handling of it is
    // seen on a real Windows install, not only its text in a unit test.
    expect(windowsSmoke).toContain('& cmd.exe /d /v:off /c call "$launcher" install --dry-run');
    expect(windowsSmoke).toContain("-contains $launcher");
    expect(windowsSmoke.indexOf("install --dry-run")).toBeGreaterThan(windowsSmoke.indexOf("npm run smoke"));
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
