import {
  modelProviderProfileSchema,
  modelProviderProfilesDocumentSchema,
  type LocalModelClientStatus,
  type ModelProviderProfile,
} from "@cognelis/decision-protocol";
import { renameReplacing } from "@cognelis/decision-storage";
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
    model: "qwen3.5-4b-q4-k-m",
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

/**
 * The profiles a file holds, or null when it holds none this build can read. Fields a later build added (pricing,
 * proxy and jsonMode each came that way) are left out rather than the file refused: going back a version kept
 * the app from opening at all.
 */
const readProfiles = (raw: string): ModelProviderProfile[] | null => {
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return null;
  }
  const first = modelProviderProfilesDocumentSchema.safeParse(stored);
  if (first.success) return first.data.profiles;
  for (const issue of first.error.issues) {
    if (issue.code !== "unrecognized_keys") continue;
    const owner = issue.path.reduce<unknown>((node, key) => (node as Record<PropertyKey, unknown>)[key], stored);
    for (const key of issue.keys) delete (owner as Record<string, unknown>)[key];
  }
  const second = modelProviderProfilesDocumentSchema.safeParse(stored);
  return second.success ? second.data.profiles : null;
};

/**
 * Fields a profile gained after 1.1.0, kept in a file beside the profiles (#write): in them, 1.1.0's strict schema
 * refused the whole file, and a reader going back to it found the app quit at once without a word.
 */
const ADDED_SINCE_1_1 = ["proxy", "jsonMode", "fallbackOnFailure", "pricing"] as const;

export class ProviderProfileRepository {
  readonly #path: string;
  /** Beside the profiles, where the fields added since 1.1.0 are kept by profile: 1.1.0 never reads it. */
  readonly #addedPath: string;
  /** Where a load set an unreadable file aside, for the app to say so; null when none did. */
  setAside: string | null = null;
  /** Where a load set the file beside the profiles aside, unreadable: their proxies, fallbacks and prices are gone. */
  addedSetAside: string | null = null;

  constructor(path: string) {
    this.#path = path;
    this.#addedPath = path.replace(/(\.json)?$/u, "-extra.json");
  }

  async load(): Promise<ModelProviderProfile[]> {
    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch (error) {
      if (!isMissing(error)) {
        throw new Error(
          `读不出模型服务配置文件 ${this.#path}（${error instanceof Error ? error.message : String(error)}），请检查它的访问权限后重新打开 Decision。`,
        );
      }
      const profiles = defaultProfiles();
      await this.#write(profiles);
      return profiles;
    }
    const stored = readProfiles(raw);
    if (stored === null) {
      // Empty or cut short (the power went during a save), or not profiles at all: kept aside where it can be
      // looked at, and models start again from the built-ins rather than the app not at all.
      const aside = `${this.#path}.unreadable-${Date.now()}`;
      try {
        await rename(this.#path, aside);
      } catch {
        // Not set aside, the next save would write over it.
        throw new Error(`模型服务配置文件 ${this.#path} 读不出来，也没能把它移到一边，请把它移走后重新打开 Decision。`);
      }
      this.setAside = aside;
      const profiles = defaultProfiles();
      await this.#write(profiles);
      return profiles;
    }
    await chmod(this.#path, 0o600);
    const added = await this.#loadAdded();
    // Put back from beside the file; one an earlier build wrote into the profile itself is the later word, and
    // one that no longer fits its profile (changed under 1.1.0) is let go rather than the profile.
    return sortProfiles(stored.map((profile) => {
      const kept = added[profile.profileId];
      if (typeof kept !== "object" || kept === null) return profile;
      const fields = Object.fromEntries(ADDED_SINCE_1_1.flatMap((key) => (key in kept ? [[key, (kept as Record<string, unknown>)[key]]] : [])));
      const merged = modelProviderProfileSchema.safeParse({ ...fields, ...profile });
      return merged.success ? merged.data : profile;
    }));
  }

  /** The fields added since 1.1.0 by profile, as the file beside the profiles holds them: none it cannot read. */
  async #loadAdded(): Promise<Record<string, unknown>> {
    let raw: string;
    try {
      raw = await readFile(this.#addedPath, "utf8");
    } catch (error) {
      if (isMissing(error)) return {};
      throw new Error(
        `读不出模型服务配置文件 ${this.#addedPath}（${error instanceof Error ? error.message : String(error)}），请检查它的访问权限后重新打开 Decision。`,
      );
    }
    let profiles: unknown;
    try {
      profiles = (JSON.parse(raw) as { profiles?: unknown }).profiles;
    } catch {
      profiles = undefined;
    }
    if (typeof profiles === "object" && profiles !== null && !Array.isArray(profiles)) return profiles as Record<string, unknown>;
    // Cut short or edited past reading: kept aside where it can be looked at, as the profiles file is, and said.
    // Read as nothing and left in place, the next save wrote over it, a proxy or a price in it gone for good; set
    // aside without a word, a backend set to connect directly went through the environment's proxy unannounced.
    const aside = `${this.#addedPath}.unreadable-${Date.now()}`;
    await rename(this.#addedPath, aside).then(() => {
      this.addedSetAside = aside;
    }, () => undefined);
    return {};
  }

  // One change at a time: two at once (a save while the model page refreshes its clients) each wrote what it had
  // read, the profiles and the file beside them from different ones.
  save(input: ModelProviderProfile): Promise<ModelProviderProfile> {
    return this.#exclusive(() => this.#save(input));
  }

  delete(profileId: string): Promise<boolean> {
    return this.#exclusive(() => this.#delete(profileId));
  }

  reorder(profileIds: string[]): Promise<ModelProviderProfile[]> {
    return this.#exclusive(() => this.#reorder(profileIds));
  }

  refreshLocalClients(statuses: LocalModelClientStatus[]): Promise<ModelProviderProfile[]> {
    return this.#exclusive(() => this.#refreshLocalClients(statuses));
  }

  #changes: Promise<unknown> = Promise.resolve();

  #exclusive<T>(change: () => Promise<T>): Promise<T> {
    const run = this.#changes.then(change);
    this.#changes = run.catch(() => undefined);
    return run;
  }

  async #save(
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

  async #delete(profileId: string): Promise<boolean> {
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

  async #reorder(
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

  async #refreshLocalClients(
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
    const isAdded = (key: string): boolean => (ADDED_SINCE_1_1 as readonly string[]).includes(key);
    const added = Object.fromEntries(document.profiles.flatMap((profile) => {
      const fields = Object.entries(profile).filter(([key, value]) => isAdded(key) && value !== undefined);
      return fields.length === 0 ? [] : [[profile.profileId, Object.fromEntries(fields)]];
    }));
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    // Beside them first, what was there with what is now: an earlier build's file holds its fields in the profiles
    // until they are written, and a profile being deleted keeps its own. Then the profiles; then beside them only
    // what they hold. Cut short anywhere, no field is lost and no deleted profile comes back without its fields
    // (beside them last, it came back so; the profiles first, a failed second write left a moved proxy nowhere).
    await this.#writeFile(this.#addedPath, { version: 1, profiles: { ...(await this.#loadAdded()), ...added } });
    await this.#writeFile(this.#path, {
      ...document,
      profiles: document.profiles.map((profile) => Object.fromEntries(Object.entries(profile).filter(([key]) => !isAdded(key)))),
    });
    await this.#writeFile(this.#addedPath, { version: 1, profiles: added });
  }

  async #writeFile(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        `${JSON.stringify(value, null, 2)}\n`,
        {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        },
      );
      await renameReplacing(temporary, path);
      await chmod(path, 0o600);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}
