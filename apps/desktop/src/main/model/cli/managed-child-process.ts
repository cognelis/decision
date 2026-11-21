import { ModelNetworkPolicy, proxyPrivateValues } from "../provider-network.js";
import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { isAbsolute } from "node:path";

import { commandInvocation } from "@cognelis/decision-integrations";
import {
  clipText,
  type ModelInvocationErrorCode,
  type ModelInvocationInput,
} from "@cognelis/decision-protocol";
import { describedError } from "../http-model-transport.js";

export interface ManagedProcessRequest {
  provider?: string;
  model?: string | undefined;
  executable: string;
  args: string[];
  stdin: string;
  cwd: string;
  timeoutMs: number;
  maximumStdoutBytes: number;
  maximumStderrBytes: number;
  /** Optional combined cap for tools whose stdout and stderr share one log. */
  maximumOutputBytes?: number;
  environment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Tool commands may report test failures as data; model clients keep the default rejection. */
  acceptNonzeroExit?: boolean;
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
  modelNetworkPolicy?: "required";
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
    !validLimit(request.maximumStderrBytes) ||
    (request.maximumOutputBytes !== undefined && !validLimit(request.maximumOutputBytes))
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
 * A reason a client reported, as a diagnostic keeps it. Claude Code reports an API error as "API Error: " and the
 * SDK's message, which carries the whole response body, and Codex as "unexpected status …: " and the body, where a
 * moderation refusal names the flagged input: the body is kept down to what its error calls itself, as the HTTP
 * transport keeps it, and one that is not JSON to the text before it. A reason with no body is kept to 300
 * characters. Cleaned before it is cut, as describedError says why.
 */
const describedReason = (reason: string, clean: (value: string) => string): string => {
  const start = reason.indexOf("{");
  if (start < 0) return clipText(clean(reason), 300);
  const lead = clipText(clean(reason.slice(0, start)).trim(), 300);
  let said: string | undefined;
  try {
    said = describedError(JSON.parse(reason.slice(start, reason.lastIndexOf("}") + 1)), clean);
  } catch {
    said = `(${reason.length - start} characters that are not JSON)`;
  }
  return [lead, said].filter((part) => part !== undefined && part.length > 0).join(" ");
};

/**
 * Why a client says it failed, where it says so on stdout rather than stderr: Claude Code's result
 * marked is_error ("Credit balance is too low"), or a Codex event of type error or turn.failed. Only
 * these: anything else on stdout may be the model's answer, which a diagnostic must not hold.
 */
const reportedFailure = (stdout: string, clean: (value: string) => string): string | null => {
  const reasonOf = (value: unknown): string | null => {
    if (value === null || typeof value !== "object") return null;
    const event = value as Record<string, unknown>;
    if (event.is_error === true && typeof event.result === "string") return describedReason(event.result, clean);
    if (event.type === "error" && typeof event.message === "string") return describedReason(event.message, clean);
    const error = event.error as Record<string, unknown> | undefined;
    if ((event.type === "turn.failed" || event.type === "error") && typeof error?.message === "string") return JSON.stringify({
      message: describedReason(error.message, clean),
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
    ...Object.entries(request.environment).filter(([name]) => /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH/iu.test(name)).map(([, value]) => value),
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
  readonly #modelNetworkPolicy: "required" | undefined;
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
    this.#modelNetworkPolicy = options.modelNetworkPolicy;
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
    let route = "blocked", result = "blocked", errorCode: string | undefined;
    try {
      validateRequest(request);
      if (this.#modelNetworkPolicy === "required") {
        try {
          const proxy = new ModelNetworkPolicy(request.environment).cliEnvironment();
          const environment = Object.fromEntries(Object.entries(request.environment).filter(([name]) => !/proxy/iu.test(name)));
          request = { ...request, environment: { ...environment, ...proxy } };
          route = "proxy"; result = "failed";
        } catch {
          throw new ManagedProcessError("invalid_configuration", "CLI model network policy requires a valid MODEL_PROXY_URL; DIRECT and bypass rules are forbidden");
        }
      }
      if (request.signal?.aborted === true) {
        throw new ManagedProcessError(
          "cancelled",
          "Managed model process was cancelled",
        );
      }
      const output = await this.#runValidated(request);
      result = "succeeded";
      return output;
    } catch (error) {
      errorCode = error instanceof ManagedProcessError ? error.code : "process_failed";
      throw error;
    } finally {
      if (this.#modelNetworkPolicy === "required") {
        try { console.info("model-network", JSON.stringify({ provider: sanitize(request.provider ?? "cli", request), model: sanitize(request.model ?? "catalog", request), policy: "required", route, result, ...(errorCode === undefined ? {} : { errorCode }) })); } catch {}
      }
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
      let parentClosed = false;
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
          if (parentClosed) {
            finishError(error);
            return;
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
        if (request.maximumOutputBytes !== undefined && stdoutBytes + stderrBytes > request.maximumOutputBytes) {
          terminate(new ManagedProcessError("response_too_large", "Managed process output exceeded the combined limit"));
          return;
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
        parentClosed = true;
        if (finished) {
          return;
        }
        if (terminalError !== undefined) {
          // close only describes the parent. A child can close stdio and ignore TERM;
          // retain the group KILL timer and delay cleanup/settlement until it fires.
          return;
        }
        // A successful CLI must not leave background writers in its process group.
        if (this.#platform !== "win32" && child.pid) {
          try { this.#killProcessGroup(child.pid, "SIGKILL"); } catch {}
        }
        const code = exitCode ?? -1;
        // A control-only client may exit nonzero on EOF because no user turn was supplied.
        if (code !== 0 && !conversationComplete && !(request.acceptNonzeroExit && exitCode !== null)) {
          finishError(
            new ManagedProcessError(
              "process_failed",
              "Managed model process exited unsuccessfully",
              {
                processExitCode: code,
                diagnosticExcerpt: sanitize(
                  [
                    reportedFailure(Buffer.concat(stdout, stdoutBytes).toString("utf8"), (value) => sanitize(value, request)),
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
