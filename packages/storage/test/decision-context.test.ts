import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import { DecisionContextRepository, MarkdownRepository, mayBeSetAside, MethodologyRepository, ObsidianVaultRepository, parseDecisionContextNote } from "../src/index.js";
import { recordFixture } from "./fixtures.js";

const roots: string[] = [];
const makeVault = async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-context-storage-"));
  roots.push(root);
  await mkdir(join(root, "Decision Journal", "summarize"), { recursive: true });
  return root;
};
const legacy = (overrides: Record<string, unknown> = {}) => `---\n${stringify({
  id: "DEC-0001", created: "2026-09-01", status: "accepted", selected_option: "列表使用稳定业务标识。",
  project: "web", session_id: "session-example", source_client: "claude_code", tags: ["react"],
  supersedes: [], superseded_by: null, ...overrides,
})}---\n# 列表标识\n\n## 决策\n列表使用稳定业务标识。\n`;
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("DecisionContextRepository", () => {
  it("includes adopted principles as their own type and excludes unaccepted candidates", async () => {
    const vault = await makeVault();
    const repository = new MethodologyRepository(vault);
    const principle = {
      id: "principle-1", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
      origin: "decision_evidence" as const, status: "accepted" as const, confirmedAt: "2026-09-01T00:00:00.000Z",
      title: "先验证边界", principle: "先验证边界再扩大投入。", appliesWhen: "兼容性不明确时。", caution: "验证成本过高时重新评估。",
      evidenceSummary: "一次完整复盘。", sourceDecisionIds: ["decision-1"], confidence: "low" as const,
      generation: { requestId: "request", profileId: "test", provider: "test", model: "test" },
    };
    await repository.save(principle);
    await repository.save({ ...principle, id: "candidate-1", status: "candidate", confirmedAt: null });
    const snapshot = await new DecisionContextRepository(vault).scan();
    expect(snapshot.documents).toEqual([expect.objectContaining({ kind: "adopted_principle", id: "principle-1", appliesWhen: principle.appliesWhen })]);
    expect(snapshot.sources[2]).toMatchObject({ status: "ready", records: 1, skipped: 0 });
  });
  it("reads legacy metadata without promoting or rewriting facts, preserving scalar and array successors", async () => {
    const vault = await makeVault();
    const path = join(vault, "Decision Journal/summarize/DEC-0001-列表标识.md");
    const original = legacy({ supersedes: ["DEC-0000"], superseded_by: ["DEC-0002", "DEC-0003"] }).replaceAll("\n", "\r\n");
    await writeFile(path, original);
    const repository = new DecisionContextRepository(vault);
    const snapshot = await repository.scan();
    expect(snapshot.documents).toEqual([expect.objectContaining({
      id: "DEC-0001", kind: "historical_decision", project: "web", sessionId: "session-example",
      supersedes: ["DEC-0000"], supersededBy: ["DEC-0002", "DEC-0003"],
      relativePath: "Decision Journal/summarize/DEC-0001-列表标识.md",
    })]);
    const doc = snapshot.documents[0]!;
    expect(original.replaceAll("\r\n", "\n").split("\n")[doc.bodyStartLine - 1]).toBe("# 列表标识");
    expect(await readFile(path, "utf8")).toBe(original);
    expect(await readdir(join(vault, "Decision Journal"))).toEqual(["summarize"]);
    const note = { relativePath: "Decision Journal/summarize/old.md", content: legacy({ superseded_by: "DEC-0002" }), contentHash: "hash", size: 100, modifiedAtMs: 0 };
    expect(parseDecisionContextNote(note, "summarize")?.supersededBy).toEqual(["DEC-0002"]);
  });

  it("rebuilds from current files so edits, removals and app records are visible", async () => {
    const vault = await makeVault();
    const path = join(vault, "Decision Journal/summarize/DEC-0001.md");
    const repository = new DecisionContextRepository(vault);
    await writeFile(path, legacy());
    await new MarkdownRepository(vault).write(recordFixture());
    expect((await repository.scan()).documents.map((doc) => doc.kind).sort()).toEqual(["historical_decision", "recorded_decision"]);
    await writeFile(path, legacy({ selected_option: "改为固定顺序，记录例外。" }));
    expect((await repository.scan()).documents.find((doc) => doc.id === "DEC-0001")?.summary).toBe("改为固定顺序，记录例外。");
    await rm(path);
    expect((await repository.scan()).documents).toHaveLength(1);
  });

  it("reads through the vault it is given, the one the decisions' repository keeps its notes in", async () => {
    const root = await makeVault();
    const vault = new ObsidianVaultRepository(root);
    await new MarkdownRepository(root, { vault }).write(recordFixture());
    const iterate = vi.spyOn(vault, "iterateFolder");

    const snapshot = await new DecisionContextRepository(root, undefined, undefined, vault).scan();

    expect(snapshot.documents.map((doc) => doc.kind)).toEqual(["recorded_decision"]);
    expect(iterate).toHaveBeenCalledWith("Decision Journal/decisions", expect.anything());
  });

  it("reports invalid and duplicated records instead of silently returning a complete no-match", async () => {
    const vault = await makeVault();
    for (const file of ["one.md", "duplicate.md"]) await writeFile(join(vault, "Decision Journal/summarize", file), legacy());
    await writeFile(join(vault, "Decision Journal/summarize/broken.md"), "---\nid: [\n---\n");
    await writeFile(join(vault, "Decision Journal/summarize/valid.md"), legacy({ id: "DEC-0002" }));
    const snapshot = await new DecisionContextRepository(vault).scan();
    expect(snapshot.documents.map((doc) => doc.id)).toEqual(["DEC-0002"]);
    expect(snapshot.sources[0]).toMatchObject({ status: "partial", records: 1, skipped: 3 });
  });

  it("keeps a hand-edited decision with an overlong tag, and sets aside one whose id is past the limit", async () => {
    const vault = await makeVault();
    const repository = new MarkdownRepository(vault);
    const tagged = await repository.write(recordFixture());
    await writeFile(tagged.path, (await readFile(tagged.path, "utf8")).replace('- "storage"', `- "${"长".repeat(120)}"`));
    expect((await new DecisionContextRepository(vault).scan()).documents.find((doc) => doc.kind === "recorded_decision")?.tags).toEqual(["长".repeat(100)]);

    await writeFile(tagged.path, (await readFile(tagged.path, "utf8")).replace('id: "018f-example-decision"', `id: "${"x".repeat(201)}"`));
    const snapshot = await new DecisionContextRepository(vault).scan();
    expect(snapshot.documents.filter((doc) => doc.kind === "recorded_decision")).toEqual([]);
    expect(snapshot.sources.find((source) => source.source === "decisions")).toMatchObject({ skipped: 1 });
  });

  it("sets aside only the record a note it cannot read names, not every record of its source", async () => {
    const vault = await makeVault();
    const folder = join(vault, "Decision Journal/summarize");
    await writeFile(join(folder, "A.md"), legacy({ id: "DEC-A" }));
    // Saved in GBK by an editor on Chinese Windows: not UTF-8, so not read; its id line still says which it is.
    await writeFile(join(folder, "Z.md"), Buffer.concat([Buffer.from(legacy({ id: "DEC-Z" })), Buffer.from([0xd5, 0xfd, 0xce, 0xc4, 0x0a])]));

    const snapshot = await new DecisionContextRepository(vault).scan();
    expect(snapshot.documents.map((doc) => doc.id)).toEqual(["DEC-A"]);
    // Doubted whole, every record of the source "may be" the unread note: its feedback and relations refused.
    expect([mayBeSetAside(snapshot, "summarize", "DEC-A"), mayBeSetAside(snapshot, "summarize", "DEC-Z")]).toEqual([false, true]);
  });

  it("rejects oversized legacy records while keeping the other source usable", async () => {
    const vault = await makeVault();
    await writeFile(join(vault, "Decision Journal/summarize/large.md"), legacy() + "x".repeat(513 * 1024));
    await new MarkdownRepository(vault).write(recordFixture());
    const snapshot = await new DecisionContextRepository(vault).scan();
    expect(snapshot.sources[0]).toMatchObject({ status: "unavailable", skipped: 1 });
    expect(snapshot.documents).toHaveLength(1);
  });

  it("does not follow a symlinked knowledge directory or traverse outside the vault", async (context) => {
    const vault = await makeVault();
    const outside = await makeVault();
    await writeFile(join(outside, "Decision Journal/summarize/private.md"), legacy());
    await rm(join(vault, "Decision Journal/summarize"), { recursive: true });
    try { await symlink(join(outside, "Decision Journal/summarize"), join(vault, "Decision Journal/summarize"), "dir"); }
    catch (error) {
      if (error !== null && typeof error === "object" && "code" in error && ["EPERM", "EACCES"].includes(String(error.code))) { context.skip(); return; }
      throw error;
    }
    const snapshot = await new DecisionContextRepository(vault).scan();
    expect(snapshot.documents).toEqual([]);
    expect(snapshot.sources[0]?.status).toBe("unavailable");
    expect(JSON.stringify(snapshot)).not.toContain(outside);
    const iterator = new ObsidianVaultRepository(vault).iterateFolder("../outside");
    await expect(iterator.next()).rejects.toThrow("Invalid vault-relative directory");
  });

  it("distinguishes a missing source from an inaccessible vault and supports cancellation", async () => {
    const vault = await makeVault();
    expect((await new DecisionContextRepository(vault).scan()).sources.every((source) => source.status === "empty")).toBe(true);
    await rm(vault, { recursive: true });
    expect((await new DecisionContextRepository(vault).scan()).sources.every((source) => source.status === "unavailable")).toBe(true);
    const controller = new AbortController();
    controller.abort();
    await expect(new ObsidianVaultRepository(vault).iterateFolder("Decision Journal/summarize", controller.signal).next()).rejects.toThrow("aborted");
  });
});
