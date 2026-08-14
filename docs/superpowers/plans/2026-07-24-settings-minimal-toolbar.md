# Settings Minimal Toolbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify the settings toolbar to a compact, left-aligned close control with no redundant branding.

**Architecture:** Extend the existing real-Electron layout probe to report toolbar height and whether the settings brand exists. Drive a focused React and CSS change from a failing regression test while leaving window vibrancy, themes, settings content, and answer UI untouched.

**Tech Stack:** Electron 43, React 19, CSS, Vite 8, Vitest 4

---

### Task 1: Add a failing minimal-toolbar regression

**Files:**
- Modify: `scripts/check-settings-layout.cjs`
- Modify: `apps/desktop/test/settings-layout.test.ts`

- [ ] **Step 1: Make the layout probe independent of the brand element**

In `scripts/check-settings-layout.cjs`, stop requiring `.settings-brand` before
measurement and return explicit brand presence and toolbar height:

```js
const brand = document.querySelector(".settings-brand");

resolve({
  backdropFilter: getComputedStyle(shell).backdropFilter,
  brandPresent: brand !== null,
  clientHeight: grid.clientHeight,
  closeButtonLeft: closeButton.getBoundingClientRect().left,
  overflowY: getComputedStyle(grid).overflowY,
  scrollHeight: grid.scrollHeight,
  tokens: {
    surface: rootStyles.getPropertyValue("--surface").trim(),
    toolbar: rootStyles.getPropertyValue("--toolbar").trim(),
    window: rootStyles.getPropertyValue("--window").trim(),
  },
  toolbarHeight: toolbar.getBoundingClientRect().height,
  toolbarJustifyContent: getComputedStyle(toolbar).justifyContent,
  viewportHeight: innerHeight,
  viewportWidth: innerWidth,
});
```

- [ ] **Step 2: Replace the brand-order assertion**

Update `SettingsMetrics` in
`apps/desktop/test/settings-layout.test.ts`:

```ts
interface SettingsMetrics {
  backdropFilter: string;
  brandPresent: boolean;
  clientHeight: number;
  closeButtonLeft: number;
  overflowY: string;
  scrollHeight: number;
  tokens: {
    surface: string;
    toolbar: string;
    window: string;
  };
  toolbarHeight: number;
  toolbarJustifyContent: string;
  viewportHeight: number;
  viewportWidth: number;
}
```

Replace the close-before-brand test with:

```ts
it("keeps the settings toolbar compact and brand-free", async () => {
  const metrics = await measureSettings("dark");

  expect(metrics.brandPresent).toBe(false);
  expect(metrics.toolbarHeight).toBe(44);
  expect(metrics.toolbarJustifyContent).toBe("flex-start");
  expect(metrics.closeButtonLeft).toBeLessThanOrEqual(16);
});
```

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
npx vitest run apps/desktop/test/settings-layout.test.ts
```

Expected: the new assertion fails because the brand is present and the toolbar
height is 52px.

- [ ] **Step 4: Commit the failing regression**

```bash
git add scripts/check-settings-layout.cjs apps/desktop/test/settings-layout.test.ts
git commit -m "test: reproduce crowded settings toolbar"
```

### Task 2: Remove branding and compact the toolbar

**Files:**
- Modify: `apps/desktop/test/App.test.tsx:184-214`
- Modify: `apps/desktop/src/renderer/components/SettingsPanel.tsx:1-78`
- Modify: `apps/desktop/src/renderer/styles.css:203-258`

- [ ] **Step 1: Update the settings-page contract**

Replace the obsolete “设置” heading lookup in `App.test.tsx` with:

```tsx
expect(
  await screen.findByRole("button", { name: "隐藏设置" }),
).toBeVisible();
expect(screen.queryByRole("heading", { name: "设置" })).toBeNull();
expect(screen.queryByText("Decision")).toBeNull();
```

The remaining vault, index, pending-rationale, summary, and grid assertions stay
unchanged.

- [ ] **Step 2: Render only the close control**

Remove the `BrandIcon` import and all `.settings-brand` markup, leaving:

```tsx
<header className="settings-toolbar drag-region">
  <button
    className="close-button no-drag"
    aria-label="隐藏设置"
    onClick={() => void api.closeSettings()}
  >
    ×
  </button>
</header>
```

- [ ] **Step 3: Compact the toolbar and remove unused settings-brand rules**

Change `.settings-toolbar` to:

```css
.settings-toolbar {
  display: flex;
  height: 44px;
  align-items: center;
  justify-content: flex-start;
  padding: 0 15px;
  border-bottom: 1px solid var(--border-muted);
  background: var(--toolbar);
  box-shadow: inset 0 1px 0 var(--window-highlight);
}
```

Delete the now-unused `.settings-brand`, `.brand-mark`, and `.settings-title`
rules. Keep `.close-button`, theme tokens, native vibrancy, and all settings and
answer content styles unchanged.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
npx vitest run apps/desktop/test/settings-layout.test.ts
```

Expected: all four settings layout tests pass.

- [ ] **Step 5: Run complete verification**

Run:

```bash
npm test
npm run typecheck
git diff --check
```

Expected: all tests pass, TypeScript reports no errors, and the diff check is
empty.

- [ ] **Step 6: Commit the renderer change**

```bash
git add apps/desktop/test/App.test.tsx apps/desktop/src/renderer/components/SettingsPanel.tsx apps/desktop/src/renderer/styles.css docs/superpowers/plans/2026-07-24-settings-minimal-toolbar.md
git commit -m "fix: simplify settings toolbar"
```

### Task 3: Package, install, and inspect

**Files:**
- Verify: `out/Decision-darwin-arm64/Decision.app`
- Install: `/Applications/Decision.app`

- [ ] **Step 1: Build the arm64 macOS application**

Run:

```bash
DECISION_ELECTRON_ZIP_DIR="$HOME/Library/Caches/electron/<cache-key>" npm run build
```

Expected: Electron Forge packages the application successfully.

- [ ] **Step 2: Verify, back up, and install**

Verify the packaged app with:

```bash
codesign --verify --deep --strict --verbose=2 "out/Decision-darwin-arm64/Decision.app"
```

Stop the installed instance, move `/Applications/Decision.app` to a
unique `/private/tmp/Decision-before-minimal-toolbar-*.app` backup, and
copy the verified package into `/Applications`.

- [ ] **Step 3: Run installed-app checks**

Run:

```bash
codesign --verify --deep --strict --verbose=2 "/Applications/Decision.app"
npm run smoke
```

Expected: signature verification and the packaged-app smoke test pass.

- [ ] **Step 4: Inspect the real settings window**

Launch the installed app directly in settings mode and verify:

- the toolbar contains only the left close button;
- no Logo, product name, separator, or “设置” remains;
- the toolbar and cards retain their frosted transparency;
- no right-side scrollbar appears;
- the state cards move upward without clipping.

- [ ] **Step 5: Relaunch the normal application**

Stop the isolated visual-check process and open the installed application
normally. Confirm one Decision process remains running.
