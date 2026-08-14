# Decision Interaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the crowded 420×72 choice bar with the approved 560px task-cap island, keep the rationale step in the same visual family, and allow preset reason factors to complete a recorded decision without typed text.

**Architecture:** Put layout eligibility and window-mode selection in a DOM-free shared module used by both React and Electron. Render the island as a narrow task cap plus a full-width decision body, with separate choice and rationale window heights. Keep the existing protocol by generating readable rationale text when factors are selected without typed text, and add an explicit reconsider transition so the rationale screen’s Back action is real.

**Tech Stack:** Electron 43, React 19, TypeScript 7, Vitest 4, Testing Library, CSS.

---

### Task 1: Add a real rationale-to-choice transition

**Files:**
- Modify: `packages/core/src/decision-machine.ts`
- Modify: `packages/core/src/decision-queue.ts`
- Modify: `packages/core/test/decision-machine.test.ts`
- Modify: `packages/core/test/decision-queue.test.ts`
- Modify: `apps/desktop/src/shared/renderer-api.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/test/ipc.test.ts`

- [ ] **Step 1: Write failing state-machine and IPC tests**

Add this state-machine assertion:

```ts
it("returns a rationale decision to choice without changing its ID", () => {
  const queued = createDecisionState(requestFixture(), () => "decision-1");
  const presented = transitionDecision(queued, { type: "present" });
  const chosen = transitionDecision(presented, {
    type: "choose",
    choice: { kind: "preset", optionId: "a", record: true },
  });

  expect(transitionDecision(chosen, { type: "reconsider" })).toEqual({
    status: "awaiting_choice",
    request: chosen.request,
    decisionId: "decision-1",
  });
});
```

Add a queue test that calls `queue.reconsiderChoice()` after a recorded choice and
expects `awaiting_choice`. Add an IPC test that invokes `IPC_CHANNELS.reconsider`
with the current decision ID and expects the queue to return to choice.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
npx vitest run packages/core/test/decision-machine.test.ts packages/core/test/decision-queue.test.ts apps/desktop/test/ipc.test.ts
```

Expected: FAIL because the `reconsider` event, queue method, IPC channel, and API
method do not exist.

- [ ] **Step 3: Implement the transition and desktop bridge**

Add the event and transition:

```ts
export type DecisionEvent =
  | { type: "present" }
  | { type: "choose"; choice: DecisionChoice }
  | { type: "reconsider" }
  | {
      type: "capture_rationale";
      rationale: string;
      reasonFactors?: string[];
    }
  | { type: "defer_rationale" }
  | { type: "skip_rationale" }
  | { type: "cancel" };

if (
  state.status === "awaiting_rationale" &&
  event.type === "reconsider"
) {
  return {
    status: "awaiting_choice",
    request: state.request,
    decisionId: state.decisionId,
  };
}
```

Add the queue method:

```ts
reconsiderChoice(): void {
  const current = this.#requireCurrent();
  current.state = transitionDecision(current.state, { type: "reconsider" });
  this.#publish();
}
```

Add `reconsider: "decision:reconsider-choice"` to `IPC_CHANNELS`,
`reconsiderChoice(input: { decisionId: string }): Promise<void>` to
`DecisionApi`, expose it in preload, validate the decision ID in the main
IPC handler, and call `queue.reconsiderChoice()`.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run:

```bash
npx vitest run packages/core/test/decision-machine.test.ts packages/core/test/decision-queue.test.ts apps/desktop/test/ipc.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the transition**

```bash
git add packages/core/src/decision-machine.ts packages/core/src/decision-queue.ts packages/core/test/decision-machine.test.ts packages/core/test/decision-queue.test.ts apps/desktop/src/shared/renderer-api.ts apps/desktop/src/preload/index.ts apps/desktop/src/main/ipc.ts apps/desktop/test/ipc.test.ts
git commit -m "feat: allow reconsidering a decision choice"
```

### Task 2: Share island eligibility and size selection

**Files:**
- Create: `apps/desktop/src/shared/decision-layout.ts`
- Create: `apps/desktop/test/decision-layout.test.ts`
- Modify: `apps/desktop/src/main/window-manager.ts`
- Modify: `apps/desktop/test/window-manager.test.ts`
- Modify: `apps/desktop/src/renderer/App.tsx`

- [ ] **Step 1: Write failing shared-layout tests**

Create:

```ts
import { describe, expect, it } from "vitest";
import {
  decisionWindowMode,
  usesDecision,
} from "../src/shared/decision-layout.js";
import { serverRequestFixture } from "./fixtures.js";

const choice = (overrides = {}) => ({
  status: "awaiting_choice" as const,
  request: serverRequestFixture(overrides),
  decisionId: "decision-1",
});

describe("decision layout", () => {
  it("uses the island for two readable options", () => {
    expect(usesDecision(choice())).toBe(true);
    expect(decisionWindowMode(choice())).toBe("island-choice");
  });

  it("keeps the rationale for the same request in the island family", () => {
    const current = {
      ...choice(),
      status: "awaiting_rationale" as const,
      choice: { kind: "preset" as const, optionId: "http", record: true as const },
    };
    expect(decisionWindowMode(current)).toBe("island-rationale");
  });

  it.each([
    [{ options: [...serverRequestFixture().options, {
      id: "pipe",
      label: "Named Pipe",
      description: "Windows native transport",
      tradeoffs: [],
    }] }],
    [{ question: "很长的问题".repeat(10) }],
    [{ options: serverRequestFixture().options.map((option) => ({
      ...option,
      label: "超过十八个字符的真实中文选项标签文本",
    })) }],
    [{ contextSummary: "长上下文".repeat(100) }],
  ])("uses the panel when island content is not readable", (overrides) => {
    expect(usesDecision(choice(overrides))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
npx vitest run apps/desktop/test/decision-layout.test.ts apps/desktop/test/window-manager.test.ts
```

Expected: FAIL because `decision-layout.ts`, the new modes, and sizes do not exist.

- [ ] **Step 3: Implement the shared policy and centered resizing**

Create the shared module:

```ts
import type { DecisionState } from "@cognelis/decision-core";

export const ISLAND_CHOICE_SIZE = { width: 560, height: 286 } as const;
export const ISLAND_RATIONALE_SIZE = { width: 560, height: 372 } as const;
export const PANEL_SIZE = { width: 560, height: 640 } as const;
export const SETTINGS_SIZE = { width: 680, height: 430 } as const;

export type DecisionWindowMode =
  | "island-choice"
  | "island-rationale"
  | "panel"
  | "settings";

const characters = (value: string): number => Array.from(value).length;

export const usesDecision = (
  current: DecisionState | null,
): boolean => {
  if (
    current === null ||
    (current.status !== "awaiting_choice" &&
      current.status !== "awaiting_rationale")
  ) {
    return false;
  }
  return (
    current.request.options.length === 2 &&
    characters(current.request.question) <= 36 &&
    current.request.options.every(
      (option) => characters(option.label) <= 18,
    ) &&
    characters(current.request.contextSummary) <= 180
  );
};

export const decisionWindowMode = (
  current: DecisionState | null,
): Exclude<DecisionWindowMode, "settings"> => {
  if (!usesDecision(current)) {
    return "panel";
  }
  return current?.status === "awaiting_rationale"
    ? "island-rationale"
    : "island-choice";
};
```

Make `WindowManager` import these constants and functions. When resizing, compute
the old horizontal center, place the new bounds around that center, and clamp the
result to the nearest display work area with 12px side padding:

```ts
const center = {
  x: current.x + current.width / 2,
  y: current.y + current.height / 2,
};
const { workArea } = this.#options.screen.getDisplayNearestPoint(center);
const unclampedX = Math.round(center.x - desired.width / 2);
const x = Math.min(
  workArea.x + workArea.width - desired.width - 12,
  Math.max(workArea.x + 12, unclampedX),
);
```

Use the shared function from both `WindowManager.publish()` and `App`.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run:

```bash
npx vitest run apps/desktop/test/decision-layout.test.ts apps/desktop/test/window-manager.test.ts
```

Expected: PASS, including 560×286 choice size, 560×372 rationale size, and
center-preserving bounds.

- [ ] **Step 5: Commit the shared layout**

```bash
git add apps/desktop/src/shared/decision-layout.ts apps/desktop/test/decision-layout.test.ts apps/desktop/src/main/window-manager.ts apps/desktop/test/window-manager.test.ts apps/desktop/src/renderer/App.tsx
git commit -m "refactor: share decision island layout policy"
```

### Task 3: Build the approved task-cap choice island

**Files:**
- Create: `apps/desktop/src/renderer/components/DecisionHeader.tsx`
- Modify: `apps/desktop/src/renderer/components/ChoiceStep.tsx`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/styles.css`
- Modify: `apps/desktop/test/App.test.tsx`
- Modify: `apps/desktop/test/accessibility.test.tsx`
- Modify: `apps/desktop/src/renderer/preview-api.ts`

- [ ] **Step 1: Write failing choice-island tests**

Update the compact App test to assert:

```ts
expect(await screen.findByText("Codex · decision")).toBeVisible();
expect(screen.getByText("选择")).toBeVisible();
expect(screen.getByRole("button", { name: "A Loopback HTTP，推荐" })).toBeVisible();
expect(screen.getByRole("button", { name: "B Unix Socket" })).toBeVisible();
expect(screen.getByRole("button", { name: "C 其它方式" })).toBeVisible();
expect(screen.getByRole("checkbox", {
  name: "不记录此次决策",
})).not.toHaveAttribute("role", "switch");
```

Add an assertion that the choice button uses the `island-option` class and the
shell uses `island island-choice`.

- [ ] **Step 2: Run the App and accessibility tests and verify they fail**

Run:

```bash
npx vitest run apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx
```

Expected: FAIL because the task cap, A/B/C option rows, and island classes do not
exist.

- [ ] **Step 3: Implement the header, vertical choices, and CSS**

Create a shared header component that renders a status dot, readable
`source · project`, and queue count in the 360×44 cap for island layouts; retain
the existing badge header for expanded panels.

In `ChoiceStep`, render island choices as:

```tsx
<div className="island-option-list" aria-label="可选方案">
  {request.options.map((option, index) => {
    const recommended = option.id === request.recommendedOptionId;
    const key = String.fromCharCode(65 + index);
    return (
      <button
        className={`choice-button island-option${
          recommended ? " recommended" : ""
        }`}
        disabled={busy}
        key={option.id}
        aria-label={`${key} ${option.label}${recommended ? "，推荐" : ""}`}
        onClick={() => void onChoose({
          kind: "preset",
          optionId: option.id,
          record: !doNotRecord,
        })}
      >
        <span className="option-key">{key}</span>
        <span className="option-label">{option.label}</span>
        <span className="option-meta">{recommended ? "推荐" : ""}</span>
      </button>
    );
  })}
</div>
```

Append the custom row as C with the same 50px height. Put the native no-record
checkbox in a non-floating footer. Style the root as transparent, the cap at
360×44, the body at 560px with a 22px radius, and every `.island-option` with
`min-height: 50px`.

Update every `DecisionApi` fixture and preview implementation with
`reconsiderChoice`.

- [ ] **Step 4: Run the App and accessibility tests and verify they pass**

Run:

```bash
npx vitest run apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit the choice island**

```bash
git add apps/desktop/src/renderer/components/DecisionHeader.tsx apps/desktop/src/renderer/components/ChoiceStep.tsx apps/desktop/src/renderer/App.tsx apps/desktop/src/renderer/styles.css apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx apps/desktop/src/renderer/preview-api.ts
git commit -m "feat: redesign the decision choice island"
```

### Task 4: Unify rationale UI and make preset factors completable

**Files:**
- Modify: `apps/desktop/src/renderer/components/RationaleStep.tsx`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/styles.css`
- Modify: `apps/desktop/test/App.test.tsx`

- [ ] **Step 1: Write failing rationale interaction tests**

Add:

```ts
it("completes with a preset factor when the note is blank", async () => {
  const snapshot = rationaleSnapshot();
  const { api } = apiFixture(snapshot);
  const user = userEvent.setup();
  render(<App api={api} />);

  expect(await screen.findByTestId("decision-shell")).toHaveClass(
    "island",
    "island-rationale",
  );
  const finish = screen.getByRole("button", { name: "完成" });
  expect(finish).toBeDisabled();

  await user.click(screen.getByRole("button", { name: "可维护性" }));
  expect(finish).toBeEnabled();
  await user.click(finish);

  expect(api.submitRationale).toHaveBeenCalledWith({
    decisionId: "decision-1",
    status: "captured",
    rationale: "选择依据：可维护性。",
    reasonFactors: ["maintainability"],
  });
});
```

Add a test that typed text remains byte-for-byte unchanged when factors are also
selected, and a Back test that calls `api.reconsiderChoice`.

- [ ] **Step 2: Run the focused App tests and verify they fail**

Run:

```bash
npx vitest run apps/desktop/test/App.test.tsx
```

Expected: FAIL because factors are checkbox labels, the save button still
requires typed text, and the rationale screen uses the expanded panel.

- [ ] **Step 3: Implement factor resolution and unified rationale layout**

Export a pure resolver:

```ts
export const resolveRationale = (
  rationale: string,
  reasonFactors: string[],
): string => {
  if (rationale.trim().length > 0) {
    return rationale;
  }
  const labels = FACTORS
    .filter(([id]) => reasonFactors.includes(id))
    .map(([, label]) => label);
  return `选择依据：${labels.join("、")}。`;
};
```

Render factors as labeled buttons with `aria-pressed`, label the textarea
“补充说明（可选）”, enable “完成” when either text or factors exist, and submit
`resolveRationale(rationale, reasonFactors)`. Add Back wired to
`onReconsider`, while “稍后补充” and “跳过理由” remain lower-emphasis actions.

Use the same island body and question-row markup as the choice step.

- [ ] **Step 4: Run the focused App tests and verify they pass**

Run:

```bash
npx vitest run apps/desktop/test/App.test.tsx
```

Expected: PASS, including factor-only completion, verbatim typed text, Back,
defer, and skip.

- [ ] **Step 5: Commit the rationale island**

```bash
git add apps/desktop/src/renderer/components/RationaleStep.tsx apps/desktop/src/renderer/App.tsx apps/desktop/src/renderer/styles.css apps/desktop/test/App.test.tsx
git commit -m "feat: unify rationale capture with the decision island"
```

### Task 5: Verify, package, and install

**Files:**
- Modify only if verification exposes a defect in files already listed above.

- [ ] **Step 1: Run formatting-independent checks**

Run:

```bash
git diff --check
npm run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 2: Run the complete automated suite**

Run:

```bash
npm test
```

Expected: all Vitest suites pass.

- [ ] **Step 3: Build the Electron package**

Run:

```bash
npm run build
```

Expected: typecheck, bridge build, and Electron Forge package all exit 0 and
produce the macOS app under `out/`.

- [ ] **Step 4: Install and smoke-test the packaged app**

Run the repository’s existing installation/smoke workflow:

```bash
npm run smoke
```

Expected: the installed app starts, integrations remain connected, and the
choice → rationale → completion flow succeeds.

- [ ] **Step 5: Commit any verification-only fix**

If verification required a scoped correction, stage only the files changed for
that correction and commit:

```bash
git commit -m "fix: finish decision island verification"
```

If no correction was required, do not create an empty commit.
