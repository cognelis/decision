import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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

  it("reports complete legacy hooks as requiring an upgrade", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-status-"));
    const claude = join(root, "claude.json");
    const codex = join(root, "codex.json");
    await writeFile(
      claude,
      JSON.stringify(passiveHook("claude-code", "DECISION_ISLAND_HOOK=3")),
      "utf8",
    );
    await writeFile(
      codex,
      JSON.stringify(passiveHook("codex", "DECISION_ISLAND_HOOK=3")),
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
