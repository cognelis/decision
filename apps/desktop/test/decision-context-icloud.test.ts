import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decisionContextQuerySchema } from "@cognelis/decision-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { DecisionContextRepository, mayBeSetAside } from "@cognelis/decision-storage";
import { DecisionContextService } from "../src/main/decision-context-service.js";

const roots: string[] = [];
const makeVault = async () => {
  const root = await mkdtemp(join(tmpdir(), "r34c-icloud-"));
  roots.push(root);
  await mkdir(join(root, "Decision Journal", "summarize"), { recursive: true });
  return root;
};
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const legacy = (id: string) => [
  "---", `id: ${id}`, "created: 2026-09-01", "status: accepted", "selected_option: 列表使用稳定业务标识。", "project: web", "---",
  "# 列表标识", "", "列表使用稳定业务标识。", "",
].join("\n");

// iCloud "Optimize Mac Storage" leaves `.B.md.icloud` where B.md was. The whole-vault walk reports it as a note not
// read; the folder walk the context scan uses drops it as a hidden file, so the decision is missing and coverage
// is "complete".
describe("context scan over a folder with an iCloud-evicted decision note", () => {
  it("counts the evicted note as not read instead of reporting complete coverage", async () => {
    const vault = await makeVault();
    const folder = join(vault, "Decision Journal/summarize");
    await writeFile(join(folder, "A.md"), legacy("DEC-A"));
    await writeFile(join(folder, ".B.md.icloud"), "bplist00placeholder");

    const repository = new DecisionContextRepository(vault);
    const snapshot = await repository.scan();
    expect(snapshot.documents.map((doc) => doc.id)).toEqual(["DEC-A"]);
    expect(snapshot.sources[0]!.skipped).toBeGreaterThan(0);

    const response = await new DecisionContextService(repository).search(decisionContextQuerySchema.parse({ query: "支付凭证加密" }));
    expect(response.coverage).not.toBe("complete");
  });

  it("doubts only the decision an evicted note's file name names, not every record of the source", async () => {
    const vault = await makeVault();
    const folder = join(vault, "Decision Journal/decisions");
    await mkdir(folder, { recursive: true });
    // A decision note's name ends in its id's hash, as the app writes it: …-dec-b-<sha256(id)[0, 8]>.md.
    const hash = createHash("sha256").update("DEC-B", "utf8").digest("hex").slice(0, 8);
    await writeFile(join(folder, `.20260901T000000000Z-缓存方案-dec-b-${hash}.md.icloud`), "bplist00placeholder");
    await writeFile(join(vault, "Decision Journal/summarize", ".C.md.icloud"), "bplist00placeholder");
    const snapshot = await new DecisionContextRepository(vault).scan();
    // Every relation and feedback on the source was refused while one old decision was in iCloud.
    expect(mayBeSetAside(snapshot, "decisions", "DEC-B")).toBe(true);
    expect(mayBeSetAside(snapshot, "decisions", "DEC-A")).toBe(false);
    // A legacy note's name says nothing of its record: any of them may be it.
    expect(mayBeSetAside(snapshot, "summarize", "DEC-A")).toBe(true);
  });

  it("doubts every decision when the evicted note's name is not one the app wrote", async () => {
    const vault = await makeVault();
    const folder = join(vault, "Decision Journal/decisions");
    await mkdir(folder, { recursive: true });
    // Renamed in Obsidian to end in a date, which reads as eight hex digits.
    await writeFile(join(folder, ".缓存方案-20260912.md.icloud"), "bplist00placeholder");
    const snapshot = await new DecisionContextRepository(vault).scan();
    expect(mayBeSetAside(snapshot, "decisions", "DEC-A")).toBe(true);
  });

  // A symlinked folder is reported as an unavailable source (existing test); a symlinked note in the folder is
  // passed over without a word, and the search says it covered everything.
  it("counts a symlinked note it refuses to read, as it does a symlinked folder", async (context) => {
    const vault = await makeVault();
    const folder = join(vault, "Decision Journal/summarize");
    await writeFile(join(folder, "A.md"), legacy("DEC-A"));
    const elsewhere = join(vault, "elsewhere.md");
    await writeFile(elsewhere, legacy("DEC-LINKED"));
    try { await symlink(elsewhere, join(folder, "Linked.md"), "file"); }
    catch (error) {
      if (error !== null && typeof error === "object" && "code" in error && ["EPERM", "EACCES"].includes(String(error.code))) { context.skip(); return; }
      throw error;
    }
    const snapshot = await new DecisionContextRepository(vault).scan();
    expect(snapshot.documents.map((doc) => doc.id)).toEqual(["DEC-A"]);
    expect(snapshot.sources[0]!.skipped).toBeGreaterThan(0);
  });
});
