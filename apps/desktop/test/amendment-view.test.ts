import type { AmendmentState } from "@cognelis/decision-protocol";
import { describe, expect, it } from "vitest";

import { rememberClients } from "../src/renderer/client-labels.js";
import { changedPart, clientLabel, historyDays, monthDayLabel, restoreRequest, rewriteInForce, stampLabel } from "../src/renderer/components/pages/decisions/amendment-view.js";

const state = (over: Partial<AmendmentState> = {}): AmendmentState => ({
  revision: 3, relativePath: "x.md", amendments: [], withdrawn: null,
  revised: { fields: ["appliesWhen"], values: { appliesWhen: "新条件" }, at: "2026-11-11T10:28:00", client: "Codex", reason: "r", stale: false },
  history: [
    { revision: 1, at: "2026-11-08T16:02:00", client: "Claude Code", action: "append", reason: null, before: null, basis: "user_confirmed" },
    { revision: 2, at: "2026-11-11T10:20:00", client: "Codex", action: "revise", reason: "第一次", before: { appliesWhen: "旧条件" }, basis: null },
    { revision: 3, at: "2026-11-11T10:28:00", client: "Codex", action: "revise", reason: "第二次", before: { appliesWhen: "中间条件" }, basis: null },
  ],
  ...over,
});

describe("changedPart", () => {
  it("marks what lies between the text both share at each end", () => {
    expect(changedPart("不可逆的发布步骤要先有回滚路径。", "不可逆的发布步骤要先有回滚路径；数据库迁移要先演练。")).toEqual({ prefix: "不可逆的发布步骤要先有回滚路径", changed: "；数据库迁移要先演练", suffix: "。" });
    expect(changedPart("同一句", "同一句")).toEqual({ prefix: "同一句", changed: "", suffix: "" });
    expect(changedPart("", "新")).toEqual({ prefix: "", changed: "新", suffix: "" });
  });
});

describe("rewriteInForce", () => {
  it("is none when stale, and the values otherwise", () => {
    expect(rewriteInForce(state())).toEqual({ appliesWhen: "新条件" });
    expect(rewriteInForce(state({ revised: { ...state().revised!, stale: true } }))).toBeNull();
    expect(rewriteInForce(undefined)).toBeNull();
  });
});

describe("historyDays", () => {
  it("groups by day, newest first, a rewrite with before and after and what puts it back", () => {
    const days = historyDays("decisions", state(), "2026-11-11");
    expect(days.map((day) => day.label)).toEqual(["今天", "11 月 8 日 周日"]);
    const [latest, earlier] = days[0]!.events;
    expect(latest).toMatchObject({ what: "改写「适用条件」", reason: "第二次", restoreTo: { appliesWhen: "中间条件" }, diff: [{ label: "适用条件", before: "中间条件", after: "新条件" }] });
    // The one before it: replaced by the next one's before.
    expect(earlier!.diff).toEqual([{ label: "适用条件", before: "旧条件", after: "中间条件" }]);
    expect(days[1]!.events[0]).toMatchObject({ what: "增补一段（用户认可）", who: "Claude Code", diff: [], restoreTo: null });
  });

  it("names a preference's fields as its page does, and keeps the reader's own revisions among them", () => {
    const own = [{ at: "2026-11-09T09:00:00", what: "修订 v2", reason: "改了措辞" }];
    const days = historyDays("preferences", state(), "2026-11-11", own);
    expect(days.flatMap((day) => day.events).find((row) => row.who === "我")).toMatchObject({ what: "修订 v2", reason: "改了措辞" });
    expect(days[0]!.events[0]!.what).toBe("改写「适用条件」");
  });

  it("says a withdrawal and a restore", () => {
    const withdrawn = state({ history: [
      { revision: 1, at: "2026-11-11T10:00:00", client: "Codex", action: "withdraw", reason: "不要了", before: null, basis: "user_said" },
      { revision: 2, at: "2026-11-11T11:00:00", client: "我", action: "restore", reason: "又要了", before: null, basis: "user_said" },
    ] });
    expect(historyDays("preferences", withdrawn, "2026-11-11")[0]!.events.map((row) => row.what)).toEqual(["恢复", "撤回"]);
  });
});

describe("requests and labels", () => {
  it("restores by revision number, against the note's hash and the amendment revision, as the reader: the main process puts back the whole text", () => {
    expect(restoreRequest("decisions", "D-1", "a".repeat(64), 3, 2, "11 月 11 日")).toMatchObject({
      action: "revert", toRevision: 2, sourceClient: "我", basis: "user_said", expectedContentHash: "a".repeat(64), expectedRevision: 3,
    });
  });
  it("writes dates as the page does", () => {
    expect(monthDayLabel("2026-11-11T10:28:00", new Date("2026-12-01T00:00:00"))).toMatch(/^11 月 1[01] 日$/u);
    expect(monthDayLabel("2025-03-04T10:00:00", new Date("2026-12-01T00:00:00"))).toBe("2025 年 3 月 4 日");
    expect(stampLabel("2026-11-11T10:28:00")).toBe("11-11 10:28");
  });
});

describe("clientLabel", () => {
  it("names a client as the registry does, the reader as 我, and never shows a bare id", () => {
    expect(clientLabel("我")).toBe("我");
    expect(clientLabel("claude-code")).toBe("Claude Code");
    expect(clientLabel("codex")).toBe("Codex");
    rememberClients([{ id: "claude-code", name: "Claude Code（桌面）" } as never]);
    expect(clientLabel("claude-code")).toBe("Claude Code（桌面）");
    rememberClients([]);
  });
  it("is used in the history rows", () => {
    const rows = historyDays("decisions", { revision: 1, relativePath: "x", amendments: [], revised: null, withdrawn: null,
      history: [{ revision: 1, at: "2026-11-11T10:00:00", client: "claude-code", action: "append", reason: null, before: null, basis: "user_said" }] }, "2026-11-11");
    expect(rows[0]!.events[0]!.who).toBe("Claude Code");
  });
});
