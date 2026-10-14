import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";

import { replaceNote } from "../src/note-rewrite.js";
import { renameReplacing } from "../src/replace-file.js";

it("refuses to write a note over one changed since it was read, and leaves no temporary file behind", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "replace-note-")), "note.md");
  await replaceNote(path, null, "---\nid: one\n---\n# 标题\n");
  const raw = await readFile(path, "utf8");
  // Saved in Obsidian between the app's read and its write: a line the reader had just added.
  const edited = `${raw}\n读者刚加的一句话。\n`;
  await writeFile(path, edited, "utf8");

  await expect(replaceNote(path, raw, `${raw}\nstatus: accepted\n`)).rejects.toThrow("刚在 Obsidian 里被改过");
  expect(await readFile(path, "utf8")).toBe(edited);
  expect((await readdir(dirname(path))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  // Read again, the write goes through.
  await replaceNote(path, edited, "---\nid: one\n---\n# 新标题\n");
  expect(await readFile(path, "utf8")).toBe("---\nid: one\n---\n# 新标题\n");
});

it("says a file already in a new note's place is not one just saved in Obsidian, and leaves it", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "replace-note-in-the-way-")), "note.md");
  // A file the app could not read as a note (found by neither id nor fingerprint) under the name a new note gets.
  await writeFile(path, "not a note\n", "utf8");
  // Said as just changed, with "open it again" that never helped.
  await expect(replaceNote(path, null, "---\nid: one\n---\n# 标题\n")).rejects.toThrow("已有一篇 App 读不出的笔记");
  expect(await readFile(path, "utf8")).toBe("not a note\n");
  expect((await readdir(dirname(path))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

const failing = (codes: Array<string | null>) => {
  const attempts: number[] = [];
  return {
    attempts,
    renameFile: async () => {
      attempts.push(attempts.length);
      const code = codes[attempts.length - 1];
      if (code !== null && code !== undefined) throw Object.assign(new Error(code), { code });
    },
  };
};

it("waits out a file held open on Windows, and gives up on one held for good", async () => {
  const waits: number[] = [];
  const wait = async (milliseconds: number) => {
    waits.push(milliseconds);
  };
  // Read by an antivirus scan, a sync client or the bridge for a moment: the save failed, or the app would not start.
  const held = failing(["EBUSY", "EPERM", null]);
  await renameReplacing("from", "to", { platform: "win32", renameFile: held.renameFile, wait });
  expect(held.attempts).toHaveLength(3);
  expect(waits).toEqual([50, 100]);

  const forGood = failing(Array(10).fill("EACCES"));
  await expect(renameReplacing("from", "to", { platform: "win32", renameFile: forGood.renameFile, wait })).rejects.toThrow("EACCES");
  expect(forGood.attempts).toHaveLength(6);

  // What the caller confirmed before writing is confirmed again before each retry, and a change stops it:
  // an edit saved in Obsidian while it waited was otherwise written over without a word.
  const checked: number[] = [];
  const changed = failing(["EBUSY", "EBUSY", null]);
  const beforeRetry = async () => {
    checked.push(changed.attempts.length);
    if (checked.length === 2) throw new Error("source_changed");
  };
  await expect(renameReplacing("from", "to", { platform: "win32", renameFile: changed.renameFile, wait, beforeRetry })).rejects.toThrow("source_changed");
  expect([checked, changed.attempts.length]).toEqual([[1, 2], 2]);

  // Elsewhere, and for any other failure, it is what it says at once.
  const elsewhere = failing(["EBUSY"]);
  await expect(renameReplacing("from", "to", { platform: "darwin", renameFile: elsewhere.renameFile, wait })).rejects.toThrow("EBUSY");
  const missing = failing(["ENOENT"]);
  await expect(renameReplacing("from", "to", { platform: "win32", renameFile: missing.renameFile, wait })).rejects.toThrow("ENOENT");
  expect([elsewhere.attempts, missing.attempts]).toEqual([[0], [0]]);
});
