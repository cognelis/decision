// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalReviewExecution, LocalReviewJob, LocalReviewMessage, LocalReviewTurn } from "@cognelis/decision-protocol";
import { createPreviewApi } from "../src/renderer/preview-api.js";
import { LocalReviewPanel } from "../src/renderer/components/pages/local-review/LocalReviewPanel.js";

beforeEach(() => { window.history.replaceState({}, "", "/?preview=local-review"); });
afterEach(() => { cleanup(); localStorage.clear(); window.history.replaceState({}, "", "/"); });

const uuid = () => crypto.randomUUID();
const at = "2026-11-05T09:00:00.000Z";
const message = (seq: number, role: LocalReviewMessage["role"], body: string, extra: Partial<LocalReviewMessage> = {}): LocalReviewMessage => ({ id: uuid(), seq, role, createdAt: at, body, references: [], turnId: null, ...extra });
const turn = (userMessageId: string, state: LocalReviewTurn["state"], extra: Partial<LocalReviewTurn> = {}): LocalReviewTurn => ({ id: uuid(), userMessageId, state, attemptId: uuid(), attempts: 1, error: null, stats: null, ...extra });
const execution = (job: LocalReviewJob, messageId: string, extra: Partial<LocalReviewExecution> = {}): LocalReviewExecution => ({ id: uuid(), messageId, turnId: uuid(), groupId: job.groups[0]!.id, kind: "existing", planBaseOid: "c".repeat(40), annotationIds: [job.annotations[0]!.id], requirements: "", expectedChanges: "追加提交", state: "pending", intent: null, attemptId: uuid(), attempts: 0, newCommitOid: null, fix: null, artifact: null, excludedFiles: [], pushed: false, comment: null, authorization: null, error: null, createdAt: at, updatedAt: at, ...extra });
const plan = (job: LocalReviewJob, extra: Partial<NonNullable<LocalReviewMessage["plan"]>> = {}) => ({ target: { kind: "existing" as const, groupId: job.groups[0]!.id }, annotationIds: [job.annotations[0]!.id], requirements: "", expectedChanges: "在原分支追加提交。", reason: "沿用已有分支。", planBaseOid: "c".repeat(40), executable: true, invalidReason: null, ...extra });

/** A preview state with a clean, empty conversation and a settled first group; `mutate` shapes the case. */
async function setup(mutate: (job: LocalReviewJob) => void = () => undefined) {
  const api = createPreviewApi(), state = await api.getLocalReviewState(), job = state.jobs[0]!;
  job.conversation = { messages: [], nextSeq: 1, readSeq: 0 }; job.turns = []; job.executions = []; job.groups[0]!.state = "pr_opened";
  mutate(job);
  job.conversation.nextSeq = Math.max(job.conversation.nextSeq, ...job.conversation.messages.map(m => m.seq + 1));
  vi.spyOn(api, "getLocalReviewState").mockImplementation(async () => structuredClone(state));
  return { api, state, job };
}
const open = (api: ReturnType<typeof createPreviewApi>, job: LocalReviewJob) => render(<LocalReviewPanel api={api} openJobId={job.id} />);
const composer = async () => await screen.findByRole("textbox", { name: "消息内容" }) as HTMLTextAreaElement;

describe("task conversation view", () => {
  it("titles the task by its first comment and demotes the UUID", async () => {
    const { api, job } = await setup(); open(api, job);
    const heading = await screen.findByRole("heading", { name: /src\/request\.ts:2 · / });
    expect(heading.textContent).toContain(new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(job.createdAt)));
    expect(heading.textContent).not.toContain(job.createdAt);
    expect(heading.closest("article")?.textContent).toContain(`任务 ID ${job.id}`);
    expect(screen.queryByRole("heading", { name: job.id })).toBeNull();
  });

  it("renders worker replies as Markdown without raw HTML, shows verbatim system results and wraps long links", async () => {
    const long = `https://example.invalid/${"segment/".repeat(40)}`, systemBody = `verification 原话：\n  npm test\t通过\n${long}\n\n**追加通过**\n\n\`\`\`sh\nnpm run check\n\`\`\``;
    const { api, job } = await setup(j => {
      const user = message(1, "user", "为什么？", { turnId: uuid() });
      j.conversation.messages = [user, message(2, "worker", `**加粗结论**\n\n- 第一条\n- 第二条\n\n\`\`\`ts\nconst x = "${"y".repeat(300)}";\n\`\`\`\n\n<img src=x onerror=alert(1)> [详情](${long})`, { turnId: user.turnId }), message(3, "system", systemBody, { event: "execution_done" })];
    });
    open(api, job);
    const reply = (await screen.findByRole("article", { name: "审阅代理" }));
    expect(reply.querySelector(".local-review-message-body strong")?.textContent).toBe("加粗结论"); expect(reply.querySelectorAll("li")).toHaveLength(2); expect(reply.querySelector("pre code")?.textContent).toContain("const x");
    expect(reply.querySelector("img")).toBeNull(); expect(reply.textContent).toContain("<img src=x onerror=alert(1)>");
    const system = screen.getByRole("article", { name: "系统消息" });
    expect(system.querySelector("details.local-review-original pre")?.textContent).toBe(systemBody);
    expect(system.querySelector(".assistant-answer strong")?.textContent).toBe("追加通过"); expect(system.querySelector(".assistant-answer pre code")?.textContent).toBe("npm run check");
  });

  it("shows references on messages and marks stale ones", async () => {
    const { api, job } = await setup(j => { j.conversation.messages = [message(1, "user", "看这两条", { references: [{ kind: "annotation", id: j.annotations[0]!.id }, { kind: "group", id: j.groups[0]!.id }, { kind: "group", id: uuid() }], turnId: uuid() })]; });
    open(api, job);
    const mine = await screen.findByRole("article", { name: "我的消息" });
    expect(within(mine).getByText("意见 src/request.ts:2")).toBeTruthy(); expect(within(mine).getByText(/组 1「补上请求取消/)).toBeTruthy(); expect(within(mine).getByText("组（已失效）")).toBeTruthy();
  });
});

describe("quoting into the composer", () => {
  it("inserts at the cursor, records each reference once and keeps the rest of the draft", async () => {
    const { api, job } = await setup(); const send = vi.spyOn(api, "sendLocalReviewMessage"); open(api, job);
    const box = await composer();
    fireEvent.change(box, { target: { value: "前后" } }); box.setSelectionRange(1, 1);
    fireEvent.click(screen.getByRole("button", { name: "在对话中引用意见 src/request.ts:2" }));
    await waitFor(() => expect(box.value).toBe("前\n> src/request.ts:2（新版本）\n> 请求需要超时保护，超时后应取消上游连接。\n\n后"));
    fireEvent.click(screen.getByRole("button", { name: "在对话中引用意见 src/request.ts:2" }));
    expect(box.value.match(/> src\/request\.ts:2/g)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "在对话中引用组 1" }));
    await waitFor(() => expect(box.value).toContain("> 组 1「补上请求取消并调整 CI 验证」\n> 分支 "));
    expect(box.value).toContain("提交 cccccccccc");
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]![0].references).toEqual([{ kind: "annotation", id: job.annotations[0]!.id }, { kind: "group", id: job.groups[0]!.id }]);
  });

  it("drops a reference whose quoted text was deleted from the draft", async () => {
    const { api, job } = await setup(); const send = vi.spyOn(api, "sendLocalReviewMessage"); open(api, job);
    const box = await composer();
    fireEvent.click(screen.getByRole("button", { name: "在对话中引用意见 src/request.ts:2" }));
    await waitFor(() => expect(box.value).toContain("> src/request.ts:2"));
    fireEvent.change(box, { target: { value: "只剩一句话" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(send).toHaveBeenCalledWith({ repositoryId: job.repositoryId, jobId: job.id, body: "只剩一句话", references: [] }));
  });
});

describe("composer", () => {
  it("sends with the button or Cmd/Ctrl+Enter, keeps Enter as a newline and clears only after success", async () => {
    const { api, job } = await setup(); const send = vi.spyOn(api, "sendLocalReviewMessage"); open(api, job);
    const box = await composer(), button = screen.getByRole("button", { name: "发送" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(box, { target: { value: "第一行\n第二行" } });
    fireEvent.keyDown(box, { key: "Enter" }); expect(send).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(send).toHaveBeenCalledWith({ repositoryId: job.repositoryId, jobId: job.id, body: "第一行\n第二行", references: [] }));
    await waitFor(() => expect(box.value).toBe(""));
  });

  it("keeps the draft and shows the reason when sending fails", async () => {
    const { api, job } = await setup(); vi.spyOn(api, "sendLocalReviewMessage").mockRejectedValue(new Error("有其它操作进行中，请稍后重试。")); open(api, job);
    const box = await composer(); fireEvent.change(box, { target: { value: "别丢这段" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect((await screen.findByRole("alert")).textContent).toContain("有其它操作进行中"); expect(box.value).toBe("别丢这段");
  });

  it("lets the draft be edited while a turn runs but never sends a second turn", async () => {
    const { api, job } = await setup(j => { const user = message(1, "user", "问题", { turnId: uuid() }); j.conversation.messages = [user]; j.turns = [{ ...turn(user.id, "running"), id: user.turnId! }]; });
    const send = vi.spyOn(api, "sendLocalReviewMessage"), act = vi.spyOn(api, "actOnLocalReviewConversation"); open(api, job);
    const box = await composer(); fireEvent.change(box, { target: { value: "追问草稿" } });
    expect(box.value).toBe("追问草稿"); expect(box.disabled).toBe(false);
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(box, { key: "Enter", metaKey: true }); expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消本回合" }));
    await waitFor(() => expect(act).toHaveBeenCalledWith({ repositoryId: job.repositoryId, jobId: job.id, action: "cancel_turn", turnId: job.turns[0]!.id }));
  });

  it("keeps the draft across polls, job refreshes and a remount", async () => {
    const { api, state, job } = await setup(); const view = open(api, job);
    const box = await composer(); fireEvent.change(box, { target: { value: "半截草稿" } });
    state.jobs[0]!.conversation.messages.push(message(1, "worker", "新回复")); state.jobs[0]!.conversation.nextSeq = 2;
    expect(await screen.findByText("新回复", {}, { timeout: 4000 })).toBeTruthy();
    expect((await composer()).value).toBe("半截草稿");
    view.unmount(); open(api, job);
    expect((await composer()).value).toBe("半截草稿");
  });
});

describe("plans and execution", () => {
  it("never executes by itself and only runs after an explicit click on a valid plan", async () => {
    const { api, job } = await setup(j => { const user = message(1, "user", "改吧", { turnId: uuid() }); j.conversation.messages = [user, message(2, "worker", "方案如下", { turnId: user.turnId, plan: plan(j) }), message(3, "worker", "这个不行", { turnId: user.turnId, plan: plan(j, { executable: false, invalidReason: "组 1 正在等待风险授权。" }) })]; });
    const run = vi.spyOn(api, "executeLocalReviewPlan"); open(api, job);
    const cards = await screen.findAllByRole("region", { name: "执行方案" });
    await new Promise(resolve => setTimeout(resolve, 50)); expect(run).not.toHaveBeenCalled();
    expect(cards).toHaveLength(2); expect(screen.getAllByRole("button", { name: "执行" })).toHaveLength(1);
    expect(within(cards[1]!).queryByRole("button")).toBeNull(); expect(cards[1]!.textContent).toContain("此方案无法执行：组 1 正在等待风险授权。");
    expect(cards[0]!.textContent).toContain("追加到组 1"); expect(cards[0]!.textContent).toContain("在原分支追加提交。");
    fireEvent.click(screen.getByRole("button", { name: "执行" }));
    await waitFor(() => expect(run).toHaveBeenCalledWith({ repositoryId: job.repositoryId, jobId: job.id, messageId: job.conversation.messages[1]!.id }));
  });

  it("replaces the execute button by the execution state once one exists", async () => {
    const { api, job } = await setup(j => { const m = message(1, "worker", "方案", { plan: plan(j) }); j.conversation.messages = [m]; j.executions = [execution(j, m.id, { state: "fixing" })]; });
    open(api, job);
    await screen.findByRole("region", { name: "执行方案" });
    expect(screen.queryByRole("button", { name: "执行" })).toBeNull(); expect(screen.getByText(/执行状态：正在修改/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消执行" })).toBeTruthy();
  });

  it("offers cancel while pending, retry and discard after failure, and no retry once attempts are exhausted", async () => {
    const act = async (state: LocalReviewExecution["state"], extra: Partial<LocalReviewExecution> = {}) => {
      const { api, job } = await setup(j => { const m = message(1, "worker", "方案", { plan: plan(j) }); const e = execution(j, m.id, { state, error: state === "failed" ? "worker 超时" : null, ...extra }); j.conversation.messages = [m, message(2, "system", "结果", { executionId: e.id, event: "execution_failed" })]; j.executions = [e]; });
      return { api, job, view: open(api, job) };
    };
    let t = await act("pending"); expect(await screen.findByRole("button", { name: "取消执行" })).toBeTruthy(); expect(screen.queryByRole("button", { name: "重试执行" })).toBeNull();
    const cancel = vi.spyOn(t.api, "actOnLocalReviewConversation"); fireEvent.click(screen.getByRole("button", { name: "取消执行" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith({ repositoryId: t.job.repositoryId, jobId: t.job.id, action: "cancel_execution", executionId: t.job.executions[0]!.id }));
    cleanup(); t = await act("failed"); expect(await screen.findByText(/worker 超时/)).toBeTruthy();
    expect(await screen.findByRole("button", { name: "重试执行" })).toBeTruthy(); expect(await screen.findByRole("button", { name: "丢弃本次追加" })).toBeTruthy();
    cleanup(); t = await act("failed", { attempts: 20 }); await screen.findByRole("article", { name: "系统消息" });
    expect(screen.queryByRole("button", { name: "重试执行" })).toBeNull();
    cleanup(); t = await act("done_comment_failed", { pushed: true }); expect(await screen.findByRole("button", { name: "重试评论" })).toBeTruthy(); expect(screen.queryByRole("button", { name: "重试执行" })).toBeNull();
    cleanup(); t = await act("remote_changed"); await screen.findByRole("article", { name: "系统消息" }); expect(screen.queryByRole("button", { name: /重试|仍然推送|审阅风险/ })).toBeNull();
  });

  it("authorizes a risky append with the execution's own new commit and base, not the group's earlier commit", async () => {
    const newOid = "f".repeat(40), base = "a".repeat(40);
    const { api, job } = await setup(j => {
      const m = message(1, "worker", "方案", { plan: plan(j, { planBaseOid: base }) });
      const e = execution(j, m.id, { state: "blocked", newCommitOid: newOid, planBaseOid: base, artifact: { commitOid: newOid, changes: [], diff: "diff --git a/.github/ci.yml b/.github/ci.yml\n+run: x", risks: [".github/ci.yml"] } });
      j.conversation.messages = [m, message(2, "system", "等待风险授权", { executionId: e.id, event: "execution_blocked" })]; j.executions = [e];
    });
    const act = vi.spyOn(api, "actOnLocalReviewConversation"); open(api, job);
    fireEvent.click(await screen.findByRole("button", { name: "审阅风险改动" }));
    expect(act).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog", { name: "高风险改动" });
    expect(dialog.textContent).toContain(newOid); expect(dialog.textContent).toContain(base); expect(dialog.textContent).toContain(".github/ci.yml"); expect(dialog.textContent).toContain(job.pushUrl);
    expect(dialog.textContent).not.toContain(job.groups[0]!.artifact!.commitOid);
    fireEvent.click(within(dialog).getByRole("button", { name: "仍然推送" }));
    await waitFor(() => expect(act).toHaveBeenCalledWith({ repositoryId: job.repositoryId, jobId: job.id, action: "approve_execution", executionId: job.executions[0]!.id, authorization: { executionId: job.executions[0]!.id, groupId: job.groups[0]!.id, commitOid: newOid, planBaseOid: base, risks: [".github/ci.yml"], pushUrl: job.pushUrl } }));
  });

  it("offers only discard when a token pattern was hit and never leaks the matched text", async () => {
    const secret = "sk-ant-synthetic-only";
    const { api, job } = await setup(j => {
      const m = message(1, "worker", "方案", { plan: plan(j) });
      const e = execution(j, m.id, { state: "blocked", newCommitOid: "f".repeat(40), artifact: { commitOid: "f".repeat(40), changes: [], diff: secret, risks: ["src/config.json"], secretFindings: [{ path: "src/config.json", line: 3 }] } });
      j.conversation.messages = [m, message(2, "system", "敏感形态扫描已阻止推送：src/config.json:3", { executionId: e.id, event: "execution_blocked" })]; j.executions = [e];
    });
    open(api, job); await screen.findByRole("button", { name: "丢弃本次追加" });
    expect(screen.queryByRole("button", { name: /审阅风险改动|仍然推送|重试/ })).toBeNull(); expect(document.body.textContent).not.toContain(secret);
  });

  it("offers the conversation retry for a restarted new-group execution", async () => {
    const { api, job } = await setup(j => {
      j.state = "interrupted"; j.groups[0]!.state = "interrupted"; j.groups[0]!.origin = "conversation";
      const m = message(1, "worker", "新组方案", { plan: plan(j) });
      const e = execution(j, m.id, { kind: "new", state: "interrupted", planBaseOid: null });
      j.executions = [e]; j.conversation.messages = [m, message(2, "system", "新组被中断。", { executionId: e.id, event: "execution_interrupted" })];
    });
    const act = vi.spyOn(api, "actOnLocalReviewConversation"); open(api, job);
    fireEvent.click(await screen.findByRole("button", { name: "重试执行" }));
    await waitFor(() => expect(act).toHaveBeenCalledWith({ repositoryId: job.repositoryId, jobId: job.id, action: "retry_execution", executionId: job.executions[0]!.id }));
  });
  it("shows turn failures with the reason and a retry, unless attempts are used up", async () => {
    const { api, job } = await setup(j => { const user = message(1, "user", "问", { turnId: uuid() }); j.conversation.messages = [user, message(2, "system", "讨论回合失败：超出上下文预算", { turnId: user.turnId, event: "turn_failed" })]; j.turns = [{ ...turn(user.id, "failed", { error: "超出上下文预算" }), id: user.turnId! }]; });
    const act = vi.spyOn(api, "actOnLocalReviewConversation"); open(api, job);
    // Synchronise on the visible control: text can already match in the still-hidden tab, but the accessible button only
    // exists once the panel has switched to the tasks tab for the opened job.
    const retry = await screen.findByRole("button", { name: "重试此回合" });
    expect((await screen.findAllByText(/超出上下文预算/)).length).toBeGreaterThan(0);
    fireEvent.click(retry);
    await waitFor(() => expect(act).toHaveBeenCalledWith({ repositoryId: job.repositoryId, jobId: job.id, action: "retry_turn", turnId: job.turns[0]!.id }));
    cleanup();
    const worn = await setup(j => { const user = message(1, "user", "问", { turnId: uuid() }); j.conversation.messages = [user]; j.turns = [{ ...turn(user.id, "failed", { attempts: 5 }), id: user.turnId! }]; });
    open(worn.api, worn.job); await composer(); expect(screen.queryByRole("button", { name: "重试此回合" })).toBeNull();
  });
});

describe("unread", () => {
  it("shows the unread count from seq and readSeq in the list", async () => {
    const { api, job } = await setup(j => { j.conversation.messages = [message(1, "user", "问"), message(2, "worker", "答一"), message(3, "worker", "答二")]; j.conversation.readSeq = 1; });
    render(<LocalReviewPanel api={api} />);
    expect(await screen.findByLabelText("2 条未读回复")).toBeTruthy(); expect(job.conversation.readSeq).toBe(1);
  });

  it("marks only what the open conversation rendered, and later replies stay unread until they render too", async () => {
    const { api, state } = await setup(j => { j.conversation.messages = [message(1, "user", "问"), message(2, "worker", "答一"), message(3, "worker", "答二")]; j.conversation.readSeq = 1; });
    const seen: { seq: number; rendered4: boolean }[] = [];
    vi.spyOn(api, "markLocalReviewRead").mockImplementation(async input => {
      seen.push({ seq: input.seq, rendered4: !!document.querySelector("[data-seq='4']") });
      const job = state.jobs[0]!; job.conversation.readSeq = Math.max(job.conversation.readSeq, input.seq);
      if (input.seq === 3) { job.conversation.messages.push(message(4, "worker", "晚到的回复")); job.conversation.nextSeq = 5; }
    });
    render(<LocalReviewPanel api={api} />);
    await screen.findByLabelText("2 条未读回复");
    expect(api.markLocalReviewRead).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: /后台任务/ }));
    await waitFor(() => expect(seen.map(s => s.seq)).toEqual([3, 4]));
    expect(seen[0]).toEqual({ seq: 3, rendered4: false }); expect(seen[1]!.rendered4).toBe(true);
    expect(await screen.findByText("晚到的回复")).toBeTruthy();
  });
});

describe("review round 1", () => {
  it("gives no comment retry once attempts are exhausted, and keeps the failed text copyable", async () => {
    const make = async (attempts: number) => setup(j => { const m = message(1, "worker", "方案", { plan: plan(j) }); const e = execution(j, m.id, { state: "done_comment_failed", pushed: true, attempts }); j.conversation.messages = [m, message(2, "system", "评论超过 8000 字符，未发送。\n\n原文：长评论", { executionId: e.id, event: "execution_comment_failed" })]; j.executions = [e]; });
    let t = await make(3); open(t.api, t.job); expect(await screen.findByRole("button", { name: "重试评论" })).toBeTruthy(); cleanup();
    t = await make(20); open(t.api, t.job); const system = await screen.findByRole("article", { name: "系统消息" });
    expect(screen.queryByRole("button", { name: "重试评论" })).toBeNull(); expect(system.querySelector("details.local-review-original pre")?.textContent).toContain("原文：长评论");
  });

  it("folds a long summary once there is a conversation and keeps the composer outside it", async () => {
    const { api, job } = await setup(j => { j.conversation.messages = [message(1, "worker", "需要补充：请说明目标。")]; }); open(api, job);
    const fold = (await screen.findByText(/任务摘要 ·/)).closest("details")!;
    expect(fold.hasAttribute("open")).toBe(false); expect(fold.contains(await composer())).toBe(false);
    cleanup(); const empty = await setup(); open(empty.api, empty.job);
    expect((await screen.findByText(/任务摘要 ·/)).closest("details")!.hasAttribute("open")).toBe(true);
  });
});

describe("group reason", () => {
  it("renders the worker's group reason as Markdown", async () => {
    const { api, job } = await setup(j => { j.groups[0]!.reason = "**同一修复**\n\n- 实现\n- 验证\n\n```ts\nabort();\n```"; }); open(api, job);
    const group = (await screen.findByRole("heading", { name: /1\. 补上请求取消/ })).closest("section")!;
    expect(group.querySelector(".assistant-answer strong")?.textContent).toBe("同一修复"); expect(group.querySelectorAll(".assistant-answer li")).toHaveLength(2); expect(group.querySelector(".assistant-answer pre code")?.textContent).toBe("abort();");
  });
});

describe("document visibility", () => {
  const setVisibility = (value: "hidden" | "visible") => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value }); document.dispatchEvent(new Event("visibilitychange")); };
  afterEach(() => { delete (document as unknown as Record<string, unknown>).visibilityState; });
  it("does not mark replies read while the document is hidden and confirms only the rendered seq once visible", async () => {
    const { api, state } = await setup(j => { j.conversation.messages = [message(1, "user", "问"), message(2, "worker", "答一")]; j.conversation.readSeq = 1; });
    const mark = vi.spyOn(api, "markLocalReviewRead").mockImplementation(async input => { const job = state.jobs[0]!; job.conversation.readSeq = Math.max(job.conversation.readSeq, input.seq); });
    setVisibility("hidden"); render(<LocalReviewPanel api={api} openJobId={state.jobs[0]!.id} />);
    await screen.findByText("答一");
    state.jobs[0]!.conversation.messages.push(message(3, "worker", "后台回复")); state.jobs[0]!.conversation.nextSeq = 4;
    expect(await screen.findByText("后台回复", {}, { timeout: 4000 })).toBeTruthy();
    expect(mark).not.toHaveBeenCalled(); expect(screen.getByLabelText("2 条未读回复")).toBeTruthy();
    setVisibility("visible");
    await waitFor(() => expect(mark).toHaveBeenCalledTimes(1)); expect(mark.mock.calls[0]![0].seq).toBe(3);
  });
});
