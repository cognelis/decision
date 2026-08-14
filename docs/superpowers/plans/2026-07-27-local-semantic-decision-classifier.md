# Local Semantic Decision Classifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reliably observe ordinary Claude Code and Codex decision exchanges without changing native behavior, classify bounded question/answer pairs with deterministic rules plus an on-device semantic model, and route uncertain or mixed cases into the existing candidate queue.

**Architecture:** Hooks only resolve bounded text, write privacy-safe stage receipts, atomically spool a same-session assistant/user pair, and return. The Electron main process consumes pairs asynchronously, runs the shared rule analyzer and the best available local provider (Apple Foundation Models first, managed Qwen3.5-2B second), validates model output, applies a conservative ensemble matrix, and hands high/medium results to the existing capture and candidate runtimes. Markdown remains the sole canonical record; every new spool, receipt, model result, and SQLite row is derived local state.

**Tech Stack:** TypeScript 7, Node.js 22, Electron 43, React 19, Zod 4, Vitest 4, Swift 6.3/FoundationModels, node-llama-cpp 3.19.1, Qwen3.5-2B Q4_K_M GGUF

---

## File map

- `packages/protocol/src/semantic.ts`: versioned pair, audit, classification, routing, and status schemas.
- `packages/core/src/text-decision-analyzer.ts`: existing deterministic analyzer moved into a shared pure module.
- `packages/core/src/semantic-router.ts`: model-output validation and conservative joint routing.
- `packages/storage/src/semantic-pair-spool.ts`: private atomic pair persistence, recovery, expiry, and acknowledgement.
- `packages/storage/src/capture-audit-store.ts`: content-free HMAC stage receipts, retention, and aggregate diagnostics.
- `apps/bridge/src/text-capture-store.ts`: version-3 raw assistant pending turn.
- `apps/bridge/src/text-fallback.ts`: passive observer that forms pairs instead of classifying user answers.
- `apps/bridge/src/cli.ts`: silent pair persistence/delivery and best-effort audit recording.
- `apps/bridge/src/runtime-client.ts`: authenticated semantic-pair delivery.
- `apps/desktop/src/main/semantic/`: provider lifecycle, validation, ensemble coordinator, and status.
- `native/foundation-model-helper/main.swift`: private JSON-lines Apple Foundation Models helper.
- `scripts/build-foundation-model-helper.sh`: deterministic helper compilation.
- `apps/desktop/assets/models/qwen3.5-2b-q4-k-m.json`: immutable model manifest.
- `scripts/prepare-local-model.mjs`: explicit resumable model download and SHA-256 verification.
- `apps/desktop/src/shared/renderer-api.ts`: read-only semantic diagnostics in snapshots.
- `apps/desktop/src/renderer/components/SettingsPanel.tsx`: semantic status card.
- `scripts/evaluate-semantic-classifier.mjs`: reproducible corpus metrics.
- `apps/desktop/test/fixtures/semantic-evaluation.json`: labelled regression corpus including the field failure.

### Task 1: Define versioned semantic contracts

**Files:**
- Create: `packages/protocol/src/semantic.ts`
- Modify: `packages/protocol/src/index.ts`
- Create: `packages/protocol/test/semantic.test.ts`

- [x] **Step 1: Write failing protocol tests**

Cover all strict boundaries:

```ts
expect(semanticDecisionPairSchema.parse(pair)).toMatchObject({
  version: 1,
  assistantText: expect.any(String),
  userText: expect.any(String),
});
expect(() =>
  semanticDecisionPairSchema.parse({
    ...pair,
    assistantText: "x".repeat(8_001),
  }),
).toThrow();
expect(Object.keys(captureAuditReceiptSchema.parse(receipt))).not.toContain(
  "sessionId",
);
expect(
  semanticClassificationSchema.parse({
    decisionIntent: "decision",
    answerRelation: "mixed",
    question: "先处理技术债还是提交？",
    optionLabels: ["处理技术债", "先提交"],
    answerExcerpt: "本次引入的需要处理",
    confidence: 0.91,
    provider: "qwen",
    modelVersion: "qwen3.5-2b-q4-k-m",
    promptVersion: "semantic-v1",
  }),
).toBeTruthy();
```

- [x] **Step 2: Run the test and verify RED**

Run `npm test -- packages/protocol/test/semantic.test.ts`.

Expected: FAIL because `semantic.ts` and its exports do not exist.

- [x] **Step 3: Implement strict schemas**

Export:

```ts
export const SEMANTIC_PAIR_VERSION = 1 as const;
export const CAPTURE_AUDIT_VERSION = 1 as const;
export const semanticBandSchema = z.enum(["high", "medium", "low"]);
export const semanticDecisionPairSchema = z.object({
  version: z.literal(SEMANTIC_PAIR_VERSION),
  pairId: bounded(200),
  sourceClient: z.enum(["claude-code", "codex"]),
  sessionId: bounded(500),
  assistantTurnId: bounded(500).optional(),
  userTurnId: bounded(500).optional(),
  cwd: bounded(2_000),
  assistantText: bounded(8_000),
  userText: bounded(2_000),
  capturedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();
```

Add the complete receipt stage/error enums from the design, `SemanticClassification`,
`SemanticRouteDecision`, and `SemanticRecognitionStatus`. Use `.strict()` for every
object, confidence `0..1`, at most eight option labels, and at most 4,000/2,000
characters for question/answer excerpts.

- [x] **Step 4: Run the test and verify GREEN**

Run `npm test -- packages/protocol/test/semantic.test.ts`.

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "feat: define semantic capture contracts"
```

### Task 2: Add private stage receipts

**Files:**
- Create: `packages/storage/src/capture-audit-store.ts`
- Modify: `packages/storage/src/index.ts`
- Create: `packages/storage/test/capture-audit-store.test.ts`

- [x] **Step 1: Write failing privacy and retention tests**

Test a fixed salt and clock:

```ts
await store.record({
  sourceClient: "codex",
  sessionId: "raw-session",
  turnId: "raw-turn",
  stage: "pair_spooled",
  durationMs: 12,
});
const [receipt] = await store.list();
expect(receipt.sessionFingerprint).toMatch(/^[a-f0-9]{64}$/);
expect(JSON.stringify(receipt)).not.toContain("raw-session");
expect(JSON.stringify(receipt)).not.toContain("raw-turn");
expect(JSON.stringify(receipt)).not.toContain("/Users/");
```

Also assert directory mode `0700`, file/salt mode `0600`, seven-day expiry,
5,000-item cap, stable HMAC fingerprints, corrupt-item quarantine, and aggregate
counts without business text.

- [x] **Step 2: Run the test and verify RED**

Run `npm test -- packages/storage/test/capture-audit-store.test.ts`.

Expected: FAIL because `CaptureAuditStore` is missing.

- [x] **Step 3: Implement one-file-per-receipt atomic storage**

Use `mkdir(..., { mode: 0o700 })`, `randomUUID()`, `writeFile(..., {
mode: 0o600, flag: "wx" })`, and `rename`. Generate `salt` once with 32 random
bytes. Fingerprint IDs with:

```ts
createHmac("sha256", salt).update(rawId, "utf8").digest("hex");
```

`record()` must accept raw IDs only transiently, construct the protocol receipt,
never serialize raw IDs, and swallow only cleanup errors. `list()` validates every
receipt, removes expired entries, quarantines corrupt entries, sorts by time, and
trims oldest entries above 5,000. `summary()` returns counts by stage/error/band.

- [x] **Step 4: Run the test and verify GREEN**

Run `npm test -- packages/storage/test/capture-audit-store.test.ts`.

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/storage
git commit -m "feat: record privacy-safe capture stages"
```

### Task 3: Add the recoverable semantic-pair spool

**Files:**
- Create: `packages/storage/src/semantic-pair-spool.ts`
- Modify: `packages/storage/src/index.ts`
- Create: `packages/storage/test/semantic-pair-spool.test.ts`

- [x] **Step 1: Write failing durability tests**

Cover append/list/acknowledge/idempotence, `0700`/`0600`, concurrent atomic writes,
24-hour incomplete cleanup delegated to the bridge store, seven-day completed pair
expiry, 5,000-pair cap, corrupt quarantine, and keeping a pair after a consumer
throws.

```ts
await spool.append(pair);
expect(await spool.list()).toEqual([pair]);
await expect(spool.append(pair)).resolves.toEqual("duplicate");
await spool.acknowledge(pair.pairId);
expect(await spool.list()).toEqual([]);
```

- [x] **Step 2: Run the test and verify RED**

Run `npm test -- packages/storage/test/semantic-pair-spool.test.ts`.

Expected: FAIL because `SemanticPairSpool` is missing.

- [x] **Step 3: Implement the spool**

Store validated pairs at `<sha256(pairId)>.json`; create acknowledgement receipts
at `receipts/<sha256(pairId)>.json`; write through a unique temporary file and
rename. `append()` returns `"accepted" | "duplicate"`, `list()` never claims or
deletes valid pairs, and `acknowledge()` writes the receipt before deleting the
body. Only `acknowledge()` or expiry may remove pair text.

- [x] **Step 4: Run the test and verify GREEN**

Run `npm test -- packages/storage/test/semantic-pair-spool.test.ts`.

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/storage
git commit -m "feat: spool semantic decision pairs"
```

### Task 4: Share the deterministic analyzer and conservative router

**Files:**
- Move: `apps/bridge/src/text-decision-analyzer.ts` to `packages/core/src/text-decision-analyzer.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/src/semantic-router.ts`
- Move: `apps/bridge/test/text-decision-analyzer.test.ts` to `packages/core/test/text-decision-analyzer.test.ts`
- Create: `packages/core/test/semantic-router.test.ts`
- Modify: bridge imports referring to the analyzer

- [x] **Step 1: Write failing router tests**

Use a table test for every route:

```ts
it.each([
  ["high", "high", "high"],
  ["high", "low", "medium"],
  ["medium", "high", "medium"],
  ["low", "high", "medium"],
  ["low", "low", "low"],
  ["high", "unavailable", "high"],
])("routes rule %s and model %s to %s", (rule, model, expected) => {
  expect(routeSemanticDecision({ ruleBand: rule, modelBand: model }))
    .toMatchObject({ finalBand: expected });
});
```

Add tests that recovered pairs older than 15 minutes are capped at medium, a
`mixed` relation is never dropped below medium when the model found an answer,
and model-proposed excerpts/options are rejected unless exact substrings of the
source pair.

- [x] **Step 2: Run moved analyzer plus router tests and verify RED**

Run:

```bash
npm test -- packages/core/test/text-decision-analyzer.test.ts packages/core/test/semantic-router.test.ts
```

Expected: analyzer import or router export fails.

- [x] **Step 3: Move the analyzer without behavior changes**

Preserve `rules-v1` output byte-for-byte. Export `TextDecisionAnalyzer`,
`PendingDecisionAnalysis`, and completed analysis types from core. Update bridge
imports only; do not change thresholds in this task.

- [x] **Step 4: Implement output validation and joint routing**

`validateSemanticClassification(pair, output)` must enforce enums/lengths,
provider metadata, confidence, and source-substring checks. Invalid optional
extractions become `null`/`[]`; invalid structural output makes the provider
unavailable. `routeSemanticDecision()` implements the design table and adds
signals `semantic_agreement`, `semantic_disagreement`, `semantic_mixed`, and
`stale_recovery_cap`.

- [x] **Step 5: Run tests and verify GREEN**

Run the Task 4 command plus `npm test -- apps/bridge/test`.

Expected: PASS with unchanged `rules-v1` fixtures.

- [x] **Step 6: Commit**

```bash
git add packages/core apps/bridge
git commit -m "refactor: share text decision analysis"
```

### Task 5: Make Hooks form pairs without semantic work

**Files:**
- Modify: `apps/bridge/src/text-capture-store.ts`
- Modify: `apps/bridge/src/text-fallback.ts`
- Modify: `apps/bridge/src/cli.ts`
- Modify: `apps/bridge/test/text-fallback.test.ts`
- Modify: `apps/bridge/test/hooks-cli.test.ts`

- [x] **Step 1: Write failing observer tests**

Assert that Stop saves any non-empty bounded assistant text even when rules return
`null`; UserPromptSubmit returns a `SemanticDecisionPair`, not a capture/candidate;
same-session matching is mandatory; one pending turn is consumed once; the long
field sample plus mixed answer is preserved; native structured events still
bypass pair classification; and all thrown store/runtime/audit errors return exit
code zero without writing hook stdout.

- [x] **Step 2: Run tests and verify RED**

Run:

```bash
npm test -- apps/bridge/test/text-fallback.test.ts apps/bridge/test/hooks-cli.test.ts
```

Expected: FAIL because the current fallback classifies and returns routed events.

- [x] **Step 3: Upgrade pending records to version 3**

Use:

```ts
interface PendingAssistantTurn {
  version: 3;
  sourceClient: "claude-code" | "codex";
  sessionId: string;
  turnId?: string;
  cwd: string;
  assistantText: string;
  capturedAt: string;
}
```

Retain readers for versions 1 and 2 so an upgrade does not strand existing
pending data. Convert legacy analysis to its question text. Enforce the 8,000
character limit and 24-hour expiry.

- [x] **Step 4: Refactor `TextCaptureFallback` into a pure observer**

`onStop()` continues returning native structured events and saves the raw bounded
assistant turn. `onUserPrompt()` builds a schema-validated pair with:

```ts
pairId = sha256(
  `${client}\0${sessionId}\0${pending.turnId ?? "stop"}\0${turnId ?? "prompt"}\0${assistantText}\0${userText}`,
);
expiresAt = new Date(capturedAt.getTime() + 7 * DAY_MS).toISOString();
```

It must not call `TextDecisionAnalyzer`, write Markdown/SQLite, or return a
capture/candidate.

- [x] **Step 5: Persist pair then deliver best-effort**

Inject `SemanticPairSpoolLike`, `CaptureAuditStoreLike`, and runtime
`deliverSemanticPair()`. Record the stages `hook_received`,
`assistant_text_resolved`, `pending_saved`, `user_prompt_matched`, and
`pair_spooled`; stable error codes are recorded best-effort. Append to disk before
HTTP delivery. Never launch the app from passive text delivery.

- [x] **Step 6: Run tests and verify GREEN**

Run the Task 5 tests and `npm test -- apps/bridge/test`.

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add apps/bridge
git commit -m "feat: observe and spool text decision pairs"
```

### Task 6: Deliver pairs to the desktop and recover them on startup

**Files:**
- Modify: `apps/bridge/src/runtime-client.ts`
- Modify: `apps/bridge/test/runtime-client.test.ts`
- Modify: `apps/desktop/src/main/local-server.ts`
- Modify: `apps/desktop/test/local-server.test.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/test/recovery.integration.test.ts`

- [x] **Step 1: Write failing transport tests**

Assert `POST /v1/semantic-pairs` requires the bearer token, rejects unknown
fields/oversize bodies, returns `{ accepted: true }`, and `RuntimeClient` never
launches the app when runtime state is absent. Add a startup test proving existing
pair-spool items are passed to a consumer and acknowledged only after it succeeds.

- [x] **Step 2: Run tests and verify RED**

Run:

```bash
npm test -- apps/bridge/test/runtime-client.test.ts apps/desktop/test/local-server.test.ts apps/desktop/test/recovery.integration.test.ts
```

Expected: endpoint and client method are missing.

- [x] **Step 3: Implement authenticated delivery**

Add `deliverSemanticPair(pair): Promise<boolean>` using the same runtime
descriptor and 750 ms timeout as candidate delivery, but do not call
`launchApplication()`. Add `ingestSemanticPair` to `LocalCaptureServerOptions`;
parse only with `semanticDecisionPairSchema`.

- [x] **Step 4: Wire durable recovery**

Create the pair spool in application support, list on startup, and feed each item
to a temporary injected consumer. Keep items on failure; acknowledgement belongs
to the semantic coordinator added later. Keep server start independent of model
initialization.

- [x] **Step 5: Run tests and verify GREEN**

Run the Task 6 command.

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add apps/bridge apps/desktop
git commit -m "feat: deliver semantic pairs to desktop"
```

### Task 7: Build the semantic coordinator with unavailable-provider fallback

**Files:**
- Create: `apps/desktop/src/main/semantic/semantic-classifier.ts`
- Create: `apps/desktop/src/main/semantic/semantic-coordinator.ts`
- Create: `apps/desktop/test/semantic-coordinator.test.ts`
- Modify: `apps/desktop/src/main/index.ts`

- [x] **Step 1: Write failing coordinator tests**

Inject fake rule/model classifiers and runtime sinks. Cover high agreement,
disagreement to candidate, low agreement drop, model unavailable uses rules,
mixed answer to medium, stale recovery cap, timeout, invalid model JSON,
acknowledge only after route persistence, duplicate pair idempotence, and audit
stages `classification_completed`/`routed`/`failed`.

- [x] **Step 2: Run tests and verify RED**

Run `npm test -- apps/desktop/test/semantic-coordinator.test.ts`.

Expected: coordinator module is missing.

- [x] **Step 3: Define the provider boundary**

Use:

```ts
export interface SemanticClassifier {
  readonly id: "apple" | "qwen";
  status(): Promise<SemanticProviderStatus>;
  classify(
    input: SemanticClassifierInput,
    signal?: AbortSignal,
  ): Promise<SemanticClassification>;
  close(): Promise<void>;
}
```

`SemanticClassifierInput` contains only pair id, bounded assistant text, bounded
user text, and locale. It never includes cwd, session/turn IDs, transcript path,
or full history.

- [x] **Step 4: Implement coordinator routing**

Run the shared rule analyzer synchronously, call the selected model with a
5-second timeout asynchronously, validate the result, apply the joint router,
convert the chosen question/answer/context into the existing event schema, and
call `CaptureRuntime.ingest()` or `ingestCandidate()`. Low results are simply
acknowledged after the routed receipt. Keep full original `userText` as the formal
answer even when a validated answer excerpt exists.

- [x] **Step 5: Run tests and verify GREEN**

Run the Task 7 test plus existing capture runtime tests.

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add apps/desktop
git commit -m "feat: coordinate semantic decision routing"
```

### Task 8: Add the Apple Foundation Models helper and provider

**Files:**
- Create: `native/foundation-model-helper/main.swift`
- Create: `scripts/build-foundation-model-helper.sh`
- Create: `apps/desktop/src/main/semantic/apple-foundation-provider.ts`
- Create: `apps/desktop/test/apple-foundation-provider.test.ts`
- Modify: `package.json`

- [x] **Step 1: Write failing provider protocol tests**

Inject a fake child process. Assert one JSON line request maps by request ID to one
response; `status` distinguishes available, device-not-eligible, Apple
Intelligence disabled, assets unavailable, and helper missing; malformed stdout
does not crash Electron; timeout/cancel kills only the pending request; three
consecutive crashes open a process-lifetime circuit breaker; `close()` leaves no
child.

- [x] **Step 2: Run test and verify RED**

Run `npm test -- apps/desktop/test/apple-foundation-provider.test.ts`.

Expected: provider is missing.

- [x] **Step 3: Implement the Swift JSON-lines helper**

Compile for `arm64-apple-macosx26.0`. Use `SystemLanguageModel.default`,
`LanguageModelSession`, `@Generable`, and greedy `GenerationOptions`. Support:

```json
{"id":"1","operation":"status"}
{"id":"2","operation":"classify","assistantText":"...","userText":"...","locale":"zh-CN"}
```

Responses contain only id/status or the fixed semantic fields; never emit logs on
stdout. Diagnostics go to stderr without input text. The prompt explicitly
defines decision/approval/information/self-resolved/none and
answers/mixed/new-task/uncertain, prohibits chain-of-thought, and requests only
the generated structure.

- [x] **Step 4: Implement and build the Node provider**

Resolve the helper from `process.resourcesPath`, spawn with `stdio:
["pipe", "pipe", "pipe"]`, frame by newline, cap each line at 32 KiB, validate
with protocol schemas, apply a 5-second timeout, and surface stable unavailable
codes. Add `npm run build:foundation-helper`.

- [x] **Step 5: Run tests and verify the real availability probe**

Run:

```bash
npm test -- apps/desktop/test/apple-foundation-provider.test.ts
npm run build:foundation-helper
printf '{"id":"1","operation":"status"}\n' | dist/native/decision-foundation-model-helper
```

Expected on the current machine: tests PASS, helper compiles, and status reports
`device_not_eligible` without crashing.

- [x] **Step 6: Commit**

```bash
git add native scripts apps/desktop package.json
git commit -m "feat: add Apple semantic provider"
```

### Task 9: Add the managed Qwen runtime and immutable model manifest

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `package-lock.json`
- Create: `apps/desktop/assets/models/qwen3.5-2b-q4-k-m.json`
- Create: `apps/desktop/src/main/semantic/model-manifest.ts`
- Create: `apps/desktop/src/main/semantic/qwen-provider.ts`
- Create: `apps/desktop/test/model-manifest.test.ts`
- Create: `apps/desktop/test/qwen-provider.test.ts`

- [x] **Step 1: Install the pinned runtime**

Run:

```bash
npm install --workspace @cognelis/decision-desktop node-llama-cpp@3.19.1
```

Expected: lockfile pins 3.19.1 and license metadata remains MIT.

- [x] **Step 2: Write failing manifest/provider tests**

Assert the exact immutable manifest:

```json
{
  "id": "qwen3.5-2b-q4-k-m",
  "fileName": "Qwen_Qwen3.5-2B-Q4_K_M.gguf",
  "url": "https://huggingface.co/bartowski/Qwen_Qwen3.5-2B-GGUF/resolve/915a52556175c333102d04f996380950d35155d9/Qwen_Qwen3.5-2B-Q4_K_M.gguf",
  "bytes": 1329766560,
  "sha256": "84aeb7fe40e7b833d71303d7f1b9f9c1991b931b5dbd214e0aa48d56a0af1f85",
  "license": "Apache-2.0"
}
```

Mock `node-llama-cpp` and assert `getLlama({ build: "never", gpu: "auto",
skipDownload: true })`, one model/context/session, concurrency one, JSON-schema
grammar, deterministic temperature, bounded prompt, parsed structured output,
missing/checksum/timeout/invalid-output fallback, and resource disposal.

- [x] **Step 3: Run tests and verify RED**

Run:

```bash
npm test -- apps/desktop/test/model-manifest.test.ts apps/desktop/test/qwen-provider.test.ts
```

Expected: manifest/provider modules are missing.

- [x] **Step 4: Implement manifest verification**

Resolve the model only under
`<userData>/models/Qwen_Qwen3.5-2B-Q4_K_M.gguf`; reject symlinks and wrong
size/hash. Cache a successful verification by inode/size/mtime for this process,
never by path alone.

- [x] **Step 5: Implement Qwen classification**

Dynamic-import `node-llama-cpp` only from Electron main. Use a 4,096-token context,
one sequence, a JSON schema grammar, maximum 256 output tokens, temperature zero,
and the same `semantic-v1` definitions as Apple. Do not bind a socket or call
model-download APIs. Normalize output through the shared validator.

- [x] **Step 6: Run tests and verify GREEN**

Run the Task 9 test command and `npm run typecheck`.

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add apps/desktop package-lock.json
git commit -m "feat: add managed Qwen semantic provider"
```

### Task 10: Select the best local provider and expose stable status

**Files:**
- Create: `apps/desktop/src/main/semantic/provider-registry.ts`
- Create: `apps/desktop/test/provider-registry.test.ts`
- Modify: `apps/desktop/src/main/semantic/semantic-coordinator.ts`
- Modify: `apps/desktop/src/main/index.ts`

- [x] **Step 1: Write failing selection tests**

Assert Apple available wins; Apple unavailable chooses verified Qwen; neither
available uses rules; a runtime provider failure retries the other provider once;
both failures use rules; status includes provider, reason, mode, model/prompt
versions, processed/high/medium/failure counts; and closing the registry closes
every instantiated provider.

- [x] **Step 2: Run test and verify RED**

Run `npm test -- apps/desktop/test/provider-registry.test.ts`.

Expected: registry is missing.

- [x] **Step 3: Implement lazy provider selection**

Probe Apple quickly, do not load Qwen weights unless Apple is unavailable, and
cache the selected provider for the app lifetime. Keep `hybrid` as the active
mode: model-only positives and all disagreement go to medium; only rule/model
high agreement can directly route high; provider unavailable uses the exact
existing rule band.

- [x] **Step 4: Wire startup, delivery, recovery, and shutdown**

Create coordinator before starting the local server; let server delivery enqueue
without waiting for model inference; process one pair at a time; recover spool
oldest-first; and call registry/coordinator `close()` before Electron exits.

- [x] **Step 5: Run tests and verify GREEN**

Run:

```bash
npm test -- apps/desktop/test/provider-registry.test.ts apps/desktop/test/semantic-coordinator.test.ts apps/desktop/test/recovery.integration.test.ts
```

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add apps/desktop
git commit -m "feat: select on-device semantic provider"
```

### Task 11: Add explicit model preparation

**Files:**
- Create: `scripts/prepare-local-model.mjs`
- Create: `scripts/test/prepare-local-model.test.ts`
- Modify: `package.json`
- Modify: `.gitignore`

- [x] **Step 1: Write failing downloader tests**

Start a local HTTP fixture supporting range requests. Test fresh download,
resume from `.partial`, content-length mismatch, SHA mismatch, atomic rename,
existing verified file skip, redirect limit, HTTPS-only production URL, progress
callbacks, cleanup of invalid partials, and never writing inside the app bundle.

- [x] **Step 2: Run test and verify RED**

Run `npm test -- scripts/test/prepare-local-model.test.ts`.

Expected: script module is missing.

- [x] **Step 3: Implement explicit preparation**

Export `prepareLocalModel({ manifest, modelsDirectory, fetcher, onProgress })`.
Stream to a `0600` partial file, hash while downloading or during final verify,
require the exact byte count and SHA-256, then atomically rename. The CLI defaults
to the platform Application Support models directory and prints progress without
business data.

- [x] **Step 4: Run tests and verify GREEN**

Run the Task 11 test and `node scripts/prepare-local-model.mjs --check`.

Expected: tests PASS; check reports `missing` before provisioning and exits with a
documented nonzero code without downloading.

- [x] **Step 5: Commit**

```bash
git add scripts package.json .gitignore
git commit -m "feat: prepare verified local model"
```

### Task 12: Show semantic recognition diagnostics

**Files:**
- Modify: `apps/desktop/src/shared/renderer-api.ts`
- Modify: `apps/desktop/src/main/app-controller.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/renderer/components/SettingsPanel.tsx`
- Modify: `apps/desktop/src/renderer/styles.css`
- Modify: `apps/desktop/test/app-controller.test.ts`
- Modify: `apps/desktop/test/App.test.tsx`
- Modify: `apps/desktop/test/settings-layout.test.ts`

- [x] **Step 1: Write failing snapshot and UI tests**

Assert snapshots include:

```ts
semanticRecognition: {
  provider: "qwen",
  providerLabel: "Qwen 本地模型",
  availability: "available",
  mode: "hybrid",
  processed7d: 12,
  high7d: 4,
  medium7d: 3,
  failures7d: 0,
}
```

The settings card must render provider/availability/mode and four aggregate
counts, never question/answer/session/path text, and expose no threshold control.

- [x] **Step 2: Run tests and verify RED**

Run:

```bash
npm test -- apps/desktop/test/app-controller.test.ts apps/desktop/test/App.test.tsx apps/desktop/test/settings-layout.test.ts
```

Expected: snapshot property and card are missing.

- [x] **Step 3: Add read-only status to snapshots**

Inject `semanticRecognition()` into `AppController`, derive seven-day aggregate
counts from `CaptureAuditStore.summary()`, and refresh the snapshot when provider
status or routing counts change.

- [x] **Step 4: Add the compact settings card**

Render “语义识别” with Apple/Qwen/rules labels, a concise availability reason,
“混合模式”, and processed/candidate/direct/failure counts. Reuse existing glass
card density and health dots; do not add provider selection or confidence sliders.

- [x] **Step 5: Run tests and verify GREEN**

Run the Task 12 command.

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add apps/desktop
git commit -m "feat: show semantic recognition status"
```

### Task 13: Add a labelled regression corpus and evaluator

**Files:**
- Create: `apps/desktop/test/fixtures/semantic-evaluation.json`
- Create: `scripts/evaluate-semantic-classifier.mjs`
- Create: `scripts/test/evaluate-semantic-classifier.test.ts`
- Modify: `package.json`

- [x] **Step 1: Write failing metric tests**

Use a synthetic mini-corpus with known confusion counts and assert high precision,
high+medium recall, relation accuracy, extractability, per-language/source slices,
and nonzero exit when thresholds fail.

- [x] **Step 2: Run test and verify RED**

Run `npm test -- scripts/test/evaluate-semantic-classifier.test.ts`.

Expected: evaluator is missing.

- [x] **Step 3: Implement the evaluator**

The CLI reads JSON fixtures, runs rules plus an injected/provider-selected model,
and emits deterministic JSON and a human table. Thresholds are high precision
`>= 0.95` and high+medium recall `>= 0.90`; `--report-only` never fails the build.
Do not write model outputs back into the corpus.

- [x] **Step 4: Add the initial curated corpus**

Add at least 60 hand-labelled, fully synthetic or redacted samples covering
explicit choices, implicit approvals, information requests, self-resolved text,
logs/code/diffs, Chinese/English, Codex/Claude, answer paraphrases, and mixed
answers. Include the redacted field regression:

```json
{
  "id": "field-mixed-001",
  "assistantText": "两仓仍未提交。是先处理本次技术债，还是先提交当前这批？",
  "userText": "本次引入的需要处理。另外，为什么要拆成两个字段？",
  "expectedBand": "medium",
  "expectedRelation": "mixed"
}
```

Keep the product in disagreement-review behavior until 500 independently labelled
real/redacted turns exist and the held-out thresholds pass; do not fabricate 500
“real” examples.

- [x] **Step 5: Run tests and baseline report**

Run:

```bash
npm test -- scripts/test/evaluate-semantic-classifier.test.ts
npm run evaluate:semantic -- --report-only
```

Expected: evaluator tests PASS and the report records current metrics without
claiming activation thresholds unless actually reached.

- [x] **Step 6: Commit**

```bash
git add apps/desktop/test/fixtures scripts package.json
git commit -m "test: add semantic decision evaluation"
```

### Task 14: Package native resources and extend smoke coverage

**Files:**
- Modify: `forge.config.ts`
- Modify: `apps/desktop/vite.main.config.ts`
- Modify: `apps/desktop/test/forge-config.test.ts`
- Modify: `apps/desktop/test/vite-main-config.test.ts`
- Modify: `scripts/smoke.mjs`
- Modify: `package.json`

- [x] **Step 1: Write failing packaging tests**

Assert the helper and model manifest are `extraResource`; node-llama-cpp native
artifacts remain outside ASAR or are unpacked; the Vite main bundle externalizes
`node-llama-cpp`; and packaging scripts build the helper before Forge.

- [x] **Step 2: Run tests and verify RED**

Run:

```bash
npm test -- apps/desktop/test/forge-config.test.ts apps/desktop/test/vite-main-config.test.ts
```

Expected: resources and externalization are missing.

- [x] **Step 3: Update build/package configuration**

Make `build` and `make` call `build:foundation-helper`. Copy the helper and
manifest into `resources/semantic`; add the minimal ASAR unpack/native-module
configuration required by node-llama-cpp. Do not copy GGUF weights into `.app`.

- [x] **Step 4: Extend smoke**

Smoke must verify:

- Hook Stop and UserPromptSubmit exit zero with empty stdout;
- a raw assistant/user pair reaches the spool;
- the long mixed field regression reaches at least medium;
- provider-unavailable mode still follows rules;
- structured native capture remains unchanged;
- Markdown is written only after rationale submission;
- SQLite rebuilds from Markdown and is still treated as derived;
- packaged helper answers `status`;
- model weight is absent from the app bundle.

- [x] **Step 5: Run tests and smoke**

Run:

```bash
npm test -- apps/desktop/test/forge-config.test.ts apps/desktop/test/vite-main-config.test.ts
npm run build
npm run smoke
```

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add forge.config.ts apps/desktop scripts/smoke.mjs package.json
git commit -m "build: package local semantic runtime"
```

### Task 15: Update product and recovery documentation

**Files:**
- Modify: `README.md`
- Create: `docs/semantic-recognition.md`
- Modify: `docs/superpowers/specs/2026-07-27-local-semantic-decision-classifier-design.md`

- [x] **Step 1: Write the documentation**

Document passive Hooks explicitly: no MCP, no replacement of native questions,
no response injection. Explain pair/audit retention, Apple→Qwen→rules fallback,
the immutable model manifest/license, explicit 1.33 GB provisioning, diagnostics,
candidate review, evaluation thresholds, model removal, and recovery. Correct the
stale `420×72` and “two to four options” README claims to the current
560-pixel/two-preset behavior.

- [x] **Step 2: Verify documentation against commands**

Run every `--help`, `--check`, doctor, install dry-run, and evaluator command shown
in the docs. Search:

```bash
rg -n "420×72|2.?4 个|MCP.*Decision|Qwen 本地端点|TODO|TBD" \
  README.md \
  docs/semantic-recognition.md \
  docs/superpowers/specs/2026-07-27-local-semantic-decision-classifier-design.md
```

Expected: no stale product claims or placeholders.

- [x] **Step 3: Commit**

```bash
git add README.md docs scripts/prepare-local-model.mjs scripts/test/prepare-local-model.test.ts
git commit -m "docs: explain local semantic recognition"
```

### Task 16: Full verification, provision, install, and real end-to-end acceptance

**Files:**
- Modify only if a verification failure exposes a tested defect.

- [x] **Step 1: Run the complete verification suite**

Run:

```bash
npm test
npm run typecheck
npm run build:bridge
npm run build:foundation-helper
npm run build
npm run make
npm run smoke
```

Expected: every command exits zero; record exact test file/test counts.

- [x] **Step 2: Run privacy and behavior inspections**

Search built sources, packaged app, receipt files, and Hook output to verify:

- no MCP registration was reintroduced;
- no `ask_user_question`/`request_user_input` interception exists;
- audit receipts contain no raw session/turn IDs, cwd, question, or answer;
- no model call exists in bridge/Hook code;
- GGUF is not inside `.app`;
- no network listener is created for local model inference.

- [x] **Step 3: Explicitly provision the verified Qwen model**

Run:

```bash
npm run prepare:model
npm run prepare:model -- --check
```

Expected: the immutable 1,329,766,560-byte file downloads to Application Support,
SHA-256 equals
`84aeb7fe40e7b833d71303d7f1b9f9c1991b931b5dbd214e0aa48d56a0af1f85`,
and check reports ready.

- [x] **Step 4: Replace the installed application and Hooks**

Quit Decision, replace `/Applications/Decision.app` with the newly
packaged app (one app only, no old/new suffix), launch it, run the packaged bridge
`install --apply`, and restart the relevant clients if their hook configuration
requires process reload.

- [x] **Step 5: Run installed-app health checks**

Run packaged bridge doctor, inspect integration status, confirm Apple reports
`device_not_eligible`, Qwen reports available, semantic mode reports hybrid, and
the app has no orphan helper or model process after quit.

- [x] **Step 6: Replay the field regression through installed Hooks**

Send the redacted long assistant text through Stop and the mixed answer through
UserPromptSubmit. Verify:

- both Hook commands return zero quickly with no stdout mutation;
- receipts contain all expected stages;
- the pair is classified as `mixed`;
- it appears in the existing candidate queue at medium or routes high only on
  rule/model high agreement;
- confirming the candidate opens the normal rationale flow;
- submitting rationale writes one Markdown decision and SQLite can be deleted and
  rebuilt without losing it.

- [x] **Step 7: Inspect final diff and commit any verification-only fixes**

Run:

```bash
git status --short
git diff --check
git log --oneline --decorate -20
```

If Step 1–6 required no fixes, the worktree must be clean. If fixes were needed,
add a focused regression test first and commit each fix separately.
