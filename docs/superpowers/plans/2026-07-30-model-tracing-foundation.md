# Model Tracing Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Apple/Qwen-only registry with a traceable structured model gateway and let users inspect, disable, and delete short-lived model input/output traces.

**Architecture:** Add provider-neutral model invocation and trace schemas to the protocol package, an atomic private trace store to storage, and a structured gateway in Electron main. Apple and Qwen become gateway adapters; semantic routing still validates source excerpts and still falls back to rules. Large trace bodies travel through explicit IPC methods instead of the frequently broadcast app snapshot.

**Tech Stack:** TypeScript 7, Zod, Vitest, Electron IPC, React 19, Swift Foundation Models, node-llama-cpp.

---

## File map

**Create**

- `packages/protocol/src/model.ts` — provider-neutral requests, usage, timing, error, trace, and summary schemas.
- `packages/protocol/test/model.test.ts` — protocol boundary tests.
- `packages/storage/src/model-trace-store.ts` — private atomic trace retention and deletion.
- `packages/storage/test/model-trace-store.test.ts` — permissions, retention, quarantine, and deletion tests.
- `apps/desktop/src/main/model/semantic-prompt.ts` — one versioned semantic prompt and JSON schema.
- `apps/desktop/src/main/model/model-gateway.ts` — provider selection, per-attempt tracing, fallback, and active status.
- `apps/desktop/test/model-gateway.test.ts` — fallback and trace middleware tests.
- `apps/desktop/src/renderer/components/ModelTracePanel.tsx` — trace list and expanded detail UI.

**Modify**

- `packages/protocol/src/index.ts` — export model contracts.
- `packages/protocol/src/semantic.ts` — add non-terminal `trace_write_failed`.
- `packages/storage/src/index.ts` — export `ModelTraceStore`.
- `packages/storage/src/capture-audit-store.ts` — treat `trace_write_failed` as non-terminal.
- `apps/desktop/src/main/semantic/semantic-classifier.ts` — provider attempt result contract.
- `apps/desktop/src/main/semantic/qwen-provider.ts` — use shared prompt and expose raw output/token meter delta.
- `apps/desktop/test/qwen-provider.test.ts` — verify trace input and runtime-measured usage.
- `native/foundation-model-helper/main.swift` — accept supplied prompts and return visible JSON.
- `apps/desktop/src/main/semantic/apple-foundation-provider.ts` — expose a provider attempt result.
- `apps/desktop/test/apple-foundation-provider.test.ts` — verify opaque system prompt and unavailable usage.
- `apps/desktop/src/main/semantic/semantic-coordinator.ts` — use gateway as the classification service without changing route rules.
- `apps/desktop/test/semantic-coordinator.test.ts` — preserve current routing behavior.
- `apps/desktop/src/main/index.ts` — assemble trace store and gateway; remove old registry.
- `apps/desktop/src/shared/renderer-api.ts` — explicit trace list/delete/clear/toggle API.
- `apps/desktop/src/main/ipc.ts` — validate trace commands.
- `apps/desktop/src/preload/index.ts` — expose trace commands.
- `apps/desktop/test/ipc.test.ts` — IPC allowlist and validation tests.
- `apps/desktop/src/renderer/components/SettingsPanel.tsx` — mount trace panel.
- `apps/desktop/src/renderer/styles.css` — compact trace layout.
- `apps/desktop/test/App.test.tsx` — trace interactions.
- `apps/desktop/test/accessibility.test.tsx` — trace controls and details.
- `apps/desktop/src/renderer/preview-api.ts` — preview fixtures.
- `docs/semantic-recognition.md` — distinguish content-free audit receipts from content-bearing traces.

**Delete after replacement**

- `apps/desktop/src/main/semantic/provider-registry.ts`
- `apps/desktop/test/provider-registry.test.ts`

### Task 1: Add provider-neutral model and trace contracts

**Files:**

- Create: `packages/protocol/src/model.ts`
- Create: `packages/protocol/test/model.test.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/protocol/src/semantic.ts`

- [ ] **Step 1: Write failing protocol tests**

Create `packages/protocol/test/model.test.ts` with these cases:

```ts
import { describe, expect, it } from "vitest";

import {
  modelInvocationTraceSchema,
  normalizedTokenUsageSchema,
  structuredGenerationRequestSchema,
} from "../src/model.js";

describe("model protocol", () => {
  it("accepts a successful semantic model attempt with partial usage", () => {
    expect(
      modelInvocationTraceSchema.parse({
        version: 1,
        traceId: "trace-1",
        requestId: "request-1",
        attemptId: "attempt-1",
        attemptIndex: 0,
        purpose: "semantic-classification",
        profile: {
          profileId: "qwen",
          backend: "qwen",
          provider: "qwen",
          model: "qwen3.5-2b-q4-k-m",
          promptVersion: "semantic-v1",
          schemaVersion: "semantic-classification-v1",
        },
        input: {
          systemPrompt: "Classify without reasoning.",
          userPrompt: "Assistant: choose A or B. User: A.",
          outputSchema: { type: "object" },
          clientSystemPromptVisibility: "visible",
        },
        output: {
          visibleText: "{\"decisionIntent\":\"decision\"}",
          parsed: { decisionIntent: "decision" },
        },
        usage: {
          source: "runtime_measured",
          inputTokens: 40,
          outputTokens: 8,
          totalTokens: 48,
        },
        timing: {
          queuedMs: 0,
          providerMs: 31,
          totalMs: 31,
        },
        status: "succeeded",
        createdAt: "2026-07-30T00:00:00.000Z",
        expiresAt: "2026-08-06T00:00:00.000Z",
      }),
    ).toMatchObject({ status: "succeeded" });
  });

  it("keeps unavailable token usage explicit", () => {
    expect(
      normalizedTokenUsageSchema.parse({ source: "unavailable" }),
    ).toEqual({ source: "unavailable" });
  });

  it("rejects negative tokens and expiry before creation", () => {
    expect(() =>
      normalizedTokenUsageSchema.parse({
        source: "provider_reported",
        inputTokens: -1,
      }),
    ).toThrow();
    expect(() =>
      modelInvocationTraceSchema.parse({
        version: 1,
        traceId: "trace-1",
        requestId: "request-1",
        attemptId: "attempt-1",
        attemptIndex: 0,
        purpose: "semantic-classification",
        profile: {
          profileId: "apple",
          backend: "apple",
          provider: "apple",
          model: "system-language-model",
          promptVersion: "semantic-v1",
          schemaVersion: "semantic-classification-v1",
        },
        input: {
          systemPrompt: "x",
          userPrompt: "y",
          outputSchema: { type: "object" },
          clientSystemPromptVisibility: "visible",
        },
        usage: { source: "unavailable" },
        timing: { queuedMs: 0, providerMs: 1, totalMs: 1 },
        status: "failed",
        createdAt: "2026-07-30T00:00:00.000Z",
        expiresAt: "2026-07-29T00:00:00.000Z",
      }),
    ).toThrow(/expiry/u);
  });

  it("bounds semantic prompts before they cross a provider boundary", () => {
    expect(() =>
      structuredGenerationRequestSchema.parse({
        requestId: "request-1",
        purpose: "semantic-classification",
        promptVersion: "semantic-v1",
        schemaVersion: "semantic-classification-v1",
        locale: "zh-CN",
        systemPrompt: "x",
        userPrompt: "x".repeat(20_001),
        outputSchema: { type: "object" },
        maxOutputTokens: 256,
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run the protocol test and verify RED**

Run:

```bash
npx vitest run packages/protocol/test/model.test.ts
```

Expected: FAIL because `packages/protocol/src/model.ts` does not exist.

- [ ] **Step 3: Implement the schemas and exports**

Create `packages/protocol/src/model.ts` with bounded Zod schemas for:

```ts
export const MODEL_TRACE_VERSION = 1 as const;

export const modelPurposeSchema = z.enum([
  "semantic-classification",
  "provider-health-check",
  "methodology-extraction",
  "skill-drafting",
  "workflow-drafting",
]);

export const modelBackendKindSchema = z.enum([
  "apple",
  "qwen",
  "openai",
  "anthropic",
  "openai-compatible",
  "codex-cli",
  "claude-code-cli",
]);

export const normalizedTokenUsageSchema = z
  .object({
    source: z.enum([
      "provider_reported",
      "runtime_measured",
      "estimated",
      "unavailable",
    ]),
    inputTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    reasoningOutputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
  })
  .strict();

export const modelTimingSchema = z
  .object({
    queuedMs: z.number().int().nonnegative().max(120_000),
    providerMs: z.number().int().nonnegative().max(120_000),
    firstOutputMs: z.number().int().nonnegative().max(120_000).optional(),
    totalMs: z.number().int().nonnegative().max(120_000),
  })
  .strict();
```

Add strict schemas and inferred types for `StructuredGenerationRequest`,
`ModelInvocationTrace`, `ModelTraceSummary`, `ModelInvocationErrorCode`, and
`ModelTraceContentMode`. Bound system/user prompts to 20,000 characters,
visible output to 20,000 characters, diagnostic excerpts to 2,000 characters,
and enforce `expiresAt > createdAt`.

Export every schema and inferred type from `packages/protocol/src/index.ts`.
Add `"trace_write_failed"` to `captureAuditErrorCodeSchema`.

- [ ] **Step 4: Run protocol tests and typecheck**

Run:

```bash
npx vitest run packages/protocol/test/model.test.ts packages/protocol/test/semantic.test.ts
npm run typecheck
```

Expected: both test files PASS and TypeScript reports no errors.

- [ ] **Step 5: Commit the contracts**

```bash
git add packages/protocol/src/model.ts packages/protocol/src/index.ts packages/protocol/src/semantic.ts packages/protocol/test/model.test.ts
git commit -m "feat: define model invocation trace protocol"
```

### Task 2: Add the private model trace store

**Files:**

- Create: `packages/storage/src/model-trace-store.ts`
- Create: `packages/storage/test/model-trace-store.test.ts`
- Modify: `packages/storage/src/index.ts`
- Modify: `packages/storage/src/capture-audit-store.ts`

- [ ] **Step 1: Write failing store tests**

Create tests that instantiate the store under `mkdtemp`, use a fixed clock and
ID factory, then prove all of these exact behaviors:

```ts
const store = new ModelTraceStore(join(root, "model-traces"), {
  now: () => now,
  idFactory: () => "trace-1",
  maximumItems: 2,
  maximumAgeMs: 7 * 24 * 60 * 60 * 1_000,
});

const saved = await store.record(successfulTraceInput());
expect(saved.traceId).toBe("trace-1");
expect(await store.list()).toEqual([saved]);
expect((await stat(join(root, "model-traces"))).mode & 0o777).toBe(0o700);
const traceFiles = (await readdir(join(root, "model-traces"))).filter(
  (entry) => entry.endsWith(".json"),
);
expect(
  (await stat(join(root, "model-traces", traceFiles[0]!))).mode & 0o777,
).toBe(0o600);

await store.deleteTrace(saved.traceId);
expect(await store.list()).toEqual([]);

await store.record(successfulTraceInput({ requestId: "group-1" }));
await store.record(successfulTraceInput({ requestId: "group-1" }));
await store.deleteRequest("group-1");
expect(await store.list()).toEqual([]);

await store.record(successfulTraceInput());
await store.clear();
expect(await store.list()).toEqual([]);
```

Also test oldest-first overflow, seven-day expiry, corrupt JSON quarantine,
`contentMode: "metadata-only"` omitting `input` and `output`, and
`trace_write_failed` not incrementing `CaptureAuditSummary.failures`.

- [ ] **Step 2: Run the store tests and verify RED**

Run:

```bash
npx vitest run packages/storage/test/model-trace-store.test.ts packages/storage/test/capture-audit-store.test.ts
```

Expected: FAIL because `ModelTraceStore` is not exported.

- [ ] **Step 3: Implement atomic storage**

Implement `ModelTraceStore` using the same secure-directory, atomic temporary
file, quarantine, retention, and deterministic sorting pattern as
`CaptureAuditStore`. Its public surface is:

```ts
export interface ModelTraceStoreOptions {
  now?: () => Date;
  maximumItems?: number;
  maximumAgeMs?: number;
  idFactory?: () => string;
  contentMode?: () => "full" | "metadata-only";
}

export type ModelTraceRecordInput = Omit<
  ModelInvocationTrace,
  "version" | "traceId" | "createdAt" | "expiresAt"
>;

export class ModelTraceStore {
  constructor(path: string, options?: ModelTraceStoreOptions);
  record(input: ModelTraceRecordInput): Promise<ModelInvocationTrace>;
  list(): Promise<ModelInvocationTrace[]>;
  summary(): Promise<ModelTraceSummary>;
  deleteTrace(traceId: string): Promise<boolean>;
  deleteRequest(requestId: string): Promise<number>;
  clear(): Promise<number>;
}
```

File names are SHA-256 hashes of `traceId`; delete methods resolve targets by
validated stored records, never by interpolating caller input into paths.
Export the store from `packages/storage/src/index.ts` and add
`trace_write_failed` to `NON_TERMINAL_ERROR_CODES`.

- [ ] **Step 4: Run storage tests and typecheck**

Run:

```bash
npx vitest run packages/storage/test/model-trace-store.test.ts packages/storage/test/capture-audit-store.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit secure trace storage**

```bash
git add packages/storage/src/model-trace-store.ts packages/storage/src/index.ts packages/storage/src/capture-audit-store.ts packages/storage/test/model-trace-store.test.ts
git commit -m "feat: store private model invocation traces"
```

### Task 3: Make Qwen return auditable attempts and measured tokens

**Files:**

- Create: `apps/desktop/src/main/model/semantic-prompt.ts`
- Modify: `apps/desktop/src/main/semantic/semantic-classifier.ts`
- Modify: `apps/desktop/src/main/semantic/qwen-provider.ts`
- Modify: `apps/desktop/test/qwen-provider.test.ts`

- [ ] **Step 1: Write failing Qwen attempt tests**

Change the fake Qwen context to expose a token meter:

```ts
const tokenMeter = {
  getState: vi
    .fn()
    .mockReturnValueOnce({
      usedInputTokens: 10,
      usedOutputTokens: 2,
    })
    .mockReturnValueOnce({
      usedInputTokens: 52,
      usedOutputTokens: 14,
    }),
};
const context = {
  getSequence: vi.fn(() => sequence),
  tokenMeter,
  dispose: vi.fn(async () => undefined),
};
```

Assert `provider.invoke(input)` returns:

```ts
expect(attempt).toMatchObject({
  classification: validOutput,
  visibleOutput: expect.stringContaining("\"decisionIntent\""),
  traceInput: {
    systemPrompt: expect.stringContaining("Do not reveal chain-of-thought"),
    userPrompt: expect.stringContaining("<assistant_message>"),
    clientSystemPromptVisibility: "visible",
  },
  usage: {
    source: "runtime_measured",
    inputTokens: 42,
    outputTokens: 12,
    totalTokens: 54,
  },
});
```

- [ ] **Step 2: Run the Qwen test and verify RED**

Run:

```bash
npx vitest run apps/desktop/test/qwen-provider.test.ts
```

Expected: FAIL because `invoke` and trace metadata do not exist.

- [ ] **Step 3: Implement the shared prompt and attempt contract**

Move the current Qwen system prompt, JSON schema, tail/head bounds, and user
prompt builder into `apps/desktop/src/main/model/semantic-prompt.ts`. Export:

```ts
export const SEMANTIC_PROMPT_VERSION = "semantic-v1";
export const SEMANTIC_SCHEMA_VERSION = "semantic-classification-v1";
export const semanticSystemPrompt: string;
export const semanticOutputJsonSchema: Record<string, unknown>;
export const buildSemanticUserPrompt: (
  input: SemanticClassifierInput,
) => string;
```

In `semantic-classifier.ts`, define:

```ts
export interface SemanticProviderAttempt {
  classification: SemanticClassification;
  visibleOutput: string;
  traceInput: {
    systemPrompt: string;
    userPrompt: string;
    outputSchema: Record<string, unknown>;
    clientSystemPromptVisibility: "visible" | "opaque";
  };
  usage: NormalizedTokenUsage;
  providerDurationMs: number;
}

export interface SemanticClassifier {
  readonly id: "apple" | "qwen";
  status(): Promise<SemanticProviderStatus>;
  invoke(
    input: SemanticClassifierInput,
    signal?: AbortSignal,
  ): Promise<SemanticProviderAttempt>;
  close(): Promise<void>;
}
```

Replace Qwen `classify` with `invoke`. Capture token meter state immediately
before and after `session.prompt`, compute non-negative deltas, and return the
raw JSON string plus parsed classification. Keep queue serialization, timeout,
cancellation, model verification, history reset, and disposal unchanged.

- [ ] **Step 4: Run Qwen and semantic type tests**

Run:

```bash
npx vitest run apps/desktop/test/qwen-provider.test.ts packages/protocol/test/model.test.ts
npm run typecheck
```

Expected: PASS after tests and fake runtime use the new `invoke` contract.

- [ ] **Step 5: Commit Qwen observability**

```bash
git add apps/desktop/src/main/model/semantic-prompt.ts apps/desktop/src/main/semantic/semantic-classifier.ts apps/desktop/src/main/semantic/qwen-provider.ts apps/desktop/test/qwen-provider.test.ts
git commit -m "feat: expose qwen model attempt telemetry"
```

### Task 4: Make Apple Foundation Models return the submitted prompt and visible output

**Files:**

- Modify: `native/foundation-model-helper/main.swift`
- Modify: `apps/desktop/src/main/semantic/apple-foundation-provider.ts`
- Modify: `apps/desktop/test/apple-foundation-provider.test.ts`

- [ ] **Step 1: Write failing helper protocol tests**

Update the fake helper assertion so classify requests must contain the supplied
prompt fields and responses must return a visible JSON string:

```ts
expect(requests[0]).toMatchObject({
  operation: "classify",
  systemPrompt: expect.stringContaining("Classify whether"),
  userPrompt: expect.stringContaining("<assistant_message>"),
});
expect(attempt).toMatchObject({
  visibleOutput: expect.stringContaining("\"decisionIntent\""),
  traceInput: {
    clientSystemPromptVisibility: "visible",
  },
  usage: { source: "unavailable" },
});
```

Add a malformed `visibleOutput` test and keep existing timeout, crash circuit,
missing helper, and close tests.

- [ ] **Step 2: Run Apple tests and verify RED**

Run:

```bash
npx vitest run apps/desktop/test/apple-foundation-provider.test.ts
```

Expected: FAIL because the helper request/response schemas lack prompt and
visible-output fields.

- [ ] **Step 3: Implement the helper and provider attempt**

In Swift, replace `assistantText`, `userText`, and `locale` request fields with:

```swift
let systemPrompt: String?
let userPrompt: String?
let locale: String?
```

Create `LanguageModelSession(model: model, instructions: systemPrompt)`, call
`session.respond(to: userPrompt, schema: classificationSchema(), options: ...)`,
decode the structure, then encode that structure once as the visible JSON
string returned beside `classification`:

```swift
private struct ClassificationResponse: Encodable {
    let id: String
    let ok = true
    let visibleOutput: String
    let classification: ModelClassification
}
```

In TypeScript, validate `visibleOutput`, implement `invoke`, reuse the shared
semantic prompt/schema, and return `usage: { source: "unavailable" }`.

- [ ] **Step 4: Build helper and run Apple tests**

Run:

```bash
npm run build:foundation-helper
npx vitest run apps/desktop/test/apple-foundation-provider.test.ts apps/desktop/test/forge-config.test.ts
npm run typecheck
```

Expected: helper builds, tests PASS, typecheck PASS.

- [ ] **Step 5: Commit Apple observability**

```bash
git add native/foundation-model-helper/main.swift apps/desktop/src/main/semantic/apple-foundation-provider.ts apps/desktop/test/apple-foundation-provider.test.ts
git commit -m "feat: expose apple model attempt telemetry"
```

### Task 5: Replace the provider registry with the traced gateway

**Files:**

- Create: `apps/desktop/src/main/model/model-gateway.ts`
- Create: `apps/desktop/test/model-gateway.test.ts`
- Modify: `apps/desktop/src/main/semantic/semantic-coordinator.ts`
- Modify: `apps/desktop/test/semantic-coordinator.test.ts`
- Delete: `apps/desktop/src/main/semantic/provider-registry.ts`
- Delete: `apps/desktop/test/provider-registry.test.ts`

- [ ] **Step 1: Write failing gateway tests**

Use fake Apple/Qwen providers and a fake trace store. Prove:

```ts
await expect(gateway.classify(input)).resolves.toEqual(
  qwenAttempt.classification,
);
expect(traceInputs).toEqual([
  expect.objectContaining({
    attemptIndex: 0,
    profile: expect.objectContaining({ backend: "apple" }),
    status: "failed",
    errorCode: "provider_unavailable",
  }),
  expect.objectContaining({
    attemptIndex: 1,
    profile: expect.objectContaining({ backend: "qwen" }),
    status: "succeeded",
    output: expect.objectContaining({
      visibleText: qwenAttempt.visibleOutput,
    }),
  }),
]);
```

Also prove Apple is selected without instantiating Qwen, both failures return a
stable `provider_unavailable`, trace write failure records non-terminal audit
without changing a successful classification, status includes audit counts,
runtime failures retry after 30 seconds, and close disposes every instantiated
provider once.

- [ ] **Step 2: Run gateway tests and verify RED**

Run:

```bash
npx vitest run apps/desktop/test/model-gateway.test.ts
```

Expected: FAIL because `StructuredModelGateway` does not exist.

- [ ] **Step 3: Implement gateway and preserve semantic routing**

Implement `StructuredModelGateway` as the single
`SemanticClassificationService`. It receives provider factories, `ModelTraceStore`,
`CaptureAuditStore`, `now`, and `idFactory`. For each actual provider invocation:

```ts
const startedAt = performance.now();
try {
  const attempt = await provider.invoke(input, signal);
  await recordTrace({
    requestId,
    attemptId,
    attemptIndex,
    purpose: "semantic-classification",
    profile: profileFor(provider, attempt),
    input: attempt.traceInput,
    output: {
      visibleText: attempt.visibleOutput,
      parsed: attempt.classification,
    },
    usage: attempt.usage,
    timing: {
      queuedMs: 0,
      providerMs: attempt.providerDurationMs,
      totalMs: Math.round(performance.now() - startedAt),
    },
    status: "succeeded",
  });
  return attempt.classification;
} catch (error) {
  await recordFailedTrace(error);
}
```

Trace persistence is best-effort. On failure, record
`trace_write_failed` through content-free audit only when the semantic input
has correlation data. Keep the current Apple→Qwen selection, one fallback,
30-second runtime retry, status labels, and audit summary behavior.

`SemanticDecisionCoordinator` continues to accept
`SemanticClassificationService`; only test fakes change from old provider
objects to a service with `classify` and optional `close`.

- [ ] **Step 4: Run gateway and semantic regression tests**

Run:

```bash
npx vitest run apps/desktop/test/model-gateway.test.ts apps/desktop/test/semantic-coordinator.test.ts
npm run typecheck
```

Expected: PASS with unchanged high/medium/low routing assertions.

- [ ] **Step 5: Delete the registry and commit replacement**

```bash
git rm apps/desktop/src/main/semantic/provider-registry.ts apps/desktop/test/provider-registry.test.ts
git add apps/desktop/src/main/model/model-gateway.ts apps/desktop/test/model-gateway.test.ts apps/desktop/src/main/semantic/semantic-coordinator.ts apps/desktop/test/semantic-coordinator.test.ts
git commit -m "feat: trace semantic model gateway attempts"
```

### Task 6: Assemble the trace store and gateway in Electron

**Files:**

- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/test/app-controller.test.ts`
- Modify: `apps/desktop/test/decision-flow.integration.test.ts`

- [ ] **Step 1: Write failing assembly/integration assertions**

Add an integration test with fake Apple unavailable and Qwen successful. After
processing one pair, assert a `ModelTraceStore` under the test user-data path
contains one failed Apple attempt and one successful Qwen attempt, while the
candidate/rationale outcome remains unchanged.

- [ ] **Step 2: Run the integration test and verify RED**

Run:

```bash
npx vitest run apps/desktop/test/decision-flow.integration.test.ts
```

Expected: FAIL because bootstrap does not create a model trace store.

- [ ] **Step 3: Wire production paths and lifecycle**

Extend `applicationSupportPaths()` with:

```ts
modelTraces: join(userData, "model-traces"),
```

Construct `ModelTraceStore`, pass it into `StructuredModelGateway`, pass the
gateway into `SemanticDecisionCoordinator`, and replace every
`semanticRegistry.status/refresh/close` reference with the gateway equivalent.
The shutdown chain must close coordinator/gateway exactly once.

- [ ] **Step 4: Run assembly regression tests**

Run:

```bash
npx vitest run apps/desktop/test/decision-flow.integration.test.ts apps/desktop/test/app-controller.test.ts apps/desktop/test/semantic-coordinator.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit production assembly**

```bash
git add apps/desktop/src/main/index.ts apps/desktop/test/app-controller.test.ts apps/desktop/test/decision-flow.integration.test.ts
git commit -m "feat: assemble traced semantic gateway"
```

### Task 7: Add safe trace IPC and preload methods

**Files:**

- Modify: `apps/desktop/src/shared/renderer-api.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/test/ipc.test.ts`

- [ ] **Step 1: Write failing IPC tests**

Extend the exact renderer allowlist with:

```ts
"listModelTraces",
"deleteModelTrace",
"deleteModelTraceRequest",
"clearModelTraces",
"setModelTraceContentEnabled",
```

Assert valid trace IDs/request IDs reach operations, IDs over 200 characters
are rejected, the toggle only accepts booleans, and clear returns the removed
count.

- [ ] **Step 2: Run IPC tests and verify RED**

Run:

```bash
npx vitest run apps/desktop/test/ipc.test.ts
```

Expected: FAIL because channels and methods are absent.

- [ ] **Step 3: Implement explicit trace operations**

Add matching `IPC_CHANNELS`, `DecisionApi` methods, preload invocations,
and `DecisionIpcOperations`. Validate IDs with
`z.string().min(1).max(200)` and the toggle with `z.boolean()`.

In main assembly, operations call `ModelTraceStore.list`, `deleteTrace`,
`deleteRequest`, and `clear`. Store the trace-content toggle in App Settings v3:

```ts
{
  version: 3,
  vaultPath,
  theme,
  modelTraceContentEnabled: true,
}
```

Add v1/v2→v3 migrations and a `withModelTraceContentEnabled` helper. The store
reads the current setting through a callback; disabling affects new traces and
does not mutate existing traces.

- [ ] **Step 4: Run IPC/settings tests and typecheck**

Run:

```bash
npx vitest run apps/desktop/test/ipc.test.ts apps/desktop/test/settings.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit trace control API**

```bash
git add apps/desktop/src/shared/renderer-api.ts apps/desktop/src/main/ipc.ts apps/desktop/src/preload/index.ts apps/desktop/src/main/index.ts apps/desktop/src/main/settings.ts apps/desktop/test/ipc.test.ts apps/desktop/test/settings.test.ts
git commit -m "feat: expose private model trace controls"
```

### Task 8: Add the model trace viewer

**Files:**

- Create: `apps/desktop/src/renderer/components/ModelTracePanel.tsx`
- Modify: `apps/desktop/src/renderer/components/SettingsPanel.tsx`
- Modify: `apps/desktop/src/renderer/styles.css`
- Modify: `apps/desktop/test/App.test.tsx`
- Modify: `apps/desktop/test/accessibility.test.tsx`
- Modify: `apps/desktop/src/renderer/preview-api.ts`

- [ ] **Step 1: Write failing UI and accessibility tests**

Render settings with two traces. Assert:

```ts
expect(
  await screen.findByRole("heading", { name: "模型调用记录" }),
).toBeInTheDocument();
expect(screen.getByText("Qwen 本地模型")).toBeInTheDocument();
expect(screen.getByText("54 tokens")).toBeInTheDocument();

await user.click(screen.getByRole("button", { name: "查看调用详情" }));
expect(screen.getByText("模型输入")).toBeInTheDocument();
expect(screen.getByText("模型输出")).toBeInTheDocument();

await user.click(screen.getByRole("button", { name: "删除这条记录" }));
expect(api.deleteModelTrace).toHaveBeenCalledWith("trace-1");

await user.click(screen.getByRole("checkbox", { name: /记录模型输入和输出/u }));
expect(api.setModelTraceContentEnabled).toHaveBeenCalledWith(false);
```

Run axe/accessibility assertions for list, disclosure buttons, labeled
checkbox, delete confirmation, and scrollable preformatted content.

- [ ] **Step 2: Run UI tests and verify RED**

Run:

```bash
npx vitest run apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx
```

Expected: FAIL because the panel is absent.

- [ ] **Step 3: Implement compact trace UI**

`ModelTracePanel` loads traces only while settings are open, newest first. Each
row shows time, provider/model, status, total tokens or “Token 不可用”, and
total duration. A disclosure expands actual input, visible output, parsed JSON,
usage source, and sanitized error. Use `<pre>` with independent scrolling.

Buttons:

- “删除这条记录” calls `deleteModelTrace`;
- “删除本次调用” calls `deleteModelTraceRequest`;
- “清空记录” requires a second explicit confirmation click;
- checkbox “记录模型输入和输出” toggles only future content.

Use a compact settings card; do not change rationale/candidate window sizing.
After every mutation, reload the trace list and show a status message.

- [ ] **Step 4: Run UI tests, layout check, and typecheck**

Run:

```bash
npx vitest run apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx
npm run typecheck
npm run build
```

Expected: tests PASS, typecheck PASS, Electron package succeeds.

- [ ] **Step 5: Commit the trace viewer**

```bash
git add apps/desktop/src/renderer/components/ModelTracePanel.tsx apps/desktop/src/renderer/components/SettingsPanel.tsx apps/desktop/src/renderer/styles.css apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx apps/desktop/src/renderer/preview-api.ts
git commit -m "feat: add model invocation trace viewer"
```

### Task 9: Document and verify the tracing foundation

**Files:**

- Modify: `docs/semantic-recognition.md`

- [ ] **Step 1: Update user-facing diagnostics documentation**

Document exact paths, seven-day/1,000-attempt retention, full-vs-metadata mode,
Apple `unavailable` Token semantics, Qwen runtime-measured tokens, and deletion.
State explicitly that traces cover only Decision model calls and never
enter Obsidian or SQLite.

- [ ] **Step 2: Run the complete verification suite**

Run:

```bash
npm test
npm run typecheck
npm run evaluate:semantic
npm run build
npm run smoke
git diff --check
```

Expected:

- all test files PASS;
- semantic precision/recall gates PASS;
- typecheck and package build PASS;
- smoke exits 0;
- `git diff --check` has no output.

- [ ] **Step 3: Inspect completion evidence**

Verify with repository search:

```bash
rg -n "model-traces|ModelTraceStore|StructuredModelGateway|trace_write_failed" apps packages docs
rg -n "modelInvocationTrace|credential|Authorization" packages/storage/src/model-trace-store.ts apps/desktop/src/main/model
git status --short
```

Expected: one gateway/store implementation, no credential fields in traces,
and only the documentation file remains uncommitted.

- [ ] **Step 4: Commit documentation**

```bash
git add docs/semantic-recognition.md
git commit -m "docs: explain private model invocation traces"
```
