import { CaptureSpool, DecisionStore, JournalEntryRepository, LocalDecisionStore, MarkdownRepository, SqliteIndex } from "@cognelis/decision-storage";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ActiveRecordService } from "../src/main/active-record-service.js";
import { CaptureRuntime } from "../src/main/capture-runtime.js";
import { serverCaptureFixture } from "./fixtures.js";
import { DecisionAnalyticsService } from "../src/main/decision-analytics-service.js";

// Synthetic records, written for these tests (IMP-123).
const base = {
  recordVersion: 1 as const,
  sourceClient: "codex" as const,
  sourceKind: "agent_capture" as const,
  sourceForm: "machine_summary" as const,
  sensitivity: "private" as const,
  project: "decision",
  tags: [],
};

const setup = async () => {
  const vault = await mkdtemp(join(tmpdir(), "review-schedule-"));
  const repository = new MarkdownRepository(vault);
  const index = new SqliteIndex(join(vault, "index.sqlite"));
  const journal = new JournalEntryRepository(vault);
  let id = 0;
  const service = new ActiveRecordService({
    decisionStore: new DecisionStore(repository, index),
    decisionIndex: index,
    journalRepository: journal,
    idFactory: () => `record-${++id}`,
    clock: () => new Date(2026, 9, 21, 10),
  });
  return { vault, repository, index, journal, service };
};

describe("default review schedule, as written through the app", () => {
  it("schedules a release decision two weeks on and lists it once due, an ordinary one never", async () => {
    const { index, service } = await setup();
    await service.create({ ...base, requestId: "r-1", kind: "decision", title: "新版 bridge 什么时候发版？", content: "周五灰度，周一全量上线", options: [] });
    await service.create({ ...base, requestId: "r-2", kind: "decision", title: "列表按钮放左边还是右边？", content: "右边", options: [] });

    const [release] = index.queryDecisions({ decisionId: "record-1" });
    const [plain] = index.queryDecisions({ decisionId: "record-2" });
    expect(release).toMatchObject({ reviewDueDate: "2026-11-04", reviewScheduleReasons: ["release"] });
    expect(plain).toMatchObject({ reviewDueDate: null, reviewScheduleReasons: [] });

    const inbox = (now: Date) => new DecisionAnalyticsService(() => now)
      .analyze([release!, plain!]).then((snapshot) => snapshot.retrospective.reviewAttention);
    expect(await inbox(new Date(2026, 10, 3, 12))).toBe(0);
    expect(await inbox(new Date(2026, 10, 4, 9))).toBe(1);
    index.close();
  });

  it("never schedules a preference or an idea, whatever it mentions", async () => {
    const { vault, service } = await setup();
    await service.create({ ...base, requestId: "r-3", kind: "preference", title: "发版前先灰度", content: "上线先灰度 10%。", appliesWhen: "发布新版本时。" });
    await service.create({ ...base, requestId: "r-4", kind: "idea", title: "数据库选型试 SQLite", content: "下次架构调整时试试。", whyInteresting: "可能更轻。", openQuestions: [] });
    expect(await service.listJournalEntries()).toHaveLength(2);
    const notes = (await readdir(vault, { recursive: true })).filter((path) => path.endsWith(".md"));
    expect(notes).toHaveLength(2);
    for (const note of notes) {
      expect(await readFile(join(vault, note), "utf8")).not.toMatch(/review_due_date|review_schedule/u);
    }
  });

  it("keeps the date an agent gave, and does not schedule notes already in the vault when the index is rebuilt", async () => {
    const { repository, index, service } = await setup();
    await service.create({ ...base, requestId: "r-5", kind: "decision", title: "数据库用 PostgreSQL 还是 SQLite？", content: "SQLite", reviewDueDate: "2026-12-01", options: [] });
    expect(index.queryDecisions({ decisionId: "record-1" })[0]).toMatchObject({ reviewDueDate: "2026-12-01", reviewScheduleReasons: [] });

    const { recordFixture } = await import("../../../packages/storage/test/fixtures.js");
    await repository.write(recordFixture({ id: "old-1", question: "今天发版吗？", expectedOutcome: "周五前可用" }));
    await new DecisionStore(repository, index).rebuildIndex();
    expect(index.queryDecisions({ decisionId: "old-1" })[0]).toMatchObject({ reviewDueDate: null, reviewScheduleReasons: [] });
    index.close();
  });

  it("schedules a decision captured in a conversation when its rationale is submitted", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-schedule-capture-"));
    const repository = new MarkdownRepository(join(root, "vault"));
    const index = new SqliteIndex(join(root, "index.sqlite"));
    const spool = new CaptureSpool(join(root, "spool"));
    let sequence = 0;
    const runtime = new CaptureRuntime({
      spool, store: new DecisionStore(repository, index), index,
      idFactory: () => `id-${++sequence}`, now: () => new Date(2026, 9, 21, 10),
    });
    const capturedAt = new Date(2026, 9, 21, 9).toISOString();
    const question = (index: number, text: string, answer: string) => ({
      questionIndex: index, header: "Plan", question: text, multiSelect: false,
      options: [{ label: answer }, { label: "再等等" }],
      answer: { kind: "preset" as const, values: [answer] },
    });
    for (const [n, text, answer] of [[1, "这个按钮放哪？", "右边"], [2, "列表默认怎么排序？", "按时间"]] as const) {
      const event = serverCaptureFixture({ sourceEventId: `event-${n}`, toolUseId: `tool-${n}`, batchId: `test:server-test:tool-${n}`, capturedAt, questions: [question(0, text, answer)] });
      await spool.append(event);
      await runtime.ingest(event);
    }
    // Written in the rationale panel while the choice is fresh: scheduled for that, the question being an ordinary one.
    await runtime.queue.submit({ status: "captured", rationale: "离手近", expectedOutcome: "误触变少" });
    await runtime.queue.submit({ status: "captured", rationale: "最常用" });

    const notes = (await repository.scan()).notes.map((note) => note.record).sort((a, b) => a.question.localeCompare(b.question));
    expect(notes.map((record) => [record.question, record.reviewDueDate, record.reviewScheduleReasons])).toEqual([
      ["列表默认怎么排序？", null, undefined],
      ["这个按钮放哪？", "2026-11-04", ["expected_outcome"]],
    ]);
    index.close();
  });

  it("keeps the schedule through a deferred note kept locally and published again", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-schedule-local-"));
    const local = new LocalDecisionStore(join(root, "local-decisions.sqlite"));
    const index = new SqliteIndex(join(root, "index.sqlite"));
    const repository = new MarkdownRepository(join(root, "vault"));
    const store = new DecisionStore(repository, index);
    const { recordFixture } = await import("../../../packages/storage/test/fixtures.js");
    const record = recordFixture({
      status: "deferred_rationale", rationaleStatus: "deferred", rationaleOriginal: null, reasonFactors: [],
      question: "今天发版吗？", reviewDueDate: "2026-11-04", reviewScheduleReasons: ["release"],
    });
    await store.save(record);
    await store.keepDeferredLocally(record.id, local, { rationale: "先留在本机" });
    expect(local.get(record.id)).toMatchObject({ reviewDueDate: "2026-11-04", reviewScheduleReasons: ["release"] });

    const published = await store.publishLocal(local.get(record.id)!, local.content(record.id) ?? undefined);
    expect((await repository.read(published.note.path)).record).toMatchObject({ reviewDueDate: "2026-11-04", reviewScheduleReasons: ["release"] });
    expect(index.queryDecisions({ decisionId: record.id })[0]).toMatchObject({ reviewDueDate: "2026-11-04", reviewScheduleReasons: ["release"] });
    local.close();
    index.close();
  });
});
