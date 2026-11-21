import { expect, it } from "vitest";
import type { DecisionRecord } from "@cognelis/decision-core";
import { adoptedSummaryContext, decisionContextQuerySchema } from "@cognelis/decision-protocol";
import { parseDecisionContextNote, serializeDecision, serializeMethodology, type DecisionContextDocument } from "@cognelis/decision-storage";
import { recordFixture } from "../../../packages/storage/test/fixtures.js";
import { DecisionContextService } from "../src/main/decision-context-service.js";
import { composeContextSummary } from "../src/main/record-context-summary.js";

const note = (id: string, title: string, body: string): DecisionContextDocument => ({
  source: "decisions", kind: "recorded_decision", id, title, project: "app", status: "accepted", created: `2026-09-0${id.at(-1)}`, summary: title,
  appliesWhen: null, caution: null, tags: [], supersedes: [], supersededBy: [], relativePath: `decisions/${id}.md`, client: null, sessionId: null,
  body, bodyStartLine: 1, contentHash: id.at(-1)!.repeat(64),
});
const service = (documents: DecisionContextDocument[]) => new DecisionContextService({ scan: async () => ({ sources: [{ source: "decisions", status: "ready", records: documents.length, skipped: 0 }], documents }) });
const search = (documents: DecisionContextDocument[], query: string) => service(documents).search(decisionContextQuerySchema.parse({ query }));

// A decision note as the App writes it: the options again as JSON, the answer in a marker.
const decisionBody = (question: string) => [
  "# 决策点", "", question, "", "## 可选方案", "", "1. 固定过期：简单", "", "```decision-options",
  JSON.stringify([{ label: "固定过期", description: "简单" }], null, 2), "```", "", "## 我的选择", "", "固定过期", "",
  "<!-- decision:selection-base64 eyJ0eXBlIjoiMCJ9 -->", "", "## 我的理由（原文）", "", "会话不长。",
].join("\n");

it("leaves a decision note's machine lines out of its excerpt and out of what is searched", async () => {
  const documents = [note("DEC-1", "会话过期", decisionBody("会话怎么过期？"))];
  const [found] = (await search(documents, "会话过期")).results;
  expect(found!.sourceRef.excerpt).not.toMatch(/decision-options|selection-base64|"label"/u);
  expect(found!.sourceRef.excerpt).toContain("1. 固定过期：简单\n\n…\n\n## 我的选择");
  // Only the options' JSON held the word: it matched every decision the App wrote.
  expect((await search(documents, "label")).results).toEqual([]);
});

// The question's pairs across its words (该使, 么缓) are in a note or two by chance ("应该使用 HTTPS", "怎么缓解"): rare,
// they outweighed 缓存, and the notes on caching were under the bar while those came back.
it("does not take a question's pairs across its words for its subject", async () => {
  const documents = [
    ...Array.from({ length: 8 }, (_, n) => note(`DEC-${n}`, n === 0 ? "会话缓存" : `缓存分层 ${n}`, `缓存的取舍 ${n}`)),
    note("EASE-1", "压力", "怎么缓解告警风暴"),
    ...Array.from({ length: 3 }, (_, n) => note(`USE-${n}`, `传输 ${n}`, "应该使用 HTTPS")),
  ];
  const found = (await search(documents, "应该使用什么缓存")).results.map((result) => result.id);
  expect(found).toHaveLength(8);
  expect(found.every((id) => id.startsWith("DEC-"))).toBe(true);
});

it("weighs a term by how few notes hold it, so one every note holds does not carry a note past the bar", async () => {
  const documents = [
    ...["1", "2", "3", "4", "5"].map((n) => note(`DEC-${n}`, `缓存分层 ${n}`, `本地缓存与远端缓存的分工 ${n}`)),
    note("DEC-6", "会话过期时长", "会话按 30 分钟过期。"),
  ];
  // 缓存 is in five notes of six, 过期 in one: those holding only 缓存 came along, a page of them before the answer.
  expect((await search(documents, "缓存过期")).results.map((result) => result.id)).toEqual(["DEC-6"]);
});

// Notes as the App writes them, read as the search reads them.
const read = (path: string, content: string, source: "decisions" | "principles") =>
  parseDecisionContextNote({ relativePath: path, content, contentHash: "0".repeat(64), size: content.length, modifiedAtMs: 0 }, source)!;
const recorded = (id: string, overrides: Partial<DecisionRecord>) =>
  read(`Decision Journal/decisions/${id}.md`, serializeDecision(recordFixture({ id, contextSummary: null, ...overrides })), "decisions");

it("leaves the App's own headings and placeholders out of what is searched, and finds a step by its name once taken", async () => {
  const documents = [
    recorded("DEC-CACHE", { question: "会话缓存放在哪？", options: [], selectedAnswer: { kind: "custom", values: ["Redis"] }, rationaleOriginal: "多实例要共享。" }),
    recorded("DEC-PLAN", { question: "灰度怎么做？", selectedAnswer: { kind: "custom", values: ["按租户"] }, rationaleOriginal: "这个方案回退最快。" }),
    recorded("DEC-LOGS", {
      question: "日志保留多久？", selectedAnswer: { kind: "custom", values: ["30 天"] }, rationaleOriginal: "合规要求。",
      outcome: "上线后磁盘涨得很快。", outcomeReview: { verdict: "worse", lesson: "保留期要按日志量评估。", reviewedAt: "2026-09-20T00:00:00.000Z" },
    }),
    read("Decision Journal/principles/p.md", serializeMethodology({
      id: "principle-1", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", origin: "decision_evidence", status: "accepted",
      confirmedAt: "2026-09-01T00:00:00.000Z", title: "先验证边界", principle: "先验证边界再扩大投入。", appliesWhen: "兼容性不明确时。",
      caution: "验证成本过高时重新评估。", evidenceSummary: "一次完整复盘。", sourceDecisionIds: ["DEC-LOGS"], confidence: "low",
      generation: { requestId: "request", profileId: "test", provider: "test", model: "test" },
    }), "principles"),
  ];
  const ids = async (query: string) => (await search(documents, query)).results.map((result) => result.id).sort();

  // Every decision the App wrote holds 我的选择, 我的理由（原文）, 当时上下文 and 复盘结论 over （尚未复盘）: all of them came back.
  expect(await ids("我的选择")).toEqual([]);
  expect(await ids("上下文")).toEqual([]);
  // The reader's own 方案 is found; the heading 可选方案 above every decision's options is not.
  expect(await ids("方案")).toEqual(["DEC-PLAN"]);
  // Reviewed, a decision is found by 复盘 (and the principle drawn from that review by what its evidence says).
  expect(await ids("复盘")).toEqual(["DEC-LOGS", "principle-1"]);
  expect(await ids("适用条件")).toEqual([]);
  // What is shown keeps the note's headings: only what is searched leaves them out.
  const [plan] = (await search(documents, "回退")).results;
  expect(plan!.sourceRef.excerpt).toContain("## 我的理由（原文）\n\n这个方案回退最快。");
});

it("leaves the lines around an adopted local summary out of what is searched, and finds the decision by what it says", async () => {
  const summary = composeContextSummary({ change: "src/request.ts:12 给请求加了超时。", views: ["超时写死不好调整", "计时器要清理"], decided: "超时由网关约定的配置传入。" });
  const documents = [
    recorded("DEC-PUT", { question: "超时由谁决定？", contextSummary: adoptedSummaryContext(summary, "PR：调整请求超时（sample/app#123）") }),
    recorded("DEC-ALONE", { question: "重试放在哪一层？", contextSummary: adoptedSummaryContext(summary) }),
    recorded("DEC-PLAIN", { question: "日志保留多久？", contextSummary: "合规要求留 30 天。" }),
  ];
  const ids = async (query: string) => (await search(documents, query)).results.map((result) => result.id).sort();

  // Written by the App around every adopted summary: found by them, each such decision came back for any of these words.
  for (const word of ["上下文", "采用", "本机模型", "观点", "做什么", "定了什么"]) expect({ word, found: await ids(word) }).toEqual({ word, found: [] });
  expect(await ids("网关")).toEqual(["DEC-ALONE", "DEC-PUT"]);
  expect(await ids("sample/app#123")).toEqual(["DEC-PUT"]);
});

// A historical note as the reader's summaries are written: the options it weighed and the constraints that came up
// as properties, its text on what was chosen (536 options in the reader's summaries, 50 of them word for word in their text).
it("finds a historical decision by an option it weighed or a constraint it found, kept only in its properties", async () => {
  const content = [
    "---", "id: DEC-0042", "created: 2026-09-01", "status: accepted", "selected_option: 用 SQLite FTS5 做全文检索", "project: decision",
    "options_presented:", "  - Elasticsearch 集群", "  - SQLite FTS5", "constraints_revealed:", "  - 只能在本机离线运行", "---",
    "# 全文检索选型", "", "## 决策", "用 SQLite FTS5。", "",
  ].join("\n");
  const historical = parseDecisionContextNote({ relativePath: "Decision Journal/summarize/DEC-0042.md", content, contentHash: "1".repeat(64), size: content.length, modifiedAtMs: 0 }, "summarize")!;
  const documents = [historical, note("DEC-1", "会话过期", "会话按 30 分钟过期。")];
  expect((await search(documents, "Elasticsearch")).results.map((result) => result.id)).toEqual(["DEC-0042"]);
  expect((await search(documents, "离线运行")).results.map((result) => result.id)).toEqual(["DEC-0042"]);
});

// The template's words are in every decision the App wrote: left out of what was counted as holding a word, 复盘 was
// one note's alone, outweighed the query's subject, and "缓存的复盘" found the one reviewed note, not the caching ones.
it("counts the template's words as held by every note, so a step's name does not outweigh the query's subject", async () => {
  const caching = Array.from({ length: 12 }, (_, n) => recorded(`CACHE-${String(n).padStart(2, "0")}`, {
    question: `会话缓存第 ${n} 处的过期时间怎么定？`, selectedAnswer: { kind: "custom", values: ["30 分钟"] }, rationaleOriginal: "缓存命中率优先。",
  }));
  const reviewed = recorded("LOGS", {
    question: "日志保留多久？", selectedAnswer: { kind: "custom", values: ["30 天"] }, rationaleOriginal: "合规要求。",
    outcome: "上线后磁盘涨得很快。", outcomeReview: { verdict: "worse", lesson: "保留期要按日志量评估。", reviewedAt: "2026-09-20T00:00:00.000Z" },
  });
  const others = Array.from({ length: 40 }, (_, n) => recorded(`OTHER-${String(n).padStart(2, "0")}`, {
    question: `第 ${n} 个部署问题怎么处理？`, selectedAnswer: { kind: "custom", values: ["按流程"] }, rationaleOriginal: "按团队流程走。",
  }));
  const documents = [...caching, reviewed, ...others];
  const found = async (query: string) => {
    const response = await service(documents).search(decisionContextQuerySchema.parse({ query, limit: 20 }));
    return { total: response.total, ids: response.results.map((result) => result.id).sort() };
  };
  const cachingIds = caching.map((document) => document.id).sort();

  const queries = ["缓存的复盘", "缓存的预期结果", "会话缓存的后续结果"];
  expect(Object.fromEntries(await Promise.all(queries.map(async (query) => [query, await found(query)] as const))))
    .toEqual(Object.fromEntries(queries.map((query) => [query, { total: 12, ids: cachingIds }])));
  // A step's name alone still finds only the decision that took it.
  expect(await found("复盘")).toEqual({ total: 1, ids: ["LOGS"] });
});

// An English question's function words: in a journal written mostly in Chinese, few notes hold "a" or "is", so they weighed
// as much as its subject, and a note on the release cadence came back for a question on retrying jobs.
it("does not take an English question's function words for its subject", async () => {
  const documents = [
    note("REL-1", "Release cadence", "Ship a release every two weeks, and the release branch is cut on Monday."),
    note("RTY-2", "Job retries", "Failed jobs in the queue are retried three times with backoff."),
    ...Array.from({ length: 6 }, (_, n) => note(`ZH-${n}`, `缓存分层 ${n}`, `缓存的取舍 ${n}`)),
  ];
  const ids = (await search(documents, "what is the policy for retrying a job in the queue")).results.map((result) => result.id);
  expect(ids).toEqual(["RTY-2"]);
});

// A query of function words alone has no term left: taken for a phrase, "it" was found inside "with" and "git".
it("finds a query of function words alone only as a word, not inside other words", async () => {
  const documents = [note("GIT-1", "Git hooks", "Run the checks with a git hook before every commit.")];
  expect((await search(documents, "it")).results).toEqual([]);
});

// Written in capitals, CAN, IT and IN are a bus, a department and SQL's operator, not function words: taken out, "CAN 总线"
// found only the note on 总线 alone (R8 white box).
it("keeps a word written in capitals though it is spelt as a function word", async () => {
  const documents = [
    note("CAN-1", "CAN", "CAN"), note("BUS-2", "总线", "总线"),
    note("SQL-3", "IN", "IN"), note("SQL-4", "SQL", "SQL"),
    ...Array.from({ length: 4 }, (_, n) => note(`ZH-${n + 5}`, `缓存分层 ${n}`, `缓存的取舍 ${n}`)),
  ];
  expect((await search(documents, "CAN 总线")).results.map((result) => result.id)).toContain("CAN-1");
  expect((await search(documents, "SQL IN")).results.map((result) => result.id)).toContain("SQL-3");
  // Lower case, or a sentence's first word, it is still a function word.
  expect((await search(documents, "can it be done in sql")).results.map((result) => result.id)).toEqual(["SQL-4"]);
});
