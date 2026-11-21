// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPreviewApi } from "../src/renderer/preview-api.js";
import { LocalReviewPanel } from "../src/renderer/components/pages/local-review/LocalReviewPanel.js";

beforeEach(() => { window.history.replaceState({}, "", "/?preview=local-review"); });
afterEach(() => { cleanup(); localStorage.clear(); window.history.replaceState({}, "", "/"); });
describe("local review page", () => {
  it("shows possible launchd additions with full labels and the host-activity caveat",async()=>{
    const api=createPreviewApi(), state=await api.getLocalReviewState();state.jobs[0]!.possibleLaunchdLabels=["synthetic.ui.label.<escaped>"];
    vi.spyOn(api,"getLocalReviewState").mockResolvedValue(state);render(<LocalReviewPanel api={api}/>);
    fireEvent.click(await screen.findByRole("tab",{name:/后台任务（1）/}));
    const alert=screen.getByRole("alert");expect(alert.textContent).toContain("可能");expect(alert.textContent).toContain("宿主正常活动");expect(within(alert).getByText("synthetic.ui.label.<escaped>")).toBeTruthy();expect(alert.querySelector("escaped")).toBeNull();
  });
  it("opens the inline editor under its line, focuses it, rejects empty text and cancels with Escape", async () => {
    const api = createPreviewApi(), save = vi.spyOn(api, "saveLocalReviewAnnotation");
    render(<LocalReviewPanel api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "在第 1 行新增意见" }));
    const editor = screen.getByRole("textbox", { name: "新增意见 L1" });
    expect(editor.closest("li")?.getAttribute("data-line")).toBe("1"); expect(document.activeElement).toBe(editor);
    expect(screen.getByRole("button", { name: "保存意见" })).toHaveProperty("disabled", true);
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true }); expect(save).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: "Escape" }); expect(screen.queryByRole("textbox", { name: "新增意见 L1" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "第 1 行行号" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" })); expect(save).not.toHaveBeenCalled();
  });
  it("preserves unsaved text when another line is clicked and extends its selected range with Shift", async () => {
    const api = createPreviewApi(), save = vi.spyOn(api, "saveLocalReviewAnnotation");
    render(<LocalReviewPanel api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "标注第 1 行" }));
    fireEvent.change(screen.getByRole("textbox", { name: "新增意见 L1" }), { target: { value: "保留这段未保存内容" } });
    fireEvent.click(screen.getByRole("button", { name: "标注第 3 行" }));
    expect(screen.getByRole("textbox", { name: "新增意见 L1" })).toHaveProperty("value", "保留这段未保存内容");
    fireEvent.click(screen.getByRole("button", { name: "标注第 3 行" }), { shiftKey: true });
    const editor = screen.getByRole("textbox", { name: "新增意见 L1–3" });
    expect(editor.closest("li")?.getAttribute("data-line")).toBe("3");
    expect(document.querySelectorAll(".local-review-file-lines li[data-selected]")).toHaveLength(3);
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ startLine: 1, endLine: 3, body: "保留这段未保存内容" })));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: /新增意见/ })).toBeNull());
    expect(screen.getByRole("complementary", { name: "意见 L1–3" }).closest("li")?.getAttribute("data-line")).toBe("3");
  });
  it("edits and deletes a saved annotation directly on its card", async () => {
    const api = createPreviewApi(), save = vi.spyOn(api, "saveLocalReviewAnnotation"), remove = vi.spyOn(api, "removeLocalReviewAnnotation");
    const id = (await api.getLocalReviewState()).sessions[0]!.annotations[0]!.id;
    render(<LocalReviewPanel api={api} />);
    const card = await screen.findByRole("complementary", { name: "意见 L2–2" });
    fireEvent.click(within(card).getByRole("button", { name: "编辑意见" }));
    const editor = screen.getByRole("textbox", { name: "编辑意见 L2" });
    expect(editor.closest("li")?.getAttribute("data-line")).toBe("2");
    fireEvent.change(editor, { target: { value: "补充取消边界" } }); fireEvent.click(screen.getByRole("button", { name: "保存意见" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ annotationId: id, body: "补充取消边界" })));
    const saved = await screen.findByRole("complementary", { name: "意见 L2–2" });
    fireEvent.click(within(saved).getByRole("button", { name: "删除意见" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(expect.objectContaining({ annotationId: id })));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "意见 L2–2" })).toBeNull());
  });
  it("places split diff widgets on their side, including unchanged context, and selects code cells", async () => {
    render(<LocalReviewPanel api={createPreviewApi()} />);
    await screen.findByRole("button", { name: "标注第 2 行" }); fireEvent.click(screen.getByRole("button", { name: "变更" }));
    fireEvent.click(screen.getByRole("button", { name: "标注旧版本第 1 行" }));
    let editor = screen.getByRole("textbox", { name: "新增意见 L1" });
    expect(editor.closest("[data-note-side]")?.getAttribute("data-note-side")).toBe("old");
    expect(editor.closest(".local-review-widget-pair")?.firstElementChild?.contains(editor)).toBe(true);
    fireEvent.keyDown(editor, { key: "Escape" });
    fireEvent.click(document.querySelector(".local-review-diff .diff-code-insert")!);
    editor = screen.getByRole("textbox", { name: "新增意见 L2" });
    const cell = editor.closest("td")!;
    expect(cell.getAttribute("colspan")).toBe("2"); expect(cell.parentElement?.lastElementChild).toBe(cell);
    fireEvent.keyDown(editor, { key: "Escape" }); fireEvent.click(screen.getByRole("button", { name: "单栏" }));
    expect(document.querySelector(".local-review-diff.diff-unified")).not.toBeNull();
  });
  it("keeps a single editor across tabs and folds both workspace sidebars", async () => {
    render(<LocalReviewPanel api={createPreviewApi()} />);
    fireEvent.click(await screen.findByRole("button", { name: "标注第 1 行" }));
    fireEvent.change(screen.getByRole("textbox", { name: "新增意见 L1" }), { target: { value: "跨标签保留" } });
    fireEvent.click(screen.getByRole("tab", { name: /后台任务（1）/ }));
    expect(screen.getByRole("button", { name: "审阅风险改动" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "新增意见 L1" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "审阅" }));
    expect(screen.getByRole("textbox", { name: "新增意见 L1" })).toHaveProperty("value", "跨标签保留");
    const collapseFiles = screen.getByRole("button", { name: "收起文件树" });
    expect(collapseFiles.textContent).toBe(""); expect(collapseFiles.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("separator", { name: "调整文件栏宽度" }).getAttribute("aria-valuenow")).toBe("300");
    fireEvent.click(collapseFiles);
    expect(screen.queryByRole("separator", { name: "调整文件栏宽度" })).toBeNull();
    expect(screen.getByRole("button", { name: "展开文件树" }).getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "展开文件树" }));
    const collapseNotes = screen.getByRole("button", { name: "收起意见栏" });
    expect(collapseNotes.textContent).toBe(""); expect(collapseNotes.querySelector("svg")).not.toBeNull();
    fireEvent.click(collapseNotes);
    expect(screen.queryByRole("button", { name: /提交 1 条意见/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开意见栏" }));
    expect(screen.getByRole("button", { name: /提交 1 条意见/ })).toHaveProperty("disabled", true);
  });
  it("folds the opinions rail by default in a minimum window and keeps the disclosure reachable", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    try {
      render(<LocalReviewPanel api={createPreviewApi()} />);
      expect(await screen.findByRole("button", { name: "展开意见栏" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "展开意见栏" }));
      expect(screen.getByText(/完整 Git 历史/)).toBeTruthy();
    } finally { vi.unstubAllGlobals(); }
  });
  it("keeps saved notes per file and opens a draft-list entry at its inline location", async () => {
    const api = createPreviewApi(), state = await api.getLocalReviewState(), original = await api.loadLocalReviewFiles({ repositoryId: state.repositories[0]!.id, sessionId: state.sessions[0]!.id });
    vi.spyOn(api, "loadLocalReviewFiles").mockResolvedValue({ ...original, files: [...original.files, { ...original.files[0]!, path: "src/other.ts" }] });
    render(<LocalReviewPanel api={api} />);
    await screen.findByRole("complementary", { name: "意见 L2–2" });
    fireEvent.click(screen.getByRole("button", { name: "src/other.ts" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "意见 L2–2" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "src/request.ts:2–2" }));
    const editor = await screen.findByRole("textbox", { name: "编辑意见 L2" });
    expect(editor.closest("li")?.getAttribute("data-line")).toBe("2");
    expect(editor).toHaveProperty("value", "请求需要超时保护，超时后应取消上游连接。");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(await screen.findByRole("complementary", { name: "意见 L2–2" })).toBeTruthy();
  });
  it("updates the task tab count as background work changes state", async () => {
    const api = createPreviewApi(), state = await api.getLocalReviewState();
    state.jobs[0]!.state = "running_groups"; vi.spyOn(api, "getLocalReviewState").mockResolvedValue(state);
    const { rerender } = render(<LocalReviewPanel api={api} />);
    expect(await screen.findByRole("tab", { name: /后台任务（1）进行中 1/ })).toBeTruthy();
    const next = structuredClone(state); next.jobs[0]!.state = "finished"; next.jobs[0]!.groups[0]!.state = "pr_opened";
    const changed = { ...api, getLocalReviewState: async () => next };
    rerender(<LocalReviewPanel api={changed} />);
    expect(await screen.findByRole("tab", { name: /后台任务（1）已结束 1/ })).toBeTruthy();
  });
  it("opens a saved new-side note outside the diff in the full file", async () => {
    const api = createPreviewApi(), state = await api.getLocalReviewState();
    const source = state.sessions[0]!.annotations[0]!;
    state.sessions[0]!.annotations.push({ ...source, id: "tail-note", startLine: 25, endLine: 25, body: "完整文件尾部的意见" });
    vi.spyOn(api, "getLocalReviewState").mockResolvedValue(state);
    const files = await api.loadLocalReviewFiles({ repositoryId: state.repositories[0]!.id, sessionId: state.sessions[0]!.id });
    vi.spyOn(api, "loadLocalReviewFiles").mockResolvedValue({ ...files, diff: "diff --git a/src/request.ts b/src/request.ts\n--- a/src/request.ts\n+++ b/src/request.ts\n@@ -1,3 +1,3 @@\n export async function request(url: string) {\n-  return fetch(url);\n+  return fetch(url);\n }\n" });
    render(<LocalReviewPanel api={api} />); await screen.findByRole("button", { name: "标注第 2 行" });
    fireEvent.click(screen.getByRole("button", { name: "变更" }));
    fireEvent.click(screen.getByRole("button", { name: "src/request.ts:25–25" }));
    const editor = await screen.findByRole("textbox", { name: "编辑意见 L25" });
    expect(editor.closest("li")?.getAttribute("data-line")).toBe("25");
    expect(editor).toHaveProperty("value", "完整文件尾部的意见");
  });
  it("focuses the editor when Shift selection extends upwards without changing its end line", async () => {
    render(<LocalReviewPanel api={createPreviewApi()} />);
    fireEvent.click(await screen.findByRole("button", { name: "标注第 3 行" }));
    const first = screen.getByRole("button", { name: "第 1 行行号" }); first.focus();
    fireEvent.click(first, { shiftKey: true });
    const editor = screen.getByRole("textbox", { name: "新增意见 L1–3" });
    expect(editor.closest("li")?.getAttribute("data-line")).toBe("3");
    expect(document.activeElement).toBe(editor);
  });
  it("remembers the explicit worker, filters model profiles and enables the matching Claude native choice", async () => {
    const api = createPreviewApi(), profiles = await api.listModelProviderProfiles(), codex = profiles.find(profile => profile.kind === "codex-cli")!;
    vi.spyOn(api, "listModelProviderProfiles").mockResolvedValue([
      { version: 1, profileId: "builtin-apple", kind: "apple", label: "Apple default", enabled: true, priority: 0, timeoutMs: 1000, credentialConfigured: false },
      { version: 1, profileId: "decision-only", kind: "openrouter-decisions", label: "Judgment only", enabled: true, priority: 0, timeoutMs: 1000, credentialConfigured: true },
      codex, { ...codex, profileId: "claude-model", kind: "claude-code-cli", label: "Claude model", model: "sonnet" },
      { version: 1, profileId: "http-model", kind: "openai-compatible", label: "HTTP model", model: "example", enabled: true, priority: 1, timeoutMs: 1000, baseUrl: "https://model.example/v1", apiProtocol: "chat-completions", credentialConfigured: true },
    ]);
    const save = vi.spyOn(api, "saveLocalReviewSettings");
    render(<LocalReviewPanel api={api} />); await screen.findByRole("button", { name: "标注第 2 行" });
    const profilesField = screen.getByRole("combobox", { name: "模型档案" });
    expect(within(profilesField).queryByRole("option", { name: /HTTP model/ })).toBeNull();
    expect(screen.getByRole("option", { name: "Claude Code CLI" })).toHaveProperty("disabled", false);
    fireEvent.change(screen.getByRole("combobox", { name: "执行方式" }), { target: { value: "pi" } });
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ settings: expect.objectContaining({ worker: "pi" }) })));
    await waitFor(() => expect(within(profilesField).getByRole("option", { name: /HTTP model/ })).toBeTruthy());
    expect(within(profilesField).getByRole("option", { name: /Claude model/ })).toBeTruthy();
    expect(within(profilesField).queryByRole("option", { name: /Apple default|Judgment only/ })).toBeNull();
    expect((profilesField as HTMLSelectElement).value).not.toBe("builtin-apple");
    expect(screen.getByText(/Pi 由 Paraself 执行工具/)).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "执行方式" }), { target: { value: "claude-code" } });
    await waitFor(()=>expect((profilesField as HTMLSelectElement).value).toBe("claude-model"));
    expect(within(profilesField).queryByRole("option",{name:/HTTP model/})).toBeNull();
    expect(screen.getByText(/钥匙串服务可达、隔离未验证，建议只用于信任的工程/)).toBeTruthy();
  });
  it("shows excluded undeclared files in a group result", async () => {
    const api = createPreviewApi(), state = await api.getLocalReviewState(), job = state.jobs[0]!;
    job.groups[0]!.excludedFiles = ["Library/Caches/generated.bin"];
    vi.spyOn(api, "getLocalReviewState").mockResolvedValue(state);
    render(<LocalReviewPanel api={api} openJobId={job.id} />);
    expect(await screen.findByText("未提交的未声明文件 · 1")).toBeTruthy();
    expect(screen.getByText("Library/Caches/generated.bin")).toBeTruthy();
  });
  it("pins both revisions, explains excluded edits and shows the disclosure before submission", async () => {
    render(<LocalReviewPanel api={createPreviewApi()} />);
    await screen.findByRole("button", { name: "标注第 2 行" });
    expect(screen.getByText(/HEAD aaaaaaaa/)).toBeTruthy();
    expect(screen.getByText(/工作区有未提交改动，不在审阅范围内/)).toBeTruthy();
    expect(screen.getByText(/完整 Git 历史/)).toBeTruthy();
    expect(screen.getByText(/推送目标：/)).toBeTruthy();
  });
  it("saves a multi-line annotation through IDs and relative paths", async () => {
    const api = createPreviewApi(), save = vi.spyOn(api, "saveLocalReviewAnnotation");
    render(<LocalReviewPanel api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "标注第 2 行" }));
    fireEvent.click(screen.getByRole("button", { name: "标注第 3 行" }), { shiftKey: true });
    fireEvent.change(screen.getByRole("textbox", { name: /新增意见/ }), { target: { value: "请在结束路径中取消请求。" } });
    fireEvent.click(screen.getByRole("button", { name: "保存意见" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ path: "src/request.ts", startLine: 2, endLine: 3, side: "new", body: "请在结束路径中取消请求。" })));
    expect(save.mock.calls[0]![0]).not.toHaveProperty("repositoryPath");
  });
  it("anchors deleted lines to the old side in the change view", async () => {
    const api = createPreviewApi(), save = vi.spyOn(api, "saveLocalReviewAnnotation");
    render(<LocalReviewPanel api={api} />);
    await screen.findByRole("button", { name: "标注第 2 行" });
    fireEvent.click(screen.getByRole("button", { name: "变更" }));
    fireEvent.click(await screen.findByRole("button", { name: "标注旧版本第 2 行" }));
    fireEvent.change(screen.getByRole("textbox", { name: /新增意见/ }), { target: { value: "旧实现也需要解释迁移原因。" } });
    fireEvent.click(screen.getByRole("button", { name: "保存意见" }));
    await waitFor(() => expect(save.mock.calls[0]![0].side).toBe("old"));
  });
  it("keeps annotations in the draft when preflight refuses the CLI", async () => {
    const api = createPreviewApi(); vi.spyOn(api, "submitLocalReview").mockRejectedValue(new Error("读限制能力探测失败"));
    render(<LocalReviewPanel api={api} />);
    const submit = await screen.findByRole("button", { name: "提交 1 条意见" });
    await waitFor(() => expect(submit).toHaveProperty("disabled", false));
    fireEvent.click(submit);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "读限制能力探测失败");
    expect((await api.getLocalReviewState()).sessions[0]!.annotations).toHaveLength(1);
  });
  it("shows only file/line findings and offers no ordinary approval for secret-blocked artifacts", async () => {
    const api=createPreviewApi(),state=await api.getLocalReviewState(),job=state.jobs[0]!,group=job.groups[0]!,secret="sk-ant-synthetic-only";
    for(const other of job.groups)other.state="no_changes";
    group.state="blocked";group.retryable=false;group.artifact!.secretFindings=[{path:"src/config.json",line:17}];group.artifact!.diff=secret;
    if(group.fix){group.fix.verification=secret;group.fix.outcomes=group.fix.outcomes.map(o=>({...o,summary:secret}));}
    vi.spyOn(api,"getLocalReviewState").mockResolvedValue(state);
    render(<LocalReviewPanel api={api} openJobId={job.id}/>);
    await screen.findByRole("button",{name:"丢弃本地产物"});
    expect(await screen.findByText("src/config.json:17")).toBeTruthy();expect(screen.getByText("敏感形态阻止推送")).toBeTruthy();expect(document.body.textContent).not.toContain(secret);
    expect(screen.queryByRole("button",{name:"审阅风险改动"})).toBeNull();expect(screen.queryByRole("button",{name:"仍然推送"})).toBeNull();
    expect(screen.queryByRole("button",{name:"重试此组"})).toBeNull();expect(screen.getByRole("button",{name:"丢弃本地产物"})).toBeTruthy();
  });
  it("only authorizes after the immutable diff, target and risk paths are shown", async () => {
    const api = createPreviewApi(), action = vi.spyOn(api, "actOnLocalReview");
    const job = (await api.getLocalReviewState()).jobs[0]!;
    render(<LocalReviewPanel api={api} openJobId={job.id} />);
    fireEvent.click(await screen.findByRole("button", { name: "审阅风险改动" }));
    expect(action).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog", { name: "高风险改动" });
    expect(dialog.textContent).toContain(job.pushUrl); expect(dialog.textContent).toContain(job.groups[0]!.artifact!.commitOid);
    fireEvent.click(screen.getByRole("button", { name: "仍然推送" }));
    await waitFor(() => expect(action).toHaveBeenCalledWith({ repositoryId: job.repositoryId, jobId: job.id, groupId: job.groups[0]!.id, action: "approve", authorization: { groupId: job.groups[0]!.id, commitOid: job.groups[0]!.artifact!.commitOid, risks: [".github/workflows/test.yml"], pushUrl: job.pushUrl } }));
  });
  it("preserves typed reviewer separators until saving and retains username case", async () => {
    const api = createPreviewApi(), save = vi.spyOn(api, "saveLocalReviewSettings");
    render(<LocalReviewPanel api={api} />);
    await screen.findByRole("button", { name: "标注第 2 行" });
    fireEvent.click(screen.getByRole("button", { name: "工程设置" }));
    const field = screen.getByRole("textbox", { name: "审阅人（逗号分隔）" });
    fireEvent.change(field, { target: { value: "Tomorrow, Yuan.Wang" } });
    fireEvent.click(screen.getByRole("button", { name: "保存工程设置" }));
    await waitFor(() => expect(save.mock.calls[0]![0].settings.reviewers).toEqual(["Tomorrow", "Yuan.Wang"]));
  });
  it("saves dependency argv as separate arguments, script control and clears project cache", async () => {
    const api=createPreviewApi(), save=vi.spyOn(api,"saveLocalReviewSettings"),clear=vi.spyOn(api,"clearLocalReviewDependencies");
    render(<LocalReviewPanel api={api}/>);await screen.findByRole("button",{name:"标注第 2 行"});fireEvent.click(screen.getByRole("button",{name:"工程设置"}));
    expect((screen.getByRole("combobox",{name:"依赖安装"}) as HTMLSelectElement).value).toBe("auto");expect(screen.getByText(/目前仅支持 Node 工程/)).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox",{name:"依赖安装"}),{target:{value:"custom"}});
    fireEvent.change(screen.getByRole("textbox",{name:"安装 argv（一行一个参数）"}),{target:{value:"npm\nci\n--no-audit"}});
    fireEvent.change(screen.getByRole("textbox",{name:"缓存键文件（一行一个相对路径）"}),{target:{value:"package-lock.json\npackage.json"}});
    fireEvent.click(screen.getByRole("checkbox",{name:"允许安装脚本"}));
    fireEvent.click(screen.getByRole("button",{name:"保存工程设置"}));
    await waitFor(()=>expect(save).toHaveBeenCalledWith(expect.objectContaining({settings:expect.objectContaining({dependencies:{mode:"custom",argv:["npm","ci","--no-audit"],files:["package-lock.json","package.json"],allowScripts:false}})})));
    fireEvent.click(screen.getByRole("button",{name:"工程设置"}));fireEvent.click(screen.getByRole("button",{name:"清除依赖缓存"}));await waitFor(()=>expect(clear).toHaveBeenCalledTimes(1));
  });
  it("shows preparing dependencies, cancellation and installation logs", async () => {
    const api=createPreviewApi(), state=await api.getLocalReviewState(),job=state.jobs[0]!;job.state="preparing_dependencies";job.dependencies={summary:"正在准备依赖",log:"npm ci: synthetic install log"};vi.spyOn(api,"getLocalReviewState").mockResolvedValue(state);
    render(<LocalReviewPanel api={api} openJobId={job.id}/>);expect(await screen.findByRole("button",{name:"取消任务"})).toBeTruthy();expect(screen.getByText("依赖安装日志 · 正在准备依赖")).toBeTruthy();expect(screen.getByText("npm ci: synthetic install log")).toBeTruthy();
  });

});
