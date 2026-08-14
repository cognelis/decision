import {
  chmod,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LocalModelClientDiscovery,
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

describe("LocalModelClientDiscovery", () => {
  it("inspects Codex version, diagnostics, required flags, and login", async () => {
    const { directory, path } = await executable("codex");
    const run = vi.fn(
      async (
        request: ManagedProcessRequest,
      ): Promise<ManagedProcessResult> => {
        if (request.args[0] === "--version") {
          return result("codex-cli 0.146.0\n");
        }
        if (request.args[0] === "login") {
          return result("Logged in using ChatGPT\n");
        }
        if (request.args[0] === "doctor") {
          return result('{"status":"ok"}\n');
        }
        if (request.args[0] === "--help") {
          return result("--ask-for-approval\n");
        }
        return result(
          [
            "--ephemeral",
            "--json",
            "--ignore-user-config",
            "--output-schema",
            "--sandbox",
            "--skip-git-repo-check",
            "--cd",
            "--model",
          ].join("\n"),
        );
      },
    );
    const discovery = new LocalModelClientDiscovery({
      runner: { run },
      environment: { PATH: directory },
      now: () =>
        new Date("2026-07-30T00:00:00.000Z"),
    });

    await expect(
      discovery.inspect("codex"),
    ).resolves.toEqual({
      kind: "codex-cli",
      executablePath: path,
      version: "0.146.0",
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
      ["doctor", "--json"],
      ["--help"],
      ["exec", "--help"],
    ]);
  });

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
    ]);
  });

  it("reports missing, non-executable, logged-out, unsupported, and malformed clients without raw diagnostics", async () => {
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

    const { path } = await executable("codex");
    const responses = [
      result("codex-cli 0.146.0"),
      result("Not logged in"),
      result("{bad"),
      result("--ask-for-approval"),
      result("--ephemeral --json"),
    ];
    const run = vi.fn(async () => responses.shift()!);
    const discovery = new LocalModelClientDiscovery({
      runner: { run },
      environment: { PATH: "" },
      now: () =>
        new Date("2026-07-30T00:00:00.000Z"),
    });
    const inspected = await discovery.inspect("codex", path);

    expect(inspected).toEqual({
      kind: "codex-cli",
      executablePath: path,
      version: "0.146.0",
      authenticated: false,
      supported: false,
      availability: "diagnostics_failed",
      checkedAt: "2026-07-30T00:00:00.000Z",
    });
    expect(JSON.stringify(inspected)).not.toContain("{bad");
  });

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
