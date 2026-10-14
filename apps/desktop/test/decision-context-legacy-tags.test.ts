import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DecisionContextRepository } from "@cognelis/decision-storage";

const roots: string[] = [];
const makeVault = async () => {
  const root = await mkdtemp(join(tmpdir(), "r34c-legacy-tags-"));
  roots.push(root);
  await mkdir(join(root, "Decision Journal", "summarize"), { recursive: true });
  return root;
};
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const legacy = (id: string, tagsLine: string) => [
  "---", `id: ${id}`, "created: 2026-09-01", "status: accepted", "selected_option: 列表使用稳定业务标识。", "project: web", tagsLine, "---",
  "# 列表标识", "", "列表使用稳定业务标识。", "",
].join("\n");

// The decisions reader (markdown.ts stringArray) reads a list property emptied in Obsidian (`tags:` -> null) or
// given as one value (`tags: react`) as none or that one, because "refused, the whole decision left every list".
// The legacy summarize schema has no such reading: the note is set aside and the source reported partial.
describe("legacy summarize note with an Obsidian-emptied or scalar tags property", () => {
  it("keeps the record when tags was emptied in the property editor", async () => {
    const vault = await makeVault();
    await writeFile(join(vault, "Decision Journal/summarize/A.md"), legacy("DEC-A", "tags:"));
    const snapshot = await new DecisionContextRepository(vault).scan();
    expect(snapshot.documents.map((doc) => doc.id)).toEqual(["DEC-A"]);
    expect(snapshot.sources[0]).toMatchObject({ status: "ready", skipped: 0 });
  });

  it("keeps the record when tags is one value", async () => {
    const vault = await makeVault();
    await writeFile(join(vault, "Decision Journal/summarize/B.md"), legacy("DEC-B", "tags: react"));
    const snapshot = await new DecisionContextRepository(vault).scan();
    expect(snapshot.documents.map((doc) => doc.id)).toEqual(["DEC-B"]);
    expect(snapshot.sources[0]).toMatchObject({ status: "ready", skipped: 0 });
  });
});
