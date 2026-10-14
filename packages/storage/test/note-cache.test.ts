import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { NoteCache } from "../src/note-cache.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("reads a note again after a read that failed, rather than keeping the failure as the file's", async () => {
  const root = await mkdtemp(join(tmpdir(), "note-cache-"));
  roots.push(root);
  const note = join(root, "note.md");
  await writeFile(note, "kept");
  const settled = new Date(Date.now() - 60_000);
  await utimes(note, settled, settled);
  const cache = new NoteCache<string>(undefined, (value) => value !== "busy");
  let attempts = 0;
  // Held open by a sync client the first time: kept, the note read as unreadable until the app restarted.
  const read = () => cache.read(note, async () => ((attempts += 1) === 1 ? "busy" : "kept"));

  expect(await read()).toBe("busy");
  expect(await read()).toBe("kept");
  expect(await read()).toBe("kept");
  expect(attempts).toBe(2);
});

it("forgets a note no listing met lately, whether or not the listings ran to the end", async () => {
  const root = await mkdtemp(join(tmpdir(), "note-cache-"));
  roots.push(root);
  const note = join(root, "note.md");
  await writeFile(note, "kept");
  const settled = new Date(Date.now() - 60_000);
  await utimes(note, settled, settled);
  const cache = new NoteCache<string>();
  let loads = 0;
  const read = () => cache.read(note, async () => {
    loads += 1;
    return "kept";
  });

  await read();
  // Listings cut short before reaching it (a cap, time run out) keep it a while: it may well still be there.
  cache.sweep();
  cache.sweep();
  cache.sweep();
  await read();
  expect(loads).toBe(1);
  // One no listing meets any more, deleted say, goes: its text stayed for good while none ran to the end.
  for (let listing = 0; listing < 4; listing += 1) cache.sweep();
  await read();
  expect(loads).toBe(2);
});
