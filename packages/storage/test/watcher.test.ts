import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  DecisionWatcher,
  MarkdownRepository,
  SqliteIndex,
  serializeDecision,
} from "../src/index.js";
import { recordFixture } from "./fixtures.js";

const makeWatcher = async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-watcher-"));
  const repository = new MarkdownRepository(join(root, "vault"));
  const index = new SqliteIndex(join(root, "index.sqlite"));
  const diagnostics: Array<{ path: string; message: string }> = [];
  const onSynchronized = vi.fn();
  const watcher = new DecisionWatcher(
    repository,
    index,
    (diagnostic) => diagnostics.push(diagnostic),
    onSynchronized,
  );
  return {
    repository,
    index,
    diagnostics,
    onSynchronized,
    watcher,
  };
};

describe("DecisionWatcher", () => {
  it.each(["change", "unlink", "close"] as const)(
    "ignores a stale read after %s",
    async (event) => {
      const { repository, index, onSynchronized, watcher } = await makeWatcher();
      const stored = await repository.write(recordFixture());
      const stale = await repository.read(stored.path);
      let release!: (note: typeof stale) => void;
      let reading!: () => void;
      const read = new Promise<void>((resolve) => { reading = resolve; });
      vi.spyOn(repository, "read").mockImplementationOnce(() => {
        reading();
        return new Promise((resolve) => { release = resolve; });
      });
      const pending = watcher.synchronizePath(stored.path);
      // The note being read when it changes, goes or the watcher closes.
      await read;

      if (event === "change") {
        await writeFile(stored.path, serializeDecision(recordFixture({ tags: ["latest"] })), "utf8");
        await watcher.synchronizePath(stored.path);
      } else if (event === "unlink") {
        watcher.removePath(stored.path);
      } else {
        await watcher.close();
      }
      onSynchronized.mockClear();
      release(stale);
      await pending;

      expect(index.count()).toBe(event === "change" ? 1 : 0);
      if (event === "change") expect(index.search("latest")).toHaveLength(1);
      expect(onSynchronized).not.toHaveBeenCalled();
      index.close();
    },
  );

  it("has a folder to watch from a first run on, and makes up no vault that is not there", async () => {
    const { access, mkdir } = await import("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "decision-watcher-first-"));
    const vault = join(root, "vault");
    await mkdir(vault);
    const first = new DecisionWatcher(new MarkdownRepository(vault), new SqliteIndex(join(root, "index.sqlite")));
    first.start();
    // chokidar never picks up a folder that appears after it began waiting: made now, the first save is watched.
    await expect(access(join(vault, "Decision Journal", "decisions"))).resolves.toBeUndefined();
    await first.close();

    const unmounted = join(root, "unmounted");
    const missing = new DecisionWatcher(new MarkdownRepository(unmounted), new SqliteIndex(join(root, "other.sqlite")));
    missing.start();
    await expect(access(unmounted)).rejects.toThrow();
    await missing.close();

    // A folder it may not make (read-only, locked by a sync tool) is said, and does not stop the app.
    const { chmod } = await import("node:fs/promises");
    const locked = join(root, "locked");
    await mkdir(join(locked, "Decision Journal"), { recursive: true });
    await chmod(join(locked, "Decision Journal"), 0o500);
    const said: string[] = [];
    const readOnly = new DecisionWatcher(new MarkdownRepository(locked), new SqliteIndex(join(root, "locked.sqlite")), (diagnostic) => said.push(diagnostic.path));
    try {
      expect(() => readOnly.start()).not.toThrow();
      expect(said).toEqual([join(locked, "Decision Journal", "decisions")]);
    } finally {
      await readOnly.close();
      await chmod(join(locked, "Decision Journal"), 0o700);
    }
  });

  it("watches a vault that was not there at start once started again, as a rebuild does", async () => {
    const { mkdir } = await import("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "decision-watcher-late-"));
    const vault = join(root, "Volumes", "Notes", "vault");
    const repository = new MarkdownRepository(vault);
    const index = new SqliteIndex(join(root, "index.sqlite"));
    const watcher = new DecisionWatcher(repository, index);
    // Started with its drive not connected yet.
    watcher.start();
    await mkdir(join(vault, "Decision Journal", "decisions"), { recursive: true });
    await repository.write(recordFixture({ id: "decision-1", question: "要不要上 Kafka？" }));

    watcher.start();
    await vi.waitFor(() => expect(index.count()).toBe(1), { timeout: 10_000 });
    // Begun on nothing, it never picked up what was edited in Obsidian after the drive came back.
    await repository.write(recordFixture({ id: "decision-2", question: "要不要拆库？" }));
    await vi.waitFor(() => expect(index.count()).toBe(2), { timeout: 10_000 });
    await watcher.close();
    index.close();
  });

  it("indexes a decision again from its remaining note when the copy it pointed to is deleted", async () => {
    const { repository, index, watcher } = await makeWatcher();
    const original = await repository.write(recordFixture());
    // What Obsidian's "make a copy" leaves: the same decision under the same name, numbered.
    const copy = original.path.replace(/\.md$/u, " 1.md");
    await writeFile(copy, await readFile(original.path, "utf8"), "utf8");
    index.upsert(await repository.read(original.path));
    index.upsert(await repository.read(copy));
    expect(index.contentHashForPath(original.path)).toBeNull();

    const { unlink } = await import("node:fs/promises");
    await unlink(copy);
    watcher.removePath(copy);

    await vi.waitFor(() => expect(index.contentHashForPath(original.path)).not.toBeNull());
    expect(index.count()).toBe(1);
    await watcher.close();
  });

  it.runIf(process.platform === "darwin")("watches the folder with one handle, not one per note, and keeps up with notes and folders", async () => {
    const { readdirSync } = await import("node:fs");
    const { rename } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const { repository, index, diagnostics, watcher } = await makeWatcher();
    const stored = [];
    for (let n = 0; n < 200; n += 1) stored.push(await repository.write(recordFixture({ id: `decision-${n}`, question: `问题 ${n}？` })));
    const before = readdirSync("/dev/fd").length;
    watcher.start();
    await vi.waitFor(() => expect(index.count()).toBe(200), { timeout: 10_000 });
    // chokidar held a descriptor per note: a few thousand decisions left none for saving or a rebuild.
    expect(readdirSync("/dev/fd").length - before).toBeLessThan(20);

    // Not notes, so no decision that "cannot be read": Finder's file, and a write's leftover.
    const month = dirname(stored[0]!.path);
    await writeFile(join(month, ".DS_Store"), Buffer.from([0, 0, 0, 1]));
    await writeFile(`${stored[0]!.path}.4242.leftover.tmp`, "partial", "utf8");
    await writeFile(stored[1]!.path, serializeDecision(recordFixture({ id: "decision-1", question: "问题 1？", tags: ["edited"] })), "utf8");
    await vi.waitFor(() => expect(index.search("edited")).toHaveLength(1), { timeout: 10_000 });
    // A folder moved out takes its notes along.
    await rename(month, join(repository.decisionsPath, "..", "elsewhere"));
    await vi.waitFor(() => expect(index.count()).toBe(0), { timeout: 10_000 });
    expect(diagnostics).toEqual([]);
    await watcher.close();
    index.close();
  });

  it.runIf(process.platform === "darwin")("passes over macOS's hidden copies, and keeps a decision iCloud moved off this Mac", async () => {
    const { mkdir, rename } = await import("node:fs/promises");
    const { basename, dirname } = await import("node:path");
    const { repository, index, diagnostics, watcher } = await makeWatcher();
    const evicted = await repository.write(recordFixture({ id: "decision-evicted", question: "留在云端吗？" }));
    const other = await repository.write(recordFixture({ id: "decision-other", question: "另一个？" }));
    watcher.start();
    await vi.waitFor(() => expect(index.count()).toBe(2), { timeout: 10_000 });

    // The ._ copy macOS writes beside a note on exFAT or a share was read as a decision that could not be read,
    // after every capture; a note iCloud moved off this Mac left the index as if deleted.
    await writeFile(join(dirname(other.path), `._${basename(other.path)}`), Buffer.from([0, 5, 22, 7]));
    await rename(evicted.path, join(dirname(evicted.path), `.${basename(evicted.path)}.icloud`));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const notICloud = () => diagnostics.filter((diagnostic) => !diagnostic.message.includes("iCloud"));
    expect(index.count()).toBe(2);
    expect(notICloud()).toEqual([]);

    // Read through again (a folder made; the system may have coalesced the events into one already), it is
    // still there, and said to be in iCloud.
    await mkdir(join(repository.decisionsPath, "2027"));
    await vi.waitFor(() => expect(diagnostics).toContainEqual(expect.objectContaining({ message: expect.stringContaining("iCloud") })), { timeout: 10_000 });
    expect(notICloud()).toEqual([]);
    expect(index.count()).toBe(2);
    await watcher.close();
    index.close();
  });

  it.runIf(process.platform === "darwin")("takes out a decision whose note, moved off this Mac by iCloud, was then deleted elsewhere", async () => {
    const { rename, rm } = await import("node:fs/promises");
    const { basename, dirname } = await import("node:path");
    const { repository, index, watcher } = await makeWatcher();
    const placeholderOf = (path: string): string => join(dirname(path), `.${basename(path)}.icloud`);
    const before = await repository.write(recordFixture({ id: "decision-before", question: "启动前就在云端？" }));
    const during = await repository.write(recordFixture({ id: "decision-during", question: "运行时移到云端？" }));
    // One evicted before the app started (as the last run indexed it), one while it runs.
    index.upsert(await repository.read(before.path));
    await rename(before.path, placeholderOf(before.path));
    watcher.start();
    await vi.waitFor(() => expect(index.count()).toBe(2), { timeout: 10_000 });
    await rename(during.path, placeholderOf(during.path));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(index.count()).toBe(2);

    // Deleted on another device, or on iCloud.com: iCloud takes the placeholder away and nothing else changes.
    await rm(placeholderOf(before.path));
    await rm(placeholderOf(during.path));
    // Kept, each stayed listed, and failed to open, until a restart.
    await vi.waitFor(() => expect(index.count()).toBe(0), { timeout: 10_000 });
    await watcher.close();
    index.close();
  });

  it("does not parse a note it finds as indexed, and does one that changed", async () => {
    const { repository, index, watcher } = await makeWatcher();
    const stored = await repository.write(recordFixture());
    index.upsert(await repository.read(stored.path));
    const read = vi.spyOn(repository, "read");

    await watcher.synchronizePath(stored.path);
    // A sweep read every note through the parser to find most of them as they were.
    expect(read).not.toHaveBeenCalled();
    await writeFile(stored.path, serializeDecision(recordFixture({ tags: ["changed-since"] })), "utf8");
    await watcher.synchronizePath(stored.path);
    expect(read).toHaveBeenCalledTimes(1);
    expect(index.search("changed-since")).toHaveLength(1);
    index.close();
  });

  it("re-indexes a valid external Markdown edit", async () => {
    const { repository, index, onSynchronized, watcher } =
      await makeWatcher();
    const stored = await repository.write(recordFixture());
    index.upsert(await repository.read(stored.path));
    const edited = serializeDecision(
      recordFixture({
        tags: ["externally-edited"],
        rationaleOriginal: "用户在 Obsidian 中改过。",
      }),
    );
    await writeFile(stored.path, edited, "utf8");

    await watcher.synchronizePath(stored.path);

    expect(index.search("externally-edited")).toHaveLength(1);
    expect((await repository.read(stored.path)).record.rationaleOriginal).toBe(
      "用户在 Obsidian 中改过。",
    );
    expect(onSynchronized).toHaveBeenCalledWith(stored.path);
    index.close();
  });

  it("reports malformed external Markdown without overwriting it", async () => {
    const {
      repository,
      index,
      diagnostics,
      onSynchronized,
      watcher,
    } = await makeWatcher();
    const path = join(repository.decisionsPath, "broken.md");
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(repository.decisionsPath, { recursive: true }),
    );
    const malformed = "---\nid: broken\n---\nnot a decision";
    await writeFile(path, malformed, "utf8");

    await watcher.synchronizePath(path);

    expect(diagnostics).toEqual([
      expect.objectContaining({ path, message: expect.any(String) }),
    ]);
    expect(await readFile(path, "utf8")).toBe(malformed);
    expect(index.count()).toBe(0);
    expect(onSynchronized).not.toHaveBeenCalled();
    index.close();
  });

  it("removes a deleted note from the index", async () => {
    const { repository, index, onSynchronized, watcher } =
      await makeWatcher();
    const stored = await repository.write(recordFixture());
    index.upsert(await repository.read(stored.path));

    watcher.removePath(stored.path);

    expect(index.count()).toBe(0);
    expect(onSynchronized).toHaveBeenCalledWith(stored.path);
    index.close();
  });

  it("reports a failed deletion without claiming synchronization", async () => {
    const { index, diagnostics, onSynchronized, watcher } = await makeWatcher();
    vi.spyOn(index, "removePath").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });

    expect(() => watcher.removePath("deleted.md")).not.toThrow();
    expect(diagnostics).toEqual([
      { path: "deleted.md", message: "database is locked" },
    ]);
    expect(onSynchronized).not.toHaveBeenCalled();
    index.close();
  });
});
