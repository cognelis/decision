import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { decisionRepositorySchema, type DecisionRepository } from "@cognelis/decision-protocol";

const run = promisify(execFile);
const git = async (directory: string, args: string[]): Promise<string> => {
  const environment: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete environment[key];
  const result = await run("git", ["-C", directory, ...args], {
    timeout: 1_500, maxBuffer: 64 * 1024, windowsHide: true,
    env: environment,
  });
  return result.stdout.trim();
};

/** Normalize identity only; credentials, query strings and remote URLs never leave the bridge. */
export const normalizeRepositoryRemote = (remote: string): string | null => {
  if (/^[^/@:\s]+@[^/:\s]+:[^\s]+$/u.test(remote)) {
    const [, host, path] = /^[^@]+@([^:]+):(.+)$/u.exec(remote)!;
    return `${host!.toLowerCase()}/${path!.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "")}`;
  }
  try {
    const url = new URL(remote);
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol) || !url.hostname) return null;
    const path = url.pathname.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "");
    const port = url.port && !((url.protocol === "ssh:" && url.port === "22") || (url.protocol === "git:" && url.port === "9418")) ? `:${url.port}` : "";
    return path ? `${url.hostname.toLowerCase()}${port}/${path}` : null;
  } catch { return null; }
};

/**
 * The project a decision made in this directory belongs to: its repository's name, as a scoped search
 * resolves it, so one recorded in a linked worktree or a subdirectory is found again from there and not
 * set aside as another project's. Outside a repository, the directory's own name, as always.
 */
export const decisionProjectFor = async (directory: string): Promise<string> => {
  const repository = await resolveDecisionRepository(directory).catch(() => null);
  if (repository !== null) return repository.project;
  // A Claude Code worktree removed before its capture was read is named by the repository it was made
  // in, not by the worktree's folder.
  const host = /^(.+?)[\\/]\.claude[\\/]worktrees[\\/][^\\/]+(?:[\\/]|$)/u.exec(directory)?.[1];
  const hosted = host === undefined ? null : await resolveDecisionRepository(host).catch(() => null);
  return hosted?.project ?? (basename(directory) || "unknown-project");
};

export const resolveDecisionRepository = async (directory: string): Promise<DecisionRepository | null> => {
  if (!isAbsolute(directory) || directory.length > 4_000 || /[\0\r\n]/u.test(directory)) return null;
  try {
    const [top, common, remote] = await Promise.all([
      git(directory, ["rev-parse", "--show-toplevel"]),
      git(directory, ["rev-parse", "--git-common-dir"]),
      git(directory, ["config", "--get", "remote.origin.url"]).catch(() => ""),
    ]);
    const [root, cwd, commonDirectory] = await Promise.all([
      realpath(top), realpath(directory), realpath(resolve(directory, common)),
    ]);
    const relativeDirectory = relative(root, cwd).split(sep).join("/");
    const canonicalRemote = normalizeRepositoryRemote(remote);
    // Existing notes use checkout project names. Shared git metadata keeps the
    // original name stable even when a linked worktree has an arbitrary name.
    const project = basename(commonDirectory) === ".git"
      ? basename(dirname(commonDirectory)) : basename(commonDirectory).replace(/\.git$/u, "");
    return decisionRepositorySchema.parse({
      id: `repo:${createHash("sha256").update(canonicalRemote ?? commonDirectory).digest("hex")}`,
      project,
      relativeDirectory,
      identitySource: canonicalRemote === null ? "git_common_directory" : "remote",
    });
  } catch { return null; }
};
