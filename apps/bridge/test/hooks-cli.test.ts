import type {
  CapturedDecisionEvent,
  SemanticDecisionPair,
} from "@cognelis/decision-protocol";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { realHomeAccess } = vi.hoisted(() => ({
  realHomeAccess: vi.fn(() => {
    throw new Error("Hook tests must inject storage instead of using the real home directory");
  }),
}));

vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  homedir: realHomeAccess,
}));

// Counted, still answered as it answers: how often a turn looks its repository up.
vi.mock("@cognelis/decision-integrations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cognelis/decision-integrations")>();
  return { ...actual, decisionProjectFor: vi.fn(actual.decisionProjectFor) };
});

beforeEach(() => { realHomeAccess.mockClear(); });
afterEach(() => { expect(realHomeAccess).not.toHaveBeenCalled(); });

import { decisionProjectFor } from "@cognelis/decision-integrations";
import { main, readHookInput } from "../src/cli.js";
import { TextCaptureStore } from "../src/text-capture-store.js";
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

  it("returns zero with empty output when spooling and delivery fail, still tries to deliver, and says it in the capture log", async () => {
    const output = vi.fn();
    const errors = vi.fn();
    const audit = { record: vi.fn(async () => undefined) };
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
        audit,
        printJson: output,
        printError: errors,
      },
    );

    expect(code).toBe(0);
    // A spool it cannot write is no reason not to hand the capture to a running App.
    expect(deliver).toHaveBeenCalledOnce();
    // Taken by neither, the capture is gone: lost without a trace, where the capture log now says it.
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ sourceClient: "codex", stage: "failed", errorCode: "pair_write_failed" }));
    expect(output).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it("does not call a capture lost that went to an App too busy to answer in time", async () => {
    const audit = { record: vi.fn(async () => undefined) };

    await main(["hook", "post-tool-use", "codex"], {
      readStdin: async () => codexPostToolUseFixture(),
      spool: { append: async () => { throw new Error("disk full"); } },
      runtime: { deliver: vi.fn(async () => false), doctor: vi.fn() },
      audit,
      printJson: vi.fn(),
    });

    expect(audit.record).not.toHaveBeenCalled();
  });

  it("says nothing in the capture log of a capture the spool kept for an App not running", async () => {
    const audit = { record: vi.fn(async () => undefined) };

    await main(["hook", "post-tool-use", "claude-code"], {
      readStdin: async () => claudePostToolUseFixture(),
      spool: { append: vi.fn(async () => undefined) },
      runtime: { deliver: vi.fn(async () => null), doctor: vi.fn() },
      audit,
      printJson: vi.fn(),
    });

    expect(audit.record).not.toHaveBeenCalled();
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

  it.each(["post-tool-use", "stop"])("says in the capture log that a %s hook's input past the limit was lost", async (hook) => {
    const audit = { record: vi.fn(async () => undefined) };
    const spool = { append: vi.fn(async () => undefined) };
    const raw = JSON.stringify({
      session_id: "claude-session",
      turn_id: "turn-7",
      hook_event_name: "PostToolUse",
      tool_input: { questions: [{ question: "x".repeat(300) }] },
    });

    await expect(main(["hook", hook, "claude-code"], {
      readStdin: () => readHookInput(Readable.from([Buffer.from(raw)]), 200),
      audit,
      spool,
      runtime: { deliver: vi.fn(), doctor: vi.fn() },
    })).resolves.toBe(0);

    expect(audit.record).toHaveBeenCalledWith({
      sourceClient: "claude-code",
      sessionId: "claude-session",
      turnId: "turn-7",
      stage: "failed",
      errorCode: "input_too_large",
    });
    expect(spool.append).not.toHaveBeenCalled();
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
            DECISION_PROVIDER_CHILD: "1",
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
    const audit = { record: vi.fn(async () => undefined) };
    const fallback = {
      // Named as the post-tool-use path names it, by the repository a directory belongs to: outside any,
      // the directory's own name, whatever the recovered event called it.
      onStop: vi.fn(async () => [{ ...event, project: "named-elsewhere" }]),
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
        audit,
        spool,
        runtime,
      }),
    ).resolves.toBe(0);

    expect(spool.append).toHaveBeenCalledWith(event);
    expect(runtime.deliver).toHaveBeenCalledWith(event);
    expect(audit.record).toHaveBeenCalledWith({
      sourceClient: "codex",
      sessionId: "session-1",
      turnId: "turn-1",
      stage: "hook_received",
    });
  });

  it("spools every decision of a Stop turn before asking the App for any", async () => {
    const events = [1, 2, 3].map((n) => ({ ...nativeEvent(), toolUseId: `tool-${n}`, sourceEventId: `tool-${n}`, batchId: `codex:session-1:tool-${n}` }));
    const appended: string[] = [];
    const spool = { append: vi.fn(async (event: CapturedDecisionEvent) => { appended.push(event.toolUseId ?? "?"); }) };
    let release: () => void = () => undefined;
    const stalled = new Promise<false>((resolve) => { release = () => resolve(false); });
    const runtime = {
      deliver: vi.fn(async (event: CapturedDecisionEvent) => (event.toolUseId === "tool-1" ? stalled : false)),
      doctor: vi.fn(),
    };
    const audit = { record: vi.fn(async () => undefined) };
    const fallback = { onStop: vi.fn(async () => events), onUserPrompt: vi.fn() };
    vi.mocked(decisionProjectFor).mockClear();
    const run = main(["hook", "stop", "codex"], {
      readStdin: async () => ({ session_id: "session-1", turn_id: "turn-1", cwd: "/tmp/project", transcript_path: "/tmp/session.jsonl" }),
      fallback, audit, spool, runtime,
    });

    // The App slow to answer for the first: killed at its five seconds here, the hook had the other two on disk
    // already, where spooling each after the delivery before it had left them nowhere, unaudited.
    await vi.waitFor(() => expect(runtime.deliver).toHaveBeenCalledTimes(1));
    expect(appended).toEqual(["tool-1", "tool-2", "tool-3"]);
    // One working directory for the turn, looked up once: once per decision, git stuck on a slow disk spent the
    // five seconds before the first delivery.
    expect(decisionProjectFor).toHaveBeenCalledTimes(1);

    release();
    expect(await run).toBe(0);
    expect(runtime.deliver).toHaveBeenCalledTimes(3);
    expect(audit.record).not.toHaveBeenCalledWith(expect.objectContaining({ stage: "failed" }));
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

  it("counts a capture that aged out before anyone answered", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "decision-bridge-aged-"),
    );
    const pendingPath = join(root, "text-pending");
    const capturedAt = new Date(
      Date.now() - 48 * 60 * 60 * 1_000,
    );
    await new TextCaptureStore(pendingPath, {
      now: () => capturedAt,
    }).save({
      version: 3,
      sourceClient: "codex",
      sessionId: "aged-session",
      turnId: "assistant-turn",
      cwd: "/tmp/project",
      assistantText: "现在继续吗？",
      capturedAt: capturedAt.toISOString(),
    });
    const audit = { record: vi.fn(async () => undefined) };

    const code = await main(
      ["hook", "user-prompt-submit", "codex"],
      {
        readStdin: async () => ({
          session_id: "unrelated-session",
          cwd: "/tmp/project",
          prompt: "继续",
        }),
        environment: { DECISION_TEXT_PENDING: pendingPath },
        audit,
      },
    );

    expect(code).toBe(0);
    expect(audit.record).toHaveBeenCalledWith({
      sourceClient: "codex",
      sessionId: "aged-session",
      turnId: "assistant-turn",
      stage: "pending_expired",
    });
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(
      "现在继续吗？",
    );
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

    // Not spooled is no reason not to hand it to a running App.
    expect(runtime.deliverSemanticPair).toHaveBeenCalledWith(pair);
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

  it("records a pair the App did not take", async () => {
    const audit = { record: vi.fn(async () => undefined) };

    await expect(
      main(["hook", "user-prompt-submit", "codex"], {
        readStdin: async () => ({ session_id: "session-1", turn_id: "turn-2", prompt: "Yes" }),
        fallback: { onStop: vi.fn(), onUserPrompt: vi.fn(async () => semanticPair()) },
        semanticPairSpool: { append: async () => "accepted" as const },
        audit,
        runtime: { deliver: vi.fn(), deliverSemanticPair: vi.fn(async () => false), doctor: vi.fn() },
        printJson: vi.fn(),
        printError: vi.fn(),
      }),
    ).resolves.toBe(0);

    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ stage: "pair_spooled" }));
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "failed", errorCode: "pair_delivery_failed" }),
    );
  });

  it("does not call an App that is not running a failure: the spool is for that", async () => {
    const audit = { record: vi.fn(async () => undefined) };

    await main(["hook", "user-prompt-submit", "codex"], {
      readStdin: async () => ({ session_id: "session-1", turn_id: "turn-2", prompt: "Yes" }),
      fallback: { onStop: vi.fn(), onUserPrompt: vi.fn(async () => semanticPair()) },
      semanticPairSpool: { append: async () => "accepted" as const },
      audit,
      runtime: { deliver: vi.fn(), deliverSemanticPair: vi.fn(async () => null), doctor: vi.fn() },
      printJson: vi.fn(),
      printError: vi.fn(),
    });

    expect(audit.record).not.toHaveBeenCalledWith(expect.objectContaining({ stage: "failed" }));
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
