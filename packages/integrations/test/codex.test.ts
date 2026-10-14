import { describe, expect, it } from "vitest";

import {
  DECISION_HOOK_MARKER,
  codexMcpCommands,
  mergeCodexHooks,
} from "../src/index.js";
import { existingCodexHooks } from "./fixtures.js";

const bridgePath =
  "/Applications/Decision.app/Contents/Resources/bridge/decision-bridge";

describe("Codex integration", () => {
  it("preserves unrelated hooks and adds supported command hooks", () => {
    const merged = mergeCodexHooks(existingCodexHooks, bridgePath);

    expect(merged.description).toBe("Existing personal hooks");
    expect(merged.hooks.PreToolUse).toEqual(
      existingCodexHooks.hooks.PreToolUse,
    );
    expect(JSON.stringify(merged)).toContain(DECISION_HOOK_MARKER);
    expect(merged.hooks.PostToolUse!.at(-1)).toMatchObject({
      matcher: "^(request_user_input|AskUserQuestion)$",
      hooks: [
        expect.objectContaining({
          type: "command",
          command: expect.stringContaining("hook post-tool-use codex"),
          timeout: 5,
        }),
      ],
    });
    expect(merged.hooks.Stop!.at(-1)).toEqual({
      hooks: [
        {
          type: "command",
          command: expect.stringContaining("hook stop codex"),
          timeout: 5,
        },
      ],
    });
    expect(merged.hooks.UserPromptSubmit!.at(-1)).toEqual({
      hooks: [
        {
          type: "command",
          command: expect.stringContaining("hook user-prompt-submit codex"),
          timeout: 5,
        },
      ],
    });
    expect(JSON.stringify(merged)).not.toContain("hook session-start");
    expect(JSON.stringify(merged)).not.toContain("additionalContext");
    expect(JSON.stringify(merged)).not.toContain("permissionDecision");
    expect(JSON.stringify(merged)).not.toContain("statusMessage");
  });

  it("upgrades Decision hooks idempotently", () => {
    const once = mergeCodexHooks(existingCodexHooks, bridgePath);
    const twice = mergeCodexHooks(once, bridgePath);

    expect(twice).toEqual(once);
    expect(
      JSON.stringify(twice).match(/DECISION_HOOK=1/gu),
    ).toHaveLength(3);
  });

  it("renders Windows hooks as one line PowerShell and cmd both read", () => {
    const windowsBridge =
      "C:\\Program Files\\Decision\\resources\\bridge\\decision-bridge.cmd";
    const merged = mergeCodexHooks(
      existingCodexHooks,
      windowsBridge,
      "win32",
    );
    const command = merged.hooks.Stop!.at(-1)?.hooks[0]?.command;

    // Codex runs it in PowerShell (where `&&` and `set "…"` are not its syntax), or in cmd when it has no shell.
    expect(command).toBe(
      'cmd /d /v:off /c call "C:\\Program Files\\Decision\\resources\\bridge\\decision-bridge.cmd" hook stop codex DECISION_HOOK=2',
    );
  });

  it("replaces an installed legacy bridge path with the current one", () => {
    const legacyPath =
      "/Applications/Decision Previous.app/Contents/Resources/bridge/decision-bridge";
    const legacy = mergeCodexHooks(existingCodexHooks, legacyPath);

    const merged = mergeCodexHooks(legacy, bridgePath);
    const serialized = JSON.stringify(merged);

    expect(serialized).not.toContain(legacyPath);
    expect(serialized.match(new RegExp(bridgePath, "gu"))).toHaveLength(3);
  });

  it("replaces the Codex MCP with the read-only bridge server", () => {
    expect(codexMcpCommands(bridgePath)).toEqual([
      { command: "codex", args: ["mcp", "get", "decision"], tolerateFailure: true, expectsBridgeFor: "codex" },
      {
        command: "codex",
        args: ["mcp", "remove", "decision"],
        tolerateFailure: true,
        absentMcpName: "decision",
      },
      {
        command: "codex",
        args: [
          "mcp",
          "add",
          "decision",
          "--",
          bridgePath,
          "mcp",
          "codex",
        ],
        tolerateFailure: false,
      },
    ]);
  });
});
