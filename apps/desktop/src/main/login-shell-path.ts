import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const MARK = "__DECISION_LOGIN_PATH__";

/** A variable a login shell printed for `env`, between two marks so its greetings and warnings are left out. */
const variableFromShellOutput = (output: string, name: string): string | undefined =>
  new RegExp(`^${name}=(.+)$`, "mu").exec(output.split(MARK)[1] ?? "")?.[1]?.trim() || undefined;

/** The PATH a login shell printed for `env`, between two marks so its greetings and warnings are left out. */
export const pathFromShellOutput = (output: string): string | undefined =>
  variableFromShellOutput(output, "PATH");

/** Where Claude Code and Codex keep their settings, when the reader's shell moves them. */
const CLIENT_HOMES = ["CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const;

export type LoginShellEnvironment = { PATH: string } & Partial<Record<(typeof CLIENT_HOMES)[number], string>>;

const runShell = (shell: string, args: string[]): Promise<string> =>
  new Promise((resolve) => {
    execFile(shell, args, { encoding: "utf8", timeout: 5_000 }, (_error, stdout) => resolve(stdout ?? ""));
  });

/**
 * The folders package managers install into by default, documented as such: Homebrew's prefix on Apple
 * silicon and on Intel. Not any one machine's paths: the release check allows them in this list alone.
 */
const KNOWN_INSTALL_FOLDERS = ["/opt/homebrew/bin", "/usr/local/bin"];

/**
 * What a terminal has. Started from Finder or the Dock, the app has launchd's PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin), which holds neither claude nor codex, nor the node an npm-installed
 * CLI runs on. The login shell's comes first, as in a terminal; then what the app had; then the usual
 * install folders, for when the shell does not answer in time (Homebrew's on Apple silicon among them:
 * left out, a Mac whose shell was slow to start found no client at all). CLAUDE_CONFIG_DIR and CODEX_HOME
 * set in the shell's files come with it: without them the app wrote hooks where the clients do not look.
 */
export const loginShellEnvironment = async (
  environment: NodeJS.ProcessEnv = process.env,
  run: (shell: string, args: string[]) => Promise<string> = runShell,
): Promise<LoginShellEnvironment> => {
  const shell = environment.SHELL || "/bin/zsh";
  const ask = async (flags: string): Promise<string | undefined> => {
    const output = await run(shell, [flags, `echo ${MARK}; env; echo ${MARK}`]).catch(() => "");
    return pathFromShellOutput(output) === undefined ? undefined : output;
  };
  // Interactive first, as a terminal also reads .zshrc; one too slow to answer still leaves .zprofile,
  // where Homebrew's installer puts its shellenv.
  const output = (await ask("-ilc")) ?? (await ask("-lc"));
  const login = output === undefined ? undefined : pathFromShellOutput(output);
  const homes = Object.fromEntries(
    CLIENT_HOMES.flatMap((name) => {
      const value = output === undefined ? undefined : variableFromShellOutput(output, name);
      return value === undefined ? [] : [[name, value]];
    }),
  );
  return {
    PATH: [...new Set([
      ...(login ?? "").split(delimiter),
      ...(environment.PATH ?? "").split(delimiter),
      join(homedir(), ".local", "bin"),
      ...KNOWN_INSTALL_FOLDERS,
    ].filter((entry) => entry.length > 0))].join(delimiter),
    ...homes,
  };
};

/** The PATH a terminal has: see loginShellEnvironment. */
export const loginShellPath = async (
  environment: NodeJS.ProcessEnv = process.env,
  run: (shell: string, args: string[]) => Promise<string> = runShell,
): Promise<string> => (await loginShellEnvironment(environment, run)).PATH;
