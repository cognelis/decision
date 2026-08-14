# Qwen Structured Output Limit Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Qwen semantic classifications from producing frequent unterminated JSON, and record a precise output-limit error with measured Token usage when the bounded generation budget is exhausted.

**Architecture:** Bound copied semantic fields in the shared JSON generation Schema, increase only Qwen's output budget to 512, and classify a malformed response as `output_limit` when the runtime token delta reaches that budget. Carry measured failure usage through both model gateways while preserving the existing `invalid_output` invocation status and provider fallback behavior.

**Tech Stack:** TypeScript 7, Zod 4, Vitest 4, node-llama-cpp 3.19.1, React 19

---

## File map

- `apps/desktop/src/main/model/semantic-prompt.ts`: shared semantic generation Schema and exact copied-field limits.
- `packages/protocol/src/model.ts`: stable `output_limit` model invocation error code.
- `apps/desktop/src/main/ipc.ts`: renderer boundary validation for provider-test results.
- `apps/desktop/src/renderer/components/ModelProviderPanel.tsx`: readable provider-test copy for `output_limit`.
- `apps/desktop/src/renderer/components/ModelTracePanel.tsx`: readable trace-detail copy for `output_limit`.
- `apps/desktop/src/main/semantic/qwen-provider.ts`: Qwen budget, measured limit detection, and failure usage.
- `apps/desktop/src/main/model/model-gateway.ts`: legacy local gateway failure normalization and usage persistence.
- `apps/desktop/src/main/model/profiled-model-gateway.ts`: configured gateway failure normalization, health-check result, and usage persistence.
- `apps/desktop/test/qwen-provider.test.ts`: Schema, 512-token request, and provider error regression tests.
- `packages/protocol/test/model.test.ts`: protocol acceptance test for `output_limit`.
- `apps/desktop/test/model-gateway.test.ts`: both gateway trace and provider-test regressions.
- `apps/desktop/test/App.test.tsx`: user-facing error-copy regression.

### Task 1: Bound semantic generation and define the error contract

**Files:**
- Modify: `apps/desktop/src/main/model/semantic-prompt.ts:10-46`
- Modify: `packages/protocol/src/model.ts:278-303`
- Modify: `apps/desktop/src/main/ipc.ts:67-96`
- Test: `apps/desktop/test/qwen-provider.test.ts`
- Test: `packages/protocol/test/model.test.ts`

- [ ] **Step 1: Write failing Schema and protocol tests**

Import `semanticOutputJsonSchema` in `apps/desktop/test/qwen-provider.test.ts` and add:

```ts
it("bounds copied semantic fields in the generation grammar", () => {
  const properties = semanticOutputJsonSchema.properties as Record<
    string,
    Record<string, unknown>
  >;
  expect(properties.question).toMatchObject({ maxLength: 160 });
  expect(properties.answerExcerpt).toMatchObject({ maxLength: 120 });
  expect(properties.optionLabels).toMatchObject({
    maxItems: 8,
    items: expect.objectContaining({ maxLength: 80 }),
  });
});
```

Import `modelInvocationErrorCodeSchema` in `packages/protocol/test/model.test.ts` and add:

```ts
it("distinguishes exhausted output budgets from malformed output", () => {
  expect(modelInvocationErrorCodeSchema.parse("output_limit")).toBe(
    "output_limit",
  );
});
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
npm test -- apps/desktop/test/qwen-provider.test.ts packages/protocol/test/model.test.ts
```

Expected: FAIL because the generation Schema has no `maxLength` values and the protocol rejects `output_limit`.

- [ ] **Step 3: Add the minimal Schema and protocol values**

Update the three generation fields:

```ts
question: {
  type: ["string", "null"],
  maxLength: 160,
},
optionLabels: {
  type: "array",
  items: { type: "string", maxLength: 80 },
  maxItems: 8,
},
answerExcerpt: {
  type: ["string", "null"],
  maxLength: 120,
},
```

Add `"output_limit"` immediately after `"invalid_output"` in
`modelInvocationErrorCodeSchema` and in the matching IPC enum for
`ModelProviderTestResult.errorCode`.

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
npm test -- apps/desktop/test/qwen-provider.test.ts packages/protocol/test/model.test.ts
```

Expected: both files PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/model/semantic-prompt.ts apps/desktop/test/qwen-provider.test.ts packages/protocol/src/model.ts packages/protocol/test/model.test.ts apps/desktop/src/main/ipc.ts
git commit -m "fix: bound semantic model output fields"
```

### Task 2: Detect Qwen output-budget exhaustion

**Files:**
- Modify: `apps/desktop/src/main/semantic/qwen-provider.ts:135-170,330-390,470-535`
- Test: `apps/desktop/test/qwen-provider.test.ts:150-210,290-340`

- [ ] **Step 1: Write failing provider tests**

Change the existing prompt expectation from `maxTokens: 256` to
`maxTokens: 512`.

Add a fake-runtime case whose token meter moves from 10 input / 0 output to
590 input / 512 output and whose session returns an unterminated JSON string:

```ts
it("reports measured output-limit exhaustion separately", async () => {
  const fake = createRuntime(async () => "{\"question\":\"unfinished");
  fake.tokenMeter.getState
    .mockReturnValueOnce({
      usedInputTokens: 10,
      usedOutputTokens: 0,
    })
    .mockReturnValueOnce({
      usedInputTokens: 590,
      usedOutputTokens: 512,
    });
  const provider = new QwenModelProvider({
    modelsDirectory: "/models",
    verifyModel: async () => availableModel(),
    loadRuntime: async () => fake.runtime,
  });

  await expect(provider.classify(input)).rejects.toMatchObject({
    code: "output_limit",
    diagnosticExcerpt:
      "Qwen output reached the 512-token limit before completing valid JSON",
    usage: {
      source: "runtime_measured",
      inputTokens: 580,
      outputTokens: 512,
      totalTokens: 1_092,
    },
  });
});
```

Keep the existing malformed-output case below the limit and assert that its code remains
`provider_invalid_output`.

- [ ] **Step 2: Run the provider test to verify RED**

Run:

```bash
npm test -- apps/desktop/test/qwen-provider.test.ts
```

Expected: FAIL because Qwen still requests 256 Token and `QwenProviderError` does not support `output_limit` or failure usage.

- [ ] **Step 3: Implement measured limit detection**

Add:

```ts
const QWEN_MAX_OUTPUT_TOKENS = 512;
```

Extend `QwenProviderError` with:

```ts
readonly code:
  | "model_missing"
  | "checksum_failed"
  | "provider_invalid_output"
  | "output_limit"
  | "runtime_unavailable"
  | "timeout";
readonly usage?: NormalizedTokenUsage;
```

Accept `usage?: NormalizedTokenUsage` in its options. In `#invokeNow`, calculate
`const usage = this.#tokenUsage(usageBefore, usageAfter)` before parsing. If parsing
fails and `usage.outputTokens >= QWEN_MAX_OUTPUT_TOKENS`, throw:

```ts
throw new QwenProviderError(
  "output_limit",
  "Qwen output exceeded its generation budget",
  {
    diagnosticExcerpt:
      "Qwen output reached the 512-token limit before completing valid JSON",
    usage,
  },
);
```

Otherwise retain the current safe parse diagnostic and attach the measured `usage`.
Use `QWEN_MAX_OUTPUT_TOKENS` in `session.prompt`.

- [ ] **Step 4: Run the provider test to verify GREEN**

Run:

```bash
npm test -- apps/desktop/test/qwen-provider.test.ts
```

Expected: all Qwen provider tests PASS, including the distinct below-limit malformed JSON case.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/semantic/qwen-provider.ts apps/desktop/test/qwen-provider.test.ts
git commit -m "fix: detect Qwen output budget exhaustion"
```

### Task 3: Preserve output-limit diagnostics through gateways and UI

**Files:**
- Modify: `apps/desktop/src/main/model/model-gateway.ts:50-65,375-425,545-570`
- Modify: `apps/desktop/src/main/model/profiled-model-gateway.ts:55-70,520-570,690-730`
- Modify: `apps/desktop/src/renderer/components/ModelProviderPanel.tsx:175-210`
- Modify: `apps/desktop/src/renderer/components/ModelTracePanel.tsx:20-45,220-250`
- Test: `apps/desktop/test/model-gateway.test.ts`
- Test: `apps/desktop/test/App.test.tsx`

- [ ] **Step 1: Write failing gateway and UI tests**

In `apps/desktop/test/model-gateway.test.ts`, make Qwen throw:

```ts
new QwenProviderError(
  "output_limit",
  "Qwen output exceeded its generation budget",
  {
    diagnosticExcerpt:
      "Qwen output reached the 512-token limit before completing valid JSON",
    usage: {
      source: "runtime_measured",
      inputTokens: 580,
      outputTokens: 512,
      totalTokens: 1_092,
    },
  },
)
```

Assert both `StructuredModelGateway` and `ProfiledModelGateway` record:

```ts
expect.objectContaining({
  status: "invalid_output",
  errorCode: "output_limit",
  usage: {
    source: "runtime_measured",
    inputTokens: 580,
    outputTokens: 512,
    totalTokens: 1_092,
  },
})
```

Also assert `testProfile()` returns `errorCode: "output_limit"`.

In `apps/desktop/test/App.test.tsx`, provide a failed Qwen provider-test result with
`errorCode: "output_limit"` and assert the status contains `输出达到长度上限`.
Provide an expanded model trace with the same code and assert its error row uses the same copy.

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
npm test -- apps/desktop/test/model-gateway.test.ts apps/desktop/test/App.test.tsx
```

Expected: FAIL because gateways normalize the code to `provider_unavailable`, discard failure usage, and the UI has no label.

- [ ] **Step 3: Implement gateway normalization and UI copy**

Add optional `usage?: NormalizedTokenUsage` to both private `NormalizedFailure`
interfaces. Extract a validated error usage when present:

```ts
const parsedUsage = normalizedTokenUsageSchema.safeParse(
  error !== null &&
    typeof error === "object" &&
    "usage" in error
    ? error.usage
    : undefined,
);
```

Map `output_limit` to:

```ts
{
  status: "invalid_output",
  errorCode: "output_limit",
  ...(parsedUsage.success ? { usage: parsedUsage.data } : {}),
}
```

When recording a failed attempt, use:

```ts
usage: failure.usage ?? { source: "unavailable" },
```

Add `output_limit: "输出达到长度上限"` to the provider-test error copy. In
`ModelTracePanel`, define a complete `Record<ModelInvocationErrorCode, string>` and
render the mapped label instead of the raw enum.

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
npm test -- apps/desktop/test/model-gateway.test.ts apps/desktop/test/App.test.tsx
```

Expected: both files PASS with measured failure usage and readable copy.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/model/model-gateway.ts apps/desktop/src/main/model/profiled-model-gateway.ts apps/desktop/src/renderer/components/ModelProviderPanel.tsx apps/desktop/src/renderer/components/ModelTracePanel.tsx apps/desktop/test/model-gateway.test.ts apps/desktop/test/App.test.tsx
git commit -m "fix: preserve Qwen output limit diagnostics"
```

### Task 4: Verify the real failure and release surface

**Files:**
- Modify only if verification exposes a regression in files already listed above.

- [ ] **Step 1: Run all targeted tests and type checking**

Run:

```bash
npm test -- apps/desktop/test/qwen-provider.test.ts apps/desktop/test/model-gateway.test.ts apps/desktop/test/App.test.tsx packages/protocol/test/model.test.ts
npm run typecheck
```

Expected: all targeted tests PASS and TypeScript exits 0.

- [ ] **Step 2: Replay the screenshot trace with the production Schema**

Run a read-only Node replay against:

```text
$HOME/Library/Application Support/Decision/model-traces/<trace-hash>.json
```

Use the repository's `semanticOutputJsonSchema`, `maxTokens: 512`, the installed GGUF,
and `temperature: 0`. Print only parse status, output Token count, and copied-field
lengths.

Expected: `parseError: null`, output Token count at most 512, question at most 160,
answer excerpt at most 120, and each option label at most 80.

- [ ] **Step 3: Run the complete release verification**

Run:

```bash
npm test
npm run typecheck
npm run evaluate:semantic -- --report-only
npm run make
npm run smoke
```

Expected: 0 test failures, typecheck exit 0, semantic report generated, Forge artifacts
created, and smoke output contains `"ok":true`.

- [ ] **Step 4: Inspect final repository state**

Run:

```bash
git status --short --branch
git log --oneline -5
git diff HEAD^ --check
```

Expected: clean `main`, the implementation commits are visible, and no whitespace errors
are reported.
