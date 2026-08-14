import type {
  ModelProviderProfile,
  StructuredGenerationRequest,
} from "@cognelis/decision-protocol";
import {
  readFile,
  stat,
} from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  CodexCliAdapter,
} from "../src/main/model/adapters/codex-cli-adapter.js";
import {
  ManagedProcessError,
  type ManagedProcessRequest,
  type ManagedProcessResult,
} from "../src/main/model/cli/managed-child-process.js";
import {
  buildSemanticUserPrompt,
  semanticOutputJsonSchema,
  semanticSystemPrompt,
} from "../src/main/model/semantic-prompt.js";
import type {
  SemanticClassifierInput,
} from "../src/main/semantic/semantic-classifier.js";

const fixturePath = fileURLToPath(
  new URL(
    "./fixtures/codex-cli-success.jsonl",
    import.meta.url,
  ),
);

const profile: ModelProviderProfile = {
  version: 1,
  profileId: "builtin-codex",
  kind: "codex-cli",
  label: "Codex",
  enabled: true,
  priority: 20,
  model: "gpt-5.6-terra",
  timeoutMs: 30_000,
  executablePath: "/opt/homebrew/bin/codex",
};

const input: SemanticClassifierInput = {
  pairId: "pair-cli-1",
  assistantText: "A or B?",
  userText: "A",
  locale: "en",
};

const methodologyRequest: StructuredGenerationRequest = {
  requestId: "methodology-request",
  purpose: "methodology-extraction",
  promptVersion: "methodology-v1",
  schemaVersion: "methodology-schema-v1",
  locale: "zh-CN",
  systemPrompt: "只基于证据提炼候选。",
  userPrompt: "证据 1：分步上线符合预期。",
  outputSchema: {
    type: "object",
    required: ["title"],
    properties: { title: { type: "string" } },
  },
  maxOutputTokens: 768,
};

const success = async (): Promise<ManagedProcessResult> => ({
  exitCode: 0,
  stdout: await readFile(fixturePath, "utf8"),
  stderr: "",
  durationMs: 840,
});

const setup = (
  result:
    | ManagedProcessResult
    | Error
    | (() => Promise<ManagedProcessResult>) = success,
) => {
  const requests: ManagedProcessRequest[] = [];
  const run = vi.fn(async (request: ManagedProcessRequest) => {
    requests.push(request);
    if (result instanceof Error) {
      throw result;
    }
    return typeof result === "function"
      ? result()
      : result;
  });
  return {
    adapter: new CodexCliAdapter({
      profile,
      runner: { run },
      environment: {
        HOME: "/Users/demo",
        USER: "demo",
        PATH: "/usr/bin:/bin",
        SECRET_SHOULD_NOT_PASS: "private",
      },
    }),
    requests,
    run,
  };
};

describe("CodexCliAdapter", () => {
  it("uses the isolated no-tool command for generic structured generation", async () => {
    const structuredOutput = JSON.stringify({ title: "可逆优先" });
    const { adapter, requests } = setup({
      exitCode: 0,
      stdout: [
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: structuredOutput },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 20,
            output_tokens: 5,
            total_tokens: 25,
          },
        }),
      ].join("\n"),
      stderr: "",
      durationMs: 90,
    });

    await expect(adapter.generate(methodologyRequest)).resolves.toMatchObject({
      parsedOutput: { title: "可逆优先" },
      visibleOutput: structuredOutput,
      modelVersion: "gpt-5.6-terra",
      providerDurationMs: 90,
    });
    expect(requests[0]?.stdin).toBe(
      `${methodologyRequest.systemPrompt}\n\n${methodologyRequest.userPrompt}`,
    );
    expect(requests[0]?.args).toContain("--output-schema");
    expect(requests[0]?.args).toContain("read-only");
  });

  it("runs a fixed ephemeral no-tool command with the prompt only on stdin", async () => {
    let schemaMode = 0;
    let schemaContent: unknown;
    let disposableDirectory = "";
    const requests: ManagedProcessRequest[] = [];
    const run = vi.fn(async (request: ManagedProcessRequest) => {
      requests.push(request);
      const schemaIndex =
        request.args.indexOf("--output-schema") + 1;
      const schemaPath = request.args[schemaIndex]!;
      schemaMode = (await stat(schemaPath)).mode & 0o777;
      schemaContent = JSON.parse(
        await readFile(schemaPath, "utf8"),
      );
      disposableDirectory = dirname(schemaPath);
      return success();
    });
    const adapter = new CodexCliAdapter({
      profile,
      runner: { run },
      environment: {
        HOME: "/Users/demo",
        USER: "demo",
        PATH: "/usr/bin:/bin",
        CODEX_HOME: "/Users/demo/.codex",
        VOLTA_HOME: "/Users/demo/.volta",
        SECRET_SHOULD_NOT_PASS: "private",
      },
    });

    const result = await adapter.invoke(input);

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    const schemaPath =
      request.args[
        request.args.indexOf("--output-schema") + 1
      ]!;
    expect(request.args).toEqual([
      "--ask-for-approval",
      "never",
      "exec",
      "--ephemeral",
      "--json",
      "--ignore-user-config",
      "--output-schema",
      schemaPath,
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--cd",
      disposableDirectory,
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
    expect(request.args).not.toContain(request.stdin);
    expect(request.stdin).toContain(semanticSystemPrompt);
    expect(request.stdin).toContain(
      buildSemanticUserPrompt(input),
    );
    expect(request.cwd).toBe(disposableDirectory);
    expect(request.environment).toEqual({
      HOME: "/Users/demo",
      USER: "demo",
      PATH: "/usr/bin:/bin",
      CODEX_HOME: "/Users/demo/.codex",
      VOLTA_HOME: "/Users/demo/.volta",
      DECISION_PROVIDER_CHILD: "1",
    });
    expect(schemaMode).toBe(0o600);
    expect(schemaContent).toEqual(semanticOutputJsonSchema);
    await expect(stat(disposableDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(result).toMatchObject({
      classification: {
        provider: "codex-cli",
        modelVersion: "gpt-5.6-terra",
        decisionIntent: "decision",
        answerRelation: "answers",
      },
      usage: {
        source: "provider_reported",
        inputTokens: 120,
        cachedInputTokens: 40,
        outputTokens: 24,
        reasoningOutputTokens: 8,
        totalTokens: 144,
      },
      providerDurationMs: 840,
    });
    expect(result.visibleOutput).not.toContain("hidden");
    expect(result.visibleOutput).not.toContain("thread-test");
  });

  it.each([
    ["invalid JSONL", "{bad"],
    [
      "missing final message",
      '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}',
    ],
    [
      "invalid semantic result",
      '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"confidence\\":2}"}}',
    ],
  ])("rejects %s", async (_label, stdout) => {
    const { adapter } = setup({
      exitCode: 0,
      stdout,
      stderr: "",
      durationMs: 1,
    });

    await expect(adapter.invoke(input)).rejects.toMatchObject({
      code: "invalid_output",
    });
  });

  it("marks missing usage as unavailable", async () => {
    const visible = JSON.stringify({
      decisionIntent: "decision",
      answerRelation: "answers",
      question: "A or B?",
      optionLabels: ["A", "B"],
      answerExcerpt: "A",
      confidence: 0.94,
    });
    const { adapter } = setup({
      exitCode: 0,
      stdout: JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: visible },
      }),
      stderr: "",
      durationMs: 4,
    });

    await expect(adapter.invoke(input)).resolves.toMatchObject({
      usage: { source: "unavailable" },
    });
  });

  it.each([
    new ManagedProcessError(
      "timeout",
      "model client timed out",
    ),
    new ManagedProcessError(
      "process_failed",
      "model client failed",
      { processExitCode: 2 },
    ),
  ])("preserves managed process failures", async (failure) => {
    const { adapter, run } = setup(failure);

    await expect(adapter.invoke(input)).rejects.toBe(failure);
    expect(run).toHaveBeenCalledOnce();
  });
});
