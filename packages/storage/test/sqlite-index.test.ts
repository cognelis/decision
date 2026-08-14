import {
  mkdtemp,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  MarkdownRepository,
  SqliteIndex,
} from "../src/index.js";
import { recordFixture } from "./fixtures.js";

const makePaths = async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-index-"));
  return {
    vault: join(root, "vault"),
    database: join(root, "index.sqlite"),
  };
};

describe("SqliteIndex", () => {
  it("upserts, searches, and filters indexed decisions", async () => {
    const paths = await makePaths();
    const repository = new MarkdownRepository(paths.vault);
    const note = await repository.write(
      recordFixture({ appliedPrincipleIds: ["principle-1"] }),
    );
    const parsed = await repository.read(note.path);
    const index = new SqliteIndex(paths.database);

    index.upsert(parsed);
    index.upsert(parsed);

    expect(index.count()).toBe(1);
    expect(index.hasDecision("018f-example-decision")).toBe(true);
    expect(index.hasDecision("missing")).toBe(false);
    expect(index.search("storage")).toEqual([
      expect.objectContaining({
        id: "018f-example-decision",
        project: "decision",
        filePath: note.path,
        appliedPrincipleIds: ["principle-1"],
      }),
    ]);
    expect(index.listByRationaleStatus("captured")).toHaveLength(1);
    expect(index.listByRationaleStatus("deferred")).toEqual([]);
    index.close();
  });

  it("lists recent decisions and counts records since a timestamp", async () => {
    const paths = await makePaths();
    const repository = new MarkdownRepository(paths.vault);
    const index = new SqliteIndex(paths.database);
    for (const record of [
      recordFixture({
        id: "oldest",
        created: "2026-07-20T00:00:00.000Z",
      }),
      recordFixture({
        id: "middle",
        created: "2026-07-26T00:00:00.000Z",
      }),
      recordFixture({
        id: "newest",
        created: "2026-07-30T00:00:00.000Z",
      }),
    ]) {
      const note = await repository.write(record);
      index.upsert(await repository.read(note.path));
    }

    expect(
      index.listRecent(2).map((decision) => decision.id),
    ).toEqual(["newest", "middle"]);
    expect(
      index.countSince("2026-07-25T00:00:00.000Z"),
    ).toBe(2);
    expect(index.snapshotDecisions().map(({ id }) => id)).toEqual([
      "oldest",
      "middle",
      "newest",
    ]);
    index.close();
  });

  it("resolves a bounded cross-principle decision set in caller order", async () => {
    const paths = await makePaths();
    const repository = new MarkdownRepository(paths.vault);
    const index = new SqliteIndex(paths.database);
    const ids = Array.from({ length: 12 }, (_, index) => `related-${index}`);
    for (const [position, id] of ids.entries()) {
      const note = await repository.write(
        recordFixture({
          id,
          created: `2026-07-${String(position + 1).padStart(2, "0")}T00:00:00.000Z`,
        }),
      );
      index.upsert(await repository.read(note.path));
    }

    expect(index.findDecisions([...ids].reverse()).map(({ id }) => id)).toEqual(
      [...ids].reverse(),
    );
    index.close();
  });

  it("queries decision history by text, rationale status, and source", async () => {
    const paths = await makePaths();
    const repository = new MarkdownRepository(paths.vault);
    const index = new SqliteIndex(paths.database);
    for (const record of [
      recordFixture({
        id: "captured-codex",
        created: "2026-07-30T00:00:00.000Z",
        sourceClient: "codex",
        question: "数据库应该使用哪种索引？",
        rationaleStatus: "captured",
        outcome: "上线后的用户反馈更清晰。",
      }),
      recordFixture({
        id: "skipped-claude",
        created: "2026-07-29T00:00:00.000Z",
        sourceClient: "claude-code",
        question: "界面应该使用哪种布局？",
        rationaleStatus: "skipped",
        status: "rationale_skipped",
        rationaleOriginal: null,
        reviewDueDate: "2026-08-01",
      }),
      recordFixture({
        id: "reviewed-codex",
        created: "2026-07-28T00:00:00.000Z",
        sourceClient: "codex",
        question: "发布节奏是否合理？",
        outcome: "按计划完成发布。",
        outcomeReview: {
          verdict: "as_expected",
          lesson: "小批量发布便于控制风险。",
          reviewedAt: "2026-08-02T10:00:00.000Z",
        },
        reviewDueDate: "2026-08-02",
      }),
    ]) {
      const note = await repository.write(record);
      index.upsert(await repository.read(note.path));
    }

    expect(
      index.queryDecisions({
        query: "索引",
        rationaleStatus: "captured",
        sourceClient: "codex",
      }),
    ).toEqual([expect.objectContaining({ id: "captured-codex" })]);
    expect(
      index.queryDecisions({ rationaleStatus: "skipped" }).map(({ id }) => id),
    ).toEqual(["skipped-claude"]);
    expect(index.queryDecisions({ sourceClient: "codex" })).toHaveLength(2);
    expect(index.queryDecisions({ decisionId: "skipped-claude", limit: 1 })).toEqual([
      expect.objectContaining({ id: "skipped-claude" }),
    ]);
    expect(index.queryDecisions({ query: "反馈" })).toEqual([
      expect.objectContaining({
        id: "captured-codex",
        outcome: "上线后的用户反馈更清晰。",
      }),
    ]);
    expect(
      index.queryDecisions({ reviewState: "pending_outcome" }).map(({ id }) => id),
    ).toEqual(["skipped-claude"]);
    expect(
      index.queryDecisions({ reviewState: "pending_review" }).map(({ id }) => id),
    ).toEqual(["captured-codex"]);
    expect(
      index.queryDecisions({ reviewState: "reviewed" }).map(({ id }) => id),
    ).toEqual(["reviewed-codex"]);
    expect(
      index
        .queryDecisions({ reviewState: "due", asOfDate: "2026-08-03" })
        .map(({ id }) => id),
    ).toEqual(["skipped-claude"]);
    expect(
      index
        .queryDecisions({ reviewState: "attention", asOfDate: "2026-08-03" })
        .map(({ id }) => id),
    ).toEqual(["captured-codex", "skipped-claude"]);
    expect(index.countReviewAttention("2026-08-03")).toBe(2);
    expect(
      index
        .queryDecisions({ reviewState: "scheduled", asOfDate: "2026-07-31" })
        .map(({ id }) => id),
    ).toEqual(["skipped-claude"]);
    expect(
      index
        .queryDecisions({ reviewState: "unscheduled", asOfDate: "2026-08-03" })
        .map(({ id }) => id),
    ).toEqual(["captured-codex"]);
    index.close();
  });

  it("indexes capture provenance and readable multi-value answers", async () => {
    const paths = await makePaths();
    const repository = new MarkdownRepository(paths.vault);
    const note = await repository.write(
      recordFixture({
        captureMode: "structured_tool",
        captureSemanticKey: "semantic-1",
        sourceEventId: "event-1",
        batchId: "batch-1",
        questionIndex: 1,
        selectedAnswer: {
          kind: "multiple",
          values: ["Risk", "Time"],
        },
      }),
    );
    const index = new SqliteIndex(paths.database);

    index.upsert(await repository.read(note.path));

    expect(index.search("Risk")).toEqual([
      expect.objectContaining({
        captureMode: "structured_tool",
        captureSemanticKey: "semantic-1",
        sourceEventId: "event-1",
        batchId: "batch-1",
        questionIndex: 1,
        selectedAnswer: "Risk、Time",
      }),
    ]);
    index.close();
  });

  it("indexes structured decision context for full-text search", async () => {
    const paths = await makePaths();
    const repository = new MarkdownRepository(paths.vault);
    const note = await repository.write(
      recordFixture({
        contextSummary: null,
        context: {
          taskBackground: "继续开发 Decision。",
          decisionFraming:
            "使用旁路轮次识别降低交互侵入性。",
          truncated: false,
        },
      }),
    );
    const index = new SqliteIndex(paths.database);

    index.upsert(await repository.read(note.path));

    expect(index.search("旁路轮次识别")).toEqual([
      expect.objectContaining({
        id: "018f-example-decision",
        context: expect.stringContaining("旁路轮次识别"),
      }),
    ]);
    index.close();
  });

  it("indexes a persisted semantic occurrence as rebuildable provenance", async () => {
    const paths = await makePaths();
    const repository = new MarkdownRepository(paths.vault);
    const note = await repository.write(
      recordFixture({
        created: "2026-07-25T00:00:00.000Z",
        captureMode: "structured_tool",
        captureSemanticKey: "semantic-1",
      }),
    );
    const index = new SqliteIndex(paths.database);
    index.upsert(await repository.read(note.path));

    expect(index.search("storage")).toEqual([
      expect.objectContaining({
        captureSemanticKey: "semantic-1",
      }),
    ]);
    index.close();
  });

  it("removes an index entry by its Markdown path", async () => {
    const paths = await makePaths();
    const repository = new MarkdownRepository(paths.vault);
    const note = await repository.write(recordFixture());
    const index = new SqliteIndex(paths.database);
    index.upsert(await repository.read(note.path));

    index.removePath(note.path);

    expect(index.count()).toBe(0);
    expect(index.search("storage")).toEqual([]);
    index.close();
  });

  it("rebuilds all rows without leaving stale FTS entries", async () => {
    const paths = await makePaths();
    const repository = new MarkdownRepository(paths.vault);
    const first = await repository.write(recordFixture());
    const second = await repository.write(
      recordFixture({
        id: "018f-second-decision",
        question: "第二个 searchable 决策",
        created: "2026-07-24T02:02:03.000Z",
        tags: ["second"],
      }),
    );
    const index = new SqliteIndex(paths.database);
    index.upsert(await repository.read(first.path));

    index.rebuild([
      await repository.read(first.path),
      await repository.read(second.path),
    ]);

    expect(index.count()).toBe(2);
    expect(index.search("second")).toEqual([
      expect.objectContaining({ id: "018f-second-decision" }),
    ]);
    index.close();
  });

  it("quarantines a corrupt index and recreates a private database", async () => {
    const paths = await makePaths();
    await writeFile(paths.database, "not a sqlite database", "utf8");

    const index = new SqliteIndex(paths.database);

    expect(index.count()).toBe(0);
    expect(
      (await readdir(join(paths.database, ".."))).some((name) =>
        name.startsWith("index.sqlite.corrupt-"),
      ),
    ).toBe(true);
    for (const path of [
      paths.database,
      `${paths.database}-wal`,
      `${paths.database}-shm`,
    ]) {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    index.close();
  });

  it("migrates an existing derived index with nullable capture columns", async () => {
    const paths = await makePaths();
    const legacy = new DatabaseSync(paths.database);
    legacy.exec(`
      CREATE TABLE decisions (
        id TEXT PRIMARY KEY,
        created TEXT NOT NULL,
        status TEXT NOT NULL,
        source_client TEXT NOT NULL,
        project TEXT NOT NULL,
        workflow TEXT,
        decision_type TEXT NOT NULL,
        selected_option TEXT NOT NULL,
        rationale_status TEXT NOT NULL,
        file_path TEXT NOT NULL UNIQUE,
        content_hash TEXT NOT NULL,
        question TEXT NOT NULL,
        rationale TEXT
      );
    `);
    legacy.close();

    const index = new SqliteIndex(paths.database);
    const inspected = new DatabaseSync(paths.database);
    const columns = (
      inspected.prepare("PRAGMA table_info(decisions)").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name);

    expect(columns).toEqual(
      expect.arrayContaining([
        "capture_mode",
        "capture_semantic_key",
        "source_event_id",
        "batch_id",
        "question_index",
        "context",
        "review_due_date",
        "applied_principle_ids",
      ]),
    );
    inspected.close();
    index.close();
  });
});
