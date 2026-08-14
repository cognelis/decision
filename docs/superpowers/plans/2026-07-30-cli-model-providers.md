# Codex and Claude Code Model Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect, configure, test, and safely invoke authenticated Codex CLI and Claude Code CLI installations as optional traced semantic-decision backends.

**Architecture:** A bounded no-shell child-process runner executes fixed argument templates in disposable empty directories. Discovery validates executable/version/auth capabilities; adapters parse versioned JSON output while filtering reasoning and tool events. An inherited provider-child marker makes Decision’s passive Hooks exit before reading input, preventing recursive capture.

**Tech Stack:** TypeScript 7, Node child processes/fs/os, Zod, Vitest fake executables, Codex CLI non-interactive JSONL, Claude Code print-mode JSON.

---

## Dependencies

Complete these plans first:

1. `docs/superpowers/plans/2026-07-30-model-tracing-foundation.md`
2. `docs/superpowers/plans/2026-07-30-remote-model-providers.md`

## File map

**Create**

- `apps/desktop/src/main/model/cli/managed-child-process.ts` — no-shell spawn, bounded streams, timeout, cancellation, process-group cleanup.
- `apps/desktop/test/managed-child-process.test.ts` — stdin, limits, timeout, abort, environment, and cleanup.
- `apps/desktop/src/main/model/cli/cli-discovery.ts` — executable lookup, version, feature, and auth diagnostics.
- `apps/desktop/test/cli-discovery.test.ts` — Codex/Claude discovery fixtures.
- `apps/desktop/src/main/model/adapters/codex-cli-adapter.ts` — fixed safe Codex invocation and JSONL parser.
- `apps/desktop/test/codex-cli-adapter.test.ts` — arguments, event parsing, usage, and failure fixtures.
- `apps/desktop/src/main/model/adapters/claude-code-cli-adapter.ts` — fixed safe Claude invocation and JSON parser.
- `apps/desktop/test/claude-code-cli-adapter.test.ts` — arguments, structured output, usage, and failure fixtures.
- `apps/desktop/test/fixtures/codex-cli-success.jsonl` — sanitized successful one-turn output.
- `apps/desktop/test/fixtures/claude-code-success.json` — sanitized successful one-turn output.

**Modify**

- `apps/bridge/src/cli.ts` — provider-child early exit before stdin/audit/spool.
- `apps/bridge/test/hooks-cli.test.ts` — prove no capture side effect under child marker.
- `apps/desktop/src/main/model/provider-profile-repository.ts` — refresh discovered CLI details without enabling them.
- `apps/desktop/test/provider-profile-repository.test.ts` — discovery merge behavior.
- `apps/desktop/src/main/model/model-gateway.ts` — instantiate CLI adapters from enabled profiles.
- `apps/desktop/test/model-gateway.test.ts` — CLI routing and trace attempts.
- `apps/desktop/src/main/index.ts` — discovery, adapter factory, lifecycle, and test operations.
- `apps/desktop/src/renderer/components/ModelProviderPanel.tsx` — path/version/auth/status fields.
- `apps/desktop/test/App.test.tsx` — CLI configuration/test UI.
- `apps/desktop/test/accessibility.test.tsx` — CLI status semantics.
- `apps/desktop/src/renderer/preview-api.ts` — CLI fixtures.
- `scripts/evaluate-semantic-classifier.mjs` — select a configured provider and report tokens/latency.
- `scripts/test/evaluate-semantic-classifier.test.ts` — provider slice output.
- `scripts/smoke.mjs` — installed-App fixed-sample CLI tests and recursion check.
- `docs/semantic-recognition.md` — client requirements, safety flags, Token semantics, recovery.

### Task 1: Prevent provider child calls from re-entering passive Hooks

**Files:**

- Modify: `apps/bridge/src/cli.ts`
- Modify: `apps/bridge/test/hooks-cli.test.ts`

- [ ] **Step 1: Write failing recursion-guard tests**

For each passive Hook operation, set the provider-child environment through an
injectable dependency and assert none of the collaborators run:

```ts
const dependencies = {
  environment: {
    DECISION_PROVIDER_CHILD: "1",
  },
  readStdin: vi.fn(async () => {
    throw new Error("stdin must not be read");
  }),
  fallback: {
    onStop: vi.fn(),
    onUserPrompt: vi.fn(),
  },
  audit: {
    record: vi.fn(),
  },
};

await expect(
  main(["hook", "stop", "codex"], dependencies),
).resolves.toBe(0);
expect(dependencies.readStdin).not.toHaveBeenCalled();
expect(dependencies.audit.record).not.toHaveBeenCalled();
```

Repeat for `post-tool-use` and `user-prompt-submit`, and prove normal Hook
behavior remains unchanged when the marker is absent.

- [ ] **Step 2: Run Hook tests and verify RED**

Run:

```bash
npx vitest run apps/bridge/test/hooks-cli.test.ts
```

Expected: FAIL because `CliDependencies` does not accept environment and Hooks
still read stdin.

- [ ] **Step 3: Implement the first-instruction guard**

Add `environment?: NodeJS.ProcessEnv` to `CliDependencies`. At the first line of
`main`, before destructuring hook input or constructing stores:

```ts
const environment = dependencies.environment ?? process.env;
const [command] = arguments_;
if (
  command === "hook" &&
  environment.DECISION_PROVIDER_CHILD === "1"
) {
  return 0;
}
```

Do not suppress `doctor` or `install`; the marker only guards Hook commands.

- [ ] **Step 4: Run all bridge tests**

Run:

```bash
npx vitest run apps/bridge/test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit recursion protection**

```bash
git add apps/bridge/src/cli.ts apps/bridge/test/hooks-cli.test.ts
git commit -m "fix: prevent recursive provider hook capture"
```

### Task 2: Add a bounded no-shell child-process runner

**Files:**

- Create: `apps/desktop/src/main/model/cli/managed-child-process.ts`
- Create: `apps/desktop/test/managed-child-process.test.ts`

- [ ] **Step 1: Write failing process-runner tests**

Use fake child streams and timers. Assert:

```ts
const result = await runner.run({
  executable: "/usr/local/bin/fake-model",
  args: ["--json"],
  stdin: "private prompt",
  cwd: "/private/tmp/decision-empty",
  timeoutMs: 100,
  maximumStdoutBytes: 1_048_576,
  maximumStderrBytes: 65_536,
  environment: {
    HOME: "/Users/demo",
    PATH: "/usr/bin:/bin",
  },
});

expect(spawn).toHaveBeenCalledWith(
  "/usr/local/bin/fake-model",
  ["--json"],
  expect.objectContaining({
    shell: false,
    cwd: "/private/tmp/decision-empty",
    detached: true,
  }),
);
expect(child.stdin.end).toHaveBeenCalledWith("private prompt");
expect(result).toMatchObject({ exitCode: 0 });
```

Add timeout, external abort, stdout/stderr size limit, non-zero exit, spawn
error, no prompt in args, graceful SIGTERM then SIGKILL, process-group target,
and cleanup callback tests.

- [ ] **Step 2: Run process tests and verify RED**

Run:

```bash
npx vitest run apps/desktop/test/managed-child-process.test.ts
```

Expected: FAIL because the runner does not exist.

- [ ] **Step 3: Implement the runner**

Expose:

```ts
export interface ManagedProcessRequest {
  executable: string;
  args: string[];
  stdin: string;
  cwd: string;
  timeoutMs: number;
  maximumStdoutBytes: number;
  maximumStderrBytes: number;
  environment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface ManagedProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export class ManagedChildProcessRunner {
  run(request: ManagedProcessRequest): Promise<ManagedProcessResult>;
}
```

Spawn with `shell: false`, `detached: process.platform !== "win32"`, and only
pipe stdin/stdout/stderr. Validate executable is absolute and arguments contain
no NUL. Bound byte accumulation before UTF-8 conversion. On cancel/timeout send
SIGTERM to the verified positive process group, wait at most 500 ms, then send
SIGKILL if still open. Every error carries a stable code and sanitized bounded
stderr.

- [ ] **Step 4: Run process tests and typecheck**

Run:

```bash
npx vitest run apps/desktop/test/managed-child-process.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit process isolation**

```bash
git add apps/desktop/src/main/model/cli/managed-child-process.ts apps/desktop/test/managed-child-process.test.ts
git commit -m "feat: isolate local model client processes"
```

### Task 3: Detect executable, version, capabilities, and authentication

**Files:**

- Create: `apps/desktop/src/main/model/cli/cli-discovery.ts`
- Create: `apps/desktop/test/cli-discovery.test.ts`
- Modify: `packages/protocol/src/model.ts`
- Modify: `packages/protocol/test/model.test.ts`

- [ ] **Step 1: Write failing discovery tests**

Create temporary executable fixtures and fake process results. Prove:

```ts
await expect(discovery.inspect("codex", configuredPath)).resolves.toEqual({
  kind: "codex-cli",
  executablePath: configuredPath,
  version: "0.146.0",
  authenticated: true,
  supported: true,
  availability: "available",
});

await expect(discovery.inspect("claude-code", claudePath)).resolves.toEqual({
  kind: "claude-code-cli",
  executablePath: claudePath,
  version: "2.1.220",
  authenticated: true,
  supported: true,
  availability: "available",
});
```

Codex uses `--version`, `login status`, `doctor --json`, and `exec --help`.
Claude uses `--version`, `auth status`, and `--help`. Add not-found,
not-executable, timeout, logged-out, malformed diagnostics, and missing required
flag cases.

- [ ] **Step 2: Run discovery tests and verify RED**

Run:

```bash
npx vitest run apps/desktop/test/cli-discovery.test.ts packages/protocol/test/model.test.ts
```

Expected: FAIL because discovery/status contracts do not exist.

- [ ] **Step 3: Implement lookup and diagnostics**

Add a strict redacted `LocalModelClientStatus` schema with kind, path, version,
authenticated, supported, availability, and checkedAt.

Discovery accepts an optional configured absolute path. Otherwise it splits the
current `PATH`, joins the exact executable name, and checks a regular executable
file without invoking a shell. Use short bounded process calls:

```ts
codex --version
codex login status
codex doctor --json
codex exec --help
claude --version
claude auth status
claude --help
```

Parse versions defensively and search help text for every fixed flag used by
the adapters. Diagnostic output is never included verbatim in renderer status.

- [ ] **Step 4: Run discovery tests and typecheck**

Run:

```bash
npx vitest run apps/desktop/test/cli-discovery.test.ts packages/protocol/test/model.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit client discovery**

```bash
git add apps/desktop/src/main/model/cli/cli-discovery.ts apps/desktop/test/cli-discovery.test.ts packages/protocol/src/model.ts packages/protocol/test/model.test.ts
git commit -m "feat: diagnose local model clients"
```

### Task 4: Add the Codex CLI adapter

**Files:**

- Create: `apps/desktop/src/main/model/adapters/codex-cli-adapter.ts`
- Create: `apps/desktop/test/codex-cli-adapter.test.ts`
- Create: `apps/desktop/test/fixtures/codex-cli-success.jsonl`

- [ ] **Step 1: Write failing Codex adapter tests**

Use this sanitized event fixture:

```json
{"type":"thread.started","thread_id":"thread-test"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item-1","type":"agent_message","text":"{\"decisionIntent\":\"decision\",\"answerRelation\":\"answers\",\"question\":\"A or B?\",\"optionLabels\":[\"A\",\"B\"],\"answerExcerpt\":\"A\",\"confidence\":0.94}"}}
{"type":"turn.completed","usage":{"input_tokens":120,"cached_input_tokens":40,"output_tokens":24,"reasoning_output_tokens":8,"total_tokens":144}}
```

Assert the runner receives this exact fixed argument sequence:

```ts
expect(request.args).toEqual([
  "exec",
  "--ephemeral",
  "--json",
  "--ignore-user-config",
  "--output-schema",
  schemaPath,
  "--sandbox",
  "read-only",
  "--ask-for-approval",
  "never",
  "--skip-git-repo-check",
  "--cd",
  temporaryDirectory,
  "-c",
  "features.shell_tool=false",
  "-c",
  "tools.web_search=false",
  "-c",
  "apps._default.enabled=false",
  "-c",
  "agents.enabled=false",
  "-c",
  "memories.generate_memories=false",
  "--model",
  "gpt-5.6-terra",
  "-",
]);
```

Assert stdin contains the model prompt, args do not, cwd is disposable,
environment contains `DECISION_PROVIDER_CHILD=1`, output/usage parse
correctly, and thread/reasoning/tool events are not copied into visible output.
Add invalid JSONL, missing final message, invalid structured result, timeout,
non-zero exit, and missing usage cases.

- [ ] **Step 2: Run Codex tests and verify RED**

Run:

```bash
npx vitest run apps/desktop/test/codex-cli-adapter.test.ts
```

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement safe Codex invocation and parser**

Create a disposable directory with `mkdtemp`, write the fixed semantic JSON
schema as a `0600` file, and always remove only that validated temporary
directory in `finally`.

Build a minimal environment by copying only:

```ts
const inheritedNames = [
  "HOME",
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "CODEX_HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
] as const;
```

Add the provider-child marker. Parse stdout line by line with strict bounded
Zod schemas for the event types used. The last completed `agent_message` is the
visible output. Map usage only when fields are valid; otherwise use
`source: "unavailable"`. Do not persist `thread_id`.

- [ ] **Step 4: Run Codex/runner tests and typecheck**

Run:

```bash
npx vitest run apps/desktop/test/codex-cli-adapter.test.ts apps/desktop/test/managed-child-process.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit Codex provider**

```bash
git add apps/desktop/src/main/model/adapters/codex-cli-adapter.ts apps/desktop/test/codex-cli-adapter.test.ts apps/desktop/test/fixtures/codex-cli-success.jsonl
git commit -m "feat: add codex cli model provider"
```

### Task 5: Add the Claude Code CLI adapter

**Files:**

- Create: `apps/desktop/src/main/model/adapters/claude-code-cli-adapter.ts`
- Create: `apps/desktop/test/claude-code-cli-adapter.test.ts`
- Create: `apps/desktop/test/fixtures/claude-code-success.json`

- [ ] **Step 1: Write failing Claude adapter tests**

Use this sanitized result fixture:

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 940,
  "duration_api_ms": 720,
  "num_turns": 1,
  "result": "{\"decisionIntent\":\"decision\",\"answerRelation\":\"answers\",\"question\":\"A or B?\",\"optionLabels\":[\"A\",\"B\"],\"answerExcerpt\":\"A\",\"confidence\":0.94}",
  "structured_output": {
    "decisionIntent": "decision",
    "answerRelation": "answers",
    "question": "A or B?",
    "optionLabels": ["A", "B"],
    "answerExcerpt": "A",
    "confidence": 0.94
  },
  "total_cost_usd": 0.0012,
  "usage": {
    "input_tokens": 100,
    "cache_read_input_tokens": 30,
    "output_tokens": 20
  }
}
```

Assert exact arguments:

```ts
expect(request.args).toEqual([
  "-p",
  "--safe-mode",
  "--tools",
  "",
  "--disallowedTools",
  "mcp__*",
  "--no-session-persistence",
  "--permission-mode",
  "dontAsk",
  "--output-format",
  "json",
  "--json-schema",
  JSON.stringify(semanticOutputJsonSchema),
  "--model",
  "haiku",
]);
```

Assert prompt is stdin-only, marker is set, no `--bare`, no resume/continue,
structured output is preferred then cross-checked against visible result,
usage/cost/timing normalize, and no session ID is persisted. Add logged-out,
invalid schema, result mismatch, timeout, non-zero exit, is_error, and missing
usage cases.

- [ ] **Step 2: Run Claude tests and verify RED**

Run:

```bash
npx vitest run apps/desktop/test/claude-code-cli-adapter.test.ts
```

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement safe Claude invocation and parser**

Use the same disposable-directory and minimal-environment helper as Codex,
adding `CLAUDE_CONFIG_DIR` to the allowlist. Spawn without shell through the
managed runner. Parse one bounded JSON document, validate the result union,
ignore session identifiers, and normalize:

```ts
usage: {
  source: "provider_reported",
  inputTokens: usage.input_tokens,
  cachedInputTokens:
    usage.cache_read_input_tokens +
    (usage.cache_creation_input_tokens ?? 0),
  outputTokens: usage.output_tokens,
  totalTokens:
    usage.input_tokens + usage.output_tokens,
  costUsd: result.total_cost_usd,
}
```

If any required usage component is absent, retain available fields but do not
invent `totalTokens`.

- [ ] **Step 4: Run Claude/runner tests and typecheck**

Run:

```bash
npx vitest run apps/desktop/test/claude-code-cli-adapter.test.ts apps/desktop/test/managed-child-process.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit Claude Code provider**

```bash
git add apps/desktop/src/main/model/adapters/claude-code-cli-adapter.ts apps/desktop/test/claude-code-cli-adapter.test.ts apps/desktop/test/fixtures/claude-code-success.json
git commit -m "feat: add claude code cli model provider"
```

### Task 6: Connect discovery and CLI adapters to profiles, gateway, and UI

**Files:**

- Modify: `apps/desktop/src/main/model/provider-profile-repository.ts`
- Modify: `apps/desktop/test/provider-profile-repository.test.ts`
- Modify: `apps/desktop/src/main/model/model-gateway.ts`
- Modify: `apps/desktop/test/model-gateway.test.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/renderer/components/ModelProviderPanel.tsx`
- Modify: `apps/desktop/test/App.test.tsx`
- Modify: `apps/desktop/test/accessibility.test.tsx`
- Modify: `apps/desktop/src/renderer/preview-api.ts`

- [ ] **Step 1: Write failing profile/gateway/UI tests**

Prove discovery updates path/version/auth/status without changing `enabled`,
gateway instantiates an enabled CLI profile at persisted priority, failed CLI
attempts are traced then fall back, and a successful CLI result participates in
the unchanged rule/model route.

UI assertions:

```ts
expect(screen.getByText("Codex CLI 0.146.0")).toBeInTheDocument();
expect(screen.getByText("已登录，可用")).toBeInTheDocument();
await user.click(screen.getByRole("button", { name: "测试 Codex CLI" }));
expect(api.testModelProviderProfile).toHaveBeenCalledWith("codex-cli");

await user.click(
  screen.getByRole("checkbox", { name: "启用 Claude Code CLI" }),
);
expect(api.saveModelProviderProfile).toHaveBeenCalledWith(
  expect.objectContaining({
    profile: expect.objectContaining({
      profileId: "claude-code-cli",
      enabled: true,
    }),
  }),
);
```

- [ ] **Step 2: Run affected tests and verify RED**

Run:

```bash
npx vitest run apps/desktop/test/provider-profile-repository.test.ts apps/desktop/test/model-gateway.test.ts apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx
```

Expected: FAIL because CLI adapters are not registered or rendered.

- [ ] **Step 3: Implement discovery refresh and adapter factory**

On settings open and explicit test, inspect both clients. Merge only discovered
path/status fields into redacted view; do not overwrite the user’s model,
timeout, priority, or enabled selection. The adapter factory requires
`supported && authenticated` before construction.

Provider UI shows configured/detected path, version, authentication,
compatibility, model, timeout, test, enable, and ordering. Custom path editing
accepts an absolute path only. Clearly label both CLI providers as remote model
calls using the client’s existing authentication, despite running through a
local executable.

- [ ] **Step 4: Run gateway/UI tests and typecheck**

Run:

```bash
npx vitest run apps/desktop/test/provider-profile-repository.test.ts apps/desktop/test/model-gateway.test.ts apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit CLI configuration**

```bash
git add apps/desktop/src/main/model/provider-profile-repository.ts apps/desktop/test/provider-profile-repository.test.ts apps/desktop/src/main/model/model-gateway.ts apps/desktop/test/model-gateway.test.ts apps/desktop/src/main/index.ts apps/desktop/src/renderer/components/ModelProviderPanel.tsx apps/desktop/test/App.test.tsx apps/desktop/test/accessibility.test.tsx apps/desktop/src/renderer/preview-api.ts
git commit -m "feat: configure local model client providers"
```

### Task 7: Extend evaluation and installed-App smoke

**Files:**

- Modify: `scripts/evaluate-semantic-classifier.mjs`
- Modify: `scripts/test/evaluate-semantic-classifier.test.ts`
- Modify: `scripts/smoke.mjs`

- [ ] **Step 1: Write failing evaluator/smoke tests**

Extend evaluator fixtures so a provider slice reports:

```json
{
  "provider": "codex-cli",
  "samples": 64,
  "highPrecision": 0.96,
  "highMediumRecall": 0.92,
  "medianLatencyMs": 820,
  "inputTokens": 8120,
  "outputTokens": 1240,
  "tokenUsageUnavailable": 0
}
```

Smoke must fail if a provider child marker produces any new semantic pair,
candidate, rationale item, or Obsidian note.

- [ ] **Step 2: Run script tests and verify RED**

Run:

```bash
npx vitest run scripts/test/evaluate-semantic-classifier.test.ts
```

Expected: FAIL because provider/Token/latency slices are absent.

- [ ] **Step 3: Implement provider-aware evaluation and smoke**

Add `--provider <profile-id>` to the evaluator. Keep `--report-only`; never
enable a provider or persist profile changes from the script. Aggregate only
trace usage produced by the selected evaluation run.

Installed-App smoke calls each enabled CLI profile with the fixed harmless
health-check sample, records before/after spool/queue/Obsidian counts, and
asserts no recursive capture. It prints only redacted provider status, never
input/output or credentials.

- [ ] **Step 4: Run script tests and full semantic evaluation**

Run:

```bash
npx vitest run scripts/test/evaluate-semantic-classifier.test.ts
npm run evaluate:semantic
npm run typecheck
```

Expected: PASS. Real CLI-provider evaluation runs only when its profile is
explicitly enabled and selected.

- [ ] **Step 5: Commit evaluation and smoke**

```bash
git add scripts/evaluate-semantic-classifier.mjs scripts/test/evaluate-semantic-classifier.test.ts scripts/smoke.mjs
git commit -m "test: evaluate local model client providers"
```

### Task 8: Document, package, install, and verify the complete goal

**Files:**

- Modify: `docs/semantic-recognition.md`
- Modify: `README.md`

- [ ] **Step 1: Update user documentation**

Document:

- Codex/Claude version, auth, and required flags;
- exact fixed safety modes and why `--bare` is not used for Claude;
- disposable workspace, disabled tools, no session persistence, and recursion marker;
- provider configuration, test, enable, priority, Token source, and recovery;
- local traces versus provider-side data handling;
- uninstalling a CLI profile does not remove or log out the client;
- current compact island dimensions, replacing the stale README description.

- [ ] **Step 2: Run the complete repository verification**

Run:

```bash
npm test
npm run typecheck
npm run evaluate:semantic
npm run build
npm run smoke
git diff --check
```

Expected: all tests and quality gates PASS, package succeeds, smoke exits 0, and
no whitespace errors.

- [ ] **Step 3: Build and install the app**

Run the repository’s established package/install flow. Replace the existing
`/Applications/Decision.app`, preserving only one installed copy. Then
run:

```bash
/Applications/Decision\ Island.app/Contents/Resources/bridge/decision-bridge doctor
/Applications/Decision\ Island.app/Contents/Resources/bridge/decision-bridge install --dry-run
/Applications/Decision\ Island.app/Contents/Resources/bridge/decision-bridge install --apply
```

Expected: doctor healthy; dry-run/apply report only passive Hook configuration
and no Decision MCP.

- [ ] **Step 4: Perform the completion audit**

Verify every design acceptance criterion with current evidence:

```bash
rg -n "ModelInvocationTrace|ModelTraceStore|OpenAIResponses|AnthropicMessages|OpenAICompatible|CodexCli|ClaudeCodeCli|DECISION_PROVIDER_CHILD" apps packages docs scripts
rg -n "decision" "$HOME/.claude/settings.json" "$HOME/.codex/hooks.json"
git status --short
git log -12 --oneline
```

Inspect one trace from each available backend through the settings UI. Confirm
input, visible output, structured output, Token source, timing, and fallback.
Confirm no trace/key in Obsidian or SQLite, no child session in Codex/Claude
resume lists, and no candidate produced by health tests.

- [ ] **Step 5: Commit documentation**

```bash
git add docs/semantic-recognition.md README.md
git commit -m "docs: explain configurable model backends"
```
