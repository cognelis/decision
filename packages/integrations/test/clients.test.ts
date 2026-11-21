import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  BUILT_IN_CLIENTS,
  clientHookPaths,
  detectIntegrationStatus,
  hookBridgeReference,
  installIntegrations,
  mergeAntigravityHooks,
  removeAntigravityHooks,
  removeIntegrations,
  type CommandRunner,
} from "../src/index.js";

const bridgePath = "/Applications/Paraself.app/Contents/Resources/bridge/paraself-bridge";
const reference = hookBridgeReference(bridgePath, "darwin");

const fourClients = async () => {
  const home = await mkdtemp(join(tmpdir(), "decision-clients-"));
  return { home, paths: clientHookPaths(BUILT_IN_CLIENTS, {}, home) };
};

const write = async (path: string, value: unknown) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8")) as Record<string, any>;

/** Every client's command there, with no server of anyone's by this app's names; those named in `missing` not installed. */
const runner = (missing: string[] = [], calls: string[][] = []): CommandRunner => async (command, args) => {
  calls.push([command, ...args]);
  if (missing.includes(command)) throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });
  if (args[1] === "list") {
    return command === "grok"
      ? { exitCode: 0, stdout: JSON.stringify([{ command: "npx", args: ["foo"], enabled: true, name: "other", scope: "user" }]) }
      : { exitCode: 0, stdout: "NAME   TYPE   STATUS   COMMAND/URL\nother  stdio  enabled  npx foo\n" };
  }
  if (args[1] === "get") return { exitCode: 1, stderr: `No MCP server found with name: ${args.at(-1)}` };
  return { exitCode: 0, stdout: "" };
};

/** Hooks as Decision wrote them: its marker, its bridge. */
const asDecision = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value).replaceAll("PARASELF_HOOK=", "DECISION_HOOK=").replaceAll(reference, decisionReference));
const decisionBridge = "/Applications/Decision.app/Contents/Resources/bridge/decision-bridge";
const decisionReference = hookBridgeReference(decisionBridge, "darwin");
/** Antigravity's file as Decision wrote it: its hook under `decision`. */
const asDecisionHook = (document: Record<string, unknown>): Record<string, Record<string, unknown>> => {
  const { paraself, ...rest } = asDecision(document) as Record<string, Record<string, unknown>>;
  return { ...rest, decision: paraself! };
};

describe("the clients' registry", () => {
  it("puts each client's hook file where it keeps its configuration", async () => {
    const { home, paths } = await fourClients();
    expect(paths).toEqual({
      "claude-code": join(home, ".claude", "settings.json"),
      codex: join(home, ".codex", "hooks.json"),
      grok: join(home, ".grok", "hooks", "paraself.json"),
      antigravity: join(home, ".gemini", "config", "hooks.json"),
    });
    expect(clientHookPaths(BUILT_IN_CLIENTS, { GROK_HOME: "/elsewhere/grok" }, home).grok).toBe("/elsewhere/grok/hooks/paraself.json");
  });

  it("connects all four, each by its own MCP command and hook file, and reads them back as connected", async () => {
    const { paths } = await fourClients();
    const calls: string[][] = [];
    const report = await installIntegrations({ mode: "apply", bridgePath, platform: "darwin", paths, runner: runner([], calls) });

    expect(report.targets.map((target) => [target.client, target.status])).toEqual([
      ["claude-code", "installed"],
      ["codex", "installed"],
      ["grok", "installed"],
      ["antigravity", "installed"],
    ]);
    expect(calls).toContainEqual(["grok", "mcp", "add", "-s", "user", "paraself", "--", bridgePath, "mcp", "grok"]);
    expect(calls).toContainEqual(["agy", "mcp", "add", "paraself", "--", bridgePath, "mcp", "antigravity"]);
    // None by Decision's name there: nothing of it taken out.
    expect(calls.filter((call) => call.includes("remove") && call.includes("decision"))).toEqual([]);
    expect(await readJson(paths.grok!)).toEqual({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: `PARASELF_HOOK=1 ${reference} hook stop grok`, timeout: 5 }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: `PARASELF_HOOK=1 ${reference} hook user-prompt-submit grok`, timeout: 5 }] }],
      },
    });
    expect(await readJson(paths.antigravity!)).toEqual({
      paraself: {
        Stop: [{ type: "command", command: `PARASELF_HOOK=1 ${reference} hook stop antigravity`, timeout: 5 }],
        PreInvocation: [{ type: "command", command: `PARASELF_HOOK=1 ${reference} hook user-prompt-submit antigravity`, timeout: 5 }],
      },
    });
    expect(await detectIntegrationStatus(paths, reference, "darwin")).toEqual({
      "claude-code": "installed",
      codex: "installed",
      grok: "installed",
      antigravity: "installed",
    });
  });

  it("skips a client whose command is not there, and connects the others", async () => {
    const { paths } = await fourClients();
    const report = await installIntegrations({ mode: "apply", bridgePath, platform: "darwin", paths, runner: runner(["grok", "codex"]) });

    expect(report.targets.map((target) => [target.client, target.status, target.detail])).toEqual([
      ["claude-code", "installed", undefined],
      ["codex", "skipped", "没有找到 codex 命令"],
      ["grok", "skipped", "没有找到 grok 命令"],
      ["antigravity", "installed", expect.stringContaining("Antigravity")],
    ]);
    expect(await detectIntegrationStatus(paths, reference, "darwin")).toMatchObject({ codex: "not-installed", grok: "not-installed" });
  });

  it("says every client's command missing when none is there", async () => {
    const { paths } = await fourClients();
    await expect(
      installIntegrations({ mode: "apply", bridgePath, platform: "darwin", paths, runner: runner(["claude", "codex", "grok", "agy"]) }),
    ).rejects.toThrow("没有找到 claude 或 codex 或 grok 或 agy 命令");
  });

  it("leaves another tool's paraself server in Grok and Antigravity alone", async () => {
    const { paths } = await fourClients();
    const theirs: CommandRunner = async (command, args) =>
      args[1] === "list"
        ? command === "grok"
          ? { exitCode: 0, stdout: JSON.stringify([{ command: "npx", args: ["their-server"], enabled: true, name: "paraself", scope: "user" }]) }
          : { exitCode: 0, stdout: "NAME      TYPE   STATUS   COMMAND/URL\nparaself  stdio  enabled  npx their-server\n" }
        : runner()(command, args);
    const report = await installIntegrations({ mode: "apply", bridgePath, platform: "darwin", paths, runner: theirs });

    expect(report.targets.filter((target) => target.client === "grok" || target.client === "antigravity").map((target) => [target.status, target.detail])).toEqual([
      ["failed", expect.stringContaining("Grok 里已有一个名为 paraself 的 MCP 服务器")],
      ["failed", expect.stringContaining("Antigravity 里已有一个名为 paraself 的 MCP 服务器")],
    ]);
  });

  it("connects beside another tool's decision server, leaving it alone and saying so", async () => {
    const { paths } = await fourClients();
    const calls: string[][] = [];
    const theirs: CommandRunner = async (command, args) => {
      calls.push([command, ...args]);
      if (args[1] === "list") {
        return command === "grok"
          ? { exitCode: 0, stdout: JSON.stringify([{ command: "npx", args: ["their-decision-server"], enabled: true, name: "decision", scope: "user" }]) }
          : { exitCode: 0, stdout: "NAME      TYPE   STATUS   COMMAND/URL\ndecision  stdio  enabled  npx their-decision-server\n" };
      }
      // Claude Code's `decision` the reader's own, Codex's none there.
      if (args[1] === "get") return command === "claude" && args.at(-1) === "decision" ? { exitCode: 0, stdout: "decision:\n  command: npx their-decision-server\n" } : runner()(command, args);
      return runner()(command, args);
    };
    const report = await installIntegrations({ mode: "apply", bridgePath, platform: "darwin", paths, runner: theirs });

    const left = "名为 decision 的 MCP 服务器不是本应用的，没有动它";
    expect(report.targets.map((target) => [target.client, target.status, target.detail])).toEqual([
      ["claude-code", "installed", left],
      ["codex", "installed", expect.stringContaining("Codex 只运行你信任过的 hook")],
      ["grok", "installed", left],
      ["antigravity", "installed", expect.stringContaining(left)],
    ]);
    expect(report.targets[1]?.detail).not.toContain("decision");
    expect(calls.filter((call) => call.includes("remove") && call.includes("decision"))).toEqual([]);
  });

  it("takes the server Decision registered out of each client, once Paraself's is added, where it runs this app's bridge", async () => {
    const { paths } = await fourClients();
    const calls: string[][] = [];
    const decisions: CommandRunner = async (command, args) => {
      calls.push([command, ...args]);
      if (args[1] === "list") {
        return command === "grok"
          ? { exitCode: 0, stdout: JSON.stringify([{ command: decisionBridge, args: ["mcp", "grok"], name: "decision" }]) }
          : { exitCode: 0, stdout: `NAME      TYPE   STATUS   COMMAND/URL\ndecision  stdio  enabled  ${decisionBridge} mcp antigravity\n` };
      }
      if (args[1] === "get") return args.at(-1) === "decision" ? { exitCode: 0, stdout: `decision:\n  command: ${decisionBridge}\n  args: mcp ${command === "claude" ? "claude-code" : command}\n` } : runner()(command, args);
      return runner()(command, args);
    };
    const report = await installIntegrations({ mode: "apply", bridgePath, platform: "darwin", paths, runner: decisions });

    expect(report.targets.map((target) => target.status)).toEqual(["installed", "installed", "installed", "installed"]);
    const removed = calls.filter((call) => call[2] === "remove" && call.includes("decision"));
    expect(removed).toEqual([
      ["claude", "mcp", "remove", "--scope", "user", "decision"],
      ["codex", "mcp", "remove", "decision"],
      ["grok", "mcp", "remove", "decision"],
      ["agy", "mcp", "remove", "decision"],
    ]);
    // Each after Paraself's own was added.
    const grokAdd = calls.findIndex((call) => call[0] === "grok" && call[2] === "add");
    expect(calls.findIndex((call) => call[0] === "grok" && call[2] === "remove" && call.includes("decision"))).toBeGreaterThan(grokAdd);
  });

  it("takes its own server out of Grok and Antigravity, as their listing shows it, Decision's with it", async () => {
    const { paths } = await fourClients();
    await installIntegrations({ mode: "apply", bridgePath, platform: "darwin", paths, runner: runner() });
    const calls: string[][] = [];
    const ours: CommandRunner = async (command, args) => {
      calls.push([command, ...args]);
      if (args[1] === "list") {
        return command === "grok"
          ? { exitCode: 0, stdout: JSON.stringify([{ command: bridgePath, args: ["mcp", "grok"], name: "paraself" }, { command: decisionBridge, args: ["mcp", "grok"], name: "decision" }, { command: "npx", args: ["foo"], name: "other" }]) }
          : { exitCode: 0, stdout: `NAME      TYPE   STATUS   COMMAND/URL\nparaself  stdio  enabled  ${bridgePath} mcp antigravity\ndecision  stdio  enabled  ${decisionBridge} mcp antigravity\n` };
      }
      return runner()(command, args);
    };
    const report = await removeIntegrations({ mode: "apply", bridgePath, platform: "darwin", paths, runner: ours });

    expect(report.targets.map((target) => [target.client, target.status])).toEqual([
      ["claude-code", "removed"],
      ["codex", "removed"],
      ["grok", "removed"],
      ["antigravity", "removed"],
    ]);
    expect(calls).toContainEqual(["grok", "mcp", "remove", "paraself"]);
    expect(calls).toContainEqual(["agy", "mcp", "remove", "paraself"]);
    expect(calls).toContainEqual(["grok", "mcp", "remove", "decision"]);
    expect(calls).toContainEqual(["agy", "mcp", "remove", "decision"]);
    // Grok's file was this app's alone, and goes with its hooks.
    await expect(readFile(paths.grok!, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readJson(paths.antigravity!)).toEqual({});
    expect(await detectIntegrationStatus(paths, reference, "darwin")).toEqual({
      "claude-code": "not-installed",
      codex: "not-installed",
      grok: "not-installed",
      antigravity: "not-installed",
    });
  });

  it("takes a server already gone from Grok and Antigravity as gone", async () => {
    const { paths } = await fourClients();
    await installIntegrations({ mode: "apply", bridgePath, platform: "darwin", paths, runner: runner() });
    // Their own words for it (grok 1.0.70, agy 1.4.8).
    const gone: CommandRunner = async (command, args) =>
      args[1] === "remove"
        ? { exitCode: 1, stderr: command === "grok" ? `No MCP server named '${args.at(-1)}' in user or project config` : `Error: MCP server "${args.at(-1)}" not found` }
        : runner()(command, args);
    const report = await removeIntegrations({ mode: "apply", bridgePath, platform: "darwin", paths, runner: gone });

    expect(report.targets.filter((target) => target.client === "grok" || target.client === "antigravity").map((target) => target.status)).toEqual(["removed", "removed"]);
  });

  it("does not write over a Grok hooks file of someone else's that has this app's name", async () => {
    const { paths } = await fourClients();
    const theirs = { hooks: { Stop: [{ hooks: [{ type: "command", command: "~/bin/notify.sh" }] }] } };
    await write(paths.grok!, theirs);
    const report = await installIntegrations({ mode: "apply", bridgePath, platform: "darwin", paths, runner: runner() });

    expect(report.targets.find((target) => target.client === "grok")).toMatchObject({ status: "failed", detail: expect.stringContaining("不是本应用写入的内容") });
    expect(await readJson(paths.grok!)).toEqual(theirs);
    // Nor is it taken away on a removal.
    await removeIntegrations({ mode: "apply", bridgePath, platform: "darwin", paths, runner: runner() });
    expect(await readJson(paths.grok!)).toEqual(theirs);
  });

  it("says this app's Antigravity hook turned off there as turned off", async () => {
    const { paths } = await fourClients();
    await installIntegrations({ mode: "apply", bridgePath, platform: "darwin", paths, runner: runner() });
    const document = await readJson(paths.antigravity!);
    await write(paths.antigravity!, { ...document, paraself: { ...document.paraself, enabled: false } });

    expect((await detectIntegrationStatus(paths, reference, "darwin")).antigravity).toBe("disabled");
    // Connecting again leaves the reader's switch as it is, as Claude Code's disableAllHooks is.
    await installIntegrations({ mode: "apply", bridgePath, platform: "darwin", paths, runner: runner() });
    expect((await detectIntegrationStatus(paths, reference, "darwin")).antigravity).toBe("disabled");
  });

  it("looks only at the clients it is given files for", async () => {
    const { paths } = await fourClients();
    expect(Object.keys(await detectIntegrationStatus({ grok: paths.grok! }, reference, "darwin"))).toEqual(["grok"]);
  });
});

describe("a listing of the clients' servers it cannot read", () => {
  // A listing that failed, or one in a form not known, says nothing of whether a `paraself` of the reader's own is there:
  // taken for "none", it was removed and replaced with this app's.
  const unreadable: [string, (command: string) => { exitCode: number; stdout?: string; stderr?: string }][] = [
    ["failed", () => ({ exitCode: 1, stderr: "config.toml: permission denied" })],
    ["in colour", (command) => ({ exitCode: 0, stdout: command === "grok" ? "\u001b[1mparaself\u001b[0m: npx user-server\n" : "NAME      TYPE   STATUS   COMMAND/URL\n\u001b[1mparaself\u001b[0m  stdio  enabled  npx user-server\n" })],
    ["in another form", (command) => ({ exitCode: 0, stdout: command === "grok" ? "Servers:\n- paraself (npx user-server)\n" : "Servers:\n- paraself (npx user-server)\n" })],
    ["empty", () => ({ exitCode: 0, stdout: "" })],
  ];

  it.each(unreadable)("changes nothing of Grok's or Antigravity's on an install when the listing is %s", async (_kind, listing) => {
    const { paths } = await fourClients();
    const calls: string[][] = [];
    const report = await installIntegrations({
      mode: "apply", bridgePath, platform: "darwin", paths: { grok: paths.grok!, antigravity: paths.antigravity! },
      runner: async (command, args) => { calls.push([command, ...args]); return args[1] === "list" ? listing(command) : { exitCode: 0 }; },
    }).catch((error: Error) => error);

    expect(calls.map(([, , sub]) => sub)).toEqual(["list", "list"]);
    expect(report).toBeInstanceOf(Error);
    expect((report as Error).message).toMatch(/Grok 的 MCP 服务器列表.*没有改动/u);
    await expect(readFile(paths.grok!, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(paths.antigravity!, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(unreadable)("takes nothing out of Grok or Antigravity on a removal when the listing is %s", async (_kind, listing) => {
    const { paths } = await fourClients();
    await installIntegrations({ mode: "apply", bridgePath, platform: "darwin", paths, runner: runner() });
    const before = [await readFile(paths.grok!, "utf8"), await readFile(paths.antigravity!, "utf8")];
    const calls: string[][] = [];
    const report = await removeIntegrations({
      mode: "apply", bridgePath, platform: "darwin", paths: { grok: paths.grok!, antigravity: paths.antigravity! },
      runner: async (command, args) => { calls.push([command, ...args]); return args[1] === "list" ? listing(command) : { exitCode: 0 }; },
    });

    expect(calls.map(([, , sub]) => sub)).toEqual(["list", "list"]);
    expect(report.targets.map((target) => [target.client, target.status])).toEqual([["grok", "failed"], ["antigravity", "failed"]]);
    expect(report.targets[0]?.detail).toMatch(/Grok 的 MCP 服务器列表/u);
    expect([await readFile(paths.grok!, "utf8"), await readFile(paths.antigravity!, "utf8")]).toEqual(before);
  });

  // A `paraself` Grok lists, that cannot be told for this app's: none of its servers changed.
  const doubtful: [string, unknown[]][] = [
    ["with no command", [{ name: "paraself" }]],
    ["with a command in a form not known", [{ name: "paraself", command: { path: "npx" }, args: [] }]],
    ["twice, once this app's and once the reader's", [
      { name: "paraself", command: bridgePath, args: ["mcp", "grok"], scope: "project" },
      { name: "paraself", command: "npx", args: ["user-server"], scope: "user" },
    ]],
  ];

  it.each(doubtful)("changes nothing of Grok's when it lists a paraself %s", async (_kind, servers) => {
    const { paths } = await fourClients();
    await installIntegrations({ mode: "apply", bridgePath, platform: "darwin", paths: { grok: paths.grok! }, runner: runner() });
    const before = await readFile(paths.grok!, "utf8");
    for (const operation of [installIntegrations, removeIntegrations]) {
      const calls: string[][] = [];
      await operation({
        mode: "apply", bridgePath, platform: "darwin", paths: { grok: paths.grok! },
        runner: async (command, args) => { calls.push([command, ...args]); return args[1] === "list" ? { exitCode: 0, stdout: JSON.stringify(servers) } : { exitCode: 0 }; },
      }).catch(() => undefined);
      expect(calls.map(([, , sub]) => sub)).toEqual(["list"]);
      // Its hooks too: which server is this app's cannot be told, so nothing of the client's is.
      expect(await readFile(paths.grok!, "utf8")).toBe(before);
    }
  });

  // Decision's `decision`, that cannot be told for this app's: left, said, and Paraself's connected all the same.
  it.each(doubtful)("connects Grok, leaving Decision's server alone, when it lists a decision %s", async (_kind, servers) => {
    const { paths } = await fourClients();
    const listed = JSON.stringify(servers.map((server) => ({ ...(server as object), name: "decision" })));
    const calls: string[][] = [];
    const report = await installIntegrations({
      mode: "apply", bridgePath, platform: "darwin", paths: { grok: paths.grok! },
      runner: async (command, args) => { calls.push([command, ...args]); return args[1] === "list" ? { exitCode: 0, stdout: listed } : { exitCode: 0 }; },
    });

    expect(report.targets[0]).toMatchObject({ status: "installed", detail: expect.stringMatching(/名为 decision 的/u) });
    expect(calls.map(([, , sub, name]) => `${sub} ${name ?? ""}`.trim())).toEqual(["list --json", "remove paraself", "add -s", "list --json"]);
  });

  it("goes on where the listing says plainly there are none", async () => {
    const { paths } = await fourClients();
    const report = await installIntegrations({
      mode: "apply", bridgePath, platform: "darwin", paths: { grok: paths.grok!, antigravity: paths.antigravity! },
      runner: async (command, args) =>
        args[1] === "list"
          ? command === "grok" ? { exitCode: 0, stdout: "[]\n" } : { exitCode: 0, stdout: "No MCP servers configured.\n" }
          : { exitCode: 0 },
    });
    expect(report.targets.map((target) => target.status)).toEqual(["installed", "installed"]);
  });

  it("stops Claude Code's and Codex's changes where a look at the server fails for a reason not its absence", async () => {
    const { paths } = await fourClients();
    const calls: string[][] = [];
    const report = await installIntegrations({
      mode: "apply", bridgePath, platform: "darwin", paths: { "claude-code": paths["claude-code"]!, codex: paths.codex! },
      runner: async (command, args) => {
        calls.push([command, ...args]);
        return args[1] === "get" ? { exitCode: 1, stderr: "Error: failed to read config: permission denied" } : { exitCode: 0 };
      },
    }).catch((error: Error) => error);

    // Neither removed nor added after it.
    expect(calls.map(([, , sub]) => sub)).toEqual(["get", "get"]);
    expect((report as Error).message).toMatch(/运行 claude mcp get 没有成功（Error: failed to read config: permission denied）/u);
  });

  it("does not take another server's absence for its own", async () => {
    const { paths } = await fourClients();
    for (const name of ["paraself.extra", "paraself-extra", "paraself_extra", "paraselfs"]) {
      const calls: string[][] = [];
      await installIntegrations({
        mode: "apply", bridgePath, platform: "darwin", paths: { "claude-code": paths["claude-code"]!, codex: paths.codex! },
        runner: async (command, args) => {
          calls.push([command, ...args]);
          return args[1] === "get"
            ? command === "claude"
              ? { exitCode: 1, stdout: `No MCP server named "${name}". Run \`claude mcp add\` to add one.\n` }
              : { exitCode: 1, stderr: `Error: No MCP server named '${name}' found.\n` }
            : { exitCode: 0 };
        },
      }).catch(() => undefined);
      expect(calls.map(([, , sub]) => sub), name).toEqual(["get", "get"]);
    }
  });

  it("goes on where Claude Code and Codex say in their own words there is no such server", async () => {
    const { paths } = await fourClients();
    // Their words for it (claude 2.1.311, codex 0.164.0).
    const report = await installIntegrations({
      mode: "apply", bridgePath, platform: "darwin", paths: { "claude-code": paths["claude-code"]!, codex: paths.codex! },
      runner: async (command, args) =>
        args[1] === "get"
          ? command === "claude"
            ? { exitCode: 1, stdout: `No MCP server named "${args.at(-1)}". Run \`claude mcp add\` to add one.\n` }
            : { exitCode: 1, stderr: `Error: No MCP server named '${args.at(-1)}' found.\n` }
          : { exitCode: 0 },
    });
    expect(report.targets.map((target) => target.status)).toEqual(["installed", "installed"]);
  });
});

describe("Antigravity's hooks file", () => {
  const others = {
    "lint-guard": {
      enabled: true,
      PreToolUse: [{ matcher: "run_command", hooks: [{ type: "command", command: "~/bin/guard.sh", timeout: 10 }] }],
    },
    futureField: { kept: true },
  };

  it("adds this app's hook beside the reader's, and adding it again changes nothing", () => {
    const once = mergeAntigravityHooks(others, bridgePath, "antigravity", "darwin");
    expect(once).toEqual({
      ...others,
      paraself: {
        Stop: [{ type: "command", command: `PARASELF_HOOK=1 ${reference} hook stop antigravity`, timeout: 5 }],
        PreInvocation: [{ type: "command", command: `PARASELF_HOOK=1 ${reference} hook user-prompt-submit antigravity`, timeout: 5 }],
      },
    });
    expect(mergeAntigravityHooks(once, bridgePath, "antigravity", "darwin")).toEqual(once);
  });

  it("takes out only this app's hook", () => {
    expect(removeAntigravityHooks(mergeAntigravityHooks(others, bridgePath, "antigravity", "darwin"))).toEqual(others);
    expect(removeAntigravityHooks(others)).toEqual(others);
  });

  it("keeps whatever else is on this app's hook as it was, of any type, and still knows the hook for its own", () => {
    const once = mergeAntigravityHooks(others, bridgePath, "antigravity", "darwin");
    const extended = { ...once, paraself: { ...(once.paraself as object), futureArray: [], futureList: ["x"], futureObject: { a: 1 }, enabled: false } };
    const again = mergeAntigravityHooks(extended, bridgePath, "antigravity", "darwin");
    expect(again).toEqual(extended);
    // Its handlers gone, nothing that runs is left on it: the hook goes whole, as before it was connected.
    expect(removeAntigravityHooks(extended)).toEqual(others);
  });

  it("leaves an event the reader added to this app's hook, and the hook with it, on a removal", () => {
    const once = mergeAntigravityHooks(others, bridgePath, "antigravity", "darwin");
    const theirs = [{ type: "command", command: "~/bin/user-session-start.sh" }];
    const mixed = { ...once, paraself: { ...(once.paraself as object), SessionStart: theirs } };
    expect(mergeAntigravityHooks(mixed, bridgePath, "antigravity", "darwin")).toEqual(mixed);
    expect(removeAntigravityHooks(mixed)).toEqual({ ...others, paraself: { SessionStart: theirs } });
  });

  it("takes this app's handlers out of an event the reader also put one in, and leaves theirs", () => {
    const once = mergeAntigravityHooks(others, bridgePath, "antigravity", "darwin") as { paraself: { Stop: unknown[] } };
    const theirs = { type: "command", command: "~/bin/notify-done.sh" };
    const mixed = { ...once, paraself: { ...once.paraself, Stop: [...once.paraself.Stop, theirs] } };
    expect(removeAntigravityHooks(mixed)).toEqual({ ...others, paraself: { Stop: [theirs] } });
  });

  it.each([
    ["turned off", { enabled: false }],
    ["turned on", { enabled: true }],
    ["with a field the client added", { futureObject: { keep: true } }],
  ])("connects again after a disconnect, the hook %s there in between", async (_kind, extra) => {
    const { paths } = await fourClients();
    const options = { mode: "apply" as const, bridgePath, platform: "darwin" as const, paths: { antigravity: paths.antigravity! }, runner: runner() };
    await installIntegrations(options);
    const installed = await readJson(paths.antigravity!);
    await write(paths.antigravity!, { ...installed, paraself: { ...installed.paraself, ...extra } });

    expect((await removeIntegrations(options)).targets[0]?.status).toBe("removed");
    // Nothing left that runs: the hook went whole, as before it was connected.
    expect(await readJson(paths.antigravity!)).toEqual({});
    const again = await installIntegrations(options);
    expect(again.targets[0]?.status).toBe("installed");
    expect((await readJson(paths.antigravity!)).paraself.Stop).toHaveLength(1);
  });

  it("keeps a handler of the reader's on this app's hook through a disconnect, and then says why it will not connect over it", async () => {
    const { paths } = await fourClients();
    const options = { mode: "apply" as const, bridgePath, platform: "darwin" as const, paths: { antigravity: paths.antigravity! }, runner: runner() };
    await installIntegrations(options);
    const installed = await readJson(paths.antigravity!);
    const theirs = [{ type: "command", command: "~/bin/user-session-start.sh" }];
    await write(paths.antigravity!, { ...installed, paraself: { ...installed.paraself, SessionStart: theirs, enabled: false } });

    await removeIntegrations(options);
    expect(await readJson(paths.antigravity!)).toEqual({ paraself: { SessionStart: theirs, enabled: false } });
    const again = await installIntegrations(options).catch((error: Error) => error);
    expect((again as Error).message).toMatch(/paraself 钩子里有别的处理器，Paraself 不会改动它/u);
    expect(await readJson(paths.antigravity!)).toEqual({ paraself: { SessionStart: theirs, enabled: false } });
  });

  it("leaves a hook the reader named paraself alone", () => {
    const theirs = { paraself: { Stop: [{ type: "command", command: "~/bin/my-decision.sh" }] } };
    expect(() => mergeAntigravityHooks(theirs, bridgePath, "antigravity", "darwin")).toThrow("不是本应用的");
    expect(removeAntigravityHooks(theirs)).toEqual(theirs);
  });

  it("renames the hook Decision kept as decision, its switch and the client's fields with it", () => {
    const decision = asDecisionHook(mergeAntigravityHooks(others, bridgePath, "antigravity", "darwin"));
    const extended = { ...decision, decision: { ...decision.decision, enabled: false, futureObject: { a: 1 } } };

    const merged = mergeAntigravityHooks(extended, bridgePath, "antigravity", "darwin");
    expect(merged).toEqual({ ...mergeAntigravityHooks(others, bridgePath, "antigravity", "darwin"), paraself: { ...(mergeAntigravityHooks(others, bridgePath, "antigravity", "darwin").paraself as object), enabled: false, futureObject: { a: 1 } } });
    expect(merged).not.toHaveProperty("decision");
    // And taken out at a disconnect, under either name.
    expect(removeAntigravityHooks(decision)).toEqual(others);
  });

  it("takes this app's handlers out of a decision hook the reader also put theirs in, and leaves theirs", () => {
    const decision = asDecisionHook(mergeAntigravityHooks(others, bridgePath, "antigravity", "darwin")) as { decision: { Stop: unknown[] } };
    const theirs = { type: "command", command: "~/bin/notify-done.sh" };
    const mixed = { ...decision, decision: { ...decision.decision, Stop: [...decision.decision.Stop, theirs] } };

    expect(mergeAntigravityHooks(mixed, bridgePath, "antigravity", "darwin")).toEqual({ ...mergeAntigravityHooks(others, bridgePath, "antigravity", "darwin"), decision: { Stop: [theirs] } });
    expect(removeAntigravityHooks(mixed)).toEqual({ ...others, decision: { Stop: [theirs] } });
  });

  it("asks to reconnect where the hook is still Decision's, and is connected after it", async () => {
    const { paths } = await fourClients();
    const options = { mode: "apply" as const, bridgePath, platform: "darwin" as const, paths: { antigravity: paths.antigravity! }, runner: runner() };
    await write(paths.antigravity!, asDecisionHook(mergeAntigravityHooks(others, bridgePath, "antigravity", "darwin")));

    expect((await detectIntegrationStatus({ antigravity: paths.antigravity! }, reference, "darwin")).antigravity).toBe("upgrade-required");
    await installIntegrations(options);
    expect(await readJson(paths.antigravity!)).toEqual(mergeAntigravityHooks(others, bridgePath, "antigravity", "darwin"));
    expect((await detectIntegrationStatus({ antigravity: paths.antigravity! }, reference, "darwin")).antigravity).toBe("installed");
  });

  it("keeps the reader's hooks when the file is connected and disconnected through the installer", async () => {
    const { paths } = await fourClients();
    await write(paths.antigravity!, others);
    await installIntegrations({ mode: "apply", bridgePath, platform: "darwin", paths: { antigravity: paths.antigravity! }, runner: runner() });
    expect(await readJson(paths.antigravity!)).toMatchObject(others);
    await removeIntegrations({ mode: "apply", bridgePath, platform: "darwin", paths: { antigravity: paths.antigravity! }, runner: runner() });
    expect(await readJson(paths.antigravity!)).toEqual(others);
  });
});

describe("Grok's hooks file as Decision named it", () => {
  const legacyOf = (path: string) => join(dirname(path), "decision.json");

  it("asks to reconnect, and the reconnect takes Decision's file away", async () => {
    const { paths } = await fourClients();
    const ours = { hooks: { Stop: [{ hooks: [{ type: "command", command: `DECISION_HOOK=1 ${decisionReference} hook stop grok`, timeout: 5 }] }], UserPromptSubmit: [{ hooks: [{ type: "command", command: `DECISION_HOOK=1 ${decisionReference} hook user-prompt-submit grok`, timeout: 5 }] }] } };
    await write(legacyOf(paths.grok!), ours);

    expect((await detectIntegrationStatus({ grok: paths.grok! }, reference, "darwin")).grok).toBe("upgrade-required");
    const report = await installIntegrations({ mode: "apply", bridgePath, platform: "darwin", paths: { grok: paths.grok! }, runner: runner() });

    expect(report.targets[0]).toMatchObject({ status: "installed" });
    await expect(readFile(legacyOf(paths.grok!), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await detectIntegrationStatus({ grok: paths.grok! }, reference, "darwin")).grok).toBe("installed");
  });

  it("still reads one left beside the new file as needing a reconnect: Grok runs both", async () => {
    const { paths } = await fourClients();
    await installIntegrations({ mode: "apply", bridgePath, platform: "darwin", paths: { grok: paths.grok! }, runner: runner() });
    await write(legacyOf(paths.grok!), asDecision(await readJson(paths.grok!)));

    expect((await detectIntegrationStatus({ grok: paths.grok! }, reference, "darwin")).grok).toBe("upgrade-required");
    await removeIntegrations({ mode: "apply", bridgePath, platform: "darwin", paths: { grok: paths.grok! }, runner: runner() });
    await expect(readFile(legacyOf(paths.grok!), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(paths.grok!, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves one with the reader's own hooks in it, without this app's", async () => {
    const { paths } = await fourClients();
    const theirs = { type: "command", command: "~/bin/notify.sh" };
    await write(legacyOf(paths.grok!), { hooks: { Stop: [{ hooks: [theirs] }, { hooks: [{ type: "command", command: `DECISION_HOOK=1 ${decisionReference} hook stop grok`, timeout: 5 }] }] } });

    await installIntegrations({ mode: "apply", bridgePath, platform: "darwin", paths: { grok: paths.grok! }, runner: runner() });
    expect(await readJson(legacyOf(paths.grok!))).toEqual({ hooks: { Stop: [{ hooks: [theirs] }] } });
    expect((await detectIntegrationStatus({ grok: paths.grok! }, reference, "darwin")).grok).toBe("installed");
  });
});
