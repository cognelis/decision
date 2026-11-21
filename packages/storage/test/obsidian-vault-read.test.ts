import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ObsidianVaultRepository } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("ObsidianVaultRepository.readVisibleNote", () => {
  it("reads only what the whole-vault walk would offer, by its own checks and without the index", async () => {
    const root = await mkdtemp(join(tmpdir(), "vault-read-"));
    roots.push(root);
    const vault = join(root, "vault");
    const write = async (path: string, content: string) => {
      await mkdir(join(vault, ...path.split("/").slice(0, -1)), { recursive: true });
      await writeFile(join(vault, ...path.split("/")), content);
    };
    await write("笔记/a.md", "visible\n");
    await write(".hidden/b.md", "hidden\n");
    await write("node_modules/c.md", "excluded\n");
    await write("Decision Journal/d.md", "own\n");
    await write("归档/e.md", "ignored\n");
    await write(".obsidian/app.json", JSON.stringify({ userIgnoreFilters: ["归档/"] }));
    await write("笔记/f.txt", "text\n");
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside", "g.md"), "outside\n");
    await symlink(join(root, "outside", "g.md"), join(vault, "笔记", "g.md"));
    await symlink(join(root, "outside"), join(vault, "linked"));
    const repository = new ObsidianVaultRepository(vault);

    expect(await repository.readVisibleNote("笔记/a.md")).toMatchObject({ relativePath: "笔记/a.md", content: "visible\n" });
    for (const path of [".hidden/b.md", "node_modules/c.md", "Decision Journal/d.md", "decision journal/d.md", "归档/e.md", "笔记/f.txt", "笔记/g.md", "linked/g.md",
      "../outside/g.md", join(root, "outside", "g.md"), "笔记//a.md", "./笔记/a.md", "笔记\\a.md", "笔记", "missing.md"]) {
      expect(await repository.readVisibleNote(path), path).toBeNull();
    }
  });

  it("excludes as Obsidian does: trimmed, without regard to case, an expression by a note's whole path, the walk and a read alike", async () => {
    const vault = await mkdtemp(join(tmpdir(), "vault-read-"));
    roots.push(vault);
    const paths = ["Archive/old.md", "notes/Draft-1.md", "private/a.md", "Secret/b.md", "keep/c.md", "skip.md"];
    for (const path of paths) {
      await mkdir(join(vault, ...path.split("/").slice(0, -1)), { recursive: true });
      await writeFile(join(vault, ...path.split("/")), "synthetic\n");
    }
    await mkdir(join(vault, ".obsidian"));
    // "/^private$/" names the folder, no note in it; "/\\/$/" no note ends in a slash; " archive/ " is a plain prefix.
    await writeFile(join(vault, ".obsidian", "app.json"), JSON.stringify({
      userIgnoreFilters: [" archive/ ", "/draft-\\d/", "/^private$/", "/\\/$/", "/^secret\\//", "  /SKIP\\.MD$/  ", "   "],
    }));
    const repository = new ObsidianVaultRepository(vault);
    const kept = ["keep/c.md", "private/a.md"];

    expect((await repository.scan()).notes.map((note) => note.relativePath)).toEqual(kept);
    for (const path of paths) expect(await repository.readVisibleNote(path) !== null, path).toBe(kept.includes(path));
  });

  it("reads past what a regular expression among the reader's filters excludes, read after read", async () => {
    const vault = await mkdtemp(join(tmpdir(), "vault-read-"));
    roots.push(vault);
    for (const path of ["private/secret.md", "notes/private.md", "notes/a.md"]) {
      await mkdir(join(vault, ...path.split("/").slice(0, -1)), { recursive: true });
      await writeFile(join(vault, ...path.split("/")), "synthetic\n");
    }
    await mkdir(join(vault, ".obsidian"));
    await writeFile(join(vault, ".obsidian", "app.json"), JSON.stringify({ userIgnoreFilters: ["/^private\\//", "/[/", "notes/a"] }));
    const repository = new ObsidianVaultRepository(vault);

    // Twice each: nothing kept from one read to the next changes what the next one sees.
    for (let round = 0; round < 2; round += 1) {
      expect(await repository.readVisibleNote("private/secret.md")).toBeNull();
      expect(await repository.readVisibleNote("notes/a.md")).toBeNull();
      expect(await repository.readVisibleNote("notes/private.md")).toMatchObject({ content: "synthetic\n" });
    }
  });
});
