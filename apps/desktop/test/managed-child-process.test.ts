import {
  spawn as nodeSpawn,
} from "node:child_process";
import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ManagedChildProcessRunner,
  ManagedProcessError,
  type SpawnProcess,
} from "../src/main/model/cli/managed-child-process.js";

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const path = await mkdtemp(
    join(tmpdir(), "decision-process-"),
  );
  temporaryDirectories.push(path);
  return path;
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

const request = async (
  script: string,
  overrides: Record<string, unknown> = {},
) => ({
  executable: process.execPath,
  args: ["-e", script],
  stdin: "private prompt",
  cwd: await temporaryDirectory(),
  timeoutMs: 2_000,
  maximumStdoutBytes: 1_048_576,
  maximumStderrBytes: 65_536,
  environment: {
    PATH: process.env.PATH,
  },
  ...overrides,
});

describe("ManagedChildProcessRunner", () => {
  it("spawns directly, writes the private prompt only to stdin, and cleans up", async () => {
    const spawnProcess = vi.fn<SpawnProcess>(
      (executable, args, options) =>
        nodeSpawn(
          executable,
          [...args],
          options,
        ),
    );
    const cleanup = vi.fn(async () => undefined);
    const runner = new ManagedChildProcessRunner({
      spawnProcess,
    });
    const input = await request(
      "process.stdin.pipe(process.stdout)",
      { cleanup },
    );

    const result = await runner.run(input);

    expect(spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      input.args,
      expect.objectContaining({
        shell: false,
        cwd: input.cwd,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    expect(input.args).not.toContain(input.stdin);
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "private prompt",
      stderr: "",
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it.each([
    {
      stream: "stdout",
      script: "process.stdout.write('x'.repeat(1000))",
      overrides: {
        maximumStdoutBytes: 32,
      },
    },
    {
      stream: "stderr",
      script: "process.stderr.write('x'.repeat(1000))",
      overrides: {
        maximumStderrBytes: 32,
      },
    },
  ])("bounds $stream before UTF-8 conversion", async (fixture) => {
    const runner = new ManagedChildProcessRunner();

    await expect(
      runner.run(
        await request(fixture.script, fixture.overrides),
      ),
    ).rejects.toMatchObject({
      code: "response_too_large",
    });
  });

  it("terminates a timed-out process group with a stable error", async () => {
    const killed: Array<[number, NodeJS.Signals]> = [];
    const runner = new ManagedChildProcessRunner({
      killProcessGroup: (pid, signal) => {
        killed.push([pid, signal]);
        process.kill(-pid, signal);
      },
    });

    await expect(
      runner.run(
        await request("setInterval(() => {}, 1000)", {
          timeoutMs: 30,
        }),
      ),
    ).rejects.toMatchObject({ code: "timeout" });

    if (process.platform !== "win32") {
      expect(killed[0]?.[0]).toBeGreaterThan(0);
      expect(killed[0]?.[1]).toBe("SIGTERM");
    }
  });

  it("terminates on external abort", async () => {
    const controller = new AbortController();
    const pending = new ManagedChildProcessRunner().run(
      await request("setInterval(() => {}, 1000)", {
        signal: controller.signal,
      }),
    );
    setTimeout(() => controller.abort(), 30);

    await expect(pending).rejects.toMatchObject({
      code: "cancelled",
    });
  });

  it("maps non-zero exit and sanitizes prompt, home, cwd, and bounded stderr", async () => {
    const cwd = await temporaryDirectory();
    const privateHome = "/Users/private-person";
    const runner = new ManagedChildProcessRunner();

    const failure = await runner
      .run({
        executable: process.execPath,
        args: [
          "-e",
          "process.stdin.on('data', value => process.stderr.write(value)); process.stdin.on('end', () => { process.stderr.write(` ${process.env.HOME} ${process.cwd()} ${'z'.repeat(3000)}`); process.exit(7); });",
        ],
        stdin: "private prompt",
        cwd,
        timeoutMs: 2_000,
        maximumStdoutBytes: 100,
        maximumStderrBytes: 10_000,
        environment: { HOME: privateHome },
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "process_failed",
      processExitCode: 7,
    });
    if (!(failure instanceof ManagedProcessError)) {
      throw new Error("Expected ManagedProcessError");
    }
    expect(failure.diagnosticExcerpt).not.toContain(
      "private prompt",
    );
    expect(failure.diagnosticExcerpt).not.toContain(
      privateHome,
    );
    expect(failure.diagnosticExcerpt).not.toContain(cwd);
    expect(failure.diagnosticExcerpt.length).toBeLessThanOrEqual(
      2_000,
    );
  });

  it("maps missing executables and rejects unsafe requests before spawn", async () => {
    const runner = new ManagedChildProcessRunner();
    const cwd = await temporaryDirectory();

    await expect(
      runner.run({
        executable: "/definitely/missing/model-client",
        args: [],
        stdin: "",
        cwd,
        timeoutMs: 100,
        maximumStdoutBytes: 100,
        maximumStderrBytes: 100,
        environment: {},
      }),
    ).rejects.toMatchObject({ code: "executable_missing" });
    await expect(
      runner.run({
        executable: "relative-client",
        args: [],
        stdin: "",
        cwd,
        timeoutMs: 100,
        maximumStdoutBytes: 100,
        maximumStderrBytes: 100,
        environment: {},
      }),
    ).rejects.toMatchObject({
      code: "invalid_configuration",
    });
    await expect(
      runner.run({
        executable: process.execPath,
        args: ["bad\u0000argument"],
        stdin: "",
        cwd,
        timeoutMs: 100,
        maximumStdoutBytes: 100,
        maximumStderrBytes: 100,
        environment: {},
      }),
    ).rejects.toMatchObject({
      code: "invalid_configuration",
    });
  });
});
