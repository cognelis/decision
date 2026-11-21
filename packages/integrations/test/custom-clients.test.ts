import type { CustomClient } from "@cognelis/decision-protocol";
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  BUILT_IN_CLIENTS,
  clientHookPath,
  clientHookPaths,
  customClientDescriptor,
  customClientProblems,
  customHookPath,
  detectIntegrationStatus,
  hookBridgeReference,
  inIntegrationsTurn,
  installIntegrations,
  lockHookTarget,
  readCustomClients,
  removeIntegrations,
  setAsideCustomClients,
  writeCustomClients,
  type CommandRunner,
} from "../src/index.js";

const bridgePath = "/Applications/Paraself.app/Contents/Resources/bridge/paraself-bridge";
const reference = hookBridgeReference(bridgePath, "darwin");

const base: Omit<CustomClient, "id" | "name" | "shortName" | "hooks"> = {
  prompt: { event: "UserPromptSubmit", field: "prompt" },
  reply: { event: "Stop", source: "field", field: "last_assistant_message" },
  fields: { sessionId: "session_id", cwd: "cwd" },
  mcp: { mode: "none" },
};

const merged: CustomClient = { ...base, id: "merged-cli", name: "Merged CLI", shortName: "MC", hooks: { file: "~/.merged/settings.json", format: "claude" } };
const owned: CustomClient = { ...base, id: "owned-cli", name: "Owned CLI", shortName: "OC", hooks: { file: "~/.owned/hooks/decision.json", format: "claude-owned" } };
const named: CustomClient = {
  ...base,
  id: "named-cli",
  name: "Named CLI",
  shortName: "NC",
  hooks: { file: "~/.named/hooks.json", format: "antigravity" },
  prompt: { event: "BeforePrompt", field: "input.text" },
  reply: { event: "AfterTurn", source: "transcript", format: "antigravity", field: "transcriptPath" },
};

const temporaryHome = () => mkdtemp(join(tmpdir(), "decision-custom-"));

const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

const write = async (path: string, value: unknown) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
};

describe("the reader's clients on disk", () => {
  it("writes them and reads them back, atomically and to the reader alone", async () => {
    const home = await temporaryHome();
    const path = join(home, "user-data", "custom-clients.json");
    await writeCustomClients(path, [merged, named]);

    expect(await readCustomClients(path)).toEqual({ clients: [merged, named], unreadable: false, mcpDropped: [] });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readdir(dirname(path))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("reads a client an earlier build saved that could not list its servers as registering none, and names it", async () => {
    const home = await temporaryHome();
    const path = join(home, "custom-clients.json");
    const old = { ...merged, command: "mycli", mcp: { mode: "command", add: ["mcp", "add", "decision", "{bridge}"], remove: ["mcp", "rm", "decision"], list: { output: "none" } } };
    await writeFile(path, JSON.stringify({ version: 1, clients: [old, owned] }));
    expect(await readCustomClients(path)).toEqual({ clients: [{ ...old, mcp: { mode: "none" } }, owned], unreadable: false, mcpDropped: ["merged-cli"] });
  });

  it("refuses to write one it would not read again", async () => {
    const home = await temporaryHome();
    await expect(writeCustomClients(join(home, "custom-clients.json"), [merged, merged])).rejects.toThrow();
  });

  it("reads none from no file, and none from one it cannot read, which is set aside as it was", async () => {
    const home = await temporaryHome();
    const path = join(home, "custom-clients.json");
    expect(await readCustomClients(path)).toEqual({ clients: [], unreadable: false, mcpDropped: [] });

    for (const broken of ["{ not json", JSON.stringify({ version: 1, clients: [{ ...merged, command: "rm -rf ~" }] }), JSON.stringify({ version: 9, clients: [] })]) {
      await writeFile(path, broken);
      expect(await readCustomClients(path)).toEqual({ clients: [], unreadable: true, mcpDropped: [] });
      const aside = await setAsideCustomClients(path, new Date("2026-10-28T09:00:00.000Z"));
      expect(aside).toBe(`${path}.unreadable-2026-10-28T09-00-00.000Z`);
      expect(await readFile(aside!, "utf8")).toBe(broken);
      expect(await readCustomClients(path)).toEqual({ clients: [], unreadable: false, mcpDropped: [] });
    }
  });
});

describe("a hook file's real place", () => {
  /** A home of its own, with Paraself's data and a built-in client's settings in it, all real folders. */
  const realHome = async () => {
    const root = await realpath(await temporaryHome());
    const home = join(root, "home");
    const data = join(home, "Library", "Application Support", "Paraself");
    await mkdir(data, { recursive: true });
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "settings.json"), "{}");
    await mkdir(join(root, "elsewhere"), { recursive: true });
    const options = { builtInPaths: clientHookPaths(BUILT_IN_CLIENTS, {}, home), home, protectedDirectories: [data] };
    return { root, home, data, options };
  };
  const at = (file: string): CustomClient => ({ ...merged, hooks: { file, format: "claude" } });
  const LINKED = "钩子配置文件的路径里有符号链接；Paraself 只写它自己的真实路径，不跟着链接写";

  it("refuses a link anywhere along the path, to a folder inside the home folder too, or the file itself", async () => {
    const { home, options } = await realHome();
    await mkdir(join(home, "real"), { recursive: true });
    await symlink(join(home, "real"), join(home, "inner"));
    expect(await customClientProblems(at("~/inner/deeper/hooks.json"), [], options)).toEqual([LINKED]);
    await writeFile(join(home, "real", "hooks.json"), "{}");
    await symlink(join(home, "real", "hooks.json"), join(home, "real", "linked.json"));
    expect(await customClientProblems(at("~/real/linked.json"), [], options)).toEqual([LINKED]);
    // Its own real path, written in another case on a file system that does not tell cases apart, is its own.
    expect(await customClientProblems(at("~/real/hooks.json"), [], options)).toEqual([]);
  });

  it("says why one it cannot follow at all (a link to itself) is refused, rather than failing whole", async () => {
    const { home, options } = await realHome();
    await symlink(join(home, ".loop"), join(home, ".loop"));
    expect(await customClientProblems(at("~/.loop/hooks.json"), [], options)).toEqual([expect.stringMatching(/符号链接|读不了/u)]);
  });

  it("follows a link out of the home folder", async () => {
    const { root, home, options } = await realHome();
    await symlink(join(root, "elsewhere"), join(home, "away"));
    expect(await customClientProblems(at("~/away/hooks.json"), [], options)).toEqual([LINKED, "钩子配置文件实际在用户主目录之外"]);
  });

  it("follows a link into Paraself's own data", async () => {
    const { home, data, options } = await realHome();
    await symlink(data, join(home, "data-alias"));
    expect(await customClientProblems(at("~/data-alias/hooks.json"), [], options)).toEqual([LINKED, "钩子配置文件不能放在 Paraself 自己的数据目录里"]);
  });

  it("follows a link to a built-in client's file, and a link to the folder it is in", async () => {
    const { home, options } = await realHome();
    await symlink(join(home, ".claude", "settings.json"), join(home, "claude-alias.json"));
    expect(await customClientProblems(at("~/claude-alias.json"), [], options)).toContain("Claude Code 已经用这个钩子配置文件，两个客户端不能共用一个");
    await symlink(join(home, ".claude"), join(home, "claude-folder"));
    expect(await customClientProblems(at("~/claude-folder/other.json"), [], options)).toEqual([LINKED, "钩子配置文件不能放在 Claude Code 的配置目录里"]);
  });

  it("takes another spelling of a built-in client's file, in case or in Unicode, for that file", async () => {
    const { home, options } = await realHome();
    expect(await customClientProblems(at("~/.CLAUDE/settings.json"), [], options)).toContain("Claude Code 已经用这个钩子配置文件，两个客户端不能共用一个");
    await mkdir(join(home, ".caf\u00e9"), { recursive: true });
    const nfc = { ...merged, id: "nfc-cli", hooks: { file: "~/.caf\u00e9/hooks.json", format: "claude" as const } };
    expect(await customClientProblems(at("~/.cafe\u0301/hooks.json"), [nfc], options)).toEqual(["Merged CLI 已经用这个钩子配置文件，两个客户端不能共用一个"]);
  });

  it("takes a hard link to another client's file for that file", async () => {
    const { home, options } = await realHome();
    await (await import("node:fs/promises")).link(join(home, ".claude", "settings.json"), join(home, "hard.json"));
    expect(await customClientProblems(at("~/hard.json"), [], options)).toContain("Claude Code 已经用这个钩子配置文件，两个客户端不能共用一个");
  });
});

describe("a client the reader writes, among the others", () => {
  const options = (home: string) => ({
    builtInPaths: clientHookPaths(BUILT_IN_CLIENTS, {}, home),
    home,
    protectedDirectories: [join(home, "Library", "Application Support", "Paraself")],
  });

  it("finds nothing in one of its own", async () => {
    expect(await customClientProblems(merged, [owned], options("/Users/reader"))).toEqual([]);
  });

  it("refuses an id a built-in client or another of the reader's has", async () => {
    expect(await customClientProblems({ ...merged, id: "grok" }, [], options("/Users/reader"))).toEqual(["id grok 是内置客户端的，换一个"]);
    expect(await customClientProblems({ ...merged, id: owned.id }, [owned], options("/Users/reader"))).toEqual([`已经有一个 id 为 ${owned.id} 的客户端`]);
  });

  it("refuses a hook file another client writes: its hooks would go with this one's", async () => {
    expect(await customClientProblems({ ...merged, hooks: { file: "~/.claude/settings.json", format: "claude" } }, [], options("/Users/reader"))).toEqual([
      "Claude Code 已经用这个钩子配置文件，两个客户端不能共用一个",
    ]);
    expect(await customClientProblems({ ...merged, hooks: owned.hooks }, [owned], options("/Users/reader"))).toEqual([
      "Owned CLI 已经用这个钩子配置文件，两个客户端不能共用一个",
    ]);
  });

  it("refuses a hook file in this app's own data", async () => {
    expect(await customClientProblems({ ...merged, hooks: { file: "~/Library/Application Support/Paraself/hooks.json", format: "claude" } }, [], options("/Users/reader"))).toEqual([
      "钩子配置文件不能放在 Paraself 自己的数据目录里",
    ]);
  });

  it("refuses a hook file in a built-in client's own folder", async () => {
    expect(await customClientProblems({ ...merged, hooks: { file: "~/.grok/hooks/mine.json", format: "claude-owned" } }, [], options("/Users/reader"))).toEqual([
      "钩子配置文件不能放在 Grok 的配置目录里",
    ]);
  });

  it("refuses on Windows an MCP template argument cmd would read as its own", async () => {
    const withMcp: CustomClient = {
      ...merged,
      command: "mycli",
      mcp: { mode: "command", add: ["mcp", "add", "decision", "{bridge}", "a&b"], remove: ["mcp", "rm", "decision"], list: { output: "json", args: ["mcp", "ls", "--json"] } },
    };
    expect(await customClientProblems(withMcp, [], { ...options("/Users/reader"), platform: "win32" })).toEqual([
      "在 Windows 上，MCP 命令的参数里不能有 & | < > ^ % ! \" 这些字符（cmd 会把它们当成自己的）：a&b",
    ]);
    expect(await customClientProblems(withMcp, [], { ...options("/Users/reader"), platform: "darwin" })).toEqual([]);
  });

  it("is found where the form says, as the registry finds the built-in ones", () => {
    expect(clientHookPath(customClientDescriptor(owned), {}, "/Users/reader")).toBe(customHookPath(owned.hooks.file, "/Users/reader"));
    expect(customHookPath("~/hooks.json", "/Users/reader")).toBe("/Users/reader/hooks.json");
    expect(clientHookPath(customClientDescriptor({ ...merged, hooks: { file: "~/hooks.json", format: "claude" } }), {}, "/Users/reader")).toBe("/Users/reader/hooks.json");
  });
});

/** Every command there and no server of anyone's by this app's names; the calls kept. */
const runner = (
  calls: string[][] = [],
  list: (command: string) => { exitCode: number; stdout?: string; stderr?: string } = () => ({ exitCode: 0, stdout: "[]" }),
): CommandRunner => async (command, args) => {
  calls.push([command, ...args]);
  if (args.includes("ls")) return list(command);
  return { exitCode: 0, stdout: "" };
};

describe("connecting a client the reader added", () => {
  const setUp = async () => {
    const home = await temporaryHome();
    const clients = [...BUILT_IN_CLIENTS, ...[merged, owned, named].map(customClientDescriptor)];
    const paths = Object.fromEntries([merged, owned, named].map((client) => [client.id, customHookPath(client.hooks.file, home)]));
    return { home, clients, paths };
  };

  it("writes its hooks in each of the three forms, the reader's own kept, and reads them back as connected", async () => {
    const { clients, paths } = await setUp();
    const theirs = { hooks: { Stop: [{ hooks: [{ type: "command", command: "~/bin/notify.sh" }] }] }, model: "x" };
    await write(paths["merged-cli"]!, theirs);
    await write(paths["named-cli"]!, { "lint-guard": { PreToolUse: [] } });

    const report = await installIntegrations({ mode: "apply", bridgePath, platform: "darwin", paths, clients, runner: runner() });
    expect(report.targets.map((target) => [target.client, target.status])).toEqual([
      ["merged-cli", "installed"],
      ["owned-cli", "installed"],
      ["named-cli", "installed"],
    ]);
    expect(await readJson(paths["merged-cli"]!)).toEqual({
      model: "x",
      hooks: {
        Stop: [
          ...theirs.hooks.Stop,
          { hooks: [{ type: "command", command: `PARASELF_HOOK=1 ${reference} hook stop merged-cli`, timeout: 5 }] },
        ],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: `PARASELF_HOOK=1 ${reference} hook user-prompt-submit merged-cli`, timeout: 5 }] }],
      },
    });
    expect(await readJson(paths["owned-cli"]!)).toEqual({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: `PARASELF_HOOK=1 ${reference} hook user-prompt-submit owned-cli`, timeout: 5 }] }],
        Stop: [{ hooks: [{ type: "command", command: `PARASELF_HOOK=1 ${reference} hook stop owned-cli`, timeout: 5 }] }],
      },
    });
    expect(await readJson(paths["named-cli"]!)).toEqual({
      "lint-guard": { PreToolUse: [] },
      paraself: {
        BeforePrompt: [{ type: "command", command: `PARASELF_HOOK=1 ${reference} hook user-prompt-submit named-cli`, timeout: 5 }],
        AfterTurn: [{ type: "command", command: `PARASELF_HOOK=1 ${reference} hook stop named-cli`, timeout: 5 }],
      },
    });
    expect(await detectIntegrationStatus(paths, reference, "darwin", clients)).toEqual({
      "merged-cli": "installed",
      "owned-cli": "installed",
      "named-cli": "installed",
    });

    // Taken out again: the reader's own stay, and the file wholly this app's goes.
    const removed = await removeIntegrations({ mode: "apply", bridgePath, platform: "darwin", paths, clients, runner: runner() });
    expect(removed.targets.map((target) => target.status)).toEqual(["removed", "removed", "removed"]);
    expect(await readJson(paths["merged-cli"]!)).toEqual(theirs);
    await expect(readFile(paths["owned-cli"]!, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readJson(paths["named-cli"]!)).toEqual({ "lint-guard": { PreToolUse: [] } });
  });

  it("runs no MCP command for a client registered with none", async () => {
    const { clients, paths } = await setUp();
    const calls: string[][] = [];
    await installIntegrations({ mode: "apply", bridgePath, platform: "darwin", paths, clients, runner: runner(calls) });
    await removeIntegrations({ mode: "apply", bridgePath, platform: "darwin", paths, clients, runner: runner(calls) });
    expect(calls).toEqual([]);
  });

  it("refuses a file wholly this app's that holds someone else's, and a named hook not its own", async () => {
    const { clients, paths } = await setUp();
    await write(paths["owned-cli"]!, { hooks: { Stop: [{ hooks: [{ type: "command", command: "~/bin/theirs.sh" }] }] } });
    await write(paths["named-cli"]!, { paraself: { AfterTurn: [{ type: "command", command: "~/bin/theirs.sh" }] } });
    const report = await installIntegrations({ mode: "apply", bridgePath, platform: "darwin", paths, clients, runner: runner() });
    expect(report.targets.map((target) => [target.client, target.status])).toEqual([
      ["merged-cli", "installed"],
      ["owned-cli", "failed"],
      ["named-cli", "failed"],
    ]);
  });
});

describe("a client the reader added that registers its MCP server by its own command", () => {
  const withMcp = (list: Extract<CustomClient["mcp"], { mode: "command" }>["list"]): CustomClient => ({
    ...merged,
    command: "mycli",
    mcp: { mode: "command", add: ["mcp", "add", "decision", "--", "{bridge}", "mcp", "{client}"], remove: ["mcp", "rm", "decision"], list },
  });

  const run = async (
    client: CustomClient,
    list: (command: string) => { exitCode: number; stdout?: string; stderr?: string },
    operation: "install" | "remove" = "install",
  ) => {
    const home = await temporaryHome();
    const clients = [customClientDescriptor(client)];
    const paths = { [client.id]: customHookPath(client.hooks.file, home) };
    const calls: string[][] = [];
    const options = { mode: "apply" as const, bridgePath, platform: "darwin" as const, paths, clients, runner: runner(calls, list) };
    const report = await (operation === "install" ? installIntegrations(options) : removeIntegrations(options)).catch((error: Error) => error);
    return { calls, report };
  };

  it("runs its templates, each argument as written and the bridge an argument of its own", async () => {
    const { calls, report } = await run(withMcp({ output: "json", args: ["mcp", "ls", "--json"] }), () => ({ exitCode: 0, stdout: "[]" }));
    expect(report).not.toBeInstanceOf(Error);
    // Written as Decision's form had it, naming the server `decision` outright: run as Paraself's, then a look at
    // Decision's, which is none.
    expect(calls).toEqual([
      ["mycli", "mcp", "ls", "--json"],
      ["mycli", "mcp", "rm", "paraself"],
      ["mycli", "mcp", "add", "paraself", "--", bridgePath, "mcp", "merged-cli"],
      ["mycli", "mcp", "ls", "--json"],
    ]);
  });

  it("leaves another's paraself server alone, as its JSON or table listing shows it", async () => {
    const json = await run(withMcp({ output: "json", args: ["mcp", "ls", "--json"] }), () => ({ exitCode: 0, stdout: JSON.stringify([{ name: "paraself", command: "npx", args: ["theirs"] }]) }));
    expect(json.calls.map((call) => call[2])).toEqual(["ls"]);
    const table = await run(
      withMcp({ output: "table", args: ["mcp", "ls"], header: ["NAME", "COMMAND"], none: "No servers." }),
      () => ({ exitCode: 0, stdout: "NAME      COMMAND\nparaself  npx theirs\n" }),
    );
    expect(table.calls.map((call) => call[2])).toEqual(["ls"]);
  });

  it("takes out Decision's server where it is this app's, and leaves another's decision, saying so", async () => {
    const decisionBridge = "/Applications/Decision.app/Contents/Resources/bridge/decision-bridge";
    const ours = await run(withMcp({ output: "json", args: ["mcp", "ls", "--json"] }), () => ({ exitCode: 0, stdout: JSON.stringify([{ name: "decision", command: decisionBridge, args: ["mcp", "merged-cli"] }]) }));
    expect(ours.calls.map((call) => call.slice(2).join(" "))).toEqual(["ls --json", "rm paraself", `add paraself -- ${bridgePath} mcp merged-cli`, "ls --json", "rm decision"]);
    const theirs = await run(withMcp({ output: "json", args: ["mcp", "ls", "--json"] }), () => ({ exitCode: 0, stdout: JSON.stringify([{ name: "decision", command: "npx", args: ["theirs"] }]) }));
    expect(theirs.calls.map((call) => call[2])).toEqual(["ls", "rm", "add", "ls"]);
    expect((theirs.report as { targets: { detail?: string }[] }).targets[0]?.detail).toBe("名为 decision 的 MCP 服务器不是本应用的，没有动它");
  });

  it("goes on where the table says it holds none, and stops where the listing is not one it knows", async () => {
    const client = withMcp({ output: "table", args: ["mcp", "ls"], header: ["NAME", "COMMAND"], none: "No servers." });
    expect((await run(client, () => ({ exitCode: 0, stdout: "No servers.\n" }))).calls.map((call) => call[2])).toEqual(["ls", "rm", "add", "ls"]);
    expect((await run(client, () => ({ exitCode: 0, stdout: "NAME COMMAND\n" }))).calls.map((call) => call[2])).toEqual(["ls", "rm", "add", "ls"]);
    expect((await run(client, () => ({ exitCode: 0, stdout: "" }))).calls.map((call) => call[2])).toEqual(["ls"]);
    expect((await run(client, () => ({ exitCode: 1, stderr: "boom" }))).calls.map((call) => call[2])).toEqual(["ls"]);
  });

  it("expands its placeholders in every template, a profile named by the client among them", async () => {
    const client: CustomClient = {
      ...merged,
      command: "mycli",
      mcp: {
        mode: "command",
        add: ["--profile", "{client}", "mcp", "add", "decision", "--", "{bridge}", "mcp", "{client}"],
        remove: ["--profile", "{client}", "mcp", "rm", "decision"],
        list: { output: "json", args: ["--profile", "{client}", "mcp", "ls", "--json"] },
      },
    };
    const { calls } = await run(client, () => ({ exitCode: 0, stdout: "[]" }));
    expect(calls).toEqual([
      ["mycli", "--profile", "merged-cli", "mcp", "ls", "--json"],
      ["mycli", "--profile", "merged-cli", "mcp", "rm", "paraself"],
      ["mycli", "--profile", "merged-cli", "mcp", "add", "paraself", "--", bridgePath, "mcp", "merged-cli"],
      ["mycli", "--profile", "merged-cli", "mcp", "ls", "--json"],
    ]);
    const removed = await run(client, () => ({ exitCode: 0, stdout: "[]" }), "remove");
    expect(removed.calls).toEqual([
      ["mycli", "--profile", "merged-cli", "mcp", "ls", "--json"],
      ["mycli", "--profile", "merged-cli", "mcp", "rm", "paraself"],
      ["mycli", "--profile", "merged-cli", "mcp", "ls", "--json"],
    ]);
  });

  it("refuses on Windows to run a template argument cmd would read as its own", async () => {
    const client = { ...withMcp({ output: "json", args: ["mcp", "ls", "--json"] }), mcp: { mode: "command" as const, add: ["mcp", "add", "decision", "{bridge}", "x|y"], remove: ["mcp", "rm", "decision"], list: { output: "json" as const, args: ["mcp", "ls", "--json"] } } };
    const home = await temporaryHome();
    const calls: string[][] = [];
    const report = await installIntegrations({
      mode: "apply", bridgePath: "C:\\Paraself\\paraself-bridge.cmd", platform: "win32", paths: { [client.id]: customHookPath(client.hooks.file, home) },
      clients: [customClientDescriptor(client)], runner: runner(calls),
    }).catch((error: Error) => error);
    expect(calls).toEqual([]);
    expect((report as Error).message).toMatch(/cmd 会把它们当成自己的/u);
  });
});

describe("a client whose question and answer come on one event", () => {
  // One handler there, reading the prompt and then the reply (promptInStop): two ran in whatever order the client chose.
  it.each(["claude", "claude-owned", "antigravity", "flat", "flat-owned"] as const)("puts one handler on that event in the %s form, and reads it back as connected", async (format) => {
    const home = await temporaryHome();
    const client: CustomClient = { ...merged, hooks: { file: "~/.one/hooks.json", format }, prompt: { event: "TurnFinished", field: "lastUserInput" }, reply: { event: "TurnFinished", source: "field", field: "reply" } };
    const clients = [customClientDescriptor(client)];
    const paths = { [client.id]: customHookPath(client.hooks.file, home) };
    await installIntegrations({ mode: "apply", bridgePath, platform: "darwin", paths, clients, runner: runner() });
    const written = await readFile(paths[client.id]!, "utf8");
    expect(written).not.toContain("hook user-prompt-submit merged-cli");
    expect(written.match(/hook stop merged-cli/gu)).toHaveLength(1);
    expect(clients[0]!.capture.promptInStop).toBe(true);
    expect(await detectIntegrationStatus(paths, reference, "darwin", clients)).toEqual({ "merged-cli": "installed" });
    await removeIntegrations({ mode: "apply", bridgePath, platform: "darwin", paths, clients, runner: runner() });
    expect(await detectIntegrationStatus(paths, reference, "darwin", clients)).toEqual({ "merged-cli": "not-installed" });
  });
});

describe("a check of a client's hook file just before it is written", () => {
  it("leaves the client alone, its MCP and its file both, where the check finds its file is now somewhere else", async () => {
    const home = await temporaryHome();
    const client = { ...merged, command: "mycli", mcp: { mode: "command" as const, add: ["mcp", "add", "decision", "{bridge}"], remove: ["mcp", "rm", "decision"], list: { output: "json" as const, args: ["mcp", "ls", "--json"] } } };
    const clients = [customClientDescriptor(client)];
    const paths = { [client.id]: customHookPath(client.hooks.file, home) };
    const calls: string[][] = [];
    const checkTarget = async () => { throw new Error("钩子配置文件实际在用户主目录之外"); };
    const installed = await installIntegrations({ mode: "apply", bridgePath, platform: "darwin", paths, clients, runner: runner(calls), checkTarget }).catch((error: Error) => error);
    expect((installed as Error).message).toMatch(/实际在用户主目录之外/u);
    expect(calls).toEqual([]);
    await expect(readFile(paths[client.id]!, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const removed = await removeIntegrations({ mode: "apply", bridgePath, platform: "darwin", paths, clients, runner: runner(calls), checkTarget });
    expect(removed.targets[0]).toMatchObject({ status: "failed", detail: expect.stringMatching(/实际在用户主目录之外/u) });
    expect(calls).toEqual([]);
  });
});

describe("the one queue every change to the clients' files waits in", () => {
  it("runs a change the reader makes to their clients after an install already under way, and before one sent after it", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const first = inIntegrationsTurn(async () => { await held; order.push("first"); });
    const second = inIntegrationsTurn(async () => { order.push("second"); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual([]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
  });
});

describe("writing a client's hook file where it was checked to be", () => {
  const raceCli: CustomClient = { ...merged, id: "race-cli", hooks: { file: "~/dir/hooks.json", format: "claude" } };
  const fixture = async (existing: "none" | "theirs" | "ours") => {
    const root = await realpath(await temporaryHome());
    const home = join(root, "home");
    const protectedDir = join(home, "ParaselfData");
    await mkdir(join(home, "dir"), { recursive: true });
    await mkdir(protectedDir, { recursive: true });
    const descriptor = customClientDescriptor(raceCli);
    const path = customHookPath(raceCli.hooks.file, home);
    if (existing === "theirs") await writeFile(path, JSON.stringify({ safe: "original" }));
    if (existing === "ours") {
      await installIntegrations({ mode: "apply", bridgePath, platform: "darwin", paths: { [raceCli.id]: path }, clients: [descriptor], runner: runner() });
    }
    const victim = join(protectedDir, "hooks.json");
    await writeFile(victim, JSON.stringify({ protected: "必须不变" }));
    // Another process, just after the last check: the folder the file is in made a link into Paraself's data.
    const swapFolder = async () => {
      await rename(join(home, "dir"), join(home, "dir-before"));
      await symlink(protectedDir, join(home, "dir"));
    };
    const swapFile = async () => {
      await rename(path, `${path}.before`).catch(() => undefined);
      await symlink(victim, path);
    };
    return { home, path, descriptor, victim, swapFolder, swapFile };
  };

  it.each([
    ["an install, the file there", "theirs", "install", "folder"],
    ["an install, no file yet", "none", "install", "folder"],
    ["a removal", "ours", "remove", "folder"],
    ["an install, the file itself made a link", "theirs", "install", "file"],
    ["a removal, the file itself made a link", "ours", "remove", "file"],
  ] as const)("writes nothing through a link made after the last check, in %s", async (_kind, existing, operation, swap) => {
    const h = await fixture(existing);
    const checkTarget = async (_client: string, path: string, stage: "check" | "write") => {
      if (stage !== "write") return undefined;
      const lock = await lockHookTarget(path, h.home);
      await (swap === "folder" ? h.swapFolder() : h.swapFile());
      return lock;
    };
    const options = { mode: "apply" as const, bridgePath, platform: "darwin" as const, paths: { [raceCli.id]: h.path }, clients: [h.descriptor], runner: runner(), checkTarget };
    const report = await (operation === "install" ? installIntegrations(options) : removeIntegrations(options)).catch((error: Error) => error);
    expect(await readFile(h.victim, "utf8")).toBe(JSON.stringify({ protected: "必须不变" }));
    const detail = report instanceof Error ? report.message : report.targets[0]?.detail ?? "";
    expect(detail).toMatch(/写入前被改动/u);
  });

  it("writes the file where it was checked to be when nothing moved", async () => {
    const h = await fixture("theirs");
    const checkTarget = async (_client: string, path: string, stage: "check" | "write") => (stage === "write" ? lockHookTarget(path, h.home) : undefined);
    const report = await installIntegrations({ mode: "apply", bridgePath, platform: "darwin", paths: { [raceCli.id]: h.path }, clients: [h.descriptor], runner: runner(), checkTarget });
    expect(report.targets[0]?.status).toBe("installed");
    expect(JSON.parse(await readFile(h.path, "utf8"))).toMatchObject({ safe: "original" });
    expect(await readFile(h.path, "utf8")).toContain("hook stop race-cli");
  });

  it("refuses to lock a path with a link along it", async () => {
    const h = await fixture("none");
    await h.swapFolder();
    await expect(lockHookTarget(h.path, h.home)).rejects.toThrow(/符号链接/u);
  });
});

describe("the bridge in every template on Windows", () => {
  it("is checked as the hooks check it, in a listing and a removal too", async () => {
    const client: CustomClient = {
      ...merged,
      command: "mycli",
      mcp: { mode: "command", add: ["mcp", "add", "decision", "{bridge}"], remove: ["mcp", "rm", "decision", "{bridge}"], list: { output: "json", args: ["mcp", "ls", "{bridge}"] } },
    };
    const home = await temporaryHome();
    const calls: string[][] = [];
    const report = await removeIntegrations({
      mode: "apply", bridgePath: "C:\\Program Files\\A&B\\paraself-bridge.cmd", platform: "win32",
      paths: { [client.id]: customHookPath(client.hooks.file, home) }, clients: [customClientDescriptor(client)], runner: runner(calls),
    });
    expect(calls).toEqual([]);
    expect(report.targets[0]).toMatchObject({ status: "failed", detail: expect.stringMatching(/命令行会另作解释的字符/u) });
  });
});
