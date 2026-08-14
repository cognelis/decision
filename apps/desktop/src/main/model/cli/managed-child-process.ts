import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { isAbsolute } from "node:path";

import type {
  ModelInvocationErrorCode,
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

export class ManagedChildProcessRunner {
  readonly #spawnProcess: SpawnProcess;
  readonly #killProcessGroup: (
    pid: number,
    signal: NodeJS.Signals,
  ) => void;
  readonly #clock: () => number;

  constructor(
    options: ManagedChildProcessRunnerOptions = {},
  ) {
    this.#spawnProcess =
      options.spawnProcess ?? (spawn as SpawnProcess);
    this.#killProcessGroup =
      options.killProcessGroup ??
      ((pid, signal) => process.kill(-pid, signal));
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
        child = this.#spawnProcess(
          request.executable,
          request.args,
          {
            shell: false,
            cwd: request.cwd,
            detached: process.platform !== "win32",
            stdio: ["pipe", "pipe", "pipe"],
            env: request.environment,
            windowsHide: true,
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
      let forceKillTimer: NodeJS.Timeout | undefined;
      let forceFinishTimer: NodeJS.Timeout | undefined;

      const clear = (): void => {
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
          if (
            process.platform !== "win32" &&
            typeof pid === "number" &&
            pid > 0
          ) {
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
            if (
              process.platform !== "win32" &&
              typeof pid === "number" &&
              pid > 0
            ) {
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
        if (code !== 0) {
          finishError(
            new ManagedProcessError(
              "process_failed",
              "Managed model process exited unsuccessfully",
              {
                processExitCode: code,
                diagnosticExcerpt: sanitize(
                  Buffer.concat(
                    stderr,
                    stderrBytes,
                  ).toString("utf8"),
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
      child.stdin.end(request.stdin);
    });
  }
}
