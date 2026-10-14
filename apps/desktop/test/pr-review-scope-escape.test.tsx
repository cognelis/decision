// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PrReviewSnapshot } from "@cognelis/decision-protocol";
import { PrReviewScopeDialog } from "../src/renderer/components/pages/pr-review/PrReviewScopeDialog.js";

afterEach(() => { cleanup(); });

const snapshot: PrReviewSnapshot = {
  snapshotId: "00000000-0000-4000-8000-000000000001", reference: "sample/app#9", title: "PR", description: "", project: "app",
  sourceCommit: "a".repeat(40), destinationCommit: "b".repeat(40), warnings: [],
  files: [{ path: "src/a.ts", status: "modified" }, { path: "src/b.ts", status: "modified" }, { path: "src/c.ts", status: "modified" }],
  fileBatches: { "src/a.ts": 1, "src/b.ts": 1, "src/c.ts": 1 }, fileHunks: { "src/a.ts": [300], "src/b.ts": [300], "src/c.ts": [300] },
};

/*
 * The app's other dialogs keep what the reader changed in them when Escape is pressed (dialog-drafts.test.tsx: a model
 * backend being added, a link's token, 不采纳 with a reason typed). 选择评审文件 does not: a selection changed over
 * a 300-file PR goes with one Escape, pressed by habit or to dismiss something else.
 */
it("keeps a changed selection on Escape, as the other dialogs keep their drafts", () => {
  const onClose = vi.fn(), onConfirm = vi.fn();
  render(<PrReviewScopeDialog snapshot={snapshot} chosen={null} unitChars={48_000} onClose={onClose} onConfirm={onConfirm} />);
  const dialog = screen.getByRole("dialog", { name: "选择评审文件" });
  const box = within(dialog).getByRole("checkbox", { name: "src/b.ts" });
  fireEvent.click(box);
  expect(within(dialog).getByRole("status")).toHaveTextContent("已选 2 / 3 个文件");
  fireEvent.keyDown(box, { key: "Escape" });
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "选择评审文件" })).toBeInTheDocument();
});
