import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, realpath, rename, rm } from "node:fs/promises";
import type { Stats } from "node:fs";
import { posix, win32 } from "node:path";

import {
  expireQuarantined,
  ObsidianSearchIndex,
  ObsidianSearchIndexSchemaError,
  ObsidianVaultRepository,
  ObsidianVaultWatcher,
  QUARANTINE_MAXIMUM_AGE_MS,
} from "@cognelis/decision-storage";

import type {
  ObsidianSearchResponse,
  ObsidianSearchStatus,
} from "../../shared/obsidian-search.js";
import { QwenEmbeddingProvider } from "../semantic/qwen-embedding-provider.js";
import {
  ObsidianSearchService,
  type ObsidianSearchServiceOptions,
} from "./obsidian-search-service.js";

const DISABLED_MESSAGE = "Obsidian 全库索引暂时不可用。";
const SIDECAR_SUFFIXES = ["", "-wal", "-shm"] as const;

export interface ObsidianSearchRuntime {
  start(): void;
  status(): ObsidianSearchStatus;
  search(input: {
    query: string;
    limit?: number;
  }): Promise<ObsidianSearchResponse>;
  rebuild(): Promise<ObsidianSearchStatus>;
  openNote(relativePath: string): Promise<void>;
  close(): Promise<void>;
}

export interface ObsidianSearchRuntimeFileSystem {
  lstat(path: string): Promise<Pick<Stats, "isFile" | "isSymbolicLink">>;
  rename(source: string, destination: string): Promise<void>;
}

export interface ObsidianSearchRuntimeFactories {
  repository(vaultPath: string): ObsidianSearchServiceOptions["repository"];
  index(indexPath: string): ObsidianSearchServiceOptions["index"] & {
    bindVault(identity: string): void;
    vaultIdentity(): string | null;
  };
  embedding(options: {
    modelsDirectory: string;
  }): ObsidianSearchServiceOptions["embedding"];
  watcher(
    vaultPath: string,
    onChange: () => void,
    onError: () => void,
  ): ReturnType<ObsidianSearchServiceOptions["watcherFactory"]>;
  service(options: ObsidianSearchServiceOptions): ObsidianSearchRuntime;
}

export interface CreateObsidianSearchRuntimeOptions {
  vaultPath: string;
  indexRoot: string;
  modelsDirectory: string;
  openExternal(uri: string): Promise<unknown>;
  now?: () => Date;
  randomUUID?: () => string;
  realpath?: (path: string) => Promise<string>;
  platform?: NodeJS.Platform;
  factories?: Partial<ObsidianSearchRuntimeFactories>;
  fileSystem?: ObsidianSearchRuntimeFileSystem;
}

const disabledStatus = (): ObsidianSearchStatus => ({
  state: "error",
  discoveredNotes: 0,
  indexedNotes: 0,
  chunkCount: 0,
  processedNotes: 0,
  totalNotes: 0,
  skippedNotes: 0,
  failedNotes: 0,
  synchronizedAt: null,
  semanticAvailable: false,
  message: DISABLED_MESSAGE,
});

const createDisabledRuntime = (): ObsidianSearchRuntime => ({
  start: () => undefined,
  status: () => disabledStatus(),
  search: async ({ query }) => ({ query, results: [], status: disabledStatus() }),
  rebuild: async () => disabledStatus(),
  openNote: async () => {
    throw new Error(DISABLED_MESSAGE);
  },
  close: async () => undefined,
});

const isMissing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

const quarantineTimestamp = (date: Date): string =>
  date.toISOString().replace(/[-:.]/gu, "");

const normalizedCanonicalVaultPath = (
  canonicalPath: string,
  platform: NodeJS.Platform,
): string => {
  if (platform === "win32") {
    if (!win32.isAbsolute(canonicalPath)) {
      throw new Error("Invalid canonical Obsidian Vault path");
    }
    return canonicalPath.replace(/\\/gu, "/");
  }
  if (!posix.isAbsolute(canonicalPath)) {
    throw new Error("Invalid canonical Obsidian Vault path");
  }
  return canonicalPath;
};

export const obsidianVaultIdentity = (
  canonicalPath: string,
  platform: NodeJS.Platform = process.platform,
): string =>
  createHash("sha256")
    .update(normalizedCanonicalVaultPath(canonicalPath, platform), "utf8")
    .digest("hex");

export const obsidianSearchIndexPath = (
  indexRoot: string,
  identity: string,
  platform: NodeJS.Platform = process.platform,
): string => {
  if (!/^[a-f0-9]{64}$/u.test(identity)) {
    throw new Error("Invalid Obsidian Vault identity");
  }
  const paths = platform === "win32" ? win32 : posix;
  if (!paths.isAbsolute(indexRoot)) {
    throw new Error("Invalid Obsidian search root");
  }
  return paths.resolve(indexRoot, "vaults", identity, "index.sqlite");
};

const quarantineIndex = async (
  indexPath: string,
  now: () => Date,
  createId: () => string,
  fileSystem: ObsidianSearchRuntimeFileSystem,
): Promise<boolean> => {
  const targets: string[] = [];
  for (const suffix of SIDECAR_SUFFIXES) {
    const target = `${indexPath}${suffix}`;
    try {
      const stat = await fileSystem.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      targets.push(target);
    } catch (error) {
      if (!isMissing(error)) return false;
    }
  }

  const id = createId().replace(/[^a-zA-Z0-9]/gu, "");
  if (id.length === 0) return false;
  const quarantineSuffix = `.corrupt-${quarantineTimestamp(now())}-${id}`;
  const pairs = targets.map((source) => ({
    source,
    destination: `${source}${quarantineSuffix}`,
  }));
  for (const { destination } of pairs) {
    try {
      await fileSystem.lstat(destination);
      return false;
    } catch (error) {
      if (!isMissing(error)) return false;
    }
  }

  const main = pairs.find(({ source }) => source === indexPath);
  const renameOrder = [
    ...pairs.filter(({ source }) => source !== indexPath),
    ...(main === undefined ? [] : [main]),
  ];
  const completed: typeof pairs = [];
  try {
    for (const pair of renameOrder) {
      await fileSystem.rename(pair.source, pair.destination);
      completed.push(pair);
    }
    return true;
  } catch {
    for (const pair of completed.reverse()) {
      try {
        await fileSystem.rename(pair.destination, pair.source);
      } catch {
        // Recovery stays disabled if a best-effort rollback cannot complete.
      }
    }
    return false;
  }
};

const closePartialResources = async (
  watchers: readonly ReturnType<
    ObsidianSearchServiceOptions["watcherFactory"]
  >[],
  embedding: ObsidianSearchServiceOptions["embedding"] | undefined,
  index: ObsidianSearchServiceOptions["index"] | undefined,
): Promise<void> => {
  for (const watcher of [...watchers].reverse()) {
    try {
      await watcher.close();
    } catch {
      // A partially composed optional feature must not affect Decision startup.
    }
  }
  try {
    await embedding?.close?.();
  } catch {
    // A partially composed optional feature must not affect Decision startup.
  }
  try {
    index?.close();
  } catch {
    // A partially composed optional feature must not affect Decision startup.
  }
};

/**
 * Note search for the vault, or one that says it is off. Off because the vault was not there at start (a
 * drive or a NAS mounted later), a rebuild tries again: it did nothing, and search stayed off until a
 * restart, whatever was rebuilt.
 */
export const createObsidianSearchRuntime = async (
  options: CreateObsidianSearchRuntimeOptions,
): Promise<ObsidianSearchRuntime> => {
  let damaged = false;
  const open = (quarantine: boolean): Promise<ObsidianSearchRuntime | null> =>
    openObsidianSearchRuntime(options, { quarantine, onIndexDamaged: () => { damaged = true; } });
  let live = await open(false);
  const disabled = createDisabledRuntime();
  let started = false;
  let opening: Promise<ObsidianSearchRuntime | null> | null = null;
  const reopen = async (quarantine: boolean): Promise<ObsidianSearchRuntime | null> => {
    opening ??= open(quarantine).finally(() => {
      opening = null;
    });
    live = await opening;
    if (live !== null && started) live.start();
    return live;
  };
  return {
    start: () => {
      started = true;
      live?.start();
    },
    status: () => live?.status() ?? disabled.status(),
    search: (input) => live?.search(input) ?? disabled.search(input),
    rebuild: async () => {
      const current = live ?? await reopen(false);
      if (current === null) return disabled.rebuild();
      if (!damaged) {
        const status = await current.rebuild();
        if (!damaged) return status;
      }
      // Found damaged while running (a search or a sync read what it could not decode): rebuilt in place, every
      // note failed and every search with it, and only a schema check at the next start ever set it aside, which
      // this passes. Set aside now, as at that start, and the rebuild begins on a fresh one.
      live = null;
      await current.close().catch(() => undefined);
      // Cleared once it is closed: a search still reading the damaged index as it closes reports the damage again,
      // and, cleared before, that report set the fresh index aside at the next rebuild.
      damaged = false;
      const fresh = await reopen(true);
      return fresh === null ? disabled.rebuild() : fresh.rebuild();
    },
    openNote: (relativePath) => live?.openNote(relativePath) ?? disabled.openNote(relativePath),
    close: async () => {
      await live?.close();
    },
  };
};

const openObsidianSearchRuntime = async (
  options: CreateObsidianSearchRuntimeOptions,
  hooks: { quarantine: boolean; onIndexDamaged: () => void },
): Promise<ObsidianSearchRuntime | null> => {
  const factories: ObsidianSearchRuntimeFactories = {
    repository: (vaultPath) => new ObsidianVaultRepository(vaultPath),
    index: (indexPath) => new ObsidianSearchIndex(indexPath),
    embedding: (embeddingOptions) => new QwenEmbeddingProvider(embeddingOptions),
    watcher: (vaultPath, onChange, onError) =>
      new ObsidianVaultWatcher(vaultPath, onChange, onError),
    service: (serviceOptions) => new ObsidianSearchService(serviceOptions),
    ...options.factories,
  };
  const fileSystem = options.fileSystem ?? { lstat, rename };
  const now = options.now ?? (() => new Date());
  const createId = options.randomUUID ?? randomUUID;
  const canonicalizeVault = options.realpath ?? realpath;
  const platform = options.platform ?? process.platform;
  type RuntimeIndex = ReturnType<ObsidianSearchRuntimeFactories["index"]>;
  let index: RuntimeIndex | undefined;
  let embedding: ObsidianSearchServiceOptions["embedding"] | undefined;
  const createdWatchers: Array<
    ReturnType<ObsidianSearchServiceOptions["watcherFactory"]>
  > = [];

  try {
    const canonicalVaultPath = await canonicalizeVault(options.vaultPath);
    const vaultIdentity = obsidianVaultIdentity(canonicalVaultPath, platform);
    const indexPath = obsidianSearchIndexPath(
      options.indexRoot,
      vaultIdentity,
      platform,
    );
    const repository = factories.repository(canonicalVaultPath);
    const openBoundIndex = (): RuntimeIndex => {
      const candidate = factories.index(indexPath);
      try {
        candidate.bindVault(vaultIdentity);
        return candidate;
      } catch (error) {
        try { candidate.close(); } catch { /* Identity failure remains primary. */ }
        throw error;
      }
    };
    if (hooks.quarantine && !(await quarantineIndex(indexPath, now, createId, fileSystem))) return null;
    try {
      index = openBoundIndex();
    } catch (error) {
      if (!(error instanceof ObsidianSearchIndexSchemaError)) throw error;
      if (
        !(await quarantineIndex(indexPath, now, createId, fileSystem))
      ) {
        return null;
      }
      index = openBoundIndex();
    }
    // Only this vault's index is kept. One for a vault left behind (another chosen, or the vault deleted) held
    // the text of every note in it, for good; choosing that vault again builds its index again.
    const paths = platform === "win32" ? win32 : posix;
    const vaults = paths.resolve(options.indexRoot, "vaults");
    for (const name of await readdir(vaults).catch(() => [] as string[])) {
      if (name !== vaultIdentity && /^[a-f0-9]{64}$/u.test(name)) {
        await rm(paths.join(vaults, name), { recursive: true, force: true }).catch(() => undefined);
      }
    }
    await expireQuarantined(paths.dirname(indexPath), QUARANTINE_MAXIMUM_AGE_MS, now().getTime());
    embedding = factories.embedding({
      modelsDirectory: options.modelsDirectory,
    });
    return factories.service({
      repository,
      index,
      embedding,
      watcherFactory: (onChange, onError) => {
        const watcher = factories.watcher(
          canonicalVaultPath,
          onChange,
          onError,
        );
        createdWatchers.push(watcher);
        return watcher;
      },
      openExternal: options.openExternal,
      now,
      onIndexDamaged: hooks.onIndexDamaged,
    });
  } catch {
    await closePartialResources(createdWatchers, embedding, index);
    return null;
  }
};
