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
