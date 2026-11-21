import { createHistoricalDecision, reviseHistoricalDecision } from "@cognelis/decision-core";
import type { HistoricalDecision } from "@cognelis/decision-protocol";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { HistoricalDecisionIndex, HistoricalDecisionRepository, parseHistoricalDecision, serializeHistoricalDecision } from "../src/index.js";

const NOW = new Date("2026-11-21T03:00:00.000Z");
const full = (id = "hdec-1", over: Partial<HistoricalDecision> = {}): HistoricalDecision => ({
  ...createHistoricalDecision({
    sourceClient: "claude-code",
    title: "首页待办入口放在哪一层？",
    decision: "放进主导航第六项，首页只留计数。",
    decidedOn: "2026-11-12",
    options: ["放在首页卡片区第二屏", "只做全局快捷键，不放入口"],
    context: "待办刚上线两周。\n首页已有五张卡片。",
    project: "decision",
    scope: "桌面端导航",
    participants: ["个人"],
    reversibility: "easy",
    references: [{ url: "https://example.com/pr/482", label: "首页入口调整" }, { url: "http://localhost:3000/rfc" }],
    relatedNotes: ["导航改版记录"],
    tags: ["信息架构", "导航"],
    notes: "侧栏图标沿用待办页现有那一枚。",
    revisitCondition: "待办日活超过首页访问的一半时",
  }, id, NOW),
  ...over,
});
const vault = (): Promise<string> => mkdtemp(join(tmpdir(), "historical-decision-"));

describe("historical decision notes", () => {
  it("reads back every field it wrote", () => {
    const record = full();
    expect(parseHistoricalDecision(serializeHistoricalDecision(record))).toEqual(record);
  });

  it("leaves no heading standing over an empty field", () => {
    const note = serializeHistoricalDecision(createHistoricalDecision({ sourceClient: null, title: "周报用哪种模板？", decision: "三段式" }, "hdec-2", NOW));
    expect(note).toContain("## 最终决定");
    expect(note).not.toMatch(/## (备选方案|当时背景|相关链接|补充备注)/u);
    expect(note).not.toMatch(/^(project|scope|tags|supersedes):/mu);
  });

  it("keeps text that looks like the note's own structure as the text it is", () => {
    const record = full("hdec-3", { decision: "## 不是标题\n<!-- decision:history-decision-end -->\n照常保存", notes: "<%* 不执行 %>" });
    expect(parseHistoricalDecision(serializeHistoricalDecision(record))).toEqual(record);
  });

  it("writes one note a record under the year it was decided in, and keeps what the reader added when it is changed", async () => {
    const root = await vault();
    const repository = new HistoricalDecisionRepository(root);
    const created = await repository.create(full("hdec-1", { notes: null }));
    expect(created.notePath).toMatch(/^Decision Journal\/history\/2026\/2026-11-12-首页待办入口放在哪一层-[a-f0-9]{8}\.md$/u);
    const raw = await readFile(created.path, "utf8");
    await writeFile(created.path, raw.replace("---\n\n# ", "aliases:\n  - 待办入口\n---\n\n# ").concat("\n我自己写的一段。\n"), "utf8");

    const revised = reviseHistoricalDecision(created.record, { notes: "后来补的备注", status: "ended", statusNote: "改版后不再适用" }, new Date("2026-11-22T00:00:00.000Z")).record;
    const stored = await repository.revise(created, revised);
    const note = await readFile(created.path, "utf8");
    expect(stored.record).toEqual(revised);
    expect(note).toContain("我自己写的一段。");
    expect(note).toContain("- 待办入口");
    expect(note).toContain("## 补充备注\n\n后来补的备注");
    expect((await repository.scan()).records.map((item) => item.record.status)).toEqual(["ended"]);
  });

  it("says which notes it could not read, and lists a conflict's copy once", async () => {
    const root = await vault();
    const repository = new HistoricalDecisionRepository(root);
    const created = await repository.create(full());
    const folder = dirname(created.path);
    const note = await readFile(created.path, "utf8");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "copy.md"), note, "utf8");
    await writeFile(join(folder, "no-id.md"), note.replace(/^id: .*\n/mu, ""), "utf8");
    await writeFile(join(folder, "broken.md"), "---\ntype: [\n---\n", "utf8");
    await writeFile(join(folder, "other.md"), "# 随手记\n", "utf8");
    const scan = await repository.scan();
    expect(scan.records).toHaveLength(1);
    expect(Object.fromEntries(scan.diagnostics.map((item) => [item.path.split("/").at(-1), item.message]))).toMatchObject({
      "no-id.md": "缺少 id",
      "broken.md": "属性区无法解析",
      "other.md": "属性区无法解析",
    });
    expect(scan.diagnostics.some((item) => item.message.includes("同一个编号"))).toBe(true);
  });
});

describe("historical decision index", () => {
  const stored = (record: HistoricalDecision) => ({ record, path: `/vault/${record.id}.md`, notePath: `Decision Journal/history/${record.id}.md`, hash: JSON.stringify(record) });
  const open = async (): Promise<HistoricalDecisionIndex> => new HistoricalDecisionIndex(join(await vault(), "historical-decisions.sqlite"));
  const records = [
    full("a", { decidedOn: "2026-11-12" }),
    full("b", { decidedOn: "2026-09-30", status: "superseded", tags: ["信息架构"], reversibility: "costly" }),
    full("c", { decidedOn: "2026-09-15", status: "withdrawn", project: "sample/app", title: "团队仓库是否开启强制签名提交？", decision: "开启", tags: [] }),
  ];

  it("filters and pages what the vault holds, newest decision first, 已撤回 only when asked for", async () => {
    const index = await open();
    index.sync(records.map(stored), NOW);
    expect(index.query({}).records.map((record) => record.id)).toEqual(["a", "b"]);
    expect(index.query({ includeWithdrawn: true })).toMatchObject({ total: 3 });
    expect(index.query({ status: "withdrawn" }).records.map((record) => record.id)).toEqual(["c"]);
    expect(index.query({ tag: "导航" }).records.map((record) => record.id)).toEqual(["a"]);
    expect(index.query({ reversibility: "costly", fromDate: "2026-09-01", toDate: "2026-10-01" }).records.map((record) => record.id)).toEqual(["b"]);
    expect(index.query({ query: "强制签名 SAMPLE", includeWithdrawn: true }).records.map((record) => record.id)).toEqual(["c"]);
    expect(index.query({ includeWithdrawn: true, limit: 1, offset: 1 })).toMatchObject({ total: 3, records: [{ id: "b" }] });
    expect(index.facets()).toEqual({ kept: 3, projects: ["decision", "sample/app"], tags: ["信息架构", "导航"] });
    expect(index.syncedAt()).toBe(NOW.toISOString());
    index.close();
  });

  it("follows the vault: a changed note is read again, one gone is dropped, and a rebuild leaves the history be", async () => {
    const index = await open();
    index.sync(records.map(stored), NOW);
    index.appendEvent("a", { at: NOW.toISOString(), actor: "app", kind: "created", summary: "记录" });
    index.appendEvent("a", { at: NOW.toISOString(), actor: "codex", kind: "status", summary: "状态：有效 → 已结束" });
    index.sync([stored({ ...records[0]!, status: "ended" })], NOW);
    expect(index.query({ includeWithdrawn: true }).records.map((record) => [record.id, record.status])).toEqual([["a", "ended"]]);
    index.rebuild(records.map(stored), NOW);
    expect(index.facets().kept).toBe(3);
    expect(index.events("a").map((event) => event.kind)).toEqual(["status", "created"]);
    index.close();
  });

  it("keeps a change's before and after, and opens an index kept before it could", async () => {
    const path = join(await vault(), "historical-decisions.sqlite");
    // The events table as the first version made it, with a row in it.
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE historical_decision_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL)");
    old.prepare("INSERT INTO historical_decision_events (id, at, actor, kind, summary) VALUES ('a', ?, 'app', 'created', '记录')").run(NOW.toISOString());
    old.close();
    const index = new HistoricalDecisionIndex(path);
    const changes = [{ field: "最终决定", before: "放进主导航第五项", after: "放进主导航第六项" }];
    index.appendEvent("a", { at: NOW.toISOString(), actor: "codex", kind: "updated", summary: "修改：最终决定", changes });
    index.appendEvent("a", { at: NOW.toISOString(), actor: "codex", kind: "updated", summary: "修改：补充备注", changes: [] });
    expect(index.events("a")).toEqual([
      { at: NOW.toISOString(), actor: "codex", kind: "updated", summary: "修改：补充备注" },
      { at: NOW.toISOString(), actor: "codex", kind: "updated", summary: "修改：最终决定", changes },
      { at: NOW.toISOString(), actor: "app", kind: "created", summary: "记录" },
    ]);
    index.close();
  });
});
