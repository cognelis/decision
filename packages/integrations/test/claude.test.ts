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

  it("replaces an installed legacy bridge path with the current one", () => {
    const legacyPath =
      "/Applications/Decision Island Legacy.app/Contents/Resources/bridge/decision-bridge";
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
                  command: "DECISION_ISLAND_HOOK=1 old hook stop",
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

    expect(JSON.stringify(merged)).not.toContain("DECISION_ISLAND_HOOK=1");
    expect(JSON.stringify(merged)).toContain("echo keep-me");
    expect(
      JSON.stringify(merged).match(/DECISION_HOOK=1/gu),
    ).toHaveLength(3);
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
      {
        command: "claude",
        args: ["mcp", "remove", "--scope", "user", "decision-island"],
        tolerateFailure: true,
        absentMcpName: "decision-island",
      },
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
