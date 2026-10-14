// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createPreviewApi } from "../src/renderer/preview-api.js";
import { PrReviewPanel } from "../src/renderer/components/pages/pr-review/PrReviewPanel.js";

afterEach(() => { cleanup(); localStorage.clear(); });

const runSampleReview = async (api: ReturnType<typeof createPreviewApi>) => {
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  const start = await screen.findByRole("button", { name: "开始评审" });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  await screen.findByRole("heading", { name: "P2 超时后请求仍在运行" });
};

// A re-evaluation that fails says why ("复评未完成：模型服务的额度或余额不足…"); a question that fails for the same
// reason says only "回答失败，请重试。" — the reader retries a call that cannot succeed, and the service's followUp()
// never translates the gateway's failure code as reevaluate() does.
it("tells the reader why an answer failed, as a failed re-evaluation does", async () => {
  const api = createPreviewApi();
  const reason = "模型服务的额度或余额不足，请到服务商处充值或检查套餐后再试。";
  vi.spyOn(api, "followUpPrReview").mockRejectedValue(new Error(reason));
  vi.spyOn(api, "reevaluatePrReviewFinding").mockRejectedValue(new Error(reason));
  await runSampleReview(api);
  fireEvent.click(screen.getByRole("button", { name: "复评「超时后请求仍在运行」" }));
  expect(await screen.findByText(`复评未完成：${reason}`)).toBeVisible();
  fireEvent.change(screen.getByLabelText("继续追问"), { target: { value: "为什么没有取消？" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  // The turn ends as failed; the page should carry the reason with it, as it does for the re-evaluation above.
  expect(await screen.findByText(/回答失败/u)).toBeVisible();
  expect(screen.getAllByText(new RegExp(reason.slice(0, 12), "u")).length).toBeGreaterThanOrEqual(2);
});
