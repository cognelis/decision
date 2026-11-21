import { describe, expect, it } from "vitest";

import { createHistoricalDecision, historicalChangeSummary, historicalDecisionKey, reviseHistoricalDecision, supersedesLoop } from "../src/index.js";

const NOW = new Date(2026, 10, 21, 9, 30);
const base = { sourceClient: null, title: "首页待办入口放在哪一层？", decision: "放进主导航第六项" } as const;

describe("historical decision", () => {
  it("needs only the matter and the decision: today, in the App, active", () => {
    const record = createHistoricalDecision(base, "hdec-1", NOW);
    expect(record).toMatchObject({ decidedOn: "2026-11-21", sourceKind: "app_manual", status: "active", revision: 1, options: [], context: null, supersedesId: null, promotedDecisionId: null });
  });

  it("keeps one of each tag and participant, links related notes as Obsidian does, and takes an agent's as captured", () => {
    const record = createHistoricalDecision({ ...base, sourceClient: "codex", tags: ["导航", "导航"], participants: ["个人", "个人"], relatedNotes: ["notes/导航改版记录.md", "[[待办上线复盘]]"] }, "hdec-1", NOW);
    expect(record).toMatchObject({ sourceKind: "agent_capture", tags: ["导航"], participants: ["个人"], relatedNotes: ["[[notes/导航改版记录]]", "[[待办上线复盘]]"] });
  });

  it("is the same record when matter, decision, project and day read the same", () => {
    const one = createHistoricalDecision({ ...base, project: "Decision" }, "a", NOW);
    const again = createHistoricalDecision({ ...base, title: " 首页待办入口放在哪一层？ ", project: "decision" }, "b", NOW);
    expect(historicalDecisionKey(again)).toBe(historicalDecisionKey(one));
    expect(historicalDecisionKey({ ...again, decidedOn: "2026-11-20" })).not.toBe(historicalDecisionKey(one));
  });

  it("advances the revision and names what changed; a change that changes nothing leaves it as it was", () => {
    const current = createHistoricalDecision(base, "hdec-1", NOW);
    const revised = reviseHistoricalDecision(current, { scope: "桌面端导航", notes: null, status: "ended", statusNote: "试行结束" }, new Date(2026, 10, 22));
    expect(revised.changed).toEqual(["影响范围", "状态说明", "状态：有效 → 已结束"]);
    expect(revised.record).toMatchObject({ revision: 2, scope: "桌面端导航", status: "ended", statusNote: "试行结束" });
    expect(reviseHistoricalDecision(current, { title: current.title, tags: [] }, NOW)).toEqual({ record: current, changed: [], changes: [] });
  });

  it("keeps what each rewritten field read before and after, as a person reads it, and says the change in one line", () => {
    const current = createHistoricalDecision({ ...base, options: ["放在首页"], reversibility: "easy" }, "hdec-1", NOW);
    const revised = reviseHistoricalDecision(current, {
      decision: "放进主导航第五项", options: ["放在首页", "只做快捷键"], reversibility: "costly", context: "首页已满",
      references: [{ url: "https://example.com/pr/482", label: "PR 482" }], supersedesId: "hdec-0",
    }, NOW);
    expect(revised.changes).toEqual([
      { field: "最终决定", before: "放进主导航第六项", after: "放进主导航第五项" },
      { field: "备选方案", before: "放在首页", after: "放在首页、只做快捷键" },
      { field: "当时背景", before: "", after: "首页已满" },
      { field: "可逆性", before: "易回退", after: "改动成本高" },
      { field: "相关链接", before: "", after: "PR 482（https://example.com/pr/482）" },
    ]);
    // The record it replaces is in the line, not as an id among the fields.
    expect(historicalChangeSummary(revised.changed)).toBe("修改：最终决定、备选方案、当时背景、可逆性、相关链接、替代关系");
    const ended = reviseHistoricalDecision(current, { status: "ended", statusNote: "试行结束" }, NOW);
    expect(historicalChangeSummary(ended.changed)).toBe("状态：有效 → 已结束");
    expect(ended.changes).toEqual([{ field: "状态说明", before: "", after: "试行结束" }]);
    expect(historicalChangeSummary(reviseHistoricalDecision(current, { notes: "补一句" }, NOW, { promotedDecisionId: "d-1" }).changed)).toBe("转为正式决策；修改：补充备注");
  });

  it("refuses a chain of replacements that would come back to where it started", () => {
    const records = new Map([["a", { supersedesId: null }], ["b", { supersedesId: "a" }], ["c", { supersedesId: "b" }]]);
    expect(supersedesLoop(records, "a", "c")).toBe(true);
    expect(supersedesLoop(records, "a", "a")).toBe(true);
    expect(supersedesLoop(records, "d", "c")).toBe(false);
  });
});
