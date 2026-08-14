# Settings Scrollbar Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the false 8px overflow from the default 680×430 settings view while preserving scrolling for genuinely long content.

**Architecture:** Add a macOS Electron layout probe that renders the real Vite settings page at the production window size and reports its scroll metrics. A Vitest regression test invokes that probe, then the CSS fix reduces only the excess bottom padding.

**Tech Stack:** Electron 43, Vite 8, React 19, Vitest 4, CSS

---

### Task 1: Add the failing real-layout regression

**Files:**
- Create: `scripts/check-settings-layout.cjs`
- Create: `apps/desktop/test/settings-layout.test.ts`

- [ ] **Step 1: Create the Electron layout probe**

Create `scripts/check-settings-layout.cjs`. Start a silent Vite development server using `apps/desktop/vite.renderer.config.ts`, open an offscreen frameless `BrowserWindow` with `width: 680` and `height: 430`, and navigate to `?preview=settings&theme=dark`. Poll until `.settings-grid` exists, wait for two animation frames, then print this JSON:

```js
{
  clientHeight: grid.clientHeight,
  overflowY: getComputedStyle(grid).overflowY,
  scrollHeight: grid.scrollHeight,
  viewportHeight: innerHeight,
  viewportWidth: innerWidth,
}
```

Always destroy the window, close the Vite server, and exit Electron. On failure, print the stack to stderr and exit non-zero.

- [ ] **Step 2: Write the Vitest assertion**

Create `apps/desktop/test/settings-layout.test.ts`:

```ts
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;
const scriptPath = new URL(
  "../../../scripts/check-settings-layout.cjs",
  import.meta.url,
).pathname;
const repositoryRoot = new URL("../../../", import.meta.url).pathname;

describe.skipIf(process.platform !== "darwin")(
  "settings layout",
  () => {
    it("fits the default settings cards without hiding real overflow", async () => {
      const { stdout } = await execFileAsync(
        electronPath,
        [scriptPath],
        {
          cwd: repositoryRoot,
          timeout: 20_000,
        },
      );
      const metrics = JSON.parse(stdout) as {
        clientHeight: number;
        overflowY: string;
        scrollHeight: number;
        viewportHeight: number;
        viewportWidth: number;
      };

      expect(metrics).toMatchObject({
        overflowY: "auto",
        viewportHeight: 430,
        viewportWidth: 680,
      });
      expect(metrics.scrollHeight).toBeLessThanOrEqual(
        metrics.clientHeight,
      );
    });
  },
);
```

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
npx vitest run apps/desktop/test/settings-layout.test.ts
```

Expected: FAIL because `scrollHeight` is 317 while `clientHeight` is 309.

- [ ] **Step 4: Commit the failing regression**

```bash
git add scripts/check-settings-layout.cjs apps/desktop/test/settings-layout.test.ts
git commit -m "test: reproduce settings scrollbar overflow"
```

### Task 2: Remove the false overflow

**Files:**
- Modify: `apps/desktop/src/renderer/styles.css:349-356`

- [ ] **Step 1: Apply the minimal CSS fix**

Change:

```css
.settings-grid {
  padding: 0 14px 14px;
}
```

to:

```css
.settings-grid {
  padding: 0 14px 6px;
}
```

Keep `overflow: auto` unchanged.

- [ ] **Step 2: Run the focused test and verify GREEN**

Run:

```bash
npx vitest run apps/desktop/test/settings-layout.test.ts
```

Expected: PASS with `scrollHeight <= clientHeight` and `overflowY: "auto"`.

- [ ] **Step 3: Run the complete verification**

Run:

```bash
npm test
npm run typecheck
git diff --check
```

Expected: all tests pass, TypeScript reports no errors, and the diff check is empty.

- [ ] **Step 4: Commit the fix**

```bash
git add apps/desktop/src/renderer/styles.css
git commit -m "fix: remove false settings scrollbar"
```

### Task 3: Package and install

**Files:**
- Verify: `out/Decision-darwin-arm64/Decision.app`
- Install: `/Applications/Decision.app`

- [ ] **Step 1: Build using the verified local Electron archive**

Run:

```bash
DECISION_ELECTRON_ZIP_DIR="$HOME/Library/Caches/electron/<cache-key>" npm run build
```

Expected: Electron Forge packages the arm64 macOS application successfully.

- [ ] **Step 2: Verify and install**

Verify the packaged app with:

```bash
codesign --verify --deep --strict --verbose=2 "out/Decision-darwin-arm64/Decision.app"
```

Quit the installed app, move the current `/Applications/Decision.app` to a unique recoverable path under `/private/tmp`, copy the new build into `/Applications`, and verify its signature again.

- [ ] **Step 3: Run the packaged smoke test and reopen the app**

Run:

```bash
npm run smoke
open -a "Decision"
```

Expected: smoke output contains `"ok":true`, and the installed app remains running.
