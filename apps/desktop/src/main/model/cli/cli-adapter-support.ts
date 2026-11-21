import { ModelProviderError } from "../http-model-transport.js";
import type { ModelProxy } from "@cognelis/decision-protocol";
import { ModelNetworkPolicy } from "../provider-network.js";
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
  proxy?: ModelProxy,
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
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
    "CODEX_CA_CERTIFICATE",
    // What a process needs on Windows to start, reach the network (Winsock wants SystemRoot), find its own
    // files and sign in; there for no one else.
    "SystemRoot",
    "windir",
    "ComSpec",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "HOMEDRIVE",
    "HOMEPATH",
    ...extraNames,
  ] as const;
  const environment: NodeJS.ProcessEnv = {};
  for (const name of inheritedNames) {
    const value = source[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  for (const name of Object.keys(environment)) if (/proxy/iu.test(name)) delete environment[name];
  try { Object.assign(environment, new ModelNetworkPolicy(source).cliEnvironment(proxy)); }
  catch { throw new ModelProviderError("invalid_configuration", "CLI model network policy requires a valid proxy and forbids DIRECT/bypass rules"); }
  environment.PARASELF_PROVIDER_CHILD = "1";
  // A Decision-era bridge still hooked into the client until it reconnects reads only the old name.
  environment.DECISION_PROVIDER_CHILD = "1";
  return environment;
};
