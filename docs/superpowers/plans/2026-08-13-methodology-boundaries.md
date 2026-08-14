# Methodology Workspace Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish enforceable renderer capability seams and extract methodology relation/merge policy into directly tested pure modules without changing runtime behavior.

**Architecture:** Keep `DecisionApi` as the full preload contract and expose structural capability views for methodology records, analytics, and practice assets. Move existing pairwise-relation and merge-draft transformations from the React component into cohesive pure modules; leave orchestration and rendering in place for this incremental slice.

**Tech Stack:** TypeScript, React 19, Electron, Vitest, Testing Library, npm workspaces

---

## File map

- Modify `apps/desktop/src/shared/renderer-api.ts`: export named capability
  views over the existing full API.
- Create `apps/desktop/test/renderer-api-capabilities.test.ts`: compile-time and
  runtime key contracts for the narrow views.
- Create `apps/desktop/src/renderer/components/pages/methodology/methodology-relation-model.ts`:
  pure pairwise relation, review queue, merge eligibility, and badge policy.
- Create `apps/desktop/test/methodology-relation-model.test.ts`: direct policy
  coverage.
- Create `apps/desktop/src/renderer/components/pages/methodology/methodology-merge-model.ts`:
  pure merge evidence and draft-source transformations.
- Create `apps/desktop/test/methodology-merge-model.test.ts`: direct merge-state
  coverage.
- Modify `apps/desktop/src/renderer/components/pages/methodology/MethodologyPanel.tsx`:
  consume the capability and pure modules; remove duplicate local policy.
- Modify `apps/desktop/src/renderer/components/pages/methodology/DecisionAnalyticsView.tsx`:
  accept only analytics capabilities.
- Modify `apps/desktop/src/renderer/components/pages/methodology/PracticeAssetsView.tsx`:
  accept only practice-asset capabilities.

The worktree contains substantial user-owned changes. Edit only these files and
do not stage existing modified files when their unrelated changes cannot be
isolated.

### Task 1: Renderer capability contracts

**Files:**
- Create: `apps/desktop/test/renderer-api-capabilities.test.ts`
- Modify: `apps/desktop/src/shared/renderer-api.ts`

- [x] **Step 1: Write the failing capability test**

Import the planned capability types and use `expectTypeOf` to assert their
exact key unions. Include negative `@ts-expect-error` assignments proving, for
example, that analytics cannot call `setTheme` and practice assets cannot call
`submitRationale`.

- [x] **Step 2: Run the test and verify RED**

Run:

```bash
npx vitest run apps/desktop/test/renderer-api-capabilities.test.ts
```

Expected: FAIL because the capability exports do not exist.

- [x] **Step 3: Add structural capability types**

Define `MethodologyRecordsApi`, `DecisionAnalyticsApi`, and
`PracticeAssetsApi` using `Pick<DecisionApi, ...>`. Define
`MethodologyWorkspaceApi` as their intersection. Do not change
`RENDERER_METHOD_NAMES`, `IPC_CHANNELS`, `DecisionApi`, or the global
window declaration.

- [x] **Step 4: Run the test and verify GREEN**

Expected: the type contract test passes and does not emit runtime work.

### Task 2: Pure relation policy

**Files:**
- Create: `apps/desktop/test/methodology-relation-model.test.ts`
- Create: `apps/desktop/src/renderer/components/pages/methodology/methodology-relation-model.ts`

- [x] **Step 1: Write failing relation-model tests**

Cover:

- stable symmetric pair keys;
- explicit relationship precedence (`conflict`, then `unrelated`, then
  `duplicate`);
- all-pairs duplicate confirmation;
- review-queue deduplication and ordering;
- unresolved-pair counting;
- merge-candidate acceptance and rejection;
- quality-badge precedence.

- [x] **Step 2: Run the test and verify RED**

Expected: FAIL because the pure relation module does not exist.

- [x] **Step 3: Move the current rules into the pure module**

Export the existing relation review and merge assessment value types plus the
pure functions. Preserve ordering, status filtering, resolution precedence,
and badge copy exactly.

- [x] **Step 4: Run the test and verify GREEN**

Expected: all relation policy tests pass.

### Task 3: Pure merge draft policy

**Files:**
- Create: `apps/desktop/test/methodology-merge-model.test.ts`
- Create: `apps/desktop/src/renderer/components/pages/methodology/methodology-merge-model.ts`

- [x] **Step 1: Write failing merge-model tests**

Cover source-ordered evidence deduplication, the 3,000-character summary bound,
identifier-set comparison, retained manual evidence ordering, five-record
bounding, automatic-summary replacement, and preservation of a manually edited
summary.

- [x] **Step 2: Run the test and verify RED**

Expected: FAIL because the pure merge module does not exist.

- [x] **Step 3: Move the current transformations into the pure module**

Export `MethodologyMergeDraftState` and the four pure helpers. Clone returned
arrays and objects where needed; never mutate sources or current draft state.

- [x] **Step 4: Run the test and verify GREEN**

Expected: all merge policy tests pass.

### Task 4: Integrate the new boundaries

**Files:**
- Modify: `apps/desktop/src/renderer/components/pages/methodology/MethodologyPanel.tsx`
- Modify: `apps/desktop/src/renderer/components/pages/methodology/DecisionAnalyticsView.tsx`
- Modify: `apps/desktop/src/renderer/components/pages/methodology/PracticeAssetsView.tsx`

- [x] **Step 1: Change component prop types**

Use `MethodologyWorkspaceApi`, `DecisionAnalyticsApi`, and
`PracticeAssetsApi`, respectively. Keep the same runtime `api` object and prop
names.

- [x] **Step 2: Replace local helpers with pure-module imports**

Import the relation and merge types/functions. Delete only the duplicate local
definitions; keep UI labels and unrelated search/revision helpers local.

- [x] **Step 3: Run focused integration coverage**

Run the new model/capability tests plus the methodology-focused tests in
`App.test.tsx`. Expected: no visible behavior or IPC call changes.

- [x] **Step 4: Run type checking**

Run `npm run typecheck`. Expected: the complete preload and preview APIs remain
structurally assignable to every narrower prop.

### Task 5: Verify and audit the structural slice

**Files:**
- Modify: `docs/superpowers/plans/2026-08-13-methodology-boundaries.md`
- Modify: `docs/superpowers/plans/2026-08-13-engineering-baseline.md`

- [x] **Step 1: Run all focused files**

Run the three new test files and the relevant renderer accessibility/layout
coverage. Expected: PASS.

- [x] **Step 2: Run the complete quality gate**

Run `npm run check` in the normal Electron-capable environment. Expected:
type checking and all automated tests PASS.

- [x] **Step 3: Inspect the complete scoped diff**

Run `git diff --check` and review every changed hunk in this slice. Confirm
there are no IPC, copy, CSS, persistence, or protocol changes.

- [x] **Step 4: Record the next priority**

Update this plan with actual verification evidence, then begin the semantic
recall design against the existing 64-sample baseline.

## Verification evidence

- Capability contract RED: three missing runtime exports failed as expected.
- Capability contract GREEN: 4 tests passed.
- Relation model RED: module resolution failed before implementation.
- Relation model GREEN: 6 tests passed.
- Merge model RED: module resolution failed before implementation.
- Merge model GREEN: 5 tests passed.
- Focused integration: `App.test.tsx` and `accessibility.test.tsx` passed 76
  tests.
- Type checking passed after component props were narrowed.
- The complete `npm run check` passed in the normal Electron-capable
  environment. The sandbox-only run failed with `listen EPERM` and Electron
  launch denial, then passed outside that restriction.
- `git diff --check` passed; no duplicate relation or merge helper definitions
  remain in `MethodologyPanel.tsx`.
- The panel decreased from roughly 7,329 to 7,129 lines; the moved 236 lines
  now live behind two pure, directly tested interfaces.
