// CS-1-F 真实模型实跑：startIsolatedApp({ useLocalModels: true }) 只读链接模型目录，
// 偏好、想法、决策的 semantic 检索正向结果，以及「可能重复」阈值标定（明显重复、换说法、相关但不同、无关）。
// 用法：node scripts/lab/probes/context-signals-model-run.mjs <证据目录>
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connectMcp, startIsolatedApp } from "../isolated-app.mjs";

const evidence = process.argv[2];
if (!evidence) throw new Error("需要证据目录");
await mkdir(evidence, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "cs1f-lab-"));
const app = await startIsolatedApp({ root, useLocalModels: true, timeoutMs: 120_000 });
const mcp = await connectMcp({ env: app.env, client: "claude-code" });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const calls = [];
const call = async (tool, args) => {
  const response = await mcp.call(tool, args);
  calls.push({ tool, args, response });
  return response.result ?? response;
};
const ctx = (result) => result.structuredContent?.context;

// 每组：基础记录 A（已存在）与新写入的 B。kind 决定在哪类来源里比。
const pref = (title, content, appliesWhen, exceptions) => ({ kind: "preference", title, content, appliesWhen, exceptions, knowledgeStatus: "active" });
const idea = (title, content) => ({ kind: "idea", title, content, whyInteresting: "值得记下", knowledgeStatus: "active" });
const decision = (title, content) => ({ kind: "decision", title, content, rationale: "示例" });
const GROUPS = [
  { group: "明显重复", a: pref("错误处理先抛出", "函数内部遇到不可恢复的错误直接抛出，不返回错误码。", "写 TypeScript 时", "原型代码除外"), b: pref("错误处理先抛出", "函数内部遇到不可恢复的错误直接抛出，不返回错误码。", "写 TypeScript 时", "原型代码除外") },
  { group: "明显重复", a: pref("命名用完整单词", "变量名不缩写，宁可长一点。", "所有代码", "循环变量除外"), b: pref("命名用完整单词", "变量名不要缩写，宁可长一点。", "所有代码", "循环变量除外") },
  { group: "明显重复", a: decision("会话缓存放哪里", "会话缓存放进程内存，单机部署延迟最低。"), b: decision("会话缓存放哪里", "会话缓存放进程内存，单机部署延迟最低。") },
  { group: "换说法的重复", a: pref("注释写原因", "注释只解释为什么这样写，不复述代码做了什么。", "写注释时", "公开 API 文档注释除外"), b: pref("注释要讲为什么", "代码注释应该说明背后的原因，而不是把代码念一遍。", "写注释时", "公开接口的文档除外") },
  { group: "换说法的重复", a: idea("把待办做成时间线", "待办按完成时间排成一条线，看这周做了什么。"), b: idea("待办的时间轴视图", "把已完成的待办按时间顺序排成一条轴，回顾一周的进展。") },
  { group: "换说法的重复", a: decision("任务队列持久化", "任务队列改为 SQLite 持久化，崩溃重启后继续处理。"), b: decision("队列落盘", "把任务队列存到 SQLite 里，进程崩溃重启后能接着跑。") },
  { group: "换说法的重复", a: pref("提交信息写单行", "commit message 只写一行标题，不写正文。", "提交代码时", "合并提交除外"), b: pref("提交说明只要一行", "提交时说明只写一行标题，不加正文段落。", "提交代码时", "合并提交除外") },
  { group: "相关但不同", a: pref("错误处理先抛出", "函数内部遇到不可恢复的错误直接抛出，不返回错误码。", "写 TypeScript 时", "原型代码除外"), b: pref("日志里记录错误", "捕获到错误后写一条带上下文的日志，再决定是否重试。", "处理错误时", "已经记录过的除外") },
  { group: "相关但不同", a: idea("把待办做成时间线", "待办按完成时间排成一条线，看这周做了什么。"), b: idea("待办支持重复事项", "每天或每周自动再生成一项待办，用于例行事务。") },
  { group: "相关但不同", a: decision("会话缓存放哪里", "会话缓存放进程内存，单机部署延迟最低。"), b: decision("会话过期时间", "会话缓存的过期时间定为三十分钟，访问时续期。") },
  { group: "相关但不同", a: pref("命名用完整单词", "变量名不缩写，宁可长一点。", "所有代码", "循环变量除外"), b: pref("文件名用短横线", "文件名全部小写，用短横线连接单词。", "新建文件时", "框架约定的文件名除外") },
  { group: "无关", a: pref("注释写原因", "注释只解释为什么这样写，不复述代码做了什么。", "写注释时", "公开 API 文档注释除外"), b: pref("午饭吃清淡的", "工作日午饭选清淡的，少油少盐。", "点外卖时", "加班除外") },
  { group: "无关", a: idea("决策可以挂检查清单", "每条决策附一份上线前检查清单。"), b: idea("周末去爬山", "周末天气好的时候去郊外爬山放松。") },
  { group: "无关", a: decision("任务队列持久化", "任务队列改为 SQLite 持久化，崩溃重启后继续处理。"), b: decision("团队周会改到周三", "团队周会从周一改到周三下午。") },
];
const sourceOf = { preference: "preferences", idea: "ideas", decision: "decisions" };
const textOf = (entry) => `${entry.title}\n${entry.content}`.slice(0, 700);

try {
  // 基础记录：每条 A 只写一次
  const seeded = new Map();
  for (const { a } of GROUPS) {
    const key = `${a.kind}|${a.title}`;
    if (seeded.has(key)) continue;
    const result = await call("record_decision_journal_entry", { project: "lab", ...a });
    seeded.set(key, result.structuredContent?.record?.recordId);
  }
  // 等向量建好：每个来源重复问，直到没有「正在后台建立 / 尚无」的说明
  const warm = async (kind) => {
    for (let n = 0; n < 40; n += 1) {
      const result = await call("search_decision_context", { source: sourceOf[kind], query: "示例", mode: "semantic", minSimilarity: 0, limit: 20 });
      const guidance = ctx(result)?.guidance ?? result.content?.[0]?.text ?? "";
      if (result.isError) throw new Error(`semantic 不可用：${guidance.split("\n")[0]}`);
      if (!/正在后台建立|尚无可用|已请求后台补建/u.test(guidance)) return n;
      await sleep(3_000);
    }
    throw new Error(`${kind} 向量一直没建好`);
  };
  const warmed = {};
  for (const kind of ["preference", "idea", "decision"]) warmed[kind] = await warm(kind);

  const table = [];
  for (const { group, a, b } of GROUPS) {
    const id = seeded.get(`${a.kind}|${a.title}`);
    const result = await call("search_decision_context", { source: sourceOf[a.kind], query: textOf(b), mode: "semantic", minSimilarity: 0, limit: 20 });
    const results = ctx(result)?.results ?? [];
    const own = results.find((item) => item.id === id);
    const others = results.filter((item) => item.id !== id).map((item) => item.similarity);
    table.push({ group, kind: a.kind, a: a.title, b: b.title, similarityToA: own?.similarity ?? null, bestOther: others.length ? Math.max(...others) : null });
  }
  await writeFile(join(evidence, "calibration.json"), `${JSON.stringify(table, null, 2)}\n`);

  // 正向 semantic：换一种说法问，应排到前面
  const ask = async (name, args) => {
    const result = await call("search_decision_context", args);
    await writeFile(join(evidence, `${name}.json`), `${JSON.stringify({ args, response: result }, null, 2)}\n`);
    return result;
  };
  await ask("semantic-prefs", { source: "preferences", query: "代码里出了异常应该怎么处理", mode: "semantic", limit: 5 });
  await ask("semantic-ideas", { source: "ideas", query: "回顾这周完成了哪些事", mode: "semantic", limit: 5 });
  await ask("semantic-decisions", { source: "decisions", query: "进程重启之后任务会不会丢", mode: "semantic", limit: 5 });
  await ask("semantic-all-paged-1", { source: ["decisions", "preferences", "ideas"], query: "怎么写注释和命名", mode: "semantic", minSimilarity: 0.3, limit: 3 });
  await ask("hybrid-prefs", { source: "preferences", query: "异常", limit: 5 });

  // 「可能重复」提示：换说法再记一次
  const dupes = [];
  for (const { group, a, b } of GROUPS.filter((item) => item.group !== "明显重复").slice(0, 8)) {
    const result = await call("record_decision_journal_entry", { project: "lab", ...b });
    dupes.push({ group, b: b.title, text: result.content?.[0]?.text, possibleDuplicates: result.structuredContent?.record?.possibleDuplicates ?? null });
  }
  await writeFile(join(evidence, "duplicate-hints.json"), `${JSON.stringify(dupes, null, 2)}\n`);
  await writeFile(join(evidence, "warmed.json"), `${JSON.stringify(warmed)}\n`);
} finally {
  await writeFile(join(evidence, "calls.json"), `${JSON.stringify(calls, null, 2)}\n`);
  mcp.close();
  await app.stop();
  await rm(root, { recursive: true, force: true });
}
