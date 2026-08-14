# Settings, Theme, and Unified Answer UI Implementation Plan

**Status:** Completed and verified on 2026-07-24.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved compact glass settings window, auto/light/dark theme persistence, corrected tray behavior, AI Living Mark assets, and a visually unified decision-answer flow.

**Architecture:** The Electron main process remains the single owner of persisted settings and maps the stored theme preference to `nativeTheme.themeSource`. A dedicated settings window mode preserves existing decision-panel sizing, while renderer semantic tokens style settings, compact decisions, expanded decisions, rationale input, and persistence feedback consistently. Tray and icon setup move behind testable narrow helpers and use committed assets generated from one SVG master.

**Tech Stack:** Electron 43, TypeScript 7, React 19, Zod, Vitest, Testing Library, Electron Forge/Vite, macOS `sips` and `iconutil`.

---

## File map

**Create**

- `apps/desktop/src/shared/appearance.ts` — shared theme enum and type.
- `apps/desktop/src/main/tray.ts` — testable tray menu and template-image configuration.
- `apps/desktop/src/renderer/components/BrandIcon.tsx` — renderer presentation of the canonical AI mark.
- `apps/desktop/assets/ai-living-mark.svg` — editable color SVG master.
- `apps/desktop/assets/trayTemplate.png` — generated 16px template image.
- `apps/desktop/assets/trayTemplate@2x.png` — generated 32px Retina template image.
- `apps/desktop/assets/app-icon.icns` — generated macOS App icon.
- `scripts/build-icons.sh` — deterministic macOS asset export from the SVG master.
- `apps/desktop/test/tray.test.ts` — tray behavior and icon setup tests.

**Modify**

- `apps/desktop/src/main/settings.ts` — v1→v2 migration and theme persistence.
- `apps/desktop/src/main/index.ts` — theme application, immutable setting updates, tray helper.
- `apps/desktop/src/main/ipc.ts` — validated `setTheme` channel.
- `apps/desktop/src/main/app-controller.ts` — dynamic theme in snapshots and explicit refresh.
- `apps/desktop/src/main/window-manager.ts` — independent settings mode and macOS vibrancy.
- `apps/desktop/src/preload/index.ts` — narrow `setTheme` bridge.
- `apps/desktop/src/shared/renderer-api.ts` — theme snapshot/API contract.
- `apps/desktop/src/renderer/preview-api.ts` — preview theme and no-op setter.
- `apps/desktop/src/renderer/App.tsx` — shared shell class for all decision states.
- `apps/desktop/src/renderer/components/SettingsPanel.tsx` — compact two-column settings UI.
- `apps/desktop/src/renderer/styles.css` — semantic light/dark glass design system.
- `apps/desktop/test/settings.test.ts` — migration and preservation tests.
- `apps/desktop/test/ipc.test.ts` — theme IPC validation tests.
- `apps/desktop/test/app-controller.test.ts` — dynamic theme snapshot tests.
- `apps/desktop/test/window-manager.test.ts` — settings size and vibrancy tests.
- `apps/desktop/test/App.test.tsx` — theme control and unified UI tests.
- `apps/desktop/test/accessibility.test.tsx` — accessible theme/control coverage.
- `forge.config.ts` — App icon and packaged tray assets.
- `.gitignore` — ignore temporary `.iconset` output if generated locally.

## Task 1: Versioned theme settings

**Files:**

- Create: `apps/desktop/src/shared/appearance.ts`
- Modify: `apps/desktop/src/main/settings.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Test: `apps/desktop/test/settings.test.ts`

- [ ] **Step 1: Write failing migration and preservation tests**

Add tests that require v2 defaults, v1 migration, all legal theme round trips, invalid theme rejection, and vault updates that preserve theme:

```ts
it("migrates v1 settings without changing the vault", async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, "settings.json");
  await writeFile(
    path,
    JSON.stringify({ version: 1, vaultPath: "/vault/existing" }),
    "utf8",
  );

  await expect(new SettingsRepository(path).load()).resolves.toEqual({
    version: 2,
    vaultPath: "/vault/existing",
    theme: "auto",
  });
});

it.each(["auto", "light", "dark"] as const)(
  "round trips the %s theme",
  async (theme) => {
    const directory = await temporaryDirectory();
    const path = join(directory, "settings.json");
    const repository = new SettingsRepository(path);
    await repository.save({
      version: 2,
      vaultPath: "/vault",
      theme,
    });
    await expect(repository.load()).resolves.toEqual({
      version: 2,
      vaultPath: "/vault",
      theme,
    });
  },
);

it("preserves theme when updating the vault", () => {
  expect(
    withVaultPath(
      { version: 2, vaultPath: "/old", theme: "dark" },
      "/new",
    ),
  ).toEqual({ version: 2, vaultPath: "/new", theme: "dark" });
});
```

- [ ] **Step 2: Run the focused test and verify red**

Run:

```bash
npx vitest run apps/desktop/test/settings.test.ts
```

Expected: failure because defaults are still v1 and `withVaultPath` does not exist.

- [ ] **Step 3: Add the shared theme contract and v2 migration**

Create:

```ts
export const THEME_PREFERENCES = ["auto", "light", "dark"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
```

In `settings.ts`, keep a strict v1 schema for reads, make the exported save schema strict v2, normalize reads, and expose a preservation helper:

```ts
const appSettingsV1Schema = z
  .object({
    version: z.literal(1),
    vaultPath: z.string().min(1).nullable(),
  })
  .strict();

export const appSettingsSchema = z
  .object({
    version: z.literal(2),
    vaultPath: z.string().min(1).nullable(),
    theme: z.enum(THEME_PREFERENCES),
  })
  .strict();

const storedSettingsSchema = z.union([
  appSettingsV1Schema,
  appSettingsSchema,
]);

const DEFAULT_SETTINGS: AppSettings = {
  version: 2,
  vaultPath: null,
  theme: "auto",
};

export const withVaultPath = (
  settings: AppSettings,
  vaultPath: string | null,
): AppSettings => ({ ...settings, vaultPath });
```

`load()` parses `storedSettingsSchema`; v1 returns `{ version: 2, vaultPath, theme: "auto" }`. Update every bootstrap assignment and `chooseVault` save in `index.ts` to call `withVaultPath(settings, path)` and assign the saved value back to the closure.

- [ ] **Step 4: Run focused tests and type checking**

Run:

```bash
npx vitest run apps/desktop/test/settings.test.ts
npm run typecheck
```

Expected: settings tests pass; type checking identifies only downstream snapshots that still need the required theme field and will be addressed in Task 2.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/appearance.ts apps/desktop/src/main/settings.ts apps/desktop/src/main/index.ts apps/desktop/test/settings.test.ts
git commit -m "升级主题设置并迁移旧配置"
```

## Task 2: Theme IPC, snapshot, and native application

**Files:**

- Modify: `apps/desktop/src/shared/renderer-api.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/main/app-controller.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/renderer/preview-api.ts`
- Modify: `apps/desktop/test/ipc.test.ts`
- Modify: `apps/desktop/test/app-controller.test.ts`
- Modify: `apps/desktop/test/App.test.tsx`
- Modify: `apps/desktop/test/accessibility.test.tsx`

- [ ] **Step 1: Write failing IPC and dynamic snapshot tests**

Add `setTheme` to the expected public method list and test legal/illegal values:

```ts
it("validates and forwards theme changes", async () => {
  const ipcMain = new FakeIpcMain();
  const queue = new DecisionQueue(() => "decision-current");
  const setTheme = vi.fn(async () => undefined);
  registerDecisionIpc({
    ipcMain,
    queue,
    operations: {
      openSettings: vi.fn(),
      closeSettings: vi.fn(),
      chooseVault: vi.fn(async () => null),
      installIntegrations: vi.fn(),
      rebuildIndex: vi.fn(),
      setTheme,
    },
  });

  await ipcMain.invoke(IPC_CHANNELS.setTheme, "dark");
  expect(setTheme).toHaveBeenCalledWith("dark");
  await expect(
    ipcMain.invoke(IPC_CHANNELS.setTheme, "sepia"),
  ).rejects.toThrow();
});
```

Add an `AppController` test whose `theme` callback changes from `auto` to `dark`, call `controller.refresh()`, and assert the last published snapshot contains `theme: "dark"`.

Update every `AppSnapshot` fixture in renderer tests with `theme: "auto"` and every `DecisionApi` fixture with `setTheme: vi.fn()`.

- [ ] **Step 2: Run focused tests and verify red**

Run:

```bash
npx vitest run apps/desktop/test/ipc.test.ts apps/desktop/test/app-controller.test.ts apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx
```

Expected: failure because the channel, method, snapshot field, and refresh method do not exist.

- [ ] **Step 3: Extend the renderer contract and preload**

Add:

```ts
export interface AppSnapshot extends DecisionQueueSnapshot {
  theme: ThemePreference;
}

export interface DecisionApi {
  setTheme(theme: ThemePreference): Promise<void>;
}
```

These are exact new members inserted into the existing interfaces; do not remove the existing snapshot fields or API methods.

Append `"setTheme"` to `RENDERER_METHOD_NAMES`, add `setTheme: "decision:set-theme"` to `IPC_CHANNELS`, expose:

```ts
setTheme: (theme) => ipcRenderer.invoke(IPC_CHANNELS.setTheme, theme),
```

and add a matching no-op method to `createPreviewApi()`.

- [ ] **Step 4: Validate IPC and make snapshots dynamic**

Add `setTheme(theme: ThemePreference)` to `DecisionIpcOperations` and register:

```ts
[
  IPC_CHANNELS.setTheme,
  (_event, input) =>
    options.operations.setTheme(z.enum(THEME_PREFERENCES).parse(input)),
],
```

Add `theme?: () => ThemePreference` to `AppControllerOptions`; emit `theme: this.#options.theme?.() ?? "auto"` and expose:

```ts
refresh(): void {
  this.#options.windows.publish(this.snapshot());
}
```

- [ ] **Step 5: Wire persistence and `nativeTheme`**

Import `nativeTheme` in `index.ts`. Before creating `WindowManager`, apply:

```ts
const electronThemeSource = {
  auto: "system",
  light: "light",
  dark: "dark",
} as const;

nativeTheme.themeSource = electronThemeSource[settings.theme];
```

Pass `theme: () => settings.theme` to `AppController`. Implement the IPC operation with save-before-apply semantics:

```ts
setTheme: async (theme) => {
  const next = { ...settings, theme };
  await settingsRepository.save(next);
  settings = next;
  nativeTheme.themeSource = electronThemeSource[theme];
  controller.refresh();
},
```

- [ ] **Step 6: Run focused tests and type checking**

Run:

```bash
npx vitest run apps/desktop/test/ipc.test.ts apps/desktop/test/app-controller.test.ts apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx
npm run typecheck
```

Expected: all listed tests and type checking pass.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/shared/renderer-api.ts apps/desktop/src/main/ipc.ts apps/desktop/src/preload/index.ts apps/desktop/src/main/app-controller.ts apps/desktop/src/main/index.ts apps/desktop/src/renderer/preview-api.ts apps/desktop/test
git commit -m "贯通应用主题切换"
```

## Task 3: Independent settings window and native glass

**Files:**

- Modify: `apps/desktop/src/main/window-manager.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Test: `apps/desktop/test/window-manager.test.ts`

- [ ] **Step 1: Write failing settings-mode and vibrancy tests**

Add:

```ts
expect(options).toMatchObject({
  vibrancy: "under-window",
  visualEffectState: "active",
});

manager.show("settings");
expect(window.setBounds).toHaveBeenLastCalledWith(
  { x: 10, y: 24, ...SETTINGS_SIZE },
  true,
);

manager.show("panel");
expect(window.setBounds).toHaveBeenLastCalledWith(
  { x: 10, y: 24, ...PANEL_SIZE },
  true,
);
```

Add a publish assertion that `settingsOpen: true` selects settings mode, while a long decision still selects the existing panel size.

Add a non-macOS creation assertion:

```ts
let createdOptions: BrowserWindowOptionsLike | undefined;
const manager = new WindowManager({
  createWindow: (options) => {
    createdOptions = options;
    return new FakeWindow();
  },
  screen: {
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    getDisplayNearestPoint: () => ({
      workArea: { x: 0, y: 24, width: 1_200, height: 800 },
    }),
  },
  preloadPath: "/app/preload.js",
  renderer: { kind: "file", value: "/app/index.html" },
  platform: "win32",
});
await manager.create();
expect(createdOptions).not.toHaveProperty("vibrancy");
expect(createdOptions).not.toHaveProperty("visualEffectState");
expect(createdOptions?.webPreferences).toMatchObject({
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
});
```

- [ ] **Step 2: Run the test and verify red**

Run:

```bash
npx vitest run apps/desktop/test/window-manager.test.ts
```

Expected: failure because `SETTINGS_SIZE`, settings mode, and vibrancy options do not exist.

- [ ] **Step 3: Implement the new mode without changing decision sizes**

Add:

```ts
export const SETTINGS_SIZE = { width: 680, height: 430 } as const;
export type WindowMode = "island" | "panel" | "settings";
```

Map modes explicitly:

```ts
const WINDOW_SIZES = {
  island: ISLAND_SIZE,
  panel: PANEL_SIZE,
  settings: SETTINGS_SIZE,
} as const;
```

Extend `BrowserWindowOptionsLike` with optional `vibrancy` and `visualEffectState`. Add a `platform?: NodeJS.Platform` option defaulting to `process.platform`; on Darwin pass:

```ts
vibrancy: "under-window",
visualEffectState: "active",
```

In `publish`, select `settings` before considering queue state. Keep `panel` at 560 × 640 and `island` at 420 × 72.

- [ ] **Step 4: Run focused tests and type checking**

Run:

```bash
npx vitest run apps/desktop/test/window-manager.test.ts
npm run typecheck
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/window-manager.ts apps/desktop/src/main/index.ts apps/desktop/test/window-manager.test.ts
git commit -m "分离设置窗口并启用原生毛玻璃"
```

## Task 4: AI Living Mark and tray behavior

**Files:**

- Create: `apps/desktop/src/main/tray.ts`
- Create: `apps/desktop/test/tray.test.ts`
- Create: `apps/desktop/assets/ai-living-mark.svg`
- Create: `scripts/build-icons.sh`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `forge.config.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Write failing tray tests**

Test that configuration sets a template image and context menu, contains “设置”, invokes `openSettings` only from that item, and never installs a direct click handler:

```ts
it("opens settings only from the 设置 menu item", () => {
  class FakeImage {
    readonly setTemplateImage = vi.fn();
  }
  class FakeTray {
    readonly listeners: string[] = [];
    readonly setImage = vi.fn();
    readonly setTitle = vi.fn((title: string) => {
      this.title = title;
    });
    readonly setToolTip = vi.fn();
    readonly setContextMenu = vi.fn();
    title = "◇";
    on(event: string): void {
      this.listeners.push(event);
    }
  }

  const openSettings = vi.fn();
  const quit = vi.fn();
  const tray = new FakeTray();
  const menu = configureTray({
    tray,
    image: new FakeImage(),
    buildMenu: (template) => ({ template }),
    openSettings,
    quit,
  });

  expect(tray.title).toBe("");
  expect(tray.listeners).not.toContain("click");
  const settings = menu.template[0];
  expect(settings.label).toBe("设置");
  settings.click?.();
  expect(openSettings).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run the test and verify red**

Run:

```bash
npx vitest run apps/desktop/test/tray.test.ts
```

Expected: failure because `configureTray` does not exist.

- [ ] **Step 3: Implement the narrow tray helper**

`configureTray` must:

- mark the supplied image as a template image;
- clear the title;
- set tooltip `Decision`;
- build the three-entry context menu;
- call `setContextMenu`;
- never call `tray.on("click", ...)`.

Replace the inline tray setup in `index.ts` with the helper and resolve the image path to packaged `Resources/assets/trayTemplate.png` or the development asset directory.

- [ ] **Step 4: Add the canonical SVG and export script**

Create an SVG with a rounded A skeleton and dotted lowercase i using a green→blue-violet gradient. Use the same geometry for a monochrome export.

`scripts/build-icons.sh` must:

1. validate `sips` and `iconutil`;
2. create a temporary iconset with `mktemp -d`;
3. rasterize the SVG at 16, 32, 64, 128, 256, 512, and 1024;
4. produce `trayTemplate.png` and `trayTemplate@2x.png` with monochrome linework and transparent background;
5. call `iconutil -c icns`;
6. move the final `.icns` to `apps/desktop/assets/app-icon.icns`;
7. remove only its validated temporary directory via a shell trap.

Run:

```bash
bash scripts/build-icons.sh
file apps/desktop/assets/trayTemplate.png apps/desktop/assets/trayTemplate@2x.png apps/desktop/assets/app-icon.icns
```

Expected: PNG 16×16, PNG 32×32, and valid Apple icon image.

- [ ] **Step 5: Package icon assets**

Set:

```ts
packagerConfig: {
  asar: true,
  name: "Decision",
  executableName: "Decision",
  appBundleId: "local.decision.app",
  appCategoryType: "public.app-category.developer-tools",
  icon: "apps/desktop/assets/app-icon",
  extraResource: ["dist/bridge", "apps/desktop/assets"],
}
```

The tray path must use `process.resourcesPath/assets/trayTemplate.png` when packaged.

- [ ] **Step 6: Run tests and type checking**

Run:

```bash
npx vitest run apps/desktop/test/tray.test.ts
npm run typecheck
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/tray.ts apps/desktop/src/main/index.ts apps/desktop/test/tray.test.ts apps/desktop/assets scripts/build-icons.sh forge.config.ts .gitignore
git commit -m "加入 AI 品牌图标与标准菜单栏交互"
```

## Task 5: Compact settings renderer

**Files:**

- Create: `apps/desktop/src/renderer/components/BrandIcon.tsx`
- Modify: `apps/desktop/src/renderer/components/SettingsPanel.tsx`
- Modify: `apps/desktop/src/renderer/styles.css`
- Modify: `apps/desktop/test/App.test.tsx`
- Modify: `apps/desktop/test/accessibility.test.tsx`

- [ ] **Step 1: Write failing UI behavior tests**

Require:

```ts
expect(await screen.findByRole("heading", { name: "设置" })).toBeVisible();
expect(screen.getByRole("group", { name: "外观" })).toBeVisible();
expect(screen.getByRole("button", { name: "自动" })).toHaveAttribute(
  "aria-pressed",
  "true",
);
await user.click(screen.getByRole("button", { name: "浅色" }));
expect(api.setTheme).toHaveBeenCalledWith("light");
expect(screen.getByTestId("settings-summary")).toBeVisible();
expect(screen.getByTestId("settings-grid")).toBeVisible();
```

Assert ordinary settings buttons contain their text but no child with `[data-decoration]`. Verify the theme group and close button have accessible names.

- [ ] **Step 2: Run renderer tests and verify red**

Run:

```bash
npx vitest run apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx
```

Expected: failure because the segmented theme control and compact structure do not exist.

- [ ] **Step 3: Implement the brand component and settings structure**

`BrandIcon` renders the same AI geometry as the SVG master and accepts `className` plus `decorative` props.

Rebuild `SettingsPanel` with:

```tsx
<main className="app-shell settings-panel">
  <header className="settings-toolbar drag-region">
    <div className="settings-brand">
      <BrandIcon decorative />
      <div>
        <p>Decision</p>
        <h1>设置</h1>
      </div>
    </div>
    <button
      className="close-button no-drag"
      aria-label="隐藏设置"
      onClick={() => void api.closeSettings()}
    >
      ×
    </button>
  </header>
  <section
    className="settings-summary"
    data-testid="settings-summary"
    aria-label="运行状态"
  >
    <div>
      <span>开发工具</span>
      <strong>{connectedCount} 个连接正常</strong>
    </div>
    <div>
      <span>本地索引</span>
      <strong>{snapshot.health.index === "healthy" ? "SQLite 健康" : "需要关注"}</strong>
    </div>
    <div>
      <span>待补理由</span>
      <strong>{snapshot.pendingRationales.length}</strong>
    </div>
  </section>
  <div className="settings-grid" data-testid="settings-grid">
    <section className="settings-card general-card" aria-labelledby="general-title">
      <header><h2 id="general-title">通用</h2><span>立即生效</span></header>
      <div className="setting-row">
        <div><strong>外观</strong><span>主题偏好</span></div>
        <div className="theme-segment" role="group" aria-label="外观">
          {([
            ["auto", "自动"],
            ["light", "浅色"],
            ["dark", "深色"],
          ] as const).map(([theme, label]) => (
            <button
              key={theme}
              aria-pressed={snapshot.theme === theme}
              disabled={busy}
              onClick={() => void run(() => api.setTheme(theme), "主题已更新。")}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="setting-row">
        <div><strong>Obsidian 仓库</strong><span>Markdown 事实源</span></div>
        <p className="path-value">{snapshot.vaultPath ?? "尚未选择仓库"}</p>
        <button disabled={busy} onClick={() => void run(() => api.chooseVault(), "仓库已更新，重启后生效。")}>更换</button>
      </div>
      <div className="setting-row">
        <div><strong>全文索引</strong><span>可随时重建</span></div>
        <span>{snapshot.health.index === "healthy" ? "正常" : "需要关注"}</span>
        <button disabled={busy} onClick={() => void run(() => api.rebuildIndex(), "SQLite 索引已从 Markdown 重建。")}>重建</button>
      </div>
    </section>
    <section className="settings-card integrations-card" aria-labelledby="integrations-title">
      <header><h2 id="integrations-title">开发工具</h2><span>{connectedCount} / 2</span></header>
      <dl className="integration-list">
        <div><dt>Claude Code</dt><dd>{integrationLabel(snapshot.integrationStatus.claudeCode)}</dd></div>
        <div><dt>Codex</dt><dd>{integrationLabel(snapshot.integrationStatus.codex)}</dd></div>
      </dl>
      <div className="action-row">
        <button disabled={busy} onClick={() => void run(() => api.installIntegrations("dry-run"), "检查完成，没有写入配置。")}>检查</button>
        <button disabled={busy} onClick={() => void run(() => api.installIntegrations("apply"), "连接已安装；重新打开客户端后生效。")}>重新安装</button>
      </div>
    </section>
    <section className="settings-card pending-card" aria-labelledby="pending-title">
      <PendingList
        decisions={snapshot.pendingRationales}
        onComplete={(id, rationale) =>
          run(
            () => api.submitRationale({
              decisionId: id,
              status: "captured",
              rationale,
            }),
            "理由已写入原决策笔记。",
          )
        }
      />
    </section>
  </div>
  {message === null ? null : <p className="settings-message" role="status">{message}</p>}
</main>
```

The appearance row maps `THEME_PREFERENCES` to three `button` elements with Chinese labels and `aria-pressed={snapshot.theme === theme}`. Use the existing `run` wrapper so a failed `api.setTheme` call reports the error without changing the snapshot-selected value.

Keep vault selection, index rebuild, integration dry run/apply, pending rationale completion, and close behavior functional. All ordinary buttons contain text only.

- [ ] **Step 4: Add semantic light/dark tokens and compact settings CSS**

Replace the dark-only root variables with light defaults plus a dark media query:

```css
:root {
  color-scheme: light;
  --window: rgb(245 249 249 / 52%);
  --toolbar: rgb(255 255 255 / 20%);
  --surface: rgb(255 255 255 / 34%);
  --surface-hover: rgb(255 255 255 / 52%);
  --border: rgb(255 255 255 / 78%);
  --text: #20252d;
  --muted: #6f7882;
  --accent: #15866a;
  --accent-surface: rgb(171 228 207 / 48%);
}

@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --window: rgb(17 23 34 / 76%);
    --toolbar: rgb(27 35 48 / 48%);
    --surface: rgb(31 42 57 / 62%);
    --surface-hover: rgb(40 54 72 / 74%);
    --border: rgb(204 222 240 / 15%);
    --text: #f4f7fb;
    --muted: #a9b4c4;
    --accent: #8ee3c5;
    --accent-surface: rgb(57 129 105 / 42%);
  }
}
```

Implement the approved 52px toolbar, three-item summary, 3:2 grid, full-width pending card, translucent cards, segmented theme control, and icon-free soft pill buttons. Keep body transparent so native vibrancy remains visible.

- [ ] **Step 5: Run renderer tests**

Run:

```bash
npx vitest run apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/components/BrandIcon.tsx apps/desktop/src/renderer/components/SettingsPanel.tsx apps/desktop/src/renderer/styles.css apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx
git commit -m "重做紧凑玻璃设置界面"
```

## Task 6: Visually unify the answer flow

**Files:**

- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/components/ChoiceStep.tsx`
- Modify: `apps/desktop/src/renderer/components/RationaleStep.tsx`
- Modify: `apps/desktop/src/renderer/components/PendingList.tsx`
- Modify: `apps/desktop/src/renderer/styles.css`
- Modify: `apps/desktop/test/App.test.tsx`
- Modify: `apps/desktop/test/accessibility.test.tsx`

- [ ] **Step 1: Write failing shared-style assertions**

Assert choice, rationale, and failed-persistence states all use the shared shell and semantic control classes:

```ts
expect(await screen.findByTestId("decision-shell")).toHaveClass("app-shell");
expect(screen.getByRole("button", { name: /Loopback HTTP/u })).toHaveClass(
  "choice-button",
);
expect(screen.getByRole("textbox", { name: "我的理由（原文）" })).toHaveClass(
  "glass-input",
);
expect(screen.getByRole("button", { name: "保存理由" })).toHaveClass(
  "primary-button",
);
```

Keep existing behavioral tests for preset choice, custom choice, no-record, deferred/skipped rationale, pending rationale, and retry persistence unchanged.

- [ ] **Step 2: Run renderer tests and verify red**

Run:

```bash
npx vitest run apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx
```

Expected: failure for the new shared shell/input classes.

- [ ] **Step 3: Apply shared semantic classes**

Add `app-shell` to every `decision-shell`. Add `glass-input` to custom-answer inputs, rationale textareas, and pending-rationale textareas. Keep ordinary action buttons text-only. Do not alter decision transitions, queue calls, record toggles, option labels, or compact-decision thresholds.

- [ ] **Step 4: Complete the unified answer CSS**

Use the same window, surface, border, text, accent, focus, shadow, and motion tokens for:

- compact and expanded `.decision-shell`;
- `.choice-button` compact pills and expanded cards;
- `.source-badge` and `.recommendation-label`;
- `.glass-input`, checkboxes, and reason factors;
- rationale action buttons;
- persistence status and retry;
- pending-rationale editor.

The compact island remains 72px tall. The expanded panel remains scrollable at 560 × 640. Add:

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
}
```

- [ ] **Step 5: Run renderer and accessibility tests**

Run:

```bash
npx vitest run apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx
```

Expected: pass with all original behavior assertions intact.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx
git commit -m "统一决策回答流程视觉"
```

## Task 7: Full verification, packaging, installation, and real UI QA

**Files:**

- Modify only if verification exposes an issue in files already listed above.

- [ ] **Step 1: Run the complete automated verification**

Run:

```bash
npm test
npm run typecheck
npm run build
```

Expected: all test files pass, TypeScript exits 0, and Electron Forge produces `out/Decision-darwin-arm64/Decision.app`.

- [ ] **Step 2: Inspect packaged assets and security settings**

Run:

```bash
test -f "out/Decision-darwin-arm64/Decision.app/Contents/Resources/assets/trayTemplate.png"
test -f "out/Decision-darwin-arm64/Decision.app/Contents/Resources/assets/trayTemplate@2x.png"
test -f "out/Decision-darwin-arm64/Decision.app/Contents/Resources/electron.icns"
codesign -dv --verbose=2 "out/Decision-darwin-arm64/Decision.app"
```

Expected: all resources exist and the local package has a valid ad-hoc signature.

- [ ] **Step 3: Install the verified package**

Quit the existing app, replace `/Applications/Decision.app` using `ditto`, and launch it. This step requires the existing approved macOS installation scope.

- [ ] **Step 4: Exercise real menu and appearance behavior**

In the installed App:

1. left-click the tray icon and verify only the native menu opens;
2. verify the menu text is “设置”;
3. choose “设置” and inspect the 680 × 430 window;
4. switch auto → light → dark and verify immediate visual changes;
5. return to auto, change macOS appearance, and verify live following;
6. quit/relaunch and verify the stored theme;
7. inspect the AI App icon, toolbar mark, 16px tray mark, and Retina mark;
8. trigger compact choice, expanded choice, custom answer, rationale, deferred/skipped rationale, and persistence feedback;
9. confirm every answer state shares the approved glass, typography, buttons, inputs, and focus language.

- [ ] **Step 5: Run smoke verification against the installed package**

Run:

```bash
npm run smoke
```

Expected: Electron App starts with isolated user data, bridge handshake succeeds, the decision flow completes, and smoke exits 0.

- [ ] **Step 6: Fix any QA defect test-first and rerun the affected gate**

For each defect, first add or tighten the nearest Vitest assertion, reproduce the failure, apply the smallest correction, rerun the focused test, then rerun Step 1 and the affected real-UI check.

- [ ] **Step 7: Final commit**

```bash
git add apps/desktop forge.config.ts scripts package-lock.json package.json
git commit -m "完成设置主题与统一界面验收"
```

If no files changed after the previous commits, do not create an empty commit.
