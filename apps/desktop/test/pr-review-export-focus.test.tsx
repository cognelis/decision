// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createPreviewApi } from "../src/renderer/preview-api.js";
import { PrReviewPanel } from "../src/renderer/components/pages/pr-review/PrReviewPanel.js";

afterEach(() => { cleanup(); localStorage.clear(); });

// The review was asked to look at one thing (本次关注点). The page shows it at the top of the record ("评审要求"), and a
// 问答 record's export says "关注点：…"; the exported review report never mentions it.
it("exports what the review was asked to focus on", async () => {
  const api = createPreviewApi();
  const exportReport = vi.spyOn(api, "exportAssistantConversation").mockResolvedValue({ status: "cancelled" });
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  const focus = await screen.findByLabelText("本次关注点（可选）");
  fireEvent.change(focus, { target: { value: "只看权限边界和超时后的资源释放" } });
  const start = screen.getByRole("button", { name: "开始评审" });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  expect(await screen.findByRole("heading", { name: "P2 超时后请求仍在运行" })).toBeVisible();
  // The page says what was asked.
  expect(screen.getByText("只看权限边界和超时后的资源释放")).toBeVisible();
  fireEvent.click(screen.getByLabelText("评审操作"));
  fireEvent.click(screen.getByRole("button", { name: "导出报告" }));
  await waitFor(() => expect(exportReport).toHaveBeenCalled());
  const markdown = exportReport.mock.calls[0]![0].markdown;
  expect(markdown).toContain("只看权限边界和超时后的资源释放");
});
