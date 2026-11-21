import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { mergeClaudeSettings, type InstallReport } from "@cognelis/decision-integrations";
import { describe, expect, it, vi } from "vitest";

import { bundledSkillsDirectory, main, type CliDependencies } from "../src/cli.js";

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

describe("paraself-bridge install command", () => {
  it("starts the read-only MCP server for a supported client", async () => {
    const serveMcp = vi.fn();

    const exitCode = await main(["mcp", "codex"], { serveMcp });

    expect(exitCode).toBe(0);
    expect(serveMcp).toHaveBeenCalledWith({ sourceClient: "codex" });
  });

  it("starts no MCP server inside a model call the App started", async () => {
    // A Claude Code or Codex CLI the App runs as a model backend, should it still load the reader's MCP
    // servers, would otherwise reach Paraself's write tools from inside that call.
    const serveMcp = vi.fn();

    const exitCode = await main(["mcp", "claude-code"], {
      serveMcp,
      environment: { PARASELF_PROVIDER_CHILD: "1" },
    });

    expect(exitCode).toBe(0);
    expect(serveMcp).not.toHaveBeenCalled();
  });

  it("rejects an MCP command line with no client's id in it", async () => {
    const serveMcp = vi.fn();
    const errors: string[] = [];

    // An id in form that no file describes is a client deleted since: quietly none (custom-client-hooks.test.ts).
    const exitCode = await main(["mcp", "Other Client"], {
      serveMcp,
      printError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(2);
    expect(serveMcp).not.toHaveBeenCalled();
    expect(errors.join("")).toContain("claude-code|codex|grok|antigravity");
  });

  it("starts the MCP server for Grok and Antigravity as for the others", async () => {
    const serveMcp = vi.fn();

    expect(await main(["mcp", "grok"], { serveMcp })).toBe(0);
    expect(await main(["mcp", "antigravity"], { serveMcp })).toBe(0);
    expect(serveMcp.mock.calls).toEqual([[{ sourceClient: "grok" }], [{ sourceClient: "antigravity" }]]);
  });

  it("runs a dry-run with user-level config paths", async () => {
    const installer = vi.fn(async () => report);
    const output: unknown[] = [];
    const dependencies: CliDependencies = {
      installer,
      bridgePath: "/Applications/Paraself.app/bridge",
      userHome: "/Users/demo",
      // Not the machine running the tests: CLAUDE_CONFIG_DIR or CODEX_HOME there would move these paths.
      environment: {},
      printJson: (value) => output.push(value),
    };

    const exitCode = await main(["install", "--dry-run"], dependencies);

    expect(exitCode).toBe(0);
    expect(installer).toHaveBeenCalledWith({
      mode: "dry-run",
      bridgePath: "/Applications/Paraself.app/bridge",
      paths: {
        "claude-code": "/Users/demo/.claude/settings.json",
        codex: "/Users/demo/.codex/hooks.json",
        grok: "/Users/demo/.grok/hooks/paraself.json",
        antigravity: "/Users/demo/.gemini/config/hooks.json",
      },
      home: "/Users/demo",
      environment: {},
      // Run from source: the repository's own skills folder, as the packaged bridge finds Resources/skills.
      skillsSource: expect.stringMatching(/[/\\]skills$/u),
    });
    expect(output).toEqual([report]);
  });

  it("writes hooks where a client reads them when its config folder is moved", async () => {
    const installer = vi.fn(async () => report);
    await main(["install", "--dry-run"], {
      installer,
      environment: { CLAUDE_CONFIG_DIR: "/Users/demo/cfg/claude", CODEX_HOME: "/Users/demo/cfg/codex", GROK_HOME: "/Users/demo/cfg/grok" },
      userHome: "/Users/demo",
      printJson: () => undefined,
    });
    expect(installer).toHaveBeenCalledWith(expect.objectContaining({
      paths: {
        "claude-code": "/Users/demo/cfg/claude/settings.json",
        codex: "/Users/demo/cfg/codex/hooks.json",
        grok: "/Users/demo/cfg/grok/hooks/paraself.json",
        antigravity: "/Users/demo/.gemini/config/hooks.json",
      },
    }));
  });

  it("uses the configured current bridge path", async () => {
    const installer = vi.fn(async () => report);
    await main(["install", "--dry-run"], { installer, environment: { PARASELF_BRIDGE_PATH: "/custom/paraself-bridge" }, userHome: "/Users/demo", printJson: () => undefined });
    expect(installer).toHaveBeenCalledWith(expect.objectContaining({ bridgePath: "/custom/paraself-bridge" }));
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
    const bridge = "/Applications/Paraself.app/Contents/Resources/bridge/paraself-bridge";
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
    expect(printed.at(-1)).toEqual({ appStatus: "healthy", port: 1, hooks: { "claude-code": "installed", codex: "not-installed", grok: "not-installed", antigravity: "not-installed" } });

    // The App moved: its hooks name a bridge no longer there, and run nothing.
    expect(await doctor("/Volumes/Elsewhere/Paraself.app/Contents/Resources/bridge/paraself-bridge")).toBe(1);
    expect(printed.at(-1)).toMatchObject({ hooks: { "claude-code": "upgrade-required", codex: "not-installed" } });
  });

  it("says what it would take out of both clients, and takes it out only with --apply", async () => {
    const remover = vi.fn<NonNullable<CliDependencies["remover"]>>(async ({ mode }) => ({ ...report, mode }));
    const output: unknown[] = [];
    const errors: string[] = [];
    const dependencies: CliDependencies = {
      remover,
      bridgePath: "/Applications/Paraself.app/bridge",
      userHome: "/Users/demo",
      environment: {},
      printJson: (value) => output.push(value),
      printError: (value) => errors.push(value),
    };

    expect(await main(["uninstall"], dependencies)).toBe(0);
    // With the bridge it was started as: the server the client shows running it is this app's, however named.
    expect(remover).toHaveBeenLastCalledWith({
      mode: "dry-run",
      bridgePath: "/Applications/Paraself.app/bridge",
      paths: {
        "claude-code": "/Users/demo/.claude/settings.json",
        codex: "/Users/demo/.codex/hooks.json",
        grok: "/Users/demo/.grok/hooks/paraself.json",
        antigravity: "/Users/demo/.gemini/config/hooks.json",
      },
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

  it("finds the bundled skills beside a packaged bridge, the repository's from source, and none in a bare build", async () => {
    const resources = await mkdtemp(join(tmpdir(), "paraself-resources-"));
    await mkdir(join(resources, "bridge"), { recursive: true });
    await mkdir(join(resources, "skills", "paraself-memory"), { recursive: true });
    await writeFile(join(resources, "skills", "paraself-memory", "SKILL.md"), "x");
    expect(bundledSkillsDirectory(pathToFileURL(join(resources, "bridge", "paraself-bridge.mjs")).href)).toBe(join(resources, "bridge", "..", "skills"));
    expect(bundledSkillsDirectory()).toMatch(/[/\\]skills$/u);
    const bare = await mkdtemp(join(tmpdir(), "paraself-bare-"));
    expect(bundledSkillsDirectory(pathToFileURL(join(bare, "paraself-bridge.mjs")).href)).toBeNull();
  });

  it("fails an install whose skills could not be written, though every client connected", async () => {
    const installer = vi.fn(async () => ({ ...report, mode: "apply" as const, skills: [{ client: "codex" as const, skill: "paraself-memory", path: "~/.agents/skills/paraself-memory", status: "failed" as const, detail: "没有写入这个文件夹的权限" }] }));
    const exitCode = await main(["install", "--apply"], { installer, bridgePath: "/b", userHome: "/Users/demo", environment: {}, skillsSource: null, printJson: () => undefined });
    expect(exitCode).toBe(1);
    expect(installer).toHaveBeenCalledWith(expect.not.objectContaining({ skillsSource: expect.anything() }));
  });
});
