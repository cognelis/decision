import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loginShellEnvironment, loginShellPath, pathFromShellOutput } from "../src/main/login-shell-path.js";

const LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

describe("loginShellPath", () => {
  it("reads the PATH between the marks, past whatever the shell greets with", () => {
    const output = "Last login: Wed Oct  1\nzsh: no job control\n__DECISION_LOGIN_PATH__\nHOME=/Users/reader\nPATH=/opt/homebrew/bin:/Users/reader/.local/bin:/usr/bin\n__DECISION_LOGIN_PATH__\n";
    expect(pathFromShellOutput(output)).toBe("/opt/homebrew/bin:/Users/reader/.local/bin:/usr/bin");
    expect(pathFromShellOutput("PATH=/somewhere\n")).toBeUndefined();
  });

  it("brings where the shell's files move Claude Code's and Codex's settings", async () => {
    const login = await loginShellEnvironment({ SHELL: "/bin/zsh", PATH: LAUNCHD_PATH }, async () =>
      "__DECISION_LOGIN_PATH__\nPATH=/usr/bin\nCLAUDE_CONFIG_DIR=/Users/reader/.config/claude\nCODEX_HOME=/Users/reader/.config/codex\n__DECISION_LOGIN_PATH__\n");
    // Left behind, the app wrote its hooks where the clients do not look.
    expect(login).toMatchObject({ CLAUDE_CONFIG_DIR: "/Users/reader/.config/claude", CODEX_HOME: "/Users/reader/.config/codex" });
    expect(await loginShellEnvironment({ SHELL: "/bin/zsh", PATH: LAUNCHD_PATH }, async () =>
      "__DECISION_LOGIN_PATH__\nPATH=/usr/bin\n__DECISION_LOGIN_PATH__\n")).not.toHaveProperty("CODEX_HOME");
  });

  it("puts the login shell's PATH before launchd's, as a terminal has it", async () => {
    const path = await loginShellPath(
      { SHELL: "/bin/zsh", PATH: LAUNCHD_PATH },
      async (shell, args) => {
        expect([shell, args[0]]).toEqual(["/bin/zsh", "-ilc"]);
        return "__DECISION_LOGIN_PATH__\nPATH=/Users/reader/.nvm/versions/node/v22/bin:/usr/bin\n__DECISION_LOGIN_PATH__\n";
      },
    );
    const entries = path.split(":");
    expect(entries.slice(0, 3)).toEqual(["/Users/reader/.nvm/versions/node/v22/bin", "/usr/bin", "/bin"]);
    expect(new Set(entries).size).toBe(entries.length);
  });

  it("asks a login shell without .zshrc when the interactive one does not answer", async () => {
    const asked: string[] = [];
    const path = await loginShellPath({ SHELL: "/bin/zsh", PATH: LAUNCHD_PATH }, async (_shell, args) => {
      asked.push(args[0]!);
      return args[0] === "-lc" ? "__DECISION_LOGIN_PATH__\nPATH=/usr/local/opt/tools/bin:/usr/bin\n__DECISION_LOGIN_PATH__\n" : "";
    });
    expect(asked).toEqual(["-ilc", "-lc"]);
    expect(path.split(":")[0]).toBe("/usr/local/opt/tools/bin");
  });

  it("still finds the usual install folders when the shell does not answer", async () => {
    const path = await loginShellPath({ PATH: LAUNCHD_PATH }, async () => { throw new Error("timed out"); });
    expect(path.startsWith(LAUNCHD_PATH)).toBe(true);
    // Homebrew's prefix on Apple silicon among them: without it a Mac whose shell was slow found no client.
    expect(path.split(":")).toEqual(expect.arrayContaining([join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"]));
  });
});
