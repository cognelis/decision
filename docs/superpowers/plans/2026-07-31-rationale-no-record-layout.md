# “不记录”理由岛布局修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 勾选“不记录此次决策”后将理由岛收缩到固定紧凑高度，并消除提交时先放大再隐藏的窗口抽动。

**Architecture:** 共享布局层新增受控的 `island-rationale-compact` 模式，renderer 只能通过严格布尔 IPC 请求完整或紧凑理由岛，主进程持有所有实际尺寸和定位。窗口管理器在保存中的 `completed` 快照上立即隐藏，只有持久化失败才显示普通错误面板。

**Tech Stack:** TypeScript 7、React 19、Electron、Zod 4、Vitest 4、Testing Library

---

## File map

- `apps/desktop/src/shared/decision-layout.ts`：声明紧凑理由岛尺寸和窗口模式。
- `apps/desktop/src/main/window-manager.ts`：执行受控 resize，管理当前模式，并在保存期间隐藏窗口。
- `apps/desktop/src/main/liquid-glass.ts`：让完整和紧凑理由岛使用相同底部圆角玻璃。
- `apps/desktop/src/shared/renderer-api.ts`：声明 renderer 的紧凑模式方法和 IPC channel。
- `apps/desktop/src/preload/index.ts`：暴露严格受限的紧凑切换方法。
- `apps/desktop/src/main/ipc.ts`：校验布尔值并转发窗口操作。
- `apps/desktop/src/main/index.ts`：把 IPC 操作绑定到 `WindowManager`。
- `apps/desktop/src/renderer/App.tsx`：把窗口切换回调传给理由步骤。
- `apps/desktop/src/renderer/components/RationaleStep.tsx`：在复选框变化时请求对应窗口模式。
- `apps/desktop/src/renderer/preview-api.ts`：为本地预览提供无副作用实现。
- `apps/desktop/test/decision-layout.test.ts`：锁定紧凑尺寸。
- `apps/desktop/test/window-manager.test.ts`：锁定 resize、保存中隐藏和失败重现行为。
- `apps/desktop/test/liquid-glass.test.ts`：锁定紧凑理由岛圆角。
- `apps/desktop/test/ipc.test.ts`：锁定 renderer surface 和布尔校验。
- `apps/desktop/test/App.test.tsx`：锁定勾选/取消勾选的窗口请求。
- `apps/desktop/test/accessibility.test.tsx`：补齐测试 API fixture。
- `scripts/check-rationale-layout.cjs`：支持“不记录”和“展开后不记录”布局测量。
- `apps/desktop/test/rationale-layout.test.ts`：锁定 256px 内的实际 Electron 布局。

### Task 1: 增加受控紧凑窗口模式并消除保存中放大

**Files:**
- Modify: `apps/desktop/test/decision-layout.test.ts`
- Modify: `apps/desktop/test/window-manager.test.ts`
- Modify: `apps/desktop/test/liquid-glass.test.ts`
- Modify: `apps/desktop/src/shared/decision-layout.ts`
- Modify: `apps/desktop/src/main/window-manager.ts`
- Modify: `apps/desktop/src/main/liquid-glass.ts`

- [ ] **Step 1: 写紧凑尺寸和窗口行为失败测试**

在 `decision-layout.test.ts` 导入并断言：

```ts
expect(ISLAND_RATIONALE_COMPACT_SIZE).toEqual({
  width: 560,
  height: 256,
});
```

在 `window-manager.test.ts` 增加两个测试。第一个先发布普通理由候选，再调用：

```ts
manager.setRationaleCompact(true);

expect(window.setBounds).toHaveBeenLastCalledWith(
  {
    x: 320,
    y: 24,
    ...ISLAND_RATIONALE_COMPACT_SIZE,
  },
  true,
);
expect(window.show).toHaveBeenCalledTimes(1);
expect(window.focus).toHaveBeenCalledTimes(1);

manager.setRationaleCompact(false);
expect(window.setBounds).toHaveBeenLastCalledWith(
  {
    x: 320,
    y: 24,
    ...ISLAND_RATIONALE_SIZE,
  },
  true,
);
```

第二个依次发布 `completed/saving` 和 `completed/failed` 快照：

```ts
manager.publish(savingSnapshot);
expect(window.hide).toHaveBeenCalledOnce();
expect(window.setBounds).not.toHaveBeenCalledWith(
  expect.objectContaining(PANEL_SIZE),
  true,
);

manager.publish(failedSnapshot);
expect(window.setBounds).toHaveBeenLastCalledWith(
  expect.objectContaining(PANEL_SIZE),
  true,
);
expect(window.show).toHaveBeenCalled();
```

在 `liquid-glass.test.ts` 调用：

```ts
surface?.update("island-rationale-compact");
expect(applyGlass).toHaveBeenLastCalledWith(handle, {
  cornerRadius: 22,
  corners: "bottom",
  style: "regular",
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
npm test -- apps/desktop/test/decision-layout.test.ts apps/desktop/test/window-manager.test.ts apps/desktop/test/liquid-glass.test.ts
```

Expected: FAIL，因为紧凑尺寸、模式和 `setRationaleCompact()` 尚不存在，保存中快照仍切换到 panel。

- [ ] **Step 3: 实现固定尺寸、模式和保存状态处理**

在 `decision-layout.ts` 增加：

```ts
export const ISLAND_RATIONALE_COMPACT_SIZE = {
  width: 560,
  height: 256,
} as const;
```

并把 `"island-rationale-compact"` 加入 `DecisionWindowMode`。

在 `window-manager.ts`：

1. 将紧凑尺寸加入 `WINDOW_SIZES`；
2. 让两个理由岛模式都固定在工作区顶部；
3. 记录当前 mode；
4. 新增 `setRationaleCompact(compact: boolean)`，仅在理由岛模式下切换固定 bounds 和原生表面，不调用 `show()` 或 `focus()`；
5. `publish()` 遇到 `current.status === "completed"` 且 `persistenceStatus === "saving"` 时直接 `hide()`；
6. `completed/failed` 保持现有 panel 行为；
7. 离开理由岛或候选消失时重置紧凑状态。

在 `liquid-glass.ts` 将判断改为：

```ts
if (
  mode === "island-rationale" ||
  mode === "island-rationale-compact"
) {
  return {
    cornerRadius: 22,
    corners: "bottom",
    style: "regular",
  };
}
```

- [ ] **Step 4: 运行测试确认 GREEN**

Run:

```bash
npm test -- apps/desktop/test/decision-layout.test.ts apps/desktop/test/window-manager.test.ts apps/desktop/test/liquid-glass.test.ts
```

Expected: 3 files PASS；紧凑切换不重复 show/focus；saving 不再触发 panel bounds。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/shared/decision-layout.ts apps/desktop/src/main/window-manager.ts apps/desktop/src/main/liquid-glass.ts apps/desktop/test/decision-layout.test.ts apps/desktop/test/window-manager.test.ts apps/desktop/test/liquid-glass.test.ts
git commit -m "fix: stabilize rationale window transitions"
```

### Task 2: 贯通 renderer 的语义化紧凑请求

**Files:**
- Modify: `apps/desktop/test/ipc.test.ts`
- Modify: `apps/desktop/test/App.test.tsx`
- Modify: `apps/desktop/src/shared/renderer-api.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/components/RationaleStep.tsx`
- Modify: `apps/desktop/src/renderer/preview-api.ts`
- Modify: `apps/desktop/test/accessibility.test.tsx`

- [ ] **Step 1: 写 IPC 与 renderer 失败测试**

在 `ipc.test.ts` 的 `RENDERER_METHOD_NAMES` 期望中加入
`"setRationaleCompact"`，在 fixture operations 中加入：

```ts
setRationaleCompact: vi.fn(),
```

新增：

```ts
it("validates and forwards the rationale compact mode", async () => {
  const ipcMain = new FakeIpcMain();
  const setRationaleCompact = vi.fn();
  registerDecisionIpc({
    ipcMain,
    queue: new RationaleQueue(),
    operations: operations({ setRationaleCompact }),
  });

  await ipcMain.invoke(IPC_CHANNELS.setRationaleCompact, true);
  await ipcMain.invoke(IPC_CHANNELS.setRationaleCompact, false);

  expect(setRationaleCompact.mock.calls).toEqual([
    [true],
    [false],
  ]);
  await expect(
    ipcMain.invoke(IPC_CHANNELS.setRationaleCompact, "true"),
  ).rejects.toThrow();
});
```

在 `App.test.tsx` 的 API fixture 加入 `setRationaleCompact` mock，并扩展
`"discards through the required checkbox"`：

```ts
const checkbox = await screen.findByRole("checkbox", {
  name: "不记录此次决策",
});
await user.click(checkbox);
expect(api.setRationaleCompact).toHaveBeenLastCalledWith(true);
await user.click(checkbox);
expect(api.setRationaleCompact).toHaveBeenLastCalledWith(false);
await user.click(checkbox);
```

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
npm test -- apps/desktop/test/ipc.test.ts apps/desktop/test/App.test.tsx
```

Expected: FAIL，因为 renderer API、IPC channel 和 RationaleStep 回调尚不存在。

- [ ] **Step 3: 实现窄 IPC 和复选框回调**

在 `renderer-api.ts`：

```ts
setRationaleCompact: "decision:set-rationale-compact",
```

并在 `DecisionApi` 中声明：

```ts
setRationaleCompact(compact: boolean): Promise<void>;
```

在 preload 实现对应 `ipcRenderer.invoke`。在 `DecisionIpcOperations` 增加
`setRationaleCompact(compact: boolean)`，handler 使用：

```ts
options.operations.setRationaleCompact(
  z.boolean().parse(input),
)
```

在 `main/index.ts` 的 operations 中绑定：

```ts
setRationaleCompact: (compact) =>
  windows.setRationaleCompact(compact),
```

给 `RationaleStep` 增加：

```ts
onCompactChange(compact: boolean): void;
```

复选框变化时先 `setDoNotRecord(compact)`，再调用 `onCompactChange(compact)`。
`App` 传入一个吞掉非关键 resize 拒绝的回调：

```ts
onCompactChange={(next) => {
  void api.setRationaleCompact(next).catch(() => undefined);
}}
```

在 `preview-api.ts`、`App.test.tsx` 和 `accessibility.test.tsx` 的 API fixture
补上无副作用实现。

- [ ] **Step 4: 运行测试与类型检查确认 GREEN**

Run:

```bash
npm test -- apps/desktop/test/ipc.test.ts apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx
npm run typecheck
```

Expected: 3 files PASS，TypeScript exit 0。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/shared/renderer-api.ts apps/desktop/src/preload/index.ts apps/desktop/src/main/ipc.ts apps/desktop/src/main/index.ts apps/desktop/src/renderer/App.tsx apps/desktop/src/renderer/components/RationaleStep.tsx apps/desktop/src/renderer/preview-api.ts apps/desktop/test/ipc.test.ts apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx
git commit -m "fix: resize no-record rationale state"
```

### Task 3: 锁定真实 Electron 布局并完成发布验证

**Files:**
- Modify: `apps/desktop/test/rationale-layout.test.ts`
- Modify: `scripts/check-rationale-layout.cjs`

- [ ] **Step 1: 写展开上下文后不记录的失败测试**

扩展 `RationaleMetrics["interaction"]`，加入
`"no-record" | "expanded-no-record"`。让 `measureRationale()` 对这两个交互使用
`ISLAND_RATIONALE_COMPACT_SIZE.height`。

新增：

```ts
it("fits expanded no-record confirmation in the compact island", async () => {
  const metrics = await measureRationale(
    "light",
    "expanded-no-record",
  );

  expect(metrics.viewportHeight).toBe(
    ISLAND_RATIONALE_COMPACT_SIZE.height,
  );
  expect(metrics.bodyScrollHeight).toBeLessThanOrEqual(
    metrics.bodyClientHeight,
  );
  expect(metrics.actionsBottom).toBeLessThanOrEqual(
    metrics.viewportHeight - 12,
  );
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
npm test -- apps/desktop/test/rationale-layout.test.ts
```

Expected: FAIL，因为布局测量器拒绝 `expanded-no-record`。

- [ ] **Step 3: 扩展只读布局测量器**

在 `check-rationale-layout.cjs`：

1. 接受 `"no-record"` 和 `"expanded-no-record"`；
2. 对 `"expanded-no-record"` 先点击 `.context-toggle`；
3. 对两种 no-record 交互点击 `.record-toggle input`；
4. no-record 状态不再要求 textarea 存在，并返回 `textareaBottom: null`；
5. 保留 `actionsBottom`、body scroll/client height 和 viewport 指标。

- [ ] **Step 4: 运行定向测试确认 GREEN**

Run:

```bash
npm test -- apps/desktop/test/rationale-layout.test.ts apps/desktop/test/decision-layout.test.ts apps/desktop/test/window-manager.test.ts apps/desktop/test/liquid-glass.test.ts apps/desktop/test/ipc.test.ts apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx
npm run typecheck
```

Expected: 所有定向测试 PASS，类型检查 exit 0。

- [ ] **Step 5: 提交布局回归测试**

```bash
git add apps/desktop/test/rationale-layout.test.ts scripts/check-rationale-layout.cjs
git commit -m "test: verify compact no-record rationale layout"
```

- [ ] **Step 6: 运行完整发布验证**

Run:

```bash
npm test
npm run typecheck
npm run make
npm run smoke
```

Expected: 全量测试 0 failures，类型检查 exit 0，Forge artifacts 生成，
smoke 输出包含 `"ok":true`。

- [ ] **Step 7: 检查最终状态**

Run:

```bash
git status --short --branch
git log --oneline -8
git diff HEAD^ --check
```

Expected: 工作区干净，`main` 包含三组实现提交，无空白错误。
