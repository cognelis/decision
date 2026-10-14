import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  ObsidianSearchIndex,
  ObsidianSearchIndexSchemaError,
  type ObsidianIndexedNoteInput,
} from "@cognelis/decision-storage";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createObsidianSearchRuntime,
  obsidianSearchIndexPath,
  obsidianVaultIdentity,
  type ObsidianSearchRuntimeFactories,
  type ObsidianSearchRuntimeFileSystem,
} from "../src/main/obsidian-search/obsidian-search-runtime.js";
import type { ObsidianSearchServiceOptions } from "../src/main/obsidian-search/obsidian-search-service.js";
import type { ObsidianSearchStatus } from "../src/shared/obsidian-search.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "obsidian-search-runtime-"));
  roots.push(root);
  return root;
};

const emptyVaultEntries = async function* (): AsyncIterableIterator<never> { return; };

const readyStatus = (): ObsidianSearchStatus => ({
  state: "ready",
  discoveredNotes: 1,
  indexedNotes: 1,
  chunkCount: 2,
  processedNotes: 1,
  totalNotes: 1,
  skippedNotes: 0,
  failedNotes: 0,
  synchronizedAt: "2026-08-18T01:02:03.004Z",
  semanticAvailable: true,
  message: null,
});

const serviceFixture = () => {
  const status = readyStatus();
  return {
    start: vi.fn(),
    status: vi.fn(() => status),
    search: vi.fn(async ({ query }: { query: string; limit?: number }) => ({
      query,
      results: [],
      status,
    })),
    rebuild: vi.fn(async () => status),
    openNote: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
};

const indexFixture = (close: () => void = vi.fn()) => {
  let identity: string | null = null;
  return {
    semanticCoverage: () => ({ totalNotes: 0, semanticNotes: 0, keywordOnlyNotes: 0, mismatchedModelNotes: 0 }),
    noteMetadataForPath: () => null,
    hasNoteDescendant: () => false,
    replaceNote: () => undefined,
    prune: () => undefined,
    markSynchronized: () => undefined,
    snapshot: () => ({ noteCount: 0, chunkCount: 0, synchronizedAt: null }),
    hasNote: () => false,
    iterateChunks: function* () { return; },
    bindVault: (nextIdentity: string) => { identity = nextIdentity; },
    vaultIdentity: () => identity,
    close,
  };
};

const derivedIndexPath = (indexRoot: string, canonicalVault: string): string =>
  obsidianSearchIndexPath(indexRoot, obsidianVaultIdentity(canonicalVault));

describe("Obsidian search runtime", () => {
  it("derives deterministic private per-vault paths across platforms", () => {
    const root = join(process.cwd(), "user-data", "obsidian-search");
    const posixIdentity = obsidianVaultIdentity(
      "/Users/Ada/Vault",
      "darwin",
    );
    const otherIdentity = obsidianVaultIdentity(
      "/Users/Ada/Other Vault",
      "darwin",
    );
    const windowsIdentity = obsidianVaultIdentity(
      "C:\\Users\\Ada\\VAULT",
      "win32",
    );

    expect(posixIdentity).toMatch(/^[a-f0-9]{64}$/u);
    expect(otherIdentity).not.toBe(posixIdentity);
    expect(windowsIdentity).toBe(
      obsidianVaultIdentity("C:/Users/Ada/VAULT", "win32"),
    );
    expect(windowsIdentity).not.toBe(
      obsidianVaultIdentity("C:/Users/Ada/Vault", "win32"),
    );
    const composedIdentity = obsidianVaultIdentity(
      "/Users/Ada/Caf\u00e9",
      "darwin",
    );
    const decomposedIdentity = obsidianVaultIdentity(
      "/Users/Ada/Cafe\u0301",
      "darwin",
    );
    expect(composedIdentity).not.toBe(decomposedIdentity);
    expect(obsidianSearchIndexPath(root, composedIdentity)).not.toBe(
      obsidianSearchIndexPath(root, decomposedIdentity),
    );
    expect(obsidianVaultIdentity("/vault/a\\b", "linux")).not.toBe(
      obsidianVaultIdentity("/vault/a/b", "linux"),
    );
    expect(obsidianSearchIndexPath(root, posixIdentity)).toBe(
      join(root, "vaults", posixIdentity, "index.sqlite"),
    );
    expect(obsidianSearchIndexPath(root, posixIdentity)).not.toContain(
      "/Users/Ada/Vault",
    );
  });

  it("keeps case- and Unicode-different canonical Vaults isolated through failed scans", async () => {
    interface StoredIndex {
      identity: string | null;
      notes: Map<string, ObsidianIndexedNoteInput>;
      synchronizedAt: string | null;
    }
    const stores = new Map<string, StoredIndex>();
    const canonicalA = "C:\\Knowledge\\Vault";
    const canonicalB = "C:\\Knowledge\\VAULT";
    const unicodeA = "C:\\Knowledge\\Caf\u00e9";
    const unicodeB = "C:\\Knowledge\\Cafe\u0301";
    const privateVaults = new Set([canonicalA, unicodeA]);
    const failedVaults = new Set([unicodeB]);
    const indexRoot = "C:\\UserData\\obsidian-search";
    const factories: Partial<ObsidianSearchRuntimeFactories> = {
      repository: (canonicalVault) => ({
        iterate: async function* () {
          if (failedVaults.has(canonicalVault)) {
            throw new Error("synthetic Vault B scan failed");
          }
          if (privateVaults.has(canonicalVault)) yield {
            kind: "note" as const,
            note: {
              relativePath: "only-a.md",
              content: "# Alpha case-sensitive secret",
              contentHash: "alpha-hash",
              size: 29,
              modifiedAtMs: 1,
            },
          };
        },
        resolveNotePath: async () => {
          throw new Error("opening is outside identity proof");
        },
      }),
      index: (path) => {
        const store = stores.get(path) ?? {
          identity: null,
          notes: new Map<string, ObsidianIndexedNoteInput>(),
          synchronizedAt: null,
        };
        stores.set(path, store);
        return {
          bindVault: (identity) => {
            if (store.identity !== null && store.identity !== identity) {
              throw new ObsidianSearchIndexSchemaError("identity mismatch");
            }
            store.identity = identity;
          },
          vaultIdentity: () => store.identity,
          semanticCoverage: (model?: string) => {
            const notes = [...store.notes.values()];
            return {
              totalNotes: notes.length,
              semanticNotes: notes.filter((note) => note.model !== null).length,
              keywordOnlyNotes: notes.filter((note) => note.model === null).length,
              mismatchedModelNotes: model === undefined ? 0 : notes.filter((note) => note.model !== null && note.model !== model).length,
            };
          },
          noteMetadataForPath: (relativePath: string) => {
            const note = store.notes.get(relativePath);
            return note === undefined ? null : {
              relativePath: note.relativePath,
              title: note.title,
              contentHash: note.contentHash,
              size: note.size,
              modifiedAtMs: note.modifiedAtMs,
              model: note.model,
              indexedAt: "2026-08-18T00:00:00.000Z",
            };
          },
          hasNoteDescendant: (directory: string) => [...store.notes.keys()].some((path) => path.startsWith(`${directory}/`)),
          replaceNote: (note) => { store.notes.set(note.relativePath, note); },
          prune: (activePaths) => {
            const active = new Set(activePaths);
            for (const path of store.notes.keys()) {
              if (!active.has(path)) store.notes.delete(path);
            }
          },
          markSynchronized: (at) => { store.synchronizedAt = at; },
          snapshot: () => ({
            noteCount: store.notes.size,
            chunkCount: [...store.notes.values()].reduce(
              (count, note) => count + note.chunks.length,
              0,
            ),
            synchronizedAt: store.synchronizedAt,
          }),
          hasNote: (relativePath) => store.notes.has(relativePath),
          iterateChunks: function* () {
            for (const note of store.notes.values()) {
              for (const chunk of note.chunks) {
                yield {
                  ...chunk,
                  relativePath: note.relativePath,
                  title: note.title,
                  model: note.model,
                };
              }
            }
          },
          close: () => undefined,
        };
      },
      embedding: () => ({
        embed: async (texts) => ({
          model: "case-model",
          vectors: texts.map(() => [1, 0, 0]),
        }),
        close: async () => undefined,
      }),
    };
    const createRuntime = (canonicalVault: string) =>
      createObsidianSearchRuntime({
        vaultPath: canonicalVault,
        indexRoot,
        modelsDirectory: "C:\\UserData\\models",
        openExternal: async () => undefined,
        platform: "win32",
        realpath: async () => canonicalVault,
        factories,
      });

    const runtimeA = await createRuntime(canonicalA);
    await runtimeA.rebuild();
    expect(runtimeA.status().indexedNotes).toBe(1);
    await runtimeA.close();

    const runtimeB = await createRuntime(canonicalB);
    expect(runtimeB.status()).toMatchObject({ indexedNotes: 0, chunkCount: 0 });
    expect(
      (await runtimeB.search({ query: "Alpha case-sensitive secret" })).results,
    ).toEqual([]);
    await runtimeB.close();

    expect(stores.size).toBe(2);

    const unicodeRuntimeA = await createRuntime(unicodeA);
    await unicodeRuntimeA.rebuild();
    expect(unicodeRuntimeA.status().indexedNotes).toBe(1);
    await unicodeRuntimeA.close();

    const unicodeRuntimeB = await createRuntime(unicodeB);
    expect(unicodeRuntimeB.status()).toMatchObject({
      indexedNotes: 0,
      chunkCount: 0,
    });
    expect(
      (await unicodeRuntimeB.search({ query: "Alpha case-sensitive secret" }))
        .results,
    ).toEqual([]);
    await unicodeRuntimeB.rebuild();
    expect(unicodeRuntimeB.status().state).toBe("error");
    expect(
      (await unicodeRuntimeB.search({ query: "Alpha case-sensitive secret" }))
        .results,
    ).toEqual([]);
    await unicodeRuntimeB.close();

    expect(stores.size).toBe(4);
  });

  it("never exposes one Vault through another before, during, or after a failed scan", async () => {
    const root = await temporaryRoot();
    const vaultA = join(root, "Vault A");
    const vaultB = join(root, "Vault B");
    const indexRoot = join(root, "user-data", "obsidian-search");
    const modelsDirectory = join(root, "models");
    const noteA = join(vaultA, "Knowledge", "only-a.md");
    await mkdir(dirname(noteA), { recursive: true });
    await mkdir(vaultB, { recursive: true });
    await writeFile(noteA, "# Alpha private title\nunique-alpha-body", "utf8");
    const embeddingFactory = () => ({
      embed: async (texts: string[]) => ({
        model: "test-model",
        vectors: texts.map(() => [1, 0, 0]),
      }),
      close: async () => undefined,
    });
    const runtimeOptions = (vaultPath: string) => ({
      vaultPath,
      indexRoot,
      modelsDirectory,
      openExternal: async () => undefined,
      factories: { embedding: embeddingFactory },
    });

    const runtimeA = await createObsidianSearchRuntime(runtimeOptions(vaultA));
    expect(runtimeA.status().indexedNotes).toBe(0);
    await runtimeA.rebuild();
    expect(
      (await runtimeA.search({ query: "unique-alpha-body" })).results.map(
        (result) => result.relativePath,
      ),
    ).toEqual(["Knowledge/only-a.md"]);
    await runtimeA.close();

    let rejectBScan: ((error: Error) => void) | undefined;
    const blockedBScan = new Promise<never>((_resolve, reject) => {
      rejectBScan = reject;
    });
    const runtimeB = await createObsidianSearchRuntime({
      ...runtimeOptions(vaultB),
      factories: {
        embedding: embeddingFactory,
        repository: () => ({
          iterate: async function* () { await blockedBScan; },
          resolveNotePath: async () => {
            throw new Error("B has no indexed note");
          },
        }),
      },
    });

    expect(runtimeB.status()).toMatchObject({ indexedNotes: 0, chunkCount: 0 });
    expect(
      (await runtimeB.search({ query: "unique-alpha-body" })).results,
    ).toEqual([]);
    const rebuildingB = runtimeB.rebuild();
    expect(runtimeB.status().state).toBe("indexing");
    expect(
      (await runtimeB.search({ query: "unique-alpha-body" })).results,
    ).toEqual([]);
    rejectBScan?.(new Error("incomplete B scan"));
    await rebuildingB;
    expect(
      (await runtimeB.search({ query: "unique-alpha-body" })).results,
    ).toEqual([]);
    expect(JSON.stringify(runtimeB.status())).not.toContain(vaultA);
    await runtimeB.close();

    // With B opened, A's index went: kept for a vault left behind (another chosen, or deleted), it held the text
    // of every note in it for good. Chosen again, A is indexed again.
    const reusedA = await createObsidianSearchRuntime(runtimeOptions(vaultA));
    expect(reusedA.status()).toMatchObject({ indexedNotes: 0 });
    await reusedA.rebuild();
    const reusedResults = await reusedA.search({ query: "unique-alpha-body" });
    expect(reusedResults.results.map((result) => result.relativePath)).toEqual([
      "Knowledge/only-a.md",
    ]);
    await reusedA.close();

    const canonicalA = await realpath(vaultA);
    const canonicalB = await realpath(vaultB);
    const identityA = obsidianVaultIdentity(canonicalA);
    const identityB = obsidianVaultIdentity(canonicalB);
    const pathA = obsidianSearchIndexPath(indexRoot, identityA);
    const pathB = obsidianSearchIndexPath(indexRoot, identityB);
    expect(identityA).not.toBe(identityB);
    expect(pathA).not.toBe(pathB);
    const rawA = new DatabaseSync(pathA, { readOnly: true });
    expect(
      rawA.prepare("SELECT value FROM meta WHERE key='vault_identity'").get(),
    ).toEqual({ value: identityA });
    rawA.close();
    const databaseBytes = await readFile(pathA);
    expect(databaseBytes.includes(Buffer.from(vaultA))).toBe(false);
    expect(databaseBytes.includes(Buffer.from(canonicalA))).toBe(false);

    await Promise.all(
      [pathB, `${pathB}-wal`, `${pathB}-shm`].map((path) =>
        rm(path, { force: true }),
      ),
    );
    const mismatched = new ObsidianSearchIndex(pathB);
    mismatched.bindVault(identityA);
    mismatched.replaceNote({
      relativePath: "leaked-a.md",
      title: "Leaked Alpha",
      contentHash: "leaked-hash",
      size: 1,
      modifiedAtMs: 1,
      model: null,
      chunks: [{
        id: "leaked-a#0",
        ordinal: 0,
        heading: null,
        text: "unique-alpha-body",
        contentHash: "leaked-chunk",
        vector: null,
      }],
    });
    mismatched.close();

    const recoveredB = await createObsidianSearchRuntime({
      ...runtimeOptions(vaultB),
      now: () => new Date("2026-08-18T01:02:03.004Z"),
      randomUUID: () => "identity-mismatch",
      factories: {
        embedding: embeddingFactory,
        repository: () => ({
          iterate: async function* () {
            throw new Error("B scan still unavailable");
          },
          resolveNotePath: async () => {
            throw new Error("B has no indexed note");
          },
        }),
      },
    });
    expect(recoveredB.status()).toMatchObject({ indexedNotes: 0, chunkCount: 0 });
    expect(
      (await recoveredB.search({ query: "unique-alpha-body" })).results,
    ).toEqual([]);
    await recoveredB.rebuild();
    expect(
      (await recoveredB.search({ query: "unique-alpha-body" })).results,
    ).toEqual([]);
    expect(JSON.stringify(recoveredB.status())).not.toContain(vaultA);
    await recoveredB.close();
    expect(
      (await readdir(dirname(pathB))).some((name) =>
        name.startsWith("index.sqlite.corrupt-"),
      ),
    ).toBe(true);
  });

  it("sets aside an index found damaged while running and rebuilds on a fresh one", async () => {
    const root = await temporaryRoot();
    const vault = join(root, "Vault");
    const indexRoot = join(root, "search");
    await mkdir(vault, { recursive: true });
    await writeFile(join(vault, "a.md"), "# A\nrollback a", "utf8");
    await writeFile(join(vault, "b.md"), "# B\nrollback b", "utf8");
    const runtime = await createObsidianSearchRuntime({
      vaultPath: vault,
      indexRoot,
      modelsDirectory: join(root, "models"),
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T01:02:03.004Z"),
      randomUUID: () => "runtime-damage",
      realpath: async () => vault,
      factories: {
        embedding: () => ({
          embed: async (texts: string[]) => ({ model: "test-model", vectors: texts.map(() => [1, 0, 0]) }),
          close: async () => undefined,
        }),
        watcher: () => ({ start: vi.fn(), close: vi.fn(async () => undefined) }),
      },
    });
    expect((await runtime.rebuild()).state).toBe("ready");

    // Damage its own reads find (the model registry's dimension), which a start's schema check passes.
    const indexPath = derivedIndexPath(indexRoot, vault);
    const other = new DatabaseSync(indexPath);
    other.exec("UPDATE models SET dimension = dimension + 1");
    other.close();
    await expect(runtime.search({ query: "rollback" })).rejects.toThrow("无法执行 Obsidian 搜索。");

    // Rebuilt in place, every note failed and every search with it; nothing set the database aside.
    expect(await runtime.rebuild()).toMatchObject({ state: "ready", indexedNotes: 2, failedNotes: 0 });
    expect((await runtime.search({ query: "rollback" })).results.map((result) => result.relativePath).sort()).toEqual(["a.md", "b.md"]);
    expect((await readdir(dirname(indexPath))).some((name) => name.includes(".corrupt-"))).toBe(true);
    await runtime.close();
  });

  it("rebuilds in place next time when the index set aside reports damage again as it closes", async () => {
    const root = await temporaryRoot();
    const opened: Array<{ service: ReturnType<typeof serviceFixture>; options: ObsidianSearchServiceOptions }> = [];
    const runtime = await createObsidianSearchRuntime({
      vaultPath: join(root, "Vault"),
      indexRoot: join(root, "search"),
      modelsDirectory: join(root, "models"),
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T01:02:03.004Z"),
      randomUUID: () => "close-damage",
      realpath: async () => join(root, "Vault"),
      factories: {
        repository: () => ({ iterate: vi.fn(emptyVaultEntries), resolveNotePath: vi.fn() }),
        index: () => indexFixture(),
        embedding: () => ({ embed: vi.fn(), close: vi.fn(async () => undefined) }),
        watcher: () => ({ start: vi.fn(), close: vi.fn(async () => undefined) }),
        service: (options) => {
          const service = serviceFixture();
          // A search still reading the damaged index as it is closed fails on the bad row as it finishes.
          service.close.mockImplementation(async () => { options.onIndexDamaged?.(); });
          opened.push({ service, options });
          return service;
        },
      },
    });
    opened[0]!.options.onIndexDamaged?.();
    await runtime.rebuild();
    expect(opened).toHaveLength(2);

    // Cleared before the old one closed, its last report set the fresh index aside at the next rebuild as well.
    await runtime.rebuild();
    expect(opened).toHaveLength(2);
    expect(opened[1]!.service.rebuild).toHaveBeenCalledTimes(2);
  });

  it("composes the full-vault service and forwards its lifecycle and operations", async () => {
    const repository = { iterate: vi.fn(emptyVaultEntries), resolveNotePath: vi.fn() };
    const index = indexFixture();
    const embedding = { embed: vi.fn(), close: vi.fn(async () => undefined) };
    const watcher = { start: vi.fn(), close: vi.fn(async () => undefined) };
    const service = serviceFixture();
    let serviceOptions: Record<string, unknown> | undefined;
    const factories: ObsidianSearchRuntimeFactories = {
      repository: vi.fn(() => repository),
      index: vi.fn(() => index),
      embedding: vi.fn(() => embedding),
      watcher: vi.fn(() => watcher),
      service: vi.fn((options) => {
        serviceOptions = options as unknown as Record<string, unknown>;
        return service;
      }),
    };
    const openExternal = vi.fn(async () => undefined);
    const canonicalVault = "/canonical/vault";
    const indexRoot = "/user-data/obsidian-search";
    const expectedIndexPath = derivedIndexPath(indexRoot, canonicalVault);

    const runtime = await createObsidianSearchRuntime({
      vaultPath: "/vault-link",
      indexRoot,
      modelsDirectory: "/user-data/models",
      openExternal,
      now: () => new Date("2026-08-18T01:02:03.004Z"),
      realpath: async () => canonicalVault,
      factories,
    });

    expect(factories.repository).toHaveBeenCalledWith(canonicalVault);
    expect(factories.index).toHaveBeenCalledWith(expectedIndexPath);
    expect(factories.embedding).toHaveBeenCalledWith({ modelsDirectory: "/user-data/models" });
    expect(serviceOptions).toMatchObject({ repository, index, embedding, openExternal });
    const watcherFactory = serviceOptions?.watcherFactory as
      | ((onChange: () => void, onError: () => void) => unknown)
      | undefined;
    const onChange = vi.fn();
    const onError = vi.fn();
    expect(watcherFactory?.(onChange, onError)).toBe(watcher);
    expect(factories.watcher).toHaveBeenCalledWith(
      canonicalVault,
      onChange,
      onError,
    );

    runtime.start();
    expect(runtime.status()).toEqual(readyStatus());
    await expect(runtime.search({ query: "ordinary", limit: 7 })).resolves.toEqual({
      query: "ordinary",
      results: [],
      status: readyStatus(),
    });
    await expect(runtime.rebuild()).resolves.toEqual(readyStatus());
    await runtime.openNote("Knowledge/ordinary-note.md");
    await runtime.close();

    expect(service.start).toHaveBeenCalledOnce();
    expect(service.search).toHaveBeenCalledWith({ query: "ordinary", limit: 7 });
    expect(service.rebuild).toHaveBeenCalledOnce();
    expect(service.openNote).toHaveBeenCalledWith("Knowledge/ordinary-note.md");
    expect(service.close).toHaveBeenCalledOnce();
    expect(index.close).not.toHaveBeenCalled();
    expect(embedding.close).not.toHaveBeenCalled();
  });

  it("quarantines only the dedicated database files after a typed schema failure and retries once", async () => {
    const root = await temporaryRoot();
    const vault = join(root, "Vault");
    const indexRoot = join(root, "user-data", "obsidian-search");
    const indexPath = derivedIndexPath(indexRoot, vault);
    const decisionDb = join(root, "user-data", "index.sqlite");
    const note = join(vault, "Knowledge", "ordinary-note.md");
    await mkdir(dirname(note), { recursive: true });
    await mkdir(dirname(indexPath), { recursive: true });
    const bytes = new Uint8Array([0, 1, 2, 10, 255]);
    await writeFile(note, bytes);
    await writeFile(decisionDb, "decision-db");
    await writeFile(indexPath, "db-bytes");
    await writeFile(`${indexPath}-wal`, "wal-bytes");
    await writeFile(`${indexPath}-shm`, "shm-bytes");
    const beforeHash = createHash("sha256").update(await readFile(note)).digest("hex");
    const service = serviceFixture();
    const freshIndex = indexFixture();
    const indexFactory = vi.fn()
      .mockImplementationOnce(() => {
        throw new ObsidianSearchIndexSchemaError("raw corrupt path");
      })
      .mockReturnValueOnce(freshIndex);

    const runtime = await createObsidianSearchRuntime({
      vaultPath: vault,
      indexRoot,
      modelsDirectory: join(root, "models"),
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T01:02:03.004Z"),
      randomUUID: () => "schema-recovery",
      realpath: async () => vault,
      factories: {
        repository: () => ({ iterate: vi.fn(emptyVaultEntries), resolveNotePath: vi.fn() }),
        index: indexFactory,
        embedding: () => ({ embed: vi.fn(), close: vi.fn(async () => undefined) }),
        watcher: () => ({ start: vi.fn(), close: vi.fn(async () => undefined) }),
        service: () => service,
      },
    });

    expect(runtime.status()).toEqual(readyStatus());
    expect(indexFactory).toHaveBeenCalledTimes(2);
    const suffix = ".corrupt-20260818T010203004Z-schemarecovery";
    await expect(readFile(`${indexPath}${suffix}`, "utf8")).resolves.toBe("db-bytes");
    await expect(readFile(`${indexPath}-wal${suffix}`, "utf8")).resolves.toBe("wal-bytes");
    await expect(readFile(`${indexPath}-shm${suffix}`, "utf8")).resolves.toBe("shm-bytes");
    expect(await readFile(decisionDb, "utf8")).toBe("decision-db");
    expect(createHash("sha256").update(await readFile(note)).digest("hex")).toBe(beforeHash);
  });

  it("does not follow or rename unsafe quarantine targets", async () => {
    const root = await temporaryRoot();
    const vault = join(root, "Vault");
    const indexRoot = join(root, "search");
    const indexPath = derivedIndexPath(indexRoot, vault);
    const outside = join(root, "outside.sqlite");
    await mkdir(dirname(indexPath), { recursive: true });
    await writeFile(outside, "outside");
    await symlink(outside, indexPath);
    const indexFactory = vi.fn(() => {
      throw new ObsidianSearchIndexSchemaError("bad schema");
    });

    const runtime = await createObsidianSearchRuntime({
      vaultPath: join(root, "Vault"),
      indexRoot,
      modelsDirectory: join(root, "models"),
      openExternal: async () => undefined,
      realpath: async () => vault,
      factories: { index: indexFactory },
    });

    expect(runtime.status()).toMatchObject({ state: "error", message: "Obsidian 全库索引暂时不可用。" });
    expect(indexFactory).toHaveBeenCalledOnce();
    expect((await lstat(indexPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(outside, "utf8")).toBe("outside");

    const directoryIndexRoot = join(root, "directory-search");
    const directoryIndexPath = derivedIndexPath(directoryIndexRoot, vault);
    await mkdir(dirname(directoryIndexPath), { recursive: true });
    await mkdir(directoryIndexPath);
    const directoryIndexFactory = vi.fn(() => {
      throw new ObsidianSearchIndexSchemaError("bad schema");
    });
    const directoryRuntime = await createObsidianSearchRuntime({
      vaultPath: join(root, "Vault"),
      indexRoot: directoryIndexRoot,
      modelsDirectory: join(root, "models"),
      openExternal: async () => undefined,
      realpath: async () => vault,
      factories: { index: directoryIndexFactory },
    });
    expect(directoryRuntime.status().state).toBe("error");
    expect(directoryIndexFactory).toHaveBeenCalledOnce();
    expect((await lstat(directoryIndexPath)).isDirectory()).toBe(true);
  });

  it("does not quarantine a generic composition permission failure", async () => {
    const fileSystem: ObsidianSearchRuntimeFileSystem = {
      lstat: vi.fn(async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }),
      rename: vi.fn(async () => undefined),
    };
    const runtime = await createObsidianSearchRuntime({
      vaultPath: "/private/vault",
      indexRoot: "/private/user-data/obsidian-search",
      modelsDirectory: "/private/models",
      openExternal: async () => undefined,
      realpath: async (path) => path,
      fileSystem,
      factories: { index: () => { throw Object.assign(new Error("EACCES /private/user-data"), { code: "EACCES" }); } },
    });

    expect(fileSystem.lstat).not.toHaveBeenCalled();
    expect(fileSystem.rename).not.toHaveBeenCalled();
    expect(runtime.status()).toMatchObject({ state: "error", message: "Obsidian 全库索引暂时不可用。" });
    expect(JSON.stringify(runtime.status())).not.toContain("/private");
  });

  it("does not quarantine or retry a production index open failure", async () => {
    const root = await temporaryRoot();
    const parentFile = join(root, "parent-file");
    await writeFile(parentFile, "not a directory");
    const fileSystem: ObsidianSearchRuntimeFileSystem = {
      lstat: vi.fn(lstat),
      rename: vi.fn(async () => undefined),
    };
    const indexFactory = vi.fn((path: string) => new ObsidianSearchIndex(path));

    const runtime = await createObsidianSearchRuntime({
      vaultPath: join(root, "Vault"),
      indexRoot: parentFile,
      modelsDirectory: join(root, "models"),
      openExternal: async () => undefined,
      realpath: async (path) => path,
      fileSystem,
      factories: { index: indexFactory },
    });

    expect(runtime.status()).toMatchObject({
      state: "error",
      message: "Obsidian 全库索引暂时不可用。",
    });
    expect(fileSystem.lstat).not.toHaveBeenCalled();
    expect(fileSystem.rename).not.toHaveBeenCalled();
    expect(indexFactory).toHaveBeenCalledOnce();
  });

  it("quarantines raw corrupt SQLite bytes through the production index wrapper", async () => {
    const root = await temporaryRoot();
    const vault = join(root, "Vault");
    const indexRoot = join(root, "obsidian-search");
    const indexPath = derivedIndexPath(indexRoot, vault);
    await mkdir(dirname(indexPath), { recursive: true });
    await writeFile(indexPath, "this is not SQLite");
    const indexFactory = vi.fn((path: string) => new ObsidianSearchIndex(path));

    const runtime = await createObsidianSearchRuntime({
      vaultPath: join(root, "Vault"),
      indexRoot,
      modelsDirectory: join(root, "models"),
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T01:02:03.004Z"),
      randomUUID: () => "raw-corruption",
      realpath: async () => vault,
      factories: {
        index: indexFactory,
        embedding: () => ({
          embed: vi.fn(),
          close: vi.fn(async () => undefined),
        }),
      },
    });

    expect(runtime.status()).toMatchObject({ state: "idle" });
    expect(indexFactory).toHaveBeenCalledTimes(2);
    await expect(
      readFile(
        `${indexPath}.corrupt-20260818T010203004Z-rawcorruption`,
        "utf8",
      ),
    ).resolves.toBe("this is not SQLite");
    await runtime.close();
  });

  it("refuses a quarantine destination collision without moving any source", async () => {
    const root = await temporaryRoot();
    const vault = join(root, "Vault");
    const indexRoot = join(root, "obsidian-search");
    const indexPath = derivedIndexPath(indexRoot, vault);
    await mkdir(dirname(indexPath), { recursive: true });
    await writeFile(indexPath, "live-db");
    await writeFile(`${indexPath}-wal`, "live-wal");
    const suffix = ".corrupt-20260818T010203004Z-collisionid";
    await writeFile(`${indexPath}${suffix}`, "existing-quarantine");
    const renameFile = vi.fn(rename);

    const runtime = await createObsidianSearchRuntime({
      vaultPath: join(root, "Vault"),
      indexRoot,
      modelsDirectory: join(root, "models"),
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T01:02:03.004Z"),
      randomUUID: () => "collision-id",
      realpath: async () => vault,
      fileSystem: { lstat, rename: renameFile },
      factories: {
        index: () => {
          throw new ObsidianSearchIndexSchemaError("invalid");
        },
      },
    });

    expect(runtime.status().state).toBe("error");
    expect(renameFile).not.toHaveBeenCalled();
    expect(await readFile(indexPath, "utf8")).toBe("live-db");
    expect(await readFile(`${indexPath}-wal`, "utf8")).toBe("live-wal");
    expect(await readFile(`${indexPath}${suffix}`, "utf8")).toBe(
      "existing-quarantine",
    );
  });

  it("rolls back completed sidecar renames when the main quarantine rename fails", async () => {
    const root = await temporaryRoot();
    const vault = join(root, "Vault");
    const indexRoot = join(root, "obsidian-search");
    const indexPath = derivedIndexPath(indexRoot, vault);
    await mkdir(dirname(indexPath), { recursive: true });
    const files = new Map([
      [indexPath, "db-bytes"],
      [`${indexPath}-wal`, "wal-bytes"],
      [`${indexPath}-shm`, "shm-bytes"],
    ]);
    await Promise.all([...files].map(([path, bytes]) => writeFile(path, bytes)));
    const renameFile = vi.fn(async (source: string, destination: string) => {
      if (source === indexPath) throw new Error(`rename failed ${indexPath}`);
      await rename(source, destination);
    });

    const runtime = await createObsidianSearchRuntime({
      vaultPath: join(root, "Vault"),
      indexRoot,
      modelsDirectory: join(root, "models"),
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T01:02:03.004Z"),
      randomUUID: () => "rollback-success",
      realpath: async () => vault,
      fileSystem: { lstat, rename: renameFile },
      factories: {
        index: () => {
          throw new ObsidianSearchIndexSchemaError("invalid");
        },
      },
    });

    expect(runtime.status().state).toBe("error");
    for (const [path, bytes] of files) {
      expect(await readFile(path, "utf8")).toBe(bytes);
    }
    expect(renameFile).toHaveBeenCalledTimes(5);
  });

  it("keeps failures generic when quarantine rollback also fails", async () => {
    const root = await temporaryRoot();
    const vaultNote = join(root, "Vault", "Knowledge", "ordinary.md");
    const decisionDb = join(root, "user-data", "index.sqlite");
    const vault = join(root, "Vault");
    const indexRoot = join(root, "user-data", "obsidian-search");
    const indexPath = derivedIndexPath(indexRoot, vault);
    await mkdir(dirname(vaultNote), { recursive: true });
    await mkdir(dirname(indexPath), { recursive: true });
    await writeFile(vaultNote, "vault-bytes");
    await writeFile(decisionDb, "decision-bytes");
    await writeFile(indexPath, "db-bytes");
    await writeFile(`${indexPath}-wal`, "wal-bytes");
    const renameFile = vi.fn(async (source: string, destination: string) => {
      if (source === indexPath || source.includes(".corrupt-")) {
        throw new Error(`private rollback failure ${source}`);
      }
      await rename(source, destination);
    });

    const runtime = await createObsidianSearchRuntime({
      vaultPath: join(root, "Vault"),
      indexRoot,
      modelsDirectory: join(root, "models"),
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T01:02:03.004Z"),
      randomUUID: () => "rollback-failure",
      realpath: async () => vault,
      fileSystem: { lstat, rename: renameFile },
      factories: {
        index: () => {
          throw new ObsidianSearchIndexSchemaError("invalid");
        },
      },
    });

    expect(runtime.status().message).toBe("Obsidian 全库索引暂时不可用。");
    expect(JSON.stringify(runtime.status())).not.toContain(root);
    expect(await readFile(vaultNote, "utf8")).toBe("vault-bytes");
    expect(await readFile(decisionDb, "utf8")).toBe("decision-bytes");
  });

  it("uses distinct quarantine destinations for runtimes created in the same millisecond", async () => {
    const root = await temporaryRoot();
    const now = () => new Date("2026-08-18T01:02:03.004Z");
    const ids = ["runtime-one", "runtime-two"];
    const quarantineDestinations: string[] = [];
    for (const [index, id] of ids.entries()) {
      const vault = join(root, "Vault");
      const indexRoot = join(root, `runtime-${index}`);
      const indexPath = derivedIndexPath(indexRoot, vault);
      await mkdir(dirname(indexPath), { recursive: true });
      await writeFile(indexPath, `db-${index}`);
      const renameFile = async (source: string, destination: string) => {
        quarantineDestinations.push(destination.slice(source.length));
        await rename(source, destination);
      };
      let attempts = 0;
      const runtime = await createObsidianSearchRuntime({
        vaultPath: join(root, "Vault"),
        indexRoot,
        modelsDirectory: join(root, "models"),
        openExternal: async () => undefined,
        now,
        randomUUID: () => id,
        realpath: async () => vault,
        fileSystem: { lstat, rename: renameFile },
        factories: {
          index: () => {
            attempts += 1;
            if (attempts === 1) {
              throw new ObsidianSearchIndexSchemaError("invalid");
            }
            return indexFixture();
          },
        },
      });
      await runtime.close();
    }

    expect(quarantineDestinations).toEqual([
      ".corrupt-20260818T010203004Z-runtimeone",
      ".corrupt-20260818T010203004Z-runtimetwo",
    ]);
  });

  it("disables the runtime when quarantine cannot rename and leaves the original in place", async () => {
    const root = await temporaryRoot();
    const vault = join(root, "Vault");
    const indexRoot = join(root, "obsidian-search");
    const indexPath = derivedIndexPath(indexRoot, vault);
    await mkdir(dirname(indexPath), { recursive: true });
    await writeFile(indexPath, "original-index-bytes");
    const fileSystem: ObsidianSearchRuntimeFileSystem = {
      lstat,
      rename: vi.fn(async () => { throw new Error("read-only filesystem /secret/index.sqlite"); }),
    };
    const indexFactory = vi.fn(() => { throw new ObsidianSearchIndexSchemaError("invalid"); });
    const runtime = await createObsidianSearchRuntime({
      vaultPath: "/vault",
      indexRoot,
      modelsDirectory: "/models",
      openExternal: async () => undefined,
      fileSystem,
      realpath: async () => vault,
      factories: { index: indexFactory },
    });

    expect(indexFactory).toHaveBeenCalledOnce();
    expect(fileSystem.rename).toHaveBeenCalledOnce();
    expect(await readFile(indexPath, "utf8")).toBe("original-index-bytes");
    expect(runtime.status().message).toBe("Obsidian 全库索引暂时不可用。");
    expect(JSON.stringify(runtime.status())).not.toContain("secret");
  });

  it("returns an honest generic disabled API and remains idempotent", async () => {
    const runtime = await createObsidianSearchRuntime({
      vaultPath: "/raw/private/vault",
      indexRoot: "/raw/private/obsidian-search",
      modelsDirectory: "/raw/private/models",
      openExternal: async () => undefined,
      realpath: async (path) => path,
      factories: { repository: () => { throw new Error("raw private failure /raw/private/vault"); } },
    });

    runtime.start();
    runtime.start();
    const status = runtime.status();
    expect(status).toEqual({
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
      message: "Obsidian 全库索引暂时不可用。",
    });
    await expect(runtime.search({ query: "private", limit: 3 })).resolves.toEqual({
      query: "private",
      results: [],
      status,
    });
    await expect(runtime.rebuild()).resolves.toEqual(status);
    await expect(runtime.openNote("note.md")).rejects.toThrow("Obsidian 全库索引暂时不可用。");
    await runtime.close();
    await runtime.close();
    expect(JSON.stringify(status)).not.toContain("/raw/private");
  });

  it("cleans created resources in reverse ownership order after partial composition failure", async () => {
    const order: string[] = [];
    const index = indexFixture(vi.fn(() => order.push("index")));
    const embedding = { embed: vi.fn(), close: vi.fn(async () => { order.push("embedding"); }) };
    const watcher = { start: vi.fn(), close: vi.fn(async () => { order.push("watcher"); }) };

    const runtime = await createObsidianSearchRuntime({
      vaultPath: "/vault",
      indexRoot: "/user-data/obsidian-search",
      modelsDirectory: "/models",
      openExternal: async () => undefined,
      realpath: async (path) => path,
      factories: {
        repository: () => ({ iterate: vi.fn(emptyVaultEntries), resolveNotePath: vi.fn() }),
        index: () => index,
        embedding: () => embedding,
        watcher: () => watcher,
        service: (options) => {
          options.watcherFactory(vi.fn(), vi.fn());
          throw new Error("service composition failed");
        },
      },
    });

    expect(runtime.status().state).toBe("error");
    expect(order).toEqual(["watcher", "embedding", "index"]);
    await runtime.close();
    expect(order).toEqual(["watcher", "embedding", "index"]);
  });
});
