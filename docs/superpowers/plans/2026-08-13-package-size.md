# Local Analytics Package-Size Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the 117 MB DuckDB native runtime while preserving the complete decision-analytics behavior and proving the reduction in a fresh packaged app.

**Architecture:** Keep the existing `snapshotDecisions()` and async analytics API. Replace the temporary in-memory DuckDB import and queries with one deterministic TypeScript pass whose state is bounded by distinct groups and months. Keep SQLite as the rebuildable source and leave IPC unchanged.

**Tech Stack:** TypeScript, Vitest, Electron Forge, Vite, npm workspaces

---

## File map

- Modify `apps/desktop/test/decision-analytics-service.test.ts`: behavior and
  edge-case contract.
- Modify `apps/desktop/src/main/decision-analytics-service.ts`: local
  aggregation implementation.
- Modify `packages/core/src/decision-analytics.ts`: truthful engine metadata.
- Modify renderer fixtures/tests and `DecisionAnalyticsView.tsx`: metadata and
  user-facing copy.
- Modify `apps/desktop/test/forge-config.test.ts`,
  `apps/desktop/test/vite-main-config.test.ts`, `forge.config.ts`, and
  `apps/desktop/vite.main.config.ts`: packaging boundary.
- Modify `package.json` and `package-lock.json`: remove DuckDB.
- Modify `README.md` and `docs/decisions/implementation-decisions.md`: current
  architecture and superseding decision.

### Task 1: Lock the analytics contract with failing tests

- [x] **Step 1: Replace the engine expectation**

Require `Local aggregation` version `1` and `SQLite snapshot`.

- [x] **Step 2: Add aggregation edge cases**

Cover blank-project normalization, deterministic project/source ordering,
project and month limits, invalid dates, and known-verdict output.

- [x] **Step 3: Prove no input mutation**

Freeze an input array and its records before analysis and assert the same
records remain unchanged.

- [x] **Step 4: Run the service test and verify RED**

Expected: engine and new edge cases fail against the DuckDB implementation
where their observable contract differs.

### Task 2: Lock the package boundary with failing tests

- [x] **Step 1: Require no DuckDB dependency or external import**

Keep `node-llama-cpp` as the active native runtime, but reject
`@duckdb/node-api` from dependencies and Vite externals.

- [x] **Step 2: Reject accidental DuckDB packaging**

Require the Forge ignore function to exclude `/node_modules/@duckdb` while
retaining active runtime namespaces.

- [x] **Step 3: Run packaging configuration tests and verify RED**

Expected: current dependency, Vite external, and allowlist behavior fail.

### Task 3: Implement deterministic local aggregation

- [x] **Step 1: Add bounded accumulator helpers**

Normalize project labels, update group counters, calculate percentages, and
derive valid UTC month keys without side effects.

- [x] **Step 2: Aggregate the snapshot once**

Calculate totals, verdict counts, project/source maps, and monthly trend state
in the same input loop.

- [x] **Step 3: Materialize stable output**

Apply the documented sorts and limits, return the existing snapshot shape, and
retain the asynchronous service interface.

- [x] **Step 4: Run service tests and verify GREEN**

### Task 4: Remove the runtime and align product surfaces

- [x] **Step 1: Update the shared engine type and renderer copy**

Use truthful local-aggregation metadata and Chinese display labels; update all
typed fixtures and assertions.

- [x] **Step 2: Remove DuckDB from build configuration**

Delete the Vite external and explicitly exclude the old namespace from Forge.

- [x] **Step 3: Remove the dependency and update the lockfile**

Uninstall `@duckdb/node-api` without running lifecycle scripts.

- [x] **Step 4: Update current documentation and the decision log**

Record the measured package cost and add a new decision superseding IMP-025.
Historical specs remain historical records.

### Task 5: Verify source-level acceptance

- [x] **Step 1: Run focused analytics, renderer, IPC, and config tests**

- [x] **Step 2: Run type checking and the complete quality gate**

- [x] **Step 3: Search production and dependency surfaces**

Confirm no production or lockfile DuckDB reference remains; only historical
design records and the superseding decision may mention it.

- [x] **Step 4: Audit the scoped diff**

Run whitespace checks and inspect every changed hunk for behavior drift.

### Task 6: Verify the packaged artifact

- [x] **Step 1: Build a fresh macOS arm64 package**

- [x] **Step 2: Inspect and measure the application**

Confirm no DuckDB artifacts exist and compare the fresh directory size with
the 472 MB baseline.

- [x] **Step 3: Run the packaged smoke test**

- [x] **Step 4: Record verification evidence and start release readiness**

Document exact test counts, artifact bytes, reduction, and smoke outcome, then
advance the prioritized program to signing, updates, releases, and CI quality.

## Verification evidence

- RED: the focused service/config run failed on four expectations: old DuckDB
  engine metadata, root dependency, Vite external, and Forge package allowlist.
- GREEN: the focused analytics and packaging configuration run passed 13
  tests; the broader renderer, IPC, accessibility, and real Electron layout
  run passed 168 tests.
- TypeScript completed without errors after guarding runtime verdict strings.
- Complete `npm run check`: 111 test files and 924 tests passed.
- `npm ls @duckdb/node-api --depth=0` is empty; production and lockfile searches
  contain no DuckDB dependency or import. The only active packaging reference
  is an explicit guard against accidentally including the removed namespace.
- Fresh `npm run build` completed. The application directory contains no
  DuckDB artifact. `app.asar.unpacked` retains only the active local inference
  native runtime and reflink helper.
- The same packaged directory fell from 483,488 KiB to 367,300 KiB: a reduction
  of 116,188 KiB / 118,976,512 bytes / 24.0%. The App bundle itself fell from
  463,988 KiB to 347,800 KiB.
- The first smoke run exposed a stale mixed-answer assumption: the semantic
  safety work correctly routed that input to candidate review, so it could not
  immediately accept a rationale. The smoke scenario now uses an unambiguous
  choice for its automatic-capture path; mixed candidate behavior remains
  covered by focused and integration tests.
- The corrected packaged smoke passed Markdown persistence, SQLite rebuild,
  structured capture, rule fallback with the model unavailable, Hook silence,
  provider-child recursion protection, content-free consultation metrics,
  anonymous feedback, transcript privacy, native helper loading, and runtime
  cleanup.
- `node --check scripts/smoke.mjs` and `git diff --check` passed.
