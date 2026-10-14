import {
  chmod,
  mkdtemp,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LocalModelClientDiscovery,
  localModelClientErrorCode,
} from "../src/main/model/cli/cli-discovery.js";
import {
  ManagedProcessError,
  type ManagedProcessRequest,
  type ManagedProcessResult,
} from "../src/main/model/cli/managed-child-process.js";

const temporaryDirectories: string[] = [];

const executable = async (
  name: string,
  mode = 0o755,
): Promise<{ directory: string; path: string }> => {
  const directory = await mkdtemp(
    join(tmpdir(), "decision-discovery-"),
  );
  temporaryDirectories.push(directory);
  const path = join(directory, name);
  await writeFile(path, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(path, mode);
  return { directory, path };
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) =>
        rm(path, { recursive: true, force: true }),
      ),
  );
});

const result = (
  stdout: string,
  stderr = "",
): ManagedProcessResult => ({
  exitCode: 0,
  stdout,
  stderr,
  durationMs: 1,
});

const codexExecFlagsFixture = (): string =>
  [
    "--ephemeral",
    "--json",
    "--ignore-user-config",
    "--output-schema",
    "--sandbox",
    "--skip-git-repo-check",
    "--cd",
    "--model",
  ].join("\n");

describe("LocalModelClientDiscovery", () => {
  it("offers only visible, valid, unique models from CODEX_HOME, without leaking catalog metadata", async () => {
    const { directory } = await executable("codex");
    const run = vi.fn(async (request: ManagedProcessRequest) => request.args[0] === "--version" ? result("codex-cli 0.147.0") : request.args[0] === "login" ? result("Logged in using ChatGPT") : request.args[0] === "--help" ? result("--ask-for-approval") : result(codexExecFlagsFixture()));
    await writeFile(join(directory, "models_cache.json"), JSON.stringify({ identity: "private-account", models: [
      { slug: "later-model", display_name: "Later", visibility: "list", priority: 2, base_instructions: "private instructions" },
      { slug: "first-model", display_name: "First", visibility: "list", priority: 1 },
      { slug: "hidden-model", visibility: "hide" }, { slug: "first-model", visibility: "list", priority: 3 },
      { slug: "x".repeat(201), visibility: "list" }, null,
    ] }));
    const discovery = new LocalModelClientDiscovery({ runner: { run }, environment: { PATH: directory, CODEX_HOME: directory } });
    const status = await discovery.inspect("codex");
    expect(status.modelsSource).toBe("cache");
    expect(status.models).toEqual([{ id: "first-model", label: "First" }, { id: "later-model", label: "Later" }]);
    expect(JSON.stringify(status)).not.toMatch(/private-account|private instructions|hidden-model/);
    expect(run).toHaveBeenCalledTimes(5);
    await writeFile(join(directory, "models_cache.json"), "broken");
    expect(await discovery.inspect("codex")).toMatchObject({ availability: "available" });
    expect((await discovery.inspect("codex")).models).toBeUndefined();
  });

  it("reads HOME/.codex when CODEX_HOME is not set and tolerates a missing catalog", async () => {
    const { directory } = await executable("codex");
    const run = vi.fn(async (request: ManagedProcessRequest) => request.args[0] === "--version" ? result("codex-cli 0.147.0") : request.args[0] === "login" ? result("Logged in using ChatGPT") : request.args[0] === "--help" ? result("--ask-for-approval") : result(codexExecFlagsFixture()));
    const home = join(directory, ".codex");
    await mkdir(home);
    const discovery = new LocalModelClientDiscovery({ runner: { run }, environment: { PATH: directory, HOME: directory } });
    expect((await discovery.inspect("codex")).models).toBeUndefined();
    await writeFile(join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: "model-name", visibility: "list" }] }));
    expect((await discovery.inspect("codex")).models).toEqual([{ id: "model-name", label: "model-name" }]);
  });

  it.each([
    ["not_found", "executable_missing"],
    ["not_executable", "executable_missing"],
    ["logged_out", "credential_unavailable"],
    ["unsupported", "unsupported_client"],
    ["diagnostics_failed", "process_failed"],
  ] as const)(
    "maps %s client readiness to %s",
    (availability, expected) => {
      expect(
        localModelClientErrorCode(availability),
      ).toBe(expected);
    },
  );

  it("finds a Windows client by PATHEXT: the installer's .exe before npm's .cmd, never npm's bare shell script", async () => {
    // npm leaves claude (a shell script only Git Bash runs) beside claude.cmd; looked up bare, that was the one.
    const { directory } = await executable("claude");
    const add = async (name: string): Promise<void> => {
      await writeFile(join(directory, name), "", "utf8");
      await chmod(join(directory, name), 0o755);
    };
    await add("claude.cmd");
    const executed: string[] = [];
    const run = vi.fn(async (request: ManagedProcessRequest): Promise<ManagedProcessResult> => {
      executed.push(request.executable);
      throw new ManagedProcessError("process_failed", "stopped after the lookup");
    });
    const discovery = new LocalModelClientDiscovery({ runner: { run }, environment: { PATH: directory }, platform: "win32" });

    await discovery.inspect("claude-code");
    expect(executed[0]).toBe(join(directory, "claude.cmd"));
    await add("claude.exe");
    executed.length = 0;
    await discovery.inspect("claude-code");
    expect(executed[0]).toBe(join(directory, "claude.exe"));
  });

  it("inspects Codex version, required flags, and login without comprehensive diagnostics", async () => {
    const { directory, path } = await executable("codex");
    const run = vi.fn(
      async (
        request: ManagedProcessRequest,
      ): Promise<ManagedProcessResult> => {
        if (request.args[0] === "doctor") {
          throw new Error(
            "startup discovery must not run codex doctor",
          );
        }
        if (request.args[0] === "--version") {
          return result("codex-cli 0.147.0\n");
        }
        if (request.args[0] === "login") {
          return result("Logged in using ChatGPT\n");
        }
        if (request.args[0] === "--help") {
          return result("--ask-for-approval\n");
        }
        return result(codexExecFlagsFixture());
      },
    );
    const discovery = new LocalModelClientDiscovery({
      runner: { run },
      environment: { PATH: directory, HTTPS_PROXY: "http://old-proxy:8080", NO_PROXY: "*" },
      now: () =>
        new Date("2026-07-30T00:00:00.000Z"),
    });

    await expect(
      discovery.inspect("codex", undefined, { mode: "custom", url: "http://127.0.0.1:7890" }),
    ).resolves.toEqual({
      kind: "codex-cli",
      executablePath: path,
      version: "0.147.0",
      authenticated: true,
      supported: true,
      availability: "available",
      checkedAt: "2026-07-30T00:00:00.000Z",
    });
    expect(
      run.mock.calls.map(([request]) => request.args),
    ).toEqual([
      ["--version"],
      ["login", "status"],
      ["--help"],
      ["exec", "--help"],
      ["app-server", "--listen", "stdio://"],
    ]);
    for (const [request] of run.mock.calls) expect(request.environment).toMatchObject({ HTTPS_PROXY: "http://127.0.0.1:7890", https_proxy: "http://127.0.0.1:7890", NO_PROXY: "", no_proxy: "" });

  });

  it.runIf(
    process.env.DECISION_CODEX_EXECUTABLE !== undefined,
  )(
    "recognizes the installed Codex without running comprehensive environment diagnostics",
    async () => {
      const path = process.env.DECISION_CODEX_EXECUTABLE!;
      const inspected = await new LocalModelClientDiscovery({
        environment: process.env,
      }).inspect("codex", path);

      expect(inspected).toMatchObject({
        kind: "codex-cli",
        executablePath: path,
        authenticated: true,
        supported: true,
        availability: "available",
      });
    },
    10_000,
  );

  it("inspects Claude Code JSON auth and safe invocation flags", async () => {
    const { path } = await executable("claude");
    const run = vi.fn(
      async (
        request: ManagedProcessRequest,
      ): Promise<ManagedProcessResult> => {
        if (request.args[0] === "--version") {
          return result("2.1.220 (Claude Code)\n");
        }
        if (request.args[0] === "auth") {
          return result(
            '{"loggedIn":true,"authMethod":"oauth"}\n',
          );
        }
        return result(
          [
            "--safe-mode",
            "--tools",
            "--disallowedTools",
            "--no-session-persistence",
            "--permission-mode",
            "--output-format",
            "--json-schema",
            "--model",
          ].join("\n"),
        );
      },
    );
    const discovery = new LocalModelClientDiscovery({
      runner: { run },
      environment: { PATH: "" },
      now: () =>
        new Date("2026-07-30T00:00:00.000Z"),
    });

    await expect(
      discovery.inspect("claude-code", path),
    ).resolves.toEqual({
      kind: "claude-code-cli",
      executablePath: path,
      version: "2.1.220",
      authenticated: true,
      supported: true,
      availability: "available",
      checkedAt: "2026-07-30T00:00:00.000Z",
    });
    expect(
      run.mock.calls.map(([request]) => request.args),
    ).toEqual([
      ["--version"],
      ["auth", "status", "--json"],
      ["--help"],
      ["-p", "--safe-mode", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-session-persistence", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
    ]);
  });

  it("looks at launch only at the clients of enabled profiles, keeping what the others were last found to be", async () => {
    const { path: codex } = await executable("codex");
    const run = vi.fn(async () => result("codex-cli 0.48.0"));
    const discovery = new LocalModelClientDiscovery({
      runner: { run },
      environment: { PATH: "/definitely/missing" },
      now: () => new Date("2026-07-30T00:00:00.000Z"),
    });
    // The built-ins, off, Codex's path kept from the time it was found.
    const profiles = [
      { version: 1, profileId: "builtin-codex-cli", kind: "codex-cli", label: "Codex CLI", enabled: false, priority: 20, timeoutMs: 30_000, executablePath: codex },
      { version: 1, profileId: "builtin-claude-code-cli", kind: "claude-code-cli", label: "Claude Code CLI", enabled: false, priority: 30, timeoutMs: 30_000 },
    ] as const;
    const known = [{ kind: "codex-cli", executablePath: codex, authenticated: true, supported: true, availability: "available", checkedAt: "2026-07-29T00:00:00.000Z" }] as const;

    // Every launch ran their seven diagnostics before the window opened.
    await expect(discovery.inspectProfiles(profiles, { onlyEnabled: true, known })).resolves.toEqual(known);
    expect(run).not.toHaveBeenCalled();

    // The models page asks for both.
    const asked = await discovery.inspectProfiles(profiles, { onlyEnabled: false, known });
    expect(asked.map((status) => status.kind)).toEqual(["codex-cli", "claude-code-cli"]);
    expect(run).toHaveBeenCalled();
  });

  it("reports missing and non-executable clients", async () => {
    const missing = new LocalModelClientDiscovery({
      runner: { run: vi.fn() },
      environment: { PATH: "/definitely/missing" },
      now: () =>
        new Date("2026-07-30T00:00:00.000Z"),
    });
    await expect(
      missing.inspect("codex"),
    ).resolves.toMatchObject({
      kind: "codex-cli",
      authenticated: false,
      supported: false,
      availability: "not_found",
    });

    const { path: nonExecutable } = await executable(
      "codex",
      0o644,
    );
    await expect(
      missing.inspect("codex", nonExecutable),
    ).resolves.toMatchObject({
      executablePath: nonExecutable,
      availability: "not_executable",
    });
  });

  it("reports an otherwise compatible logged-out Codex client", async () => {
    const { path } = await executable("codex");
    const responses = [
      result("codex-cli 0.147.0"),
      result("Not logged in"),
      result("--ask-for-approval"),
      result(codexExecFlagsFixture()),
    ];
    const discovery = new LocalModelClientDiscovery({
      runner: { run: vi.fn(async () => responses.shift()!) },
      environment: { PATH: "" },
      now: () =>
        new Date("2026-07-30T00:00:00.000Z"),
    });

    await expect(
      discovery.inspect("codex", path),
    ).resolves.toMatchObject({
      version: "0.147.0",
      authenticated: false,
      supported: true,
      availability: "logged_out",
    });
  });

  it("reports a Codex client missing required exec flags", async () => {
    const { path } = await executable("codex");
    const responses = [
      result("codex-cli 0.147.0"),
      result("Logged in using ChatGPT"),
      result("--ask-for-approval"),
      result("--ephemeral --json"),
    ];
    const discovery = new LocalModelClientDiscovery({
      runner: { run: vi.fn(async () => responses.shift()!) },
      environment: { PATH: "" },
      now: () =>
        new Date("2026-07-30T00:00:00.000Z"),
    });

    await expect(
      discovery.inspect("codex", path),
    ).resolves.toMatchObject({
      authenticated: true,
      supported: false,
      availability: "unsupported",
    });
  });

  it.each([
    [
      "global option prefix",
      "--ask-for-approval-mode",
      codexExecFlagsFixture(),
    ],
    [
      "hyphenated exec option prefix",
      "--ask-for-approval",
      codexExecFlagsFixture().replace(
        "--model",
        "--model-provider",
      ),
    ],
    [
      "underscored exec option prefix",
      "--ask-for-approval",
      codexExecFlagsFixture().replace(
        "--model",
        "--model_provider",
      ),
    ],
  ])(
    "rejects a %s lookalike",
    async (_label, globalHelp, execHelp) => {
      const { path } = await executable("codex");
      const responses = [
        result("codex-cli 0.147.0"),
        result("Logged in using ChatGPT"),
        result(globalHelp),
        result(execHelp),
      ];
      const discovery = new LocalModelClientDiscovery({
        runner: {
          run: vi.fn(async () => responses.shift()!),
        },
        environment: { PATH: "" },
        now: () =>
          new Date("2026-07-30T00:00:00.000Z"),
      });

      await expect(
        discovery.inspect("codex", path),
      ).resolves.toMatchObject({
        authenticated: true,
        supported: false,
        availability: "unsupported",
      });
    },
  );

  it("reports malformed version output without retaining diagnostics", async () => {
    const { path } = await executable("codex");
    const responses = [
      result("private malformed version output"),
      result("Logged in using ChatGPT"),
      result("--ask-for-approval"),
      result(codexExecFlagsFixture()),
    ];
    const discovery = new LocalModelClientDiscovery({
      runner: { run: vi.fn(async () => responses.shift()!) },
      environment: { PATH: "" },
      now: () =>
        new Date("2026-07-30T00:00:00.000Z"),
    });

    const inspected = await discovery.inspect("codex", path);

    expect(inspected).toEqual({
      kind: "codex-cli",
      executablePath: path,
      authenticated: true,
      supported: true,
      availability: "diagnostics_failed",
      checkedAt: "2026-07-30T00:00:00.000Z",
    });
    expect(JSON.stringify(inspected)).not.toContain("private");
  });

  it("reports a logged-out Claude Code whose auth status exits 1, as the real one does", async () => {
    const { path } = await executable("claude");
    const run = vi.fn(async (request: ManagedProcessRequest): Promise<ManagedProcessResult> => {
      if (request.args[0] === "auth") {
        throw new ManagedProcessError("process_failed", "private command failure", { processExitCode: 1 });
      }
      if (request.args[0] === "--version") return result("2.1.220 (Claude Code)\n");
      return result(["--safe-mode", "--tools", "--disallowedTools", "--no-session-persistence", "--permission-mode", "--output-format", "--json-schema", "--model"].join("\n"));
    });
    const discovery = new LocalModelClientDiscovery({
      runner: { run },
      environment: { PATH: "" },
      now: () => new Date("2026-07-30T00:00:00.000Z"),
    });

    // Told to log in, with its version: a failed check said neither.
    await expect(discovery.inspect("claude-code", path)).resolves.toMatchObject({
      version: "2.1.220", authenticated: false, supported: true, availability: "logged_out",
    });
  });

  it("reports a logged-out Codex client whose login status exits 1, as the real one does", async () => {
    const { path } = await executable("codex");
    const run = vi.fn(async (request: ManagedProcessRequest): Promise<ManagedProcessResult> => {
      if (request.args[0] === "login") {
        throw new ManagedProcessError("process_failed", "private command failure", {
          processExitCode: 1,
          diagnosticExcerpt: "Not logged in",
        });
      }
      if (request.args[0] === "--version") return result("codex-cli 0.147.0");
      if (request.args[0] === "--help") return result("--ask-for-approval");
      return result(codexExecFlagsFixture());
    });
    const discovery = new LocalModelClientDiscovery({
      runner: { run },
      environment: { PATH: "" },
      now: () => new Date("2026-07-30T00:00:00.000Z"),
    });

    const inspected = await discovery.inspect("codex", path);

    // Told to log in, not that its diagnostics failed.
    expect(inspected).toMatchObject({ authenticated: false, supported: true, availability: "logged_out" });
    expect(JSON.stringify(inspected)).not.toContain("private");
  });

  it.each([
    ["version", "--version"],
    ["global help", "--help"],
    ["exec help", "exec"],
  ])(
    "maps a nonzero Codex %s command to diagnostics_failed",
    async (_label, failingCommand) => {
      const { path } = await executable("codex");
      const run = vi.fn(
        async (
          request: ManagedProcessRequest,
        ): Promise<ManagedProcessResult> => {
          if (request.args[0] === failingCommand) {
            throw new ManagedProcessError(
              "process_failed",
              "private command failure",
              { processExitCode: 1 },
            );
          }
          if (request.args[0] === "--version") {
            return result("codex-cli 0.147.0");
          }
          if (request.args[0] === "login") {
            return result("Logged in using ChatGPT");
          }
          if (request.args[0] === "--help") {
            return result("--ask-for-approval");
          }
          return result(codexExecFlagsFixture());
        },
      );
      const discovery = new LocalModelClientDiscovery({
        runner: { run },
        environment: { PATH: "" },
        now: () =>
          new Date("2026-07-30T00:00:00.000Z"),
      });

      const inspected = await discovery.inspect(
        "codex",
        path,
      );

      expect(inspected).toMatchObject({
        authenticated: false,
        supported: false,
        availability: "diagnostics_failed",
      });
      expect(JSON.stringify(inspected)).not.toContain(
        "private",
      );
    },
  );

  it("maps discovery timeouts to a stable unavailable status", async () => {
    const { path } = await executable("claude");
    const discovery = new LocalModelClientDiscovery({
      runner: {
        run: vi.fn(async () => {
          throw new ManagedProcessError(
            "timeout",
            "private timeout detail",
          );
        }),
      },
      environment: { PATH: "" },
      now: () =>
        new Date("2026-07-30T00:00:00.000Z"),
    });

    const inspected = await discovery.inspect(
      "claude-code",
      path,
    );

    expect(inspected).toMatchObject({
      kind: "claude-code-cli",
      executablePath: path,
      availability: "diagnostics_failed",
      authenticated: false,
      supported: false,
    });
    expect(JSON.stringify(inspected)).not.toContain("private");
  });
});
