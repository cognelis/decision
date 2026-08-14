# Engineering Baseline and Startup Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make renderer startup and render failures recoverable and add one deterministic local quality-gate command without changing decision behavior.

**Architecture:** A focused React hook owns the initial snapshot request, retry ordering, and the existing push subscription. `App` renders the hook's bounded startup states, while a class error boundary at the renderer entry seam handles unexpected React failures. Root package scripts compose existing verification commands; semantic readiness remains explicit and strict but separate until its thresholds pass.

**Tech Stack:** TypeScript, React 19, Electron, Vitest, Testing Library, npm workspaces

---

## File map

- Create `apps/desktop/src/renderer/use-app-snapshot.ts`: snapshot bootstrap,
  subscription, retry, stale-result suppression, and cleanup.
- Create `apps/desktop/test/use-app-snapshot.test.tsx`: hook behavior at its
  public interface.
- Modify `apps/desktop/src/renderer/App.tsx`: consume the bootstrap module and
  render an actionable startup failure surface.
- Modify `apps/desktop/test/App.test.tsx`: verify startup failure and retry from
  the application interface.
- Create `apps/desktop/src/renderer/components/AppErrorBoundary.tsx`: isolate
  unexpected React tree failures and expose an explicit reload action.
- Create `apps/desktop/test/app-error-boundary.test.tsx`: verify fixed fallback
  copy, privacy, and reload behavior.
- Modify `apps/desktop/src/renderer/main.tsx`: wrap the application root in the
  error boundary.
- Modify `apps/desktop/src/renderer/styles.css`: style both recovery surfaces
  without changing existing page layouts.
- Modify `package.json`: define `check`, `check:semantic`, and
  `report:semantic`.
- Create `scripts/test/package-scripts.test.ts`: lock the quality-gate command
  semantics.
- Modify `README.md`: document the canonical local verification commands and
  the intentionally separate semantic readiness gate.

The worktree contains substantial user-owned changes in existing files. During
execution, edit only the listed regions, inspect every diff, and do not stage or
commit implementation files whose pre-existing changes cannot be isolated.

### Task 1: Snapshot bootstrap module

**Files:**
- Create: `apps/desktop/src/renderer/use-app-snapshot.ts`
- Create: `apps/desktop/test/use-app-snapshot.test.tsx`

- [x] **Step 1: Write the failing hook tests**

Create a jsdom test using `renderHook`, `act`, and deferred promises. Cover
these observable behaviors independently:

```tsx
it("recovers an initial snapshot failure through retry", async () => {
  const first = deferred<AppSnapshot>();
  const second = deferred<AppSnapshot>();
  const api = snapshotApi([first.promise, second.promise]);
  const { result } = renderHook(() => useAppSnapshot(api));

  await act(async () => first.reject(new Error("private /vault path")));
  expect(result.current).toMatchObject({
    snapshot: null,
    loading: false,
    error: SNAPSHOT_LOAD_ERROR,
  });

  act(() => result.current.retry());
  expect(result.current.loading).toBe(true);
  await act(async () => second.resolve(snapshotFixture()));
  expect(result.current).toMatchObject({
    snapshot: snapshotFixture(),
    loading: false,
    error: null,
  });
});

it("lets a pushed snapshot invalidate an older request", async () => {
  const pending = deferred<AppSnapshot>();
  const api = snapshotApi([pending.promise]);
  const { result } = renderHook(() => useAppSnapshot(api));

  act(() => api.emit(newerSnapshot));
  await act(async () => pending.resolve(olderSnapshot));

  expect(result.current.snapshot).toEqual(newerSnapshot);
});
```

Also verify initial success, push recovery after rejection, exactly one active
subscription across retries, and no state update after unmount.

- [x] **Step 2: Run the hook tests and verify RED**

Run:

```bash
npx vitest run apps/desktop/test/use-app-snapshot.test.tsx
```

Expected: FAIL because `use-app-snapshot.ts` and its exported interface do not
exist.

- [x] **Step 3: Implement the minimal hook**

Export the fixed public message and interface:

```ts
export const SNAPSHOT_LOAD_ERROR =
  "暂时无法读取应用状态，请重试。";

export interface AppSnapshotState {
  snapshot: AppSnapshot | null;
  loading: boolean;
  error: string | null;
  retry(): void;
}
```

Use one `useEffect` for the subscription lifetime, one monotonic `useRef`
sequence shared by requests and pushed snapshots, and a memoized retry
callback. A request may commit only when its captured sequence still equals the
current sequence and its effect lifetime is active. Preserve the fixed error
while a retry is loading so the retry surface remains visible and disabled.

- [x] **Step 4: Run the hook tests and verify GREEN**

Run the focused Vitest command again. Expected: all hook tests PASS with no
unhandled rejection output.

### Task 2: Actionable startup failure

**Files:**
- Modify: `apps/desktop/src/renderer/App.tsx:24-80`
- Modify: `apps/desktop/test/App.test.tsx`

- [x] **Step 1: Write the failing application behavior test**

Add a test that rejects the first `getSnapshot`, asserts the fixed alert and
retry button, clicks retry, resolves the second request, and observes the normal
dashboard region:

```tsx
it("retries a failed initial snapshot without reloading the window", async () => {
  const api = apiFixture(rationaleSnapshot({ current: null })).api;
  vi.mocked(api.getSnapshot)
    .mockRejectedValueOnce(new Error("private /vault path"))
    .mockResolvedValueOnce(rationaleSnapshot({ current: null }));
  const user = userEvent.setup();

  render(<App api={api} />);

  const alert = await screen.findByRole("alert", {
    name: "应用状态加载失败",
  });
  expect(alert).toHaveTextContent("暂时无法读取应用状态，请重试。");
  expect(alert).not.toHaveTextContent("/vault");

  await user.click(screen.getByRole("button", { name: "重试" }));

  expect(
    await screen.findByRole("region", { name: "决策中心" }),
  ).toBeVisible();
  expect(api.getSnapshot).toHaveBeenCalledTimes(2);
  expect(api.onSnapshot).toHaveBeenCalledOnce();
});
```

- [x] **Step 2: Run the application test and verify RED**

Run:

```bash
npx vitest run apps/desktop/test/App.test.tsx -t "retries a failed initial snapshot"
```

Expected: FAIL because the current `App` leaves the rejection unhandled and
continues rendering the one-pixel loading state.

- [x] **Step 3: Integrate the hook and failure surface**

Replace the local snapshot state/effect with:

```tsx
const {
  snapshot,
  loading: snapshotLoading,
  error: snapshotError,
  retry: retrySnapshot,
} = useAppSnapshot(api);
```

When `snapshot === null` and `snapshotError !== null`, render:

```tsx
<section
  className="app-recovery-state"
  role="alert"
  aria-labelledby="snapshot-load-error-title"
>
  <h1 id="snapshot-load-error-title">应用状态加载失败</h1>
  <p>{snapshotError}</p>
  <button
    className="primary-button"
    type="button"
    disabled={snapshotLoading}
    onClick={retrySnapshot}
  >
    {snapshotLoading ? "正在重试…" : "重试"}
  </button>
</section>
```

Keep the existing one-pixel loading state only for an initial request that has
not failed.

- [x] **Step 4: Run focused application coverage and verify GREEN**

Run the focused test, followed by all `App.test.tsx` tests. Expected: PASS.

### Task 3: Top-level render error isolation

**Files:**
- Create: `apps/desktop/src/renderer/components/AppErrorBoundary.tsx`
- Create: `apps/desktop/test/app-error-boundary.test.tsx`
- Modify: `apps/desktop/src/renderer/main.tsx:20-29`

- [x] **Step 1: Write the failing error-boundary tests**

Render a child that throws `new Error("private /vault path")`. Inject a reload
spy through the boundary interface and assert:

```tsx
expect(
  screen.getByRole("alert", { name: "应用界面发生错误" }),
).toHaveTextContent("重新加载后可继续使用");
expect(screen.getByRole("alert")).not.toHaveTextContent("/vault");
expect(reload).not.toHaveBeenCalled();
await user.click(screen.getByRole("button", { name: "重新加载" }));
expect(reload).toHaveBeenCalledOnce();
```

Add a second test proving non-throwing children render unchanged.

- [x] **Step 2: Run the boundary tests and verify RED**

Run:

```bash
npx vitest run apps/desktop/test/app-error-boundary.test.tsx
```

Expected: FAIL because `AppErrorBoundary` does not exist.

- [x] **Step 3: Implement and install the boundary**

Create a class boundary with this public interface:

```tsx
interface AppErrorBoundaryProps {
  children: ReactNode;
  reload?: () => void;
}
```

Use `getDerivedStateFromError` to enter the failed state,
`componentDidCatch` to write a fixed diagnostic prefix plus the React error
details to `console.error`, and `reload ?? (() => window.location.reload())`
only from the explicit button handler. Render fixed user-facing copy and never
render `error.message`.

Wrap `<App />` inside `<AppErrorBoundary>` beneath `<StrictMode>` in `main.tsx`.

- [x] **Step 4: Run the boundary tests and verify GREEN**

Run the focused test file. Expected: both tests PASS; console output is
suppressed only within the throwing test using a restored spy.

### Task 4: Recovery surface styling

**Files:**
- Modify: `apps/desktop/src/renderer/styles.css:11606-11625`
- Modify: `apps/desktop/test/accessibility.test.tsx`

- [x] **Step 1: Add a failing accessibility assertion**

Render the startup failure state and assert the alert has one heading, one
descriptive paragraph, and a keyboard-focusable retry button. Reuse fixed role
and name assertions instead of CSS structure assertions.

- [x] **Step 2: Run the focused accessibility test and verify RED**

Run:

```bash
npx vitest run apps/desktop/test/accessibility.test.tsx -t "startup failure"
```

Expected: FAIL because the recovery surface is not yet part of the accessibility
fixture coverage.

- [x] **Step 3: Add contained recovery styles**

Add `.app-recovery-state` styles near the existing status/loading styles. Use a
full-window grid, a bounded inline size, centered text, existing color tokens,
and existing `.primary-button` styling. Do not change selectors used by normal
desktop, task, or modal layouts.

- [x] **Step 4: Verify accessibility and layout regression tests**

Run the accessibility test file, then the dashboard, rationale, and settings
layout test files in a normal Electron-capable environment. Expected: PASS.

### Task 5: Canonical quality-gate scripts

**Files:**
- Create: `scripts/test/package-scripts.test.ts`
- Modify: `package.json:12-24`
- Modify: `README.md:212-233`

- [x] **Step 1: Write the failing package-script test**

Read the root `package.json` and assert exact command composition:

```ts
expect(packageJson.scripts).toMatchObject({
  check: "npm run typecheck && npm test",
  "check:semantic": "npm run evaluate:semantic",
  "report:semantic": "npm run evaluate:semantic -- --report-only",
});
```

- [x] **Step 2: Run the script test and verify RED**

Run:

```bash
npx vitest run scripts/test/package-scripts.test.ts
```

Expected: FAIL because the three canonical scripts do not exist.

- [x] **Step 3: Add scripts and documentation**

Add the exact commands above to the root package. In README's development
verification section, lead with `npm run check`, retain `npm run make` and
`npm run smoke`, document `npm run report:semantic` as the current baseline
report, and document `npm run check:semantic` as the strict readiness gate.

- [x] **Step 4: Run the script test and verify GREEN**

Run the focused script test. Expected: PASS.

### Task 6: First-stage verification and handoff

**Files:**
- Verify all files listed above
- Update this plan's task checkboxes as evidence is collected

- [x] **Step 1: Inspect the scoped diff**

Run `git diff --check` and inspect diffs only for the listed implementation
files. Confirm no unrelated user-owned region was reformatted or reverted.

- [x] **Step 2: Run type checking**

Run `npm run typecheck`. Expected: exit 0.

- [x] **Step 3: Run the canonical quality gate**

Run `npm run check` in a normal Electron-capable environment. Expected: all
test files and tests pass with exit 0.

- [x] **Step 4: Verify the non-blocking semantic report**

Run `npm run report:semantic`. Expected: exit 0 and a report containing the
current precision, recall, relation accuracy, and threshold status.

- [x] **Step 5: Verify the strict semantic gate remains truthful**

Run `npm run check:semantic`. Until the separate classifier sub-project reaches
its thresholds, expected: non-zero exit with `Activation threshold NOT MET`.
This expected failure is readiness evidence, not a regression in this stage.

- [x] **Step 6: Record the next prioritized sub-project**

After reporting the verified first-stage result, begin a new design cycle for
methodology workbench decomposition and renderer-interface narrowing. Do not
bundle that structural change into this baseline patch.
