import { queryCliModels } from "./cli-model-catalog.js";
import type { ModelProviderProfile, ModelProxy } from "@cognelis/decision-protocol";
import { providerProxyEnvironment, proxyEnvironmentNames } from "../provider-network.js";
import {
  localModelClientStatusSchema,
  type LocalModelClientStatus,
  type ModelInvocationErrorCode,
} from "@cognelis/decision-protocol";
import {
  access,
  stat,
} from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import {
  delimiter,
  isAbsolute,
  join,
} from "node:path";

import {
  ManagedChildProcessRunner,
  ManagedProcessError,
  type ManagedProcessRequest,
  type ManagedProcessResult,
} from "./managed-child-process.js";

export type LocalModelClient = "codex" | "claude-code";

interface ProcessRunnerLike {
  run(
    request: ManagedProcessRequest,
  ): Promise<ManagedProcessResult>;
}

export interface LocalModelClientDiscoveryOptions {
  runner?: ProcessRunnerLike;
  environment?: NodeJS.ProcessEnv;
  now?: () => Date;
  platform?: NodeJS.Platform;
  cacheDirectory?: string;
}

const executableName = (
  client: LocalModelClient,
): string => (client === "codex" ? "codex" : "claude");

const clientKind = (
  client: LocalModelClient,
): LocalModelClientStatus["kind"] =>
  client === "codex" ? "codex-cli" : "claude-code-cli";

export const localModelClientErrorCode = (
  availability:
    | LocalModelClientStatus["availability"]
    | undefined,
): ModelInvocationErrorCode => {
  switch (availability) {
    case "not_found":
    case "not_executable":
      return "executable_missing";
    case "logged_out":
      return "credential_unavailable";
    case "unsupported":
      return "unsupported_client";
    case "diagnostics_failed":
    case "available":
    case undefined:
      return "process_failed";
  }
};

const findExecutable = async (
  client: LocalModelClient,
  configuredPath: string | undefined,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<{
  path?: string;
  availability?: "not_found" | "not_executable";
}> => {
  if (configuredPath !== undefined) {
    if (!isAbsolute(configuredPath)) {
      return {
        path: configuredPath,
        availability: "not_executable",
      };
    }
    try {
      const metadata = await stat(configuredPath);
      await access(configuredPath, constants.X_OK);
      return metadata.isFile()
        ? { path: configuredPath }
        : {
            path: configuredPath,
            availability: "not_executable",
          };
    } catch {
      return {
        path: configuredPath,
        availability: "not_executable",
      };
    }
  }
  const pathEntries = (environment.PATH ?? "")
    .split(platform === "win32" ? ";" : delimiter)
    .filter((entry) => entry.length > 0);
  // On Windows a command is a file with one of PATHEXT's extensions, claude.exe from the installer before
  // claude.cmd from npm: the bare name npm also leaves there is a shell script only Git Bash can run.
  const names = platform === "win32"
    ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .filter((extension) => extension.length > 0)
        .map((extension) => `${executableName(client)}${extension.toLowerCase()}`)
    : [executableName(client)];
  for (const directory of pathEntries) {
    for (const name of names) {
      const candidate = join(directory, name);
      try {
        const metadata = await stat(candidate);
        await access(candidate, constants.X_OK);
        if (metadata.isFile()) {
          return { path: candidate };
        }
      } catch {
        // Continue through the exact PATH entries.
      }
    }
  }
  return { availability: "not_found" };
};

const versionFrom = (value: string): string | undefined =>
  value.match(/\b(\d+\.\d+\.\d+)\b/u)?.[1];

const includesEveryOption = (
  value: string,
  flags: string[],
): boolean => {
  const options = new Set(
    value.match(/--[^\s,=]+/gu) ?? [],
  );
  return flags.every((flag) => options.has(flag));
};

const codexGlobalFlags = ["--ask-for-approval"];

const codexExecFlags = [
  "--ephemeral",
  "--json",
  "--ignore-user-config",
  "--output-schema",
  "--sandbox",
  "--skip-git-repo-check",
  "--cd",
  "--model",
];

const claudeFlags = [
  "--safe-mode",
  "--tools",
  "--disallowedTools",
  "--no-session-persistence",
  "--permission-mode",
  "--output-format",
  "--json-schema",
  "--model",
];

export class LocalModelClientDiscovery {
  readonly #runner: ProcessRunnerLike;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #now: () => Date;
  readonly #platform: NodeJS.Platform;
  readonly #cacheDirectory: string | undefined;

  constructor(
    options: LocalModelClientDiscoveryOptions = {},
  ) {
    this.#runner =
      options.runner ?? new ManagedChildProcessRunner();
    this.#environment =
      options.environment ?? process.env;
    this.#now = options.now ?? (() => new Date());
    this.#platform = options.platform ?? process.platform;
    this.#cacheDirectory = options.cacheDirectory;
  }

  /**
   * Both clients, as their profiles name them. `onlyEnabled`: a client whose profile is off keeps what it was
   * last found to be (`known`) and is looked at when the models page asks. Found once, a disabled built-in kept
   * its path, and every launch ran its seven diagnostics before the window opened.
   */
  async inspectProfiles(
    profiles: readonly ModelProviderProfile[],
    options: { onlyEnabled: boolean; known: readonly LocalModelClientStatus[] },
  ): Promise<LocalModelClientStatus[]> {
    const look = async (client: LocalModelClient): Promise<LocalModelClientStatus[]> => {
      const profile = profiles.find((item) => item.kind === clientKind(client));
      if (options.onlyEnabled && profile?.enabled !== true) {
        return options.known.filter((status) => status.kind === clientKind(client));
      }
      return [await this.inspect(client, profile?.executablePath, profile?.proxy, !options.onlyEnabled)];
    };
    return (await Promise.all([look("codex"), look("claude-code")])).flat();
  }

  async inspect(
    client: LocalModelClient,
    configuredPath?: string,
    proxy?: ModelProxy,
    includeModels = true,
  ): Promise<LocalModelClientStatus> {
    const kind = clientKind(client);
    const checkedAt = this.#now().toISOString();
    const resolved = await findExecutable(
      client,
      configuredPath,
      this.#environment,
      this.#platform,
    );
    if (resolved.availability !== undefined) {
      return localModelClientStatusSchema.parse({
        kind,
        ...(resolved.path === undefined
          ? {}
          : { executablePath: resolved.path }),
        authenticated: false,
        supported: false,
        availability: resolved.availability,
        checkedAt,
      });
    }
    const executablePath = resolved.path!;
    try {
      const environment: NodeJS.ProcessEnv = {
        ...this.#environment,
        DECISION_PROVIDER_CHILD: "1",
      };
      for (const name of proxyEnvironmentNames) delete environment[name];
      Object.assign(environment, providerProxyEnvironment(this.#environment, proxy));
      const run = (args: string[]) =>
        this.#runner.run({
          executable: executablePath,
          args,
          stdin: "",
          cwd: tmpdir(),
          timeoutMs: 2_000,
          maximumStdoutBytes: 256 * 1_024,
          maximumStderrBytes: 64 * 1_024,
          environment,
        });
      // `codex login status` and `claude auth status` exit 1 to say "Not logged in": an answer about the
      // account, not a client that failed its diagnostics.
      const loginStatus = (args: string[]) =>
        run(args).catch((error: unknown) => {
          if (!(error instanceof ManagedProcessError) || error.code !== "process_failed") throw error;
          return { exitCode: error.processExitCode ?? -1, stdout: "", stderr: error.diagnosticExcerpt, durationMs: 0 };
        });
      const outputs =
        client === "codex"
          ? await Promise.all([
              run(["--version"]),
              loginStatus(["login", "status"]),
              run(["--help"]),
              run(["exec", "--help"]),
            ])
          : await Promise.all([
              run(["--version"]),
              loginStatus(["auth", "status", "--json"]),
              run(["--help"]),
            ]);
      const version = versionFrom(
        `${outputs[0]!.stdout}\n${outputs[0]!.stderr}`,
      );
      let authenticated = false;
      let supported = false;
      let diagnosticsValid = version !== undefined;
      if (client === "codex") {
        authenticated = /^Logged in\b/imu.test(
          `${outputs[1]!.stdout}\n${outputs[1]!.stderr}`,
        );
        supported = includesEveryOption(
          `${outputs[2]!.stdout}\n${outputs[2]!.stderr}`,
          codexGlobalFlags,
        ) && includesEveryOption(
          `${outputs[3]!.stdout}\n${outputs[3]!.stderr}`,
          codexExecFlags,
        );
      } else {
        try {
          const auth = JSON.parse(
            outputs[1]!.stdout,
          ) as Record<string, unknown>;
          authenticated =
            auth.loggedIn === true ||
            auth.authenticated === true;
        } catch {
          // Logged out, it may say so by its exit code alone.
          if (outputs[1]!.exitCode !== 1) diagnosticsValid = false;
        }
        supported = includesEveryOption(
          `${outputs[2]!.stdout}\n${outputs[2]!.stderr}`,
          claudeFlags,
        );
      }
      const availability =
        !diagnosticsValid
          ? "diagnostics_failed"
          : !supported
            ? "unsupported"
            : !authenticated
              ? "logged_out"
              : "available";
      const catalog = includeModels
        ? await queryCliModels(client, { executable: executablePath, cwd: tmpdir(), environment, timeoutMs: 8_000, maximumStdoutBytes: 1024 * 1024, maximumStderrBytes: 64 * 1024 }, this.#runner, this.#cacheDirectory, authenticated && supported, version)
        : { models: [] };
      const { models } = catalog;
      return localModelClientStatusSchema.parse({
        kind,
        executablePath,
        ...(models.length ? { models, modelsSource: catalog.modelsSource } : {}),
        ...(version === undefined ? {} : { version }),
        authenticated,
        supported,
        availability,
        checkedAt,
      });
    } catch {
      return localModelClientStatusSchema.parse({
        kind,
        executablePath,
        authenticated: false,
        supported: false,
        availability: "diagnostics_failed",
        checkedAt,
      });
    }
  }
}
