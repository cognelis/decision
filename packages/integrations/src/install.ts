import { spawn } from "node:child_process";
import { access, constants, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import { claudeMcpCommands, claudeMcpRemoveCommands, mergeClaudeSettings } from "./claude.js";
import { codexMcpCommands, codexMcpRemoveCommands, mergeCodexHooks } from "./codex.js";
import { removeHookDocument, type CommandSpec } from "./hooks.js";

export type InstallMode = "dry-run" | "apply";
export type IntegrationClient = "claude-code" | "codex";

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
}

interface RemoveOptions {
  mode: InstallMode;
  claudeSettingsPath: string;
  codexHooksPath: string;
  platform?: NodeJS.Platform;
  runner?: CommandRunner;
  /**
   * Where this run's bridge is: a server shown running it is this app's, as one running a `decision-bridge` is.
   * Not packaged, the bridge is run by its source file's name, and its own server was taken for another tool's.
   */
  bridgePath?: string;
}

interface InstallOptions extends RemoveOptions {
  bridgePath: string;
}

interface ParsedTarget {
  client: IntegrationClient;
  path: string;
  before: string;
  after: string;
}

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
        // `decision` there was taken for the one to replace; the add and remove name the user scope themselves.
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
    throw new Error(`${path} 不是有效的 JSON，多半是手动编辑时多了或少了逗号、引号，修正后再试`);
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
  client: IntegrationClient,
  path: string,
  bridgePath: string,
  platform: NodeJS.Platform,
): Promise<ParsedTarget> => {
  const source = await readTarget(path);
  const merged =
    client === "claude-code"
      ? mergeClaudeSettings(source.parsed, bridgePath, platform)
      : mergeCodexHooks(source.parsed, bridgePath, platform);
  return {
    client,
    path,
    before: source.raw,
    after: formatJson(merged),
  };
};

const prepareRemoval = async (client: IntegrationClient, path: string): Promise<ParsedTarget> => {
  const source = await readTarget(path);
  const removed = removeHookDocument(source.parsed);
  // A file with none of this app's hooks in it is left as it is, its layout too.
  return {
    client,
    path,
    before: source.raw,
    after: JSON.stringify(removed) === JSON.stringify(source.parsed) ? source.raw : formatJson(removed),
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
  const boundary = `(?![\\p{Letter}\\p{Number}_-])`;
  return new RegExp(
    `(?:no\\s+mcp\\s+server\\s+(?:found\\s+with\\s+name:\\s*|named\\s+)["']?${target}["']?${boundary}|` +
      `mcp\\s+server\\s+["']?${target}["']?\\s+(?:not found|does not exist|not configured)|` +
      `未找到(?:名为|名称为)?\\s*["']?${target}["']?\\s*(?:的)?\\s*mcp\\s*服务器|` +
      `mcp\\s*服务器\\s*["']?${target}["']?\\s*不存在)`,
    "iu",
  ).test(detail);
};

const CLIENT_COMMAND: Record<IntegrationClient, string> = { "claude-code": "claude", codex: "codex" };

// A client whose command is not there at all: spawn says ENOENT; cmd.exe, that it is not recognized.
const commandMissing = (error: unknown): boolean =>
  isMissing(error) ||
  (error instanceof Error && /is not recognized as an internal or external command|command not found/iu.test(error.message));

// The code of the error a look at a server that is not this app's ends in.
const NOT_THIS_APPS = "DECISION_MCP_NOT_THIS_APPS";

const runMcpCommands = async (
  commands: CommandSpec[],
  runner: CommandRunner,
  bridgePath: string | undefined,
): Promise<boolean> => {
  // Whether a command of this app's took effect: a server removed or added, not a look at one, nor the removal
  // of one that was not there.
  let acted = false;
  for (const specification of commands) {
    const result = await runner(specification.command, specification.args);
    // cmd's own code for a command it cannot find, in any language. Its message, in the console's code page
    // and read as UTF-8, came out as noise, and a client never installed was reported as failed.
    if (result.exitCode === 9009) {
      throw Object.assign(new Error(`没有找到 ${specification.command} 命令`), { code: "ENOENT" });
    }
    if (specification.expectsBridgeFor !== undefined) {
      // A server of that name the client shows, that does not run this app's bridge (another tool's, or the
      // reader's own), was removed and replaced without a word. Not there, or nothing shown: as before.
      const shown = result.exitCode === 0 ? (result.stdout?.trim() ?? "") : "";
      const ours =
        new RegExp(`\\bmcp ${specification.expectsBridgeFor}(?![\\w-])`, "u").test(shown) &&
        (/decision-bridge(?:\.cmd)?(?=["'\s]|$)/u.test(shown) || (bridgePath !== undefined && shown.includes(bridgePath)));
      if (shown !== "" && !ours) {
        throw Object.assign(
          new Error(
            `${specification.expectsBridgeFor === "codex" ? "Codex" : "Claude Code"} 里已有一个名为 decision 的 MCP 服务器，` +
              "运行的不是本应用的桥接程序，没有改动它；" +
              "如果不再需要它，先自行删除或改名再试",
          ),
          { code: NOT_THIS_APPS },
        );
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
  return acted;
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

const install = async (
  options: InstallOptions,
): Promise<InstallReport> => {
  const platform = options.platform ?? process.platform;
  // Each client's own file is read on its own: one that cannot be read (not valid JSON, no permission)
  // is that client's failure, its commands are not run and its file is left as it is; the other client
  // still connects.
  const targets = await Promise.all(
    ([
      ["claude-code", options.claudeSettingsPath],
      ["codex", options.codexHooksPath],
    ] as const).map(([client, path]) =>
      prepareTarget(client, path, options.bridgePath, platform).catch((error: unknown) => ({
        client,
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
  if (targets.every((target) => "unreadable" in target)) {
    throw new Error(targets.map((target) => ("unreadable" in target ? target.unreadable : "")).join("；"));
  }
  const commandsFor: Record<IntegrationClient, CommandSpec[]> = {
    "claude-code": claudeMcpCommands(options.bridgePath, platform),
    codex: codexMcpCommands(options.bridgePath),
  };
  const commands = [...commandsFor["claude-code"], ...commandsFor.codex];

  if (options.mode === "dry-run") {
    return {
      mode: options.mode,
      targets: targets.map((target) =>
        "unreadable" in target
          ? unreadableReport(target)
          : {
              client: target.client,
              path: target.path,
              changed: target.before !== target.after,
            },
      ),
      commands,
      restartRequired: true,
    };
  }

  // Each client stands alone: one whose command is not installed is skipped, and one that fails does not
  // keep the other from connecting. Within a client the callable MCP capability goes first, and hook
  // marker v1 is written only once that client accepted it, so status detection stays conservative.
  const runner = options.runner ?? defaultRunner(platform);
  const reports: InstallTargetReport[] = [];
  for (const target of targets) {
    if ("unreadable" in target) {
      reports.push(unreadableReport(target));
      continue;
    }
    try {
      await runMcpCommands(commandsFor[target.client], runner, options.bridgePath);
    } catch (error) {
      reports.push({
        client: target.client,
        path: target.path,
        changed: false,
        ...(commandMissing(error)
          ? { status: "skipped" as const, detail: `没有找到 ${CLIENT_COMMAND[target.client]} 命令` }
          : { status: "failed" as const, detail: error instanceof Error ? error.message : String(error) }),
      });
      continue;
    }
    // Read again just before writing: the commands take seconds, and what the client or the reader wrote to
    // the file meanwhile (a /model change in a running Claude Code, say) went under what it held before them.
    let changed: boolean;
    let fresh: Awaited<ReturnType<typeof prepareTarget>>;
    try {
      fresh = await prepareTarget(target.client, target.path, options.bridgePath, platform);
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
        await writeAtomically(target.path, fresh.after, fresh.before, platform);
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
    reports.push({
      client: target.client,
      path: target.path,
      changed,
      status: "installed",
      // Codex holds a hook new or changed to it until the reader trusts it there: connected, it ran none.
      ...(target.client === "codex"
        ? { detail: "Codex 只运行你信任过的 hook：打开 Codex 时若提示 Hooks need review，确认信任后才会开始自动记录" }
        : {}),
    });
  }
  if (!reports.some((report) => report.status === "installed")) {
    throw new Error(
      reports.every((report) => report.status === "skipped")
        ? "没有找到 claude 或 codex 命令：请先安装 Claude Code 或 Codex，并确认在终端里能运行它们。"
        : reports.map((report) => report.detail ?? "").join("；"),
    );
  }
  return {
    mode: options.mode,
    targets: reports,
    commands,
    restartRequired: true,
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
 * Takes this app out of both clients: its hooks out of each file (the reader's own stay) and its MCP server out
 * of each client, where the server of that name runs this app's bridge. Skills published to a client are files
 * of the client's own, and stay.
 */
export const removeIntegrations = (options: RemoveOptions): Promise<InstallReport> => inTurn(() => remove(options));

const remove = async (options: RemoveOptions): Promise<InstallReport> => {
  const platform = options.platform ?? process.platform;
  const commandsFor: Record<IntegrationClient, CommandSpec[]> = {
    "claude-code": claudeMcpRemoveCommands(),
    codex: codexMcpRemoveCommands(),
  };
  const runner = options.runner ?? defaultRunner(platform);
  const reports: InstallTargetReport[] = [];
  for (const [client, path] of [
    ["claude-code", options.claudeSettingsPath],
    ["codex", options.codexHooksPath],
  ] as const) {
    // A file it cannot read or write is that client's failure, and nothing of that client's is changed.
    let target: ParsedTarget;
    try {
      target = await prepareRemoval(client, path);
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
      acted = await runMcpCommands(commandsFor[client], runner, options.bridgePath);
    } catch (error) {
      missing = commandMissing(error);
      if (missing) {
        detail = `没有找到 ${CLIENT_COMMAND[client]} 命令，没有删除它登记的 MCP 服务器`;
      } else if ((error as NodeJS.ErrnoException).code === NOT_THIS_APPS) {
        detail = "名为 decision 的 MCP 服务器不是本应用的，没有动它";
      } else {
        reports.push(failedReport(client, path, error instanceof Error ? error.message : String(error)));
        continue;
      }
    }
    // Read again just before writing, as an install does: what was saved to it while the commands ran stays.
    let fresh: ParsedTarget;
    try {
      fresh = await prepareRemoval(client, path);
    } catch (error) {
      reports.push(failedReport(client, path, inReaderWords(error)));
      continue;
    }
    const changed = fresh.before !== fresh.after;
    try {
      if (changed) await writeAtomically(path, fresh.after, fresh.before, platform);
    } catch (error) {
      reports.push(failedReport(client, path, `无法写入 ${path}：${inReaderWords(error)}`));
      continue;
    }
    reports.push(
      // A client not there at all, with nothing of this app's in its file: skipped, as an install says, not removed.
      missing && !changed
        ? { client, path, changed, status: "skipped", detail: `没有找到 ${CLIENT_COMMAND[client]} 命令` }
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
    commands: [...commandsFor["claude-code"], ...commandsFor.codex],
    restartRequired: true,
    note: "已发布到客户端的技能和工作流没有删除，客户端仍会加载它们；不需要的可以在 Decision 里逐个回滚发布。",
  };
};
