import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  join,
  resolve,
} from "node:path";

const DIRECTORY_PREFIX =
  "decision-model-provider-";

export interface CliWorkspace {
  directory: string;
  schemaPath: string;
  cleanup(): Promise<void>;
}

export const createCliWorkspace =
  async (
    outputSchema: Record<string, unknown>,
  ): Promise<CliWorkspace> => {
    const temporaryRoot = resolve(tmpdir());
    const directory = await mkdtemp(
      join(temporaryRoot, DIRECTORY_PREFIX),
    );
    const schemaPath = join(directory, "output-schema.json");
    await writeFile(
      schemaPath,
      `${JSON.stringify(outputSchema)}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      },
    );
    return {
      directory,
      schemaPath,
      cleanup: async () => {
        const resolved = resolve(directory);
        if (
          dirname(resolved) !== temporaryRoot ||
          !basename(resolved).startsWith(DIRECTORY_PREFIX)
        ) {
          throw new Error(
            "Refusing to remove an invalid model provider workspace",
          );
        }
        await rm(resolved, { recursive: true, force: true });
      },
    };
  };

export const minimalClientEnvironment = (
  source: NodeJS.ProcessEnv,
  extraNames: readonly string[] = [],
): NodeJS.ProcessEnv => {
  const inheritedNames = [
    "HOME",
    "USER",
    "PATH",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "CODEX_HOME",
    "VOLTA_HOME",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
    ...extraNames,
  ] as const;
  const environment: NodeJS.ProcessEnv = {};
  for (const name of inheritedNames) {
    const value = source[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  environment.DECISION_PROVIDER_CHILD = "1";
  return environment;
};
