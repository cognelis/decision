# Cognelis Brand Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the codebase to Cognelis / Decision while preserving every historical knowledge artifact and every pending local item from an existing Decision Island installation.

**Architecture:** A single environment compatibility module resolves current and legacy variables, while the desktop path boundary performs an atomic whole-directory migration before Electron takes its single-instance lock or opens storage. All normal code is mechanically renamed to the new package, IPC, preload, artifact, and product identifiers; legacy strings remain only in compatibility files, migration tests, and the migration specification.

**Tech Stack:** TypeScript 7, Node.js 22, Electron 43, Vite 8, Vitest 4, npm workspaces, Markdown, SQLite.

**Commit policy:** The user explicitly requested that migration changes be committed only after the complete migration passes verification. Tasks therefore use test checkpoints instead of intermediate commits and end with one final commit.

---

## File structure

- Create `config/decision-environment.mjs`: one runtime/build-time resolver for `DECISION_*` with `DECISION_ISLAND_*` fallback.
- Create `config/decision-environment.d.mts`: strict TypeScript declarations for the resolver.
- Create `scripts/test/decision-environment.test.ts`: precedence, empty-value, and source reporting tests.
- Modify `apps/desktop/src/main/application-paths.ts`: resolve new defaults and atomically migrate the legacy user-data directory before startup.
- Expand `apps/desktop/test/application-paths.test.ts`: old-only, new-only, conflict, explicit override, failure fallback, and idempotence tests.
- Create `apps/desktop/test/brand-migration.test.ts`: content-preservation fixture covering history and pending-state files.
- Modify `apps/desktop/src/main/index.ts`: consume one resolved environment/path object and remove direct legacy environment reads.
- Modify `packages/integrations/src/hooks.ts`, `claude.ts`, `codex.ts`, `install.ts`, and tests: migrate hooks and MCP names without touching unrelated client configuration.
- Modify `apps/bridge/vite.config.ts` and `apps/bridge/resources/*`: build the current bridge plus a 1.x compatibility entrypoint.
- Modify package manifests, TypeScript/Vite aliases, source imports, preload API, IPC strings, build scripts, native/helper names, smoke fixtures, and release verification to the new namespace.
- Modify README, release/privacy docs, historical engineering docs, and brand-bearing filenames so public-facing material consistently says Decision.
- Modify `scripts/test/release-portability.test.ts`: enforce the allowed legacy-string boundary and current secret/path checks.

### Task 1: Central environment compatibility boundary

**Files:**
- Create: `config/decision-environment.mjs`
- Create: `config/decision-environment.d.mts`
- Create: `scripts/test/decision-environment.test.ts`
- Modify: `tsconfig.json`

- [ ] **Step 1: Write failing precedence and diagnostics tests**

```ts
import { describe, expect, it } from "vitest";

import {
  readDecisionEnvironment,
  readDecisionEnvironmentWithSource,
} from "../../config/decision-environment.mjs";

describe("Decision environment compatibility", () => {
  it("prefers the current name", () => {
    expect(
      readDecisionEnvironment(
        { DECISION_USER_DATA: "/new", DECISION_ISLAND_USER_DATA: "/old" },
        "USER_DATA",
      ),
    ).toBe("/new");
  });

  it("falls back to the legacy name throughout 1.x", () => {
    expect(
      readDecisionEnvironment({ DECISION_ISLAND_RUNTIME_FILE: "/old/runtime" }, "RUNTIME_FILE"),
    ).toBe("/old/runtime");
  });

  it("treats empty values as unset and reports the selected source", () => {
    expect(
      readDecisionEnvironmentWithSource(
        { DECISION_SMOKE: "", DECISION_ISLAND_SMOKE: "1" },
        "SMOKE",
      ),
    ).toEqual({ value: "1", source: "legacy" });
  });
});
```

- [ ] **Step 2: Run the focused test and verify the module is missing**

Run: `npx vitest run scripts/test/decision-environment.test.ts`
Expected: FAIL because `config/decision-environment.mjs` does not exist.

- [ ] **Step 3: Implement the resolver without logging values**

```js
const value = (environment, key) => {
  const candidate = environment[key];
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
};

export const readDecisionEnvironmentWithSource = (environment, suffix) => {
  const current = value(environment, `DECISION_${suffix}`);
  if (current !== undefined) return { value: current, source: "current" };
  const legacy = value(environment, `DECISION_ISLAND_${suffix}`);
  return legacy === undefined
    ? { value: undefined, source: "default" }
    : { value: legacy, source: "legacy" };
};

export const readDecisionEnvironment = (environment, suffix) =>
  readDecisionEnvironmentWithSource(environment, suffix).value;
```

The declaration file defines `DecisionEnvironmentSource`, `DecisionEnvironmentResolution`, and the two function signatures with `NodeJS.ProcessEnv` and `string` suffixes. Add `config/**/*.mts` to the TypeScript include list.

- [ ] **Step 4: Run resolver tests and type checking**

Run: `npx vitest run scripts/test/decision-environment.test.ts`
Expected: PASS, 3 tests.

Run: `npm run typecheck`
Expected: PASS.

### Task 2: Atomic user-data migration before storage startup

**Files:**
- Modify: `apps/desktop/src/main/application-paths.ts`
- Modify: `apps/desktop/test/application-paths.test.ts`
- Modify: `apps/desktop/src/main/index.ts`

- [ ] **Step 1: Replace the old path tests with the complete migration matrix**

Add tests that inject a fake file-system boundary and assert these exact results:

```ts
expect(resolve("old-only")).toMatchObject({
  path: "/home/Library/Application Support/Decision",
  state: "migrated",
});
expect(resolve("both")).toMatchObject({
  path: "/home/Library/Application Support/Decision",
  state: "conflict",
});
expect(resolve("rename-fails")).toMatchObject({
  path: "/home/Library/Application Support/Decision Island",
  state: "legacy-fallback",
});
expect(resolve("explicit-legacy-env")).toMatchObject({
  path: "/custom/user-data",
  state: "explicit",
  environmentSource: "legacy",
});
```

Also assert that a second invocation after a successful rename returns `current` and never calls `rename` again.

- [ ] **Step 2: Run the focused path test and verify it fails**

Run: `npx vitest run apps/desktop/test/application-paths.test.ts`
Expected: FAIL because the current function only honors the legacy explicit override.

- [ ] **Step 3: Implement `resolveDecisionUserData` and return a startup report**

The module exposes these stable types:

```ts
export type UserDataMigrationState =
  | "explicit"
  | "current"
  | "migrated"
  | "legacy-fallback"
  | "conflict";

export interface UserDataResolution {
  path: string;
  state: UserDataMigrationState;
  environmentSource: "current" | "legacy" | "default";
  migrationError?: string;
}
```

`resolveDecisionUserData` must:

1. read `USER_DATA` through `readDecisionEnvironmentWithSource`;
2. return explicit paths without moving defaults;
3. compute platform defaults (`Decision` current, historical name legacy);
4. use an injected `existsSync`/`renameSync`/`writeFileSync` boundary;
5. atomically rename only when legacy exists and current does not;
6. write `.cognelis-migration-v1.json` with mode `0o600` after success;
7. return the legacy path unchanged if rename throws;
8. return current with `conflict` if both exist.

`configureElectronUserDataPath` always calls `app.setPath("userData", resolution.path)` and returns the resolution.

- [ ] **Step 4: Wire the resolved path into bootstrap before the lock**

At module startup:

```ts
const userDataResolution = configureElectronUserDataPath(app);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app.whenReady().then(() => bootstrap(userDataResolution));
}
```

Change `applicationSupportPaths` to accept the selected user-data root and obtain all override values through `readDecisionEnvironment`. Do not recompute a default directory inside `bootstrap`.

- [ ] **Step 5: Run path tests and the main-process test set**

Run: `npx vitest run apps/desktop/test/application-paths.test.ts`
Expected: PASS for the complete migration matrix.

Run: `npx vitest run apps/desktop/test`
Expected: PASS.

### Task 3: Prove history and pending state survive as one unit

**Files:**
- Create: `apps/desktop/test/brand-migration.test.ts`
- Modify: `apps/desktop/src/main/application-paths.ts` only if the fixture exposes a migration defect

- [ ] **Step 1: Create an old-layout fixture with representative byte content**

The test creates a temporary home containing:

```text
Library/Application Support/Decision Island/
  settings.json
  index.sqlite
  semantic-vectors.sqlite
  capture-spool/pending-rationale.json
  candidate-spool/pending-candidate.json
  semantic-pair-spool/pending-pair.json
  text-pending/pending-text.json
  manual-form-drafts.json
  methodology-suggestion-preferences.json
  practice-asset-history/history.json
  practice-publications/status.json
  model-provider-profiles.json
  model-provider-credentials/provider.bin
  models/model.gguf
Documents/Decision Island Vault/
  Decisions/DEC-001.md
  Methodologies/MET-001.md
  Practice Assets/PRA-001.md
```

Use unique fixed contents for every file, recursively hash the old application directory before migration, run `resolveDecisionUserData`, and recursively hash the new directory after migration. Assert equality excluding only `.cognelis-migration-v1.json`.

- [ ] **Step 2: Assert the two product invariants**

```ts
expect(historyAfter).toEqual(historyBefore);
expect(pendingAfter).toEqual(pendingBefore);
expect(readSettings().vaultPath).toBe(oldVaultPath);
expect(oldVaultHashesAfter).toEqual(oldVaultHashesBefore);
expect(existsSync(oldApplicationData)).toBe(false);
expect(existsSync(newApplicationData)).toBe(true);
```

The `history` set includes Markdown references, SQLite/index/history/profile files; the `pending` set includes every spool, draft, preference, publication, and credential/model byte fixture. A corrupt pending JSON file is deliberately included and must still exist unchanged after migration.

- [ ] **Step 3: Run the preservation test**

Run: `npx vitest run apps/desktop/test/brand-migration.test.ts`
Expected: PASS with byte-for-byte history and pending-state equality.

### Task 4: Migrate Hooks, MCP registration, and bridge entrypoints

**Files:**
- Modify: `packages/integrations/src/hooks.ts`
- Modify: `packages/integrations/src/index.ts`
- Modify: `packages/integrations/src/claude.ts`
- Modify: `packages/integrations/src/codex.ts`
- Modify: `packages/integrations/src/install.ts`
- Modify: `packages/integrations/test/claude.test.ts`
- Modify: `packages/integrations/test/codex.test.ts`
- Modify: `packages/integrations/test/install.test.ts`
- Modify: `apps/bridge/vite.config.ts`
- Create: `apps/bridge/resources/decision-bridge`
- Preserve as compatibility: `apps/bridge/resources/decision-island-bridge`

- [ ] **Step 1: Update tests to require new markers and legacy cleanup**

Tests must assert:

```ts
expect(serialized.match(/DECISION_HOOK=1/gu)).toHaveLength(3);
expect(serialized).not.toContain("DECISION_ISLAND_HOOK=");
expect(serialized).toContain("echo keep-me");
```

MCP command arrays must first tolerate removal of `decision-island`, then tolerate removal of `decision`, then add `decision` with the new bridge path. Applying merge twice must return identical JSON.

- [ ] **Step 2: Run integration tests and verify old behavior fails**

Run: `npx vitest run packages/integrations/test`
Expected: FAIL on the marker and MCP server name assertions.

- [ ] **Step 3: Implement dual-marker cleanup and current-only output**

Export `DECISION_HOOK_MARKER = "DECISION_HOOK="` and keep the old marker private as a compatibility constant. The owned-handler predicate removes commands containing either marker. New handlers emit only `DECISION_HOOK=1`.

MCP commands remove the old name and current name idempotently before adding current `decision`. Error parsing accepts not-found messages for either exact name and continues to reject prefixes such as `decision-backup`.

- [ ] **Step 4: Build both bridge names from one implementation**

Vite emits `decision-bridge.mjs`; the close-bundle hook copies executable wrappers to both:

```text
dist/bridge/decision-bridge
dist/bridge/decision-island-bridge
```

The legacy wrapper must execute `decision-bridge.mjs`; it must not contain a forked protocol implementation.

- [ ] **Step 5: Run integration and bridge tests**

Run: `npx vitest run packages/integrations/test apps/bridge/test`
Expected: PASS.

Run: `npm run build:bridge`
Expected: both executable names and `decision-bridge.mjs` exist.

### Task 5: Rename code namespaces and internal contracts

**Files:**
- Modify: `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`
- Modify: `apps/*/package.json`, `packages/*/package.json`
- Modify: all TypeScript imports under `apps/` and `packages/`
- Modify: `apps/desktop/vite.main.config.ts`
- Modify: `apps/desktop/src/shared/renderer-api.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: renderer declarations and every renderer use of the preload API
- Modify: `forge.config.ts`

- [ ] **Step 1: Mechanically rename workspace packages and aliases**

Apply this exact mapping across manifests, lock metadata, aliases, imports, and tests:

```text
decision-island                         -> @cognelis/decision (root name only)
@cognelis/decision-core                  -> @cognelis/decision-core
@cognelis/decision-integrations          -> @cognelis/decision-integrations
@cognelis/decision-protocol              -> @cognelis/decision-protocol
@cognelis/decision-storage               -> @cognelis/decision-storage
@cognelis/decision-bridge                -> @cognelis/decision-bridge
@cognelis/decision-desktop               -> @cognelis/decision-desktop
```

Keep the existing directory layout; this is a package identity change, not a repository restructuring.

- [ ] **Step 2: Rename preload and IPC contracts**

Rename `DecisionIslandApi` to `DecisionApi`, expose only `window.decision`, update global declarations and renderer calls, and change every internal channel from `decision-island:*` to `decision:*`. Do not expose a legacy preload alias because renderer and preload ship atomically in the same App.

- [ ] **Step 3: Rename App and build identities**

In `forge.config.ts` retain product/executable `Decision`, set bundle ID to `com.cognelis.decision`, and read release environment through the compatibility resolver. Rename structured-output schema identifiers to `decision_semantic_classification` and `decision_structured_output`.

- [ ] **Step 4: Run type checking to find every incomplete rename**

Run: `npm run typecheck`
Expected: PASS; no unresolved `@decision-island/*`, `DecisionIslandApi`, or `window.decisionIsland` references.

- [ ] **Step 5: Run unit tests**

Run: `npm test`
Expected: PASS.

### Task 6: Rename artifacts, defaults, fixtures, and normal product copy

**Files:**
- Modify: `scripts/build-foundation-model-helper.sh`
- Modify: `scripts/build-liquid-glass-addon.sh`
- Modify: `scripts/build-icons.sh`
- Modify: `scripts/prepare-local-model.mjs`
- Modify: `scripts/evaluate-semantic-classifier.mjs`
- Modify: `scripts/visual-fixture.mjs`
- Modify: `scripts/smoke.mjs`
- Modify: `scripts/release-artifact.mjs`
- Modify: related tests under `scripts/test/`
- Modify: product strings under `apps/`, `packages/`, and their tests

- [ ] **Step 1: Update artifact names and test expectations**

Current output must be exactly:

```text
dist/bridge/decision-bridge
dist/semantic/decision-foundation-model-helper
dist/native/decision-liquid-glass.node
```

Only `dist/bridge/decision-island-bridge` remains as the documented 1.x compatibility alias. Temporary directories use `decision-*`; fixtures and smoke environment use current `DECISION_*` variables.

- [ ] **Step 2: Update fresh-install defaults and messages**

Fresh defaults are `Application Support/Decision`, `Documents/Decision Vault`, MCP `decision`, and product text `Decision`. Errors say `Decision failed to start` or `Decision settings are invalid`.

Do not rewrite arbitrary captured user text in protocol/storage fixtures where the phrase is intentionally example content; rename fixtures that represent App-generated content.

- [ ] **Step 3: Run scripts and release tests**

Run: `npx vitest run scripts/test`
Expected: PASS.

Run: `npm run build:foundation-helper`
Expected: current helper filename exists.

Run: `npm run build:liquid-glass`
Expected: current native addon filename exists.

### Task 7: Public documentation, license, and legacy-brand guard

**Files:**
- Create: `LICENSE`
- Modify: `README.md`
- Modify: `docs/release.md`
- Modify: `docs/semantic-recognition.md`
- Modify: `docs/decisions/implementation-decisions.md`
- Modify/rename: brand-bearing files under `docs/superpowers/specs/` and `docs/superpowers/plans/`
- Modify: `scripts/test/release-portability.test.ts`
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Add MIT licensing metadata**

Use the standard MIT text with:

```text
Copyright (c) 2026 Cognelis contributors
```

Set root package `license` to `MIT`; workspace packages remain private and inherit the repository license. Add README sections for License, Privacy, Build, and Local Data Migration.

- [ ] **Step 2: Rename engineering documentation**

Use `git mv` for filenames containing `decision-island`, replacing that segment with `decision`. Update product prose to `Decision`. Preserve old names only when a paragraph explicitly describes 1.x compatibility or the superseded publication decision.

- [ ] **Step 3: Add a denylist test with an explicit compatibility allowlist**

The portability test scans current candidate files for these patterns:

```ts
const legacyBrand = /Decision Island|decision-island|DECISION_ISLAND|DecisionIsland|decisionIsland/u;
```

Allowed files are exactly the compatibility environment module/declaration, desktop path and integration-status migration source/tests, integration compatibility source/tests, legacy bridge/runtime compatibility source/tests, storage marker compatibility source/tests, migration design/plan, and superseded publishing spec. Any other match fails with its path.

- [ ] **Step 4: Run portability, metadata, and whitespace checks**

Run: `npx vitest run scripts/test/release-portability.test.ts scripts/test/package-scripts.test.ts`
Expected: PASS.

Run: `git diff --check`
Expected: no output.

### Task 8: Full migration verification and single commit

**Files:**
- Modify only files required by failures discovered during verification

- [ ] **Step 1: Run the two hard migration acceptance suites**

Run: `npx vitest run apps/desktop/test/application-paths.test.ts apps/desktop/test/brand-migration.test.ts packages/integrations/test`
Expected: PASS; history and pending fixtures are byte-for-byte available.

- [ ] **Step 2: Run the complete quality gate**

Run: `npm run quality`
Expected: typecheck, all Vitest tests, and semantic quality gate PASS.

- [ ] **Step 3: Build and smoke the packaged App**

Run: `npm run make`
Expected: Apple Silicon Decision ZIP builds successfully with bundle ID `com.cognelis.decision`.

Run: `npm run smoke`
Expected: packaged App starts in isolation, consumes pending fixture data, and exits successfully.

Run: `npm run release:verify`
Expected: artifact manifest and forbidden-content checks PASS; no unsigned artifact is marked for public distribution.

- [ ] **Step 4: Re-run static publication audits on the complete tree**

Run: `npx vitest run scripts/test/release-portability.test.ts`
Expected: zero credential, private path, unapproved legacy-brand, or generated-artifact findings.

Run: `git status --short`
Expected: only the intended migration/spec/plan/license changes.

- [ ] **Step 5: Create the one requested migration commit**

```bash
git add --all
git commit -m "feat: migrate Decision to Cognelis"
```

Expected: one commit containing the complete migration and its specifications, with a clean working tree afterward.
