# Continuous Todo Review and Glass Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a continuous “待处理” review session, redesign the review panel around captured source context, and make transparent frosted glass visibly consistent across every theme and window mode.

**Architecture:** Keep candidate persistence and FIFO ownership in `DecisionCandidateQueue`, but let promoted candidates enter `RationaleQueue` at the active review position so their rationale appears immediately. `AppController` owns only ephemeral review-session progress and resume state. Renderer components consume that snapshot, while one shared CSS material token system drives the settings panel, ordinary panels, rationale island, and review panel.

**Tech Stack:** TypeScript 7, Electron 43, React 19, Vitest 4, Testing Library, CSS custom properties, macOS vibrancy.

---

## File map

- `packages/core/src/rationale-queue.ts`
  - Add a prioritized ingest entry point that can temporarily preempt an awaiting rationale without losing FIFO state.
- `packages/core/test/rationale-queue.test.ts`
  - Prove the promoted rationale becomes current and the preempted rationale resumes afterward.
- `apps/desktop/src/main/capture-runtime.ts`
  - Route reviewed candidate promotion through prioritized ingest.
- `apps/desktop/test/capture-runtime.test.ts`
  - Prove reviewed promotion takes focus without dropping an existing rationale.
- `apps/desktop/src/main/app-controller.ts`
  - Own review-session progress, suspension for one promoted rationale, automatic resume, and action methods.
- `apps/desktop/src/main/index.ts`
  - Delegate confirm/ignore operations to the controller instead of closing the surface.
- `apps/desktop/src/shared/renderer-api.ts`
  - Expose nullable `candidateReviewProgress`.
- `apps/desktop/test/app-controller.test.ts`
  - Cover ignore advance, confirm/rationale/resume, last-item close, pause, new arrival, and failure.
- `apps/desktop/src/renderer/components/CandidateReview.tsx`
  - Render compact “待处理 X / N” chrome, full decision framing, answer, task context, and fixed actions.
- `apps/desktop/src/renderer/App.tsx`
  - Pass review progress into `CandidateReview`.
- `apps/desktop/src/renderer/components/SettingsPanel.tsx`
  - Replace candidate terminology with “待处理”.
- `apps/desktop/src/main/tray.ts`
  - Replace the tray entry with `待处理 N`.
- `apps/desktop/src/renderer/preview-api.ts`
  - Add a realistic review preview for visual verification.
- `apps/desktop/src/renderer/styles.css`
  - Rebalance the review layout and define one transparent glass material hierarchy for all themes and surfaces.
- `apps/desktop/test/App.test.tsx`
  - Cover content hierarchy, progress text, renamed actions, and review rendering.
- `apps/desktop/test/accessibility.test.tsx`
  - Verify the new region name and controls remain accessible.
- `apps/desktop/test/tray.test.ts`
  - Verify the new menu copy and count.
- `apps/desktop/test/settings-layout.test.ts`
  - Tighten translucency thresholds and verify the high-alpha highlight no longer masks vibrancy.
- `scripts/check-settings-layout.cjs`
  - Report the extra material token and both backdrop-filter properties.
- `apps/desktop/test/glass-theme.test.ts`
  - Lock the shared glass selector and cross-theme token contract.
- `README.md`
  - Replace current user-facing candidate terminology and document continuous processing/glass behavior.

### Task 1: Prioritize the rationale created by candidate promotion

**Files:**
- Modify: `packages/core/test/rationale-queue.test.ts`
- Modify: `packages/core/src/rationale-queue.ts`
- Modify: `apps/desktop/test/capture-runtime.test.ts`
- Modify: `apps/desktop/src/main/capture-runtime.ts`

- [ ] **Step 1: Write the failing core queue test**

Add this test beside the FIFO test in `packages/core/test/rationale-queue.test.ts`:

```ts
it("temporarily prioritizes a reviewed rationale and then resumes FIFO", async () => {
  let sequence = 0;
  const queue = new RationaleQueue(() => `candidate-${++sequence}`);
  const existing = captureFixture({
    sourceEventId: "existing",
    toolUseId: "existing",
    batchId: "existing",
  });
  const reviewed = captureFixture({
    sourceEventId: "reviewed",
    toolUseId: "reviewed",
    batchId: "reviewed",
  });

  queue.ingest(existing);
  queue.ingestPrioritized(reviewed);

  expect(queue.snapshot()).toMatchObject({
    current: {
      candidateId: "candidate-2",
      event: { sourceEventId: "reviewed" },
    },
    waitingCount: 1,
  });

  await queue.submit({ status: "skipped" });

  expect(queue.snapshot()).toMatchObject({
    current: {
      candidateId: "candidate-1",
      event: { sourceEventId: "existing" },
    },
    waitingCount: 0,
  });
});
```

- [ ] **Step 2: Run the core test and verify RED**

Run:

```bash
npm test -- packages/core/test/rationale-queue.test.ts
```

Expected: FAIL because `RationaleQueue.ingestPrioritized` does not exist.

- [ ] **Step 3: Implement prioritized ingest**

Refactor `packages/core/src/rationale-queue.ts` so the public methods delegate to one internal ingest path:

```ts
type IngestPlacement = "fifo" | "priority";

ingest(input: CapturedDecisionEvent): CaptureReceipt {
  return this.#ingestDetailed(input, "fifo").receipt;
}

ingestDetailed(
  input: CapturedDecisionEvent,
): RationaleIngestResult {
  return this.#ingestDetailed(input, "fifo");
}

ingestPrioritized(
  input: CapturedDecisionEvent,
): CaptureReceipt {
  return this.ingestPrioritizedDetailed(input).receipt;
}

ingestPrioritizedDetailed(
  input: CapturedDecisionEvent,
): RationaleIngestResult {
  return this.#ingestDetailed(input, "priority");
}

#ingestDetailed(
  input: CapturedDecisionEvent,
  placement: IngestPlacement,
): RationaleIngestResult {
```

Immediately after the existing `crossModeDuplicates` declaration, add:

```ts
const acceptedCandidates: RationaleCandidate[] = [];
```

Replace the single existing enqueue statement:

```ts
this.#waiting.push(candidate);
```

with:

```ts
acceptedCandidates.push(candidate);
```

Immediately before the existing `this.#advance()` call, add:

```ts
if (placement === "priority" && acceptedCandidates.length > 0) {
  if (this.#current?.status === "awaiting_rationale") {
    this.#waiting.unshift(this.#current);
    this.#current = null;
  }
  this.#waiting.unshift(...acceptedCandidates);
} else {
  this.#waiting.push(...acceptedCandidates);
}
```

Do not preempt a `completed` current item; prioritized candidates remain at the front of `#waiting` until its persistence finishes.

- [ ] **Step 4: Run the core test and verify GREEN**

Run:

```bash
npm test -- packages/core/test/rationale-queue.test.ts
```

Expected: all `RationaleQueue` tests PASS.

- [ ] **Step 5: Write the failing runtime integration test**

Add to `apps/desktop/test/capture-runtime.test.ts`:

```ts
it("prioritizes a promoted review without losing the existing rationale", async () => {
  const { runtime } = createRuntime();
  const existing = serverCaptureFixture({
    sourceEventId: "existing",
    toolUseId: "existing",
    batchId: "existing",
  });
  const reviewed = serverCandidateFixture();

  await runtime.ingest(existing);
  await runtime.ingestCandidate(reviewed);
  await runtime.confirmCurrentCandidate();

  expect(runtime.queue.snapshot()).toMatchObject({
    current: {
      event: {
        sourceEventId: reviewed.event.sourceEventId,
      },
    },
    waitingCount: 1,
  });

  await runtime.queue.submit({ status: "skipped" });

  expect(runtime.queue.snapshot()).toMatchObject({
    current: {
      event: { sourceEventId: "existing" },
    },
    waitingCount: 0,
  });
});
```

- [ ] **Step 6: Run the runtime test and verify RED**

Run:

```bash
npm test -- apps/desktop/test/capture-runtime.test.ts
```

Expected: FAIL because candidate promotion still appends behind the existing rationale.

- [ ] **Step 7: Route promotion through the priority entry point**

Change the candidate `onPromote` callback in `apps/desktop/src/main/capture-runtime.ts` while preserving spool ordering:

```ts
onPromote: async (candidate) => {
  if (
    this.#spool.append === undefined ||
    this.#candidateSpool === undefined
  ) {
    throw new Error(
      "Decision candidate promotion storage is unavailable",
    );
  }
  await this.#spool.append(candidate.event);
  await this.ingest(candidate.event, "priority");
  await this.#candidateSpool.acknowledge(candidate.candidateId);
},
```

Add an optional placement parameter to the existing public method:

```ts
async ingest(
  event: CapturedDecisionEvent,
  placement: "fifo" | "priority" = "fifo",
): Promise<CaptureReceipt> {
}
```

Replace the existing `const result = this.queue.ingestDetailed(...)` statement with:

```ts
const pendingEvent = {
  ...event,
  questions: pendingQuestions,
};
const result =
  placement === "priority"
    ? this.queue.ingestPrioritizedDetailed(pendingEvent)
    : this.queue.ingestDetailed(pendingEvent);
```

Both paths retain the same structured/transcript cross-mode duplicate bookkeeping.

- [ ] **Step 8: Run focused runtime and core tests**

Run:

```bash
npm test -- packages/core/test/rationale-queue.test.ts apps/desktop/test/capture-runtime.test.ts
```

Expected: both test files PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/rationale-queue.ts packages/core/test/rationale-queue.test.ts apps/desktop/src/main/capture-runtime.ts apps/desktop/test/capture-runtime.test.ts
git commit -m "feat: prioritize reviewed rationales"
```

### Task 2: Keep and resume a continuous review session

**Files:**
- Modify: `apps/desktop/src/shared/renderer-api.ts`
- Modify: `apps/desktop/src/main/app-controller.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/test/app-controller.test.ts`
- Modify: `apps/desktop/test/window-manager.test.ts`
- Modify: `apps/desktop/test/App.test.tsx`
- Modify: `apps/desktop/test/accessibility.test.tsx`
- Modify: `apps/desktop/src/renderer/preview-api.ts`

- [ ] **Step 1: Add failing controller tests for continuous ignore and progress**

Add this helper near the top of `apps/desktop/test/app-controller.test.ts`:

```ts
interface ControllerFixtureOptions {
  onIgnore?(
    candidate: ReturnType<typeof serverCandidateFixture>,
  ): Promise<void>;
}

const createController = async (
  options: ControllerFixtureOptions = {},
) => {
  let sequence = 0;
  const queue = new RationaleQueue(
    () => `rationale-${++sequence}`,
  );
  const candidates = new DecisionCandidateQueue({
    onPromote: async (candidate) => {
      queue.ingestPrioritized(candidate.event);
    },
    onIgnore:
      options.onIgnore ?? (async () => undefined),
  });
  const publish = vi.fn();
  const controller = new AppController({
    queue,
    candidates,
    server: {
      start: vi.fn(async () => ({
        host: "127.0.0.1",
        port: 45_678,
      })),
      stop: vi.fn(async () => undefined),
    },
    watcher: {
      start: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    },
    index: { close: vi.fn() },
    windows: {
      create: vi.fn(async () => undefined),
      publish,
      prepareToQuit: vi.fn(),
    },
    runtimeFile: "/runtime.json",
    token: "x".repeat(32),
    writeRuntime: vi.fn(async () => undefined),
    removeRuntime: vi.fn(async () => undefined),
  });
  await controller.start();
  return { candidates, controller, publish, queue };
};
```

Refactor the existing candidate controller test to use this helper, then add:

```ts
it("advances ignored candidates without closing the review session", async () => {
  const { candidates, controller } = await createController();
  const first = serverCandidateFixture();
  const second = {
    ...serverCandidateFixture(),
    candidateId: "candidate-server-2",
    createdAt: "2026-07-27T00:01:00.000Z",
  };
  candidates.ingest(first);
  candidates.ingest(second);
  controller.openCandidateReview();

  await controller.ignoreCandidate(first.candidateId);

  expect(controller.snapshot()).toMatchObject({
    candidateReviewOpen: true,
    candidateReviewProgress: { position: 2, total: 2 },
    decisionCandidates: {
      current: { candidateId: "candidate-server-2" },
      count: 1,
    },
  });
});
```

- [ ] **Step 2: Add failing tests for rationale suspension and resume**

Add:

```ts
it("resumes the next review after the promoted rationale is disposed", async () => {
  const { candidates, controller, queue } =
    await createController();
  const first = serverCandidateFixture();
  const second = {
    ...serverCandidateFixture(),
    candidateId: "candidate-server-2",
    createdAt: "2026-07-27T00:01:00.000Z",
  };
  candidates.ingest(first);
  candidates.ingest(second);
  controller.openCandidateReview();

  await controller.confirmCandidate(first.candidateId);

  expect(controller.snapshot()).toMatchObject({
    candidateReviewOpen: false,
    current: { event: { sourceEventId: first.event.sourceEventId } },
  });

  await queue.submit({ status: "deferred" });

  expect(controller.snapshot()).toMatchObject({
    candidateReviewOpen: true,
    candidateReviewProgress: { position: 2, total: 2 },
    decisionCandidates: {
      current: { candidateId: "candidate-server-2" },
    },
  });
});
```

Add separate tests proving:

```ts
it("closes after the last ignored candidate", async () => {
  const { candidates, controller } = await createController();
  const only = serverCandidateFixture();
  candidates.ingest(only);
  controller.openCandidateReview();

  await controller.ignoreCandidate(only.candidateId);

  expect(controller.snapshot().candidateReviewOpen).toBe(false);
  expect(controller.snapshot().candidateReviewProgress).toBeNull();
});

it("keeps the session alive through the last promoted rationale so new arrivals can join", async () => {
  const { candidates, controller, queue } =
    await createController();
  const first = serverCandidateFixture();
  const late = {
    ...serverCandidateFixture(),
    candidateId: "candidate-server-late",
    createdAt: "2026-07-27T00:02:00.000Z",
  };
  candidates.ingest(first);
  controller.openCandidateReview();

  await controller.confirmCandidate(first.candidateId);
  candidates.ingest(late);
  await queue.submit({ status: "skipped" });

  expect(controller.snapshot()).toMatchObject({
    candidateReviewOpen: true,
    candidateReviewProgress: { position: 2, total: 2 },
    decisionCandidates: {
      current: { candidateId: "candidate-server-late" },
    },
  });
});

it("closes after the last promoted rationale is disposed", async () => {
  const { candidates, controller, queue } =
    await createController();
  const only = serverCandidateFixture();
  candidates.ingest(only);
  controller.openCandidateReview();

  await controller.confirmCandidate(only.candidateId);
  await queue.submit({ status: "skipped" });

  expect(controller.snapshot().candidateReviewOpen).toBe(false);
  expect(controller.snapshot().candidateReviewProgress).toBeNull();
});

it("keeps the current review open when persistence fails", async () => {
  const { candidates, controller } = await createController({
    onIgnore: async () => {
      throw new Error("candidate receipt failed");
    },
  });
  const candidate = serverCandidateFixture();
  candidates.ingest(candidate);
  controller.openCandidateReview();

  await expect(
    controller.ignoreCandidate(candidate.candidateId),
  ).rejects.toThrow(/Candidate persistence/u);

  expect(controller.snapshot()).toMatchObject({
    candidateReviewOpen: true,
    candidateReviewProgress: { position: 1, total: 1 },
    decisionCandidates: {
      current: { candidateId: candidate.candidateId },
      persistenceStatus: "failed",
    },
  });
});
```

- [ ] **Step 3: Run controller tests and verify RED**

Run:

```bash
npm test -- apps/desktop/test/app-controller.test.ts
```

Expected: FAIL because controller action methods and `candidateReviewProgress` do not exist and current actions close externally.

- [ ] **Step 4: Add the renderer snapshot contract**

In `apps/desktop/src/shared/renderer-api.ts` add:

```ts
export interface CandidateReviewProgress {
  position: number;
  total: number;
}
```

Insert this field after `candidateReviewOpen` in `AppSnapshot`:

```ts
candidateReviewProgress: CandidateReviewProgress | null;
```

Add `candidateReviewProgress: null` to non-review fixtures in:

- `apps/desktop/test/App.test.tsx`
- `apps/desktop/test/accessibility.test.tsx`
- `apps/desktop/test/window-manager.test.ts`
- `apps/desktop/src/renderer/preview-api.ts`

- [ ] **Step 5: Implement the review-session state machine in `AppController`**

Add fields:

```ts
#candidateReviewOpen = false;
#candidateReviewSessionActive = false;
#candidateReviewRationaleId: string | null = null;
#candidateReviewProcessed = 0;
#candidateReviewTotal = 0;
```

Update `openCandidateReview()`:

```ts
openCandidateReview(): void {
  const candidates = this.#candidateSnapshot();
  if (candidates.current === null) {
    return;
  }
  this.#candidateReviewSessionActive = true;
  this.#candidateReviewOpen = true;
  this.#candidateReviewRationaleId = null;
  this.#candidateReviewProcessed = 0;
  this.#candidateReviewTotal = candidates.count;
  this.#settingsOpen = false;
  this.#publish();
}
```

Update pause/settings paths to call a private reset:

```ts
#resetCandidateReview(): void {
  this.#candidateReviewSessionActive = false;
  this.#candidateReviewOpen = false;
  this.#candidateReviewRationaleId = null;
  this.#candidateReviewProcessed = 0;
  this.#candidateReviewTotal = 0;
}
```

Add action methods:

```ts
async ignoreCandidate(candidateId: string): Promise<void> {
  const candidates = this.#requireCandidates();
  await candidates.ignore(candidateId);
  this.#candidateReviewProcessed += 1;
  if (candidates.snapshot().current === null) {
    this.#resetCandidateReview();
  }
  this.#publish();
}

async confirmCandidate(candidateId: string): Promise<void> {
  const candidates = this.#requireCandidates();
  await candidates.promote(candidateId);
  this.#candidateReviewProcessed += 1;
  this.#candidateReviewOpen = false;
  this.#candidateReviewRationaleId =
    this.#options.queue.snapshot().current?.candidateId ?? null;
  if (this.#candidateReviewRationaleId === null) {
    this.#resetCandidateReview();
  }
  this.#publish();
}
```

In the rationale subscription, resume exactly when the tracked candidate leaves current:

```ts
this.#options.queue.subscribe((snapshot) => {
  if (
    this.#candidateReviewSessionActive &&
    this.#candidateReviewRationaleId !== null &&
    snapshot.current?.candidateId !==
      this.#candidateReviewRationaleId
  ) {
    this.#candidateReviewRationaleId = null;
    if (this.#candidateSnapshot().current === null) {
      this.#resetCandidateReview();
    } else {
      this.#candidateReviewOpen = true;
    }
  }
  this.#publish();
});
```

In the candidate subscription, grow the session total without closing a rationale-backed session:

```ts
if (this.#candidateReviewSessionActive) {
  this.#candidateReviewTotal = Math.max(
    this.#candidateReviewTotal,
    this.#candidateReviewProcessed + snapshot.count,
  );
}
if (
  snapshot.current === null &&
  this.#candidateReviewRationaleId === null
) {
  this.#resetCandidateReview();
}
```

Expose progress only while the session is active:

```ts
candidateReviewProgress: this.#candidateReviewSessionActive
  ? {
      position: Math.min(
        this.#candidateReviewProcessed + 1,
        this.#candidateReviewTotal,
      ),
      total: this.#candidateReviewTotal,
    }
  : null,
```

Add:

```ts
#requireCandidates(): DecisionCandidateQueue {
  const candidates = this.#options.candidates;
  if (candidates === undefined) {
    throw new Error("Decision candidate queue is unavailable");
  }
  return candidates;
}
```

- [ ] **Step 6: Delegate main-process operations to the controller**

Replace the confirm/ignore operations in `apps/desktop/src/main/index.ts`:

```ts
confirmCandidate: (candidateId) =>
  controller.confirmCandidate(candidateId),
ignoreCandidate: (candidateId) =>
  controller.ignoreCandidate(candidateId),
```

Remove both unconditional `controller.closeCandidateReview()` calls.

- [ ] **Step 7: Run controller tests and verify GREEN**

Run:

```bash
npm test -- apps/desktop/test/app-controller.test.ts
```

Expected: all controller tests PASS.

- [ ] **Step 8: Run snapshot consumers and typecheck**

Run:

```bash
npm test -- apps/desktop/test/window-manager.test.ts apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx
npm run typecheck
```

Expected: focused tests and TypeScript PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/shared/renderer-api.ts apps/desktop/src/main/app-controller.ts apps/desktop/src/main/index.ts apps/desktop/test/app-controller.test.ts apps/desktop/test/window-manager.test.ts apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx apps/desktop/src/renderer/preview-api.ts
git commit -m "feat: keep candidate review sessions open"
```

### Task 3: Replace terminology and redesign the review content hierarchy

**Files:**
- Modify: `apps/desktop/test/App.test.tsx`
- Modify: `apps/desktop/test/accessibility.test.tsx`
- Modify: `apps/desktop/test/tray.test.ts`
- Modify: `apps/desktop/src/renderer/components/CandidateReview.tsx`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/components/SettingsPanel.tsx`
- Modify: `apps/desktop/src/main/tray.ts`
- Modify: `apps/desktop/src/renderer/styles.css`
- Modify: `apps/desktop/src/renderer/preview-api.ts`

- [ ] **Step 1: Write failing renderer tests for content priority**

Replace the old large-title assertion in `apps/desktop/test/App.test.tsx` with:

```ts
expect(
  await screen.findByRole("region", { name: "待处理决策" }),
).toBeVisible();
expect(screen.getByText("待处理 1 / 2")).toBeVisible();
expect(
  screen.queryByRole("heading", {
    name: "这是一个需要记录的决策吗？",
  }),
).toBeNull();
expect(screen.queryByText("本地识别 · 尚未写入 Obsidian")).toBeNull();
expect(screen.getByRole("heading", { name: "原文" })).toBeVisible();
expect(screen.getByText("先规则后模型")).toBeVisible();
expect(screen.getByText("继续开发 Decision。")).toBeVisible();
expect(screen.getByText("Loopback HTTP")).toBeVisible();
```

Update the review snapshot with:

```ts
candidateReviewProgress: { position: 1, total: 2 },
```

Change action assertions to:

```ts
screen.getByRole("button", { name: "稍后" });
screen.getByRole("button", { name: "忽略" });
screen.getByRole("button", { name: "记录并补充理由" });
```

- [ ] **Step 2: Write failing copy/accessibility tests**

In `apps/desktop/test/tray.test.ts` expect:

```ts
expect(menu.template[0]?.label).toBe("待处理 3");
```

In `apps/desktop/test/accessibility.test.tsx` query:

```ts
expect(
  await screen.findByRole("region", { name: "待处理决策" }),
).toBeVisible();
```

Add a source scan test in `apps/desktop/test/App.test.tsx` or a dedicated copy test:

```ts
expect(document.body).not.toHaveTextContent("待确认候选");
```

- [ ] **Step 3: Run renderer and tray tests and verify RED**

Run:

```bash
npm test -- apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx apps/desktop/test/tray.test.ts
```

Expected: FAIL on old region name, old menu copy, old heading, and missing progress/original section.

- [ ] **Step 4: Implement the compact review markup**

Change `CandidateReviewProps`:

```ts
interface CandidateReviewProps {
  candidate: CapturedDecisionCandidate;
  position: number;
  total: number;
  busy: boolean;
  persistenceStatus: "saving" | "failed" | undefined;
  error: string | null;
  onClose(): void;
  onConfirm(): Promise<void>;
  onIgnore(): Promise<void>;
  onRetry(): Promise<void>;
}
```

Replace the current content structure in `CandidateReview.tsx` with:

```tsx
<main
  className="app-shell decision-shell expanded candidate-review"
  role="region"
  aria-label="待处理决策"
>
  <header className="candidate-review-toolbar drag-region">
    <div className="origin-line">
      <SourceBadge source={candidate.event.sourceClient} />
      <span className="project-name">{candidate.event.project}</span>
      <span className="waiting-count">
        待处理 {position} / {total}
      </span>
    </div>
    <button
      type="button"
      className="text-button no-drag"
      disabled={saving}
      onClick={onClose}
    >
      稍后
    </button>
  </header>

  <section className="candidate-review-content">
    <section className="candidate-question" aria-labelledby="candidate-question">
      <span>需要判断</span>
      <h1 id="candidate-question">{question.question}</h1>
    </section>

    {candidate.event.context?.decisionFraming === undefined ? null : (
      <section className="candidate-source" aria-labelledby="candidate-source-title">
        <h2 id="candidate-source-title">原文</h2>
        <p>{candidate.event.context.decisionFraming}</p>
      </section>
    )}

    <section className="candidate-answer" aria-label="你的回答">
      <span>你的回答</span>
      <strong>{question.answer.values.join("、")}</strong>
    </section>

    {question.options.length === 0 ? null : (
      <ul className="candidate-options" aria-label="相关选项">
        {question.options.map((option) => (
          <li key={option.id}>
            <strong>{option.label}</strong>
            {option.description === undefined ? null : (
              <span>{option.description}</span>
            )}
          </li>
        ))}
      </ul>
    )}

    <DecisionContext
      context={
        candidate.event.context?.taskBackground === undefined
          ? undefined
          : {
              taskBackground:
                candidate.event.context.taskBackground,
              ...(candidate.event.context.truncated === undefined
                ? {}
                : {
                    truncated:
                      candidate.event.context.truncated,
                  }),
            }
      }
    />
    {persistenceStatus === "failed" ? (
      <div className="candidate-persistence-error" role="alert">
        <p>候选状态暂时无法保存，内容仍保留。</p>
        <button
          type="button"
          className="secondary-button"
          disabled={saving}
          onClick={() => void onRetry()}
        >
          重试
        </button>
      </div>
    ) : null}
    {error === null ? null : (
      <p className="error-message" role="alert">
        {error}
      </p>
    )}
  </section>

  <footer className="candidate-review-actions">
    <button
      type="button"
      className="secondary-button"
      disabled={saving}
      onClick={() => void onIgnore()}
    >
      忽略
    </button>
    <button
      type="button"
      className="primary-button"
      disabled={saving}
      onClick={() => void onConfirm()}
    >
      记录并补充理由
    </button>
  </footer>
</main>
```

Keep the existing Escape listener, saving states, retry behavior, and error roles unchanged.

- [ ] **Step 5: Pass stable progress from `App`**

In `apps/desktop/src/renderer/App.tsx`:

```tsx
const reviewProgress = snapshot.candidateReviewProgress ?? {
  position: 1,
  total: snapshot.decisionCandidates.count,
};

<CandidateReview
  candidate={reviewCandidate}
  position={reviewProgress.position}
  total={reviewProgress.total}
  busy={busy}
  persistenceStatus={
    snapshot.decisionCandidates.persistenceStatus
  }
  error={error}
  onClose={() => {
    void api.closeCandidateReview();
  }}
  onConfirm={() =>
    perform(() =>
      api.confirmCandidate(reviewCandidate.candidateId),
    )
  }
  onIgnore={() =>
    perform(() =>
      api.ignoreCandidate(reviewCandidate.candidateId),
    )
  }
  onRetry={() =>
    perform(() =>
      api.retryCandidate(reviewCandidate.candidateId),
    )
  }
/>
```

- [ ] **Step 6: Replace tray and settings copy**

In `apps/desktop/src/main/tray.ts`:

```ts
label: `待处理 ${options.candidateCount}`,
```

In the settings summary:

```tsx
<span>待处理</span>
<strong>{snapshot.decisionCandidates.count} 项待处理</strong>
<button
  type="button"
  className="text-button"
  disabled={busy || snapshot.decisionCandidates.count === 0}
  onClick={() => void api.openCandidateReview()}
>
  查看
</button>
```

- [ ] **Step 7: Rebalance candidate CSS**

Replace the old candidate review rules with:

```css
.candidate-review-content {
  display: flex;
  min-height: 0;
  flex: 1;
  padding: 18px 22px 16px;
  overflow: auto;
  flex-direction: column;
  gap: 15px;
  user-select: text;
}

.candidate-question {
  flex: none;
}

.candidate-question > span,
.candidate-answer > span {
  color: var(--muted);
  font-size: 10px;
}

.candidate-question h1 {
  margin: 5px 0 0;
  font-size: 18px;
  line-height: 1.38;
  letter-spacing: -0.015em;
}

.candidate-source {
  padding: 14px 0;
  border-block: 1px solid var(--border-muted);
}

.candidate-source h2 {
  margin: 0 0 8px;
  color: var(--text-soft);
  font-size: 11px;
}

.candidate-source p {
  margin: 0;
  color: var(--text-soft);
  line-height: 1.65;
  white-space: pre-wrap;
}

.candidate-answer {
  display: grid;
  gap: 5px;
}

.candidate-answer strong {
  color: var(--accent-ink);
  font-size: 13px;
}

.candidate-options {
  display: flex;
  margin: 0;
  padding: 0;
  flex-wrap: wrap;
  gap: 7px;
  list-style: none;
}

.candidate-options li {
  min-width: 0;
  padding: 7px 9px;
  border: 1px solid var(--border-muted);
  border-radius: 9px;
  background: var(--surface-inset);
}
```

Keep the toolbar at 48px and action bar at 64px. Remove `.candidate-review-copy` and `.candidate-decision-card` rules that no longer have markup.

- [ ] **Step 8: Add a realistic preview state**

In `apps/desktop/src/renderer/preview-api.ts`, add `preview === "candidate"` with:

```ts
const review = {
  candidateVersion: 1 as const,
  candidateId: "preview-review",
  createdAt: "2026-07-28T00:00:00.000Z",
  expiresAt: "2026-08-04T00:00:00.000Z",
  event: {
    ...candidate().event,
    captureMode: "transcript" as const,
    context: {
      taskBackground: "继续开发 Decision 的本地语义采集。",
      decisionFraming:
        "这是既有代码，不是本次引入。调整会涉及领域类型和 9 个既有测试。两个改动仍在 dev 分支且尚未提交。",
    },
  },
};
return {
  ...common,
  current: null,
  settingsOpen: false,
  candidateReviewOpen: true,
  candidateReviewProgress: { position: 1, total: 4 },
  decisionCandidates: { current: review, count: 4 },
};
```

- [ ] **Step 9: Run renderer tests and verify GREEN**

Run:

```bash
npm test -- apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx apps/desktop/test/tray.test.ts
```

Expected: all focused tests PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx apps/desktop/test/tray.test.ts apps/desktop/src/renderer/components/CandidateReview.tsx apps/desktop/src/renderer/App.tsx apps/desktop/src/renderer/components/SettingsPanel.tsx apps/desktop/src/main/tray.ts apps/desktop/src/renderer/styles.css apps/desktop/src/renderer/preview-api.ts
git commit -m "feat: redesign continuous todo review"
```

### Task 4: Make glass visibly translucent across all themes

**Files:**
- Modify: `apps/desktop/test/settings-layout.test.ts`
- Modify: `scripts/check-settings-layout.cjs`
- Create: `apps/desktop/test/glass-theme.test.ts`
- Modify: `apps/desktop/src/renderer/styles.css`

- [ ] **Step 1: Tighten the failing translucency metrics**

Add `webkitBackdropFilter` to `SettingsMetrics` and add
`windowHighlight` to its nested `tokens` interface:

```ts
webkitBackdropFilter: string;
```

```ts
windowHighlight: string;
```

Replace the translucency cases with:

```ts
it.each([
  {
    theme: "light" as const,
    maximumComposite: 0.42,
    maximumToolbar: 0.14,
    maximumHighlight: 0.4,
  },
  {
    theme: "dark" as const,
    maximumComposite: 0.58,
    maximumToolbar: 0.2,
    maximumHighlight: 0.16,
  },
])(
  "keeps $theme settings visibly translucent over native vibrancy",
  async ({
    theme,
    maximumComposite,
    maximumToolbar,
    maximumHighlight,
  }) => {
    const metrics = await measureSettings(theme);

    expect(metrics.backdropFilter).toContain("blur(38px)");
    expect(metrics.webkitBackdropFilter).toContain("blur(38px)");
    expect(alphaOf(metrics.tokens.toolbar)).toBeLessThanOrEqual(
      maximumToolbar,
    );
    expect(alphaOf(metrics.tokens.windowHighlight)).toBeLessThanOrEqual(
      maximumHighlight,
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

- [ ] **Step 2: Add the failing shared-surface CSS contract**

Create `apps/desktop/test/glass-theme.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const css = await readFile(
  new URL("../src/renderer/styles.css", import.meta.url),
  "utf8",
);

describe("glass theme", () => {
  it("shares one backdrop material between panels and the island", () => {
    expect(css).toMatch(
      /\.app-shell,\s*\.island-body\s*\{[^}]*backdrop-filter:\s*blur\(38px\)\s+saturate\(155%\);/su,
    );
    expect(css).toContain(
      "-webkit-backdrop-filter: blur(38px) saturate(155%);",
    );
  });

  it("defines matching forced light and dark glass tokens", () => {
    expect(css).toContain('html[data-preview-theme="light"]');
    expect(css).toContain('html[data-preview-theme="dark"]');
    expect(css.match(/--window:/gu)).toHaveLength(4);
    expect(css.match(/--toolbar:/gu)).toHaveLength(4);
    expect(css.match(/--surface:/gu)).toHaveLength(4);
    expect(css.match(/--surface-raised:/gu)).toHaveLength(4);
  });
});
```

- [ ] **Step 3: Run the glass tests and verify RED**

Run:

```bash
npm test -- apps/desktop/test/settings-layout.test.ts apps/desktop/test/glass-theme.test.ts
```

Expected: FAIL because current blur is 34px, there is no prefixed filter/shared selector, light highlight alpha is 84%, and composite opacity is too high.

- [ ] **Step 4: Report both filter and highlight metrics**

In `scripts/check-settings-layout.cjs`, extend the resolved object:

```js
const shellStyles = getComputedStyle(shell);
resolve({
  backdropFilter: shellStyles.backdropFilter,
  webkitBackdropFilter: shellStyles.webkitBackdropFilter,
  tokens: {
    surface: rootStyles.getPropertyValue("--surface").trim(),
    toolbar: rootStyles.getPropertyValue("--toolbar").trim(),
    window: rootStyles.getPropertyValue("--window").trim(),
    windowHighlight:
      rootStyles.getPropertyValue("--window-highlight").trim(),
  },
});
```

- [ ] **Step 5: Replace theme material alpha values**

Use these values in `:root` and `html[data-preview-theme="light"]`:

```css
--window: rgb(235 244 243 / 22%);
--window-highlight: rgb(255 255 255 / 34%);
--toolbar: rgb(255 255 255 / 10%);
--surface: rgb(255 255 255 / 18%);
--surface-raised: rgb(255 255 255 / 30%);
--surface-hover: rgb(255 255 255 / 38%);
--surface-inset: rgb(184 200 204 / 14%);
--border: rgb(255 255 255 / 54%);
--border-muted: rgb(44 61 74 / 10%);
--border-strong: rgb(35 53 67 / 17%);
```

Use these values in the dark media block and `html[data-preview-theme="dark"]`:

```css
--window: rgb(9 15 24 / 38%);
--window-highlight: rgb(222 235 248 / 10%);
--toolbar: rgb(24 33 47 / 16%);
--surface: rgb(27 38 53 / 22%);
--surface-raised: rgb(40 53 70 / 32%);
--surface-hover: rgb(48 64 84 / 40%);
--surface-inset: rgb(5 10 18 / 20%);
--border: rgb(214 230 246 / 16%);
--border-muted: rgb(214 230 246 / 9%);
--border-strong: rgb(214 230 246 / 23%);
```

The resulting window/surface composite alphas are about 36% light and 52% dark before the subtle gradients, leaving the native backdrop visibly present.

- [ ] **Step 6: Share one glass backdrop rule**

Move only material properties into a shared selector:

```css
.app-shell,
.island-body {
  background:
    radial-gradient(
      circle at 6% -12%,
      rgb(56 201 157 / 8%),
      transparent 38%
    ),
    linear-gradient(
      135deg,
      var(--window-highlight),
      transparent 42%
    ),
    var(--window);
  box-shadow:
    0 30px 72px var(--shadow),
    0 3px 12px var(--shadow-soft),
    inset 0 1px 0 var(--window-highlight);
  backdrop-filter: blur(38px) saturate(155%);
  -webkit-backdrop-filter: blur(38px) saturate(155%);
}
```

Keep `.app-shell` geometry and `.island-body` geometry in their existing separate rules. Remove the duplicated material declarations from `.island-body`.

- [ ] **Step 7: Keep child surfaces from becoming opaque**

Audit every `background` under settings, candidate review, rationale, inputs, and buttons. Keep all neutral surfaces on `--toolbar`, `--surface`, `--surface-raised`, `--surface-hover`, or `--surface-inset`. Retain accent/error fills, but do not introduce an opaque white, black, or gray background.

The existing hard-coded `rgb(255 255 255 / 7%)` settings-card header may remain because it is below the shared toolbar alpha and does not mask vibrancy.

- [ ] **Step 8: Run glass tests and verify GREEN**

Run:

```bash
npm test -- apps/desktop/test/settings-layout.test.ts apps/desktop/test/glass-theme.test.ts
```

Expected: both light and dark metrics and the shared material contract PASS.

- [ ] **Step 9: Run renderer layout tests**

Run:

```bash
npm test -- apps/desktop/test/App.test.tsx apps/desktop/test/settings-layout.test.ts apps/desktop/test/preview-theme.test.ts apps/desktop/test/glass-theme.test.ts
```

Expected: all focused UI tests PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/test/settings-layout.test.ts apps/desktop/test/glass-theme.test.ts scripts/check-settings-layout.cjs apps/desktop/src/renderer/styles.css
git commit -m "feat: strengthen transparent glass themes"
```

### Task 5: Update current documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/semantic-recognition.md`
- Modify: `docs/superpowers/specs/2026-07-28-continuous-todo-review-design.md`

- [ ] **Step 1: Update current user documentation**

In `README.md` and `docs/semantic-recognition.md`:

- replace current UI references to “待确认候选” with “待处理”;
- explain that one opening handles the queue continuously;
- explain confirm → rationale → next item and ignore → next item;
- keep “candidate spool” and “中置信候选” only where documenting internals;
- document that all window modes use the same translucent glass theme.

Change the design spec status to:

```md
状态：已确认
```

- [ ] **Step 2: Verify no current product copy remains**

Run:

```bash
rg -n "待确认候选" README.md docs/semantic-recognition.md apps/desktop/src apps/desktop/test
```

Expected: no user-facing matches; historical superseded specs and implementation plans may retain the old term.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/semantic-recognition.md docs/superpowers/specs/2026-07-28-continuous-todo-review-design.md
git commit -m "docs: explain continuous todo review"
```

### Task 6: Verify, package, install, and smoke-test the real App

**Files:**
- Verify: all changed source, tests, and docs
- Build output: `out/Decision-darwin-arm64/Decision.app`
- Install target: `/Applications/Decision.app`

- [ ] **Step 1: Check formatting and the exact diff**

Run:

```bash
git diff --check
git status --short
git log --oneline -8
```

Expected: no whitespace errors; only intended files are modified before the final verification commit.

- [ ] **Step 2: Run the full automated test suite**

Run:

```bash
npm test
```

Expected: every Vitest file and test passes with zero failures.

- [ ] **Step 3: Run TypeScript verification**

Run:

```bash
npm run typecheck
```

Expected: exit 0 with no TypeScript errors.

- [ ] **Step 4: Build the packaged macOS App**

Run:

```bash
npm run build
```

Expected: bridge, Foundation Models helper, typecheck, and Electron Forge packaging all exit 0; the `.app` exists under `out/Decision-darwin-arm64/`.

- [ ] **Step 5: Inspect review and glass previews**

Run the renderer preview in Light and Dark for:

```text
?preview=candidate&theme=light
?preview=candidate&theme=dark
?preview=settings&theme=light
?preview=settings&theme=dark
```

Verify:

- `待处理 1 / 4` is visible;
- decision framing receives most of the scrollable body;
- toolbar and actions remain fixed;
- no large explanatory title remains;
- the preview gradient visibly透色 through the blurred shell;
- Light and Dark keep the same geometry and readable controls.

- [ ] **Step 6: Replace the installed App**

Quit the running app, move the existing exact target to a temporary backup, copy the newly packaged app to `/Applications/Decision.app`, and relaunch. Restore the backup if copying or launch health verification fails.

- [ ] **Step 7: Run real desktop smoke checks**

With at least two candidate items:

1. Open `待处理 N` once.
2. Ignore the first item and verify the second appears without closing.
3. Confirm the next item, choose a rationale disposition, and verify the following candidate returns automatically.
4. Press Escape and verify the candidate remains.
5. Switch Auto, Light, and Dark from settings.
6. Move settings, rationale island, and review panel over a wallpaper containing both bright/dark edges and multiple colors.
7. Verify the wallpaper colors remain visibly blurred through every surface and no page becomes an opaque white/black rectangle.

- [ ] **Step 8: Run the repository smoke test**

Run:

```bash
npm run smoke
```

Expected: passive hook capture, Markdown persistence, SQLite indexing, and bridge health all pass.

- [ ] **Step 9: Final completion audit**

Re-read `docs/superpowers/specs/2026-07-28-continuous-todo-review-design.md` section by section and map every requirement to:

- an automated test;
- source evidence;
- preview or installed-App visual evidence.

Do not claim completion while any interaction, terminology, content hierarchy, theme, packaging, installation, or smoke requirement lacks evidence.
