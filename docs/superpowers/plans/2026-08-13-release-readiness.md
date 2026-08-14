# Signed Release Boundary and Update Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing ad-hoc macOS package into a fail-closed, testable signed-release path while retaining fast local builds and defining a safe manual-update contract.

**Architecture:** Forge selects a pure environment-derived macOS distribution configuration. A separate built-in-only release verifier validates versions, signatures, notarization state, archive integrity, and forbidden content, then emits redacted SHA-256 metadata. CI calls one provider-neutral quality command; publishing remains a protected external step.

**Tech Stack:** TypeScript, Node.js ESM, Vitest, Electron Forge, macOS `codesign`/`spctl`/`stapler`, npm workspaces

---

## File map

- Modify `forge.config.ts` and `apps/desktop/test/forge-config.test.ts`: local
  and distribution signing/notarization boundary.
- Add `scripts/release-artifact.mjs` and
  `scripts/test/release-artifact.test.ts`: artifact contract and CLI verifier.
- Modify `package.json` and `scripts/test/package-scripts.test.ts`: quality and
  release entry points.
- Add `docs/release.md`: credentials, Gitee/macOS runner mapping, release and
  manual-update procedure.
- Modify `README.md` and `docs/decisions/implementation-decisions.md`: current
  release state and architectural decision.

### Task 1: Lock signing modes with failing tests

- [x] **Step 1: Assert the existing local ad-hoc contract**

- [x] **Step 2: Add missing and partial release-credential cases**

- [x] **Step 3: Add keychain and API-key notarization cases**

- [x] **Step 4: Run Forge tests and verify RED**

### Task 2: Lock the release artifact contract with failing tests

- [x] **Step 1: Test SemVer, tag, and artifact naming rules**

- [x] **Step 2: Test checksum and redacted manifest generation**

- [x] **Step 3: Require provider-neutral quality and explicit release scripts**

- [x] **Step 4: Run focused tests and verify RED**

### Task 3: Implement fail-closed Forge distribution configuration

- [x] **Step 1: Add a pure environment-to-config function**

- [x] **Step 2: Preserve local ad-hoc packaging**

- [x] **Step 3: Configure Developer ID hardened signing and notarization**

- [x] **Step 4: Run Forge tests and verify GREEN**

### Task 4: Implement the release artifact verifier

- [x] **Step 1: Implement pure release metadata helpers**

- [x] **Step 2: Validate App, archive, forbidden content, and signature**

- [x] **Step 3: Add distribution-only Gatekeeper and staple checks**

- [x] **Step 4: Emit checksum and versioned JSON metadata atomically**

- [x] **Step 5: Run artifact tests and verify GREEN**

### Task 5: Wire quality/release commands and documentation

- [x] **Step 1: Add `quality`, local release, and distribution verification scripts**

- [x] **Step 2: Document Gitee PR and trusted macOS release stages**

- [x] **Step 3: Document the manual-update boundary and automatic-update gates**

- [x] **Step 4: Record the superseding implementation decision**

### Task 6: Verify local and fail-closed release paths

- [x] **Step 1: Run focused tests and the complete quality gate**

- [x] **Step 2: Run fresh `make` and packaged smoke**

- [x] **Step 3: Verify the local artifact and inspect emitted metadata**

- [x] **Step 4: Prove distribution mode rejects absent credentials and ad-hoc artifacts**

- [x] **Step 5: Audit the diff and record credential-dependent follow-up**

## Verification evidence

- RED: the initial focused run had five expected assertion failures plus the
  missing release-verifier module. The failures covered the absent environment
  boundary, both notarization strategies, mixed credentials, and missing npm
  entry points.
- GREEN: Forge signing-mode, package-script, and release-contract tests passed
  16 tests. TypeScript and Node syntax checks passed.
- The unified `npm run quality` command passed 112 test files / 933 tests, then
  passed the unchanged 64-sample strict semantic gate at 100% high precision,
  100% high + medium recall, and 84.4% relation accuracy.
- Fresh `npm run make` produced
  `Decision-darwin-arm64-0.1.0.zip`; the rebuilt packaged smoke passed every
  persistence, rebuild, privacy, Hook, consultation, native-helper, and cleanup
  assertion.
- Local artifact verification passed strict ad-hoc signature verification,
  both bundle-version checks, ZIP integrity, and the DuckDB/GGUF content guard.
- After the final compatible build-dependency updates, the fresh ZIP is
  162,178,981 bytes with SHA-256
  `1daf3f762611989f33743a81dc595d75b4ffb25d9f98e19868f7d865128abdfe`.
  The checksum document and redacted schema-v1 manual-update manifest were
  written under `out/release/`.
- Distribution verification with the correct `v0.1.0` tag rejected the same
  local artifact with `Distribution artifact is not signed by a Developer ID
  Application`, proving the two modes cannot be confused.
- Unit coverage proves release configuration rejects missing, partial, mixed,
  keychain-without-profile, and ad-hoc identities before Forge can package.
- `git diff --check` passed and the scoped audit found no embedded credential,
  absolute local path, publishing side effect, updater network call, or change
  to ordinary local build behavior.
- Credential-dependent follow-up: an actual Developer ID signature,
  notarization submission/staple, Gatekeeper assessment, and protected Gitee
  artifact upload cannot be executed until the repository owner configures the
  Apple credentials and trusted macOS arm64 runner described in
  `docs/release.md`. The distribution path is implemented and fail-closed; no
  credential was invented or persisted during this work.
