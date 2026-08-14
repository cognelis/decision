# Decision Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split all decision work, recent decisions, and statistics from Settings into a complete “决策中心”.

**Architecture:** Reuse the existing single Electron window with an explicit primary-surface state (`hidden`, `dashboard`, or `settings`). Feed the dashboard from a renderer-safe read model backed by the rebuildable SQLite index, while existing queue mutations continue through validated IPC.

**Tech Stack:** TypeScript, React, Electron, Vitest, Testing Library, Node SQLite, CSS.

---

## File structure

**Create**

- `apps/desktop/src/renderer/components/DecisionCenter.tsx` — decision-center composition and navigation.
- `apps/desktop/src/renderer/components/DashboardPendingRationales.tsx` — deferred-rationale list and inline editor.
- `apps/desktop/src/renderer/components/RecentDecisionList.tsx` — recent indexed decisions.
- `apps/desktop/test/dashboard-layout.test.ts` — real Electron geometry test.
- `scripts/check-dashboard-layout.cjs` — offscreen dashboard renderer and metrics.

**Modify**

- `packages/storage/src/sqlite-index.ts` and its tests — recent rows and rolling counts.
- `apps/desktop/src/shared/renderer-api.ts` — primary-surface and dashboard read-model interface.
- `apps/desktop/src/main/app-controller.ts` and tests — exclusive primary surface and return flow.
- `apps/desktop/src/shared/decision-layout.ts` — dashboard window size/mode.
- `apps/desktop/src/main/window-manager.ts` and tests — dashboard mode priority.
- `apps/desktop/src/main/tray.ts` and tests — combined workload entry.
- `apps/desktop/src/main/ipc.ts`, `apps/desktop/src/preload/index.ts`, and IPC tests — dashboard navigation.
- `apps/desktop/src/main/index.ts` — production dashboard adapter and tray wiring.
- `apps/desktop/src/renderer/App.tsx` — primary-surface routing.
- `apps/desktop/src/renderer/components/SettingsPanel.tsx` — configuration-only settings.
- `apps/desktop/src/renderer/preview-api.ts` — deterministic dashboard fixture.
- `apps/desktop/src/renderer/styles.css` — dashboard layout and simplified settings.
- renderer and accessibility tests — business/settings separation.

### Task 1: Add the SQLite dashboard read operations

**Files:**
- Modify: `packages/storage/src/sqlite-index.ts`
- Test: `packages/storage/test/sqlite-index.test.ts`

- [ ] **Step 1: Write failing ordering and count tests**

Add a test that upserts three fixture notes with distinct `created` values,
then asserts:

```ts
expect(index.listRecent(2).map((decision) => decision.id)).toEqual([
  "newest",
  "middle",
]);
expect(index.countSince("2026-07-25T00:00:00.000Z")).toBe(2);
```

- [ ] **Step 2: Run the storage test and verify red**

Run:

```bash
npm test -- packages/storage/test/sqlite-index.test.ts
```

Expected: TypeScript/test failure because `listRecent` and `countSince` do
not exist.

- [ ] **Step 3: Implement bounded recent queries**

Add:

```ts
listRecent(limit = 12): IndexedDecision[] {
  const bounded = Math.max(1, Math.min(50, Math.trunc(limit)));
  const rows = this.#database
    .prepare(
      "SELECT * FROM decisions ORDER BY created DESC, id DESC LIMIT ?",
    )
    .all(bounded) as unknown as DecisionRow[];
  return rows.map(mapRow);
}

countSince(created: string): number {
  const row = this.#database
    .prepare(
      "SELECT count(*) AS count FROM decisions WHERE created >= ?",
    )
    .get(created) as { count: number };
  return Number(row.count);
}
```

- [ ] **Step 4: Run the storage test and typecheck**

Run:

```bash
npm test -- packages/storage/test/sqlite-index.test.ts
npm run typecheck
```

Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/storage/src/sqlite-index.ts packages/storage/test/sqlite-index.test.ts
git commit -m "feat: add decision dashboard queries"
```

### Task 2: Introduce the dashboard read model and primary-surface state

**Files:**
- Modify: `apps/desktop/src/shared/renderer-api.ts`
- Modify: `apps/desktop/src/main/app-controller.ts`
- Test: `apps/desktop/test/app-controller.test.ts`

- [ ] **Step 1: Write failing controller state tests**

Add tests that prove:

```ts
controller.openDashboard();
expect(controller.snapshot().primarySurface).toBe("dashboard");

controller.openSettings();
expect(controller.snapshot().primarySurface).toBe("settings");

controller.closePrimarySurface();
expect(controller.snapshot().primarySurface).toBe("hidden");
```

Add a dashboard fixture and assert it is copied into `snapshot.dashboard`.
Add a candidate-flow test that opens the dashboard, starts review, closes
review, and expects the dashboard to return.

- [ ] **Step 2: Run the controller test and verify red**

Run:

```bash
npm test -- apps/desktop/test/app-controller.test.ts
```

Expected: missing methods and snapshot fields.

- [ ] **Step 3: Define renderer-safe dashboard types**

In `renderer-api.ts`, add:

```ts
export type PrimarySurface = "hidden" | "dashboard" | "settings";

export interface RecentDecisionSummary {
  id: string;
  created: string;
  sourceClient: string;
  project: string;
  question: string;
  selectedAnswer: string;
  rationaleStatus: "captured" | "deferred" | "skipped";
}

export interface DashboardSnapshot {
  totalDecisions: number;
  recorded7d: number;
  recentDecisions: RecentDecisionSummary[];
}
```

Add `primarySurface` and `dashboard` to `AppSnapshot`. Retain
`settingsOpen` as a derived compatibility field until Task 5 migrates the
renderer, then remove it.

- [ ] **Step 4: Implement one exclusive primary surface**

In `AppController`, replace `#settingsOpen` with:

```ts
#primarySurface: PrimarySurface = "hidden";
#candidateReviewReturnSurface: PrimarySurface = "hidden";
```

Expose `openDashboard`, `openSettings`, and `closePrimarySurface`. Capture the
return surface when candidate review starts and restore it when review is
cancelled or fully finishes. Keep the surface hidden while the promoted
candidate is collecting rationale.

Accept a dashboard provider:

```ts
dashboard?: () => DashboardSnapshot;
```

Use an empty safe default when the provider is absent.

- [ ] **Step 5: Run controller tests and typecheck**

Run:

```bash
npm test -- apps/desktop/test/app-controller.test.ts
npm run typecheck
```

Expected: controller tests and typecheck pass. Update the shared snapshot
fixtures in desktop tests with `primarySurface`, `dashboard`, and the derived
`settingsOpen` value so this commit remains independently buildable.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/shared/renderer-api.ts apps/desktop/src/main/app-controller.ts apps/desktop/test/app-controller.test.ts
git commit -m "feat: model decision center state"
```

### Task 3: Add dashboard sizing and tray navigation

**Files:**
- Modify: `apps/desktop/src/shared/decision-layout.ts`
- Modify: `apps/desktop/src/main/window-manager.ts`
- Modify: `apps/desktop/src/main/liquid-glass.ts`
- Modify: `apps/desktop/src/main/tray.ts`
- Test: `apps/desktop/test/decision-layout.test.ts`
- Test: `apps/desktop/test/window-manager.test.ts`
- Test: `apps/desktop/test/liquid-glass.test.ts`
- Test: `apps/desktop/test/tray.test.ts`

- [ ] **Step 1: Write failing dashboard window tests**

Define the expected size:

```ts
expect(DASHBOARD_SIZE).toEqual({ width: 760, height: 760 });
```

Publish a snapshot with `primarySurface: "dashboard"` and assert the window
uses `DASHBOARD_SIZE` and native mode `"dashboard"`. Add a priority test
showing an active candidate review overrides dashboard until it closes.

- [ ] **Step 2: Write the failing tray test**

Assert the menu labels and callback:

```ts
expect(menu.template[0]?.label).toBe("决策中心 · 5 项待办");
menu.template[0]?.click?.();
expect(openDashboard).toHaveBeenCalledOnce();
```

- [ ] **Step 3: Run targeted tests and verify red**

Run:

```bash
npm test -- apps/desktop/test/decision-layout.test.ts apps/desktop/test/window-manager.test.ts apps/desktop/test/liquid-glass.test.ts apps/desktop/test/tray.test.ts
```

Expected: dashboard size/mode and tray interface failures.

- [ ] **Step 4: Implement the dashboard mode**

Add:

```ts
export const DASHBOARD_SIZE = { width: 760, height: 760 } as const;
```

Add `"dashboard"` to `DecisionWindowMode`, `WINDOW_SIZES`, and native glass
regular-panel handling. In `WindowManager.publish`, route
`primarySurface === "settings"` first, candidate review second, dashboard
third, then rationale and persistence states.

- [ ] **Step 5: Replace the tray business entry**

Change `configureTray` to accept `pendingCount` and `openDashboard`. Render
`决策中心 · ${pendingCount} 项待办`, including zero.

- [ ] **Step 6: Run targeted tests**

Run:

```bash
npm test -- apps/desktop/test/decision-layout.test.ts apps/desktop/test/window-manager.test.ts apps/desktop/test/liquid-glass.test.ts apps/desktop/test/tray.test.ts
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/shared/decision-layout.ts apps/desktop/src/main/window-manager.ts apps/desktop/src/main/liquid-glass.ts apps/desktop/src/main/tray.ts apps/desktop/test/decision-layout.test.ts apps/desktop/test/window-manager.test.ts apps/desktop/test/liquid-glass.test.ts apps/desktop/test/tray.test.ts
git commit -m "feat: add decision center window mode"
```

### Task 4: Wire dashboard navigation and production data

**Files:**
- Modify: `apps/desktop/src/shared/renderer-api.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/renderer/preview-api.ts`
- Test: `apps/desktop/test/ipc.test.ts`

- [ ] **Step 1: Write failing IPC tests**

Update the renderer method-name expectation to include:

```ts
"openDashboard",
"closePrimarySurface",
```

Keep `closeSettings` temporarily for the still-unmigrated renderer. Assert
both new channels forward with no arguments and remain part of the frozen
preload surface.

- [ ] **Step 2: Run the IPC test and verify red**

Run:

```bash
npm test -- apps/desktop/test/ipc.test.ts
```

Expected: method/channel mismatches.

- [ ] **Step 3: Add validated navigation channels**

Add channels and methods:

```ts
openDashboard: "decision:open-dashboard",
closePrimarySurface: "decision:close-primary-surface",
```

Wire them through renderer interface, preload, IPC operations, and main
controller calls. `closeSettings` continues to delegate to
`closePrimarySurface` until Task 5 removes the compatibility method.

- [ ] **Step 4: Build the production dashboard adapter**

In `main/index.ts`, map index rows without exposing `filePath`, `contentHash`,
context, or rationale text:

```ts
dashboard: () => ({
  totalDecisions: index.count(),
  recorded7d: index.countSince(
    new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
  ),
  recentDecisions: index.listRecent(12).map((decision) => ({
    id: decision.id,
    created: decision.created,
    sourceClient: decision.sourceClient,
    project: decision.project,
    question: decision.question,
    selectedAnswer: decision.selectedAnswer,
    rationaleStatus: decision.rationaleStatus as
      | "captured"
      | "deferred"
      | "skipped",
  })),
}),
```

Wrap the adapter with a safe empty fallback if index reads throw. Update tray
counts from each snapshot:

```ts
snapshot.decisionCandidates.count + snapshot.pendingRationales.length
```

- [ ] **Step 5: Add preview dashboard data**

Add `preview=dashboard` with non-empty pending work, recent decisions, and
statistics so layout tests exercise real content.

- [ ] **Step 6: Run IPC, controller, and type checks**

Run:

```bash
npm test -- apps/desktop/test/ipc.test.ts apps/desktop/test/app-controller.test.ts
npm run typecheck
```

Expected: all exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/shared/renderer-api.ts apps/desktop/src/main/ipc.ts apps/desktop/src/preload/index.ts apps/desktop/src/main/index.ts apps/desktop/src/renderer/preview-api.ts apps/desktop/test/ipc.test.ts
git commit -m "feat: wire decision center data"
```

### Task 5: Build the Decision Center and simplify Settings

**Files:**
- Create: `apps/desktop/src/renderer/components/DecisionCenter.tsx`
- Create: `apps/desktop/src/renderer/components/DashboardPendingRationales.tsx`
- Create: `apps/desktop/src/renderer/components/RecentDecisionList.tsx`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/components/SettingsPanel.tsx`
- Modify: `apps/desktop/src/shared/renderer-api.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Delete: `apps/desktop/src/renderer/components/PendingList.tsx`
- Test: `apps/desktop/test/App.test.tsx`
- Test: `apps/desktop/test/accessibility.test.tsx`

- [ ] **Step 1: Write failing renderer separation tests**

Render a dashboard snapshot and assert the four summary labels, current
candidate question, deferred rationale question, recent decision question,
and recognition metrics are visible.

Click “开始处理” and assert `api.openCandidateReview()` is called. Complete a
deferred rationale and assert the existing `submitRationale` input:

```ts
{
  candidateId: "pending-1",
  status: "captured",
  rationale: "补充后的理由",
}
```

Render Settings and assert it contains none of:

```ts
"待确认"
"待补理由"
"最近决策"
"处理轮次"
```

- [ ] **Step 2: Run renderer tests and verify red**

Run:

```bash
npm test -- apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx
```

Expected: missing dashboard surface and stale Settings business content.

- [ ] **Step 3: Implement focused renderer modules**

`DecisionCenter` renders the toolbar, four summary cards, two work cards,
recent list, and seven-day recognition section. It accepts snapshot data and
callbacks; it does not call global APIs directly.

`DashboardPendingRationales` moves the existing editor behavior out of
Settings and preserves typed text when `onComplete` rejects.

`RecentDecisionList` formats time and source labels and maps rationale states:

```ts
const rationaleLabels = {
  captured: "理由完整",
  deferred: "待补理由",
  skipped: "未补理由",
} as const;
```

- [ ] **Step 4: Route primary surfaces in App**

Before transient decision content, render:

```tsx
if (snapshot.primarySurface === "settings") {
  return <SettingsPanel snapshot={snapshot} api={api} />;
}
if (snapshot.primarySurface === "dashboard") {
  return (
    <DecisionCenter
      snapshot={snapshot}
      onClose={() => api.closePrimarySurface()}
      onOpenSettings={() => api.openSettings()}
      onReview={() => api.openCandidateReview()}
      onCompleteRationale={(id, rationale) =>
        api.submitRationale({
          candidateId: id,
          status: "captured",
          rationale,
        })
      }
    />
  );
}
```

Update Settings close to `closePrimarySurface`.

Remove the compatibility `settingsOpen` snapshot field and `closeSettings`
renderer method/channel after every caller has moved.

- [ ] **Step 5: Remove business content from Settings**

Remove the summary strip, `PendingList`, candidate action, and semantic
metrics. Retain semantic provider label, availability, and mode. Delete the
now-replaced `PendingList.tsx`.

- [ ] **Step 6: Run renderer and accessibility tests**

Run:

```bash
npm test -- apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx
npm run typecheck
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/App.tsx apps/desktop/src/renderer/components/DecisionCenter.tsx apps/desktop/src/renderer/components/DashboardPendingRationales.tsx apps/desktop/src/renderer/components/RecentDecisionList.tsx apps/desktop/src/renderer/components/SettingsPanel.tsx apps/desktop/src/renderer/components/PendingList.tsx apps/desktop/src/shared/renderer-api.ts apps/desktop/src/main/ipc.ts apps/desktop/src/preload/index.ts apps/desktop/src/main/index.ts apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx
git commit -m "feat: build decision center"
```

### Task 6: Style and verify the real dashboard window

**Files:**
- Modify: `apps/desktop/src/renderer/styles.css`
- Modify: `apps/desktop/test/settings-layout.test.ts`
- Create: `apps/desktop/test/dashboard-layout.test.ts`
- Create: `scripts/check-dashboard-layout.cjs`

- [ ] **Step 1: Write the failing Electron layout test**

Measure the dashboard at 760 × 760 and assert:

```ts
expect(metrics.viewportWidth).toBe(760);
expect(metrics.viewportHeight).toBe(760);
expect(metrics.horizontalOverflow).toBe(false);
expect(metrics.toolbarHeight).toBe(52);
expect(metrics.summaryColumns).toBe("repeat(4, minmax(0px, 1fr))");
expect(metrics.startReviewVisible).toBe(true);
expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
```

Also update Settings geometry expectations after removing its summary strip.

- [ ] **Step 2: Run layout tests and verify red**

Run:

```bash
npm test -- apps/desktop/test/dashboard-layout.test.ts apps/desktop/test/settings-layout.test.ts
```

Expected: dashboard fixture/script or geometry failures.

- [ ] **Step 3: Implement the dashboard visual system**

Use:

- a 52px glass toolbar;
- four equal summary cards with unwrapped labels/actions;
- a two-column work grid with the rationale list spanning the wider column;
- recent decisions as compact rows with answer emphasis;
- recognition metrics as a quiet footer card;
- one vertical scroll container and no nested page-level horizontal scroll.

Remove obsolete `.settings-summary`, `.candidate-summary`, and old pending
styles. Rename shared card styles only when both surfaces genuinely use them.

- [ ] **Step 4: Capture and inspect light/dark screenshots**

Run the Electron layout script with screenshot paths for both themes. Inspect
both images and verify:

- no vertical Chinese button text;
- no clipped actions;
- readable recent-decision rows;
- business content is absent from Settings;
- glass contrast remains consistent.

- [ ] **Step 5: Run layout, renderer, and type checks**

Run:

```bash
npm test -- apps/desktop/test/dashboard-layout.test.ts apps/desktop/test/settings-layout.test.ts apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx
npm run typecheck
git diff --check
```

Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/styles.css apps/desktop/test/settings-layout.test.ts apps/desktop/test/dashboard-layout.test.ts scripts/check-dashboard-layout.cjs
git commit -m "test: verify decision center layout"
```

### Task 7: Complete release verification and deployment

**Files:**
- Verify the complete repository and packaged application.

- [ ] **Step 1: Run all tests**

```bash
npm test
```

Expected: 0 failed test files and 0 failed tests.

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 3: Build the distributable**

```bash
npm run make
```

Expected: artifacts under `out/make` and exit 0.

- [ ] **Step 4: Run packaged smoke**

```bash
npm run smoke
```

Expected: JSON output containing `"ok":true`.

- [ ] **Step 5: Audit requirements**

Confirm from current source, tests, screenshots, and runtime:

- Settings has no candidate, rationale, recent-decision, or recognition-count
  business UI.
- Decision Center contains all four required business areas.
- all counts and recent rows come from snapshot/index data;
- tray opens Decision Center and shows combined workload;
- candidate and deferred-rationale actions still persist safely;
- recent rows contain no file paths.

- [ ] **Step 6: Push and replace the app**

```bash
git push origin main
```

Quit the installed app, preserve the previous bundle in Trash, copy
`out/Decision-darwin-arm64/Decision.app` to
`/Applications/Decision.app`, verify with checksum dry-run, and reopen
it.

- [ ] **Step 7: Confirm final state**

```bash
git status --short
git rev-list --left-right --count origin/main...main
```

Expected: clean output followed by `0 0`.
