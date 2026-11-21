// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prReviewRunSchema, type PrReviewVerdict } from "@cognelis/decision-protocol";
import { createPreviewApi } from "../src/renderer/preview-api.js";
import { dismissedIn, publishedIn, loadReviewHistory, mergeReviewEvents, saveReviewHistory, type ReviewHistoryEntry } from "../src/renderer/components/pages/pr-review/review-history.js";
import { PrReviewPanel, reviewMarkdown } from "../src/renderer/components/pages/pr-review/PrReviewPanel.js";
import { PrDiscussionDialog, commentDraft } from "../src/renderer/components/pages/pr-review/PrDiscussionDialog.js";
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

it("lays out a finding's Markdown, as its copy and its comment draft take it", async () => {
  const api = createPreviewApi();
  const original = api.runPrReview.bind(api);
  vi.spyOn(api, "runPrReview").mockImplementation(async (request) => {
    const result = await original(request);
    return { ...result, findings: [{ ...result.findings[0]!, body: "**影响**：重复提交。\n\n```ts\nclearTimeout(timer);\n```" }] };
  });
  await runSampleReview(api);
  const finding = screen.getByRole("heading", { name: "P2 超时后请求仍在运行" }).closest("article")!;
  // Shown as written, the marks read as text and a fence took six lines of the card.
  expect(within(finding).getByText("影响").tagName).toBe("STRONG");
  expect(within(finding).getByText("clearTimeout(timer);").closest("pre")).not.toBeNull();
  expect(finding.textContent).not.toContain("**");
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
  // The code is over the comment opening the thread, as on the platform; the reply under it says it is one.
  expect(await within(discussion).findAllByText(/new AbortController/u)).toHaveLength(1);
  expect(within(discussion).getByText("回复")).toBeVisible();
  fireEvent.click(await within(discussion).findByRole("button", { name: "把 Example 的评论记为决策" }));
  // One dialog at a time: the discussion comes back once the record is saved.
  const form = await screen.findByRole("dialog", { name: "主动记录" });
  expect(screen.queryByRole("dialog", { name: "PR 讨论" })).toBeNull();
  expect(within(form).getByLabelText("标题")).toHaveValue("src/request.ts:12 怎么处理？");
  expect(within(form).getByLabelText("来源")).toHaveValue("PR 评论 · 示例 GitHub");
  expect(within(form).getByRole("button", { name: "偏好" })).toBeDisabled();
  // What it was said about is in front of the reader: the code it is on and the reply it got, theirs to add to.
  const context = within(form).getByLabelText<HTMLTextAreaElement>("当时上下文");
  expect(context.value).toContain("代码（评论当时的改动，diff 片段）：\n@@ -9,2 +9,4 @@\n export async function request(");
  expect(context.value).toMatch(/讨论串：\nExample · .+（本条）\n\nMaintainer · .+：\n同意，调用方传入的超时参数这次一起删掉。/u);
  fireEvent.change(context, { target: { value: `${context.value}\n补充：5 秒是和网关约定的。` } });
  fireEvent.click(within(form).getByRole("button", { name: /保存记录/ }));
  await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
    kind: "decision", sourceKind: "pr_comment", sourceUrl: "https://github.com/sample/app/pull/123#discussion_r2",
    project: "sample", context: expect.stringMatching(/^PR：示例：调整请求超时（sample\/app#123）[\s\S]*补充：5 秒是和网关约定的。$/u),
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

it("reads a PR's comments for decisions only when asked, and forgets one the reader turns down", async () => {
  const api = createPreviewApi();
  const recognize = vi.spyOn(api, "recognizePrDiscussion");
  const dismiss = vi.spyOn(api, "dismissPrCommentCandidate");
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  fireEvent.click(await screen.findByRole("button", { name: "PR 讨论" }));
  const discussion = await screen.findByRole("dialog", { name: "PR 讨论" });
  expect(await within(discussion).findByText("今天还能调用 20 次")).toBeVisible();
  // Opening the discussion spends nothing: the model reads only on the reader's word.
  expect(recognize).not.toHaveBeenCalled();
  expect(within(discussion).queryByText("像是决定")).toBeNull();
  fireEvent.click(within(discussion).getByRole("button", { name: "找出像是决定的评论（2 条未识别）" }));
  expect(await within(discussion).findByText("像是决定")).toBeVisible();
  expect(recognize).toHaveBeenCalledWith({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123", title: "示例：调整请求超时" });
  expect(within(discussion).getByText("评论都识别过了")).toBeVisible();
  fireEvent.click(within(discussion).getByRole("button", { name: "只看像是决定的（1）" }));
  expect(within(discussion).queryByText("整体思路没问题。")).toBeNull();
  fireEvent.click(within(discussion).getByRole("button", { name: "Maintainer 的评论不是决定" }));
  await waitFor(() => expect(within(discussion).queryByText("像是决定")).toBeNull());
  expect(dismiss).toHaveBeenCalledWith("https://github.com/sample/app/pull/123#discussion_r3");
});

it("opens a PR's discussion at the comments read as decisions when the home page asks", async () => {
  const api = createPreviewApi();
  await api.recognizePrDiscussion({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123", title: "示例：调整请求超时" });
  render(<PrReviewPanel api={api} openDiscussion={{ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123", title: "示例：调整请求超时" }} />);
  const discussion = await screen.findByRole("dialog", { name: "PR 讨论" });
  expect(await within(discussion).findByText("像是决定")).toBeVisible();
  expect(within(discussion).queryByText("整体思路没问题。")).toBeNull();
  fireEvent.click(within(discussion).getByRole("button", { name: "显示全部评论" }));
  expect(within(discussion).getByText("整体思路没问题。")).toBeVisible();
});

it("drafts a comment the model read as a decision under the question it read there", () => {
  const draft = commentDraft(
    { id: "c1", url: "https://github.com/sample/app/pull/123#discussion_r1", author: "Example", path: "src/request.ts", line: 12, body: "超时统一由上层处理。", createdAt: "2026-10-01T02:00:00Z", replyTo: null, code: null, decisionId: null,
      candidate: { question: "超时由哪一层处理？", choice: "统一由上层处理", quote: "超时统一由上层处理" } },
    { title: "示例", reference: "sample/app#123", project: "app" },
    "示例 GitHub",
  );
  // The comment's own words stay the choice; only the question is the model's, for the reader to rewrite.
  expect([draft.title, draft.content]).toEqual(["超时由哪一层处理？", "超时统一由上层处理。"]);
});

it("dates a recorded PR comment on the day it shows, not the day in UTC", () => {
  // 04:30 on 1 October here: in UTC, east of Greenwich, still 30 September.
  const createdAt = new Date(2026, 9, 1, 4, 30).toISOString();
  const draft = commentDraft(
    { id: "c1", url: "https://github.com/sample/app/pull/123#discussion_r1", author: "Example", path: "src/request.ts", line: 12, body: "超时统一由上层处理。", createdAt, replyTo: null, code: null, decisionId: null, candidate: null },
    { title: "示例", reference: "sample/app#123", project: "app" },
    "示例 GitHub",
  );
  expect(draft.context).toContain("评论：Example · 2026-10-01");
  // A conversation comment is on no line: the PR's title asks, and no place is given.
  const general = commentDraft(
    { id: "issuecomment-1", url: "https://github.com/sample/app/pull/123#issuecomment-1", author: "Reviewer", path: null, line: null, body: "整体思路没问题。", createdAt, replyTo: null, code: null, decisionId: null, candidate: null },
    { title: "示例", reference: "sample/app#123", project: "app" },
    "示例 GitHub",
  );
  expect([general.title, general.context?.includes("位置"), general.source?.url]).toEqual(["「示例」怎么处理？", false, "https://github.com/sample/app/pull/123#issuecomment-1"]);
});

it("gives a recorded PR comment the code it is on and the thread it was said in, oldest first", () => {
  const pr = { title: "示例", reference: "sample/app#123", project: "app" };
  const at = (hour: number) => new Date(2026, 9, 1, hour).toISOString();
  const asked = { id: "1", url: "https://github.com/sample/app/pull/123#discussion_r1", author: "Example", path: "src/request.ts", line: 12, body: "超时放在哪一层？\n调用方，还是请求层？", createdAt: at(9), replyTo: null, code: { side: "new" as const, from: 9, text: "a\nb\nc\nd" }, decisionId: null, candidate: null };
  const answer = { ...asked, id: "2", url: "https://github.com/sample/app/pull/123#discussion_r2", author: "Maintainer", body: "统一放在请求层。", createdAt: at(10), replyTo: "1" };
  const elsewhere = { ...asked, id: "3", url: "https://github.com/sample/app/pull/123#discussion_r3", body: "另一处。", createdAt: at(11), code: null };
  expect(commentDraft(answer, pr, "示例 GitHub", [elsewhere, answer, asked]).context).toBe([
    "PR：示例（sample/app#123）", "位置：src/request.ts:12", "评论：Maintainer · 2026-10-01",
    "代码（PR 当前版本第 9–12 行）：", "a", "b", "c", "d",
    "讨论串：", "Example · 2026-10-01：", "超时放在哪一层？", "调用方，还是请求层？", "", "Maintainer · 2026-10-01（本条）",
  ].join("\n"));
  // A removed line is the old version's; alone in its thread, no thread is claimed.
  expect(commentDraft({ ...asked, code: { side: "old", from: 12, text: "x" } }, pr, "示例 GitHub", [asked]).context).toBe(
    "PR：示例（sample/app#123）\n位置：src/request.ts:12\n评论：Example · 2026-10-01\n代码（改动前版本第 12 行）：\nx");
});

it("keeps a thread's comments as written, and past what a record holds keeps the one opening it and drops those farthest from the comment first, saying so", () => {
  const pr = { title: "示例", reference: "sample/app#123", project: "app" };
  const said = (n: number, body: string) => ({ id: String(n), url: `https://github.com/sample/app/pull/123#discussion_r${n}`, author: `U${String(n).padStart(2, "0")}`, path: "src/a.ts", line: 3, body,
    createdAt: new Date(2026, 9, 1, 0, n).toISOString(), replyTo: n === 1 ? null : "1", code: null, decisionId: null, candidate: null });
  // A suggestion squashed onto one line read as prose, its fences in the middle of it.
  const suggestion = "改成这样：\n```suggestion\nconst timeout = 5_000;\n```\n其余不变。";
  const short = [said(1, "超时写死了？"), said(2, suggestion), said(3, "可以。")];
  expect(commentDraft(short[2]!, pr, "示例 GitHub", short).context).toContain(
    `讨论串：\nU01 · 2026-10-01：\n超时写死了？\n\nU02 · 2026-10-01：\n${suggestion}\n\nU03 · 2026-10-01（本条）`);

  // Twelve comments of 1,000 characters, the seventh recorded: the first, the question it answers, stays as it does;
  // then those next to it, the nearest that no longer fits whole keeping its start, and those left out are counted. A
  // record holds 8,000 characters: what is put in for the reader leaves them 2,000 to add.
  const long = Array.from({ length: 12 }, (_, index) => said(index + 1, `${String(index + 1).padStart(2, "0")}${"字".repeat(998)}`));
  const context = commentDraft(long[6]!, pr, "示例 GitHub", long).context!;
  expect(context.length).toBeLessThanOrEqual(6_000);
  expect(context).toContain(`讨论串：\nU01 · 2026-10-01：\n01${"字".repeat(998)}\n\n（上下文已满，其间的 2 条评论未列出）\n\nU04 · 2026-10-01：\n04字`);
  expect(context).toMatch(/\n\nU04 · 2026-10-01：\n04字{200,997}…（这条评论过长，后文省略）\n\nU05 · 2026-10-01：\n05字{998}\n\n/u);
  expect(context).toContain(`U06 · 2026-10-01：\n06${"字".repeat(998)}\n\nU07 · 2026-10-01（本条）\n\nU08 · 2026-10-01：\n08`);
  expect(context).toMatch(/\n\nU09 · 2026-10-01：\n09字{998}\n\n（上下文已满，之后的 3 条评论未列出）$/u);
  expect(["U02", "U03", "U10", "U11", "U12"].filter((author) => context.includes(`${author} ·`))).toEqual([]);
});

it("closes a code block a cut leaves open, so a record copied as Markdown does not read as code from there on", () => {
  const pr = { title: "示例", reference: "sample/app#123", project: "app" };
  const said = (n: number, body: string) => ({ id: String(n), url: `https://github.com/sample/app/pull/123#discussion_r${n}`, author: `U0${n}`, path: "README.md", line: 3, body,
    createdAt: new Date(2026, 9, 1, 0, n).toISOString(), replyTo: n === 1 ? null : "1", code: null, decisionId: null, candidate: null });
  const fences = (text: string) => text.split("\n").filter((line) => /^ {0,3}(`{3,}|~{3,})/u.test(line));
  // A suggestion longer than the record has room for, cut inside its block.
  const thread = [said(1, "超时写死了？"), said(2, `改成这样：\n\`\`\`suggestion\n${"const timeout = 5_000;\n".repeat(400)}\`\`\`\n其余不变。`), said(3, "可以。")];
  const context = commentDraft(thread[2]!, pr, "示例 GitHub", thread).context!;
  expect(fences(context)).toEqual(["```suggestion", "```"]);
  expect(context).toMatch(/\n```\n…（这条评论过长，后文省略）\n\nU03 · 2026-10-01（本条）$/u);
  // So is the code, cut from a file in the middle of one.
  const readme = commentDraft({ ...thread[0]!, code: { kind: "file", side: "new", from: 1, text: "# 用法\n```bash\nnpm test" } }, pr, "示例 GitHub").context!;
  expect(readme).toBe("PR：示例（sample/app#123）\n位置：README.md:3\n评论：U01 · 2026-10-01\n代码（PR 当前版本第 1–3 行）：\n# 用法\n```bash\nnpm test\n```");
  // A line of inline code that starts with three backticks opens no block (CommonMark): closed as if it did, the fence
  // added opened one, and what followed read as code.
  const inline = [said(1, "怎么装？"), said(2, `先跑\n\`\`\`npm install\`\`\`\n${"再看看日志。\n".repeat(1_500)}`), said(3, "可以。")];
  expect(fences(commentDraft(inline[2]!, pr, "示例 GitHub", inline).context!)).toEqual(["```npm install```"]);
});

it("says where a recorded PR comment's code comes from, and shows a diff's removed and added lines apart", async () => {
  const pr = { title: "示例", reference: "sample/app#123", project: "app" };
  const comment = { id: "1", url: "https://github.com/sample/app/pull/123#discussion_r1", author: "Example", path: "src/request.ts", line: 11, body: "为什么改成大写？",
    createdAt: new Date(2026, 9, 1, 9).toISOString(), replyTo: null, code: { kind: "hunk" as const, side: "new" as const, from: 10, text: "@@ -10,2 +10,3 @@\n a\n-b\n+B\n+C" }, decisionId: null, candidate: null };
  // The change as the reviewer saw it, removed lines too; or the file as the PR has it now, by its lines.
  expect(commentDraft(comment, pr, "示例 GitHub").context).toBe(
    "PR：示例（sample/app#123）\n位置：src/request.ts:11\n评论：Example · 2026-10-01\n代码（评论当时的改动，diff 片段）：\n@@ -10,2 +10,3 @@\n a\n-b\n+B\n+C");
  expect(commentDraft({ ...comment, code: { kind: "file", side: "new", from: 6, text: "x\ny\nz" } }, pr, "示例 GitHub").context).toContain("代码（PR 当前版本第 6–8 行）：\nx\ny\nz");
  render(<PrDiscussionDialog api={{ listPrDiscussion: async () => ({ more: false, recognition: null, comments: [comment] }), recognizePrDiscussion: vi.fn(), dismissPrCommentCandidate: vi.fn(), openPrLink: vi.fn() }}
    connectionId="00000000-0000-4000-8000-000000000011" pr={pr} onRecord={vi.fn()} onClose={vi.fn()} />);
  // Its caption says where it comes from (jsdom does not name a figure by it, as a browser does).
  const code = (await screen.findByText("评论当时的改动，diff 片段")).closest("figure")!;
  expect(within(code).getByText("-b")).toHaveAttribute("data-diff", "removed");
  expect(within(code).getByText("+B")).toHaveAttribute("data-diff", "added");
  expect(within(code).getByText("@@ -10,2 +10,3 @@")).toHaveAttribute("data-diff", "hunk");
});

it("reads a PR's discussion again after a failed read, and lays out each comment's Markdown", async () => {
  const comment = { id: "1", url: "https://github.com/sample/app/pull/123#discussion_r1", author: "Example", path: "src/request.ts", line: 11, body: "可以：\n\n- 去掉 `retry`\n- 超时交给上层",
    createdAt: new Date(2026, 9, 1, 9).toISOString(), replyTo: null, code: null, decisionId: null, candidate: null };
  const list = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ more: false, recognition: null, comments: [comment] });
  render(<PrDiscussionDialog api={{ listPrDiscussion: list, recognizePrDiscussion: vi.fn(), dismissPrCommentCandidate: vi.fn(), openPrLink: vi.fn() }}
    connectionId="00000000-0000-4000-8000-000000000011" pr={{ title: "示例", reference: "sample/app#123" }} onRecord={vi.fn()} onClose={vi.fn()} />);
  // Said where the comments would be, with the way to read them again, not as a dead end in ink.
  expect(await screen.findByRole("alert")).toHaveTextContent("PR 讨论读取失败");
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect((await screen.findByText("retry")).tagName).toBe("CODE");
  expect(screen.getByText("超时交给上层").tagName).toBe("LI");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(list).toHaveBeenCalledTimes(2);
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
  // 发布评论 sits in the dialog's footer, outside the form it submits.
  const submit = within(form.closest<HTMLElement>('[role="dialog"]')!).getByRole("button", { name: "发布评论" });
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
  fireEvent.click(within(form.closest<HTMLElement>('[role="dialog"]')!).getByRole("button", { name: "取消" }));
  expect(screen.queryByText("已发布为 PR 评论")).toBeNull();
  expect(screen.getByRole("button", { name: "把「超时后请求仍在运行」转为 PR 评论" })).toBeEnabled();
});

const runSampleReview = async (api: ReturnType<typeof createPreviewApi>) => {
  render(<PrReviewPanel api={api} />);
  // The first test a worker runs renders the page cold: past a second, at times, before the list is there.
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }, { timeout: 5_000 }));
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
    const record = { source: "decisions", id: "DEC-7", title: "请求超时必须释放资源", kind: "summarized_decision", current: true, summary: "超时后取消底层请求。", appliesWhen: "", caution: "", warnings: [], lifecycleState: "active", sourceRef: { relativePath: "decisions/DEC-7.md" } };
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
    const record = { source: "decisions", id: "DEC-7", title: "请求超时必须释放资源", kind: "summarized_decision", current: false, summary: "超时后取消底层请求。", appliesWhen: "", caution: "", warnings: [], lifecycleState: "uncertain", sourceRef: { relativePath: "decisions/DEC-7.md" } };
    return { ...report, evidence: [{ index: 1, record: record as never }] };
  });
  await runSampleReview(api);
  // Said on the card before it is opened: what kind of record, and that whether it still stands is to be checked.
  const evidence = within(document.getElementById("review-evidence-1")!);
  expect(evidence.getByText(/· 历史选择$/u)).toBeInTheDocument();
  expect(evidence.getByText(/^有效状态待核对 · /u)).toBeInTheDocument();
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
  fireEvent.click(screen.getByRole("button", { name: /src\/request\.ts:12\s*旧版本/ }));
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
  fireEvent.change(within(form).getByLabelText(/^不采纳的原因/u), { target: { value: "有意为之：超时由上层统一取消。" } });
  fireEvent.click(within(form.closest<HTMLElement>('[role="dialog"]')!).getByRole("button", { name: "不采纳" }));
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
  expect(within(form).getByLabelText(/^不采纳的原因/u)).toHaveValue("上层统一取消。");
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
  fireEvent.click(within(await screen.findByRole("dialog", { name: "不采纳这条问题" })).getByRole("button", { name: "不采纳" }));
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

it("keeps the candidates the verification left out under the findings, with why, and those it could not judge apart", async () => {
  const api = createPreviewApi();
  await runSampleReview(api);
  const filtered = screen.getByText("核验未通过的候选问题 · 1").closest("details")!;
  expect(filtered).not.toHaveAttribute("open");
  fireEvent.click(screen.getByText("核验未通过的候选问题 · 1"));
  expect(filtered).toHaveTextContent("超时时间写死");
  expect(filtered).toHaveTextContent("src/request.ts:11");
  expect(filtered).toHaveTextContent("核验找到了具体反证");
  expect(filtered).not.toHaveTextContent("置信度");
  // Neither confirmed nor refuted: with what is missing, and not one to post.
  const waiting = screen.getByText("待核实的候选问题 · 1").closest("details")!;
  fireEvent.click(screen.getByText("待核实的候选问题 · 1"));
  expect(waiting).toHaveTextContent("缺少：调用 request() 的业务代码与服务端是否去重。");
  // Only the confirmed finding is offered to post: neither section has a button at all.
  expect(screen.getByRole("button", { name: "把「超时后请求仍在运行」转为 PR 评论" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "把「重试时重复提交」转为 PR 评论" })).toBeNull();
  expect(within(waiting).queryAllByRole("button")).toEqual([]);
  const unplaced = screen.getByText("没能定位到变更行的候选问题 · 1").closest("details")!;
  fireEvent.click(screen.getByText("没能定位到变更行的候选问题 · 1"));
  expect(unplaced).toHaveTextContent("src/client.ts:40");
  expect(screen.queryByRole("button", { name: "把「调用方没有处理超时错误」转为 PR 评论" })).toBeNull();
  expect(within(unplaced).queryAllByRole("button")).toEqual([]);
  // One problem stands; neither the one left out nor the one waiting is counted with it.
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

it("marks a PR whose comments grew after its overview though its update time stayed, not for one posted from here", async () => {
  const api = createPreviewApi();
  const [item] = (await api.listPullRequests({ connectionId: "00000000-0000-4000-8000-000000000011", filter: "review-requested", page: 1 })).items;
  // As Bitbucket lists it: a new comment moves the count and leaves the update time where it was.
  const list = vi.spyOn(api, "listPullRequests").mockResolvedValue({ items: [{ ...item!, comments: 2 }], nextPage: null });
  const load = vi.spyOn(api, "loadPrReview");
  vi.spyOn(api, "followUpPrReview").mockResolvedValue({ answer: "概览" });
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  // The snapshot is checked against the count too, so its comments are read again once it moves.
  await waitFor(() => expect(load).toHaveBeenCalledWith({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123", updatedAt: item!.updatedAt, commentCount: 2 }));
  // A comment comes in after the list on screen was read: the overview counts from the platform as it starts.
  list.mockResolvedValue({ items: [{ ...item!, comments: 3 }], nextPage: null });
  fireEvent.click(await screen.findByRole("radio", { name: /PR 概览/ }));
  const run = screen.getByRole("button", { name: "生成 PR 概览" });
  await waitFor(() => expect(run).toBeEnabled());
  fireEvent.click(run);
  fireEvent.click(await screen.findByRole("button", { name: "把这条回答发布到 PR" }));
  const post = within(await screen.findByRole("dialog", { name: "发布到 PR" })).getByRole("button", { name: "发布评论" });
  await waitFor(() => expect(post).toBeEnabled());
  fireEvent.click(post);
  expect(await screen.findByText("已发布到 PR")).toBeVisible();
  const refresh = async (comments: number) => {
    const reads = list.mock.calls.length;
    list.mockResolvedValue({ items: [{ ...item!, comments }], nextPage: null });
    fireEvent.click(screen.getByRole("button", { name: "刷新 PR 列表" }));
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(reads));
    await waitFor(() => expect(screen.queryByText("正在读取 PR 列表…")).toBeNull());
  };
  // The one comment more is the overview just posted.
  await refresh(4);
  expect(screen.getByRole("button", { name: /#123 示例：调整请求超时/ })).not.toHaveTextContent("之后有更新");
  await refresh(5);
  expect(screen.getByRole("button", { name: /#123 示例：调整请求超时/ })).toHaveTextContent("PR 概览之后有更新");
  expect(await screen.findByText(/这份记录之后，PR 又有新提交或新评论。/u)).toBeVisible();
});

it("takes a comment posted from an older record of a PR as no news to its newest record either", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  const [item] = (await api.listPullRequests({ connectionId: "00000000-0000-4000-8000-000000000011", filter: "review-requested", page: 1 })).items;
  // An overview and, later, suggestions on the same commits, both made at two comments.
  const record = (id: string, at: string, question: string): ReviewHistoryEntry => ({ id, kind: "chat", at, model: "本机", focus: "", draft: "", events: [], state: "finished", error: "", published: [], verdicts: [], rechecks: [],
    connectionId: "00000000-0000-4000-8000-000000000011", report: null, snapshot, listedComments: 2, turns: [{ id: crypto.randomUUID(), at, model: "本机", question, answer: `${question} 的回答`, state: "done" }] });
  saveReviewHistory([record("00000000-0000-4000-8000-0000000000c5", "2026-09-30T11:00:00.000Z", "/improve"), record("00000000-0000-4000-8000-0000000000c4", "2026-09-30T10:00:00.000Z", "/describe")]);
  const list = vi.spyOn(api, "listPullRequests").mockResolvedValue({ items: [{ ...item!, comments: 2 }], nextPage: null });
  render(<PrReviewPanel api={api} />);
  await screen.findByRole("button", { name: /#123 示例：调整请求超时/ });
  fireEvent.click(screen.getByRole("button", { name: /历史评审/u }));
  fireEvent.click(document.querySelector<HTMLButtonElement>('[data-run-id="00000000-0000-4000-8000-0000000000c4"]')!);
  fireEvent.click(await screen.findByRole("button", { name: "把这条回答发布到 PR" }));
  const post = within(await screen.findByRole("dialog", { name: "发布到 PR" })).getByRole("button", { name: "发布评论" });
  await waitFor(() => expect(post).toBeEnabled());
  fireEvent.click(post);
  expect(await screen.findByText("已发布到 PR")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "PR 1" }));
  list.mockResolvedValue({ items: [{ ...item!, comments: 3 }], nextPage: null });
  const reads = list.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "刷新 PR 列表" }));
  await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(reads));
  await waitFor(() => expect(screen.queryByText("正在读取 PR 列表…")).toBeNull());
  expect(screen.getByRole("button", { name: /#123 示例：调整请求超时/ })).toHaveTextContent("改进建议");
  expect(screen.getByRole("button", { name: /#123 示例：调整请求超时/ })).not.toHaveTextContent("之后有更新");
  await waitFor(() => expect(loadReviewHistory().entries.map((entry) => entry.listedComments)).toEqual([3, 3]));
});

it("counts the comments of a record made before the list counted them from what the list shows now", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  const [item] = (await api.listPullRequests({ connectionId: "00000000-0000-4000-8000-000000000011", filter: "review-requested", page: 1 })).items;
  // Overviewed after the PR's last update, by a version that kept no count.
  saveReviewHistory([{ id: "00000000-0000-4000-8000-0000000000c3", kind: "chat", at: "2026-09-30T10:00:00.000Z", model: "本机", focus: "", draft: "", turns: [], events: [], state: "finished", error: "", published: [], verdicts: [], rechecks: [],
    connectionId: "00000000-0000-4000-8000-000000000011", report: null, snapshot }]);
  const list = vi.spyOn(api, "listPullRequests").mockResolvedValue({ items: [{ ...item!, comments: 5 }], nextPage: null });
  render(<PrReviewPanel api={api} />);
  // What it saw is not known: nothing is said until the count moves on from here, and where it counts from is kept.
  await waitFor(() => expect(loadReviewHistory().entries[0]?.listedComments).toBe(5));
  expect(screen.getByRole("button", { name: /#123 示例：调整请求超时/ })).not.toHaveTextContent("之后有更新");
  list.mockResolvedValue({ items: [{ ...item!, comments: 6 }], nextPage: null });
  fireEvent.click(screen.getByRole("button", { name: "刷新 PR 列表" }));
  await waitFor(() => expect(screen.getByRole("button", { name: /#123 示例：调整请求超时/ })).toHaveTextContent("之后有更新"));
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
  fireEvent.change(within(form).getByLabelText(/^不采纳的原因/u), { target: { value: "有意为之。" } });
  fireEvent.click(within(form.closest<HTMLElement>('[role="dialog"]')!).getByRole("button", { name: "不采纳" }));
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
  // A screen reader hears it too, after the PR's name, with the build the platform reports (the preview's: passing).
  expect(screen.getByRole("button", { name: /#123 示例：调整请求超时/u })).toHaveAccessibleDescription("中风险，构建通过，评审完成 · 4 个问题（1 个 P1）");
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
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("第 2 条「计时器未清理」发布失败：PR 版本或状态已变化（HTTP 409），请刷新后重新确认。已发出的 1 条不会重发；处理好后再发布，只补发剩下的。");
  expect(publish).toHaveBeenCalledTimes(2);
  expect(publish).toHaveBeenNthCalledWith(1, expect.objectContaining({ path: "src/request.ts", line: 12, side: "new", body: expect.stringContaining("**P2 · 超时后请求仍在运行**") }));
  // The one that went out is not offered again; a retry sends the rest and counts both rounds.
  expect(within(dialog).getByText("已发布")).toBeVisible();
  fireEvent.click(within(dialog).getByRole("button", { name: "补发剩下的 1 条" }));
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
  // Read from the App once the page opens.
  await waitFor(() => expect(document.querySelector(`[data-run-id="${firstId}"]`)).not.toBeNull());
  fireEvent.click(document.querySelector(`[data-run-id="${firstId}"]`)!);
  fireEvent.click(screen.getByLabelText("评审操作"));
  fireEvent.click(screen.getByRole("button", { name: "导出报告" }));
  expect(exporter).toHaveBeenCalledWith(expect.objectContaining({ markdown: expect.stringContaining("源提交：" + "a".repeat(40)) }));
  fireEvent.click(screen.getByLabelText("评审操作"));
  fireEvent.click(screen.getByRole("button", { name: "删除评审" }));
  expect(loadReviewHistory().entries).toHaveLength(2);
  fireEvent.click(within(screen.getByRole("dialog", { name: "删除这次评审记录？" })).getByRole("button", { name: "删除" }));
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
  expect(await screen.findByText(/上次评审已中断/)).toBeVisible();
  view.unmount();
  localStorage.setItem(key, "{broken");
  render(<PrReviewPanel api={api} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("原数据已保留");
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
  expect(await screen.findByText("怎么修复？")).toBeVisible();
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
    source: "summarize", kind: "summarized_decision", id: "DEC-1", title: "取消超时请求", project: "sample", status: "accepted", current: true,
    summary: "超时需要释放资源", appliesWhen: "请求取消", caution: "后台任务另议", tags: [], supersedes: [], supersededBy: [], successors: [], unresolvedSuccessorIds: [],
    sourceRef: { relativePath: "summarize/DEC-1.md", client: null, sessionId: null, excerpt: "超时需要释放资源", excerptStartLine: 1, truncated: false }, matchReason: "超时", warnings: [],
  } }] });
  const open = vi.spyOn(api, "openVaultDocument").mockResolvedValue(undefined);
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例/ }));
  fireEvent.click(await screen.findByRole("button", { name: "开始评审" }));
  // The citation names the decision it points at, not only its number.
  fireEvent.click(await screen.findByRole("link", { name: "[1] 取消超时请求" }));
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
    fireEvent.change(within(form).getByLabelText(/^不采纳的原因/u), { target: { value: "有意为之，超时由上层统一处理" } });
    fireEvent.click(within(form.closest<HTMLElement>('[role="dialog"]')!).getByRole("button", { name: "不采纳" }));

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

it("moves the evidence, the review's numbers and its steps beside the report only while the pane is wide enough", async () => {
  // Each observer is kept by what it observes, so the detail pane's own can be told its width changed.
  const observers = new Map<Element, () => void>();
  vi.stubGlobal("ResizeObserver", class {
    constructor(private readonly callback: () => void) {}
    observe(target: Element) { observers.set(target, this.callback); }
    disconnect() {}
  });
  try {
    const api = createPreviewApi();
    await runSampleReview(api);
    const detail = screen.getByLabelText("当前评审");
    const resize = (width: number) => {
      Object.defineProperty(detail, "clientWidth", { configurable: true, value: width });
      act(() => observers.get(detail)?.());
    };
    // The default window keeps one column: the numbers, the evidence and the steps stay in the report.
    resize(900);
    expect(screen.queryByRole("complementary", { name: "决策证据与评审信息" })).toBeNull();
    expect(screen.getByText(/^1 个问题 · 完成评审 1\/1 个文件/u)).toBeVisible();
    expect(screen.getByText("决策证据：未取得相关决策证据；不能据此断言没有历史约束。")).toBeVisible();
    expect(document.querySelector(".review-chat-messages .review-process")).not.toBeNull();
    resize(1040);
    const aside = within(screen.getByRole("complementary", { name: "决策证据与评审信息" }));
    expect(aside.getByRole("heading", { name: "这次评审" })).toBeVisible();
    expect(aside.getByText("1/1 个文件已评审，读取了 1 个文件的 diff")).toBeVisible();
    expect(aside.getByText("未取得相关决策证据；不能据此断言没有历史约束。")).toBeVisible();
    expect(aside.getByRole("heading", { name: "评审过程" })).toBeVisible();
    // Said once: the report's own line and its steps go, while the findings stay where they were.
    expect(screen.queryByText(/^1 个问题 · 完成评审/u)).toBeNull();
    expect(document.querySelector(".review-chat-messages .review-process")).toBeNull();
    expect(screen.getByRole("heading", { name: "P2 超时后请求仍在运行" })).toBeVisible();
    resize(900);
    expect(screen.queryByRole("complementary", { name: "决策证据与评审信息" })).toBeNull();
    expect(screen.getByText(/^1 个问题 · 完成评审 1\/1 个文件/u)).toBeVisible();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("shows a PR's risk level by its files and the target branch's REVIEW.md, before a review and on the list after one", async () => {
  const api = createPreviewApi();
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  await screen.findByRole("button", { name: "开始评审" });
  const scope = screen.getByRole("heading", { name: "这次会带上" }).parentElement!;
  expect(within(scope).getByText("风险等级")).toBeVisible();
  expect(scope).toHaveTextContent("请求与重试：src/request.ts · 按目标分支 main 的 REVIEW.md 风险路径判定；等级按改动的文件定，不由作者选。");
  expect(scope).toHaveTextContent("REVIEW.md、AGENTS.md · 读自目标分支 main");
  const row = screen.getByRole("button", { name: /#123 示例：调整请求超时/ });
  // The PR open now is known: its row carries the level, and the list can be narrowed by it.
  await waitFor(() => expect(within(row).getByText("中风险")).toHaveAttribute("data-level", "medium"));
  fireEvent.click(await screen.findByRole("button", { name: "开始评审" }));
  await screen.findByRole("heading", { name: "P2 超时后请求仍在运行" });
  expect(within(screen.getByRole("region", { name: "评审过程" })).getAllByText("中风险")[0]).toBeVisible();
});

it("says what each finding stands on, and ends a posted comment with a line saying so", async () => {
  const api = createPreviewApi();
  const original = api.runPrReview.bind(api);
  vi.spyOn(api, "runPrReview").mockImplementation(async (request) => {
    const result = await original(request);
    const [first] = result.findings;
    return { ...result, findings: [
      { ...first!, title: "续期没有检查吊销", body: "违反 REVIEW.md 里的约定：续期前要检查吊销。" },
      { ...first!, title: "错误码不一致", body: "按 Ruleset 1 的约定，错误码应和登录接口一致。", line: 13 },
    ] };
  });
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  const start = await screen.findByRole("button", { name: "开始评审" });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  const rule = (await screen.findByRole("heading", { name: "P2 续期没有检查吊销" })).closest("article")!;
  expect(rule).toHaveTextContent("依据REVIEW.md仓库规则");
  const personal = screen.getByRole("heading", { name: "P2 错误码不一致" }).closest("article")!;
  expect(personal).toHaveTextContent("依据本机评审规则个人依据 · 只作建议");

  fireEvent.click(screen.getByRole("button", { name: "把「续期没有检查吊销」转为 PR 评论" }));
  let form = await screen.findByRole("form", { name: "发布评论表单" });
  expect((within(form).getByRole("textbox") as HTMLTextAreaElement).value).toMatch(/\n\n— Paraself 预评审 · 依据 REVIEW\.md · P2$/u);
  expect(screen.queryByText(/只有你的个人决策或本机评审规则支撑/u)).toBeNull();
  fireEvent.click(within(screen.getByRole("dialog", { name: "发布为 PR 评论" })).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("form", { name: "发布评论表单" })).toBeNull());

  fireEvent.click(screen.getByRole("button", { name: "把「错误码不一致」转为 PR 评论" }));
  form = await screen.findByRole("form", { name: "发布评论表单" });
  expect((within(form).getByRole("textbox") as HTMLTextAreaElement).value).toMatch(/— Paraself 预评审 · 审阅人的个人经验，仓库暂无此规则 · P2 · 建议$/u);
  expect(screen.getByText(/只有你的个人决策或本机评审规则支撑：发出去只是建议/u)).toBeVisible();
});

it("shows above a review what its approval needs, as the platform reports it, and what it could not read", async () => {
  const api = createPreviewApi();
  await runSampleReview(api);
  const conditions = within(screen.getByRole("region", { name: "批准条件" }));
  // The preview's platform: a passing build, nobody's approval, one open discussion; a medium-risk PR needs one person.
  expect(conditions.getByText("风险等级").nextElementSibling).toHaveTextContent("中风险请求与重试");
  expect(conditions.getByText("批准").nextElementSibling).toHaveTextContent("0 / 1");
  expect(conditions.getByText("构建").nextElementSibling).toHaveTextContent("通过");
  expect(conditions.getByText("阻塞项").nextElementSibling).toHaveTextContent("1 项未完成");
  expect(conditions.getByText("PR 描述").nextElementSibling).toHaveTextContent("没写验证、风险、撤回");
  expect(conditions.getByText(/^等级按改动的文件定，不由作者选；按目标分支 main 的 REVIEW\.md 风险路径判定。AI 的批准不算人。/u)).toHaveTextContent("这个平台的阻塞项是未解决的讨论。");
  // An open blocker: approving asks why.
  fireEvent.click(screen.getByRole("button", { name: "批准" }));
  expect(await screen.findByText("还有 1 项未完成的阻塞项：批准要写明理由。")).toBeVisible();
});

it("says so when the platform's status cannot be read, rather than show it as none", async () => {
  const api = createPreviewApi();
  vi.spyOn(api, "listPrReviewStatuses").mockImplementation(async ({ references }) => ({ statuses: references.map(reference => ({ reference, status: null, error: "代码平台连接失败。" })) }));
  await runSampleReview(api);
  const conditions = within(screen.getByRole("region", { name: "批准条件" }));
  expect(conditions.getByText("构建").nextElementSibling).toHaveTextContent("读不到");
  expect(conditions.getByText("阻塞项").nextElementSibling).toHaveTextContent("读不到");
  expect(conditions.getByText(/平台状态读不到：代码平台连接失败。/u)).toBeVisible();
  expect(screen.getByRole("button", { name: /#123 示例：调整请求超时/u })).not.toHaveTextContent("构建");
});

it("posts a P1 the repository's rules stand behind as blocking unless told otherwise, and one on a personal basis never", async () => {
  const api = createPreviewApi();
  const run = api.runPrReview;
  vi.spyOn(api, "runPrReview").mockImplementation(async (input) => {
    const report = await run(input);
    const base = report.findings[0]!;
    return { ...report, findings: [
      { ...base, priority: "P1", title: "超时不取消请求", body: "违反 REVIEW.md 第 2 条：超时要取消底层请求。" },
      { ...base, priority: "P1", title: "和以前的决定不一致", body: "和你以前定的重试策略不一致。", line: 13, decisionIndexes: [1] },
      { ...base, line: 14 },
    ] };
  });
  const publish = vi.spyOn(api, "publishPrReviewComment").mockImplementation(async (input) => ({ message: "ok", ...(input.blocking ? { blocking: true } : {}) }));
  await runSampleReview(api);
  // Said on each finding before anything is posted.
  expect(within(screen.getByRole("heading", { name: "P1 超时不取消请求" }).closest("article")!).getByText("发布时设为阻塞")).toBeVisible();
  expect(within(screen.getByRole("heading", { name: "P1 和以前的决定不一致" }).closest("article")!).getByText("不能设为阻塞")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "批量发布为 PR 评论（3）" }));
  const dialog = within(await screen.findByRole("dialog", { name: "批量发布为 PR 评论" }));
  expect(dialog.getByRole("checkbox", { name: "把「超时不取消请求」设为阻塞" })).toBeChecked();
  expect(dialog.getByRole("checkbox", { name: "把「和以前的决定不一致」设为阻塞" })).toBeDisabled();
  expect(dialog.getByText("设为阻塞：个人依据不能设为阻塞（依据标记为阻塞的本机规则的 P1 除外）")).toBeVisible();
  expect(dialog.getByRole("checkbox", { name: "把「超时后请求仍在运行」设为阻塞" })).not.toBeChecked();
  expect(await dialog.findByText(/阻塞项：这个平台没有任务：发成普通评论，要仓库开启“讨论解决后才能合并”才拦得住。/u)).toBeVisible();
  const send = dialog.getByRole("button", { name: "发布 3 条，其中 1 条阻塞" });
  await waitFor(() => expect(send).toBeEnabled());
  const statuses = vi.spyOn(api, "listPrReviewStatuses");
  fireEvent.click(send);
  expect(await screen.findByText("已发布 3 条评论。")).toBeVisible();
  // The task posted is in the blockers the platform reports next.
  expect(statuses).toHaveBeenCalledWith(expect.objectContaining({ references: ["sample/app#123"] }));
  expect(publish.mock.calls.map(([input]) => input.blocking)).toEqual([true, undefined, undefined]);
  expect(within(screen.getByRole("heading", { name: "P1 超时不取消请求" }).closest("article")!).getByText("已发布为 PR 评论（阻塞项）")).toBeVisible();
  expect(within(screen.getByRole("heading", { name: "P2 超时后请求仍在运行" }).closest("article")!).getByText("已发布为 PR 评论")).toBeVisible();
});

it("reads again a record an agent changed through the App, and does not save its older copy over it", async () => {
  const api = createPreviewApi();
  let changed: ((input: { ids: string[] }) => void) | undefined;
  vi.spyOn(api, "onPrReviewHistoryChanged").mockImplementation(listener => { changed = listener; return () => { changed = undefined; }; });
  await runSampleReview(api);
  await waitFor(async () => expect((await api.listPrReviewHistory()).entries[0]?.report).not.toBeNull());
  // As update_pr_review_finding writes it: the App's copy, the page told which record moved.
  const [entry] = (await api.listPrReviewHistory()).entries;
  await api.savePrReviewHistory({ removed: [], entries: [{ ...entry!, verdicts: [{ finding: 0, verdict: "drop", reason: "超时由网关处理。", replacement: null, at: new Date().toISOString(), model: "评审者", by: "reviewer" }] }] });
  const save = vi.spyOn(api, "savePrReviewHistory");
  const statuses = vi.spyOn(api, "listPrReviewStatuses");
  act(() => changed!({ ids: [entry!.id] }));
  expect(await screen.findByText("超时由网关处理。", { exact: false })).toBeVisible();
  // A comment it posted may be a task: the PR's blockers are read again.
  expect(statuses).toHaveBeenCalledWith({ connectionId: entry!.connectionId, references: [entry!.snapshot.reference] });
  expect(screen.getByRole("note", { name: "不采纳" })).toHaveTextContent("你不采纳");
  // Taken as saved: nothing goes back over it.
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(save.mock.calls.flatMap(([input]) => input.entries).every(item => item.verdicts?.length === 1)).toBe(true);
  expect((await api.listPrReviewHistory()).entries[0]!.verdicts).toHaveLength(1);
});

it("lists a review an agent started through the App among the records, newest first, and shows it finished when told", async () => {
  const api = createPreviewApi();
  let changed: ((input: { ids: string[] }) => void) | undefined;
  vi.spyOn(api, "onPrReviewHistoryChanged").mockImplementation(listener => { changed = listener; return () => { changed = undefined; }; });
  await runSampleReview(api);
  await waitFor(async () => expect((await api.listPrReviewHistory()).entries[0]?.report).not.toBeNull());
  const [entry] = (await api.listPrReviewHistory()).entries;
  // As run_pr_review keeps it: a record of its own, running from the start, which the page has not seen.
  const started = { ...entry!, id: crypto.randomUUID(), at: new Date(Date.now() + 1_000).toISOString(), report: null, state: "running" as const, events: [], published: [], verdicts: [] };
  let current: typeof entry = started;
  const list = api.listPrReviewHistory;
  vi.spyOn(api, "listPrReviewHistory").mockImplementation(async () => ({ ...(await list()), entries: [current!, entry!], running: current!.state === "running" ? [started.id] : [] }));
  act(() => changed!({ ids: [started.id] }));
  fireEvent.click(screen.getByRole("button", { name: /^历史评审/u }));
  await waitFor(() => expect(within(screen.getByRole("list", { name: "历史评审" })).getAllByRole("button")).toHaveLength(2));
  const [first] = within(screen.getByRole("list", { name: "历史评审" })).getAllByRole("button");
  expect(first).toHaveTextContent("评审中");
  fireEvent.click(first!);
  expect(await screen.findByText("这次评审由 agent 发起，在 App 后台进行；结束后这里显示结果。")).toBeVisible();
  current = { ...started, state: "finished", report: entry!.report };
  act(() => changed!({ ids: [started.id] }));
  await waitFor(() => expect(within(screen.getByRole("list", { name: "历史评审" })).getAllByRole("button")[0]).toHaveTextContent("第 2 轮"));
});

it("shows what the user's own PR received, each comment with what was done with it, and answers one with a standard reply", async () => {
  const api = createPreviewApi();
  const respond = vi.spyOn(api, "respondToPrComment");
  const read = vi.spyOn(api, "listPrReceivedComments");
  render(<PrReviewPanel api={api} />);
  fireEvent.click(within(await screen.findByRole("group", { name: "PR 范围" }, { timeout: 5_000 })).getByRole("button", { name: "我创建的" }));
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例/ }, { timeout: 5_000 }));
  const received = within(await screen.findByRole("region", { name: "收到的意见 · 2 条" }));
  expect(received.getByText("1 / 2 条有去向")).toBeVisible();
  // Over it, the conditions as the author reads them: what the merge waits for, and the answers.
  const conditions = within(screen.getByRole("region", { name: "批准条件" }));
  await waitFor(() => expect(conditions.getByText("回应").nextElementSibling).toHaveTextContent("1 / 2 条有去向"));
  expect(screen.getByRole("region", { name: "批准条件" }).querySelector("p")).toHaveTextContent(/^合并要等：1 人批准、阻塞项完成。/u);
  const [task, person] = received.getAllByRole("listitem");
  expect(task).toHaveTextContent("阻塞P1超时后请求仍在运行示例审阅人 A· Paraself 预评审 · 依据 REVIEW.mdsrc/request.ts:12");
  expect(within(task!).getByText("待你决定")).toBeVisible();
  expect(person).toHaveTextContent("人工超时时间能不能做成可配置？");
  expect(within(person!).getByText("已回复：有意为之 —— 超时由调用方传入，这里只给默认值。")).toBeVisible();
  expect(within(person!).getByRole("button", { name: "不修" })).toBeDisabled();

  // 转后续 offers the comment's title for the todo.
  fireEvent.click(within(task!).getByRole("button", { name: "转后续" }));
  expect(within(await screen.findByRole("dialog", { name: "转后续" })).getByLabelText("待办标题")).toHaveValue("超时后请求仍在运行");
  fireEvent.click(screen.getByRole("button", { name: "取消" }));

  fireEvent.click(within(task!).getByRole("button", { name: "不修" }));
  const dialog = within(await screen.findByRole("dialog", { name: "不修" }));
  const send = dialog.getByRole("button", { name: "发出回复" });
  expect(send).toBeDisabled();
  fireEvent.click(dialog.getByRole("radio", { name: /有意为之/ }));
  fireEvent.change(dialog.getByLabelText("理由"), { target: { value: "网关会取消底层请求。" } });
  // Shown as it will go out.
  expect(dialog.getByText("将回复").parentElement).toHaveTextContent("将回复有意为之：网关会取消底层请求。— Paraself 作者回应");
  fireEvent.click(send);
  expect(await screen.findByText("界面预览：回复已模拟发出，未写入代码平台。")).toBeVisible();
  expect(respond).toHaveBeenCalledWith({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123", commentId: "901", kind: "intended", reason: "网关会取消底层请求。" });
  // Read again, as the platform now has it.
  expect(read).toHaveBeenCalledTimes(2);
});

it("hands a line comment on the user's own PR to the local review, and pushes the fix onto the PR only once confirmed", async () => {
  const api = createPreviewApi();
  const submit = vi.spyOn(api, "submitLocalReviewFromPr");
  const act = vi.spyOn(api, "actOnLocalReview");
  vi.spyOn(api, "listModelProviderProfiles").mockResolvedValue([{ version: 1, profileId: "builtin-codex", kind: "codex-cli", label: "Codex CLI", enabled: true, priority: 0, timeoutMs: 120_000, model: "gpt-6-luna", executablePath: "/preview/codex" } as never]);
  render(<PrReviewPanel api={api} />);
  fireEvent.click(within(await screen.findByRole("group", { name: "PR 范围" }, { timeout: 5_000 })).getByRole("button", { name: "我创建的" }));
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例/ }, { timeout: 5_000 }));
  const received = within(await screen.findByRole("region", { name: "收到的意见 · 2 条" }));
  const [task, person] = received.getAllByRole("listitem");
  // A comment on the PR as a whole has no line to fix at.
  expect(within(person!).getByRole("button", { name: "修" })).toBeDisabled();
  fireEvent.click(within(task!).getByRole("button", { name: "修" }));
  expect(within(task!).getByText("将交给本地审阅修改")).toBeVisible();
  const hand = within(screen.getByRole("group", { name: "交给本地审阅" }));
  const send = hand.getByRole("button", { name: "交给本地审阅修改 1 条" });
  await waitFor(() => expect(send).toBeEnabled());
  fireEvent.click(send);
  await waitFor(() => expect(submit).toHaveBeenCalledWith({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123", commentIds: ["901"], profileId: "builtin-codex", worker: "codex" }));
  expect(await within(task!).findByText("本地审阅已改好：+2 −1 · 超时改为取消底层请求。")).toBeVisible();
  expect(within(task!).getByRole("button", { name: "修" })).toBeDisabled();

  // 本轮变化 as it will be written, and the push only on the author's word.
  const round = within(screen.getByRole("region", { name: /^本轮变化/u }));
  expect(round.getByText(/修复 1 条意见/u)).toBeVisible();
  expect(round.getByText(/推送前核对远端分支头仍是/u)).toHaveTextContent("作为新提交推到原 PR 的 feature/request；推送前核对远端分支头仍是 aaaaaaaaaaaa，变了就停，不强推。");
  fireEvent.click(round.getByRole("button", { name: "推送修复到原 PR" }));
  const dialog = within(await screen.findByRole("dialog", { name: "推送修复到原 PR" }));
  expect(act).not.toHaveBeenCalled();
  fireEvent.click(dialog.getByRole("button", { name: "确认推送" }));
  await waitFor(() => expect(act).toHaveBeenCalledWith(expect.objectContaining({ action: "approve", authorization: expect.objectContaining({ commitOid: "d".repeat(40), risks: [] }) })));
  expect(await within(task!).findByText(`已推送到原 PR，提交 ${"d".repeat(12)}，已回复已修`)).toBeVisible();
});

it("reads what became of the findings a record posted when it is opened, and says on each card how the author answered", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "00000000-0000-4000-8000-000000000011", reference: "sample/app#123" });
  const report = await api.runPrReview({ snapshotId: snapshot.snapshotId, runId: "00000000-0000-4000-8000-000000000002", profileId: "local", focus: "" });
  const read = vi.spyOn(api, "readPrReviewOutcomes");
  saveReviewHistory([{ kind: "review" as const, model: "本机", focus: "", draft: "", turns: [], events: [], state: "finished" as const, error: "", rechecks: [], verdicts: [],
    connectionId: "00000000-0000-4000-8000-000000000011", id: "00000000-0000-4000-8000-0000000000e7", at: "2026-09-30T11:00:00.000Z", snapshot, report,
    published: [{ finding: 0, at: "2026-09-30T11:05:00.000Z", comment: "c1", outcome: { kind: "wrong" as const, words: "超时由网关取消。", at: "2026-10-01T09:00:00.000Z" } }] }]);
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /历史评审/u }, { timeout: 5_000 }));
  fireEvent.click(within(screen.getByRole("list", { name: "历史评审" })).getAllByRole("button")[0]!);
  const card = (await screen.findByRole("heading", { name: "P2 超时后请求仍在运行" })).closest("article")!;
  expect(within(card).getByText("作者：说错了 —— 超时由网关取消。")).toBeVisible();
  // Read again: the outcome is a month old.
  await waitFor(() => expect(read).toHaveBeenCalledWith({ id: "00000000-0000-4000-8000-0000000000e7" }));
});

it("posts a single finding as blocking when it may be one, and says on the card that it went out so", async () => {
  const api = createPreviewApi();
  const run = api.runPrReview;
  vi.spyOn(api, "runPrReview").mockImplementation(async (input) => {
    const report = await run(input);
    return { ...report, findings: [{ ...report.findings[0]!, priority: "P1", body: "违反 REVIEW.md 第 2 条：超时要取消底层请求。" }, report.findings[0]!] };
  });
  const publish = vi.spyOn(api, "publishPrReviewComment").mockImplementation(async (input) => ({ message: "评论已发布到 src/request.ts:12。", ...(input.blocking ? { blocking: true } : {}) }));
  await runSampleReview(api);
  fireEvent.click(screen.getAllByRole("button", { name: "把「超时后请求仍在运行」转为 PR 评论" })[0]!);
  const dialog = within(await screen.findByRole("dialog", { name: "发布为 PR 评论" }));
  const blocking = dialog.getByRole("checkbox", { name: /^设为阻塞：/u });
  expect(blocking).toBeChecked();
  expect(await dialog.findByText("设为阻塞：这个平台没有任务：发成普通评论，要仓库开启“讨论解决后才能合并”才拦得住")).toBeVisible();
  const send = dialog.getByRole("button", { name: "发布评论" });
  await waitFor(() => expect(send).toBeEnabled());
  fireEvent.click(send);
  expect(await screen.findByText("已发布为 PR 评论（阻塞项）")).toBeVisible();
  expect(publish).toHaveBeenCalledWith(expect.objectContaining({ line: 12, blocking: true, body: expect.stringContaining("— Paraself 预评审 · 依据 REVIEW.md · P1") }));
});

it("offers a quick approval for a low-risk PR whose every check holds, and says so in the list", async () => {
  const api = createPreviewApi();
  const load = api.loadPrReview, run = api.runPrReview;
  vi.spyOn(api, "loadPrReview").mockImplementation(async (input) => ({ ...(await load(input)), description: "## 验证\n预览单测。\n\n## 风险\n低。\n\n## 撤回\n回退。",
    risk: { level: "low", table: "review_md", reasons: [{ level: "low", reason: "文案", paths: ["src/request.ts"], more: 0 }], changesRules: false, problems: [] } }));
  vi.spyOn(api, "runPrReview").mockImplementation(async (input) => ({ ...(await run(input)), findings: [] }));
  vi.spyOn(api, "listPrReviewStatuses").mockImplementation(async ({ references }) => ({ statuses: references.map(reference => ({ reference,
    status: { sourceCommit: "a".repeat(40), build: "passed" as const, approvals: { count: 0, users: [], logins: [], stale: [] }, blockers: 0, blocking: "discussions" as const, blockersHold: null, sections: null, problems: [] } })) }));
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  const start = await screen.findByRole("button", { name: "开始评审" });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  expect(await screen.findByText("本次已覆盖范围内没有形成有效问题；不代表 PR 已获批准。")).toBeVisible();
  expect(await screen.findByRole("button", { name: "快速批准" })).toBeVisible();
  expect(screen.getByRole("button", { name: /#123 示例：调整请求超时/u })).toHaveTextContent("可以快速批准");
});

it("says the status could not be read when the link itself is refused, rather than read on", async () => {
  const api = createPreviewApi();
  vi.spyOn(api, "listPrReviewStatuses").mockRejectedValue(new Error("请先在设置 › 链接中添加并选择代码平台。"));
  await runSampleReview(api);
  const conditions = within(screen.getByRole("region", { name: "批准条件" }));
  expect(conditions.getByText("构建").nextElementSibling).toHaveTextContent("读不到");
  expect(conditions.getByText(/平台状态读不到：请先在设置 › 链接中添加并选择代码平台。/u)).toBeVisible();
  expect(screen.queryByRole("button", { name: "快速批准" })).toBeNull();
});

it("says whose approval is on an older commit, whether a code owner approved a high-risk PR, and when blockers hold no merge", async () => {
  const api = createPreviewApi();
  const load = api.loadPrReview;
  vi.spyOn(api, "loadPrReview").mockImplementation(async (input) => ({ ...(await load(input)), codeOwners: { file: "CODEOWNERS", owners: ["alice", "@auth"] },
    risk: { level: "high", table: "review_md", reasons: [{ level: "high", reason: "认证与会话", paths: ["src/request.ts"], more: 0 }], changesRules: false, problems: [] } }));
  const status = { sourceCommit: "a".repeat(40), build: "passed" as const, approvals: { count: 1, users: ["Alice"], logins: ["alice"], stale: ["老王"] }, blockers: 0, blocking: "discussions" as const, blockersHold: false, sections: null, problems: [] };
  const statuses = vi.spyOn(api, "listPrReviewStatuses").mockImplementation(async ({ references }) => ({ statuses: references.map(reference => ({ reference, status })) }));
  await runSampleReview(api);
  const conditions = within(screen.getByRole("region", { name: "批准条件" }));
  expect(conditions.getByText("批准").nextElementSibling).toHaveTextContent("1 / 2 · 1 人的批准在旧提交上 · 负责人 alice 已批准");
  expect(conditions.getByText(/老王 批准的是旧提交，新提交还要再看。/u)).toHaveTextContent("仓库没有开启“讨论解决后才能合并”，阻塞项拦不住合并。");
  expect(statuses).toHaveBeenCalled();
});

it("names the code owners a high-risk PR still needs when none of them approved", async () => {
  const api = createPreviewApi();
  const load = api.loadPrReview;
  vi.spyOn(api, "loadPrReview").mockImplementation(async (input) => ({ ...(await load(input)), codeOwners: { file: "CODEOWNERS", owners: ["alice", "@auth"] },
    risk: { level: "high", table: "review_md", reasons: [{ level: "high", reason: "认证与会话", paths: ["src/request.ts"], more: 0 }], changesRules: false, problems: [] } }));
  vi.spyOn(api, "listPrReviewStatuses").mockImplementation(async ({ references }) => ({ statuses: references.map(reference => ({ reference,
    status: { sourceCommit: "a".repeat(40), build: "passed" as const, approvals: { count: 1, users: ["Bob"], logins: ["bob"], stale: [] }, blockers: 0, blocking: "discussions" as const, blockersHold: null, sections: null, problems: [] } })) }));
  await runSampleReview(api);
  // Groups and teams cannot be checked by name: said so.
  expect(within(screen.getByRole("region", { name: "批准条件" })).getByText("批准").nextElementSibling).toHaveTextContent("1 / 2 · 需含负责人：alice、@auth（组成员无法核对）");
});

it("leaves a finding another reviewer's Paraself already posted at its place unticked, and says whose", async () => {
  const api = createPreviewApi();
  const run = api.runPrReview;
  vi.spyOn(api, "runPrReview").mockImplementation(async (input) => {
    const report = await run(input);
    return { ...report, findings: [report.findings[0]!, { ...report.findings[0]!, title: "计时器未清理", line: 20 }] };
  });
  const discussion = api.listPrDiscussion;
  vi.spyOn(api, "listPrDiscussion").mockImplementation(async (input) => {
    const read = await discussion(input);
    return { ...read, comments: [...read.comments, { id: "9", url: "https://github.com/sample/app/pull/123#discussion_r9", author: "示例审阅人 B", path: "src/request.ts", line: 13,
      body: "**P2 · 超时后请求还在跑**\n\n……\n\n— Paraself 预评审 · P2", createdAt: "2026-09-21T11:00:00Z", replyTo: null, code: null, decisionId: null, candidate: null }] };
  });
  const publish = vi.spyOn(api, "publishPrReviewComment");
  await runSampleReview(api);
  fireEvent.click(screen.getByRole("button", { name: "批量发布为 PR 评论（2）" }));
  const dialog = within(await screen.findByRole("dialog", { name: "批量发布为 PR 评论" }));
  expect(await dialog.findByText("PR 上已有同位置的同类意见（示例审阅人 B），默认不再发布。")).toBeVisible();
  expect(dialog.getByRole("checkbox", { name: "超时后请求仍在运行（src/request.ts:12）" })).not.toBeChecked();
  const send = dialog.getByRole("button", { name: "发布 1 条" });
  await waitFor(() => expect(send).toBeEnabled());
  fireEvent.click(send);
  expect(await screen.findByText("已发布 1 条评论。")).toBeVisible();
  expect(publish.mock.calls.map(([input]) => input.line)).toEqual([20]);
});

it("answers under the PR's review summary already there on Bitbucket, so each PR keeps one", async () => {
  const api = createPreviewApi();
  const context = api.getPrActionContext;
  vi.spyOn(api, "getPrActionContext").mockImplementation(async (input) => ({ ...(await context(input)), platform: "bitbucket-server" }));
  const discussion = api.listPrDiscussion;
  vi.spyOn(api, "listPrDiscussion").mockImplementation(async (input) => ({ ...(await discussion(input)), comments: [{ id: "77", url: "https://code.example/77", author: "示例审阅人 B", path: null, line: null,
    body: "**AI 评审**：1 个问题（提交 `aaaaaaaaaaaa`）", createdAt: "2026-09-21T11:00:00Z", replyTo: null, code: null, decisionId: null, candidate: null }] }));
  const post = vi.spyOn(api, "publishPrGeneralComment");
  await runSampleReview(api);
  fireEvent.click(screen.getByLabelText("评审操作"));
  fireEvent.click(screen.getByRole("button", { name: "发布评审摘要到 PR" }));
  const dialog = within(await screen.findByRole("dialog", { name: "发布到 PR" }));
  expect(await dialog.findByText("PR 上已有一份评审摘要（示例审阅人 B 发的）：这次接在它下面，不另发一条。")).toBeVisible();
  const send = dialog.getByRole("button", { name: "发布评论" });
  await waitFor(() => expect(send).toBeEnabled());
  fireEvent.click(send);
  await waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ replyTo: "77" })));
});

it("drafts the description's missing parts from the approval conditions, and writes them back over the version read", async () => {
  const api = createPreviewApi();
  const update = vi.spyOn(api, "updatePrDescription");
  await runSampleReview(api);
  const conditions = within(screen.getByRole("region", { name: "批准条件" }));
  fireEvent.click(conditions.getByRole("button", { name: "起草" }));
  const dialog = within(await screen.findByRole("dialog", { name: "起草 PR 描述" }));
  const field = await dialog.findByRole("textbox", { name: "PR 描述" });
  await waitFor(() => expect(field).toHaveValue([
    "为请求添加超时保护。",
    "## 验证\n\n构建通过。Paraself 预评审发现 1 个问题。（补上跑了哪些检查：单元测试、lint、手工验证……）",
    "## 风险\n\n中风险：请求与重试（src/request.ts）。影响 src。",
    "## 撤回\n\n（写明怎么撤回，以及哪些撤不掉：数据迁移、已发出的消息、对外接口等）",
  ].join("\n\n")));
  expect(dialog.getByText(/补上了验证、风险、撤回。 还没有 PR 概览，撤回一段留给你写/u)).toBeVisible();
  fireEvent.change(field, { target: { value: `${(field as HTMLTextAreaElement).value.replace("（写明怎么撤回，以及哪些撤不掉：数据迁移、已发出的消息、对外接口等）", "回滚本 PR 即可。")}` } });
  const statuses = vi.spyOn(api, "listPrReviewStatuses");
  fireEvent.click(dialog.getByRole("button", { name: "写回 PR 描述" }));
  expect(await screen.findByText("界面预览：PR 描述已模拟写回，未写入代码平台。")).toBeVisible();
  expect(update).toHaveBeenCalledWith({ connectionId: expect.any(String), reference: "sample/app#123", description: expect.stringContaining("## 撤回\n\n回滚本 PR 即可。"), baseVersion: expect.stringMatching(/^[0-9a-f]{16}$/u) });
  // The strip reads the PR again, the description as it now stands among it.
  expect(statuses).toHaveBeenCalled();
});

it("reviews only what the new commits changed in a later round, unless asked for the whole PR", async () => {
  const api = createPreviewApi();
  await runSampleReview(api);
  // The PR moved on: a new head commit.
  const load = api.loadPrReview;
  vi.spyOn(api, "loadPrReview").mockImplementation(async (input) => ({ ...(await load(input)), snapshotId: "00000000-0000-4000-8000-0000000000d2", sourceCommit: "d".repeat(40) }));
  const run = vi.spyOn(api, "runPrReview");
  fireEvent.click(screen.getByRole("button", { name: "重新评审最新提交" }));
  const only = await screen.findByRole("checkbox", { name: /只看新提交/u });
  expect(only).toBeChecked();
  const start = await screen.findByRole("button", { name: "开始评审" });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  await waitFor(() => expect(run).toHaveBeenCalledWith(expect.objectContaining({ since: "a".repeat(40) })));
});

it("marks a review 自动预评审 started, and says on the PR list what the link spent of its day", async () => {
  const api = createPreviewApi();
  let changed: ((input: { ids: string[] }) => void) | undefined;
  vi.spyOn(api, "onPrReviewHistoryChanged").mockImplementation(listener => { changed = listener; return () => { changed = undefined; }; });
  const [link] = await api.listPrConnections();
  vi.spyOn(api, "listPrConnections").mockResolvedValue([{ ...link!, autoReview: { profileId: "local", dailyReviews: 2 } }]);
  let used = 1;
  vi.spyOn(api, "getPrReviewSettings").mockImplementation(async () => ({ prReviewToolsVersion: 1, status: "ok", connections: [], models: [],
    settings: [{ connectionId: link!.id, label: link!.label, platform: link!.platform, autoReview: { profileId: "local", model: "本机", dailyReviews: 2 }, usedToday: used }] }));
  await runSampleReview(api);
  expect(await screen.findByText("自动预评审已开：今天评审了 1 次，最多 2 次。")).toBeVisible();
  await waitFor(async () => expect((await api.listPrReviewHistory()).entries[0]?.report).not.toBeNull());
  const [entry] = (await api.listPrReviewHistory()).entries;
  const started = { ...entry!, id: crypto.randomUUID(), at: new Date(Date.now() + 1_000).toISOString(), report: null, state: "running" as const, events: [], published: [], verdicts: [], auto: true as const };
  const list = api.listPrReviewHistory;
  vi.spyOn(api, "listPrReviewHistory").mockImplementation(async () => ({ ...(await list()), entries: [started, entry!], running: [started.id] }));
  used = 2;
  act(() => changed!({ ids: [started.id] }));
  expect(await screen.findByText("自动预评审今天的 2 次已用完：余下的 PR 只列出，明天再评。")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /^历史评审/u }));
  await waitFor(() => expect(within(screen.getByRole("list", { name: "历史评审" })).getAllByRole("button")[0]).toHaveTextContent("自动 · 评审中"));
  fireEvent.click(within(screen.getByRole("list", { name: "历史评审" })).getAllByRole("button")[0]!);
  expect(await screen.findByText("这次评审由自动预评审发起，在 App 后台进行；结束后这里显示结果。")).toBeVisible();
});

it("shows 评审质量 for the link chosen: the team's figures, the outcomes by basis, and a noisy rule to turn off", async () => {
  const api = createPreviewApi();
  const turn = vi.spyOn(api, "updateReviewRule");
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: "评审质量" }, { timeout: 5_000 }));
  const view = within(await screen.findByLabelText("评审质量", { selector: "div" }));
  expect(await view.findByRole("heading", { name: "评审质量" })).toBeVisible();
  expect(view.getByText("每个 PR 的人工批准").parentElement).toHaveTextContent("1.3之前 30 天 1.6");
  expect(view.getByText("等人批准（中位）").parentElement).toHaveTextContent("5 小时之前 30 天 9 小时");
  expect(view.getByRole("heading", { name: "已发布意见的结果 · 51 条" })).toBeVisible();
  expect(within(view.getByRole("row", { name: /^仓库规则/u })).getAllByRole("cell").map(cell => cell.textContent)).toEqual(["21", "16", "1", "2", "0", "0", "2"]);
  expect(view.getByText(/“可能修了”另有 5 条/u)).toBeVisible();
  // Demo figures, as the preview says; the rule authors keep calling wrong, turned off and on again.
  expect(view.getByText("只读的小表不需要分页。")).toBeVisible();
  fireEvent.click(view.getByRole("button", { name: "停用" }));
  await waitFor(() => expect(turn).toHaveBeenCalledWith({ rule: "list-pagination.md", enabled: false }));
  expect(await view.findByText("已停用「list-pagination」：之后的评审不再用它，文件还在。")).toBeVisible();
  expect(view.getByRole("button", { name: "重新启用" })).toBeVisible();
  // The PR list's search and scope are not for this view.
  expect(screen.queryByRole("searchbox", { name: "搜索评审列表" })).toBeNull();
});

it("writes an escape's four lines on 评审质量, then makes it a benchmark candidate from where the problem sat", async () => {
  const api = createPreviewApi();
  const update = vi.spyOn(api, "updateReviewEscape");
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: "评审质量" }, { timeout: 5_000 }));
  const view = within(await screen.findByLabelText("评审质量", { selector: "div" }));
  expect(await view.findByRole("heading", { name: "漏网复盘 · 1 条待写" })).toBeVisible();
  expect(view.getByText("回滚 · 漏网").parentElement).toHaveTextContent("0 · 1之前 30 天 1 · 0");
  expect(screen.getByRole("button", { name: /漏网复盘\s*1 条待写/u })).toBeVisible();
  const card = within(view.getByRole("article", { name: /SYN\/app#119「导出报表加时间列」合并后被 SYN\/app#124/u }));
  fireEvent.change(card.getByLabelText("问题是什么"), { target: { value: "导出时间按服务器时区格式化" } });
  fireEvent.change(card.getByLabelText("本该哪一层拦住"), { target: { value: "human_review" } });
  fireEvent.change(card.getByLabelText("为什么没拦住"), { target: { value: "评审只看了格式" } });
  fireEvent.change(card.getByLabelText("改在哪里"), { target: { value: "norm" } });
  fireEvent.click(card.getByRole("button", { name: "保存复盘" }));
  await waitFor(() => expect(update).toHaveBeenCalledWith({ id: "00000000-0000-4000-8000-0000000000e1", action: "write",
    writeup: { problem: "导出时间按服务器时区格式化", layer: "human_review", why: "评审只看了格式", change: "norm", changeText: "" } }));
  expect(await card.findByText("人工评审")).toBeVisible();
  expect(screen.getByRole("button", { name: /漏网复盘\s*1 条已写/u })).toBeVisible();
  // Where the problem sat, as a file and its lines; not a place, not sent.
  const add = card.getByRole("button", { name: "加入评测集" });
  fireEvent.change(card.getByLabelText("问题在哪（PR 合入时的文件和行）"), { target: { value: "src/export.ts" } });
  expect(add).toBeDisabled();
  fireEvent.change(card.getByLabelText("问题在哪（PR 合入时的文件和行）"), { target: { value: "src/export.ts:42-48" } });
  fireEvent.click(add);
  await waitFor(() => expect(update).toHaveBeenLastCalledWith({ id: "00000000-0000-4000-8000-0000000000e1", action: "add_to_benchmark", location: { path: "src/export.ts", startLine: 42, endLine: 48 }, priority: "P2" }));
  expect(await card.findByText(/已加入评测集的候选样本 case-000000000119/u)).toBeVisible();
});

it("shows an escape as written elsewhere once 评审质量 is read again", async () => {
  const api = createPreviewApi();
  const read = api.getReviewQuality;
  let written = false;
  vi.spyOn(api, "getReviewQuality").mockImplementation(async (input) => {
    const result = await read(input);
    return written ? { ...result, quality: { ...result.quality!, escapes: result.quality!.escapes.map(item => ({ ...item, state: "written" as const,
      writeup: { problem: "导出时间按服务器时区格式化", layer: "ci" as const, why: "没有跨时区的测试", change: "check" as const, changeText: "加跨时区测试" } })) } } : result;
  });
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: "评审质量" }, { timeout: 5_000 }));
  const view = within(await screen.findByLabelText("评审质量", { selector: "div" }));
  expect(await view.findByLabelText("问题是什么")).toBeVisible();
  // An agent wrote its four lines through the bridge; the page reads it again.
  written = true;
  fireEvent.click(view.getByRole("button", { name: "重新读取" }));
  expect(await view.findByText("没有跨时区的测试")).toBeVisible();
  expect(view.getByText("CI 与测试")).toBeVisible();
  expect(view.queryByLabelText("问题是什么")).toBeNull();
});

it("shows 评测集: the two sets, the change compared before and after with the gate's word, and the candidates to confirm", async () => {
  const api = createPreviewApi();
  const page = vi.spyOn(api, "reviewBenchmarkPage");
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: "评审质量" }, { timeout: 5_000 }));
  fireEvent.click(await screen.findByRole("button", { name: /评测集\s*4 条待确认/u }));
  const view = within(await screen.findByLabelText("评测集", { selector: "div" }));
  expect(view.getByText("缺陷集 · 28 个")).toBeVisible();
  expect(view.getByText(/留出集命中 11\/18 · 核验误杀 1 · 修复后再报 0/u)).toBeVisible();
  expect(view.getByText(/有害意见 0 条 \/ 20 个 PR · 每个 PR 1.3 条意见 · 已知误报再犯 0/u)).toBeVisible();
  // The latest run against the one before: recall level, harm down, so it can be taken.
  expect(await view.findByText("召回没降，有害意见减少：可以采用。")).toBeVisible();
  expect(within(view.getByRole("row", { name: /^有害意见/u })).getAllByRole("cell").map(cell => cell.textContent)).toEqual(["2", "0", "下降"]);
  fireEvent.click(view.getByRole("button", { name: "采用" }));
  await waitFor(() => expect(page).toHaveBeenCalledWith({ kind: "adopt", id: "00000000-0000-4000-8000-0000000000b2", note: "" }));
  expect(await view.findByText(/^已采用（/u)).toBeVisible();
  // A candidate confirmed by the one who checks it; a suggestion taken as a candidate.
  const candidates = within(view.getByRole("region", { name: /待确认的候选样本 · 4/u }) as HTMLElement);
  fireEvent.click(candidates.getAllByRole("button", { name: "确认入集" })[0]!);
  await waitFor(() => expect(page).toHaveBeenCalledWith({ kind: "confirm", repositoryPath: "/preview/app", caseId: "case-000000000119" }));
  fireEvent.click(candidates.getAllByRole("button", { name: "收为候选" })[0]!);
  await waitFor(() => expect(page).toHaveBeenCalledWith(expect.objectContaining({ kind: "accept", key: "preview-121" })));
  // Started only with what changed said; the holdout by default.
  fireEvent.click(view.getByRole("button", { name: "运行评测" }));
  const form = within(view.getByRole("form", { name: "运行评测" }));
  expect(form.getByRole("button", { name: "开始评测" })).toBeDisabled();
  fireEvent.change(form.getByLabelText("改了什么"), { target: { value: "换成新模型" } });
  fireEvent.click(form.getByRole("button", { name: "开始评测" }));
  await waitFor(() => expect(page).toHaveBeenCalledWith({ kind: "run", repositoryPath: "/preview/app", label: "换成新模型", split: "holdout", fixControl: false }));
});

it("proposes a rule for REVIEW.md from 评审质量 with the line as the user leaves it, handed to the local review", async () => {
  const api = createPreviewApi();
  const act = vi.spyOn(api, "actOnReviewPromotion");
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: "评审质量" }, { timeout: 5_000 }));
  const view = within(await screen.findByLabelText("评审质量", { selector: "div" }));
  expect(await view.findByRole("heading", { name: "晋升提议 · 1" })).toBeVisible();
  expect(screen.getByRole("button", { name: /晋升提议\s*1 条/u })).toBeVisible();
  const card = within(view.getByRole("article", { name: /「续期失败返回 401 \+ SESSION_EXPIRED」/u }));
  expect(card.getByText("支撑的意见出现在 3 个 PR，修了 2 次")).toBeVisible();
  fireEvent.change(card.getByLabelText("写进 REVIEW.md 的一条"), { target: { value: "- 续期失败一律返回 401 和 SESSION_EXPIRED。" } });
  fireEvent.click(card.getByRole("button", { name: "提议写进 REVIEW.md" }));
  await waitFor(() => expect(act).toHaveBeenCalledWith({ action: "propose", connectionId: expect.any(String), key: "decision|null|dec-9", draft: "- 续期失败一律返回 401 和 SESSION_EXPIRED。" }));
  expect(await card.findByText(/已交给本地审阅（任务 00000000-0000-4000-8000-0000000000ab）/u)).toBeVisible();
  await waitFor(() => expect(screen.queryByRole("button", { name: /晋升提议\s*1 条/u })).toBeNull());
});

it("posts a P1 on a rule the reviewer marked blocking as blocking, quoting the rule; with the quote edited out it may not block", async () => {
  const api = createPreviewApi();
  const load = api.loadPrReview, run = api.runPrReview;
  vi.spyOn(api, "loadPrReview").mockImplementation(async (input) => ({ ...(await load(input)),
    rules: [{ id: "money.md", source: "decision" as const, enforcement: "blocking" as const, text: "金额一律用整数分，不用浮点数。" }] }));
  vi.spyOn(api, "runPrReview").mockImplementation(async (input) => {
    const report = await run(input);
    return { ...report, findings: [{ ...report.findings[0]!, priority: "P1", body: "违反 Ruleset 1：金额用了浮点数。" }] };
  });
  const publish = vi.spyOn(api, "publishPrReviewComment").mockImplementation(async (input) => ({ message: "ok", ...(input.blocking ? { blocking: true } : {}) }));
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }, { timeout: 5_000 }));
  const start = await screen.findByRole("button", { name: "开始评审" });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  const card = within((await screen.findByRole("heading", { name: "P1 超时后请求仍在运行" })).closest("article")!);
  expect(card.getByText("发布时设为阻塞")).toBeVisible();
  expect(card.getByText("个人规则 · 标记为阻塞")).toBeVisible();
  fireEvent.click(card.getByRole("button", { name: "把「超时后请求仍在运行」转为 PR 评论" }));
  const form = await screen.findByRole("form", { name: "发布评论表单" });
  const dialog = within(form.closest<HTMLElement>('[role="dialog"]')!);
  const body = within(form).getByLabelText("评论内容") as HTMLTextAreaElement;
  expect(body.value).toContain("> 审阅人的规则「money」（标记为阻塞）：\n> 金额一律用整数分，不用浮点数。\n\n— Paraself 预评审 · 依据 审阅人的规则（标记为阻塞） · P1");
  const toggle = dialog.getByRole("checkbox", { name: /设为阻塞/u });
  expect(toggle).toBeChecked();
  // The quote taken out, it may not block; put back, it may again.
  const full = body.value;
  fireEvent.change(body, { target: { value: "**P1 · 超时后请求仍在运行**\n\n金额用了浮点数。" } });
  expect(toggle).toBeDisabled();
  expect(dialog.getByText("设为阻塞：正文里要保留规则原文的引用才能设为阻塞")).toBeVisible();
  fireEvent.change(body, { target: { value: full } });
  await waitFor(() => expect(toggle).toBeEnabled());
  fireEvent.click(dialog.getByRole("button", { name: "发布评论" }));
  await waitFor(() => expect(publish).toHaveBeenCalledWith(expect.objectContaining({ blocking: true, body: full.trim() })));
});
