import { describe, expect, it } from "vitest";

import {
  DECISION_HOOK_MARKER,
  claudeMcpCommands,
  mergeClaudeSettings,
} from "../src/index.js";
import { existingClaudeSettings } from "./fixtures.js";

const bridgePath =
  "/Applications/Decision.app/Contents/Resources/bridge/decision-bridge";

describe("Claude Code integration", () => {
  it("preserves existing settings and appends Decision hooks", () => {
    const merged = mergeClaudeSettings(existingClaudeSettings, bridgePath);

    expect(merged).toMatchObject({
      defaultMode: "acceptEdits",
      enabledPlugins: {
        "superpowers@claude-plugins-official": true,
      },
    });
    expect(merged.hooks.SessionStart![0]).toEqual(
      existingClaudeSettings.hooks.SessionStart[0],
    );
    expect(merged.hooks.Stop![0]).toEqual(existingClaudeSettings.hooks.Stop[0]);
    expect(JSON.stringify(merged)).toContain(DECISION_HOOK_MARKER);
    expect(JSON.stringify(merged)).toContain(`'${bridgePath}'`);
    expect(merged.hooks.PostToolUse!.at(-1)).toMatchObject({
      matcher: "^AskUserQuestion$",
      hooks: [
        expect.objectContaining({
          type: "command",
          command: expect.stringContaining("hook post-tool-use claude-code"),
          timeout: 5,
        }),
      ],
    });
    expect(merged.hooks.Stop!.at(-1)).toEqual({
      hooks: [
        {
          type: "command",
          command: expect.stringContaining("hook stop claude-code"),
          timeout: 5,
        },
      ],
    });
    expect(merged.hooks.UserPromptSubmit!.at(-1)).toEqual({
      hooks: [
        {
          type: "command",
          command: expect.stringContaining(
            "hook user-prompt-submit claude-code",
          ),
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
    const once = mergeClaudeSettings(existingClaudeSettings, bridgePath);
    const twice = mergeClaudeSettings(once, bridgePath);

    expect(twice).toEqual(once);
    expect(
      JSON.stringify(twice).match(/DECISION_HOOK=1/gu),
    ).toHaveLength(3);
  });

  it("runs Windows hooks through cmd without a shell, replacing the cmd-syntax ones", () => {
    const windowsBridge =
      "C:\\Program Files\\Decision\\resources\\bridge\\decision-bridge.cmd";
    const before = {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: `set "DECISION_HOOK=1" && call "${windowsBridge}" hook stop claude-code` }] }],
      },
    };
    const merged = mergeClaudeSettings(before, windowsBridge, "win32");

    // Claude Code runs a hook's command in Git Bash, or PowerShell without it: cmd's `set "…" && call` ran in neither.
    expect(merged.hooks.Stop).toEqual([
      {
        hooks: [
          {
            type: "command",
            command: "cmd.exe",
            args: ["/d", "/v:off", "/c", "call", windowsBridge, "hook", "stop", "claude-code", "DECISION_HOOK=2"],
            timeout: 5,
          },
        ],
      },
    ]);
    expect(() => mergeClaudeSettings({}, "C:\\Users\\R&D\\decision-bridge.cmd", "win32")).toThrow(/^Decision 所在的路径里有命令行会另作解释的字符/u);
  });

  it("starts the MCP bridge through cmd on Windows, where it is a .cmd", () => {
    const windowsBridge = "C:\\Users\\Ada Lovelace\\Decision\\decision-bridge.cmd";
    expect(claudeMcpCommands(windowsBridge, "win32").at(-1)!.args.slice(5)).toEqual([
      "--", "cmd", "/d", "/v:off", "/c", "call", windowsBridge, "mcp", "claude-code",
    ]);
  });

  it("replaces an installed legacy bridge path with the current one", () => {
    const legacyPath =
      "/Applications/Decision Previous.app/Contents/Resources/bridge/decision-bridge";
    const legacy = mergeClaudeSettings(existingClaudeSettings, legacyPath);

    const merged = mergeClaudeSettings(legacy, bridgePath);
    const serialized = JSON.stringify(merged);

    expect(serialized).not.toContain(legacyPath);
    expect(serialized.match(new RegExp(bridgePath, "gu"))).toHaveLength(3);
  });

  it("removes legacy owned handlers without removing neighboring hooks", () => {
    const merged = mergeClaudeSettings(
      {
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: "DECISION_HOOK=3 old hook stop claude-code",
                },
                {
                  type: "command",
                  command: "echo keep-me",
                },
              ],
            },
          ],
        },
      },
      bridgePath,
    );

    expect(JSON.stringify(merged)).not.toContain("DECISION_HOOK=3");
    expect(JSON.stringify(merged)).toContain("echo keep-me");
    expect(
      JSON.stringify(merged).match(/DECISION_HOOK=1/gu),
    ).toHaveLength(3);
  });

  it("keeps a reader's own hook that only mentions the marker or the bridge's words", () => {
    const own = [
      { type: "command", command: "SKIP_DECISION_HOOK=1 ~/bin/notify-done.sh" },
      { type: "command", command: "DECISION_HOOK=1 ~/bin/notify-done.sh" },
      { type: "command", command: "~/bin/log.sh hook stop claude-code" },
    ];
    const merged = mergeClaudeSettings({ hooks: { Stop: [{ hooks: own }] } }, bridgePath);

    expect(merged.hooks.Stop![0]).toEqual({ hooks: own });
  });

  it("preserves unknown fields and non-command hook handlers", () => {
    const input = {
      hooks: {
        Stop: [
          {
            matcher: "custom",
            customGroupField: { keep: true },
            hooks: [
              {
                type: "prompt",
                prompt: "Check the result",
                async: true,
              },
              {
                type: "command",
                command: "existing-command",
                async: true,
                customHandlerField: 42,
              },
            ],
          },
        ],
      },
    };

    const merged = mergeClaudeSettings(input, bridgePath);

    expect(merged.hooks.Stop![0]).toEqual(input.hooks.Stop[0]);
  });

  it("replaces the user-scoped MCP with the read-only bridge server", () => {
    expect(claudeMcpCommands(bridgePath)).toEqual([
      { command: "claude", args: ["mcp", "get", "decision"], tolerateFailure: true, expectsBridgeFor: "claude-code" },
      {
        command: "claude",
        args: ["mcp", "remove", "--scope", "user", "decision"],
        tolerateFailure: true,
        absentMcpName: "decision",
      },
      {
        command: "claude",
        args: [
          "mcp",
          "add",
          "--scope",
          "user",
          "decision",
          "--",
          bridgePath,
          "mcp",
          "claude-code",
        ],
        tolerateFailure: false,
      },
    ]);
  });
});
