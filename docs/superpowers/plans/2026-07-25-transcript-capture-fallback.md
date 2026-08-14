# Transcript Capture Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend passive structured capture with a local, precision-first fallback for direct questions asked as ordinary assistant text.

**Architecture:** Stop hooks record only a narrowly extracted final direct question in a private per-session pending store. The next UserPromptSubmit hook for the same client and session pairs the user response with that question and emits the existing `CapturedDecisionEvent` shape; direct hook fields are preferred, and a bounded transcript-tail reader is used only when the assistant message is absent.

**Tech Stack:** TypeScript 7, Zod 4, Node.js filesystem APIs, existing capture spool/runtime, Vitest

---

## File map

- `apps/bridge/src/direct-question.ts`: deterministic direct-question extraction and rejection rules.
- `apps/bridge/src/transcript-tail.ts`: bounded JSONL tail reader for Claude Code and Codex message shapes.
- `apps/bridge/src/text-capture-store.ts`: private per-client/session pending question state.
- `apps/bridge/src/text-fallback.ts`: Stop and UserPromptSubmit correlation into a transcript-mode capture.
- `apps/bridge/src/cli.ts`: adds fail-open Stop and UserPromptSubmit commands.
- `packages/integrations/src/hooks.ts`: installs passive PostToolUse, Stop, and UserPromptSubmit handlers.
- `apps/desktop/src/main/integration-status.ts`: requires the complete hybrid hook set.
- `scripts/smoke.mjs`: verifies ordinary text question capture without full transcript persistence.
- `README.md`: documents structured-first plus local transcript fallback.

### Task 1: Extract only direct final questions

**Files:**
- Create: `apps/bridge/src/direct-question.ts`
- Create: `apps/bridge/test/direct-question.test.ts`

- [ ] **Step 1: Write red precision tests**

```ts
import { extractDirectQuestion } from "../src/direct-question.js";

it.each([
  ["选择哪种发布方式？", "选择哪种发布方式？"],
  [
    "我已经完成检查。\n\n接下来先修复兼容性，还是先补测试？",
    "接下来先修复兼容性，还是先补测试？",
  ],
  [
    "背景如下：\n- A：速度优先\n- B：稳定优先\n\n你希望采用哪一个？",
    "背景如下：\n- A：速度优先\n- B：稳定优先\n\n你希望采用哪一个？",
  ],
])("extracts a direct final question from %s", (message, expected) => {
  expect(extractDirectQuestion(message)).toBe(expected);
});

it.each([
  "测试已经通过。",
  "代码中包含 `shouldRetry?` 变量。",
  "```ts\nconst value = ready ? a : b;\n```",
  "> 用户之前问：是否需要缓存？\n\n我已完成实现。",
  "如果失败怎么办？我会自动回滚并继续。",
])("rejects status, code, quotes, and answered rhetorical questions", (message) => {
  expect(extractDirectQuestion(message)).toBeNull();
});
```

- [ ] **Step 2: Run extraction tests and verify RED**

Run:

```bash
npm test -- apps/bridge/test/direct-question.test.ts
```

Expected: FAIL because the extractor does not exist.

- [ ] **Step 3: Implement deterministic extraction**

```ts
export const extractDirectQuestion = (message: string): string | null => {
  const stripped = stripFencedCode(message).trim();
  if (stripped.length === 0 || stripped.length > 8_000) return null;
  const paragraphs = stripped.split(/\n{2,}/u);
  const last = paragraphs.at(-1)?.trim() ?? "";
  if (!/[?？]\s*$/u.test(last)) return null;
  if (/^(?:>|```)/u.test(last)) return null;
  const previous = paragraphs.slice(0, -1).join("\n\n").trim();
  const candidate = previous.length > 0 &&
      /(?:^|\n)\s*(?:[-*]|\d+\.)\s+/u.test(previous)
    ? `${previous}\n\n${last}`
    : last;
  return candidate.length <= 4_000 ? candidate : null;
};
```

`stripFencedCode` removes complete triple-backtick blocks before testing
question punctuation. Reject a paragraph containing a question followed by a
declarative answer in the same paragraph.

- [ ] **Step 4: Run extraction tests**

Run:

```bash
npm test -- apps/bridge/test/direct-question.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bridge/src/direct-question.ts apps/bridge/test/direct-question.test.ts
git commit -m "feat: detect direct assistant questions"
```

### Task 2: Read only a bounded transcript tail

**Files:**
- Create: `apps/bridge/src/transcript-tail.ts`
- Create: `apps/bridge/test/transcript-tail.test.ts`

- [ ] **Step 1: Add red bounded-reader tests**

```ts
it("extracts the last Claude assistant text from a JSONL tail", async () => {
  await writeFile(path, [
    JSON.stringify({ type: "assistant", message: {
      role: "assistant",
      content: [{ type: "text", text: "旧消息" }],
    }}),
    JSON.stringify({ type: "assistant", message: {
      role: "assistant",
      content: [{ type: "text", text: "选择 A 还是 B？" }],
    }}),
  ].join("\n"));
  await expect(readLastAssistantText(path, { maximumBytes: 64 * 1024 }))
    .resolves.toBe("选择 A 还是 B？");
});

it("extracts Codex response_item output_text", async () => {
  await writeFile(path, JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "现在继续吗？" }],
    },
  }));
  await expect(readLastAssistantText(path)).resolves.toBe("现在继续吗？");
});

it("never reads more than the configured tail", async () => {
  const read = vi.fn(realRead);
  await readLastAssistantText(path, { maximumBytes: 1024, read });
  expect(read).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    length: 1024,
  }));
});
```

- [ ] **Step 2: Run transcript tests and verify RED**

Run:

```bash
npm test -- apps/bridge/test/transcript-tail.test.ts
```

Expected: FAIL because the bounded reader does not exist.

- [ ] **Step 3: Implement the tail reader**

Open the file, `stat()` it, and read at most the final 64 KiB. If reading starts
mid-line, discard the first partial line. Walk valid JSON lines from newest to
oldest and extract assistant text from these exact supported branches:

```ts
const candidates = [
  value.message?.role === "assistant" ? value.message.content : null,
  value.payload?.role === "assistant" ? value.payload.content : null,
];
```

Accept content array items with `type: "text" | "output_text"` and a string
`text`. Missing files, invalid lines, unsupported formats, and oversized text
return `null`; no transcript content is logged or returned beyond the final
assistant text.

- [ ] **Step 4: Run transcript tests**

Run:

```bash
npm test -- apps/bridge/test/transcript-tail.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bridge/src/transcript-tail.ts apps/bridge/test/transcript-tail.test.ts
git commit -m "feat: read bounded transcript tails"
```

### Task 3: Correlate Stop and UserPromptSubmit in a private store

**Files:**
- Create: `apps/bridge/src/text-capture-store.ts`
- Create: `apps/bridge/src/text-fallback.ts`
- Create: `apps/bridge/test/text-fallback.test.ts`

- [ ] **Step 1: Add red correlation tests**

```ts
it("pairs one direct Stop question with the next prompt in the same session", async () => {
  await fallback.onStop({
    session_id: "session-1",
    turn_id: "turn-question",
    cwd: "/tmp/project",
    last_assistant_message: "先做 A 还是 B？",
  }, "codex");

  const event = await fallback.onUserPrompt({
    session_id: "session-1",
    turn_id: "turn-answer",
    cwd: "/tmp/project",
    prompt: "先做 A",
  }, "codex");

  expect(event).toMatchObject({
    captureMode: "transcript",
    sourceClient: "codex",
    sessionId: "session-1",
    questions: [{
      question: "先做 A 还是 B？",
      answer: { kind: "custom", values: ["先做 A"] },
    }],
  });
});

it("does not cross sessions or reuse a consumed question", async () => {
  await fallback.onStop(stopFixture({ session_id: "one" }), "claude-code");
  await expect(fallback.onUserPrompt(
    promptFixture({ session_id: "two" }),
    "claude-code",
  )).resolves.toBeNull();
  await fallback.onUserPrompt(promptFixture({ session_id: "one" }), "claude-code");
  await expect(fallback.onUserPrompt(
    promptFixture({ session_id: "one" }),
    "claude-code",
  )).resolves.toBeNull();
});

it("falls back to a bounded transcript only without last_assistant_message", async () => {
  const readLastAssistantText = vi.fn(async () => "采用哪种缓存？");
  await fallback.onStop({
    session_id: "session-1",
    transcript_path: "/tmp/session.jsonl",
    cwd: "/tmp/project",
  }, "claude-code");
  expect(readLastAssistantText).toHaveBeenCalledWith("/tmp/session.jsonl");
});
```

- [ ] **Step 2: Run text fallback tests and verify RED**

Run:

```bash
npm test -- apps/bridge/test/text-fallback.test.ts
```

Expected: FAIL because fallback modules do not exist.

- [ ] **Step 3: Implement private per-session pending state**

Store one JSON file per SHA-256 of `${client}:${sessionId}` under
`text-pending/`, with directory mode `0700` and file mode `0600`:

```ts
interface PendingTextQuestion {
  version: 1;
  sourceClient: "claude-code" | "codex";
  sessionId: string;
  turnId?: string;
  cwd: string;
  question: string;
  capturedAt: string;
}
```

`onStop()` prefers `last_assistant_message`, otherwise calls the bounded reader;
it saves only when `extractDirectQuestion()` succeeds. `onUserPrompt()` reads
the exact session file, rejects empty or over-2,000-character prompts, deletes
the pending file before returning, and emits:

```ts
{
  eventVersion: 1,
  captureMode: "transcript",
  sourceClient,
  sessionId,
  turnId: input.turn_id,
  sourceEventId: `${pending.turnId ?? "stop"}:${input.turn_id ?? "prompt"}`,
  batchId: `${sourceClient}:${sessionId}:text:${sha256(question + prompt)}`,
  project: basename(cwd),
  cwd,
  capturedAt: now().toISOString(),
  questions: [{
    questionIndex: 0,
    question,
    options: [],
    answer: { kind: "custom", values: [prompt] },
    multiSelect: false,
  }],
}
```

- [ ] **Step 4: Run text fallback tests**

Run:

```bash
npm test -- apps/bridge/test/text-fallback.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bridge/src apps/bridge/test
git commit -m "feat: correlate passive text decisions"
```

### Task 4: Add fail-open text hook commands

**Files:**
- Modify: `apps/bridge/src/cli.ts`
- Modify: `apps/bridge/test/hooks-cli.test.ts`

- [ ] **Step 1: Add red CLI tests for both lifecycle events**

```ts
it("records Stop state without stdout", async () => {
  const fallback = { onStop: vi.fn(async () => undefined) };
  const printJson = vi.fn();
  const code = await main(
    ["hook", "stop", "codex"],
    { readStdin: async () => stopFixture(), fallback, printJson },
  );
  expect(code).toBe(0);
  expect(fallback.onStop).toHaveBeenCalledOnce();
  expect(printJson).not.toHaveBeenCalled();
});

it("spools a correlated UserPromptSubmit event and always exits zero", async () => {
  const fallback = {
    onUserPrompt: vi.fn(async () => transcriptCaptureFixture()),
  };
  const spool = { append: vi.fn(async () => undefined) };
  const runtime = { deliver: vi.fn(async () => null) };
  const code = await main(
    ["hook", "user-prompt-submit", "claude-code"],
    { readStdin: async () => promptFixture(), fallback, spool, runtime },
  );
  expect(code).toBe(0);
  expect(spool.append).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run hook CLI tests and verify RED**

Run:

```bash
npm test -- apps/bridge/test/hooks-cli.test.ts
```

Expected: FAIL because the new commands are unknown.

- [ ] **Step 3: Route Stop and UserPromptSubmit without output**

Add commands:

```text
hook stop <claude-code|codex>
hook user-prompt-submit <claude-code|codex>
```

Both read stdin inside a try/catch and always return zero. Stop only updates
pending state. UserPromptSubmit appends/delivers only when correlation returns
an event. Neither command calls `printJson`, `printError`, or writes hook
decision fields.

- [ ] **Step 4: Run bridge tests**

Run:

```bash
npm test -- apps/bridge/test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bridge
git commit -m "feat: add fail-open text capture hooks"
```

### Task 5: Install and detect the complete hybrid hook set

**Files:**
- Modify: `packages/integrations/src/hooks.ts`
- Modify: `packages/integrations/test/claude.test.ts`
- Modify: `packages/integrations/test/codex.test.ts`
- Modify: `apps/desktop/src/main/integration-status.ts`
- Modify: `apps/desktop/test/integration-status.test.ts`

- [ ] **Step 1: Add red hybrid integration expectations**

```ts
expect(merged.hooks.Stop.at(-1)).toMatchObject({
  hooks: [expect.objectContaining({
    command: expect.stringContaining("hook stop claude-code"),
    timeout: 5,
  })],
});
expect(merged.hooks.UserPromptSubmit.at(-1)).toMatchObject({
  hooks: [expect.objectContaining({
    command: expect.stringContaining("hook user-prompt-submit claude-code"),
    timeout: 5,
  })],
});
expect(JSON.stringify(merged)).not.toContain("additionalContext");
expect(JSON.stringify(merged)).not.toContain("Waiting for");
```

Status tests require all three owned commands and return `not-installed` when
any one is absent.

- [ ] **Step 2: Run integration/status tests and verify RED**

Run:

```bash
npm test -- packages/integrations/test \
  apps/desktop/test/integration-status.test.ts
```

Expected: FAIL because only PostToolUse is installed.

- [ ] **Step 3: Merge passive Stop and UserPromptSubmit handlers**

Append command handlers with no matcher:

```ts
events.Stop = [
  ...(events.Stop ?? []),
  { hooks: [handler(`hook stop ${client}`)] },
];
events.UserPromptSubmit = [
  ...(events.UserPromptSubmit ?? []),
  { hooks: [handler(`hook user-prompt-submit ${client}`)] },
];
```

Use timeout 5, no status message, no async flag, and no output-producing hook
configuration. Continue removing both old and current owned handlers by marker
before merge.

- [ ] **Step 4: Run integration/status tests**

Run:

```bash
npm test -- packages/integrations/test \
  apps/desktop/test/integration-status.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/integrations apps/desktop/src/main/integration-status.ts \
  apps/desktop/test/integration-status.test.ts
git commit -m "feat: install hybrid passive capture hooks"
```

### Task 6: Verify dedupe, privacy, packaged smoke, and documentation

**Files:**
- Modify: `apps/desktop/test/decision-flow.integration.test.ts`
- Modify: `apps/bridge/test/text-fallback.test.ts`
- Modify: `scripts/smoke.mjs`
- Modify: `README.md`

- [ ] **Step 1: Add red end-to-end fallback tests**

```ts
it("does not duplicate a structured event through transcript fallback", async () => {
  runtime.ingest(structuredCaptureFixture({
    sessionId: "session-1",
    question: "Use A or B?",
    answer: "A",
  }));
  runtime.ingest(transcriptCaptureFixture({
    sessionId: "session-1",
    question: "Use A or B?",
    answer: "A",
  }));
  expect(runtime.queue.snapshot().waitingCount).toBe(0);
  expect(runtime.queue.snapshot().current).toMatchObject({
    event: { captureMode: "structured_tool" },
  });
});

it("never persists unrelated transcript lines", async () => {
  const event = await correlateFromTranscript(privateTranscriptFixture());
  expect(JSON.stringify(event)).not.toContain("unrelated secret line");
});
```

- [ ] **Step 2: Run bridge and integration tests and verify RED**

Run:

```bash
npm test -- apps/bridge/test \
  apps/desktop/test/decision-flow.integration.test.ts
```

Expected: FAIL until semantic cross-mode dedupe is added.

- [ ] **Step 3: Add cross-mode semantic dedupe**

In `RationaleQueue`, keep the exact source key and a secondary semantic key:

```ts
sha256([
  sourceClient,
  sessionId,
  normalize(question),
  normalize(answer.values.join("\u0000")),
].join("\u0001"))
```

When both modes describe the same session/question/answer, prefer the existing
structured candidate and count the transcript event as duplicate. Do not
deduplicate identical decisions from different sessions.

Update smoke to invoke bridge Stop then UserPromptSubmit fixtures, assert the
hook processes emit empty stdout and exit zero, complete one rationale, and
verify the Markdown contains `capture_mode: "transcript"` but no unrelated
transcript line.

Update README with the final hybrid behavior, precision rules, local bounded
tail read, privacy guarantees, and the limitation that ambiguous text questions
are intentionally ignored.

- [ ] **Step 4: Run full final verification**

Run:

```bash
npm test
npm run typecheck
npm run make
npm run smoke
```

Expected: every test and typecheck passes, package succeeds, and smoke reports
both structured and transcript capture paths healthy.

- [ ] **Step 5: Inspect the final behavior boundary**

Run:

```bash
rg -n "ask_decision|DECISION_REQUEST_V1|additionalContext|permissionDecision|decision.*block" \
  apps packages scripts README.md
```

Expected: no active behavior-changing integration remains. Matches inside
tests that assert absence are acceptable.

- [ ] **Step 6: Commit**

```bash
git add apps packages scripts README.md
git commit -m "feat: capture ordinary decisions passively"
```
