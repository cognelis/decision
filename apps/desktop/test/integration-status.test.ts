import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { hookBridgeReference, mergeClaudeSettings, mergeCodexHooks } from "@cognelis/decision-integrations";

import { detectIntegrationStatus } from "../src/main/integration-status.js";

const passiveHook = (
  client: "claude-code" | "codex",
  marker = "DECISION_HOOK=1",
) => ({
  hooks: {
    PostToolUse: [
      {
        matcher:
          client === "claude-code"
            ? "^AskUserQuestion$"
            : "^(request_user_input|AskUserQuestion)$",
        hooks: [
          {
            type: "command",
            command:
              `${marker} '/app/bridge' ` +
              `hook post-tool-use ${client}`,
            timeout: 5,
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: "command",
            command:
              `${marker} '/app/bridge' ` +
              `hook stop ${client}`,
            timeout: 5,
          },
        ],
      },
    ],
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: "command",
            command:
              `${marker} '/app/bridge' ` +
              `hook user-prompt-submit ${client}`,
            timeout: 5,
          },
        ],
      },
    ],
  },
});

describe("detectIntegrationStatus", () => {
  it("reports installed only when each hybrid passive hook exists", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "decision-status-"),
    );
    const claude = join(root, "claude.json");
    const codex = join(root, "codex.json");
    await writeFile(
      claude,
      JSON.stringify(passiveHook("claude-code")),
      "utf8",
    );
    await writeFile(
      codex,
      JSON.stringify(passiveHook("codex")),
      "utf8",
    );

    await expect(
      detectIntegrationStatus({
        claudeSettingsPath: claude,
        codexHooksPath: codex,
      }),
    ).resolves.toEqual({
      claudeCode: "installed",
      codex: "installed",
    });
  });

  it("says Claude Code runs none of the hooks when its settings turn every hook off", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-status-"));
    const claude = join(root, "claude.json");
    await writeFile(claude, JSON.stringify({ ...passiveHook("claude-code"), disableAllHooks: true }), "utf8");

    await expect(detectIntegrationStatus({ claudeSettingsPath: claude, codexHooksPath: join(root, "absent.json") }))
      .resolves.toEqual({ claudeCode: "disabled", codex: "not-installed" });

    // Set with none of this app's hooks there (a reader who only ever connected Codex): never connected, not off.
    await writeFile(claude, JSON.stringify({ disableAllHooks: true, model: "opus" }), "utf8");
    await expect(detectIntegrationStatus({ claudeSettingsPath: claude, codexHooksPath: join(root, "absent.json") }))
      .resolves.toEqual({ claudeCode: "not-installed", codex: "not-installed" });
  });

  it("asks to reconnect hooks that run a bridge this app no longer keeps there", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-status-"));
    const claude = join(root, "claude.json");
    const codex = join(root, "codex.json");
    await writeFile(claude, JSON.stringify(passiveHook("claude-code")), "utf8");
    await writeFile(codex, JSON.stringify(passiveHook("codex")), "utf8");
    const paths = { claudeSettingsPath: claude, codexHooksPath: codex };

    await expect(detectIntegrationStatus(paths, "'/app/bridge'")).resolves.toEqual({ claudeCode: "installed", codex: "installed" });
    // The app moved, or upgraded into a new folder: the hooks still name the old bridge.
    await expect(detectIntegrationStatus(paths, "'/Applications/Decision.app/Contents/Resources/bridge/decision-bridge'"))
      .resolves.toEqual({ claudeCode: "upgrade-required", codex: "upgrade-required" });
  });

  it("knows Windows hooks in the form both clients run, and asks to reconnect the cmd-syntax ones", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-status-"));
    const bridge = "C:\\Program Files\\Decision\\resources\\bridge\\decision-bridge.cmd";
    const claude = join(root, "claude.json");
    const codex = join(root, "codex.json");
    const paths = { claudeSettingsPath: claude, codexHooksPath: codex };
    await writeFile(claude, JSON.stringify(mergeClaudeSettings({}, bridge, "win32")), "utf8");
    await writeFile(codex, JSON.stringify(mergeCodexHooks({}, bridge, "win32")), "utf8");
    await expect(detectIntegrationStatus(paths, hookBridgeReference(bridge, "win32"), "win32"))
      .resolves.toEqual({ claudeCode: "installed", codex: "installed" });

    // Written before in cmd's syntax, which Claude Code's Git Bash or PowerShell never ran.
    await writeFile(claude, JSON.stringify(passiveHook("claude-code", 'set "DECISION_HOOK=1" &&')), "utf8");
    await writeFile(codex, JSON.stringify(passiveHook("codex", 'set "DECISION_HOOK=1" &&')), "utf8");
    await expect(detectIntegrationStatus(paths, hookBridgeReference(bridge, "win32"), "win32"))
      .resolves.toEqual({ claudeCode: "upgrade-required", codex: "upgrade-required" });
  });

  it("reports complete legacy hooks as requiring an upgrade", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-status-"));
    const claude = join(root, "claude.json");
    const codex = join(root, "codex.json");
    await writeFile(
      claude,
      JSON.stringify(passiveHook("claude-code", "DECISION_HOOK=3")),
      "utf8",
    );
    await writeFile(
      codex,
      JSON.stringify(passiveHook("codex", "DECISION_HOOK=3")),
      "utf8",
    );

    await expect(
      detectIntegrationStatus({
        claudeSettingsPath: claude,
        codexHooksPath: codex,
      }),
    ).resolves.toEqual({
      claudeCode: "upgrade-required",
      codex: "upgrade-required",
    });
  });

  it("reports a partial passive hook installation as not installed", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "decision-status-"),
    );
    const partial = passiveHook("claude-code");
    delete (
      partial.hooks as Partial<typeof partial.hooks>
    ).UserPromptSubmit;
    const path = join(root, "partial.json");
    await writeFile(path, JSON.stringify(partial), "utf8");

    await expect(
      detectIntegrationStatus({
        claudeSettingsPath: path,
        codexHooksPath: path,
      }),
    ).resolves.toEqual({
      claudeCode: "not-installed",
      codex: "not-installed",
    });
  });

  it("does not treat legacy behavior-changing hooks as installed", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "decision-status-"),
    );
    const legacy = join(root, "legacy.json");
    await writeFile(
      legacy,
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  command:
                    "DECISION_HOOK=1 bridge hook session-start",
                },
              ],
            },
          ],
        },
      }),
      "utf8",
    );

    await expect(
      detectIntegrationStatus({
        claudeSettingsPath: legacy,
        codexHooksPath: legacy,
      }),
    ).resolves.toEqual({
      claudeCode: "not-installed",
      codex: "not-installed",
    });
  });

  it("reports missing as not installed and malformed JSON as unknown", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "decision-status-"),
    );
    const malformed = join(root, "malformed.json");
    await writeFile(malformed, "{broken", "utf8");

    await expect(
      detectIntegrationStatus({
        claudeSettingsPath: join(root, "missing.json"),
        codexHooksPath: malformed,
      }),
    ).resolves.toEqual({
      claudeCode: "not-installed",
      codex: "unknown",
    });
  });
});
