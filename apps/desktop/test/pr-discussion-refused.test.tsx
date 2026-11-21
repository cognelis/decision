// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { PrDiscussion } from "@cognelis/decision-protocol";
import { PrDiscussionDialog } from "../src/renderer/components/pages/pr-review/PrDiscussionDialog.js";

afterEach(cleanup);

const comment = (id: string, body: string, refused: boolean) => ({
  id, url: `https://code.example.com/projects/PROJ/repos/repo/pull-requests/12/overview?commentId=${id}`, author: "Alice", path: "src/a.ts", line: 3, body,
  createdAt: "2026-10-20T01:00:00Z", replyTo: null, code: null, decisionId: null, candidate: null, ...(refused ? { refused: true as const } : {}) });

// Read as not decisions, a refused batch said nothing: "评论都识别过了", and a real decision among them was never offered.
it("says how many comments the provider's moderation left unread, marks each, and lets the reader settle one", async () => {
  const discussion: PrDiscussion = { more: false, recognition: { pending: 0, callsLeft: 19, stopped: null },
    comments: [comment("21", "这段要整个重写", true), comment("22", "先不处理，现有数据不会重复", true), comment("23", "已改", false)] };
  const dismiss = vi.fn(async () => undefined);
  const user = userEvent.setup();
  render(<PrDiscussionDialog api={{ listPrDiscussion: async () => discussion, recognizePrDiscussion: vi.fn(), dismissPrCommentCandidate: dismiss, openPrLink: vi.fn() }}
    connectionId="00000000-0000-4000-8000-000000000001" pr={{ title: "示例", reference: "PROJ/repo#12" }} onRecord={vi.fn()} onClose={vi.fn()} />);
  const dialog = within(await screen.findByRole("dialog", { name: "PR 讨论" }));

  expect(await dialog.findByText("有 2 条评论因审核拒绝未能识别，可以手动查看并记录")).toBeVisible();
  expect(dialog.queryByText("评论都识别过了")).toBeNull();
  expect(dialog.getAllByText("未能识别")).toHaveLength(2);
  await user.click(dialog.getAllByRole("button", { name: "Alice 的评论不是决定" })[0]!);
  expect(dismiss).toHaveBeenCalledWith(discussion.comments[0]!.url);
  expect(await dialog.findByText("有 1 条评论因审核拒绝未能识别，可以手动查看并记录")).toBeVisible();
});
