# Passive Structured Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the behavior-changing `ask_decision` path with fail-open `PostToolUse` capture, then collect rationale asynchronously in Decision.

**Architecture:** Claude Code and Codex hook adapters normalize successful native question-tool results into a versioned `CapturedDecisionEvent`. The bridge atomically spools each event, attempts a short authenticated delivery, and exits successfully without writing stdout; the desktop app deduplicates questions, presents a rationale-only FIFO, and converts accepted candidates into Markdown plus a rebuildable SQLite index.

**Tech Stack:** TypeScript 7, Zod 4, Node.js filesystem/HTTP APIs, Electron 43, React 19, node:sqlite, Vitest

---

## File map

- `packages/protocol/src/capture.ts`: versioned normalized capture envelope, question, answer, and receipt schemas.
- `packages/protocol/src/schemas.ts`: runtime descriptor only after legacy ask-decision schemas are removed.
- `packages/core/src/rationale-queue.ts`: rationale-only FIFO, active dedupe, persistence retry, and candidate dispositions.
- `packages/core/src/record.ts`: converts a captured candidate into a durable record.
- `packages/storage/src/capture-spool.ts`: private one-event-per-file spool plus hash-only processed receipts.
- `packages/storage/src/markdown.ts`: serializes new capture provenance and multi-value answers while reading existing notes.
- `packages/storage/src/sqlite-index.ts`: indexes capture provenance and readable answers.
- `apps/bridge/src/hook-adapters.ts`: Claude Code and Codex `PostToolUse` payload adapters.
- `apps/bridge/src/runtime-client.ts`: short `deliver()` path that never waits for a user decision.
- `apps/bridge/src/cli.ts`: passive hook, install, and doctor commands; no MCP server.
- `packages/integrations/src/hooks.ts`: removes owned legacy handlers and installs one passive `PostToolUse` handler per client.
- `packages/integrations/src/claude.ts`: Claude hook merge plus MCP removal command.
- `packages/integrations/src/codex.ts`: Codex hook merge plus MCP removal command.
- `apps/desktop/src/main/capture-runtime.ts`: ingestion, queue disposition, spool acknowledgement, and storage health.
- `apps/desktop/src/main/local-server.ts`: authenticated `POST /v1/captures` returning immediately.
- `apps/desktop/src/main/app-controller.ts`: publishes the rationale queue snapshot.
- `apps/desktop/src/main/index.ts`: composes spool replay, runtime, server, and passive integrations.
- `apps/desktop/src/shared/renderer-api.ts`: rationale-only snapshot and IPC contract.
- `apps/desktop/src/shared/decision-layout.ts`: rationale-only compact eligibility.
- `apps/desktop/src/renderer/App.tsx`: removes the choice step and renders captured question/answer plus rationale.
- `apps/desktop/src/renderer/components/RationaleStep.tsx`: captured/deferred/skipped/not-recorded disposition UI.
- `apps/desktop/src/renderer/components/ChoiceStep.tsx`: delete after choice capture moves back to native clients.
- `scripts/smoke.mjs`: posts a capture and completes its rationale without waiting on an MCP request.

### Task 1: Define the normalized capture protocol

**Files:**
- Create: `packages/protocol/src/capture.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/protocol/src/schemas.ts`
- Modify: `packages/protocol/test/schemas.test.ts`

- [ ] **Step 1: Replace ask-decision schema tests with capture envelope tests**

```ts
import {
  capturedDecisionEventSchema,
  captureReceiptSchema,
  runtimeDescriptorSchema,
} from "../src/index.js";

export const captureFixture = {
  eventVersion: 1,
  captureMode: "structured_tool",
  sourceClient: "codex",
  sessionId: "session-1",
  turnId: "turn-1",
  sourceEventId: "event-1",
  toolUseId: "tool-1",
  batchId: "codex:session-1:tool-1",
  project: "decision",
  cwd: "/Users/demo/decision",
  capturedAt: "2026-07-25T00:00:00.000Z",
  questions: [{
    questionIndex: 0,
    header: "Storage",
    question: "Which storage format?",
    options: [
      { id: "markdown", label: "Markdown", description: "Readable" },
      { id: "sqlite", label: "SQLite", description: "Queryable" },
    ],
    answer: { kind: "preset", values: ["Markdown"] },
    multiSelect: false,
  }],
} as const;

it("accepts a complete structured capture", () => {
  expect(capturedDecisionEventSchema.parse(captureFixture)).toEqual(
    captureFixture,
  );
});

it("accepts a multi-select answer without rewriting values", () => {
  const event = {
    ...captureFixture,
    questions: [{
      ...captureFixture.questions[0],
      multiSelect: true,
      answer: { kind: "multiple", values: ["Risk", "Time"] },
    }],
  };
  expect(capturedDecisionEventSchema.parse(event)).toEqual(event);
});

it("rejects duplicate question indexes", () => {
  expect(() => capturedDecisionEventSchema.parse({
    ...captureFixture,
    questions: [
      captureFixture.questions[0],
      captureFixture.questions[0],
    ],
  })).toThrow(/question indexes/i);
});

it("validates capture receipts", () => {
  expect(captureReceiptSchema.parse({ accepted: 1, duplicates: 0 }))
    .toEqual({ accepted: 1, duplicates: 0 });
});
```

- [ ] **Step 2: Run the protocol test and verify RED**

Run:

```bash
npm test -- packages/protocol/test/schemas.test.ts
```

Expected: FAIL because capture schemas are not exported.

- [ ] **Step 3: Add strict versioned capture schemas**

```ts
// packages/protocol/src/capture.ts
import { z } from "zod";

export const CAPTURE_EVENT_VERSION = 1 as const;
export const captureModeSchema = z.enum(["structured_tool", "transcript"]);
export const sourceClientSchema = z.enum(["claude-code", "codex", "test"]);

const text = (maximum: number) => z.string().trim().min(1).max(maximum);

export const capturedOptionSchema = z.object({
  id: z.string().trim().min(1).max(200).optional(),
  label: text(500),
  description: text(2_000).optional(),
}).strict();

export const capturedAnswerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("preset"),
    values: z.array(text(2_000)).length(1),
  }).strict(),
  z.object({
    kind: z.literal("multiple"),
    values: z.array(text(2_000)).min(1).max(8),
  }).strict(),
  z.object({
    kind: z.literal("custom"),
    values: z.array(text(2_000)).length(1),
  }).strict(),
]);

export const capturedQuestionSchema = z.object({
  questionIndex: z.number().int().min(0).max(7),
  header: text(200).optional(),
  question: text(4_000),
  options: z.array(capturedOptionSchema).max(8),
  answer: capturedAnswerSchema,
  multiSelect: z.boolean(),
}).strict();

export const capturedDecisionEventSchema = z.object({
  eventVersion: z.literal(CAPTURE_EVENT_VERSION),
  captureMode: captureModeSchema,
  sourceClient: sourceClientSchema,
  sessionId: text(500),
  turnId: text(500).optional(),
  sourceEventId: text(500).optional(),
  toolUseId: text(500).optional(),
  batchId: text(1_000),
  project: text(500),
  cwd: text(2_000),
  capturedAt: z.string().datetime(),
  questions: z.array(capturedQuestionSchema).min(1).max(8),
}).strict().superRefine((event, context) => {
  const indexes = event.questions.map((question) => question.questionIndex);
  if (new Set(indexes).size !== indexes.length) {
    context.addIssue({
      code: "custom",
      message: "question indexes must be unique",
      path: ["questions"],
    });
  }
});

export const captureReceiptSchema = z.object({
  accepted: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
}).strict();

export type CapturedDecisionEvent =
  z.infer<typeof capturedDecisionEventSchema>;
export type CapturedQuestion = z.infer<typeof capturedQuestionSchema>;
export type CapturedAnswer = z.infer<typeof capturedAnswerSchema>;
export type CapturedOption = z.infer<typeof capturedOptionSchema>;
export type CaptureMode = z.infer<typeof captureModeSchema>;
export type CaptureReceipt = z.infer<typeof captureReceiptSchema>;
export type SourceClient = z.infer<typeof sourceClientSchema>;
```

Re-export the capture symbols from `index.ts`. Keep the legacy ask-decision
schemas temporarily so the repository remains type-correct while downstream
consumers are migrated; Task 10 removes those exports after the final consumer
has been deleted. Keep `PROTOCOL_VERSION` and `runtimeDescriptorSchema`.

- [ ] **Step 4: Run protocol tests and typecheck**

Run:

```bash
npm test -- packages/protocol/test/schemas.test.ts
npm run typecheck
```

Expected: protocol tests PASS and typecheck PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "refactor: define passive capture protocol"
```

### Task 2: Normalize Claude Code and Codex PostToolUse payloads

**Files:**
- Create: `apps/bridge/src/hook-adapters.ts`
- Create: `apps/bridge/test/hook-adapters.test.ts`
- Modify: `apps/bridge/test/fixtures.ts`

- [ ] **Step 1: Add red adapter tests for single, batch, multi-select, and cancelled results**

```ts
import {
  adaptClaudePostToolUse,
  adaptCodexPostToolUse,
} from "../src/hook-adapters.js";

it("maps every answered Claude question into one normalized batch", () => {
  const event = adaptClaudePostToolUse({
    session_id: "claude-session",
    cwd: "/tmp/project",
    hook_event_name: "PostToolUse",
    tool_name: "AskUserQuestion",
    tool_use_id: "toolu_1",
    tool_input: {
      questions: [{
        header: "Framework",
        question: "Which framework?",
        options: [
          { label: "React", description: "Established" },
          { label: "Vue", description: "Compact" },
        ],
        multiSelect: false,
      }],
    },
    tool_response: { answers: { "Which framework?": "React" } },
  }, () => new Date("2026-07-25T00:00:00.000Z"));

  expect(event).toMatchObject({
    sourceClient: "claude-code",
    toolUseId: "toolu_1",
    questions: [{
      questionIndex: 0,
      question: "Which framework?",
      answer: { kind: "preset", values: ["React"] },
    }],
  });
});

it("maps Codex request_user_input answers by question id", () => {
  expect(adaptCodexPostToolUse({
    session_id: "codex-session",
    turn_id: "turn-1",
    cwd: "/tmp/project",
    hook_event_name: "PostToolUse",
    tool_name: "request_user_input",
    tool_use_id: "call-1",
    tool_input: {
      questions: [{
        id: "framework",
        header: "Framework",
        question: "Which framework?",
        options: [
          { label: "React", description: "Established" },
          { label: "Vue", description: "Compact" },
        ],
      }],
    },
    tool_response: { answers: { framework: { answers: ["Vue"] } } },
  })).toMatchObject({
    sourceClient: "codex",
    questions: [{ answer: { kind: "preset", values: ["Vue"] } }],
  });
});

it("returns null for failed, cancelled, unrelated, or unanswered calls", () => {
  expect(adaptClaudePostToolUse({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
  })).toBeNull();
});
```

- [ ] **Step 2: Run adapter tests and verify RED**

Run:

```bash
npm test -- apps/bridge/test/hook-adapters.test.ts
```

Expected: FAIL because the adapter module does not exist.

- [ ] **Step 3: Implement narrow client adapters**

Create helpers that:

```ts
const answerKind = (
  values: string[],
  labels: Set<string>,
  multiSelect: boolean,
): "preset" | "multiple" | "custom" =>
  multiSelect || values.length > 1
    ? "multiple"
    : labels.has(values[0] as string)
      ? "preset"
      : "custom";
```

Validate only the documented payload branches used by each client. Build
`batchId` as `${sourceClient}:${sessionId}:${toolUseId}`, derive `project` from
`basename(cwd)`, preserve option and answer text, and return `null` when the
tool name, questions, answers, or common identifiers are absent.

- [ ] **Step 4: Run adapter tests**

Run:

```bash
npm test -- apps/bridge/test/hook-adapters.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bridge/src/hook-adapters.ts apps/bridge/test
git commit -m "feat: normalize native question hooks"
```

### Task 3: Add the private capture spool

**Files:**
- Create: `packages/storage/src/capture-spool.ts`
- Create: `packages/storage/test/capture-spool.test.ts`
- Modify: `packages/storage/src/index.ts`
- Modify: `apps/bridge/package.json`

- [ ] **Step 1: Write red spool tests**

```ts
it("atomically stores, lists, acknowledges, and removes capture bodies", async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-spool-"));
  const spool = new CaptureSpool(root);
  const event = captureFixture();

  await spool.append(event);
  await spool.append(event);
  expect(await spool.list()).toEqual([event]);

  await spool.acknowledge(event, 0);
  expect(await spool.list()).toEqual([]);
  expect(await spool.isAcknowledged(event, 0)).toBe(true);
  expect((await stat(join(root, "receipts"))).mode & 0o777).toBe(0o700);
});

it("keeps unacknowledged questions from the same batch", async () => {
  const event = captureFixture({
    questions: [questionFixture(0), questionFixture(1)],
  });
  await spool.append(event);
  await spool.acknowledge(event, 0);
  expect((await spool.list())[0]?.questions.map((q) => q.questionIndex))
    .toEqual([1]);
});
```

- [ ] **Step 2: Run spool tests and verify RED**

Run:

```bash
npm test -- packages/storage/test/capture-spool.test.ts
```

Expected: FAIL because `CaptureSpool` does not exist.

- [ ] **Step 3: Implement one-event-per-file storage with hash-only receipts**

```ts
export class CaptureSpool {
  constructor(readonly path: string) {}

  async append(input: CapturedDecisionEvent): Promise<void> {
    const event = capturedDecisionEventSchema.parse(input);
    const pending = await this.#withoutAcknowledged(event);
    if (pending.questions.length === 0) return;
    await this.#writeAtomically(this.#eventPath(event), pending);
  }

  async list(): Promise<CapturedDecisionEvent[]> {
    await this.#secureDirectories();
    const events: CapturedDecisionEvent[] = [];
    for (const name of await readdir(this.#eventsPath)) {
      if (!name.endsWith(".json")) continue;
      const path = join(this.#eventsPath, name);
      try {
        const parsed = capturedDecisionEventSchema.parse(
          JSON.parse(await readFile(path, "utf8")),
        );
        const pending = await this.#withoutAcknowledged(parsed);
        if (pending.questions.length === 0) {
          await unlink(path).catch(() => undefined);
        } else {
          events.push(pending);
        }
      } catch {
        await rename(path, `${path}.corrupt-${randomUUID()}`);
      }
    }
    return events.sort(
      (left, right) =>
        left.capturedAt.localeCompare(right.capturedAt) ||
        left.batchId.localeCompare(right.batchId),
    );
  }

  async acknowledge(
    event: CapturedDecisionEvent,
    questionIndex: number,
  ): Promise<void> {
    await this.#secureDirectories();
    await writeFile(this.#receiptPath(event, questionIndex), "", {
      mode: 0o600,
      flag: "wx",
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const remaining = await this.#withoutAcknowledged(event);
    if (remaining.questions.length === 0) {
      await unlink(this.#eventPath(event)).catch(() => undefined);
    } else {
      await this.#writeAtomically(this.#eventPath(event), remaining);
    }
  }
}
```

Export `captureEventKey()` and `captureQuestionKey()` helpers using SHA-256.
Create directories with mode `0700`, files with `0600`, use temporary sibling
files plus `rename`, and quarantine invalid JSON without logging its contents.
Add `@cognelis/decision-storage` to bridge dependencies.

- [ ] **Step 4: Run spool tests**

Run:

```bash
npm test -- packages/storage/test/capture-spool.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/storage apps/bridge/package.json
git commit -m "feat: add recoverable capture spool"
```

### Task 4: Replace MCP installation with passive PostToolUse hooks

**Files:**
- Modify: `packages/integrations/src/hooks.ts`
- Modify: `packages/integrations/src/claude.ts`
- Modify: `packages/integrations/src/codex.ts`
- Modify: `packages/integrations/src/install.ts`
- Modify: `packages/integrations/src/index.ts`
- Modify: `packages/integrations/test/claude.test.ts`
- Modify: `packages/integrations/test/codex.test.ts`
- Modify: `packages/integrations/test/install.test.ts`

- [ ] **Step 1: Rewrite integration tests around passive hooks and MCP removal**

```ts
expect(mergeClaudeSettings(existingClaudeSettings, bridgePath)
  .hooks.PostToolUse.at(-1)).toMatchObject({
  matcher: "^AskUserQuestion$",
  hooks: [expect.objectContaining({
    type: "command",
    command: expect.stringContaining("hook post-tool-use claude-code"),
    timeout: 5,
  })],
});

expect(mergeCodexHooks(existingCodexHooks, bridgePath)
  .hooks.PostToolUse.at(-1)).toMatchObject({
  matcher: "^(request_user_input|AskUserQuestion)$",
  hooks: [expect.objectContaining({
    command: expect.stringContaining("hook post-tool-use codex"),
  })],
});

expect(JSON.stringify(merged)).not.toContain("hook session-start");
expect(JSON.stringify(merged)).not.toContain("hook stop");
expect(claudeCleanupCommands()).toEqual([{
  command: "claude",
  args: ["mcp", "remove", "--scope", "user", "decision"],
  tolerateFailure: true,
}]);
```

Update install expectations from four MCP commands to two tolerated removal
commands. Add a fixture containing legacy Decision handlers and assert
only marked handlers are removed.

- [ ] **Step 2: Run integration tests and verify RED**

Run:

```bash
npm test -- packages/integrations/test
```

Expected: FAIL because installation still adds MCP, SessionStart, and Stop.

- [ ] **Step 3: Install only owned passive handlers**

Use marker prefix `DECISION_HOOK=` so both legacy
`DECISION_HOOK=1` and new `DECISION_HOOK=2` handlers are removed
before merging. Add exactly one new handler:

```ts
const command =
  `DECISION_HOOK=2 ${shellQuote(bridgePath)} ` +
  `hook post-tool-use ${client}`;
events.PostToolUse = [
  ...(events.PostToolUse ?? []),
  { matcher, hooks: [{ type: "command", command, timeout: 5 }] },
];
```

Rename MCP command helpers to cleanup helpers and return only remove commands.
Keep atomic backups and unknown config fields unchanged.

- [ ] **Step 4: Run integration tests**

Run:

```bash
npm test -- packages/integrations/test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/integrations
git commit -m "refactor: install passive decision hooks"
```

### Task 5: Make bridge hooks fail-open and non-interactive

**Files:**
- Modify: `apps/bridge/src/runtime-client.ts`
- Modify: `apps/bridge/src/cli.ts`
- Delete: `apps/bridge/src/mcp-server.ts`
- Delete: `apps/bridge/src/hooks.ts`
- Delete: `apps/bridge/test/mcp-server.test.ts`
- Modify: `apps/bridge/test/hooks-cli.test.ts`
- Modify: `apps/bridge/test/runtime-client.test.ts`
- Modify: `apps/bridge/package.json`

- [ ] **Step 1: Add red fail-open CLI tests**

```ts
it("spools and delivers a Claude hook without stdout", async () => {
  const spool = { append: vi.fn(async () => undefined) };
  const runtime = { deliver: vi.fn(async () => ({ accepted: 1, duplicates: 0 })) };
  const output: unknown[] = [];
  const code = await main(
    ["hook", "post-tool-use", "claude-code"],
    {
      readStdin: async () => claudePostToolUseFixture(),
      spool,
      runtime,
      printJson: (value) => output.push(value),
    },
  );
  expect(code).toBe(0);
  expect(spool.append).toHaveBeenCalledOnce();
  expect(runtime.deliver).toHaveBeenCalledOnce();
  expect(output).toEqual([]);
});

it("returns zero with empty stdout when spooling and delivery fail", async () => {
  const code = await main(
    ["hook", "post-tool-use", "codex"],
    {
      readStdin: async () => codexPostToolUseFixture(),
      spool: { append: async () => { throw new Error("disk full"); } },
      runtime: { deliver: async () => { throw new Error("offline"); } },
      printJson: vi.fn(),
      printError: vi.fn(),
    },
  );
  expect(code).toBe(0);
});
```

- [ ] **Step 2: Run bridge tests and verify RED**

Run:

```bash
npm test -- apps/bridge/test
```

Expected: FAIL because the CLI still exposes MCP and blocking hooks.

- [ ] **Step 3: Implement short delivery and remove MCP**

Add:

```ts
async deliver(input: CapturedDecisionEvent): Promise<CaptureReceipt | null> {
  const runtime = await this.#readRuntime().catch(() => null);
  if (runtime === null) {
    await this.#launch().catch(() => undefined);
    return null;
  }
  try {
    const response = await this.#fetch(
      `http://127.0.0.1:${runtime.port}/v1/captures`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${runtime.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(capturedDecisionEventSchema.parse(input)),
        signal: AbortSignal.timeout(this.#deliveryTimeoutMs),
      },
    );
    return response.ok
      ? captureReceiptSchema.parse(await response.json())
      : null;
  } catch {
    await this.#launch().catch(() => undefined);
    return null;
  }
}
```

The hook command adapts input, appends before delivery, swallows all errors,
prints nothing, and returns zero. Keep `doctor` and `install`. Remove the MCP
SDK dependency, `mcp` command, session-start command, stop marker command, and
their files/tests.

- [ ] **Step 4: Run bridge tests**

Run:

```bash
npm test -- apps/bridge/test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bridge package-lock.json
git commit -m "refactor: make capture hooks fail open"
```

### Task 6: Replace the choice state machine with a rationale queue

**Files:**
- Create: `packages/core/src/rationale-queue.ts`
- Create: `packages/core/test/rationale-queue.test.ts`
- Modify: `packages/core/src/record.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/test/record.test.ts`
- Delete: `packages/core/src/decision-machine.ts`
- Delete: `packages/core/src/decision-queue.ts`
- Delete: `packages/core/test/decision-machine.test.ts`
- Delete: `packages/core/test/decision-queue.test.ts`

- [ ] **Step 1: Add red queue tests**

```ts
it("splits a batch into FIFO rationale candidates and deduplicates replays", () => {
  const queue = new RationaleQueue(() => "candidate-1");
  const event = captureFixture({ questions: [
    questionFixture(0),
    questionFixture(1),
  ]});

  expect(queue.ingest(event)).toEqual({ accepted: 2, duplicates: 0 });
  expect(queue.ingest(event)).toEqual({ accepted: 0, duplicates: 2 });
  expect(queue.snapshot()).toMatchObject({
    current: {
      status: "awaiting_rationale",
      question: { questionIndex: 0 },
    },
    waitingCount: 1,
  });
});

it.each(["captured", "deferred", "skipped", "not_recorded"] as const)(
  "disposes a candidate as %s without waiting for an agent",
  async (status) => {
    const onDisposition = vi.fn(async () => undefined);
    const queue = new RationaleQueue(() => "candidate-1", { onDisposition });
    queue.ingest(captureFixture());
    await queue.submit(status === "captured"
      ? { status, rationale: "Because it is maintainable." }
      : { status });
    expect(onDisposition).toHaveBeenCalledWith(
      expect.objectContaining({ candidateId: "candidate-1" }),
      expect.objectContaining({ status }),
    );
    expect(queue.snapshot().current).toBeNull();
  },
);
```

- [ ] **Step 2: Run core tests and verify RED**

Run:

```bash
npm test -- packages/core/test
```

Expected: FAIL because `RationaleQueue` does not exist.

- [ ] **Step 3: Implement the queue and record conversion**

Define:

```ts
export type RationaleSubmission =
  | { status: "captured"; rationale: string; reasonFactors?: string[] }
  | { status: "deferred" | "skipped" | "not_recorded" };

export interface RationaleCandidate {
  status: "awaiting_rationale" | "completed";
  candidateId: string;
  event: CapturedDecisionEvent;
  question: CapturedQuestion;
  candidateKey: string;
}

export interface RationaleQueueSnapshot {
  current: RationaleCandidate | null;
  waitingCount: number;
  persistenceStatus?: "saving" | "failed";
}
```

`ingest()` splits questions, keeps an in-memory key set, and publishes
serializable snapshots. `submit()` calls `onDisposition` before advancing;
failed persistence keeps the completed candidate for retry.

Replace `createDecisionRecord(state, now)` with:

```ts
createDecisionRecord(
  candidate: RationaleCandidate,
  submission: Exclude<RationaleSubmission, { status: "not_recorded" }>,
  id: string,
  now: Date,
): DecisionRecord
```

The record preserves source, capture mode, batch, question index, options and
answer values. It sets workflow and recommendation to `null`, decision type to
`other`, and context summary to `null`.

- [ ] **Step 4: Run core tests**

Run:

```bash
npm test -- packages/core/test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "refactor: queue captured decisions for rationale"
```

### Task 7: Persist passive capture provenance and multi-value answers

**Files:**
- Modify: `packages/storage/src/markdown.ts`
- Modify: `packages/storage/src/sqlite-index.ts`
- Modify: `packages/storage/test/markdown.test.ts`
- Modify: `packages/storage/test/sqlite-index.test.ts`
- Modify: `packages/storage/test/decision-store.test.ts`

- [ ] **Step 1: Add red storage compatibility tests**

```ts
it("round-trips passive provenance and a multi-select answer", () => {
  const record = recordFixture({
    captureMode: "structured_tool",
    sourceEventId: "event-1",
    batchId: "batch-1",
    questionIndex: 1,
    selectedAnswer: { kind: "multiple", values: ["Risk", "Time"] },
  });
  expect(parseDecision(serializeDecision(record))).toEqual(record);
});

it("reads a legacy selection marker into the new selected answer", () => {
  const legacy = serializeLegacyDecision();
  expect(parseDecision(legacy).selectedAnswer).toEqual({
    kind: "preset",
    values: ["方案 A"],
  });
});

it("indexes capture provenance without changing Markdown truth", async () => {
  index.upsert(await repository.read(note.path));
  expect(index.search("Risk")).toHaveLength(1);
});
```

- [ ] **Step 2: Run storage tests and verify RED**

Run:

```bash
npm test -- packages/storage/test
```

Expected: FAIL because the old record only supports one selected option.

- [ ] **Step 3: Extend Markdown and SQLite compatibly**

Write frontmatter:

```yaml
capture_mode: structured_tool
source_event_id: event-1
batch_id: batch-1
question_index: 1
selected_option: "Risk、Time"
```

Encode the new `selectedAnswer` in the existing base64 selection marker.
`decodeSelection()` accepts both legacy `{kind:"preset",id,label}` /
`{kind:"custom",answer}` and new `{kind,values}` shapes. Make
`contextSummary` nullable and render a neutral
`（原生问答未提供额外上下文）` placeholder.

Add nullable capture columns to `decisions`. On existing databases, inspect
`PRAGMA table_info(decisions)` and add missing columns before preparing
statements. Store readable answer values joined with `、`; FTS continues to
index question, answer, rationale, project and tags.

- [ ] **Step 4: Run storage tests**

Run:

```bash
npm test -- packages/storage/test
```

Expected: PASS, including legacy note fixtures.

- [ ] **Step 5: Commit**

```bash
git add packages/storage
git commit -m "feat: persist passive capture provenance"
```

### Task 8: Ingest captures and acknowledge the spool in the desktop runtime

**Files:**
- Create: `apps/desktop/src/main/capture-runtime.ts`
- Modify: `apps/desktop/src/main/local-server.ts`
- Modify: `apps/desktop/src/main/app-controller.ts`
- Modify: `apps/desktop/test/local-server.test.ts`
- Create: `apps/desktop/test/capture-runtime.test.ts`
- Modify: `apps/desktop/test/app-controller.test.ts`
- Delete: `apps/desktop/src/main/decision-runtime.ts`

- [ ] **Step 1: Add red runtime and HTTP tests**

```ts
it("returns 202 immediately after queueing a capture", async () => {
  const queue = { ingest: vi.fn(() => ({ accepted: 1, duplicates: 0 })) };
  const server = new LocalCaptureServer({ queue, token: TOKEN });
  await server.start();
  const response = await fetch(`${baseUrl(server)}/v1/captures`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(captureFixture()),
  });
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ accepted: 1, duplicates: 0 });
});

it("acknowledges a candidate only after disposition succeeds", async () => {
  const spool = { acknowledge: vi.fn(async () => undefined) };
  const store = { save: vi.fn(async () => ({ indexed: true })) };
  const runtime = new CaptureRuntime({ spool, store, idFactory, now });
  runtime.ingest(captureFixture());
  await runtime.queue.submit({ status: "deferred" });
  expect(store.save).toHaveBeenCalledOnce();
  expect(spool.acknowledge).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run desktop runtime tests and verify RED**

Run:

```bash
npm test -- apps/desktop/test/local-server.test.ts \
  apps/desktop/test/capture-runtime.test.ts \
  apps/desktop/test/app-controller.test.ts
```

Expected: FAIL because capture runtime/server types do not exist.

- [ ] **Step 3: Implement capture runtime and server**

`CaptureRuntime` owns a `RationaleQueue`. Its `onDisposition`:

```ts
if (submission.status !== "not_recorded") {
  const result = await store.save(createDecisionRecord(
    candidate,
    submission,
    idFactory(),
    now(),
  ));
  if (!result.indexed) markIndexDegraded();
}
await spool.acknowledge(candidate.event, candidate.question.questionIndex);
```

The server keeps authenticated `/health`, replaces `/v1/decisions` with
`POST /v1/captures`, validates the envelope, calls `runtime.ingest()`, and
returns `202` without waiting for rationale. Smoke mode exposes a rationale
completion endpoint only in smoke tests.

`AppController` subscribes to `RationaleQueue` rather than `DecisionQueue`.

- [ ] **Step 4: Run focused desktop tests**

Run:

```bash
npm test -- apps/desktop/test/local-server.test.ts \
  apps/desktop/test/capture-runtime.test.ts \
  apps/desktop/test/app-controller.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main apps/desktop/test
git commit -m "feat: ingest passive captures in desktop"
```

### Task 9: Make the renderer rationale-only

**Files:**
- Modify: `apps/desktop/src/shared/renderer-api.ts`
- Modify: `apps/desktop/src/shared/decision-layout.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/components/RationaleStep.tsx`
- Modify: `apps/desktop/src/renderer/components/DecisionHeader.tsx`
- Modify: `apps/desktop/src/renderer/preview-api.ts`
- Modify: `apps/desktop/src/renderer/styles.css`
- Delete: `apps/desktop/src/renderer/components/ChoiceStep.tsx`
- Modify: `apps/desktop/test/App.test.tsx`
- Modify: `apps/desktop/test/decision-layout.test.ts`
- Modify: `apps/desktop/test/ipc.test.ts`
- Modify: `apps/desktop/test/accessibility.test.tsx`

- [ ] **Step 1: Add red rationale-only UI tests**

```tsx
it("shows the native answer and never renders choice controls", async () => {
  render(<App api={apiWithSnapshot(rationaleSnapshot())} />);
  expect(await screen.findByText("为什么这样选？")).toBeVisible();
  expect(screen.getByText("Markdown")).toBeVisible();
  expect(screen.queryByLabelText("可选方案")).toBeNull();
  expect(screen.queryByText("返回")).toBeNull();
});

it("discards through the required checkbox", async () => {
  const api = apiWithSnapshot(rationaleSnapshot());
  render(<App api={api} />);
  await user.click(screen.getByRole("checkbox", {
    name: "不记录此次决策",
  }));
  await user.click(screen.getByRole("button", { name: "不记录" }));
  expect(api.submitRationale).toHaveBeenCalledWith({
    candidateId: "candidate-1",
    status: "not_recorded",
  });
});
```

- [ ] **Step 2: Run UI tests and verify RED**

Run:

```bash
npm test -- apps/desktop/test/App.test.tsx \
  apps/desktop/test/decision-layout.test.ts \
  apps/desktop/test/ipc.test.ts \
  apps/desktop/test/accessibility.test.tsx
```

Expected: FAIL because the current renderer starts at choice.

- [ ] **Step 3: Remove choice IPC/state and adapt rationale UI**

The renderer API keeps snapshot, rationale submit, retry, settings, vault,
integration, rebuild, and theme methods. Delete choose, reconsider and cancel.
Rationale input targets `candidateId`.

`RationaleStep` receives a captured candidate, uses
`candidate.question.answer.values.join("、")`, removes the Return button, and
adds:

```tsx
<label className="record-toggle">
  <input
    type="checkbox"
    checked={doNotRecord}
    disabled={busy}
    onChange={(event) => setDoNotRecord(event.target.checked)}
  />
  <span>不记录此次决策</span>
</label>
```

When checked, hide or disable reason actions and show one primary “不记录”
button. Otherwise preserve factors, free text, skip, later, and complete.
Compact eligibility depends on question and readable answer length; the only
compact mode is `island-rationale`.

- [ ] **Step 4: Run UI tests**

Run:

```bash
npm test -- apps/desktop/test/App.test.tsx \
  apps/desktop/test/decision-layout.test.ts \
  apps/desktop/test/ipc.test.ts \
  apps/desktop/test/accessibility.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src apps/desktop/test
git commit -m "refactor: make the island rationale only"
```

### Task 10: Compose startup replay, passive status, packaging, and smoke

**Files:**
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/main/integration-status.ts`
- Modify: `apps/desktop/test/integration-status.test.ts`
- Modify: `apps/desktop/test/decision-flow.integration.test.ts`
- Modify: `apps/desktop/test/recovery.integration.test.ts`
- Modify: `apps/bridge/vite.config.ts`
- Modify: `scripts/smoke.mjs`
- Modify: `README.md`
- Modify: `package-lock.json`

- [ ] **Step 1: Add red bootstrap/status/integration expectations**

```ts
it("reports installed only when the passive PostToolUse hook exists", async () => {
  await writeFile(claudePath, JSON.stringify(passiveClaudeHooks()));
  await writeFile(codexPath, JSON.stringify(passiveCodexHooks()));
  await expect(detectIntegrationStatus(paths)).resolves.toEqual({
    claudeCode: "installed",
    codex: "installed",
  });
});

it("replays spooled captures and persists a deferred rationale", async () => {
  await spool.append(captureFixture());
  const app = await createIntegrationRuntime({ spool, vault });
  await app.start();
  expect(app.snapshot().current?.status).toBe("awaiting_rationale");
  await app.submit({ status: "deferred" });
  expect((await repository.scan()).notes).toHaveLength(1);
  expect(await spool.list()).toEqual([]);
});
```

- [ ] **Step 2: Run integration tests and verify RED**

Run:

```bash
npm test -- apps/desktop/test/integration-status.test.ts \
  apps/desktop/test/decision-flow.integration.test.ts \
  apps/desktop/test/recovery.integration.test.ts
```

Expected: FAIL because bootstrap still composes MCP decision flow.

- [ ] **Step 3: Compose passive runtime and update smoke**

Add `spool` to `applicationSupportPaths()`. During bootstrap:

```ts
const spool = new CaptureSpool(paths.spool);
const runtime = new CaptureRuntime({ repository, index, spool, idFactory: randomUUID });
for (const event of await spool.list()) runtime.ingest(event);
const server = new LocalCaptureServer({ runtime, token, smokeMode });
```

Update status detection to match the passive PostToolUse command. Remove
ask-decision bundling and MCP SDK references. Smoke invokes the packaged bridge
with a PostToolUse fixture, waits for `/health`, submits rationale through the
smoke endpoint, and asserts one Markdown note, one SQLite row, an empty spool,
and no MCP-shaped output.

At this point remove the temporary legacy `askDecisionRequestSchema`,
`askDecisionResultSchema`, derived request/result types, and decision enums
from `packages/protocol/src/schemas.ts` and `packages/protocol/src/index.ts`.

Update README to describe native selection, passive capture, rationale-only
island, private spool, and Hook-only integration. Remove the obsolete
“420×72”, “2–4 option island”, MCP-first, and explicit Stop marker text.

- [ ] **Step 4: Run complete phase-one verification**

Run:

```bash
npm test
npm run typecheck
npm run build:bridge
```

Expected: all tests PASS, typecheck PASS, bridge build PASS.

- [ ] **Step 5: Commit**

```bash
git add apps packages scripts README.md package-lock.json
git commit -m "feat: capture native decisions passively"
```

### Task 11: Package and run the phase-one end-to-end smoke test

**Files:**
- Modify only files revealed by packaging or smoke failures, with a regression
  test added beside every fix.

- [ ] **Step 1: Build the macOS package**

Run:

```bash
npm run make
```

Expected: Electron Forge produces the arm64 package without type or bundle
errors.

- [ ] **Step 2: Run the packaged smoke test**

Run:

```bash
npm run smoke
```

Expected: smoke reports native hook capture, rationale persistence, Markdown,
SQLite, spool cleanup, bridge, and runtime cleanup as true.

- [ ] **Step 3: Re-run the complete test suite**

Run:

```bash
npm test
npm run typecheck
```

Expected: all tests PASS and TypeScript emits no diagnostics.

- [ ] **Step 4: Inspect for legacy behavior**

Run:

```bash
rg -n "ask_decision|DECISION_REQUEST_V1|hook session-start|Waiting for your Decision choice|awaiting_choice" \
  apps packages scripts README.md
```

Expected: no active source, config, smoke, or README references. Historical
specs and plans are intentionally excluded from this check.

- [ ] **Step 5: Commit any packaging-only fixes**

If Step 1–4 required changes:

```bash
git add apps packages scripts README.md package-lock.json
git commit -m "fix: package passive capture flow"
```

If no files changed, do not create an empty commit.
