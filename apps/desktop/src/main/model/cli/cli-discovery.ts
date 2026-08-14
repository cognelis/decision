import {
  localModelClientStatusSchema,
  type LocalModelClientStatus,
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
}

const executableName = (
  client: LocalModelClient,
): string => (client === "codex" ? "codex" : "claude");

const clientKind = (
  client: LocalModelClient,
): LocalModelClientStatus["kind"] =>
  client === "codex" ? "codex-cli" : "claude-code-cli";

const findExecutable = async (
  client: LocalModelClient,
  configuredPath: string | undefined,
  environment: NodeJS.ProcessEnv,
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
    .split(delimiter)
    .filter((entry) => entry.length > 0);
  for (const directory of pathEntries) {
    const candidate = join(
      directory,
      executableName(client),
    );
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
  return { availability: "not_found" };
};

const versionFrom = (value: string): string | undefined =>
  value.match(/\b(\d+\.\d+\.\d+)\b/u)?.[1];

const includesEvery = (
  value: string,
  flags: string[],
): boolean => flags.every((flag) => value.includes(flag));

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

  constructor(
    options: LocalModelClientDiscoveryOptions = {},
  ) {
    this.#runner =
      options.runner ?? new ManagedChildProcessRunner();
    this.#environment =
      options.environment ?? process.env;
    this.#now = options.now ?? (() => new Date());
  }

  async inspect(
    client: LocalModelClient,
    configuredPath?: string,
  ): Promise<LocalModelClientStatus> {
    const kind = clientKind(client);
    const checkedAt = this.#now().toISOString();
    const resolved = await findExecutable(
      client,
      configuredPath,
      this.#environment,
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
      const outputs =
        client === "codex"
          ? await Promise.all([
              run(["--version"]),
              run(["login", "status"]),
              run(["doctor", "--json"]),
              run(["--help"]),
              run(["exec", "--help"]),
            ])
          : await Promise.all([
              run(["--version"]),
              run(["auth", "status", "--json"]),
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
        try {
          JSON.parse(outputs[2]!.stdout);
        } catch {
          diagnosticsValid = false;
        }
        supported = includesEvery(
          `${outputs[3]!.stdout}\n${outputs[3]!.stderr}`,
          codexGlobalFlags,
        ) && includesEvery(
          `${outputs[4]!.stdout}\n${outputs[4]!.stderr}`,
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
          diagnosticsValid = false;
        }
        supported = includesEvery(
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
      return localModelClientStatusSchema.parse({
        kind,
        executablePath,
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
