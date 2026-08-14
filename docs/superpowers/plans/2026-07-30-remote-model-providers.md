# Remote Model Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users securely configure, test, order, and invoke OpenAI, Anthropic, and OpenAI-compatible structured model backends through the traced model gateway.

**Architecture:** Store redacted provider profiles separately from encrypted credentials. A bounded HTTP transport enforces HTTPS/loopback policy, no cross-origin redirects, timeouts, response limits, and redacted diagnostics. API adapters normalize provider output and Token usage into the gateway contracts from the tracing foundation.

**Tech Stack:** TypeScript 7, Zod, Electron `safeStorage`, Node fetch/Web Streams, Vitest local HTTP mocks, React 19.

---

## Dependency

Complete `docs/superpowers/plans/2026-07-30-model-tracing-foundation.md` first.

## File map

**Create**

- `apps/desktop/src/main/model/provider-profile-repository.ts` — versioned redacted profile persistence and built-in defaults.
- `apps/desktop/test/provider-profile-repository.test.ts` — migration, ordering, validation, and atomic-write tests.
- `apps/desktop/src/main/model/credential-vault.ts` — encrypted secret storage behind an injectable codec.
- `apps/desktop/test/credential-vault.test.ts` — encryption, deletion, unavailable codec, and permissions tests.
- `apps/desktop/src/main/model/http-model-transport.ts` — bounded HTTPS/loopback requests and redacted errors.
- `apps/desktop/test/http-model-transport.test.ts` — local HTTP server security tests.
- `apps/desktop/src/main/model/adapters/openai-responses-adapter.ts` — OpenAI Responses structured output.
- `apps/desktop/test/openai-responses-adapter.test.ts` — request/response/usage/error fixtures.
- `apps/desktop/src/main/model/adapters/anthropic-messages-adapter.ts` — Anthropic Messages structured output.
- `apps/desktop/test/anthropic-messages-adapter.test.ts` — request/response/usage/error fixtures.
- `apps/desktop/src/main/model/adapters/openai-compatible-adapter.ts` — Responses or Chat Completions compatibility mapping.
- `apps/desktop/test/openai-compatible-adapter.test.ts` — protocol variants and missing usage.
- `apps/desktop/src/renderer/components/ModelProviderPanel.tsx` — provider list, editor, test, toggle, and ordering UI.

**Modify**

- `packages/protocol/src/model.ts` — provider profile, redacted profile, test result, and mutation input schemas.
- `packages/protocol/test/model.test.ts` — profile validation and redaction contracts.
- `apps/desktop/src/main/model/model-gateway.ts` — load enabled profiles dynamically.
- `apps/desktop/test/model-gateway.test.ts` — configurable priority and stable profile failure behavior.
- `apps/desktop/src/main/index.ts` — repositories, credentials, adapters, and operations.
- `apps/desktop/src/shared/renderer-api.ts` — redacted provider-management API.
- `apps/desktop/src/main/ipc.ts` — validate profile and secret mutations.
- `apps/desktop/src/preload/index.ts` — expose provider operations.
- `apps/desktop/test/ipc.test.ts` — profile IPC validation and no-secret response.
- `apps/desktop/src/renderer/components/SettingsPanel.tsx` — mount provider panel.
- `apps/desktop/src/renderer/styles.css` — provider card/editor layout.
- `apps/desktop/test/App.test.tsx` — provider settings workflows.
- `apps/desktop/test/accessibility.test.tsx` — labels, errors, keyboard ordering.
- `apps/desktop/src/renderer/preview-api.ts` — provider fixtures.
- `docs/semantic-recognition.md` — remote-data boundary and configuration.

### Task 1: Define and persist redacted provider profiles

**Files:**

- Modify: `packages/protocol/src/model.ts`
- Modify: `packages/protocol/test/model.test.ts`
- Create: `apps/desktop/src/main/model/provider-profile-repository.ts`
- Create: `apps/desktop/test/provider-profile-repository.test.ts`

- [ ] **Step 1: Write failing profile contract and repository tests**

Add protocol tests for this accepted profile:

```ts
const profile = modelProviderProfileSchema.parse({
  version: 1,
  profileId: "remote-openai",
  kind: "openai",
  label: "OpenAI",
  enabled: false,
  priority: 20,
  model: "gpt-5-mini",
  timeoutMs: 30_000,
  baseUrl: "https://api.openai.com",
  apiProtocol: "responses",
  credentialRef: "credential-1",
});
expect(profile.kind).toBe("openai");
```

Reject HTTP non-loopback URLs, timeout outside 1,000–120,000 ms, a missing model
for remote profiles, duplicate IDs/priorities in a stored document, credentials
on a redacted renderer profile, and raw arbitrary CLI arguments.

Repository tests must prove first load creates Apple/Qwen enabled plus
Codex/Claude discovered-but-disabled placeholders, save is atomic, reorder
normalizes priority to 0/10/20 increments, built-ins cannot be deleted, and
remote profiles can be deleted.

- [ ] **Step 2: Run profile tests and verify RED**

Run:

```bash
npx vitest run packages/protocol/test/model.test.ts apps/desktop/test/provider-profile-repository.test.ts
```

Expected: FAIL because profile schemas/repository do not exist.

- [ ] **Step 3: Implement profile schemas and repository**

Add strict schemas:

```ts
export const modelProviderKindSchema = modelBackendKindSchema;

export const modelProviderProfileSchema = z
  .object({
    version: z.literal(1),
    profileId: z.string().trim().min(1).max(200),
    kind: modelProviderKindSchema,
    label: z.string().trim().min(1).max(100),
    enabled: z.boolean(),
    priority: z.number().int().min(0).max(10_000),
    model: z.string().trim().min(1).max(200).optional(),
    timeoutMs: z.number().int().min(1_000).max(120_000),
    executablePath: z.string().trim().min(1).max(2_000).optional(),
    baseUrl: z.string().url().max(2_000).optional(),
    apiProtocol: z
      .enum(["responses", "chat-completions", "messages"])
      .optional(),
    credentialRef: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
```

Use `superRefine` for kind-specific requirements and secure URL policy.
Create redacted renderer types with `credentialConfigured: boolean` and no
`credentialRef`.

`ProviderProfileRepository` exposes:

```ts
load(): Promise<ModelProviderProfile[]>;
save(profile: ModelProviderProfile): Promise<ModelProviderProfile>;
delete(profileId: string): Promise<boolean>;
reorder(profileIds: string[]): Promise<ModelProviderProfile[]>;
```

Use one versioned JSON document, `0600`, temporary-file atomic rename, strict
duplicate checks, and four deterministic built-in profile IDs.

- [ ] **Step 4: Run profile tests and typecheck**

Run:

```bash
npx vitest run packages/protocol/test/model.test.ts apps/desktop/test/provider-profile-repository.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit profile persistence**

```bash
git add packages/protocol/src/model.ts packages/protocol/test/model.test.ts apps/desktop/src/main/model/provider-profile-repository.ts apps/desktop/test/provider-profile-repository.test.ts
git commit -m "feat: persist redacted model provider profiles"
```

### Task 2: Add encrypted credential storage

**Files:**

- Create: `apps/desktop/src/main/model/credential-vault.ts`
- Create: `apps/desktop/test/credential-vault.test.ts`

- [ ] **Step 1: Write failing credential-vault tests**

Use an injected fake codec:

```ts
const codec = {
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) =>
    Buffer.from(`encrypted:${value}`, "utf8"),
  ),
  decryptString: vi.fn((value: Buffer) =>
    value.toString("utf8").replace(/^encrypted:/u, ""),
  ),
};
const vault = new CredentialVault(join(root, "credentials"), codec);

await vault.set("credential-1", "sk-private");
expect(await vault.get("credential-1")).toBe("sk-private");
expect(await readFile(vaultPath, "utf8")).not.toContain("sk-private");
expect((await stat(vaultPath)).mode & 0o777).toBe(0o600);

await vault.delete("credential-1");
await expect(vault.get("credential-1")).resolves.toBeNull();
```

Also prove empty secrets are rejected, IDs cannot escape the directory,
decryption failure maps to `credential_decryption_failed`, and unavailable
encryption rejects persistent save with `credential_unavailable`.

- [ ] **Step 2: Run credential tests and verify RED**

Run:

```bash
npx vitest run apps/desktop/test/credential-vault.test.ts
```

Expected: FAIL because the vault does not exist.

- [ ] **Step 3: Implement the vault**

Define:

```ts
export interface CredentialCodec {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export class CredentialVault {
  constructor(path: string, codec: CredentialCodec);
  set(reference: string, secret: string): Promise<void>;
  get(reference: string): Promise<string | null>;
  has(reference: string): Promise<boolean>;
  delete(reference: string): Promise<boolean>;
}
```

Hash references into filenames, atomically write base64 ciphertext, set
directory/file permissions, never include the secret in thrown messages, and
zero temporary plaintext Buffers where a Buffer is used.

- [ ] **Step 4: Run credential tests and typecheck**

Run:

```bash
npx vitest run apps/desktop/test/credential-vault.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit encrypted credentials**

```bash
git add apps/desktop/src/main/model/credential-vault.ts apps/desktop/test/credential-vault.test.ts
git commit -m "feat: encrypt model provider credentials"
```

### Task 3: Build the bounded HTTP transport

**Files:**

- Create: `apps/desktop/src/main/model/http-model-transport.ts`
- Create: `apps/desktop/test/http-model-transport.test.ts`

- [ ] **Step 1: Write failing transport tests**

Start a local Node HTTP server and prove:

```ts
const result = await transport.postJson({
  url: `${serverUrl}/v1/responses`,
  headers: {
    authorization: "Bearer sk-secret",
    "content-type": "application/json",
  },
  body: { model: "test", input: "hello" },
  timeoutMs: 100,
  maximumResponseBytes: 1_048_576,
  secrets: ["sk-secret"],
});
expect(result.status).toBe(200);
expect(result.requestId).toBe("request-1");
```

Add cases for timeout, response over limit, non-loopback HTTP rejection,
cross-origin and same-origin redirects both returned as errors rather than
followed, malformed JSON, 401/429 status mapping, and diagnostics not containing
the bearer token, user home, or temporary path.

- [ ] **Step 2: Run transport tests and verify RED**

Run:

```bash
npx vitest run apps/desktop/test/http-model-transport.test.ts
```

Expected: FAIL because the transport does not exist.

- [ ] **Step 3: Implement bounded requests**

Use `fetch` with `redirect: "manual"` and an `AbortController`. Read
`response.body` through its reader and abort once cumulative bytes exceed the
limit. Return:

```ts
export interface HttpModelResponse {
  status: number;
  headers: Record<string, string>;
  requestId?: string;
  json: unknown;
}
```

Normalize failures to `ModelProviderError` with stable protocol error codes.
The sanitizer replaces every configured secret, Authorization/Bearer patterns,
the resolved home directory, and supplied temporary paths before truncating to
2,000 characters.

- [ ] **Step 4: Run transport tests and typecheck**

Run:

```bash
npx vitest run apps/desktop/test/http-model-transport.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit bounded transport**

```bash
git add apps/desktop/src/main/model/http-model-transport.ts apps/desktop/test/http-model-transport.test.ts
git commit -m "feat: add bounded model api transport"
```

### Task 4: Add OpenAI Responses structured generation

**Files:**

- Create: `apps/desktop/src/main/model/adapters/openai-responses-adapter.ts`
- Create: `apps/desktop/test/openai-responses-adapter.test.ts`

- [ ] **Step 1: Write failing OpenAI adapter tests**

Capture the transport request and assert the exact body:

```ts
expect(request.body).toEqual({
  model: "gpt-5-mini",
  store: false,
  tools: [],
  instructions: semanticSystemPrompt,
  input: semanticUserPrompt,
  max_output_tokens: 256,
  text: {
    format: {
      type: "json_schema",
      name: "decision_island_semantic_classification",
      strict: true,
      schema: semanticOutputJsonSchema,
    },
  },
});
```

Return a fixture with output text and usage. Assert parsed classification,
provider/model/request ID, cached/reasoning/total Tokens, raw visible output,
and provider duration. Add 401, 429, missing output, invalid JSON, and invalid
schema cases.

- [ ] **Step 2: Run OpenAI adapter tests and verify RED**

Run:

```bash
npx vitest run apps/desktop/test/openai-responses-adapter.test.ts
```

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement the OpenAI adapter**

Implement `SemanticClassifier` with profile, credential lookup, transport, and
clock dependencies. POST to `${baseUrl}/v1/responses`, validate a strict bounded
response schema, concatenate only `output_text` blocks, parse and validate the
semantic classification, then normalize:

```ts
usage: {
  source: "provider_reported",
  inputTokens: usage.input_tokens,
  cachedInputTokens: usage.input_tokens_details?.cached_tokens,
  outputTokens: usage.output_tokens,
  reasoningOutputTokens:
    usage.output_tokens_details?.reasoning_tokens,
  totalTokens: usage.total_tokens,
}
```

Never log or return the credential.

- [ ] **Step 4: Run adapter tests and typecheck**

Run:

```bash
npx vitest run apps/desktop/test/openai-responses-adapter.test.ts apps/desktop/test/http-model-transport.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit OpenAI support**

```bash
git add apps/desktop/src/main/model/adapters/openai-responses-adapter.ts apps/desktop/test/openai-responses-adapter.test.ts
git commit -m "feat: add openai responses model provider"
```

### Task 5: Add Anthropic Messages structured generation

**Files:**

- Create: `apps/desktop/src/main/model/adapters/anthropic-messages-adapter.ts`
- Create: `apps/desktop/test/anthropic-messages-adapter.test.ts`

- [ ] **Step 1: Write failing Anthropic adapter tests**

Assert the exact request body:

```ts
expect(request.body).toEqual({
  model: "claude-haiku-4-5",
  max_tokens: 256,
  system: semanticSystemPrompt,
  messages: [{ role: "user", content: semanticUserPrompt }],
  output_config: {
    format: {
      type: "json_schema",
      schema: semanticOutputJsonSchema,
    },
  },
});
```

Return a text block and usage fixture. Assert input/output/cache/thinking Token
mapping, request ID, visible output, strict parse, 401/429 mapping, refusal,
unsupported structured output, and missing text behavior.

- [ ] **Step 2: Run Anthropic tests and verify RED**

Run:

```bash
npx vitest run apps/desktop/test/anthropic-messages-adapter.test.ts
```

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement the Anthropic adapter**

POST `/v1/messages` with `x-api-key`, `anthropic-version`, and JSON content
headers. Do not send tools or thinking configuration. Validate the response,
join only visible text blocks, parse the semantic classification, and normalize
only provider-present usage fields. Map `output_tokens_details.thinking_tokens`
to `reasoningOutputTokens` when returned.

- [ ] **Step 4: Run adapter tests and typecheck**

Run:

```bash
npx vitest run apps/desktop/test/anthropic-messages-adapter.test.ts apps/desktop/test/http-model-transport.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit Anthropic support**

```bash
git add apps/desktop/src/main/model/adapters/anthropic-messages-adapter.ts apps/desktop/test/anthropic-messages-adapter.test.ts
git commit -m "feat: add anthropic messages model provider"
```

### Task 6: Add OpenAI-compatible protocol variants

**Files:**

- Create: `apps/desktop/src/main/model/adapters/openai-compatible-adapter.ts`
- Create: `apps/desktop/test/openai-compatible-adapter.test.ts`

- [ ] **Step 1: Write failing compatibility tests**

Cover both configured protocols:

```ts
expect(responsesRequest.url).toBe(`${baseUrl}/v1/responses`);
expect(chatRequest.url).toBe(`${baseUrl}/v1/chat/completions`);
expect(chatRequest.body).toMatchObject({
  model: "local-model",
  messages: [
    { role: "system", content: semanticSystemPrompt },
    { role: "user", content: semanticUserPrompt },
  ],
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "decision_island_semantic_classification",
      strict: true,
      schema: semanticOutputJsonSchema,
    },
  },
});
```

Prove missing or semantically ambiguous usage returns
`{ source: "unavailable" }`, loopback HTTP works, HTTPS works, and invalid
endpoint/profile combinations fail before network access.

- [ ] **Step 2: Run compatibility tests and verify RED**

Run:

```bash
npx vitest run apps/desktop/test/openai-compatible-adapter.test.ts
```

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement both compatibility mappings**

Delegate Responses protocol parsing to the OpenAI adapter codec without
assuming OpenAI data-retention semantics. Implement strict Chat Completions
request/response parsing separately. Only mark usage `provider_reported` when
numeric fields are present and internally consistent.

- [ ] **Step 4: Run all remote adapter tests**

Run:

```bash
npx vitest run apps/desktop/test/openai-responses-adapter.test.ts apps/desktop/test/anthropic-messages-adapter.test.ts apps/desktop/test/openai-compatible-adapter.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit compatibility support**

```bash
git add apps/desktop/src/main/model/adapters/openai-compatible-adapter.ts apps/desktop/test/openai-compatible-adapter.test.ts
git commit -m "feat: add openai compatible model provider"
```

### Task 7: Route enabled profiles and expose secure provider IPC

**Files:**

- Modify: `apps/desktop/src/main/model/model-gateway.ts`
- Modify: `apps/desktop/test/model-gateway.test.ts`
- Modify: `apps/desktop/src/shared/renderer-api.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/test/ipc.test.ts`

- [ ] **Step 1: Write failing routing and IPC tests**

Prove a disabled remote profile is never instantiated, an enabled profile is
tried at its persisted priority, auth failure creates a failed trace then
continues to the next profile, and profile changes refresh the next call.

IPC tests prove renderer responses never contain `credentialRef` or secret,
save accepts an optional one-time secret, deleting a profile deletes its
credential, reorder requires every current profile ID exactly once, and test
uses `purpose: "provider-health-check"`.

- [ ] **Step 2: Run gateway/IPC tests and verify RED**

Run:

```bash
npx vitest run apps/desktop/test/model-gateway.test.ts apps/desktop/test/ipc.test.ts
```

Expected: FAIL because the gateway still uses fixed built-ins.

- [ ] **Step 3: Implement dynamic profile routing and operations**

Gateway loads profiles at call start, filters enabled profiles, sorts by
priority then profile ID, and asks an injected factory for an adapter. The
factory supports all built-in and API kinds. Cache long-lived Apple/Qwen
instances; create stateless HTTP adapters cheaply per profile.

Expose:

```ts
listModelProviderProfiles(): Promise<RedactedModelProviderProfile[]>;
saveModelProviderProfile(
  input: ModelProviderMutationInput,
): Promise<RedactedModelProviderProfile>;
deleteModelProviderProfile(profileId: string): Promise<boolean>;
reorderModelProviderProfiles(profileIds: string[]): Promise<void>;
testModelProviderProfile(profileId: string): Promise<ModelProviderTestResult>;
```

Main process generates `credentialRef`, encrypts the optional secret, persists
the profile only after credential save succeeds, rolls back new credentials on
profile save failure, and never returns secret material.

- [ ] **Step 4: Run routing/IPC tests and typecheck**

Run:

```bash
npx vitest run apps/desktop/test/model-gateway.test.ts apps/desktop/test/ipc.test.ts apps/desktop/test/credential-vault.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit configurable routing**

```bash
git add apps/desktop/src/main/model/model-gateway.ts apps/desktop/test/model-gateway.test.ts apps/desktop/src/shared/renderer-api.ts apps/desktop/src/main/ipc.ts apps/desktop/src/preload/index.ts apps/desktop/src/main/index.ts apps/desktop/test/ipc.test.ts
git commit -m "feat: route configured remote model providers"
```

### Task 8: Add the model provider settings UI

**Files:**

- Create: `apps/desktop/src/renderer/components/ModelProviderPanel.tsx`
- Modify: `apps/desktop/src/renderer/components/SettingsPanel.tsx`
- Modify: `apps/desktop/src/renderer/styles.css`
- Modify: `apps/desktop/test/App.test.tsx`
- Modify: `apps/desktop/test/accessibility.test.tsx`
- Modify: `apps/desktop/src/renderer/preview-api.ts`

- [ ] **Step 1: Write failing provider UI tests**

Assert users can:

```ts
await user.click(screen.getByRole("button", { name: "添加模型后端" }));
await user.selectOptions(screen.getByLabelText("后端类型"), "openai");
await user.type(screen.getByLabelText("模型"), "gpt-5-mini");
await user.type(screen.getByLabelText("API 密钥"), "sk-private");
await user.click(screen.getByRole("button", { name: "保存后端" }));

expect(api.saveModelProviderProfile).toHaveBeenCalledWith(
  expect.objectContaining({
    profile: expect.objectContaining({
      kind: "openai",
      model: "gpt-5-mini",
    }),
    secret: "sk-private",
  }),
);
expect(screen.queryByDisplayValue("sk-private")).not.toBeInTheDocument();
```

Also test enable/disable, move up/down, edit without replacing a configured
secret, test connection, delete confirmation, URL validation errors, and
keyboard-accessible labels.

- [ ] **Step 2: Run UI tests and verify RED**

Run:

```bash
npx vitest run apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx
```

Expected: FAIL because the provider panel is absent.

- [ ] **Step 3: Implement compact provider management**

Render built-ins and remote profiles in one ordered list. Each row shows
enabled state, backend, label/model, availability, and last test result.
Provide move-up/down buttons instead of drag-only ordering. The editor has
kind-specific fields and never repopulates a saved secret. Mark every remote
provider with “会把当前裁剪后的问答发送给该服务”.

Testing uses a fixed harmless sample, shows latency/model/Token source, and
reloads trace/provider state afterward. No provider editor appears inside the
decision island.

- [ ] **Step 4: Run UI, accessibility, and build verification**

Run:

```bash
npx vitest run apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx
npm run typecheck
npm run build
```

Expected: PASS and Electron package succeeds.

- [ ] **Step 5: Commit provider UI**

```bash
git add apps/desktop/src/renderer/components/ModelProviderPanel.tsx apps/desktop/src/renderer/components/SettingsPanel.tsx apps/desktop/src/renderer/styles.css apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx apps/desktop/src/renderer/preview-api.ts
git commit -m "feat: manage remote model providers"
```

### Task 9: Document and verify remote providers

**Files:**

- Modify: `docs/semantic-recognition.md`

- [ ] **Step 1: Document remote configuration and privacy**

Document supported protocols, HTTPS/loopback rule, Keychain-backed storage,
default-disabled behavior, provider-side retention caveat, Token source labels,
test behavior, routing, and credential deletion.

- [ ] **Step 2: Run the complete suite**

Run:

```bash
npm test
npm run typecheck
npm run evaluate:semantic
npm run build
npm run smoke
git diff --check
```

Expected: all tests/gates/build/smoke PASS and no whitespace errors.

- [ ] **Step 3: Audit secret boundaries**

Run:

```bash
rg -n "apiKey|secret|credentialRef|Authorization|x-api-key" apps packages docs
rg -n "ModelProviderPanel|CredentialVault|OpenAIResponses|AnthropicMessages|OpenAICompatible" apps packages docs
git status --short
```

Expected: secrets are accepted only in main-process mutation input, encrypted
vault, and adapter request memory; renderer snapshots/traces/docs contain no
real secret values.

- [ ] **Step 4: Commit documentation**

```bash
git add docs/semantic-recognition.md
git commit -m "docs: explain remote model provider controls"
```

