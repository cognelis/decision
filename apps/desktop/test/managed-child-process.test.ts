import {
  spawn as nodeSpawn,
} from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ManagedChildProcessRunner,
  ManagedProcessError,
  stopManagedProcesses,
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
  it("enforces a combined stdout/stderr cap without halving either individual stream budget", async () => {
    const runner=new ManagedChildProcessRunner();
    expect((await runner.run(await request("process.stdout.write('a'.repeat(80));process.stderr.write('b'.repeat(10))",{maximumOutputBytes:100}))).stdout).toHaveLength(80);
    await expect(runner.run(await request("process.stdout.write('a'.repeat(60));process.stderr.write('b'.repeat(60))",{maximumOutputBytes:100}))).rejects.toMatchObject({code:"response_too_large"});
  });
  it.skipIf(process.platform === "win32")("waits for SIGKILL of a TERM-ignoring child after its parent closes", async () => {
    const cwd = await temporaryDirectory();
    const marker = join(cwd, "alive");
    const ready = join(cwd, "ready");
    const childFile = join(cwd, "child.cjs");
    await writeFile(childFile, `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'survived'),1200);setInterval(()=>{},1000);`);
    const controller = new AbortController();
    let pid: number | undefined;
    const cleanup = vi.fn(async () => {
      expect(await readFile(marker, "utf8").catch(() => null)).toBeNull();
    });
    const kills: NodeJS.Signals[] = [];
    const runner = new ManagedChildProcessRunner({
      spawnProcess: (executable, args, options) => {
        const child = nodeSpawn(executable, [...args], options);
        pid = child.pid;
        return child;
      },
      killProcessGroup: (group, signal) => { kills.push(signal); process.kill(-group, signal); },
    });
    const pending = runner.run(await request(`require('node:child_process').spawn(process.execPath,[${JSON.stringify(childFile)}],{stdio:'ignore'});setInterval(()=>{},1000);`, { cwd, signal: controller.signal, cleanup })).catch(error => error);
    try {
      await vi.waitFor(async () => expect(await readFile(ready, "utf8")).toBe("ready"));
      controller.abort();
      expect(await pending).toMatchObject({ code: "cancelled" });
      expect(kills).toContain("SIGKILL");
      expect(cleanup).toHaveBeenCalledOnce();
      await new Promise(resolve => setTimeout(resolve, 1300));
      expect(await readFile(marker, "utf8").catch(() => null)).toBeNull();
    } finally {
      if (pid) try { process.kill(-pid, "SIGKILL"); } catch {}
    }
  });

  it("preserves bounded stdout/stderr for opted-in nonzero tool exits but still rejects timeouts", async () => {
    const runner = new ManagedChildProcessRunner();
    const output = await runner.run(await request("process.stdout.write('TAP version 13\\n# fail 1\\n');process.stderr.write('test diagnostic');process.exitCode=1", { acceptNonzeroExit: true }));
    expect(output).toMatchObject({ exitCode: 1, stdout: "TAP version 13\n# fail 1\n", stderr: "test diagnostic" });
    await expect(runner.run(await request("setInterval(()=>{},1000)", { acceptNonzeroExit: true, timeoutMs: 100 }))).rejects.toMatchObject({ code: "timeout" });
  });

  it("keeps stdin open for a bounded protocol exchange and closes it after completion", async () => {
    const input = await request("let n=0; process.stdin.on('data',()=>{process.stdout.write(++n===1?'ready\\n':'models\\n')}); process.stdin.on('end',()=>process.exit(0));", { stdin: "initialize\n" });
    let replied = false;
    const result = await new ManagedChildProcessRunner().run({ ...input, conversation: stdout => {
      if (stdout.includes("models")) return { complete: true };
      if (stdout.includes("ready") && !replied) { replied = true; return { input: "list\n" }; }
      return {};
    } });
    expect(result.stdout).toBe("ready\nmodels\n");
  });

  it("terminates a conversation that never completes", async () => {
    const input = await request("setInterval(()=>{},1000)", { timeoutMs: 50 });
    await expect(new ManagedChildProcessRunner().run({ ...input, conversation: () => ({}) })).rejects.toMatchObject({ code: "timeout" });
  });

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

  it("starts npm's .cmd shim through cmd on Windows, which starts none without a shell", async () => {
    const calls: Array<{ command: string; args: readonly string[]; verbatim: boolean | undefined }> = [];
    const runner = new ManagedChildProcessRunner({
      platform: "win32",
      spawnProcess: (command, args, options) => {
        calls.push({ command, args, verbatim: options.windowsVerbatimArguments });
        return nodeSpawn(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], options);
      },
      killProcessGroup: () => undefined,
    });

    await runner.run(await request("", { executable: "/npm/claude.cmd", args: ["-p", "--output-format", "json"] }));

    expect(calls).toEqual([{
      command: "cmd.exe",
      args: ["/d", "/s", "/v:off", "/c", '""/npm/claude.cmd" "-p" "--output-format" "json""'],
      verbatim: true,
    }]);
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

  it("stops every process still running when the app quits, from any runner", async () => {
    const killed: Array<[number, NodeJS.Signals]> = [];
    const killProcessGroup = (pid: number, signal: NodeJS.Signals): void => {
      killed.push([pid, signal]);
      process.kill(-pid, signal);
    };
    // Two adapters' runners, a call under way in each, neither with a signal to abort it.
    const first = new ManagedChildProcessRunner({ killProcessGroup }).run(await request("setInterval(() => {}, 1000)"));
    const second = new ManagedChildProcessRunner({ killProcessGroup }).run(await request("setInterval(() => {}, 1000)"));
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Started detached, each outlived the quit and ran its billed call to the end for nobody. Both are watched before
    // the stop: awaited one after the other, the second could reject first, unwatched for that moment.
    const outcomes = Promise.allSettled([first, second]);
    stopManagedProcesses();
    const [one, two] = await outcomes;
    expect(one).toMatchObject({ status: "rejected", reason: { code: "cancelled" } });
    expect(two).toMatchObject({ status: "rejected", reason: { code: "cancelled" } });
    if (process.platform !== "win32") expect(killed.filter(([, signal]) => signal === "SIGTERM")).toHaveLength(2);
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

  it.each([
    // Claude Code: one result object, marked is_error.
    ['{"type":"result","is_error":true,"result":"Credit balance is too low"}', "Credit balance is too low"],
    // Codex exec --json: events, one per line, the failure among them.
    ['{"type":"turn.started"}\n{"type":"turn.failed","error":{"message":"You have hit your usage limit"}}', "You have hit your usage limit"],
  ])("keeps the reason a client reports on stdout when it exits unsuccessfully", async (stdout, reason) => {
    const failure = await new ManagedChildProcessRunner()
      .run(await request(`process.stdout.write(${JSON.stringify(stdout)}); process.exitCode = 1;`))
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "process_failed", processExitCode: 1 });
    expect((failure as ManagedProcessError).diagnosticExcerpt).toContain(reason);
  });

  it("keeps a nested Codex error before noisy stderr can crowd it out", async () => {
    const stdout = JSON.stringify({ type: "error", error: { message: "Invalid schema: missing path", code: "invalid_json_schema" }, status: 400 });
    const failure = await new ManagedChildProcessRunner().run(await request(`process.stderr.write('warning '.repeat(1000)); process.stdout.write(${JSON.stringify(stdout)}); process.exitCode = 1;`)).catch(error => error);
    expect(failure.diagnosticExcerpt).toContain("missing path");
    expect(failure.diagnosticExcerpt).toContain("invalid_json_schema");
    expect(failure.diagnosticExcerpt.length).toBeLessThanOrEqual(2000);
  });

  it("keeps what a client's reported API error calls itself, never the body it quotes", async () => {
    // Claude Code reports an API error as "API Error: " and the SDK's message, which carries the whole response body,
    // and Codex as "unexpected status …: " and the body: a moderation refusal names the flagged input in it.
    const typed = "我们决定裁掉B项目团队";
    const failed = async (overrides: Parameters<typeof request>) => new ManagedChildProcessRunner()
      .run(await request(...overrides))
      .then(() => { throw new Error("expected the client to fail"); }, (error: unknown) => error as ManagedProcessError);
    const body = JSON.stringify({ error: { code: 403, message: "Your input was flagged for \"harassment\".", metadata: { reasons: ["harassment"], flagged_input: typed } } });
    for (const [stdout, kept] of [
      [JSON.stringify({ type: "result", is_error: true, result: `API Error: 403 ${body}` }), "API Error: 403"],
      [`{"type":"turn.started"}\n${JSON.stringify({ type: "turn.failed", error: { message: `unexpected status 403 Forbidden: ${body}` } })}`, "unexpected status 403"],
      [JSON.stringify({ type: "error", message: `unexpected status 403 Forbidden: ${body}` }), "unexpected status 403"],
      // A body cut short is not read: only what came before it is kept.
      [JSON.stringify({ type: "result", is_error: true, result: `API Error: 500 {"error":{"message":"${typed}` }), "API Error: 500"],
    ] as const) {
      const failure = await failed([`process.stdout.write(${JSON.stringify(stdout)}); process.exitCode = 1;`]);

      expect(failure.diagnosticExcerpt).not.toContain(typed);
      expect(failure.diagnosticExcerpt).toContain(kept);
    }

    // A reason with no body is kept to 300 characters, cleaned before it is cut: a path across the cut goes whole.
    const home = "/Users/private-person";
    const failure = await failed([
      `process.stdout.write(${JSON.stringify(JSON.stringify({ type: "result", is_error: true, result: `${"w".repeat(290)}${home}/.claude is unreadable ${"v".repeat(500)}` }))}); process.exitCode = 1;`,
      { environment: { PATH: process.env.PATH, HOME: home } },
    ]);
    expect(failure.diagnosticExcerpt).not.toContain("/Users/");
    expect(failure.diagnosticExcerpt).not.toContain("v".repeat(100));
  });

  it("leaves what else a failed client printed on stdout out of the diagnostic: it may be the answer", async () => {
    const failure = await new ManagedChildProcessRunner()
      .run(await request("process.stdout.write('{\"answer\":\"私密的回答\"}'); process.exitCode = 1;"))
      .catch((error: unknown) => error);

    expect((failure as ManagedProcessError).diagnosticExcerpt).not.toContain("私密的回答");
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
