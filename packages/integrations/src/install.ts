import { spawn } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import { claudeMcpCommands, mergeClaudeSettings } from "./claude.js";
import { codexMcpCommands, mergeCodexHooks } from "./codex.js";
import type { CommandSpec } from "./hooks.js";

export type InstallMode = "dry-run" | "apply";
export type IntegrationClient = "claude-code" | "codex";

export interface CommandResult {
  exitCode: number;
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
}

export interface InstallReport {
  mode: InstallMode;
  targets: InstallTargetReport[];
  commands: CommandSpec[];
  restartRequired: boolean;
}

interface InstallOptions {
  mode: InstallMode;
  bridgePath: string;
  claudeSettingsPath: string;
  codexHooksPath: string;
  platform?: NodeJS.Platform;
  runner?: CommandRunner;
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
    throw new Error("Windows command arguments must be one line");
  }
  return `"${value.replaceAll("%", "%%").replaceAll('"', '""')}"`;
};

export const commandInvocation = (
  command: string,
  args: string[],
  options: CommandInvocationOptions = {},
): { command: string; args: string[] } => {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { command, args: [...args] };
  }
  return {
    command:
      options.commandInterpreter ?? process.env.ComSpec ?? "cmd.exe",
    args: [
      "/d",
      "/s",
      "/v:off",
      "/c",
      [command, ...args].map(quoteWindowsCommandArgument).join(" "),
    ],
  };
};

const defaultRunner = (platform: NodeJS.Platform): CommandRunner =>
  async (command, args) =>
    new Promise((resolve, reject) => {
      const invocation = commandInvocation(command, args, { platform });
      const child = spawn(invocation.command, invocation.args, {
        stdio: ["ignore", "ignore", "pipe"],
      });
      const stderr: Buffer[] = [];
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject);
      child.once("close", (code) => {
        resolve({
          exitCode: code ?? 1,
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
    throw new Error(`Invalid JSON in ${path}`);
  }
};

const formatJson = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;

const prepareTarget = async (
  client: IntegrationClient,
  path: string,
  bridgePath: string,
  platform: NodeJS.Platform,
): Promise<ParsedTarget> => {
  const source = await readJson(path);
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

const writeAtomically = async (
  path: string,
  content: string,
): Promise<void> => {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
    JSON.parse(await readFile(path, "utf8"));
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

const runMcpCommands = async (
  commands: CommandSpec[],
  runner: CommandRunner,
): Promise<void> => {
  for (const specification of commands) {
    const result = await runner(specification.command, specification.args);
    if (result.exitCode === 0) {
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
    throw new Error(
      `${specification.command} ${specification.args.join(" ")} failed${
        detail.length === 0 ? "" : `: ${detail}`
      }`,
    );
  }
};

export const installIntegrations = async (
  options: InstallOptions,
): Promise<InstallReport> => {
  const platform = options.platform ?? process.platform;
  const targets = await Promise.all([
    prepareTarget(
      "claude-code",
      options.claudeSettingsPath,
      options.bridgePath,
      platform,
    ),
    prepareTarget(
      "codex",
      options.codexHooksPath,
      options.bridgePath,
      platform,
    ),
  ]);
  const commands = [
    ...claudeMcpCommands(options.bridgePath),
    ...codexMcpCommands(options.bridgePath),
  ];

  if (options.mode === "dry-run") {
    return {
      mode: options.mode,
      targets: targets.map((target) => ({
        client: target.client,
        path: target.path,
        changed: target.before !== target.after,
      })),
      commands,
      restartRequired: true,
    };
  }

  // Install the callable MCP capability first. Hook marker v1 is written only
  // after both clients accepted it, so status detection remains conservative.
  await runMcpCommands(commands, options.runner ?? defaultRunner(platform));

  const reports: InstallTargetReport[] = [];
  for (const target of targets) {
    const changed = target.before !== target.after;
    if (changed) {
      await writeAtomically(target.path, target.after);
    }
    reports.push({
      client: target.client,
      path: target.path,
      changed,
    });
  }
  return {
    mode: options.mode,
    targets: reports,
    commands,
    restartRequired: true,
  };
};
