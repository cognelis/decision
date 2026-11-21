import { spawn } from "node:child_process";
import { access, constants, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import { BUILT_IN_CLIENTS, mcpByFile, type ClientDescriptor } from "./clients.js";
import { assertHookTargetLock, customHookPath, writeLockedHookFile, type HookTargetLock } from "./custom-clients.js";
import {
  hookBridgeReference,
  legacyHookFile,
  mergeAntigravityHooks,
  mergeFlatHooks,
  mergeHookDocument,
  removeAntigravityHooks,
  removeFlatHooks,
  removeHookDocument,
  type CommandSpec,
} from "./hooks.js";
import { LEGACY_MCP_SERVER_NAME, MCP_NOT_THIS_APPS, MCP_SERVER_NAME, mergeMcpFile, removeMcpFile, runsThisBridge } from "./mcp-file.js";
import { isSkillClient, skillSummary, syncBundledSkills, type SkillInstallReport } from "./skills.js";

export type InstallMode = "dry-run" | "apply";
/** A client's id, as the registry names it. */
export type IntegrationClient = string;

export interface CommandResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
) => Promise<CommandResult>;

export interface InstallTargetReport {
  client: IntegrationClient;
  path: string;
  changed: boolean;
  /**
   * After an apply: connected (detail says what the client still asks of the reader), skipped for want of its
   * command, or failed (detail says why); after a removal, removed (detail says what of it was left alone),
   * skipped (no command and nothing of this app's in its file, or nothing of this app's in the client) or failed.
   */
  status?: "installed" | "skipped" | "failed" | "removed";
  detail?: string;
}

export interface InstallReport {
  mode: InstallMode;
  targets: InstallTargetReport[];
  commands: CommandSpec[];
  restartRequired: boolean;
  /** What the reader is to know besides each client's result. */
  note?: string;
  /** Paraself's bundled skills, client by client, where the install was given them (skillsSource). */
  skills?: SkillInstallReport[];
}

interface RemoveOptions {
  mode: InstallMode;
  /** Each client's hook file, by id: the clients acted on are those named here, in the registry's order. */
  paths?: Record<string, string>;
  /** Claude Code's and Codex's, as `paths` names them. */
  claudeSettingsPath?: string;
  codexHooksPath?: string;
  /** The registry: the built-in clients unless said. */
  clients?: readonly ClientDescriptor[];
  /** The reader's home folder, where a client's MCP file (`~/…`) is. */
  home?: string;
  platform?: NodeJS.Platform;
  runner?: CommandRunner;
  /**
   * Where this run's bridge is: a server shown running it is this app's, as one running a `paraself-bridge` (or, as
   * Decision's, a `decision-bridge`) is. Not packaged, the bridge is run by its source file's name, and its own server
   * was taken for another tool's.
   */
  bridgePath?: string;
  /**
   * Checks a client's hook file where it really is, before its MCP is changed (`check`) and just before its file is
   * read and written (`write`): one that now lies somewhere it may not is refused with why, and nothing of that client's
   * changed. At `write` it may lock the file (lockHookTarget): it is then read and written there and nowhere else, and
   * only while it and its folder are the ones locked.
   */
  checkTarget?: (client: IntegrationClient, path: string, stage: "check" | "write") => Promise<HookTargetLock | void>;
}

interface InstallOptions extends RemoveOptions {
  bridgePath: string;
  /**
   * The bundled skills folder (Resources/skills): given, Codex and Claude Code get Paraself's skills in their own
   * skills folders (skills.ts), each once it is connected. Not given, none are touched.
   */
  skillsSource?: string;
  /** Where CLAUDE_CONFIG_DIR and CODEX_HOME are read for the skills folders: the process's own unless said. */
  environment?: NodeJS.ProcessEnv;
}

interface ParsedTarget {
  client: IntegrationClient;
  path: string;
  before: string;
  /** null: the file goes, one wholly this app's left with nothing in it. */
  after: string | null;
}

/** The clients to act on and each one's file, in the registry's order. */
const targetsOf = (options: RemoveOptions): { descriptor: ClientDescriptor; path: string }[] => {
  const paths: Record<string, string | undefined> = {
    ...options.paths,
    ...(options.claudeSettingsPath === undefined ? {} : { "claude-code": options.claudeSettingsPath }),
    ...(options.codexHooksPath === undefined ? {} : { codex: options.codexHooksPath }),
  };
  return (options.clients ?? BUILT_IN_CLIENTS).flatMap((descriptor) => {
    const path = paths[descriptor.id];
    return path === undefined ? [] : [{ descriptor, path }];
  });
};

/** What cmd reads as its own in an argument: a template's on Windows, where the client's command is run through it. */
const CMD_SPECIAL = /[&|<>^%!"]/u;

/**
 * A template's arguments as they are run: `{bridge}` the bridge's own argument(s), `{client}` the client's id, `{name}`
 * the server's name, in every template alike; a reader's template names the server `decision` outright, as Decision's
 * form had it written, and that is its `{name}` too. On Windows an argument cmd would read part of as its own is
 * refused, not escaped.
 */
const expandTemplate = (
  client: ClientDescriptor,
  args: readonly string[],
  bridgePath: string | undefined,
  platform: NodeJS.Platform,
  name: string = MCP_SERVER_NAME,
): string[] =>
  args.flatMap((part) => {
    if (part === "{name}" || part === LEGACY_MCP_SERVER_NAME) return [name];
    if (part === "{bridge}") {
      if (bridgePath === undefined) return [part];
      // A path cmd would read part of as its own is refused in every template of every client's, a listing and a
      // removal as well as an add: not left to the hooks an install writes first.
      const reference = hookBridgeReference(bridgePath, platform);
      return platform === "win32" && client.id === "claude-code" ? ["cmd", "/d", "/v:off", "/c", "call", reference] : [bridgePath];
    }
    const expanded = part.replaceAll("{client}", client.id);
    if (platform === "win32" && CMD_SPECIAL.test(expanded)) {
      throw new Error(`在 Windows 上，MCP 命令的参数里不能有 & | < > ^ % ! " 这些字符（cmd 会把它们当成自己的）：${expanded}`);
    }
    return [expanded];
  });

/**
 * The commands that show, then take out, the client's server of that name, once seen to run this app's bridge. Decision's
 * (`legacy`): one not seen to be this app's is left, and said, and the rest goes on; none there, nothing is taken out.
 */
const namedRemoveCommands = (
  client: ClientDescriptor,
  bridgePath: string | undefined,
  platform: NodeJS.Platform,
  name: string,
): CommandSpec[] => {
  const { mcp, command } = client;
  if (mcp === undefined || mcpByFile(mcp) || command === undefined) return [];
  const legacy = name === LEGACY_MCP_SERVER_NAME ? { legacy: true as const } : {};
  return [
    {
      command,
      args: expandTemplate(client, mcp.inspect.args, bridgePath, platform, name),
      tolerateFailure: true,
      expectsBridgeFor: client.id,
      absentMcpName: name,
      ...(mcp.inspect.output === "get" ? {} : { shows: mcp.inspect }),
      ...legacy,
    },
    { command, args: expandTemplate(client, mcp.remove, bridgePath, platform, name), tolerateFailure: true, absentMcpName: name, ...legacy },
  ];
};

/** The commands that take out the client's `paraself` server, and Decision's `decision`, each once seen to run this app's bridge. */
export const mcpRemoveCommands = (
  client: ClientDescriptor,
  bridgePath?: string,
  platform: NodeJS.Platform = process.platform,
): CommandSpec[] => [
  ...namedRemoveCommands(client, bridgePath, platform, MCP_SERVER_NAME),
  ...namedRemoveCommands(client, bridgePath, platform, LEGACY_MCP_SERVER_NAME),
];

/**
 * The server taken out and added again, then Decision's taken out: a client whose add failed keeps the one it had. On
 * Windows the bridge is a .cmd, which Claude Code cannot start without cmd (as npx, its docs say): `call` first, so cmd
 * leaves the quotes around a path with spaces where they are.
 */
export const mcpCommands = (
  client: ClientDescriptor,
  bridgePath: string,
  platform: NodeJS.Platform = process.platform,
): CommandSpec[] => client.mcp === undefined || mcpByFile(client.mcp) || client.command === undefined ? [] : [
  ...namedRemoveCommands(client, bridgePath, platform, MCP_SERVER_NAME),
  {
    command: client.command,
    args: expandTemplate(client, client.mcp.add, bridgePath, platform),
    tolerateFailure: false,
  },
  ...namedRemoveCommands(client, bridgePath, platform, LEGACY_MCP_SERVER_NAME),
];

interface CommandInvocationOptions {
  platform?: NodeJS.Platform;
  commandInterpreter?: string;
}

const quoteWindowsCommandArgument = (value: string): string => {
  if (/\0|\r|\n/u.test(value)) {
    throw new Error("命令的参数里不能有换行");
  }
  return `"${value.replaceAll("%", "%%").replaceAll('"', '""')}"`;
};

export const commandInvocation = (
  command: string,
  args: string[],
  options: CommandInvocationOptions = {},
): { command: string; args: string[]; windowsVerbatimArguments: boolean } => {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { command, args: [...args], windowsVerbatimArguments: false };
  }
  // The whole line in one more pair of quotes, passed verbatim: cmd /s takes that pair off, and Node would
  // otherwise escape the quotes cmd needs. The release smoke test runs the bridge on Windows this way.
  return {
    command:
      options.commandInterpreter ?? process.env.ComSpec ?? "cmd.exe",
    windowsVerbatimArguments: true,
    args: [
      "/d",
      "/s",
      "/v:off",
      "/c",
      `"${[command, ...args].map(quoteWindowsCommandArgument).join(" ")}"`,
    ],
  };
};

// A client's command that has not ended by then is stopped: one stuck on a lock or a network check held up every
// install and removal queued after it (one at a time, below) until the App was quit.
const COMMAND_TIMEOUT_MS = 60_000;

const defaultRunner = (platform: NodeJS.Platform): CommandRunner =>
  async (command, args) =>
    new Promise((resolve, reject) => {
      const invocation = commandInvocation(command, args, { platform });
      const child = spawn(invocation.command, invocation.args, {
        // From the reader's home, not from wherever the bridge was started: `claude mcp get` shows the server a
        // project in the working directory defines (its .mcp.json comes before the user scope), and another tool's
        // `paraself` there was taken for the one to replace; the add and remove name the user scope themselves.
        cwd: homedir(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`${command} 运行超过 ${COMMAND_TIMEOUT_MS / 1000} 秒没有结束，已停止；请稍后再试。`));
      }, COMMAND_TIMEOUT_MS);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });
    });

const readJson = async (
  path: string,
): Promise<{ raw: string; parsed: unknown }> => {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { raw: "", parsed: {} };
    }
    throw error;
  }
  try {
    return { raw, parsed: JSON.parse(raw) as unknown };
  } catch {
    throw new Error(`${path} 不是有效的 JSON（有注释，或手动编辑时多了、少了逗号、引号），Paraself 不改写这样的文件；修正后再试`);
  }
};

const formatJson = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;

const readTarget = async (path: string): Promise<{ raw: string; parsed: unknown }> => {
  const source = await readJson(path);
  // A file the reader may not write (made read-only to keep tools out of it, root's, denied by an ACL, or with
  // Windows's read-only attribute) is left as it is: the rename went over that, and the file was reported connected.
  // Asked of the system, not read off the owner's bit: that bit said writable of root's file and of one an ACL denies.
  if (source.raw !== "" && !(await access(path, constants.W_OK).then(() => true, () => false))) {
    throw new Error(`${path} 设成了只读，没有改动它；先恢复它的写权限再试`);
  }
  return source;
};

const prepareTarget = async (
  client: ClientDescriptor,
  path: string,
  bridgePath: string,
  platform: NodeJS.Platform,
  home?: string,
): Promise<ParsedTarget> => {
  const shadow = client.hooks.shadowedBy === undefined ? null : customHookPath(client.hooks.shadowedBy, home);
  if (shadow !== null && (await access(shadow).then(() => true, () => false))) {
    throw new Error(`有 ${shadow} 时 ${client.name} 不读 ${path} 里的钩子，没有接入；把那份文件里的钩子挪到 ${path} 的 hooks 里并删掉它，再试`);
  }
  const source = await readTarget(path);
  const merged =
    client.hooks.format === "antigravity"
      ? mergeAntigravityHooks(source.parsed, bridgePath, client, platform)
      : client.hooks.format === "flat"
        ? mergeFlatHooks(source.parsed, bridgePath, client, platform)
        : mergeHookDocument(source.parsed, bridgePath, client, platform);
  return {
    client: client.id,
    path,
    before: source.raw,
    after: formatJson(merged),
  };
};

const isEmptyHookFile = (document: Record<string, unknown>): boolean =>
  Object.keys(document).every((key) => key === "hooks" || key === "version") &&
  Object.keys((document.hooks ?? {}) as object).length === 0;

const prepareRemoval = async (client: ClientDescriptor, path: string): Promise<ParsedTarget> => {
  const source = await readTarget(path);
  const removed =
    client.hooks.format === "antigravity"
      ? removeAntigravityHooks(source.parsed, client)
      : client.hooks.format === "flat"
        ? removeFlatHooks(source.parsed)
        : removeHookDocument(source.parsed);
  const unchanged = JSON.stringify(removed) === JSON.stringify(source.parsed);
  // A file with none of this app's hooks in it is left as it is, its layout too; one that was this app's alone goes.
  return {
    client: client.id,
    path,
    before: source.raw,
    after: unchanged ? source.raw : client.hooks.ownsFile === true && isEmptyHookFile(removed) ? null : formatJson(removed),
  };
};

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

/** Why a file could not be read or written, in the reader's words: Node's "EACCES: permission denied, open '…'". */
const inReaderWords = (error: unknown): string => {
  switch ((error as NodeJS.ErrnoException | null)?.code) {
    case "EACCES":
      return "没有读写它或它所在文件夹的权限，改好权限后再试";
    case "EPERM":
      return "没有读写它的权限，或它正被别的程序占用；稍后或改好权限后再试";
    case "EBUSY":
      return "它正被别的程序占用，稍后再试";
    case "EROFS":
      return "它所在的磁盘是只读的";
    case "ENOSPC":
    case "EDQUOT":
      return "磁盘空间不足，清理空间后再试";
    default:
      return error instanceof Error ? error.message : String(error);
  }
};

/** The file written, or taken away where it is to go (`null`). */
const writeOrRemove = async (path: string, content: string | null, before: string, platform: NodeJS.Platform): Promise<void> =>
  content === null ? unlink(path).catch((error: unknown) => (isMissing(error) ? undefined : Promise.reject(error))) : writeAtomically(path, content, before, platform);

const writeAtomically = async (
  path: string,
  content: string,
  /** What the file held when `content` was made from it ("" for none). */
  before: string,
  platform: NodeJS.Platform,
): Promise<void> => {
  // Through a link to where it points, with the mode the file had: a settings file a dotfiles manager
  // links in keeps its link, and the managed copy is the one that gets the hooks.
  const target = await realpath(path).catch((error: unknown) => (isMissing(error) ? path : Promise.reject(error)));
  const mode = await stat(target).then((status) => status.mode & 0o777, () => 0o600);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode });
    // On Windows the file may be open for a moment (an antivirus scan, a sync client, the client reading it),
    // and the rename then fails with EPERM or EBUSY where waiting a little succeeds, as storage's
    // renameReplacing does: about a second and a half in all.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, target);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (platform !== "win32" || (code !== "EPERM" && code !== "EBUSY") || attempt === 5) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
        // What the client saved to it meanwhile would otherwise go under what it held before. Still held against
        // reading too: looked at again after the next wait, rather than given up on at once.
        const now = await readFile(target, "utf8").catch((reason: unknown) => {
          const held = (reason as NodeJS.ErrnoException).code;
          return isMissing(reason) ? "" : held === "EPERM" || held === "EBUSY" ? null : Promise.reject(reason);
        });
        if (now !== null && now !== before) throw new Error("它刚被别的程序改动过，这次没有写入，请再试一次");
      }
    }
    JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const confirmsMcpAbsent = (detail: string, name: string): boolean => {
  const target = escapeRegExp(name);
  // The whole name, quoted or not: `'paraself.extra'` and `paraself-extra` are another server's, and its absence is
  // not this one's. A sentence's full stop after it is not part of a name; a dot with more of a name after it is.
  const named = `(?:"${target}"|'${target}'|${target}(?![\\p{Letter}\\p{Number}_"'-]|\\.[\\p{Letter}\\p{Number}_-]))`;
  return new RegExp(
    `(?:no\\s+mcp\\s+server\\s+(?:found\\s+with\\s+name:\\s*|named\\s+)${named}|` +
      `mcp\\s+server\\s+${named}\\s+(?:not found|does not exist|not configured)|` +
      `未找到(?:名为|名称为)?\\s*${named}\\s*(?:的)?\\s*mcp\\s*服务器|` +
      `mcp\\s*服务器\\s*${named}\\s*不存在)`,
    "iu",
  ).test(detail);
};

const clientName = (id: string): string => BUILT_IN_CLIENTS.find((client) => client.id === id)?.name ?? id;

// A client whose command is not there at all: spawn says ENOENT; cmd.exe, that it is not recognized.
const commandMissing = (error: unknown): boolean =>
  isMissing(error) ||
  (error instanceof Error && /is not recognized as an internal or external command|command not found/iu.test(error.message));

// The code of the error a look at a server that is not this app's ends in.
const NOT_THIS_APPS = MCP_NOT_THIS_APPS;
// The code of the error a look at the client's servers that could not be read ends in.
const UNREAD = "PARASELF_MCP_UNREAD";

/**
 * What a listing of every server shows under this app's name: each such server's command line, none for none, and null
 * for a listing not read or a server by that name whose command cannot be told.
 */
const listedServers = (output: string, shows: NonNullable<CommandSpec["shows"]>, name: string): string[] | null => {
  if (shows.output === "json") {
    let servers: unknown;
    try {
      servers = JSON.parse(output);
    } catch {
      return null;
    }
    if (!Array.isArray(servers)) return null;
    const lines: string[] = [];
    for (const server of servers) {
      const entry = typeof server === "object" && server !== null && !Array.isArray(server) ? (server as Record<string, unknown>) : null;
      if (entry === null || typeof entry.name !== "string") return null;
      if (entry.name !== name) continue;
      const args = entry.args ?? [];
      const target = entry.command ?? entry.url;
      // Listed, but with nothing to tell whose it is: not "none".
      if (typeof target !== "string" || target.trim() === "" || !Array.isArray(args) || !args.every((arg) => typeof arg === "string")) return null;
      lines.push([target, ...args].join(" "));
    }
    return lines;
  }
  if (shows.output !== "table") return output === "" ? [] : [output];
  const lines = output.split(/\r?\n/u).map((line) => line.trimEnd()).filter((line) => line.length > 0);
  if (lines.length === 1 && lines[0] === shows.none) return [];
  if (lines[0]?.split(/\s+/u).join(" ") !== shows.header.join(" ")) return null;
  const found: string[] = [];
  for (const line of lines.slice(1)) {
    // A row: its name, then one word a column up to the last, which runs to the line's end.
    const cells = new RegExp(`^(\\S+)${"\\s+\\S+".repeat(shows.header.length - 2)}\\s+(\\S.*)$`, "u").exec(line);
    if (cells === null || !/^[\w.-]+$/u.test(cells[1]!)) return null;
    if (cells[1] === name) found.push(cells[2]!);
  }
  return found;
};

/** Why a look at the client's servers said nothing that could be gone on: none of its servers is changed. */
const unreadListing = (client: string, why: string, name: string): Error =>
  new Error(`${clientName(client)} 的 MCP 服务器列表${why}，看不出名为 ${name} 的是不是本应用的，没有改动它；稍后再试，或在终端里运行它的 mcp list 看看`);

/**
 * A client's server written into, or taken out of, its own MCP configuration file, where it is now (one of the
 * reader's is locked first, as its hook file is). True where the file was changed.
 */
const applyMcpFile = async (
  client: ClientDescriptor,
  options: RemoveOptions,
  platform: NodeJS.Platform,
  action: "install" | "remove",
  /** False: what it would do, read alone (a check): nothing locked or written, no folder made. */
  write = true,
): Promise<{ acted: boolean; left: string[] }> => {
  const mcp = client.mcp;
  if (!mcpByFile(mcp)) return { acted: false, left: [] };
  const path = customHookPath(mcp.file, options.home);
  if (action === "install" && !(await access(path).then(() => true, () => false))) {
    // Made, it would come before an older file the client reads only while it is absent, and hide that file's servers.
    for (const older of (mcp.olderFiles ?? []).map((file) => customHookPath(file, options.home))) {
      if (await access(older).then(() => true, () => false)) {
        throw new Error(`${client.name} 的 MCP 服务器现在写在 ${older}；新建 ${path} 会让它不再读那份文件，没有改动。把那份文件改名为 ${path} 后再试`);
      }
    }
  }
  const lock = await options.checkTarget?.(client.id, path, write ? "write" : "check");
  const source = await readTarget(lock?.path ?? path);
  if (lock) await assertHookTargetLock(lock);
  let after: Record<string, unknown>;
  let left: string[];
  if (action === "install") {
    ({ document: after, left } = mergeMcpFile(source.parsed, options.bridgePath!, { ...client, mcp }, platform));
  } else {
    const removed = removeMcpFile(source.parsed, client, options.bridgePath);
    if (!removed.changed) return { acted: false, left: removed.left };
    ({ document: after, left } = removed);
  }
  const content = formatJson(after);
  if (content === source.raw) return { acted: false, left };
  if (!write) return { acted: true, left };
  await (lock ? writeLockedHookFile(lock, content) : writeOrRemove(path, content, source.raw, platform));
  return { acted: true, left };
};

/** Servers by this app's names left where they were, not this app's: said in the client's result. */
const leftAlone = (names: readonly string[]): string[] =>
  names.length === 0 ? [] : [`名为 ${names.join("、")} 的 MCP 服务器不是本应用的，没有动它`];

/**
 * The servers the client shows by the name a look asked for, each its command line, every one seen to run this app's
 * bridge: one that does not (another tool's, or the reader's own), or a listing that cannot be read, is an error.
 */
const shownServers = (specification: CommandSpec, result: CommandResult, bridgePath: string | undefined): string[] => {
  const client = specification.expectsBridgeFor!;
  const name = specification.absentMcpName ?? MCP_SERVER_NAME;
  const listing = specification.shows;
  let shown: string[];
  if (listing === undefined || listing.output === "get") {
    // Not there: said so in the client's words (claude 2.1.311, codex 0.164.0). Failed for any other reason, it
    // says nothing of a server of the reader's own by that name.
    if (result.exitCode !== 0 && !confirmsMcpAbsent(`${result.stderr ?? ""}\n${result.stdout ?? ""}`, name)) {
      const detail = (result.stderr?.trim() || result.stdout?.trim()) ?? "";
      throw Object.assign(
        new Error(`运行 ${specification.command} ${specification.args[0] ?? ""} ${specification.args[1] ?? ""}`.trimEnd() + ` 没有成功${detail.length === 0 ? "" : `（${detail}）`}`),
        { code: UNREAD },
      );
    }
    const output = result.exitCode === 0 ? (result.stdout?.trim() ?? "") : "";
    shown = output === "" ? [] : [output];
  } else {
    const listed = result.exitCode === 0 ? listedServers(result.stdout?.trim() ?? "", listing, name) : null;
    if (listed === null) {
      throw Object.assign(
        unreadListing(client, result.exitCode === 0 ? "格式认不出来" : `没有读出来（${(result.stderr ?? "").trim() || `退出码 ${result.exitCode}`}）`, name),
        { code: UNREAD },
      );
    }
    // More than one by that name (a project's beside the user's): which one an `mcp remove <name>` takes, and so
    // whether it is this app's, cannot be told. ponytail: refused whole; each scope's server named once the CLIs
    // take a scope on removal.
    if (listed.length > 1) {
      throw Object.assign(unreadListing(client, `里有 ${listed.length} 个名为 ${name} 的服务器`, name), { code: UNREAD });
    }
    shown = listed;
  }
  // Each server by that name on its own, should a client show more than one.
  if (!shown.every((server) => runsThisBridge(server, client, bridgePath))) {
    throw Object.assign(
      new Error(
        `${clientName(client)} 里已有一个名为 ${name} 的 MCP 服务器，` +
          "运行的不是本应用的桥接程序，没有改动它；" +
          "如果不再需要它，先自行删除或改名再试",
      ),
      { code: NOT_THIS_APPS },
    );
  }
  return shown;
};

/**
 * The commands run in order. `acted`: whether a command of this app's took effect, a server removed or added, not a look
 * at one, nor the removal of one that was not there. `notes`: Decision's server left as it was, not seen to be this app's.
 */
const runMcpCommands = async (
  commands: CommandSpec[],
  runner: CommandRunner,
  bridgePath: string | undefined,
): Promise<{ acted: boolean; notes: string[] }> => {
  let acted = false;
  const notes: string[] = [];
  // Decision's server, none there or not seen to be this app's: its removal is not run.
  let legacyLeft = false;
  for (const specification of commands) {
    if (specification.legacy === true && legacyLeft) continue;
    const result = await runner(specification.command, specification.args);
    // cmd's own code for a command it cannot find, in any language. Its message, in the console's code page
    // and read as UTF-8, came out as noise, and a client never installed was reported as failed.
    if (result.exitCode === 9009) {
      throw Object.assign(new Error(`没有找到 ${specification.command} 命令`), { code: "ENOENT" });
    }
    if (specification.expectsBridgeFor !== undefined) {
      // A server of that name the client shows, that does not run this app's bridge (another tool's, or the
      // reader's own), was removed and replaced without a word. Not there, or nothing shown: as before.
      try {
        const shown = shownServers(specification, result, bridgePath);
        if (specification.legacy === true && shown.length === 0) legacyLeft = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (specification.legacy !== true || (code !== NOT_THIS_APPS && code !== UNREAD)) throw error;
        notes.push(...(code === NOT_THIS_APPS ? leftAlone([LEGACY_MCP_SERVER_NAME]) : [(error as Error).message]));
        legacyLeft = true;
      }
      continue;
    }
    if (result.exitCode === 0) {
      acted = true;
      continue;
    }
    const detail = result.stderr?.trim() ?? "";
    const confirmedAbsent =
      specification.tolerateFailure &&
      specification.absentMcpName !== undefined &&
      confirmsMcpAbsent(detail, specification.absentMcpName);
    if (confirmedAbsent) {
      continue;
    }
    // Which step, and the client's own reason: the whole command line (the app's path in it) said neither plainly.
    throw new Error(
      `运行 ${specification.command} ${specification.args[0] ?? ""} ${specification.args[1] ?? ""}`.trimEnd() +
        ` 没有成功${detail.length === 0 ? "" : `（${detail}）`}`,
    );
  }
  return { acted, notes };
};

/**
 * Decision's own hooks file beside the client's (legacyHookFile) without this app's hooks: taken away where it holds
 * nothing else, the reader's own left in it. What could not be done, said; nothing to say, none.
 */
const removeLegacyHookFile = async (
  client: ClientDescriptor,
  path: string,
  platform: NodeJS.Platform,
): Promise<{ changed: boolean; notes: string[] }> => {
  const legacy = legacyHookFile(client, path);
  if (legacy === null) return { changed: false, notes: [] };
  try {
    // As a disconnect takes this app's hooks out of a file: the file goes where nothing else is in it.
    const target = await prepareRemoval(client, legacy);
    if (target.after === target.before) return { changed: false, notes: [] };
    await writeOrRemove(legacy, target.after, target.before, platform);
    return { changed: true, notes: [] };
  } catch (error) {
    return { changed: false, notes: [`旧的 ${legacy} 没能清理（${inReaderWords(error)}），里面本应用的旧钩子还会运行；请自行删除它`] };
  }
};

// One run over the clients' files and commands at a time: the App's page left and come back to while one ran sent
// another, and the two read, rewrote and ran `mcp add`/`remove` over each other. The next waits for the one before.
// ponytail: per process; a bridge CLI run at the same moment is another process and is not held back.
let turn: Promise<unknown> = Promise.resolve();
const inTurn = <T>(run: () => Promise<T>): Promise<T> => {
  const result = turn.then(run, run);
  turn = result.catch(() => undefined);
  return result;
};

export const installIntegrations = (options: InstallOptions): Promise<InstallReport> => inTurn(() => install(options));

/** One client's skills synced, or what kept them from it: never the end of that client's connection. */
const clientSkills = async (options: InstallOptions, client: IntegrationClient, mode: InstallMode): Promise<SkillInstallReport[]> => {
  if (options.skillsSource === undefined || !isSkillClient(client)) return [];
  try {
    return await syncBundledSkills({ source: options.skillsSource, clients: [client], mode, environment: options.environment, home: options.home });
  } catch (error) {
    return [{ client, skill: "*", path: options.skillsSource, status: "failed", detail: `读不出 Paraself 自带的技能（${inReaderWords(error)}）` }];
  }
};

const withSkills = (detail: string | undefined, skills: readonly SkillInstallReport[], dryRun: boolean): string | undefined =>
  [detail ?? [], skillSummary(skills, dryRun) ?? []].flat().join("；") || undefined;

const skillsChange = (skills: readonly SkillInstallReport[]): boolean =>
  skills.some((skill) => skill.status === "installed" || skill.status === "updated" || skill.status === "migrated");

/** An install run inside inIntegrationsTurn: its clients and paths read once the turn is its own, not when it was asked for. */
export const installIntegrationsWithinTurn = (options: InstallOptions): Promise<InstallReport> => install(options);

const install = async (
  options: InstallOptions,
): Promise<InstallReport> => {
  const platform = options.platform ?? process.platform;
  // Each client's own file is read on its own: one that cannot be read (not valid JSON, no permission)
  // is that client's failure, its commands are not run and its file is left as it is; the other client
  // still connects.
  const clients = targetsOf(options);
  const descriptors = new Map(clients.map(({ descriptor }) => [descriptor.id, descriptor]));
  const targets = await Promise.all(
    clients.map(({ descriptor, path }) =>
      prepareTarget(descriptor, path, options.bridgePath, platform, options.home).catch((error: unknown) => ({
        client: descriptor.id,
        path,
        unreadable: inReaderWords(error),
      })),
    ),
  );
  const unreadableReport = (target: { client: IntegrationClient; path: string; unreadable: string }): InstallTargetReport => ({
    client: target.client,
    path: target.path,
    changed: false,
    status: "failed",
    detail: target.unreadable,
  });
  if (targets.length > 0 && targets.every((target) => "unreadable" in target)) {
    throw new Error(targets.map((target) => ("unreadable" in target ? target.unreadable : "")).join("；"));
  }
  const commandsFor = (client: IntegrationClient): CommandSpec[] =>
    mcpCommands(descriptors.get(client)!, options.bridgePath, platform);
  // Said in the report as they would run; one a template of which cannot run here is that client's failure, below.
  const commands = clients.flatMap(({ descriptor }) => {
    try {
      return commandsFor(descriptor.id);
    } catch {
      return [];
    }
  });

  if (options.mode === "dry-run") {
    const skills: SkillInstallReport[] = [];
    // Skills looked at one client after another: their reports keep the registry's order.
    const reports: InstallTargetReport[] = [];
    for (const target of targets) {
      if ("unreadable" in target) {
        reports.push(unreadableReport(target));
        continue;
      }
      const hooksChanged = target.before !== target.after;
      const own = await clientSkills(options, target.client, "dry-run");
      skills.push(...own);
      const detail = withSkills(undefined, own, true);
      // The MCP file looked at as an install would, read alone: one it would refuse (another `paraself`, comments, an
      // older file it would hide) is said, and one it would change counts as a change.
      try {
        const mcp = await applyMcpFile(descriptors.get(target.client)!, options, platform, "install", false);
        reports.push({ client: target.client, path: target.path, changed: hooksChanged || mcp.acted || skillsChange(own), ...(detail === undefined ? {} : { detail }) });
      } catch (error) {
        reports.push({ client: target.client, path: target.path, changed: hooksChanged, status: "failed", detail: inReaderWords(error) });
      }
    }
    return {
      mode: options.mode,
      targets: reports,
      commands,
      restartRequired: true,
      ...(options.skillsSource === undefined ? {} : { skills }),
    };
  }

  // Each client stands alone: one whose command is not installed is skipped, and one that fails does not
  // keep the other from connecting. Within a client the callable MCP capability goes first, and hook
  // marker v1 is written only once that client accepted it, so status detection stays conservative.
  const runner = options.runner ?? defaultRunner(platform);
  const reports: InstallTargetReport[] = [];
  const skills: SkillInstallReport[] = [];
  for (const target of targets) {
    if ("unreadable" in target) {
      reports.push(unreadableReport(target));
      continue;
    }
    // What the reader is to know of Decision's server and hooks file, left as they were.
    const notes: string[] = [];
    try {
      await options.checkTarget?.(target.client, target.path, "check");
      notes.push(...(await runMcpCommands(commandsFor(target.client), runner, options.bridgePath)).notes);
      notes.push(...leftAlone((await applyMcpFile(descriptors.get(target.client)!, options, platform, "install")).left));
    } catch (error) {
      reports.push({
        client: target.client,
        path: target.path,
        changed: false,
        ...(commandMissing(error)
          ? { status: "skipped" as const, detail: `没有找到 ${descriptors.get(target.client)!.command ?? ""} 命令` }
          : { status: "failed" as const, detail: error instanceof Error ? error.message : String(error) }),
      });
      continue;
    }
    // Read again just before writing: the commands take seconds, and what the client or the reader wrote to
    // the file meanwhile (a /model change in a running Claude Code, say) went under what it held before them.
    let changed: boolean;
    let fresh: Awaited<ReturnType<typeof prepareTarget>>;
    let lock: HookTargetLock | void;
    try {
      // Locked first, then read where it was locked: what is written is made from the very file it goes over.
      lock = await options.checkTarget?.(target.client, target.path, "write");
      fresh = await prepareTarget(descriptors.get(target.client)!, lock?.path ?? target.path, options.bridgePath, platform, options.home);
      // What was read is the locked file's: anything moved meanwhile, and it is not the one to change.
      if (lock) await assertHookTargetLock(lock);
    } catch (error) {
      // Changed into something unreadable while the commands ran: not a file it could not write.
      reports.push({
        client: target.client,
        path: target.path,
        changed: false,
        status: "failed",
        detail: inReaderWords(error),
      });
      continue;
    }
    try {
      changed = fresh.before !== fresh.after;
      if (changed) {
        await (lock ? writeLockedHookFile(lock, fresh.after) : writeOrRemove(target.path, fresh.after, fresh.before, platform));
      }
    } catch (error) {
      // Its own file it could not write is this client's failure, not the end of the other's result.
      reports.push({
        client: target.client,
        path: target.path,
        changed: false,
        status: "failed",
        detail: `无法写入 ${target.path}：${inReaderWords(error)}`,
      });
      continue;
    }
    notes.push(...(await removeLegacyHookFile(descriptors.get(target.client)!, target.path, platform)).notes);
    // Only once connected: a client this install could not connect is given no skills either.
    const own = await clientSkills(options, target.client, "apply");
    skills.push(...own);
    const detail = withSkills([descriptors.get(target.client)!.installNote ?? [], ...notes].flat().join("；") || undefined, own, false);
    reports.push({
      client: target.client,
      path: target.path,
      changed: changed || skillsChange(own),
      status: "installed",
      ...(detail === undefined ? {} : { detail }),
    });
  }
  if (!reports.some((report) => report.status === "installed")) {
    throw new Error(
      reports.every((report) => report.status === "skipped")
        ? `没有找到 ${clients.flatMap(({ descriptor }) => descriptor.command ?? []).join(" 或 ")} 命令：请先安装 ${clients.map(({ descriptor }) => descriptor.name).join(" 或 ")}，并确认在终端里能运行它们。`
        : reports.map((report) => report.detail ?? "").join("；"),
    );
  }
  return {
    mode: options.mode,
    targets: reports,
    commands,
    restartRequired: true,
    ...(options.skillsSource === undefined ? {} : { skills }),
  };
};

const failedReport = (client: IntegrationClient, path: string, detail: string): InstallTargetReport => ({
  client,
  path,
  changed: false,
  status: "failed",
  detail,
});

/**
 * Takes this app out of every client: its hooks out of each file (the reader's own stay) and its MCP server out
 * of each client, where the server of that name runs this app's bridge. Skills published to a client are files
 * of the client's own, and stay.
 */
export const removeIntegrations = (options: RemoveOptions): Promise<InstallReport> => inTurn(() => remove(options));

/**
 * The one queue installs and removals run in, for a change of the App's own to the clients' files to wait its turn too
 * (a client the reader saves or deletes). Inside it, `removeIntegrationsWithinTurn` takes one out without queueing again.
 */
export const inIntegrationsTurn = <T>(run: () => Promise<T>): Promise<T> => inTurn(run);

export const removeIntegrationsWithinTurn = (options: RemoveOptions): Promise<InstallReport> => remove(options);

const remove = async (options: RemoveOptions): Promise<InstallReport> => {
  const platform = options.platform ?? process.platform;
  const clients = targetsOf(options);
  const runner = options.runner ?? defaultRunner(platform);
  const reports: InstallTargetReport[] = [];
  for (const { descriptor, path } of clients) {
    const client = descriptor.id;
    // A file it cannot read or write is that client's failure, and nothing of that client's is changed.
    let target: ParsedTarget;
    try {
      target = await prepareRemoval(descriptor, path);
    } catch (error) {
      reports.push(failedReport(client, path, inReaderWords(error)));
      continue;
    }
    if (options.mode === "dry-run") {
      reports.push({ client, path, changed: target.before !== target.after });
      continue;
    }
    // The server first, as an install connects it first: hooks still there say the client is still connected.
    let detail: string | undefined;
    let missing = false;
    let acted = false;
    try {
      await options.checkTarget?.(client, path, "check");
    } catch (error) {
      reports.push(failedReport(client, path, error instanceof Error ? error.message : String(error)));
      continue;
    }
    try {
      const commands = await runMcpCommands(mcpRemoveCommands(descriptor, options.bridgePath, platform), runner, options.bridgePath);
      const file = await applyMcpFile(descriptor, options, platform, "remove");
      acted = commands.acted || file.acted;
      const notes = [...commands.notes, ...leftAlone(file.left)];
      if (notes.length > 0) detail = notes.join("；");
    } catch (error) {
      missing = commandMissing(error);
      if (missing) {
        detail = `没有找到 ${descriptor.command ?? ""} 命令，没有删除它登记的 MCP 服务器`;
      } else if ((error as NodeJS.ErrnoException).code === NOT_THIS_APPS) {
        detail = `名为 ${MCP_SERVER_NAME} 的 MCP 服务器不是本应用的，没有动它`;
      } else {
        reports.push(failedReport(client, path, error instanceof Error ? error.message : String(error)));
        continue;
      }
    }
    // Read again just before writing, as an install does: what was saved to it while the commands ran stays.
    let fresh: ParsedTarget;
    let lock: HookTargetLock | void;
    try {
      lock = await options.checkTarget?.(client, path, "write");
      fresh = await prepareRemoval(descriptor, lock?.path ?? path);
      if (lock) await assertHookTargetLock(lock);
    } catch (error) {
      reports.push(failedReport(client, path, error instanceof Error && !("code" in error) ? error.message : inReaderWords(error)));
      continue;
    }
    let changed = fresh.before !== fresh.after;
    try {
      if (changed) {
        await (lock ? writeLockedHookFile(lock, fresh.after) : writeOrRemove(path, fresh.after, fresh.before, platform));
      }
    } catch (error) {
      reports.push(failedReport(client, path, `无法写入 ${path}：${inReaderWords(error)}`));
      continue;
    }
    const legacy = await removeLegacyHookFile(descriptor, path, platform);
    changed ||= legacy.changed;
    if (legacy.notes.length > 0) detail = [detail ?? [], ...legacy.notes].flat().join("；");
    reports.push(
      // A client not there at all, with nothing of this app's in its file: skipped, as an install says, not removed.
      missing && !changed
        ? { client, path, changed, status: "skipped", detail: `没有找到 ${descriptor.command ?? ""} 命令` }
        // Nothing of this app's in the client (never connected, or taken out before): nothing was taken out now,
        // and it was said to be disconnected, with a restart to ask for.
        : !changed && !acted
          ? { client, path, changed, status: "skipped", detail: ["没有本应用的接入，无需断开", ...(detail === undefined ? [] : [detail])].join("；") }
          : { client, path, changed, status: "removed", ...(detail === undefined ? {} : { detail }) },
    );
  }
  return {
    mode: options.mode,
    targets: reports,
    commands: clients.flatMap(({ descriptor }) => {
      try {
        return mcpRemoveCommands(descriptor, options.bridgePath, platform);
      } catch {
        return [];
      }
    }),
    restartRequired: true,
    note: "已发布到客户端的技能和工作流没有删除，客户端仍会加载它们；不需要的可以在 Paraself 里逐个回滚发布。Paraself 自带的 paraself-memory、paraself-review 技能也保留在客户端的技能文件夹里，不需要的可以自行删除。",
  };
};
