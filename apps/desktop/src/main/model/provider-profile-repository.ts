import {
  modelProviderProfileSchema,
  modelProviderProfilesDocumentSchema,
  type LocalModelClientStatus,
  type ModelProviderProfile,
} from "@cognelis/decision-protocol";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

export const BUILT_IN_PROVIDER_IDS = {
  apple: "builtin-apple",
  qwen: "builtin-qwen",
  codex: "builtin-codex",
  claudeCode: "builtin-claude-code",
} as const;

const builtInIds = new Set<string>(
  Object.values(BUILT_IN_PROVIDER_IDS),
);

const defaultProfiles = (): ModelProviderProfile[] => [
  {
    version: 1,
    profileId: BUILT_IN_PROVIDER_IDS.apple,
    kind: "apple",
    label: "Apple Foundation Models",
    enabled: true,
    priority: 0,
    model: "system-language-model",
    timeoutMs: 5_000,
  },
  {
    version: 1,
    profileId: BUILT_IN_PROVIDER_IDS.qwen,
    kind: "qwen",
    label: "Qwen 本地模型",
    enabled: true,
    priority: 10,
    model: "qwen3.5-2b-q4-k-m",
    timeoutMs: 5_000,
  },
  {
    version: 1,
    profileId: BUILT_IN_PROVIDER_IDS.codex,
    kind: "codex-cli",
    label: "Codex CLI",
    enabled: false,
    priority: 20,
    timeoutMs: 30_000,
  },
  {
    version: 1,
    profileId: BUILT_IN_PROVIDER_IDS.claudeCode,
    kind: "claude-code-cli",
    label: "Claude Code CLI",
    enabled: false,
    priority: 30,
    timeoutMs: 30_000,
  },
];

const isMissing = (error: unknown): boolean =>
  error !== null &&
  typeof error === "object" &&
  "code" in error &&
  error.code === "ENOENT";

const sortProfiles = (
  profiles: ModelProviderProfile[],
): ModelProviderProfile[] =>
  [...profiles].sort(
    (left, right) =>
      left.priority - right.priority ||
      left.profileId.localeCompare(right.profileId),
  );

export class ProviderProfileRepository {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async load(): Promise<ModelProviderProfile[]> {
    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      const profiles = defaultProfiles();
      await this.#write(profiles);
      return profiles;
    }
    const document = modelProviderProfilesDocumentSchema.parse(
      JSON.parse(raw),
    );
    await chmod(this.#path, 0o600);
    return sortProfiles(document.profiles);
  }

  async save(
    input: ModelProviderProfile,
  ): Promise<ModelProviderProfile> {
    const profile = modelProviderProfileSchema.parse(input);
    const profiles = await this.load();
    const index = profiles.findIndex(
      (candidate) =>
        candidate.profileId === profile.profileId,
    );
    if (
      index >= 0 &&
      builtInIds.has(profile.profileId) &&
      profiles[index]!.kind !== profile.kind
    ) {
      throw new Error("Built-in provider kind cannot be changed");
    }
    if (index >= 0) {
      profiles[index] = profile;
    } else {
      profiles.push(profile);
    }
    await this.#write(profiles);
    return profile;
  }

  async delete(profileId: string): Promise<boolean> {
    if (builtInIds.has(profileId)) {
      return false;
    }
    const profiles = await this.load();
    const remaining = profiles.filter(
      (profile) => profile.profileId !== profileId,
    );
    if (remaining.length === profiles.length) {
      return false;
    }
    await this.#write(remaining);
    return true;
  }

  async reorder(
    profileIds: string[],
  ): Promise<ModelProviderProfile[]> {
    const profiles = await this.load();
    const expected = new Set(
      profiles.map((profile) => profile.profileId),
    );
    const received = new Set(profileIds);
    if (
      received.size !== profileIds.length ||
      received.size !== expected.size ||
      [...expected].some((id) => !received.has(id))
    ) {
      throw new Error(
        "Provider reorder must include every profile exactly once",
      );
    }
    const byId = new Map(
      profiles.map((profile) => [profile.profileId, profile]),
    );
    const reordered = profileIds.map((profileId, index) => ({
      ...byId.get(profileId)!,
      priority: index * 10,
    }));
    await this.#write(reordered);
    return reordered;
  }

  async refreshLocalClients(
    statuses: LocalModelClientStatus[],
  ): Promise<ModelProviderProfile[]> {
    const profiles = await this.load();
    const byKind = new Map(
      statuses.map((status) => [status.kind, status]),
    );
    let changed = false;
    const refreshed = profiles.map((profile) => {
      if (
        profile.kind !== "codex-cli" &&
        profile.kind !== "claude-code-cli"
      ) {
        return profile;
      }
      const status = byKind.get(profile.kind);
      if (
        status?.executablePath === undefined ||
        status.executablePath === profile.executablePath
      ) {
        return profile;
      }
      changed = true;
      return {
        ...profile,
        executablePath: status.executablePath,
      };
    });
    if (changed) {
      await this.#write(refreshed);
    }
    return sortProfiles(refreshed);
  }

  async #write(
    profiles: ModelProviderProfile[],
  ): Promise<void> {
    const document = modelProviderProfilesDocumentSchema.parse({
      version: 1,
      profiles: sortProfiles(profiles),
    });
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        `${JSON.stringify(document, null, 2)}\n`,
        {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        },
      );
      await rename(temporary, this.#path);
      await chmod(this.#path, 0o600);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}
