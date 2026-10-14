// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prReviewRunSchema, type PrReviewVerdict } from "@cognelis/decision-protocol";
import { createPreviewApi } from "../src/renderer/preview-api.js";
import { dismissedIn, publishedIn, loadReviewHistory, mergeReviewEvents, saveReviewHistory, type ReviewHistoryEntry } from "../src/renderer/components/pages/pr-review/review-history.js";
import { PrReviewPanel, reviewMarkdown } from "../src/renderer/components/pages/pr-review/PrReviewPanel.js";
import { commentDraft } from "../src/renderer/components/pages/pr-review/PrDiscussionDialog.js";
import { PrReviewCommentDialog } from "../src/renderer/components/pages/pr-review/PrReviewCommentDialog.js";

afterEach(() => { cleanup(); localStorage.clear(); });
it("loads a PR, runs the review and exports its coverage and commit anchors", async () => {
  const api = createPreviewApi();
  const load = vi.spyOn(api, "loadPrReview");
  const run = vi.spyOn(api, "runPrReview");
  const exportReport = vi.spyOn(api, "exportAssistantConversation").mockResolvedValue({ status: "cancelled" });
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  const start = await screen.findByRole("button", { name: "开始评审" });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  expect(await screen.findByRole("heading", { name: "P2 超时后请求仍在运行" })).toBeVisible();
  expect(load).toHaveBeenCalledWith({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123", updatedAt: "2026-09-21T10:00:00Z" });
  expect(screen.getByRole("region", { name: "评审过程" })).toBeVisible();
  expect(run).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/此为界面预览/)).toBeVisible();
  fireEvent.click(screen.getByLabelText("评审操作"));
  fireEvent.click(screen.getByRole("button", { name: "导出报告" }));
  expect(exportReport).toHaveBeenCalledWith(expect.objectContaining({ markdown: expect.stringContaining("源提交：" + "a".repeat(40)) }));
  // The same Markdown goes to the clipboard, for a PR comment or a chat.
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  fireEvent.click(screen.getByLabelText("评审操作"));
  fireEvent.click(screen.getByRole("button", { name: "复制为 Markdown" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(exportReport.mock.calls[0]![0].markdown));
  fireEvent.click(within(screen.getByRole("group", { name: "PR 范围" })).getByRole("button", { name: "我创建的" }));
  expect(screen.queryByRole("button", { name: "开始评审" })).toBeNull();
});

it("records a finding that names a team practice as a decision", async () => {
  const api = createPreviewApi();
  const create = vi.spyOn(api, "createProactiveRecord");
  await runSampleReview(api);
  fireEvent.click(screen.getByRole("button", { name: "把「超时后请求仍在运行」记为决策" }));
  const form = await screen.findByRole("dialog", { name: "主动记录" });
  expect(within(form).getByLabelText("标题")).toHaveValue("超时后请求仍在运行：以后怎么处理？");
  fireEvent.click(within(form).getByRole("button", { name: /保存记录/ }));
  await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
    kind: "decision", project: "sample", context: expect.stringContaining("位置：src/request.ts:12（新版本）"),
  })));
  // No comment link to keep here, so none is claimed.
  expect(await screen.findByText("已记为决策。")).toBeInTheDocument();
});

it("says what a finding was recorded as when the dialog made it something else", async () => {
  const api = createPreviewApi();
  const original = api.createProactiveRecord.bind(api);
  vi.spyOn(api, "createProactiveRecord").mockImplementation(async (request) => ({ ...(await original(request)), recordKind: "idea" }));
  await runSampleReview(api);
  fireEvent.click(screen.getByRole("button", { name: "把「超时后请求仍在运行」记为决策" }));
  const form = await screen.findByRole("dialog", { name: "主动记录" });
  fireEvent.click(within(form).getByRole("button", { name: /保存记录/ }));
  expect(await screen.findByText("已记为想法。")).toBeInTheDocument();
});

it("records a decision made in a PR comment with the comment's link and points to ones already recorded", async () => {
  const api = createPreviewApi();
  const create = vi.spyOn(api, "createProactiveRecord");
  const openDecision = vi.fn();
  render(<PrReviewPanel api={api} onOpenDecision={openDecision} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  fireEvent.click(await screen.findByRole("button", { name: "PR 讨论" }));
  const discussion = await screen.findByRole("dialog", { name: "PR 讨论" });
  fireEvent.click(await within(discussion).findByRole("button", { name: "把 Example 的评论记为决策" }));
  // One dialog at a time: the discussion comes back once the record is saved.
  const form = await screen.findByRole("dialog", { name: "主动记录" });
  expect(screen.queryByRole("dialog", { name: "PR 讨论" })).toBeNull();
  expect(within(form).getByLabelText("标题")).toHaveValue("src/request.ts:12 怎么处理？");
  expect(within(form).getByLabelText("来源")).toHaveValue("PR 评论 · 示例 GitHub");
  expect(within(form).getByRole("button", { name: "偏好" })).toBeDisabled();
  fireEvent.click(within(form).getByRole("button", { name: /保存记录/ }));
  await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
    kind: "decision", sourceKind: "pr_comment", sourceUrl: "https://github.com/sample/app/pull/123#discussion_r2",
    project: "sample", context: expect.stringContaining("PR：示例：调整请求超时（sample/app#123）"),
  })));
  expect(await screen.findByText("已记为决策，并保留了评论链接。")).toBeInTheDocument();
  const reopened = await screen.findByRole("dialog", { name: "PR 讨论" });
  // The comment just recorded now points at its decision instead of offering a second record.
  const recorded = await within(reopened).findAllByRole("button", { name: "已记为决策 · 查看" });
  expect(recorded).toHaveLength(2);
  fireEvent.click(recorded[1]!);
  expect(openDecision).toHaveBeenCalledWith("preview-decision");
  expect(screen.queryByRole("dialog", { name: "PR 讨论" })).toBeNull();
});

it("dates a recorded PR comment on the day it shows, not the day in UTC", () => {
  // 04:30 on 1 October here: in UTC, east of Greenwich, still 30 September.
  const createdAt = new Date(2026, 9, 1, 4, 30).toISOString();
  const draft = commentDraft(
    { id: "c1", url: "https://github.com/sample/app/pull/123#discussion_r1", author: "Example", path: "src/request.ts", line: 12, body: "超时统一由上层处理。", createdAt, decisionId: null },
    { title: "示例", reference: "sample/app#123", project: "app" },
    "示例 GitHub",
  );
  expect(draft.context).toContain("评论：Example · 2026-10-01");
});

it("lists what merged that I reviewed or wrote as one list, newest first, each read on from its own cursor", async () => {
  const api = createPreviewApi();
  const item = (number: number, updatedAt: string) => ({ reference: `sample/app#${number}`, repository: "sample/app", number: String(number), title: `PR ${number}`, author: "someone", updatedAt });
  const list = vi.spyOn(api, "listPullRequests").mockImplementation(async (query) => {
    if (query.state !== "merged") return { items: [], nextPage: null };
    // Bitbucket's cursors are offsets of each list's own: the second page of one is not the other's.
    if (query.filter === "review-requested") return query.page === 1 ? { items: [item(1, "2026-10-01T00:00:00Z"), item(3, "2026-10-03T00:00:00Z")], nextPage: 31 } : { items: [item(5, "2026-09-01T00:00:00Z")], nextPage: null };
    return query.page === 1 ? { items: [item(2, "2026-10-02T00:00:00Z"), item(3, "2026-10-03T00:00:00Z")], nextPage: null } : { items: [], nextPage: null };
  });
  render(<PrReviewPanel api={api} />);
  fireEvent.click(within(await screen.findByRole("group", { name: "PR 范围" })).getByRole("button", { name: "已合并" }));
  const titles = () => screen.getAllByRole("button", { name: /^sample\/app #\d+ PR \d+$/u }).map((button) => /#(\d+)/u.exec(button.getAttribute("aria-label") ?? "")![1]);
  // Newest first, one PR in both lists shown once.
  await waitFor(() => expect(titles()).toEqual(["3", "2", "1"]));
  fireEvent.click(screen.getByRole("button", { name: "加载更多 PR" }));
  await waitFor(() => expect(titles()).toEqual(["3", "2", "1", "5"]));
  // On from the one list with more, at its own cursor; the other, ended, not read again.
  expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ filter: "review-requested", state: "merged", page: 31 }));
  expect(list.mock.calls.filter(([query]) => query.state === "merged" && query.filter === "created")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "加载更多 PR" })).toBeNull();
});

it("walks the merged list with the arrow keys, opening a PR's discussion only when asked", async () => {
  const api = createPreviewApi();
  const item = (number: number, updatedAt: string) => ({ reference: `sample/app#${number}`, repository: "sample/app", number: String(number), title: `PR ${number}`, author: "someone", updatedAt });
  vi.spyOn(api, "listPullRequests").mockImplementation(async (query) => ({ items: query.state === "merged" ? [item(1, "2026-10-01T00:00:00Z"), item(2, "2026-10-02T00:00:00Z")] : [], nextPage: null }));
  render(<PrReviewPanel api={api} />);
  fireEvent.click(within(await screen.findByRole("group", { name: "PR 范围" })).getByRole("button", { name: "已合并" }));
  const first = await screen.findByRole("button", { name: "sample/app #2 PR 2" });
  first.focus();
  fireEvent.keyDown(first, { key: "ArrowDown" });
  // A dialog at every step took the focus, and the list could not be walked.
  expect(screen.getByRole("button", { name: "sample/app #1 PR 1" })).toHaveFocus();
  expect(screen.queryByRole("dialog", { name: "PR 讨论" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "sample/app #1 PR 1" }));
  expect(await screen.findByRole("dialog", { name: "PR 讨论" })).toBeVisible();
});

it("opens each record the arrow keys reach in the history list, whatever the PR list was set to", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  const report = await api.runPrReview({ snapshotId: snapshot.snapshotId, runId: "00000000-0000-4000-8000-000000000002", profileId: "local", focus: "" });
  const entry = (id: string, title: string) => ({ kind: "review" as const, model: "本机", focus: "", draft: "", turns: [], events: [], state: "finished" as const, error: "", rechecks: [], published: [], verdicts: [],
    connectionId: "00000000-0000-4000-8000-000000000011", id, at: "2026-09-30T11:00:00.000Z", snapshot: { ...snapshot, title }, report });
  saveReviewHistory([entry("00000000-0000-4000-8000-0000000000e5", "评审甲"), entry("00000000-0000-4000-8000-0000000000e6", "评审乙")]);
  render(<PrReviewPanel api={api} />);
  // The PR list set to 已合并, where the arrows only move: the history list took that from it, with no control to say so.
  fireEvent.click(within(await screen.findByRole("group", { name: "PR 范围" })).getByRole("button", { name: "已合并" }));
  fireEvent.click(screen.getByRole("button", { name: /历史评审/u }));
  const [first, second] = within(screen.getByRole("list", { name: "历史评审" })).getAllByRole("button");
  first!.focus();
  fireEvent.keyDown(first!, { key: "ArrowDown" });
  expect(second).toHaveFocus();
  expect(second).toHaveAttribute("aria-pressed", "true");
});

it("says in the result how many lockfiles or generated files were kept from the model, once conclusions are listed", async () => {
  const api = createPreviewApi();
  const loaded = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  const snapshot = { ...loaded, files: [...loaded.files, { path: "pnpm-lock.yaml", status: "modified" }], skippedFiles: ["pnpm-lock.yaml"] };
  const report = await api.runPrReview({ snapshotId: snapshot.snapshotId, runId: "00000000-0000-4000-8000-000000000002", profileId: "local", focus: "" });
  saveReviewHistory([{ kind: "review", model: "本机", focus: "", draft: "", turns: [], events: [], state: "finished", error: "", rechecks: [], published: [], verdicts: [],
    connectionId: "00000000-0000-4000-8000-000000000011", id: "00000000-0000-4000-8000-0000000000e4", at: "2026-09-30T11:00:00.000Z", snapshot,
    report: { ...report, conclusions: [{ label: "src/request.ts", text: "已核对。" }] } }]);
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /历史评审/u }));
  fireEvent.click((await screen.findAllByRole("button", { name: /示例：调整请求超时/u }))[0]!);
  // The header counts 2 files and the review 1: the sentence saying why stood only in the summary, no longer shown.
  expect(await screen.findByText(/完成评审 1\/1 个文件（另有 1 个锁定或生成文件未送模型）/u)).toBeVisible();
});

it("opens a merged PR's discussion directly, without fetching its diff", async () => {
  const api = createPreviewApi();
  const list = vi.spyOn(api, "listPullRequests");
  const load = vi.spyOn(api, "loadPrReview");
  const prefetch = vi.spyOn(api, "prefetchPrReviews");
  render(<PrReviewPanel api={api} />);
  await screen.findByRole("button", { name: /#123 示例：调整请求超时/ });
  await waitFor(() => expect(prefetch).toHaveBeenCalledTimes(1));
  fireEvent.click(within(screen.getByRole("group", { name: "PR 范围" })).getByRole("button", { name: "已合并" }));
  // One switch of three, its names fixed: whose and which state were two, and the first renamed itself with the second.
  expect(within(screen.getByRole("group", { name: "PR 范围" })).getAllByRole("button").map((button) => [button.textContent, button.getAttribute("aria-pressed")]))
    .toEqual([["待我评审", "false"], ["我创建的", "false"], ["已合并", "true"]]);
  // What merged that I reviewed and what I wrote, both read.
  await waitFor(() => expect(list).toHaveBeenCalledWith(expect.objectContaining({ filter: "created", state: "merged" })));
  expect(list).toHaveBeenCalledWith(expect.objectContaining({ filter: "review-requested", state: "merged" }));
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  const discussion = await screen.findByRole("dialog", { name: "PR 讨论" });
  expect(discussion).toHaveAccessibleDescription(/「示例：调整请求超时」（sample\/app#123）/u);
  expect(await within(discussion).findByRole("button", { name: "把 Example 的评论记为决策" })).toBeVisible();
  expect(load).not.toHaveBeenCalled();
  // Only the open list was read ahead; history never fetches diffs.
  expect(prefetch).toHaveBeenCalledTimes(1);
});

const reviewSample = async (api: ReturnType<typeof createPreviewApi>) => {
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  const start = await screen.findByRole("button", { name: "开始评审" });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  fireEvent.click(await screen.findByRole("button", { name: "把「超时后请求仍在运行」转为 PR 评论" }));
  const form = await screen.findByRole("form", { name: "发布评论表单" });
  const submit = within(form).getByRole("button", { name: "发布评论" });
  await waitFor(() => expect(submit).toBeEnabled());
  return { form, submit, body: within(form).getByLabelText("评论内容") as HTMLTextAreaElement };
};

it("publishes a finding as the reviewer's edited comment on its line, once", async () => {
  const api = createPreviewApi();
  const publish = vi.spyOn(api, "publishPrReviewComment");
  const { body, submit } = await reviewSample(api);
  expect(body.value).toContain("**P2 · 超时后请求仍在运行**");
  expect(body).toHaveFocus();
  expect(publish).not.toHaveBeenCalled();
  fireEvent.change(body, { target: { value: "请把 AbortSignal 传给底层请求。" } });
  fireEvent.click(submit);
  await waitFor(() => expect(screen.queryByRole("form", { name: "发布评论表单" })).toBeNull());
  expect(publish).toHaveBeenCalledWith({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123", sourceCommit: "a".repeat(40), destinationCommit: expect.stringMatching(/^[a-f0-9]{40}$/u), path: "src/request.ts", side: "new", line: 12, body: "请把 AbortSignal 传给底层请求。" });
  expect(screen.getByText("已发布为 PR 评论")).toBeVisible();
  // The button it came from is gone: focus goes to the finding it posted, not to the page, once the dialog is.
  await waitFor(() => expect(screen.getByRole("heading", { name: "P2 超时后请求仍在运行" })).toHaveFocus());
  expect(screen.getByText(/已发布 1 条评论/u)).toBeVisible();
  expect(screen.getByRole("button", { name: /#123 示例：调整请求超时/u })).toHaveTextContent("评审完成 · 1 个问题 · 已发布 1");
  expect(screen.queryByRole("button", { name: /转为 PR 评论/u })).toBeNull();
  expect(screen.getByText("界面预览：评论已模拟，未写入代码平台。")).toBeVisible();
  expect(loadReviewHistory().entries[0]!.published).toEqual([{ finding: 0, at: expect.any(String) }]);
});

it("inserts the finding's line as a suggested change on GitHub, to be rewritten into the fix", async () => {
  const api = createPreviewApi();
  vi.spyOn(api, "loadPrReviewFile").mockResolvedValue({ content: Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"), binary: false });
  const { form, body } = await reviewSample(api);
  fireEvent.click(within(form).getByRole("button", { name: "插入建议修改" }));
  await waitFor(() => expect(body.value.endsWith("\n\n```suggestion\nline 12\n```")).toBe(true));
  expect(body.value.startsWith("**P2 · 超时后请求仍在运行**")).toBe(true);
  // The caret waits at the end of the line to rewrite.
  expect(body).toHaveFocus();
  expect(body.selectionStart).toBe(body.value.length - "\n```".length);
});

it("fences a suggested line of backticks with a longer fence, and replaces the one inserted before", async () => {
  const api = createPreviewApi();
  vi.spyOn(api, "loadPrReviewFile").mockResolvedValue({ content: Array.from({ length: 20 }, (_, index) => index === 11 ? "```" : `line ${index + 1}`).join("\n"), binary: false });
  const { form, body } = await reviewSample(api);
  const insert = within(form).getByRole("button", { name: "插入建议修改" });
  fireEvent.click(insert);
  await waitFor(() => expect(body.value.endsWith("\n\n````suggestion\n```\n````")).toBe(true));
  await waitFor(() => expect(insert).toBeEnabled());
  fireEvent.click(insert);
  await waitFor(() => expect(insert).toBeEnabled());
  expect(body.value.match(/suggestion\n/gu)).toHaveLength(1);
  expect(body.value.startsWith("**P2 · 超时后请求仍在运行**")).toBe(true);
});

it("offers no suggested change where the platform has none", async () => {
  const api = createPreviewApi();
  vi.spyOn(api, "listPrConnections").mockResolvedValue([{ id: "00000000-0000-4000-8000-000000000011", label: "示例 Bitbucket", platform: "bitbucket-server", baseUrl: "https://bitbucket.example.com" }]);
  const { form } = await reviewSample(api);
  expect(within(form).queryByRole("button", { name: "插入建议修改" })).toBeNull();
});

it("offers no suggested change for a line of the old version", async () => {
  const api = createPreviewApi();
  const run = api.runPrReview;
  vi.spyOn(api, "runPrReview").mockImplementation(async (input) => {
    const report = await run(input);
    return { ...report, findings: report.findings.map(finding => ({ ...finding, side: "old" as const })) };
  });
  const { form } = await reviewSample(api);
  expect(within(form).queryByRole("button", { name: "插入建议修改" })).toBeNull();
});

it("previews the comment's Markdown and returns to the same draft", async () => {
  const api = createPreviewApi();
  const { form, body } = await reviewSample(api);
  const previewButton = within(form).getByRole("button", { name: "预览" });
  fireEvent.change(body, { target: { value: "**加粗** 与 `code`\n\n- 第一条" } });
  fireEvent.click(previewButton);
  expect(previewButton).toHaveAttribute("aria-pressed", "true");
  const preview = within(form).getByRole("region", { name: "评论预览" });
  expect(preview.querySelector("strong")).toHaveTextContent("加粗");
  expect(within(preview).getByRole("listitem")).toHaveTextContent("第一条");
  expect(body).not.toBeVisible();
  fireEvent.click(within(form).getByRole("button", { name: "编辑" }));
  expect(within(form).queryByRole("region", { name: "评论预览" })).toBeNull();
  expect(body).toBeVisible();
  expect(body).toHaveFocus();
  expect(body.value).toBe("**加粗** 与 `code`\n\n- 第一条");
  fireEvent.change(body, { target: { value: "  " } });
  expect(previewButton).toBeDisabled();
});

it("publishes with the same shortcut as the other dialogs", async () => {
  const api = createPreviewApi();
  const publish = vi.spyOn(api, "publishPrReviewComment");
  const { body } = await reviewSample(api);
  fireEvent.keyDown(body, { key: "Enter", metaKey: true });
  await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
});

it("keeps the draft and says why when the platform rejects the comment", async () => {
  const api = createPreviewApi();
  vi.spyOn(api, "publishPrReviewComment").mockRejectedValue(new Error("平台拒绝了这条行内评论（HTTP 422）：该行可能已不在 PR 的 diff 中。"));
  const { form, body, submit } = await reviewSample(api);
  fireEvent.change(body, { target: { value: "请取消底层请求。" } });
  fireEvent.click(submit);
  expect(await within(form).findByRole("alert")).toHaveTextContent("HTTP 422");
  expect(body).toHaveValue("请取消底层请求。");
  fireEvent.click(within(form).getByRole("button", { name: "取消" }));
  expect(screen.queryByText("已发布为 PR 评论")).toBeNull();
  expect(screen.getByRole("button", { name: "把「超时后请求仍在运行」转为 PR 评论" })).toBeEnabled();
});

const runSampleReview = async (api: ReturnType<typeof createPreviewApi>) => {
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  const start = await screen.findByRole("button", { name: "开始评审" });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  await screen.findByRole("heading", { name: "P2 超时后请求仍在运行" });
};

it("finds a past review by what it found", async () => {
  const api = createPreviewApi();
  vi.spyOn(api, "reevaluatePrReviewFinding").mockResolvedValue({ verdict: "replace", reason: "表述不准。", replacement: { title: "超时后未取消底层请求", body: "请传入 AbortSignal。" } });
  await runSampleReview(api);
  fireEvent.click(screen.getByRole("button", { name: "复评「超时后请求仍在运行」" }));
  expect(await screen.findByText("复评：取代")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /历史评审/u }));
  const search = screen.getByRole("searchbox", { name: "搜索评审列表" });
  // Not in the PR's title: only the finding says it.
  fireEvent.change(search, { target: { value: "请求仍在运行" } });
  expect(screen.queryByText("没有匹配的评审。")).toBeNull();
  // Nor the title a re-evaluation gave it.
  fireEvent.change(search, { target: { value: "未取消底层请求" } });
  expect(screen.queryByText("没有匹配的评审。")).toBeNull();
  fireEvent.change(search, { target: { value: "完全不相关的词" } });
  expect(screen.getByText("没有匹配的评审。")).toBeVisible();
});

it("tells a reader who went elsewhere that the review finished", async () => {
  const shown: { title: string; body: string | undefined }[] = [];
  const notices: FakeNotification[] = [];
  class FakeNotification {
    static permission = "granted";
    onclick: (() => void) | null = null;
    constructor(title: string, options?: NotificationOptions) { shown.push({ title, body: options?.body }); notices.push(this); }
  }
  vi.stubGlobal("Notification", FakeNotification);
  const away = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  try {
    const api = createPreviewApi();
    const open = vi.spyOn(api, "openSurface");
    await runSampleReview(api);
    await waitFor(() => expect(shown).toEqual([{ title: "PR 评审 · 评审完成", body: "sample/app#123 · 1 个问题（P2 ×1）" }]));
    // Clicking it goes to the review page, on this record.
    act(() => notices[0]!.onclick?.());
    expect(open).toHaveBeenCalledWith("pr-review");
    expect(screen.getByRole("button", { name: /历史评审/u })).toHaveAttribute("aria-pressed", "true");
  } finally {
    away.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("tells a reader who went elsewhere that re-evaluating every finding ended", async () => {
  const shown: { title: string; body: string | undefined }[] = [];
  class FakeNotification {
    static permission = "granted";
    onclick: (() => void) | null = null;
    constructor(title: string, options?: NotificationOptions) { shown.push({ title, body: options?.body }); }
  }
  vi.stubGlobal("Notification", FakeNotification);
  const away = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  try {
    const api = createPreviewApi();
    const run = api.runPrReview;
    vi.spyOn(api, "runPrReview").mockImplementation(async (input) => {
      const report = await run(input);
      return { ...report, findings: [report.findings[0]!, { ...report.findings[0]!, title: "计时器未清理", line: 13 }] };
    });
    vi.spyOn(api, "reevaluatePrReviewFinding").mockResolvedValue({ verdict: "keep", reason: "成立。", replacement: null });
    await runSampleReview(api);
    shown.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "全部复评（2）" }));
    await waitFor(() => expect(shown).toEqual([{ title: "PR 评审 · 全部复评完成", body: "sample/app#123 · 已复评 2 / 2 条" }]));
  } finally {
    away.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("copies one finding with the line and commit it is about, to hand to a coding agent", async () => {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  await runSampleReview(createPreviewApi());
  fireEvent.click(screen.getByRole("button", { name: "复制「超时后请求仍在运行」" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(`**P2 · 超时后请求仍在运行**\n\n计时器只拒绝等待中的 Promise，底层请求不会取消。应将 AbortSignal 传入请求，并在结束时清理计时器。\n\n位置：\`src/request.ts:12\`（新版本，sample/app#123 @ ${"a".repeat(12)}）`));
  expect(await screen.findByText("已复制为 Markdown。")).toBeVisible();
});

it("copies the decisions a finding cites along with it", async () => {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const api = createPreviewApi();
  const run = api.runPrReview;
  vi.spyOn(api, "runPrReview").mockImplementation(async (input) => {
    const report = await run(input);
    const record = { source: "decisions", id: "DEC-7", title: "请求超时必须释放资源", kind: "historical_decision", current: true, summary: "超时后取消底层请求。", appliesWhen: "", caution: "", warnings: [], lifecycleState: "active", sourceRef: { relativePath: "decisions/DEC-7.md" } };
    return { ...report, findings: [{ ...report.findings[0]!, decisionIndexes: [1] }], evidence: [{ index: 1, record: record as never }] };
  });
  await runSampleReview(api);
  fireEvent.click(screen.getByRole("button", { name: "复制「超时后请求仍在运行」" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining("相关决策：\n- [1] decisions/DEC-7 请求超时必须释放资源")));
});

it("says a decision whose standing is unsure is to be checked, not replaced", async () => {
  const api = createPreviewApi();
  const run = api.runPrReview;
  vi.spyOn(api, "runPrReview").mockImplementation(async (input) => {
    const report = await run(input);
    // Related to another by hand, then edited: whether it still stands is not known.
    const record = { source: "decisions", id: "DEC-7", title: "请求超时必须释放资源", kind: "historical_decision", current: false, summary: "超时后取消底层请求。", appliesWhen: "", caution: "", warnings: [], lifecycleState: "uncertain", sourceRef: { relativePath: "decisions/DEC-7.md" } };
    return { ...report, evidence: [{ index: 1, record: record as never }] };
  });
  await runSampleReview(api);
  expect(screen.getByText(/历史选择 · 有效状态待核对/u, { selector: "p" })).toBeInTheDocument();
  expect(screen.queryByText(/已替代或退役/u)).toBeNull();
});

it("shows what each answer spent next to its model", async () => {
  const api = createPreviewApi();
  vi.spyOn(api, "followUpPrReview").mockResolvedValue({ answer: "## 概览\n\n修复超时。", usage: { input: 2_400, output: 700, unreportedCalls: 0, cost: { currency: "¥", amount: 0.0104 } } });
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  fireEvent.click(await screen.findByRole("radio", { name: /PR 概览/ }));
  const run = screen.getByRole("button", { name: "生成 PR 概览" });
  await waitFor(() => expect(run).toBeEnabled());
  fireEvent.click(run);
  expect(await screen.findByText("3.1k tokens ≈ ¥0.0104")).toBeVisible();
});

it("says what a review spent, as a floor when a call reported nothing", async () => {
  const api = createPreviewApi();
  const run = api.runPrReview;
  vi.spyOn(api, "runPrReview").mockImplementation(async (input) => ({ ...(await run(input)), usage: { input: 30_000, output: 8_200, unreportedCalls: 0, cost: { currency: "¥", amount: 0.3056 } } }));
  await runSampleReview(api);
  expect(screen.getByText(/3 次模型调用（38\.2k tokens ≈ ¥0\.3056）/u)).toBeVisible();
  const report = { ...(await run({ snapshotId: "00000000-0000-4000-8000-000000000001", runId: "00000000-0000-4000-8000-000000000002", profileId: "local", focus: "" })), usage: { input: 900, output: 100, unreportedCalls: 1 } };
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  expect(reviewMarkdown(snapshot, report)).toContain("评审分组：1 组\n模型调用：3 次（至少 1.0k tokens）");
});

it("says the side, the steps and the evidence in the exported report as the page does", () => {
  const report = {
    status: "completed", summary: "发现 1 个问题。",
    findings: [{ priority: "P2", title: "缺少空值判断", path: "src/login.ts", line: 42, side: "new", body: "user 可能为空。", decisionIndexes: [1] }],
    reviewedFiles: ["src/login.ts"], unreviewedFiles: [], readFiles: ["src/login.ts"], unreadFiles: [], steps: 2, warnings: [],
    history: [{ id: "e1", kind: "model", status: "done", at: "2026-10-05T02:30:00.000Z", message: "评审分组 1/1：src/login.ts" }],
    evidence: [{ index: 1, record: {
      source: "decision", id: "DEC-1", title: "登录先校验会话", summary: "先校验。", warnings: [], current: false,
      sourceRef: { relativePath: "decisions/2026/09/登录.md", contentHash: "h" },
      applicability: { status: "needs_review", reasons: [], scope: {} }, lifecycleState: "superseded",
    } }, { index: 2, record: {
      source: "decision", id: "DEC-2", title: "旧的登录方案", summary: "不再用。", warnings: [], current: true,
      sourceRef: { relativePath: "decisions/2026/08/旧登录.md", contentHash: "g" },
      applicability: { status: "out_of_scope", reasons: [], scope: {} }, lifecycleState: "current",
    } }, { index: 3, record: {
      source: "summarize", id: "DEC-3", title: "会话字段跨仓同发", summary: "两个仓库一起发。", warnings: [], current: true, project: "clarai", scopeState: "unrecorded",
      sourceRef: { relativePath: "summarize/DEC-3.md", contentHash: "f" },
      applicability: { status: "out_of_scope", reasons: ["当前项目不在记录的适用项目范围内。"], scope: {} }, lifecycleState: "current",
    } }],
  };
  const markdown = reviewMarkdown({ title: "修复登录", reference: "acme/app#12", sourceCommit: "a".repeat(40), destinationCommit: "b".repeat(40), rules: [] } as never, report as never);
  // It said "(new)", "2026-10-05T02:30:00.000Z · … · done", "范围：needs_review", "状态：superseded" and "pi agent".
  expect(markdown).toContain("src/login.ts:42（新版本）");
  expect(markdown).toContain("评审规则：无\n仓库规范：无");
  expect(markdown).toMatch(/2026年10月[45]日 \d{2}:\d{2}:\d{2} · 评审分组 1\/1：src\/login\.ts · 已完成/u);
  expect(markdown).toContain("范围：适用范围需核对\n状态：已替代或退役");
  // Checked and found not to apply, it was said to be still to check.
  expect(markdown).toContain("范围：明确不适用\n状态：未识别到替代");
  // Kept out only by the project it is filed under, which a deep review reads too.
  expect(markdown).toContain("范围：其它项目（clarai）\n状态：未识别到替代");
  expect(markdown).toContain("本报告由 AI 评审生成");
  expect(markdown).not.toMatch(/\(new\)|· done|needs_review|superseded|pi agent/u);
});

it("dates the exported report's steps in the zone the Mac is in now", () => {
  const zone = process.env.TZ;
  process.env.TZ = "Asia/Shanghai";
  try {
    const snapshot = { title: "修复登录", reference: "acme/app#12", sourceCommit: "a".repeat(40), destinationCommit: "b".repeat(40), rules: [] } as never;
    const report = {
      status: "completed", summary: "", findings: [], reviewedFiles: [], unreviewedFiles: [], readFiles: [], unreadFiles: [], steps: 0, warnings: [], evidence: [],
      history: [{ id: "e1", kind: "model", status: "done", at: "2026-10-05T02:30:00.000Z", message: "评审分组 1/1：src/login.ts" }],
    } as never;
    expect(reviewMarkdown(snapshot, report)).toContain("2026年10月5日 10:30:00 · 评审分组 1/1：src/login.ts · 已完成");

    // Taken to Los Angeles with the app open: the page's clock followed, the report's steps kept Shanghai's.
    process.env.TZ = "America/Los_Angeles";
    expect(reviewMarkdown(snapshot, report)).toContain("2026年10月4日 19:30:00 · 评审分组 1/1：src/login.ts · 已完成");
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});

it("writes dates the way the rest of the app does, whatever the system region", async () => {
  await runSampleReview(createPreviewApi());
  expect(screen.getByText(/9月21日 更新/u)).toBeVisible();
  expect(screen.getByText(/\d{4}年\d{1,2}月\d{1,2}日 \d{2}:\d{2}/u)).toBeVisible();
  expect(screen.queryByText(/\d{1,2}\/\d{1,2}\/\d{4}/u)).toBeNull();
});

it("opens the diff on a finding's own line", async () => {
  const api = createPreviewApi();
  // A hunk that holds the finding's line: new line 12 is the inserted one.
  vi.spyOn(api, "loadPrReviewDiff").mockResolvedValue({ diff: "diff --git a/src/request.ts b/src/request.ts\n--- a/src/request.ts\n+++ b/src/request.ts\n@@ -10,3 +10,4 @@\n line10\n line11\n+changed12\n line12\n" });
  await runSampleReview(api);
  // No decision came up: said outright, with what that does not mean, rather than folded away.
  expect(screen.getByText("决策证据：未取得相关决策证据；不能据此断言没有历史约束。")).toBeVisible();
  // How much was found, and how serious, before reading the findings one by one.
  const result = screen.getByRole("listitem", { name: "评审结果" });
  expect(result.querySelector(".review-result-head")).toHaveTextContent("评审完成P2 ×1");
  expect(within(result).getByText(/^1 个问题 · 完成评审 1\/1 个文件/u)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /src\/request\.ts:12/ }));
  const dialog = await screen.findByRole("dialog", { name: "PR 详情" });
  expect(await within(dialog).findByText(/已定位到第 12 行/)).toBeVisible();
  expect(dialog.querySelector(".diff-code-selected")).toHaveTextContent("changed12");
});

it("still says a dropped finding's line is outside the diff, since nothing above the diff lists it", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  const report = await api.runPrReview({ snapshotId: snapshot.snapshotId, runId: "00000000-0000-4000-8000-000000000002", profileId: "local", focus: "" });
  saveReviewHistory([{ kind: "review", model: "本机", focus: "", draft: "", turns: [], events: [], state: "finished", error: "", rechecks: [], published: [],
    connectionId: "00000000-0000-4000-8000-000000000011", id: "00000000-0000-4000-8000-0000000000e1", at: "2026-09-30T11:00:00.000Z", snapshot, report,
    verdicts: [{ finding: 0, verdict: "drop", reason: "误报。", replacement: null, at: "2026-09-30T11:10:00.000Z", model: "本机" }] }]);
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /历史评审/u }));
  fireEvent.click((await screen.findAllByRole("button", { name: /示例：调整请求超时/u }))[0]!);
  fireEvent.click(await screen.findByRole("button", { name: /src\/request\.ts:12/ }));
  const dialog = await screen.findByRole("dialog", { name: "PR 详情" });
  expect(await within(dialog).findByText(/第 12 行不在 diff 中/)).toBeVisible();
  expect(within(dialog).queryByRole("list", { name: "未显示在 diff 中的评审问题" })).toBeNull();
});

it("shows the reader's own words in their bubble on the right, with no label above them", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  const report = await api.runPrReview({ snapshotId: snapshot.snapshotId, runId: "00000000-0000-4000-8000-000000000002", profileId: "local", focus: "" });
  saveReviewHistory([{ kind: "review", model: "本机", focus: "看超时处理", draft: "", events: [], state: "finished", error: "", rechecks: [], published: [], verdicts: [],
    connectionId: "00000000-0000-4000-8000-000000000011", id: "00000000-0000-4000-8000-0000000000e2", at: "2026-09-30T11:00:00.000Z", snapshot, report,
    turns: [{ id: "00000000-0000-4000-8000-0000000000f1", at: "2026-09-30T11:05:00.000Z", model: "本机", question: "这里为什么要取消请求？", answer: "超时后请求仍在运行。", state: "done" }] }]);
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /历史评审/u }));
  fireEvent.click((await screen.findAllByRole("button", { name: /示例：调整请求超时/u }))[0]!);
  // A screen reader is told who speaks by name, as two columns tell the eye.
  expect(await screen.findByRole("listitem", { name: "追问" })).toHaveTextContent("这里为什么要取消请求？");
  expect(screen.getByRole("listitem", { name: "评审要求" })).toHaveTextContent("看超时处理");
  // The conversation already sits in two columns: "你" above the reader's own words said nothing the layout did not.
  expect(screen.queryByText("你")).toBeNull();
});

it("finds a finding's line in the whole file when the diff does not reach it", async () => {
  const api = createPreviewApi();
  vi.spyOn(api, "loadPrReviewFile").mockResolvedValue({ content: Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"), binary: false });
  await runSampleReview(api);
  fireEvent.click(screen.getByRole("button", { name: /src\/request\.ts:12/ }));
  const dialog = await screen.findByRole("dialog", { name: "PR 详情" });
  // The preview diff only covers lines 1–5: the list above the diff names line 12, and the toolbar does not say it again.
  expect(await within(dialog).findByRole("list", { name: "未显示在 diff 中的评审问题" })).toHaveTextContent("第 12 行 · 超时后请求仍在运行");
  expect(within(dialog).queryByText(/第 12 行不在 diff 中/)).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "文件内容" }));
  const lines = await within(dialog).findByRole("list", { name: "文件内容" });
  expect(within(lines).getAllByRole("listitem").find(item => item.getAttribute("aria-current") === "true")).toHaveTextContent("line 12");
});

it("reads an old-side finding's line in the target commit's file", async () => {
  const api = createPreviewApi();
  const run = api.runPrReview;
  vi.spyOn(api, "runPrReview").mockImplementation(async (input) => {
    const report = await run(input);
    return { ...report, findings: report.findings.map(finding => ({ ...finding, side: "old" as const })) };
  });
  const read = vi.spyOn(api, "loadPrReviewFile").mockResolvedValue({ content: Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"), binary: false });
  await runSampleReview(api);
  fireEvent.click(screen.getByRole("button", { name: /src\/request\.ts:12（旧版本）/ }));
  const dialog = await screen.findByRole("dialog", { name: "PR 详情" });
  fireEvent.click(await within(dialog).findByRole("button", { name: "文件内容" }));
  const lines = await within(dialog).findByRole("list", { name: "文件内容" });
  expect(within(lines).getAllByRole("listitem").find(item => item.getAttribute("aria-current") === "true")).toHaveTextContent("line 12");
  expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ side: "old" }));
});

it("re-evaluates a finding and drafts its comment from the replacement", async () => {
  const api = createPreviewApi();
  const reevaluate = vi.spyOn(api, "reevaluatePrReviewFinding");
  await runSampleReview(api);
  fireEvent.click(screen.getByRole("button", { name: "复评「超时后请求仍在运行」" }));
  expect(await screen.findByText("复评：取代")).toBeVisible();
  expect(screen.getByRole("note", { name: "复评结论" })).toHaveTextContent("超时后应取消底层请求并清理计时器");
  expect(reevaluate).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "00000000-0000-4000-8000-000000000011", finding: expect.objectContaining({ path: "src/request.ts", line: 12 }) }));
  expect(screen.getByText("超时后应取消底层请求并清理计时器")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "把「超时后请求仍在运行」转为 PR 评论" }));
  const form = await screen.findByRole("form", { name: "发布评论表单" });
  expect((within(form).getByLabelText("评论内容") as HTMLTextAreaElement).value).toContain("**P2 · 超时后应取消底层请求并清理计时器**");
  expect(loadReviewHistory().entries[0]!.verdicts).toEqual([expect.objectContaining({ finding: 0, verdict: "replace" })]);
});

it("does not call a re-evaluation the reader stopped a failure", async () => {
  const api = createPreviewApi();
  let reject!: (error: Error) => void;
  vi.spyOn(api, "reevaluatePrReviewFinding").mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  vi.spyOn(api, "cancelPrReview").mockImplementation(async () => { reject(new Error("复评已停止。")); });
  await runSampleReview(api);
  fireEvent.click(screen.getByRole("button", { name: "复评「超时后请求仍在运行」" }));
  fireEvent.click(await screen.findByRole("button", { name: "停止复评" }));

  await waitFor(() => expect(screen.getByRole("button", { name: "复评「超时后请求仍在运行」" })).toBeEnabled());
  expect(screen.queryByText(/复评未完成/u)).toBeNull();
});

it("turns a finding down with a reason, and tells the next review of the repository about it", async () => {
  const api = createPreviewApi();
  const run = vi.spyOn(api, "runPrReview");
  await runSampleReview(api);
  fireEvent.click(screen.getByRole("button", { name: "不采纳「超时后请求仍在运行」" }));
  const form = await screen.findByRole("form", { name: "不采纳这条问题" });
  fireEvent.change(within(form).getByLabelText("不采纳的原因"), { target: { value: "有意为之：超时由上层统一取消。" } });
  fireEvent.click(within(form).getByRole("button", { name: "不采纳" }));
  expect(await screen.findByRole("note", { name: "不采纳" })).toHaveTextContent("你不采纳 · 有意为之：超时由上层统一取消。");
  expect(screen.getByText(/^1 个问题（1 个不采纳） · 完成评审/u)).toBeVisible();
  // Closed like a drop, and the reviewer's own until taken back: no posting, no re-evaluation.
  expect(screen.queryByRole("button", { name: "把「超时后请求仍在运行」转为 PR 评论" })).toBeNull();
  expect(screen.queryByRole("button", { name: "复评「超时后请求仍在运行」" })).toBeNull();
  await waitFor(() => expect(loadReviewHistory().entries[0]!.verdicts).toEqual([expect.objectContaining({ finding: 0, verdict: "drop", by: "reviewer", reason: "有意为之：超时由上层统一取消。" })]));
  fireEvent.click(screen.getByRole("button", { name: "重新评审最新提交" }));
  expect((await screen.findByText("条不采纳过的问题")).parentElement).toHaveTextContent("1条不采纳过的问题超时后请求仍在运行 · 告诉模型不再提同类问题");
  const start = await screen.findByRole("button", { name: "开始评审" });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  await waitFor(() => expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ dismissed: [expect.objectContaining({ title: "超时后请求仍在运行", path: "src/request.ts", reason: "有意为之：超时由上层统一取消。" })] })));
});

it("tells the next review of the repository what the reviewer put on its PRs as comments", async () => {
  const api = createPreviewApi();
  const run = vi.spyOn(api, "runPrReview");
  const { submit } = await reviewSample(api);
  fireEvent.click(submit);
  expect(await screen.findByText("已发布为 PR 评论")).toBeVisible();
  expect(run).toHaveBeenLastCalledWith(expect.not.objectContaining({ published: expect.anything() }));
  fireEvent.click(screen.getByRole("button", { name: "重新评审最新提交" }));
  expect((await screen.findByText("条发布过的问题")).parentElement).toHaveTextContent("1条发布过的问题超时后请求仍在运行 · 告诉模型团队在意同类问题");
  const start = await screen.findByRole("button", { name: "开始评审" });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  await waitFor(() => expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ published: [{ title: "超时后请求仍在运行", path: "src/request.ts" }] })));
});

/** The reviewer's own no, at a time. */
const declined = (finding: number, at: string, reason: string): ReviewHistoryEntry["verdicts"][number] => ({ finding, verdict: "drop", reason, replacement: null, at, model: "评审者", by: "reviewer" });
/** Earlier reviews of other PRs of the sample repository, each with the sample finding and a second one, and its verdicts. */
const earlierReviews = async (api: ReturnType<typeof createPreviewApi>, reviews: Array<{ reference: string; at: string; verdicts: ReviewHistoryEntry["verdicts"] }>) => {
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  const report = await api.runPrReview({ snapshotId: snapshot.snapshotId, runId: "00000000-0000-4000-8000-000000000002", profileId: "local", focus: "" });
  const findings = [report.findings[0]!, { ...report.findings[0]!, title: "重试没有上限", line: 30 }] as const;
  saveReviewHistory(reviews.map(({ reference, at, verdicts }, index) => ({ id: `00000000-0000-4000-8000-0000000000c${index}`, kind: "review", at, model: "本机", focus: "", draft: "", turns: [], events: [],
    state: "finished", error: "", published: [], rechecks: [], connectionId: "00000000-0000-4000-8000-000000000011", report: { ...report, findings: [...findings], history: [] }, snapshot: { ...snapshot, reference }, verdicts })));
  return findings;
};

it("lists what was turned down in the repository, and takes each back from every review it was turned down in", async () => {
  const api = createPreviewApi();
  const kept = { finding: 1, verdict: "keep" as const, reason: "成立。", replacement: null, at: "2026-09-29T10:06:00.000Z", model: "本机" };
  const [timeout, retry] = await earlierReviews(api, [
    { reference: "sample/app#101", at: "2026-09-30T10:00:00.000Z", verdicts: [declined(0, "2026-09-30T10:05:00.000Z", "上层统一取消。"), declined(1, "2026-09-30T10:06:00.000Z", "重试由网关限制。")] },
    { reference: "sample/app#100", at: "2026-09-29T10:00:00.000Z", verdicts: [declined(0, "2026-09-29T10:05:00.000Z", "旧的原因。"), kept] },
  ]);
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  const card = (await screen.findByText("条不采纳过的问题")).parentElement!;
  expect(card).toHaveTextContent("2条不采纳过的问题");
  fireEvent.click(within(card).getByRole("button", { name: "查看不采纳过的问题" }));
  const list = within(await screen.findByRole("dialog", { name: "不采纳过的问题" })).getByRole("list", { name: "不采纳过的问题" });
  const items = within(list).getAllByRole("listitem");
  // Newest first; the newest reason stands, and the list says one was turned down twice.
  expect(items.map(item => item.querySelector("strong")!.textContent)).toEqual([retry!.title, timeout!.title]);
  expect(items[1]).toHaveTextContent(`${timeout!.title}撤回上层统一取消。${timeout!.path} · sample/app#101`);
  expect(items[1]).toHaveTextContent("不采纳过 2 次");
  // Its button goes with its row: focus stays in the dialog, on the row taking its place, then on closing it.
  fireEvent.click(within(list).getByRole("button", { name: `撤回「${retry!.title}」（${retry!.path}）的不采纳` }));
  const next = await within(list).findByRole("button", { name: `撤回「${timeout!.title}」（${timeout!.path}）的不采纳` });
  // Given time under a full parallel run: the withdrawal's writes, then the refocus, took past a second there.
  await waitFor(() => expect(next).toHaveFocus(), { timeout: 3_000 });
  fireEvent.click(next);
  expect(await screen.findByText("都已撤回，以后评审这个仓库时不再告诉模型。")).toBeVisible();
  await waitFor(() => expect(screen.getByRole("button", { name: "关闭不采纳过的问题" })).toHaveFocus(), { timeout: 3_000 });
  // A model's verdict in the same review stays.
  await waitFor(() => expect(loadReviewHistory().entries.map(item => item.verdicts)).toEqual([[], [kept]]));
});

it("marks a finding only by what was turned down before this review started", async () => {
  const api = createPreviewApi();
  await earlierReviews(api, [{ reference: "sample/app#101", at: "2026-09-30T10:00:00.000Z", verdicts: [declined(0, "2099-01-01T00:00:00.000Z", "以后才不采纳。")] }]);
  // The review finds the sample finding under its own name: nothing marks it.
  await runSampleReview(api);
  expect(screen.queryByText(/不采纳过同一问题/u)).toBeNull();
});

it("marks a finding like one turned down before, with the reason, and offers that reason to turn it down again", async () => {
  const api = createPreviewApi();
  const [finding] = await earlierReviews(api, [{ reference: "sample/app#101", at: "2026-09-30T10:00:00.000Z", verdicts: [declined(0, "2026-09-30T10:05:00.000Z", "上层统一取消。")] }]);
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  const start = await screen.findByRole("button", { name: "开始评审" });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  expect(await screen.findByRole("heading", { name: `P2 ${finding.title} 以前不采纳过` })).toBeVisible();
  expect(screen.getByText("你在 sample/app#101 不采纳过同一问题：上层统一取消。")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: `不采纳「${finding.title}」` }));
  const form = await screen.findByRole("form", { name: "不采纳这条问题" });
  expect(within(form).getByLabelText("不采纳的原因")).toHaveValue("上层统一取消。");
});

it("asks about one finding from the follow-up box, after what is already typed there", async () => {
  const api = createPreviewApi();
  await runSampleReview(api);
  const box = screen.getByLabelText("继续追问");
  fireEvent.click(screen.getByRole("button", { name: "追问「超时后请求仍在运行」" }));
  expect(box).toHaveValue("关于「超时后请求仍在运行」（src/request.ts:12）：");
  expect(box).toHaveFocus();
  fireEvent.change(box, { target: { value: "先问一句" } });
  fireEvent.click(screen.getByRole("button", { name: "追问「超时后请求仍在运行」" }));
  expect(box).toHaveValue("先问一句\n关于「超时后请求仍在运行」（src/request.ts:12）：");
});

it("keeps the finding named when what is typed would leave it no room", async () => {
  const api = createPreviewApi();
  await runSampleReview(api);
  const box = screen.getByLabelText("继续追问") as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: "问".repeat(2_000) } });
  fireEvent.click(screen.getByRole("button", { name: "追问「超时后请求仍在运行」" }));
  expect(box.value.endsWith("\n关于「超时后请求仍在运行」（src/request.ts:12）：")).toBe(true);
  expect(box.value.length).toBeLessThanOrEqual(2_000);
});

it("takes a turned-down finding back, open again", async () => {
  const api = createPreviewApi();
  await runSampleReview(api);
  fireEvent.click(screen.getByRole("button", { name: "不采纳「超时后请求仍在运行」" }));
  fireEvent.click(within(await screen.findByRole("form", { name: "不采纳这条问题" })).getByRole("button", { name: "不采纳" }));
  const note = await screen.findByRole("note", { name: "不采纳" });
  expect(note).toHaveTextContent("没有写原因。");
  fireEvent.click(within(note).getByRole("button", { name: "撤回" }));
  expect(screen.queryByRole("note", { name: "不采纳" })).toBeNull();
  expect(screen.getByRole("button", { name: "把「超时后请求仍在运行」转为 PR 评论" })).toBeVisible();
  await waitFor(() => expect(loadReviewHistory().entries[0]!.verdicts).toEqual([]));
});

it("hands a review what the reviewer turned down in that repository on that connection, newest first, once per finding", () => {
  const connectionId = "00000000-0000-4000-8000-000000000011";
  const finding = { priority: "P2" as const, title: "超时未取消", body: "请求仍在运行。", path: "src/a.ts", side: "new" as const, line: 3, decisionIndexes: [] };
  const snapshot = { snapshotId: "00000000-0000-4000-8000-000000000001", reference: "org/app#1", title: "PR", description: "", project: "app", sourceCommit: "a".repeat(40), destinationCommit: "b".repeat(40), files: [{ path: "src/a.ts", status: "modified" }], warnings: [] };
  const report = { status: "completed" as const, summary: "三处问题", findings: [finding, { ...finding, title: "重试没有上限", line: 9 }, { ...finding, title: "日志缺少上下文", line: 12 }], evidence: [], readFiles: [], unreadFiles: [], reviewedFiles: [], unreviewedFiles: [], warnings: [], steps: 1, history: [] };
  const no = (index: number, at: string, reason: string) => ({ finding: index, verdict: "drop" as const, reason, replacement: null, at, model: "评审者", by: "reviewer" as const });
  const entry = (id: string, reference: string, verdicts: ReviewHistoryEntry["verdicts"], connection = connectionId): ReviewHistoryEntry => ({ id, kind: "review", at: "2026-09-30T10:00:00.000Z", model: "本机", focus: "", draft: "", turns: [], events: [],
    state: "finished", error: "", published: [], rechecks: [], connectionId: connection, snapshot: { ...snapshot, reference }, report, verdicts });
  const history = [
    entry("00000000-0000-4000-8000-0000000000a1", "org/app#2", [no(0, "2026-09-30T10:05:00.000Z", "上层统一取消。")]),
    // Turned down again later: the latest reason stands. A model's drop is not the reviewer's.
    entry("00000000-0000-4000-8000-0000000000a2", "org/app#1", [no(0, "2026-09-29T10:05:00.000Z", "旧的原因。"), no(1, "2026-09-29T10:06:00.000Z", "重试由网关限制。"),
      { finding: 2, verdict: "drop", reason: "模型认为是误报。", replacement: null, at: "2026-09-29T10:07:00.000Z", model: "本机" }]),
    entry("00000000-0000-4000-8000-0000000000a3", "org/other#1", [no(0, "2026-09-30T11:00:00.000Z", "别的仓库。")]),
    entry("00000000-0000-4000-8000-0000000000a4", "org/app#3", [no(0, "2026-09-30T12:00:00.000Z", "别的连接。")], "00000000-0000-4000-8000-000000000012"),
    // A reason as long as a re-evaluation's is cut to what a review request carries.
    entry("00000000-0000-4000-8000-0000000000a5", "org/app#4", [no(2, "2026-09-28T10:00:00.000Z", `${"长".repeat(1_999)}。`)]),
  ];
  const dismissed = dismissedIn(history, connectionId, "org/app#5");
  expect(dismissed).toEqual([
    { title: "超时未取消", body: "请求仍在运行。", path: "src/a.ts", reason: "上层统一取消。" },
    { title: "重试没有上限", body: "请求仍在运行。", path: "src/a.ts", reason: "重试由网关限制。" },
    { title: "日志缺少上下文", body: "请求仍在运行。", path: "src/a.ts", reason: "长".repeat(500) },
  ]);
  expect(prReviewRunSchema.parse({ snapshotId: snapshot.snapshotId, runId: "00000000-0000-4000-8000-0000000000b1", profileId: "local", focus: "", dismissed }).dismissed).toEqual(dismissed);
});

it("hands a review what the reviewer put on that repository's PRs as comments, newest first, once per finding, as posted, not what they turned down", () => {
  const connectionId = "00000000-0000-4000-8000-000000000011";
  const finding = { priority: "P2" as const, title: "超时未取消", body: "请求仍在运行。", path: "src/a.ts", side: "new" as const, line: 3, decisionIndexes: [] };
  const snapshot = { snapshotId: "00000000-0000-4000-8000-000000000001", reference: "org/app#1", title: "PR", description: "", project: "app", sourceCommit: "a".repeat(40), destinationCommit: "b".repeat(40), files: [{ path: "src/a.ts", status: "modified" }], warnings: [] };
  const report = { status: "completed" as const, summary: "三处问题", findings: [finding, { ...finding, title: "重试没有上限", line: 9 }, { ...finding, title: "日志缺少上下文", line: 12 }], evidence: [], readFiles: [], unreadFiles: [], reviewedFiles: [], unreviewedFiles: [], warnings: [], steps: 1, history: [] };
  const entry = (id: string, reference: string, published: ReviewHistoryEntry["published"], verdicts: ReviewHistoryEntry["verdicts"] = [], connection = connectionId): ReviewHistoryEntry => ({ id, kind: "review", at: "2026-09-30T10:00:00.000Z", model: "本机", focus: "", draft: "", turns: [], events: [],
    state: "finished", error: "", published, rechecks: [], connectionId: connection, snapshot: { ...snapshot, reference }, report, verdicts });
  const history = [
    entry("00000000-0000-4000-8000-0000000000a1", "org/app#2", [{ finding: 1, at: "2026-09-30T10:05:00.000Z" }]),
    // Posted again in an older review: once is enough. Posted and later turned down: not something the team cares for.
    entry("00000000-0000-4000-8000-0000000000a2", "org/app#1", [{ finding: 1, at: "2026-09-29T10:05:00.000Z" }, { finding: 0, at: "2026-09-29T10:06:00.000Z" }, { finding: 2, at: "2026-09-29T10:07:00.000Z" }],
      [{ finding: 2, verdict: "drop", reason: "其实不必。", replacement: null, at: "2026-09-29T11:00:00.000Z", model: "评审者", by: "reviewer" }]),
    entry("00000000-0000-4000-8000-0000000000a3", "org/other#1", [{ finding: 2, at: "2026-09-30T11:00:00.000Z" }]),
    entry("00000000-0000-4000-8000-0000000000a4", "org/app#3", [{ finding: 2, at: "2026-09-30T12:00:00.000Z" }], [], "00000000-0000-4000-8000-000000000012"),
    // Replaced by a re-evaluation, then posted: as posted.
    entry("00000000-0000-4000-8000-0000000000a6", "org/app#6", [{ finding: 0, at: "2026-09-30T13:00:00.000Z" }],
      [{ finding: 0, verdict: "replace", reason: "表述不准。", replacement: { title: "超时后应取消请求", body: "请传入 AbortSignal。" }, at: "2026-09-30T12:30:00.000Z", model: "本机" }]),
    // Turned down in another review: the no stands, and the review is not told both.
    entry("00000000-0000-4000-8000-0000000000a7", "org/app#7", [],
      [{ finding: 1, verdict: "drop", reason: "重试由网关限制。", replacement: null, at: "2026-09-30T14:00:00.000Z", model: "评审者", by: "reviewer" }]),
  ];
  const published = publishedIn(history, connectionId, "org/app#5");
  expect(published).toEqual([{ title: "超时后应取消请求", path: "src/a.ts" }, { title: "超时未取消", path: "src/a.ts" }]);
  expect(publishedIn(history.slice(0, -1), connectionId, "org/app#5").map(item => item.title)).toEqual(["超时后应取消请求", "重试没有上限", "超时未取消"]);
  expect(prReviewRunSchema.parse({ snapshotId: snapshot.snapshotId, runId: "00000000-0000-4000-8000-0000000000b1", profileId: "local", focus: "", published }).published).toEqual(published);
});

it("exports what became of each finding: its re-evaluation and whether it was posted", () => {
  const snapshot = { snapshotId: "00000000-0000-4000-8000-000000000001", reference: "org/app#1", title: "PR", description: "", project: "app", sourceCommit: "a".repeat(40), destinationCommit: "b".repeat(40), files: [{ path: "src/a.ts", status: "modified" }], warnings: [] };
  const finding = { priority: "P2" as const, title: "超时未取消", body: "请求仍在运行。", path: "src/a.ts", side: "new" as const, line: 3, decisionIndexes: [] };
  const report = { status: "completed" as const, summary: "一处问题", findings: [finding, { ...finding, title: "第二条", line: 9 }], evidence: [], readFiles: ["src/a.ts"], unreadFiles: [], reviewedFiles: ["src/a.ts"], unreviewedFiles: [], warnings: [], steps: 1, history: [] };
  const markdown = reviewMarkdown(snapshot, report, {
    verdicts: [{ finding: 0, verdict: "replace", reason: "表述不准。", replacement: { title: "超时后应取消请求", body: "请传入 AbortSignal。" }, at: "2026-09-28T09:00:00.000Z", model: "本机" }],
    published: [{ finding: 0, at: "2026-09-28T09:05:00.000Z" }],
  });
  expect(markdown).toContain("决策证据：无\n\n复评：取代 · 表述不准。\n替代评论：超时后应取消请求\n请传入 AbortSignal。\n\n已发布为 PR 评论");
  expect(markdown.split("## P2 第二条")[1]).not.toMatch(/复评|已发布/u);
});

it("says how large the change is, and when code changed without a test", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  const load = vi.spyOn(api, "loadPrReview");
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  expect(await screen.findByText("+12 −4 · 没有改测试")).toBeVisible();
  load.mockResolvedValue({ ...snapshot, changeSize: { added: 30, removed: 2, testFiles: 2, codeFiles: 1 } });
  cleanup();
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  expect(await screen.findByText("+30 −2 · 含 2 个测试文件")).toBeVisible();
});

it("names the matched review rules and opens the rules folder from the preparation view", async () => {
  const api = createPreviewApi();
  const open = vi.spyOn(api, "openReviewRulesDirectory").mockRejectedValueOnce(new Error("denied")).mockResolvedValue(undefined);
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  expect(await screen.findByText(/team\/timeout\.md（code-meeseeks）/u)).toBeVisible();
  expect(screen.getByText("会参考，不重复提出已被指出的问题")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "管理规则" }));
  expect(await screen.findByText("无法打开评审规则目录，请检查权限后重试。")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "管理规则" }));
  await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
});

it("expands /describe into the PR overview request while the chat shows the command", async () => {
  const api = createPreviewApi();
  const followUp = vi.spyOn(api, "followUpPrReview");
  await runSampleReview(api);
  fireEvent.change(screen.getByLabelText("继续追问"), { target: { value: "/describe 重点说明超时处理" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(followUp).toHaveBeenCalledTimes(1));
  expect(followUp.mock.calls[0]![0].question).toMatch(/^按 PR 概览格式回答[\s\S]*\n补充要求：重点说明超时处理$/u);
  // It runs as the overview's own pipeline over the whole PR.
  expect(followUp.mock.calls[0]![0].command).toBe("describe");
  expect(screen.getByText("/describe 重点说明超时处理")).toBeVisible();
  // Anything that is not a known command is asked as written.
  fireEvent.change(screen.getByLabelText("继续追问"), { target: { value: "/unknown 为什么没取消？" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(followUp).toHaveBeenCalledTimes(2));
  expect(followUp.mock.calls[1]![0].question).toBe("/unknown 为什么没取消？");
  expect(followUp.mock.calls[1]![0].command).toBeUndefined();
});

it("keeps the candidates the verification left out under the findings, with their score and why", async () => {
  const api = createPreviewApi();
  await runSampleReview(api);
  const filtered = screen.getByText("核验未通过的候选问题 · 1").closest("details")!;
  expect(filtered).not.toHaveAttribute("open");
  fireEvent.click(screen.getByText("核验未通过的候选问题 · 1"));
  expect(filtered).toHaveTextContent("超时时间写死");
  expect(filtered).toHaveTextContent("src/request.ts:11");
  expect(filtered).toHaveTextContent("置信度 45 · 超时值本来就由调用方传入");
  // One problem stands; the one left out is not counted with it.
  expect(screen.getByText(/^1 个问题 · 完成评审 1\/1 个文件 · 分 1 组/u)).toBeVisible();
});

it("asks for a deep review only when it is ticked, and only for a full review", async () => {
  const api = createPreviewApi();
  const run = vi.spyOn(api, "runPrReview");
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  const deep = await screen.findByRole("checkbox", { name: /深度评审/u });
  expect(deep).not.toBeChecked();
  fireEvent.click(screen.getByRole("radio", { name: /PR 概览/u }));
  expect(screen.queryByRole("checkbox", { name: /深度评审/u })).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: /完整评审/u }));
  fireEvent.click(screen.getByRole("checkbox", { name: /深度评审/u }));
  expect(screen.getByText(/每组两位审查者各最多 6 次调用，另加核验/u)).toBeVisible();
  const start = screen.getByRole("button", { name: "开始评审" });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  await waitFor(() => expect(run).toHaveBeenCalledWith(expect.objectContaining({ depth: "deep" })));
});

it("says how many groups a review takes with the model picked", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  vi.spyOn(api, "loadPrReview").mockResolvedValue({ ...snapshot, fileHunks: { "src/request.ts": [30_000] } });
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  const groups = (await screen.findByText("个评审分组")).parentElement!;
  // The local model reads 4,000 characters at a time; a remote one reads this PR whole.
  expect(groups).toHaveTextContent("8个评审分组按所选模型一次能读的长度，相关文件放在一组");
  fireEvent.change(screen.getByLabelText("评审模型"), { target: { value: "openai-remote" } });
  await waitFor(() => expect(groups).toHaveTextContent("1个评审分组整个 PR 一次读完"));
});

it("says a remote model reviews a few groups at once, and a local one in turn", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  vi.spyOn(api, "loadPrReview").mockResolvedValue({ ...snapshot, fileHunks: { "src/request.ts": [100_000] } });
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  const groups = (await screen.findByText("个评审分组")).parentElement!;
  expect(groups).not.toHaveTextContent("同时评审");
  fireEvent.change(screen.getByLabelText("评审模型"), { target: { value: "openai-remote" } });
  await waitFor(() => expect(groups).toHaveTextContent(/相关文件放在一组，最多 3 组同时评审；/u));
});

it("sends a quick command without discarding the question being typed", async () => {
  const api = createPreviewApi();
  const followUp = vi.spyOn(api, "followUpPrReview");
  await runSampleReview(api);
  fireEvent.change(screen.getByLabelText("继续追问"), { target: { value: "还没写完的问题" } });
  fireEvent.click(within(screen.getByRole("group", { name: "评审指令" })).getByRole("button", { name: "改进建议" }));
  await waitFor(() => expect(followUp).toHaveBeenCalledTimes(1));
  expect(followUp.mock.calls[0]![0].question).toMatch(/^按代码建议格式回答/u);
  expect(followUp.mock.calls[0]![0].command).toBe("improve");
  expect(await screen.findByText("/improve")).toBeVisible();
  expect(screen.getByLabelText("继续追问")).toHaveValue("还没写完的问题");
});

it("still shows that a finding was posted after a later re-evaluation drops it", async () => {
  const api = createPreviewApi();
  vi.spyOn(api, "reevaluatePrReviewFinding").mockResolvedValue({ verdict: "drop", reason: "误报。", replacement: null });
  const { submit } = await reviewSample(api);
  fireEvent.click(submit);
  await waitFor(() => expect(screen.queryByRole("form", { name: "发布评论表单" })).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "复评「超时后请求仍在运行」" }));
  expect(await screen.findByText("复评：撤销（误报）")).toBeVisible();
  expect(screen.getByText("已发布为 PR 评论")).toBeVisible();
});

it("closes a finding the re-evaluation drops instead of offering to post it", async () => {
  const api = createPreviewApi();
  vi.spyOn(api, "reevaluatePrReviewFinding").mockResolvedValue({ verdict: "drop", reason: "计时器已在 finally 中清理，属于误报。", replacement: null });
  await runSampleReview(api);
  fireEvent.click(screen.getByRole("button", { name: "复评「超时后请求仍在运行」" }));
  expect(await screen.findByText("复评：撤销（误报）")).toBeVisible();
  expect(screen.queryByRole("button", { name: /转为 PR 评论/u })).toBeNull();
  expect(screen.getByRole("button", { name: "复评「超时后请求仍在运行」" })).toHaveTextContent("重新复评");
});

it("shows a PR read before at once and confirms its commits in the background without turning busy", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  vi.spyOn(api, "peekPrReview").mockResolvedValue(snapshot);
  let confirm!: (value: typeof snapshot) => void;
  vi.spyOn(api, "loadPrReview").mockReturnValue(new Promise((resolve) => { confirm = resolve; }));
  const prefetch = vi.spyOn(api, "prefetchPrReviews");
  const run = vi.spyOn(api, "runPrReview");
  render(<PrReviewPanel api={api} />);
  await waitFor(() => expect(prefetch).toHaveBeenCalledWith({ connectionId: "00000000-0000-4000-8000-000000000011", items: [expect.objectContaining({ reference: "sample/app#123" })] }));
  const item = await screen.findByRole("button", { name: /#123 示例：调整请求超时/ });
  fireEvent.click(item);
  expect(await screen.findByText("选择方式")).toBeVisible();
  // The check is silent: no notice comes and goes, nothing dims.
  expect(screen.queryByRole("status")).toBeNull();
  expect(item).toBeEnabled();
  const start = screen.getByRole("button", { name: "开始评审" });
  await waitFor(() => expect(start).toBeEnabled());
  // A review started meanwhile waits for the check and reviews what the platform confirms.
  fireEvent.click(start);
  expect(run).not.toHaveBeenCalled();
  await act(async () => confirm({ ...snapshot, snapshotId: "00000000-0000-4000-8000-000000000099", sourceCommit: "c".repeat(40) }));
  await waitFor(() => expect(run).toHaveBeenCalledWith(expect.objectContaining({ snapshotId: "00000000-0000-4000-8000-000000000099" })));
  expect(screen.getByText("PR 有新提交，已读取最新变更。")).toBeVisible();
});

it("moves on to another PR while the one before is still being confirmed", async () => {
  const api = createPreviewApi();
  const first = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  const second = { ...first, snapshotId: "00000000-0000-4000-8000-000000000124", reference: "sample/app#124", title: "示例：补充重试" };
  vi.spyOn(api, "listPullRequests").mockResolvedValue({ items: [first, second].map(({ reference, title }) => ({ reference, number: reference.split("#")[1]!, repository: "sample/app", title, author: "Example", updatedAt: "2026-09-21T10:00:00Z" })), nextPage: null });
  vi.spyOn(api, "peekPrReview").mockImplementation(async ({ reference }) => reference === second.reference ? second : first);
  let confirmFirst!: (value: typeof first) => void;
  vi.spyOn(api, "loadPrReview").mockImplementation(({ reference }) => reference === second.reference ? Promise.resolve(second) : new Promise((resolve) => { confirmFirst = resolve; }));
  const prefetch = vi.spyOn(api, "prefetchPrReviews");
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  expect(await screen.findByRole("heading", { name: first.title })).toBeVisible();
  // Opening a PR reads the next ones ahead.
  expect(prefetch).toHaveBeenLastCalledWith({ connectionId: "00000000-0000-4000-8000-000000000011", items: [{ reference: second.reference, updatedAt: "2026-09-21T10:00:00Z" }] });
  // ↓ from the first PR opens the next one.
  fireEvent.keyDown(screen.getByRole("button", { name: /#123 示例：调整请求超时/ }), { key: "ArrowDown" });
  expect(await screen.findByRole("heading", { name: second.title })).toBeVisible();
  expect(screen.getByRole("button", { name: /#124 示例：补充重试/ })).toHaveFocus();
  // The first PR's check lands late, with new commits; it no longer concerns the screen.
  await act(async () => confirmFirst({ ...first, snapshotId: "00000000-0000-4000-8000-000000000099", sourceCommit: "c".repeat(40) }));
  expect(screen.getByRole("heading", { name: second.title })).toBeVisible();
  expect(screen.queryByText("PR 有新提交，已读取最新变更。")).toBeNull();
});

it("writes a PR overview straight away, keeps it as a record of its own and goes on from there", async () => {
  const api = createPreviewApi();
  const follow = vi.spyOn(api, "followUpPrReview").mockResolvedValue({ answer: "### 1) 类型：新功能" });
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  // Pick the way in, and the composer's one button runs it.
  fireEvent.click(await screen.findByRole("radio", { name: /PR 概览/ }));
  const overview = screen.getByRole("button", { name: "生成 PR 概览" });
  await waitFor(() => expect(overview).toBeEnabled());
  // ⌘Enter in the focus box runs the picked way too, and the focus goes along.
  const focusBox = screen.getByLabelText("本次关注点（可选）");
  fireEvent.change(focusBox, { target: { value: "关注超时" } });
  fireEvent.keyDown(focusBox, { key: "Enter", metaKey: true });
  expect(await screen.findByRole("heading", { name: "1) 类型：新功能" })).toBeVisible();
  expect(screen.getByText("关注点：关注超时")).toBeVisible();
  const request = follow.mock.calls[0]![0];
  expect(request.focus).toBe("关注超时");
  // The overview goes into the PR description as written.
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  fireEvent.click(screen.getByRole("button", { name: "复制这条回答" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("### 1) 类型：新功能"));
  expect(await screen.findByText("已复制为 Markdown。")).toBeVisible();
  expect(request.report).toBeUndefined();
  expect(request.connectionId).toBe("00000000-0000-4000-8000-000000000011");
  expect(request.question).toContain("PR 概览格式");
  expect(screen.getByLabelText("继续追问")).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: /^历史评审/ }));
  expect(within(screen.getByRole("list", { name: "历史评审" })).getByRole("button")).toHaveTextContent("PR 概览");
  // The label is searchable: "概览" finds it, a review status does not.
  fireEvent.change(screen.getByLabelText("搜索评审列表"), { target: { value: "概览" } });
  expect(within(screen.getByRole("list", { name: "历史评审" })).getAllByRole("button")).toHaveLength(1);
  fireEvent.change(screen.getByLabelText("搜索评审列表"), { target: { value: "评审完成" } });
  expect(within(screen.getByRole("list", { name: "历史评审" })).queryAllByRole("button")).toHaveLength(0);
  fireEvent.change(screen.getByLabelText("搜索评审列表"), { target: { value: "" } });
  // From the overview the next step is the full review, whatever way was picked before.
  fireEvent.click(screen.getByRole("button", { name: "完整评审" }));
  expect(await screen.findByRole("button", { name: "开始评审" })).toBeVisible();
  expect(screen.getByRole("radio", { name: /完整评审/ })).toBeChecked();
});

it("opens the PR on its platform from the preparation page", async () => {
  const api = createPreviewApi();
  const open = vi.spyOn(api, "openPr");
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  fireEvent.click(await screen.findByRole("button", { name: "在平台打开" }));
  await waitFor(() => expect(open).toHaveBeenCalledWith({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" }));
});

it("shows the PR description, and offers the overview when there is none", async () => {
  render(<PrReviewPanel api={createPreviewApi()} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  expect(await screen.findByText("为请求添加超时保护。")).toBeVisible();
  cleanup();

  const bare = createPreviewApi();
  const snapshot = await bare.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  vi.spyOn(bare, "loadPrReview").mockResolvedValue({ ...snapshot, description: "" });
  render(<PrReviewPanel api={bare} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  fireEvent.click(await screen.findByRole("button", { name: "选择 PR 概览" }));
  expect(screen.getByRole("radio", { name: /PR 概览/ })).toBeChecked();
  expect(screen.queryByRole("button", { name: "选择 PR 概览" })).toBeNull();
});

it("reviews only the files picked on the preparation page", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  // The local model reads 4,000 characters of diff a group: the source file alone takes two.
  vi.spyOn(api, "loadPrReview").mockResolvedValue({ ...snapshot, batchCount: 5, skippedFiles: ["package-lock.json"], fileBatches: { "src/request.ts": 2, "test/request.test.ts": 3 }, fileHunks: { "src/request.ts": [3_000, 3_000], "test/request.test.ts": [9_000] },
    files: [{ path: "src/request.ts", status: "modified" }, { path: "test/request.test.ts", status: "added" }, { path: "package-lock.json", status: "modified" }] });
  const run = vi.spyOn(api, "runPrReview");
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  fireEvent.click(await screen.findByRole("button", { name: "选择文件" }));
  const dialog = screen.getByRole("dialog", { name: "选择评审文件" });
  expect(within(dialog).getByRole("checkbox", { name: "package-lock.json" })).toBeDisabled();
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "test/request.test.ts" }));
  expect(within(dialog).getByRole("status")).toHaveTextContent("已选 1 / 2 个文件 · 约 2 组");
  expect(within(dialog).getByText("大文件 · 约 2 组")).toBeVisible();
  fireEvent.click(within(dialog).getByRole("button", { name: "确定" }));
  expect(screen.getByText("1 / 2")).toBeVisible();
  expect(screen.getByText("个文件将评审")).toBeVisible();
  const start = screen.getByRole("button", { name: "开始评审" });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  await waitFor(() => expect(run).toHaveBeenCalledWith(expect.objectContaining({ paths: ["src/request.ts"] })));
});

it("points a failed PR list at the links page, where each token can be checked", async () => {
  const api = createPreviewApi();
  vi.spyOn(api, "listPullRequests").mockRejectedValue(new Error("Error invoking remote method 'decision:pr-list': PrPlatformError: 代码平台拒绝了此资源的身份认证（HTTP 401），请检查连接凭据或仓库授权。"));
  const open = vi.spyOn(api, "openSurface");
  render(<PrReviewPanel api={api} />);
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("代码平台拒绝了此资源的身份认证（HTTP 401）");
  expect(alert).not.toHaveTextContent("Error invoking remote method");
  fireEvent.click(within(alert).getByRole("button", { name: "检查链接" }));
  expect(open).toHaveBeenCalledWith("connections");
});

it("narrows the PR list by status words as well", async () => {
  const api = createPreviewApi();
  render(<PrReviewPanel api={api} />);
  const search = await screen.findByRole("searchbox", { name: "搜索评审列表" });
  fireEvent.change(search, { target: { value: "未评审" } });
  expect(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ })).toBeVisible();
  fireEvent.change(search, { target: { value: "评审完成" } });
  expect(screen.queryByRole("button", { name: /#123 示例：调整请求超时/ })).toBeNull();
  expect(screen.getByText("没有匹配的 PR。")).toBeVisible();
});

it("says in a record when the PR moved after it, with the way to review the latest commits", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  const report = await api.runPrReview({ snapshotId: snapshot.snapshotId, runId: "00000000-0000-4000-8000-000000000002", profileId: "local", focus: "" });
  // Reviewed on 1 September; the list says the PR was updated on 21 September.
  saveReviewHistory([{ id: "00000000-0000-4000-8000-0000000000c2", kind: "review", at: "2026-09-01T10:00:00.000Z", model: "本机", focus: "", draft: "", turns: [], events: [], state: "finished", error: "", published: [], verdicts: [], rechecks: [],
    connectionId: "00000000-0000-4000-8000-000000000011", report: { ...report, history: [] }, snapshot: { ...snapshot, sourceCommit: "c".repeat(40) } }]);
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: "PR 1" }));
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  expect(await screen.findByText(/这份评审之后，PR 又有新提交或新评论。/u)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "评审最新提交" }));
  expect(await screen.findByRole("button", { name: "开始评审" })).toBeVisible();
});

it("offers to review only what changed since the PR's last review", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  const files = [{ path: "src/request.ts", status: "modified" }, { path: "src/retry.ts", status: "modified" }, { path: "src/cache.ts", status: "added" }];
  const report = await api.runPrReview({ snapshotId: snapshot.snapshotId, runId: "00000000-0000-4000-8000-000000000002", profileId: "local", focus: "" });
  saveReviewHistory([{ id: "00000000-0000-4000-8000-0000000000c1", kind: "review", at: "2026-09-29T10:00:00.000Z", model: "本机", focus: "", draft: "", turns: [], events: [], state: "finished", error: "", published: [], verdicts: [], rechecks: [],
    connectionId: "00000000-0000-4000-8000-000000000011", report: { ...report, history: [], reviewedFiles: ["src/request.ts", "src/retry.ts"] },
    snapshot: { ...snapshot, sourceCommit: "c".repeat(40), files: files.slice(0, 2), fileDigests: { "src/request.ts": "1".repeat(16), "src/retry.ts": "2".repeat(16) } } }]);
  vi.spyOn(api, "loadPrReview").mockResolvedValue({ ...snapshot, files, fileBatches: { "src/request.ts": 1, "src/retry.ts": 1, "src/cache.ts": 1 },
    fileDigests: { "src/request.ts": "1".repeat(16), "src/retry.ts": "3".repeat(16), "src/cache.ts": "4".repeat(16) } });
  const run = vi.spyOn(api, "runPrReview");
  render(<PrReviewPanel api={api} />);
  // A PR with a review opens that review; reviewing its newer commits starts from there.
  fireEvent.click(await screen.findByRole("button", { name: "PR 1" }));
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  fireEvent.click(await screen.findByRole("button", { name: "重新评审最新提交" }));
  const note = await screen.findByRole("note");
  expect(note).toHaveTextContent("有 2 个文件的改动变了或尚未评审：src/retry.ts、src/cache.ts。");
  fireEvent.click(within(note).getByRole("button", { name: "只评审这些" }));
  expect(screen.getByText("2 / 3")).toBeVisible();
  expect(screen.getByRole("note")).toHaveTextContent("已只选这些。");
  const start = screen.getByRole("button", { name: "开始评审" });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  await waitFor(() => expect(run).toHaveBeenCalledWith(expect.objectContaining({ paths: ["src/retry.ts", "src/cache.ts"] })));
});

it("counts a target branch that moved alone as a change since the last review", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  const files = [{ path: "src/request.ts", status: "modified" }, { path: "src/retry.ts", status: "modified" }];
  const report = await api.runPrReview({ snapshotId: snapshot.snapshotId, runId: "00000000-0000-4000-8000-000000000002", profileId: "local", focus: "" });
  // Same source commit; the target moved, and the platform's diff of one file moved with it.
  saveReviewHistory([{ id: "00000000-0000-4000-8000-0000000000c3", kind: "review", at: "2026-09-29T10:00:00.000Z", model: "本机", focus: "", draft: "", turns: [], events: [], state: "finished", error: "", published: [], verdicts: [], rechecks: [],
    connectionId: "00000000-0000-4000-8000-000000000011", report: { ...report, history: [], reviewedFiles: ["src/request.ts", "src/retry.ts"] },
    snapshot: { ...snapshot, destinationCommit: "d".repeat(40), files, fileDigests: { "src/request.ts": "1".repeat(16), "src/retry.ts": "2".repeat(16) } } }]);
  vi.spyOn(api, "loadPrReview").mockResolvedValue({ ...snapshot, files, fileBatches: { "src/request.ts": 1, "src/retry.ts": 1 },
    fileDigests: { "src/request.ts": "1".repeat(16), "src/retry.ts": "3".repeat(16) } });
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: "PR 1" }));
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  fireEvent.click(await screen.findByRole("button", { name: "重新评审最新提交" }));
  expect(await screen.findByRole("note")).toHaveTextContent("有 1 个文件的改动变了或尚未评审：src/retry.ts。");
});

it("lists the previous review's findings on the new commits and rechecks those whose files changed", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  const report = await api.runPrReview({ snapshotId: snapshot.snapshotId, runId: "00000000-0000-4000-8000-000000000002", profileId: "local", focus: "" });
  const files = [{ path: "src/request.ts", status: "modified" }, { path: "src/retry.ts", status: "modified" }];
  const earlier = { priority: "P2" as const, title: "重试没有上限", body: "重试次数不封顶。", path: "src/retry.ts", side: "new" as const, line: 30, decisionIndexes: [] };
  const base = { kind: "review" as const, model: "本机", focus: "", draft: "", turns: [], events: [], state: "finished" as const, error: "", verdicts: [], rechecks: [], connectionId: "00000000-0000-4000-8000-000000000011" };
  saveReviewHistory([
    { ...base, id: "00000000-0000-4000-8000-0000000000d2", at: "2026-09-30T10:00:00.000Z", published: [], report: { ...report, history: [] },
      snapshot: { ...snapshot, files, fileDigests: { "src/request.ts": "1".repeat(16), "src/retry.ts": "3".repeat(16) } } },
    { ...base, id: "00000000-0000-4000-8000-0000000000d1", at: "2026-09-29T10:00:00.000Z", published: [{ finding: 1, at: "2026-09-29T11:00:00.000Z" }],
      report: { ...report, history: [], findings: [...report.findings, earlier] },
      snapshot: { ...snapshot, sourceCommit: "c".repeat(40), files, fileDigests: { "src/request.ts": "1".repeat(16), "src/retry.ts": "2".repeat(16) } } },
  ]);
  const recheck = vi.spyOn(api, "reevaluatePrReviewFinding").mockResolvedValue({ verdict: "drop", reason: "第 30 行已加上最多 5 次的上限。", replacement: null });
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /历史评审/u }));
  fireEvent.click((await screen.findAllByRole("button", { name: /示例：调整请求超时/u }))[0]!);
  const previous = await screen.findByText("上次评审的 2 个问题 · 1 个所在文件有改动");
  const section = previous.closest("details")!;
  // Folded until opened, so the new findings stay first.
  expect(section.open).toBe(false);
  section.open = true;
  // Raised again by this review: it says so, rather than asking for a recheck of a changed file.
  expect(section).toHaveTextContent("超时后请求仍在运行src/request.ts:12 · 这次评审又报了");
  expect(section).toHaveTextContent("已发布为 PR 评论");
  // The timeout problem is in this report as well as the last one: the heading says it outlived the changes.
  expect(screen.getByRole("heading", { name: "P2 超时后请求仍在运行 之前也报过" })).toBeVisible();
  const button = within(section).getByRole("button", { name: "复核有改动的 1 个" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  // The button gives way to a status line: focus waits on the section's heading instead of falling out.
  expect(section.querySelector("summary")).toHaveFocus();
  expect(await within(section).findByText("已不存在")).toBeVisible();
  expect(within(section).getByText("第 30 行已加上最多 5 次的上限。")).toBeVisible();
  expect(recheck).toHaveBeenCalledWith(expect.objectContaining({ finding: expect.objectContaining({ path: "src/retry.ts" }), earlierCommit: "c".repeat(40) }));
  expect(within(section).queryByRole("button", { name: /复核有改动/u })).toBeNull();
  // The exported record keeps the whole section, the unchecked ones included.
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  fireEvent.click(screen.getByLabelText("评审操作"));
  fireEvent.click(screen.getByRole("button", { name: "复制为 Markdown" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining(`## 上次评审的问题（提交 \`${"c".repeat(12)}\`）`)));
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining("- **P2** 重试没有上限（`src/retry.ts:30`）：已不存在 · 第 30 行已加上最多 5 次的上限。 · 已发布为 PR 评论"));
  // The summary comment tells the author which of the last review's points are settled.
  fireEvent.click(screen.getByLabelText("评审操作"));
  fireEvent.click(screen.getByRole("button", { name: "发布评审摘要到 PR" }));
  const draft = within(await screen.findByRole("dialog", { name: "发布到 PR" })).getByLabelText("评论内容") as HTMLTextAreaElement;
  expect(draft.value).toContain(`**上次评审的问题**（提交 \`${"c".repeat(12)}\`）：已不存在 1 个\n- 已不存在：重试没有上限（\`src/retry.ts:30\`）`);
  // This review found the timeout problem again and lists it above; it is not repeated as still there.
  expect(draft.value).not.toContain("仍然存在：超时后请求仍在运行");
});

it("says when the last review was on these very commits", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  const report = await api.runPrReview({ snapshotId: snapshot.snapshotId, runId: "00000000-0000-4000-8000-000000000002", profileId: "local", focus: "" });
  saveReviewHistory([{ id: "00000000-0000-4000-8000-0000000000f3", kind: "review", at: "2026-09-29T10:00:00.000Z", model: "本机", focus: "", draft: "", turns: [], events: [], state: "finished", error: "", published: [], verdicts: [], rechecks: [],
    connectionId: "00000000-0000-4000-8000-000000000011", report: { ...report, history: [] }, snapshot }]);
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  fireEvent.click(await screen.findByRole("button", { name: "重新评审最新提交" }));
  expect(await screen.findByText(/就是这个提交；再评审会重新调用模型。/u)).toHaveTextContent("评审完成");
  // Still the reader's call: nothing is held back.
  await waitFor(() => expect(screen.getByRole("button", { name: "开始评审" })).toBeEnabled());
});

it("offers the files the last review of this very commit left out", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  const report = await api.runPrReview({ snapshotId: snapshot.snapshotId, runId: "00000000-0000-4000-8000-000000000002", profileId: "local", focus: "" });
  saveReviewHistory([{ id: "00000000-0000-4000-8000-0000000000f4", kind: "review", at: "2026-09-29T10:00:00.000Z", model: "本机", focus: "", draft: "", turns: [], events: [], state: "finished", error: "", published: [], verdicts: [], rechecks: [],
    connectionId: "00000000-0000-4000-8000-000000000011", report: { ...report, history: [], status: "cancelled", reviewedFiles: [], findings: [] }, snapshot }]);
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  fireEvent.click(await screen.findByRole("button", { name: "重新评审最新提交" }));
  const note = await screen.findByText(/就是这个提交，但有 1 个文件没评审：src\/request\.ts。/u);
  fireEvent.click(within(note).getByRole("button", { name: "只评审这些" }));
  expect(note).toHaveTextContent("已只选这些。");
});

it("offers the focus this PR was last reviewed for", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  const report = await api.runPrReview({ snapshotId: snapshot.snapshotId, runId: "00000000-0000-4000-8000-000000000002", profileId: "local", focus: "" });
  saveReviewHistory([{ id: "00000000-0000-4000-8000-0000000000f1", kind: "review", at: "2026-09-29T10:00:00.000Z", model: "本机", focus: "  重点看超时后的资源释放  ", draft: "", turns: [], events: [], state: "finished", error: "", published: [], verdicts: [], rechecks: [],
    connectionId: "00000000-0000-4000-8000-000000000011", report: { ...report, history: [] }, snapshot: { ...snapshot, sourceCommit: "c".repeat(40) } }]);
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: "PR 1" }));
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  fireEvent.click(await screen.findByRole("button", { name: "重新评审最新提交" }));
  const offer = await screen.findByText(/上次对这个 PR 的关注点：重点看超时后的资源释放/u);
  fireEvent.click(within(offer).getByRole("button", { name: "沿用" }));
  expect(screen.getByRole("textbox", { name: "本次关注点（可选）" })).toHaveValue("重点看超时后的资源释放");
  // The offer goes away with its button; the caret is left in the field it filled.
  expect(screen.getByRole("textbox", { name: "本次关注点（可选）" })).toHaveFocus();
  expect(screen.queryByText(/上次对这个 PR 的关注点/u)).toBeNull();
});

it("carries findings through stopped and partial reviews, and keeps posted ones until found gone", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  const report = await api.runPrReview({ snapshotId: snapshot.snapshotId, runId: "00000000-0000-4000-8000-000000000002", profileId: "local", focus: "" });
  const files = [{ path: "src/request.ts", status: "modified" }, { path: "src/retry.ts", status: "modified" }];
  const finding = (title: string, path: string, line: number) => ({ priority: "P2" as const, title, body: `${title}。`, path, side: "new" as const, line, decisionIndexes: [] });
  const base = { kind: "review" as const, model: "本机", focus: "", draft: "", turns: [], events: [], state: "finished" as const, error: "", verdicts: [], rechecks: [], published: [], connectionId: "00000000-0000-4000-8000-000000000011" };
  const at = (commit: string, request: string) => ({ ...snapshot, sourceCommit: commit.repeat(40), files, fileDigests: { "src/request.ts": request.repeat(16), "src/retry.ts": "2".repeat(16) } });
  const posted = (finding: number) => ({ finding, at: "2026-09-28T11:00:00.000Z" });
  saveReviewHistory([
    { ...base, id: "00000000-0000-4000-8000-0000000000a4", at: "2026-09-30T10:00:00.000Z", report: { ...report, history: [] }, snapshot: at("a", "6") },
    // Stopped after src/request.ts: it still found and posted a problem there, and speaks for that file.
    { ...base, id: "00000000-0000-4000-8000-0000000000a3", at: "2026-09-29T12:00:00.000Z", published: [posted(0)],
      report: { ...report, history: [], status: "cancelled", reviewedFiles: ["src/request.ts"], findings: [finding("凭据写进日志", "src/request.ts", 8)] }, snapshot: at("e", "5") },
    // Reviewed both files, quiet about what the PR's comments already said; it found one posted problem gone.
    { ...base, id: "00000000-0000-4000-8000-0000000000a2", at: "2026-09-29T10:00:00.000Z",
      rechecks: [{ run: "00000000-0000-4000-8000-0000000000a1", finding: 2, verdict: "drop", reason: "已加上抖动。", replacement: null, at: "2026-09-29T10:10:00.000Z", model: "本机" }],
      report: { ...report, history: [], reviewedFiles: ["src/request.ts", "src/retry.ts"], findings: [finding("日志缺少请求 ID", "src/request.ts", 20)] }, snapshot: at("d", "5") },
    { ...base, id: "00000000-0000-4000-8000-0000000000a1", at: "2026-09-28T10:00:00.000Z", published: [posted(1), posted(2)],
      report: { ...report, history: [], reviewedFiles: ["src/request.ts", "src/retry.ts"], findings: [finding("超时后请求仍在运行", "src/request.ts", 12), finding("重试没有上限", "src/retry.ts", 30), finding("重试间隔没有抖动", "src/retry.ts", 34)] }, snapshot: at("c", "1") },
  ]);
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /历史评审/u }));
  fireEvent.click((await screen.findAllByRole("button", { name: /示例：调整请求超时/u }))[0]!);
  const summary = await screen.findByText("之前评审的 2 个问题 · 1 个所在文件有改动");
  const section = summary.closest("details")!;
  section.open = true;
  // The stopped review's posted problem, on the file it finished.
  expect(section).toHaveTextContent(`凭据写进日志src/request.ts:8 · 提交 ${"e".repeat(8)} · 文件有改动，尚未复核 · 已发布为 PR 评论`);
  // A posted problem the later review stayed quiet about is still followed; one it found gone is not.
  expect(section).toHaveTextContent(`重试没有上限src/retry.ts:30 · 提交 ${"c".repeat(8)} · 文件没有改动，应当还在 · 已发布为 PR 评论`);
  expect(section).not.toHaveTextContent("重试间隔没有抖动");
  // Unposted findings on files a later review looked at are superseded by it.
  expect(section).not.toHaveTextContent("日志缺少请求 ID");
  expect(section).not.toHaveTextContent("超时后请求仍在运行src/request.ts:12");
});

it("follows a problem, not one report of it: a recheck settles every copy and a posted copy marks them all", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  const report = await api.runPrReview({ snapshotId: snapshot.snapshotId, runId: "00000000-0000-4000-8000-000000000002", profileId: "local", focus: "" });
  const files = [{ path: "src/request.ts", status: "modified" }, { path: "src/retry.ts", status: "modified" }];
  const finding = (title: string, path: string, line: number) => ({ priority: "P2" as const, title, body: `${title}。`, path, side: "new" as const, line, decisionIndexes: [] });
  const base = { kind: "review" as const, model: "本机", focus: "", draft: "", turns: [], events: [], state: "finished" as const, error: "", verdicts: [], rechecks: [], published: [], connectionId: "00000000-0000-4000-8000-000000000011" };
  const at = (commit: string, digest: string) => ({ ...snapshot, sourceCommit: commit.repeat(40), files, fileDigests: { "src/request.ts": digest.repeat(16), "src/retry.ts": digest.repeat(16) } });
  const whole = { history: [], reviewedFiles: ["src/request.ts", "src/retry.ts"] };
  saveReviewHistory([
    { ...base, id: "00000000-0000-4000-8000-0000000000b4", at: "2026-09-30T10:00:00.000Z", report: { ...report, ...whole }, snapshot: at("a", "4") },
    // The rerun found the second report of the problem gone, and raised another one.
    { ...base, id: "00000000-0000-4000-8000-0000000000b3", at: "2026-09-29T12:00:00.000Z", report: { ...report, ...whole, findings: [finding("日志缺少请求 ID", "src/request.ts", 20)] }, snapshot: at("e", "3"),
      rechecks: [{ run: "00000000-0000-4000-8000-0000000000b2", finding: 0, verdict: "drop", reason: "已加上上限。", replacement: null, at: "2026-09-29T12:10:00.000Z", model: "本机" }] },
    { ...base, id: "00000000-0000-4000-8000-0000000000b2", at: "2026-09-29T10:00:00.000Z", report: { ...report, ...whole, findings: [finding("重试没有上限", "src/retry.ts", 31)] }, snapshot: at("d", "2") },
    { ...base, id: "00000000-0000-4000-8000-0000000000b1", at: "2026-09-28T10:00:00.000Z", published: [{ finding: 0, at: "2026-09-28T11:00:00.000Z" }],
      report: { ...report, ...whole, findings: [finding("重试没有上限", "src/retry.ts", 30)] }, snapshot: at("c", "1") },
  ]);
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /历史评审/u }));
  const runs = await screen.findAllByRole("button", { name: /示例：调整请求超时/u });
  fireEvent.click(runs[0]!);
  const newest = (await screen.findByText("上次评审的 1 个问题 · 1 个所在文件有改动")).closest("details")!;
  // The posted first report does not come back once the later report of the same problem was found gone.
  expect(newest).toHaveTextContent("日志缺少请求 ID");
  expect(newest).not.toHaveTextContent("重试没有上限");
  fireEvent.click(runs[1]!);
  const rerun = (await screen.findByText("上次评审的 1 个问题 · 1 个所在文件有改动")).closest("details")!;
  rerun.open = true;
  // The later report speaks for the problem, and still says a comment on it was posted.
  expect(rerun).toHaveTextContent("重试没有上限src/retry.ts:31 · 已不存在 · 已发布为 PR 评论");
});

it("keeps two findings of one review that share a title on different lines", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  const report = await api.runPrReview({ snapshotId: snapshot.snapshotId, runId: "00000000-0000-4000-8000-000000000002", profileId: "local", focus: "" });
  const files = [{ path: "src/request.ts", status: "modified" }, { path: "src/retry.ts", status: "modified" }];
  const backoff = (line: number) => ({ priority: "P3" as const, title: "重试缺少退避", body: "立即重试。", path: "src/retry.ts", side: "new" as const, line, decisionIndexes: [] });
  const base = { kind: "review" as const, model: "本机", focus: "", draft: "", turns: [], events: [], state: "finished" as const, error: "", verdicts: [], rechecks: [], published: [], connectionId: "00000000-0000-4000-8000-000000000011" };
  saveReviewHistory([
    { ...base, id: "00000000-0000-4000-8000-0000000000b6", at: "2026-09-30T10:00:00.000Z", report: { ...report, history: [], reviewedFiles: ["src/request.ts"] }, snapshot: { ...snapshot, files } },
    { ...base, id: "00000000-0000-4000-8000-0000000000b5", at: "2026-09-29T10:00:00.000Z", report: { ...report, history: [], findings: [backoff(30), backoff(80)] }, snapshot: { ...snapshot, sourceCommit: "c".repeat(40), files } },
  ]);
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /历史评审/u }));
  fireEvent.click((await screen.findAllByRole("button", { name: /示例：调整请求超时/u }))[0]!);
  const section = (await screen.findByText("上次评审的 2 个问题 · 2 个所在文件有改动")).closest("details")!;
  expect(section).toHaveTextContent("src/retry.ts:30");
  expect(section).toHaveTextContent("src/retry.ts:80");
});

it("knows a replaced finding by both its titles", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  const report = await api.runPrReview({ snapshotId: snapshot.snapshotId, runId: "00000000-0000-4000-8000-000000000002", profileId: "local", focus: "" });
  const files = [{ path: "src/request.ts", status: "modified" }, { path: "src/retry.ts", status: "modified" }];
  const fileDigests = { "src/request.ts": "1".repeat(16), "src/retry.ts": "2".repeat(16) };
  const finding = (title: string, path: string, line: number) => ({ priority: "P2" as const, title, body: `${title}。`, path, side: "new" as const, line, decisionIndexes: [] });
  const replaced = (index: number, title: string) => ({ finding: index, verdict: "replace" as const, reason: "表述不准。", replacement: { title, body: `${title}。` }, at: "2026-09-29T10:30:00.000Z", model: "本机" });
  const base = { kind: "review" as const, model: "本机", focus: "", draft: "", turns: [], events: [], state: "finished" as const, error: "", rechecks: [], published: [], connectionId: "00000000-0000-4000-8000-000000000011" };
  saveReviewHistory([
    { ...base, id: "00000000-0000-4000-8000-0000000000b8", at: "2026-09-30T10:00:00.000Z", verdicts: [],
      report: { ...report, history: [], findings: [...report.findings, finding("重试没有上限", "src/retry.ts", 30)] }, snapshot: { ...snapshot, files, fileDigests } },
    // Each earlier finding was re-worded on re-evaluation: one under the title found again now, one away from it.
    { ...base, id: "00000000-0000-4000-8000-0000000000b7", at: "2026-09-29T10:00:00.000Z", verdicts: [replaced(0, "超时后未取消底层请求"), replaced(1, "重试没有上限")],
      report: { ...report, history: [], findings: [finding("超时后请求仍在运行", "src/request.ts", 12), finding("重试次数不封顶", "src/retry.ts", 30)] },
      snapshot: { ...snapshot, sourceCommit: "c".repeat(40), files, fileDigests } },
  ]);
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /历史评审/u }));
  fireEvent.click((await screen.findAllByRole("button", { name: /示例：调整请求超时/u }))[0]!);
  expect(await screen.findByRole("heading", { name: "P2 超时后请求仍在运行 之前也报过" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "P2 重试没有上限 之前也报过" })).toBeVisible();
  fireEvent.click(screen.getByLabelText("评审操作"));
  fireEvent.click(screen.getByRole("button", { name: "发布评审摘要到 PR" }));
  const draft = within(await screen.findByRole("dialog", { name: "发布到 PR" })).getByLabelText("评论内容") as HTMLTextAreaElement;
  // Both are listed above as found again; neither is repeated as still there.
  expect(draft.value).not.toContain("仍然存在：超时后未取消底层请求");
  expect(draft.value).not.toContain("仍然存在：重试没有上限");
});

it("reads a recheck an earlier rerun made on the same commits as its own", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  const report = await api.runPrReview({ snapshotId: snapshot.snapshotId, runId: "00000000-0000-4000-8000-000000000002", profileId: "local", focus: "" });
  const files = [{ path: "src/request.ts", status: "modified" }, { path: "src/retry.ts", status: "modified" }];
  const finding = (title: string, path: string, line: number) => ({ priority: "P2" as const, title, body: `${title}。`, path, side: "new" as const, line, decisionIndexes: [] });
  const base = { kind: "review" as const, model: "本机", focus: "", draft: "", turns: [], events: [], state: "finished" as const, error: "", verdicts: [], rechecks: [], published: [], connectionId: "00000000-0000-4000-8000-000000000011" };
  const now = { ...snapshot, files };
  saveReviewHistory([
    { ...base, id: "00000000-0000-4000-8000-0000000000c9", at: "2026-09-30T11:00:00.000Z", report: { ...report, history: [], reviewedFiles: [] }, snapshot: now },
    // Stopped before any file was done, after its recheck had found the retry problem gone.
    { ...base, id: "00000000-0000-4000-8000-0000000000c8", at: "2026-09-30T10:00:00.000Z", report: { ...report, history: [], status: "cancelled", reviewedFiles: [], findings: [] }, snapshot: now,
      rechecks: [{ run: "00000000-0000-4000-8000-0000000000c7", finding: 1, verdict: "drop", reason: "已加上上限。", replacement: null, at: "2026-09-30T10:05:00.000Z", model: "本机" }] },
    { ...base, id: "00000000-0000-4000-8000-0000000000c7", at: "2026-09-29T10:00:00.000Z",
      report: { ...report, history: [], findings: [finding("凭据写进日志", "src/request.ts", 8), finding("重试没有上限", "src/retry.ts", 30)] }, snapshot: { ...now, sourceCommit: "c".repeat(40) } },
  ]);
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /历史评审/u }));
  fireEvent.click((await screen.findAllByRole("button", { name: /示例：调整请求超时/u }))[0]!);
  // The rerun read the same code: its word stands as it is, and only the other one is left to recheck.
  const section = (await screen.findByText("上次评审的 2 个问题 · 2 个所在文件有改动")).closest("details")!;
  section.open = true;
  expect(section).toHaveTextContent("重试没有上限src/retry.ts:30 · 已不存在");
  expect(section).toHaveTextContent("已加上上限。");
  expect(within(section).getByRole("button", { name: "复核有改动的 1 个" })).toBeVisible();
});

it("pairs findings that share a title one to one, so each keeps its own posting", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  const report = await api.runPrReview({ snapshotId: snapshot.snapshotId, runId: "00000000-0000-4000-8000-000000000002", profileId: "local", focus: "" });
  const files = [{ path: "src/request.ts", status: "modified" }, { path: "src/retry.ts", status: "modified" }];
  const finding = (title: string, line: number) => ({ priority: "P2" as const, title, body: `${title}。`, path: "src/retry.ts", side: "new" as const, line, decisionIndexes: [] });
  const base = { kind: "review" as const, model: "本机", focus: "", draft: "", turns: [], events: [], state: "finished" as const, error: "", verdicts: [], rechecks: [], connectionId: "00000000-0000-4000-8000-000000000011" };
  saveReviewHistory([
    { ...base, id: "00000000-0000-4000-8000-0000000000a9", at: "2026-09-30T10:00:00.000Z", published: [], report: { ...report, history: [] }, snapshot: { ...snapshot, files } },
    // Read both files whole and raised one of the two problems again.
    { ...base, id: "00000000-0000-4000-8000-0000000000a8", at: "2026-09-29T12:00:00.000Z", published: [], snapshot: { ...snapshot, sourceCommit: "d".repeat(40), files },
      report: { ...report, history: [], reviewedFiles: ["src/request.ts", "src/retry.ts"], findings: [finding("重试没有上限", 30)] } },
    // Two titles, each raised twice; one of each pair was posted.
    { ...base, id: "00000000-0000-4000-8000-0000000000a7", at: "2026-09-28T10:00:00.000Z", published: [{ finding: 0, at: "2026-09-28T11:00:00.000Z" }, { finding: 3, at: "2026-09-28T11:00:00.000Z" }],
      snapshot: { ...snapshot, sourceCommit: "c".repeat(40), files },
      report: { ...report, history: [], findings: [finding("重试缺少退避", 30), finding("重试缺少退避", 80), finding("重试没有上限", 30), finding("重试没有上限", 80)] } },
  ]);
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /历史评审/u }));
  fireEvent.click((await screen.findAllByRole("button", { name: /示例：调整请求超时/u }))[0]!);
  const section = (await screen.findByText("之前评审的 3 个问题 · 3 个所在文件有改动")).closest("details")!;
  section.open = true;
  const items = within(section).getAllByRole("listitem");
  // Raised again by the newer review: that report speaks for it, and it was never posted.
  expect(items[0]).toHaveTextContent(`重试没有上限src/retry.ts:30 · 提交 ${"d".repeat(8)} · 文件有改动，尚未复核`);
  expect(items[0]).not.toHaveTextContent("已发布");
  // Posted ones stay; the unposted twin gives way to the newer review that read the file whole.
  expect(items[1]).toHaveTextContent(`重试缺少退避src/retry.ts:30 · 提交 ${"c".repeat(8)} · 文件有改动，尚未复核 · 已发布为 PR 评论`);
  expect(items[2]).toHaveTextContent(`重试没有上限src/retry.ts:80 · 提交 ${"c".repeat(8)} · 文件有改动，尚未复核 · 已发布为 PR 评论`);
  expect(section).not.toHaveTextContent("重试缺少退避src/retry.ts:80");
});

it("pairs the nearest reports first, and lets a rerun of these commits drop a problem too", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  const report = await api.runPrReview({ snapshotId: snapshot.snapshotId, runId: "00000000-0000-4000-8000-000000000002", profileId: "local", focus: "" });
  const files = [{ path: "src/request.ts", status: "modified" }, { path: "src/retry.ts", status: "modified" }];
  const finding = (title: string, path: string, line: number) => ({ priority: "P2" as const, title, body: `${title}。`, path, side: "new" as const, line, decisionIndexes: [] });
  const drop = (index: number) => ({ finding: index, verdict: "drop" as const, reason: "误报。", replacement: null, at: "2026-09-30T10:10:00.000Z", model: "本机" });
  const base = { kind: "review" as const, model: "本机", focus: "", draft: "", turns: [], events: [], state: "finished" as const, error: "", rechecks: [], connectionId: "00000000-0000-4000-8000-000000000011" };
  saveReviewHistory([
    // This review raised the retry problem at 50, and at 31, where it dropped it.
    { ...base, id: "00000000-0000-4000-8000-0000000000e9", at: "2026-09-30T11:00:00.000Z", published: [], verdicts: [drop(1)], snapshot: { ...snapshot, files },
      report: { ...report, history: [], findings: [finding("重试没有上限", "src/retry.ts", 50), finding("重试没有上限", "src/retry.ts", 31)] } },
    // A rerun of these commits dropped the logging problem.
    { ...base, id: "00000000-0000-4000-8000-0000000000e8", at: "2026-09-30T10:00:00.000Z", published: [], verdicts: [drop(0)], snapshot: { ...snapshot, files },
      report: { ...report, history: [], findings: [finding("凭据写进日志", "src/request.ts", 8)] } },
    { ...base, id: "00000000-0000-4000-8000-0000000000e7", at: "2026-09-29T10:00:00.000Z", published: [{ finding: 1, at: "2026-09-29T11:00:00.000Z" }], verdicts: [], snapshot: { ...snapshot, sourceCommit: "c".repeat(40), files },
      report: { ...report, history: [], findings: [finding("重试没有上限", "src/retry.ts", 30), finding("重试没有上限", "src/retry.ts", 80), finding("凭据写进日志", "src/request.ts", 8)] } },
  ]);
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /历史评审/u }));
  fireEvent.click((await screen.findAllByRole("button", { name: /示例：调整请求超时/u }))[0]!);
  // 31 sits right by 30 and takes it, so the drop settles 30; 50 is left with 80, the posted one.
  const section = (await screen.findByText("上次评审的 1 个问题 · 0 个所在文件有改动")).closest("details")!;
  section.open = true;
  expect(section).toHaveTextContent("重试没有上限src/retry.ts:80 · 这次评审又报了 · 已发布为 PR 评论");
  expect(section).not.toHaveTextContent("src/retry.ts:30");
  // Dropped by the rerun on this very code: not carried either.
  expect(section).not.toHaveTextContent("凭据写进日志");
});

it("lets a rerun of these commits speak for the problem nearest it, not one left over far away", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  const report = await api.runPrReview({ snapshotId: snapshot.snapshotId, runId: "00000000-0000-4000-8000-000000000002", profileId: "local", focus: "" });
  const files = [{ path: "src/request.ts", status: "modified" }, { path: "src/retry.ts", status: "modified" }];
  const retry = (line: number) => ({ priority: "P2" as const, title: "重试没有上限", body: "重试次数不封顶。", path: "src/retry.ts", side: "new" as const, line, decisionIndexes: [] });
  const base = { kind: "review" as const, model: "本机", focus: "", draft: "", turns: [], events: [], state: "finished" as const, error: "", rechecks: [], connectionId: "00000000-0000-4000-8000-000000000011" };
  saveReviewHistory([
    { ...base, id: "00000000-0000-4000-8000-0000000000d6", at: "2026-09-30T11:00:00.000Z", published: [], verdicts: [], snapshot: { ...snapshot, files }, report: { ...report, history: [], findings: [retry(30)] } },
    // A rerun of these commits raised it at 30 as well and dropped it there; 30 is the problem it speaks for.
    { ...base, id: "00000000-0000-4000-8000-0000000000d5", at: "2026-09-30T10:00:00.000Z", published: [], snapshot: { ...snapshot, files }, report: { ...report, history: [], findings: [retry(30)] },
      verdicts: [{ finding: 0, verdict: "drop", reason: "误报。", replacement: null, at: "2026-09-30T10:10:00.000Z", model: "本机" }] },
    { ...base, id: "00000000-0000-4000-8000-0000000000d4", at: "2026-09-29T10:00:00.000Z", published: [{ finding: 1, at: "2026-09-29T11:00:00.000Z" }], verdicts: [], snapshot: { ...snapshot, sourceCommit: "c".repeat(40), files },
      report: { ...report, history: [], findings: [retry(30), retry(80)] } },
  ]);
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /历史评审/u }));
  fireEvent.click((await screen.findAllByRole("button", { name: /示例：调整请求超时/u }))[0]!);
  const section = (await screen.findByText("上次评审的 2 个问题 · 1 个所在文件有改动")).closest("details")!;
  section.open = true;
  // This review, newer than the rerun, found 30 again; 80, posted and far from both, is still there to recheck.
  expect(section).toHaveTextContent("重试没有上限src/retry.ts:30 · 这次评审又报了");
  expect(section).toHaveTextContent("重试没有上限src/retry.ts:80 · 文件有改动，尚未复核 · 已发布为 PR 评论");
  expect(within(section).getByRole("button", { name: "复核有改动的 1 个" })).toBeVisible();
});

it("counts a comment a rerun posted once, for the one finding nearest it", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  const report = await api.runPrReview({ snapshotId: snapshot.snapshotId, runId: "00000000-0000-4000-8000-000000000002", profileId: "local", focus: "" });
  const files = [{ path: "src/request.ts", status: "modified" }, { path: "src/retry.ts", status: "modified" }];
  const retry = (line: number) => ({ priority: "P2" as const, title: "重试没有上限", body: "重试次数不封顶。", path: "src/retry.ts", side: "new" as const, line, decisionIndexes: [] });
  const base = { kind: "review" as const, model: "本机", focus: "", draft: "", turns: [], events: [], state: "finished" as const, error: "", rechecks: [], verdicts: [], connectionId: "00000000-0000-4000-8000-000000000011" };
  saveReviewHistory([
    { ...base, id: "00000000-0000-4000-8000-0000000000d3", at: "2026-09-30T11:00:00.000Z", published: [], snapshot: { ...snapshot, files }, report: { ...report, history: [], findings: [retry(32), retry(29)] } },
    { ...base, id: "00000000-0000-4000-8000-0000000000d2", at: "2026-09-30T10:00:00.000Z", published: [{ finding: 0, at: "2026-09-30T10:20:00.000Z" }], snapshot: { ...snapshot, files }, report: { ...report, history: [], findings: [retry(30)] } },
  ]);
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /历史评审/u }));
  fireEvent.click((await screen.findAllByRole("button", { name: /示例：调整请求超时/u }))[0]!);
  // 29 is nearer the posted 30 than 32 is: only 29 counts as posted; 32 can still be posted.
  expect(await screen.findAllByText("同一提交的另一次评审已发布")).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: "把「重试没有上限」转为 PR 评论" })).toHaveLength(1);
});

it("breaks a tie between equally near pairs by order among what could pair at all", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  const report = await api.runPrReview({ snapshotId: snapshot.snapshotId, runId: "00000000-0000-4000-8000-000000000002", profileId: "local", focus: "" });
  const files = [{ path: "src/request.ts", status: "modified" }, { path: "src/retry.ts", status: "modified" }];
  const finding = (title: string, line: number) => ({ priority: "P2" as const, title, body: `${title}。`, path: "src/retry.ts", side: "new" as const, line, decisionIndexes: [] });
  const base = { kind: "review" as const, model: "本机", focus: "", draft: "", turns: [], events: [], state: "finished" as const, error: "", rechecks: [], published: [], connectionId: "00000000-0000-4000-8000-000000000011" };
  saveReviewHistory([
    // Another title comes first in the file; it cannot pair with either, and must not shift the order of the rest.
    { ...base, id: "00000000-0000-4000-8000-0000000000c6", at: "2026-09-30T11:00:00.000Z", snapshot: { ...snapshot, files },
      verdicts: [{ finding: 2, verdict: "drop", reason: "误报。", replacement: null, at: "2026-09-30T11:10:00.000Z", model: "本机" }],
      report: { ...report, history: [], findings: [finding("日志缺少请求 ID", 1), finding("重试没有上限", 15), finding("重试没有上限", 25)] } },
    { ...base, id: "00000000-0000-4000-8000-0000000000c5", at: "2026-09-29T10:00:00.000Z", verdicts: [], snapshot: { ...snapshot, sourceCommit: "c".repeat(40), files },
      report: { ...report, history: [], findings: [finding("重试没有上限", 10), finding("重试没有上限", 20)] } },
  ]);
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /历史评审/u }));
  fireEvent.click((await screen.findAllByRole("button", { name: /示例：调整请求超时/u }))[0]!);
  // 15 goes with 10 and 25 with 20, as they lie: the drop settles 20, and 10 was raised again.
  const section = (await screen.findByText("上次评审的 1 个问题 · 0 个所在文件有改动")).closest("details")!;
  section.open = true;
  expect(section).toHaveTextContent("重试没有上限src/retry.ts:10 · 这次评审又报了");
  expect(section).not.toHaveTextContent("src/retry.ts:20");
});

it("keeps following a problem a rerun of these commits posted, though an earlier review let it go", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  const report = await api.runPrReview({ snapshotId: snapshot.snapshotId, runId: "00000000-0000-4000-8000-000000000002", profileId: "local", focus: "" });
  const files = [{ path: "src/request.ts", status: "modified" }, { path: "src/retry.ts", status: "modified" }];
  const retry = { priority: "P2" as const, title: "重试没有上限", body: "重试次数不封顶。", path: "src/retry.ts", side: "new" as const, line: 30, decisionIndexes: [] };
  const base = { kind: "review" as const, model: "本机", focus: "", draft: "", turns: [], events: [], state: "finished" as const, error: "", rechecks: [], verdicts: [], connectionId: "00000000-0000-4000-8000-000000000011" };
  saveReviewHistory([
    { ...base, id: "00000000-0000-4000-8000-0000000000c4", at: "2026-09-30T11:00:00.000Z", published: [], snapshot: { ...snapshot, files }, report: { ...report, history: [] } },
    // A rerun of these commits raised it again and posted it.
    { ...base, id: "00000000-0000-4000-8000-0000000000c3", at: "2026-09-30T10:00:00.000Z", published: [{ finding: 0, at: "2026-09-30T10:20:00.000Z" }], snapshot: { ...snapshot, files }, report: { ...report, history: [], findings: [retry] } },
    // Read the file whole and said nothing of it.
    { ...base, id: "00000000-0000-4000-8000-0000000000c2", at: "2026-09-29T12:00:00.000Z", published: [], snapshot: { ...snapshot, sourceCommit: "d".repeat(40), files },
      report: { ...report, history: [], reviewedFiles: ["src/request.ts", "src/retry.ts"], findings: [] } },
    { ...base, id: "00000000-0000-4000-8000-0000000000c1", at: "2026-09-29T10:00:00.000Z", published: [], snapshot: { ...snapshot, sourceCommit: "c".repeat(40), files }, report: { ...report, history: [], findings: [retry] } },
  ]);
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /历史评审/u }));
  fireEvent.click((await screen.findAllByRole("button", { name: /示例：调整请求超时/u }))[0]!);
  // The comment is on the PR, and this review does not mention it: it stays in view.
  const section = (await screen.findByText(/之前评审的 1 个问题/u)).closest("details")!;
  section.open = true;
  expect(section).toHaveTextContent("重试没有上限src/retry.ts:30");
  expect(section).toHaveTextContent("已发布为 PR 评论");
});

it("counts every review of this very commit before saying files were left out", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  const report = await api.runPrReview({ snapshotId: snapshot.snapshotId, runId: "00000000-0000-4000-8000-000000000002", profileId: "local", focus: "" });
  const base = { kind: "review" as const, model: "本机", focus: "", draft: "", turns: [], events: [], state: "finished" as const, error: "", published: [], verdicts: [], rechecks: [], connectionId: "00000000-0000-4000-8000-000000000011" };
  saveReviewHistory([
    { ...base, id: "00000000-0000-4000-8000-0000000000f6", at: "2026-09-30T10:00:00.000Z", report: { ...report, history: [], status: "cancelled", reviewedFiles: [], findings: [] }, snapshot },
    { ...base, id: "00000000-0000-4000-8000-0000000000f5", at: "2026-09-29T10:00:00.000Z", report: { ...report, history: [] }, snapshot },
  ]);
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  fireEvent.click(await screen.findByRole("button", { name: "重新评审最新提交" }));
  // The latest one stopped early, but the one before read the file whole.
  expect(await screen.findByText(/就是这个提交；再评审会重新调用模型。/u)).toBeVisible();
  expect(screen.queryByText(/个文件没评审/u)).toBeNull();
});

it("lets a finding dropped here take its earlier report with it", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  const report = await api.runPrReview({ snapshotId: snapshot.snapshotId, runId: "00000000-0000-4000-8000-000000000002", profileId: "local", focus: "" });
  const files = [{ path: "src/request.ts", status: "modified" }];
  const fileDigests = { "src/request.ts": "1".repeat(16) };
  const base = { kind: "review" as const, model: "本机", focus: "", draft: "", turns: [], events: [], state: "finished" as const, error: "", rechecks: [], published: [], connectionId: "00000000-0000-4000-8000-000000000011" };
  saveReviewHistory([
    { ...base, id: "00000000-0000-4000-8000-0000000000a6", at: "2026-09-30T10:00:00.000Z", report: { ...report, history: [] }, snapshot: { ...snapshot, files, fileDigests },
      verdicts: [{ finding: 0, verdict: "drop", reason: "超时已经取消了请求。", replacement: null, at: "2026-09-30T10:10:00.000Z", model: "本机" }] },
    { ...base, id: "00000000-0000-4000-8000-0000000000a5", at: "2026-09-29T10:00:00.000Z", verdicts: [], report: { ...report, history: [] }, snapshot: { ...snapshot, sourceCommit: "c".repeat(40), files, fileDigests } },
  ]);
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /历史评审/u }));
  fireEvent.click((await screen.findAllByRole("button", { name: /示例：调整请求超时/u }))[0]!);
  expect(await screen.findByText("复评：撤销（误报）")).toBeVisible();
  // Judged a false alarm on this code, the earlier report of it is not carried as "应当还在".
  expect(screen.queryByText(/上次评审的/u)).toBeNull();
  fireEvent.click(screen.getByLabelText("评审操作"));
  fireEvent.click(screen.getByRole("button", { name: "发布评审摘要到 PR" }));
  const draft = within(await screen.findByRole("dialog", { name: "发布到 PR" })).getByLabelText("评论内容") as HTMLTextAreaElement;
  expect(draft.value).not.toContain("仍然存在");
});

it("takes a rerun's recheck as read on this code, and does not post its comment twice", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  const report = await api.runPrReview({ snapshotId: snapshot.snapshotId, runId: "00000000-0000-4000-8000-000000000002", profileId: "local", focus: "" });
  const files = [{ path: "src/request.ts", status: "modified" }, { path: "src/retry.ts", status: "modified" }];
  const base = { kind: "review" as const, model: "本机", focus: "", draft: "", turns: [], events: [], state: "finished" as const, error: "", verdicts: [], connectionId: "00000000-0000-4000-8000-000000000011" };
  const now = { ...snapshot, files };
  saveReviewHistory([
    { ...base, id: "00000000-0000-4000-8000-0000000000a4", at: "2026-09-30T11:00:00.000Z", rechecks: [], published: [], report: { ...report, history: [] }, snapshot: now },
    // The same commits: it posted the timeout problem, and found the retry problem still there.
    { ...base, id: "00000000-0000-4000-8000-0000000000a3", at: "2026-09-30T10:00:00.000Z", published: [{ finding: 0, at: "2026-09-30T10:20:00.000Z" }], report: { ...report, history: [] }, snapshot: now,
      rechecks: [{ run: "00000000-0000-4000-8000-0000000000a2", finding: 0, verdict: "keep", reason: "第 30 行仍然没有上限。", replacement: null, at: "2026-09-30T10:05:00.000Z", model: "本机" }] },
    { ...base, id: "00000000-0000-4000-8000-0000000000a2", at: "2026-09-29T10:00:00.000Z", rechecks: [], published: [], snapshot: { ...now, sourceCommit: "c".repeat(40) },
      report: { ...report, history: [], reviewedFiles: ["src/request.ts"], findings: [{ priority: "P2" as const, title: "重试没有上限", body: "重试次数不封顶。", path: "src/retry.ts", side: "new" as const, line: 30, decisionIndexes: [] }] } },
  ]);
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /历史评审/u }));
  fireEvent.click((await screen.findAllByRole("button", { name: /示例：调整请求超时/u }))[0]!);
  const section = (await screen.findByText("上次评审的 1 个问题 · 1 个所在文件有改动")).closest("details")!;
  section.open = true;
  expect(section).toHaveTextContent("重试没有上限src/retry.ts:30 · 仍然存在");
  expect(section).toHaveTextContent("第 30 行仍然没有上限。");
  expect(within(section).queryByRole("button", { name: /复核有改动/u })).toBeNull();
  // Posted by the rerun on this very line: not offered again.
  expect(screen.getByText("同一提交的另一次评审已发布")).toBeVisible();
  expect(screen.queryByRole("button", { name: "把「超时后请求仍在运行」转为 PR 评论" })).toBeNull();
});

it("names the lockfiles and generated files the review leaves out", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  vi.spyOn(api, "loadPrReview").mockResolvedValue({ ...snapshot, skippedFiles: ["package-lock.json", "a.min.js", "b.min.js", "c.js.map"] });
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  expect(await screen.findByText(/不送模型的锁定或生成文件：package-lock\.json、a\.min\.js、b\.min\.js 等 4 个/)).toBeVisible();
});

it("posts an answer to the PR as a whole after the reader confirms it, and only once", async () => {
  const api = createPreviewApi();
  vi.spyOn(api, "followUpPrReview").mockResolvedValue({ answer: "## 概览\n\n修复超时。" });
  const publish = vi.spyOn(api, "publishPrGeneralComment");
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  fireEvent.click(await screen.findByRole("radio", { name: /PR 概览/ }));
  const run = screen.getByRole("button", { name: "生成 PR 概览" });
  await waitFor(() => expect(run).toBeEnabled());
  fireEvent.click(run);
  fireEvent.click(await screen.findByRole("button", { name: "把这条回答发布到 PR" }));
  const dialog = await screen.findByRole("dialog", { name: "发布到 PR" });
  const text = within(dialog).getByLabelText("评论内容");
  expect(text).toHaveValue("## 概览\n\n修复超时。");
  fireEvent.change(text, { target: { value: "## 概览\n\n修复超时（已核对）。" } });
  const post = within(dialog).getByRole("button", { name: "发布评论" });
  await waitFor(() => expect(post).toBeEnabled());
  fireEvent.click(post);
  await waitFor(() => expect(publish).toHaveBeenCalledWith({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123", sourceCommit: "a".repeat(40), destinationCommit: "b".repeat(40), body: "## 概览\n\n修复超时（已核对）。" }));
  expect(await screen.findByText("已发布到 PR")).toBeVisible();
  expect(screen.queryByRole("button", { name: "把这条回答发布到 PR" })).toBeNull();
});

it("lets the oldest records give way when storage is full, instead of saving nothing", () => {
  // Only the shape matters to saving: newest first, as the panel keeps them.
  const entries = Array.from({ length: 10 }, (_, index) => ({ id: `entry-${index}`, note: "x".repeat(1_000) })) as unknown as ReviewHistoryEntry[];
  const setItem = Storage.prototype.setItem;
  const full = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
    if (value.length > 5_000) throw new DOMException("full", "QuotaExceededError");
    setItem.call(this, key, value);
  });
  try {
    const { saved, dropped } = saveReviewHistory(entries);
    expect(saved).toBe(true);
    expect(dropped).toBeGreaterThan(0);
    const stored = JSON.parse(localStorage.getItem("decision.pr-review.history.v1")!) as { id: string }[];
    expect(stored).toHaveLength(10 - dropped);
    expect(stored[0]!.id).toBe("entry-0");
  } finally { full.mockRestore(); }
});

it("marks a PR that changed after its last review or overview", async () => {
  const api = createPreviewApi();
  const [item] = (await api.listPullRequests({ connectionId: "00000000-0000-4000-8000-000000000011", filter: "review-requested", page: 1 })).items;
  const list = vi.spyOn(api, "listPullRequests").mockResolvedValue({ items: [item!], nextPage: null });
  vi.spyOn(api, "followUpPrReview").mockResolvedValue({ answer: "概览" });
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  fireEvent.click(await screen.findByRole("radio", { name: /PR 概览/ }));
  const run = screen.getByRole("button", { name: "生成 PR 概览" });
  await waitFor(() => expect(run).toBeEnabled());
  fireEvent.click(run);
  expect(await screen.findByText("概览")).toBeVisible();
  // Read before the overview: nothing new. A later update asks for another look.
  expect(screen.getByRole("button", { name: /#123 示例：调整请求超时/ })).not.toHaveTextContent("之后有更新");
  list.mockResolvedValue({ items: [{ ...item!, updatedAt: "2099-01-01T00:00:00Z" }], nextPage: null });
  fireEvent.click(screen.getByRole("button", { name: "刷新 PR 列表" }));
  await waitFor(() => expect(screen.getByRole("button", { name: /#123 示例：调整请求超时/ })).toHaveTextContent("PR 概览之后有更新"));
  // Set apart at the end of the status line, and still found by searching for it.
  expect(screen.getByRole("button", { name: /#123 示例：调整请求超时/ }).querySelector("[data-changed]")).toHaveTextContent("之后有更新");
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索评审列表" }), { target: { value: "之后有更新" } });
  expect(screen.getByRole("button", { name: /#123 示例：调整请求超时/ })).toBeVisible();
});

it("keeps the PR read before on screen when its commits cannot be confirmed", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  vi.spyOn(api, "peekPrReview").mockResolvedValue(snapshot);
  vi.spyOn(api, "loadPrReview").mockRejectedValue(new Error("代码平台连接失败"));
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  expect(await screen.findByText("无法核对最新提交，显示的是上次读取的内容：代码平台连接失败")).toBeVisible();
  expect(screen.getByText("选择方式")).toBeVisible();
});

it("keeps a running review mounted across navigation and can stop it", async () => {
  const api = createPreviewApi();
  let resolve!: (value: Awaited<ReturnType<typeof api.runPrReview>>) => void;
  const pending = new Promise<Awaited<ReturnType<typeof api.runPrReview>>>((done) => { resolve = done; });
  const run = vi.spyOn(api, "runPrReview").mockReturnValue(pending);
  const cancel = vi.spyOn(api, "cancelPrReview").mockResolvedValue(undefined);
  const view = render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  fireEvent.click(await screen.findByRole("button", { name: "开始评审" }));
  await screen.findByRole("button", { name: "停止评审" });
  view.rerender(<PrReviewPanel api={api} hidden />);
  expect(cancel).not.toHaveBeenCalled();
  view.rerender(<PrReviewPanel api={api} />);
  fireEvent.click(screen.getByRole("button", { name: "停止评审" }));
  expect(cancel).toHaveBeenCalledWith(run.mock.calls[0]![0].runId);
  expect(await screen.findByText("正在停止…")).toBeVisible();
  resolve({ status: "cancelled", summary: "评审已停止", findings: [], evidence: [], readFiles: [], unreadFiles: ["src/request.ts"], warnings: [], steps: 1, history: [], reviewedFiles: [], unreviewedFiles: ["src/request.ts"] });
  expect(await screen.findByText("评审已停止")).toBeVisible();
  // Stopped now, as the report says: the note that it was stopping goes.
  expect(screen.queryByText("正在停止…")).toBeNull();
});

it("reviews the commits the platform has as the review starts, not those read when the PR was opened", async () => {
  const api = createPreviewApi();
  const first = await api.loadPrReview({ connectionId: "preview", reference: "sample/app#123" });
  // Pushed while the preparation page stood open: the snapshot read then is replaced or expired.
  const newer = { ...first, snapshotId: crypto.randomUUID(), sourceCommit: "c".repeat(40) };
  vi.spyOn(api, "loadPrReview").mockResolvedValueOnce(first).mockResolvedValue(newer);
  const run = vi.spyOn(api, "runPrReview");
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例/ }));
  const start = await screen.findByRole("button", { name: "开始评审" });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);

  await waitFor(() => expect(run).toHaveBeenCalledWith(expect.objectContaining({ snapshotId: newer.snapshotId })));
  expect(await screen.findByText("PR 有新提交，已读取最新变更。")).toBeVisible();
});

it("keeps focus on a finding when its no is taken back from its card", async () => {
  const api = createPreviewApi();
  await runSampleReview(api);
  fireEvent.click(screen.getByRole("button", { name: "不采纳「超时后请求仍在运行」" }));
  const form = await screen.findByRole("form", { name: "不采纳这条问题" });
  fireEvent.change(within(form).getByLabelText("不采纳的原因"), { target: { value: "有意为之。" } });
  fireEvent.click(within(form).getByRole("button", { name: "不采纳" }));
  const withdraw = within(await screen.findByRole("note", { name: "不采纳" })).getByRole("button", { name: "撤回" });
  withdraw.focus();
  fireEvent.click(withdraw);

  // The button goes with the note it sat in: focus goes to the finding, not to the page.
  await waitFor(() => expect(screen.getByRole("heading", { name: "P2 超时后请求仍在运行" })).toHaveFocus());
});

it("shows and updates a tool's process record before the review has finished", async () => {
  const api = createPreviewApi();
  let listener!: Parameters<typeof api.onPrReviewProgress>[0];
  vi.spyOn(api, "onPrReviewProgress").mockImplementation((handler) => { listener = handler; return () => undefined; });
  const run = vi.spyOn(api, "runPrReview").mockImplementation(() => new Promise(() => undefined));
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例/ }));
  fireEvent.click(await screen.findByRole("button", { name: "开始评审" }));
  await waitFor(() => expect(run).toHaveBeenCalled());
  const runId = run.mock.calls[0]![0].runId;
  const process = () => screen.getByRole("region", { name: "评审过程" });
  act(() => listener({ runId, id: "one", at: new Date().toISOString(), kind: "tool", status: "running", message: "读取 src/request.ts 的变更", detail: "从第1行开始" }));
  expect(process().querySelector('li[data-status="running"]')).toHaveTextContent("读取 src/request.ts 的变更");
  act(() => listener({ runId, id: "one", at: new Date().toISOString(), kind: "tool", status: "done", message: "读取 src/request.ts 的变更：60 行", detail: "读取60行" }));
  expect(process().querySelectorAll("li[data-status]")).toHaveLength(1);
  expect(process().querySelector('li[data-status="done"]')).toHaveTextContent("读取 src/request.ts 的变更：60 行");
  expect(screen.getByRole("button", { name: "停止评审" })).toBeVisible();
  // How far it is, in the header and the list, from the batch it is on.
  act(() => listener({ runId, id: "batch-1", at: new Date().toISOString(), kind: "status", status: "running", message: "评审分组 2/5：src/request.ts 等 3 个文件" }));
  expect(screen.getAllByText(/评审中 · 2\/5 组/u).length).toBeGreaterThan(0);
  // With several groups at work at once (a remote model), how many are done.
  act(() => listener({ runId, id: "batch-0", at: new Date().toISOString(), kind: "status", status: "done", message: "评审分组 1/5：src/a.ts" }));
  act(() => listener({ runId, id: "batch-2", at: new Date().toISOString(), kind: "status", status: "running", message: "评审分组 3/5：src/c.ts" }));
  expect(screen.getAllByText(/评审中 · 已完成 1\/5 组/u).length).toBeGreaterThan(0);
  // A group that ended without its conclusion is not counted done.
  act(() => listener({ runId, id: "batch-3", at: new Date().toISOString(), kind: "status", status: "error", message: "评审分组 4/5：src/d.ts" }));
  expect(screen.getAllByText(/评审中 · 已完成 1\/5 组，1 组未评完/u).length).toBeGreaterThan(0);
});

it("shows each group's steps under it, saying what each read or found, without the model's calls or labels above every step", async () => {
  const api = createPreviewApi();
  let listener!: Parameters<typeof api.onPrReviewProgress>[0];
  vi.spyOn(api, "onPrReviewProgress").mockImplementation((handler) => { listener = handler; return () => undefined; });
  const run = vi.spyOn(api, "runPrReview").mockImplementation(() => new Promise(() => undefined));
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例/ }));
  fireEvent.click(await screen.findByRole("button", { name: "开始评审" }));
  await waitFor(() => expect(run).toHaveBeenCalled());
  const runId = run.mock.calls[0]![0].runId;
  const at = () => new Date().toISOString();
  act(() => {
    listener({ runId, id: "brief", at: at(), kind: "model", status: "done", message: "梳理 PR 全貌" });
    listener({ runId, id: "batch-0", at: at(), kind: "status", status: "running", group: 0, message: "评审分组 1/2：src/request.ts" });
    listener({ runId, id: "think", at: at(), kind: "model", status: "done", group: 0, lens: "rules", message: "第 1 次调用模型完成" });
    listener({ runId, id: "search", at: at(), kind: "tool", status: "done", group: 0, lens: "rules", message: "检索决策「请求超时」：1 条相关（summarize/DEC-1）" });
  });
  const group = screen.getByRole("region", { name: "评审过程" }).querySelector(".review-step-group")!;
  expect(group).toHaveTextContent("评审分组 1/2：src/request.ts");
  expect(group).toHaveTextContent("进行中 · 1 步");
  expect(within(group as HTMLElement).getByText("规则与决策")).toBeVisible();
  expect(within(group as HTMLElement).getByText("检索决策「请求超时」：1 条相关（summarize/DEC-1）")).toBeVisible();
  // The mark before a step is drawn; a screen reader hears how it went in words.
  expect(within(group as HTMLElement).getByText("已完成：")).toHaveClass("sr-only");
  // A group's model call is said by the steps it chose; the PR's brief, outside any group, stays.
  expect(screen.queryByText("第 1 次调用模型完成")).toBeNull();
  expect(screen.getByText("梳理 PR 全貌")).toBeVisible();
  expect(screen.getByRole("region", { name: "评审过程" })).not.toHaveTextContent(/工具|动作详情/u);
});

it("opens what a step found or read from its line: each decision and its note, the code and the file it came from", async () => {
  const api = createPreviewApi();
  let listener!: Parameters<typeof api.onPrReviewProgress>[0];
  vi.spyOn(api, "onPrReviewProgress").mockImplementation((handler) => { listener = handler; return () => undefined; });
  const run = vi.spyOn(api, "runPrReview").mockImplementation(() => new Promise(() => undefined));
  const note = vi.spyOn(api, "openVaultDocument").mockResolvedValue(undefined);
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例/ }));
  fireEvent.click(await screen.findByRole("button", { name: "开始评审" }));
  await waitFor(() => expect(run).toHaveBeenCalled());
  const runId = run.mock.calls[0]![0].runId;
  const at = () => new Date().toISOString();
  act(() => {
    listener({ runId, id: "batch-0", at: at(), kind: "status", status: "running", group: 0, message: "评审分组 1/1：src/request.ts" });
    listener({ runId, id: "search", at: at(), kind: "tool", status: "done", group: 0, message: "检索与本组相关的决策：1 条相关（summarize/DEC-1）",
      decisions: [{ source: "summarize", id: "DEC-1", title: "请求超时必须取消", summary: "超时后取消实际调用，释放资源。", applicability: "needs_review", relativePath: "summarize/DEC-1.md" }] });
    listener({ runId, id: "read", at: at(), kind: "tool", status: "done", group: 0, message: "读取源码 src/request.ts 第 1–80 行",
      code: { path: "src/request.ts", side: "new", line: 1, view: "file" }, detail: "    1  export async function request(url: string) {" });
    listener({ runId, id: "think", at: at(), kind: "model", status: "error", group: 0, message: "模型的回答不符合要求的格式",
      detail: "错误类别：invalid_output\n\n模型原始输出：\n好的，我来评审。" });
    listener({ runId, id: "diff", at: at(), kind: "tool", status: "done", group: 0, message: "读取 src/request.ts 的变更：2 行",
      code: { path: "src/request.ts", side: "new", line: 2, view: "diff" }, detail: "1/1  const timeout = 100;\n-/2 +const controller = new AbortController();" });
    // A file the PR does not change, read for a definition: the PR's details do not hold it.
    listener({ runId, id: "elsewhere", at: at(), kind: "tool", status: "done", group: 0, message: "读取源码 src/config.ts 第 1–80 行",
      code: { path: "src/config.ts", side: "new", line: 1, view: "file" }, detail: "    1  export const config = {};" });
  });
  const group = within(screen.getByRole("region", { name: "评审过程" }).querySelector<HTMLElement>(".review-step-group")!);
  expect(group.getByText("读取源码 src/config.ts 第 1–80 行").closest("li")!.querySelector("button")).toBeNull();
  expect(group.getByText(/-\/2 \+const controller/u)).toHaveAttribute("data-change", "add");
  fireEvent.click(screen.getByText("查看 1 条决策"));
  expect(screen.getByText("请求超时必须取消")).toBeVisible();
  expect(screen.getByText("需核对适用范围")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "打开来源笔记：请求超时必须取消" }));
  expect(note).toHaveBeenCalledWith("summarize/DEC-1.md");
  // A refused answer as the model wrote it, not only its kind of failure.
  fireEvent.click(screen.getByText("查看模型原始输出"));
  expect(screen.getByText(/好的，我来评审。/u)).toBeVisible();
  const read = within(group.getByText("读取源码 src/request.ts 第 1–80 行").closest("li")!);
  fireEvent.click(read.getByText("查看代码"));
  expect(read.getByText(/export async function request/u)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "在 PR 详情中查看整个文件" }));
  const dialog = await screen.findByRole("dialog", { name: "PR 详情" });
  expect(await within(dialog).findByRole("list", { name: "文件内容" })).toBeVisible();
});

it("lists each group's conclusion under its files and reviewer, rather than one paragraph", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  const report = await api.runPrReview({ snapshotId: snapshot.snapshotId, runId: "00000000-0000-4000-8000-000000000002", profileId: "local", focus: "" });
  saveReviewHistory([{ kind: "review", model: "本机", focus: "", draft: "", turns: [], events: [], state: "finished", error: "", rechecks: [], published: [], verdicts: [],
    connectionId: "00000000-0000-4000-8000-000000000011", id: "00000000-0000-4000-8000-0000000000e3", at: "2026-09-30T11:00:00.000Z", snapshot,
    report: { ...report, overview: "给请求加上超时。", conclusions: [{ label: "src/request.ts", lens: "bugs", text: "超时后请求仍在运行。\n- 应传入 AbortSignal" }, { label: "src/request.ts", lens: "rules", text: "没有违反评审规则。" }] } }]);
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /历史评审/u }));
  fireEvent.click((await screen.findAllByRole("button", { name: /示例：调整请求超时/u }))[0]!);
  const conclusions = await screen.findByRole("list", { name: "各组结论" });
  // One block a group; a list inside a conclusion (its Markdown) is not counted as one.
  expect(conclusions.querySelectorAll(":scope > li")).toHaveLength(2);
  expect(within(conclusions).getByText("缺陷")).toBeVisible();
  expect(within(conclusions).getByText("应传入 AbortSignal")).toBeVisible();
  expect(screen.getByText("给请求加上超时。")).toBeVisible();
});

it("drafts the review's summary as one PR comment, to post after a look", async () => {
  const api = createPreviewApi();
  const publish = vi.spyOn(api, "publishPrGeneralComment");
  await runSampleReview(api);
  fireEvent.click(screen.getByLabelText("评审操作"));
  fireEvent.click(screen.getByRole("button", { name: "发布评审摘要到 PR" }));
  const dialog = await screen.findByRole("dialog", { name: "发布到 PR" });
  const text = within(dialog).getByLabelText("评论内容") as HTMLTextAreaElement;
  expect(text.value).toBe(`**AI 评审**：1 个问题（P2 ×1）（提交 \`${"a".repeat(12)}\`）\n- **P2** 超时后请求仍在运行（\`src/request.ts:12\`）`);
  const send = within(dialog).getByRole("button", { name: "发布评论" });
  await waitFor(() => expect(send).toBeEnabled());
  fireEvent.click(send);
  await waitFor(() => expect(publish).toHaveBeenCalledWith(expect.objectContaining({ body: text.value })));
});

it("keeps the lists open while a review runs, and leads back to it", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  const report = await api.runPrReview({ snapshotId: snapshot.snapshotId, runId: "00000000-0000-4000-8000-000000000002", profileId: "local", focus: "" });
  saveReviewHistory([{ id: "00000000-0000-4000-8000-0000000000d9", kind: "review", at: "2026-09-29T10:00:00.000Z", model: "本机", focus: "", draft: "", turns: [], events: [], state: "finished", error: "", published: [], verdicts: [], rechecks: [],
    connectionId: "00000000-0000-4000-8000-000000000011", report: { ...report, history: [], summary: "早先那次评审的结论。" }, snapshot: { ...snapshot, sourceCommit: "c".repeat(40) } }]);
  const run = api.runPrReview;
  let finish!: () => void;
  vi.spyOn(api, "runPrReview").mockImplementation(input => new Promise(resolve => { finish = () => resolve(run(input)); }));
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/u }));
  // The PR was reviewed before: its record opens; a new review starts from there.
  fireEvent.click(await screen.findByRole("button", { name: "重新评审最新提交" }));
  const start = await screen.findByRole("button", { name: "开始评审" });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  expect(await screen.findByRole("button", { name: "停止评审" })).toBeVisible();
  // The list itself can be refreshed or narrowed meanwhile.
  expect(screen.getByRole("button", { name: "刷新 PR 列表" })).toBeEnabled();
  expect(within(screen.getByRole("group", { name: "PR 范围" })).getByRole("button", { name: "我创建的" })).toBeEnabled();
  // The earlier review can be read meanwhile; stopping belongs to the running one only.
  fireEvent.click(screen.getByRole("button", { name: /历史评审/u }));
  const older = document.querySelector<HTMLButtonElement>('[data-run-id="00000000-0000-4000-8000-0000000000d9"]')!;
  expect(older).toBeEnabled();
  fireEvent.click(older);
  expect(await screen.findByText("早先那次评审的结论。")).toBeVisible();
  expect(screen.queryByRole("button", { name: "停止评审" })).toBeNull();
  expect(screen.getByText(/「示例：调整请求超时」正在评审，完成或停止后才能开始新的评审或追问。/u)).toBeVisible();
  expect(screen.getByRole("textbox", { name: "继续追问" })).toHaveAttribute("readonly");
  fireEvent.click(screen.getByRole("button", { name: "回到正在进行的评审" }));
  expect(await screen.findByRole("button", { name: "停止评审" })).toBeVisible();
  // Away again when it ends: the page there says so, and leads to the result.
  fireEvent.click(older);
  expect(await screen.findByText("早先那次评审的结论。")).toBeVisible();
  finish();
  fireEvent.click(await screen.findByRole("button", { name: "查看结果" }));
  expect(await screen.findByRole("heading", { name: "评审完成" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "查看结果" })).toBeNull();
  expect(screen.queryByText(/正在评审，完成或停止后/u)).toBeNull();
});

it("copies every standing finding as one list for a coding agent", async () => {
  const api = createPreviewApi();
  const run = api.runPrReview;
  vi.spyOn(api, "runPrReview").mockImplementation(async (input) => {
    const report = await run(input);
    const finding = report.findings[0]!;
    return { ...report, findings: [finding, { ...finding, priority: "P1" as const, title: "凭据写进日志", line: 13 }, { ...finding, title: "计时器未清理", line: 14 }] };
  });
  vi.spyOn(api, "reevaluatePrReviewFinding").mockResolvedValue({ verdict: "drop", reason: "已经清理。", replacement: null });
  await runSampleReview(api);
  fireEvent.click(screen.getByRole("button", { name: "复评「计时器未清理」" }));
  expect(await screen.findByText("复评：撤销（误报）")).toBeVisible();
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  fireEvent.click(screen.getByLabelText("评审操作"));
  fireEvent.click(screen.getByRole("button", { name: "复制问题清单" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
  const list = (writeText.mock.calls[0] as unknown as [string])[0];
  expect(list).toContain("# 示例：调整请求超时（sample/app#123）的评审问题\n\n共 2 个");
  expect(list).toContain("**P1 · 凭据写进日志**");
  expect(list).toContain("`src/request.ts:13`");
  // The dropped one is left out.
  expect(list).not.toContain("计时器未清理");
});

it("returns to the actions menu once the summary dialog is closed", async () => {
  const api = createPreviewApi();
  await runSampleReview(api);
  fireEvent.click(screen.getByLabelText("评审操作"));
  fireEvent.click(screen.getByRole("button", { name: "发布评审摘要到 PR" }));
  const dialog = await screen.findByRole("dialog", { name: "发布到 PR" });
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "发布到 PR" })).toBeNull());
  // The menu item it came from is folded away: focus goes back to the menu, not to the page.
  expect(screen.getByLabelText("评审操作")).toHaveFocus();
});

it("re-evaluates every finding without a verdict in one go, and stops when asked", async () => {
  const api = createPreviewApi();
  const run = api.runPrReview;
  vi.spyOn(api, "runPrReview").mockImplementation(async (input) => {
    const report = await run(input);
    const finding = report.findings[0]!;
    return { ...report, findings: [finding, { ...finding, title: "计时器未清理", line: 13 }, { ...finding, title: "错误信息丢失", line: 14 }] };
  });
  let release!: () => void;
  const reevaluate = vi.spyOn(api, "reevaluatePrReviewFinding")
    .mockResolvedValueOnce({ verdict: "keep", reason: "成立。", replacement: null })
    .mockImplementationOnce((input) => new Promise((_, reject) => { release = () => reject(new Error(`cancelled ${input.runId}`)); }));
  const cancel = vi.spyOn(api, "cancelPrReview").mockImplementation(async () => { release(); });
  await runSampleReview(api);
  fireEvent.click(screen.getByRole("button", { name: "全部复评（3）" }));
  // The button gives way to a progress line; focus waits on the report's heading rather than falling out.
  expect(screen.getByRole("heading", { name: "评审完成" })).toHaveFocus();
  expect(await screen.findByText("正在复评 2 / 3…")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "停止复评" }));
  await waitFor(() => expect(screen.queryByText(/正在复评/u)).toBeNull());
  expect(cancel).toHaveBeenCalled();
  expect(reevaluate).toHaveBeenCalledTimes(2);
  // One verdict kept; the other two wait for another run.
  expect(screen.getByText("复评：保留")).toBeVisible();
  expect(screen.getByRole("button", { name: "全部复评（2）" })).toBeVisible();
});

it("reads a long report one priority at a time", async () => {
  const api = createPreviewApi();
  const run = api.runPrReview;
  vi.spyOn(api, "runPrReview").mockImplementation(async (input) => {
    const report = await run(input);
    const finding = report.findings[0]!;
    return { ...report, findings: [finding, { ...finding, priority: "P1" as const, title: "凭据写进日志", line: 13 }, { ...finding, priority: "P3" as const, title: "命名不一致", line: 14 }, { ...finding, title: "重试没有上限", line: 15 }] };
  });
  await runSampleReview(api);
  const filter = screen.getByRole("group", { name: "筛选问题" });
  fireEvent.click(within(filter).getByRole("button", { name: "P1 1" }));
  expect(screen.getByRole("heading", { name: "P1 凭据写进日志" })).toBeVisible();
  expect(screen.queryByRole("heading", { name: "P2 超时后请求仍在运行" })).toBeNull();
  // Actions still act on the finding they sit under.
  expect(screen.getByRole("button", { name: "复制「凭据写进日志」" })).toBeVisible();
  fireEvent.click(within(filter).getByRole("button", { name: "全部 4" }));
  expect(screen.getByRole("heading", { name: "P2 超时后请求仍在运行" })).toBeVisible();
  // The list says a P1 stands, so this PR can be found first; once the P1 is dropped it says no more.
  expect(screen.getByRole("button", { name: /#123 示例：调整请求超时/u })).toHaveTextContent("评审完成 · 4 个问题（1 个 P1）");
  // A screen reader hears it too, after the PR's name.
  expect(screen.getByRole("button", { name: /#123 示例：调整请求超时/u })).toHaveAccessibleDescription("评审完成 · 4 个问题（1 个 P1）");
  expect(screen.getByRole("button", { name: /#123 示例：调整请求超时/u }).querySelector(".review-status-p1")).toHaveTextContent("（1 个 P1）");
  vi.spyOn(api, "reevaluatePrReviewFinding").mockResolvedValue({ verdict: "drop", reason: "日志里只有请求 ID。", replacement: null });
  fireEvent.click(screen.getByRole("button", { name: "复评「凭据写进日志」" }));
  await waitFor(() => expect(screen.getByRole("button", { name: /#123 示例：调整请求超时/u })).toHaveTextContent("评审完成 · 4 个问题"));
  expect(screen.getByRole("button", { name: /#123 示例：调整请求超时/u })).not.toHaveTextContent("P1");
  // The report's head counts what stands, as the list does.
  expect(screen.getByRole("listitem", { name: "评审结果" }).querySelector(".review-result-head")).not.toHaveTextContent("P1");
});

it("narrows a long report to the findings still waiting for a decision", async () => {
  const api = createPreviewApi();
  const run = api.runPrReview;
  vi.spyOn(api, "runPrReview").mockImplementation(async (input) => {
    const report = await run(input);
    const finding = report.findings[0]!;
    return { ...report, findings: [finding, { ...finding, title: "计时器未清理", line: 13 }, { ...finding, title: "错误信息丢失", line: 14 }, { ...finding, title: "重试没有上限", line: 15 }] };
  });
  vi.spyOn(api, "reevaluatePrReviewFinding").mockResolvedValue({ verdict: "drop", reason: "上一行已经清理。", replacement: null });
  await runSampleReview(api);
  // Every finding is open and of one priority: nothing to narrow yet.
  expect(screen.queryByRole("group", { name: "筛选问题" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "复评「计时器未清理」" }));
  expect(await screen.findByText("复评：撤销（误报）")).toBeVisible();
  // The line of numbers says how many of them were dropped.
  expect(screen.getByText(/^4 个问题（1 个已撤销） · 完成评审/u)).toBeVisible();
  const filter = screen.getByRole("group", { name: "筛选问题" });
  fireEvent.click(within(filter).getByRole("button", { name: "待处理 3" }));
  expect(screen.queryByRole("heading", { name: "P2 计时器未清理" })).toBeNull();
  expect(screen.getByRole("heading", { name: "P2 错误信息丢失" })).toBeVisible();
  // One priority only: no priority buttons beside it.
  expect(within(filter).queryByRole("button", { name: /^P2/u })).toBeNull();
  fireEvent.click(within(filter).getByRole("button", { name: "全部 4" }));
  expect(screen.getByRole("heading", { name: "P2 计时器未清理" })).toBeVisible();
});

it("posts several findings in one go, each on its line, and stops at the first failure", async () => {
  const api = createPreviewApi();
  const run = api.runPrReview;
  vi.spyOn(api, "runPrReview").mockImplementation(async (input) => {
    const report = await run(input);
    const finding = report.findings[0]!;
    return { ...report, findings: [finding, { ...finding, title: "计时器未清理", line: 13 }, { ...finding, title: "错误信息丢失", line: 14 }] };
  });
  const publish = vi.spyOn(api, "publishPrReviewComment").mockResolvedValueOnce({ message: "ok" }).mockRejectedValueOnce(new Error("Error invoking remote method 'decision:pr-review-comment': Error: PR 版本或状态已变化（HTTP 409），请刷新后重新确认。"));
  await runSampleReview(api);
  fireEvent.click(screen.getByRole("button", { name: "批量发布为 PR 评论（3）" }));
  const dialog = await screen.findByRole("dialog", { name: "批量发布为 PR 评论" });
  // Named with its line, so two findings with one title are still told apart.
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "错误信息丢失（src/request.ts:14）" }));
  const send = within(dialog).getByRole("button", { name: "发布 2 条" });
  await waitFor(() => expect(send).toBeEnabled());
  fireEvent.click(send);
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("「计时器未清理」发布失败：PR 版本或状态已变化（HTTP 409），请刷新后重新确认。已发布 1 条。");
  expect(publish).toHaveBeenCalledTimes(2);
  expect(publish).toHaveBeenNthCalledWith(1, expect.objectContaining({ path: "src/request.ts", line: 12, side: "new", body: expect.stringContaining("**P2 · 超时后请求仍在运行**") }));
  // The one that went out is not offered again; a retry sends the rest and counts both rounds.
  expect(within(dialog).getByText("已发布")).toBeVisible();
  fireEvent.click(within(dialog).getByRole("button", { name: "发布 1 条" }));
  expect(await screen.findByText("已发布 2 条评论。")).toBeVisible();
  expect(publish).toHaveBeenCalledTimes(3);
  expect(screen.queryByRole("button", { name: /批量发布为 PR 评论/u })).toBeNull();
});

it("says what went out when a batch is closed after a failure", async () => {
  const api = createPreviewApi();
  const run = api.runPrReview;
  vi.spyOn(api, "runPrReview").mockImplementation(async (input) => {
    const report = await run(input);
    return { ...report, findings: [report.findings[0]!, { ...report.findings[0]!, title: "计时器未清理", line: 13 }] };
  });
  vi.spyOn(api, "publishPrReviewComment").mockResolvedValueOnce({ message: "ok" }).mockRejectedValueOnce(new Error("失败"));
  await runSampleReview(api);
  fireEvent.click(screen.getByRole("button", { name: "批量发布为 PR 评论（2）" }));
  const dialog = await screen.findByRole("dialog", { name: "批量发布为 PR 评论" });
  const send = within(dialog).getByRole("button", { name: "发布 2 条" });
  await waitFor(() => expect(send).toBeEnabled());
  fireEvent.click(send);
  await within(dialog).findByRole("alert");
  fireEvent.click(within(dialog).getByRole("button", { name: "关闭批量发布为 PR 评论" }));
  expect(await screen.findByText("已发布 1 条评论。")).toBeVisible();
});

it("opens a record picked in quick jump, in the history list", async () => {
  const api = createPreviewApi();
  await runSampleReview(api);
  const id = loadReviewHistory().entries[0]!.id;
  cleanup();
  const view = render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /PR\s*1/u }));
  view.rerender(<PrReviewPanel api={api} openRun={{ id }} />);
  expect(await screen.findByRole("button", { name: /历史评审/u })).toHaveAttribute("aria-pressed", "true");
  expect(document.querySelector(`[data-run-id="${id}"]`)).toHaveAttribute("aria-pressed", "true");
  expect(await screen.findByRole("heading", { name: "P2 超时后请求仍在运行" })).toBeVisible();
});

it("tells the sidebar a review is running, and that it ended while the page was elsewhere", async () => {
  const api = createPreviewApi();
  let finish!: (report: Awaited<ReturnType<typeof api.runPrReview>>) => void;
  const run = vi.spyOn(api, "runPrReview").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const activity = vi.fn();
  const view = render(<PrReviewPanel api={api} onActivity={activity} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例/ }));
  fireEvent.click(await screen.findByRole("button", { name: "开始评审" }));
  await waitFor(() => expect(activity).toHaveBeenLastCalledWith("running"));
  view.rerender(<PrReviewPanel api={api} hidden onActivity={activity} />);
  const report = await createPreviewApi().runPrReview({ snapshotId: "00000000-0000-4000-8000-000000000001", runId: run.mock.calls[0]![0].runId, profileId: "local", focus: "" });
  await act(async () => finish(report));
  await waitFor(() => expect(activity).toHaveBeenLastCalledWith("done"));
  view.rerender(<PrReviewPanel api={api} onActivity={activity} />);
  await waitFor(() => expect(activity).toHaveBeenLastCalledWith(null));
});

it("writes a question being typed once the typing pauses, not key by key, and at once when the window goes away", async () => {
  const api = createPreviewApi();
  await runSampleReview(api);
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  const writes = () => setItem.mock.calls.filter(([key]) => key === "decision.pr-review.history.v1").length;
  const box = screen.getByLabelText("继续追问");
  for (const draft of ["为", "为什么", "为什么要", "为什么要取消"]) fireEvent.change(box, { target: { value: draft } });
  expect(writes()).toBe(0);
  await waitFor(() => expect(loadReviewHistory().entries[0]!.draft).toBe("为什么要取消"));
  expect(writes()).toBe(1);
  fireEvent.change(box, { target: { value: "为什么要取消请求" } });
  act(() => { window.dispatchEvent(new Event("pagehide")); });
  expect(loadReviewHistory().entries[0]!.draft).toBe("为什么要取消请求");
  setItem.mockRestore();
});

it("writes the history at most once a second while a review runs, and its final state as soon as it ends", async () => {
  const api = createPreviewApi();
  let listener!: Parameters<typeof api.onPrReviewProgress>[0];
  vi.spyOn(api, "onPrReviewProgress").mockImplementation((handler) => { listener = handler; return () => undefined; });
  let finish!: (report: Awaited<ReturnType<typeof api.runPrReview>>) => void;
  const run = vi.spyOn(api, "runPrReview").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  const writes = () => setItem.mock.calls.filter(([key]) => key === "decision.pr-review.history.v1").length;
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例/ }));
  fireEvent.click(await screen.findByRole("button", { name: "开始评审" }));
  await waitFor(() => expect(run).toHaveBeenCalled());
  const runId = run.mock.calls[0]![0].runId;
  const before = writes();
  for (let step = 0; step < 30; step++) act(() => listener({ runId, id: `step-${step}`, at: new Date().toISOString(), kind: "tool", status: "done", message: `步骤 ${step}` }));
  expect(writes() - before).toBeLessThanOrEqual(1);
  const report = await createPreviewApi().runPrReview({ snapshotId: "00000000-0000-4000-8000-000000000001", runId, profileId: "local", focus: "" });
  await act(async () => finish(report));
  await waitFor(() => expect(loadReviewHistory().entries[0]).toMatchObject({ state: "finished" }));
  expect(loadReviewHistory().entries[0]!.events.map(event => event.id)).toEqual(expect.arrayContaining(["step-0", "step-29"]));
  setItem.mockRestore();
});

it("refreshes connections after returning from settings without offering connection editing here", async () => {
  const api = createPreviewApi();
  const connections = vi.spyOn(api, "listPrConnections").mockResolvedValue([]);
  const open = vi.spyOn(api, "openSurface").mockResolvedValue(undefined);
  const view = render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: "管理链接" }));
  expect(open).toHaveBeenCalledWith("connections");
  expect(screen.queryByLabelText("访问令牌")).toBeNull();
  view.rerender(<PrReviewPanel api={api} hidden />);
  connections.mockResolvedValue([{ id: "00000000-0000-4000-8000-000000000011", label: "新连接", platform: "github", baseUrl: "https://github.com" }]);
  view.rerender(<PrReviewPanel api={api} />);
  expect(await screen.findByRole("button", { name: /#123 示例/ })).toBeVisible();
  expect(screen.getByRole("option", { name: "新连接 · GitHub" })).toBeInTheDocument();
});


it("retains separate runs across restart and exports the selected run's commit", async () => {
  const api = createPreviewApi();
  const first = await api.loadPrReview({ connectionId: "preview", reference: "sample/app#123" });
  // The platform's answer, however often it is asked: the first commit until a newer one is pushed.
  let onPlatform = first;
  vi.spyOn(api, "loadPrReview").mockImplementation(async () => onPlatform);
  const exporter = vi.spyOn(api, "exportAssistantConversation").mockResolvedValue({ status: "cancelled" });
  const view = render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例/ }));
  fireEvent.click(await screen.findByRole("button", { name: "开始评审" }));
  await screen.findByRole("heading", { name: "P2 超时后请求仍在运行" });
  await waitFor(() => expect(loadReviewHistory().entries[0]?.state).toBe("finished"));
  const firstId = loadReviewHistory().entries[0]!.id;
  onPlatform = { ...first, snapshotId: crypto.randomUUID(), sourceCommit: "c".repeat(40) };
  fireEvent.click(screen.getByRole("button", { name: "重新评审最新提交" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "开始评审" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "开始评审" }));
  await waitFor(() => expect(loadReviewHistory().entries.filter(item => item.state === "finished")).toHaveLength(2));
  view.unmount();
  render(<PrReviewPanel api={api} />);
  fireEvent.click(screen.getByRole("button", { name: /^历史评审/ }));
  fireEvent.click(document.querySelector(`[data-run-id="${firstId}"]`)!);
  fireEvent.click(screen.getByLabelText("评审操作"));
  fireEvent.click(screen.getByRole("button", { name: "导出报告" }));
  expect(exporter).toHaveBeenCalledWith(expect.objectContaining({ markdown: expect.stringContaining("源提交：" + "a".repeat(40)) }));
  fireEvent.click(screen.getByLabelText("评审操作"));
  fireEvent.click(screen.getByRole("button", { name: "删除评审" }));
  expect(loadReviewHistory().entries).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(loadReviewHistory().entries).toHaveLength(1));
});

it("never saves an empty history in place of one the store is too full for, and keeps a huge newest record without its log", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  const run = (index: number, events: ReviewHistoryEntry["events"] = []): ReviewHistoryEntry => ({
    id: `00000000-0000-4000-8000-0000000000d${index}`, kind: "review", at: `2026-09-2${index}T10:00:00.000Z`, model: "本机", focus: "", draft: "",
    turns: [], events, state: "finished", error: "", published: [], verdicts: [], rechecks: [],
    connectionId: "00000000-0000-4000-8000-000000000011", report: null, snapshot,
  });
  const older = [run(1), run(2), run(3)];
  expect(saveReviewHistory(older)).toEqual({ saved: true, dropped: 0 });
  const kept = localStorage.getItem("decision.pr-review.history.v1");
  // A store that takes no more than the three runs already in it.
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
    if (value.length > kept!.length + 2_000) throw new DOMException("full", "QuotaExceededError");
    setItem.call(this, key, value);
  });
  const log = Array.from({ length: 40 }, (_, index) => ({ runId: "00000000-0000-4000-8000-0000000000d9", id: `step-${index}`, at: "2026-09-29T10:00:00.000Z",
    kind: "tool" as const, message: "读取变更", status: "done" as const, detail: "长".repeat(400) }));

  // Too large with its log: kept without it, the older runs with it.
  expect(saveReviewHistory([run(9, log), ...older])).toMatchObject({ saved: true });
  const saved = loadReviewHistory().entries;
  expect(saved.map((item) => item.id)).toContain("00000000-0000-4000-8000-0000000000d9");
  expect(saved.find((item) => item.id.endsWith("d9"))!.events).toEqual([]);

  // Too large even so: nothing is saved, and what was there stays.
  const before = localStorage.getItem("decision.pr-review.history.v1");
  const huge = { ...run(8, log), focus: "大".repeat(20_000) };
  expect(saveReviewHistory([huge, ...older])).toEqual({ saved: false, dropped: 0 });
  expect(localStorage.getItem("decision.pr-review.history.v1")).toBe(before);
});

it("restores unfinished runs as interrupted and keeps corrupt storage untouched", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "preview", reference: "sample/app#123" });
  const key = "decision.pr-review.history.v1";
  localStorage.setItem(key, JSON.stringify([{ id: crypto.randomUUID(), at: new Date().toISOString(), model: "测试模型", focus: "检查权限", snapshot, events: [], report: null, state: "running", error: "" }]));
  expect(loadReviewHistory().entries[0]?.state).toBe("interrupted");
  const view = render(<PrReviewPanel api={api} />);
  expect(screen.getByText(/上次评审已中断/)).toBeVisible();
  view.unmount();
  localStorage.setItem(key, "{broken");
  render(<PrReviewPanel api={api} />);
  expect(screen.getByRole("alert")).toHaveTextContent("原数据已保留");
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例/ }));
  fireEvent.click(await screen.findByRole("button", { name: "开始评审" }));
  await screen.findByRole("heading", { name: "P2 超时后请求仍在运行" });
  expect(localStorage.getItem(key)).toBe("{broken");
});

it("updates actions by identity while retaining legitimately repeated actions", () => {
  const event = { runId: crypto.randomUUID(), id: "one", at: new Date().toISOString(), kind: "tool" as const, status: "running" as const, message: "读取变更" };
  const result = mergeReviewEvents([event], [{ ...event, status: "done" }, { ...event, id: "two", status: "done" }]);
  expect(result).toHaveLength(2);
  expect(result[0]!.status).toBe("done");
});

it("keeps failed review requests in history and reports storage exhaustion", async () => {
  const api = createPreviewApi();
  vi.spyOn(api, "runPrReview").mockRejectedValue(new Error("backend detail"));
  const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  try {
    render(<PrReviewPanel api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /#123 示例/ }));
    fireEvent.click(await screen.findByRole("button", { name: "开始评审" }));
    expect(await screen.findByText(/backend detail/)).toBeVisible();
    expect(screen.getByText(/评审历史保存失败/)).toBeVisible();
    expect(screen.getByRole("button", { name: "导出报告" })).toBeEnabled();
  } finally { storage.mockRestore(); }
});


it("keeps the result and follow-up replies in one conversation and persists the full exchange", async () => {
  const api = createPreviewApi();
  const follow = vi.spyOn(api, "followUpPrReview").mockResolvedValue({ answer: "需要把取消信号传给底层请求。" });
  const exporter = vi.spyOn(api, "exportAssistantConversation").mockResolvedValue({ status: "cancelled" });
  const view = render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例/ }));
  fireEvent.click(await screen.findByRole("button", { name: "开始评审" }));
  await screen.findByRole("heading", { name: "P2 超时后请求仍在运行" });
  expect(screen.getByRole("log", { name: "执行记录" }).querySelector('.review-chat-result')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("继续追问"), { target: { value: "怎么修复？" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  expect(await screen.findByText("需要把取消信号传给底层请求。")).toBeVisible();
  expect(follow).toHaveBeenCalledWith(expect.objectContaining({ question: "怎么修复？", snapshot: expect.objectContaining({ sourceCommit: "a".repeat(40) }), report: expect.objectContaining({ summary: expect.stringContaining("预览示例") }), messages: [] }));
  fireEvent.change(screen.getByLabelText("继续追问"), { target: { value: "怎么测试？" } });
  fireEvent.keyDown(screen.getByLabelText("继续追问"), { key: "Enter", isComposing: true });
  expect(follow).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(loadReviewHistory().entries[0]?.turns).toHaveLength(2));
  expect(follow.mock.calls[1]![0].messages).toEqual([{ role: "user", content: "怎么修复？" }, { role: "assistant", content: "需要把取消信号传给底层请求。" }]);
  fireEvent.click(screen.getByLabelText("评审操作"));
  fireEvent.click(screen.getByRole("button", { name: "导出报告" }));
  expect(exporter.mock.calls[0]![0].markdown).toContain("怎么修复？");
  expect(exporter.mock.calls[0]![0].markdown).toContain("需要把取消信号传给底层请求。");
  view.unmount(); render(<PrReviewPanel api={api} />);
  expect(screen.getByText("怎么修复？")).toBeVisible();
  expect(screen.getByText("怎么测试？")).toBeVisible();
});

it("retries failed replies without duplicating the question and stops in-flight replies", async () => {
  const api = createPreviewApi();
  let reject!: (error: Error) => void;
  const follow = vi.spyOn(api, "followUpPrReview").mockRejectedValueOnce(new Error("failed")).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  const cancel = vi.spyOn(api, "cancelPrReview").mockImplementation(async () => reject(new Error("cancelled")));
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例/ }));
  fireEvent.click(await screen.findByRole("button", { name: "开始评审" }));
  await screen.findByRole("heading", { name: "P2 超时后请求仍在运行" });
  fireEvent.change(screen.getByLabelText("继续追问"), { target: { value: "为什么？" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  fireEvent.click(await screen.findByRole("button", { name: "重试回答" }));
  expect(screen.getAllByText("为什么？")).toHaveLength(1);
  expect(screen.getByRole("button", { name: /#123 示例/ })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "停止回答" }));
  expect(await screen.findByText("已停止回答。")).toBeVisible();
  expect(cancel).toHaveBeenCalledWith(follow.mock.calls[1]![0].runId);
  expect(loadReviewHistory().entries[0]?.turns).toHaveLength(1);
});

it("keeps the latest button stable around the scroll boundary and does not scroll while drafting", async () => {
  const api = createPreviewApi();
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例/ }));
  fireEvent.click(await screen.findByRole("button", { name: "开始评审" }));
  await screen.findByRole("heading", { name: "P2 超时后请求仍在运行" });
  const log = screen.getByRole("log", { name: "执行记录" });
  const jump = screen.getByLabelText("滚动到底部");
  Object.defineProperties(log, { scrollHeight: { configurable: true, value: 500 }, clientHeight: { configurable: true, value: 100 } });
  log.scrollTop = 300; fireEvent.scroll(log);
  expect(jump).toBeVisible();
  for (const position of [365, 370, 367, 369]) { log.scrollTop = position; fireEvent.scroll(log); expect(jump).toBeVisible(); }
  log.scrollTop = 390; fireEvent.scroll(log);
  expect(jump).not.toBeVisible();
  for (const position of [365, 370, 367, 369]) { log.scrollTop = position; fireEvent.scroll(log); expect(jump).not.toBeVisible(); }
  fireEvent.change(screen.getByLabelText("继续追问"), { target: { value: "保留滚动位置" } });
  expect(log.scrollTop).toBe(369);
  log.scrollTop = 300; fireEvent.scroll(log);
  fireEvent.click(jump);
  expect(jump).not.toBeVisible();
  expect(log.scrollTop).toBe(500);
});


it("switches PR context together with its conversation and restores drafts without reloading", async () => {
  const api = createPreviewApi();
  const connectionId = "00000000-0000-4000-8000-000000000011";
  const list = await api.listPullRequests({ connectionId, filter: "review-requested", page: 1 });
  const second = { ...list.items[0]!, reference: "sample/app#124", number: "124", title: "第二个 PR" };
  vi.spyOn(api, "listPullRequests").mockResolvedValue({ items: [...list.items, second], nextPage: null });
  const load = vi.spyOn(api, "loadPrReview");
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例/ }));
  fireEvent.click(await screen.findByRole("button", { name: "开始评审" }));
  await screen.findByRole("heading", { name: "P2 超时后请求仍在运行" });
  fireEvent.change(screen.getByLabelText("继续追问"), { target: { value: "保留第一个 PR 的草稿" } });
  fireEvent.click(screen.getByRole("button", { name: /#124/ }));
  await screen.findByRole("button", { name: "开始评审" });
  expect(screen.queryByRole("region", { name: "评审过程" })).toBeNull();
  expect(screen.getByRole("button", { name: /#124/ })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: /#123 示例/ }));
  expect(screen.getByLabelText("继续追问")).toHaveValue("保留第一个 PR 的草稿");
  expect(screen.queryByRole("button", { name: "开始评审" })).toBeNull();
  // Opened, confirmed as the review started, and the other PR opened: coming back reads nothing again.
  expect(load).toHaveBeenCalledTimes(3);
  fireEvent.click(within(screen.getByRole("group", { name: "PR 范围" })).getByRole("button", { name: "我创建的" }));
  await waitFor(() => expect(screen.getByRole("button", { name: /#123 示例/ })).toBeEnabled());
  expect(screen.getByLabelText("继续追问")).toHaveValue("保留第一个 PR 的草稿");
});

it("does not reuse a conversation from a different connection with the same PR reference", async () => {
  const api = createPreviewApi();
  const connections = await api.listPrConnections();
  const secondId = "00000000-0000-4000-8000-000000000012";
  vi.spyOn(api, "listPrConnections").mockResolvedValue([...connections, { ...connections[0]!, id: secondId, label: "另一平台" }]);
  const load = vi.spyOn(api, "loadPrReview");
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例/ }));
  fireEvent.click(await screen.findByRole("button", { name: "开始评审" }));
  await screen.findByRole("heading", { name: "P2 超时后请求仍在运行" });
  fireEvent.change(screen.getByLabelText("代码平台链接"), { target: { value: secondId } });
  const item = await screen.findByRole("button", { name: /#123 示例/ });
  expect(item).toHaveAttribute("aria-pressed", "false");
  load.mockRejectedValueOnce(new Error("暂时无法读取"));
  fireEvent.click(item);
  expect(await screen.findByText("暂时无法读取")).toBeVisible();
  expect(screen.queryByRole("region", { name: "评审过程" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "重试读取 PR" }));
  await screen.findByRole("button", { name: "开始评审" });
  expect(load).toHaveBeenLastCalledWith({ connectionId: secondId, reference: "sample/app#123", updatedAt: "2026-09-21T10:00:00Z" });
});


it("searches and paginates PRs, searches history, and retains metadata in PR details", async () => {
  const api = createPreviewApi();
  const connectionId = "00000000-0000-4000-8000-000000000011";
  const first = (await api.listPullRequests({ connectionId, filter: "review-requested", page: 1 })).items[0]!;
  const list = vi.spyOn(api, "listPullRequests").mockResolvedValueOnce({ items: [first], nextPage: 2 }).mockResolvedValue({ items: [{ ...first, reference: "sample/app#124", number: "124", title: "修复权限边界" }], nextPage: null });
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: "加载更多 PR" }));
  expect(await screen.findByRole("button", { name: /#124/ })).toBeVisible();
  expect(list).toHaveBeenLastCalledWith({ connectionId, filter: "review-requested", page: 2 });
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "超时" } });
  expect(screen.queryByRole("button", { name: /#124/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /#123 示例/ }));
  fireEvent.click(await screen.findByRole("button", { name: "查看 PR 详情" }));
  const details = screen.getByRole("dialog", { name: "PR 详情" });
  expect(details).toHaveTextContent("为请求添加超时保护。");
  expect(details).toHaveTextContent("src/request.ts");
  expect(details).toHaveTextContent("b".repeat(40));
  fireEvent.click(screen.getByRole("button", { name: "关闭PR 详情" }));
  fireEvent.click(screen.getByRole("button", { name: "开始评审" }));
  await screen.findByRole("heading", { name: "P2 超时后请求仍在运行" });
  fireEvent.click(screen.getByRole("button", { name: /^历史评审/ }));
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "没有这个评审" } });
  expect(screen.getByText("没有匹配的评审。")).toBeVisible();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "aaaa" } });
  expect(within(screen.getByRole("list", { name: "历史评审" })).getAllByRole("button")).toHaveLength(1);
});

it("switches models from the composer, keeps focus and supports the actions disclosure", async () => {
  const api = createPreviewApi();
  const run = vi.spyOn(api, "runPrReview");
  const follow = vi.spyOn(api, "followUpPrReview");
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例/ }));
  fireEvent.change(await screen.findByLabelText("评审模型"), { target: { value: "openai-remote" } });
  expect(screen.getByText(/代码、决策摘录、命中的评审规则和 PR 上已有的评论将发送/)).toBeVisible();
  fireEvent.change(screen.getByLabelText("本次关注点（可选）"), { target: { value: "检查异常处理" } });
  fireEvent.click(screen.getByRole("button", { name: "开始评审" }));
  await screen.findByRole("heading", { name: "P2 超时后请求仍在运行" });
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ profileId: "openai-remote", focus: "检查异常处理" }));
  expect(screen.getByText("检查异常处理")).toBeVisible();
  fireEvent.change(screen.getByLabelText("对话模型"), { target: { value: "qwen-local" } });
  fireEvent.change(screen.getByLabelText("继续追问"), { target: { value: "如何修复" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(follow).toHaveBeenCalledWith(expect.objectContaining({ profileId: "qwen-local", focus: "检查异常处理" })));
  await screen.findByText(/可以将取消信号/);
  fireEvent.click(screen.getByLabelText("评审操作"));
  const actions = screen.getByLabelText("评审操作").closest("details")!;
  expect(actions.open).toBe(true);
  fireEvent.keyDown(actions, { key: "Escape" });
  expect(actions.open).toBe(false);
  expect(screen.getByLabelText("评审操作")).toHaveFocus();
  fireEvent.click(screen.getByLabelText("评审操作"));
  fireEvent.click(screen.getByRole("button", { name: "删除评审" }));
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(loadReviewHistory().entries).toHaveLength(1);
});

it("expands cited evidence and keeps source opening and export available", async () => {
  const api = createPreviewApi();
  const report = await api.runPrReview({ snapshotId: crypto.randomUUID(), runId: crypto.randomUUID(), profileId: "qwen-local", focus: "" });
  vi.spyOn(api, "runPrReview").mockResolvedValue({ ...report, findings: report.findings.map(item => ({ ...item, decisionIndexes: [1] })), evidence: [{ index: 1, record: {
    source: "summarize", kind: "historical_decision", id: "DEC-1", title: "取消超时请求", project: "sample", status: "accepted", current: true,
    summary: "超时需要释放资源", appliesWhen: "请求取消", caution: "后台任务另议", tags: [], supersedes: [], supersededBy: [], successors: [], unresolvedSuccessorIds: [],
    sourceRef: { relativePath: "summarize/DEC-1.md", client: null, sessionId: null, excerpt: "超时需要释放资源", excerptStartLine: 1, truncated: false }, matchReason: "超时", warnings: [],
  } }] });
  const open = vi.spyOn(api, "openVaultDocument").mockResolvedValue(undefined);
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例/ }));
  fireEvent.click(await screen.findByRole("button", { name: "开始评审" }));
  fireEvent.click(await screen.findByRole("link", { name: "[1]" }));
  expect(document.getElementById("review-evidence-1")).toHaveAttribute("open");
  expect(document.querySelector(".review-evidence")).toHaveAttribute("open");
  fireEvent.click(screen.getByRole("button", { name: "打开来源笔记" }));
  expect(open).toHaveBeenCalledWith("summarize/DEC-1.md");
});

describe("a record left behind", () => {
  const CONNECTION = "00000000-0000-4000-8000-000000000011";
  const B_ID = "00000000-0000-4000-8000-0000000000b1";
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("takes its open dialogs with it, rather than aiming them at the record shown next", async () => {
    // Review A finishes while the window is away (a notification is posted), then record B is opened.
    const shown: Array<{ title: string; onclick: null | (() => void) }> = [];
    class FakeNotification {
      static permission = "granted";
      onclick: null | (() => void) = null;
      constructor(public title: string) { shown.push(this); }
    }
    vi.stubGlobal("Notification", FakeNotification);
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const api = createPreviewApi();
    const snapshot = await api.loadPrReview({ connectionId: CONNECTION, reference: "sample/app#123" });
    const report = await api.runPrReview({ snapshotId: snapshot.snapshotId, runId: "00000000-0000-4000-8000-000000000002", profileId: "local", focus: "" });
    saveReviewHistory([{
      id: B_ID, kind: "review", at: "2026-09-20T10:00:00.000Z", model: "本机", focus: "", draft: "", turns: [], events: [],
      state: "finished", error: "", published: [], verdicts: [], rechecks: [], connectionId: CONNECTION,
      snapshot: { ...snapshot, reference: "other/repo#7", title: "B 的 PR", sourceCommit: "c".repeat(40), files: [{ path: "src/b.ts", status: "modified" }] },
      report: { ...report, history: [], findings: [{ priority: "P1", title: "B 的问题", body: "B 的正文", path: "src/b.ts", side: "new", line: 3, decisionIndexes: [] }] },
    }]);
    const publishLine = vi.spyOn(api, "publishPrReviewComment");
    render(<PrReviewPanel api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
    const start = await screen.findByRole("button", { name: "开始评审" });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    await screen.findByRole("heading", { name: "P2 超时后请求仍在运行" });
    await waitFor(() => expect(shown).toHaveLength(1));
    hasFocus.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: /历史评审/ }));
    fireEvent.click(screen.getByRole("button", { name: /B 的 PR/ }));
    await screen.findByRole("heading", { name: "P1 B 的问题" });
    fireEvent.click(screen.getByRole("button", { name: "把「B 的问题」转为 PR 评论" }));
    await screen.findByRole("form", { name: "发布评论表单" });

    // The notification about review A is clicked: the comment written for B must not go to A's PR.
    act(() => shown[0]!.onclick!());

    expect(screen.queryByRole("form", { name: "发布评论表单" })).toBeNull();
    expect(publishLine).not.toHaveBeenCalled();
  });

  it("keeps the reviewer's own 不采纳 when a re-evaluation started before it comes back", async () => {
    const api = createPreviewApi();
    const snapshot = await api.loadPrReview({ connectionId: CONNECTION, reference: "sample/app#123" });
    const report = await api.runPrReview({ snapshotId: snapshot.snapshotId, runId: "00000000-0000-4000-8000-000000000002", profileId: "qwen-local", focus: "" });
    saveReviewHistory([{
      id: B_ID, kind: "review", at: "2026-09-20T10:00:00.000Z", model: "本机", focus: "", draft: "",
      turns: [], events: [], state: "finished", error: "", published: [], verdicts: [], rechecks: [], connectionId: CONNECTION,
      snapshot, report: { ...report, history: [] },
    }]);
    let land!: (verdict: PrReviewVerdict) => void;
    vi.spyOn(api, "reevaluatePrReviewFinding").mockReturnValue(new Promise((resolve) => { land = resolve; }));
    render(<PrReviewPanel api={api} />);
    const reevaluate = await screen.findByRole("button", { name: "复评「超时后请求仍在运行」" });
    await waitFor(() => expect(reevaluate).toBeEnabled());
    fireEvent.click(reevaluate);
    fireEvent.click(screen.getByRole("button", { name: "不采纳「超时后请求仍在运行」" }));
    const form = await screen.findByRole("form", { name: "不采纳这条问题" });
    fireEvent.change(within(form).getByLabelText("不采纳的原因"), { target: { value: "有意为之，超时由上层统一处理" } });
    fireEvent.click(within(form).getByRole("button", { name: "不采纳" }));

    await act(async () => { land({ verdict: "keep", reason: "问题仍然成立。", replacement: null }); });

    expect(screen.getByRole("note", { name: "不采纳" })).toHaveTextContent("有意为之，超时由上层统一处理");
    expect(loadReviewHistory().entries[0]!.verdicts.some((verdict) => verdict.by === "reviewer")).toBe(true);
  });

  it("keeps the model the reader picked for a follow-up when the page shows again", async () => {
    const api = createPreviewApi();
    const snapshot = await api.loadPrReview({ connectionId: CONNECTION, reference: "sample/app#123" });
    const report = await api.runPrReview({ snapshotId: snapshot.snapshotId, runId: "00000000-0000-4000-8000-000000000002", profileId: "openai-remote", focus: "" });
    saveReviewHistory([{
      id: B_ID, kind: "review", at: "2026-09-20T10:00:00.000Z", model: "OpenAI · gpt-5", focus: "", draft: "",
      turns: [], events: [], state: "finished", error: "", published: [], verdicts: [], rechecks: [], connectionId: CONNECTION,
      profileId: "openai-remote", snapshot, report: { ...report, history: [] },
    }]);
    // Over IPC every call returns a fresh array, as a re-read on each showing of the page does.
    const providers = await api.listAssistantModels();
    vi.spyOn(api, "listAssistantModels").mockImplementation(async () => structuredClone(providers));
    const view = render(<PrReviewPanel api={api} />);
    const picker = await screen.findByLabelText("对话模型");
    await waitFor(() => expect(picker).toHaveValue("openai-remote"));
    fireEvent.change(picker, { target: { value: "qwen-local" } });

    view.rerender(<PrReviewPanel api={api} hidden />);
    view.rerender(<PrReviewPanel api={api} hidden={false} />);
    await act(async () => { await Promise.resolve(); });

    // Code and the review stay on the device, as the reader chose.
    expect(screen.getByLabelText("对话模型")).toHaveValue("qwen-local");
  });
});

it("keeps a comment the reviewer reworded open against a stray Escape; 取消 still closes it", async () => {
  const onClose = vi.fn();
  const api = {
    getPrActionContext: vi.fn(async () => ({ state: "open", sourceBranch: "feature", sourceCommit: "a".repeat(40), destinationBranch: "main", destinationCommit: "b".repeat(40) })),
    publishPrReviewComment: vi.fn(), publishPrGeneralComment: vi.fn(), loadPrReviewFile: vi.fn(),
  };
  render(<PrReviewCommentDialog api={api as never} snapshot={{ reference: "AI/app#12", sourceCommit: "a".repeat(40), destinationCommit: "b".repeat(40) } as never}
    connectionId="connection-1" draft="模型写的概述。" onClose={onClose} onPublished={vi.fn()} />);
  const dialog = screen.getByRole("dialog", { name: "发布到 PR" });
  // Untouched, Escape closes it.
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.change(within(dialog).getByRole("textbox", { name: "评论内容" }), { target: { value: "我自己重写的措辞。" } });
  // Reworded, the rewording went with a stray Escape.
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  expect(onClose).toHaveBeenCalledTimes(2);
});

// What the page says of a finished record: its summary comment, its coverage line, its export, its refusal.
const r18Finding = { priority: "P2" as const, title: "超时后请求仍在运行", body: "底层请求不会取消。", path: "src/request.ts", side: "new" as const, line: 12, decisionIndexes: [] };
const r18Snapshot = (files: Array<{ path: string; status: string }>, skippedFiles: string[] = []): ReviewHistoryEntry["snapshot"] => ({
  snapshotId: "00000000-0000-4000-8000-000000000001", reference: "sample/app#123", title: "示例：调整请求超时", description: "", project: "sample", sourceCommit: "a".repeat(40), destinationCommit: "b".repeat(40),
  files, ...(skippedFiles.length ? { skippedFiles } : {}), fileBatches: Object.fromEntries(files.filter(file => !skippedFiles.includes(file.path)).map(file => [file.path, 1])), warnings: [],
});
const r18Report = (overrides: Partial<NonNullable<ReviewHistoryEntry["report"]>> = {}): NonNullable<ReviewHistoryEntry["report"]> => ({
  status: "completed", summary: "一处问题。", findings: [r18Finding], evidence: [], readFiles: ["src/request.ts"], unreadFiles: [], reviewedFiles: ["src/request.ts"], unreviewedFiles: [], warnings: [], steps: 2, history: [], groups: 1, ...overrides,
});
const r18Entry = (overrides: Partial<ReviewHistoryEntry> & Pick<ReviewHistoryEntry, "snapshot" | "report">): ReviewHistoryEntry => ({
  id: "00000000-0000-4000-8000-0000000000c1", kind: "review", at: "2026-09-30T10:00:00.000Z", model: "本机", focus: "", draft: "", turns: [], events: [],
  state: "finished", error: "", published: [], verdicts: [], rechecks: [], connectionId: "00000000-0000-4000-8000-000000000011", profileId: "local", ...overrides,
});
const copiedMarkdown = async (): Promise<string> => {
  const writeText = vi.fn(async (_text: string) => undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  fireEvent.click(screen.getByLabelText("评审操作"));
  fireEvent.click(screen.getByRole("button", { name: "复制为 Markdown" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
  return writeText.mock.calls[0]![0];
};

it("says in the summary comment that the review was stopped, and how many files it never reviewed", async () => {
  const snapshot = r18Snapshot([{ path: "src/request.ts", status: "modified" }, { path: "src/retry.ts", status: "modified" }, { path: "src/queue.ts", status: "modified" }]);
  localStorage.setItem("decision.pr-review.history.v1", JSON.stringify([r18Entry({ snapshot, report: r18Report({ status: "cancelled", summary: "分 3 组评审了 1/3 个文件，形成 1 条问题。尚未完成的内容与原因见下方。",
    unreadFiles: ["src/retry.ts", "src/queue.ts"], unreviewedFiles: ["src/retry.ts", "src/queue.ts"], warnings: ["评审已取消或达到时限。"], groups: 3 }) })]));
  render(<PrReviewPanel api={createPreviewApi()} />);
  expect(await screen.findByRole("heading", { name: "已停止" })).toBeVisible();
  fireEvent.click(screen.getByLabelText("评审操作"));
  fireEvent.click(screen.getByRole("button", { name: "发布评审摘要到 PR" }));
  const draft = within(await screen.findByRole("dialog", { name: "发布到 PR" })).getByLabelText("评论内容") as HTMLTextAreaElement;
  // Read on the PR as a finished review's word, the stop and the two files nowhere in it.
  expect(draft.value).toBe(`**AI 评审**：1 个问题（P2 ×1）（提交 \`${"a".repeat(12)}\`，已停止，2 个文件未评审）\n- **P2** 超时后请求仍在运行（\`src/request.ts:12\`）`);
});

it("counts the files the review covers on its result line, as the summary and the export do, lockfiles aside", async () => {
  const snapshot = r18Snapshot([{ path: "package-lock.json", status: "modified" }, { path: "src/request.ts", status: "modified" }, { path: "src/retry.ts", status: "modified" }], ["package-lock.json"]);
  localStorage.setItem("decision.pr-review.history.v1", JSON.stringify([r18Entry({ snapshot, report: r18Report({ summary: "分 1 组评审了 2/2 个文件（另有 1 个锁定或生成文件未送模型），形成 0 条问题。",
    findings: [], readFiles: ["src/request.ts", "src/retry.ts"], reviewedFiles: ["src/request.ts", "src/retry.ts"] }) })]));
  render(<PrReviewPanel api={createPreviewApi()} />);
  expect(await screen.findByRole("heading", { name: "评审完成" })).toBeVisible();
  // It read 2/3 under a summary saying 2/2, with no file listed as unreviewed.
  expect(screen.getByText(/完成评审 2\/2 个文件/u)).toBeVisible();
  expect(screen.queryByText(/未完成评审的文件/u)).toBeNull();
});

it("exports a finding posted by another review of the same commits as published", async () => {
  const snapshot = r18Snapshot([{ path: "src/request.ts", status: "modified" }]);
  localStorage.setItem("decision.pr-review.history.v1", JSON.stringify([
    r18Entry({ id: "00000000-0000-4000-8000-0000000000c2", at: "2026-09-30T11:00:00.000Z", snapshot, report: r18Report() }),
    r18Entry({ id: "00000000-0000-4000-8000-0000000000c1", at: "2026-09-30T10:00:00.000Z", snapshot, report: r18Report(), published: [{ finding: 0, at: "2026-09-30T10:05:00.000Z" }] }),
  ]));
  render(<PrReviewPanel api={createPreviewApi()} />);
  // The page would not offer it for posting again; the export said nothing of it.
  expect(await screen.findByText("同一提交的另一次评审已发布")).toBeVisible();
  expect(await copiedMarkdown()).toContain("同一提交的另一次评审已发布为 PR 评论");
});

it.each(["PR 快照已失效，请重新加载。", "已有评审正在运行。"])("shows the main process's own reason for a refused review: %s", async (reason) => {
  const api = createPreviewApi();
  vi.spyOn(api, "runPrReview").mockRejectedValue(new Error(reason));
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  const start = await screen.findByRole("button", { name: "开始评审" });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  // Told to check the model and the platform link, when the next step was to reload, or to wait.
  expect(await screen.findByRole("alert")).toHaveTextContent(reason);
});

it("keeps the 需要修改 dialog and its comment when the background check of a cached PR finds a new commit", async () => {
  const api = createPreviewApi();
  const cached = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  vi.spyOn(api, "peekPrReview").mockResolvedValue(cached);
  let confirm: (value: typeof cached) => void = () => undefined;
  vi.spyOn(api, "loadPrReview").mockReturnValue(new Promise((resolve) => { confirm = resolve; }));
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  const needWork = await screen.findByRole("button", { name: "需要修改" });
  await waitFor(() => expect(needWork).toBeEnabled());
  fireEvent.click(needWork);
  fireEvent.change(await screen.findByLabelText("评审意见"), { target: { value: "超时处理需要先取消底层请求，再重试。" } });

  await act(async () => confirm({ ...cached, snapshotId: "00000000-0000-4000-8000-000000000099", sourceCommit: "c".repeat(40) }));

  // Mounted afresh for the newer snapshot, the dialog closed on its own and the comment typed into it was gone.
  expect(screen.getByRole("dialog", { name: /需要修改/u })).toBeVisible();
  expect(screen.getByDisplayValue("超时处理需要先取消底层请求，再重试。")).toBeVisible();
});

it("does not carry the 需要修改 dialog to the same PR reference on another link", async () => {
  const api = createPreviewApi();
  const connections = await api.listPrConnections();
  const secondId = "00000000-0000-4000-8000-000000000012";
  vi.spyOn(api, "listPrConnections").mockResolvedValue([...connections, { ...connections[0]!, id: secondId, label: "镜像平台" }]);
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  const needWork = await screen.findByRole("button", { name: "需要修改" });
  await waitFor(() => expect(needWork).toBeEnabled());
  fireEvent.click(needWork);
  fireEvent.change(await screen.findByLabelText("评审意见"), { target: { value: "只给第一个平台的意见。" } });

  // The same `sample/app#123` on a mirror: keyed by the reference alone, the dialog and the comment went with it.
  fireEvent.change(screen.getByLabelText("代码平台链接"), { target: { value: secondId } });
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: /需要修改/u })).toBeNull());
  expect(screen.queryByDisplayValue("只给第一个平台的意见。")).toBeNull();
});

it("drops a list's failure once the link it was about is removed", async () => {
  const api = createPreviewApi();
  vi.spyOn(api, "listPullRequests").mockRejectedValue(new Error("令牌已失效"));
  const view = render(<PrReviewPanel api={api} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("令牌已失效");

  // The link removed on 链接, the page, kept mounted out of sight, is shown again.
  view.rerender(<PrReviewPanel api={api} hidden />);
  vi.spyOn(api, "listPrConnections").mockResolvedValue([]);
  view.rerender(<PrReviewPanel api={api} hidden={false} />);
  await waitFor(() => expect(screen.getByRole("combobox", { name: "代码平台链接" })).toBeDisabled());
  // Its failure stood, with its 检查链接, over a page with no link at all. It goes in the effect after the one that
  // empties the picker: asked at once, the test read the page a render early, now and then.
  await waitFor(() => expect(screen.queryByText(/令牌已失效/u)).toBeNull());
});

const r19Records = (): [string, string] => {
  const files = [{ path: "src/request.ts", status: "modified" }];
  const first = "00000000-0000-4000-8000-0000000000a1", second = "00000000-0000-4000-8000-0000000000b1";
  saveReviewHistory([
    r18Entry({ id: first, snapshot: { ...r18Snapshot(files), reference: "sample/app#1", title: "PR 甲" }, report: r18Report() }),
    r18Entry({ id: second, snapshot: { ...r18Snapshot(files), reference: "sample/app#2", title: "PR 乙" }, report: r18Report() }),
  ]);
  return [first, second];
};

it("says a re-evaluation's failure on its own record, not on the one open when it lands", async () => {
  const api = createPreviewApi();
  const [first, second] = r19Records();
  let fail: (cause: Error) => void = () => undefined;
  vi.spyOn(api, "reevaluatePrReviewFinding").mockReturnValue(new Promise((_resolve, reject) => { fail = reject; }));
  const view = render(<PrReviewPanel api={api} />);
  expect(await screen.findByRole("heading", { name: "PR 甲" })).toBeVisible();
  const reevaluate = await screen.findByRole("button", { name: `复评「${r18Finding.title}」` });
  await waitFor(() => expect(reevaluate).toBeEnabled());
  fireEvent.click(reevaluate);

  // ⌘K to the other record while it runs; it fails there.
  view.rerender(<PrReviewPanel api={api} openRun={{ id: second }} />);
  expect(await screen.findByRole("heading", { name: "PR 乙" })).toBeVisible();
  await act(async () => { fail(new Error("模型超时")); });
  // Said on the page, it showed on PR 乙, of which nothing had been asked.
  expect(screen.queryByText(/复评未完成/u)).toBeNull();

  view.rerender(<PrReviewPanel api={api} openRun={{ id: first }} />);
  expect(await screen.findByRole("heading", { name: "PR 甲" })).toBeVisible();
  expect(screen.getByText(/复评未完成/u)).toBeVisible();
});

it("closes the PR 详情 opened on one record when another record is opened", async () => {
  const api = createPreviewApi();
  const [, second] = r19Records();
  const view = render(<PrReviewPanel api={api} />);
  expect(await screen.findByRole("heading", { name: "PR 甲" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "查看 PR 详情" }));
  expect(within(await screen.findByRole("dialog", { name: "PR 详情" })).getByRole("heading", { name: "PR 甲" })).toBeVisible();

  view.rerender(<PrReviewPanel api={api} openRun={{ id: second }} />);
  expect(await screen.findByRole("heading", { name: "PR 乙" })).toBeVisible();
  // Kept open, the same dialog went on to show PR 乙's files where the reader had opened PR 甲's.
  expect(screen.queryByRole("dialog", { name: "PR 详情" })).toBeNull();
});
