import { describe, expect, it } from "vitest";

import { allowance, charge, DEFAULT_BUDGET, emptyLedger, independentEvidence, isVagueNote, recheckOf, reopenReason, suggestionId } from "../src/main/organization-core.js";

describe("independent evidence", () => {
  it("counts a decision and three restatements of it once, and statements not at all", () => {
    const decision = { role: "observation" as const, rootKeys: ["decision:D1"] };
    const restatements = [1, 2, 3].map(() => ({ role: "derived" as const, rootKeys: ["decision:D1"] }));
    expect(independentEvidence([decision, ...restatements])).toBe(1);
    expect(independentEvidence([{ role: "statement", rootKeys: ["preference:P1"] }, { role: "statement", rootKeys: ["idea:I1"] }])).toBe(0);
  });

  it("counts two independent findings twice though an experience cites both", () => {
    expect(independentEvidence([
      { role: "observation", rootKeys: ["todo_item:L#1"] },
      { role: "observation", rootKeys: ["todo_item:L#2"] },
      { role: "derived", rootKeys: ["todo_item:L#1", "todo_item:L#2"] },
    ])).toBe(2);
  });

  it("lets the model merge roots, never split them", () => {
    const sources = [{ role: "observation" as const, rootKeys: ["todo_item:L#1"] }, { role: "observation" as const, rootKeys: ["todo_item:L#2"] }];
    expect(independentEvidence(sources)).toBe(2);
    expect(independentEvidence(sources, [["todo_item:L#1", "todo_item:L#2"]])).toBe(1);
    // An item moved from another list is the same finding.
    expect(independentEvidence([{ role: "observation", rootKeys: ["todo_item:A#3"] }, { role: "observation", rootKeys: ["todo_item:A#3"] }])).toBe(1);
  });
});

describe("reopening a rejected suggestion", () => {
  const label = (key: string) => key;
  it("stays rejected on the same evidence, whatever else changed", () => {
    expect(reopenReason({ "todo_item:L#1": "a" }, [{ key: "todo_item:L#1", evidenceFingerprint: "a", role: "observation" }], label)).toBeNull();
    // A derived source (a summary, a candidate) is no new evidence.
    expect(reopenReason({ "todo_item:L#1": "a" }, [{ key: "todo_item:L#1", evidenceFingerprint: "a", role: "observation" }, { key: "summary:S", evidenceFingerprint: "b", role: "derived" }], label)).toBeNull();
  });

  it("reopens on a new source or changed substance, saying which", () => {
    expect(reopenReason({ "todo_item:L#1": "a" }, [{ key: "todo_item:L#1", evidenceFingerprint: "a", role: "observation" }, { key: "todo_item:L#2", evidenceFingerprint: "c", role: "observation" }], label)).toBe("新增来源：todo_item:L#2");
    expect(reopenReason({ "todo_item:L#1": "a" }, [{ key: "todo_item:L#1", evidenceFingerprint: "z", role: "observation" }], label)).toBe("内容已改变：todo_item:L#1");
  });

  it("keeps one identity for a suggestion whatever its words or model", () => {
    expect(suggestionId("experience", "P", ["todo_item:L#1"])).toBe(suggestionId("experience", "P", ["todo_item:L#1"]));
    expect(suggestionId("conflict", "P", ["decision:a", "preference:b"])).toBe(suggestionId("conflict", "P", ["preference:b", "decision:a"]));
    expect(suggestionId("conflict", "P", ["decision:a", "preference:b"])).not.toBe(suggestionId("conflict", "P", ["summary:a", "preference:b"]));
  });
});

describe("deterministic hints", () => {
  it("takes a bare 「已处理」 for no result", () => {
    expect(isVagueNote("已处理")).toBe(true);
    expect(isVagueNote("done")).toBe(true);
    expect(isVagueNote(null)).toBe(true);
    expect(isVagueNote("在测试环境重试 50 次未再重复")).toBe(false);
  });

  it("asks to reconsider an overdue or long-untouched open item, never a finished one", () => {
    expect(recheckOf({ status: "open", due: "2026-11-02", lastChangedAt: "2026-11-10T00:00:00Z" }, "2026-11-11")).toEqual({ reason: "overdue", days: 9 });
    expect(recheckOf({ status: "open", due: null, lastChangedAt: "2026-10-01T00:00:00Z" }, "2026-11-11")).toEqual({ reason: "untouched", days: 41 });
    expect(recheckOf({ status: "done", due: "2026-11-02", lastChangedAt: "2026-10-01T00:00:00Z" }, "2026-11-11")).toBeNull();
  });
});

describe("budget", () => {
  it("does not send a call the input would overrun, and caps its output at what is left", () => {
    const used = { ...emptyLedger(), reportedOutputTokens: 2_500, reportedInputTokens: 1_000 };
    expect(allowance(DEFAULT_BUDGET, used, 1_000, 900, 0, 0)).toEqual({ maxOutputTokens: 500 });
    expect(allowance(DEFAULT_BUDGET, used, 11_500, 900, 0, 0)).toEqual({ stop: "budget" });
    expect(allowance(DEFAULT_BUDGET, { ...emptyLedger(), reportedOutputTokens: 2_900 }, 100, 900, 0, 0)).toEqual({ stop: "budget" });
    expect(allowance(DEFAULT_BUDGET, { ...emptyLedger(), calls: 8 }, 100, 900, 0, 0)).toEqual({ stop: "calls" });
    expect(allowance(DEFAULT_BUDGET, emptyLedger(), 100, 900, 0, 120_000)).toEqual({ stop: "time" });
  });

  it("keeps reported and estimated use apart, a failed call and a retry counted in the same total", () => {
    let ledger = charge(emptyLedger(), { ok: false, retry: false, promptChars: 2_000, maxOutputTokens: 900 });
    ledger = charge(ledger, { ok: true, retry: true, promptChars: 2_000, maxOutputTokens: 900, usage: { inputTokens: 1_700, outputTokens: 300 } });
    expect(ledger).toEqual({ calls: 2, failedCalls: 1, retries: 1, reportedInputTokens: 1_700, reportedOutputTokens: 300, estimatedInputTokens: 2_000, estimatedOutputTokens: 900 });
  });
});


it("来源日期不把非法日期滚动成另一天，也不猜测未知格式", async () => {
  const { shortDate } = await import("../src/renderer/components/pages/organization/organization-text.js");
  expect(shortDate("2026-09-01")).toBe("9 月 1 日");
  for (const value of ["2026-02-30", "11/31/2026", "日期待核实"]) expect(shortDate(value)).toBe(value);
});
