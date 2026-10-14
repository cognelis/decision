import { expect, it } from "vitest";
import { decisionContextQuerySchema } from "@cognelis/decision-protocol";
import type { DecisionContextDocument } from "@cognelis/decision-storage";
import { DecisionContextService } from "../src/main/decision-context-service.js";

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
