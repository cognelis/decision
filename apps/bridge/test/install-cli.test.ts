import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mergeClaudeSettings, type InstallReport } from "@cognelis/decision-integrations";
import { describe, expect, it, vi } from "vitest";

import { main, type CliDependencies } from "../src/cli.js";

const report: InstallReport = {
  mode: "dry-run",
  targets: [
    {
      client: "claude-code",
      path: "/Users/demo/.claude/settings.json",
      changed: true,
    },
    {
      client: "codex",
      path: "/Users/demo/.codex/hooks.json",
      changed: true,
    },
  ],
  commands: [],
  restartRequired: true,
};

describe("decision-bridge install command", () => {
  it("starts the read-only MCP server for a supported client", async () => {
    const serveMcp = vi.fn();

    const exitCode = await main(["mcp", "codex"], { serveMcp });

    expect(exitCode).toBe(0);
    expect(serveMcp).toHaveBeenCalledWith({ sourceClient: "codex" });
  });

  it("starts no MCP server inside a model call the App started", async () => {
    // A Claude Code or Codex CLI the App runs as a model backend, should it still load the reader's MCP
    // servers, would otherwise reach Decision's write tools from inside that call.
    const serveMcp = vi.fn();

    const exitCode = await main(["mcp", "claude-code"], {
      serveMcp,
      environment: { DECISION_PROVIDER_CHILD: "1" },
    });

    expect(exitCode).toBe(0);
    expect(serveMcp).not.toHaveBeenCalled();
  });

  it("rejects an unsupported MCP client", async () => {
    const serveMcp = vi.fn();
    const errors: string[] = [];

    const exitCode = await main(["mcp", "other"], {
      serveMcp,
      printError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(2);
    expect(serveMcp).not.toHaveBeenCalled();
    expect(errors.join("")).toContain("claude-code|codex");
  });

  it("runs a dry-run with user-level config paths", async () => {
    const installer = vi.fn(async () => report);
    const output: unknown[] = [];
    const dependencies: CliDependencies = {
      installer,
      bridgePath: "/Applications/Decision.app/bridge",
      userHome: "/Users/demo",
      // Not the machine running the tests: CLAUDE_CONFIG_DIR or CODEX_HOME there would move these paths.
      environment: {},
      printJson: (value) => output.push(value),
    };

    const exitCode = await main(["install", "--dry-run"], dependencies);

    expect(exitCode).toBe(0);
    expect(installer).toHaveBeenCalledWith({
      mode: "dry-run",
      bridgePath: "/Applications/Decision.app/bridge",
      claudeSettingsPath: "/Users/demo/.claude/settings.json",
      codexHooksPath: "/Users/demo/.codex/hooks.json",
    });
    expect(output).toEqual([report]);
  });

  it("writes hooks where a client reads them when its config folder is moved", async () => {
    const installer = vi.fn(async () => report);
    await main(["install", "--dry-run"], {
      installer,
      environment: { CLAUDE_CONFIG_DIR: "/Users/demo/cfg/claude", CODEX_HOME: "/Users/demo/cfg/codex" },
      userHome: "/Users/demo",
      printJson: () => undefined,
    });
    expect(installer).toHaveBeenCalledWith(expect.objectContaining({
      claudeSettingsPath: "/Users/demo/cfg/claude/settings.json",
      codexHooksPath: "/Users/demo/cfg/codex/hooks.json",
    }));
  });

  it("uses the configured current bridge path", async () => {
    const installer = vi.fn(async () => report);
    await main(["install", "--dry-run"], { installer, environment: { DECISION_BRIDGE_PATH: "/custom/decision-bridge" }, userHome: "/Users/demo", printJson: () => undefined });
    expect(installer).toHaveBeenCalledWith(expect.objectContaining({ bridgePath: "/custom/decision-bridge" }));
  });

  it("fails an install a client was not connected by, though the other was", async () => {
    const installer = vi.fn(async () => ({
      ...report,
      mode: "apply" as const,
      targets: [
        { ...report.targets[0]!, status: "installed" as const },
        { ...report.targets[1]!, status: "failed" as const, detail: "permission denied" },
      ],
    }));

    expect(await main(["install", "--apply"], { installer, userHome: "/Users/demo", environment: {}, printJson: () => undefined })).toBe(1);
  });

  it("says beside the App's state whether each client's hooks reach it, and fails when none will", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-doctor-"));
    await mkdir(join(root, ".claude"));
    const bridge = "/Applications/Decision.app/Contents/Resources/bridge/decision-bridge";
    await writeFile(join(root, ".claude", "settings.json"), JSON.stringify(mergeClaudeSettings({}, bridge, process.platform)));
    const printed: unknown[] = [];
    const doctor = (bridgePath: string) =>
      main(["doctor"], {
        environment: {},
        userHome: root,
        bridgePath,
        runtime: { deliver: vi.fn(), doctor: async () => ({ appStatus: "healthy", port: 1 }) },
        printJson: (value) => printed.push(value),
      });

    expect(await doctor(bridge)).toBe(0);
    expect(printed.at(-1)).toEqual({ appStatus: "healthy", port: 1, hooks: { claudeCode: "installed", codex: "not-installed" } });

    // The App moved: its hooks name a bridge no longer there, and run nothing.
    expect(await doctor("/Volumes/Elsewhere/Decision.app/Contents/Resources/bridge/decision-bridge")).toBe(1);
    expect(printed.at(-1)).toMatchObject({ hooks: { claudeCode: "upgrade-required", codex: "not-installed" } });
  });

  it("says what it would take out of both clients, and takes it out only with --apply", async () => {
    const remover = vi.fn<NonNullable<CliDependencies["remover"]>>(async ({ mode }) => ({ ...report, mode }));
    const output: unknown[] = [];
    const errors: string[] = [];
    const dependencies: CliDependencies = {
      remover,
      bridgePath: "/Applications/Decision.app/bridge",
      userHome: "/Users/demo",
      environment: {},
      printJson: (value) => output.push(value),
      printError: (value) => errors.push(value),
    };

    expect(await main(["uninstall"], dependencies)).toBe(0);
    // With the bridge it was started as: the server the client shows running it is this app's, however named.
    expect(remover).toHaveBeenLastCalledWith({
      mode: "dry-run",
      bridgePath: "/Applications/Decision.app/bridge",
      claudeSettingsPath: "/Users/demo/.claude/settings.json",
      codexHooksPath: "/Users/demo/.codex/hooks.json",
    });
    expect(await main(["uninstall", "--apply"], dependencies)).toBe(0);
    expect(remover).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "apply" }));
    expect(output).toHaveLength(2);

    // A client it could not take out fails the command, for a script to see.
    remover.mockResolvedValueOnce({ ...report, mode: "apply", targets: [{ ...report.targets[0]!, status: "failed", detail: "permission denied" }] });
    expect(await main(["uninstall", "--apply"], dependencies)).toBe(1);

    expect(await main(["uninstall", "--force"], dependencies)).toBe(2);
    expect(remover).toHaveBeenCalledTimes(3);
    expect(errors.join("")).toContain("uninstall [--apply]");
  });

  it("rejects an unknown install mode without writing", async () => {
    const installer = vi.fn();
    const errors: string[] = [];

    const exitCode = await main(["install", "--unknown"], {
      installer,
      printError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(2);
    expect(installer).not.toHaveBeenCalled();
    expect(errors.join("")).toContain("--dry-run");
  });
});
