// CS-1 实跑：隔离 App + 打包里的真实 bridge MCP，读偏好与想法、各种筛选、semantic，以及增补、改写、撤回。
// 用法：node scripts/lab/probes/context-signals-probe.mjs --app App.app --bridge bridge --label round --out DIR；每步保存合成请求和结果。
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connectMcp, startIsolatedApp } from "../isolated-app.mjs";

const { parseCommon, executableOf } = await import("./lib.mjs");
const { app: appPath, bridge, out: evidence } = parseCommon();
await mkdir(evidence, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "cs1-lab-"));
const app = await startIsolatedApp({ root, executable: executableOf(appPath) });
const mcp = await connectMcp({ env: app.env, bridge, client: "claude-code" });
let counter = 0;
const log = [];
const step = async (name, tool, args = {}) => {
  const started = performance.now();
  const response = await mcp.call(tool, args);
  const elapsedMs = Math.round((performance.now() - started) * 10) / 10;
  const file = `${String(++counter).padStart(2, "0")}-${name}.json`;
  await writeFile(join(evidence, file), `${JSON.stringify({ tool, args, response }, null, 2)}\n`);
  const result = response.result ?? {};
  log.push({ file, tool, elapsedMs, isError: result.isError === true, text: (result.content?.[0]?.text ?? JSON.stringify(response.error)).split("\n")[0].slice(0, 160) });
  return response.result ?? response;
};
const ctx = (result) => result.structuredContent?.context;
const ids = (result) => (ctx(result)?.results ?? []).map((item) => item.id);
const check = (label, ok, detail = "") => { log.push({ check: label, ok, detail: String(detail).slice(0, 200) }); if (!ok) process.exitCode = 1; };

try {
  await writeFile(join(evidence, "00-tools.json"), `${JSON.stringify(await mcp.listTools(), null, 2)}\n`);
  const record = (args) => step(`seed-${args.kind}`, "record_decision_journal_entry", { project: "paraself", ...args });
  const prefs = [
    await record({ kind: "preference", title: "错误处理先抛出", content: "函数内部遇到不可恢复的错误直接抛出，不返回错误码。", appliesWhen: "写 TypeScript 时", exceptions: "原型代码除外", knowledgeStatus: "active", languages: ["typescript"] }),
    await record({ kind: "preference", title: "命名用完整单词", content: "变量名不缩写，宁可长一点。", appliesWhen: "所有代码", exceptions: "循环变量 i、j 除外", knowledgeStatus: "active", project: "other" }),
    await record({ kind: "preference", title: "注释写原因", content: "注释只解释为什么，不复述代码做了什么。", appliesWhen: "写注释时", exceptions: "公开 API 的文档注释除外", knowledgeStatus: "active" }),
  ];
  const ideas = [
    await record({ kind: "idea", title: "把待办做成时间线", content: "待办按完成时间排成一条线看进度。", whyInteresting: "能看出一周做了什么", knowledgeStatus: "active" }),
    await record({ kind: "idea", title: "决策可以挂检查清单", content: "每条决策附一份上线前检查清单。", knowledgeStatus: "inbox" }),
  ];
  await record({ kind: "decision", title: "会话缓存放哪里", content: "会话缓存放进程内存。", rationale: "单机部署，延迟最低" });
  const prefIds = prefs.map((item) => item.structuredContent.record.recordId);
  check("seed: 3 偏好 2 想法已创建", [...prefs, ...ideas].every((item) => item.structuredContent?.record?.status === "created"));

  // 读取：全部、翻页、筛选
  const allPrefs = await step("prefs-all", "search_decision_context", { source: "preferences", limit: 20 });
  check("取全部偏好", ids(allPrefs).length === 3 && ctx(allPrefs).total === 3, ids(allPrefs));
  check("文字标注信号而非原则", allPrefs.content[0].text.includes("用户偏好，是信号不是原则") && allPrefs.content[0].text.includes("不得据此推断新的偏好"));
  const allIdeas = await step("ideas-all", "search_decision_context", { source: "ideas", limit: 20 });
  check("取全部想法", ids(allIdeas).length === 2, ids(allIdeas));
  const page1 = await step("both-page1", "search_decision_context", { source: ["preferences", "ideas"], limit: 2 });
  const page2 = await step("both-page2", "search_decision_context", { source: ["preferences", "ideas"], limit: 2, offset: ctx(page1).nextOffset });
  const page3 = await step("both-page3", "search_decision_context", { source: ["preferences", "ideas"], limit: 2, offset: ctx(page2).nextOffset });
  check("空 query 翻页取全 5 条", new Set([...ids(page1), ...ids(page2), ...ids(page3)]).size === 5 && ctx(page3).nextOffset === null, [ids(page1), ids(page2), ids(page3)]);
  const byProject = await step("project-paraself", "search_decision_context", { source: "preferences", project: "paraself" });
  check("project 筛选排除其它项目并计数", ids(byProject).length === 2 && ctx(byProject).excludedByScope === 1, ids(byProject));
  await step("project-paraself-include-out", "search_decision_context", { source: "preferences", project: "paraself", includeOutOfScope: true });
  const keyword = await step("keyword", "search_decision_context", { source: ["preferences", "ideas"], query: "时间线", mode: "keyword" });
  check("关键词命中想法", ids(keyword).length === 1, ids(keyword));
  const byId = await step("record-id", "search_decision_context", { source: "preferences", recordId: prefIds[0] });
  check("recordId 命中", ids(byId)[0] === prefIds[0]);
  await step("relation-ignored", "search_decision_context", { source: "preferences", relation: "conflict" });
  await step("taskscope-ignored", "search_decision_context", { source: "preferences", repositoryPath: root });
  await step("default-source", "search_decision_context", { limit: 20 });
  await step("mixed-decisions-and-signals", "search_decision_context", { source: ["decisions", "preferences", "ideas"], limit: 20 });
  await step("mode-keyword-decisions", "search_decision_context", { source: "decisions", query: "缓存", mode: "keyword" });
  await step("mode-hybrid-default", "search_decision_context", { query: "缓存" });
  const semantic = await step("semantic-prefs", "search_decision_context", { source: "preferences", query: "异常怎么处理", mode: "semantic" });
  check("semantic：模型不可用时明确说明、不退化", semantic.isError === true && ctx(semantic)?.results.length === 0 || /不可用/.test(semantic.content[0].text), semantic.content[0].text.split("\n")[0]);
  await step("semantic-decisions", "search_decision_context", { source: "decisions", query: "会话缓存", mode: "semantic" });
  const bad1 = await step("refuse-semantic-empty-query", "search_decision_context", { mode: "semantic" });
  const bad2 = await step("refuse-minsimilarity", "search_decision_context", { minSimilarity: 0.5 });
  check("不合规的 semantic 请求被拒绝并说明", bad1.isError === true && bad2.isError === true);

  // 增补、改写、撤回（偏好）
  const hash = ctx(byId).results[0].sourceRef.contentHash;
  const appended = await step("amend-append", "update_decision_journal_entry", { action: "append", source: "preferences", recordId: prefIds[0], text: "Promise 链里改用 async/await 的 try/catch，不再用 .catch 吞错误。", basis: "user_said", reason: "用户在会话里补充" });
  check("append 保存", appended.structuredContent.amendment.status === "saved" && appended.structuredContent.amendment.revision === 1);
  const found = await step("amend-search-appended-words", "search_decision_context", { source: "preferences", query: "try/catch", mode: "keyword" });
  check("检索命中增补的文字，带修订号与增补内容", ids(found)[0] === prefIds[0] && ctx(found).results[0].amendment.revision === 1 && ctx(found).results[0].amendment.amendments[0].text.includes("try/catch"));
  const wrong = await step("amend-revise-wrong-hash", "update_decision_journal_entry", { action: "revise", source: "preferences", recordId: prefIds[0], expectedContentHash: "0".repeat(64), expectedRevision: 1, fields: { appliesWhen: "写 TS 和 JS 时" }, reason: "用户收窄范围" });
  check("revise 带错 hash 被拒", wrong.isError === true && wrong.structuredContent.amendment.status === "source_changed");
  const revised = await step("amend-revise", "update_decision_journal_entry", { action: "revise", source: "preferences", recordId: prefIds[0], expectedContentHash: hash, expectedRevision: 1, fields: { appliesWhen: "写 TypeScript 和 JavaScript 时", caution: null }, reason: "用户说范围要放宽，例外也不要了" });
  check("revise 保存", revised.structuredContent.amendment.status === "saved" && revised.structuredContent.amendment.revision === 2);
  const after = await step("amend-search-after-revise", "search_decision_context", { source: "preferences", recordId: prefIds[0] });
  const state = ctx(after).results[0];
  check("改写生效且被替换的原文可找回", state.appliesWhen === "写 TypeScript 和 JavaScript 时" && state.caution === null && state.amendment.history.some((item) => item.before?.appliesWhen === "写 TypeScript 时" && item.before?.caution === "原型代码除外"), JSON.stringify(state.amendment.history.map((item) => item.before)));
  const conflict = await step("amend-revise-stale-revision", "update_decision_journal_entry", { action: "revise", source: "preferences", recordId: prefIds[0], expectedContentHash: hash, expectedRevision: 1, fields: { summary: "x" }, reason: "r" });
  check("revision 过期被拒", conflict.structuredContent.amendment.status === "revision_conflict");
  const withdrawn = await step("amend-withdraw", "update_decision_journal_entry", { action: "withdraw", source: "preferences", recordId: prefIds[2], expectedRevision: 0, reason: "用户不再这样要求" });
  check("withdraw 保存", withdrawn.structuredContent.amendment.status === "saved");
  const afterWithdraw = await step("withdrawn-default-excluded", "search_decision_context", { source: "preferences", limit: 20 });
  check("默认检索不返回已撤回", !ids(afterWithdraw).includes(prefIds[2]) && ids(afterWithdraw).length === 2, ids(afterWithdraw));
  const shown = await step("withdrawn-include", "search_decision_context", { source: "preferences", includeWithdrawn: true, limit: 20 });
  check("includeWithdrawn 可查，带原因", ctx(shown).results.find((item) => item.id === prefIds[2])?.amendment.withdrawn.reason === "用户不再这样要求");
  const consult = await step("consult-after-withdraw", "consult_decision_principles", { question: "注释应该怎么写？", options: [{ label: "写原因" }, { label: "写做了什么" }], project: "paraself" });
  check("consult 不再带出已撤回的偏好", !JSON.stringify(consult.structuredContent).includes(prefIds[2]));
  const decisionWithdraw = await step("withdraw-decision-refused", "update_decision_journal_entry", { action: "withdraw", source: "decisions", recordId: "none", expectedRevision: 0, reason: "r" });
  check("决策不提供撤回", decisionWithdraw.isError === true);

  // summarize：增补、改写，之后原笔记被重新生成
  const summaryPath = join(app.env.PARASELF_VAULT_PATH, "Decision Journal", "summarize", "HIST-CACHE-缓存后端.md");
  const summaryNote = (extra = "") => `---\nid: HIST-CACHE\ncreated: "2026-09-01"\nstatus: "accepted"\nselected_option: "缓存后端采用进程内存。"\nproject: "paraself"\ntags: ["synthetic"]\nsupersedes: []\nsuperseded_by: null\n---\n# 缓存后端\n\n## 决策\n缓存后端采用进程内存。${extra}\n`;
  await mkdir(join(app.env.PARASELF_VAULT_PATH, "Decision Journal", "summarize"), { recursive: true });
  await writeFile(summaryPath, summaryNote());
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  const original = await step("summary-read", "search_decision_context", { source: "summarize", recordId: "HIST-CACHE" });
  check("读到 summarize 笔记", ids(original)[0] === "HIST-CACHE", ids(original));
  const summaryHash = ctx(original).results[0].sourceRef.contentHash;
  await step("summary-append", "update_decision_journal_entry", { action: "append", source: "summarize", recordId: "HIST-CACHE", text: "多实例部署时必须改用 Redis，否则会话不一致。", basis: "user_confirmed" });
  await step("summary-revise", "update_decision_journal_entry", { action: "revise", source: "summarize", recordId: "HIST-CACHE", expectedContentHash: summaryHash, expectedRevision: 1, fields: { summary: "缓存后端：单机用进程内存，多实例用 Redis。" }, reason: "用户改了结论" });
  const before = await step("summary-search-amended", "search_decision_context", { source: "summarize", query: "Redis" });
  check("summarize 增补可被检索命中", ids(before)[0] === "HIST-CACHE" && ctx(before).results[0].summary.includes("多实例用 Redis"));
  await writeFile(summaryPath, summaryNote("\n\n重新生成：补充了测试数据。"));
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  const regenerated = await step("summary-after-regeneration", "search_decision_context", { source: "summarize", recordId: "HIST-CACHE" });
  const regen = ctx(regenerated).results[0];
  check("summarize 重新生成后增补不丢，改写标为过期", regen.amendment?.amendments.length === 1 && regen.amendment.revised.stale === true && regen.summary.includes("进程内存"), JSON.stringify(regen.amendment?.revised));

  // 重复提示
  const dup = await record({ kind: "preference", title: "错误先抛出，不返回错误码", content: "不可恢复的错误直接 throw。", appliesWhen: "TS", exceptions: "原型", knowledgeStatus: "active" });
  await writeFile(join(evidence, "dup-note.txt"), `${dup.content[0].text}\n（隔离环境没有嵌入模型，所以没有「可能重复」提示；有模型时的行为由单元测试覆盖。）\n`);

  // 旧 bridge：不带请求头直接问本机服务
  const runtime = JSON.parse(await readFile(app.env.PARASELF_RUNTIME_FILE, "utf8"));
  const raw = async (name, body, headers = {}) => {
    const answer = await fetch(`http://127.0.0.1:${runtime.port}/v1/decision-context`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${runtime.token}`, ...headers }, body: JSON.stringify(body) });
    const text = await answer.text();
    await writeFile(join(evidence, `${String(++counter).padStart(2, "0")}-${name}.json`), `${JSON.stringify({ body, headers, status: answer.status, answer: text.startsWith("{") ? JSON.parse(text) : text }, null, 2)}\n`);
    return { status: answer.status, json: text.startsWith("{") ? JSON.parse(text) : null };
  };
  const oldDecisions = await raw("old-client-decisions", { query: "", source: "decisions" });
  check("旧客户端（无请求头）读决策：没有新字段", oldDecisions.status === 200 && oldDecisions.json.results.every((item) => !("similarity" in item) && !("amendment" in item) && !("signal" in item)));
  const oldDefault = await raw("old-client-default", {});
  check("旧客户端不传 source：只有三类决策来源", oldDefault.json.results.every((item) => ["summarize", "decisions", "principles"].includes(item.source)) && oldDefault.json.sources.length === 3);
  const oldNew = await raw("old-client-asks-new-source", { source: "preferences" });
  check("旧客户端用新来源被拒绝", oldNew.status === 400);
  const newShape = await raw("new-client-shape-2", { source: "preferences" }, { "x-decision-context-shape": "2" });
  check("新客户端带头可读偏好", newShape.status === 200 && newShape.json.results.length === 3);
} catch (error) {
  log.push({ error: String(error?.stack ?? error) });
  process.exitCode = 1;
} finally {
  await writeFile(join(evidence, "SUMMARY.json"), `${JSON.stringify(log, null, 2)}\n`);
  try { await mcp.close(); } finally {
    await app.stop();
    await rm(root, { recursive: true, force: true });
  }
}
console.log(JSON.stringify(log.filter((item) => "check" in item || "error" in item), null, 2));
