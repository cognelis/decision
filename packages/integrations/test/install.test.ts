import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  commandInvocation,
  installIntegrations,
  removeIntegrations,
  type CommandRunner,
} from "../src/index.js";
import { existingClaudeSettings, existingCodexHooks } from "./fixtures.js";

// A settings.json Windows holds open for a moment (an antivirus scan, a sync client): its next renames refuse,
// and so, for a moment longer, do its next reads.
const heldOpen = vi.hoisted(() => ({ count: 0, reads: 0, meanwhile: undefined as ((path: string) => Promise<void>) | undefined }));
// A settings file the reader may not write though its owner's bit says otherwise (root's, or an ACL denying it).
const unwritable = vi.hoisted(() => ({ path: undefined as string | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    access: async (path: string, mode?: number) => {
      if (path === unwritable.path) throw Object.assign(new Error(`EPERM: operation not permitted, access '${path}'`), { code: "EPERM" });
      return actual.access(path, mode);
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (heldOpen.reads > 0 && String(args[0]).endsWith("settings.json")) {
        heldOpen.reads -= 1;
        throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${String(args[0])}'`), { code: "EBUSY" });
      }
      return actual.readFile(...args);
    },
    rename: async (from: string, to: string) => {
      if (heldOpen.count > 0 && to.endsWith("settings.json")) {
        heldOpen.count -= 1;
        await heldOpen.meanwhile?.(to);
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: "EPERM" });
      }
      return actual.rename(from, to);
    },
  };
});

// The clients' commands as the default runner starts them: each says it ran, from where.
const spawned = vi.hoisted(() => ({ cwd: [] as (string | undefined)[], hang: false, killed: 0 }));
vi.mock("node:child_process", async (importOriginal) => {
  const { EventEmitter } = await import("node:events");
  return {
    ...(await importOriginal<typeof import("node:child_process")>()),
    spawn: (_command: string, _args: string[], options: { cwd?: string }) => {
      spawned.cwd.push(options.cwd);
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => { spawned.killed += 1; },
      });
      // One stuck on a lock or a network check never ends by itself.
      if (!spawned.hang) queueMicrotask(() => child.emit("close", 0));
      return child;
    },
  };
});

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
      // As the release smoke test runs the bridge on Windows: cmd /s takes the outer pair off, and the line
      // reaches it verbatim rather than with its quotes escaped by Node.
      windowsVerbatimArguments: true,
      args: [
        "/d",
        "/s",
        "/v:off",
        "/c",
        '""claude" "mcp" "add" "--" "C:\\Program Files\\Decision\\decision-bridge.cmd""',
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
      windowsVerbatimArguments: false,
    });
  });

  it("runs the clients' commands from the reader's home, where no project's own servers come before the user's", async () => {
    const paths = await makeConfig();
    spawned.cwd.length = 0;

    // Started from a repository with a `decision` server of another tool's in its .mcp.json, `claude mcp get` showed
    // that one, and this app's user-scoped server was refused as not its own.
    await installIntegrations({ mode: "apply", bridgePath, claudeSettingsPath: paths.claudeSettingsPath, codexHooksPath: paths.codexHooksPath });

    expect(spawned.cwd).toHaveLength(6);
    expect(new Set(spawned.cwd)).toEqual(new Set([homedir()]));
  });

  it("stops a client command that never ends, so the installs queued behind it run", async () => {
    const paths = await makeConfig();
    const options = { bridgePath, claudeSettingsPath: paths.claudeSettingsPath, codexHooksPath: paths.codexHooksPath };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    spawned.hang = true;
    spawned.killed = 0;
    try {
      void installIntegrations({ ...options, mode: "apply" }).catch(() => undefined);
      let after = false;
      void installIntegrations({ ...options, mode: "dry-run" }).then(() => { after = true; }, () => { after = true; });
      // Not stopped, the stuck command held the dry run behind it, and every later install, until the App was quit.
      // Each minute passed lets the real file reads between the commands land before the next one starts.
      for (let step = 0; step < 400 && !after; step += 1) {
        await vi.advanceTimersByTimeAsync(60_000);
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(spawned.killed).toBeGreaterThan(0);
      expect(after).toBe(true);
    } finally {
      spawned.hang = false;
      vi.useRealTimers();
    }
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
      ["claude", ["mcp", "get", "decision"]],
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
      ["codex", ["mcp", "get", "decision"]],
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
        status: "installed",
      },
      {
        client: "codex",
        path: paths.codexHooksPath,
        changed: true,
        status: "installed",
        // Codex runs none of them until the reader trusts them there.
        detail: expect.stringContaining("Hooks need review"),
      },
    ]);
    expect(
      (await readdir(paths.root, { recursive: true })).filter((path) =>
        path.includes("decision-backup"),
      ),
    ).toEqual([]);
    expect(report.restartRequired).toBe(true);
  });

  it("connects one client while the other's file is not valid JSON, touching nothing of that one's", async () => {
    const paths = await makeConfig();
    await writeFile(paths.codexHooksPath, "{ invalid", "utf8");
    const runner = vi.fn<CommandRunner>(async () => ({ exitCode: 0 }));
    const options = {
      bridgePath,
      claudeSettingsPath: paths.claudeSettingsPath,
      codexHooksPath: paths.codexHooksPath,
      runner,
    };

    // A check says which file it could not read, and still reports the other client.
    const checked = await installIntegrations({ ...options, mode: "dry-run" });
    expect(checked.targets.map(({ client, status, changed }) => ({ client, status, changed }))).toEqual([
      { client: "claude-code", status: undefined, changed: true },
      { client: "codex", status: "failed", changed: false },
    ]);

    const report = await installIntegrations({ ...options, mode: "apply" });
    expect(report.targets.map(({ client, status }) => ({ client, status }))).toEqual([
      { client: "claude-code", status: "installed" },
      { client: "codex", status: "failed" },
    ]);
    expect(report.targets[1]?.detail).toMatch(/不是有效的 JSON/u);
    expect(await readFile(paths.claudeSettingsPath, "utf8")).toContain("DECISION_HOOK=1");
    expect(await readFile(paths.codexHooksPath, "utf8")).toBe("{ invalid");
    expect(runner.mock.calls.every(([command]) => command === "claude")).toBe(true);
  });

  it("says in the reader's words why a client's file cannot be used", async () => {
    const paths = await makeConfig();
    const { chmod } = await import("node:fs/promises");
    await writeFile(paths.claudeSettingsPath, "[]\n", "utf8");
    await chmod(paths.codexHooksPath, 0o000);
    try {
      const checked = await installIntegrations({
        mode: "dry-run",
        bridgePath,
        claudeSettingsPath: paths.claudeSettingsPath,
        codexHooksPath: paths.codexHooksPath,
        runner: vi.fn<CommandRunner>(),
      }).catch((error: unknown) => error);

      // Neither could be read: "settings must be a JSON object", and Node's "EACCES: permission denied, open '…'".
      expect(String(checked)).toBe("Error: 整个文件应当是一个 JSON 对象，以 { 开头；没有读写它或它所在文件夹的权限，改好权限后再试");
    } finally {
      await chmod(paths.codexHooksPath, 0o600);
    }
  });

  it("writes nothing and runs nothing when neither file can be read", async () => {
    const paths = await makeConfig();
    await writeFile(paths.claudeSettingsPath, "{ invalid", "utf8");
    await writeFile(paths.codexHooksPath, "{ invalid", "utf8");
    const runner = vi.fn<CommandRunner>();

    await expect(
      installIntegrations({
        mode: "apply",
        bridgePath,
        claudeSettingsPath: paths.claudeSettingsPath,
        codexHooksPath: paths.codexHooksPath,
        runner,
      }),
    ).rejects.toThrow(/不是有效的 JSON/u);

    expect(await readFile(paths.claudeSettingsPath, "utf8")).toBe("{ invalid");
    expect(await readFile(paths.codexHooksPath, "utf8")).toBe("{ invalid");
    expect(runner).not.toHaveBeenCalled();
  });

  it("skips a client cmd cannot find on a Windows in any language, by cmd's own exit code", async () => {
    const paths = await makeConfig();
    // Chinese Windows: cmd says it in code page 936, read as UTF-8; the client was reported as failed in noise.
    const runner = vi.fn<CommandRunner>(async (command) =>
      command === "codex" ? { exitCode: 9009, stderr: "'codex' ����ڲ����ⲿ����" } : { exitCode: 0 });

    const report = await installIntegrations({
      mode: "apply",
      bridgePath,
      claudeSettingsPath: paths.claudeSettingsPath,
      codexHooksPath: paths.codexHooksPath,
      runner,
    });

    expect(report.targets.find((target) => target.client === "codex")).toMatchObject({ status: "skipped", detail: "没有找到 codex 命令" });
  });

  it("connects the client that is installed and skips the one whose command is not", async () => {
    const paths = await makeConfig();
    const beforeCodex = await readFile(paths.codexHooksPath, "utf8");
    const runner = vi.fn<CommandRunner>(async (command) => {
      if (command === "codex") throw Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
      return { exitCode: 0 };
    });

    const report = await installIntegrations({
      mode: "apply",
      bridgePath,
      claudeSettingsPath: paths.claudeSettingsPath,
      codexHooksPath: paths.codexHooksPath,
      runner,
    });

    expect(report.targets.map(({ client, status, detail }) => ({ client, status, detail }))).toEqual([
      { client: "claude-code", status: "installed", detail: undefined },
      { client: "codex", status: "skipped", detail: "没有找到 codex 命令" },
    ]);
    expect(await readFile(paths.claudeSettingsPath, "utf8")).toContain("DECISION_HOOK=1");
    expect(await readFile(paths.codexHooksPath, "utf8")).toBe(beforeCodex);

    // With neither command there, nothing is connected, and the reader is told what to install.
    const none = vi.fn<CommandRunner>(async (command) => {
      throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });
    });
    await expect(installIntegrations({
      mode: "apply",
      bridgePath,
      claudeSettingsPath: paths.claudeSettingsPath,
      codexHooksPath: paths.codexHooksPath,
      runner: none,
    })).rejects.toThrow("没有找到 claude 或 codex 命令");
  });

  it("keeps one client's result when the other's file cannot be written", async () => {
    const paths = await makeConfig();
    const { chmod } = await import("node:fs/promises");
    const codexFolder = join(paths.root, ".codex");
    await chmod(codexFolder, 0o500);
    try {
      const report = await installIntegrations({
        mode: "apply",
        bridgePath,
        claudeSettingsPath: paths.claudeSettingsPath,
        codexHooksPath: paths.codexHooksPath,
        runner: vi.fn<CommandRunner>(async () => ({ exitCode: 0 })),
      });

      expect(report.targets.map(({ client, status }) => ({ client, status }))).toEqual([
        { client: "claude-code", status: "installed" },
        { client: "codex", status: "failed" },
      ]);
      expect(report.targets[1]?.detail).toContain("无法写入");
      expect(await readFile(paths.claudeSettingsPath, "utf8")).toContain("DECISION_HOOK=1");
    } finally {
      await chmod(codexFolder, 0o700);
    }
  });

  it("leaves a settings file its owner made read-only, says so, and still connects the other client", async () => {
    const paths = await makeConfig();
    const { chmod } = await import("node:fs/promises");
    const before = await readFile(paths.claudeSettingsPath, "utf8");
    await chmod(paths.claudeSettingsPath, 0o444);
    const runner = vi.fn<CommandRunner>(async () => ({ exitCode: 0 }));
    const options = { bridgePath, claudeSettingsPath: paths.claudeSettingsPath, codexHooksPath: paths.codexHooksPath, platform: "darwin" as const, runner };

    const checked = await installIntegrations({ ...options, mode: "dry-run" });
    // Shown inside the page's own parentheses: none of its own.
    expect(checked.targets[0]).toMatchObject({ status: "failed", detail: `${paths.claudeSettingsPath} 设成了只读，没有改动它；先恢复它的写权限再试` });

    const report = await installIntegrations({ ...options, mode: "apply" });
    expect(report.targets.map(({ client, status }) => ({ client, status }))).toEqual([
      { client: "claude-code", status: "failed" },
      { client: "codex", status: "installed" },
    ]);
    expect(report.targets[0]?.detail).toMatch(/只读/u);
    expect(await readFile(paths.claudeSettingsPath, "utf8")).toBe(before);
    expect(runner.mock.calls.every(([command]) => command === "codex")).toBe(true);
  });

  it("leaves a settings file the reader may not write though its owner's bit allows it, on Windows too", async () => {
    const paths = await makeConfig();
    const before = await readFile(paths.claudeSettingsPath, "utf8");
    const runner = vi.fn<CommandRunner>(async () => ({ exitCode: 0 }));
    try {
      // Root's from a `sudo claude` once, or an ACL denying this user: the owner's write bit is set all the same,
      // and the rename replaced the file with a copy of the reader's own.
      unwritable.path = paths.claudeSettingsPath;
      const report = await installIntegrations({
        mode: "apply",
        bridgePath: "C:\\Program Files\\Decision\\decision-bridge.cmd",
        platform: "win32",
        claudeSettingsPath: paths.claudeSettingsPath,
        codexHooksPath: paths.codexHooksPath,
        runner,
      });
      expect(report.targets.map(({ client, status }) => ({ client, status }))).toEqual([
        { client: "claude-code", status: "failed" },
        { client: "codex", status: "installed" },
      ]);
      expect(report.targets[0]?.detail).toBe(`${paths.claudeSettingsPath} 设成了只读，没有改动它；先恢复它的写权限再试`);
      expect(await readFile(paths.claudeSettingsPath, "utf8")).toBe(before);
    } finally {
      unwritable.path = undefined;
    }
  });

  it("waits for a settings file Windows holds open for a moment, and does not write over what was saved meanwhile", async () => {
    const paths = await makeConfig();
    const options = {
      mode: "apply" as const,
      bridgePath: "C:\\Program Files\\Decision\\decision-bridge.cmd",
      platform: "win32" as const,
      claudeSettingsPath: paths.claudeSettingsPath,
      codexHooksPath: paths.codexHooksPath,
      runner: vi.fn<CommandRunner>(async () => ({ exitCode: 0 })),
    };
    try {
      heldOpen.count = 2;
      const report = await installIntegrations(options);
      expect(report.targets[0]).toMatchObject({ client: "claude-code", status: "installed" });
      expect(heldOpen.count).toBe(0);
      expect(await readFile(paths.claudeSettingsPath, "utf8")).toContain("DECISION_HOOK=2");

      // The client saved its own change while the rename waited: that is kept, and the reader asked to try again.
      await writeFile(paths.claudeSettingsPath, '{"model":"opus"}\n');
      heldOpen.count = 1;
      heldOpen.meanwhile = (path) => writeFile(path, '{"model":"sonnet"}\n');
      const raced = await installIntegrations(options);
      expect(raced.targets[0]).toMatchObject({ status: "failed", detail: expect.stringMatching(/再试一次/u) });
      expect(await readFile(paths.claudeSettingsPath, "utf8")).toBe('{"model":"sonnet"}\n');

      // Held against reading too, the moment after the rename refused: the next wait, not a refusal of the install.
      heldOpen.count = 2;
      heldOpen.meanwhile = async () => {
        heldOpen.reads = 1;
        heldOpen.meanwhile = undefined;
      };
      const waited = await installIntegrations(options);
      expect(waited.targets[0]).toMatchObject({ client: "claude-code", status: "installed" });
      expect(heldOpen.reads).toBe(0);
      expect(await readFile(paths.claudeSettingsPath, "utf8")).toContain("DECISION_HOOK=2");
    } finally {
      heldOpen.count = 0;
      heldOpen.reads = 0;
      heldOpen.meanwhile = undefined;
    }
  });

  it("writes a linked settings file where the link points, keeping the link and its mode", async () => {
    const paths = await makeConfig();
    const { chmod, lstat, rename: move, stat: status, symlink } = await import("node:fs/promises");
    const managed = join(paths.root, "dotfiles-settings.json");
    await move(paths.claudeSettingsPath, managed);
    await chmod(managed, 0o644);
    await symlink(managed, paths.claudeSettingsPath);

    await installIntegrations({
      mode: "apply",
      bridgePath,
      claudeSettingsPath: paths.claudeSettingsPath,
      codexHooksPath: paths.codexHooksPath,
      runner: vi.fn<CommandRunner>(async () => ({ exitCode: 0 })),
    });

    expect((await lstat(paths.claudeSettingsPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(managed, "utf8")).toContain("DECISION_HOOK=1");
    expect((await status(managed)).mode & 0o777).toBe(0o644);
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

  it("leaves another tool's MCP server named decision alone, saying so, and replaces this app's from an old path", async () => {
    const paths = await makeConfig();
    const before = await readFile(paths.claudeSettingsPath, "utf8");
    const runner = vi.fn<CommandRunner>(async (command, args) =>
      args[1] !== "get"
        ? { exitCode: 0 }
        : command === "claude"
          ? { exitCode: 0, stdout: "decision:\n  Scope: User config\n  Type: stdio\n  Command: npx\n  Args: -y decision-journal-mcp\n" }
          : {
              exitCode: 0,
              stdout: "decision\n  enabled: true\n  transport: stdio\n  command: /Volumes/Old/Decision.app/Contents/Resources/bridge/decision-bridge\n  args: mcp codex\n",
            });

    const report = await installIntegrations({
      mode: "apply",
      bridgePath,
      claudeSettingsPath: paths.claudeSettingsPath,
      codexHooksPath: paths.codexHooksPath,
      runner,
    });

    expect(report.targets.map(({ client, status }) => ({ client, status }))).toEqual([
      { client: "claude-code", status: "failed" },
      { client: "codex", status: "installed" },
    ]);
    expect(report.targets[0]?.detail).toMatch(/^Claude Code 里已有一个名为 decision 的 MCP 服务器，运行的不是本应用的桥接程序，没有改动它/u);
    expect(await readFile(paths.claudeSettingsPath, "utf8")).toBe(before);
    expect(runner.mock.calls.filter(([command]) => command === "claude")).toEqual([["claude", ["mcp", "get", "decision"]]]);
    expect(runner.mock.calls.filter(([command]) => command === "codex").map(([, args]) => args[1])).toEqual(["get", "remove", "add"]);
  });

  it("runs one install or removal at a time: one sent while another runs waits for it", async () => {
    const paths = await makeConfig();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const runner = vi.fn<CommandRunner>(async () => { await held; return { exitCode: 0 }; });
    const options = { claudeSettingsPath: paths.claudeSettingsPath, codexHooksPath: paths.codexHooksPath, platform: "darwin" as const, runner, bridgePath, mode: "apply" as const };
    const first = installIntegrations(options);
    await vi.waitFor(() => expect(runner).toHaveBeenCalled());
    const before = runner.mock.calls.length;

    // Sent by the page left and come back to while the first ran: it read and rewrote the same files and ran the
    // clients' commands over the first's.
    const second = removeIntegrations(options);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runner).toHaveBeenCalledTimes(before);

    release();
    await Promise.all([first, second]);
    expect(runner.mock.calls.length).toBeGreaterThan(before);
  });

  it("knows its own server by this run's bridge path, as a bridge not packaged is named", async () => {
    const paths = await makeConfig();
    // Run from source, the bridge is its source file, with no "decision-bridge" in its name.
    const source = "/repo/apps/bridge/src/cli.ts";
    const runner = vi.fn<CommandRunner>(async (command, args) =>
      args[1] === "get"
        ? { exitCode: 0, stdout: `decision:\n  Scope: User config\n  Type: stdio\n  Command: ${source}\n  Args: mcp ${command === "claude" ? "claude-code" : "codex"}\n` }
        : { exitCode: 0 });
    const options = { claudeSettingsPath: paths.claudeSettingsPath, codexHooksPath: paths.codexHooksPath, platform: "darwin" as const, runner };

    // Connected once, a second 安装或修复 found its own server there and replaced it, rather than refusing.
    const again = await installIntegrations({ ...options, mode: "apply", bridgePath: source });
    expect(again.targets.map(({ status }) => status)).toEqual(["installed", "installed"]);
    expect(runner.mock.calls.map(([, args]) => args[1])).toEqual(["get", "remove", "add", "get", "remove", "add"]);

    const removed = await removeIntegrations({ ...options, mode: "apply", bridgePath: source });
    expect(removed.targets.map(({ status, detail }) => ({ status, detail }))).toEqual([
      { status: "removed", detail: undefined },
      { status: "removed", detail: undefined },
    ]);

    // With the packaged bridge, a server running something else by that name is still another tool's.
    await expect(installIntegrations({ ...options, mode: "apply", bridgePath })).rejects.toThrow(/不是本应用的桥接程序/u);
  });

  it("takes this app out of both clients, leaving the reader's own hooks and settings as they were", async () => {
    const paths = await makeConfig();
    const runner = vi.fn<CommandRunner>(async (command, args) =>
      args[1] === "get"
        ? { exitCode: 0, stdout: `decision\n  command: ${bridgePath}\n  args: mcp ${command === "claude" ? "claude-code" : "codex"}\n` }
        : { exitCode: 0 });
    const options = { claudeSettingsPath: paths.claudeSettingsPath, codexHooksPath: paths.codexHooksPath, runner };
    await installIntegrations({ ...options, bridgePath, mode: "apply" });
    runner.mockClear();

    const checked = await removeIntegrations({ ...options, mode: "dry-run" });
    expect(checked.targets.map(({ changed, status }) => ({ changed, status }))).toEqual([
      { changed: true, status: undefined },
      { changed: true, status: undefined },
    ]);
    expect(runner).not.toHaveBeenCalled();
    expect(await readFile(paths.claudeSettingsPath, "utf8")).toContain("DECISION_HOOK=1");

    const report = await removeIntegrations({ ...options, mode: "apply" });
    expect(report.targets.map(({ client, changed, status, detail }) => ({ client, changed, status, detail }))).toEqual([
      { client: "claude-code", changed: true, status: "removed", detail: undefined },
      { client: "codex", changed: true, status: "removed", detail: undefined },
    ]);
    expect(report.note).toMatch(/技能和工作流没有删除/u);
    expect(runner.mock.calls.map(([command, args]) => `${command} ${args.join(" ")}`)).toEqual([
      "claude mcp get decision",
      "claude mcp remove --scope user decision",
      "codex mcp get decision",
      "codex mcp remove decision",
    ]);
    expect(JSON.parse(await readFile(paths.claudeSettingsPath, "utf8"))).toEqual(existingClaudeSettings);
    expect(JSON.parse(await readFile(paths.codexHooksPath, "utf8"))).toEqual(existingCodexHooks);

    // Again, with nothing of this app's left: the files are not touched.
    const again = await removeIntegrations({ ...options, mode: "apply" });
    expect(again.targets.map((target) => target.changed)).toEqual([false, false]);
  });

  it("leaves a server named decision that is not this app's, cleans the file of a client whose command is gone, and keeps the hooks of one whose server it could not remove", async () => {
    const paths = await makeConfig();
    await installIntegrations({
      mode: "apply",
      bridgePath,
      claudeSettingsPath: paths.claudeSettingsPath,
      codexHooksPath: paths.codexHooksPath,
      runner: async () => ({ exitCode: 0 }),
    });
    const options = { mode: "apply" as const, claudeSettingsPath: paths.claudeSettingsPath, codexHooksPath: paths.codexHooksPath };
    const runner = vi.fn<CommandRunner>(async (command, args) => {
      if (command === "codex") throw Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
      return args[1] === "get" ? { exitCode: 0, stdout: "decision:\n  Command: npx\n  Args: -y decision-journal-mcp\n" } : { exitCode: 0 };
    });

    const failing = await removeIntegrations({
      ...options,
      runner: async (command, args) =>
        args[1] === "remove" ? { exitCode: 1, stderr: "permission denied" } : { exitCode: 0 },
    });
    expect(failing.targets.map(({ status, detail }) => ({ status, detail }))).toEqual([
      { status: "failed", detail: "运行 claude mcp remove 没有成功（permission denied）" },
      { status: "failed", detail: "运行 codex mcp remove 没有成功（permission denied）" },
    ]);
    expect(await readFile(paths.claudeSettingsPath, "utf8")).toContain("DECISION_HOOK=1");

    const report = await removeIntegrations({ ...options, runner });
    expect(report.targets.map(({ client, status, detail }) => ({ client, status, detail }))).toEqual([
      { client: "claude-code", status: "removed", detail: "名为 decision 的 MCP 服务器不是本应用的，没有动它" },
      { client: "codex", status: "removed", detail: "没有找到 codex 命令，没有删除它登记的 MCP 服务器" },
    ]);
    expect(runner.mock.calls.filter(([, args]) => args[1] === "remove")).toEqual([]);
    expect(await readFile(paths.claudeSettingsPath, "utf8")).not.toContain("DECISION_HOOK=");
    expect(await readFile(paths.codexHooksPath, "utf8")).not.toContain("DECISION_HOOK=");
  });

  it("leaves a hook group the reader left empty where it is, connecting and disconnecting alike", async () => {
    const paths = await makeConfig();
    // A group the reader emptied for the moment, in a file with none of this app's hooks: there is nothing to take
    // out, and the file is not to be rewritten in another layout.
    const before = `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [] }] } }, null, 4)}\n`;
    await writeFile(paths.codexHooksPath, before, "utf8");
    const options = { claudeSettingsPath: paths.claudeSettingsPath, codexHooksPath: paths.codexHooksPath, runner: vi.fn<CommandRunner>(async () => ({ exitCode: 0 })) };

    const checked = await removeIntegrations({ ...options, mode: "dry-run" });
    expect(checked.targets[1]).toMatchObject({ client: "codex", changed: false });

    // Connected and taken out again, the group is still there.
    await installIntegrations({ ...options, mode: "apply", bridgePath });
    await removeIntegrations({ ...options, mode: "apply" });
    expect(JSON.parse(await readFile(paths.codexHooksPath, "utf8"))).toEqual(JSON.parse(before));
  });

  it("skips a client this app was never connected to, rather than saying it was disconnected", async () => {
    const paths = await makeConfig();
    const beforeClaude = await readFile(paths.claudeSettingsPath, "utf8");
    // Both clients there, neither with a server or a hook of this app's.
    const runner = vi.fn<CommandRunner>(async (command, args) =>
      args[1] === "get"
        ? { exitCode: 1, stderr: "No MCP server found with name: decision" }
        : { exitCode: 1, stderr: command === "claude" ? 'No MCP server named "decision" in user scope' : "MCP server decision does not exist" });

    const report = await removeIntegrations({ mode: "apply", claudeSettingsPath: paths.claudeSettingsPath, codexHooksPath: paths.codexHooksPath, runner });

    // Nothing taken out: no restart to ask for either, which the page asks for only after a removal.
    expect(report.targets.map(({ changed, status, detail }) => ({ changed, status, detail }))).toEqual([
      { changed: false, status: "skipped", detail: "没有本应用的接入，无需断开" },
      { changed: false, status: "skipped", detail: "没有本应用的接入，无需断开" },
    ]);
    expect(await readFile(paths.claudeSettingsPath, "utf8")).toBe(beforeClaude);
  });

  it("skips a client that is not there at all when taking this app out", async () => {
    const paths = await makeConfig();

    const report = await removeIntegrations({
      mode: "apply",
      claudeSettingsPath: paths.claudeSettingsPath,
      codexHooksPath: paths.codexHooksPath,
      runner: async (command) => {
        throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });
      },
    });

    expect(report.targets.map(({ changed, status, detail }) => ({ changed, status, detail }))).toEqual([
      { changed: false, status: "skipped", detail: "没有找到 claude 命令" },
      { changed: false, status: "skipped", detail: "没有找到 codex 命令" },
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

  it("keeps what was written to a client's settings while its commands ran", async () => {
    const paths = await makeConfig();
    const runner = vi.fn<CommandRunner>(async (command) => {
      // A /model change in the running Claude Code, seconds into the install.
      if (command === "claude") {
        const settings = JSON.parse(await readFile(paths.claudeSettingsPath, "utf8")) as Record<string, unknown>;
        await writeFile(paths.claudeSettingsPath, `${JSON.stringify({ ...settings, model: "opus" }, null, 2)}\n`);
      }
      return { exitCode: 0 };
    });

    await installIntegrations({ mode: "apply", bridgePath, claudeSettingsPath: paths.claudeSettingsPath, codexHooksPath: paths.codexHooksPath, runner });

    const written = JSON.parse(await readFile(paths.claudeSettingsPath, "utf8")) as { model?: string; hooks?: unknown };
    expect(written.model).toBe("opus");
    expect(JSON.stringify(written.hooks)).toContain("DECISION_HOOK=");
  });

  it("says a settings file broken while its commands ran is unreadable, not unwritable", async () => {
    const paths = await makeConfig();
    const runner = vi.fn<CommandRunner>(async (command) => {
      if (command === "claude") await writeFile(paths.claudeSettingsPath, '{\n  "model": "opus",\n}\n');
      return { exitCode: 0 };
    });

    const report = await installIntegrations({ mode: "apply", bridgePath, claudeSettingsPath: paths.claudeSettingsPath, codexHooksPath: paths.codexHooksPath, runner });

    const claude = report.targets.find((target) => target.client === "claude-code");
    expect(claude).toMatchObject({ status: "failed", detail: expect.stringMatching(/不是有效的 JSON/u) });
    expect(claude?.detail).not.toMatch(/无法写入/u);
  });

  it("says which step failed and the client's reason, not the whole command line", async () => {
    const paths = await makeConfig();
    const runner = vi.fn<CommandRunner>(async () => ({ exitCode: 1, stderr: "Error: Invalid scope: user" }));

    const failure = await installIntegrations({
      mode: "apply",
      bridgePath,
      claudeSettingsPath: paths.claudeSettingsPath,
      codexHooksPath: paths.codexHooksPath,
      runner,
    }).catch((error: unknown) => error) as Error;

    // The app's own path in a raw command line told the reader nothing they could act on.
    for (const part of failure.message.split("；")) expect(part).toMatch(/^运行 (claude|codex) mcp \S+ 没有成功（Error: Invalid scope: user）$/u);
    expect(failure.message).not.toContain(bridgePath);
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
      stderr: "MCP server other not found; configured servers: decision",
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
      stderr: "No MCP server found with name: decision-backup",
    }));

    await expect(
      installIntegrations({
        mode: "apply",
        bridgePath,
        claudeSettingsPath: paths.claudeSettingsPath,
        codexHooksPath: paths.codexHooksPath,
        runner,
      }),
    ).rejects.toThrow(/decision-backup/i);
  });
});
