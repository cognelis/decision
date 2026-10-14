import {
  chmod,
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

/** An index holding these decisions, written as the app writes them and read from their notes. */
const indexOf = async (records: Array<Parameters<typeof recordFixture>[0]>): Promise<SqliteIndex> => {
  const paths = await makePaths();
  const repository = new MarkdownRepository(paths.vault);
  const index = new SqliteIndex(paths.database);
  for (const overrides of records) index.upsert(await repository.read((await repository.write(recordFixture(overrides))).path));
  return index;
};

const found = (index: SqliteIndex, query: string, limit?: number): string[] =>
  index.queryDecisions({ query, ...(limit === undefined ? {} : { limit }) }).map((decision) => decision.id);

describe("SqliteIndex", () => {
  it("searches a query holding a control character (a NUL pasted in with text) rather than failing the whole list", async () => {
    const index = await indexOf([{ id: "a", question: "缓存策略选型", tags: [] }]);
    expect(found(index, "缓存策略\u0000")).toEqual(["a"]);
    index.close();
  });

  it("takes keywords joined by Chinese punctuation as separate words", async () => {
    const index = await indexOf([{ id: "a", question: "会话放 Redis 还是本地缓存？", tags: [] }]);
    expect(found(index, "Redis、缓存")).toEqual(["a"]);
    expect(found(index, "缓存，Redis")).toEqual(["a"]);
    index.close();
  });

  it("finds a decision spacing Chinese and Latin when the query is typed without the spaces", async () => {
    const index = await indexOf([{ id: "spaced", question: "是否使用 Redis 缓存会话？", tags: [] }]);
    expect(found(index, "使用Redis缓存")).toEqual(["spaced"]);
    expect(found(index, "Redis缓存")).toEqual(["spaced"]);
    index.close();
  });

  it("finds a decision by a short word in its tags or text, alone or beside longer words", async () => {
    const index = await indexOf([
      { id: "tagged", question: "连接池大小怎么定？", tags: ["架构", "storage"], rationaleOriginal: "压测之后再调。" },
      { id: "full-width", question: "ＡＰＩ网关的限流放在哪一层？", tags: [] },
      { id: "accented", question: "Café 的 ÉTÉ 计划", tags: [] },
    ]);
    // A two-character tag found nothing, and a short word beside a long one lost what each found alone.
    expect(found(index, "架构")).toEqual(["tagged"]);
    expect(found(index, "连接 storage")).toEqual(["tagged"]);
    expect(found(index, "API网关")).toEqual(["full-width"]);
    expect(found(index, "ét")).toEqual(["accented"]);
    index.close();
  });

  it("puts first the decision whose question holds the words, ahead of newer ones that only mention them", async () => {
    const filler = "我们讨论了很多关于团队协作和发布节奏的问题，最终决定先保持现状，后续再看。".repeat(12);
    const index = await indexOf([
      { id: "exact", created: "2026-01-01T00:00:00.000Z", question: "缓存策略选型", contextSummary: filler, rationaleOriginal: filler, tags: [] },
      { id: "mention", created: "2026-02-01T00:00:00.000Z", question: "数据库连接池大小", contextSummary: "顺带提到缓存策略选型。", rationaleOriginal: "缓存策略选型以后再说，缓存策略选型不是重点。", tags: [] },
      { id: "exact-short", created: "2026-01-01T00:00:00.000Z", question: "Redis 缓存", tags: [] },
      ...[1, 2, 3, 4, 5].map((day) => ({
        id: `mention-${day}`,
        created: `2026-03-0${day}T00:00:00.000Z`,
        question: `第 ${day} 个服务的会话放哪里`,
        rationaleOriginal: "Redis 之外也考虑过本地缓存。",
        tags: [],
      })),
    ]);
    expect(found(index, "缓存策略选型")).toEqual(["exact", "mention"]);
    // ⌘K's five: by date alone (缓存 is a short word), the one asked about was left out.
    expect(found(index, "Redis 缓存", 5)[0]).toBe("exact-short");
    index.close();
  });

  it("finds words in either width, typed with the IME in full-width mode or written so in a note", async () => {
    const index = await indexOf([
      { id: "half-width", question: "选用 SQLite 还是 PostgreSQL 作为存储？", tags: [] },
      { id: "full-width", question: "ＡＰＩ网关的限流放在哪一层？", tags: [] },
    ]);
    expect(found(index, "ＳＱＬｉｔｅ")).toEqual(["half-width"]);
    expect(found(index, "api")).toEqual(["full-width"]);
    index.close();
  });

  it("finds a decision by an alternative it weighed, and the tradeoff written against it", async () => {
    const index = await indexOf([{
      id: "storage",
      question: "存储层怎么选？",
      tags: [],
      options: [
        { id: "sqlite", label: "SQLite", description: "嵌入式，随应用分发", tradeoffs: ["并发写受限"] },
        { id: "postgres", label: "PostgreSQL", description: "独立服务进程", tradeoffs: ["需要额外运维"] },
      ],
      selectedAnswer: { kind: "preset", values: ["SQLite"] },
    }]);
    expect(found(index, "PostgreSQL")).toEqual(["storage"]);
    expect(found(index, "需要额外运维")).toEqual(["storage"]);
    index.close();
  });

  it("owes the notes a read when its search rows are from before they were folded and held the options", async () => {
    const paths = await makePaths();
    const repository = new MarkdownRepository(paths.vault);
    const note = await repository.read((await repository.write(recordFixture({ question: "ＡＰＩ网关放哪一层？" }))).path);
    const first = new SqliteIndex(paths.database);
    first.upsert(note);
    first.close();
    // As the shipped build left them: raw text, and no options.
    const old = new DatabaseSync(paths.database);
    old.exec("DROP TABLE decisions_fts; CREATE VIRTUAL TABLE decisions_fts USING fts5(id UNINDEXED, question, selected_option, rationale, context, expected_outcome, outcome, outcome_lesson, project, tags, tokenize='trigram'); INSERT INTO decisions_fts (rowid, id, question, selected_option, rationale, context, expected_outcome, outcome, outcome_lesson, project, tags) SELECT rowid, id, question, selected_option, '', '', '', '', '', project, '' FROM decisions; PRAGMA user_version = 0;");
    old.close();

    const reopened = new SqliteIndex(paths.database);
    expect(reopened.needsRebuild).toBe(true);
    reopened.rebuild([note]);
    expect(reopened.needsRebuild).toBe(false);
    expect(found(reopened, "api")).toEqual([note.id]);
    // The tradeoff of the option not taken.
    expect(found(reopened, "直接阅读不方便")).toEqual([note.id]);
    reopened.close();
  });

  it("keeps the tags the old search rows held, and answers a pasted page of words", async () => {
    const paths = await makePaths();
    const repository = new MarkdownRepository(paths.vault);
    const note = await repository.read((await repository.write(recordFixture({ tags: ["架构"] }))).path);
    const first = new SqliteIndex(paths.database);
    first.upsert(note);
    first.close();
    // As the shipped build left them: no options, the tags in the search rows alone (no other table holds them).
    const old = new DatabaseSync(paths.database);
    old.exec("DROP TABLE decisions_fts; CREATE VIRTUAL TABLE decisions_fts USING fts5(id UNINDEXED, question, selected_option, rationale, context, expected_outcome, outcome, outcome_lesson, project, tags, tokenize='trigram'); INSERT INTO decisions_fts (rowid, id, question, selected_option, rationale, context, expected_outcome, outcome, outcome_lesson, project, tags) SELECT rowid, id, question, selected_option, '', '', '', '', '', project, '架构' FROM decisions; PRAGMA user_version = 0;");
    old.close();

    // The vault's disk not there at this start, the notes are not read again: written blank, a tag found nothing.
    const reopened = new SqliteIndex(paths.database);
    expect(reopened.needsRebuild).toBe(true);
    expect(found(reopened, "架构")).toEqual([note.id]);
    // Each word a clause of its own, a pasted page outgrew SQLite's expression depth and the whole list failed.
    expect(() => found(reopened, Array.from({ length: 1_200 }, (_, index) => `w${index}`).join(" "))).not.toThrow();
    reopened.close();
  });

  it("folds the old search rows it makes again, before the notes are read again", async () => {
    const paths = await makePaths();
    const repository = new MarkdownRepository(paths.vault);
    const note = await repository.read((await repository.write(recordFixture({ question: "ＡＰＩ网关放哪一层？" }))).path);
    const first = new SqliteIndex(paths.database);
    first.upsert(note);
    first.close();
    // As the shipped build left them: raw text, and no options.
    const old = new DatabaseSync(paths.database);
    old.exec("DROP TABLE decisions_fts; CREATE VIRTUAL TABLE decisions_fts USING fts5(id UNINDEXED, question, selected_option, rationale, context, expected_outcome, outcome, outcome_lesson, project, tags, tokenize='trigram'); INSERT INTO decisions_fts (rowid, id, question, selected_option, rationale, context, expected_outcome, outcome, outcome_lesson, project, tags) SELECT rowid, id, question, selected_option, '', '', '', '', '', project, '' FROM decisions; PRAGMA user_version = 0;");
    old.close();

    // The vault's disk not there at this start: written raw again, the full-width word found nothing it had before.
    const reopened = new SqliteIndex(paths.database);
    expect(found(reopened, "ＡＰＩ网关")).toEqual([note.id]);
    expect(found(reopened, "api")).toEqual([note.id]);
    reopened.close();
  });

  it("looks for punctuation typed alone as typed, rather than listing every decision", async () => {
    const paths = await makePaths();
    const repository = new MarkdownRepository(paths.vault);
    const index = new SqliteIndex(paths.database);
    for (const record of [recordFixture({ id: "asks", question: "要不要上 Redis？" }), recordFixture({ id: "plain", question: "缓存策略选型" })]) {
      index.upsert(await repository.read((await repository.write(record)).path));
    }

    // Split away, "？" left no word, and the page said every decision matched.
    expect(found(index, "？")).toEqual(["asks"]);
    expect(found(index, " \u0000 ")).toEqual(expect.arrayContaining(["asks", "plain"]));
    index.close();
  });

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
    expect(index.listByRationaleStatus("captured", 0)).toEqual([]);
    expect(index.idsByRationaleStatus("captured")).toEqual(["018f-example-decision"]);
    expect(index.progressFacts()).toEqual([
      expect.objectContaining({ outcome: parsed.record.outcome === null ? null : "", outcomeVerdict: parsed.record.outcomeReview?.verdict ?? null }),
    ]);
    expect(index.listByRationaleStatus("deferred")).toEqual([]);
    index.close();
  });

  it("keeps each search row at its decision's rowid, and puts rows from before there once", async () => {
    const paths = await makePaths();
    const repository = new MarkdownRepository(paths.vault);
    const index = new SqliteIndex(paths.database);
    const notes = [];
    for (const id of ["decision-a", "decision-b", "decision-c"]) {
      notes.push(await repository.read((await repository.write(recordFixture({ id, question: `${id} 用 storage 还是数据库？` }))).path));
    }
    for (const note of notes) index.upsert(note);
    index.upsert(notes[1]!);
    index.removePath(notes[0]!.path);
    const misaligned = (database: DatabaseSync): number => (database
      .prepare("SELECT count(*) AS n FROM decisions_fts f WHERE NOT EXISTS (SELECT 1 FROM decisions d WHERE d.rowid = f.rowid AND d.id = f.id)")
      .get() as { n: number }).n;
    // Found by an id the search table does not index, each write read the whole table for its row.
    const inspect = new DatabaseSync(paths.database);
    expect(misaligned(inspect)).toBe(0);
    expect(index.search("storage").map((decision) => decision.id).sort()).toEqual(["decision-b", "decision-c"]);

    // A database written before keeps its rows elsewhere: they are put at their rowid when it is opened.
    index.close();
    inspect.exec("DELETE FROM decisions_fts; INSERT INTO decisions_fts (rowid, id, question, selected_option, rationale, context, expected_outcome, outcome, outcome_lesson, project, tags) SELECT rowid + 100, id, question, selected_option, '', '', '', '', '', project, '' FROM decisions;");
    expect(misaligned(inspect)).toBe(2);
    inspect.close();
    const reopened = new SqliteIndex(paths.database);
    const after = new DatabaseSync(paths.database);
    expect(misaligned(after)).toBe(0);
    after.close();
    expect(reopened.search("storage")).toHaveLength(2);
    reopened.close();
  });

  it("reads the newest decisions through an index, not by sorting the whole table", async () => {
    const paths = await makePaths();
    const index = new SqliteIndex(paths.database);
    const inspect = new DatabaseSync(paths.database, { readOnly: true });
    // As listRecent reads each snapshot's twelve, and the library lists them with no filter: every row read
    // and sorted, on every push, at ten thousand decisions.
    for (const sql of [
      "SELECT * FROM decisions ORDER BY created DESC, id DESC LIMIT 12",
      "SELECT d.id, d.question FROM decisions d ORDER BY d.created DESC, d.id DESC LIMIT 50",
    ]) {
      const plan = (inspect.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
        .map((row) => row.detail).join("; ");
      expect(plan).toContain("USING INDEX decisions_created");
      expect(plan).not.toContain("TEMP B-TREE");
    }
    inspect.close();
    index.close();
  });

  it("owes the notes a full read after a migration until one is done, across restarts", async () => {
    const paths = await makePaths();
    const repository = new MarkdownRepository(paths.vault);
    const note = await repository.read((await repository.write(recordFixture())).path);
    const first = new SqliteIndex(paths.database);
    first.upsert(note);
    expect(first.needsRebuild).toBe(false);
    first.close();
    // Search rows from an older app: put at their rowids, their tags owed to a read of the notes.
    const old = new DatabaseSync(paths.database);
    old.exec("DELETE FROM decisions_fts; INSERT INTO decisions_fts (rowid, id, question, selected_option, rationale, context, expected_outcome, outcome, outcome_lesson, project, tags) SELECT rowid + 100, id, question, selected_option, '', '', '', '', '', project, '' FROM decisions;");
    old.close();
    const migrated = new SqliteIndex(paths.database);
    expect(migrated.needsRebuild).toBe(true);
    migrated.close();
    // A start that could not rebuild (the vault not mounted) left it forgotten, and the tags were never read in.
    const next = new SqliteIndex(paths.database);
    expect(next.needsRebuild).toBe(true);
    next.rebuild([note]);
    expect(next.needsRebuild).toBe(false);
    next.close();
    const after = new SqliteIndex(paths.database);
    expect(after.needsRebuild).toBe(false);
    after.close();
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
    // The same instant written with an offset: compared as time, not as text.
    expect(index.countSince("2026-07-26T08:00:00+08:00")).toBe(2);
    expect(
      index
        .queryDecisions({ createdSince: "2026-07-26T08:00:00+08:00" })
        .map(({ id }) => id),
    ).toEqual(["newest", "middle"]);
    expect(
      index.queryDecisions({ project: "decision" }).map(({ id }) => id),
    ).toEqual(["newest", "middle", "oldest"]);
    expect(index.queryDecisions({ project: "other" })).toEqual([]);
    expect(index.snapshotDecisions().map(({ id }) => id)).toEqual([
      "oldest",
      "middle",
      "newest",
    ]);

    // Edited by hand in the vault; the analytics label it by JavaScript's trim.
    const edited = await repository.write(
      recordFixture({
        id: "edited-project",
        created: "2026-07-27T00:00:00.000Z",
        project: "总部Q3　\t",
      }),
    );
    index.upsert(await repository.read(edited.path));
    expect(
      index.queryDecisions({ decisionId: "edited-project" })[0]?.project,
    ).toBe("总部Q3　\t");
    expect(
      index.queryDecisions({ project: "总部Q3" }).map(({ id }) => id),
    ).toEqual(["edited-project"]);
    // The project list groups by the same trim, so each entry filters to its count.
    expect(index.listProjects()).toEqual([
      { project: "decision", count: 3 },
      { project: "总部Q3", count: 1 },
    ]);
    expect(index.listProjects(1)).toEqual([{ project: "decision", count: 3 }]);
    // Cleared in the note's properties: the analytics count it as 未命名项目,
    // and browsing that name from them lists it.
    const blank = await repository.write(
      recordFixture({ id: "blank-project", created: "2026-07-27T01:00:00.000Z", project: "　" }),
    );
    index.upsert(await repository.read(blank.path));
    expect(
      index.queryDecisions({ project: "未命名项目" }).map(({ id }) => id),
    ).toEqual(["blank-project"]);
    index.removePath(blank.path);

    // Waiting for an expectation: none written yet, and no outcome to restate.
    for (const record of [
      recordFixture({ id: "expecting", created: "2026-07-28T00:00:00.000Z", expectedOutcome: "错误率不升。" }),
      recordFixture({ id: "concluded", created: "2026-07-29T00:00:00.000Z", outcome: "已经上线。" }),
    ]) {
      const note = await repository.write(record);
      index.upsert(await repository.read(note.path));
    }
    const missing = index
      .queryDecisions({ reviewState: "expectation_missing" })
      .map(({ id }) => id);
    expect(missing).toContain("newest");
    expect(missing).not.toContain("expecting");
    expect(missing).not.toContain("concluded");
    index.close();
  });

  it("marks a decision carried over from rows owed a full read as unread, so its note is read whole once it is back", async () => {
    const paths = await makePaths();
    const repository = new MarkdownRepository(paths.vault);
    const note = await repository.write(recordFixture());
    const index = new SqliteIndex(paths.database);
    index.upsert(await repository.read(note.path));
    // An index from before columns it now has, filled in from nothing: the notes are owed a full read.
    const raw = new DatabaseSync(paths.database);
    raw.exec("PRAGMA user_version = 1");
    raw.close();

    // Its note moved off this Mac by iCloud meanwhile: carried over as it stands.
    index.rebuild([], [note.path]);

    // Carried with its hash, the note read as unchanged once it was back, and its new columns stayed empty for good.
    expect(index.findDecisions([recordFixture().id])[0]?.contentHash).toBe("");
    expect(index.needsRebuild).toBe(false);
    index.close();
  });

  it("reads only the decisions that applied a principle, for its usage", async () => {
    const paths = await makePaths();
    const repository = new MarkdownRepository(paths.vault);
    const index = new SqliteIndex(paths.database);
    for (const [id, applied] of [["applied-twice", ["principle-1", "principle-2"]], ["applied-other", ["principle-2"]], ["applied-none", []], ["applied-once", ["principle-1"]]] as const) {
      const note = await repository.write(recordFixture({ id, appliedPrincipleIds: [...applied] }));
      index.upsert(await repository.read(note.path));
    }

    expect(index.decisionsApplying("principle-1").map(({ id }) => id).sort()).toEqual(["applied-once", "applied-twice"]);
    // A principle id is matched whole, not as part of another.
    expect(index.decisionsApplying("principle")).toEqual([]);
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

    // The first by its question, the other by the tradeoff its options list (需要额外索引).
    expect(
      index.queryDecisions({
        query: "索引",
        rationaleStatus: "captured",
        sourceClient: "codex",
      }).map(({ id }) => id),
    ).toEqual(["captured-codex", "reviewed-codex"]);
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
      index.queryDecisions({ outcomeVerdict: "as_expected" }).map(({ id }) => id),
    ).toEqual(["reviewed-codex"]);
    expect(index.queryDecisions({ outcomeVerdict: "worse" })).toEqual([]);
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

  it("indexes and finds a manual decision by semantic key", async () => {
    const paths = await makePaths();
    const repository = new MarkdownRepository(paths.vault);
    const note = await repository.write(
      recordFixture({
        id: "manual-1",
        sourceClient: "manual",
        captureSemanticKey: "manual-semantic-1",
        expectedOutcome: "减少低价值打断",
      }),
    );
    const index = new SqliteIndex(paths.database);
    index.upsert(await repository.read(note.path));

    expect(index.findByCaptureSemanticKey("manual-semantic-1")).toEqual(
      expect.objectContaining({
        id: "manual-1",
        expectedOutcome: "减少低价值打断",
      }),
    );
    expect(index.search("低价值打断")).toEqual([
      expect.objectContaining({ id: "manual-1" }),
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

  it("lists the newest due reviews first, so a backlog never crowds out one just come due", async () => {
    const paths = await makePaths();
    const repository = new MarkdownRepository(paths.vault);
    const index = new SqliteIndex(paths.database);
    for (const [id, due] of [["due-oldest", "2026-09-20"], ["due-middle", "2026-09-21"], ["due-newest", "2026-09-22"]] as const) {
      const note = await repository.write(recordFixture({ id, question: `${id} 的问题`, reviewDueDate: due }));
      index.upsert(await repository.read(note.path));
    }

    // Two slots, three due: the one that came due today is among them, not left for a backlog to clear.
    expect(index.listReviewDue("2026-09-22", 2).map((decision) => decision.id)).toEqual(["due-newest", "due-middle"]);
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

  it("rebuilds thousands of notes in time growing with their number, one full-text row even for an id given twice", async () => {
    const paths = await makePaths();
    const note = (id: string, path: string, question: string) => ({
      id, path, contentHash: `hash-${path}`, record: recordFixture({ id, question }),
    });
    // The same id under two files (a copy): it is still one row, found once.
    const notes = [note("018f-twice", "/vault/a.md", "第一份 copy 决策"), note("018f-twice", "/vault/b.md", "第二份 copy 决策")];
    for (let index = 0; index < 6_000; index += 1) {
      notes.push(note(`018f-n-${index}`, `/vault/n-${index}.md`, `第 ${index} 个决策`));
    }
    const index = new SqliteIndex(paths.database);

    const started = performance.now();
    index.rebuild(notes);

    // Looking each id up in the unindexed full-text table first took near five seconds at this size.
    expect(performance.now() - started).toBeLessThan(2_500);
    expect(index.count()).toBe(6_001);
    expect(index.search("copy")).toEqual([expect.objectContaining({ id: "018f-twice", question: "第二份 copy 决策" })]);
    index.close();
  });

  it("gives every decision for ranking by meaning, while a list still stops at 200", async () => {
    const paths = await makePaths();
    const index = new SqliteIndex(paths.database);
    index.rebuild(Array.from({ length: 250 }, (_, at) => ({
      id: `018f-${at}`, path: `/vault/${at}.md`, contentHash: `hash-${at}`,
      record: recordFixture({ id: `018f-${at}`, question: `第 ${at} 个决策` }),
    })));

    expect(index.queryDecisions({ limit: 500 })).toHaveLength(200);
    // Ranked among the newest 200 only, an older decision could not be found by meaning at all.
    expect(index.queryDecisions({ everything: true })).toHaveLength(250);
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

  // A full disk, a permission or a lock says nothing of the index: it is kept, and the failure passed on.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("keeps a whole index it cannot open for another reason", async () => {
    const paths = await makePaths();
    const repository = new MarkdownRepository(paths.vault);
    const healthy = new SqliteIndex(paths.database);
    healthy.upsert(await repository.read((await repository.write(recordFixture())).path));
    healthy.close();
    await chmod(paths.database, 0o400);

    expect(() => new SqliteIndex(paths.database)).toThrow(/EACCES/u);
    expect((await readdir(join(paths.database, ".."))).filter((name) => name.includes(".corrupt-"))).toEqual([]);

    await chmod(paths.database, 0o600);
    const reopened = new SqliteIndex(paths.database);
    expect(reopened.count()).toBe(1);
    reopened.close();
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
