import { mkdir, mkdtemp, readFile, rename, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { DecisionStore, DecisionWatcher, MarkdownRepository, SqliteIndex } from "../src/index.js";
import { recordFixture } from "./fixtures.js";

// Every decision note read, counted.
const reads = vi.hoisted(() => ({ notes: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readFile = ((path: unknown, ...rest: unknown[]) => {
    if (String(path).endsWith(".md")) reads.notes += 1;
    return (actual.readFile as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof actual.readFile;
  return { ...actual, readFile, default: { ...actual, readFile } };
});

const deferred = (id: string) =>
  recordFixture({ id, question: `待补的 ${id}？`, status: "deferred_rationale", rationaleStatus: "deferred", rationaleOriginal: null, reasonFactors: [] });

describe("finding a decision's note for 补理由, 跳过 or a principle tag", () => {
  it("reads where the index has it, not the whole folder, and looks through the folder once it is not there", async () => {
    const vault = await mkdtemp(join(tmpdir(), "decision-locate-"));
    const paths = new Map<string, string>();
    const repository = new MarkdownRepository(vault, { locate: (id) => paths.get(id) ?? null });
    for (let n = 0; n < 60; n += 1) {
      const record = n < 2 ? deferred(`deferred-${n}`) : recordFixture({ id: `decision-${n}`, question: `第 ${n} 个？` });
      paths.set(record.id, (await repository.write(record)).path);
    }

    reads.notes = 0;
    await repository.skipDeferredRationale("deferred-0");
    // Every note read for each such click (sixty here): most of a second at ten thousand decisions.
    expect(reads.notes).toBeLessThan(10);
    await expect(repository.read(paths.get("deferred-0")!)).resolves.toMatchObject({ record: { rationaleStatus: "skipped" } });

    // Moved in Obsidian since the index last saw it: found through the folder, as before.
    const moved = join(vault, "Decision Journal", "decisions", "moved", "elsewhere.md");
    await mkdir(join(moved, ".."), { recursive: true });
    await rename(paths.get("deferred-1")!, moved);
    await repository.skipDeferredRationale("deferred-1");
    await expect(repository.read(moved)).resolves.toMatchObject({ record: { rationaleStatus: "skipped" } });
  });

  it("refuses, as before, while a copy beside it holds the same id", async () => {
    const vault = await mkdtemp(join(tmpdir(), "decision-locate-copy-"));
    const paths = new Map<string, string>();
    const repository = new MarkdownRepository(vault, { locate: (id) => paths.get(id) ?? null });
    const original = await repository.write(deferred("deferred-copied"));
    paths.set("deferred-copied", original.path);
    // A sync conflict's copy, beside it under its name.
    const { copyFile } = await import("node:fs/promises");
    await copyFile(original.path, original.path.replace(/\.md$/u, " 2.md"));

    await expect(repository.skipDeferredRationale("deferred-copied")).rejects.toThrow("有不止一篇决策笔记使用同一个编号");
  });

  it("refuses, as before, while a copy under its name sits in another folder", async () => {
    const vault = await mkdtemp(join(tmpdir(), "decision-locate-elsewhere-"));
    const paths = new Map<string, string>();
    const repository = new MarkdownRepository(vault, { locate: (id) => paths.get(id) ?? null });
    const original = await repository.write(deferred("deferred-elsewhere"));
    paths.set("deferred-elsewhere", original.path);
    // Copied in Finder into another month's folder, under its name.
    const other = join(vault, "Decision Journal", "decisions", "2020", "01");
    await mkdir(other, { recursive: true });
    const { copyFile } = await import("node:fs/promises");
    await copyFile(original.path, join(other, basename(original.path)));

    // Looked for only beside it, the click wrote one of the two without a word.
    await expect(repository.skipDeferredRationale("deferred-elsewhere")).rejects.toThrow("有不止一篇决策笔记使用同一个编号");
  });
});

/** Twenty decisions written an hour ago, so that their files' times stand for what they hold, and indexed. */
const indexedVault = async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-stamps-"));
  const repository = new MarkdownRepository(join(root, "vault"));
  const indexPath = join(root, "index.sqlite");
  let index = new SqliteIndex(indexPath);
  const store = () => new DecisionStore(repository, index);
  const paths: string[] = [];
  const past = new Date(Date.now() - 3_600_000);
  for (let n = 0; n < 20; n += 1) {
    const { path } = await repository.write(recordFixture({ id: `decision-${n}`, question: `第 ${n} 个？` }));
    await utimes(path, past, past);
    paths.push(path);
  }
  await store().rebuildIndex();
  return {
    repository, paths, store,
    get index() { return index; },
    /** Closed, changed by `meanwhile`, and opened again, as by the next start. */
    reopen: (meanwhile: (path: string) => void) => {
      index.close();
      meanwhile(indexPath);
      index = new SqliteIndex(indexPath);
    },
  };
};

describe("a start", () => {
  it("reads only the notes changed since the index read them, and the watcher's first look none of the others", async () => {
    const vault = await indexedVault();
    // While the app was closed: one note edited in Obsidian.
    await writeFile(vault.paths[3]!, (await readFile(vault.paths[3]!, "utf8")).replace("第 3 个？", "第 3 个，改过？"), "utf8");

    reads.notes = 0;
    await vault.store().reconcileIndex();
    // Each read and hashed at every start, ten thousand held the window back a second.
    expect(reads.notes).toBe(1);
    expect(vault.index.findDecisions(["decision-3"])[0]?.question).toBe("第 3 个，改过？");

    reads.notes = 0;
    const watcher = new DecisionWatcher(vault.repository, vault.store().watchedIndex);
    for (const path of vault.paths) await watcher.synchronizePath(path);
    // Only the one written just now, whose times cannot yet tell another write apart from it.
    expect(reads.notes).toBe(1);
    await watcher.close();
    vault.index.close();
  });

  it("reads an index's notes from before stamps once more, and from then on only what changes", async () => {
    const vault = await indexedVault();
    // An index from before: no stamp kept for any note.
    vault.reopen((path) => {
      const database = new DatabaseSync(path);
      database.exec("ALTER TABLE decisions DROP COLUMN file_stamp");
      database.close();
    });
    // Not a rebuild of every note owed: what is unknown is only read.
    expect(vault.index.needsRebuild).toBe(false);

    reads.notes = 0;
    await vault.store().reconcileIndex();
    expect(reads.notes).toBe(20);
    reads.notes = 0;
    await vault.store().reconcileIndex();
    expect(reads.notes).toBe(0);
    expect(vault.index.count()).toBe(20);
    vault.index.close();
  });
});
