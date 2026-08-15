import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  commandInvocation,
  installIntegrations,
  type CommandRunner,
} from "../src/index.js";
import { existingClaudeSettings, existingCodexHooks } from "./fixtures.js";

const bridgePath =
  "/Applications/Decision.app/Contents/Resources/bridge/decision-bridge";

const makeConfig = async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-install-"));
  const claudeSettingsPath = join(root, ".claude", "settings.json");
  const codexHooksPath = join(root, ".codex", "hooks.json");
  await import("node:fs/promises").then(({ mkdir }) =>
    Promise.all([
      mkdir(join(root, ".claude"), { recursive: true }),
      mkdir(join(root, ".codex"), { recursive: true }),
    ]),
  );
  await writeFile(
    claudeSettingsPath,
    `${JSON.stringify(existingClaudeSettings, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    codexHooksPath,
    `${JSON.stringify(existingCodexHooks, null, 2)}\n`,
    "utf8",
  );
  return { root, claudeSettingsPath, codexHooksPath };
};

describe("installIntegrations", () => {
  it("runs Windows client shims through the command interpreter", () => {
    expect(
      commandInvocation("claude", [
        "mcp",
        "add",
        "--",
        "C:\\Program Files\\Decision\\decision-bridge.cmd",
      ], {
        platform: "win32",
        commandInterpreter: "C:\\Windows\\System32\\cmd.exe",
      }),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/v:off",
        "/c",
        '"claude" "mcp" "add" "--" "C:\\Program Files\\Decision\\decision-bridge.cmd"',
      ],
    });
  });

  it("keeps POSIX client execution argument-safe", () => {
    expect(
      commandInvocation("codex", ["mcp", "remove", "decision"], {
        platform: "darwin",
      }),
    ).toEqual({
      command: "codex",
      args: ["mcp", "remove", "decision"],
    });
  });

  it("dry-runs without touching files or executing client commands", async () => {
    const paths = await makeConfig();
    const beforeClaude = await readFile(paths.claudeSettingsPath, "utf8");
    const beforeCodex = await readFile(paths.codexHooksPath, "utf8");
    const runner = vi.fn<CommandRunner>();

    const report = await installIntegrations({
      mode: "dry-run",
      bridgePath,
      claudeSettingsPath: paths.claudeSettingsPath,
      codexHooksPath: paths.codexHooksPath,
      runner,
    });

    expect(report.mode).toBe("dry-run");
    expect(report.targets).toEqual([
      {
        client: "claude-code",
        path: paths.claudeSettingsPath,
        changed: true,
      },
      {
        client: "codex",
        path: paths.codexHooksPath,
        changed: true,
      },
    ]);
    expect(await readFile(paths.claudeSettingsPath, "utf8")).toBe(beforeClaude);
    expect(await readFile(paths.codexHooksPath, "utf8")).toBe(beforeCodex);
    expect(runner).not.toHaveBeenCalled();
  });

  it("replaces legacy entries and installs read-only MCP servers without backups", async () => {
    const paths = await makeConfig();
    const runner = vi.fn<CommandRunner>(async () => ({ exitCode: 0 }));

    const report = await installIntegrations({
      mode: "apply",
      bridgePath,
      claudeSettingsPath: paths.claudeSettingsPath,
      codexHooksPath: paths.codexHooksPath,
      runner,
    });

    expect(
      JSON.parse(await readFile(paths.claudeSettingsPath, "utf8")),
    ).toMatchObject({ defaultMode: "acceptEdits" });
    expect(
      JSON.parse(await readFile(paths.codexHooksPath, "utf8")),
    ).toMatchObject({ description: "Existing personal hooks" });
    expect(runner).toHaveBeenCalledTimes(6);
    expect(runner.mock.calls).toEqual([
      ["claude", ["mcp", "remove", "--scope", "user", "decision-island"]],
      ["claude", ["mcp", "remove", "--scope", "user", "decision"]],
      [
        "claude",
        [
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
      ],
      ["codex", ["mcp", "remove", "decision-island"]],
      ["codex", ["mcp", "remove", "decision"]],
      [
        "codex",
        [
          "mcp",
          "add",
          "decision",
          "--",
          bridgePath,
          "mcp",
          "codex",
        ],
      ],
    ]);
    expect(report.targets).toEqual([
      {
        client: "claude-code",
        path: paths.claudeSettingsPath,
        changed: true,
      },
      {
        client: "codex",
        path: paths.codexHooksPath,
        changed: true,
      },
    ]);
    expect(
      (await readdir(paths.root, { recursive: true })).filter((path) =>
        path.includes("decision-island-backup"),
      ),
    ).toEqual([]);
    expect(report.restartRequired).toBe(true);
  });

  it("writes nothing and runs nothing when either JSON file is invalid", async () => {
    const paths = await makeConfig();
    await writeFile(paths.codexHooksPath, "{ invalid", "utf8");
    const beforeClaude = await readFile(paths.claudeSettingsPath, "utf8");
    const runner = vi.fn<CommandRunner>();

    await expect(
      installIntegrations({
        mode: "apply",
        bridgePath,
        claudeSettingsPath: paths.claudeSettingsPath,
        codexHooksPath: paths.codexHooksPath,
        runner,
      }),
    ).rejects.toThrow(/invalid JSON/i);

    expect(await readFile(paths.claudeSettingsPath, "utf8")).toBe(beforeClaude);
    expect(await readFile(paths.codexHooksPath, "utf8")).toBe("{ invalid");
    expect(runner).not.toHaveBeenCalled();
  });

  it("is idempotent on a second apply", async () => {
    const paths = await makeConfig();
    const runner = vi.fn<CommandRunner>(async () => ({ exitCode: 0 }));
    const options = {
      mode: "apply" as const,
      bridgePath,
      claudeSettingsPath: paths.claudeSettingsPath,
      codexHooksPath: paths.codexHooksPath,
      runner,
    };
    await installIntegrations(options);

    const second = await installIntegrations(options);

    expect(second.targets.map((target) => target.changed)).toEqual([
      false,
      false,
    ]);
  });

  it("tolerates only cleanup failures that confirm the MCP is absent", async () => {
    const paths = await makeConfig();
    const runner = vi.fn<CommandRunner>(async (command, args) => {
      if (args[1] !== "remove") {
        return { exitCode: 0 };
      }
      const target = args.at(-1);
      return {
        exitCode: 1,
        stderr:
          command === "claude"
            ? `No MCP server found with name: ${target}`
            : `MCP server ${target} does not exist`,
      };
    });

    await expect(
      installIntegrations({
        mode: "apply",
        bridgePath,
        claudeSettingsPath: paths.claudeSettingsPath,
        codexHooksPath: paths.codexHooksPath,
        runner,
      }),
    ).resolves.toMatchObject({ mode: "apply" });
  });

  it("tolerates Claude's current absent-MCP wording", async () => {
    const paths = await makeConfig();
    const runner = vi.fn<CommandRunner>(async (command, args) =>
      command === "claude" && args[1] === "remove"
        ? {
            exitCode: 1,
            stderr: `No MCP server named "${args.at(-1)}" in user scope`,
          }
        : { exitCode: 0 },
    );

    await expect(
      installIntegrations({
        mode: "apply",
        bridgePath,
        claudeSettingsPath: paths.claudeSettingsPath,
        codexHooksPath: paths.codexHooksPath,
        runner,
      }),
    ).resolves.toMatchObject({ mode: "apply" });
  });

  it("does not mark v3 hooks installed when MCP setup fails", async () => {
    const paths = await makeConfig();
    const beforeClaude = await readFile(paths.claudeSettingsPath, "utf8");
    const beforeCodex = await readFile(paths.codexHooksPath, "utf8");
    const runner = vi.fn<CommandRunner>(async () => ({
      exitCode: 1,
      stderr: "permission denied",
    }));

    await expect(
      installIntegrations({
        mode: "apply",
        bridgePath,
        claudeSettingsPath: paths.claudeSettingsPath,
        codexHooksPath: paths.codexHooksPath,
        runner,
      }),
    ).rejects.toThrow(/permission denied/i);

    expect(await readFile(paths.claudeSettingsPath, "utf8")).toBe(
      beforeClaude,
    );
    expect(await readFile(paths.codexHooksPath, "utf8")).toBe(beforeCodex);
  });

  it("does not mistake an unrelated missing file for an absent MCP", async () => {
    const paths = await makeConfig();
    const runner = vi.fn<CommandRunner>(async () => ({
      exitCode: 1,
      stderr: "configuration file not found",
    }));

    await expect(
      installIntegrations({
        mode: "apply",
        bridgePath,
        claudeSettingsPath: paths.claudeSettingsPath,
        codexHooksPath: paths.codexHooksPath,
        runner,
      }),
    ).rejects.toThrow(/configuration file not found/i);
  });

  it("does not accept an absence message for a different MCP target", async () => {
    const paths = await makeConfig();
    const runner = vi.fn<CommandRunner>(async () => ({
      exitCode: 1,
      stderr: "MCP server other not found; configured servers: decision-island",
    }));

    await expect(
      installIntegrations({
        mode: "apply",
        bridgePath,
        claudeSettingsPath: paths.claudeSettingsPath,
        codexHooksPath: paths.codexHooksPath,
        runner,
      }),
    ).rejects.toThrow(/MCP server other not found/i);
  });

  it("does not accept an absent MCP whose name merely has the target prefix", async () => {
    const paths = await makeConfig();
    const runner = vi.fn<CommandRunner>(async () => ({
      exitCode: 1,
      stderr: "No MCP server found with name: decision-island-backup",
    }));

    await expect(
      installIntegrations({
        mode: "apply",
        bridgePath,
        claudeSettingsPath: paths.claudeSettingsPath,
        codexHooksPath: paths.codexHooksPath,
        runner,
      }),
    ).rejects.toThrow(/decision-island-backup/i);
  });
});
