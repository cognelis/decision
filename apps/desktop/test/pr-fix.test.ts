import { expect, it } from "vitest";
import type { LocalReviewJob, LocalReviewState } from "@cognelis/decision-protocol";

import { diffSize, fixJobsFor, fixMoved, fixStatus, roundPreview } from "../src/renderer/components/pages/pr-review/pr-fix.js";
import { createLocalReviewPreview } from "../src/renderer/preview-local-review.js";

const preview = async () => {
  const api = createLocalReviewPreview();
  const id = await api.submitLocalReviewFromPr({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123", commentIds: ["901"], profileId: "builtin-codex" });
  const state = await api.getLocalReviewState() as LocalReviewState;
  return { state, job: state.jobs.find((job) => job.id === id)! };
};

it("tells what a comment's fix stands at, from the latest task of the PR that has it", async () => {
  const { state, job } = await preview();
  expect(fixJobsFor(state, "00000000-0000-4000-8000-000000000011", "sample/app#123").map((item) => item.id)).toEqual([job.id]);
  expect(fixJobsFor(state, "00000000-0000-4000-8000-000000000011", "sample/app#999")).toEqual([]);
  expect(fixStatus({ id: "901" }, [job])).toMatchObject({ tone: "ready", text: "本地审阅已改好：+2 −1 · 超时改为取消底层请求。" });
  expect(fixStatus({ id: "902" }, [job])).toBeNull();
  const rejected: LocalReviewJob = { ...job, verdicts: [{ ...job.verdicts[0]!, verdict: "reject", reason: "调用方已经处理超时。" }] };
  expect(fixStatus({ id: "901" }, [rejected])).toMatchObject({ tone: "bad", text: "本地审阅没有采纳：调用方已经处理超时。" });
  const moved: LocalReviewJob = { ...job, groups: [{ ...job.groups[0]!, state: "failed", retryable: false, error: "推送前远端分支头变了：feature/request 现在是 eeeeeeeeeeee……" }] };
  expect(fixMoved(moved)).toBe(true);
  expect(fixMoved(job)).toBe(false);
  expect(diffSize("--- a/x\n+++ b/x\n-old\n+new\n+more\n")).toEqual({ added: 2, removed: 1 });
});

it("previews 本轮变化 with this round's fixes and the other answers on the PR", async () => {
  const { job } = await preview();
  const comments = [
    { id: "901", url: "", author: "A", path: "src/request.ts", line: 12, side: "new" as const, body: "", createdAt: "", task: null, resolved: null, replies: [] },
    { id: "902", url: "", author: "B", path: null, line: null, side: null, body: "", createdAt: "", task: null, resolved: null,
      replies: [{ id: "903", author: "me", mine: true, createdAt: "", body: "**有意为之**：……\n\n— Paraself 作者回应" }] },
  ];
  expect(roundPreview(job, comments)).toBe(`提交 \`${"d".repeat(12)}\` 修复 1 条意见：\n- 超时后请求仍在运行（回应 示例审阅人 A）\n另 1 条已回复：有意为之 1 条。`);
});
