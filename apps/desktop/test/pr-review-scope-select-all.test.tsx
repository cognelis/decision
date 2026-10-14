// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PrReviewSnapshot } from "@cognelis/decision-protocol";
import { PrReviewScopeDialog } from "../src/renderer/components/pages/pr-review/PrReviewScopeDialog.js";

afterEach(() => { cleanup(); });

const paths = ["src/auth/login.ts", "src/auth/token.ts", "src/ui/app.ts", "src/ui/menu.ts", "docs/readme.md"];
const snapshot: PrReviewSnapshot = {
  snapshotId: "00000000-0000-4000-8000-000000000001", reference: "sample/app#9", title: "PR", description: "", project: "app",
  sourceCommit: "a".repeat(40), destinationCommit: "b".repeat(40), warnings: [],
  files: paths.map(path => ({ path, status: "modified" })),
  fileBatches: Object.fromEntries(paths.map(path => [path, 1])), fileHunks: Object.fromEntries(paths.map(path => [path, [300]])),
};

/*
 * The directory checkboxes act on the files the filter shows (a directory's box reads its shown files). 全选 and
 * 全不选, in the same row as the filter, act on every file of the PR, shown or not: filtered to "auth", 全不选 then
 * 全选 picks the whole PR, and 确定 runs the review the reader just narrowed on every file.
 */
it("applies 全选 and 全不选 to the files the filter shows, as the directory boxes do", () => {
  const onConfirm = vi.fn();
  render(<PrReviewScopeDialog snapshot={snapshot} chosen={null} unitChars={48_000} onClose={() => undefined} onConfirm={onConfirm} />);
  const dialog = screen.getByRole("dialog", { name: "选择评审文件" });
  fireEvent.click(within(dialog).getByRole("button", { name: "全不选" }));
  expect(within(dialog).getByRole("status")).toHaveTextContent("已选 0 / 5 个文件");
  fireEvent.change(within(dialog).getByRole("searchbox", { name: "筛选文件路径" }), { target: { value: "auth" } });
  expect(within(dialog).getAllByRole("checkbox", { name: /\.ts$|\.md$/u })).toHaveLength(2);
  fireEvent.click(within(dialog).getByRole("button", { name: "全选" }));
  // Only the two auth files were shown; only they are picked.
  expect(within(dialog).getByRole("status")).toHaveTextContent("已选 2 / 5 个文件");
  fireEvent.click(within(dialog).getByRole("button", { name: "确定" }));
  expect(onConfirm).toHaveBeenCalledWith(["src/auth/login.ts", "src/auth/token.ts"]);
});
