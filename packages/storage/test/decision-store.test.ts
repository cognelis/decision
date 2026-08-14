import {
  access,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
    ).rejects.toThrow(/not deferred/u);
    await expect(access(saved.note.path)).resolves.toBeUndefined();
    expect(index.count()).toBe(1);
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
