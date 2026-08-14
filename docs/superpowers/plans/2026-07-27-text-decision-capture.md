# Text Decision Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Passively recognize human decisions requested through ordinary Claude Code and Codex text, preserve bounded related context, route uncertain matches to a local review queue, and keep accepted Obsidian Markdown as the only source of truth.

**Architecture:** The bridge reads only the current bounded turn, analyzes it with a versioned rule classifier, and pairs the result with the next same-session user prompt. High-confidence pairs become normal capture events; medium-confidence pairs become expiring review candidates. The desktop app promotes or ignores review candidates, then reuses the existing rationale and Markdown persistence pipeline.

**Tech Stack:** TypeScript, Zod, Node.js/Electron, React, Vitest, Testing Library, Markdown/YAML, SQLite FTS5.

---

## Scope and file map

The implementation is one release made of nine sequential, independently testable tasks.

### New files

- `apps/bridge/src/text-decision-analyzer.ts`
  - Extract one final decision request block, options and bounded context.
  - Score request and answer signals with `rules-v1`.
- `apps/bridge/test/text-decision-analyzer.test.ts`
  - Labeled Chinese and English rule corpus.
- `packages/storage/src/candidate-spool.ts`
  - Atomic, private, expiring persistence for medium-confidence candidates.
- `packages/storage/test/candidate-spool.test.ts`
  - Capacity, expiry, deduplication, permissions and recovery tests.
- `packages/core/src/candidate-queue.ts`
  - In-memory review queue and promotion/ignore lifecycle.
- `packages/core/test/candidate-queue.test.ts`
  - FIFO state, subscriptions and persistence failure tests.
- `apps/desktop/src/renderer/components/CandidateReview.tsx`
  - Candidate confirmation surface with bounded context preview.
- `apps/desktop/src/renderer/components/DecisionContext.tsx`
  - Shared collapsed/expanded task-background and framing display.

### Modified files

- `packages/protocol/src/capture.ts`
  - Add optional structured context/detection and candidate protocol.
- `packages/protocol/src/index.ts`
  - Export new schemas and types.
- `packages/protocol/test/schemas.test.ts`
  - Validate bounds, strictness and legacy compatibility.
- `packages/core/src/record.ts`
  - Carry structured context/detection into formal records.
- `packages/core/src/index.ts`
  - Export candidate queue and new record types.
- `packages/core/test/record.test.ts`
  - Verify context mapping.
- `packages/storage/src/markdown.ts`
  - Round-trip structured context and detection metadata.
- `packages/storage/src/sqlite-index.ts`
  - Add context to rebuildable FTS content.
- `packages/storage/src/index.ts`
  - Export candidate spool.
- `packages/storage/test/markdown.test.ts`
  - Verify legacy and structured Markdown round trips.
- `packages/storage/test/sqlite-index.test.ts`
  - Verify context search and index rebuild.
- `apps/bridge/src/transcript-tail.ts`
  - Recover a bounded last user/assistant turn for Claude and Codex.
- `apps/bridge/src/text-capture-store.ts`
  - Store a versioned analyzed pending request with 24-hour expiry.
- `apps/bridge/src/text-fallback.ts`
  - Coordinate Stop analysis and next-prompt final scoring.
- `apps/bridge/src/cli.ts`
  - Route high events and medium candidates without changing hook output.
- `apps/bridge/src/runtime-client.ts`
  - Deliver medium candidates without launching the app.
- `apps/bridge/test/transcript-tail.test.ts`
  - Cover both transcript shapes and unrelated-content filtering.
- `apps/bridge/test/text-fallback.test.ts`
  - Cover high, medium, low and unrelated next prompts.
- `apps/bridge/test/hooks-cli.test.ts`
  - Verify fail-open routing and silent medium persistence.
- `apps/bridge/test/runtime-client.test.ts`
  - Verify candidate delivery never launches an offline app.
- `apps/desktop/src/main/local-server.ts`
  - Add authenticated candidate delivery endpoint.
- `apps/desktop/src/main/capture-runtime.ts`
  - Own candidate queue promotion/ignore and spool handoff.
- `apps/desktop/src/main/app-controller.ts`
  - Publish rationale and review-queue state.
- `apps/desktop/src/main/ipc.ts`
  - Validate candidate review commands.
- `apps/desktop/src/main/index.ts`
  - Construct candidate spool/queue and wire menu actions.
- `apps/desktop/src/main/tray.ts`
  - Render live `待确认候选 N` entry.
- `apps/desktop/src/main/window-manager.ts`
  - Show the candidate review panel without affecting compact rationale mode.
- `apps/desktop/src/preload/index.ts`
  - Expose review commands.
- `apps/desktop/src/shared/renderer-api.ts`
  - Add candidate snapshot and IPC contracts.
- `apps/desktop/src/shared/decision-layout.ts`
  - Add review-panel layout.
- `apps/desktop/src/renderer/App.tsx`
  - Select settings, candidate-review or rationale surface.
- `apps/desktop/src/renderer/components/RationaleStep.tsx`
  - Show shared context above rationale controls.
- `apps/desktop/src/renderer/components/SettingsPanel.tsx`
  - Include candidate count and review entry.
- `apps/desktop/src/renderer/styles.css`
  - Style compact context disclosure and review actions.
- `apps/desktop/test/local-server.test.ts`
  - Cover authenticated candidate delivery.
- `apps/desktop/test/capture-runtime.test.ts`
  - Cover candidate promotion and ignore.
- `apps/desktop/test/app-controller.test.ts`
  - Cover combined snapshot publication.
- `apps/desktop/test/ipc.test.ts`
  - Cover candidate command validation.
- `apps/desktop/test/tray.test.ts`
  - Cover live candidate count.
- `apps/desktop/test/window-manager.test.ts`
  - Cover candidate review window state.
- `apps/desktop/test/App.test.tsx`
  - Cover candidate review and context disclosure.
- `README.md`
  - Replace stale compact-size/option statements and document passive text capture.

## Task 1: Extend the protocol without breaking old capture events

**Files:**
- Modify: `packages/protocol/src/capture.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/protocol/test/schemas.test.ts`
- Modify: `apps/bridge/test/fixtures.ts`
- Modify: `apps/desktop/test/fixtures.ts`
- Modify: `packages/core/test/fixtures.ts`
- Modify: `packages/storage/test/fixtures.ts`

- [ ] **Step 1: Write failing schema tests**

Add tests that prove an old event still parses and a contextual text event parses:

```ts
const contextual = capturedDecisionEventSchema.parse({
  ...captureFixture(),
  captureMode: "transcript",
  context: {
    taskBackground: "继续开发 Decision。",
    decisionFraming: "规则方案低延迟，本地模型以后再接入。",
    truncated: false,
  },
  detection: {
    band: "high",
    score: 86,
    detectorVersion: "rules-v1",
    signals: ["has_choice_prompt", "answer_matches_option"],
  },
});

expect(contextual.context?.taskBackground).toBe(
  "继续开发 Decision。",
);
expect(capturedDecisionEventSchema.parse(captureFixture()).context)
  .toBeUndefined();
```

Also reject context over 6,000 combined characters, score outside `0..100`,
unknown signal fields and candidates whose event is not medium confidence.

- [ ] **Step 2: Run the protocol tests and verify RED**

Run:

```bash
npm test -- packages/protocol/test/schemas.test.ts
```

Expected: FAIL because `context`, `detection` and
`capturedDecisionCandidateSchema` are not defined.

- [ ] **Step 3: Add strict schemas and inferred types**

Add:

```ts
export const capturedDecisionContextSchema = z
  .object({
    taskBackground: humanText(4_000).optional(),
    decisionFraming: humanText(4_000).optional(),
    truncated: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const total =
      (value.taskBackground?.length ?? 0) +
      (value.decisionFraming?.length ?? 0);
    if (total > 6_000) {
      context.addIssue({
        code: "custom",
        message: "captured context must not exceed 6000 characters",
      });
    }
  });

export const captureDetectionSchema = z
  .object({
    band: z.enum(["high", "medium"]),
    score: z.number().int().min(0).max(100),
    detectorVersion: humanText(100),
    signals: z.array(humanText(100)).max(32),
  })
  .strict();
```

Make `context` and `detection` optional on `capturedDecisionEventSchema`.
Add a strict `capturedDecisionCandidateSchema` with:

```ts
{
  candidateVersion: 1;
  candidateId: string;
  createdAt: string;
  expiresAt: string;
  event: CapturedDecisionEvent;
}
```

Its `superRefine` requires `event.detection?.band === "medium"`.
Export all inferred types from `packages/protocol/src/index.ts`.

- [ ] **Step 4: Run protocol and workspace tests and verify GREEN**

Run:

```bash
npm test -- packages/protocol/test/schemas.test.ts packages/protocol/test/workspace.test.ts
npm run typecheck
```

Expected: both test files pass and TypeScript exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol apps/bridge/test/fixtures.ts apps/desktop/test/fixtures.ts packages/core/test/fixtures.ts packages/storage/test/fixtures.ts
git commit -m "feat: define contextual text capture protocol"
```

## Task 2: Persist structured context in Markdown and the rebuildable index

**Files:**
- Modify: `packages/core/src/record.ts`
- Modify: `packages/core/test/record.test.ts`
- Modify: `packages/storage/src/markdown.ts`
- Modify: `packages/storage/src/sqlite-index.ts`
- Modify: `packages/storage/test/markdown.test.ts`
- Modify: `packages/storage/test/sqlite-index.test.ts`

- [ ] **Step 1: Write failing record and Markdown round-trip tests**

Create a transcript candidate with context/detection, call
`createDecisionRecord`, serialize it, and assert:

```ts
expect(record.context).toEqual({
  taskBackground: "继续开发 Decision。",
  decisionFraming: "先提高采集质量，再做方法论提炼。",
  truncated: false,
});
expect(record.detection).toMatchObject({
  band: "high",
  detectorVersion: "rules-v1",
});
expect(markdown).toContain("### 任务背景");
expect(markdown).toContain("### 约束与考虑");
expect(markdown).toContain('capture_detector: "rules-v1"');
expect(parseDecision(markdown).context).toEqual(record.context);
```

Keep an explicit legacy test whose `## 当时上下文` contains plain text and
assert it still populates `contextSummary`.

- [ ] **Step 2: Write a failing SQLite context-search test**

Save a note where the unique term `旁路轮次识别` appears only in
`decisionFraming`, rebuild the index, and assert:

```ts
expect(index.search("旁路轮次识别")).toMatchObject([
  { id: note.record.id },
]);
```

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
npm test -- packages/core/test/record.test.ts packages/storage/test/markdown.test.ts packages/storage/test/sqlite-index.test.ts
```

Expected: FAIL because structured context and context FTS fields do not exist.

- [ ] **Step 4: Map context and detection into `DecisionRecord`**

Add:

```ts
context: CapturedDecisionContext | null;
detection: CaptureDetection | null;
```

Keep `contextSummary` for old notes. In `createDecisionRecord` copy optional
event values:

```ts
context: candidate.event.context
  ? { ...candidate.event.context }
  : null,
detection: candidate.event.detection
  ? {
      ...candidate.event.detection,
      signals: [...candidate.event.detection.signals],
    }
  : null,
```

- [ ] **Step 5: Serialize and parse structured Markdown**

Render the existing `## 当时上下文` heading with optional
`### 任务背景` and `### 约束与考虑` subsections. If no structured context is
present, preserve the current plain `contextSummary` behavior.

Add nullable frontmatter keys:

```yaml
capture_confidence: "high"
capture_score: 86
capture_detector: "rules-v1"
```

Do not put signal arrays in the human-readable body. Parse new subsections
without consuming `## 后续结果`; parse legacy plain text unchanged.

- [ ] **Step 6: Add context to FTS while keeping SQLite disposable**

Add nullable `context` to `IndexedDecision` and `DecisionRow`. Add a
`context TEXT` column to `decisions` through the existing migration helper.
Add `context` to the FTS5 table for new databases.

Because an existing FTS5 table cannot gain a column, detect its schema with
`PRAGMA table_info(decisions_fts)`. If `context` is absent, drop and recreate
only `decisions_fts`, then repopulate it from the authoritative `decisions`
rows. The normal startup `rebuildIndex()` will then repopulate everything from
Markdown.

- [ ] **Step 7: Run focused tests and typecheck and verify GREEN**

Run:

```bash
npm test -- packages/core/test/record.test.ts packages/storage/test/markdown.test.ts packages/storage/test/sqlite-index.test.ts packages/storage/test/decision-store.test.ts
npm run typecheck
```

Expected: all focused tests pass and TypeScript exits 0.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/record.ts packages/core/test/record.test.ts packages/storage/src/markdown.ts packages/storage/src/sqlite-index.ts packages/storage/test/markdown.test.ts packages/storage/test/sqlite-index.test.ts
git commit -m "feat: persist captured decision context"
```

## Task 3: Read a bounded turn and classify textual decision requests

**Files:**
- Create: `apps/bridge/src/text-decision-analyzer.ts`
- Create: `apps/bridge/test/text-decision-analyzer.test.ts`
- Modify: `apps/bridge/src/transcript-tail.ts`
- Modify: `apps/bridge/test/transcript-tail.test.ts`
- Modify: `apps/bridge/src/direct-question.ts`
- Modify: `apps/bridge/test/direct-question.test.ts`

- [ ] **Step 1: Write failing turn-reader tests**

Add Claude and Codex JSONL fixtures where the last visible user message and
assistant message are separated by tool records. Assert:

```ts
expect(await readLastDecisionTurn(path)).toEqual({
  userText: "继续开发 Decision，优先提高采集质量。",
  assistantText:
    "规则方案延迟低，本地模型召回更高。\n\n建议先规则后模型，你希望这样安排吗",
});
```

Also assert:

- only the final complete pair is returned;
- code/tool payload text is not treated as user background;
- the reader never reads more than the configured 64 KiB tail;
- malformed lines return `null` or are skipped without exposing contents.

- [ ] **Step 2: Write the labeled analyzer corpus**

Use table-driven cases:

```ts
{
  name: "captures a no-question-mark choice",
  input: {
    userText: "继续开发",
    assistantText: [
      "SQLite 规则识别更轻，本地模型召回更高。",
      "",
      "1. 先规则后模型",
      "2. 直接本地模型",
      "",
      "请选择一种方式",
    ].join("\n"),
  },
  expectedBandBeforeAnswer: "high",
  expectedQuestion: "请选择一种方式",
  expectedOptions: ["先规则后模型", "直接本地模型"],
}
```

Include at least these hard negatives:

- `测试是否通过：否` status text;
- a rhetorical `为什么这样做？因为……`;
- a question only inside fenced code or quote;
- `请提供 API key` information collection;
- assistant announces a choice and continues implementation.

Include medium examples such as one implicit recommendation followed by a
pause, and low examples with no response request or alternatives.

Label every case with `humanDecision: boolean` and `expectedBand`. Aggregate
the corpus and assert:

```ts
expect(highPrecision(results)).toBeGreaterThanOrEqual(0.95);
expect(highAndMediumRecall(results)).toBeGreaterThanOrEqual(0.9);
```

Add one assistant turn containing two numbered subquestions and assert the
analyzer returns one combined request rather than two answer targets.

- [ ] **Step 3: Run analyzer and reader tests and verify RED**

Run:

```bash
npm test -- apps/bridge/test/text-decision-analyzer.test.ts apps/bridge/test/transcript-tail.test.ts
```

Expected: FAIL because `readLastDecisionTurn` and
`TextDecisionAnalyzer` do not exist.

- [ ] **Step 4: Implement `readLastDecisionTurn`**

Reuse `readTailLines`. Normalize only visible `user` and `assistant` messages
from supported Claude/Codex shapes:

```ts
export interface DecisionTurnExcerpt {
  userText: string | null;
  assistantText: string;
}
```

Cap each visible message at 8,000 characters and return only the most recent
assistant message plus the nearest preceding user message. Do not return
transcript paths, system messages, reasoning, tool calls or tool output.

- [ ] **Step 5: Implement deterministic request-block extraction**

`TextDecisionAnalyzer.analyze(turn)` must:

1. strip fenced code, log-like blocks and quote-only paragraphs;
2. inspect the final 8,000 assistant characters;
3. locate the final solicitation paragraph;
4. attach the nearest preceding numbered/bulleted option block;
5. extract at most eight options;
6. capture task background and pre-question framing;
7. trim combined context to 6,000 characters at paragraph boundaries.

Return:

```ts
interface PendingDecisionAnalysis {
  question: string;
  options: CapturedOption[];
  context?: CapturedDecisionContext;
  preScore: number;
  signals: string[];
  detectorVersion: "rules-v1";
}
```

- [ ] **Step 6: Implement versioned scoring**

Use named weights, not inline magic numbers:

```ts
const WEIGHTS = {
  explicitChoicePrompt: 35,
  multipleOptions: 25,
  decisionVocabulary: 10,
  finalWaitingPosition: 10,
  rhetoricalOrExplanatory: -45,
  codeLogOrQuote: -60,
  assistantAlreadyContinues: -35,
  informationRequestOnly: -30,
} as const;
```

Clamp to `0..100`. Before an answer, report only the numeric score and signals.
`complete(analysis, prompt)` adds answer signals:

```ts
const ANSWER_WEIGHTS = {
  optionIdOrLabel: 25,
  yesNoOrOrdinal: 15,
  lexicalRelation: 10,
  unrelatedNewTask: -100,
} as const;
```

Final band is high for `>= 75`, medium for `50..74`, otherwise low. Hard
guards override numeric score.

- [ ] **Step 7: Add the bounded-input performance assertion**

Analyze a representative 64 KiB input 200 times, sort the recorded durations,
and assert:

```ts
const p95 = durations[Math.floor(durations.length * 0.95)] ?? Infinity;
expect(p95).toBeLessThanOrEqual(150);
```

The analyzer must use no network, child process or unbounded history access.

- [ ] **Step 8: Keep `extractDirectQuestion` as a compatibility wrapper**

Delegate the old function to the analyzer with `userText: null` and return
only `analysis.question`. Preserve its public signature so existing imports
and tests do not break during the migration.

- [ ] **Step 9: Run the bridge analyzer suite and verify GREEN**

Run:

```bash
npm test -- apps/bridge/test/text-decision-analyzer.test.ts apps/bridge/test/transcript-tail.test.ts apps/bridge/test/direct-question.test.ts
npm run typecheck
```

Expected: all focused tests pass and TypeScript exits 0.

- [ ] **Step 10: Commit**

```bash
git add apps/bridge/src/text-decision-analyzer.ts apps/bridge/src/transcript-tail.ts apps/bridge/src/direct-question.ts apps/bridge/test/text-decision-analyzer.test.ts apps/bridge/test/transcript-tail.test.ts apps/bridge/test/direct-question.test.ts
git commit -m "feat: score textual decision requests"
```

## Task 4: Pair the next answer and route high, medium and low results

**Files:**
- Modify: `apps/bridge/src/text-capture-store.ts`
- Modify: `apps/bridge/src/text-fallback.ts`
- Modify: `apps/bridge/src/cli.ts`
- Modify: `apps/bridge/test/text-fallback.test.ts`
- Modify: `apps/bridge/test/hooks-cli.test.ts`
- Create: `packages/storage/src/candidate-spool.ts`
- Create: `packages/storage/test/candidate-spool.test.ts`
- Modify: `packages/storage/src/index.ts`

- [ ] **Step 1: Write failing pending-store tests**

Extend the pending shape to version 2:

```ts
{
  version: 2,
  sourceClient: "codex",
  sessionId: "session-1",
  turnId: "turn-question",
  cwd: "/tmp/project",
  analysis: {
    question: "先做方案 1 还是方案 3",
    options: [],
    context: { taskBackground: "继续开发" },
    preScore: 60,
    signals: ["has_choice_prompt"],
    detectorVersion: "rules-v1",
  },
  capturedAt: "2026-07-27T00:00:00.000Z",
}
```

Assert `consume` discards items older than 24 hours, keeps same-session
isolation, atomically replaces older requests and reads legacy version 1
questions as a conservative analysis.

- [ ] **Step 2: Write failing fallback routing tests**

Cover:

```ts
expect(high).toMatchObject({
  kind: "capture",
  event: {
    context: { taskBackground: "继续开发" },
    detection: { band: "high", detectorVersion: "rules-v1" },
  },
});

expect(medium).toMatchObject({
  kind: "candidate",
  candidate: {
    event: { detection: { band: "medium" } },
  },
});

expect(await fallback.onUserPrompt(unrelated, "codex")).toBeNull();
```

Also verify `先 1 后 3`, `可以`, `不要` and `按你的建议` are preserved as
the complete custom answer.

- [ ] **Step 3: Write failing candidate-spool tests**

Use a temp directory and assert:

- duplicate `candidateId` creates one item;
- `list()` sorts oldest first and removes expired items;
- only 100 non-expired items remain, dropping the oldest overflow;
- `acknowledge()` writes a content-free receipt before removing the body;
- replay after acknowledgement is ignored;
- directory mode is `0700`, body and receipt files are `0600`;
- corrupt files are quarantined without leaking their content in errors.

The public API is:

```ts
class CandidateSpool {
  append(candidate: CapturedDecisionCandidate): Promise<void>;
  list(): Promise<CapturedDecisionCandidate[]>;
  acknowledge(candidateId: string): Promise<void>;
  isAcknowledged(candidateId: string): Promise<boolean>;
}
```

- [ ] **Step 4: Run the focused tests and verify RED**

Run:

```bash
npm test -- apps/bridge/test/text-fallback.test.ts apps/bridge/test/hooks-cli.test.ts packages/storage/test/candidate-spool.test.ts
```

Expected: FAIL because pending v2, discriminated routing and
`CandidateSpool` do not exist.

- [ ] **Step 5: Upgrade `TextCaptureStore`**

Inject `now` into the store. Validate both v1 and v2 on read, normalize v1 to
v2, and delete expired/corrupt files. Keep hashed filenames, atomic rename,
directory mode `0700` and file mode `0600`.

- [ ] **Step 6: Change fallback output to a discriminated result**

Define:

```ts
export type TextCaptureResult =
  | { kind: "capture"; event: CapturedDecisionEvent }
  | { kind: "candidate"; candidate: CapturedDecisionCandidate };
```

`onStop` still returns native structured events unchanged, but saves analyzer
output instead of a bare question. `onUserPrompt` consumes exactly one pending
item, final-scores it, returns `null` for low/unrelated, and otherwise creates
one contextual transcript event.

The candidate ID is a SHA-256 fingerprint of client, session, question and
answer. `expiresAt` is exactly seven days after `createdAt`.

- [ ] **Step 7: Implement atomic bounded candidate persistence**

Follow `CaptureSpool` conventions, but use separate `items`, `receipts` and
`quarantine` directories. Hash all filenames. Never store question/project
text in a filename or receipt. Prune on append and list.

- [ ] **Step 8: Route results in the CLI without affecting stdout**

Extend CLI dependencies with:

```ts
interface CandidateSpoolLike {
  append(candidate: CapturedDecisionCandidate): Promise<void>;
}
```

For `capture`, keep existing `persistAndDeliver`. For `candidate`, append to
the default `CandidateSpool`. Runtime notification is added in Task 5; at this
checkpoint durable local persistence is already complete. Catch every error
and return exit code 0 without printing.

- [ ] **Step 9: Run bridge/storage tests and verify GREEN**

Run:

```bash
npm test -- apps/bridge/test/text-fallback.test.ts apps/bridge/test/hooks-cli.test.ts apps/bridge/test/install-cli.test.ts packages/storage/test/candidate-spool.test.ts
npm run typecheck
```

Expected: all focused tests pass and TypeScript exits 0.

- [ ] **Step 10: Commit**

```bash
git add apps/bridge/src/text-capture-store.ts apps/bridge/src/text-fallback.ts apps/bridge/src/cli.ts apps/bridge/test/text-fallback.test.ts apps/bridge/test/hooks-cli.test.ts packages/storage/src/candidate-spool.ts packages/storage/src/index.ts packages/storage/test/candidate-spool.test.ts
git commit -m "feat: route scored text decisions"
```

## Task 5: Add no-launch candidate transport

**Files:**
- Modify: `apps/bridge/src/runtime-client.ts`
- Modify: `apps/bridge/src/cli.ts`
- Modify: `apps/bridge/test/runtime-client.test.ts`
- Modify: `apps/desktop/src/main/local-server.ts`
- Modify: `apps/desktop/test/local-server.test.ts`

- [ ] **Step 1: Write failing no-launch transport tests**

Assert:

```ts
await client.deliverCandidate(candidate);
expect(launch).not.toHaveBeenCalled();
```

for missing runtime, failed fetch and non-2xx responses. Add a server test for
authenticated `POST /v1/candidates`, schema rejection and body limits.

- [ ] **Step 2: Run transport tests and verify RED**

Run:

```bash
npm test -- apps/bridge/test/runtime-client.test.ts apps/desktop/test/local-server.test.ts
```

Expected: FAIL because candidate transport and its server route do not exist.

- [ ] **Step 3: Add candidate transport**

Add `RuntimeClient.deliverCandidate(candidate)` that returns `boolean`, reads
the current runtime descriptor, posts to `/v1/candidates`, and never calls the
launch function. Extend `LocalCaptureServerOptions` with `ingestCandidate`.

- [ ] **Step 4: Notify a running app after durable spooling**

After `CandidateSpool.append` succeeds, the CLI calls
`RuntimeClient.deliverCandidate`. Delivery failure is ignored because the
spool remains durable. Unlike normal high-confidence delivery, this method
must not launch the app.

- [ ] **Step 5: Run transport tests and verify GREEN**

Run:

```bash
npm test -- apps/bridge/test/runtime-client.test.ts apps/desktop/test/local-server.test.ts apps/bridge/test/hooks-cli.test.ts
npm run typecheck
```

Expected: all focused tests pass and TypeScript exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/bridge/src/runtime-client.ts apps/bridge/src/cli.ts apps/bridge/test/runtime-client.test.ts apps/bridge/test/hooks-cli.test.ts apps/desktop/src/main/local-server.ts apps/desktop/test/local-server.test.ts
git commit -m "feat: spool uncertain decision candidates"
```

## Task 6: Add candidate review state and durable promotion

**Files:**
- Create: `packages/core/src/candidate-queue.ts`
- Create: `packages/core/test/candidate-queue.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `apps/desktop/src/main/capture-runtime.ts`
- Modify: `apps/desktop/test/capture-runtime.test.ts`
- Modify: `apps/desktop/test/recovery.integration.test.ts`

- [ ] **Step 1: Write failing candidate queue tests**

The queue snapshot is:

```ts
interface CandidateQueueSnapshot {
  current: CapturedDecisionCandidate | null;
  count: number;
  persistenceStatus?: "saving" | "failed";
}
```

Test oldest-first order, duplicate IDs, subscriptions, ignore, promote,
persistence failure and retry. Closing UI is not a queue mutation.

- [ ] **Step 2: Run core queue tests and verify RED**

Run:

```bash
npm test -- packages/core/test/candidate-queue.test.ts
```

Expected: FAIL because `DecisionCandidateQueue` does not exist.

- [ ] **Step 3: Implement the queue**

Use constructor callbacks:

```ts
interface CandidateQueueOptions {
  onPromote(candidate: CapturedDecisionCandidate): Promise<void>;
  onIgnore(candidate: CapturedDecisionCandidate): Promise<void>;
}
```

Do not remove the current candidate until its callback succeeds. Publish
`saving` then the next item; on failure publish `failed` and allow retry.

- [ ] **Step 4: Write failing runtime promotion tests**

Assert promotion order:

1. append the candidate event to the normal capture spool;
2. ingest it into the existing rationale queue;
3. acknowledge the candidate body;
4. expose the rationale candidate with context intact.

Assert ignore only acknowledges the candidate and never writes Markdown,
SQLite or normal capture spool.

- [ ] **Step 5: Integrate candidate queue into `CaptureRuntime`**

Extend runtime options with candidate spool and a capture-spool `append`.
Expose:

```ts
readonly candidates: DecisionCandidateQueue;
ingestCandidate(candidate: CapturedDecisionCandidate): Promise<void>;
resumeCandidates(candidates: CapturedDecisionCandidate[]): void;
confirmCurrentCandidate(): Promise<void>;
ignoreCurrentCandidate(): Promise<void>;
retryCurrentCandidate(): Promise<void>;
```

Promotion preserves detection band `medium`; it does not pretend the detector
was high confidence.

- [ ] **Step 6: Run core/runtime/recovery tests and verify GREEN**

Run:

```bash
npm test -- packages/core/test/candidate-queue.test.ts apps/desktop/test/capture-runtime.test.ts apps/desktop/test/recovery.integration.test.ts
npm run typecheck
```

Expected: all focused tests pass and TypeScript exits 0.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/candidate-queue.ts packages/core/src/index.ts packages/core/test/candidate-queue.test.ts apps/desktop/src/main/capture-runtime.ts apps/desktop/test/capture-runtime.test.ts apps/desktop/test/recovery.integration.test.ts
git commit -m "feat: review uncertain decision candidates"
```

## Task 7: Wire desktop snapshots, IPC, window mode and live tray count

**Files:**
- Modify: `apps/desktop/src/shared/renderer-api.ts`
- Modify: `apps/desktop/src/shared/decision-layout.ts`
- Modify: `apps/desktop/src/main/app-controller.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/main/window-manager.ts`
- Modify: `apps/desktop/src/main/tray.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/test/app-controller.test.ts`
- Modify: `apps/desktop/test/ipc.test.ts`
- Modify: `apps/desktop/test/window-manager.test.ts`
- Modify: `apps/desktop/test/tray.test.ts`

- [ ] **Step 1: Write failing snapshot/controller tests**

Extend `AppSnapshot`:

```ts
candidateReviewOpen: boolean;
decisionCandidates: {
  current: CapturedDecisionCandidate | null;
  count: number;
  persistenceStatus?: "saving" | "failed";
};
```

Assert controller subscribes to both queues, opening candidate review does not
consume an item, closing hides only that surface, and rationale presentation
takes precedence immediately after promotion.

- [ ] **Step 2: Write failing IPC and preload tests**

Add channels and API methods:

```ts
openCandidateReview(): Promise<void>;
closeCandidateReview(): Promise<void>;
confirmCandidate(candidateId: string): Promise<void>;
ignoreCandidate(candidateId: string): Promise<void>;
retryCandidate(candidateId: string): Promise<void>;
```

Require the ID to match the current candidate. Reject unknown fields and IDs
over 200 characters.

- [ ] **Step 3: Write failing tray and window tests**

Assert the menu contains `待确认候选 3`, clicking it opens review, zero count
still renders `待确认候选 0`, and settings/quit remain present.

Add `candidate-review` to `DecisionWindowMode` with `PANEL_SIZE`. Assert:

- review uses the 12 px safety margin;
- compact rationale still uses `workArea.y`;
- review stays visible while `candidateReviewOpen` and a candidate exists;
- no candidate closes the review surface.

- [ ] **Step 4: Run desktop main-process tests and verify RED**

Run:

```bash
npm test -- apps/desktop/test/app-controller.test.ts apps/desktop/test/ipc.test.ts apps/desktop/test/window-manager.test.ts apps/desktop/test/tray.test.ts
```

Expected: FAIL because candidate snapshot, channels and window mode are absent.

- [ ] **Step 5: Implement shared API and controller subscriptions**

Subscribe to both `RationaleQueue` and `DecisionCandidateQueue`. Centralize
snapshot publishing so any candidate ingest, promotion or ignore refreshes the
window and tray.

- [ ] **Step 6: Implement IPC and preload commands**

Validate IDs with Zod. `confirmCandidate` and `ignoreCandidate` call runtime
operations, then close review. Promotion allows the rationale queue update to
show its normal island.

- [ ] **Step 7: Implement live tray menu**

Refactor tray rendering into a small controller:

```ts
interface TrayMenuState {
  candidateCount: number;
}

update(state: TrayMenuState): void;
```

Each update rebuilds the native context menu with:

1. `待确认候选 N`;
2. `设置`;
3. separator;
4. `退出 Decision`.

- [ ] **Step 8: Wire bootstrap and recovery**

Add `candidateSpool` path beside `capture-spool`, load/prune candidates before
controller start, and wire server candidate delivery to
`runtime.ingestCandidate`. Ensure medium candidates received while the app is
running update snapshots without launching another process.

- [ ] **Step 9: Run desktop main tests and typecheck and verify GREEN**

Run:

```bash
npm test -- apps/desktop/test/app-controller.test.ts apps/desktop/test/ipc.test.ts apps/desktop/test/window-manager.test.ts apps/desktop/test/tray.test.ts apps/desktop/test/local-server.test.ts
npm run typecheck
```

Expected: all focused tests pass and TypeScript exits 0.

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src/shared apps/desktop/src/main apps/desktop/src/preload apps/desktop/test/app-controller.test.ts apps/desktop/test/ipc.test.ts apps/desktop/test/window-manager.test.ts apps/desktop/test/tray.test.ts apps/desktop/test/local-server.test.ts
git commit -m "feat: expose candidate review controls"
```

## Task 8: Build the candidate review and shared context UI

**Files:**
- Create: `apps/desktop/src/renderer/components/CandidateReview.tsx`
- Create: `apps/desktop/src/renderer/components/DecisionContext.tsx`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/components/RationaleStep.tsx`
- Modify: `apps/desktop/src/renderer/components/SettingsPanel.tsx`
- Modify: `apps/desktop/src/renderer/styles.css`
- Modify: `apps/desktop/test/App.test.tsx`
- Modify: `apps/desktop/test/accessibility.test.tsx`
- Modify: `apps/desktop/test/settings-layout.test.ts`

- [ ] **Step 1: Write failing candidate-review UI tests**

Render a medium candidate and assert:

```ts
expect(screen.getByRole("heading", {
  name: "这是一个需要记录的决策吗？",
})).toBeVisible();
expect(screen.getByText("先规则后模型")).toBeVisible();
expect(screen.getByText("继续开发 Decision。")).toBeVisible();
```

Click `是，记录并补充理由` and expect `confirmCandidate(candidateId)`.
Click `不是，忽略` and expect `ignoreCandidate(candidateId)`. Closing review
must call only `closeCandidateReview`.

- [ ] **Step 2: Write failing context-disclosure tests**

For both review and rationale views, assert:

- two-line preview is visible by default;
- `展开上下文` reveals `任务背景` and `约束与考虑`;
- `收起上下文` collapses it;
- missing context renders no empty disclosure;
- truncated context shows `上下文已截断`;
- buttons have no decorative prefix icons.

- [ ] **Step 3: Run renderer tests and verify RED**

Run:

```bash
npm test -- apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx apps/desktop/test/settings-layout.test.ts
```

Expected: FAIL because candidate review and context disclosure do not exist.

- [ ] **Step 4: Implement `DecisionContext`**

Render only user-visible captured excerpts:

```tsx
<section className="decision-context">
  <button aria-expanded={expanded} onClick={toggle}>
    {expanded ? "收起上下文" : "展开上下文"}
  </button>
  {expanded ? (
    <div className="decision-context-body">
      {context.taskBackground ? (
        <section>
          <h3>任务背景</h3>
          <p>{context.taskBackground}</p>
        </section>
      ) : null}
      {context.decisionFraming ? (
        <section>
          <h3>约束与考虑</h3>
          <p>{context.decisionFraming}</p>
        </section>
      ) : null}
    </div>
  ) : null}
</section>
```

The collapsed preview uses CSS line clamp, not destructive text slicing.

- [ ] **Step 5: Implement `CandidateReview` and App routing**

Order App surfaces:

1. settings;
2. candidate review when explicitly open and current candidate exists;
3. rationale/persistence;
4. idle.

The candidate review shows source/project, question, captured answer, options,
context, count, confirm and ignore. Escape/close retains the candidate.

- [ ] **Step 6: Add context to rationale and settings entry**

Place `DecisionContext` after the captured answer and before the rationale
factors. In settings summary add the candidate count and a `查看候选` button;
do not build a history browser.

- [ ] **Step 7: Add compact visual styles**

Use the existing glass tokens. The collapsed context is two lines. Expanded
context has a maximum height and scroll. Buttons remain text-only. Preserve
the required checkbox for `不记录此次决策`.

- [ ] **Step 8: Run renderer tests and verify GREEN**

Run:

```bash
npm test -- apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx apps/desktop/test/settings-layout.test.ts apps/desktop/test/decision-layout.test.ts
npm run typecheck
```

Expected: all focused tests pass and TypeScript exits 0.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/renderer apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx apps/desktop/test/settings-layout.test.ts apps/desktop/test/decision-layout.test.ts
git commit -m "feat: review contextual decision candidates"
```

## Task 9: End-to-end verification, documentation and installed-app replacement

**Files:**
- Modify: `README.md`
- Modify: `scripts/smoke.mjs`
- Modify: `apps/desktop/test/decision-flow.integration.test.ts`
- Modify: `apps/desktop/test/recovery.integration.test.ts`

- [ ] **Step 1: Write end-to-end regression coverage**

Add one high path and one medium path:

```ts
// High: Stop -> next prompt -> capture spool -> rationale -> Markdown.
expect(savedMarkdown).toContain("### 任务背景");
expect(savedMarkdown).toContain("先 1 后 3");

// Medium: Stop -> next prompt -> candidate spool -> confirm ->
// capture spool -> rationale -> Markdown.
expect(await candidateSpool.list()).toHaveLength(0);
expect(savedMarkdown).toContain('capture_confidence: "medium"');
```

Also verify ignore produces neither Markdown nor SQLite rows and restart
restores unhandled candidates.

- [ ] **Step 2: Run integration tests and verify GREEN**

Run:

```bash
npm test -- apps/desktop/test/decision-flow.integration.test.ts apps/desktop/test/recovery.integration.test.ts
```

Expected: both integration files pass. A failure identifies a concrete wiring
defect that must be fixed in the owning module and covered by its focused test
before rerunning this step.

- [ ] **Step 3: Replace stale README statements**

Document:

- hooks are passive and never replace native tools;
- ordinary text decisions are scored locally;
- medium matches wait for confirmation;
- related context is bounded and stored in Markdown;
- SQLite remains disposable;
- current island dimensions reflect the actual implementation;
- current compact mode is not described as a fixed two-to-four-option chooser.

- [ ] **Step 4: Extend smoke coverage**

In smoke mode inject a contextual transcript event, complete its rationale,
and assert the generated Markdown contains task background and framing.
Keep the existing settings screenshot/package smoke behavior.

- [ ] **Step 5: Run the complete verification suite**

Run:

```bash
npm test
npm run typecheck
npm run build:bridge
npm run smoke
```

Expected:

- every Vitest file and test passes;
- TypeScript exits 0;
- bridge bundle builds;
- Electron smoke exits 0 and reports the generated Markdown.

- [ ] **Step 6: Run a packaged build**

Run:

```bash
npm run make
```

Expected: Electron Forge exits 0 and creates a macOS artifact under `out/`.

- [ ] **Step 7: Commit final integration and docs**

```bash
git add README.md scripts/smoke.mjs apps/desktop/test/decision-flow.integration.test.ts apps/desktop/test/recovery.integration.test.ts
git commit -m "docs: explain passive contextual capture"
```

- [ ] **Step 8: Replace the installed app and reinstall integrations**

Quit the running app, replace `/Applications/Decision.app` with the
newly packaged `.app` at the same path, then run the installed bridge:

```bash
"/Applications/Decision.app/Contents/Resources/bridge/decision-bridge" install --apply
```

Do not retain a second “old” or “new” app beside it.

- [ ] **Step 9: Verify the installed result**

Launch the installed app and run:

```bash
"/Applications/Decision.app/Contents/Resources/bridge/decision-bridge" doctor
```

Expected: `appStatus` is `healthy`. Then manually exercise:

1. a no-question-mark textual choice and a short answer;
2. a medium candidate opened from `待确认候选 N`;
3. candidate confirmation followed by `稍后处理`;
4. the resulting Obsidian note contains bounded context;
5. native Claude Code/Codex questions still behave unchanged.

- [ ] **Step 10: Final repository verification**

Run:

```bash
git status --short
git log --oneline --decorate -12
```

Expected: working tree is clean and the feature is represented by small,
ordered commits.
