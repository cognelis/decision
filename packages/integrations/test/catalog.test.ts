import { CLIENT_CATALOG, customClientSchema } from "@cognelis/decision-protocol";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CATALOG_CLIENTS,
  clientHookPaths,
  customHookPath,
  detectIntegrationStatus,
  hookBridgeReference,
  hookCommandLine,
  installIntegrations,
  KNOWN_CLIENTS,
  mcpByFile,
  mergeFlatHooks,
  mergeHookDocument,
  removeIntegrations,
  customClientDescriptor,
  type ClientDescriptor,
  type CommandRunner,
} from "../src/index.js";

const bridgePath = "/Applications/Paraself.app/Contents/Resources/bridge/paraself-bridge";
const reference = hookBridgeReference(bridgePath, "darwin");
// No catalog tool registers its server by a command: none is run.
const runner: CommandRunner = async (command, args) => {
  throw new Error(`ran ${command} ${args.join(" ")}`);
};

const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
const write = async (path: string, value: unknown) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
};

/** What the reader already has in a file of this format: a hook of their own, and a setting. */
const theirs = (client: ClientDescriptor): Record<string, unknown> | null =>
  client.hooks.ownsFile === true
    ? null
    : client.hooks.format === "flat"
      ? { version: 1, hooks: { stop: [{ command: "~/bin/notify.sh" }] } }
      : { model: "their-model", hooks: { Stop: [{ hooks: [{ type: "command", command: "~/bin/notify.sh" }] }] } };

const setUp = async (client: ClientDescriptor, mcpServer?: unknown, name = "paraself") => {
  const home = await mkdtemp(join(tmpdir(), `decision-catalog-${client.id}-`));
  const paths = clientHookPaths([client], {}, home);
  const hookPath = paths[client.id]!;
  const mcp = client.mcp;
  const mcpPath = mcpByFile(mcp) ? customHookPath(mcp.file, home) : null;
  const before = theirs(client);
  if (before !== null) await write(hookPath, before);
  if (mcpPath !== null) {
    const existing = mcpPath === hookPath && before !== null ? before : {};
    await write(mcpPath, { ...existing, theme: "dark", mcpServers: { github: { command: "npx", args: ["github-mcp"] }, ...(mcpServer === undefined ? {} : { [name]: mcpServer }) } });
  }
  const options = { bridgePath, platform: "darwin" as const, clients: [client], paths, home, runner };
  return { hookPath, mcpPath, before, options, paths };
};

describe("the catalog", () => {
  it("is looked up after the clients written in code, each id once", () => {
    expect(KNOWN_CLIENTS.slice(0, 4).map((client) => client.id)).toEqual(["claude-code", "codex", "grok", "antigravity"]);
    expect(new Set(KNOWN_CLIENTS.map((client) => client.id)).size).toBe(KNOWN_CLIENTS.length);
    expect(CATALOG_CLIENTS.map((client) => client.id)).toEqual(CLIENT_CATALOG.map(({ client }) => client.id));
  });

  it.each(CATALOG_CLIENTS.map((client) => [client.id, client] as const))(
    "%s: connects beside what the reader has, again without a change, and takes out only its own",
    async (_id, client) => {
      const { hookPath, mcpPath, before, options, paths } = await setUp(client);
      const mcpBefore = mcpPath === null ? null : await readJson(mcpPath);

      const report = await installIntegrations({ ...options, mode: "apply" });
      expect(report.targets[0]).toMatchObject({ client: client.id, status: "installed", changed: true });
      const written = await readJson(hookPath);
      // The reader's own hook and setting stay.
      if (before !== null) {
        expect(JSON.stringify(written)).toContain("~/bin/notify.sh");
        if ("model" in before) expect(written.model).toBe("their-model");
      }
      if (client.hooks.format === "flat") expect(written.version).toBe(1);
      for (const { event, operation } of client.hooks.events) {
        const entries = (written.hooks as Record<string, unknown[]>)[event]!;
        const handlers = client.hooks.format === "flat" ? entries : entries.flatMap((group) => (group as { hooks: unknown[] }).hooks);
        // Its whole command line, the bridge's arguments apart from it or not.
        const runs = (handler: unknown) => hookCommandLine(handler as { command?: unknown; args?: unknown })?.includes(`hook ${operation} ${client.id}`) === true;
        const ours = handlers.find(runs) as Record<string, unknown>;
        expect(ours).toMatchObject({ type: "command" });
        expect(ours[client.hooks.timeout?.field ?? "timeout"]).toBe(client.hooks.timeout?.value ?? 5);
        if (client.hooks.group !== undefined) {
          const group = entries.find((entry) => (entry as { hooks: unknown[] }).hooks.some(runs));
          expect(group).toMatchObject(client.hooks.group);
        }
      }
      expect(await detectIntegrationStatus(paths, reference, "darwin", [client])).toEqual({ [client.id]: "installed" });
      if (mcpPath !== null) {
        const mcp = await readJson(mcpPath);
        const servers = mcp.mcpServers as Record<string, Record<string, unknown>>;
        expect(servers.github).toEqual({ command: "npx", args: ["github-mcp"] });
        expect(mcp.theme).toBe("dark");
        expect(servers.paraself).toEqual({ ...(mcpByFile(client.mcp) ? client.mcp.entry : {}), command: bridgePath, args: ["mcp", client.id] });
      }

      // Connected again: nothing to change.
      const hookAfter = await readFile(hookPath, "utf8");
      const mcpAfter = mcpPath === null ? null : await readFile(mcpPath, "utf8");
      const again = await installIntegrations({ ...options, mode: "apply" });
      expect(again.targets[0]).toMatchObject({ status: "installed", changed: false });
      expect(await readFile(hookPath, "utf8")).toBe(hookAfter);
      if (mcpPath !== null) expect(await readFile(mcpPath, "utf8")).toBe(mcpAfter);

      const removed = await removeIntegrations({ ...options, mode: "apply" });
      expect(removed.targets[0]).toMatchObject({ status: "removed" });
      if (before === null) {
        await expect(readFile(hookPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(await readJson(hookPath)).toMatchObject(before);
        expect(JSON.stringify(await readJson(hookPath))).not.toContain(`mcp ${client.id}`);
        expect(JSON.stringify(await readJson(hookPath))).not.toContain(bridgePath);
      }
      if (mcpPath !== null) expect(await readJson(mcpPath)).toEqual(mcpBefore);
      expect(await detectIntegrationStatus(paths, reference, "darwin", [client])).toEqual({ [client.id]: "not-installed" });
    },
  );

  it.each(CATALOG_CLIENTS.filter((client) => mcpByFile(client.mcp)).map((client) => [client.id, client] as const))(
    "%s: leaves a paraself server of the reader's own alone, and writes no hooks over it",
    async (_id, client) => {
      const theirServer = { command: "npx", args: ["their-paraself-server"] };
      const { hookPath, mcpPath, options } = await setUp(client, theirServer);
      const hookBefore = await readFile(hookPath, "utf8").catch(() => null);

      const failed = await installIntegrations({ ...options, mode: "apply" }).catch((error: Error) => error);
      expect((failed as Error).message).toMatch(/已有一个名为 paraself 的服务器，运行的不是本应用的桥接程序/u);
      expect(((await readJson(mcpPath!)).mcpServers as Record<string, unknown>).paraself).toEqual(theirServer);
      expect(await readFile(hookPath, "utf8").catch(() => null)).toBe(hookBefore);

      const removed = await removeIntegrations({ ...options, mode: "apply" });
      expect(removed.targets[0]?.detail ?? "").toMatch(/不是本应用的，没有动它/u);
      expect(((await readJson(mcpPath!)).mcpServers as Record<string, unknown>).paraself).toEqual(theirServer);
    },
  );

  it.each(CATALOG_CLIENTS.filter((client) => mcpByFile(client.mcp)).map((client) => [client.id, client] as const))(
    "%s: connects beside a decision server of the reader's own, leaving it and saying so",
    async (_id, client) => {
      const theirServer = { command: "npx", args: ["their-decision-server"] };
      const { mcpPath, options } = await setUp(client, theirServer, "decision");

      const report = await installIntegrations({ ...options, mode: "apply" });
      expect(report.targets[0]).toMatchObject({ status: "installed", detail: expect.stringContaining("名为 decision 的 MCP 服务器不是本应用的，没有动它") });
      const servers = (await readJson(mcpPath!)).mcpServers as Record<string, unknown>;
      expect(servers.decision).toEqual(theirServer);
      expect(servers.paraself).toMatchObject({ command: bridgePath, args: ["mcp", client.id] });
    },
  );

  it.each(CATALOG_CLIENTS.filter((client) => mcpByFile(client.mcp)).map((client) => [client.id, client] as const))(
    "%s: takes the server Decision registered in its MCP file out at a connect, what the reader added to it kept",
    async (_id, client) => {
      const decisionServer = { command: "/Applications/Decision.app/Contents/Resources/bridge/decision-bridge", args: ["mcp", client.id], env: { THEIR: "1" } };
      const { mcpPath, options } = await setUp(client, decisionServer, "decision");

      await installIntegrations({ ...options, mode: "apply" });
      const servers = (await readJson(mcpPath!)).mcpServers as Record<string, unknown>;
      expect(servers.decision).toBeUndefined();
      expect(servers.paraself).toEqual({ ...(mcpByFile(client.mcp) ? client.mcp.entry : {}), env: { THEIR: "1" }, command: bridgePath, args: ["mcp", client.id] });
      expect(servers.github).toEqual({ command: "npx", args: ["github-mcp"] });
    },
  );

  it("takes Copilot's hooks file as Decision named it away at a connect, and reads it as needing one before", async () => {
    const client = CATALOG_CLIENTS.find((entry) => entry.id === "copilot")!;
    const { hookPath, options, paths } = await setUp(client);
    const decisionBridge = "/Applications/Decision.app/Contents/Resources/bridge/decision-bridge";
    const legacy = join(dirname(hookPath), "decision.json");
    await write(legacy, JSON.parse(JSON.stringify(mergeFlatHooks({}, decisionBridge, client, "darwin")).replaceAll("PARASELF_HOOK=", "DECISION_HOOK=")));

    expect(await detectIntegrationStatus(paths, reference, "darwin", [client])).toEqual({ copilot: "upgrade-required" });
    const report = await installIntegrations({ ...options, mode: "apply" });
    expect(report.targets[0]).toMatchObject({ status: "installed" });
    await expect(readFile(legacy, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await detectIntegrationStatus(paths, reference, "darwin", [client])).toEqual({ copilot: "installed" });
  });

  it("does not write a file it cannot read as strict JSON, one with comments among them", async () => {
    const client = CATALOG_CLIENTS.find((entry) => entry.id === "qwen-code")!;
    const { hookPath, options } = await setUp(client);
    const commented = `{\n  // their note\n  "model": "their-model"\n}\n`;
    await writeFile(hookPath, commented);
    const failed = await installIntegrations({ ...options, mode: "apply" }).catch((error: Error) => error);
    expect((failed as Error).message).toMatch(/不是有效的 JSON（有注释/u);
    expect(await readFile(hookPath, "utf8")).toBe(commented);
  });

  it("refuses a hooks file of Copilot's own that holds anything not this app's", async () => {
    const client = CATALOG_CLIENTS.find((entry) => entry.id === "copilot")!;
    const { hookPath, options } = await setUp(client);
    await write(hookPath, { version: 1, hooks: { Stop: [{ type: "command", command: "~/bin/notify.sh" }] } });
    const failed = await installIntegrations({ ...options, mode: "apply" }).catch((error: Error) => error);
    expect((failed as Error).message).toMatch(/不是本应用写入的内容/u);
  });

  it("does not connect Droid while a hooks.json of its own there keeps it from reading settings.json's hooks", async () => {
    const client = CATALOG_CLIENTS.find((entry) => entry.id === "droid")!;
    const { hookPath, options } = await setUp(client);
    await write(join(dirname(hookPath), "hooks.json"), { Stop: [] });
    const failed = await installIntegrations({ ...options, mode: "apply" }).catch((error: Error) => error);
    expect((failed as Error).message).toMatch(/hooks\.json 时 Factory Droid 不读/u);
    expect(await readFile(hookPath, "utf8")).not.toContain("hook stop droid");
  });

  it("does not make CodeBuddy's .mcp.json while an older file it reads its servers from is there", async () => {
    const client = CATALOG_CLIENTS.find((entry) => entry.id === "codebuddy")!;
    const home = await mkdtemp(join(tmpdir(), "decision-catalog-codebuddy-older-"));
    const paths = clientHookPaths([client], {}, home);
    await write(join(home, ".codebuddy", "mcp.json"), { mcpServers: { github: { command: "npx" } } });
    const failed = await installIntegrations({ mode: "apply", bridgePath, platform: "darwin", clients: [client], paths, home, runner }).catch((error: Error) => error);
    expect((failed as Error).message).toMatch(/新建 .*\.mcp\.json 会让它不再读那份文件/u);
    await expect(readFile(join(home, ".codebuddy", ".mcp.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  describe("Auggie, run with no shell", () => {
    const auggie = CATALOG_CLIENTS.find((entry) => entry.id === "auggie")!;

    it("names the bridge in command and the rest in args, no variable before it, and reads it back as connected", async () => {
      const { hookPath, options, paths } = await setUp(auggie);
      await installIntegrations({ ...options, mode: "apply" });
      const groups = ((await readJson(hookPath)).hooks as Record<string, { hooks: Record<string, unknown>[] }[]>).Stop!;
      const ours = groups.flatMap((group) => group.hooks).find((handler) => handler.command === bridgePath)!;
      expect(ours).toEqual({ type: "command", command: bridgePath, args: ["hook", "stop", "auggie", "PARASELF_HOOK=1"], timeout: 5_000 });
      expect(await detectIntegrationStatus(paths, reference, "darwin", [auggie])).toEqual({ auggie: "installed" });
      // Another app's bridge there: a reconnect.
      expect(await detectIntegrationStatus(paths, hookBridgeReference("/Other/paraself-bridge", "darwin"), "darwin", [auggie])).toEqual({ auggie: "upgrade-required" });
    });

    it("on Windows runs the bridge through cmd as Claude Code's hook is, its arguments apart", async () => {
      const { hookPath, options } = await setUp(auggie);
      const windowsBridge = "C:\\Users\\me\\AppData\\Local\\Paraself\\paraself-bridge.cmd";
      await installIntegrations({ ...options, bridgePath: windowsBridge, platform: "win32", mode: "apply" });
      const groups = ((await readJson(hookPath)).hooks as Record<string, { hooks: Record<string, unknown>[] }[]>).Stop!;
      expect(groups.flatMap((group) => group.hooks).find((handler) => handler.command === "cmd.exe")).toMatchObject({
        args: ["/d", "/v:off", "/c", "call", windowsBridge, "hook", "stop", "auggie", "PARASELF_HOOK=2"],
      });
    });

    it("is not connected where Paraself's path has a space, which it would split the command on", async () => {
      const { hookPath, options } = await setUp(auggie);
      const before = await readFile(hookPath, "utf8");
      const spaced = "/Users/me/My Apps/Paraself.app/Contents/Resources/bridge/paraself-bridge";
      const failed = await installIntegrations({ ...options, bridgePath: spaced, mode: "apply" }).catch((error: Error) => error);
      expect((failed as Error).message).toMatch(/路径里有空格/u);
      // Neither its hooks nor its MCP server written.
      expect(await readFile(hookPath, "utf8")).toBe(before);
    });

    it("leaves every other client's hook one command line", async () => {
      for (const client of [...KNOWN_CLIENTS.slice(0, 4), ...CATALOG_CLIENTS.filter((entry) => entry.id !== "auggie")]) {
        expect(client.hooks.invocation).toBeUndefined();
      }
      const qwen = CATALOG_CLIENTS.find((entry) => entry.id === "qwen-code")!;
      const { hookPath, options } = await setUp(qwen);
      await installIntegrations({ ...options, mode: "apply" });
      expect(await readFile(hookPath, "utf8")).toContain(`"command": "PARASELF_HOOK=1 '${bridgePath}' hook stop qwen-code"`);
    });
  });
});

// CL2-REVIEW-CAT (rounds/CL2/review-cat/standards): the reviewer's reproductions, kept as the behaviour they asked for.
describe("a catalog tool's MCP file and hooks, as the review found them", () => {
  const cursor = CATALOG_CLIENTS.find((entry) => entry.id === "cursor")!;
  const mcpOf = (home: string) => customHookPath((cursor.mcp as { file: string }).file, home);

  it("takes a server for this app's by its form alone: a program named like the bridge is not it (CFG-1)", async () => {
    const { options } = await setUp(cursor);
    const theirs = { command: "/usr/local/bin/my-paraself-bridge", args: ["mcp", "cursor"], env: { USER_SETTING: "keep" } };
    await write(mcpOf(options.home), { mcpServers: { paraself: theirs } });
    await expect(installIntegrations({ ...options, mode: "apply" })).rejects.toThrow(/运行的不是本应用的桥接程序/u);
    expect(((await readJson(mcpOf(options.home))).mcpServers as Record<string, unknown>).paraself).toEqual(theirs);
  });

  it("does not take out a server whose arguments only mention the bridge (CFG-1)", async () => {
    const { options } = await setUp(cursor);
    for (const [name, bridge] of [["paraself", "paraself-bridge"], ["decision", "decision-bridge"]] as const) {
      const theirs = { command: "/usr/local/bin/custom-mcp-server", args: ["--label", bridge, "--example", "mcp cursor"] };
      await write(mcpOf(options.home), { mcpServers: { [name]: theirs } });
      await removeIntegrations({ ...options, mode: "apply" });
      expect(((await readJson(mcpOf(options.home))).mcpServers as Record<string, unknown>)[name], name).toEqual(theirs);
    }
  });

  it("takes this app's server at an earlier place, and on Windows its cmd wrapper, as its own; extra arguments not (CFG-1)", async () => {
    // By its name now, and by Decision's from Decision.app and Decision's launcher at the install root.
    for (const [name, app, root] of [["paraself", "Paraself", "Paraself\\paraself"], ["decision", "Decision", "Decision\\decision"]] as const) {
      const { options } = await setUp(cursor);
      await write(mcpOf(options.home), { mcpServers: { [name]: { command: `/Old/${app}.app/Contents/Resources/bridge/${name}-bridge`, args: ["mcp", "cursor"] } } });
      await installIntegrations({ ...options, mode: "apply" });
      expect((await readJson(mcpOf(options.home))).mcpServers, name).toEqual({ paraself: { type: "stdio", command: bridgePath, args: ["mcp", "cursor"] } });

      const windowsBridge = `C:\\Users\\me\\AppData\\Local\\${root}-bridge.cmd`;
      const wrapped = { type: "stdio", command: "cmd", args: ["/d", "/v:off", "/c", "call", windowsBridge, "mcp", "cursor"] };
      await write(mcpOf(options.home), { mcpServers: { [name]: wrapped } });
      await removeIntegrations({ ...options, bridgePath: "C:\\Users\\me\\AppData\\Local\\Paraself\\paraself-bridge.cmd", platform: "win32", mode: "apply" });
      expect((await readJson(mcpOf(options.home))).mcpServers, name).toEqual({});

      const extra = { command: bridgePath, args: ["mcp", "cursor", "--their-flag"] };
      await write(mcpOf(options.home), { mcpServers: { [name]: extra } });
      await removeIntegrations({ ...options, mode: "apply" });
      expect(((await readJson(mcpOf(options.home))).mcpServers as Record<string, unknown>)[name], name).toEqual(extra);
    }
  });

  it("keeps what the reader added to this app's own entry, disabled among it, through a reconnect (CFG-2)", async () => {
    const { options } = await setUp(cursor);
    await installIntegrations({ ...options, mode: "apply" });
    const document = await readJson(mcpOf(options.home));
    const servers = document.mcpServers as Record<string, Record<string, unknown>>;
    Object.assign(servers.paraself!, { env: { THEIR: "1" }, disabled: true, vendorFutureOption: { keep: 1 } });
    await write(mcpOf(options.home), document);
    await installIntegrations({ ...options, mode: "apply" });
    expect(((await readJson(mcpOf(options.home))).mcpServers as Record<string, unknown>).paraself).toEqual({
      type: "stdio", command: bridgePath, args: ["mcp", "cursor"], env: { THEIR: "1" }, disabled: true, vendorFutureOption: { keep: 1 },
    });
  });

  it("says Droid is shadowed, not connected, once a hooks.json of its own is there (CFG-3)", async () => {
    const droid = CATALOG_CLIENTS.find((entry) => entry.id === "droid")!;
    const { options, paths } = await setUp(droid);
    await installIntegrations({ ...options, mode: "apply" });
    expect(await detectIntegrationStatus(paths, reference, "darwin", [droid], options.home)).toEqual({ droid: "installed" });
    await write(customHookPath(droid.hooks.shadowedBy!, options.home), { hooks: {} });
    expect(await detectIntegrationStatus(paths, reference, "darwin", [droid], options.home)).toEqual({ droid: "shadowed" });
    // Never connected, it is not connected: no word of a shadow.
    const fresh = await setUp(droid);
    await write(customHookPath(droid.hooks.shadowedBy!, fresh.options.home), { hooks: {} });
    expect(await detectIntegrationStatus(fresh.paths, reference, "darwin", [droid], fresh.options.home)).toEqual({ droid: "not-installed" });
  });

  it("refuses a timeout field that would take the place of what a handler runs (CFG-4)", () => {
    for (const field of ["command", "type", "args", "bash", "powershell"]) {
      const raw = { ...CLIENT_CATALOG[0]!.client, id: "timeout-test", hooks: { ...CLIENT_CATALOG[0]!.client.hooks, timeout: { field, value: 5000 } } };
      expect(customClientSchema.safeParse(raw).success).toBe(false);
    }
    const fine = customClientSchema.parse({ ...CLIENT_CATALOG[0]!.client, id: "timeout-test", hooks: { ...CLIENT_CATALOG[0]!.client.hooks, timeout: { field: "timeoutMs", value: 5000 } } });
    const handler = (mergeHookDocument({}, bridgePath, customClientDescriptor(fine), "darwin").hooks.UserPromptSubmit![0]!.hooks[0]!);
    expect(handler).toMatchObject({ type: "command", timeoutMs: 5000 });
    expect(typeof handler.command).toBe("string");
  });

  it("finds in a check what an install of its MCP file would refuse or change, writing nothing (CFG-5)", async () => {
    const cases: [string, (home: string, client: ClientDescriptor) => Promise<void>][] = [
      ["another paraself", async (home) => writeFile(mcpOf(home), JSON.stringify({ mcpServers: { paraself: { command: "npx", args: ["their-server"] } } }))],
      ["comments", async (home) => writeFile(mcpOf(home), '{\n// their note\n"mcpServers":{}\n}')],
      ["an older file", async (home, client) => {
        const mcp = client.mcp as { file: string; olderFiles: string[] };
        await rename(customHookPath(mcp.file, home), customHookPath(mcp.olderFiles[0]!, home));
      }],
    ];
    for (const [what, breakIt] of cases) {
      const client = what === "an older file" ? CATALOG_CLIENTS.find((entry) => entry.id === "codebuddy")! : cursor;
      const { options } = await setUp(client);
      await installIntegrations({ ...options, mode: "apply" });
      await breakIt(options.home, client);
      const mcpPath = customHookPath((client.mcp as { file: string }).file, options.home);
      const before = await readFile(mcpPath, "utf8").catch(() => null);
      const report = await installIntegrations({ ...options, mode: "dry-run" });
      expect(report.targets[0], what).toMatchObject({ status: "failed" });
      expect(await readFile(mcpPath, "utf8").catch(() => null), what).toBe(before);
    }
    // A server not added yet is a change to make, said so without writing it.
    const { options } = await setUp(cursor);
    const report = await installIntegrations({ ...options, mode: "dry-run" });
    expect(report.targets[0]).toMatchObject({ changed: true });
    expect(((await readJson(mcpOf(options.home))).mcpServers as Record<string, unknown>).paraself).toBeUndefined();
    await installIntegrations({ ...options, mode: "apply" });
    expect((await installIntegrations({ ...options, mode: "dry-run" })).targets[0]).toMatchObject({ changed: false });
  });
});
