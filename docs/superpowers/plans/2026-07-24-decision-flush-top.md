# Decision Flush-Top Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two-layer compact decision window with one 560px-wide surface that is flush with the current display's work-area top.

**Architecture:** Keep compact eligibility and decision behavior unchanged. Update the shared mode sizes, make the main-process window manager derive bounds from the active display and mode, and simplify the renderer so only ordinary panels use `DecisionHeader` while compact modes render one glass body.

**Tech Stack:** Electron, React, TypeScript, CSS, Vitest, Testing Library

---

## File map

- `apps/desktop/src/shared/decision-layout.ts`: authoritative sizes for compact choice and rationale windows.
- `apps/desktop/src/main/window-manager.ts`: display-relative centering, top offsets, resizing, and focus behavior.
- `apps/desktop/src/renderer/App.tsx`: compact versus ordinary panel composition.
- `apps/desktop/src/renderer/components/DecisionHeader.tsx`: ordinary panel source/project header only.
- `apps/desktop/src/renderer/styles.css`: single-surface flush-top shape and glass styling.
- `apps/desktop/test/decision-layout.test.ts`: size regression coverage.
- `apps/desktop/test/window-manager.test.ts`: display-relative bounds and focus regression coverage.
- `apps/desktop/test/App.test.tsx`: compact header removal and ordinary header preservation.

### Task 1: Lock the smaller compact window sizes

**Files:**
- Modify: `apps/desktop/test/decision-layout.test.ts`
- Modify: `apps/desktop/src/shared/decision-layout.ts`

- [ ] **Step 1: Write the failing size test**

Add the constants to the import and this test:

```ts
import {
  decisionWindowMode,
  ISLAND_CHOICE_SIZE,
  ISLAND_RATIONALE_SIZE,
  usesDecision,
} from "../src/shared/decision-layout.js";

it("uses the flush-top compact dimensions", () => {
  expect(ISLAND_CHOICE_SIZE).toEqual({ width: 560, height: 240 });
  expect(ISLAND_RATIONALE_SIZE).toEqual({ width: 560, height: 326 });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npm test -- apps/desktop/test/decision-layout.test.ts
```

Expected: FAIL because the current heights are `286` and `372`.

- [ ] **Step 3: Update the compact size constants**

Use:

```ts
export const ISLAND_CHOICE_SIZE = {
  width: 560,
  height: 240,
} as const;
export const ISLAND_RATIONALE_SIZE = {
  width: 560,
  height: 326,
} as const;
```

- [ ] **Step 4: Run the test and verify GREEN**

Run:

```bash
npm test -- apps/desktop/test/decision-layout.test.ts
```

Expected: the decision-layout test file passes.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/test/decision-layout.test.ts apps/desktop/src/shared/decision-layout.ts
git commit -m "feat: shrink compact island windows"
```

### Task 2: Center each mode and pin only compact modes to the top

**Files:**
- Modify: `apps/desktop/test/window-manager.test.ts`
- Modify: `apps/desktop/src/main/window-manager.ts`

- [ ] **Step 1: Write failing display-bound tests**

Update the creation assertion to require initial compact bounds:

```ts
expect(options).toMatchObject({
  x: 720,
  y: 24,
  ...ISLAND_CHOICE_SIZE,
});
```

Rename the resize test to `"centers ordinary windows with a top safety margin"` and assert:

```ts
expect(window.setBounds).toHaveBeenLastCalledWith(
  { x: 260, y: 36, ...SETTINGS_SIZE },
  true,
);
expect(window.setBounds).toHaveBeenLastCalledWith(
  { x: 320, y: 36, ...PANEL_SIZE },
  true,
);
```

Update the settings snapshot assertion to:

```ts
expect(window.setBounds).toHaveBeenLastCalledWith(
  { x: 260, y: 36, ...SETTINGS_SIZE },
  true,
);
```

Rename the compact test to `"pins choice, rationale, and return transitions to the work-area top"` and assert choice and rationale bounds:

```ts
expect(window.setBounds).toHaveBeenLastCalledWith(
  { x: 320, y: 24, ...ISLAND_CHOICE_SIZE },
  true,
);
expect(window.setBounds).toHaveBeenLastCalledWith(
  { x: 320, y: 24, ...ISLAND_RATIONALE_SIZE },
  true,
);
```

Publish the original choice snapshot once more and assert it returns to `{ x: 320, y: 24, ...ISLAND_CHOICE_SIZE }`.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npm test -- apps/desktop/test/window-manager.test.ts
```

Expected: FAIL because bounds currently preserve the old center and `y`.

- [ ] **Step 3: Add one mode-aware bounds helper**

Replace the duplicated initial/show calculations with:

```ts
const TOP_SAFETY_MARGIN = 12;

const boundsForMode = (
  workArea: Rectangle,
  mode: DecisionWindowMode,
): Rectangle => {
  const desired = WINDOW_SIZES[mode];
  const compact =
    mode === "island-choice" || mode === "island-rationale";
  return {
    x: Math.round(
      workArea.x + Math.max(0, (workArea.width - desired.width) / 2),
    ),
    y: workArea.y + (compact ? 0 : TOP_SAFETY_MARGIN),
    ...desired,
  };
};

const initialBounds = (screen: ScreenLike): Rectangle => {
  const point = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(point);
  return boundsForMode(workArea, "island-choice");
};
```

In `show`, keep using the current bounds' center to select the active display, then call:

```ts
window.setBounds(boundsForMode(workArea, mode), true);
```

Do not change the existing focus rule: choice uses `showInactive()`; rationale, panel, and settings use `show()` and `focus()`.

- [ ] **Step 4: Run the test and verify GREEN**

Run:

```bash
npm test -- apps/desktop/test/window-manager.test.ts
```

Expected: all window-manager tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/test/window-manager.test.ts apps/desktop/src/main/window-manager.ts
git commit -m "feat: pin compact islands to display top"
```

### Task 3: Render one continuous compact surface

**Files:**
- Modify: `apps/desktop/test/App.test.tsx`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/components/DecisionHeader.tsx`
- Modify: `apps/desktop/src/renderer/styles.css`

- [ ] **Step 1: Write the failing compact renderer test**

Rename the first test to `"renders one flush-top island with full-height options"` and replace the compact source assertion with:

```ts
const shell = screen.getByTestId("decision-shell");
expect(shell).toHaveAttribute("data-layout", "island");
expect(shell).toHaveClass("island", "island-choice");
expect(shell.querySelector(".island-header")).toBeNull();
expect(shell.querySelector(".island-cap")).toBeNull();
expect(shell.firstElementChild).toHaveClass(
  "island-body",
  "flush-top-surface",
);
expect(screen.queryByText("Codex · decision")).toBeNull();
```

In the expanded-content test, add:

```ts
expect(screen.getByText("decision")).toBeVisible();
```

This protects the ordinary panel source/project header.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npm test -- apps/desktop/test/App.test.tsx
```

Expected: FAIL because compact mode still renders `DecisionHeader` and the source/project cap.

- [ ] **Step 3: Simplify compact composition**

In `App.tsx`, render `DecisionHeader` only in the non-compact branch:

```tsx
{compact ? (
  <section className="island-body flush-top-surface">
    <div className="island-question-row drag-region">
      <h1>{islandQuestion}</h1>
      <span>{step}</span>
    </div>
    {stepContent}
    {error === null ? null : (
      <p className="error-message" role="alert">
        {error}
      </p>
    )}
  </section>
) : (
  <>
    <DecisionHeader
      request={current.request}
      waitingCount={snapshot.waitingCount}
    />
    {stepContent}
    {error === null ? null : (
      <p className="error-message" role="alert">
        {error}
      </p>
    )}
  </>
)}
```

In `DecisionHeader.tsx`, remove `SOURCE_NAMES`, remove the `island` prop, and remove the compact conditional. Leave the existing ordinary `decision-header drag-region`, `origin-line`, `SourceBadge`, project, waiting count, and question markup unchanged.

- [ ] **Step 4: Make the single body the glass window**

Remove `.island-header`, `.island-cap`, `.activity-dot`, `.island-origin`, and `.island-cap .waiting-count`. Replace the combined cap/body styling with:

```css
.decision-shell.island {
  display: block;
  min-height: 100vh;
  overflow: hidden;
  border-radius: 0;
}

.island-body {
  width: 100%;
  min-height: 100vh;
  padding: 12px 16px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-top: 0;
  border-radius: 0 0 22px 22px;
  background:
    radial-gradient(
      circle at 6% -12%,
      rgb(56 201 157 / 10%),
      transparent 38%
    ),
    linear-gradient(135deg, var(--window-highlight), transparent 42%),
    var(--window);
  box-shadow:
    0 20px 52px var(--shadow),
    0 3px 12px var(--shadow-soft),
    inset 0 1px 0 var(--window-highlight);
  backdrop-filter: blur(34px) saturate(150%);
}
```

Keep the existing option, rationale, input, button, footer, and checkbox rules. The global `button`, `input`, and `textarea` no-drag rule remains authoritative while `.island-question-row.drag-region` provides window dragging.

- [ ] **Step 5: Run renderer and focused regression tests**

Run:

```bash
npm test -- apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx
```

Expected: both test files pass with no accessibility regression.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/test/App.test.tsx apps/desktop/src/renderer/App.tsx apps/desktop/src/renderer/components/DecisionHeader.tsx apps/desktop/src/renderer/styles.css
git commit -m "feat: unify compact island surface"
```

### Task 4: Verify, package, and inspect the real macOS window

**Files:**
- Verify only; no planned source changes.

- [ ] **Step 1: Run static and complete automated verification**

Run:

```bash
npm run typecheck
npm test
```

Expected: TypeScript succeeds and all Vitest files pass.

- [ ] **Step 2: Build and run the packaged smoke test**

Run:

```bash
npm run build
npm run smoke
```

Expected: Electron packaging succeeds and the smoke test exits successfully.

- [ ] **Step 3: Inspect choice and rationale in light and dark appearance**

Trigger a compact decision and verify:

- the body begins exactly at the current display work-area top;
- there are no transparent left/right shoulders above the body;
- the top corners are square and bottom corners remain rounded;
- choice mode remains non-activating;
- rationale mode accepts focus and text input;
- returning to choice keeps the same `x` and `y`;
- the checkbox remains labeled “不记录此次决策” and is not a switch;
- light and dark appearances preserve the glass material and readable contrast.

- [ ] **Step 4: Install the verified package**

Quit the currently installed Decision, preserve it in a uniquely named `/private/tmp` backup, copy the newly packaged `.app` to `/Applications/Decision.app`, relaunch it, and repeat the compact choice/rationale smoke check.

- [ ] **Step 5: Record final evidence**

Capture:

- the exact test count from `npm test`;
- successful typecheck, package, and smoke commands;
- the installed app path;
- the final commit range.
