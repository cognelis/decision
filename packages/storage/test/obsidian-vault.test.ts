import { constants } from "node:fs";
import type { Dir, Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, mkdtemp, mkdir, open, opendir, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ObsidianVaultRepository,
  ObsidianVaultWatcher,
} from "../src/index.js";

const temporaryRoots: string[] = [];
const makeTemporaryRoot = async (prefix: string) => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
};
const makeVault = () => makeTemporaryRoot("obsidian-vault-");

afterEach(async () => {
  const roots = temporaryRoots.splice(0);
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const detectSymlinkSupport = async (): Promise<boolean> => {
  const root = await mkdtemp(join(tmpdir(), "obsidian-symlink-check-"));
  try {
    const target = join(root, "target");
    await writeFile(target, "target");
    await symlink(target, join(root, "link"));
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "EPERM" || code === "EACCES") return false;
    throw error;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const symlinkSupported = await detectSymlinkSupport();

const fakeDirent = (name: string, kind: "directory" | "file" | "socket" | "device"): Dirent => ({
  name,
  isDirectory: () => kind === "directory",
  isFile: () => kind === "file",
  isSymbolicLink: () => false,
  isSocket: () => kind === "socket",
  isCharacterDevice: () => kind === "device",
} as Dirent);

const fakeDir = (entries: Dirent[]) => {
  const close = vi.fn(async () => undefined);
  const iterate = vi.fn();
  const directory = {
    close,
    async *[Symbol.asyncIterator]() {
      iterate();
      yield* entries;
    },
  } as unknown as Dir;
  return { close, directory, iterate };
};

const deferred = <T>() => {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
};

const expectResolveFailureWithoutVaultPath = async (
  repository: ObsidianVaultRepository,
  relativePath: string,
  vault: string,
) => {
  const error = await repository.resolveNotePath(relativePath).then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).not.toContain(vault);
};

describe("ObsidianVaultRepository", () => {
  it("leaves out every folder and note whose name starts with a dot, as Obsidian does", async () => {
    const vault = await makeVault();
    await writeFile(join(vault, "周报.md"), "# 周报");
    await mkdir(join(vault, ".stversions"));
    await writeFile(join(vault, ".stversions", "周报~20260901.md"), "# 周报（旧）");
    await mkdir(join(vault, ".history"));
    await writeFile(join(vault, ".history", "周报_20260902.md"), "# 周报（旧）");

    const scan = await new ObsidianVaultRepository(vault).scan();

    // Old copies kept by Syncthing and VS Code came up as more results under the same name.
    expect(scan.notes.map((note) => note.relativePath)).toEqual(["周报.md"]);
  });

  it("iterates lazily and closes the open directory when the consumer returns", async () => {
    const vault = await makeVault();
    for (const name of ["a.md", "b.md", "c.md"]) await writeFile(join(vault, name), name);
    const rootDirectory = fakeDir([
      fakeDirent("a.md", "file"),
      fakeDirent("b.md", "file"),
      fakeDirent("c.md", "file"),
    ]);
    const openedPaths: string[] = [];
    const repository = new ObsidianVaultRepository(vault, {
      opendir: (async (path: string) => path === vault ? rootDirectory.directory : opendir(path)) as typeof opendir,
      open: (async (path: string, flags: number) => {
        openedPaths.push(path);
        return open(path, flags);
      }) as typeof open,
    });

    const iterator = repository.iterate();
    const first = await iterator.next();

    expect(first.value).toMatchObject({ kind: "note", note: { relativePath: "a.md", content: "a.md" } });
    expect(openedPaths).toEqual([join(vault, "a.md")]);
    await iterator.return?.();
    expect(rootDirectory.close).toHaveBeenCalledTimes(1);
    expect(openedPaths).toEqual([join(vault, "a.md")]);
  });

  it("aborts before starting without opening the vault", async () => {
    const vault = await makeVault();
    const openDirectory = vi.fn(opendir);
    const repository = new ObsidianVaultRepository(vault, { opendir: openDirectory as typeof opendir });
    const controller = new AbortController();
    controller.abort();

    await expect(repository.iterate(controller.signal).next()).rejects.toMatchObject({ name: "AbortError" });
    expect(openDirectory).not.toHaveBeenCalled();
  });

  it("closes a directory acquired after aborting a pending opendir", async () => {
    const vault = await makeVault();
    const pendingDirectory = deferred<Dir>();
    const acquisitionStarted = deferred<void>();
    const acquiredDirectory = fakeDir([]);
    const repository = new ObsidianVaultRepository(vault, {
      opendir: (async () => {
        acquisitionStarted.resolve();
        return pendingDirectory.promise;
      }) as typeof opendir,
    });
    const controller = new AbortController();
    const next = repository.iterate(controller.signal).next();
    await acquisitionStarted.promise;

    controller.abort();
    pendingDirectory.resolve(acquiredDirectory.directory);

    await expect(next).rejects.toMatchObject({ name: "AbortError" });
    expect(acquiredDirectory.close).toHaveBeenCalledTimes(1);
    expect(acquiredDirectory.iterate).not.toHaveBeenCalled();
  });

  it("closes a file acquired after aborting a pending open", async () => {
    const vault = await makeVault();
    const notePath = join(vault, "note.md");
    await writeFile(notePath, "note");
    const rootDirectory = fakeDir([fakeDirent("note.md", "file")]);
    const pendingFile = deferred<FileHandle>();
    const acquisitionStarted = deferred<void>();
    const acquiredFile = {
      stat: vi.fn(),
      read: vi.fn(),
      close: vi.fn(async () => undefined),
    } as unknown as FileHandle;
    const repository = new ObsidianVaultRepository(vault, {
      opendir: (async () => rootDirectory.directory) as typeof opendir,
      open: (async () => {
        acquisitionStarted.resolve();
        return pendingFile.promise;
      }) as typeof open,
    });
    const controller = new AbortController();
    const next = repository.iterate(controller.signal).next();
    await acquisitionStarted.promise;

    controller.abort();
    pendingFile.resolve(acquiredFile);

    await expect(next).rejects.toMatchObject({ name: "AbortError" });
    expect(acquiredFile.close).toHaveBeenCalledTimes(1);
    expect(acquiredFile.stat).not.toHaveBeenCalled();
    expect(acquiredFile.read).not.toHaveBeenCalled();
    expect(rootDirectory.close).toHaveBeenCalledTimes(1);
  });

  it("aborts during directory enumeration and closes the directory without yielding a diagnostic", async () => {
    const vault = await makeVault();
    await writeFile(join(vault, "next.md"), "next");
    const controller = new AbortController();
    const close = vi.fn(async () => undefined);
    const directory = {
      close,
      [Symbol.asyncIterator]() {
        return {
          next: vi.fn(async () => {
            controller.abort();
            return { done: false as const, value: fakeDirent("next.md", "file") };
          }),
        };
      },
    } as unknown as Dir;
    const openFile = vi.fn(open);
    const repository = new ObsidianVaultRepository(vault, {
      opendir: (async () => directory) as typeof opendir,
      open: openFile as typeof open,
    });
    const iterator = repository.iterate(controller.signal);

    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
    expect(close).toHaveBeenCalledTimes(1);
    expect(openFile).not.toHaveBeenCalled();
  });

  it("aborts during a file read and closes file and directory handles without yielding the next note", async () => {
    const vault = await makeVault();
    const firstPath = join(vault, "first.md");
    const nextPath = join(vault, "next.md");
    await writeFile(firstPath, "first");
    await writeFile(nextPath, "next");
    const rootDirectory = fakeDir([
      fakeDirent("first.md", "file"),
      fakeDirent("next.md", "file"),
    ]);
    const controller = new AbortController();
    const openedPaths: string[] = [];
    const fileClose = vi.fn(async () => undefined);
    const repository = new ObsidianVaultRepository(vault, {
      opendir: (async () => rootDirectory.directory) as typeof opendir,
      open: (async (path: string, flags: number) => {
        openedPaths.push(path);
        const handle = await open(path, flags);
        return {
          stat: handle.stat.bind(handle),
          read: async (buffer: Buffer, offset: number, length: number, position: number) => {
            controller.abort();
            return handle.read(buffer, offset, length, position);
          },
          close: async () => {
            fileClose();
            await handle.close();
          },
        } as unknown as FileHandle;
      }) as typeof open,
    });

    await expect(repository.iterate(controller.signal).next()).rejects.toMatchObject({ name: "AbortError" });
    expect(fileClose).toHaveBeenCalledTimes(1);
    expect(rootDirectory.close).toHaveBeenCalledTimes(1);
    expect(openedPaths).toEqual([firstPath]);
  });

  it("streams 1000 synthetic tiny notes with one live entry and adaptive bounded reads", async () => {
    const vault = resolve(join(tmpdir(), "synthetic-vault"));
    const entries = Array.from({ length: 1000 }, (_, index) => fakeDirent(`note-${index}.md`, "file"));
    const rootDirectory = fakeDir(entries);
    const requestedSizes: number[] = [];
    let activeHandles = 0;
    let maxActiveHandles = 0;
    const directoryStat = {
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => false,
    };
    const repository = new ObsidianVaultRepository(vault, {
      opendir: (async () => rootDirectory.directory) as typeof opendir,
      lstat: (async (path: string, options?: { bigint?: boolean }) => {
        if (path === vault) return directoryStat;
        const index = Number(/note-(\d+)\.md$/u.exec(path)?.[1] ?? 0);
        if (options?.bigint === true) {
          return {
            dev: 1n,
            ino: BigInt(index + 1),
            isDirectory: () => false,
            isFile: () => true,
            isSymbolicLink: () => false,
          };
        }
        return {
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
        };
      }) as typeof lstat,
      realpath: (async (path: string) => path) as typeof realpath,
      open: (async (path: string) => {
        const index = Number(/note-(\d+)\.md$/u.exec(path)?.[1] ?? 0);
        const bytes = Buffer.from(String(index));
        const fileStat = {
          dev: 1n,
          ino: BigInt(index + 1),
          size: BigInt(bytes.byteLength),
          mtimeNs: 1n,
          isFile: () => true,
          isSymbolicLink: () => false,
        };
        activeHandles += 1;
        maxActiveHandles = Math.max(maxActiveHandles, activeHandles);
        return {
          stat: async () => fileStat,
          read: async (buffer: Buffer, offset: number, length: number, position: number) => {
            requestedSizes.push(length);
            const count = Math.min(length, Math.max(0, bytes.byteLength - position));
            if (count > 0) bytes.copy(buffer, offset, position, position + count);
            return { bytesRead: count, buffer };
          },
          close: async () => { activeHandles -= 1; },
        } as unknown as FileHandle;
      }) as typeof open,
    });

    let count = 0;
    let liveYieldedContent = 0;
    let maxLiveYieldedContent = 0;
    for await (const entry of repository.iterate()) {
      expect(entry.kind).toBe("note");
      liveYieldedContent += 1;
      maxLiveYieldedContent = Math.max(maxLiveYieldedContent, liveYieldedContent);
      expect(activeHandles).toBe(0);
      count += 1;
      liveYieldedContent -= 1;
    }

    expect(count).toBe(1000);
    expect(maxLiveYieldedContent).toBe(1);
    expect(maxActiveHandles).toBe(1);
    expect(Math.max(...requestedSizes)).toBeLessThanOrEqual(4);
    expect(rootDirectory.close).toHaveBeenCalledTimes(1);
  });

  it("keeps scan compatibility with separately sorted notes and diagnostics", async () => {
    const vault = await makeVault();
    await writeFile(join(vault, "z.md"), "z");
    await writeFile(join(vault, "a.md"), "a");
    await writeFile(join(vault, "z-invalid.md"), Buffer.from([0xc3, 0x28]));
    await writeFile(join(vault, "a-invalid.md"), Buffer.from([0xc3, 0x28]));

    const scan = await new ObsidianVaultRepository(vault).scan();

    expect(scan.notes.map((note) => note.relativePath)).toEqual(["a.md", "z.md"]);
    expect(scan.diagnostics.map((diagnostic) => diagnostic.relativePath)).toEqual([
      "a-invalid.md",
      "z-invalid.md",
    ]);
  });

  it("excludes documented directory names case-insensitively while scanning", async () => {
    const vault = await makeVault();
    for (const excluded of [".GIT", ".Obsidian", ".TRASH", ".Hg", ".SVN", "Node_Modules"]) {
      await mkdir(join(vault, excluded));
      await writeFile(join(vault, excluded, "ignored.md"), "ignored");
    }
    await writeFile(join(vault, "kept.md"), "kept");

    const scan = await new ObsidianVaultRepository(vault).scan();

    expect(scan.notes.map((note) => note.relativePath)).toEqual(["kept.md"]);
    expect(scan.diagnostics).toEqual([]);
  });

  it("discovers ordinary Markdown notes safely, and does not open the app's own Decision Journal", async () => {
    const vault = await makeVault();
    await mkdir(join(vault, "知识", "Decision Journal"), { recursive: true });
    await mkdir(join(vault, "Decision Journal", "decisions"), {
      recursive: true,
    });
    await writeFile(join(vault, "root.md"), "root");
    await writeFile(join(vault, "知识", "说明.md"), "说明");
    await writeFile(join(vault, "知识", "Decision Journal", "摘抄.md"), "摘抄");
    await writeFile(join(vault, "Decision Journal", "decisions", "decision.md"), "decision");
    await writeFile(join(vault, "UPPER.MD"), "upper");
    for (const ignored of [".obsidian", ".trash", ".git", ".hg", ".svn", "node_modules"]) {
      await mkdir(join(vault, ignored));
      await writeFile(join(vault, ignored, "ignored.md"), "ignored");
    }
    await writeFile(join(vault, "not.txt"), "not");
    await writeFile(join(vault, "too-large.md"), Buffer.alloc(5 * 1024 * 1024 + 1));
    await writeFile(join(vault, "invalid.md"), Buffer.from([0xc3, 0x28]));
    const outside = await makeTemporaryRoot("outside-");
    if (symlinkSupported) {
      await symlink(join(vault, "root.md"), join(vault, "linked.md"));
      await symlink(join(outside), join(vault, "linked-dir"));
    }

    const touched: string[] = [];
    const repository = new ObsidianVaultRepository(vault, {
      opendir: ((path: string, ...rest: []) => { touched.push(path); return opendir(path, ...rest); }) as typeof opendir,
      open: ((path: string, ...rest: []) => { touched.push(path); return open(path, ...rest); }) as typeof open,
    });
    const scan = await repository.scan();
    // Its notes answer to the decision services: read through and only then passed over by the note index,
    // ten thousand of them were read on every sync, and the app's every write started one.
    expect(scan.notes.map((note) => note.relativePath)).toEqual([
      "UPPER.MD",
      "root.md",
      "知识/Decision Journal/摘抄.md",
      "知识/说明.md",
    ]);
    expect(touched.filter((path) => path.startsWith(join(vault, "Decision Journal")))).toEqual([]);
    const own = [];
    for await (const entry of repository.iterateFolder("Decision Journal/decisions")) own.push(entry);
    expect(own).toMatchObject([{ kind: "note", note: { relativePath: "Decision Journal/decisions/decision.md" } }]);
    expect(scan.notes.every((note) => !note.relativePath.startsWith(vault))).toBe(true);
    expect(scan.diagnostics.map((diagnostic) => diagnostic.relativePath).sort()).toEqual(["invalid.md", "too-large.md"]);
    const rootNote = scan.notes.find((note) => note.relativePath === "root.md");
    expect(rootNote).toMatchObject({ content: "root", size: 4, contentHash: "4813494d137e1631bba301d5acab6e7bb7aa74ce1185d456565ef51d737677b2" });
    const rootStat = await stat(join(vault, "root.md"), { bigint: true });
    expect(rootNote?.modifiedAtMs).toBe(Number(rootStat.mtimeNs) / 1_000_000);
    if (symlinkSupported) expect(scan.notes.some((note) => note.relativePath === "linked.md")).toBe(false);
  });

  it("reads a folder's notes again only once they change", async () => {
    const vault = await makeVault();
    const folder = join(vault, "Decision Journal", "decisions");
    await mkdir(folder, { recursive: true });
    const settled = async (name: string, content: string): Promise<void> => {
      await writeFile(join(folder, name), content);
      const at = new Date(Date.now() - 60_000);
      await utimes(join(folder, name), at, at);
    };
    await settled("a.md", "a");
    await settled("b.md", "b");
    const opened: string[] = [];
    const repository = new ObsidianVaultRepository(vault, {
      open: (async (path: string, flags: number) => {
        opened.push(path);
        return open(path, flags);
      }) as typeof open,
    });
    const read = async (): Promise<string[]> => {
      const contents: string[] = [];
      for await (const entry of repository.iterateFolder("Decision Journal/decisions")) {
        if (entry.kind === "note") contents.push(entry.note.content);
      }
      return contents.sort();
    };
    expect(await read()).toEqual(["a", "b"]);
    expect(await read()).toEqual(["a", "b"]);
    // Every search read every note again: seconds at ten thousand decisions.
    expect(opened).toHaveLength(2);
    await settled("b.md", "b2");
    await rm(join(folder, "a.md"));
    expect(await read()).toEqual(["b2"]);
    expect(opened).toHaveLength(3);
    // Written just now, it is read every time: a clock too coarse could not tell its next write from it.
    await writeFile(join(folder, "c.md"), "c");
    expect(await read()).toEqual(["b2", "c"]);
    expect(await read()).toEqual(["b2", "c"]);
    expect(opened).toHaveLength(5);
  });

  it("ends a listing cut short too, forgetting in time a note such listings no longer reach", async () => {
    const vault = await makeVault();
    const folder = join(vault, "Decision Journal", "decisions");
    await mkdir(folder, { recursive: true });
    const at = new Date(Date.now() - 60_000);
    for (const name of ["a.md", "b.md"]) {
      await writeFile(join(folder, name), name);
      await utimes(join(folder, name), at, at);
    }
    const opened: string[] = [];
    const repository = new ObsidianVaultRepository(vault, {
      open: (async (path: string, flags: number) => {
        opened.push(path);
        return open(path, flags);
      }) as typeof open,
    });
    const listing = (stopAfterFirst: boolean) => async () => {
      for await (const entry of repository.iterateFolder("Decision Journal/decisions")) {
        if (stopAfterFirst && entry.kind === "note") break;
      }
    };
    await listing(false)();
    // A reader that stops at its cap, every time: the note past it was kept for good, deleted or not.
    for (let time = 0; time < 4; time += 1) await listing(true)();
    await listing(false)();
    expect(opened).toHaveLength(3);
  });

  it("rejects unsafe note paths", async () => {
    const vault = await makeVault();
    await writeFile(join(vault, "ok.md"), "ok");
    const repository = new ObsidianVaultRepository(vault);
    for (const path of ["../outside.md", "/tmp/absolute.md", "C:/outside.md", "C:\\outside.md", "ok.txt", "missing.md", "", ".", "a\\b.md", "a/./ok.md", "a//ok.md"]) {
      await expectResolveFailureWithoutVaultPath(repository, path, vault);
    }
    expect(await repository.resolveNotePath("ok.md")).toBe(join(vault, "ok.md"));
  });

  it("says a note is gone only when the vault is there, the file is not, and iCloud holds no placeholder for it", async () => {
    const vault = await makeVault();
    await mkdir(join(vault, "notes"));
    await writeFile(join(vault, "notes", "here.md"), "还在");
    await writeFile(join(vault, "notes", ".evicted.md.icloud"), "");
    const repository = new ObsidianVaultRepository(vault);

    expect(await repository.noteExists("notes/here.md")).toBe(true);
    expect(await repository.noteExists("notes/deleted.md")).toBe(false);
    expect(await repository.noteExists("moved-folder/deleted.md")).toBe(false);
    // Moved off this Mac by iCloud, a link, an unsafe path, the vault unmounted: no answer. Answered "gone", the
    // assistant dropped a note still in the vault from the conversation.
    await expect(repository.noteExists("notes/evicted.md")).rejects.toThrow();
    await symlink(join(vault, "notes", "here.md"), join(vault, "notes", "linked.md"));
    await expect(repository.noteExists("notes/linked.md")).rejects.toThrow();
    await expect(repository.noteExists("../outside.md")).rejects.toThrow();
    await rm(vault, { recursive: true, force: true });
    await expect(repository.noteExists("notes/here.md")).rejects.toThrow();
  });

  it("validates an opened directory before enumerating it and continues after an external replacement", async () => {
    const vault = await makeVault();
    const swapped = join(vault, "swapped");
    await mkdir(swapped);
    await writeFile(join(vault, "safe.md"), "safe");
    const rootDirectory = fakeDir([
      fakeDirent("swapped", "directory"),
      fakeDirent("safe.md", "file"),
    ]);
    const outsideDirectory = fakeDir([fakeDirent("secret.md", "file")]);
    const events: string[] = [];

    const repository = new ObsidianVaultRepository(vault, {
      opendir: (async (path: string) => {
        events.push(`open:${path}`);
        if (path === vault) return rootDirectory.directory;
        if (path === swapped) return outsideDirectory.directory;
        return opendir(path);
      }) as typeof opendir,
      realpath: (async (path: string) => {
        events.push(`real:${path}`);
        if (path === swapped) return join(vault, "..", "outside");
        return realpath(path);
      }) as typeof realpath,
    });

    const scan = await repository.scan();

    expect(scan.notes.map((note) => [note.relativePath, note.content])).toEqual([["safe.md", "safe"]]);
    expect(scan.notes.some((note) => note.content.includes("secret"))).toBe(false);
    expect(events.indexOf(`open:${swapped}`)).toBeLessThan(events.indexOf(`real:${swapped}`));
    expect(outsideDirectory.close).toHaveBeenCalledTimes(1);
  });

  it("does not leak names or content from a stale external directory handle after its path is restored", async () => {
    const vault = await makeVault();
    const restoredDirectoryPath = join(vault, "restored");
    const externalName = "outside-secret.md";
    await mkdir(restoredDirectoryPath);
    await writeFile(join(vault, "safe.md"), "safe");
    const rootDirectory = fakeDir([
      fakeDirent("restored", "directory"),
      fakeDirent("safe.md", "file"),
    ]);
    const staleExternalDirectory = fakeDir([fakeDirent(externalName, "file")]);
    const openedPaths: string[] = [];
    const repository = new ObsidianVaultRepository(vault, {
      opendir: (async (path: string) => {
        if (path === vault) return rootDirectory.directory;
        if (path === restoredDirectoryPath) return staleExternalDirectory.directory;
        return opendir(path);
      }) as typeof opendir,
      open: (async (path: string, flags: number) => {
        openedPaths.push(path);
        return open(path, flags);
      }) as typeof open,
    });

    const scan = await repository.scan();

    expect(scan.notes.map((note) => [note.relativePath, note.content])).toEqual([["safe.md", "safe"]]);
    expect(scan.diagnostics).toEqual([{ relativePath: "restored", reason: "Unable to read Markdown note" }]);
    expect(JSON.stringify(scan)).not.toContain(externalName);
    expect(JSON.stringify(scan)).not.toContain(vault);
    expect(openedPaths).not.toContain(join(restoredDirectoryPath, externalName));
    expect(staleExternalDirectory.close).toHaveBeenCalledTimes(1);
  });

  it("does not expose an unvalidated child directory name from a stale external handle", async () => {
    const vault = await makeVault();
    const restoredDirectoryPath = join(vault, "restored");
    const externalDirectoryName = "outside-folder";
    await mkdir(restoredDirectoryPath);
    await writeFile(join(vault, "safe.md"), "safe");
    const rootDirectory = fakeDir([
      fakeDirent("restored", "directory"),
      fakeDirent("safe.md", "file"),
    ]);
    const staleExternalDirectory = fakeDir([fakeDirent(externalDirectoryName, "directory")]);
    const repository = new ObsidianVaultRepository(vault, {
      opendir: (async (path: string) => {
        if (path === vault) return rootDirectory.directory;
        if (path === restoredDirectoryPath) return staleExternalDirectory.directory;
        throw new Error(`ENOENT: ${path}`);
      }) as typeof opendir,
    });

    const scan = await repository.scan();

    expect(scan.notes.map((note) => note.relativePath)).toEqual(["safe.md"]);
    expect(scan.diagnostics).toEqual([{ relativePath: "restored", reason: "Unable to read directory" }]);
    expect(JSON.stringify(scan)).not.toContain(externalDirectoryName);
    expect(JSON.stringify(scan)).not.toContain(vault);
  });

  it("rejects a directory symlink replacement after opendir without enumerating it", async () => {
    const vault = await makeVault();
    const swapped = join(vault, "swapped");
    await mkdir(swapped);
    await writeFile(join(vault, "safe.md"), "safe");
    const originalStat = await stat(swapped);
    const symlinkStat = Object.create(originalStat) as typeof originalStat;
    symlinkStat.isSymbolicLink = () => true;
    const rootDirectory = fakeDir([
      fakeDirent("swapped", "directory"),
      fakeDirent("safe.md", "file"),
    ]);
    const replacedDirectory = fakeDir([fakeDirent("secret.md", "file")]);
    let childOpened = false;
    const repository = new ObsidianVaultRepository(vault, {
      opendir: (async (path: string) => {
        if (path === vault) return rootDirectory.directory;
        if (path === swapped) {
          childOpened = true;
          return replacedDirectory.directory;
        }
        return opendir(path);
      }) as typeof opendir,
      lstat: (async (path: string, options?: { bigint?: boolean }) => {
        if (path === swapped && childOpened) return symlinkStat;
        return options?.bigint === true ? lstat(path, { bigint: true }) : lstat(path);
      }) as typeof lstat,
    });

    const scan = await repository.scan();

    expect(scan.notes.map((note) => [note.relativePath, note.content])).toEqual([["safe.md", "safe"]]);
    expect(replacedDirectory.iterate).not.toHaveBeenCalled();
    expect(replacedDirectory.close).toHaveBeenCalledTimes(1);
  });

  it("rejects content opened through a file symlink replacement race while returning another note", async () => {
    const vault = await makeVault();
    const racedPath = join(vault, "raced.md");
    await writeFile(racedPath, "safe");
    await writeFile(join(vault, "other.md"), "other");
    const originalStat = await stat(racedPath);
    const outsideBytes = Buffer.from("outside secret");
    let replaced = false;
    const racedHandle = {
      stat: vi.fn(async () => originalStat),
      readFile: vi.fn(async () => outsideBytes),
      close: vi.fn(async () => undefined),
    } as unknown as FileHandle;
    const symlinkStat = Object.create(originalStat) as typeof originalStat;
    symlinkStat.isSymbolicLink = () => true;

    const repository = new ObsidianVaultRepository(vault, {
      open: (async (path: string, flags: number) => {
        if (path === racedPath) {
          replaced = true;
          return racedHandle;
        }
        return open(path, flags);
      }) as typeof open,
      lstat: (async (path: string, options?: { bigint?: boolean }) => {
        if (path === racedPath && replaced) return symlinkStat;
        return options?.bigint === true ? lstat(path, { bigint: true }) : lstat(path);
      }) as typeof lstat,
      realpath: (async (path: string) => path === racedPath && replaced ? join(vault, "..", "outside.md") : realpath(path)) as typeof realpath,
    });

    const scan = await repository.scan();

    expect(scan.notes.map((note) => [note.relativePath, note.content])).toEqual([["other.md", "other"]]);
    expect(scan.diagnostics).toContainEqual({ relativePath: "raced.md", reason: "Unable to read Markdown note" });
    expect(JSON.stringify(scan)).not.toContain(vault);
    expect(racedHandle.close).toHaveBeenCalledTimes(1);
  });

  it("rejects descriptor identity differences above Number.MAX_SAFE_INTEGER", async () => {
    const vault = await makeVault();
    const notePath = join(vault, "identity.md");
    await writeFile(notePath, "safe");
    const actualStat = await stat(notePath, { bigint: true });
    const actualNumberStat = await stat(notePath);
    const pathStat = Object.create(actualStat) as typeof actualStat;
    const descriptorStat = Object.create(actualStat) as typeof actualStat;
    const pathNumberStat = Object.create(actualNumberStat) as typeof actualNumberStat;
    const descriptorNumberStat = Object.create(actualNumberStat) as typeof actualNumberStat;
    const pathDevice = 9_007_199_254_740_992n;
    const descriptorDevice = 9_007_199_254_740_993n;
    Object.defineProperty(pathStat, "dev", { value: pathDevice });
    Object.defineProperty(descriptorStat, "dev", { value: descriptorDevice });
    Object.defineProperty(pathNumberStat, "dev", { value: Number(pathDevice) });
    Object.defineProperty(descriptorNumberStat, "dev", { value: Number(descriptorDevice) });
    expect(Number(pathDevice)).toBe(Number(descriptorDevice));
    const read = vi.fn();
    const handle = {
      stat: vi.fn(async (options?: { bigint?: boolean }) => {
        return options?.bigint === true ? descriptorStat : descriptorNumberStat;
      }),
      read,
      close: vi.fn(async () => undefined),
    } as unknown as FileHandle;
    let opened = false;
    const repository = new ObsidianVaultRepository(vault, {
      open: (async (path: string, flags: number) => {
        if (path === notePath) {
          opened = true;
          return handle;
        }
        return open(path, flags);
      }) as typeof open,
      lstat: (async (path: string, options?: { bigint?: boolean }) => {
        if (path === notePath && opened) return options?.bigint === true ? pathStat : pathNumberStat;
        return options?.bigint === true ? lstat(path, { bigint: true }) : lstat(path);
      }) as typeof lstat,
    });

    const scan = await repository.scan();

    expect(scan.notes).toEqual([]);
    expect(scan.diagnostics).toEqual([{ relativePath: "identity.md", reason: "Unable to read Markdown note" }]);
    expect(read).not.toHaveBeenCalled();
    expect(handle.stat).toHaveBeenCalledWith({ bigint: true });
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("reports an unreadable Markdown file generically and still returns another note", async () => {
    const vault = await makeVault();
    const unreadable = join(vault, "unreadable.md");
    await writeFile(unreadable, "unreadable");
    await writeFile(join(vault, "kept.md"), "kept");
    const repository = new ObsidianVaultRepository(vault, {
      open: (async (path: string, flags: number) => {
        if (path === unreadable) throw new Error(`EACCES: ${path}`);
        return open(path, flags);
      }) as typeof open,
    });

    const scan = await repository.scan();

    expect(scan.notes.map((note) => note.relativePath)).toEqual(["kept.md"]);
    expect(scan.diagnostics).toContainEqual({ relativePath: "unreadable.md", reason: "Unable to read Markdown note" });
    expect(JSON.stringify(scan.diagnostics)).not.toContain(vault);
  });

  it("reports a disappearing Markdown file generically and still returns another note", async () => {
    const vault = await makeVault();
    const disappearing = join(vault, "disappearing.md");
    await writeFile(disappearing, "gone");
    await writeFile(join(vault, "kept.md"), "kept");
    const repository = new ObsidianVaultRepository(vault, {
      open: (async (path: string, flags: number) => {
        if (path === disappearing) throw new Error(`ENOENT: ${path}`);
        return open(path, flags);
      }) as typeof open,
    });

    const scan = await repository.scan();

    expect(scan.notes.map((note) => note.relativePath)).toEqual(["kept.md"]);
    expect(scan.diagnostics).toContainEqual({ relativePath: "disappearing.md", reason: "Unable to read Markdown note" });
    expect(JSON.stringify(scan.diagnostics)).not.toContain(vault);
  });

  it("reports an unreadable directory generically and continues scanning sibling directories", async () => {
    const vault = await makeVault();
    const unreadable = join(vault, "unreadable");
    await mkdir(unreadable);
    await mkdir(join(vault, "kept"));
    await writeFile(join(vault, "kept", "note.md"), "kept");
    const repository = new ObsidianVaultRepository(vault, {
      opendir: (async (path: string) => {
        if (path === unreadable) throw new Error(`EACCES: ${path}`);
        return opendir(path);
      }) as typeof opendir,
    });

    const scan = await repository.scan();

    expect(scan.notes.map((note) => note.relativePath)).toEqual(["kept/note.md"]);
    // Named by itself, a folder in the vault: named by its parent (the root, so none), nothing deleted anywhere in
    // the vault was pruned while it stayed locked.
    expect(scan.diagnostics).toContainEqual({ relativePath: "unreadable", reason: "Unable to read directory" });
    expect(JSON.stringify(scan.diagnostics)).not.toContain(vault);
  });

  it("names an unreadable nested folder by itself, not by the folder holding it", async () => {
    const vault = await makeVault();
    const locked = join(vault, "Projects", "Locked");
    await mkdir(locked, { recursive: true });
    await writeFile(join(vault, "Projects", "note.md"), "note");
    const repository = new ObsidianVaultRepository(vault, {
      opendir: (async (path: string) => {
        if (path === locked) throw new Error(`EACCES: ${path}`);
        return opendir(path);
      }) as typeof opendir,
    });

    const scan = await repository.scan();

    // Named "Projects", every note deleted beside it stayed indexed while it stayed locked.
    expect(scan.diagnostics).toEqual([{ relativePath: "Projects/Locked", reason: "Unable to read directory" }]);
  });

  it("passes over a note at the vault's top that is gone by the time it is read, without making the scan unknown", async () => {
    const vault = await makeVault();
    await writeFile(join(vault, "kept.md"), "kept");
    await writeFile(join(vault, "racing.md"), "racing");
    const repository = new ObsidianVaultRepository(vault, {
      lstat: (async (path: string, options?: object) => {
        // Listed, then removed (a delete, a sync client's replace) before it is checked.
        if (path === join(vault, "racing.md")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return lstat(path, options as never);
      }) as typeof lstat,
    });

    const scan = await repository.scan();

    expect(scan.notes.map((note) => note.relativePath)).toEqual(["kept.md"]);
    // Said with no folder to name (its parent is the root), it made the whole scan unknown: nothing was pruned.
    expect(scan.diagnostics).toEqual([]);
  });

  it("reports a disappearing directory generically and continues scanning sibling directories", async () => {
    const vault = await makeVault();
    const disappearing = join(vault, "disappearing");
    await mkdir(disappearing);
    await mkdir(join(vault, "kept"));
    await writeFile(join(vault, "kept", "note.md"), "kept");
    const repository = new ObsidianVaultRepository(vault, {
      opendir: (async (path: string) => {
        if (path === disappearing) {
          // Gone between the listing and the open: no longer a folder in the vault to name.
          await rm(disappearing, { recursive: true });
          throw new Error(`ENOENT: ${path}`);
        }
        return opendir(path);
      }) as typeof opendir,
    });

    const scan = await repository.scan();

    expect(scan.notes.map((note) => note.relativePath)).toEqual(["kept/note.md"]);
    expect(scan.diagnostics).toContainEqual({ relativePath: null, reason: "Unable to read directory" });
    expect(JSON.stringify(scan.diagnostics)).not.toContain(vault);
  });

  it("says a note iCloud moved off this Mac is there, not read, rather than passing its placeholder over", async () => {
    const vault = await makeVault();
    await mkdir(join(vault, "Projects"));
    await writeFile(join(vault, "Projects", "kept.md"), "kept");
    // "Optimize Mac Storage": the note's file replaced by its placeholder.
    await writeFile(join(vault, "Projects", ".plan.md.icloud"), "");
    await writeFile(join(vault, ".top.md.icloud"), "");
    await mkdir(join(vault, ".trash"));
    await writeFile(join(vault, ".trash", ".old.md.icloud"), "");

    const scan = await new ObsidianVaultRepository(vault).scan();

    expect(scan.notes.map((note) => note.relativePath)).toEqual(["Projects/kept.md"]);
    // Passed over as a hidden file, the note left the index and every search without a word.
    expect(scan.diagnostics).toEqual([
      { relativePath: "Projects/plan.md", reason: "Markdown note is in iCloud, not on this Mac" },
      { relativePath: "top.md", reason: "Markdown note is in iCloud, not on this Mac" },
    ]);
  });

  it("leaves out a note excluded in Obsidian when iCloud has moved it off this Mac too", async () => {
    const vault = await makeVault();
    await mkdir(join(vault, ".obsidian"));
    await writeFile(join(vault, ".obsidian", "app.json"), JSON.stringify({ userIgnoreFilters: ["Projects/草稿.md"] }));
    await mkdir(join(vault, "Projects"));
    await writeFile(join(vault, "Projects", ".草稿.md.icloud"), "");
    await writeFile(join(vault, "Projects", ".plan.md.icloud"), "");

    const scan = await new ObsidianVaultRepository(vault).scan();

    // Said before the filter was asked, the excluded draft was counted among the notes not indexed, and kept.
    expect(scan.diagnostics).toEqual([{ relativePath: "Projects/plan.md", reason: "Markdown note is in iCloud, not on this Mac" }]);
  });

  it("leaves out what the reader excluded in Obsidian, by the plain paths among its filters", async () => {
    const vault = await makeVault();
    await mkdir(join(vault, ".obsidian"));
    await writeFile(join(vault, ".obsidian", "app.json"), JSON.stringify({ userIgnoreFilters: ["Templates/", "Archive/Old/", "/草稿/"] }));
    for (const path of ["Templates/会议模板.md", "Archive/Old/旧方案.md", "Archive/现行.md", "Projects/上线.md", "草稿.md"]) {
      await mkdir(join(vault, ...path.split("/").slice(0, -1)), { recursive: true });
      await writeFile(join(vault, ...path.split("/")), "回滚预案");
    }

    const scan = await new ObsidianVaultRepository(vault).scan();

    // Read past, the excluded template and archive came back in every search; a regular expression is not followed.
    expect(scan.notes.map((note) => note.relativePath)).toEqual(["Archive/现行.md", "Projects/上线.md", "草稿.md"]);
    expect(scan.diagnostics).toEqual([]);
  });

  it("skips socket directory entries", async () => {
    const vault = await makeVault();
    const rootDirectory = fakeDir([fakeDirent("socket.md", "socket")]);
    const repository = new ObsidianVaultRepository(vault, {
      opendir: (async (path: string) => path === vault ? rootDirectory.directory : opendir(path)) as typeof opendir,
    });

    const scan = await repository.scan();

    expect(scan).toEqual({ notes: [], diagnostics: [] });
    expect(rootDirectory.close).toHaveBeenCalledTimes(1);
  });

  it("skips device directory entries", async () => {
    const vault = await makeVault();
    const rootDirectory = fakeDir([fakeDirent("device.md", "device")]);
    const repository = new ObsidianVaultRepository(vault, {
      opendir: (async (path: string) => path === vault ? rootDirectory.directory : opendir(path)) as typeof opendir,
    });

    const scan = await repository.scan();

    expect(scan).toEqual({ notes: [], diagnostics: [] });
    expect(rootDirectory.close).toHaveBeenCalledTimes(1);
  });

  it("uses O_NOFOLLOW when the platform exposes it", async () => {
    const vault = await makeVault();
    const notePath = join(vault, "note.md");
    await writeFile(notePath, "note");
    let openedFlags: number | undefined;
    const repository = new ObsidianVaultRepository(vault, {
      open: (async (path: string, flags: number) => {
        openedFlags = flags;
        return open(path, flags);
      }) as typeof open,
    });

    const scan = await repository.scan();

    expect(scan.notes.map((note) => note.relativePath)).toEqual(["note.md"]);
    expect(openedFlags).toBe(constants.O_RDONLY | constants.O_NOFOLLOW);
  });

  it("validates every component and rejects a post-open replacement without O_NOFOLLOW", async () => {
    const vault = await makeVault();
    const directory = join(vault, "nested");
    const notePath = join(directory, "note.md");
    await mkdir(directory);
    await writeFile(notePath, "safe");
    const originalStat = await stat(notePath);
    const symlinkStat = Object.create(originalStat) as typeof originalStat;
    symlinkStat.isSymbolicLink = () => true;
    const events: string[] = [];
    let opened = false;
    const repository = new ObsidianVaultRepository(vault, {
      noFollowFlag: undefined,
      lstat: (async (path: string) => {
        events.push(`lstat:${path}`);
        if (path === notePath && opened) return symlinkStat;
        return lstat(path);
      }) as typeof lstat,
      open: (async (path: string, flags: number) => {
        events.push(`open:${path}:${flags}`);
        opened = true;
        return open(path, constants.O_RDONLY);
      }) as typeof open,
    });

    const scan = await repository.scan();

    const openIndex = events.findIndex((event) => event.startsWith(`open:${notePath}:`));
    // The root is checked as what it leads to: a vault reached through a link is still a directory.
    const realVault = await realpath(vault);
    expect(events.slice(0, openIndex).filter((event) => event === `lstat:${realVault}`)).toHaveLength(2);
    expect(events.indexOf(`lstat:${directory}`)).toBeLessThan(openIndex);
    expect(events.indexOf(`lstat:${notePath}`)).toBeLessThan(openIndex);
    expect(events.slice(openIndex + 1)).toContain(`lstat:${notePath}`);
    expect(events[openIndex]).toBe(`open:${notePath}:${constants.O_RDONLY}`);
    expect(scan.notes).toEqual([]);
    expect(scan.diagnostics).toContainEqual({ relativePath: "nested/note.md", reason: "Unable to read Markdown note" });
  });

  it("accepts a Markdown note exactly 5 MiB long", async () => {
    const vault = await makeVault();
    const notePath = join(vault, "limit.md");
    await writeFile(notePath, "fixture");
    const originalStat = await stat(notePath, { bigint: true });
    const limitStat = Object.create(originalStat) as typeof originalStat;
    Object.defineProperty(limitStat, "size", { value: BigInt(5 * 1024 * 1024) });
    const bytes = Buffer.alloc(5 * 1024 * 1024, 0x61);
    let readOffset = 0;
    const handle = {
      stat: vi.fn(async () => limitStat),
      read: vi.fn(async (buffer: Buffer, offset: number, length: number) => {
        const count = Math.min(length, bytes.byteLength - readOffset);
        if (count > 0) bytes.copy(buffer, offset, readOffset, readOffset + count);
        readOffset += count;
        return { bytesRead: count, buffer };
      }),
      close: vi.fn(async () => undefined),
    } as unknown as FileHandle;
    const repository = new ObsidianVaultRepository(vault, {
      open: (async (path: string, flags: number) => path === notePath ? handle : open(path, flags)) as typeof open,
    });

    const scan = await repository.scan();

    expect(scan.notes).toHaveLength(1);
    expect(scan.notes[0]).toMatchObject({ relativePath: "limit.md", size: 5 * 1024 * 1024 });
    expect(scan.notes[0]?.content).toHaveLength(5 * 1024 * 1024);
    expect(scan.diagnostics).toEqual([]);
  });

  it("bounds reads to 5 MiB plus 1 byte and rejects a note that grows during reading", async () => {
    const vault = await makeVault();
    const notePath = join(vault, "growing.md");
    await writeFile(notePath, "seed");
    const initialStat = await stat(notePath, { bigint: true });
    const grownStat = Object.create(initialStat) as typeof initialStat;
    Object.defineProperties(grownStat, {
      size: { value: BigInt(5 * 1024 * 1024 + 2) },
      mtimeNs: { value: initialStat.mtimeNs + 1n },
    });
    const readRequests: Array<{ bufferLength: number; requestedLength: number }> = [];
    let statCalls = 0;
    const handle = {
      stat: vi.fn(async (options: { bigint: true }) => {
        expect(options).toEqual({ bigint: true });
        statCalls += 1;
        return statCalls === 1 ? initialStat : grownStat;
      }),
      read: vi.fn(async (buffer: Buffer, _offset: number, length: number) => {
        readRequests.push({ bufferLength: buffer.byteLength, requestedLength: length });
        buffer.fill(0x61, 0, length);
        return { bytesRead: length, buffer };
      }),
      close: vi.fn(async () => undefined),
    } as unknown as FileHandle;
    const repository = new ObsidianVaultRepository(vault, {
      open: (async (path: string, flags: number) => path === notePath ? handle : open(path, flags)) as typeof open,
    });

    const scan = await repository.scan();

    expect(readRequests.length).toBeGreaterThan(0);
    expect(Math.max(...readRequests.map((request) => request.bufferLength))).toBeLessThanOrEqual(64 * 1024);
    expect(Math.max(...readRequests.map((request) => request.requestedLength))).toBeLessThanOrEqual(64 * 1024);
    expect(readRequests.reduce((total, request) => total + request.requestedLength, 0)).toBe(5 * 1024 * 1024 + 1);
    expect(scan.notes).toEqual([]);
    expect(scan.diagnostics).toEqual([{ relativePath: "growing.md", reason: "Unable to read Markdown note" }]);
    expect(JSON.stringify(scan)).not.toContain("aaaa");
    expect(handle.stat).toHaveBeenCalledTimes(2);
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("rejects a Markdown note 1 byte over 5 MiB without reading it", async () => {
    const vault = await makeVault();
    const notePath = join(vault, "over-limit.md");
    await writeFile(notePath, "fixture");
    const originalStat = await stat(notePath, { bigint: true });
    const overLimitStat = Object.create(originalStat) as typeof originalStat;
    Object.defineProperty(overLimitStat, "size", { value: BigInt(5 * 1024 * 1024 + 1) });
    const read = vi.fn();
    const handle = {
      stat: vi.fn(async () => overLimitStat),
      read,
      close: vi.fn(async () => undefined),
    } as unknown as FileHandle;
    const repository = new ObsidianVaultRepository(vault, {
      open: (async (path: string, flags: number) => path === notePath ? handle : open(path, flags)) as typeof open,
    });

    const scan = await repository.scan();

    expect(scan.notes).toEqual([]);
    expect(scan.diagnostics).toEqual([{ relativePath: "over-limit.md", reason: "Markdown note exceeds 5 MiB" }]);
    expect(read).not.toHaveBeenCalled();
  });

  it.skipIf(!symlinkSupported)("resolver rejects a final symlink without exposing the vault path", async () => {
    const vault = await makeVault();
    await writeFile(join(vault, "target.md"), "target");
    await symlink(join(vault, "target.md"), join(vault, "linked.md"));

    await expectResolveFailureWithoutVaultPath(new ObsidianVaultRepository(vault), "linked.md", vault);
  });

  it.skipIf(!symlinkSupported)("resolver rejects an intermediate in-vault symlink without exposing the vault path", async () => {
    const vault = await makeVault();
    await mkdir(join(vault, "notes"));
    await writeFile(join(vault, "notes", "target.md"), "target");
    await symlink(join(vault, "notes"), join(vault, "alias"));

    await expectResolveFailureWithoutVaultPath(new ObsidianVaultRepository(vault), "alias/target.md", vault);
  });

  it.skipIf(!symlinkSupported)("resolver rejects an intermediate external symlink without exposing the vault path", async () => {
    const vault = await makeVault();
    const outside = await makeTemporaryRoot("outside-");
    await writeFile(join(outside, "target.md"), "outside");
    await symlink(outside, join(vault, "outside"));

    await expectResolveFailureWithoutVaultPath(new ObsidianVaultRepository(vault), "outside/target.md", vault);
  });

  it("resolver rejects a current nonregular target without exposing the vault path", async () => {
    const vault = await makeVault();
    await mkdir(join(vault, "directory.md"));

    await expectResolveFailureWithoutVaultPath(new ObsidianVaultRepository(vault), "directory.md", vault);
  });
});

describe("ObsidianVaultWatcher", () => {
  it.runIf(process.platform === "darwin")("watches the vault with one handle and hears a note written in it", async () => {
    const vault = await makeVault();
    await mkdir(join(vault, "日志"));
    const onChange = vi.fn();
    const onError = vi.fn();
    // Not chokidar here: it held a descriptor for every note, and a large vault ran the process out of them.
    const watcher = new ObsidianVaultWatcher(vault, onChange, onError);
    watcher.start();
    try {
      // The event stream starts a moment after the watch does (at launch, the first sync covers that moment).
      await new Promise((resolve) => setTimeout(resolve, 300));
      await writeFile(join(vault, "日志", "周报.md"), "# 周报");
      await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 5_000, interval: 20 });
      expect(onError).not.toHaveBeenCalled();
    } finally {
      await watcher.close();
    }
  });

  it.runIf(process.platform === "darwin")("hears a folder of notes renamed though its name has a dot in it", async () => {
    const vault = await makeVault();
    await mkdir(join(vault, "项目 v1.2"));
    await writeFile(join(vault, "项目 v1.2", "决定.md"), "# 决定");
    const onChange = vi.fn();
    const watcher = new ObsidianVaultWatcher(vault, onChange, vi.fn());
    watcher.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      // Only the folder is reported: its notes move with it unannounced.
      await rename(join(vault, "项目 v1.2"), join(vault, "项目 v1.3"));
      await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 5_000, interval: 20 });
    } finally {
      await watcher.close();
    }
  });

  it.runIf(process.platform === "darwin")("does not hear the app's own writes into its Decision Journal", async () => {
    const vault = await makeVault();
    await mkdir(join(vault, "Decision Journal", "decisions"), { recursive: true });
    await mkdir(join(vault, "日志"));
    const onChange = vi.fn();
    const watcher = new ObsidianVaultWatcher(vault, onChange, vi.fn());
    watcher.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      onChange.mockClear();
      // A capture saved: the note index read the whole vault again, for notes it never keeps.
      await writeFile(join(vault, "Decision Journal", "decisions", "决策.md"), "# 决策");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(onChange).not.toHaveBeenCalled();
      // A note of the reader's is heard as before.
      await writeFile(join(vault, "日志", "周报.md"), "# 周报");
      await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 5_000, interval: 20 });
    } finally {
      await watcher.close();
    }
  });

  it("ignores documented directory names case-insensitively in callbacks and events", async () => {
    type Handler = (...args: unknown[]) => void;
    const handlers = new Map<string, Handler>();
    const fake = {
      on(event: string, handler: Handler) { handlers.set(event, handler); return this; },
      close: vi.fn(async () => undefined),
    };
    let ignored: ((path: unknown, stats?: { isFile(): boolean }) => boolean) | undefined;
    const watch = vi.fn((_path: string, options: { ignored?: typeof ignored }) => {
      ignored = options.ignored;
      return fake;
    });
    const onChange = vi.fn();
    const watcher = new ObsidianVaultWatcher("/vault", onChange, vi.fn(), { watch });
    watcher.start();

    // And the app's own folder, whose every write had the whole vault read again.
    for (const excluded of [".GIT", ".Obsidian", ".TRASH", ".Hg", ".SVN", "Node_Modules", "Decision Journal", "decision journal"]) {
      expect(ignored?.(`/vault/${excluded}`, { isFile: () => false })).toBe(true);
      handlers.get("add")?.(`/vault/${excluded}/ignored.md`);
    }
    expect(onChange).not.toHaveBeenCalled();
    // Only the vault's: a folder of the reader's by that name deeper down is notes like any other.
    expect(ignored?.("/vault/知识/Decision Journal", { isFile: () => false })).toBe(false);
    handlers.get("add")?.("/vault/知识/Decision Journal/摘抄.md");
    expect(onChange).toHaveBeenCalledTimes(1);
    await watcher.close();
  });

  it("is idempotent, filters events, reports errors, and closes idempotently", async () => {
    type Handler = (...args: unknown[]) => void;
    const handlers = new Map<string, Handler>();
    const fake = {
      on(event: string, handler: Handler) { handlers.set(event, handler); return this; },
      close: vi.fn(async () => undefined),
    };
    let ignored: ((path: unknown, stats?: { isFile(): boolean }) => boolean) | undefined;
    const watch = vi.fn((_path: string, options: { ignored?: typeof ignored }) => { ignored = options.ignored; return fake; });
    const onChange = vi.fn();
    const onError = vi.fn();
    const watcher = new ObsidianVaultWatcher("/vault", onChange, onError, { watch });
    watcher.start();
    watcher.start();
    expect(watch).toHaveBeenCalledTimes(1);
    const options = watch.mock.calls[0]?.[1];
    expect(options).toMatchObject({ ignoreInitial: true, followSymlinks: false, awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 } });
    expect(ignored?.("/vault", { isFile: () => false })).toBe(false);
    expect(ignored?.("/vault/ordinary", { isFile: () => false })).toBe(false);
    expect(ignored?.("/vault/.git", { isFile: () => false })).toBe(true);
    expect(ignored?.("/vault/note.md", { isFile: () => true })).toBe(false);
    expect(ignored?.("/vault/note.txt", { isFile: () => true })).toBe(true);
    expect(ignored?.("/vault/ordinary")).toBe(false);
    handlers.get("add")?.("/vault/note.md");
    handlers.get("unlink")?.("/vault/removed.md");
    handlers.get("change")?.("/vault/changed.md");
    handlers.get("change")?.("/vault/.obsidian/config.md");
    handlers.get("change")?.("/vault/note.txt");
    handlers.get("error")?.(new Error("hidden detail"));
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith();
    await watcher.close();
    await watcher.close();
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it("rejects Windows different-drive paths from ignored callbacks and events", async () => {
    type Handler = (...args: unknown[]) => void;
    const handlers = new Map<string, Handler>();
    const fake = {
      on(event: string, handler: Handler) { handlers.set(event, handler); return this; },
      close: vi.fn(async () => undefined),
    };
    let ignored: ((path: unknown, stats?: { isFile(): boolean }) => boolean) | undefined;
    const watch = vi.fn((_path: string, options: { ignored?: typeof ignored }) => {
      ignored = options.ignored;
      return fake;
    });
    const onChange = vi.fn();
    const watcher = new ObsidianVaultWatcher("/vault", onChange, vi.fn(), {
      watch,
      relative: () => "D:\\outside\\note.md",
    });
    watcher.start();

    expect(ignored?.("/vault/note.md", { isFile: () => true })).toBe(true);
    handlers.get("add")?.("/vault/note.md");
    expect(onChange).not.toHaveBeenCalled();
    await watcher.close();
  });
});
