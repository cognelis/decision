import { createJournalEntry, RationaleQueue, type JournalEntry } from "@cognelis/decision-core";
import { CONTEXT_SHAPE, CONTEXT_SHAPE_HEADER, contextAsReleased, decisionContextQuerySchema, type DecisionAmendmentRequest, type ProactiveRecordRequest } from "@cognelis/decision-protocol";
import { DecisionAmendmentRepository, type DecisionContextDocument, type DecisionContextSnapshot } from "@cognelis/decision-storage";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { amendedRepository, amendmentStateOf, DecisionAmendmentService, entriesForConsultation, journalContentHash } from "../src/main/decision-context-amendments.js";
import { DecisionContextService } from "../src/main/decision-context-service.js";
import { ContextSearch } from "../src/main/decision-context-signals.js";
import { LocalCaptureServer } from "../src/main/local-server.js";
import { possibleDuplicates } from "../src/main/possible-duplicates.js";

const q = (value: Parameters<typeof decisionContextQuerySchema.parse>[0]) => decisionContextQuerySchema.parse(value);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const base = { amendVersion: 1, sourceClient: "claude-code" } as const;

const summaryDoc = (body = "## 决策问题\n缓存放哪里？", extra: Partial<DecisionContextDocument> = {}): DecisionContextDocument => ({
  id: "S-1", source: "summarize", kind: "summarized_decision", title: "缓存选型", project: "paraself", status: "accepted", created: "2026-09-01",
  summary: "缓存放进程内。", appliesWhen: "单机部署", caution: null, tags: [], supersedes: [], supersededBy: [],
  relativePath: "Decision Journal/summarize/S-1.md", client: null, sessionId: null, body, bodyStartLine: 1, contentHash: sha(body), ...extra,
});
const entry = (id: string, kind: "preference" | "idea", title: string, content: string): JournalEntry => createJournalEntry(
  kind === "preference" ? { kind, title, content, appliesWhen: "写代码时", exceptions: "原型除外" } : { kind, title, content, whyInteresting: "有意思" },
  { sourceKind: "app_manual", sourceForm: "user_original", project: null }, id, new Date("2026-10-01T00:00:00Z"));

const setup = async (documents: () => DecisionContextDocument[] = () => [summaryDoc()], entries: () => JournalEntry[] = () => [entry("P-1", "preference", "命名用完整单词", "变量名不缩写。")]) => {
  const vault = await mkdtemp(join(tmpdir(), "amend-"));
  const repository = new DecisionAmendmentRepository(vault);
  const snapshot = async (): Promise<DecisionContextSnapshot> => ({
    documents: documents(),
    sources: [{ source: "summarize", status: "ready", records: documents().length, skipped: 0 }],
  });
  const service = new DecisionAmendmentService(repository, {
    find: async (source, recordId) => {
      if (source === "preferences" || source === "ideas") {
        const found = entries().find((item) => item.id === recordId);
        return found === undefined ? null : { contentHash: journalContentHash(found), summary: found.content, appliesWhen: found.kind === "preference" ? found.appliesWhen : null, caution: found.kind === "preference" ? found.exceptions : null };
      }
      const document = documents().find((item) => item.id === recordId && item.source === source);
      return document === undefined ? null : { contentHash: document.contentHash!, summary: document.summary, appliesWhen: document.appliesWhen, caution: document.caution };
    },
  });
  const search = new ContextSearch(
    new DecisionContextService(amendedRepository({ scan: snapshot }, repository)),
    { scan: async () => ({ entries: entries(), diagnostics: [] }) },
    undefined,
    repository,
  );
  return { vault, repository, service, search };
};
const append = (text: string, over: Partial<DecisionAmendmentRequest> = {}) =>
  ({ ...base, source: "summarize", recordId: "S-1", action: "append", text, basis: "user_said", ...over }) as DecisionAmendmentRequest;

describe("append", () => {
  it("adds a dated text beside the record, found by its words, the original note untouched", async () => {
    const { vault, service, search, repository } = await setup();
    expect(await service.update(append("多实例部署时改用 Redis，这是用户在会话里补充的"))).toMatchObject({ status: "saved", revision: 1, originalUnchanged: true });
    const found = await search.search(q({ query: "Redis", source: "summarize" }));
    expect(found.results.map((record) => record.id)).toEqual(["S-1"]);
    expect(found.results[0]!.amendment).toMatchObject({ revision: 1, amendments: [{ n: 1, client: "claude-code", basis: "user_said", text: expect.stringContaining("Redis") }] });
    expect(found.results[0]!.warnings.join()).toMatch(/已被 claude-code 于 \d{4}-\d{2}-\d{2} 增补.*不是用户原话/u);
    // The note's own excerpt holds none of the addition: its words and line numbers are the note's.
    expect(found.results[0]!.sourceRef.excerpt).not.toContain("Redis");
    expect(found.results[0]!.sourceRef.excerptStartLine).toBe(1);
    expect(found.results[0]!.summary).toBe("缓存放进程内。");
    // The word is in no note but the amendment's, which is a file of its own.
    expect(await readdir(join(vault, "Decision Journal", "decision-amendments"))).toHaveLength(1);
    expect(await readFile(join(vault, repository.relativePath("summarize", "S-1")), "utf8")).toContain("Redis");
    // Browsing without a query shows it too.
    expect((await search.search(q({ source: "summarize" }))).results[0]!.amendment?.revision).toBe(1);
  });

  it("is acknowledged, not added twice, when the same text is sent again, and counts each new one", async () => {
    const { service } = await setup();
    await service.update(append("第一条"));
    expect(await service.update(append("第一条"))).toMatchObject({ status: "unchanged", revision: 1 });
    expect(await service.update(append("第二条", { basis: "user_confirmed", reason: "用户同意了这个说法" }))).toMatchObject({ status: "saved", revision: 2 });
  });

  it("refuses an unknown record and a principle", async () => {
    const { service } = await setup();
    expect(await service.update(append("x", { recordId: "none" }))).toMatchObject({ status: "not_found" });
    expect(() => service.update({ ...append("x"), source: "principles" } as never)).rejects.toThrow();
  });
});

describe("revise", () => {
  const revise = (revision: number, hash: string, summary: string, over: Partial<DecisionAmendmentRequest> = {}) =>
    ({ ...base, source: "summarize", recordId: "S-1", action: "revise", expectedContentHash: hash, expectedRevision: revision, fields: { summary }, reason: "用户改了说法", ...over }) as DecisionAmendmentRequest;

  it("shows the rewrite, keeps what it replaced in the history, and finds the words of the new text", async () => {
    const { service, search } = await setup();
    const hash = summaryDoc().contentHash!;
    expect(await service.update(revise(0, hash, "缓存放 Redis，进程内只做一级缓存。"))).toMatchObject({ status: "saved", revision: 1 });
    expect(await service.update(revise(1, hash, "缓存统一放 Redis。"))).toMatchObject({ status: "saved", revision: 2 });
    const [record] = (await search.search(q({ query: "统一放", source: "summarize" }))).results;
    expect(record!.summary).toBe("缓存统一放 Redis。");
    expect(record!.amendment!.history.map((item) => [item.action, item.before?.summary])).toEqual([
      ["revise", "缓存放进程内。"], ["revise", "缓存放 Redis，进程内只做一级缓存。"],
    ]);
    expect(record!.amendment!.revised).toMatchObject({ stale: false, fields: ["summary"], reason: "用户改了说法" });
    // An unchanged rewrite adds no revision.
    expect(await service.update(revise(2, hash, "缓存统一放 Redis。"))).toMatchObject({ status: "unchanged", revision: 2 });
  });

  it("is refused when the original changed or the amendment revision is out of date", async () => {
    const { service } = await setup();
    const hash = summaryDoc().contentHash!;
    expect(await service.update(revise(0, sha("other"), "x"))).toMatchObject({ status: "source_changed" });
    await service.update(revise(0, hash, "新说法"));
    expect(await service.update(revise(0, hash, "更新的说法"))).toMatchObject({ status: "revision_conflict", revision: 1 });
  });

  it("stops applying a rewrite once the original has changed, but keeps the added texts", async () => {
    let document = summaryDoc();
    const { service, search } = await setup(() => [document]);
    await service.update(append("多实例用 Redis"));
    await service.update(revise(1, document.contentHash!, "改写后的说法"));
    // A summary made again, as the App does: its body and so its hash are new.
    document = summaryDoc("## 决策问题\n缓存放哪里？\n重新生成的内容。");
    const [record] = (await search.search(q({ source: "summarize" }))).results;
    expect(record!.summary).toBe("缓存放进程内。");
    expect(record!.amendment).toMatchObject({ revision: 2, amendments: [{ text: "多实例用 Redis" }], revised: { stale: true } });
    expect(record!.warnings.join()).toContain("修改已失效（原笔记已变化）");
    expect((await search.search(q({ query: "Redis", source: "summarize" }))).results.map((item) => item.id)).toEqual(["S-1"]);
    // Rewritten again against the new original.
    expect(await service.update(revise(2, document.contentHash!, "重新生成后的改写"))).toMatchObject({ status: "saved", revision: 3 });
  });

  it("rewrites a preference's condition and clears its exception", async () => {
    const { service, search } = await setup();
    const original = entry("P-1", "preference", "命名用完整单词", "变量名不缩写。");
    await service.update({ ...base, source: "preferences", recordId: "P-1", action: "revise", expectedContentHash: journalContentHash(original), expectedRevision: 0,
      fields: { appliesWhen: "写 TypeScript 时", caution: null }, reason: "用户收窄了范围" });
    const [record] = (await search.search(q({ source: "preferences" }))).results;
    expect(record).toMatchObject({ appliesWhen: "写 TypeScript 时", caution: null, amendment: { history: [{ before: { appliesWhen: "写代码时", caution: "原型除外" } }] } });
  });
});

describe("withdraw", () => {
  const withdraw = (source: "preferences" | "decisions", id: string, revision = 0) =>
    ({ ...base, source, recordId: id, action: "withdraw", expectedRevision: revision, reason: "用户不再这样想" }) as DecisionAmendmentRequest;

  it("leaves a withdrawn preference out unless asked, says why, and keeps it for a consultation out", async () => {
    const entries = [entry("P-1", "preference", "命名用完整单词", "变量名不缩写。"), entry("P-2", "preference", "注释写原因", "注释说为什么。")];
    const { service, search, repository } = await setup(undefined, () => entries);
    expect(await service.update(withdraw("preferences", "P-1"))).toMatchObject({ status: "saved", revision: 1 });
    expect(await service.update(withdraw("preferences", "P-1", 1))).toMatchObject({ status: "unchanged" });
    expect((await search.search(q({ source: "preferences" }))).results.map((record) => record.id)).toEqual(["P-2"]);
    const shown = await search.search(q({ source: "preferences", includeWithdrawn: true }));
    expect(shown.results.find((record) => record.id === "P-1")).toMatchObject({ status: "withdrawn", current: false, amendment: { withdrawn: { reason: "用户不再这样想" } } });
    expect(shown.results.find((record) => record.id === "P-1")!.warnings.join()).toContain("用户已撤回");
    expect(entriesForConsultation(entries, (await repository.scan()).records).map((item) => item.id)).toEqual(["P-2"]);
  });

  it("is not offered for a decision", async () => {
    const { service } = await setup();
    expect(await service.update(withdraw("decisions", "S-1"))).toMatchObject({ status: "not_allowed" });
  });

  it("puts what was added to a preference into a consultation's text", async () => {
    const entries = [entry("P-1", "preference", "命名用完整单词", "变量名不缩写。")];
    const { service, repository } = await setup(undefined, () => entries);
    await service.update({ ...base, source: "preferences", recordId: "P-1", action: "append", text: "循环变量 i、j 可以缩写", basis: "user_said" });
    expect(entriesForConsultation(entries, (await repository.scan()).records)[0]!.content).toContain("循环变量 i、j 可以缩写");
  });
});

describe("possible duplicates", () => {
  const request = { recordVersion: 1, requestId: "r", sourceClient: "codex", kind: "preference", title: "命名", content: "不缩写" } as unknown as ProactiveRecordRequest;
  const found = (id: string, similarity: number | undefined, source = "preferences") => ({ id, source, title: `标题 ${id}`, similarity });
  const answer = (results: unknown[]) => async () => ({ results } as never);

  it("lists the near existing records but not the one just written, at most 3, nearest first", async () => {
    const duplicates = await possibleDuplicates(answer([found("NEW", 0.99), found("A", 0.9), found("B", 0.8), found("C", 0.78), found("D", 0.76), found("E", undefined)]), request, "NEW");
    expect(duplicates.map((item) => item.id)).toEqual(["A", "B", "C"]);
    expect(duplicates[0]).toMatchObject({ source: "preferences", title: "标题 A", similarity: 0.9 });
  });

  it("asks for meaning alone, within the kind written, and says nothing when the search fails or is slow", async () => {
    let asked: unknown;
    await possibleDuplicates(async (query) => { asked = query; return { results: [] } as never; }, request, "NEW");
    expect(asked).toMatchObject({ mode: "semantic", source: ["preferences"], minSimilarity: 0.7 });
    await possibleDuplicates(async (query) => { asked = query; return { results: [] } as never; }, { ...request, kind: "decision" } as ProactiveRecordRequest, "NEW");
    expect(asked).toMatchObject({ source: ["decisions", "summarize"] });
    expect(await possibleDuplicates(async () => { throw new Error("no model"); }, request, "NEW")).toEqual([]);
  });

  it("is told to a bridge that asks for the new shape only", async () => {
    const token = "dupe-token-".padEnd(64, "x");
    const server = new LocalCaptureServer({
      queue: new RationaleQueue(), token,
      recordJournalEntry: async () => ({ recordVersion: 1, status: "created", recordKind: "preference", recordId: "P-9", knowledgeStatus: "active", sensitivity: "private", storedTranscript: false,
        possibleDuplicates: [{ source: "preferences", id: "P-1", title: "命名", similarity: 0.9 }] }),
    });
    const { host, port } = await server.start();
    const post = async (shaped: boolean) => (await (await fetch(`http://${host}:${port}/v1/journal-entries`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(shaped ? { [CONTEXT_SHAPE_HEADER]: CONTEXT_SHAPE } : {}) },
      body: JSON.stringify({ recordVersion: 1, requestId: "r", sourceClient: "codex", sourceKind: "agent_capture", sourceForm: "machine_summary", sensitivity: "private", kind: "idea", title: "t", content: "c", project: "p" }),
    })).json()) as Record<string, unknown>;
    try {
      expect(await post(true)).toHaveProperty("possibleDuplicates");
      expect(await post(false)).not.toHaveProperty("possibleDuplicates");
    } finally {
      await server.stop();
    }
  });
});

describe("review fixes (CS-1-F)", () => {
  const revise = (revision: number, hash: string, summary: string, over: Record<string, unknown> = {}) =>
    ({ ...base, source: "summarize", recordId: "S-1", action: "revise", expectedContentHash: hash, expectedRevision: revision, fields: { summary }, reason: "用户改了说法", ...over }) as DecisionAmendmentRequest;

  it("keeps the words of a stale rewrite when the next one replaces it, and shows its values while stale", async () => {
    let document = summaryDoc();
    const { service, search } = await setup(() => [document]);
    await service.update(revise(0, document.contentHash!, "用户批准过的改写"));
    document = summaryDoc("## 决策问题\n重新生成。");
    const [stale] = (await search.search(q({ source: "summarize" }))).results;
    expect(stale!.amendment!.revised).toMatchObject({ stale: true, values: { summary: "用户批准过的改写" } });
    await service.update(revise(1, document.contentHash!, "基于新原文的改写"));
    const [after] = (await search.search(q({ source: "summarize" }))).results;
    expect(after!.amendment!.history.at(-1)).toMatchObject({ action: "revise", replacedOverride: { summary: "用户批准过的改写" } });
  });

  it("never cuts a rewrite's replaced text from the history, and says limit_reached when only those are left", async () => {
    const { service, search, repository } = await setup();
    const hash = summaryDoc().contentHash!;
    await service.update(revise(0, hash, "第一次改写"));
    // 70 appends: the history holds 60, the oldest appends going and the rewrite's record staying.
    for (let n = 0; n < 70; n += 1) await service.update(append(`补充 ${n}`));
    const [record] = (await search.search(q({ source: "summarize" }))).results;
    const stored = (await repository.scan()).records.get("summarize:S-1")!;
    expect(stored.history).toHaveLength(60);
    expect(stored.history.some((item) => item.action === "revise" && item.before?.summary === "缓存放进程内。")).toBe(true);
    expect(record!.amendment!.amendments).toHaveLength(70);
    // Only rewrites in the history: nothing more can be taken in, and it says so rather than failing.
    const only = await setup();
    let revision = 0;
    const results: string[] = [];
    for (let n = 0; n < 62; n += 1) {
      const answer = await only.service.update(revise(revision, hash, `改写 ${n}`));
      results.push(answer.status);
      if (answer.status === "saved") revision = answer.revision;
    }
    expect(results.slice(0, 60).every((status) => status === "saved")).toBe(true);
    expect(results.slice(60)).toEqual(["limit_reached", "limit_reached"]);
  });

  it("marks what an agent changed as not the user's own words, in a search and in a consultation, and asks for the user's word", async () => {
    const entries = [entry("P-1", "preference", "命名用完整单词", "变量名不缩写。")];
    const { vault, repository, search } = await setup(undefined, () => entries);
    const service = new DecisionAmendmentService(repository, { find: async (source, id) => {
      const found = entries.find((item) => item.id === id)!;
      return { contentHash: journalContentHash(found), userWrote: true, summary: found.content, appliesWhen: null, caution: null };
    } });
    void vault;
    const hash = journalContentHash(entries[0]!);
    const request = { ...base, source: "preferences", recordId: "P-1", action: "revise", expectedContentHash: hash, expectedRevision: 0, fields: { summary: "变量名可缩写" }, reason: "用户改了" } as DecisionAmendmentRequest;
    expect(await service.update(request)).toMatchObject({ status: "basis_required" });
    expect(await service.update({ ...request, basis: "user_confirmed" } as DecisionAmendmentRequest)).toMatchObject({ status: "saved" });
    const [record] = (await search.search(q({ source: "preferences" }))).results;
    expect(record!.summary).toBe("变量名可缩写");
    expect(record!.warnings.join()).toContain("已被 claude-code");
    expect(record!.warnings.join()).toContain("原话：变量名不缩写。");
    expect(record!.amendment!.history.at(-1)).toMatchObject({ basis: "user_confirmed" });
    const consulted = entriesForConsultation(entries, (await repository.scan()).records)[0]!.content;
    expect(consulted).toContain("已被 claude-code");
    expect(consulted).toContain("原话：变量名不缩写。");
    expect(await service.update({ ...base, source: "preferences", recordId: "P-1", action: "withdraw", expectedRevision: 1, reason: "r" } as DecisionAmendmentRequest)).toMatchObject({ status: "basis_required" });
  });

  it("restores a withdrawn preference by restore, and by the same one being recorded again", async () => {
    const { service, search, repository } = await setup();
    const withdraw = (revision: number) => ({ ...base, source: "preferences", recordId: "P-1", action: "withdraw", expectedRevision: revision, reason: "不要了" }) as DecisionAmendmentRequest;
    await service.update(withdraw(0));
    expect((await search.search(q({ source: "preferences" }))).results).toHaveLength(0);
    expect(await service.update({ ...base, source: "preferences", recordId: "P-1", action: "restore", basis: "user_said", expectedRevision: 1, reason: "又要了" } as DecisionAmendmentRequest)).toMatchObject({ status: "saved", revision: 2 });
    const [back] = (await search.search(q({ source: "preferences" }))).results;
    expect(back).toMatchObject({ id: "P-1", amendment: { withdrawn: null, history: [{ action: "withdraw" }, { action: "restore", basis: "user_said" }] } });
    // Without a basis a restore is refused before it is sent, and a decision has none.
    expect(() => service.update({ ...base, source: "preferences", recordId: "P-1", action: "restore", expectedRevision: 2, reason: "r" } as never)).rejects.toThrow();
    // Recorded again: the withdrawal ends, once.
    await service.update(withdraw(2));
    expect(await repository.clearWithdrawal("preferences", "P-1", "codex")).toBe(true);
    expect(await repository.clearWithdrawal("preferences", "P-1", "codex")).toBe(false);
    expect((await search.search(q({ source: "preferences" }))).results.map((record) => record.id)).toEqual(["P-1"]);
  });

  it("append said again within a day is one, another day is a new one", async () => {
    const { repository } = await setup();
    const record = { contentHash: summaryDoc().contentHash!, effective: { summary: "s", appliesWhen: null, caution: null } };
    const t0 = new Date("2026-11-11T00:00:00Z");
    const at = (hours: number) => new Date(t0.getTime() + hours * 3_600_000);
    expect(await repository.save(append("同一句"), record, t0)).toMatchObject({ status: "saved", revision: 1 });
    expect(await repository.save(append("同一句"), record, at(1))).toMatchObject({ status: "unchanged", revision: 1 });
    expect(await repository.save(append("同一句"), record, at(25))).toMatchObject({ status: "saved", revision: 2 });
  });
});

describe("a decision's own words (CS-3)", () => {
  const original = { question: "决策工作流应该从设置中拆出吗？", choice: "建立独立决策中心", rationale: "更容易维护", context: "设置页已有 9 个分区。", expectedOutcome: "找历史决策降到 10 秒。" };
  const decisionDoc = (hash = sha("d1")): DecisionContextDocument => ({
    id: "D-1", source: "decisions", kind: "recorded_decision", title: original.question, project: "paraself", status: "accepted", created: "2026-07-30",
    summary: original.choice, appliesWhen: null, caution: null, tags: [], supersedes: [], supersededBy: [], relativePath: "Decision Journal/decisions/D-1.md",
    client: null, sessionId: null, body: "## 决策\n建立独立决策中心", bodyStartLine: 1, contentHash: hash,
    outcomeState: { expectedOutcome: original.expectedOutcome, outcome: null, review: null, reviewDueDate: null },
  });
  const make = async (doc: () => DecisionContextDocument = decisionDoc) => {
    const vault = await mkdtemp(join(tmpdir(), "amend-dec-"));
    const repository = new DecisionAmendmentRepository(vault);
    const service = new DecisionAmendmentService(repository, { find: async (source, id) => {
      const d = doc();
      return source === "decisions" && id === "D-1" ? { contentHash: d.contentHash!, summary: d.summary, appliesWhen: null, caution: null, decision: original } : null;
    } });
    const search = new ContextSearch(new DecisionContextService(amendedRepository({ scan: async () => ({ documents: [doc()], sources: [{ source: "decisions", status: "ready", records: 1, skipped: 0 }] }) }, repository)), undefined, undefined, repository);
    return { repository, service, search };
  };
  const revise = (fields: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    ({ ...base, source: "decisions", recordId: "D-1", action: "revise", expectedContentHash: sha("d1"), expectedRevision: 0, fields, reason: "用户改了", basis: "user_said", ...over }) as DecisionAmendmentRequest;

  it("rewrites question, choice, rationale, context and expected result; a search shows them, with the original words", async () => {
    const { service, search } = await make();
    expect(await service.update(revise({ question: "决策工作流要不要从设置里拆出来？", choice: "建立独立决策中心，先只放决策和复盘", rationale: "更容易维护，也有回退路径", context: null, expectedOutcome: "一个月内降到 10 秒以内" }))).toMatchObject({ status: "saved", revision: 1 });
    const [record] = (await search.search(q({ source: "decisions" }))).results;
    expect(record).toMatchObject({ title: "决策工作流要不要从设置里拆出来？", summary: "建立独立决策中心，先只放决策和复盘", outcomeState: { expectedOutcome: "一个月内降到 10 秒以内" } });
    expect(record!.amendment!.revised).toMatchObject({ stale: false, fields: ["question", "choice", "rationale", "context", "expectedOutcome"], values: { rationale: "更容易维护，也有回退路径", context: null } });
    // The words as the reader wrote them, per field: found back, though the note itself was never written.
    expect(record!.amendment!.originals).toEqual({ ...original, context: original.context });
    expect(record!.warnings.join()).toContain("已被 claude-code");
    expect(record!.warnings.join()).toContain("question=决策工作流应该从设置中拆出吗？");
  });

  it("is found by the words of a rewrite, and put back by a rewrite of its own", async () => {
    const { service, search } = await make();
    await service.update(revise({ rationale: "独立出来之后可以单独回退" }));
    expect((await search.search(q({ source: "decisions", query: "单独回退" }))).results.map((item) => item.id)).toEqual(["D-1"]);
    const before = (await search.search(q({ source: "decisions" }))).results[0]!.amendment!.history.at(-1)!.before!;
    expect(before).toEqual({ rationale: original.rationale });
    expect(await service.update(revise(before, { expectedRevision: 1 }))).toMatchObject({ status: "saved", revision: 2 });
  });

  it("needs the user's basis, and is a decision's alone", async () => {
    const { service } = await make();
    expect(await service.update(revise({ rationale: "x" }, { basis: undefined }))).toMatchObject({ status: "basis_required" });
    expect(await service.update(revise({ rationale: "x" }, { basis: "user_confirmed" }))).toMatchObject({ status: "saved" });
    const { repository } = await setup();
    expect(await repository.save({ ...base, source: "summarize", recordId: "S-1", action: "revise", expectedContentHash: sha("x"), expectedRevision: 0, fields: { rationale: "x" }, reason: "r", basis: "user_said" } as DecisionAmendmentRequest,
      { contentHash: sha("x"), effective: { summary: "s", appliesWhen: null, caution: null } })).toMatchObject({ status: "not_allowed" });
  });

  it("refuses when the note changed or the revision is old, and keeps a rewrite across an outcome being written (rebind)", async () => {
    let doc = decisionDoc();
    const { service, repository, search } = await make(() => doc);
    expect(await service.update(revise({ choice: "改过的选择" }, { expectedContentHash: sha("other") }))).toMatchObject({ status: "source_changed" });
    expect(await service.update(revise({ choice: "改过的选择" }, { expectedRevision: 3 }))).toMatchObject({ status: "revision_conflict" });
    await service.update(revise({ choice: "改过的选择" }));
    // The App writes the outcome: the note's hash moves on, and the rewrite goes with it.
    expect(await repository.rebind({ source: "decisions", recordId: "D-1" }, sha("d1"), sha("d2"))).toBe(0);
    doc = decisionDoc(sha("d2"));
    const [record] = (await search.search(q({ source: "decisions" }))).results;
    expect(record).toMatchObject({ summary: "改过的选择" });
    expect(record!.amendment!.revised!.stale).toBe(false);
  });
});

describe("review fixes (CS-3-F)", () => {
  const original = { question: "决策工作流应该从设置中拆出吗？", choice: "建立独立决策中心", rationale: "更容易维护", context: "设置页已有 9 个分区。", expectedOutcome: "找历史决策降到 10 秒。" };
  const doc = (hash: string): DecisionContextDocument => ({
    id: "D-1", source: "decisions", kind: "recorded_decision", title: original.question, project: "paraself", status: "accepted", created: "2026-07-30",
    summary: original.choice, appliesWhen: null, caution: null, tags: [], supersedes: [], supersededBy: [], relativePath: "Decision Journal/decisions/D-1.md",
    client: null, sessionId: null, body: "## 决策\n建立独立决策中心", bodyStartLine: 1, contentHash: hash,
  });
  const rev = (fields: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    ({ ...base, source: "decisions", recordId: "D-1", action: "revise", expectedContentHash: sha("d1"), expectedRevision: 0, fields, reason: "用户改了", basis: "user_said", ...over }) as DecisionAmendmentRequest;
  const make = async (hashes: () => string[]) => {
    const vault = await mkdtemp(join(tmpdir(), "amend-fix-"));
    const repository = new DecisionAmendmentRepository(vault);
    let calls = 0;
    const find = async () => { const list = hashes(); const hash = list[Math.min(calls++, list.length - 1)]!; return { contentHash: hash, summary: original.choice, appliesWhen: null, caution: null, decision: original }; };
    const service = new DecisionAmendmentService(repository, { find });
    return { repository, service };
  };

  it("takes a decision's summary as its choice: refused as a summary, so there is one path with a basis", async () => {
    const { service } = await make(() => [sha("d1")]);
    expect(await service.update(rev({ summary: "绕过依据的选择" }, { basis: undefined }))).toMatchObject({ status: "not_allowed" });
    expect(await service.update(rev({ choice: "新选择" }, { basis: undefined }))).toMatchObject({ status: "basis_required" });
    expect(await service.update(rev({ choice: "新选择" }))).toMatchObject({ status: "saved" });
  });

  it("does not write a rewrite over a note that moved on while it waited in the queue (rebind and agent write racing)", async () => {
    // The lookup read the note as d1; by the time the write's turn comes the App has written a review: d2.
    const { service, repository } = await make(() => [sha("d1"), sha("d2")]);
    expect(await service.update(rev({ rationale: "竞态中的改写" }))).toMatchObject({ status: "source_changed" });
    expect((await repository.scan()).records.size).toBe(0);
    // A rewrite held at d1 is moved to d2 by the rebind, and the agent's, still made against d1, is refused.
    const second = await make(() => [sha("d1")]);
    await second.service.update(rev({ rationale: "先写的" }));
    const [moved, late] = await Promise.all([
      second.repository.rebind({ source: "decisions", recordId: "D-1" }, sha("d1"), sha("d2")),
      new DecisionAmendmentService(second.repository, { find: async () => ({ contentHash: sha("d2"), summary: original.choice, appliesWhen: null, caution: null, decision: original }) }).update(rev({ rationale: "晚到的" }, { expectedRevision: 1 })),
    ]);
    expect(moved).toBe(0);
    expect(late).toMatchObject({ status: "source_changed" });
    expect((await second.repository.scan()).records.get("decisions:D-1")!.overrides!.contentHash).toBe(sha("d2"));
  });

  it("puts back the whole text a rewrite replaced, by its revision, though the page and the agent see a cut of it", async () => {
    const long = `开头${"很长的理由。".repeat(400)}结尾`;
    const vault = await mkdtemp(join(tmpdir(), "amend-revert-"));
    const repository = new DecisionAmendmentRepository(vault);
    const found = { contentHash: sha("d1"), summary: original.choice, appliesWhen: null, caution: null, decision: { ...original, rationale: long } };
    const service = new DecisionAmendmentService(repository, { find: async () => found });
    await service.update(rev({ rationale: "短理由" }));
    const scanned = await repository.scan();
    const state = amendmentStateOf(scanned.records.get("decisions:D-1")!, sha("d1"), "x.md", 60);
    expect(state.history[0]).toMatchObject({ beforeTruncated: true });
    expect(state.history[0]!.before!.rationale!.length).toBeLessThan(long.length);
    expect(await service.update({ ...base, source: "decisions", recordId: "D-1", action: "revert", toRevision: 1, expectedContentHash: sha("d1"), expectedRevision: 1, reason: "恢复", basis: "user_said" } as DecisionAmendmentRequest)).toMatchObject({ status: "saved", revision: 2 });
    expect((await repository.scan()).records.get("decisions:D-1")!.overrides!.fields.rationale).toBe(long);
    expect(await service.update({ ...base, source: "decisions", recordId: "D-1", action: "revert", toRevision: 9, expectedContentHash: sha("d1"), expectedRevision: 2, reason: "恢复" } as DecisionAmendmentRequest)).toMatchObject({ status: "revision_unknown" });
  });

  it("says in the words of the warnings what an agent without `amendment` is told: the new values, a stale rewrite, and where the excerpt is from", async () => {
    let hash = sha("d1");
    const { repository, service } = await make(() => [hash]);
    await service.update(rev({ question: "新问题", rationale: "新理由" }));
    const search = new ContextSearch(new DecisionContextService(amendedRepository({ scan: async () => ({ documents: [doc(hash)], sources: [{ source: "decisions", status: "ready", records: 1, skipped: 0 }] }) }, repository)), undefined, undefined, repository);
    const [fresh] = (await search.search(q({ source: "decisions" }))).results;
    const released = contextAsReleased({ ...(await search.search(q({ source: "decisions" }))), results: [fresh!] } as never).results[0]!;
    expect(released).not.toHaveProperty("amendment");
    expect(released.title).toBe("新问题");
    expect(released.warnings.join()).toContain("改写后的值：");
    expect(released.warnings.join()).toContain("rationale=新理由");
    expect(released.warnings.join()).toContain("sourceRef.excerpt 是原笔记最初版本的摘录");
    // The note changed (Obsidian, a sync): the rewrite no longer holds, and says so, first.
    hash = sha("changed in obsidian");
    const [stale] = (await search.search(q({ source: "decisions" }))).results;
    expect(stale!.title).toBe(original.question);
    expect(stale!.warnings[0]).toContain("修改已失效（原笔记已变化）");
    expect(stale!.warnings.join()).not.toContain("改写后的值：");
  });
});
