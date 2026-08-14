# Settings Frosted Toolbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore visible native frosted transparency in both themes and place the settings close button on the left.

**Architecture:** Extend the existing real-Electron settings layout probe to report theme tokens, blur, and toolbar geometry. Use those measurements as failing regression tests, then make one focused renderer structure change and one focused theme-token change.

**Tech Stack:** Electron 43, React 19, CSS, Vite 8, Vitest 4

---

### Task 1: Add failing frosted-glass and toolbar-position regressions

**Files:**
- Modify: `scripts/check-settings-layout.cjs`
- Modify: `apps/desktop/test/settings-layout.test.ts`

- [ ] **Step 1: Make the real layout probe theme-aware**

In `scripts/check-settings-layout.cjs`, read a `light` or `dark` argument:

```js
const theme = process.argv[2] ?? "dark";
if (theme !== "light" && theme !== "dark") {
  throw new Error(`Unsupported settings layout theme: ${theme}`);
}
```

Navigate to the selected theme:

```js
await window.loadURL(
  `http://127.0.0.1:${port}/?preview=settings&theme=${theme}`,
);
```

When `.settings-grid` is available, also require `.app-shell`,
`.settings-toolbar`, `.settings-brand`, and `.close-button`. Return:

```js
{
  backdropFilter: getComputedStyle(shell).backdropFilter,
  brandLeft: brand.getBoundingClientRect().left,
  clientHeight: grid.clientHeight,
  closeButtonLeft: closeButton.getBoundingClientRect().left,
  overflowY: getComputedStyle(grid).overflowY,
  scrollHeight: grid.scrollHeight,
  tokens: {
    surface: rootStyles.getPropertyValue("--surface").trim(),
    toolbar: rootStyles.getPropertyValue("--toolbar").trim(),
    window: rootStyles.getPropertyValue("--window").trim(),
  },
  toolbarJustifyContent:
    getComputedStyle(toolbar).justifyContent,
  viewportHeight: innerHeight,
  viewportWidth: innerWidth,
}
```

- [ ] **Step 2: Add alpha-budget and left-position tests**

In `apps/desktop/test/settings-layout.test.ts`, extract `measureSettings(theme)`
and cache each spawned Electron result. Parse percentages from CSS colors:

```ts
const alphaOf = (color: string): number => {
  const match = color.match(/\/\s*([\d.]+)%\)$/u);
  if (match?.[1] === undefined) {
    throw new Error(`CSS color does not contain alpha: ${color}`);
  }
  return Number(match[1]) / 100;
};

const compositeAlpha = (back: number, front: number): number =>
  1 - (1 - back) * (1 - front);
```

Add theme cases:

```ts
it.each([
  { theme: "light", maximumComposite: 0.6, maximumToolbar: 0.18 },
  { theme: "dark", maximumComposite: 0.76, maximumToolbar: 0.25 },
])(
  "keeps $theme settings translucent enough for native vibrancy",
  async ({ theme, maximumComposite, maximumToolbar }) => {
    const metrics = await measureSettings(theme);
    expect(metrics.backdropFilter).toContain("blur(34px)");
    expect(alphaOf(metrics.tokens.toolbar)).toBeLessThanOrEqual(
      maximumToolbar,
    );
    expect(
      compositeAlpha(
        alphaOf(metrics.tokens.window),
        alphaOf(metrics.tokens.surface),
      ),
    ).toBeLessThanOrEqual(maximumComposite);
  },
);
```

Add toolbar geometry:

```ts
it("places the settings close button before the brand", async () => {
  const metrics = await measureSettings("dark");
  expect(metrics.toolbarJustifyContent).toBe("flex-start");
  expect(metrics.closeButtonLeft).toBeLessThan(metrics.brandLeft);
});
```

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
npx vitest run apps/desktop/test/settings-layout.test.ts
```

Expected failures:

- light composite alpha is about `0.6832`, above `0.6`;
- dark composite alpha is about `0.9088`, above `0.76`;
- close button is right of the brand and toolbar justification is
  `space-between`.

- [ ] **Step 4: Commit the failing regressions**

```bash
git add scripts/check-settings-layout.cjs apps/desktop/test/settings-layout.test.ts
git commit -m "test: reproduce opaque settings and right close button"
```

### Task 2: Restore translucency and move the close button

**Files:**
- Modify: `apps/desktop/src/renderer/components/SettingsPanel.tsx:59-79`
- Modify: `apps/desktop/src/renderer/styles.css:1-118`
- Modify: `apps/desktop/src/renderer/styles.css:203-212`

- [ ] **Step 1: Put the close button first in the toolbar**

In `SettingsPanel.tsx`, move the existing close button before
`.settings-brand` without changing its label or click handler:

```tsx
<header className="settings-toolbar drag-region">
  <button
    className="close-button no-drag"
    aria-label="隐藏设置"
    onClick={() => void api.closeSettings()}
  >
    ×
  </button>
  <div className="settings-brand">
    <span className="brand-mark">
      <BrandIcon />
    </span>
    <div className="settings-title">
      <span>Decision</span>
      <span aria-hidden="true">/</span>
      <h1>设置</h1>
    </div>
  </div>
</header>
```

In `styles.css`, update the toolbar flow:

```css
.settings-toolbar {
  justify-content: flex-start;
  gap: 10px;
}
```

- [ ] **Step 2: Lower the translucent surface alpha values**

Apply these values to `:root` and
`html[data-preview-theme="light"]`:

```css
--window: rgb(245 249 249 / 38%);
--toolbar: rgb(255 255 255 / 14%);
--surface: rgb(255 255 255 / 24%);
--surface-raised: rgb(255 255 255 / 36%);
--surface-hover: rgb(255 255 255 / 50%);
--surface-inset: rgb(210 218 221 / 26%);
```

Apply these values to the dark media query and
`html[data-preview-theme="dark"]`:

```css
--window: rgb(13 19 29 / 54%);
--toolbar: rgb(28 37 51 / 22%);
--surface: rgb(31 42 57 / 38%);
--surface-raised: rgb(40 53 70 / 48%);
--surface-hover: rgb(48 64 84 / 60%);
--surface-inset: rgb(8 14 23 / 28%);
```

Keep native vibrancy, `backdrop-filter`, text, borders, shadows, accents,
window sizes, and all decision-answer styles unchanged.

- [ ] **Step 3: Run the focused test and verify GREEN**

Run:

```bash
npx vitest run apps/desktop/test/settings-layout.test.ts
```

Expected: all layout, transparency, blur, overflow, and close-position tests
pass.

- [ ] **Step 4: Run complete verification**

Run:

```bash
npm test
npm run typecheck
git diff --check
```

Expected: all tests pass, TypeScript reports no errors, and the diff check is
empty.

- [ ] **Step 5: Commit the renderer change**

```bash
git add apps/desktop/src/renderer/components/SettingsPanel.tsx apps/desktop/src/renderer/styles.css
git commit -m "fix: restore frosted settings and move close button"
```

### Task 3: Package, install, and inspect

**Files:**
- Verify: `out/Decision-darwin-arm64/Decision.app`
- Install: `/Applications/Decision.app`

- [ ] **Step 1: Build with the verified local Electron archive**

Run:

```bash
DECISION_ELECTRON_ZIP_DIR="$HOME/Library/Caches/electron/<cache-key>" npm run build
```

Expected: Electron Forge packages the arm64 macOS application successfully.

- [ ] **Step 2: Verify, back up, and install**

Verify the packaged app:

```bash
codesign --verify --deep --strict --verbose=2 "out/Decision-darwin-arm64/Decision.app"
```

Quit the installed app, move it to a unique recoverable path under
`/private/tmp`, copy the new build to `/Applications/Decision.app`,
and verify the installed signature.

- [ ] **Step 3: Run packaged smoke and restore normal launch**

Run:

```bash
npm run smoke
open -a "Decision"
```

Expected: smoke output contains `"ok":true`, the installed app remains
running, and the settings toolbar shows the close button on the left over a
visibly frosted background.
