import {
  access,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  DecisionStore,
  MarkdownRepository,
  SqliteIndex,
  type DecisionIndex,
} from "../src/index.js";
import { recordFixture } from "./fixtures.js";

const makeStore = async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-store-"));
  const repository = new MarkdownRepository(join(root, "vault"));
  const index = new SqliteIndex(join(root, "index.sqlite"));
  return { root, repository, index, store: new DecisionStore(repository, index) };
};

describe("DecisionStore", () => {
  it("writes Markdown before updating the derived index", async () => {
    const { index, store } = await makeStore();

    const result = await store.save(recordFixture());

    expect(result.indexed).toBe(true);
    await expect(access(result.note.path)).resolves.toBeUndefined();
    expect(index.search("storage")).toHaveLength(1);
    index.close();
  });

  it("keeps a successful Markdown note when indexing fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-store-"));
    const repository = new MarkdownRepository(join(root, "vault"));
    const warnings: Error[] = [];
    const failingIndex: DecisionIndex = {
      upsert: () => {
        throw new Error("simulated index failure");
      },
      removePath: () => undefined,
      rebuild: () => undefined,
      close: () => undefined,
    };
    const store = new DecisionStore(repository, failingIndex, (error) =>
      warnings.push(error),
    );

    const result = await store.save(recordFixture());

    expect(result.indexed).toBe(false);
    await expect(access(result.note.path)).resolves.toBeUndefined();
    expect(warnings.map((warning) => warning.message)).toEqual([
      "simulated index failure",
    ]);
  });

  it("rebuilds the index from Markdown and carries diagnostics", async () => {
    const { repository, index, store } = await makeStore();
    await repository.write(recordFixture());
    await repository.write(
      recordFixture({
        id: "018f-second-decision",
        created: "2026-07-25T01:02:03.000Z",
        question: "第二个决策",
        tags: ["second"],
      }),
    );

    const report = await store.rebuildIndex();

    expect(report.indexedCount).toBe(2);
    expect(report.diagnostics).toEqual([]);
    expect(index.count()).toBe(2);
    index.close();
  });

  it("keeps a decision saved while a rebuild was reading the vault", async () => {
    const { repository, index, store } = await makeStore();
    await repository.write(recordFixture());
    const read = repository.scan.bind(repository);
    let scanned!: () => void;
    let saved!: () => void;
    const scanDone = new Promise<void>((resolve) => { scanned = resolve; });
    const saveDone = new Promise<void>((resolve) => { saved = resolve; });
    // The vault read before the capture lands; the rebuild ends after it.
    repository.scan = async () => {
      const result = await read();
      scanned();
      await saveDone;
      return result;
    };
    const rebuilding = store.rebuildIndex();
    await scanDone;

    await store.save(recordFixture({ id: "018f-captured-meanwhile", question: "重建期间捕获的决策", created: "2026-07-25T01:02:03.000Z" }));
    saved();
    await rebuilding;

    expect(index.findDecisions(["018f-captured-meanwhile"])).toHaveLength(1);
    index.close();
  });

  it("keeps the last index when the vault is not there, rather than rebuilding it as empty", async () => {
    const { rename, mkdir } = await import("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "decision-store-"));
    await mkdir(join(root, "vault"));
    // As the app opens it: a vault that must already be there.
    const repository = new MarkdownRepository(join(root, "vault"), { existingVault: true });
    const index = new SqliteIndex(join(root, "index.sqlite"));
    const store = new DecisionStore(repository, index);
    await repository.write(recordFixture());
    await store.rebuildIndex();
    // Its disk not connected, or the folder moved.
    await rename(join(root, "vault"), join(root, "moved"));

    await expect(store.rebuildIndex()).rejects.toThrow(/找不到仓库目录/u);

    expect(index.count()).toBe(1);
    // A vault there with no decisions yet is still read as none.
    await mkdir(join(root, "vault"));
    await expect(store.rebuildIndex()).resolves.toMatchObject({ indexedCount: 0 });
    index.close();
  });

  it("reads a note saved with Windows line endings or a BOM, and records its outcome", async () => {
    const { repository, index, store } = await makeStore();
    const crlf = await repository.write(recordFixture({ id: "dec-crlf", question: "被转成 CRLF 的决策" }));
    await writeFile(crlf.path, (await readFile(crlf.path, "utf8")).replaceAll("\n", "\r\n"), "utf8");
    const bom = await repository.write(recordFixture({ id: "dec-bom", created: "2026-07-25T01:02:03.000Z", question: "带 BOM 的决策" }));
    await writeFile(bom.path, `﻿${await readFile(bom.path, "utf8")}`, "utf8");

    const report = await store.rebuildIndex();

    expect(report.diagnostics).toEqual([]);
    expect(index.findDecisions(["dec-crlf", "dec-bom"])).toHaveLength(2);
    await expect(repository.updateOutcome("dec-crlf", "上线后错误率下降")).resolves.toMatchObject({ id: "dec-crlf" });
    expect(await readFile(crlf.path, "utf8")).toContain("上线后错误率下降");
    index.close();
  });

  it("indexes the rest when one decisions subfolder cannot be read, and says which", async () => {
    const { chmod, mkdir } = await import("node:fs/promises");
    const { repository, index, store } = await makeStore();
    await repository.write(recordFixture({ id: "dec-readable" }));
    const locked = join(repository.decisionsPath, "synced-from-elsewhere");
    await mkdir(locked);
    await writeFile(join(locked, "other.md"), "---\nid: other\n---\n");
    await chmod(locked, 0o000);
    try {
      const report = await store.rebuildIndex();

      expect(index.findDecisions(["dec-readable"])).toHaveLength(1);
      // In words: Node's own English line, with the folder's whole path, went on to the page.
      expect(report.diagnostics).toEqual([{ path: locked, message: "无法读取这个文件夹，没有读取它的权限" }]);
    } finally {
      await chmod(locked, 0o700);
      index.close();
    }
  });

  it("names both notes that share one decision id, and counts the decision once", async () => {
    const { repository, index, store } = await makeStore();
    const original = await repository.write(recordFixture({ id: "dec-shared" }));
    // What Obsidian's "make a copy" or a sync conflict leaves beside it.
    const copy = original.path.replace(/\.md$/u, " 1.md");
    await writeFile(copy, await readFile(original.path, "utf8"), "utf8");

    const report = await store.rebuildIndex();

    expect(report.indexedCount).toBe(1);
    expect(report.diagnostics.map((diagnostic) => diagnostic.path).sort()).toEqual([original.path, copy].sort());
    expect(report.diagnostics[0]?.message).toContain("同一个决策 ID");
    index.close();
  });

  it("indexes a file whose id was changed as its new id, in place of the old one", async () => {
    const { repository, index } = await makeStore();
    const stored = await repository.write(recordFixture({ id: "dec-old" }));
    index.upsert(await repository.read(stored.path));
    const renamed = (await readFile(stored.path, "utf8")).replace(/^id: .*$/mu, "id: dec-new");
    await writeFile(stored.path, renamed, "utf8");

    const reread = await repository.read(stored.path);
    expect(reread.id).toBe("dec-new");
    expect(() => index.upsert(reread)).not.toThrow();
    expect(index.findDecisions(["dec-new"])).toHaveLength(1);
    expect(index.findDecisions(["dec-old"])).toHaveLength(0);
    index.close();
  });

  it("completes deferred rationale without deleting user-added sections", async () => {
    const { repository, index, store } = await makeStore();
    const deferred = recordFixture({
      status: "deferred_rationale",
      rationaleStatus: "deferred",
      rationaleOriginal: null,
      reasonFactors: [],
    });
    const saved = await store.save(deferred);
    const original = await readFile(saved.note.path, "utf8");
    await writeFile(
      saved.note.path,
      original.replace(
        "<!-- decision:rationale-end -->\n\n## 当时上下文",
        "<!-- decision:rationale-end -->\n\n## 我的补充\n\n这段不能被删除。\n\n## 当时上下文",
      ),
      "utf8",
    );

    const updated = await store.completeDeferredRationale(deferred.id, {
      rationale: "  保留我的原始空格。  ",
      reasonFactors: ["reversibility"],
    });

    expect(updated.indexed).toBe(true);
    const content = await readFile(saved.note.path, "utf8");
    expect(content).toContain("## 我的补充\n\n这段不能被删除。");
    const parsed = await repository.read(saved.note.path);
    expect(parsed.record).toMatchObject({
      status: "completed",
      rationaleStatus: "captured",
      rationaleOriginal: "  保留我的原始空格。  ",
      reasonFactors: ["reversibility"],
    });
    expect(index.listByRationaleStatus("deferred")).toHaveLength(0);
    expect(index.listByRationaleStatus("captured")).toHaveLength(1);
    index.close();
  });

  it("marks a deferred rationale skipped without deleting the decision", async () => {
    const { repository, index, store } = await makeStore();
    const deferred = recordFixture({
      status: "deferred_rationale",
      rationaleStatus: "deferred",
      rationaleOriginal: null,
      reasonFactors: [],
    });
    const saved = await store.save(deferred);
    const original = await readFile(saved.note.path, "utf8");
    await writeFile(
      saved.note.path,
      original.replace(
        "<!-- decision:rationale-end -->\n\n## 当时上下文",
        "<!-- decision:rationale-end -->\n\n## 我的补充\n\n保留这段历史记录。\n\n## 当时上下文",
      ),
      "utf8",
    );
    const updated = await store.skipDeferredRationale(deferred.id);

    expect(updated.indexed).toBe(true);
    const content = await readFile(saved.note.path, "utf8");
    expect(content).toContain(
      "## 我的补充\n\n保留这段历史记录。",
    );
    expect(content).toContain(
      "## 我的理由（原文）\n\n（已跳过）",
    );
    const parsed = await repository.read(saved.note.path);
    expect(parsed.record).toMatchObject({
      status: "rationale_skipped",
      rationaleStatus: "skipped",
      rationaleOriginal: null,
      reasonFactors: [],
    });
    expect(index.listByRationaleStatus("deferred")).toHaveLength(0);
    expect(index.listByRationaleStatus("skipped")).toHaveLength(1);
    index.close();
  });

  it("reads a deferred rationale written by hand in Obsidian as given, and does not write over it", async () => {
    const { repository, index, store } = await makeStore();
    const deferred = recordFixture({
      status: "deferred_rationale",
      rationaleStatus: "deferred",
      rationaleOriginal: null,
      reasonFactors: [],
    });
    const saved = await store.save(deferred);
    const original = await readFile(saved.note.path, "utf8");
    await writeFile(saved.note.path, original.replace("（稍后补充）", "团队已经熟悉 Markdown，迁移成本最低。"), "utf8");
    await store.rebuildIndex();

    // Still listed as waiting for a rationale, and skipping it there wrote （已跳过） over the reader's own.
    expect(index.listByRationaleStatus("deferred")).toHaveLength(0);
    expect((await repository.read(saved.note.path)).record).toMatchObject({
      status: "completed",
      rationaleStatus: "captured",
      rationaleOriginal: "团队已经熟悉 Markdown，迁移成本最低。",
    });
    await expect(store.skipDeferredRationale(deferred.id)).rejects.toThrow(/不在待补理由/u);
    expect(await readFile(saved.note.path, "utf8")).toContain("团队已经熟悉 Markdown，迁移成本最低。");
    index.close();
  });

  it("keeps a review written by hand in Obsidian, and what follows it, when the app records one", async () => {
    const { repository, index, store } = await makeStore();
    const saved = await store.save(recordFixture({ outcome: "上线后查询变快了" }));
    const original = await readFile(saved.note.path, "utf8");
    await writeFile(saved.note.path, original.replace("（尚未复盘）\n", "这次选 Markdown 是对的。\n\n## 我的补充\n\n和同事讨论过。\n"), "utf8");

    await store.updateOutcomeReview(saved.note.id, { verdict: "as_expected", lesson: "索引要压测", reviewedAt: "2026-10-03T08:00:00.000Z" });

    // The first verdict recorded took everything under the heading with it.
    const after = await readFile(saved.note.path, "utf8");
    expect(after).toContain("这次选 Markdown 是对的。");
    expect(after).toContain("## 我的补充\n\n和同事讨论过。");
    expect((await repository.read(saved.note.path)).record.outcomeReview).toMatchObject({ verdict: "as_expected", lesson: "索引要压测" });
    index.close();
  });

  it("says which decision iCloud moved off this Mac, rather than calling the folder healthy", async () => {
    const { index, store } = await makeStore();
    const saved = await store.save(recordFixture());
    await writeFile(join(dirname(saved.note.path), `.${basename(saved.note.path)}.icloud`), "bplist00", "utf8");
    await rm(saved.note.path);

    const report = await store.rebuildIndex();

    expect(report.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([expect.stringContaining("iCloud")]);
    index.close();
  });

  it("keeps the decisions of notes iCloud moved off this Mac, or in a folder it cannot list now, at a start and a rebuild", async () => {
    const { chmod, mkdir, rename } = await import("node:fs/promises");
    const { repository, index, store } = await makeStore();
    const evicted = await store.save(recordFixture({ id: "decision-evicted", question: "留在云端的决策？" }));
    const deleted = await store.save(recordFixture({ id: "decision-deleted", question: "真的删掉了？" }));
    const synced = await repository.write(recordFixture({ id: "decision-synced", question: "别处同步来的？" }));
    const locked = join(repository.decisionsPath, "synced-from-elsewhere");
    await mkdir(locked);
    await rename(synced.path, join(locked, basename(synced.path)));
    await store.reconcileIndex();
    expect(index.count()).toBe(3);

    // "Optimize Mac Storage", a folder a sync tool locked, and a note really deleted, while the app was closed.
    await rename(evicted.note.path, join(dirname(evicted.note.path), `.${basename(evicted.note.path)}.icloud`));
    await chmod(locked, 0o000);
    await rm(deleted.note.path);
    try {
      // Taken out at each start, they were gone from every list, search and review until they came back.
      const reconciled = await store.reconcileIndex();
      expect(index.findDecisions(["decision-evicted", "decision-synced", "decision-deleted"]).map((decision) => decision.id).sort())
        .toEqual(["decision-evicted", "decision-synced"]);
      expect(reconciled.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
        expect.stringContaining("iCloud"),
        expect.stringContaining("无法读取这个文件夹"),
      ]);

      // Rebuilt whole from Settings, they keep their rows as last read, found by search as well.
      await store.rebuildIndex();
      expect(index.count()).toBe(2);
      expect(index.search("留在云端").map((decision) => decision.id)).toEqual(["decision-evicted"]);
      expect(index.findDecisions(["decision-synced"])[0]?.question).toBe("别处同步来的？");
    } finally {
      await chmod(locked, 0o700);
      index.close();
    }
  });

  it("rebuilds a note read again beside its iCloud placeholder as it now reads", async () => {
    const { index, store } = await makeStore();
    const saved = await store.save(recordFixture({ id: "decision-old-id" }));
    // Coming back from iCloud, its placeholder not yet gone; its id was changed on another device meanwhile.
    await writeFile(join(dirname(saved.note.path), `.${basename(saved.note.path)}.icloud`), "bplist00", "utf8");
    await writeFile(saved.note.path, (await readFile(saved.note.path, "utf8")).replaceAll("decision-old-id", "decision-new-id"), "utf8");

    // Kept as last read as well, its row clashed with the note read on the path, and the rebuild failed.
    await expect(store.rebuildIndex()).resolves.toMatchObject({ indexedCount: 1 });
    expect(index.findDecisions(["decision-old-id", "decision-new-id"]).map((decision) => decision.id)).toEqual(["decision-new-id"]);
    index.close();
  });

  it("refuses an edit made from the version an editor opened, once the note changed in Obsidian", async () => {
    const { repository, index, store } = await makeStore();
    const saved = await store.save(recordFixture({ outcome: "上线后查询变快了" }));
    const opened = saved.note.contentHash;
    // While the editor is open, the reader adds what happened in week two in Obsidian.
    const original = await readFile(saved.note.path, "utf8");
    await writeFile(saved.note.path, original.replace("上线后查询变快了", "上线后查询变快了\n\n第二周：凌晨批处理超时，回退了一次。"), "utf8");

    // Saved without its version, the paragraph written in Obsidian was gone without a word.
    await expect(store.updateOutcome(saved.note.id, "上线后查询变快了（已确认）", opened)).rejects.toMatchObject({ code: "source_changed" });
    expect(await readFile(saved.note.path, "utf8")).toContain("凌晨批处理超时");

    // From the version as it now is, it saves; a review standing is the app's to keep, not a reason to refuse.
    await store.updateOutcomeReview(saved.note.id, { verdict: "as_expected", lesson: null, reviewedAt: "2026-10-03T08:00:00.000Z" });
    const current = (await repository.read(saved.note.path)).contentHash;
    await expect(store.updateOutcome(saved.note.id, "改写后的结果", current)).resolves.toMatchObject({ indexed: true });
    index.close();
  });

  it("edits decisions in a vault reached through a link, as it writes them", async () => {
    const { mkdir, symlink } = await import("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "decision-store-linked-"));
    const real = join(root, "iCloud", "Vault");
    await mkdir(real, { recursive: true });
    await symlink(real, join(root, "Vault"));
    const index = new SqliteIndex(join(root, "index.sqlite"));
    const store = new DecisionStore(new MarkdownRepository(join(root, "Vault"), { existingVault: true }), index);
    const saved = await store.save(recordFixture());
    const deferred = await store.save(recordFixture({ id: "deferred-1", status: "deferred_rationale", rationaleStatus: "deferred", rationaleOriginal: null, reasonFactors: [] }));

    // Written and listed, then every edit of it refused as a note that "cannot be written safely".
    await expect(store.updateOutcome(saved.note.id, "上线后查询变快了")).resolves.toMatchObject({ indexed: true });
    await expect(store.completeDeferredRationale(deferred.note.id, { rationale: "因为团队熟悉" })).resolves.toMatchObject({ indexed: true });
    index.close();
  });

  it.runIf(process.platform === "darwin")("edits decisions whose folder is spelled with another case on disk", async () => {
    const { mkdir } = await import("node:fs/promises");
    const { isDecisionJournalPath } = await import("../src/index.js");
    const { root, index, store } = await makeStore();
    // Made by hand, or by Obsidian on another device, as "decision journal".
    await mkdir(join(root, "vault", "decision journal"), { recursive: true });
    const saved = await store.save(recordFixture());

    await expect(store.updateOutcome(saved.note.id, "上线后查询变快了")).resolves.toMatchObject({ indexed: true });
    // And the vault-wide note search leaves it out as the app's own folder, rather than indexing it twice.
    expect(isDecisionJournalPath("decision journal/decisions/2026/07/x.md")).toBe(true);
    index.close();
  });

  it("reads an outcome emptied in Obsidian as none yet, and says when one written there is too long to rewrite", async () => {
    const { index, store } = await makeStore();
    const emptied = await store.save(recordFixture({ id: "decision-emptied", outcome: "写错了，这条其实还没上线" }));
    await writeFile(emptied.note.path, (await readFile(emptied.note.path, "utf8")).replace("写错了，这条其实还没上线", ""), "utf8");
    const long = await store.save(recordFixture({ id: "decision-long", outcome: "上线后查询变快了" }));
    await writeFile(long.note.path, (await readFile(long.note.path, "utf8")).replace("上线后查询变快了", `慢查询日志：\n\n${"SELECT 1;  -- 1.2s\n".repeat(500)}`), "utf8");
    await store.rebuildIndex();

    // Read as an outcome of "", it waited for a review that had nothing to review.
    expect(index.findDecisions(["decision-emptied"])[0]?.outcome).toBeNull();
    // Refused as a note "missing, unreadable or copied", with nothing about its length.
    await expect(store.updateReviewDueDate("decision-long", "2026-12-01")).rejects.toThrow("超过了 8000 字");
    index.close();
  });

  it("keeps an edit the watcher brought in while a rebuild was reading the vault", async () => {
    // A vault that takes a moment to read: held open once read, until released.
    class SlowRepository extends MarkdownRepository {
      gate: Promise<void> = Promise.resolve();
      onRead: () => void = () => undefined;
      override async scan(): ReturnType<MarkdownRepository["scan"]> {
        const result = await super.scan();
        this.onRead();
        await this.gate;
        return result;
      }
    }
    const root = await mkdtemp(join(tmpdir(), "decision-store-rebuild-"));
    const repository = new SlowRepository(join(root, "vault"));
    const index = new SqliteIndex(join(root, "index.sqlite"));
    const store = new DecisionStore(repository, index);
    const saved = await store.save(recordFixture({ outcome: "A：上线顺利" }));
    let release!: () => void;
    repository.gate = new Promise((resolve) => { release = resolve; });
    const read = new Promise<void>((resolve) => { repository.onRead = resolve; });
    const rebuilding = store.rebuildIndex();
    await read;

    // Saved in Obsidian once the vault was read, and brought in by the watcher.
    await writeFile(saved.note.path, (await readFile(saved.note.path, "utf8")).replace("A：上线顺利", "B：第二周回退"), "utf8");
    store.watchedIndex.upsert(await repository.read(saved.note.path));
    release();
    await rebuilding;

    // The database built from the earlier read was swapped in over it, and the list showed A until the next edit.
    expect(index.findDecisions([saved.note.id])[0]?.outcome).toBe("B：第二周回退");
    index.close();
  });

  it("changes only what it writes: the reader's own properties, a BOM and Windows line endings stay", async () => {
    const { repository, index, store } = await makeStore();
    const saved = await store.save(recordFixture());
    const original = await readFile(saved.note.path, "utf8");
    await writeFile(saved.note.path, original.replace("\n---\n# 决策点", "\nticket: 0042\norder_id: 2024100300012345678\n---\n# 决策点"), "utf8");

    await store.updateReviewDueDate(saved.note.id, "2026-12-01");
    // Re-rendered whole, 0042 became 42 and the id lost its last digits.
    const dated = await readFile(saved.note.path, "utf8");
    for (const kept of ["ticket: 0042\n", "order_id: 2024100300012345678\n", "review_due_date: 2026-12-01"]) expect(dated).toContain(kept);

    // Saved with a BOM and CRLF (git's autocrlf, a Windows editor), every line came back changed.
    await writeFile(saved.note.path, `﻿${dated.replaceAll("\n", "\r\n")}`, "utf8");
    await store.rebuildIndex();
    await store.updateOutcome(saved.note.id, "上线后查询变快了");
    const after = await readFile(saved.note.path, "utf8");
    expect(after.charCodeAt(0)).toBe(0xfeff);
    expect(after.replaceAll("\r\n", "").includes("\n")).toBe(false);
    expect((await repository.read(saved.note.path)).record.outcome).toBe("上线后查询变快了");
    index.close();
  });

  it("finds the note to complete, skip or tag by its id, without parsing the whole vault", async () => {
    const { repository, index, store } = await makeStore();
    await store.save(recordFixture({ id: "deferred-scan", status: "deferred_rationale", rationaleStatus: "deferred", rationaleOriginal: null, reasonFactors: [] }));
    const saved = await store.save(recordFixture({ id: "tagged-scan" }));
    const scan = vi.spyOn(repository, "scan");

    await store.skipDeferredRationale("deferred-scan");
    await store.updateAppliedPrinciples(saved.note.id, { appliedPrincipleIds: ["principle-1"] });
    // Read and parsed whole, each such click on a vault of ten thousand decisions took seconds.
    expect(scan).not.toHaveBeenCalled();
    expect((await repository.read(saved.note.path)).record.appliedPrincipleIds).toEqual(["principle-1"]);
    index.close();
  });

  it("brings the index up to the vault at a start by reading in only what changed since", async () => {
    const { repository, index, store } = await makeStore();
    // A new index is rebuilt whole, as before.
    await repository.write(recordFixture({ id: "kept", question: "保留的？" }));
    await expect(store.reconcileIndex()).resolves.toMatchObject({ indexedCount: 1 });
    const edited = await store.save(recordFixture({ id: "edited", question: "改过的？", outcome: "旧结果" }));
    const removed = await store.save(recordFixture({ id: "removed", question: "删掉的？" }));
    // While the app was closed: one note edited, one deleted, one added.
    await writeFile(edited.note.path, (await readFile(edited.note.path, "utf8")).replace("旧结果", "新结果"), "utf8");
    await rm(removed.note.path);
    await repository.write(recordFixture({ id: "added", question: "新加的？" }));
    const upsert = vi.spyOn(index, "upsert");

    const report = await store.reconcileIndex();

    // Rebuilt whole at every start, ten thousand decisions kept the window from opening for seconds.
    expect(upsert.mock.calls.map(([note]) => note.id).sort()).toEqual(["added", "edited"]);
    expect(index.findDecisions(["edited"])[0]?.outcome).toBe("新结果");
    expect(index.hasDecision("removed")).toBe(false);
    expect(report).toEqual({ indexedCount: 3, diagnostics: [] });
    index.close();
  });

  it("writes a property the reader spread over lines as a whole, when changing just its lines would not read", async () => {
    const { repository, index, store } = await makeStore();
    const saved = await store.save(recordFixture({ appliedPrincipleIds: ["p-0", "p-1"] }));
    const original = await readFile(saved.note.path, "utf8");
    // Rewritten in Obsidian as a flow list over three lines: its closing bracket is not a line of its own key.
    await writeFile(saved.note.path, original.replace(/applied_principles:\n(?: {2}- .*\n)+/u, 'applied_principles: [\n  "p-0",\n  "p-1"\n]\n'), "utf8");
    expect(await readFile(saved.note.path, "utf8")).toContain('applied_principles: [\n  "p-0"');

    await store.updateAppliedPrinciples(saved.note.id, { appliedPrincipleIds: ["p-2"] });
    expect((await repository.read(saved.note.path)).record.appliedPrincipleIds).toEqual(["p-2"]);
    index.close();
  });

  it("runs one rebuild at a time: a second asked for meanwhile is the first", async () => {
    const { index, store } = await makeStore();
    await store.save(recordFixture());
    const first = store.rebuildIndex();
    // Two at once each cleared what the other tracked of the writes made meanwhile.
    expect(store.rebuildIndex()).toBe(first);
    await first;
    const next = store.rebuildIndex();
    expect(next).not.toBe(first);
    await next;
    index.close();
  });

  it("deletes a deferred decision from Markdown and the derived index", async () => {
    const { index, store } = await makeStore();
    const deferred = recordFixture({
      status: "deferred_rationale",
      rationaleStatus: "deferred",
      rationaleOriginal: null,
      reasonFactors: [],
    });
    const saved = await store.save(deferred);

    const deleted = await store.deleteDeferredRationale(deferred.id);

    expect(deleted.indexed).toBe(true);
    await expect(access(saved.note.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(index.count()).toBe(0);
    index.close();
  });

  it("refuses to delete a decision that is no longer awaiting rationale", async () => {
    const { index, store } = await makeStore();
    const saved = await store.save(recordFixture());

    await expect(
      store.deleteDeferredRationale("018f-example-decision"),
    ).rejects.toThrow(/不在待补理由/u);
    await expect(access(saved.note.path)).resolves.toBeUndefined();
    expect(index.count()).toBe(1);
    index.close();
  });

  it("says a note deleted in Obsidian is gone, in words, when its rationale or principles are then written", async () => {
    const { index, store } = await makeStore();
    const deferred = recordFixture({
      status: "deferred_rationale",
      rationaleStatus: "deferred",
      rationaleOriginal: null,
      reasonFactors: [],
    });
    const saved = await store.save(deferred);
    await rm(saved.note.path);

    const unavailable = { code: "source_unavailable", message: expect.stringMatching(/^这条决策的笔记暂时无法安全写入/u) };
    await expect(store.completeDeferredRationale(deferred.id, { rationale: "因为便宜。" })).rejects.toMatchObject(unavailable);
    await expect(store.skipDeferredRationale(deferred.id)).rejects.toMatchObject(unavailable);
    await expect(store.deleteDeferredRationale(deferred.id)).rejects.toMatchObject(unavailable);
    await expect(store.updateAppliedPrinciples(deferred.id, { appliedPrincipleIds: ["principle-1"] })).rejects.toMatchObject(unavailable);
    index.close();
  });

  it("updates an outcome in Markdown and the rebuildable search index", async () => {
    const { repository, index, store } = await makeStore();
    await store.save(recordFixture());

    const updated = await store.updateOutcome(
      "018f-example-decision",
      "上线一周后运行稳定，检索耗时低于预期。",
    );

    expect(updated.indexed).toBe(true);
    expect((await repository.read(updated.note.path)).record.outcome).toBe(
      "上线一周后运行稳定，检索耗时低于预期。",
    );
    expect(index.queryDecisions({ query: "运行稳定" })).toEqual([
      expect.objectContaining({
        id: "018f-example-decision",
        outcome: "上线一周后运行稳定，检索耗时低于预期。",
      }),
    ]);
    index.close();
  });

  it("updates applied principles in Markdown and the rebuildable index", async () => {
    const { repository, index, store } = await makeStore();
    await store.save(recordFixture());

    const updated = await store.updateAppliedPrinciples(
      "018f-example-decision",
      { appliedPrincipleIds: ["principle-1", "principle-2"] },
    );

    expect(updated.indexed).toBe(true);
    await expect(repository.read(updated.note.path)).resolves.toMatchObject({
      record: {
        appliedPrincipleIds: ["principle-1", "principle-2"],
      },
    });
    expect(index.findDecisions(["018f-example-decision"])[0]).toMatchObject({
      appliedPrincipleIds: ["principle-1", "principle-2"],
    });
    index.close();
  });

  it("stores a review date in Markdown and the rebuildable index", async () => {
    const { repository, index, store } = await makeStore();
    await store.save(recordFixture());

    const updated = await store.updateReviewDueDate(
      "018f-example-decision",
      "2026-08-15",
    );

    expect(updated.indexed).toBe(true);
    expect(
      (await repository.read(updated.note.path)).record.reviewDueDate,
    ).toBe("2026-08-15");
    expect(index.queryDecisions({ reviewState: "scheduled", asOfDate: "2026-08-10" }))
      .toEqual([
        expect.objectContaining({
          id: "018f-example-decision",
          reviewDueDate: "2026-08-15",
        }),
      ]);
    index.close();
  });

  it("stores a structured review and makes its lesson searchable", async () => {
    const { repository, index, store } = await makeStore();
    await store.save(
      recordFixture({ outcome: "上线后稳定运行一周。" }),
    );

    const updated = await store.updateOutcomeReview(
      "018f-example-decision",
      {
        verdict: "mixed",
        lesson: "方向正确，但低估了迁移成本。",
        reviewedAt: "2026-08-02T10:00:00.000Z",
      },
    );

    expect(updated.indexed).toBe(true);
    expect((await repository.read(updated.note.path)).record.outcomeReview).toEqual({
      verdict: "mixed",
      lesson: "方向正确，但低估了迁移成本。",
      reviewedAt: "2026-08-02T10:00:00.000Z",
    });
    expect(index.queryDecisions({ reviewState: "reviewed" })).toEqual([
      expect.objectContaining({
        id: "018f-example-decision",
        outcomeVerdict: "mixed",
        outcomeLesson: "方向正确，但低估了迁移成本。",
      }),
    ]);
    expect(index.queryDecisions({ query: "迁移成本" })).toHaveLength(1);
    index.close();
  });
});
