import type {
  ModelProviderProfile,
  ModelProxy,
  StructuredGenerationRequest,
} from "@cognelis/decision-protocol";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  ClaudeCodeCliAdapter,
} from "../src/main/model/adapters/claude-code-cli-adapter.js";
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
    "./fixtures/claude-code-success.json",
    import.meta.url,
  ),
);

const profile: ModelProviderProfile = {
  version: 1,
  profileId: "builtin-claude-code",
  kind: "claude-code-cli",
  label: "Claude Code",
  enabled: true,
  priority: 30,
  model: "haiku",
  timeoutMs: 30_000,
  executablePath: "/Users/demo/.volta/bin/claude",
};

const input: SemanticClassifierInput = {
  pairId: "pair-cli-2",
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
  durationMs: 960,
});

const setup = (
  processResult:
    | ManagedProcessResult
    | Error
    | (() => Promise<ManagedProcessResult>) = success,
  proxy?: ModelProxy,
) => {
  const requests: ManagedProcessRequest[] = [];
  const run = vi.fn(async (request: ManagedProcessRequest) => {
    requests.push(request);
    if (processResult instanceof Error) {
      throw processResult;
    }
    return typeof processResult === "function"
      ? processResult()
      : processResult;
  });
  return {
    adapter: new ClaudeCodeCliAdapter({
      profile: { ...profile, ...(proxy === undefined ? {} : { proxy }) },
      runner: { run },
      environment: {
        HOME: "/Users/demo",
        USER: "demo",
        PATH: "/usr/bin:/bin",
        VOLTA_HOME: "/Users/demo/.volta",
        CLAUDE_CONFIG_DIR: "/Users/demo/.claude",
        SECRET_SHOULD_NOT_PASS: "private",
      },
    }),
    requests,
    run,
  };
};

describe("ClaudeCodeCliAdapter", () => {
  it("passes the configured proxy to semantic and structured CLI child requests", async () => {
    const { adapter, requests } = setup(success, { mode: "custom", url: "http://127.0.0.1:7890", noProxy: "localhost" });
    await adapter.invoke(input); await adapter.generate(methodologyRequest);
    expect(requests).toHaveLength(2);
    for (const request of requests) expect(request.environment).toMatchObject({ HTTP_PROXY: "http://127.0.0.1:7890", HTTPS_PROXY: "http://127.0.0.1:7890", http_proxy: "http://127.0.0.1:7890", https_proxy: "http://127.0.0.1:7890", NO_PROXY: "localhost", no_proxy: "localhost", DECISION_PROVIDER_CHILD: "1" });
  });

  it("cross-checks visible and structured methodology output", async () => {
    const structuredOutput = { title: "可逆优先" };
    const { adapter, requests } = setup({
      exitCode: 0,
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: JSON.stringify(structuredOutput),
        structured_output: structuredOutput,
        duration_api_ms: 80,
      }),
      stderr: "",
      durationMs: 100,
    });

    await expect(adapter.generate(methodologyRequest)).resolves.toMatchObject({
      parsedOutput: structuredOutput,
      visibleOutput: JSON.stringify(structuredOutput),
      modelVersion: "haiku",
      providerDurationMs: 80,
    });
    expect(requests[0]?.stdin).toBe(
      `${methodologyRequest.systemPrompt}\n\n${methodologyRequest.userPrompt}`,
    );
    expect(requests[0]?.args).toContain(
      JSON.stringify(methodologyRequest.outputSchema),
    );
    expect(requests[0]?.args).toContain("--safe-mode");
  });

  it("runs one safe stateless print request and cross-checks structured output", async () => {
    const { adapter, requests } = setup();

    const result = await adapter.invoke(input);

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
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
    expect(request.args).not.toContain("--bare");
    expect(request.args).not.toContain("--resume");
    expect(request.args).not.toContain("--continue");
    expect(request.args).not.toContain(request.stdin);
    expect(request.stdin).toContain(semanticSystemPrompt);
    expect(request.stdin).toContain(
      buildSemanticUserPrompt(input),
    );
    expect(request.environment).toEqual({
      HOME: "/Users/demo",
      USER: "demo",
      PATH: "/usr/bin:/bin",
      VOLTA_HOME: "/Users/demo/.volta",
      CLAUDE_CONFIG_DIR: "/Users/demo/.claude",
      DECISION_PROVIDER_CHILD: "1",
    });
    expect(result).toMatchObject({
      classification: {
        provider: "claude-code-cli",
        modelVersion: "haiku",
        decisionIntent: "decision",
        answerRelation: "answers",
      },
      usage: {
        source: "provider_reported",
        // Input counts what was cached as well, as OpenAI reports it: Claude Code counts it apart.
        inputTokens: 130,
        cachedInputTokens: 30,
        outputTokens: 20,
        totalTokens: 150,
        costUsd: 0.0012,
      },
      providerDurationMs: 720,
    });
    expect(result.visibleOutput).not.toContain(
      "must-not-persist",
    );
    await expect(stat(request.cwd)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    [
      "is_error",
      {
        type: "result",
        subtype: "error",
        is_error: true,
        result: "logged out",
      },
    ],
    [
      "invalid schema",
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "{\"confidence\":2}",
        structured_output: { confidence: 2 },
      },
    ],
    [
      "result mismatch",
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: JSON.stringify({
          decisionIntent: "decision",
          answerRelation: "answers",
          question: "A or B?",
          optionLabels: ["A", "B"],
          answerExcerpt: "A",
          confidence: 0.94,
        }),
        structured_output: {
          decisionIntent: "decision",
          answerRelation: "answers",
          question: "A or B?",
          optionLabels: ["A", "B"],
          answerExcerpt: "B",
          confidence: 0.94,
        },
      },
    ],
  ])("rejects %s responses", async (_label, value) => {
    const { adapter } = setup({
      exitCode: 0,
      stdout: JSON.stringify(value),
      stderr: "",
      durationMs: 1,
    });

    await expect(adapter.invoke(input)).rejects.toMatchObject({
      code: "invalid_output",
    });
  });

  it("keeps partial usage without inventing a total", async () => {
    const fixture = JSON.parse(
      await readFile(fixturePath, "utf8"),
    ) as Record<string, unknown>;
    fixture.usage = {
      cache_creation_input_tokens: 8,
      output_tokens: 20,
    };
    const { adapter } = setup({
      exitCode: 0,
      stdout: JSON.stringify(fixture),
      stderr: "",
      durationMs: 10,
    });

    await expect(adapter.invoke(input)).resolves.toMatchObject({
      usage: {
        source: "provider_reported",
        cachedInputTokens: 8,
        outputTokens: 20,
        costUsd: 0.0012,
      },
    });
    const result = await adapter.invoke(input);
    expect(result.usage).not.toHaveProperty("totalTokens");
  });

  it.each([
    new ManagedProcessError(
      "timeout",
      "Claude timed out",
    ),
    new ManagedProcessError(
      "process_failed",
      "Claude exited",
      { processExitCode: 1 },
    ),
  ])("preserves managed process failures", async (failure) => {
    const { adapter, run } = setup(failure);

    await expect(adapter.invoke(input)).rejects.toBe(failure);
    expect(run).toHaveBeenCalledOnce();
  });
});
