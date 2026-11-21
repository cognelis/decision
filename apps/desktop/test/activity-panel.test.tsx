// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActivityPanel } from "../src/renderer/components/pages/activity/ActivityPanel.js";
import { apiFixture, modelTraceFixture, rationaleSnapshot } from "./app-fixtures.js";

afterEach(cleanup);

describe("ActivityPanel", () => {
  it("reads the call list again when the counts above it move", async () => {
    const snapshot = rationaleSnapshot({ current: null, primarySurface: "activity" });
    const { api } = apiFixture(snapshot, [modelTraceFixture()]);
    const view = render(<ActivityPanel snapshot={snapshot} api={api} />);
    await screen.findByRole("region", { name: "模型调用记录" });
    expect(api.listModelTraces).toHaveBeenCalledTimes(1);

    // A classification fails while the page is open: the counts above say so.
    const failed = { ...snapshot, semanticRecognition: { ...snapshot.semanticRecognition, processed7d: 13, failures7d: 1 } };
    await act(async () => { view.rerender(<ActivityPanel snapshot={failed} api={api} />); });
    // Read once, the list never showed the failure the summary counted.
    expect(api.listModelTraces).toHaveBeenCalledTimes(2);

    // A push that moves no count reads nothing again.
    await act(async () => { view.rerender(<ActivityPanel snapshot={{ ...failed }} api={api} />); });
    expect(api.listModelTraces).toHaveBeenCalledTimes(2);
  });

  it("sums the misrecognized deletions of the last 30 days by band and signal", async () => {
    const snapshot = rationaleSnapshot({ current: null, primarySurface: "activity" });
    const { api } = apiFixture(snapshot);
    vi.mocked(api.getMisrecognitionSummary).mockResolvedValue({ days: 30, total: 3, byMode: { transcript: 2, structured_tool: 1 }, byBand: { high: 2, medium: 1, unknown: 0 }, bySignal: { awaits_confirmation: 1, has_choice_prompt: 3 }, byDetector: { "rules-v5": 3 } });
    await act(async () => { render(<ActivityPanel snapshot={snapshot} api={api} />); });
    const card = screen.getByRole("region", { name: "识别错误" });
    expect(card).toHaveTextContent("近 30 天");
    expect(card).toHaveTextContent(/3\s*条删除标为识别错误/u);
    expect(card).toHaveTextContent("对话识别 2 · 结构化提问 1");
    expect(card).toHaveTextContent(/直接捕获\s*2/u); expect(card).toHaveTextContent(/候选\s*1/u);
    // Most frequent signal first.
    expect(card.textContent!.indexOf("has_choice_prompt")).toBeLessThan(card.textContent!.indexOf("awaits_confirmation"));
    expect(card).toHaveTextContent("rules-v5");
  });

  it("says the ratings could not be read, rather than that none were given", async () => {
    const snapshot = rationaleSnapshot({ current: null, primarySurface: "activity" });
    const { api } = apiFixture(snapshot);
    vi.mocked(api.getAssistantFeedbackSummary).mockRejectedValue(new Error("读取失败"));
    await act(async () => { render(<ActivityPanel snapshot={snapshot} api={api} />); });

    // Taken as none, the card said 0 / 0 and 还没有评分, as a record with nothing in it does.
    expect(screen.getByText("评分记录这次没能读取，请稍后重新打开这一页。")).toBeVisible();
    expect(screen.queryByText(/还没有评分/u)).toBeNull();
    expect(screen.getByText("有用").nextElementSibling).toHaveTextContent("—");
  });
});
