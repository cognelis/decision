# Decision Cross-Platform Binary Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a Windows x64 Squirrel installer and an Apple Silicon macOS ZIP by default for every valid Decision release tag, with honest unsigned-build warnings and preserved 1.x data/integration compatibility.

**Architecture:** Keep Electron Forge as the single packager and introduce a small target-contract module shared by Forge-facing tests, smoke checks, and release verification. Native runners build and verify their own platform; a final Linux job verifies that both immutable artifact sets agree on version and source commit before it alone writes the GitHub Release. Platform-specific paths and commands stay behind focused helpers so the decision domain and persisted data formats remain unchanged.

**Tech Stack:** Electron 43, Electron Forge 7, MakerZIP, MakerSquirrel, electron-squirrel-startup, TypeScript 7, Node.js 22, Vitest 4, GitHub Actions, GitHub CLI

---

## File structure

- `scripts/platform-artifacts.mjs`: defines supported release targets, deterministic names, Forge output paths, and packaged-app layouts.
- `scripts/build-native.mjs`: builds Apple-only helpers on macOS and removes stale Apple outputs elsewhere.
- `scripts/release-artifact.mjs`: validates one native artifact and emits its publication files.
- `scripts/verify-release-set.mjs`: validates the complete two-platform set before publication.
- `apps/desktop/src/main/application-paths.ts`: owns platform-specific data, vault, and Obsidian paths.
- `apps/desktop/src/main/index.ts`: selects packaged resources and exits on Squirrel lifecycle events.
- `packages/integrations/src/hooks.ts`: renders POSIX and Windows hook commands.
- `packages/integrations/src/install.ts`: executes client CLI commands on both shell families.
- `.github/workflows/release.yml`: builds natively and grants write permission only to the aggregate release job.

### Task 1: Lock the release target contract

**Files:**
- Create: `scripts/platform-artifacts.mjs`
- Create: `scripts/test/platform-artifacts.test.ts`

- [ ] **Step 1: Write the failing target-contract tests**

```ts
import { describe, expect, it } from "vitest";

// @ts-expect-error executable ESM module without declarations
import { releaseTarget, supportedReleaseTargets } from "../platform-artifacts.mjs";

describe("release platform contract", () => {
  it("supports exactly Windows x64 and Apple Silicon macOS", () => {
    expect(supportedReleaseTargets()).toEqual([
      { platform: "win32", arch: "x64" },
      { platform: "darwin", arch: "arm64" },
    ]);
  });

  it("uses deterministic Forge and public paths", () => {
    expect(releaseTarget({
      repositoryRoot: "/repo",
      productName: "Decision",
      version: "1.1.0",
      platform: "win32",
      arch: "x64",
    })).toMatchObject({
      artifactName: "Decision-1.1.0-win-x64-Setup.exe",
      manifestName: "decision-win32-x64.json",
      signature: "unsigned",
      packagedExecutable: "/repo/out/Decision-win32-x64/Decision.exe",
    });
    expect(releaseTarget({
      repositoryRoot: "/repo",
      productName: "Decision",
      version: "1.1.0",
      platform: "darwin",
      arch: "arm64",
    })).toMatchObject({
      artifactName: "Decision-darwin-arm64-1.1.0.zip",
      manifestName: "decision-darwin-arm64.json",
      signature: "ad-hoc",
      packagedExecutable:
        "/repo/out/Decision-darwin-arm64/Decision.app/Contents/MacOS/Decision",
    });
  });

  it("rejects every unsupported target", () => {
    expect(() => releaseTarget({
      repositoryRoot: "/repo",
      productName: "Decision",
      version: "1.1.0",
      platform: "linux",
      arch: "x64",
    })).toThrow(/unsupported release target/i);
  });
});
```

- [ ] **Step 2: Run the test and confirm the missing module fails**

Run: `npx vitest run scripts/test/platform-artifacts.test.ts`

Expected: FAIL because `scripts/platform-artifacts.mjs` does not exist.

- [ ] **Step 3: Implement the target-contract module**

Return these fields from `releaseTarget`: `platform`, `arch`, `signature`, `artifactName`, `artifactPath`, `checksumName`, `manifestName`, `packageRoot`, `packagedExecutable`, `bridgePath`, and `legacyBridgePath`. The Windows maker path is `out/make/squirrel.windows/x64/<artifact>`; the macOS maker path is `out/make/zip/darwin/arm64/<artifact>`. Use `win32.join` for Windows fixture paths and `posix.join` for macOS even when tests run on another host. Reject every target other than `win32/x64` and `darwin/arm64`.

- [ ] **Step 4: Run the target tests**

Run: `npx vitest run scripts/test/platform-artifacts.test.ts`

Expected: PASS with 3 tests.

- [ ] **Step 5: Commit the target contract**

```bash
git add scripts/platform-artifacts.mjs scripts/test/platform-artifacts.test.ts
git commit -m "build: define cross-platform release targets"
```

### Task 2: Add Windows packaging and safe native-build dispatch

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `forge.config.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/test/forge-config.test.ts`
- Create: `scripts/build-native.mjs`
- Create: `scripts/test/build-native.test.ts`
- Create: `apps/desktop/assets/app-icon.ico`
- Modify: `scripts/build-icons.sh`

- [ ] **Step 1: Write failing tests for makers, Squirrel startup, and native dispatch**

Extend `apps/desktop/test/forge-config.test.ts`:

```ts
expect(packageJson).toMatchObject({
  author: "Cognelis contributors",
  description: expect.stringContaining("decision"),
});
expect(packageJson.dependencies).toHaveProperty("electron-squirrel-startup");
expect(packageJson.devDependencies).toHaveProperty(
  "@electron-forge/maker-squirrel",
  "7.11.2",
);
expect(JSON.stringify(forgeConfig.makers)).toContain("squirrel");
expect(JSON.stringify(forgeConfig.makers)).toContain(
  `Decision-${packageJson.version}-win-x64-Setup.exe`,
);
```

Add `scripts/test/build-native.test.ts`:

```ts
import { describe, expect, it } from "vitest";

// @ts-expect-error executable ESM module without declarations
import { nativeBuildPlan } from "../build-native.mjs";

describe("native build plan", () => {
  it("builds both Apple helpers only on macOS", () => {
    expect(nativeBuildPlan("darwin")).toEqual([
      "scripts/build-foundation-model-helper.sh",
      "scripts/build-liquid-glass-addon.sh",
    ]);
    expect(nativeBuildPlan("win32")).toEqual([]);
    expect(nativeBuildPlan("linux")).toEqual([]);
  });
});
```

Add a source-level assertion that `index.ts` imports `electron-squirrel-startup` and guards user-data configuration behind a false startup flag.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run apps/desktop/test/forge-config.test.ts scripts/test/build-native.test.ts`

Expected: FAIL because the Squirrel maker, dependency, icon, and dispatcher are absent.

- [ ] **Step 3: Install exact dependencies**

```bash
npm install --save-dev --save-exact @electron-forge/maker-squirrel@7.11.2
npm install --save --save-exact electron-squirrel-startup@1.0.1
```

Expected: npm completes without changing the locked Electron or other Forge versions.

- [ ] **Step 4: Configure MakerSquirrel and platform icons**

Import `MakerSquirrel`, read the package version, retain MakerZIP for `darwin`, and add:

```ts
new MakerSquirrel({
  name: "Decision",
  authors: "Cognelis contributors",
  description: "Local-first decision capture and review platform",
  setupExe: `Decision-${packageVersion}-win-x64-Setup.exe`,
  setupIcon: "apps/desktop/assets/app-icon.ico",
  noMsi: true,
})
```

Set `packagerConfig.icon` to extensionless `apps/desktop/assets/app-icon` so Electron Packager selects `.icns` or `.ico`. Keep `createMacDistributionConfig` unchanged.

- [ ] **Step 5: Generate and validate the Windows icon**

Extend `scripts/build-icons.sh` so the same rendered app PNG produces a checked-in ICO with 16, 32, 48, 64, 128, and 256 pixel entries. Test the binary header bytes `00 00 01 00`, require a 256-pixel entry, and reject a renamed PNG.

- [ ] **Step 6: Implement native dispatch**

Export `nativeBuildPlan(platform = process.platform)`. On macOS, execute the two existing shell scripts sequentially. Else create `dist/semantic` and `dist/native`, delete stale Apple outputs and legacy aliases, copy only the Qwen manifest into `dist/semantic`, and never invoke `sh`, `xcrun`, or a compiler. Replace duplicated shell calls in `build` and `make` with `npm run build:native`.

- [ ] **Step 7: Exit early for Squirrel lifecycle events**

Use:

```ts
if (squirrelStartup) {
  app.quit();
} else {
  const userDataResolution = configureElectronUserDataPath(app);
  // Existing single-instance and whenReady startup live in this branch.
}
```

No SQLite, spool, vault, server, or window may open on a Squirrel event.

- [ ] **Step 8: Run focused and full tests**

Run: `npx vitest run apps/desktop/test/forge-config.test.ts scripts/test/build-native.test.ts scripts/test/package-scripts.test.ts`

Expected: PASS.

Run: `npm run check`

Expected: typecheck and all tests PASS.

- [ ] **Step 9: Commit packaging support**

```bash
git add package.json package-lock.json forge.config.ts apps/desktop/src/main/index.ts apps/desktop/test/forge-config.test.ts apps/desktop/assets/app-icon.ico scripts/build-icons.sh scripts/build-native.mjs scripts/test/build-native.test.ts scripts/test/package-scripts.test.ts
git commit -m "build: add native Windows packaging"
```

### Task 3: Package and address the bridge on both platforms

**Files:**
- Create: `apps/bridge/resources/decision-bridge.cmd`
- Create: `apps/bridge/resources/decision-island-bridge.cmd`
- Modify: `apps/bridge/vite.config.ts`
- Modify: `apps/bridge/test/vite-config.test.ts`
- Create: `apps/desktop/src/main/bridge-path.ts`
- Create: `apps/desktop/test/bridge-path.test.ts`
- Modify: `apps/desktop/src/main/index.ts`

- [ ] **Step 1: Write failing wrapper and path tests**

```ts
expect(bridgeExecutablePath({
  packaged: true,
  platform: "win32",
  resourcesPath: "C:\\Users\\Ada\\AppData\\Local\\Decision\\resources",
  appPath: "C:\\source\\decision",
})).toBe(
  "C:\\Users\\Ada\\AppData\\Local\\Decision\\resources\\bridge\\decision-bridge.cmd",
);
expect(bridgeExecutablePath({
  packaged: true,
  platform: "darwin",
  resourcesPath: "/Applications/Decision.app/Contents/Resources",
  appPath: "/source/decision",
})).toBe(
  "/Applications/Decision.app/Contents/Resources/bridge/decision-bridge",
);
```

Read each `.cmd` fixture and assert it sets `ELECTRON_RUN_AS_NODE=1`, runs `Decision.exe`, forwards `%*`, and uses `decision-bridge.mjs` for both current and legacy entry names.

- [ ] **Step 2: Run tests and confirm they fail**

Run: `npx vitest run apps/bridge/test/vite-config.test.ts apps/desktop/test/bridge-path.test.ts`

Expected: FAIL because Windows wrappers and `bridge-path.ts` do not exist.

- [ ] **Step 3: Add Windows wrappers**

Both files use this shape:

```bat
@echo off
setlocal
set "bridge_directory=%~dp0"
set "ELECTRON_RUN_AS_NODE=1"
set "DECISION_BRIDGE_PATH=%bridge_directory%decision-bridge.cmd"
"%bridge_directory%..\..\Decision.exe" "%bridge_directory%decision-bridge.mjs" %*
exit /b %errorlevel%
```

The legacy wrapper changes only `DECISION_BRIDGE_PATH` to `decision-island-bridge.cmd`.

- [ ] **Step 4: Copy wrappers and select the runtime path**

Copy both extensionless and both `.cmd` wrappers in the Vite close-bundle hook; chmod only extensionless files. Implement `bridgeExecutablePath(options)` with `win32.join` or `posix.join`, and replace the inline function in `index.ts`.

- [ ] **Step 5: Run tests and commit**

Run: `npx vitest run apps/bridge/test/vite-config.test.ts apps/desktop/test/bridge-path.test.ts`

Expected: PASS.

```bash
git add apps/bridge/resources/decision-bridge.cmd apps/bridge/resources/decision-island-bridge.cmd apps/bridge/vite.config.ts apps/bridge/test/vite-config.test.ts apps/desktop/src/main/bridge-path.ts apps/desktop/test/bridge-path.test.ts apps/desktop/src/main/index.ts
git commit -m "feat: package Windows bridge launchers"
```

### Task 4: Make hook installation and client execution Windows-safe

**Files:**
- Modify: `packages/integrations/src/hooks.ts`
- Modify: `packages/integrations/src/claude.ts`
- Modify: `packages/integrations/src/codex.ts`
- Modify: `packages/integrations/src/install.ts`
- Modify: `packages/integrations/test/claude.test.ts`
- Modify: `packages/integrations/test/codex.test.ts`
- Modify: `packages/integrations/test/install.test.ts`
- Modify: `apps/desktop/src/main/index.ts`

- [ ] **Step 1: Write failing Windows hook and runner tests**

Pass an optional platform through merge and installation APIs. Require:

```ts
expect(windowsCommand).toBe(
  'set "DECISION_HOOK=1" && call "C:\\Program Files\\Decision\\resources\\bridge\\decision-bridge.cmd" hook stop codex',
);
expect(posixCommand).toBe(
  "DECISION_HOOK=1 '/Applications/Decision.app/Contents/Resources/bridge/decision-bridge' hook stop codex",
);
```

With an injected spawn function, prove Windows invokes `process.env.ComSpec ?? "cmd.exe"` with `/d /s /c`, while macOS spawns `claude` or `codex` directly. Existing non-Decision handlers and unknown fields remain equivalent after parse/format.

- [ ] **Step 2: Run tests and confirm they fail**

Run: `npx vitest run packages/integrations/test/claude.test.ts packages/integrations/test/codex.test.ts packages/integrations/test/install.test.ts`

Expected: FAIL because platform-aware command rendering and execution are absent.

- [ ] **Step 3: Implement platform-aware hook rendering**

Add `platform: NodeJS.Platform = process.platform` to merge APIs. Retain POSIX single-quote escaping. Windows uses `set "DECISION_HOOK=1" && call "<bridge>" ...`; reject NUL, CR, or LF, and double literal `%` to `%%` before inserting paths. Keep the stable marker and three events unchanged.

- [ ] **Step 4: Implement the Windows runner**

Export `createCommandRunner({ platform, commandInterpreter, spawn })`. On Windows, quote each argument for cmd and execute through `/d /s /c`; elsewhere retain direct spawn. Preserve stderr capture and exact absent-MCP failure handling. Have `installIntegrations` pass its platform to hook merge and runner creation.

- [ ] **Step 5: Wire Electron, run tests, and commit**

Pass `platform: process.platform` from `index.ts`.

Run: `npx vitest run packages/integrations/test/claude.test.ts packages/integrations/test/codex.test.ts packages/integrations/test/install.test.ts apps/desktop/test/integration-status.test.ts`

Expected: PASS, including existing idempotent 1.x upgrade and no-write-on-failure cases.

```bash
git add packages/integrations/src/hooks.ts packages/integrations/src/claude.ts packages/integrations/src/codex.ts packages/integrations/src/install.ts packages/integrations/test/claude.test.ts packages/integrations/test/codex.test.ts packages/integrations/test/install.test.ts apps/desktop/src/main/index.ts
git commit -m "fix: make integrations portable to Windows"
```

### Task 5: Resolve Windows Obsidian configuration without touching stored data

**Files:**
- Modify: `apps/desktop/src/main/application-paths.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/test/application-paths.test.ts`
- Modify: `apps/desktop/test/brand-migration.test.ts`

- [ ] **Step 1: Write failing path and migration tests**

```ts
expect(resolveObsidianConfigurationPath({
  platform: "win32",
  homeDirectory: "C:\\Users\\Ada",
  appData: "D:\\Profiles\\Ada\\Roaming",
})).toBe("D:\\Profiles\\Ada\\Roaming\\obsidian\\obsidian.json");
expect(resolveObsidianConfigurationPath({
  platform: "darwin",
  homeDirectory: "/Users/ada",
})).toBe(
  "/Users/ada/Library/Application Support/obsidian/obsidian.json",
);
```

Add a Windows migration fixture equivalent to the existing macOS fixture and assert every historical and pending file hash remains unchanged when `Decision Island` becomes `Decision`.

- [ ] **Step 2: Run tests and confirm failure**

Run: `npx vitest run apps/desktop/test/application-paths.test.ts apps/desktop/test/brand-migration.test.ts`

Expected: FAIL because the Obsidian resolver is absent and bootstrap is macOS-only.

- [ ] **Step 3: Implement and wire the resolver**

Use `%APPDATA%` with `AppData/Roaming` fallback on Windows, `Library/Application Support` on macOS, and `XDG_CONFIG_HOME` with `.config` fallback on Linux. Replace the inline macOS join in `index.ts`; do not change settings schema, vault contents, IDs, spool formats, or migration ordering.

- [ ] **Step 4: Run migration coverage and commit**

Run: `npx vitest run apps/desktop/test/application-paths.test.ts apps/desktop/test/brand-migration.test.ts apps/desktop/test/recovery.integration.test.ts`

Expected: PASS with unchanged historical and pending fixtures.

```bash
git add apps/desktop/src/main/application-paths.ts apps/desktop/src/main/index.ts apps/desktop/test/application-paths.test.ts apps/desktop/test/brand-migration.test.ts
git commit -m "fix: discover Windows application paths"
```

### Task 6: Generalize packaged smoke and artifact verification

**Files:**
- Modify: `scripts/smoke.mjs`
- Modify: `scripts/release-artifact.mjs`
- Modify: `scripts/test/release-artifact.test.ts`
- Create: `scripts/verify-release-set.mjs`
- Create: `scripts/test/verify-release-set.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing manifest and release-set tests**

Require schema v2:

```ts
expect(documents.manifest).toEqual({
  schemaVersion: 2,
  product: "Decision",
  version: "1.1.0",
  platform: "win32",
  arch: "x64",
  artifact: {
    name: "Decision-1.1.0-win-x64-Setup.exe",
    bytes: 123456,
    sha256: "a".repeat(64),
  },
  signature: "unsigned",
  sourceCommit: "b".repeat(40),
  updatePolicy: "manual",
});
```

Test macOS accepts only `ad-hoc` or `developer-id`, Windows only `unsigned` or `authenticode`, source commit is 40 lowercase hex, and a Windows Setup has valid DOS and PE signatures. Create a temporary complete set; require success only when version, current tag commit, size, hash, checksum, and exact target pairs agree. Missing Windows files, mismatched commits, or an unexpected third artifact must fail.

- [ ] **Step 2: Run tests and confirm failure**

Run: `npx vitest run scripts/test/release-artifact.test.ts scripts/test/verify-release-set.test.ts`

Expected: FAIL because schema v2, Windows verification, and aggregation are absent.

- [ ] **Step 3: Generalize one-platform verification**

Use `releaseTarget()` and accept `--platform` plus `--arch`. Common checks cover SemVer, tag agreement, exact tag-to-HEAD when required, size, hash, forbidden names, and current commit. macOS retains ZIP safety, plist versions, contents, codesign, and optional Developer ID/Gatekeeper/stapler. Windows reads the final Setup, validates DOS/PE structure, silently installs it, scans and smokes the installed application plus current/legacy bridges, then uninstalls it in cleanup.

Copy only the main artifact, `.sha256`, and schema-v2 manifest into `out/release`. Never copy `.nupkg`, `RELEASES`, source maps, weights, databases, or fixtures.

- [ ] **Step 4: Make packaged smoke platform-aware**

Use `releaseTarget()` for the executable and bridge. macOS retains Foundation and Liquid Glass checks. Windows asserts Apple binaries are absent, invokes `.cmd` through `ComSpec`, and runs the same isolated health, Hook, MCP, pending-capture, Markdown, SQLite, and cleanup flow.

- [ ] **Step 5: Implement complete-set verification**

`verifyReleaseSet({ directory, version, tag })` requires exactly:

```text
Decision-<version>-win-x64-Setup.exe
Decision-<version>-win-x64-Setup.exe.sha256
decision-win32-x64.json
Decision-darwin-arm64-<version>.zip
Decision-darwin-arm64-<version>.zip.sha256
decision-darwin-arm64.json
```

Parse manifests, independently hash artifacts, verify checksum text, and require identical product, version, source commit, and `manual` update policy. Expose `--directory`, `--version`, `--tag`, and an expected `--source-commit` bound to the workflow tag commit. Keep this aggregate import path dependency-free.

- [ ] **Step 6: Run verifier tests and native macOS smoke**

Run: `npx vitest run scripts/test/platform-artifacts.test.ts scripts/test/release-artifact.test.ts scripts/test/verify-release-set.test.ts`

Expected: PASS.

Run: `npm run make -- --platform=darwin --arch=arm64 && npm run smoke && npm run release:verify`

Expected: isolated App smoke passes and `out/release` has the macOS ZIP, checksum, and schema-v2 manifest.

- [ ] **Step 7: Commit release verification**

```bash
git add scripts/smoke.mjs scripts/release-artifact.mjs scripts/test/release-artifact.test.ts scripts/verify-release-set.mjs scripts/test/verify-release-set.test.ts package.json
git commit -m "build: verify native release artifacts"
```

### Task 7: Add the native GitHub release workflow

**Files:**
- Create: `.github/workflows/release.yml`
- Create: `docs/release-notes.md`
- Create: `scripts/test/release-workflow.test.ts`

- [ ] **Step 1: Write the failing workflow policy test**

```ts
expect(workflow).toContain("windows-latest");
expect(workflow).toContain("macos-26");
expect(workflow).toContain("--platform=win32 --arch=x64");
expect(workflow).toContain("--platform=darwin --arch=arm64");
expect(workflow.match(/contents: write/gu)).toHaveLength(1);
expect(workflow).toContain("needs: [quality, build-windows, build-macos]");
expect(workflow).toContain("scripts/verify-release-set.mjs");
expect(workflow).toContain("github.ref_type == 'tag'");
expect(workflow).toContain("release-${{ github.ref }}");
```

Also assert release notes name both downloads, disclose unsigned Windows and ad-hoc/non-notarized macOS, explain SmartScreen and Gatekeeper graphical recovery, state SHA-256 is integrity rather than publisher identity, and never recommend globally disabling security.

- [ ] **Step 2: Run the test and confirm missing files fail**

Run: `npx vitest run scripts/test/release-workflow.test.ts`

Expected: FAIL because workflow and notes do not exist.

- [ ] **Step 3: Implement the workflow**

Create `v*` tag and `workflow_dispatch` triggers, top-level `permissions: contents: read`, and concurrency `release-${{ github.ref }}`. Use Node 22 with `npm ci --ignore-scripts`.

- `quality` on Ubuntu runs `npm run quality`, `npm run audit:runtime`, and portability audit.
- `build-windows` on `windows-latest` first runs the native byte-preserving migration fixture, makes `win32/x64`, installs the final Setup, scans and smokes the installed payload, uninstalls it, then uploads verified `out/release/*` for 7 days.
- `build-macos` on `macos-26` makes `darwin/arm64`, runs smoke and native verification, then uploads its three files for 7 days. The runner version matches the Foundation Models helper's macOS 26 SDK requirement.
- `release` needs all three, runs only for a tag, alone receives `contents: write`, merges downloads into a clean directory, and verifies the complete set against `github.sha`. It creates or repairs only an invisible draft, deletes unexpected draft assets, uploads and re-downloads exactly six files, verifies them again, then publishes once. An already-published Release is immutable and must already match the tag commit.

Use `actions/checkout@v4`, `actions/setup-node@v4`, `actions/upload-artifact@v4`, and `actions/download-artifact@v4`. Do not expose repository or environment secrets to build jobs.

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run scripts/test/release-workflow.test.ts scripts/test/release-portability.test.ts`

Expected: PASS with exactly one release-writer permission and no secret/path finding.

```bash
git add .github/workflows/release.yml docs/release-notes.md scripts/test/release-workflow.test.ts
git commit -m "ci: publish Windows and Apple Silicon releases"
```

### Task 8: Advance the public version and documentation

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `apps/bridge/package.json`
- Modify: `apps/desktop/package.json`
- Modify: `packages/core/package.json`
- Modify: `packages/integrations/package.json`
- Modify: `packages/protocol/package.json`
- Modify: `packages/storage/package.json`
- Modify: `scripts/test/package-scripts.test.ts`
- Modify: `scripts/test/release-portability.test.ts`
- Modify: `README.md`
- Modify: `docs/release.md`
- Modify: `docs/decisions/implementation-decisions.md`

- [ ] **Step 1: Write failing version and documentation assertions**

Require root/workspace/internal dependency version `1.1.0`. Extend portability coverage so documentation contains `Windows x64` and `Apple Silicon`, the workflow is scanned, and the new spec/plan are allowlisted only for their explicit 1.x legacy compatibility language.

- [ ] **Step 2: Run tests and confirm the old contract fails**

Run: `npx vitest run scripts/test/package-scripts.test.ts scripts/test/release-portability.test.ts`

Expected: FAIL because packages and docs still describe 1.0.0 macOS-only behavior.

- [ ] **Step 3: Bump all workspaces together**

Set the root and six workspace versions to `1.1.0`; set every internal `@cognelis/decision-*` dependency to exact `1.1.0`; refresh lock metadata with npm. Do not create or move a Git tag.

- [ ] **Step 4: Rewrite build and release guidance**

README describes a cross-platform desktop product, lists both downloads, separates Windows and macOS prerequisites, retains `npm ci`/`npm run check`/`npm run make`, documents first-run warnings through graphical system UI, and keeps 1.x migration/privacy/pending/manual-update statements.

`docs/release.md` defines the two-target table, schema-v2 manifest, unsigned/ad-hoc meanings, workflow, optional Developer ID enhancement, complete-set failure, and manual updates. Remove claims that unsigned public binaries are forbidden or a private runner is required.

Append IMP-071 (IMP-069 is already the autonomous-decision record): hosted native runners publish unsigned Windows x64 and ad-hoc Apple Silicon artifacts with explicit warnings; auto-update remains deferred. Mark the conflicting parts of IMP-062 and IMP-068 superseded without deleting history.

- [ ] **Step 5: Run tests and commit**

Run: `npx vitest run scripts/test/package-scripts.test.ts scripts/test/release-portability.test.ts scripts/test/release-workflow.test.ts`

Expected: PASS with no secret, maintainer path, or uncontrolled legacy brand.

```bash
git add package.json package-lock.json apps/bridge/package.json apps/desktop/package.json packages/core/package.json packages/integrations/package.json packages/protocol/package.json packages/storage/package.json scripts/test/package-scripts.test.ts scripts/test/release-portability.test.ts README.md docs/release.md docs/decisions/implementation-decisions.md
git commit -m "chore: prepare Decision 1.1.0"
```

### Task 9: Verify and publish the release candidate

**Files:**
- Modify only for a scoped defect reproduced by a failing test; give every fix its own commit.

- [ ] **Step 1: Run complete local gates**

Run: `npm run quality`

Expected: typecheck, all Vitest suites, and semantic gate PASS.

Run: `npm run audit:runtime`

Expected: zero runtime dependency vulnerabilities.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 2: Re-run migration and release-security evidence**

```bash
npx vitest run apps/desktop/test/brand-migration.test.ts apps/desktop/test/recovery.integration.test.ts scripts/test/release-portability.test.ts scripts/test/release-workflow.test.ts scripts/test/release-artifact.test.ts scripts/test/verify-release-set.test.ts
```

Expected: historical hashes, pending-state fixtures, secret/path scans, workflow policy, and artifact contracts PASS.

- [ ] **Step 3: Build and smoke native macOS**

Run: `npm run make -- --platform=darwin --arch=arm64`

Expected: `Decision.app` and `Decision-darwin-arm64-1.1.0.zip` without Apple credentials.

Run: `npm run smoke && npm run release:verify`

Expected: isolated smoke passes and publication files bind the ad-hoc ZIP to HEAD.

- [ ] **Step 4: Review against the specification**

Invoke `superpowers:requesting-code-review`, review standards and spec coverage, fix correctness/security/portability/data findings test-first, then rerun Steps 1–3.

- [ ] **Step 5: Commit the implementation record**

Mark checkboxes only after evidence exists:

```bash
git add docs/superpowers/plans/2026-08-16-cross-platform-binary-release.md
git commit -m "docs: record cross-platform release implementation"
```

- [ ] **Step 6: Push without changing v1.0.0**

Publish the reviewed tree to GitHub `main` through the established clean-public-tree procedure. Confirm the existing `v1.0.0` tag and source Release remain unchanged.

- [ ] **Step 7: Tag only the exact reviewed public commit**

Create and push annotated `v1.1.0`. Do not upload local binaries; the tag triggers native CI.

- [ ] **Step 8: Require native evidence**

Wait for `quality`, `build-windows`, `build-macos`, and `release`. Inspect logs for actual native make, smoke, and verification. Diagnose failures with `superpowers:systematic-debugging`; after a published immutable tag, fix forward as `v1.1.1` rather than moving it.

- [ ] **Step 9: Verify the public Release**

Require exactly two main artifacts, two checksums, and two manifests; recompute hashes; require identical version/source commit; confirm warnings are visible. Do not claim Windows availability until its Windows-hosted smoke passes.
