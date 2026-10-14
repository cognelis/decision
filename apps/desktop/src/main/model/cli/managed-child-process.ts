import { proxyPrivateValues } from "../provider-network.js";
import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { isAbsolute } from "node:path";

import { commandInvocation } from "@cognelis/decision-integrations";
import type {
  ModelInvocationErrorCode,
  ModelInvocationInput,
} from "@cognelis/decision-protocol";

export interface ManagedProcessRequest {
  executable: string;
  args: string[];
  stdin: string;
  cwd: string;
  timeoutMs: number;
  maximumStdoutBytes: number;
  maximumStderrBytes: number;
  environment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  cleanup?: () => Promise<void> | void;
  /** Bounded control-protocol exchange; completing closes stdin without starting a model turn. */
  conversation?: (stdout: string) => { input?: string; complete?: boolean };
}

export interface ManagedProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export class ManagedProcessError extends Error {
  readonly code: ModelInvocationErrorCode;
  readonly diagnosticExcerpt: string;
  traceInput?: ModelInvocationInput;
  readonly processExitCode: number | undefined;

  constructor(
    code: ModelInvocationErrorCode,
    message: string,
    options: {
      diagnosticExcerpt?: string;
      processExitCode?: number;
    } = {},
  ) {
    super(message);
    this.name = "ManagedProcessError";
    this.code = code;
    this.diagnosticExcerpt =
      options.diagnosticExcerpt ?? message;
    this.processExitCode = options.processExitCode;
  }
}

export type SpawnProcess = (
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & {
    stdio: ["pipe", "pipe", "pipe"];
  },
) => ChildProcessWithoutNullStreams;

export interface ManagedChildProcessRunnerOptions {
  spawnProcess?: SpawnProcess;
  killProcessGroup?: (
    pid: number,
    signal: NodeJS.Signals,
  ) => void;
  clock?: () => number;
  platform?: NodeJS.Platform;
}

const validLimit = (value: number): boolean =>
  Number.isInteger(value) && value > 0;

const validateRequest = (
  request: ManagedProcessRequest,
): void => {
  if (
    !isAbsolute(request.executable) ||
    !isAbsolute(request.cwd) ||
    request.executable.includes("\u0000") ||
    request.cwd.includes("\u0000") ||
    request.args.some((argument) =>
      argument.includes("\u0000"),
    ) ||
    !validLimit(request.timeoutMs) ||
    !validLimit(request.maximumStdoutBytes) ||
    !validLimit(request.maximumStderrBytes)
  ) {
    throw new ManagedProcessError(
      "invalid_configuration",
      "Managed model process configuration is invalid",
    );
  }
};

const replaceAll = (
  value: string,
  search: string,
): string =>
  search.length === 0
    ? value
    : value.split(search).join("[redacted]");

/**
 * Why a client says it failed, where it says so on stdout rather than stderr: Claude Code's result
 * marked is_error ("Credit balance is too low"), or a Codex event of type error or turn.failed. Only
 * these: anything else on stdout may be the model's answer, which a diagnostic must not hold.
 */
const reportedFailure = (stdout: string): string | null => {
  const reasonOf = (value: unknown): string | null => {
    if (value === null || typeof value !== "object") return null;
    const event = value as Record<string, unknown>;
    if (event.is_error === true && typeof event.result === "string") return event.result;
    if (event.type === "error" && typeof event.message === "string") return event.message;
    const error = event.error as Record<string, unknown> | undefined;
    if ((event.type === "turn.failed" || event.type === "error") && typeof error?.message === "string") return JSON.stringify({
      message: error.message,
      ...(typeof error.code === "string" && /^[a-z_]{1,80}$/u.test(error.code) ? { code: error.code } : {}),
      ...(typeof event.status === "number" && Number.isInteger(event.status) && event.status >= 100 && event.status <= 599 ? { status: event.status } : {}),
    });
    return null;
  };
  const parse = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  const whole = reasonOf(parse(stdout.trim()));
  if (whole !== null) return whole;
  for (const line of stdout.split("\n").reverse()) {
    const reason = line.trim().startsWith("{") ? reasonOf(parse(line.trim())) : null;
    if (reason !== null) return reason;
  }
  return null;
};

const sanitize = (
  value: string,
  request: ManagedProcessRequest,
): string => {
  let sanitized = value
    .replace(
      /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu,
      "Bearer [redacted]",
    )
    .replace(
      /\b(?:sk|key|token)-[A-Za-z0-9._-]{8,}/giu,
      "[redacted]",
    );
  const privateValues = [
    ...proxyPrivateValues(request.environment),
    request.stdin,
    request.cwd,
    request.environment.HOME,
    request.environment.CODEX_HOME,
    request.environment.CLAUDE_CONFIG_DIR,
  ]
    .filter(
      (candidate): candidate is string =>
        typeof candidate === "string" &&
        candidate.length > 0,
    )
    .sort((left, right) => right.length - left.length);
  for (const privateValue of privateValues) {
    sanitized = replaceAll(sanitized, privateValue);
  }
  return sanitized.slice(0, 2_000);
};

// Every model process running, as each runner stops it when cancelled. Started in a group of their own (detached),
// they outlived a quit: a billed CLI call ran to its end for nobody, unless stopped here.
const running = new Set<() => void>();

/** Cancels every model process still running, from any runner: for a quit. */
export const stopManagedProcesses = (): void => {
  for (const stop of [...running]) stop();
};

export class ManagedChildProcessRunner {
  readonly #spawnProcess: SpawnProcess;
  readonly #killProcessGroup: (
    pid: number,
    signal: NodeJS.Signals,
  ) => void;
  readonly #clock: () => number;
  readonly #platform: NodeJS.Platform;

  constructor(
    options: ManagedChildProcessRunnerOptions = {},
  ) {
    this.#platform = options.platform ?? process.platform;
    this.#spawnProcess =
      options.spawnProcess ?? (spawn as SpawnProcess);
    this.#killProcessGroup =
      options.killProcessGroup ??
      (this.#platform === "win32"
        // No process groups: the tree goes from its root, the cmd a shim runs in and the client under it alike.
        ? (pid) => {
            execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => undefined);
          }
        : (pid, signal) => process.kill(-pid, signal));
    this.#clock = options.clock ?? (() => performance.now());
  }

  async run(
    request: ManagedProcessRequest,
  ): Promise<ManagedProcessResult> {
    try {
      validateRequest(request);
      if (request.signal?.aborted === true) {
        throw new ManagedProcessError(
          "cancelled",
          "Managed model process was cancelled",
        );
      }
      return await this.#runValidated(request);
    } finally {
      await request.cleanup?.();
    }
  }

  #runValidated(
    request: ManagedProcessRequest,
  ): Promise<ManagedProcessResult> {
    const startedAt = this.#clock();
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        // A .cmd or .bat (npm's shim for claude and codex) runs only through cmd: Node refuses to start one
        // without a shell, since its fix for batch argument injection.
        const invocation = this.#platform === "win32" && /\.(?:cmd|bat)$/iu.test(request.executable)
          ? commandInvocation(request.executable, request.args, { platform: this.#platform })
          : { command: request.executable, args: request.args, windowsVerbatimArguments: false };
        child = this.#spawnProcess(
          invocation.command,
          invocation.args,
          {
            shell: false,
            cwd: request.cwd,
            detached: this.#platform !== "win32",
            stdio: ["pipe", "pipe", "pipe"],
            env: request.environment,
            windowsHide: true,
            windowsVerbatimArguments: invocation.windowsVerbatimArguments,
          },
        );
      } catch (error) {
        reject(
          new ManagedProcessError(
            error !== null &&
              typeof error === "object" &&
              "code" in error &&
              error.code === "ENOENT"
              ? "executable_missing"
              : "process_failed",
            "Managed model process could not be started",
          ),
        );
        return;
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let terminalError: ManagedProcessError | undefined;
      let finished = false;
      let conversationComplete = false;
      let forceKillTimer: NodeJS.Timeout | undefined;
      let forceFinishTimer: NodeJS.Timeout | undefined;

      const clear = (): void => {
        running.delete(onAbort);
        clearTimeout(timeoutTimer);
        if (forceKillTimer !== undefined) {
          clearTimeout(forceKillTimer);
        }
        if (forceFinishTimer !== undefined) {
          clearTimeout(forceFinishTimer);
        }
        request.signal?.removeEventListener(
          "abort",
          onAbort,
        );
      };

      const finishError = (
        error: ManagedProcessError,
      ): void => {
        if (finished) {
          return;
        }
        finished = true;
        clear();
        reject(error);
      };

      const terminate = (
        error: ManagedProcessError,
      ): void => {
        if (finished || terminalError !== undefined) {
          return;
        }
        terminalError = error;
        const pid = child.pid;
        try {
          if (typeof pid === "number" && pid > 0) {
            this.#killProcessGroup(pid, "SIGTERM");
          } else {
            child.kill("SIGTERM");
          }
        } catch {
          child.kill("SIGTERM");
        }
        forceKillTimer = setTimeout(() => {
          if (finished) {
            return;
          }
          try {
            if (typeof pid === "number" && pid > 0) {
              this.#killProcessGroup(pid, "SIGKILL");
            } else {
              child.kill("SIGKILL");
            }
          } catch {
            child.kill("SIGKILL");
          }
          forceFinishTimer = setTimeout(
            () => finishError(error),
            500,
          );
          forceFinishTimer.unref();
        }, 500);
        forceKillTimer.unref();
      };

      const addChunk = (
        target: Buffer[],
        chunk: Buffer | string,
        stream: "stdout" | "stderr",
      ): void => {
        const buffer = Buffer.from(chunk);
        if (stream === "stdout") {
          stdoutBytes += buffer.byteLength;
          if (
            stdoutBytes > request.maximumStdoutBytes
          ) {
            terminate(
              new ManagedProcessError(
                "response_too_large",
                "Managed model process stdout exceeded the configured limit",
              ),
            );
            return;
          }
        } else {
          stderrBytes += buffer.byteLength;
          if (
            stderrBytes > request.maximumStderrBytes
          ) {
            terminate(
              new ManagedProcessError(
                "response_too_large",
                "Managed model process stderr exceeded the configured limit",
              ),
            );
            return;
          }
        }
        target.push(buffer);
        if (stream === "stdout" && request.conversation && !conversationComplete && !terminalError) {
          try {
            const response = request.conversation(Buffer.concat(stdout, stdoutBytes).toString("utf8"));
            if (response.input) child.stdin.write(response.input);
            if (response.complete) { conversationComplete = true; child.stdin.end(); }
          } catch {
            terminate(new ManagedProcessError("invalid_output", "Client control protocol returned an invalid response"));
          }
        }
      };

      child.stdout.on("data", (chunk: Buffer | string) =>
        addChunk(stdout, chunk, "stdout"),
      );
      child.stderr.on("data", (chunk: Buffer | string) =>
        addChunk(stderr, chunk, "stderr"),
      );
      child.once("error", (error) => {
        finishError(
          new ManagedProcessError(
            "code" in error && error.code === "ENOENT"
              ? "executable_missing"
              : "process_failed",
            "Managed model process could not be started",
            {
              diagnosticExcerpt: sanitize(
                error.message,
                request,
              ),
            },
          ),
        );
      });
      child.once("close", (exitCode) => {
        if (finished) {
          return;
        }
        if (terminalError !== undefined) {
          finishError(terminalError);
          return;
        }
        const code = exitCode ?? -1;
        // A control-only client may exit nonzero on EOF because no user turn was supplied.
        if (code !== 0 && !conversationComplete) {
          finishError(
            new ManagedProcessError(
              "process_failed",
              "Managed model process exited unsuccessfully",
              {
                processExitCode: code,
                diagnosticExcerpt: sanitize(
                  [
                    reportedFailure(Buffer.concat(stdout, stdoutBytes).toString("utf8")),
                    Buffer.concat(stderr, stderrBytes).toString("utf8").trim(),
                  ]
                    .filter((part): part is string => part !== null && part.length > 0)
                    .join("\n"),
                  request,
                ),
              },
            ),
          );
          return;
        }
        finished = true;
        clear();
        resolve({
          exitCode: code,
          stdout: Buffer.concat(
            stdout,
            stdoutBytes,
          ).toString("utf8"),
          stderr: Buffer.concat(
            stderr,
            stderrBytes,
          ).toString("utf8"),
          durationMs: Math.max(
            0,
            this.#clock() - startedAt,
          ),
        });
      });

      const onAbort = (): void =>
        terminate(
          new ManagedProcessError(
            "cancelled",
            "Managed model process was cancelled",
          ),
        );
      request.signal?.addEventListener("abort", onAbort, {
        once: true,
      });
      running.add(onAbort);
      const timeoutTimer = setTimeout(
        () =>
          terminate(
            new ManagedProcessError(
              "timeout",
              "Managed model process timed out",
            ),
          ),
        request.timeoutMs,
      );
      timeoutTimer.unref();
      child.stdin.once("error", () => undefined);
      if (request.conversation) child.stdin.write(request.stdin);
      else child.stdin.end(request.stdin);
    });
  }
}
