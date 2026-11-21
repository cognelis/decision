import {
  CLIENT_CATALOG,
  CUSTOM_CLIENTS_VERSION,
  customClientsFileSchema,
  upgradeCustomClientsFile,
  type CustomClient,
} from "@cognelis/decision-protocol";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, sep } from "node:path";

import { BUILT_IN_CLIENTS, type ClientDescriptor } from "./clients.js";

/** A custom client's hook file where it is now: `~/…` under the reader's home folder. */
export const customHookPath = (file: string, home: string = homedir()): string => join(home, ...file.slice(2).split("/"));

// Droid's lines wrap a message as Claude Code's do (`{ type: "message", message: { role, content } }`): read so, its
// turns told apart by its own rule (transcript-tail's USER_TURN).
const TRANSCRIPT_FORMAT = {
  claude: "claude-codex",
  codex: "claude-codex",
  droid: "droid",
  antigravity: "antigravity",
  copilot: "copilot",
  codebuddy: "codebuddy",
} as const;

/** A client the reader added, or one of the catalog's, as the registry describes the built-in ones: data the installer and the bridge read alike. */
export const customClientDescriptor = (client: CustomClient): ClientDescriptor => {
  const directory = posix.dirname(client.hooks.file.slice(2));
  const { mcp } = client;
  // The prompt and the reply in one event: one handler there, reading both in order (ClientDescriptor.capture.promptInStop).
  const together = client.prompt.event === client.reply.event;
  return {
    id: client.id,
    name: client.name,
    shortName: client.shortName,
    ...(client.command === undefined ? {} : { command: client.command }),
    configDir: { home: directory === "." ? "" : directory },
    hooks: {
      file: posix.basename(client.hooks.file),
      format: client.hooks.format === "antigravity" ? "antigravity" : client.hooks.format.startsWith("flat") ? "flat" : "claude",
      ...(client.hooks.format.endsWith("-owned") ? { ownsFile: true } : {}),
      events: together
        ? [{ event: client.reply.event, operation: "stop" }]
        : [
            { event: client.prompt.event, operation: "user-prompt-submit" },
            { event: client.reply.event, operation: "stop" },
          ],
      ...(client.hooks.group === undefined ? {} : { group: client.hooks.group }),
      ...(client.hooks.shadowedBy === undefined ? {} : { shadowedBy: client.hooks.shadowedBy }),
      ...(client.hooks.invocation === undefined ? {} : { invocation: client.hooks.invocation }),
      ...(client.hooks.timeout === undefined ? {} : { timeout: client.hooks.timeout }),
    },
    capture: {
      fields: {
        sessionId: client.fields.sessionId,
        cwd: client.fields.cwd,
        prompt: client.prompt.field,
        ...(client.reply.source === "field" ? { reply: client.reply.field } : { transcript: client.reply.field }),
        ...(client.fields.turnId === undefined ? {} : { turnId: client.fields.turnId }),
      },
      ...(client.reply.source === "transcript" ? { transcript: TRANSCRIPT_FORMAT[client.reply.format] } : {}),
      ...(client.complete === undefined ? {} : { stopReason: { field: client.complete.field, complete: client.complete.values } }),
      ...(together ? { promptInStop: true as const } : {}),
      // A reply read off a transcript, unread at a turn's end, leaves the one waiting from the turn before no question
      // for a later answer: dropped, as Antigravity's is.
      ...(client.reply.source === "transcript" ? { dropPendingWithoutReply: true } : {}),
    },
    ...(mcp.mode === "none"
      ? {}
      : mcp.mode === "file"
        ? { mcp: { file: mcp.file, ...(mcp.entry === undefined ? {} : { entry: mcp.entry }), ...(mcp.olderFiles === undefined ? {} : { olderFiles: mcp.olderFiles }) } }
        : {
            mcp: {
              inspect:
                mcp.list.output === "json"
                  ? { args: mcp.list.args, output: "json" as const }
                  // No line of its own for none: an empty listing is then one not read, and nothing is changed.
                  : { args: mcp.list.args, output: "table" as const, header: mcp.list.header, none: mcp.list.none ?? "\u0000" },
              remove: mcp.remove,
              add: mcp.add,
            },
          }),
  };
};

/**
 * The reader's clients, as the file holds them: none where there is no file, `unreadable` where it is not one.
 * `mcpDropped`: clients an earlier build saved registering MCP by a command that could not list its servers, read as
 * registering none (see upgradeCustomClientsFile).
 */
export const readCustomClients = async (
  path: string,
): Promise<{ clients: CustomClient[]; unreadable: boolean; mcpDropped: string[] }> => {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    return { clients: [], unreadable: (error as NodeJS.ErrnoException).code !== "ENOENT", mcpDropped: [] };
  }
  try {
    const { file, mcpDropped } = upgradeCustomClientsFile(JSON.parse(raw));
    const parsed = customClientsFileSchema.safeParse(file);
    return parsed.success
      ? { clients: parsed.data.clients, unreadable: false, mcpDropped }
      : { clients: [], unreadable: true, mcpDropped: [] };
  } catch {
    return { clients: [], unreadable: true, mcpDropped: [] };
  }
};

/** A file that could not be read, moved aside for whoever looks into it: the App starts with no clients of the reader's. */
export const setAsideCustomClients = async (path: string, now: Date = new Date()): Promise<string | null> => {
  const aside = `${path}.unreadable-${now.toISOString().replaceAll(":", "-")}`;
  return rename(path, aside).then(() => aside, () => null);
};

export const writeCustomClients = async (path: string, clients: readonly CustomClient[]): Promise<void> => {
  const content = `${JSON.stringify(customClientsFileSchema.parse({ version: CUSTOM_CLIENTS_VERSION, clients }), null, 2)}\n`;
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};

/**
 * Where a path really is: its nearest folder that exists, links followed, and the rest of it as written. A link
 * anywhere along it (out of the home folder, into Paraself's data, to another client's file) is followed.
 */
export const realHookPath = async (path: string): Promise<string> => {
  const rest: string[] = [];
  let at = path;
  for (;;) {
    try {
      return join(await realpath(at), ...rest.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = dirname(at);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === at) throw error;
      rest.push(basename(at));
      at = parent;
    }
  }
};

/**
 * A path as a file system that tells neither case nor Unicode forms apart (macOS's, Windows's) reads it.
 * ponytail: compared so on every system, a case-sensitive one too: two files there differing in case alone are taken for
 * one, and the second refused; per-volume probing if that ever matters.
 */
const sameName = (path: string): string => path.normalize("NFC").toLowerCase();

const inside = (child: string, parent: string): boolean => {
  const path = relative(sameName(parent), sameName(child));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

/** The file a path names, where it exists: two names for one file (a hard link) are one. */
const fileIdentity = (path: string): Promise<string | null> =>
  stat(path).then((status) => `${status.dev}:${status.ino}`, () => null);

const LINKED = "钩子配置文件的路径里有符号链接；Paraself 只写它自己的真实路径，不跟着链接写";

/** The folders and the file below the home folder a custom client's hook file is at, as written (`~/a/b.json` → a, b.json). */
const belowHome = (path: string, home: string): string[] => relative(home, path).split(sep).filter(Boolean);

/**
 * Whether anything along a path below the home folder (a folder or the file) is a link: none may be, so the file it names
 * is the one written, whatever is linked later. What does not exist yet is none.
 */
const linkAlong = async (path: string, home: string): Promise<boolean> => {
  let at = await realHookPath(home);
  for (const segment of belowHome(path, home)) {
    at = join(at, segment);
    const status = await lstat(at).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : Promise.reject(error)));
    if (status === null) return false;
    if (status.isSymbolicLink()) return true;
  }
  return false;
};

/** A custom client's hook file as checked just before it is written: the real file, and the folder it is in, by identity. */
export interface HookTargetLock {
  /** Where it is, no link along it: the writer writes here and resolves nothing again. */
  path: string;
  directory: string;
  directoryId: string;
  /** None where there was no file. */
  fileId: string | null;
  mode: number;
}

const identityOf = (status: { dev: number; ino: number }): string => `${status.dev}:${status.ino}`;

const changedBeforeWriting = (why: string): Error => new Error(`钩子配置文件在写入前被改动了（${why}），没有写入；稍后再试`);

/**
 * Makes the folders a custom client's hook file goes in, none of them a link, and notes the folder and the file by
 * identity: the file is then written there, and only while each is still the one noted (assertHookTargetLock).
 */
export const lockHookTarget = async (path: string, home: string = homedir()): Promise<HookTargetLock> => {
  const segments = belowHome(path, home);
  let at = await realpath(home);
  for (const segment of segments.slice(0, -1)) {
    at = join(at, segment);
    let status = await lstat(at).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : Promise.reject(error)));
    if (status === null) {
      await mkdir(at, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => (error.code === "EEXIST" ? undefined : Promise.reject(error)));
      status = await lstat(at);
    }
    if (status.isSymbolicLink() || !status.isDirectory()) throw new Error(LINKED);
  }
  const directoryStatus = await lstat(at);
  const target = join(at, segments.at(-1)!);
  const file = await lstat(target).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : Promise.reject(error)));
  if (file?.isSymbolicLink() === true) throw new Error(LINKED);
  return {
    path: target,
    directory: at,
    directoryId: identityOf(directoryStatus),
    fileId: file === null ? null : identityOf(file),
    mode: file === null ? 0o600 : file.mode & 0o777,
  };
};

/** The folder and the file still the ones noted, neither a link: else nothing is written, and why is said. */
export const assertHookTargetLock = async (lock: HookTargetLock): Promise<void> => {
  const directory = await lstat(lock.directory).catch(() => null);
  if (directory === null || directory.isSymbolicLink() || identityOf(directory) !== lock.directoryId) {
    throw changedBeforeWriting("它所在的文件夹换了");
  }
  const file = await lstat(lock.path).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : Promise.reject(error)));
  if (file === null ? lock.fileId !== null : file.isSymbolicLink() || identityOf(file) !== lock.fileId) {
    throw changedBeforeWriting(file?.isSymbolicLink() === true ? "它换成了符号链接" : "它被换掉了");
  }
};

/** Writes (or, content null, takes away) the file where it was locked: a temporary file beside it, renamed over it. */
export const writeLockedHookFile = async (lock: HookTargetLock, content: string | null): Promise<void> => {
  if (content === null) {
    await assertHookTargetLock(lock);
    await unlink(lock.path).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? undefined : Promise.reject(error)));
    return;
  }
  const temporary = join(lock.directory, `.${basename(lock.path)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporary, content, { encoding: "utf8", mode: lock.mode, flag: "wx" });
  try {
    await assertHookTargetLock(lock);
    await rename(temporary, lock.path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};

/** What cmd reads as its own in an argument: an MCP template's, on Windows, where the client's command runs through it. */
const CMD_SPECIAL = /[&|<>^%!"]/u;

/**
 * Why a client the reader wrote cannot be saved beside the others, or connected as it is: an id another client has; a
 * hook file, where it really is, outside the home folder, in Paraself's own data or a built-in client's folder, or one
 * another client writes (its hooks would be taken for this one's and removed with them); a template cmd would misread.
 */
export const customClientProblems = async (
  client: CustomClient,
  others: readonly CustomClient[],
  options: {
    /** Where each built-in client's hooks are now, by id. */
    builtInPaths: Record<string, string>;
    home?: string;
    /** This app's own folders, where no client's hooks go. */
    protectedDirectories: readonly string[];
    platform?: NodeJS.Platform;
  },
): Promise<string[]> => {
  const home = options.home ?? homedir();
  const problems: string[] = [];
  if (BUILT_IN_CLIENTS.some((builtIn) => builtIn.id === client.id)) problems.push(`id ${client.id} 是内置客户端的，换一个`);
  const catalog = CLIENT_CATALOG.find((entry) => entry.client.id === client.id);
  if (catalog !== undefined) problems.push(`Paraself 已内置 ${catalog.client.name}，这一条不再生效，可以删除`);
  if (others.some((other) => other.id === client.id)) problems.push(`已经有一个 id 为 ${client.id} 的客户端`);
  const linked = await linkAlong(customHookPath(client.hooks.file, home), home).catch(() => true);
  if (linked) problems.push(LINKED);
  try {
    problems.push(...(await placeProblems(client, others, options, home)));
  } catch (error) {
    // A path it cannot follow at all (a link to itself): said for this client, the others still read.
    if (!linked) problems.push(`钩子配置文件的路径读不了（${(error as NodeJS.ErrnoException).code ?? String(error)}）`);
  }
  if (client.mcp.mode === "file") problems.push(...(await mcpFileProblems(customHookPath(client.mcp.file, home), home, options.protectedDirectories)));
  if ((options.platform ?? process.platform) === "win32" && client.mcp.mode === "command") {
    for (const arg of [...client.mcp.add, ...client.mcp.remove, ...client.mcp.list.args]) {
      if (arg !== "{bridge}" && CMD_SPECIAL.test(arg)) {
        problems.push(`在 Windows 上，MCP 命令的参数里不能有 & | < > ^ % ! " 这些字符（cmd 会把它们当成自己的）：${arg}`);
      }
    }
  }
  return problems;
};

/**
 * Where a custom client's MCP file really is: no link along it, in the home folder, not in Paraself's own data. Another
 * client's file it may be (its own hook file, a settings file the client keeps both in): only `mcpServers.paraself` is
 * written there, and one not this app's is left alone.
 */
const mcpFileProblems = async (path: string, home: string, protectedDirectories: readonly string[]): Promise<string[]> => {
  try {
    if (await linkAlong(path, home)) return ["MCP 配置文件的路径里有符号链接；Paraself 只写它自己的真实路径，不跟着链接写"];
    const target = await realHookPath(path);
    if (!inside(target, await realHookPath(home))) return ["MCP 配置文件实际在用户主目录之外"];
    for (const directory of protectedDirectories) {
      if (inside(target, await realHookPath(directory))) return ["MCP 配置文件不能放在 Paraself 自己的数据目录里"];
    }
    return [];
  } catch (error) {
    return [`MCP 配置文件的路径读不了（${(error as NodeJS.ErrnoException).code ?? String(error)}）`];
  }
};

/** The catalog's tool a client of the reader's gives way to: one by its id, or one writing the same hook file. */
export const supersededBy = (client: CustomClient, catalogPaths: Record<string, string>, home: string = homedir()): string | null => {
  const byId = CLIENT_CATALOG.find((entry) => entry.client.id === client.id);
  if (byId !== undefined) return byId.client.name;
  const path = sameName(customHookPath(client.hooks.file, home));
  const byFile = CLIENT_CATALOG.find((entry) => catalogPaths[entry.client.id] !== undefined && sameName(catalogPaths[entry.client.id]!) === path);
  return byFile?.client.name ?? null;
};

/** Where a client's hook file really is, against the home folder, the protected folders and the other clients' files. */
const placeProblems = async (
  client: CustomClient,
  others: readonly CustomClient[],
  options: { builtInPaths: Record<string, string>; protectedDirectories: readonly string[] },
  home: string,
): Promise<string[]> => {
  const problems: string[] = [];
  const target = await realHookPath(customHookPath(client.hooks.file, home));
  const identity = await fileIdentity(target);
  const same = async (other: string): Promise<boolean> => {
    const real = await realHookPath(other);
    if (sameName(real) === sameName(target)) return true;
    const otherIdentity = await fileIdentity(real);
    return identity !== null && otherIdentity === identity;
  };
  if (!inside(target, await realHookPath(home))) problems.push("钩子配置文件实际在用户主目录之外");
  for (const [id, path] of Object.entries(options.builtInPaths)) {
    const name = BUILT_IN_CLIENTS.find((entry) => entry.id === id)?.name ?? CLIENT_CATALOG.find((entry) => entry.client.id === id)?.client.name ?? id;
    if (await same(path)) problems.push(`${name} 已经用这个钩子配置文件，两个客户端不能共用一个`);
    else if (inside(target, await realHookPath(dirname(path)))) problems.push(`钩子配置文件不能放在 ${name} 的配置目录里`);
  }
  for (const other of others) {
    if (await same(customHookPath(other.hooks.file, home))) problems.push(`${other.name} 已经用这个钩子配置文件，两个客户端不能共用一个`);
  }
  for (const directory of options.protectedDirectories) {
    if (inside(target, await realHookPath(directory))) {
      problems.push("钩子配置文件不能放在 Paraself 自己的数据目录里");
      break;
    }
  }
  return problems;
};
