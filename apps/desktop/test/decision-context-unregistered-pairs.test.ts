import { decisionContextQuerySchema, decisionContextResponseSchema, decisionRelationRecordSchema, type DecisionContextQuery, type DecisionRelationRecord } from "@cognelis/decision-protocol";
import { DecisionContextRepository, MarkdownRepository, type DecisionContextDocument, type DecisionContextSnapshot } from "@cognelis/decision-storage";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordFixture } from "../../../packages/storage/test/fixtures.js";
import { boundedWarnings, DecisionContextService, recordDay } from "../src/main/decision-context-service.js";

// IMP-175: each decision record says when it dates from; two that stand on a page with no judgment between them have the
// guidance say what to check, naming neither.
const UNJUDGED = "本页有未标记被替代、相互之间也没有登记替代、冲突或无关关系的决策记录";
const OTHER_PAGES = "其他页的记录没有和本页比较。";

const hash = (id: string) => [...id].map((character) => character.charCodeAt(0).toString(16)).join("").padEnd(64, "0").slice(0, 64);
const document = (id: string, overrides: Partial<DecisionContextDocument> = {}): DecisionContextDocument => ({
  id, source: "summarize", kind: "summarized_decision", title: id, project: "lab", status: "accepted",
  created: "2026-03-10", summary: "数据库连接池使用 HikariCP。", appliesWhen: null, caution: null,
  tags: ["synthetic"], supersedes: [], supersededBy: [], relativePath: `Decision Journal/summarize/${id}.md`,
  client: null, sessionId: null, body: "# 数据库连接池\n\n## 决策\n数据库连接池使用 HikariCP。", bodyStartLine: 11, contentHash: hash(id), ...overrides,
});
const decision = (id: string, overrides: Partial<DecisionContextDocument> = {}) => document(id, {
  source: "decisions", kind: "recorded_decision", status: "completed", created: "2026-10-29T12:33:56.421Z",
  relativePath: `Decision Journal/decisions/2026/10/20261029T123356421Z-${id}.md`, ...overrides,
});
const relation = (first: DecisionContextDocument, second: DecisionContextDocument, disposition: DecisionRelationRecord["disposition"], overrides: Partial<DecisionRelationRecord> = {}) =>
  decisionRelationRecordSchema.parse({
    first: { source: first.source, recordId: first.id, contentHash: first.contentHash },
    second: { source: second.source, recordId: second.id, contentHash: second.contentHash },
    disposition, successor: null, reason: "合成用户确认。", relationVersion: 1, revision: 1, updatedAt: "2026-10-01T00:00:00.000Z", history: [], ...overrides,
  });
const service = (documents: DecisionContextDocument[], overrides: Partial<DecisionContextSnapshot> = {}) => new DecisionContextService({
  scan: async () => ({ documents, sources: (["summarize", "decisions", "principles"] as const).map((source) => {
    const records = documents.filter((item) => item.source === source).length;
    return { source, records, skipped: 0, status: records > 0 ? "ready" as const : "empty" as const };
  }), ...overrides }),
});
const search = async (documents: DecisionContextDocument[], overrides: Partial<DecisionContextSnapshot> = {}, asked: Partial<DecisionContextQuery> = {}) => {
  const response = decisionContextResponseSchema.parse(await service(documents, overrides).search(decisionContextQuerySchema.parse({ query: "数据库连接池", project: "lab", ...asked })));
  return { response, guidance: response.guidance, byId: new Map(response.results.map((result) => [`${result.source}:${result.id}`, result])) };
};
const inZone = async <T>(zone: string, run: () => Promise<T> | T): Promise<T> => {
  const before = process.env.TZ;
  process.env.TZ = zone;
  try { return await run(); } finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; }
};

const older = document("HU01-a");
const newer = document("HU01-b", { created: "2026-09-05", summary: "数据库连接池使用 Druid，开启监控面板。" });

describe("a decision record's date", () => {
  it("keeps a calendar date as written and an instant with its zone as the day it was here, and nothing else", async () => {
    for (const valid of ["2026-03-10", "2028-02-29"]) expect(recordDay(valid)).toBe(valid);
    for (const invalid of ["2026-02-30", "2026-02-29", "2026-13-01", "2026-10-30garbage", "2026/10/30", "2026-10-30T12:00:00", "2026-10-30T25:00:00Z", "2026-10-30T12:00:00+08:60", ""]) {
      expect(recordDay(invalid), invalid).toBeNull();
    }
    const days = (zone: string) => inZone(zone, () => ["2026-10-29T20:00:00Z", "2026-10-30T00:30:00+08:00", "2026-10-29T22:00:00-05:00", "2026-10-29T16:00:00.000Z"].map(recordDay));
    expect(await days("Asia/Singapore")).toEqual(["2026-10-30", "2026-10-30", "2026-10-30", "2026-10-30"]);
    expect(await days("UTC")).toEqual(["2026-10-29", "2026-10-29", "2026-10-30", "2026-10-29"]);
  });

  it("says first on every summarize and App decision record, replaced or not, when it was made or else written", async () => {
    const replaced = document("OLD", { status: "superseded", supersededBy: ["HU01-b"], created: "2026-01-02" });
    const { byId } = await inZone("Asia/Singapore", () => search([older, newer, replaced,
      decision("told", { title: "数据库连接池", occurred: "2026-03-02T00:00:00Z" }),
      decision("written", { title: "数据库连接池", created: "2026-10-29T16:00:00.000Z" }),
      decision("misdated", { title: "数据库连接池", occurred: "2026/03/02" }),
      document("garbled", { created: "2026-10-30garbage" }),
      document("P1", { source: "principles", kind: "adopted_principle", title: "数据库连接池" }),
    ], {}, { limit: 20 }));
    expect(byId.get("summarize:HU01-a")?.warnings[0]).toBe("记录日期 2026-03-10。");
    expect(byId.get("summarize:OLD")?.warnings.slice(0, 2)).toEqual(["记录日期 2026-01-02。", "此记录已被替代或退役；核对后继记录后再判断当前约束，不以旧结论直接修改代码。"]);
    expect(byId.get("decisions:told")?.warnings[0]).toBe("决策日期 2026-03-02。");
    expect(byId.get("decisions:written")?.warnings[0]).toBe("记录日期 2026-10-30。");
    // One not a date is not stood in for by the day the App wrote it.
    expect(byId.get("decisions:misdated")?.warnings[0]).toBe("记录日期未知。");
    expect(byId.get("summarize:garbled")?.warnings[0]).toBe("记录日期未知。");
    expect(byId.get("principles:P1")?.warnings.join("\n")).not.toMatch(/日期/u);
  });

  it("gives way only to what says the record stands replaced or in doubt, and keeps the successors' room", () => {
    const successors = Array.from({ length: 5 }, (_, index) => `后继记录 summarize/S${index} 仍然有效。`);
    const telling = Array.from({ length: 6 }, (_, index) => `关键状态 ${index}`);
    const least = ["未记录结构化适用条件，请结合项目、原文和当前需求核对。", "关系超过展示上限，请查阅关系笔记核对完整历史。"];
    expect(boundedWarnings(["记录日期 2026-03-10。", ...telling.slice(0, 4), ...least, ...successors]))
      .toEqual(["记录日期 2026-03-10。", ...telling.slice(0, 4), least[0], ...successors.slice(0, 3), "另有 2 条后继记录未列出，请查阅关系笔记逐条核对。"]);
    expect(boundedWarnings(["记录日期 2026-03-10。", ...telling, ...least, ...successors]))
      .toEqual([...telling, ...successors.slice(0, 3), "另有 2 条后继记录未列出，请查阅关系笔记逐条核对。"]);
  });
});

describe("two records on a page with no judgment between them", () => {
  it("has the guidance say what to check, naming no record and counting none", async () => {
    const { guidance, byId } = await search([older, newer]);
    expect(guidance).toContain(`${UNJUDGED}，各条的日期写在它的警告里。`);
    expect(guidance).toContain("不要仅凭日期选择其中一条；用户确认后，可用 record_decision_relation 登记两条的关系。");
    expect(guidance).not.toContain(OTHER_PAGES);
    expect(guidance).not.toMatch(/HU01|\d 条/u);
    expect(byId.get("summarize:HU01-b")?.warnings[0]).toBe("记录日期 2026-09-05。");
  });

  it("says nothing for a record alone, a pair judged conflicting or unrelated, or one replaced", async () => {
    expect((await search([older])).guidance).not.toContain(UNJUDGED);
    for (const disposition of ["conflict", "unrelated"] as const) {
      expect((await search([older, newer], { relations: [relation(older, newer, disposition)] })).guidance, disposition).not.toContain(UNJUDGED);
    }
    const supersedes = relation(older, newer, "supersedes", { successor: older.id < newer.id ? "second" : "first" });
    expect((await search([older, newer], { relations: [supersedes] })).guidance).not.toContain(UNJUDGED);
  });

  it("reads one of three pairs judged as leaving the other two unjudged", async () => {
    const third = document("HU01-c", { created: "2026-06-01", summary: "数据库连接池使用 c3p0。" });
    expect((await search([older, newer, third], { relations: [relation(older, third, "unrelated")] })).guidance).toContain(UNJUDGED);
  });

  it("finds the judgment among every relationship a record has, not only the 20 shown", async () => {
    const others = Array.from({ length: 21 }, (_, index) => document(`X${index}`, { title: `X${index}`, summary: "日志保留三十天。", body: "日志保留三十天。" }));
    const relations = [relation(older, newer, "unrelated", { updatedAt: "2026-01-01T00:00:00.000Z" }),
      ...others.map((other) => relation(older, other, "unrelated", { updatedAt: "2026-10-02T00:00:00.000Z" }))];
    const { guidance, byId } = await search([older, newer, ...others], { relations });
    expect(byId.get("summarize:HU01-a")?.relations).toHaveLength(20);
    expect(byId.get("summarize:HU01-a")?.relations?.some((shown) => shown.other.recordId === newer.id)).toBe(false);
    expect(guidance).not.toContain(UNJUDGED);
  });

  it("tells records of two sources with one id apart", async () => {
    const summary = document("SAME");
    const recorded = decision("SAME", { title: "数据库连接池" });
    expect((await search([summary, recorded])).guidance).toContain(UNJUDGED);
    expect((await search([summary, recorded], { relations: [relation(summary, recorded, "unrelated")] })).guidance).not.toContain(UNJUDGED);
  });

  it("pairs records of one project only, read as the search reads project names", async () => {
    const web = [document("W1", { project: "web" }), document("W2", { project: "web" })];
    const apart = [...web, document("A1", { project: "api" }), document("N1", { project: null })];
    const judged = { relations: [relation(web[0]!, web[1]!, "unrelated")] };
    expect((await search(apart, judged, { project: undefined })).guidance).not.toContain(UNJUDGED);
    expect((await search([...apart, document("W3", { project: "ＷＥＢ" })], judged, { project: undefined })).guidance).toContain(UNJUDGED);
    expect((await search([...apart, document("N2", { project: null })], judged, { project: undefined })).guidance).toContain(UNJUDGED);
    expect((await search([...apart, document("W4", { project: " web" })], judged, { project: undefined })).guidance).not.toContain(UNJUDGED);
  });

  it("leaves out a pair in doubt over a stale judgment, and one replaced again once a judgment is withdrawn", async () => {
    const edited = { ...newer, contentHash: hash("edited") };
    const stale = await search([older, edited], { relations: [relation(older, newer, "unrelated")] });
    expect([...stale.byId.values()].map((result) => result.lifecycleState)).toEqual(["uncertain", "uncertain"]);
    expect(stale.guidance).not.toContain(UNJUDGED);
    const withdrawn = relation(older, newer, "revoked");
    expect((await search([older, newer], { relations: [withdrawn] })).guidance).toContain(UNJUDGED);
    const inline = [{ ...older, supersededBy: [newer.id] }, { ...newer, supersedes: [older.id] }];
    const restored = await search(inline, { relations: [withdrawn] });
    expect(restored.byId.get("summarize:HU01-a")?.current).toBe(false);
    expect(restored.guidance).not.toContain(UNJUDGED);
  });

  it("says other pages were not compared on a page with a next one and on the last of several", async () => {
    const four = [older, newer, document("HU01-c", { created: "2026-06-01" }), document("HU01-d", { created: "2026-06-02" })];
    const first = await search(four, {}, { limit: 2 });
    const last = await search(four, {}, { limit: 2, offset: 2 });
    expect([first.response.nextOffset, last.response.nextOffset]).toEqual([2, null]);
    for (const page of [first, last]) expect(page.guidance).toContain(`登记两条的关系。\n${OTHER_PAGES}`);
  });

  it("says so on every page of several, whether or not the page holds a pair, and on no page alone", async () => {
    const pages = await Promise.all([0, 1].map((offset) => search([older, newer], {}, { limit: 1, offset })));
    expect(pages.map((page) => page.response.nextOffset)).toEqual([1, null]);
    for (const page of pages) {
      expect(page.guidance).toContain(OTHER_PAGES);
      expect(page.guidance).not.toContain(UNJUDGED);
    }
    const third = document("HU01-c", { created: "2026-01-01" });
    const judged = await search([older, newer, third], { relations: [relation(older, newer, "unrelated")] }, { limit: 2 });
    expect(judged.response.results.map((result) => result.id)).toEqual(["HU01-b", "HU01-a"]);
    expect(judged.guidance).not.toContain(UNJUDGED);
    expect(judged.guidance).toContain(OTHER_PAGES);
    expect((await search([older, newer])).guidance).not.toContain(OTHER_PAGES);
  });

  it("keeps two pairs apart whatever their ids hold, a judgment off the page leaving this page's pair unjudged", async () => {
    const onPage = [document("A"), document("B\nsummarize:C")];
    const offPage = [document("A\nsummarize:B", { title: "日志", summary: "日志保留三十天。", body: "日志保留三十天。" }),
      document("C", { title: "日志", summary: "日志保留七天。", body: "日志保留七天。" })];
    const { byId, guidance } = await search([...onPage, ...offPage], { relations: [relation(offPage[0]!, offPage[1]!, "unrelated")] });
    expect([...byId.keys()].sort()).toEqual(["summarize:A", "summarize:B\nsummarize:C"]);
    expect(guidance).toContain(UNJUDGED);
  });

  it("stays within the guidance's 2,000 characters and each warning's 500 beside every other line it can hold", async () => {
    const documents = [older, newer, document("HU01-c", { created: "2026-06-01" })];
    const response = await new DecisionContextService(
      { scan: async () => ({ documents, sources: [{ source: "summarize", records: 3, skipped: 1, status: "partial" }] }) },
      undefined, undefined, { similarTo: () => async () => ({ unavailable: "model_missing" }) },
    ).search(decisionContextQuerySchema.parse({ query: "数据库连接池", project: "lab", limit: 2 }));
    expect(response.guidance).toContain("语义补充这次不可用");
    expect(response.guidance).toContain(OTHER_PAGES);
    expect(response.guidance.length).toBeLessThanOrEqual(2_000);
    expect(response.results.flatMap((result) => result.warnings).every((warning) => warning.length <= 500)).toBe(true);
  });
});

// From the note on disk to the response, in two zones: what the App wrote, what occurred_at a reader typed in Obsidian.
describe("a decision record's date from its note", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
  const notePath = async (vault: string, id: string) => {
    const files = await readdir(join(vault, "Decision Journal/decisions"), { recursive: true });
    return join(vault, "Decision Journal/decisions", files.find((file) => file.endsWith(".md") && file.includes(id.slice(0, 8)))!);
  };

  it.each(["Asia/Singapore", "UTC"])("dates each note as this machine's day in %s, and sets aside one whose occurred_at is no time", async (zone) => {
    const vault = await mkdtemp(join(tmpdir(), "decision-context-dates-")); roots.push(vault);
    await mkdir(join(vault, "Decision Journal/summarize"), { recursive: true });
    const legacy = (id: string, created: string) => `---\nid: ${id}\ncreated: ${created}\nstatus: accepted\nproject: lab\nselected_option: 数据库连接池使用 ${id}。\n---\n# 数据库连接池\n`;
    await writeFile(join(vault, "Decision Journal/summarize/plain.md"), legacy("plain", "2026-09-05"));
    await writeFile(join(vault, "Decision Journal/summarize/leap.md"), legacy("leap", "2026-02-29"));
    await writeFile(join(vault, "Decision Journal/summarize/tail.md"), legacy("tail", "2026-10-30garbage"));
    const notes = new MarkdownRepository(vault);
    const write = (id: string, occurredAt: string | null) => notes.write(recordFixture({ id, question: "数据库连接池", project: "lab", created: "2026-10-29T16:00:00.000Z", occurredAt }));
    await write("0001-told", "2026-10-29T20:00:00Z");
    await write("0002-offset", "2026-10-30T00:30:00+08:00");
    await write("0003-untold", null);
    await write("0004-slashed", null);
    await write("0005-nonsense", null);
    const retype = async (id: string, value: string) => {
      const path = await notePath(vault, id);
      await writeFile(path, (await readFile(path, "utf8")).replace(/^occurred_at: .*$/mu, `occurred_at: ${value}`));
    };
    await retype("0004-slashed", "2026/10/30");
    await retype("0005-nonsense", "not a time");
    // created as a reader may leave it in Obsidian: read as a time for lists and ranking, a date only as written.
    const rewrite = async (id: string, created: string) => {
      await write(id, null);
      const path = await notePath(vault, id);
      await writeFile(path, (await readFile(path, "utf8")).replace(/^created: .*$/mu, `created: ${created}`));
    };
    await rewrite("0006-rolled", "2026-02-30");
    await rewrite("0007-slashed", "2026/10/30");
    await rewrite("0008-zoneless", "2026-10-30T12:00:00");
    await rewrite("0009-day", "2026-10-30");
    const response = await inZone(zone, () => new DecisionContextService(new DecisionContextRepository(vault))
      .search(decisionContextQuerySchema.parse({ query: "数据库连接池", project: "lab", limit: 20 })));
    const dates = Object.fromEntries(response.results.map((result) => [result.id, result.warnings[0]]));
    const singapore = zone === "Asia/Singapore";
    expect(dates).toEqual({
      plain: "记录日期 2026-09-05。", leap: "记录日期未知。", tail: "记录日期未知。",
      "0001-told": `决策日期 ${singapore ? "2026-10-30" : "2026-10-29"}。`,
      "0002-offset": `决策日期 ${singapore ? "2026-10-30" : "2026-10-29"}。`,
      "0003-untold": `记录日期 ${singapore ? "2026-10-30" : "2026-10-29"}。`,
      // The parser takes occurred_at as Date.parse does; read as no date here, never as the day it was written.
      "0004-slashed": "记录日期未知。",
      "0006-rolled": "记录日期未知。", "0007-slashed": "记录日期未知。", "0008-zoneless": "记录日期未知。", "0009-day": "记录日期 2026-10-30。",
    });
    // One whose occurred_at is no time at all never reaches a search: its note is set aside and counted.
    expect(response.sources.find((source) => source.source === "decisions")).toMatchObject({ records: 8, skipped: 1 });
  });
});
