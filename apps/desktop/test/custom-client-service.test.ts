import {
  clientHookPath,
  customHookPath,
  inIntegrationsTurn,
  installIntegrationsWithinTurn,
  removeIntegrationsWithinTurn,
  type ClientDescriptor,
  type InstallReport,
} from "@cognelis/decision-integrations";
import type { CustomClient } from "@cognelis/decision-protocol";
import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { CustomClientService } from "../src/main/custom-client-service.js";

const myCli: CustomClient = {
  id: "my-cli",
  name: "My CLI",
  shortName: "MC",
  hooks: { file: "~/.mycli/hooks.json", format: "claude" },
  prompt: { event: "UserPromptSubmit", field: "prompt" },
  reply: { event: "Stop", source: "field", field: "last_assistant_message" },
  fields: { sessionId: "session_id", cwd: "cwd" },
  mcp: { mode: "none" },
};

const report = (client: string, status: "removed" | "skipped" | "failed", detail?: string): InstallReport => ({
  mode: "apply",
  targets: [{ client, path: "/x", changed: status === "removed", status, ...(detail === undefined ? {} : { detail }) }],
  commands: [],
  restartRequired: true,
});

const setUp = async (disconnect = vi.fn(async (client: ClientDescriptor) => report(client.id, "removed"))) => {
  const root = await (await import("node:fs/promises")).realpath(await mkdtemp(join(tmpdir(), "decision-custom-service-")));
  const path = join(root, "user-data", "custom-clients.json");
  const service = new CustomClientService({
    path,
    home: join(root, "home"),
    builtInPaths: () => ({ "claude-code": join(root, "home", ".claude", "settings.json") }),
    protectedDirectories: () => [join(root, "user-data")],
    disconnect,
  });
  await service.load();
  return { root, path, service, disconnect };
};

describe("the clients the reader adds", () => {
  it("saves one and reads it back after a restart", async () => {
    const { path, service, disconnect } = await setUp();
    expect(await service.save(myCli)).toEqual([myCli]);
    expect(disconnect).not.toHaveBeenCalled();

    const again = new CustomClientService({ path, builtInPaths: () => ({}), protectedDirectories: () => [], disconnect });
    await again.load();
    expect(again.list()).toEqual([myCli]);
    expect(again.descriptors().map((client) => client.id)).toEqual(["my-cli"]);
  });

  it("starts with none, and the file set aside, when the file cannot be read", async () => {
    const { root, path } = await setUp();
    await mkdir(join(root, "user-data"), { recursive: true });
    await writeFile(path, "{ broken");
    const service = new CustomClientService({ path, builtInPaths: () => ({}), protectedDirectories: () => [], disconnect: vi.fn() });
    const { setAside } = await service.load();
    expect(service.list()).toEqual([]);
    expect(setAside).toMatch(/custom-clients\.json\.unreadable-/u);
    expect(await readFile(setAside!, "utf8")).toBe("{ broken");
    expect((await readdir(join(root, "user-data"))).includes("custom-clients.json")).toBe(false);
  });

  it("refuses one with a built-in client's id, another's hook file, or a hook file in Paraself's own data", async () => {
    const { service } = await setUp();
    await service.save(myCli);
    await expect(service.save({ ...myCli, id: "codex" })).rejects.toThrow("id codex 是内置客户端的");
    await expect(service.save({ ...myCli, id: "other-cli" })).rejects.toThrow("My CLI 已经用这个钩子配置文件");
    await expect(service.save({ ...myCli, id: "other-cli", hooks: { file: "~/.claude/settings.json", format: "claude" } })).rejects.toThrow("Claude Code 已经用这个钩子配置文件");
    await expect(service.save({ ...myCli, id: "my-cli" })).rejects.toThrow("已经有一个 id 为 my-cli 的客户端");
    expect(service.list()).toEqual([myCli]);
  });

  it("refuses one the schema does not read, a command line among it", async () => {
    const { service } = await setUp();
    await expect(service.save({ ...myCli, command: "mycli && rm -rf ~" })).rejects.toThrow();
    expect(service.list()).toEqual([]);
  });

  it("disconnects one edited where it was before saving it as it now is", async () => {
    const { service, disconnect } = await setUp();
    await service.save(myCli);
    const edited = { ...myCli, name: "My CLI 2", hooks: { file: "~/.mycli2/hooks.json", format: "claude-owned" as const } };
    expect(await service.save(edited, "my-cli")).toEqual([edited]);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(disconnect.mock.calls[0]![0]).toMatchObject({ id: "my-cli", hooks: { file: "hooks.json" }, configDir: { home: ".mycli" } });
  });

  it("deletes one once it is disconnected, and keeps it where it could not be", async () => {
    const disconnect = vi.fn(async (client: ClientDescriptor) => report(client.id, "failed", "无法写入 hooks.json"));
    const { service } = await setUp(disconnect);
    await service.save(myCli);
    await expect(service.delete("my-cli")).rejects.toThrow("My CLI 没能先断开（无法写入 hooks.json），没有删除它");
    expect(service.list()).toEqual([myCli]);

    disconnect.mockImplementation(async (client) => report(client.id, "removed"));
    expect((await service.delete("my-cli")).targets[0]?.status).toBe("removed");
    expect(service.list()).toEqual([]);
  });

  it("keeps one edited as it was where it could not be disconnected", async () => {
    const disconnect = vi.fn(async (client: ClientDescriptor) => report(client.id, "failed", "权限不够"));
    const { service } = await setUp(disconnect);
    await service.save(myCli);
    await expect(service.save({ ...myCli, name: "Renamed" }, "my-cli")).rejects.toThrow("没有改动它");
    expect(service.list()).toEqual([myCli]);
  });
});

describe("the clients read back at start", () => {
  const written = async (clients: unknown[]) => {
    const root = await (await import("node:fs/promises")).realpath(await mkdtemp(join(tmpdir(), "decision-custom-load-")));
    const path = join(root, "user-data", "custom-clients.json");
    await mkdir(join(root, "user-data"), { recursive: true });
    await writeFile(path, JSON.stringify({ version: 1, clients }));
    const disconnect = vi.fn(async (client: ClientDescriptor) => report(client.id, "removed"));
    const service = new CustomClientService({
      path,
      home: join(root, "home"),
      builtInPaths: () => ({ "claude-code": join(root, "home", ".claude", "settings.json") }),
      protectedDirectories: () => [join(root, "user-data")],
      disconnect,
    });
    await service.load();
    return { root, path, service, disconnect };
  };

  it("keeps one that would not be saved out of what is connected, and says why on the page", async () => {
    const builtIn = { ...myCli, id: "claude-code", hooks: { file: "~/.other/hooks.json", format: "claude" } };
    const inData = { ...myCli, id: "in-data", hooks: { file: "~/../user-data/hooks.json", format: "claude" } };
    const sharing = { ...myCli, id: "sharing-cli", name: "Sharing CLI" };
    const { service } = await written([myCli, builtIn, sharing]);
    // A file the schema reads, but one id among it is a built-in client's and one hook file is another's.
    expect(service.descriptors().map((client) => client.id)).toEqual(["my-cli"]);
    expect(service.summaries()).toEqual([
      { id: "my-cli", name: "My CLI", shortName: "MC", mcp: false, custom: true },
      { id: "claude-code", name: "My CLI", shortName: "MC", mcp: false, custom: true, problem: "id claude-code 是内置客户端的，换一个" },
      { id: "sharing-cli", name: "Sharing CLI", shortName: "MC", mcp: false, custom: true, problem: "My CLI 已经用这个钩子配置文件，两个客户端不能共用一个" },
    ]);
    expect(await service.targetProblems("my-cli")).toEqual([]);
    expect(await service.targetProblems("sharing-cli")).not.toEqual([]);
    void inData;
  });

  it("deletes one it never connected without touching its hook file", async () => {
    const sharing = { ...myCli, id: "sharing-cli", name: "Sharing CLI" };
    const { service, disconnect } = await written([myCli, sharing]);
    await service.delete("sharing-cli");
    expect(disconnect).not.toHaveBeenCalled();
    expect(service.list().map((client) => client.id)).toEqual(["my-cli"]);
  });

  it("says which one an earlier build saved registering MCP it could not list now registers none", async () => {
    const old = { ...myCli, command: "mycli", mcp: { mode: "command", add: ["mcp", "add", "decision", "{bridge}"], remove: ["mcp", "rm", "decision"], list: { output: "none" } } };
    const { service } = await written([old]);
    expect(service.list()[0]!.mcp).toEqual({ mode: "none" });
    expect(service.summaries()[0]!.notice).toMatch(/不支持查询.*改为不注册 MCP/u);
  });
});

describe("saving and deleting the reader's clients", () => {
  it("waits its turn with the installs and removals", async () => {
    const order: string[] = [];
    const root = await (await import("node:fs/promises")).realpath(await mkdtemp(join(tmpdir(), "decision-custom-turn-")));
    const service = new CustomClientService({
      path: join(root, "custom-clients.json"),
      home: join(root, "home"),
      builtInPaths: () => ({}),
      protectedDirectories: () => [],
      disconnect: vi.fn(async (client: ClientDescriptor) => report(client.id, "removed")),
      serialize: async (run) => { order.push("queued"); const result = await run(); order.push("done"); return result; },
    });
    await service.save(myCli);
    await service.delete("my-cli");
    expect(order).toEqual(["queued", "done", "queued", "done"]);
  });
});

describe("a client whose hook file's path cannot be followed at all", () => {
  it("is said to have a problem, and the others are read and connected as ever", async () => {
    const root = await (await import("node:fs/promises")).realpath(await mkdtemp(join(tmpdir(), "decision-custom-loop-")));
    const home = join(root, "home");
    await mkdir(home, { recursive: true });
    await symlink(join(home, ".loop"), join(home, ".loop"));
    const path = join(root, "custom-clients.json");
    const looping = { ...myCli, id: "loop-cli", name: "Loop CLI", hooks: { file: "~/.loop/hooks.json", format: "claude" as const } };
    await writeFile(path, JSON.stringify({ version: 1, clients: [looping, myCli] }));
    const service = new CustomClientService({ path, home, builtInPaths: () => ({}), protectedDirectories: () => [], disconnect: vi.fn() });

    await expect(service.load()).resolves.toMatchObject({ setAside: null });
    expect(service.descriptors().map((client) => client.id)).toEqual(["my-cli"]);
    expect(service.summaries().find((client) => client.id === "loop-cli")?.problem).toMatch(/符号链接|读不了/u);
  });

  it("starts with none of the reader's clients, rather than not at all, when a check fails in a way not foreseen", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-custom-throw-"));
    const path = join(root, "custom-clients.json");
    await writeFile(path, JSON.stringify({ version: 1, clients: [myCli] }));
    const service = new CustomClientService({ path, home: root, builtInPaths: () => { throw new Error("environment unreadable"); }, protectedDirectories: () => [], disconnect: vi.fn() });
    await expect(service.load()).resolves.toBeDefined();
    expect(service.descriptors()).toEqual([]);
    expect(service.summaries()[0]?.problem).toMatch(/environment unreadable/u);
  });
});

describe("a change to the clients' files waiting its turn", () => {
  const bridgePath = "/Applications/Paraself.app/Contents/Resources/bridge/paraself-bridge";

  const setUpReal = async () => {
    const root = await (await import("node:fs/promises")).realpath(await mkdtemp(join(tmpdir(), "decision-custom-queue-")));
    const home = join(root, "home");
    await mkdir(home, { recursive: true });
    const service: CustomClientService = new CustomClientService({
      path: join(root, "custom-clients.json"),
      home,
      builtInPaths: () => ({}),
      protectedDirectories: () => [],
      serialize: inIntegrationsTurn,
      disconnect: (client) => removeIntegrationsWithinTurn({
        mode: "apply", bridgePath, platform: "darwin", clients: [client], paths: { [client.id]: clientHookPath(client, {}, home) },
        runner: async () => ({ exitCode: 0 }),
      }),
    });
    await service.load();
    /** An install as the 接入 page sends one: its clients and paths read once its turn comes. */
    const install = () => service.inTurn(() => {
      const clients = service.descriptors();
      return installIntegrationsWithinTurn({
        mode: "apply", bridgePath, platform: "darwin", clients,
        paths: Object.fromEntries(service.list().filter((client) => clients.some((entry) => entry.id === client.id)).map((client) => [client.id, customHookPath(client.hooks.file, home)])),
        checkTarget: (client, path, stage) => service.checkTarget(client, path, stage),
        runner: async () => ({ exitCode: 0 }),
      }).catch((error: Error) => error);
    });
    return { root, home, service, install };
  };

  /** Holds the queue until released: what is sent meanwhile waits behind it. */
  const holdQueue = () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    void inIntegrationsTurn(() => held);
    return release;
  };

  it("does not connect a client deleted while the install waited", async () => {
    const { home, service, install } = await setUpReal();
    await service.save(myCli);
    const release = holdQueue();
    const deleted = service.delete("my-cli");
    const installed = install();
    release();
    await deleted;
    await installed;
    await expect(readFile(customHookPath(myCli.hooks.file, home), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("connects a client edited while the install waited where it now is", async () => {
    const { home, service, install } = await setUpReal();
    await service.save(myCli);
    const release = holdQueue();
    const moved = { ...myCli, hooks: { file: "~/.mycli-new/hooks.json", format: "claude" as const } };
    const edited = service.save(moved, "my-cli");
    const installed = install();
    release();
    await edited;
    await installed;
    expect(await readFile(customHookPath(moved.hooks.file, home), "utf8")).toContain("hook stop my-cli");
    await expect(readFile(customHookPath(myCli.hooks.file, home), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to write a client's file other than where it now is, or one deleted, and locks the one it is", async () => {
    const { home, service } = await setUpReal();
    await service.save(myCli);
    const path = customHookPath(myCli.hooks.file, home);
    await expect(service.checkTarget("my-cli", customHookPath("~/.elsewhere/hooks.json", home), "write")).rejects.toThrow(/刚被改动过/u);
    await expect(service.checkTarget("gone-cli", path, "write")).rejects.toThrow(/已经删除/u);
    expect(await service.checkTarget("claude-code", "/anything", "write")).toBeUndefined();
    expect(await service.checkTarget("my-cli", path, "check")).toBeUndefined();
    expect(await service.checkTarget("my-cli", path, "write")).toMatchObject({ path, fileId: null });
  });
});

describe("a client of the reader's that registers its server in a file of its own", () => {
  const bridgePath = "/Applications/Paraself.app/Contents/Resources/bridge/paraself-bridge";
  const byFile: CustomClient = { ...myCli, id: "file-cli", name: "File CLI", mcp: { mode: "file", file: "~/.filecli/mcp.json", entry: { type: "stdio" } } };

  const setUpHome = async () => {
    const root = await (await import("node:fs/promises")).realpath(await mkdtemp(join(tmpdir(), "decision-custom-mcp-file-")));
    const home = join(root, "home");
    await mkdir(home, { recursive: true });
    const service = new CustomClientService({ path: join(root, "custom-clients.json"), home, builtInPaths: () => ({}), protectedDirectories: () => [join(root, "user-data")], disconnect: vi.fn() });
    await service.load();
    return { root, home, service };
  };

  it("writes it there, the file locked as its hook file is, and takes only its own out again", async () => {
    const { home, service } = await setUpHome();
    await service.save(byFile);
    const mcpPath = customHookPath("~/.filecli/mcp.json", home);
    await mkdir(join(home, ".filecli"), { recursive: true });
    await writeFile(mcpPath, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    const options = {
      bridgePath, platform: "darwin" as const, clients: service.descriptors(), home,
      paths: { "file-cli": customHookPath(byFile.hooks.file, home) },
      checkTarget: (client: string, path: string, stage: "check" | "write") => service.checkTarget(client, path, stage),
      runner: async () => { throw new Error("no command is run"); },
    };
    await installIntegrationsWithinTurn({ ...options, mode: "apply" });
    expect(JSON.parse(await readFile(mcpPath, "utf8"))).toEqual({ mcpServers: { other: { command: "x" }, paraself: { type: "stdio", command: bridgePath, args: ["mcp", "file-cli"] } } });
    await removeIntegrationsWithinTurn({ ...options, mode: "apply" });
    expect(JSON.parse(await readFile(mcpPath, "utf8"))).toEqual({ mcpServers: { other: { command: "x" } } });
  });

  it("is not saved with a link along its MCP file's path, nor with it in Paraself's own data", async () => {
    const { root, home, service } = await setUpHome();
    await mkdir(join(root, "elsewhere"), { recursive: true });
    await symlink(join(root, "elsewhere"), join(home, ".linked"));
    await expect(service.save({ ...byFile, mcp: { mode: "file", file: "~/.linked/mcp.json" } })).rejects.toThrow(/MCP 配置文件的路径里有符号链接/u);
    await mkdir(join(root, "user-data"), { recursive: true });
    await symlink(join(root, "user-data"), join(home, "data")).catch(() => undefined);
    await expect(service.save({ ...byFile, mcp: { mode: "file", file: "~/data/mcp.json" } })).rejects.toThrow(/符号链接|数据目录/u);
  });

  it("gives way to a tool the catalog ships under its id, listed as no longer in effect", async () => {
    const { root, home } = await setUpHome();
    const path = join(root, "superseded.json");
    await writeFile(path, JSON.stringify({ version: 1, clients: [{ ...myCli, id: "qwen-code", name: "My Qwen" }] }));
    const service = new CustomClientService({ path, home, builtInPaths: () => ({}), protectedDirectories: () => [], disconnect: vi.fn() });
    await service.load();
    expect(service.descriptors()).toEqual([]);
    expect(service.summaries()[0]).toMatchObject({ id: "qwen-code", superseded: true, problem: expect.stringMatching(/Paraself 已内置 Qwen Code，这一条不再生效/u) });
  });
});
