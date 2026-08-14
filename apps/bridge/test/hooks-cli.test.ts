import type {
  CapturedDecisionEvent,
  SemanticDecisionPair,
} from "@cognelis/decision-protocol";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { main, readHookInput } from "../src/cli.js";
import {
  claudePostToolUseFixture,
  codexPostToolUseFixture,
} from "./fixtures.js";

describe("passive PostToolUse hook", () => {
  it("spools and delivers a Claude hook without stdout", async () => {
    const spool = { append: vi.fn(async () => undefined) };
    const runtime = {
      deliver: vi.fn(async () => ({ accepted: 1, duplicates: 0 })),
      doctor: vi.fn(),
    };
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

  it("returns zero with empty output when spooling and delivery fail", async () => {
    const output = vi.fn();
    const errors = vi.fn();
    const deliver = vi.fn(async () => {
      throw new Error("offline");
    });

    const code = await main(
      ["hook", "post-tool-use", "codex"],
      {
        readStdin: async () => codexPostToolUseFixture(),
        spool: {
          append: async () => {
            throw new Error("disk full");
          },
        },
        runtime: {
          deliver,
          doctor: vi.fn(),
        },
        printJson: output,
        printError: errors,
      },
    );

    expect(code).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it("ignores unrelated and malformed hook payloads", async () => {
    const spool = { append: vi.fn(async () => undefined) };
    const runtime = {
      deliver: vi.fn(),
      doctor: vi.fn(),
    };

    await expect(
      main(["hook", "post-tool-use", "claude-code"], {
        readStdin: async () => ({ tool_name: "Bash" }),
        spool,
        runtime,
      }),
    ).resolves.toBe(0);
    await expect(
      main(["hook", "post-tool-use", "codex"], {
        readStdin: async () => {
          throw new Error("invalid JSON");
        },
        spool,
        runtime,
      }),
    ).resolves.toBe(0);

    expect(spool.append).not.toHaveBeenCalled();
    expect(runtime.deliver).not.toHaveBeenCalled();
  });
});

describe("hook input bounds", () => {
  it("parses a small JSON stream", async () => {
    await expect(
      readHookInput(
        Readable.from([
          Buffer.from('{"session_id":"small"}', "utf8"),
        ]),
        64,
      ),
    ).resolves.toEqual({ session_id: "small" });
  });

  it("rejects input as soon as the byte limit is exceeded", async () => {
    await expect(
      readHookInput(
        Readable.from([Buffer.alloc(65, "x")]),
        64,
      ),
    ).rejects.toThrow(/too large/i);
  });
});

const nativeEvent = (): CapturedDecisionEvent => ({
  eventVersion: 1,
  captureMode: "structured_tool",
  sourceClient: "codex",
  sourceEventId: "call-native",
  toolUseId: "call-native",
  sessionId: "session-1",
  turnId: "turn-1",
  batchId: "codex:session-1:call-native",
  project: "project",
  cwd: "/tmp/project",
  capturedAt: "2026-07-25T00:00:01.000Z",
  questions: [
    {
      questionIndex: 0,
      question: "Should I write tests first?",
      options: [{ label: "Yes" }, { label: "No" }],
      answer: { kind: "preset", values: ["Yes"] },
      multiSelect: false,
    },
  ],
});

const semanticPair = (): SemanticDecisionPair => ({
  version: 1,
  pairId: "pair-1",
  sourceClient: "codex",
  sessionId: "session-1",
  assistantTurnId: "turn-1",
  userTurnId: "turn-2",
  cwd: "/tmp/project",
  assistantText: "Should I keep the strict parser?",
  userText: "Yes, keep it strict.",
  capturedAt: "2026-07-25T00:00:01.000Z",
  expiresAt: "2026-08-01T00:00:01.000Z",
});

describe("passive text observer hooks", () => {
  it.each([
    ["post-tool-use", "claude-code"],
    ["stop", "codex"],
    ["user-prompt-submit", "claude-code"],
  ])(
    "exits before reading %s input for a model-provider child",
    async (operation, client) => {
      const readStdin = vi.fn(async () => {
        throw new Error("stdin must not be read");
      });
      const fallback = {
        onStop: vi.fn(),
        onUserPrompt: vi.fn(),
      };
      const audit = { record: vi.fn() };
      const spool = { append: vi.fn() };
      const semanticPairSpool = { append: vi.fn() };

      await expect(
        main(["hook", operation, client], {
          environment: {
            DECISION_ISLAND_PROVIDER_CHILD: "1",
          },
          readStdin,
          fallback,
          audit,
          spool,
          semanticPairSpool,
        }),
      ).resolves.toBe(0);

      expect(readStdin).not.toHaveBeenCalled();
      expect(fallback.onStop).not.toHaveBeenCalled();
      expect(fallback.onUserPrompt).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(spool.append).not.toHaveBeenCalled();
      expect(semanticPairSpool.append).not.toHaveBeenCalled();
    },
  );

  it("keeps native Stop recovery on the existing capture path", async () => {
    const event = nativeEvent();
    const fallback = {
      onStop: vi.fn(async () => [event]),
      onUserPrompt: vi.fn(),
    };
    const spool = { append: vi.fn(async () => undefined) };
    const runtime = {
      deliver: vi.fn(async () => ({ accepted: 1, duplicates: 0 })),
      doctor: vi.fn(),
    };

    await expect(
      main(["hook", "stop", "codex"], {
        readStdin: async () => ({
          session_id: "session-1",
          turn_id: "turn-1",
          cwd: "/tmp/project",
          transcript_path: "/tmp/session.jsonl",
        }),
        fallback,
        spool,
        runtime,
      }),
    ).resolves.toBe(0);

    expect(spool.append).toHaveBeenCalledWith(event);
    expect(runtime.deliver).toHaveBeenCalledWith(event);
  });

  it("records Stop observation stages without emitting or delivering text", async () => {
    const fallback = {
      onStop: vi.fn(async () => []),
      onUserPrompt: vi.fn(),
    };
    const audit = { record: vi.fn(async () => undefined) };
    const spool = { append: vi.fn() };
    const runtime = {
      deliver: vi.fn(),
      doctor: vi.fn(),
    };
    const output = vi.fn();
    const payload = {
      session_id: "session-1",
      turn_id: "assistant-1",
      cwd: "/tmp/project",
      last_assistant_message: "Should I keep the strict parser?",
    };

    const code = await main(["hook", "stop", "claude-code"], {
      readStdin: async () => payload,
      fallback,
      audit,
      spool,
      runtime,
      printJson: output,
    });

    expect(code).toBe(0);
    expect(fallback.onStop).toHaveBeenCalledWith(payload, "claude-code");
    expect(audit.record).toHaveBeenCalledWith({
      sourceClient: "claude-code",
      sessionId: "session-1",
      turnId: "assistant-1",
      stage: "hook_received",
    });
    expect(spool.append).not.toHaveBeenCalled();
    expect(runtime.deliver).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalled();
  });

  it("spools a pair before best-effort asynchronous delivery", async () => {
    const pair = semanticPair();
    const fallback = {
      onStop: vi.fn(),
      onUserPrompt: vi.fn(async () => pair),
    };
    const pairSpool = {
      append: vi.fn(async () => "accepted" as const),
    };
    const audit = { record: vi.fn(async () => undefined) };
    const runtime = {
      deliver: vi.fn(),
      deliverSemanticPair: vi.fn(async () => true),
      doctor: vi.fn(),
    };
    const payload = {
      session_id: "session-1",
      turn_id: "turn-2",
      cwd: "/tmp/project",
      prompt: "Yes, keep it strict.",
    };

    const code = await main(
      ["hook", "user-prompt-submit", "codex"],
      {
        readStdin: async () => payload,
        fallback,
        semanticPairSpool: pairSpool,
        audit,
        runtime,
      },
    );

    expect(code).toBe(0);
    expect(pairSpool.append).toHaveBeenCalledWith(pair);
    expect(
      pairSpool.append.mock.invocationCallOrder[0],
    ).toBeLessThan(
      runtime.deliverSemanticPair.mock.invocationCallOrder[0]!,
    );
    expect(runtime.deliverSemanticPair).toHaveBeenCalledWith(pair);
    expect(audit.record).toHaveBeenCalledWith({
      sourceClient: "codex",
      sessionId: "session-1",
      turnId: "turn-2",
      stage: "pair_spooled",
    });
  });

  it("records stable pair failures and remains silent", async () => {
    const pair = semanticPair();
    const output = vi.fn();
    const errors = vi.fn();
    const audit = { record: vi.fn(async () => undefined) };
    const runtime = {
      deliver: vi.fn(),
      deliverSemanticPair: vi.fn(async () => true),
      doctor: vi.fn(),
    };

    await expect(
      main(["hook", "user-prompt-submit", "codex"], {
        readStdin: async () => ({
          session_id: "session-1",
          turn_id: "turn-2",
          prompt: "Yes",
        }),
        fallback: {
          onStop: vi.fn(),
          onUserPrompt: vi.fn(async () => pair),
        },
        semanticPairSpool: {
          append: async () => {
            throw new Error("private disk failure");
          },
        },
        audit,
        runtime,
        printJson: output,
        printError: errors,
      }),
    ).resolves.toBe(0);

    expect(runtime.deliverSemanticPair).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith({
      sourceClient: "codex",
      sessionId: "session-1",
      turnId: "turn-2",
      stage: "failed",
      errorCode: "pair_write_failed",
    });
    expect(output).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it("keeps both text hooks fail-open even when audit and observer fail", async () => {
    const output = vi.fn();
    const errors = vi.fn();
    const fallback = {
      onStop: vi.fn(async () => {
        throw new Error("disk full");
      }),
      onUserPrompt: vi.fn(async () => {
        throw new Error("corrupt pending state");
      }),
    };
    const audit = {
      record: vi.fn(async () => {
        throw new Error("audit unavailable");
      }),
    };

    await expect(
      main(["hook", "stop", "claude-code"], {
        readStdin: async () => ({
          session_id: "session-1",
          cwd: "/tmp/project",
        }),
        fallback,
        audit,
        printJson: output,
        printError: errors,
      }),
    ).resolves.toBe(0);
    await expect(
      main(["hook", "user-prompt-submit", "codex"], {
        readStdin: async () => ({
          session_id: "session-1",
          prompt: "继续",
        }),
        fallback,
        audit,
        printJson: output,
        printError: errors,
      }),
    ).resolves.toBe(0);

    expect(output).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });
});
