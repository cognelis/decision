// Capture a PNG of a renderer preview surface with offscreen Electron.
//
//   npm run preview:capture -- <preview> <out.png> [action] [theme]
//
//   preview : dashboard | first-run | decisions | assistant | methodology |
//             clients | models | activity | settings | candidate | rationale |
//             panel
//   action  : none (default) | help | quick-jump | journal | decision-detail | decision-review-date |
//             decision-detail-bottom |
//             pending-dialog | pending-dialog-bottom | scroll-bottom | tile-focus | assistant-hover | model-hover | assistant-library | assistant-sources | assistant-question
//   theme   : light (default) | dark
//
// The page is served by the same Vite renderer config the layout checks use,
// with the in-memory preview API, so nothing touches real user data.
const { app, BrowserWindow } = require("electron");
const { writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const repositoryRoot = resolve(__dirname, "..");
const [preview = "dashboard", out, action = "none", theme = "light", size = "1160x760"] =
  process.argv.slice(2);
const [width, height] = size.split("x").map(Number);
if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
  throw new Error(`Invalid preview size: ${size}`);
}

if (out === undefined) {
  console.error("Usage: capture-preview.cjs <preview> <out.png> [action] [theme]");
  app.exit(2);
}

const ACTIONS = {
  none: "",
  "sidebar-expanded": `document.querySelector('[aria-label="展开菜单栏"]')?.click();`,
  "sidebar-collapsed": `
    const collapse = document.querySelector('[aria-label="收起菜单栏"]');
    if (collapse) collapse.click();
    await new Promise(resolve => setTimeout(resolve, 100));
    const rail = document.querySelector('.desktop-sidebar').getBoundingClientRect();
    if (rail.width > 60) throw new Error('Sidebar did not collapse');
    document.querySelector('.desktop-navigation [aria-label="问答"]').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  `,
  switches: "",
  "record-idea": `
    [...document.querySelectorAll("button")].find(item => item.textContent.trim() === "主动记录").click();
    await new Promise(resolve => setTimeout(resolve, 100));
    [...document.querySelectorAll(".active-record-kinds button")].find(item => item.textContent.trim() === "想法").click();
    await new Promise(resolve => setTimeout(resolve, 60));
    const title = document.querySelector('[aria-label="标题"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(title, "新想法保存后应该直接可见");
    title.dispatchEvent(new Event("input", { bubbles: true }));
    const content = document.querySelector('[aria-label="想法内容"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(content, "先记录，再补充适用条件。");
    content.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 80));
    document.querySelector('.active-record-form button[type="submit"]').click();
    await new Promise(resolve => setTimeout(resolve, 350));
    const saved = document.querySelector('.journal-entry-card[aria-current="true"]');
    if (!saved || !saved.textContent.includes("新想法保存后应该直接可见")) throw new Error("Saved journal entry was not highlighted");
  `,
  "clarify-journal": `
    [...document.querySelectorAll("button")].find(item => item.textContent.trim() === "偏好与想法").click();
    await new Promise(resolve => setTimeout(resolve, 250));
    const card = document.getElementById("journal-entry-idea-event-driven-cache");
    if (!card) throw new Error("Inbox idea missing");
    card.querySelector("button").click();
    await new Promise(resolve => setTimeout(resolve, 100));
    const fillJournal = async (name, value) => {
      const input = document.querySelector('[aria-label="' + name + '"]');
      const prototype = input.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, value);
      input.dispatchEvent(new Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 40));
    };
    await fillJournal("为什么值得保留", "减少缓存失效窗口，值得在一个服务中验证。");
    await fillJournal("下一步验证", "先用测试服务验证事件丢失时的回退行为。");
    await fillJournal("记录状态", "active");
    await fillJournal("变更原因", "补齐价值与验证方法，进入有效想法。");
  `,
  "schedule-record": `
    [...document.querySelectorAll("button")].find(item => item.textContent.trim() === "主动记录").click();
    await new Promise(resolve => setTimeout(resolve, 100));
    const fill = (name, value) => {
      const input = document.querySelector('[aria-label="' + name + '"]');
      const prototype = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    fill("标题", "安排一次上线后复盘");
    fill("最终选择", "先灰度一周，再决定是否扩大范围。");
    fill("预期结果", "一周内故障率不增加，再逐步扩大范围。");
    fill("复盘日期", "2026-10-01");
    await new Promise(resolve => setTimeout(resolve, 100));
  `,
  "schedule-edit": `
    [...document.querySelectorAll(".decision-library-row")][1]?.click();
    await new Promise(resolve => setTimeout(resolve, 200));
    const edit = [...document.querySelectorAll("button")].find(button => ["调整日期", "安排日期"].includes(button.textContent.trim()));
    if (!edit) throw new Error("Schedule action missing");
    edit.click();
    await new Promise(resolve => setTimeout(resolve, 100));
    document.querySelector(".decision-review-presets")?.scrollIntoView({ block: "center" });
  `,
  "continue-review": `
    const click = (text) => {
      const button = [...document.querySelectorAll("button")].find(item => item.textContent.trim() === text);
      if (!button) throw new Error("Missing button: " + text);
      button.click();
    };
    click("回填结果");
    await new Promise(resolve => setTimeout(resolve, 150));
    const input = document.querySelector(".dashboard-review-dialog-form textarea");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, "实际运行一周，读取延迟下降且没有新增故障。");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 100));
    click("保存并继续复盘");
    await new Promise(resolve => setTimeout(resolve, 300));
    if (!document.querySelector('[aria-label="完成复盘表单"]')) throw new Error("Did not continue to review");
    click("优于预期");
  `,
  "distill-decision": `
    const row = [...document.querySelectorAll(".decision-library-row")]
      .find(item => item.querySelector(".decision-review-badge"));
    if (!row) throw new Error("Reviewed decision missing");
    row.click();
    await new Promise(resolve => setTimeout(resolve, 150));
    const distill = [...document.querySelectorAll("button")].find(button => button.textContent.trim() === "用于提炼原则");
    if (!distill) throw new Error("Distillation entry missing");
    distill.click();
    await new Promise(resolve => setTimeout(resolve, 500));
    if (!document.querySelector(".methodology-source-list input:checked")) throw new Error("Source was not carried into picker");
    if (!document.body.textContent.includes("已选 1 / 5")) throw new Error("Source selection count incorrect");
  `,
  "pr-diff": `
    document.querySelector('.review-pr-item').click();
    const waitForDiff = async find => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) { const result = find(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 20)); }
      throw new Error('PR diff preview did not render');
    };
    (await waitForDiff(() => document.querySelector('[aria-label="查看 PR 详情"]'))).click();
    await waitForDiff(() => document.querySelector('.diff'));
  `,
  "pr-review": `
    const item = document.querySelector(".review-pr-item");
    if (!item) throw new Error("PR list missing");
    item.click();
    await new Promise(resolve => setTimeout(resolve, 100));
    const restart = [...document.querySelectorAll("button")].find(button => button.getAttribute("aria-label") === "重新评审最新提交");
    if (restart) {
      restart.click();
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    [...document.querySelectorAll("button")].find(button => button.textContent === "开始评审").click();
    await new Promise(resolve => setTimeout(resolve, 100));
    if (!document.querySelector(".review-finding") || !document.querySelector(".review-chat-messages")) throw new Error("Review result/process missing");
    document.querySelector(".review-chat-messages").scrollIntoView({ block: "center" });
  `,
  "pr-prepare": `
    document.querySelector(".review-pr-item").click();
    await new Promise(resolve => setTimeout(resolve, 150));
    if (!document.querySelector(".review-preparation")) throw new Error("Preparation view missing");
  `,
  "pr-scope": `
    document.querySelector(".review-pr-item").click();
    await new Promise(resolve => setTimeout(resolve, 150));
    const choose = [...document.querySelectorAll("button")].find(button => button.textContent === "选择文件");
    if (!choose) throw new Error("File choice missing: the snapshot needs two files with a diff");
    choose.click();
    await new Promise(resolve => setTimeout(resolve, 150));
  `,
  "find": `
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 100));
    const field = document.querySelector(".find-bar input");
    if (!field) throw new Error("Find bar missing");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field, "决策");
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 150));
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 150));
  `,
  "methodology-practice": `
    const tab = [...document.querySelectorAll("button, a")].find(element => element.textContent.trim() === "技能与流程");
    if (!tab) throw new Error("Practice tab missing");
    tab.click();
    await new Promise(resolve => setTimeout(resolve, 200));
  `,
  "methodology-analysis": `
    const tab = [...document.querySelectorAll("button, a")].find(element => element.textContent.trim() === "分析");
    if (!tab) throw new Error("Analysis tab missing");
    tab.click();
    await new Promise(resolve => setTimeout(resolve, 300));
  `,
  "methodology-graph": `
    const tab = [...document.querySelectorAll("button, a")].find(element => element.textContent.trim() === "图谱");
    if (!tab) throw new Error("Graph tab missing");
    tab.click();
    await new Promise(resolve => setTimeout(resolve, 400));
  `,
  "pr-batch": `
    document.querySelector(".review-pr-item").click();
    await new Promise(resolve => setTimeout(resolve, 100));
    [...document.querySelectorAll("button")].find(button => button.textContent === "开始评审").click();
    await new Promise(resolve => setTimeout(resolve, 200));
    const batch = [...document.querySelectorAll("button")].find(button => button.textContent.startsWith("批量发布为 PR 评论"));
    if (!batch) throw new Error("Batch publishing missing: the report needs two findings");
    batch.click();
    await new Promise(resolve => setTimeout(resolve, 200));
  `,
  "pr-finding-diff": `
    document.querySelector(".review-pr-item").click();
    await new Promise(resolve => setTimeout(resolve, 100));
    [...document.querySelectorAll("button")].find(button => button.textContent === "开始评审").click();
    await new Promise(resolve => setTimeout(resolve, 150));
    const location = document.querySelector(".review-finding-location");
    if (!location) throw new Error("Finding location missing");
    location.click();
    const deadline = Date.now() + 10000;
    while (!document.querySelector(".pr-diff-toolbar") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    await new Promise(resolve => setTimeout(resolve, 150));
  `,
  "pr-reevaluate": `
    document.querySelector(".review-pr-item").click();
    await new Promise(resolve => setTimeout(resolve, 100));
    [...document.querySelectorAll("button")].find(button => button.textContent === "开始评审").click();
    await new Promise(resolve => setTimeout(resolve, 150));
    const recheck = [...document.querySelectorAll(".review-finding-actions button")].find(button => button.textContent === "复评");
    if (!recheck) throw new Error("Re-evaluate action missing");
    recheck.click();
    await new Promise(resolve => setTimeout(resolve, 150));
    document.querySelector(".review-finding-verdict")?.scrollIntoView({ block: "center" });
  `,
  // Seeds two reviews of one PR on other commits before the review page mounts, then opens the newer.
  "pr-previous": `
    const files = [{ path: "src/request.ts", status: "modified" }, { path: "src/retry.ts", status: "modified" }];
    const snapshot = (commit, retry) => ({ snapshotId: "00000000-0000-4000-8000-0000000000e1", reference: "sample/app#123", title: "示例：调整请求超时", description: "为请求添加超时保护。", project: "sample/app",
      sourceCommit: commit.repeat(40), destinationCommit: "b".repeat(40), files, warnings: [], fileDigests: { "src/request.ts": "1".repeat(16), "src/retry.ts": retry.repeat(16) } });
    const finding = (priority, title, path, line) => ({ priority, title, body: title + "。", path, side: "new", line, decisionIndexes: [] });
    const report = (findings) => ({ status: "completed", summary: "预览：重新评审。", findings, evidence: [], readFiles: ["src/request.ts", "src/retry.ts"], unreadFiles: [], reviewedFiles: ["src/request.ts", "src/retry.ts"], unreviewedFiles: [], warnings: [], steps: 2, history: [] });
    const base = { kind: "review", model: "本机", focus: "", draft: "", turns: [], events: [], state: "finished", error: "", verdicts: [], connectionId: "00000000-0000-4000-8000-000000000011" };
    localStorage.setItem("decision.pr-review.history.v1", JSON.stringify([
      { ...base, id: "00000000-0000-4000-8000-0000000000e3", at: "2026-09-30T10:00:00.000Z", snapshot: snapshot("a", "3"), published: [],
        report: report([finding("P2", "超时后请求仍在运行", "src/request.ts", 14), finding("P3", "日志里缺少请求 ID", "src/request.ts", 20)]),
        rechecks: [{ run: "00000000-0000-4000-8000-0000000000e2", finding: 1, verdict: "drop", reason: "第 30 行已加上最多 5 次的上限，并在每次重试前等待。", replacement: null, at: "2026-09-30T10:05:00.000Z", model: "本机" }] },
      { ...base, id: "00000000-0000-4000-8000-0000000000e2", at: "2026-09-29T10:00:00.000Z", snapshot: snapshot("c", "2"), rechecks: [], published: [{ finding: 1, at: "2026-09-29T11:00:00.000Z" }],
        report: report([finding("P2", "超时后请求仍在运行", "src/request.ts", 12), finding("P2", "重试没有上限", "src/retry.ts", 30), finding("P3", "重试间隔没有抖动", "src/retry.ts", 34)]) },
    ]));
    document.querySelector('.desktop-navigation [aria-label="评审"]').click();
    const wait = async (find) => { const deadline = Date.now() + 10000; while (Date.now() < deadline) { const found = find(); if (found) return found; await new Promise(resolve => setTimeout(resolve, 30)); } throw new Error("Previous review capture: element missing"); };
    (await wait(() => [...document.querySelectorAll(".review-list-tabs button")].find(button => button.textContent.includes("历史评审")))).click();
    (await wait(() => document.querySelector('.review-pr-item[data-run-id="00000000-0000-4000-8000-0000000000e3"]'))).click();
    const section = await wait(() => document.querySelector(".review-previous"));
    section.open = true;
    await new Promise(resolve => setTimeout(resolve, 150));
    section.scrollIntoView({ block: "center" });
  `,
  "pr-discussion": `
    document.querySelector(".review-pr-item").click();
    const deadline = Date.now() + 10000;
    let open;
    while (!(open = [...document.querySelectorAll("button")].find(button => button.textContent.trim() === "PR 讨论")) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
    if (!open) throw new Error("PR discussion entry missing");
    open.click();
    while (!document.querySelector(".pr-discussion-list") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
    await new Promise(resolve => setTimeout(resolve, 150));
  `,
  "pr-comment": `
    document.querySelector(".review-pr-item").click();
    await new Promise(resolve => setTimeout(resolve, 100));
    [...document.querySelectorAll("button")].find(button => button.textContent === "开始评审").click();
    await new Promise(resolve => setTimeout(resolve, 150));
    const draft = [...document.querySelectorAll(".review-finding-actions button")].find(button => button.textContent === "转为评论");
    if (!draft) throw new Error("Draft action missing");
    draft.click();
    await new Promise(resolve => setTimeout(resolve, 150));
  `,
  "pr-comment-preview": `
    document.querySelector(".review-pr-item").click();
    await new Promise(resolve => setTimeout(resolve, 100));
    [...document.querySelectorAll("button")].find(button => button.textContent === "开始评审").click();
    await new Promise(resolve => setTimeout(resolve, 150));
    [...document.querySelectorAll(".review-finding-actions button")].find(button => button.textContent === "转为评论").click();
    await new Promise(resolve => setTimeout(resolve, 150));
    const field = document.querySelector('[aria-label="评论内容"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, field.value + "\\n\\n建议：\\n\\n- 把 \`AbortSignal\` 传给 \`fetch\`\\n- 在 \`finally\` 里清理计时器\\n\\n> 超时只拒绝了 Promise。");
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 60));
    [...document.querySelectorAll(".pr-diff-modes button")].find(button => button.textContent === "预览").click();
    await new Promise(resolve => setTimeout(resolve, 100));
    if (!document.querySelector(".pr-comment-preview li")) throw new Error("Preview did not render the list");
  `,
  "assistant-hover": "",
  "assistant-question": `
    (() => {
      const bubble = document.querySelector(".assistant-turn.user");
      const text = bubble.querySelector("p");
      text.textContent = "PascalCase相关的决策";
      const short = bubble.getBoundingClientRect();
      if (short.height > 44) throw new Error("Short question bubble is too tall: " + short.height);
      text.textContent = "长问题换行验证 PascalCase ".repeat(24);
      const long = bubble.getBoundingClientRect();
      const edit = bubble.querySelector("button").getBoundingClientRect();
      if (long.height <= short.height || bubble.scrollWidth > bubble.clientWidth + 1 || edit.top > long.top + 12) throw new Error("Long question layout regression");
      text.textContent = "PascalCase相关的决策";
      document.querySelector(".assistant-stream").scrollTop = 0;
    })();
  `,
  "model-hover": "",
  "deepseek-pricing": `
    document.querySelector('[aria-label="编辑 DeepSeek"]')?.click();
    await new Promise(resolve => setTimeout(resolve, 100));
    const model = document.querySelector('input[aria-label="模型"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(model, "deepseek-flash");
    model.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 100));
    document.querySelector('[aria-label="填入 DeepSeek Flash 参考价格"]')?.click();
    await new Promise(resolve => setTimeout(resolve, 100));
    document.querySelector(".provider-pricing-fields")?.scrollIntoView({ block: "center" });
  `,
  "qwen-settings": `document.querySelector('[aria-label="配置 Qwen 本地模型"]')?.click(); await new Promise(resolve => setTimeout(resolve, 300));`,
  "trace-failure": `document.querySelector('.model-trace-list .model-trace-row button')?.click();`,
  "assistant-library": "",
  "assistant-sources": `document.querySelector('[aria-label="材料范围"]').click();`,
  help: `document.querySelector(".desktop-help-sheet")?.click();`,
  "quick-jump": `document.querySelector(".desktop-quick-jump")?.click();`,
  journal: `[...document.querySelectorAll("button")]
    .find((button) => button.textContent?.trim() === "偏好与想法")?.click();`,
  "decision-detail": `[...document.querySelectorAll(".decision-library-row")]
    .find((row) => row.querySelector(".decision-review-badge"))?.click();`,
  "decision-review-date": `document.querySelector(".decision-library-row")?.click();
    await new Promise(resolve => setTimeout(resolve, 300));
    const schedule = () => [...document.querySelectorAll(".modal-dialog button")]
      .find((button) => ["安排日期", "调整日期"].includes(button.textContent?.trim()));
    for (let step = 0; step < 12 && !schedule(); step += 1) {
      document.querySelector('[aria-label="下一条决策"]')?.click();
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!schedule()) throw new Error("No decision offers a review date");
    schedule().click();
    await new Promise(resolve => setTimeout(resolve, 150));
    document.querySelector("#decision-review-due-date").scrollIntoView({ block: "center" });`,
  "decision-detail-bottom": `[...document.querySelectorAll(".decision-library-row")]
    .find((row) => row.querySelector(".decision-review-badge"))?.click();
    setTimeout(() => {
      for (const element of document.querySelectorAll(".modal-dialog-body")) {
        element.scrollTop = 1e6;
      }
    }, 300);`,
  "review-outcome": `[...document.querySelectorAll("button")]
    .find((button) => button.textContent?.trim() === "回填结果")?.click();`,
  "postpone-review": `
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "回填结果")?.click();
    await new Promise(resolve => setTimeout(resolve, 150));
    [...document.querySelectorAll(".dashboard-review-postpone button")]
      .find((button) => button.textContent?.trim() === "一周后")?.click();
  `,
  "pending-dialog": `[...document.querySelectorAll("button")]
    .find((button) => button.textContent?.trim() === "补充理由")?.click();`,
  "pending-dialog-bottom": `[...document.querySelectorAll("button")]
    .find((button) => button.textContent?.trim() === "补充理由")?.click();
    setTimeout(() => {
      for (const element of document.querySelectorAll(".modal-dialog-body, .modal-dialog")) {
        element.scrollTop = 1e6;
      }
    }, 200);`,
  "scroll-bottom": `for (const element of document.querySelectorAll(
      ".decision-workspace, .modal-dialog-body, .modal-dialog, .desktop-page-scroll"
    )) {
      element.scrollTop = 1e6;
    }`,
  "tile-focus": `document.querySelector(".dashboard-summary-item.interactive")?.focus();`,
  // 候选列表现在画在页面里，所以它能被截到；原生菜单截不到。
  "select-open": `(() => {
    const select = document.querySelector("select");
    if (!select) throw new Error("No select on this surface");
    select.scrollIntoView({ block: "center" });
  })();`,
};

/** Actions that drive a multi-step flow need longer than the default settle. */
ACTIONS["pr-diff-split"] = ACTIONS["pr-diff"] + `
  [...document.querySelectorAll('button')].find(button => button.textContent === 'Side-by-Side').click();
`;
ACTIONS["pr-diff-file"] = ACTIONS["pr-diff"] + `
  [...document.querySelectorAll('button')].find(button => button.textContent === '文件内容').click();
  await new Promise(resolve => setTimeout(resolve, 150));
  if (!document.querySelector('.pr-file-lines')) throw new Error('File content missing');
`;

// The preparation page scrolled to its end: the mode picker and what goes with it.
ACTIONS["pr-prepare-bottom"] = ACTIONS["pr-prepare"] + `
    const body = document.querySelector(".review-preparation-body");
    body.scrollTop = body.scrollHeight;
    await new Promise(resolve => setTimeout(resolve, 100));
`;
ACTIONS["pr-merge-confirm"] = ACTIONS["pr-review"] + `
  [...document.querySelectorAll('.pr-platform-actions button')].find(button => button.textContent === 'Merge').click();
  await new Promise(resolve => setTimeout(resolve, 150));
  if (!document.querySelector('.pr-action-branches')) throw new Error('Merge confirmation missing');
`;

ACTIONS["pr-review-history"] = ACTIONS["pr-review"] + `
  [...document.querySelectorAll('.review-list-tabs button')].find(button => button.textContent.includes('历史评审')).click();
  await new Promise(resolve => setTimeout(resolve, 100));
  document.querySelector('.review-more > summary').click();
`;

// A finding turned down: the dialog with a reason typed, the note left in its place, the next review's preparation.
ACTIONS["pr-dismiss"] = ACTIONS["pr-review"] + `
  [...document.querySelectorAll('button')].find(button => button.textContent === '不采纳').click();
  await new Promise(resolve => setTimeout(resolve, 150));
  const reason = document.querySelector('textarea[aria-label="不采纳的原因"]');
  if (!reason) throw new Error('Dismiss dialog missing');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(reason, '有意为之：超时由上层统一取消。');
  reason.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 100));
`;
ACTIONS["pr-dismissed"] = ACTIONS["pr-dismiss"] + `
  document.querySelector('form[aria-label="不采纳这条问题"] button[type="submit"]').click();
  await new Promise(resolve => setTimeout(resolve, 150));
  const note = document.querySelector('[aria-label="不采纳"]');
  if (!note) throw new Error('Dismissal note missing');
  note.scrollIntoView({ block: 'center' });
`;
ACTIONS["pr-prepare-dismissed"] = ACTIONS["pr-dismissed"] + `
  [...document.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === '重新评审最新提交').click();
  await new Promise(resolve => setTimeout(resolve, 150));
  if (!document.querySelector('.review-preparation')) throw new Error('Preparation view missing');
`;
ACTIONS["pr-dismissals"] = ACTIONS["pr-prepare-dismissed"] + `
  [...document.querySelectorAll('.review-scope button')].find(button => button.textContent === '查看').click();
  await new Promise(resolve => setTimeout(resolve, 150));
  if (!document.querySelector('.review-dismissals')) throw new Error('Dismissals list missing');
`;
// The same finding raised again by the next review: marked, with the reason it was turned down.
ACTIONS["pr-declined-again"] = ACTIONS["pr-prepare-dismissed"] + `
  [...document.querySelectorAll('button')].find(button => button.textContent === '开始评审').click();
  await new Promise(resolve => setTimeout(resolve, 200));
  const again = [...document.querySelectorAll('.review-finding-again')].find(tag => tag.textContent === '以前不采纳过');
  if (!again) throw new Error('Declined-before mark missing');
  again.closest('.review-finding').scrollIntoView({ block: 'center' });
`;
// A finding posted as a comment, then the next review's preparation telling the model the team cares about its like.
ACTIONS["pr-prepare-published"] = ACTIONS["pr-review"] + `
  [...document.querySelectorAll('button')].find(button => button.textContent === '转为评论').click();
  await new Promise(resolve => setTimeout(resolve, 400));
  [...document.querySelectorAll('form[aria-label="发布评论表单"] button')].find(button => button.textContent === '发布评论').click();
  await new Promise(resolve => setTimeout(resolve, 300));
  [...document.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === '重新评审最新提交').click();
  await new Promise(resolve => setTimeout(resolve, 150));
  if (![...document.querySelectorAll('.review-scope span')].some(span => span.textContent === '条发布过的问题')) throw new Error('Published line missing');
`;
// A finding's comment with its line inserted as a suggested change.
ACTIONS["pr-suggest"] = ACTIONS["pr-review"] + `
  [...document.querySelectorAll('button')].find(button => button.textContent === '转为评论').click();
  await new Promise(resolve => setTimeout(resolve, 200));
  [...document.querySelectorAll('button')].find(button => button.textContent === '插入建议修改').click();
  await new Promise(resolve => setTimeout(resolve, 250));
  if (!document.querySelector('textarea[aria-label="评论内容"]').value.includes('suggestion')) throw new Error('Suggestion missing');
`;
ACTIONS["finish-review"] = ACTIONS["continue-review"] + `
  const question = document.querySelector(".dashboard-rationale-question h3").textContent;
  document.querySelector('.dashboard-review-dialog-form button[type="submit"]').click();
  await new Promise(resolve => setTimeout(resolve, 350));
  if (document.querySelector(".dashboard-review-dialog-form")) throw new Error("Review form did not close after save");
  if (document.querySelector(".dashboard-review-list")?.textContent.includes(question)) throw new Error("Reviewed decision remains pending");
`;
ACTIONS["save-scheduled-record"] = ACTIONS["schedule-record"] + `
  document.querySelector('.active-record-form button[type="submit"]').click();
  await new Promise(resolve => setTimeout(resolve, 350));
  const row = [...document.querySelectorAll(".decision-library-row")].find(item => item.textContent.includes("安排一次上线后复盘"));
  if (!row) throw new Error("Saved decision missing");
  if (!document.querySelector(".decision-library-detail")) row.click();
  await new Promise(resolve => setTimeout(resolve, 100));
  if (!document.querySelector(".decision-library-detail").textContent.includes("一周内故障率不增加，再逐步扩大范围。")) throw new Error("Expected outcome missing from details");
  const schedule = [...document.querySelectorAll(".decision-outcome-heading")].find(item => item.textContent.includes("复盘计划"))?.closest("section");
  if (!schedule || !schedule.textContent.includes("10月1日")) throw new Error("Review date not saved");
  schedule.scrollIntoView({ block: "center" });
`;
ACTIONS["restore-record-draft"] = ACTIONS["schedule-record"] + `
  [...document.querySelectorAll("button")].find(item => item.textContent.trim() === "关闭并保留草稿").click();
  await new Promise(resolve => setTimeout(resolve, 100));
  [...document.querySelectorAll("button")].find(item => item.textContent.trim() === "主动记录").click();
  await new Promise(resolve => setTimeout(resolve, 100));
  if (document.querySelector('[aria-label="标题"]').value !== "安排一次上线后复盘" || document.querySelector('[aria-label="复盘日期"]').value !== "2026-10-01") throw new Error("Draft was not restored");
  if (!document.querySelector('.active-record-form [role="status"]').textContent.includes("已恢复上次草稿")) throw new Error("Restoration notice missing");
`;
const ACTION_SETTLE_MS = {};
for (const name of ["restore-record-draft", "clarify-journal"]) {
  ACTIONS[`${name}-bottom`] = ACTIONS[name] + `
    const submit = document.querySelector('.modal-dialog-body button[type="submit"]');
    submit.scrollIntoView({ block: "end" });
    await new Promise(resolve => requestAnimationFrame(resolve));
    const body = document.querySelector(".modal-dialog-body");
    const bounds = body.getBoundingClientRect();
    const button = submit.getBoundingClientRect();
    if (button.bottom > bounds.bottom + 1 || button.top < bounds.top || body.scrollWidth > body.clientWidth + 1) throw new Error("Form action is clipped at minimum size");
  `;
}
ACTIONS["save-clarified-journal"] = ACTIONS["clarify-journal"] + `
  document.querySelector('.journal-revision-form button[type="submit"]').click();
  await new Promise(resolve => setTimeout(resolve, 300));
  const savedCard = document.getElementById("journal-entry-idea-event-driven-cache");
  if (!savedCard?.textContent.includes("想法 · 有效") || !savedCard.textContent.includes("先用测试服务验证事件丢失")) throw new Error("Clarification was not saved");
  savedCard.scrollIntoView({ block: "center" });
`;
ACTIONS["restore-journal"] = ACTIONS["save-clarified-journal"] + `
  [...savedCard.querySelectorAll("button")].find(item => item.textContent.trim() === "归档").click();
  await new Promise(resolve => setTimeout(resolve, 250));
  const archivedCard = document.getElementById("journal-entry-idea-event-driven-cache");
  if (!archivedCard.textContent.includes("已归档")) throw new Error("Archive failed");
  archivedCard.querySelector("button").click();
  await new Promise(resolve => setTimeout(resolve, 80));
  await fillJournal("记录状态", "active");
  await fillJournal("变更原因", "继续试验，恢复记录。");
  document.querySelector('.journal-revision-form button[type="submit"]').click();
  await new Promise(resolve => setTimeout(resolve, 250));
  const restoredCard = document.getElementById("journal-entry-idea-event-driven-cache");
  if (!restoredCard.textContent.includes("想法 · 有效") || !restoredCard.textContent.includes("v4")) throw new Error("Restore did not preserve revisions");
`;
ACTIONS["journal-history"] = ACTIONS["restore-journal"] + `
  const history = document.querySelector("#journal-entry-idea-event-driven-cache .journal-entry-history");
  if (!history) throw new Error("Revision history missing");
  history.querySelector("summary").click();
  const previous = [...history.querySelectorAll("details summary")].find(item => item.textContent.includes("v1"));
  previous.click();
  previous.scrollIntoView({ block: "center" });
`;
ACTIONS["show-expected-outcome"] = ACTIONS["save-scheduled-record"] + `
  const expected = [...document.querySelectorAll(".decision-detail-context")].find(item => item.textContent.includes("预期结果"));
  if (!expected) throw new Error("Expected outcome not rendered");
  expected.scrollIntoView({ block: "center" });
`;

if (!(action in ACTIONS)) {
  console.error(`Unsupported action: ${action}`);
  app.exit(2);
}

let server;
let window;

const finish = async (code) => {
  if (window !== undefined && !window.isDestroyed()) window.destroy();
  if (server !== undefined) await server.close();
  app.exit(code);
};

app
  .whenReady()
  .then(async () => {
    const { createServer } = await import(
      pathToFileURL(require.resolve("vite", { paths: [repositoryRoot] })).href
    );
    server = await createServer({
      configFile: join(repositoryRoot, "apps", "desktop", "vite.renderer.config.ts"),
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0, strictPort: false },
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (address === null || address === undefined || typeof address === "string") {
      throw new Error("Preview server did not start");
    }

    window = new BrowserWindow({
      width,
      height,
      show: action === "switches",
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      webPreferences: { partition: `preview-${process.pid}`, offscreen: action !== "switches" },
    });
    await window.loadURL(
      `http://127.0.0.1:${address.port}/?preview=${encodeURIComponent(preview)}&theme=${encodeURIComponent(theme)}`,
    );
    await window.webContents.executeJavaScript(`new Promise((resolve) => {
      const deadline = Date.now() + 15000;
      const check = () => {
        const stage = document.querySelector(".desktop-stage");
        if ((stage && stage.textContent.trim().length > 0) || Date.now() > deadline) {
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    })`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 900));
    if (ACTIONS[action] !== "") {
      const settleMs = ACTION_SETTLE_MS[action] ?? 400;
      await window.webContents.executeJavaScript(
        `(async () => { ${ACTIONS[action]} await new Promise((resolve) => setTimeout(resolve, ${settleMs})); })()`,
      );
    }
    if (action === "select-open") {
      // showPicker() 要用户手势，只有真的鼠标事件算数。
      const point = await window.webContents.executeJavaScript(`
        (() => {
          const rect = document.querySelector("select").getBoundingClientRect();
          return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
        })()
      `);
      for (const type of ["mouseDown", "mouseUp"]) {
        window.webContents.sendInputEvent({ type, button: "left", clickCount: 1, ...point });
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      const open = await window.webContents.executeJavaScript(
        `document.querySelectorAll("option").length > 0 &&
         [...document.querySelectorAll("option")].some((node) => node.checkVisibility())`,
      );
      if (!open) throw new Error("Select picker did not open in page");
    }
    if (action === "assistant-hover" || action === "model-hover") {
      const selector = action === "assistant-hover" ? '[aria-label="有用"]' : '[aria-label^="测试 "]';
      const point = await window.webContents.executeJavaScript(`
        (() => {
          const button = document.querySelector(${JSON.stringify(selector)});
          if (!button || !button.querySelector("svg")) throw new Error("Missing feedback icon");
          button.scrollIntoView({ block: "nearest" });
          const rect = button.getBoundingClientRect();
          return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
        })()
      `);
      window.webContents.sendInputEvent({ type: "mouseMove", ...point });
      await new Promise(resolve => setTimeout(resolve, 100));
      await window.webContents.executeJavaScript(`
        (() => {
          const button = document.querySelector(${JSON.stringify(selector)});
          const tip = document.querySelector('[role="tooltip"]');
          if (!tip || !tip.textContent.includes(button.getAttribute("aria-label"))) throw new Error("Hover tooltip missing");
        })()
      `);
    }
    if (action === "switches") {
      window.focus();
      const initial = await window.webContents.executeJavaScript(`(() => {
        const controls = [...document.querySelectorAll('input[role="switch"]')];
        controls[0]?.scrollIntoView({ block: "center" });
        controls[0]?.focus();
        return { checked: controls[0]?.checked, metrics: controls.map(input => ({
          name: input.getAttribute("aria-label"), width: input.getBoundingClientRect().width,
          height: input.getBoundingClientRect().height, appearance: getComputedStyle(input).appearance,
        })) };
      })()`);
      if (!initial.metrics.length || initial.metrics.some(item => item.width !== 34 || item.height !== 20 || item.appearance !== "none")) {
        throw new Error("Inconsistent switches: " + JSON.stringify(initial.metrics));
      }
      window.webContents.focus();
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
      await new Promise(resolve => setTimeout(resolve, 250));
      const afterKey = await window.webContents.executeJavaScript(`(() => {
        const input = document.querySelector('input[role="switch"]');
        return { checked: input.checked, focused: document.activeElement === input, outline: getComputedStyle(input).outlineStyle, documentFocused: document.hasFocus(), focusSelector: input.matches(":focus") };
      })()`);
      if (afterKey.checked === initial.checked || !afterKey.focused || afterKey.outline === "none") {
        throw new Error("Switch keyboard failure: " + JSON.stringify(afterKey));
      }
      await window.webContents.executeJavaScript(`document.querySelector('input[role="switch"]').closest("label").click()`);
      await new Promise(resolve => setTimeout(resolve, 250));
      const restored = await window.webContents.executeJavaScript(`document.querySelector('input[role="switch"]').checked`);
      if (restored !== initial.checked) throw new Error("Label did not toggle switch back");
      console.log("Switch geometry, Space key, focus and label click verified");
    }
    const image = await window.webContents.capturePage();
    writeFileSync(out, image.toPNG());
    console.log(`saved ${out}`);
    await finish(0);
  })
  .catch(async (error) => {
    console.error(error);
    await finish(1);
  });
