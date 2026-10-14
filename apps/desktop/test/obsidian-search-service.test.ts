import { chmod, mkdir, mkdtemp, open, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ObsidianSearchIndex,
  ObsidianVaultRepository,
  type ObsidianIndexedChunk,
  type ObsidianIndexedNoteInput,
  type ObsidianVaultScan,
  type ObsidianVaultScanEntry,
} from "@cognelis/decision-storage";
import { QwenEmbeddingProviderError } from "../src/main/semantic/qwen-embedding-provider.js";
import type { EmbeddingBatch } from "../src/main/model/embedding-provider.js";
import {
  ObsidianSearchService,
  type ObsidianSearchServiceOptions,
} from "../src/main/obsidian-search/obsidian-search-service.js";

const roots: string[] = [];
const services: ObsidianSearchService[] = [];

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((service) => service.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "obsidian-search-service-"));
  roots.push(root);
  return root;
};

const unit = (values: number[]): number[] => {
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return values.map((value) => value / magnitude);
};

const vectorFor = (text: string): number[] =>
  /回滚|回退|上线风险|rollback/iu.test(text)
    ? unit([1, 0, 0])
    : /午餐|lunch/iu.test(text)
      ? unit([0, 1, 0])
      : unit([0, 0, 1]);

class FakeEmbedding {
  model = "test-model";
  calls: string[][] = [];
  signals: Array<AbortSignal | undefined> = [];
  closed = false;
  behavior: (texts: string[], call: number) => Promise<{ model: string; vectors: number[][] }>;

  constructor(
    behavior: (texts: string[], call: number) => Promise<{ model: string; vectors: number[][] }> = async (texts) => ({
      model: "test-model",
      vectors: texts.map(vectorFor),
    }),
  ) {
    this.behavior = behavior;
  }

  async embed(
    texts: string[],
    signal?: AbortSignal,
  ): Promise<{ model: string; vectors: number[][] }> {
    this.calls.push([...texts]);
    this.signals.push(signal);
    const result = await this.behavior(texts, this.calls.length);
    return { ...result, model: result.model || this.model };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

interface CapturedWatcher {
  change(): void;
  error(): void;
  starts: number;
  closes: number;
}

const watcherHarness = (): {
  factory: ObsidianSearchServiceOptions["watcherFactory"];
  watcher: CapturedWatcher;
} => {
  let onChange = (): void => undefined;
  let onError = (): void => undefined;
  const watcher: CapturedWatcher = {
    change: () => onChange(),
    error: () => onError(),
    starts: 0,
    closes: 0,
  };
  return {
    watcher,
    factory: (change, error) => {
      onChange = change;
      onError = error;
      return {
        start: () => { watcher.starts += 1; },
        close: async () => { watcher.closes += 1; },
      };
    },
  };
};

const timerHarness = () => {
  const timers: Array<{ callback: () => void; cleared: boolean; fired: boolean }> = [];
  return {
    setTimer: (callback: () => void) => {
      const timer = { callback, cleared: false, fired: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle: unknown) => { (handle as { cleared: boolean }).cleared = true; },
    flush: () => {
      let timer: (typeof timers)[number] | undefined;
      for (let index = timers.length - 1; index >= 0; index -= 1) {
        const candidate = timers[index]!;
        if (!candidate.cleared && !candidate.fired) { timer = candidate; break; }
      }
      if (timer === undefined) throw new Error("no pending timer");
      timer.fired = true;
      timer.callback();
    },
  };
};

const shutdownTimerHarness = () => {
  const timers: Array<{ callback: () => void; cleared: boolean; fired: boolean }> = [];
  return {
    setTimer: (callback: () => void) => {
      const timer = { callback, cleared: false, fired: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle: unknown) => {
      (handle as { cleared: boolean }).cleared = true;
    },
    flush: () => {
      const timer = timers.find((candidate) => !candidate.cleared && !candidate.fired);
      if (timer === undefined) throw new Error("no pending shutdown timer");
      timer.fired = true;
      timer.callback();
    },
    pending: () => timers.filter((timer) => !timer.cleared && !timer.fired).length,
  };
};

const writeNote = async (vault: string, relativePath: string, content: string): Promise<void> => {
  const absolute = join(vault, ...relativePath.split("/"));
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content, "utf8");
};

const createRealService = async (options: {
  embedding?: FakeEmbedding;
  timers?: ReturnType<typeof timerHarness>;
} = {}) => {
  const root = await temporaryRoot();
  const vault = join(root, "vault");
  await mkdir(vault);
  const index = new ObsidianSearchIndex(join(root, "search.sqlite"));
  const embedding = options.embedding ?? new FakeEmbedding();
  const watcher = watcherHarness();
  const service = new ObsidianSearchService({
    repository: new ObsidianVaultRepository(vault),
    index,
    embedding,
    watcherFactory: watcher.factory,
    openExternal: vi.fn(async () => undefined),
    now: () => new Date("2026-08-18T10:00:00.000Z"),
    ...(options.timers === undefined ? {} : {
      setTimer: options.timers.setTimer,
      clearTimer: options.timers.clearTimer,
    }),
  });
  services.push(service);
  return { root, vault, index, embedding, watcher: watcher.watcher, service };
};

const storedNote = (
  relativePath: string,
  title: string,
  text: string,
  options: { hash?: string; model?: string | null; vector?: number[] | null } = {},
): ObsidianIndexedNoteInput => {
  const model = options.model === undefined ? "test-model" : options.model;
  return {
    relativePath,
    title,
    contentHash: options.hash ?? `hash-${relativePath}`,
    size: text.length,
    modifiedAtMs: 1,
    model,
    chunks: [{
      id: `chunk-${relativePath}`,
      ordinal: 0,
      heading: null,
      text,
      contentHash: `chunk-hash-${relativePath}-${options.hash ?? "default"}`,
      vector: model === null ? null : (options.vector ?? vectorFor(text)),
    }],
  };
};

const emptyIndex = (): ObsidianSearchServiceOptions["index"] => ({
  semanticCoverage: () => ({ totalNotes: 0, semanticNotes: 0, keywordOnlyNotes: 0, mismatchedModelNotes: 0 }),
  noteMetadataForPath: () => null,
  hasNoteDescendant: () => false,
  replaceNote: () => undefined,
  prune: () => undefined,
  markSynchronized: () => undefined,
  snapshot: () => ({ noteCount: 0, chunkCount: 0, synchronizedAt: null }),
  hasNote: () => false,
  iterateChunks: function* () { return; },
  close: () => undefined,
});

const scanEntries = async function* (scan: ObsidianVaultScan): AsyncIterableIterator<ObsidianVaultScanEntry> {
  for (const note of scan.notes) yield { kind: "note", note };
  for (const diagnostic of scan.diagnostics) yield { kind: "diagnostic", diagnostic };
};

const waitUntil = async (predicate: () => boolean): Promise<void> => {
  await vi.waitFor(() => {
    if (!predicate()) throw new Error("condition was not reached");
  }, { timeout: 5_000, interval: 5 });
};

describe("ObsidianSearchService synchronization", () => {
  it("waits by elapsed deadline instead of a fixed event-loop turn count", async () => {
    let ready = false;
    const delayed = (async () => {
      for (let turn = 0; turn < 150; turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      ready = true;
    })();
    try {
      await waitUntil(() => ready);
      expect(ready).toBe(true);
    } finally {
      await delayed;
    }
  });

  it("indexes project notes and leaves this app's own Markdown to the decision services", async () => {
    const { vault, index, service, embedding } = await createRealService();
    await writeNote(vault, "Projects/roadmap.md", "# Roadmap\nShip the desktop search");
    await writeNote(vault, "Decision Journal/2026-08-18.md", "# Decision\nKeep a rollback path");
    await writeNote(
      vault,
      "Decision Journal/decisions/2026/08/rollback.md",
      "# Decision\nKeep a rollback path",
    );

    const status = await service.rebuild();

    // A decision is searchable through DecisionContextService; indexing it here
    // too would return one record twice by two unrelated routes.
    expect(index.noteMetadata().map((note) => note.relativePath)).toEqual([
      "Projects/roadmap.md",
    ]);
    expect(status).toMatchObject({
      state: "ready",
      discoveredNotes: 1,
      indexedNotes: 1,
      processedNotes: 1,
      totalNotes: 1,
      skippedNotes: 0,
      failedNotes: 0,
      synchronizedAt: "2026-08-18T10:00:00.000Z",
      semanticAvailable: true,
      message: null,
    });
    expect(status.chunkCount).toBeGreaterThanOrEqual(1);
    expect(embedding.calls[0]).toHaveLength(1);
    expect(embedding.calls.slice(1).every((batch) => batch.length <= 16)).toBe(true);
    expect(embedding.signals.every((signal) => signal instanceof AbortSignal)).toBe(
      true,
    );
  });

  it("reads the chunks for one search and keeps them for the next, until a sync writes or prunes the index", async () => {
    const { vault, index, service } = await createRealService();
    await writeNote(vault, "Projects/cache.md", "# Cache\nRollback the cache migration first");
    await writeNote(vault, "Projects/deploy.md", "# Deploy\nShip behind a flag");
    await service.rebuild();
    const reads = vi.spyOn(index, "iterateChunks");

    // Every query decoded each chunk's vector and normalized its text again: half a second at three thousand notes.
    const first = await service.search({ query: "rollback" });
    const second = await service.search({ query: "rollback" });
    expect(second.results).toEqual(first.results);
    expect(first.results.map((result) => result.relativePath)).toContain("Projects/cache.md");
    expect(reads).toHaveBeenCalledTimes(1);

    // A note changed in the vault: the next search reads what the sync wrote, its text and its vector, not what
    // it kept.
    await writeNote(vault, "Projects/cache.md", "# Cache\nWarm the replica before the cutover");
    await service.rebuild();
    expect((await service.search({ query: "replica" })).results[0]).toMatchObject({ relativePath: "Projects/cache.md", matchKind: "hybrid" });
    expect((await service.search({ query: "rollback" })).results).toEqual([]);
    expect(reads).toHaveBeenCalledTimes(2);

    // And one deleted: pruned, it is not found from what was kept.
    await rm(join(vault, "Projects/deploy.md"));
    await service.rebuild();
    expect((await service.search({ query: "flag" })).results.map((result) => result.relativePath)).not.toContain("Projects/deploy.md");
    expect(reads).toHaveBeenCalledTimes(3);
  });

  it("indexes a valid note after Unicode-safe title truncation", async () => {
    const { vault, index, service } = await createRealService();
    await writeNote(vault, "long-title.md", `# ${"🙂".repeat(600)}\nkeep rollback capability`);

    const status = await service.rebuild();

    expect(status).toMatchObject({
      state: "ready",
      indexedNotes: 1,
      failedNotes: 0,
      semanticAvailable: true,
    });
    expect(index.noteMetadata()[0]?.title).toBe("🙂".repeat(500));
    expect(index.hasNote("long-title.md")).toBe(true);
  });

  it("replaces streamed notes immediately and aborts without reading or committing the remainder", async () => {
    const first = {
      relativePath: "large.md",
      content: "x".repeat(5 * 1024 * 1024),
      contentHash: "large-hash",
      size: 5 * 1024 * 1024,
      modifiedAtMs: 1,
    };
    let iteratorClosed = false;
    let secondYielded = false;
    let replaceCount = 0;
    let pruneCount = 0;
    let markCount = 0;
    let retainedBodies: number | undefined;
    const index = emptyIndex();
    index.replaceNote = () => { replaceCount += 1; };
    index.prune = () => { pruneCount += 1; };
    index.markSynchronized = () => { markCount += 1; };
    const repository = {
      iterate: async function* (signal?: AbortSignal): AsyncIterableIterator<ObsidianVaultScanEntry> {
        try {
          yield { kind: "note", note: first };
          await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
          if (!signal?.aborted) {
            secondYielded = true;
            yield { kind: "note", note: { ...first, relativePath: "second.md" } };
          }
        } finally {
          iteratorClosed = true;
        }
      },
      resolveNotePath: async () => "/unused.md",
    };
    const service = new ObsidianSearchService({
      repository,
      index,
      embedding: new FakeEmbedding(async () => { throw new QwenEmbeddingProviderError("model_missing", "missing"); }),
      watcherFactory: watcherHarness().factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
      onSynchronizationDiagnostics: (diagnostics: { retainedNoteBodies: number }) => {
        retainedBodies = diagnostics.retainedNoteBodies;
      },
    } as unknown as ObsidianSearchServiceOptions);
    services.push(service);

    service.start();
    await waitUntil(() => replaceCount === 1);
    await service.close();

    expect(retainedBodies).toBe(0);
    expect(iteratorClosed).toBe(true);
    expect(secondYielded).toBe(false);
    expect(pruneCount).toBe(0);
    expect(markCount).toBe(0);
  });

  it("starts once, synchronizes in the background, and coalesces debounced watcher bursts", async () => {
    const timers: Array<{ callback: () => void; cleared: boolean }> = [];
    let scans = 0;
    const repository = {
      iterate: () => { scans += 1; return scanEntries({ notes: [], diagnostics: [] }); },
      resolveNotePath: async () => "/unused.md",
    };
    const root = await temporaryRoot();
    const index = new ObsidianSearchIndex(join(root, "search.sqlite"));
    const embedding = new FakeEmbedding();
    const watcher = watcherHarness();
    const service = new ObsidianSearchService({
      repository,
      index,
      embedding,
      watcherFactory: watcher.factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
      setTimer: (callback) => {
        const timer = { callback, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimer: (timer) => { (timer as { cleared: boolean }).cleared = true; },
    });
    services.push(service);

    service.start();
    service.start();
    await waitUntil(() => scans === 1 && service.status().state !== "indexing");
    watcher.watcher.change();
    watcher.watcher.change();
    watcher.watcher.change();

    expect(watcher.watcher.starts).toBe(1);
    expect(timers).toHaveLength(3);
    expect(timers.slice(0, 2).every((timer) => timer.cleared)).toBe(true);
    timers[2]!.callback();
    await waitUntil(() => scans === 2);
    expect(scans).toBe(2);

    watcher.watcher.error();
    expect(service.status()).toMatchObject({ state: "error", message: "Obsidian 文件监听暂时不可用。" });
    expect(JSON.stringify(service.status())).not.toContain("/unused");
  });

  it.each(["factory", "start"] as const)("still performs the initial scan when watcher %s throws", async (phase) => {
    let scans = 0;
    let watcherCloses = 0;
    const index = emptyIndex();
    const service = new ObsidianSearchService({
      repository: {
        iterate: () => { scans += 1; return scanEntries({ notes: [], diagnostics: [] }); },
        resolveNotePath: async () => "/unused.md",
      },
      index,
      embedding: new FakeEmbedding(),
      watcherFactory: () => {
        if (phase === "factory") throw new Error("/private/watch factory failed");
        return {
          start: () => { throw new Error("/private/watch start failed"); },
          close: async () => { watcherCloses += 1; },
        };
      },
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    });
    services.push(service);

    expect(() => service.start()).not.toThrow();
    await waitUntil(() => scans === 1 && service.status().state !== "indexing");

    expect(service.status()).toMatchObject({ state: "error", message: "Obsidian 文件监听暂时不可用。" });
    expect(JSON.stringify(service.status())).not.toContain("/private/watch");
    expect(watcherCloses).toBe(phase === "start" ? 1 : 0);
    await service.close();
    expect(watcherCloses).toBe(phase === "start" ? 1 : 0);
  });

  it("runs a sync asked for just as the running one finishes, however the two interleave", async () => {
    const ticks = async (count: number): Promise<void> => { for (let tick = 0; tick < count; tick += 1) await Promise.resolve(); };
    const outcomes: Array<{ state: string; walks: number }> = [];
    // Each run moves a search's model probe a microtask later, past every point where the running sync can end.
    for (let delay = 0; delay < 20; delay += 1) {
      const root = await temporaryRoot();
      const index = new ObsidianSearchIndex(join(root, "search.sqlite"));
      // Keyword-only, so a search asks for a sync to embed it.
      index.replaceNote(storedNote("stuck.md", "stuck", "rollback stuck", { model: null }));
      let walks = 0;
      let searched: Promise<unknown> = Promise.resolve();
      const service: ObsidianSearchService = new ObsidianSearchService({
        repository: {
          iterate: async function* () {
            walks += 1;
            if (walks === 1) searched = service.search({ query: "rollback" }).catch(() => undefined);
            yield { kind: "diagnostic" as const, diagnostic: { relativePath: "stuck.md", reason: "unreadable" } };
          },
          resolveNotePath: async () => join(root, "x.md"),
        },
        index,
        embedding: new FakeEmbedding(async (texts) => {
          if (walks > 0) await ticks(delay);
          return { model: "test-model", vectors: texts.map(() => [1, 0, 0]) };
        }),
        watcherFactory: watcherHarness().factory,
        openExternal: vi.fn(async () => undefined),
        now: () => new Date("2026-08-18T10:00:00.000Z"),
      });
      services.push(service);
      await service.rebuild();
      await searched;
      await new Promise((resolve) => setTimeout(resolve, 50));
      outcomes.push({ state: service.status().state, walks });
    }
    // Asked for after the drain's last look and before it let go, the sync joined a finished run: never run, one
    // walk, and 同步中 for good.
    expect(outcomes.filter((outcome) => outcome.state === "indexing")).toEqual([]);
  });

  it("reads only the notes changed since the last sync, by size and time, not the whole vault each time", async () => {
    const root = await temporaryRoot();
    const vault = join(root, "vault");
    await mkdir(vault);
    const minuteAgo = new Date(Date.now() - 60_000);
    for (let note = 0; note < 5; note += 1) {
      await writeNote(vault, `note-${note}.md`, `# Note ${note}\nrollback ${note}`);
      await utimes(join(vault, `note-${note}.md`), minuteAgo, minuteAgo);
    }
    const opened: string[] = [];
    const watcher = watcherHarness();
    const timers = timerHarness();
    const service = new ObsidianSearchService({
      repository: new ObsidianVaultRepository(vault, {
        open: (async (path: string, flags: number) => {
          opened.push(String(path));
          return open(path, flags);
        }) as typeof open,
      }),
      index: new ObsidianSearchIndex(join(root, "search.sqlite")),
      embedding: new FakeEmbedding(),
      watcherFactory: watcher.factory,
      openExternal: vi.fn(async () => undefined),
      now: () => new Date("2026-08-18T10:00:00.000Z"),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    services.push(service);
    expect((await service.rebuild()).indexedNotes).toBe(5);

    // One note saved in Obsidian; the watcher's sync after it.
    await writeNote(vault, "note-2.md", "# Note 2\nrollback 2, revised");
    const halfMinuteAgo = new Date(Date.now() - 30_000);
    await utimes(join(vault, "note-2.md"), halfMinuteAgo, halfMinuteAgo);
    service.start();
    await waitUntil(() => service.status().state !== "indexing");
    opened.length = 0;
    watcher.watcher.change();
    timers.flush();
    await waitUntil(() => service.status().state !== "indexing");

    // Opened, read and hashed, all five again for the one save.
    expect(opened.map((path) => path.slice(vault.length + 1))).toEqual([]);
    expect(service.status()).toMatchObject({ state: "ready", discoveredNotes: 5, indexedNotes: 5 });
    expect((await service.search({ query: "revised" })).results.map((result) => result.relativePath)).toEqual(["note-2.md"]);
  });

  it("reads again a note recorded before its save settled, so a second save in that clock slot is found", async () => {
    const root = await temporaryRoot();
    const vault = join(root, "vault");
    await mkdir(vault);
    // A volume whose clock keeps whole seconds (exFAT, HFS+): both saves below carry the same time.
    const slot = new Date(Math.floor((Date.now() - 60_000) / 1_000) * 1_000);
    await writeNote(vault, "plan.md", "# Plan\nalpha beta gamma");
    await utimes(join(vault, "plan.md"), slot, slot);
    const opened: string[] = [];
    const watcher = watcherHarness();
    const timers = timerHarness();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // Read half a second after the first save, as the watcher reads it.
      vi.setSystemTime(slot.getTime() + 500);
      const service = new ObsidianSearchService({
        repository: new ObsidianVaultRepository(vault, {
          open: (async (path: string, flags: number) => {
            opened.push(String(path));
            return open(path, flags);
          }) as typeof open,
        }),
        index: new ObsidianSearchIndex(join(root, "search.sqlite")),
        embedding: new FakeEmbedding(),
        watcherFactory: watcher.factory,
        openExternal: vi.fn(async () => undefined),
        now: () => new Date(),
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
      });
      services.push(service);
      expect((await service.rebuild()).indexedNotes).toBe(1);

      // A second save of the same size in the same second; the next sync comes once the note has settled.
      await writeNote(vault, "plan.md", "# Plan\nalpha zeta gamma");
      await utimes(join(vault, "plan.md"), slot, slot);
      vi.setSystemTime(slot.getTime() + 10_000);
      opened.length = 0;
      service.start();
      await waitUntil(() => service.status().state !== "indexing");
      // Trusted as recorded, the size and time matched and the note was never read: 「zeta」 was in no chunk.
      expect(opened.map((path) => path.slice(vault.length + 1))).toEqual(["plan.md"]);

      // Read once settled and recorded so, it is not read again until it changes.
      vi.setSystemTime(slot.getTime() + 20_000);
      opened.length = 0;
      watcher.watcher.change();
      timers.flush();
      await waitUntil(() => service.status().state !== "indexing");
      expect(opened).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a note read again and found the same, so a touch that changed only its time is not read every sync", async () => {
    const root = await temporaryRoot();
    const vault = join(root, "vault");
    await mkdir(vault);
    const minuteAgo = new Date(Date.now() - 60_000);
    await writeNote(vault, "plan.md", "# Plan\nalpha beta gamma");
    await utimes(join(vault, "plan.md"), minuteAgo, minuteAgo);
    const opened: string[] = [];
    const watcher = watcherHarness();
    const timers = timerHarness();
    const service = new ObsidianSearchService({
      repository: new ObsidianVaultRepository(vault, {
        open: (async (path: string, flags: number) => {
          opened.push(String(path));
          return open(path, flags);
        }) as typeof open,
      }),
      index: new ObsidianSearchIndex(join(root, "search.sqlite")),
      embedding: new FakeEmbedding(),
      watcherFactory: watcher.factory,
      openExternal: vi.fn(async () => undefined),
      now: () => new Date(),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    services.push(service);
    expect((await service.rebuild()).indexedNotes).toBe(1);

    // Touched (a sync tool, `touch`): its time moved, its text did not.
    const halfMinuteAgo = new Date(Date.now() - 30_000);
    await utimes(join(vault, "plan.md"), halfMinuteAgo, halfMinuteAgo);
    service.start();
    await waitUntil(() => service.status().state !== "indexing");
    opened.length = 0;
    watcher.watcher.change();
    timers.flush();
    await waitUntil(() => service.status().state !== "indexing");
    // Read, found the same and left recorded at its old time, it was read again at every sync.
    expect(opened).toEqual([]);
  });

  it("runs one synchronization at a time and queues one follow-up request", async () => {
    let scans = 0;
    let releaseFirst: (() => void) | undefined;
    const firstScan = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const repository = {
      iterate: async function* (): AsyncIterableIterator<ObsidianVaultScanEntry> {
        scans += 1;
        if (scans === 1) await firstScan;
        yield* scanEntries({ notes: [], diagnostics: [] });
      },
      resolveNotePath: async () => "/unused.md",
    };
    const root = await temporaryRoot();
    const index = new ObsidianSearchIndex(join(root, "search.sqlite"));
    const watcher = watcherHarness();
    let scheduled: (() => void) | undefined;
    const service = new ObsidianSearchService({
      repository,
      index,
      embedding: new FakeEmbedding(),
      watcherFactory: watcher.factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
      setTimer: (callback) => { scheduled = callback; return callback; },
      clearTimer: () => undefined,
    });
    services.push(service);

    service.start();
    let firstRebuild: Promise<unknown> | undefined;
    let secondRebuild: Promise<unknown> | undefined;
    try {
      await waitUntil(() => scans === 1);
      watcher.watcher.change();
      scheduled?.();
      firstRebuild = service.rebuild();
      secondRebuild = service.rebuild();
      expect(scans).toBe(1);
    } finally {
      releaseFirst?.();
    }
    await Promise.all([firstRebuild, secondRebuild]);

    expect(scans).toBe(2);
  });

  it("keeps a watcher failure sticky when an in-flight synchronization completes", async () => {
    let releaseScan: (() => void) | undefined;
    const blockedScan = new Promise<void>((resolve) => { releaseScan = resolve; });
    const watcher = watcherHarness();
    const index = emptyIndex();
    let synchronized = false;
    index.markSynchronized = () => { synchronized = true; };
    const service = new ObsidianSearchService({
      repository: {
        iterate: async function* () { await blockedScan; yield* scanEntries({ notes: [], diagnostics: [] }); },
        resolveNotePath: async () => "/unused.md",
      },
      index,
      embedding: new FakeEmbedding(),
      watcherFactory: watcher.factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    });
    services.push(service);

    service.start();
    try {
      await waitUntil(() => service.status().state === "indexing");
      watcher.watcher.error();
    } finally {
      releaseScan?.();
    }
    await waitUntil(() => synchronized);

    expect(service.status()).toMatchObject({
      state: "error",
      message: "Obsidian 文件监听暂时不可用。",
    });
  });

  it("runs a queued forced follow-up after a synchronization index failure", async () => {
    let scans = 0;
    let snapshotCalls = 0;
    let releaseScan: (() => void) | undefined;
    const blockedScan = new Promise<void>((resolve) => { releaseScan = resolve; });
    const index = emptyIndex();
    index.snapshot = () => {
      snapshotCalls += 1;
      if (snapshotCalls === 3) throw new Error("/private/db final snapshot failed");
      return { noteCount: 0, chunkCount: 0, synchronizedAt: null };
    };
    const service = new ObsidianSearchService({
      repository: {
        iterate: async function* () {
          scans += 1;
          if (scans === 1) await blockedScan;
          yield* scanEntries({ notes: [], diagnostics: [] });
        },
        resolveNotePath: async () => "/unused.md",
      },
      index,
      embedding: new FakeEmbedding(),
      watcherFactory: watcherHarness().factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    });
    services.push(service);

    service.start();
    let rebuilt: Promise<unknown> | undefined;
    try {
      await waitUntil(() => scans === 1);
      rebuilt = service.rebuild();
    } finally {
      releaseScan?.();
    }

    await expect(rebuilt).resolves.toMatchObject({ state: "ready" });
    expect(scans).toBe(2);
  });

  it("probes once per normal sync, embeds only stale notes, prunes deletes, and rebuilds on model change or force", async () => {
    const timers = timerHarness();
    const { vault, index, service, embedding, watcher } = await createRealService({ timers });
    await writeNote(vault, "a.md", "# Alpha\nfirst body");
    await writeNote(vault, "b.md", "# Beta\nsecond body");
    service.start();
    await waitUntil(() => service.status().state === "ready");
    const afterInitial = embedding.calls.length;

    watcher.change();
    timers.flush();
    await waitUntil(() => embedding.calls.length > afterInitial && service.status().state === "ready");
    expect(embedding.calls.length).toBe(afterInitial + 1);

    await writeNote(vault, "a.md", "# Alpha\nchanged rollback body");
    watcher.change();
    timers.flush();
    await waitUntil(() => index.iterateChunks().next().value?.text.includes("changed") === true);
    expect(embedding.calls.at(-1)?.some((text) => text.includes("changed"))).toBe(true);

    await rm(join(vault, "b.md"));
    watcher.change();
    timers.flush();
    await waitUntil(() => index.noteMetadata().length === 1);
    expect(index.hasNote("b.md")).toBe(false);

    embedding.behavior = async (texts) => ({ model: "next-model", vectors: texts.map(vectorFor) });
    watcher.change();
    timers.flush();
    await waitUntil(() => index.noteMetadata()[0]?.model === "next-model");
    expect(index.noteMetadata()[0]?.model).toBe("next-model");

    const beforeForce = embedding.calls.length;
    await service.rebuild();
    expect(embedding.calls.length).toBeGreaterThan(beforeForce + 1);
  });

  it("indexes keyword-only notes when the managed model is missing", async () => {
    const embedding = new FakeEmbedding(async () => {
      throw new QwenEmbeddingProviderError("model_missing", "absolute/model/path is absent");
    });
    const { vault, index, service } = await createRealService({ embedding });
    await writeNote(vault, "keyword.md", "# Keyword note\nsearchable fallback body");

    const status = await service.rebuild();

    expect(status).toMatchObject({
      state: "unavailable",
      semanticAvailable: false,
      failedNotes: 0,
      message: "本地嵌入模型未准备，当前仅使用关键词检索。",
    });
    expect(index.noteMetadata()[0]?.model).toBeNull();
    expect(index.iterateChunks().next().value?.vector).toBeNull();
    expect(status.synchronizedAt).toBe("2026-08-18T10:00:00.000Z");
    expect(JSON.stringify(status)).not.toContain("absolute/model/path");
  });

  it("passes over a note named so the index cannot hold it, and indexes and prunes the rest", async () => {
    const { vault, index, service } = await createRealService();
    index.replaceNote(storedNote("deleted.md", "Deleted", "gone from the vault"));
    // A Finder name typed with a "/" is stored with a ":"; a Windows zip unpacks a "\" into the name.
    await writeFile(join(vault, "C:C++ 笔记.md"), "# C++\n指针与引用", "utf8");
    await writeFile(join(vault, "项目\\周报.md"), "# 周报\n本周进展", "utf8");
    await writeNote(vault, "z-later.md", "# Later\nrollback guidance");

    const status = await service.rebuild();

    // Thrown at the index lookup, it stopped the whole sync there: nothing after it indexed, nothing pruned.
    expect(status).toMatchObject({ state: "ready", skippedNotes: 2 });
    expect(index.hasNote("z-later.md")).toBe(true);
    expect(index.hasNote("deleted.md")).toBe(false);
  });

  it("finds words as the excerpt shows them, and puts a note with every word above notes with one", async () => {
    // Keyword ranking alone, as without a model.
    const { vault, service } = await createRealService({
      embedding: new FakeEmbedding(async () => {
        throw new QwenEmbeddingProviderError("model_missing", "not installed");
      }),
    });
    await writeNote(vault, "灰度.md", "# 发布\n我们**决定**采用灰度发布，详见 [[发布规范|规范]]。");
    await writeNote(vault, "会议纪要.md", "# 周会\n讨论了预算，也讨论了招聘。");
    for (let note = 0; note < 3; note += 1) await writeNote(vault, `预算/预算 ${note}.md`, `# 预算 ${note}\n预算明细`);
    await service.rebuild();

    // Copied from the excerpt, which shows no "**": it found nothing.
    expect((await service.search({ query: "决定采用灰度发布" })).results[0]).toMatchObject({ relativePath: "灰度.md" });
    expect((await service.search({ query: "详见 规范" })).results[0]).toMatchObject({ relativePath: "灰度.md" });
    // The one note about both, under notes with one word in title, heading and path.
    expect((await service.search({ query: "预算 招聘" })).results[0]).toMatchObject({ relativePath: "会议纪要.md" });
  });

  it("splits a query into words as the decisions in the same box are searched", async () => {
    const { vault, service } = await createRealService({
      embedding: new FakeEmbedding(async () => {
        throw new QwenEmbeddingProviderError("model_missing", "not installed");
      }),
    });
    await writeNote(vault, "缓存方案.md", "# 缓存方案\n用 Redis 作为缓存，过期时间一小时。");
    await service.rebuild();

    // Split on spaces only, each was one string found in no note, where the decisions beside them were found.
    for (const query of ["Redis、缓存", "使用Redis缓存", "Redis，缓存"]) {
      expect((await service.search({ query })).results.map((result) => result.relativePath)).toEqual(["缓存方案.md"]);
    }
  });

  it("folds a query's words as it folds the notes, whatever the system's language", async () => {
    // Turkish (and Azerbaijani, Lithuanian) lower-case "I" as a dotless "ı" by locale, and as "i" otherwise.
    const turkish = vi.spyOn(String.prototype, "toLocaleLowerCase").mockImplementation(function (this: string) {
      return this.replace(/I/gu, "ı").toLowerCase();
    });
    try {
      const { vault, service } = await createRealService({
        embedding: new FakeEmbedding(async () => {
          throw new QwenEmbeddingProviderError("model_missing", "not installed");
        }),
      });
      await writeNote(vault, "行程.md", "# 行程\nIstanbul 的会议安排");
      await writeNote(vault, "差旅.md", "# 差旅\n出差报销流程");
      await service.rebuild();

      // Folded the decisions' way, the query's "istanbul" met the note's "ıstanbul", and that note was not found.
      expect((await service.search({ query: "出差 Istanbul" })).results.map((result) => result.relativePath)).toContain("行程.md");
    } finally {
      turkish.mockRestore();
    }
  });

  it("does not match every note on the .md every path ends with", async () => {
    const { vault, service } = await createRealService({
      embedding: new FakeEmbedding(async () => {
        throw new QwenEmbeddingProviderError("model_missing", "not installed");
      }),
    });
    await writeNote(vault, "预算.md", "# 预算\n季度明细");
    await writeNote(vault, "招聘.md", "# 招聘\n岗位说明");
    await service.rebuild();

    // Matched in the path, "md" and "." found every note as a phrase.
    expect((await service.search({ query: "md" })).results).toEqual([]);
    expect((await service.search({ query: "." })).results).toEqual([]);
  });

  it("reads the vault again on no search while a note it cannot read stays keyword-only or of an older model", async () => {
    let model: string | null = null;
    const embedding = new FakeEmbedding(async (texts) => {
      if (model === null) throw new QwenEmbeddingProviderError("model_missing", "not installed");
      return { model, vectors: texts.map(vectorFor) };
    });
    const { vault, index, service } = await createRealService({ embedding });
    for (let note = 0; note < 3; note += 1) await writeNote(vault, `note-${note}.md`, `# Note ${note}\nrollback ${note}`);
    await writeNote(vault, "stuck.md", "# Stuck\nrollback stuck");
    await writeNote(vault, "old.md", "# Old\nrollback old");
    await service.rebuild(); // no model yet: every note keyword-only
    model = "model-v1";
    await chmod(join(vault, "stuck.md"), 0o000);
    try {
      await service.rebuild(); // embedded, all but the one it cannot read
      model = "model-v2";
      await chmod(join(vault, "old.md"), 0o000);
      await service.rebuild(); // embedded again, but old.md, unreadable, keeps model-v1
      expect(index.semanticCoverage("model-v2")).toMatchObject({ semanticNotes: 4, keywordOnlyNotes: 1, mismatchedModelNotes: 1 });
      const syncs = (): number => embedding.calls.filter((texts) => texts.some((text) => text.includes("model probe"))).length;
      const before = syncs();

      for (let search = 0; search < 3; search += 1) {
        // Each queued a full pass over the vault, to read it all again and embed nothing, and said 同步中.
        expect((await service.search({ query: "rollback" })).status.state).not.toBe("indexing");
      }
      await waitUntil(() => service.status().state !== "indexing");
      expect(syncs() - before).toBe(0);
    } finally {
      await chmod(join(vault, "stuck.md"), 0o644);
      await chmod(join(vault, "old.md"), 0o644);
    }
  });

  it("embeds nothing of the vault again on each search while a note the model will not take stays keyword-only", async () => {
    const embedding = new FakeEmbedding(async (texts) => {
      if (texts.some((text) => text.includes("模型不接受"))) throw new Error("Input is longer than the context size");
      return { model: "test-model", vectors: texts.map(vectorFor) };
    });
    const { vault, service } = await createRealService({ embedding });
    await writeNote(vault, "rejected.md", "# Rejected\n模型不接受的内容");
    for (let note = 0; note < 5; note += 1) await writeNote(vault, `note-${note}.md`, `# Note ${note}\nrollback ${note}`);
    await service.rebuild();
    const afterSync = embedding.calls.length;

    for (const query of ["rollback", "回滚", "Note"]) await service.search({ query });
    await waitUntil(() => service.status().state !== "indexing");

    // One embedding a search, of its query: forced syncs embedded every note again on each.
    expect(embedding.calls.length - afterSync).toBe(3);
    expect((await service.search({ query: "模型不接受" })).results[0]).toMatchObject({ relativePath: "rejected.md" });
  });

  it("embeds keyword-only notes once the model is back, though notes it refused were deleted meanwhile", async () => {
    let available = true;
    const embedding = new FakeEmbedding(async (texts) => {
      if (!available) throw new QwenEmbeddingProviderError("model_missing", "not installed");
      if (texts.some((text) => text.includes("模型不接受"))) throw new Error("Input is longer than the context size");
      return { model: "test-model", vectors: texts.map(vectorFor) };
    });
    const { vault, index, service } = await createRealService({ embedding });
    await writeNote(vault, "refused-1.md", "# Refused 1\n模型不接受的内容");
    await writeNote(vault, "refused-2.md", "# Refused 2\n模型不接受的内容");
    await service.rebuild();

    // Refused, then deleted while the model is away; two new notes wait keyword-only.
    available = false;
    await rm(join(vault, "refused-1.md"));
    await rm(join(vault, "refused-2.md"));
    await writeNote(vault, "later-1.md", "# Later 1\nrollback plan");
    await writeNote(vault, "later-2.md", "# Later 2\nrelease plan");
    await service.rebuild();
    expect(index.noteMetadata().map((note) => [note.relativePath, note.model])).toEqual([
      ["later-1.md", null],
      ["later-2.md", null],
    ]);

    available = true;
    await service.search({ query: "rollback" });
    await waitUntil(() => index.noteMetadata().every((note) => note.model === "test-model"));
  });

  it("keeps a note the model will not take findable by keyword, and continues later notes", async () => {
    const embedding = new FakeEmbedding(async (texts, call) => {
      if (call === 3) return { model: "wrong-model", vectors: texts.map(vectorFor) };
      return { model: "test-model", vectors: texts.map(vectorFor) };
    });
    const { vault, index, service } = await createRealService({ embedding });
    index.replaceNote(storedNote("a-bad.md", "Old", "old preserved", { hash: "old-hash" }));
    const huge = Array.from({ length: 18 }, (_, index) => `${"x".repeat(1201)} ${index}`).join("\n\n");
    await writeNote(vault, "a-bad.md", `# Changed\n${huge}`);
    await writeNote(vault, "b-good.md", "# Good\nrollback guidance");

    const status = await service.rebuild();

    // Not embedded, it is still found by keyword, at its new content: left out, it could not be found at all.
    expect(status).toMatchObject({ state: "ready", failedNotes: 0, processedNotes: 2 });
    const bad = index.noteMetadata().find((note) => note.relativePath === "a-bad.md");
    expect(bad?.contentHash).not.toBe("old-hash");
    expect(bad?.model).toBeNull();
    expect(index.hasNote("b-good.md")).toBe(true);
    expect(index.snapshot().synchronizedAt).toBe("2026-08-18T10:00:00.000Z");
    expect(JSON.stringify(status)).not.toContain("a-bad.md");
  });

  it("does not advance synchronization time after a transient provider failure", async () => {
    const embedding = new FakeEmbedding(async () => {
      throw new Error("temporary failure");
    });
    const { vault, index, service } = await createRealService({ embedding });
    await writeNote(vault, "provider.md", "# Provider\nbody");

    const status = await service.rebuild();

    expect(status.state).toBe("error");
    expect(index.snapshot().synchronizedAt).toBeNull();
  });

  it("calls a vault read through by keyword a sync done while the model is there but cannot run", async () => {
    const embedding = new FakeEmbedding(async () => {
      throw new QwenEmbeddingProviderError("runtime_unavailable", "Unable to initialize the managed local embedding model");
    });
    const { vault, index, service } = await createRealService({ embedding });
    await writeNote(vault, "a.md", "# A\nrollback a");
    await writeNote(vault, "b.md", "# B\nlunch b");

    const status = await service.rebuild();

    // Called a failure for good: the page said the whole index was unavailable beside its keyword results, and
    // 最近同步 was never set, whatever was rebuilt.
    expect(status).toMatchObject({
      state: "unavailable",
      message: "本地嵌入模型暂时无法运行，当前仅使用关键词检索。",
      synchronizedAt: "2026-08-18T10:00:00.000Z",
      indexedNotes: 2,
    });
    expect(index.snapshot().synchronizedAt).toBe("2026-08-18T10:00:00.000Z");
    expect((await service.search({ query: "rollback" })).results.map((result) => result.relativePath)).toEqual(["a.md"]);
  });

  it("does not mark synchronization after prune fails", async () => {
    let markCalls = 0;
    const index = emptyIndex();
    index.snapshot = () => ({ noteCount: 0, chunkCount: 0, synchronizedAt: "2026-08-17T00:00:00.000Z" });
    index.prune = () => { throw new Error("prune failed"); };
    index.markSynchronized = () => { markCalls += 1; };
    const service = new ObsidianSearchService({
      repository: { iterate: () => scanEntries({ notes: [], diagnostics: [] }), resolveNotePath: async () => "/unused.md" },
      index,
      embedding: new FakeEmbedding(),
      watcherFactory: watcherHarness().factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    });
    services.push(service);

    const status = await service.rebuild();

    expect(markCalls).toBe(0);
    expect(status.synchronizedAt).toBe("2026-08-17T00:00:00.000Z");
  });

  it("does not prune on an incomplete directory scan and retains diagnosed Markdown files", async () => {
    const root = await temporaryRoot();
    const index = new ObsidianSearchIndex(join(root, "search.sqlite"));
    index.replaceNote(storedNote("keep.md", "Keep", "old text"));
    index.replaceNote(storedNote("remove.md", "Remove", "old text"));
    let scan: ObsidianVaultScan = {
      notes: [],
      diagnostics: [{ relativePath: null, reason: "/secret/root failed" }],
    };
    const service = new ObsidianSearchService({
      repository: { iterate: () => scanEntries(scan), resolveNotePath: async () => "/unused.md" },
      index,
      embedding: new FakeEmbedding(),
      watcherFactory: watcherHarness().factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    });
    services.push(service);

    await service.rebuild();
    expect(index.noteMetadata()).toHaveLength(2);
    expect(index.snapshot().synchronizedAt).toBeNull();

    scan = {
      notes: [],
      diagnostics: [{ relativePath: "keep.md", reason: "oversized /secret/file" }],
    };
    await service.rebuild();
    expect(index.noteMetadata().map((note) => note.relativePath)).toEqual(["keep.md"]);
    expect(service.status()).toMatchObject({ skippedNotes: 1 });
    // Read through, one note passed over: a sync done.
    expect(index.snapshot().synchronizedAt).toBe("2026-08-18T10:00:00.000Z");
    expect(JSON.stringify(service.status())).not.toContain("secret");
  });

  it("keeps what is under a folder it could not read, a dot-md one too, and prunes what was deleted elsewhere", async () => {
    const root = await temporaryRoot();
    const index = new ObsidianSearchIndex(join(root, "search.sqlite"));
    index.replaceNote(storedNote("archive.md/child.md", "Archived child", "must survive"));
    index.replaceNote(storedNote("deleted.md", "Deleted elsewhere", "gone from the vault"));
    const service = new ObsidianSearchService({
      repository: {
        iterate: () => scanEntries({
          notes: [],
          diagnostics: [{ relativePath: "archive.md", reason: "Unable to read directory /private/vault" }],
        }),
        resolveNotePath: async () => "/unused.md",
      },
      index,
      embedding: new FakeEmbedding(),
      watcherFactory: watcherHarness().factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    });
    services.push(service);

    await service.rebuild();

    // One unreadable folder kept every note renamed or deleted elsewhere in the results.
    expect(index.noteMetadata().map((note) => note.relativePath)).toEqual(["archive.md/child.md"]);
    expect(JSON.stringify(service.status())).not.toContain("/private/vault");
  });
});

describe("ObsidianSearchService retrieval", () => {
  it("recalls semantic-only notes, keeps an exact title first, excludes weak vectors, and collapses chunks", async () => {
    const { index, service } = await createRealService();
    index.replaceNote(storedNote("exact.md", "上线风险", "exact keyword body", { vector: unit([0.8, 0.6, 0]) }));
    index.replaceNote(storedNote("semantic.md", "渐进发布", "先小范围验证再保留回退能力", { vector: unit([1, 0, 0]) }));
    index.replaceNote(storedNote("weak.md", "午餐", "no relevant overlap", { vector: unit([0.4, Math.sqrt(0.84), 0]) }));
    const duplicate = storedNote("multi.md", "Multiple", "rollback first", { vector: unit([0.95, 0.05, 0]) });
    duplicate.chunks.push({
      id: "chunk-multi-2",
      ordinal: 1,
      heading: "Second",
      text: "rollback second",
      contentHash: "chunk-multi-2-hash",
      vector: unit([0.99, 0.01, 0]),
    });
    index.replaceNote(duplicate);

    const response = await service.search({ query: "上线风险", limit: 10 });

    expect(response.results[0]).toMatchObject({ relativePath: "exact.md", matchKind: "hybrid" });
    expect(response.results.map((result) => result.relativePath)).toContain("semantic.md");
    expect(response.results.map((result) => result.relativePath)).not.toContain("weak.md");
    expect(response.results.filter((result) => result.relativePath === "multi.md")).toHaveLength(1);
    expect(response.results.find((result) => result.relativePath === "semantic.md")?.matchKind).toBe("semantic");
    expect(response.results.every((result) => Array.from(result.snippet).length <= 260)).toBe(true);
    expect(JSON.stringify(response.results)).not.toMatch(/similarity|0\.9|\/Users\//u);
  });

  it("uses the dedicated retrieval instruction, ignores vectors from other models, and streams exactly once", async () => {
    let iterations = 0;
    let consumed = 0;
    const chunks: ObsidianIndexedChunk[] = [
      { id: "a", relativePath: "old.md", ordinal: 0, title: "Old", heading: null, text: "hidden", contentHash: "a", model: "old-model", vector: [1, 0, 0] },
      ...Array.from({ length: 450 }, (_, index): ObsidianIndexedChunk => ({
        id: `n-${index}`,
        relativePath: `notes/${String(index).padStart(3, "0")}.md`,
        ordinal: 0,
        title: index === 449 ? "Needle" : `Note ${index}`,
        heading: index === 449 ? "Final" : null,
        text: index === 449 ? "exact streaming needle" : `ordinary body ${index}`,
        contentHash: `h-${index}`,
        model: "test-model",
        vector: index < 300 || index === 448 ? unit([0.8, 0.6, 0]) : unit([0, 1, 0]),
      })),
    ];
    const fakeIndex = {
      semanticCoverage: () => ({ totalNotes: 451, semanticNotes: 451, keywordOnlyNotes: 0, mismatchedModelNotes: 0 }),
      noteMetadataForPath: () => null,
      hasNoteDescendant: () => false,
      replaceNote: () => undefined,
      prune: () => undefined,
      markSynchronized: () => undefined,
      snapshot: () => ({ noteCount: 451, chunkCount: 451, synchronizedAt: "2026-08-18T00:00:00.000Z" }),
      hasNote: () => false,
      iterateChunks: function* () {
        iterations += 1;
        for (const chunk of chunks) { consumed += 1; yield chunk; }
      },
      listChunks: () => { throw new Error("listChunks must not be called"); },
      close: () => undefined,
    };
    const embedding = new FakeEmbedding(async (texts) => ({ model: "test-model", vectors: texts.map(() => unit([1, 0, 0])) }));
    const service = new ObsidianSearchService({
      repository: { iterate: () => scanEntries({ notes: [], diagnostics: [] }), resolveNotePath: async () => "/unused.md" },
      index: fakeIndex,
      embedding,
      watcherFactory: watcherHarness().factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    });
    services.push(service);

    const response = await service.search({ query: "streaming needle", limit: 5 });

    expect(embedding.calls[0]?.[0]).toBe("Instruct: Retrieve semantically relevant personal Obsidian notes from the local vault\nQuery: streaming needle");
    expect(iterations).toBe(1);
    expect(consumed).toBe(chunks.length);
    expect(response.results[0]?.relativePath).toBe("notes/449.md");
    expect(response.results.map((result) => result.relativePath)).not.toContain("old.md");
    expect(response.results).toHaveLength(5);
  });

  it("falls back to keyword results and updates status when query embedding becomes unavailable", async () => {
    const { index, service, embedding } = await createRealService();
    index.replaceNote(storedNote("keyword.md", "Exact Keyword", "**readable** [link](https://example.test) body"));
    embedding.behavior = async () => { throw new QwenEmbeddingProviderError("checksum_failed", "/private/model checksum"); };

    const response = await service.search({ query: "Exact Keyword" });

    expect(response.results).toEqual([expect.objectContaining({
      relativePath: "keyword.md",
      matchKind: "keyword",
    })]);
    expect(response.results[0]?.snippet).not.toMatch(/\*\*|<[^>]+>/u);
    expect(response.status).toMatchObject({
      state: "unavailable",
      semanticAvailable: false,
      message: "本地嵌入模型未准备，当前仅使用关键词检索。",
    });
    expect(JSON.stringify(response.status)).not.toContain("/private/model");
  });

  it.each([
    {
      code: "runtime_unavailable" as const,
      // The index answered; only the query's embedding failed. Said "error", the page called the index unavailable.
      failedState: "unavailable",
      failedMessage: "本地语义检索暂时失败，当前仅使用关键词检索。",
    },
    {
      code: "model_missing" as const,
      failedState: "unavailable",
      failedMessage: "本地嵌入模型未准备，当前仅使用关键词检索。",
    },
  ])("retries a later semantic query after $code", async ({ code, failedState, failedMessage }) => {
    const root = await temporaryRoot();
    const index = new ObsidianSearchIndex(join(root, "search.sqlite"));
    index.replaceNote(storedNote("semantic.md", "Gradual release", "keep rollback capability"));
    let queryAttempts = 0;
    const embedding = new FakeEmbedding(async (texts) => {
      if (texts[0]?.startsWith("Instruct:")) {
        queryAttempts += 1;
        if (queryAttempts === 1) throw new QwenEmbeddingProviderError(code, "/private/model query failed");
      }
      return { model: "test-model", vectors: texts.map(vectorFor) };
    });
    const service = new ObsidianSearchService({
      repository: { iterate: () => scanEntries({ notes: [], diagnostics: [] }), resolveNotePath: async () => "/unused.md" },
      index,
      embedding,
      watcherFactory: watcherHarness().factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    });
    services.push(service);

    const failed = await service.search({ query: "上线风险" });
    const recovered = await service.search({ query: "上线风险" });

    expect(failed.results).toEqual([]);
    expect(failed.status).toMatchObject({ state: failedState, semanticAvailable: false, message: failedMessage });
    expect(recovered.results).toEqual([expect.objectContaining({ relativePath: "semantic.md", matchKind: "semantic" })]);
    expect(recovered.status).toMatchObject({ state: "ready", semanticAvailable: true, message: null });
    expect(queryAttempts).toBe(2);
  });

  it("automatically reindexes keyword-only notes after the local model is installed", async () => {
    const root = await temporaryRoot();
    const vault = join(root, "vault");
    await mkdir(vault);
    await writeNote(vault, "recovery.md", "# Recovery\nkeep rollback capability");
    const index = new ObsidianSearchIndex(join(root, "search.sqlite"));
    let available = false;
    const embedding = new FakeEmbedding(async (texts) => {
      if (!available) throw new QwenEmbeddingProviderError("model_missing", "not installed");
      return { model: "test-model", vectors: texts.map(vectorFor) };
    });
    const service = new ObsidianSearchService({
      repository: new ObsidianVaultRepository(vault),
      index,
      embedding,
      watcherFactory: watcherHarness().factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    });
    services.push(service);
    await service.rebuild();
    expect(index.noteMetadata()[0]?.model).toBeNull();
    available = true;

    const recoverySearch = await service.search({ query: "Recovery" });

    expect(recoverySearch.results[0]).toMatchObject({ relativePath: "recovery.md", matchKind: "keyword" });
    expect(recoverySearch.status.state).toBe("indexing");
    await waitUntil(() => service.status().state === "ready" && index.noteMetadata()[0]?.model === "test-model");
    const semanticSearch = await service.search({ query: "上线风险" });
    expect(semanticSearch.results[0]).toMatchObject({ relativePath: "recovery.md", matchKind: "semantic" });
  });

  it("recovers keyword-only notes after model installation while scan errors remain visible", async () => {
    const root = await temporaryRoot();
    const vault = join(root, "vault");
    await mkdir(vault);
    await writeNote(vault, "recovery.md", "# Recovery\nkeep rollback capability");
    const repository = new ObsidianVaultRepository(vault);
    const index = new ObsidianSearchIndex(join(root, "search.sqlite"));
    let available = false;
    const embedding = new FakeEmbedding(async (texts) => {
      if (!available) throw new QwenEmbeddingProviderError("model_missing", "not installed");
      return { model: "test-model", vectors: texts.map(vectorFor) };
    });
    const service = new ObsidianSearchService({
      repository: {
        iterate: async function* (signal) {
          yield* repository.iterate(signal);
          yield {
            kind: "diagnostic",
            diagnostic: { relativePath: "oversized.md", reason: "/private/vault note was skipped" },
          };
        },
        resolveNotePath: (path) => repository.resolveNotePath(path),
      },
      index,
      embedding,
      watcherFactory: watcherHarness().factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    });
    services.push(service);
    const initial = await service.rebuild();
    expect(initial).toMatchObject({
      state: "unavailable",
      semanticAvailable: false,
      skippedNotes: 1,
      message: "部分 Obsidian 笔记暂时无法建立索引。",
    });
    expect(index.noteMetadata()[0]?.model).toBeNull();
    const callsBeforeRecovery = embedding.calls.length;
    available = true;

    const recoverySearch = await service.search({ query: "Recovery" });

    expect(recoverySearch.results[0]).toMatchObject({
      relativePath: "recovery.md",
      matchKind: "keyword",
    });
    expect(embedding.calls.length).toBeGreaterThan(callsBeforeRecovery);
    await waitUntil(() =>
      service.status().state === "ready" &&
      service.status().semanticAvailable &&
      index.noteMetadata()[0]?.model === "test-model"
    );
    expect(service.status()).toMatchObject({
      state: "ready",
      semanticAvailable: true,
      skippedNotes: 1,
      message: "部分 Obsidian 笔记暂时无法建立索引。",
    });
    const semanticSearch = await service.search({ query: "上线风险" });
    expect(semanticSearch.results[0]).toMatchObject({
      relativePath: "recovery.md",
      matchKind: "semantic",
    });
  });

  it("coalesces a forced sync when semantic search finds keyword-only coverage", async () => {
    const root = await temporaryRoot();
    const vault = join(root, "vault");
    await mkdir(vault);
    await writeNote(vault, "a.md", "# Semantic A\nrollback alpha");
    await writeNote(vault, "b.md", "# Keyword B\nrollback beta");
    const repository = new ObsidianVaultRepository(vault);
    let synchronizationStreams = 0;
    const index = new ObsidianSearchIndex(join(root, "search.sqlite"));
    index.replaceNote(storedNote("a.md", "Semantic A", "rollback alpha", { model: "test-model", vector: vectorFor("rollback") }));
    index.replaceNote(storedNote("b.md", "Keyword B", "rollback beta", { model: null }));
    const service = new ObsidianSearchService({
      repository: {
        iterate: (signal) => { synchronizationStreams += 1; return repository.iterate(signal); },
        resolveNotePath: (path) => repository.resolveNotePath(path),
      },
      index,
      embedding: new FakeEmbedding(),
      watcherFactory: watcherHarness().factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    });
    services.push(service);

    const [first, second] = await Promise.all([
      service.search({ query: "上线风险" }),
      service.search({ query: "上线风险" }),
    ]);

    expect(first.results).toEqual([expect.objectContaining({ relativePath: "a.md", matchKind: "semantic" })]);
    expect(first.status.state).toBe("indexing");
    expect(second.status.state).toBe("indexing");
    await waitUntil(() => service.status().state === "ready" && index.noteMetadataForPath("b.md")?.model === "test-model");
    expect(synchronizationStreams).toBe(1);
    expect((await service.search({ query: "上线风险" })).results.map((result) => result.relativePath)).toContain("b.md");
  });

  it("forces one reindex for old-model coverage but none when all notes match", async () => {
    const root = await temporaryRoot();
    const vault = join(root, "vault");
    await mkdir(vault);
    await writeNote(vault, "mismatch.md", "# Mismatch\nrollback body");
    const repository = new ObsidianVaultRepository(vault);
    let synchronizationStreams = 0;
    const index = new ObsidianSearchIndex(join(root, "search.sqlite"));
    index.replaceNote(storedNote("mismatch.md", "Mismatch", "rollback body", { model: "old-model", vector: vectorFor("rollback") }));
    const service = new ObsidianSearchService({
      repository: {
        iterate: (signal) => { synchronizationStreams += 1; return repository.iterate(signal); },
        resolveNotePath: (path) => repository.resolveNotePath(path),
      },
      index,
      embedding: new FakeEmbedding(),
      watcherFactory: watcherHarness().factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    });
    services.push(service);

    const mismatch = await service.search({ query: "上线风险" });
    expect(mismatch.status.state).toBe("indexing");
    await waitUntil(() => service.status().state === "ready" && index.noteMetadataForPath("mismatch.md")?.model === "test-model");
    expect(synchronizationStreams).toBe(1);

    await service.search({ query: "上线风险" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(synchronizationStreams).toBe(1);
  });

  it("does not let a query embedding failure overwrite active indexing", async () => {
    const root = await temporaryRoot();
    const index = new ObsidianSearchIndex(join(root, "search.sqlite"));
    index.replaceNote(storedNote("semantic.md", "Gradual release", "keep rollback capability"));
    let releaseScan: (() => void) | undefined;
    const blockedScan = new Promise<void>((resolve) => { releaseScan = resolve; });
    const service = new ObsidianSearchService({
      repository: {
        iterate: async function* () { await blockedScan; yield* scanEntries({ notes: [], diagnostics: [] }); },
        resolveNotePath: async () => "/unused.md",
      },
      index,
      embedding: new FakeEmbedding(async (texts) => {
        if (texts[0]?.startsWith("Instruct:")) throw new QwenEmbeddingProviderError("runtime_unavailable", "/private/query");
        return { model: "test-model", vectors: texts.map(vectorFor) };
      }),
      watcherFactory: watcherHarness().factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    });
    services.push(service);
    service.start();
    try {
      await waitUntil(() => service.status().state === "indexing");
      const response = await service.search({ query: "上线风险" });
      expect(response.status.state).toBe("indexing");
      expect(response.status.message).toBeNull();
    } finally {
      releaseScan?.();
    }
  });

  it("preserves sync and watcher errors across failed and successful semantic queries", async () => {
    const chunk: ObsidianIndexedChunk = {
      id: "semantic", relativePath: "semantic.md", ordinal: 0, title: "Gradual release", heading: null,
      text: "keep rollback capability", contentHash: "semantic-hash", model: "test-model", vector: vectorFor("rollback"),
    };
    const index = emptyIndex();
    index.snapshot = () => ({ noteCount: 1, chunkCount: 1, synchronizedAt: null });
    const metadata = {
      relativePath: chunk.relativePath, title: chunk.title, contentHash: chunk.contentHash,
      size: 1, modifiedAtMs: 1, model: "test-model", indexedAt: "2026-08-18T00:00:00.000Z",
    };
    index.semanticCoverage = () => ({ totalNotes: 1, semanticNotes: 1, keywordOnlyNotes: 0, mismatchedModelNotes: 0 });
    index.noteMetadataForPath = (path) => path === chunk.relativePath ? metadata : null;
    index.iterateChunks = function* () { yield chunk; };
    index.prune = () => { throw new Error("/private/db sync failure"); };
    let failQuery = true;
    const embedding = new FakeEmbedding(async (texts) => {
      if (texts[0]?.startsWith("Instruct:") && failQuery) {
        throw new QwenEmbeddingProviderError("runtime_unavailable", "/private/query");
      }
      return { model: "test-model", vectors: texts.map(vectorFor) };
    });
    const watcher = watcherHarness();
    const service = new ObsidianSearchService({
      repository: { iterate: () => scanEntries({ notes: [], diagnostics: [] }), resolveNotePath: async () => "/unused.md" },
      index,
      embedding,
      watcherFactory: watcher.factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    });
    services.push(service);

    const syncError = await service.rebuild();
    await service.search({ query: "上线风险" });
    expect(service.status()).toMatchObject({ state: "error", message: syncError.message });
    failQuery = false;
    await service.search({ query: "上线风险" });
    expect(service.status()).toMatchObject({ state: "error", message: syncError.message, semanticAvailable: true });

    service.start();
    await waitUntil(() => service.status().state !== "indexing");
    watcher.watcher.error();
    failQuery = true;
    await service.search({ query: "上线风险" });
    failQuery = false;
    await service.search({ query: "上线风险" });
    expect(service.status()).toMatchObject({ state: "error", message: "Obsidian 文件监听暂时不可用。", semanticAvailable: true });
  });

  it("centers snippets on late matches, cleans wikilinks, and preserves grapheme clusters", async () => {
    const root = await temporaryRoot();
    const index = new ObsidianSearchIndex(join(root, "search.sqlite"));
    const cluster = "👩🏽‍💻";
    const text = `${cluster.repeat(320)} [[docs/target|Visible Alias]] needle [[Plain Target]] ${cluster.repeat(320)}`;
    index.replaceNote(storedNote("late.md", "Late", text, { model: null }));
    const service = new ObsidianSearchService({
      repository: { iterate: () => scanEntries({ notes: [], diagnostics: [] }), resolveNotePath: async () => "/unused.md" },
      index,
      embedding: new FakeEmbedding(),
      watcherFactory: watcherHarness().factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    });
    services.push(service);

    const response = await service.search({ query: "needle" });
    const snippet = response.results[0]!.snippet;
    const segments = [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(snippet)]
      .map((segment) => segment.segment);

    expect(snippet).toContain("needle");
    expect(snippet).toContain("Visible Alias");
    expect(snippet).toContain("Plain Target");
    expect(snippet).not.toContain("[[");
    expect(segments.length).toBeLessThanOrEqual(260);
    expect(segments.filter((segment) => segment.includes("👩"))).toEqual(
      expect.arrayContaining([cluster]),
    );
    expect(segments.filter((segment) => segment.includes("👩")).every((segment) => segment === cluster)).toBe(true);
  });

  it("caps snippets by both grapheme clusters and Unicode code points", async () => {
    const root = await temporaryRoot();
    const index = new ObsidianSearchIndex(join(root, "search.sqlite"));
    const cluster = "👩🏽‍💻";
    index.replaceNote(storedNote("dual-budget.md", "Dual budget", `${cluster.repeat(300)} needle ${cluster.repeat(300)}`, { model: null }));
    const service = new ObsidianSearchService({
      repository: { iterate: () => scanEntries({ notes: [], diagnostics: [] }), resolveNotePath: async () => "/unused.md" },
      index,
      embedding: new FakeEmbedding(),
      watcherFactory: watcherHarness().factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    });
    services.push(service);

    const snippet = (await service.search({ query: "needle" })).results[0]!.snippet;
    const graphemeCount = [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(snippet)].length;

    expect(snippet).toContain("needle");
    expect(Array.from(snippet).length).toBeLessThanOrEqual(260);
    expect(graphemeCount).toBeLessThanOrEqual(260);
    expect(snippet).not.toMatch(/\u200d…|…\u200d/u);
  });

  it("does not bypass the code-point budget for fewer than 260 multi-point graphemes", async () => {
    const root = await temporaryRoot();
    const index = new ObsidianSearchIndex(join(root, "search.sqlite"));
    const cluster = "👩🏽‍💻";
    index.replaceNote(storedNote("fast-path.md", "Fast path", `${cluster.repeat(100)} needle ${cluster.repeat(99)}`, { model: null }));
    const service = new ObsidianSearchService({
      repository: { iterate: () => scanEntries({ notes: [], diagnostics: [] }), resolveNotePath: async () => "/unused.md" },
      index,
      embedding: new FakeEmbedding(),
      watcherFactory: watcherHarness().factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    });
    services.push(service);

    const snippet = (await service.search({ query: "needle" })).results[0]!.snippet;
    const graphemeCount = [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(snippet)].length;

    expect(snippet).toContain("needle");
    expect(Array.from(snippet).length).toBeLessThanOrEqual(260);
    expect(graphemeCount).toBeLessThanOrEqual(260);
  });

  it("centers a snippet on the earliest matched term when the full phrase is absent", async () => {
    const root = await temporaryRoot();
    const index = new ObsidianSearchIndex(join(root, "search.sqlite"));
    index.replaceNote(storedNote("terms.md", "Separated terms", `${"prefix ".repeat(320)}alpha ${"middle ".repeat(80)}beta`, { model: null }));
    const service = new ObsidianSearchService({
      repository: { iterate: () => scanEntries({ notes: [], diagnostics: [] }), resolveNotePath: async () => "/unused.md" },
      index,
      embedding: new FakeEmbedding(),
      watcherFactory: watcherHarness().factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    });
    services.push(service);

    const response = await service.search({ query: "alpha beta" });

    expect(response.results[0]?.snippet).toContain("alpha");
    expect(response.results[0]?.snippet).toMatch(/^…/u);
  });

  it("strips embedded and ordinary wikilink syntax without leaving an image marker", async () => {
    const root = await temporaryRoot();
    const index = new ObsidianSearchIndex(join(root, "search.sqlite"));
    index.replaceNote(storedNote("links.md", "Links", "![[assets/diagram|Preview Alias]] needle [[Plain Target]]", { model: null }));
    const service = new ObsidianSearchService({
      repository: { iterate: () => scanEntries({ notes: [], diagnostics: [] }), resolveNotePath: async () => "/unused.md" },
      index,
      embedding: new FakeEmbedding(),
      watcherFactory: watcherHarness().factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    });
    services.push(service);

    const response = await service.search({ query: "needle" });

    expect(response.results[0]?.snippet).toBe("Preview Alias needle Plain Target");
  });

  it("does not let internal ranking diagnostics escape search", async () => {
    const index = emptyIndex();
    const chunk: ObsidianIndexedChunk = {
      id: "diagnostic", relativePath: "diagnostic.md", ordinal: 0, title: "Diagnostic", heading: null,
      text: "needle", contentHash: "diagnostic-hash", model: null, vector: null,
    };
    index.snapshot = () => ({ noteCount: 1, chunkCount: 1, synchronizedAt: null });
    index.iterateChunks = function* () { yield chunk; };
    const service = new ObsidianSearchService({
      repository: { iterate: () => scanEntries({ notes: [], diagnostics: [] }), resolveNotePath: async () => "/unused.md" },
      index,
      embedding: new FakeEmbedding(),
      watcherFactory: watcherHarness().factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
      onRankingDiagnostics: () => { throw new Error("diagnostic observer failed"); },
    });
    services.push(service);

    await expect(service.search({ query: "needle" })).resolves.toMatchObject({
      results: [expect.objectContaining({ relativePath: "diagnostic.md" })],
    });
  });

  it.each([
    { query: "" },
    { query: "   ", limit: 20 },
    { query: "x".repeat(501), limit: 20 },
    { query: "ok", limit: 0 },
    { query: "ok", limit: 51 },
    { query: "ok", limit: 1.5 },
  ])("rejects invalid search input %#", async (input) => {
    const { service } = await createRealService();
    await expect(service.search(input)).rejects.toThrow("无法执行 Obsidian 搜索。");
  });

  it("uses a default limit of twenty and deterministic path ordering", async () => {
    const { index, service } = await createRealService();
    for (let indexValue = 24; indexValue >= 0; indexValue -= 1) {
      index.replaceNote(storedNote(`notes/${String(indexValue).padStart(2, "0")}.md`, `Shared ${indexValue}`, "shared phrase", { model: null }));
    }
    const response = await service.search({ query: "shared" });
    expect(response.results).toHaveLength(20);
    expect(response.results.map((result) => result.relativePath)).toEqual(
      Array.from({ length: 20 }, (_, indexValue) => `notes/${String(indexValue).padStart(2, "0")}.md`),
    );
  });

  it("retains a late exact phrase match when term-only lexical candidates exceed the route cap", async () => {
    const chunks: ObsidianIndexedChunk[] = [
      ...Array.from({ length: 260 }, (_, index): ObsidianIndexedChunk => ({
        id: `term-${index}`,
        relativePath: `alpha-x-beta/${String(index).padStart(3, "0")}.md`,
        ordinal: 0,
        title: `alpha / beta ${index}`,
        heading: "alpha / beta",
        text: "alpha / beta",
        contentHash: `term-hash-${index}`,
        model: null,
        vector: null,
      })),
      {
        id: "late-phrase",
        relativePath: "late.md",
        ordinal: 0,
        title: "Late phrase",
        heading: null,
        text: "the exact alpha beta phrase is here",
        contentHash: "late-phrase-hash",
        model: null,
        vector: null,
      },
    ];
    const index = emptyIndex();
    index.snapshot = () => ({ noteCount: chunks.length, chunkCount: chunks.length, synchronizedAt: null });
    index.iterateChunks = function* () { yield* chunks; };
    const service = new ObsidianSearchService({
      repository: { iterate: () => scanEntries({ notes: [], diagnostics: [] }), resolveNotePath: async () => "/unused.md" },
      index,
      embedding: new FakeEmbedding(),
      watcherFactory: watcherHarness().factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    });
    services.push(service);

    const response = await service.search({ query: "alpha beta", limit: 50 });

    expect(response.results.map((result) => result.relativePath)).toContain("late.md");
    expect(response.results[0]?.relativePath).toBe("late.md");
  });

  it("keeps a late exact-body phrase ahead of term-only hybrid matches after fusion", async () => {
    const chunks: ObsidianIndexedChunk[] = [
      ...Array.from({ length: 260 }, (_, index): ObsidianIndexedChunk => ({
        id: `hybrid-term-${index}`,
        relativePath: `alpha-x-beta/hybrid-${String(index).padStart(3, "0")}.md`,
        ordinal: 0,
        title: `alpha / beta ${index}`,
        heading: "alpha / beta",
        text: "alpha / beta",
        contentHash: `hybrid-term-hash-${index}`,
        model: "test-model",
        vector: unit([1, 0, 0]),
      })),
      {
        id: "late-fused-phrase",
        relativePath: "late-fused.md",
        ordinal: 0,
        title: "Late fused phrase",
        heading: null,
        text: "the exact alpha beta phrase is retained",
        contentHash: "late-fused-phrase-hash",
        model: null,
        vector: null,
      },
    ];
    const index = emptyIndex();
    index.snapshot = () => ({ noteCount: chunks.length, chunkCount: chunks.length, synchronizedAt: null });
    index.semanticCoverage = () => ({ totalNotes: chunks.length, semanticNotes: chunks.length - 1, keywordOnlyNotes: 1, mismatchedModelNotes: 0 });
    index.iterateChunks = function* () { yield* chunks; };
    const service = new ObsidianSearchService({
      repository: { iterate: () => scanEntries({ notes: [], diagnostics: [] }), resolveNotePath: async () => "/unused.md" },
      index,
      embedding: new FakeEmbedding(async (texts) => ({ model: "test-model", vectors: texts.map(() => unit([1, 0, 0])) })),
      watcherFactory: watcherHarness().factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    });
    services.push(service);

    const response = await service.search({ query: "alpha beta", limit: 50 });

    expect(response.results[0]?.relativePath).toBe("late-fused.md");
    expect(response.results.map((result) => result.relativePath)).toContain("late-fused.md");
  });

  it("applies RRF only within each retained route cutoff", async () => {
    const lexical = Array.from({ length: 200 }, (_, index): ObsidianIndexedChunk => ({
      id: `lexical-${index}`,
      relativePath: `alpha-x-beta/${String(index).padStart(3, "0")}.md`,
      ordinal: 0,
      title: "alpha / beta",
      heading: "alpha / beta",
      text: "alpha / beta",
      contentHash: `lexical-hash-${index}`,
      model: null,
      vector: null,
    }));
    const target: ObsidianIndexedChunk = {
      id: "rank-201-target",
      relativePath: "alpha-x-beta/zzz.md",
      ordinal: 0,
      title: "alpha / beta",
      heading: "alpha / beta",
      text: "alpha / beta",
      contentHash: "rank-201-target-hash",
      model: "test-model",
      vector: unit([1, 0, 0]),
    };
    const chunks = [...lexical, target];
    const index = emptyIndex();
    index.snapshot = () => ({ noteCount: chunks.length, chunkCount: chunks.length, synchronizedAt: null });
    index.semanticCoverage = () => ({ totalNotes: chunks.length, semanticNotes: 1, keywordOnlyNotes: chunks.length - 1, mismatchedModelNotes: 0 });
    index.iterateChunks = function* () { yield* chunks; };
    let candidateObjectCounts: { lexical: number; semantic: number } | undefined;
    const service = new ObsidianSearchService({
      repository: { iterate: () => scanEntries({ notes: [], diagnostics: [] }), resolveNotePath: async () => "/unused.md" },
      index,
      embedding: new FakeEmbedding(async (texts) => ({ model: "test-model", vectors: texts.map(() => unit([1, 0, 0])) })),
      watcherFactory: watcherHarness().factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
      onRankingDiagnostics: (counts) => { candidateObjectCounts = counts; },
    });
    services.push(service);

    const response = await service.search({ query: "alpha beta", limit: 5 });

    expect(response.results[0]?.relativePath).toBe("alpha-x-beta/000.md");
    expect(response.results.find((result) => result.relativePath === target.relativePath)?.matchKind).toBe("semantic");
    expect(candidateObjectCounts).toEqual({ lexical: 200, semantic: 1 });
  });

  it("bounds 10k streamed candidates, yields cooperatively, and serializes index writes", async () => {
    const chunks = Array.from({ length: 10_240 }, (_, index): ObsidianIndexedChunk => ({
      id: `bulk-${index}`,
      relativePath: `bulk/${String(index).padStart(5, "0")}.md`,
      ordinal: 0,
      title: `exact / phrase ${index}`,
      heading: null,
      text: "exact / phrase",
      contentHash: `bulk-hash-${index}`,
      model: null,
      vector: null,
    }));
    chunks.push({
      id: "late-exact",
      relativePath: "bulk/late-exact.md",
      ordinal: 0,
      title: "Late",
      heading: null,
      text: "the exact phrase is retained",
      contentHash: "late-exact-hash",
      model: null,
      vector: null,
    });
    let iterating = false;
    let interleavedWrite = false;
    let yieldCalls = 0;
    let queuedMicrotaskRan = false;
    let candidateCounts: { lexical: number; semantic: number } | undefined;
    let rebuild: Promise<unknown> | undefined;
    const guard = (): void => { if (iterating) interleavedWrite = true; };
    const index = emptyIndex();
    const forbiddenFullMetadata = vi.fn(() => { throw new Error("full metadata read is forbidden"); });
    Object.assign(index, {
      noteMetadata: forbiddenFullMetadata,
      semanticCoverage: () => ({ totalNotes: 10_241, semanticNotes: 0, keywordOnlyNotes: 10_241, mismatchedModelNotes: 0 }),
      noteMetadataForPath: () => null,
      hasNoteDescendant: () => false,
    });
    index.snapshot = () => { guard(); return { noteCount: chunks.length, chunkCount: chunks.length, synchronizedAt: null }; };
    index.replaceNote = () => { guard(); };
    index.prune = () => { guard(); };
    index.markSynchronized = () => { guard(); };
    index.iterateChunks = function* () {
      iterating = true;
      try { yield* chunks; } finally { iterating = false; }
    };
    let service: ObsidianSearchService;
    service = new ObsidianSearchService({
      repository: { iterate: () => scanEntries({ notes: [], diagnostics: [] }), resolveNotePath: async () => "/unused.md" },
      index,
      embedding: new FakeEmbedding(),
      watcherFactory: watcherHarness().factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
      yieldToMain: async () => {
        yieldCalls += 1;
        if (yieldCalls === 1) {
          queueMicrotask(() => { queuedMicrotaskRan = true; });
          rebuild = service.rebuild();
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
      onRankingDiagnostics: (counts: { lexical: number; semantic: number }) => { candidateCounts = counts; },
    } as unknown as ObsidianSearchServiceOptions);
    services.push(service);

    const response = await service.search({ query: "exact phrase", limit: 5 });
    await rebuild;

    expect(response.results[0]?.relativePath).toBe("bulk/late-exact.md");
    expect(candidateCounts).toEqual({ lexical: 200, semantic: 0 });
    expect(yieldCalls).toBeGreaterThan(10);
    expect(queuedMicrotaskRan).toBe(true);
    expect(interleavedWrite).toBe(false);
    expect(forbiddenFullMetadata).not.toHaveBeenCalled();
  });
});

describe("ObsidianSearchService index failure boundaries", () => {
  it("keeps successful embedding separate from model coverage failure", async () => {
    const chunk: ObsidianIndexedChunk = {
      id: "coverage", relativePath: "coverage.md", ordinal: 0, title: "Coverage", heading: null,
      text: "rollback body", contentHash: "coverage-hash", model: "test-model", vector: vectorFor("rollback"),
    };
    const index = emptyIndex();
    let coverageCalls = 0;
    index.snapshot = () => ({ noteCount: 1, chunkCount: 1, synchronizedAt: null });
    index.semanticCoverage = () => {
      coverageCalls += 1;
      if (coverageCalls === 3) throw new Error("/private/db model coverage failed");
      return { totalNotes: 1, semanticNotes: 1, keywordOnlyNotes: 0, mismatchedModelNotes: 0 };
    };
    index.iterateChunks = function* () { yield chunk; };
    const service = new ObsidianSearchService({
      repository: { iterate: () => scanEntries({ notes: [], diagnostics: [] }), resolveNotePath: async () => "/unused.md" },
      index,
      embedding: new FakeEmbedding(),
      watcherFactory: watcherHarness().factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    });
    services.push(service);
    const before = service.status();

    const error = await service.search({ query: "上线风险" }).then(
      () => null,
      (failure: unknown) => failure,
    );

    expect(error).toEqual(new Error("无法执行 Obsidian 搜索。"));
    expect(String(error)).not.toContain("/private/db");
    expect(service.status()).toEqual(before);
    expect(coverageCalls).toBe(3);
  });

  it.each(["snapshot", "metadata", "prune", "mark", "final snapshot"] as const)(
    "resolves rebuild with a generic status when %s fails",
    async (phase) => {
      const index = emptyIndex();
      let snapshotCalls = 0;
      let metadataCalls = 0;
      index.snapshot = () => {
        snapshotCalls += 1;
        if (phase === "snapshot" && snapshotCalls === 2) throw new Error("/private/db snapshot failed");
        if (phase === "final snapshot" && snapshotCalls === 3) throw new Error("/private/db final snapshot failed");
        return { noteCount: 0, chunkCount: 0, synchronizedAt: null };
      };
      index.noteMetadataForPath = () => {
        metadataCalls += 1;
        if (phase === "metadata") throw new Error("/private/db metadata failed");
        return null;
      };
      if (phase === "prune") index.prune = () => { throw new Error("/private/db prune failed"); };
      if (phase === "mark") index.markSynchronized = () => { throw new Error("/private/db mark failed"); };
      const service = new ObsidianSearchService({
        repository: {
          iterate: () => scanEntries({
            notes: phase === "metadata"
              ? [{ relativePath: "metadata.md", content: "# Metadata\nbody", contentHash: "metadata-hash", size: 15, modifiedAtMs: 1 }]
              : [],
            diagnostics: [],
          }),
          resolveNotePath: async () => "/unused.md",
        },
        index,
        embedding: new FakeEmbedding(),
        watcherFactory: watcherHarness().factory,
        openExternal: async () => undefined,
        now: () => new Date("2026-08-18T10:00:00.000Z"),
      });
      services.push(service);

      const status = await service.rebuild();

      expect(status).toMatchObject({
        state: "error",
        message: "Obsidian 笔记索引暂时无法同步。",
      });
      expect(JSON.stringify(status)).not.toContain("/private/db");
    },
  );

  it("counts replace failures per note without exposing the index error", async () => {
    const index = emptyIndex();
    index.replaceNote = () => { throw new Error("/private/db replace failed"); };
    const service = new ObsidianSearchService({
      repository: {
        iterate: () => scanEntries({
          notes: [{ relativePath: "note.md", content: "# Note\nbody", contentHash: "new", size: 11, modifiedAtMs: 1 }],
          diagnostics: [],
        }),
        resolveNotePath: async () => "/unused.md",
      },
      index,
      embedding: new FakeEmbedding(),
      watcherFactory: watcherHarness().factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    });
    services.push(service);

    const status = await service.rebuild();

    expect(status).toMatchObject({ state: "error", failedNotes: 1 });
    expect(JSON.stringify(status)).not.toContain("/private/db");
  });

  it("preserves the persisted timestamp when marking and the final snapshot both fail", async () => {
    const index = emptyIndex();
    let snapshotCalls = 0;
    index.snapshot = () => {
      snapshotCalls += 1;
      if (snapshotCalls === 3) throw new Error("/private/db final snapshot failed");
      return { noteCount: 0, chunkCount: 0, synchronizedAt: "2026-08-17T00:00:00.000Z" };
    };
    index.markSynchronized = () => { throw new Error("/private/db mark failed"); };
    const service = new ObsidianSearchService({
      repository: { iterate: () => scanEntries({ notes: [], diagnostics: [] }), resolveNotePath: async () => "/unused.md" },
      index,
      embedding: new FakeEmbedding(),
      watcherFactory: watcherHarness().factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    });
    services.push(service);

    const status = await service.rebuild();

    expect(status).toMatchObject({
      state: "error",
      synchronizedAt: "2026-08-17T00:00:00.000Z",
      message: "Obsidian 笔记索引暂时无法同步。",
    });
  });

  it("does not mark or advance time when the final count snapshot fails", async () => {
    const index = emptyIndex();
    let snapshotCalls = 0;
    let persistedTimestamp: string | null = null;
    index.snapshot = () => {
      snapshotCalls += 1;
      if (snapshotCalls === 3) throw new Error("/private/db final snapshot failed");
      return { noteCount: 0, chunkCount: 0, synchronizedAt: "2026-08-17T00:00:00.000Z" };
    };
    index.markSynchronized = (timestamp) => { persistedTimestamp = timestamp; };
    const service = new ObsidianSearchService({
      repository: { iterate: () => scanEntries({ notes: [], diagnostics: [] }), resolveNotePath: async () => "/unused.md" },
      index,
      embedding: new FakeEmbedding(),
      watcherFactory: watcherHarness().factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    });
    services.push(service);

    const status = await service.rebuild();

    expect(persistedTimestamp).toBeNull();
    expect(status).toMatchObject({
      state: "error",
      synchronizedAt: "2026-08-17T00:00:00.000Z",
      message: "Obsidian 笔记索引暂时无法同步。",
    });
  });

  it.each(["metadata", "iterator"] as const)("maps search %s failures to one generic error", async (phase) => {
    const index = emptyIndex();
    let metadataCalls = 0;
    index.semanticCoverage = () => {
      metadataCalls += 1;
      if (phase === "metadata" && metadataCalls === 2) throw new Error("/private/db search metadata");
      return { totalNotes: 0, semanticNotes: 0, keywordOnlyNotes: 0, mismatchedModelNotes: 0 };
    };
    if (phase === "iterator") {
      index.iterateChunks = function* () {
        throw new Error("/private/db corrupt row");
      };
    }
    const service = new ObsidianSearchService({
      repository: { iterate: () => scanEntries({ notes: [], diagnostics: [] }), resolveNotePath: async () => "/unused.md" },
      index,
      embedding: new FakeEmbedding(),
      watcherFactory: watcherHarness().factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    });
    services.push(service);

    const error = await service.search({ query: "query" }).then(
      () => null,
      (failure: unknown) => failure,
    );

    expect(error).toEqual(new Error("无法执行 Obsidian 搜索。"));
    expect(String(error)).not.toContain("/private/db");
  });

  it("handles a background start failure without an unhandled rejection", async () => {
    const index = emptyIndex();
    let snapshotCalls = 0;
    index.snapshot = () => {
      snapshotCalls += 1;
      if (snapshotCalls === 2) throw new Error("/private/db background snapshot");
      return { noteCount: 0, chunkCount: 0, synchronizedAt: null };
    };
    const service = new ObsidianSearchService({
      repository: { iterate: () => scanEntries({ notes: [], diagnostics: [] }), resolveNotePath: async () => "/unused.md" },
      index,
      embedding: new FakeEmbedding(),
      watcherFactory: watcherHarness().factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    });
    services.push(service);
    const unhandled: unknown[] = [];
    const listener = (error: unknown): void => { unhandled.push(error); };
    process.on("unhandledRejection", listener);
    try {
      service.start();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(service.status()).toMatchObject({
        state: "error",
        message: "Obsidian 笔记索引暂时无法同步。",
      });
    } finally {
      process.off("unhandledRejection", listener);
    }
  });
});

describe("ObsidianSearchService security and lifecycle", () => {
  it("cancels a queued synchronization write before it enters the index lock", async () => {
    const chunks = Array.from({ length: 128 }, (_, index): ObsidianIndexedChunk => ({
      id: `lock-${index}`, relativePath: `lock/${index}.md`, ordinal: 0, title: `Lock ${index}`,
      heading: null, text: "needle", contentHash: `lock-hash-${index}`, model: null, vector: null,
    }));
    let releaseDocumentEmbedding: (() => void) | undefined;
    let releaseRanking: (() => void) | undefined;
    let documentEmbeddingStarted = false;
    let rankingBlocked = false;
    let documentEmbedded = false;
    const blockedDocumentEmbedding = new Promise<void>((resolve) => { releaseDocumentEmbedding = resolve; });
    const blockedRanking = new Promise<void>((resolve) => { releaseRanking = resolve; });
    const index = emptyIndex();
    const writes = { replace: vi.fn(), prune: vi.fn(), mark: vi.fn(), close: vi.fn() };
    index.replaceNote = writes.replace;
    index.prune = writes.prune;
    index.markSynchronized = writes.mark;
    index.close = writes.close;
    index.iterateChunks = () => chunks[Symbol.iterator]();
    let embedCalls = 0;
    const service = new ObsidianSearchService({
      repository: {
        iterate: () => scanEntries({
          notes: [{ relativePath: "queued.md", content: "# Queued\nbody", contentHash: "queued-hash", size: 13, modifiedAtMs: 1 }],
          diagnostics: [],
        }),
        resolveNotePath: async () => "/unused.md",
      },
      index,
      embedding: {
        embed: async (texts) => {
          embedCalls += 1;
          if (embedCalls === 2) {
            documentEmbeddingStarted = true;
            await blockedDocumentEmbedding;
            documentEmbedded = true;
          }
          return { model: "test-model", vectors: texts.map(vectorFor) };
        },
      },
      watcherFactory: watcherHarness().factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
      yieldToMain: async () => {
        if (!rankingBlocked) {
          rankingBlocked = true;
          await blockedRanking;
        }
      },
    });
    services.push(service);
    const rebuilding = service.rebuild();
    const rebuildingSettled = rebuilding.then(() => undefined, () => undefined);
    let search: Promise<unknown> | undefined;
    let closing: Promise<void> | undefined;
    try {
      await waitUntil(() => documentEmbeddingStarted);
      search = service.search({ query: "needle" });
      await waitUntil(() => rankingBlocked);
      releaseDocumentEmbedding?.();
      await waitUntil(() => documentEmbedded);
      closing = service.close();
    } finally {
      releaseDocumentEmbedding?.();
      releaseRanking?.();
    }

    await Promise.allSettled([rebuildingSettled, search, closing]);
    expect(writes.replace).not.toHaveBeenCalled();
    expect(writes.prune).not.toHaveBeenCalled();
    expect(writes.mark).not.toHaveBeenCalled();
    expect(writes.close).toHaveBeenCalledOnce();
  });

  it("does not open a queued search iterator after close", async () => {
    const chunks = Array.from({ length: 128 }, (_, index): ObsidianIndexedChunk => ({
      id: `search-lock-${index}`, relativePath: `search-lock/${index}.md`, ordinal: 0,
      title: `Search ${index}`, heading: null, text: "needle", contentHash: `search-lock-hash-${index}`,
      model: null, vector: null,
    }));
    let releaseRanking: (() => void) | undefined;
    let rankingBlocked = false;
    let iteratorCalls = 0;
    const blockedRanking = new Promise<void>((resolve) => { releaseRanking = resolve; });
    const index = emptyIndex();
    index.iterateChunks = () => {
      iteratorCalls += 1;
      return chunks[Symbol.iterator]();
    };
    const service = new ObsidianSearchService({
      repository: { iterate: () => scanEntries({ notes: [], diagnostics: [] }), resolveNotePath: async () => "/unused.md" },
      index,
      embedding: new FakeEmbedding(),
      watcherFactory: watcherHarness().factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
      yieldToMain: async () => {
        if (!rankingBlocked) {
          rankingBlocked = true;
          await blockedRanking;
        }
      },
    });
    services.push(service);
    const first = service.search({ query: "needle" });
    let second: Promise<unknown> | undefined;
    let closing: Promise<void> | undefined;
    try {
      await waitUntil(() => rankingBlocked);
      second = service.search({ query: "needle" });
      closing = service.close();
    } finally {
      releaseRanking?.();
    }

    await Promise.allSettled([first, second, closing]);
    expect(iteratorCalls).toBe(1);
  });

  it("opens only an indexed, repository-validated note through a constructed Obsidian URL", async () => {
    const root = await temporaryRoot();
    const absolute = join(root, "vault", "空 格#?.md");
    const order: string[] = [];
    const openExternal = vi.fn(async (url: string) => { order.push(`open:${url}`); });
    const index = {
      semanticCoverage: () => ({ totalNotes: 1, semanticNotes: 0, keywordOnlyNotes: 1, mismatchedModelNotes: 0 }),
      noteMetadataForPath: () => null, hasNoteDescendant: () => false,
      replaceNote: () => undefined, prune: () => undefined,
      markSynchronized: () => undefined,
      snapshot: () => ({ noteCount: 1, chunkCount: 1, synchronizedAt: null }),
      hasNote: (path: string) => { order.push(`has:${path}`); return path === "空 格#?.md"; },
      iterateChunks: function* () { return; }, close: () => undefined,
    };
    const service = new ObsidianSearchService({
      repository: {
        iterate: () => scanEntries({ notes: [], diagnostics: [] }),
        resolveNotePath: async (path) => { order.push(`resolve:${path}`); return absolute; },
      },
      index,
      embedding: new FakeEmbedding(),
      watcherFactory: watcherHarness().factory,
      openExternal,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    });
    services.push(service);

    await service.openNote("空 格#?.md");

    expect(order.slice(0, 2)).toEqual(["has:空 格#?.md", "resolve:空 格#?.md"]);
    expect(openExternal).toHaveBeenCalledOnce();
    const url = openExternal.mock.calls[0]![0];
    expect(url).toMatch(/^obsidian:\/\/open\?path=/u);
    expect(url).toContain("%20");
    expect(url).toContain("%23");
    expect(url).toContain("%3F");
    expect(url).not.toContain("空 格#?");

    await expect(service.openNote("https://evil.test/x.md")).rejects.toThrow("无法打开 Obsidian 笔记。");
    expect(openExternal).toHaveBeenCalledOnce();
  });

  it("rejects missing or unsafe notes without leaking repository errors", async () => {
    const root = await temporaryRoot();
    const index = new ObsidianSearchIndex(join(root, "search.sqlite"));
    index.replaceNote(storedNote("missing.md", "Missing", "old"));
    const service = new ObsidianSearchService({
      repository: {
        iterate: () => scanEntries({ notes: [], diagnostics: [] }),
        resolveNotePath: async () => { throw new Error("/Users/alice/private/vault/missing.md"); },
      },
      index,
      embedding: new FakeEmbedding(),
      watcherFactory: watcherHarness().factory,
      openExternal: vi.fn(),
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    });
    services.push(service);
    await expect(service.openNote("missing.md")).rejects.toThrow("无法打开 Obsidian 笔记。");
    await expect(service.openNote("../missing.md")).rejects.toThrow("无法打开 Obsidian 笔记。");
  });

  it("aborts a blocked synchronization embedding before waiting during close", async () => {
    let capturedSignal: AbortSignal | undefined;
    let embedStarted = false;
    let release: (() => void) | undefined;
    let rejectBlocked: ((error: Error) => void) | undefined;
    const blocked = new Promise<EmbeddingBatch>((resolve, reject) => {
      release = () => resolve({ model: "test-model", vectors: [vectorFor("probe")] });
      rejectBlocked = reject;
    });
    const order: string[] = [];
    const index = emptyIndex();
    index.close = () => order.push("index");
    const service = new ObsidianSearchService({
      repository: {
        iterate: () => scanEntries({ notes: [], diagnostics: [] }),
        resolveNotePath: async () => "/unused.md",
      },
      index,
      embedding: {
        embed: async (_texts, signal) => {
          embedStarted = true;
          capturedSignal = signal;
          signal?.addEventListener(
            "abort",
            () => rejectBlocked?.(new Error("aborted")),
            { once: true },
          );
          return blocked;
        },
        close: async () => { order.push("embedding"); },
      },
      watcherFactory: watcherHarness().factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    });
    services.push(service);
    service.start();

    try {
      await waitUntil(() => embedStarted);
      expect(capturedSignal).toBeInstanceOf(AbortSignal);
      const closing = service.close();
      await closing;
      expect(capturedSignal?.aborted).toBe(true);
      expect(order).toEqual(["embedding", "index"]);
    } finally {
      release?.();
    }
  });

  it("aborts a blocked query embedding and prevents late index access", async () => {
    let capturedSignal: AbortSignal | undefined;
    let embedStarted = false;
    let release: (() => void) | undefined;
    let rejectBlocked: ((error: Error) => void) | undefined;
    let iteratorCalls = 0;
    const chunk = storedNote("tracked.md", "Tracked", "rollback capability");
    const index = emptyIndex();
    index.semanticCoverage = () => ({ totalNotes: 1, semanticNotes: 1, keywordOnlyNotes: 0, mismatchedModelNotes: 0 });
    index.iterateChunks = function* () {
      iteratorCalls += 1;
      return;
    };
    const blocked = new Promise<EmbeddingBatch>((resolve, reject) => {
      release = () => resolve({ model: "test-model", vectors: [vectorFor("query")] });
      rejectBlocked = reject;
    });
    const service = new ObsidianSearchService({
      repository: {
        iterate: () => scanEntries({ notes: [], diagnostics: [] }),
        resolveNotePath: async () => "/unused.md",
      },
      index,
      embedding: {
        embed: async (_texts, signal) => {
          embedStarted = true;
          capturedSignal = signal;
          signal?.addEventListener(
            "abort",
            () => rejectBlocked?.(new Error("aborted")),
            { once: true },
          );
          return blocked;
        },
      },
      watcherFactory: watcherHarness().factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    });
    services.push(service);
    const search = service.search({ query: "rollback" });

    try {
      await waitUntil(() => embedStarted);
      expect(capturedSignal).toBeInstanceOf(AbortSignal);
      await expect(service.close()).rejects.toThrow(
        "Obsidian 搜索资源未能完整关闭。",
      );
      expect(capturedSignal?.aborted).toBe(true);
      await expect(search).rejects.toThrow("Obsidian 搜索服务已关闭。");
      expect(iteratorCalls).toBe(0);
    } finally {
      release?.();
    }
  });

  it("times out an embedding that ignores abort and prevents late synchronization writes", async () => {
    const timers = shutdownTimerHarness();
    let capturedSignal: AbortSignal | undefined;
    let embedStarted = false;
    let release: (() => void) | undefined;
    const blocked = new Promise<EmbeddingBatch>((resolve) => {
      release = () => resolve({ model: "test-model", vectors: [vectorFor("probe")] });
    });
    const index = emptyIndex();
    const writes = {
      replace: vi.fn(),
      prune: vi.fn(),
      mark: vi.fn(),
      close: vi.fn(),
    };
    index.replaceNote = writes.replace;
    index.prune = writes.prune;
    index.markSynchronized = writes.mark;
    index.close = writes.close;
    const service = new ObsidianSearchService({
      repository: {
        iterate: () => scanEntries({
          notes: [{
            relativePath: "note.md",
            content: "# Note\nbody",
            contentHash: "hash",
            size: 11,
            modifiedAtMs: 1,
          }],
          diagnostics: [],
        }),
        resolveNotePath: async () => "/unused.md",
      },
      index,
      embedding: {
        embed: async (_texts, signal) => {
          embedStarted = true;
          capturedSignal = signal;
          return blocked;
        },
        close: async () => undefined,
      },
      watcherFactory: watcherHarness().factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
      shutdownTimeoutMs: 10_000,
      setShutdownTimer: timers.setTimer,
      clearShutdownTimer: timers.clearTimer,
    });
    services.push(service);
    service.start();

    let closing: Promise<void> | undefined;
    try {
      await waitUntil(() => embedStarted);
      expect(capturedSignal).toBeInstanceOf(AbortSignal);
      closing = service.close();
      expect(capturedSignal?.aborted).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await waitUntil(() => timers.pending() === 1);
      timers.flush();
      await expect(closing).rejects.toThrow(
        "Obsidian 搜索资源未能完整关闭。",
      );
      expect(writes.close).toHaveBeenCalledOnce();
      expect(service.status()).toMatchObject({
        state: "error",
        message: "Obsidian 笔记索引暂时无法同步。",
      });
      release?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(writes.replace).not.toHaveBeenCalled();
      expect(writes.prune).not.toHaveBeenCalled();
      expect(writes.mark).not.toHaveBeenCalled();
    } finally {
      release?.();
      await closing?.catch(() => undefined);
    }
  });

  it("preserves completed notes but skips finalization when a later batch is cancelled", async () => {
    let embedCalls = 0;
    let rejectBlocked: ((error: Error) => void) | undefined;
    const blocked = new Promise<EmbeddingBatch>((_resolve, reject) => {
      rejectBlocked = reject;
    });
    const index = emptyIndex();
    const replaced: string[] = [];
    index.replaceNote = (note) => replaced.push(note.relativePath);
    index.prune = vi.fn();
    index.markSynchronized = vi.fn();
    const service = new ObsidianSearchService({
      repository: {
        iterate: () => scanEntries({
          notes: [
            {
              relativePath: "first.md",
              content: "# First\nbody",
              contentHash: "first-hash",
              size: 12,
              modifiedAtMs: 1,
            },
            {
              relativePath: "second.md",
              content: "# Second\nbody",
              contentHash: "second-hash",
              size: 13,
              modifiedAtMs: 2,
            },
          ],
          diagnostics: [],
        }),
        resolveNotePath: async () => "/unused.md",
      },
      index,
      embedding: {
        embed: async (texts, signal) => {
          embedCalls += 1;
          if (embedCalls <= 2) {
            return { model: "test-model", vectors: texts.map(vectorFor) };
          }
          signal?.addEventListener(
            "abort",
            () => rejectBlocked?.(new Error("aborted")),
            { once: true },
          );
          return blocked;
        },
      },
      watcherFactory: watcherHarness().factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    });
    services.push(service);
    service.start();

    await waitUntil(() => embedCalls === 3 && replaced.length === 1);
    await service.close();

    expect(replaced).toEqual(["first.md"]);
    expect(index.prune).not.toHaveBeenCalled();
    expect(index.markSynchronized).not.toHaveBeenCalled();
    expect(service.status()).toMatchObject({
      state: "error",
      message: "Obsidian 笔记索引暂时无法同步。",
    });
  });

  it("bounds embedding provider close before closing the index", async () => {
    const timers = shutdownTimerHarness();
    let releaseEmbedding: (() => void) | undefined;
    const blockedClose = new Promise<void>((resolve) => {
      releaseEmbedding = resolve;
    });
    const order: string[] = [];
    const index = emptyIndex();
    index.close = () => order.push("index");
    const service = new ObsidianSearchService({
      repository: {
        iterate: () => scanEntries({ notes: [], diagnostics: [] }),
        resolveNotePath: async () => "/unused.md",
      },
      index,
      embedding: {
        embed: async (texts) => ({ model: "test-model", vectors: texts.map(vectorFor) }),
        close: async () => {
          order.push("embedding");
          await blockedClose;
        },
      },
      watcherFactory: watcherHarness().factory,
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
      shutdownTimeoutMs: 10_000,
      setShutdownTimer: timers.setTimer,
      clearShutdownTimer: timers.clearTimer,
    });
    services.push(service);

    const closing = service.close();
    try {
      await waitUntil(() => order.includes("embedding"));
      expect(timers.pending()).toBe(1);
      timers.flush();
      await expect(closing).rejects.toThrow(
        "Obsidian 搜索资源未能完整关闭。",
      );
      expect(order).toEqual(["embedding", "index"]);
    } finally {
      releaseEmbedding?.();
    }
  });

  it("closes watcher, timer, active sync, embedding, then index exactly once", async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    let scanStarted = false;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const root = await temporaryRoot();
    const realIndex = new ObsidianSearchIndex(join(root, "search.sqlite"));
    const index = {
      semanticCoverage: (model?: string) => realIndex.semanticCoverage(model),
      noteMetadataForPath: (path: string) => realIndex.noteMetadataForPath(path),
      hasNoteDescendant: (path: string) => realIndex.hasNoteDescendant(path),
      replaceNote: (note: ObsidianIndexedNoteInput) => realIndex.replaceNote(note),
      prune: (paths: readonly string[]) => realIndex.prune(paths), markSynchronized: (at: string) => realIndex.markSynchronized(at),
      snapshot: () => realIndex.snapshot(), hasNote: (path: string) => realIndex.hasNote(path),
      iterateChunks: (model?: string) => realIndex.iterateChunks(model),
      close: () => { order.push("index"); realIndex.close(); },
    };
    const embedding = {
      embed: async (texts: string[]) => ({ model: "test-model", vectors: texts.map(vectorFor) }),
      close: async () => { order.push("embedding"); },
    };
    const watcher = {
      start: () => order.push("watcher-start"),
      close: async () => { order.push("watcher-close"); },
    };
    let notifyChange = (): void => undefined;
    let timer: (() => void) | undefined;
    const service = new ObsidianSearchService({
      repository: {
        iterate: async function* () { scanStarted = true; await blocked; order.push("sync-finished"); yield* scanEntries({ notes: [], diagnostics: [] }); },
        resolveNotePath: async () => "/unused.md",
      },
      index,
      embedding,
      watcherFactory: (change) => { notifyChange = change; return watcher; },
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
      setTimer: (callback) => { timer = callback; return callback; },
      clearTimer: () => { order.push("timer-clear"); timer = undefined; },
    });
    service.start();
    let closing: Promise<void> | undefined;
    try {
      await waitUntil(() => scanStarted);
      notifyChange();
      expect(timer).toBeDefined();
      closing = service.close();
      expect(order).toEqual(["watcher-start", "watcher-close", "timer-clear"]);
    } finally {
      release?.();
    }
    await closing;
    await service.close();

    expect(order).toEqual(["watcher-start", "watcher-close", "timer-clear", "sync-finished", "embedding", "index"]);
    expect(timer).toBeUndefined();
    expect(() => service.start()).toThrow("Obsidian 搜索服务已关闭。");
    await expect(service.search({ query: "x" })).rejects.toThrow("Obsidian 搜索服务已关闭。");
    await expect(service.rebuild()).rejects.toThrow("Obsidian 搜索服务已关闭。");
    await expect(service.openNote("x.md")).rejects.toThrow("Obsidian 搜索服务已关闭。");
  });

  it("continues ordered cleanup when every cleanup dependency fails", async () => {
    const order: string[] = [];
    let releaseSync: (() => void) | undefined;
    let scanStarted = false;
    const blockedSync = new Promise<void>((resolve) => { releaseSync = resolve; });
    const index = emptyIndex();
    index.close = () => { order.push("index"); throw new Error("/private/db close failed"); };
    let notifyChange = (): void => undefined;
    const service = new ObsidianSearchService({
      repository: {
        iterate: async function* () {
          scanStarted = true;
          await blockedSync;
          order.push("sync-finished");
          yield* scanEntries({ notes: [], diagnostics: [] });
        },
        resolveNotePath: async () => "/unused.md",
      },
      index,
      embedding: {
        embed: async (texts) => ({ model: "test-model", vectors: texts.map(vectorFor) }),
        close: async () => { order.push("embedding"); throw new Error("/private/model close failed"); },
      },
      watcherFactory: (change) => {
        notifyChange = change;
        return {
          start: () => undefined,
          close: async () => { order.push("watcher"); throw new Error("/private/watch close failed"); },
        };
      },
      openExternal: async () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
      setTimer: (callback) => callback,
      clearTimer: () => { order.push("timer"); throw new Error("/private/timer clear failed"); },
    });
    services.push(service);
    service.start();
    let closingResult: Promise<{ resolved: true } | { resolved: false; error: unknown }> | undefined;
    try {
      await waitUntil(() => scanStarted);
      notifyChange();
      const closing = service.close();
      expect(service.close()).toBe(closing);
      closingResult = closing.then(
        () => ({ resolved: true as const }),
        (error: unknown) => ({ resolved: false as const, error }),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(order).toEqual(["watcher", "timer"]);
    } finally {
      releaseSync?.();
    }

    expect(await closingResult).toEqual({
      resolved: false,
      error: new Error("Obsidian 搜索资源未能完整关闭。"),
    });
    await expect(service.close()).rejects.toThrow(
      "Obsidian 搜索资源未能完整关闭。",
    );
    expect(order).toEqual(["watcher", "timer", "sync-finished", "embedding", "index"]);
  });

  it("waits for in-flight search and open operations before closing dependencies", async () => {
    const order: string[] = [];
    let releaseSearch: (() => void) | undefined;
    let releaseOpen: (() => void) | undefined;
    let searchStarted = false;
    let openStarted = false;
    const blockedSearch = new Promise<void>((resolve) => { releaseSearch = resolve; });
    const blockedOpen = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const chunk: ObsidianIndexedChunk = {
      id: "tracked", relativePath: "tracked.md", ordinal: 0, title: "Tracked", heading: null,
      text: "rollback capability", contentHash: "tracked-hash", model: "test-model", vector: vectorFor("rollback"),
    };
    const index = emptyIndex();
    index.snapshot = () => ({ noteCount: 1, chunkCount: 1, synchronizedAt: null });
    index.semanticCoverage = () => ({ totalNotes: 1, semanticNotes: 1, keywordOnlyNotes: 0, mismatchedModelNotes: 0 });
    index.hasNote = () => true;
    index.iterateChunks = function* () { yield chunk; };
    index.close = () => { order.push("index-close"); };
    const service = new ObsidianSearchService({
      repository: {
        iterate: () => scanEntries({ notes: [], diagnostics: [] }),
        resolveNotePath: async () => {
          openStarted = true;
          await blockedOpen;
          return "/vault/tracked.md";
        },
      },
      index,
      embedding: {
        embed: async (texts) => {
          searchStarted = true;
          await blockedSearch;
          return { model: "test-model", vectors: texts.map(vectorFor) };
        },
        close: async () => { order.push("embedding-close"); },
      },
      watcherFactory: watcherHarness().factory,
      openExternal: async () => { order.push("open-external"); },
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    });
    services.push(service);

    const search = service.search({ query: "上线风险" });
    const opening = service.openNote("tracked.md");
    let closing: Promise<void> | undefined;
    try {
      await waitUntil(() => searchStarted && openStarted);
      closing = service.close();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(order).toEqual([]);
      await expect(service.search({ query: "new" })).rejects.toThrow("Obsidian 搜索服务已关闭。");
      await expect(service.openNote("tracked.md")).rejects.toThrow("Obsidian 搜索服务已关闭。");
    } finally {
      releaseSearch?.();
      releaseOpen?.();
    }

    const operations = await Promise.allSettled([search, opening]);
    await expect(closing).rejects.toThrow(
      "Obsidian 搜索资源未能完整关闭。",
    );
    expect(operations.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(order).toEqual(["embedding-close", "index-close"]);
  });
});
