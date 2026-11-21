import { RationaleQueue } from "@cognelis/decision-core";
import { prDescriptionVersion, type PrConnection, type PrConnectionInput, type PrListQuery, type PrListResponse, type PrReviewCommentRequest, type PrReviewHistoryEntry, type PrReviewReport, type PrReviewRun } from "@cognelis/decision-protocol";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { LocalCaptureServer } from "../../desktop/src/main/local-server.js";
import { PrReviewHistoryStore } from "../../desktop/src/main/pr-review-history-store.js";
import { listPrsForAgent, queryRecords, recordComments, recordView, updateFinding } from "../../desktop/src/main/pr-review-records.js";
import { descriptionDraftForAgent, updatePrForAgent, type PrDescriptionToolSources } from "../../desktop/src/main/pr-description-tools.js";
import { startReviewForAgent } from "../../desktop/src/main/pr-review-runs.js";
import { PrAutoReviewUsage, localDay, reviewSettingsFor, updateReviewSettings } from "../../desktop/src/main/pr-auto-review.js";
import { PrTeamFactsCache, reviewQualityFor, setReviewRuleEnabled } from "../../desktop/src/main/review-quality.js";
import { ReviewEscapeStore, escapesFor, recordEscape, updateEscape } from "../../desktop/src/main/review-escapes.js";
import { PromotionLedger, promotionsForAgent } from "../../desktop/src/main/review-promotions.js";
import { commentsForAgent, updateCommentForAgent, type PrResponseToolSources } from "../../desktop/src/main/pr-comment-responses.js";
import type { PrThread } from "../../desktop/src/main/pr-platform-client.js";
import { PrDescriptionMovedError } from "../../desktop/src/main/pr-platform-client.js";
import { createDecisionMcpServer } from "../src/mcp-server.js";
import { RuntimeClient } from "../src/runtime-client.js";

const connection = { id: "00000000-0000-4000-8000-0000000000c1", label: "团队 Bitbucket", platform: "bitbucket-server" } as PrConnection;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const finding = (priority: "P1" | "P2" | "P3", title: string, body: string, line: number) => ({ priority, title, body, path: "apps/auth/session.ts", side: "new" as const, line, decisionIndexes: [] });
const record = (n: number, at: string, kind: "review" | "chat", findings: ReturnType<typeof finding>[] = []): PrReviewHistoryEntry => ({
  id: uuid(n), kind, at, model: "本机", focus: n === 3 ? "会话续期" : "", draft: "", turns: kind === "chat" ? [{ id: uuid(90 + n), at, model: "本机", question: "续期为什么不查吊销？", answer: "因为……", state: "done" }] : [],
  connectionId: connection.id, events: [], state: "finished", error: "", listedComments: 0,
  snapshot: {
    snapshotId: uuid(50 + n), reference: "TEAM/app#128", title: "会话续期改为滑动过期", description: "", project: "app",
    sourceCommit: "a".repeat(40), destinationCommit: "b".repeat(40), files: [{ path: "apps/auth/session.ts", status: "modified" }], warnings: [],
    guides: ["REVIEW.md"], destinationBranch: "main",
    risk: { level: "high", table: "review_md", reasons: [{ level: "high", reason: "认证与会话", paths: ["apps/auth/session.ts"], more: 0 }], changesRules: false, problems: [] },
  },
  report: kind === "chat" ? null : {
    status: "completed", summary: "续期没有查吊销。", findings, evidence: [], readFiles: [], unreadFiles: [], reviewedFiles: [], unreviewedFiles: [], warnings: [], steps: 3, history: [],
    needsContext: n === 3 ? [{ finding: finding("P2", "时钟回拨时续期算错", "可能算错。", 60), reason: "要看时钟来源", missing: "clock.ts" }] : undefined,
  },
  published: n === 3 ? [{ finding: 0, at }] : [],
  verdicts: n === 3 ? [{ finding: 2, verdict: "drop", reason: "这是有意为之的取舍", replacement: null, at, model: "本机", by: "reviewer" }] : [],
  rechecks: [],
});

const roots: string[] = [];
const servers: LocalCaptureServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const connect = async (server: ReturnType<typeof createDecisionMcpServer>) => {
  const [client, transport] = InMemoryTransport.createLinkedPair();
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  client.onmessage = (message) => { if ("id" in message) waiting.get(message.id as number)?.(message as Record<string, unknown>); };
  await Promise.all([server.connect(transport), client.start()]);
  let id = 0;
  const request = (method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((resolve) => {
    const current = ++id;
    waiting.set(current, resolve);
    void client.send({ jsonrpc: "2.0", id: current, method, params });
  });
  await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "pr-review-test", version: "1" } });
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  type Result = { isError?: boolean; content: Array<{ text: string }>; structuredContent: { prReview: unknown } };
  return { call: async (name: string, args: Record<string, unknown>) => (await request("tools/call", { name, arguments: args })).result as Result, close: () => Promise.all([client.close(), server.close()]) };
};

it("lists PRs with their latest review here, and reads the records with each finding's basis, through the App's own routes", async () => {
  const root = await mkdtemp(join(tmpdir(), "paraself-pr-review-mcp-"));
  roots.push(root);
  const history = new PrReviewHistoryStore(join(root, "history"));
  await history.save({ removed: [], entries: [
    record(1, "2026-11-10T10:00:00.000Z", "review", [finding("P2", "续期没有记录日志", "建议补日志。", 20)]),
    record(2, "2026-11-11T10:00:00.000Z", "chat"),
    record(3, "2026-11-12T10:00:00.000Z", "review", [
      finding("P1", "续期没有检查吊销", "违反 REVIEW.md《认证》第 2 条：续期前要检查吊销。", 88),
      finding("P2", "错误码和登录接口不一致", "按 Ruleset 1，续期失败应返回 401。", 41),
      finding("P2", "续期窗口写死", "窗口时长写死在代码里。", 30),
    ]),
  ] });
  let failing = false;
  const pullRequests = async (query: PrListQuery): Promise<PrListResponse> => {
    if (failing) throw new Error("平台拒绝了请求（HTTP 401）：令牌已过期。");
    return { nextPage: null, items: query.filter === "review-requested" ? [
      { reference: "TEAM/app#128", title: "会话续期改为滑动过期", repository: "TEAM/app", number: "128", author: "示例作者", updatedAt: "2026-11-12T10:00:00Z" },
      { reference: "TEAM/app#129", title: "订单列表加分页", repository: "TEAM/app", number: "129", author: "示例作者 C", updatedAt: "" },
    ] : [] };
  };
  const token = "t".repeat(64);
  const app = new LocalCaptureServer({
    queue: new RationaleQueue(), token,
    listPrsForAgent: (query) => listPrsForAgent(query, { connections: async () => [connection], pullRequests, history: () => history.list(),
      // #128 read in time, #129 not: the list says what it has.
      statuses: async (_connection, references) => new Map(references.filter((reference) => reference === "TEAM/app#128").map((reference) => [reference,
        { sourceCommit: "a".repeat(40), build: "passed" as const, approvals: { count: 1, users: ["示例审阅人"], logins: ["reviewer"], stale: [] }, blockers: 1, blocking: "tasks" as const, blockersHold: true, sections: null, problems: [] }])) }),
    listPrReviewRecords: async (query) => queryRecords(await history.list(), query),
    getPrReviewRecord: async ({ id }) => {
      const list = await history.list();
      const entry = list.entries.find((item) => item.id === id);
      return { prReviewToolsVersion: 1, record: entry ? recordView(list.entries, entry) : null };
    },
  });
  servers.push(app);
  const { port } = await app.start();
  const runtimeFile = join(root, "runtime.json");
  await writeFile(runtimeFile, JSON.stringify({ protocolVersion: 1, port, token, pid: process.pid, startedAt: new Date().toISOString() }));
  const mcp = await connect(createDecisionMcpServer({ sourceClient: "codex", runtime: new RuntimeClient({ runtimeFile }), cwd: root }));
  try {
    const listed = await mcp.call("list_prs", {});
    expect(listed.isError).toBeUndefined();
    expect(listed.content[0]!.text).toContain("连接「团队 Bitbucket」· 待我评审：");
    expect(listed.content[0]!.text).toContain(`- TEAM/app#128 会话续期改为滑动过期（示例作者，`);
    expect(listed.content[0]!.text).toContain(`本机：第 2 轮评审完成 · 高风险 · 3 个问题（P1 1、P2 2） · 已发布 1 条评论，记录 ${uuid(3)} · 平台：构建通过 · 批准 1/2 · 1 项未完成的任务`);
    expect(listed.content[0]!.text).toContain("批准只数人的，机器人和服务账号的批准不算");
    expect(listed.content[0]!.text).toContain("- TEAM/app#129 订单列表加分页（示例作者 C）· 本机未评审");
    const unknown = await mcp.call("list_prs", { connection: "不存在" });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0]!.text).toContain(`现有的连接：「团队 Bitbucket」（bitbucket-server，id ${connection.id}）`);
    failing = true;
    expect((await mcp.call("list_prs", { connection: "团队 Bitbucket" })).content[0]!.text).toContain("读不了（平台拒绝了请求（HTTP 401）：令牌已过期。）");

    const records = await mcp.call("list_pr_reviews", { reference: "TEAM/app" });
    expect(records.content[0]!.text).toContain("共 3 条评审记录");
    expect(records.content[0]!.text.indexOf(uuid(3))).toBeLessThan(records.content[0]!.text.indexOf(uuid(1)));
    expect(records.content[0]!.text).toContain(`- ${uuid(2)}`);
    expect(records.content[0]!.text).toContain("问答 · 高风险");

    const read = (await mcp.call("get_pr_review", { id: uuid(3) })).content[0]!.text;
    expect(read).toContain("风险等级：高风险（认证与会话：apps/auth/session.ts；按目标分支的 REVIEW.md 风险路径）");
    expect(read).toContain("1. P1 续期没有检查吊销（apps/auth/session.ts:88，新版本）");
    expect(read).toContain("依据 REVIEW.md（仓库规则）；已发布为 PR 评论，结果还没读到");
    // Once read from the PR: how its author answered, and when that was read.
    const [three] = (await history.list()).entries.filter((item) => item.id === uuid(3));
    await history.save({ removed: [], entries: [{ ...three!, published: [{ ...three!.published[0]!, comment: "901", outcome: { kind: "wrong", words: "网关已经查过吊销。", at: "2026-11-13T02:00:00.000Z" } }] }] });
    expect((await mcp.call("get_pr_review", { id: uuid(3) })).content[0]!.text).toMatch(/依据 REVIEW\.md（仓库规则）；已发布为 PR 评论，作者回应：说错了 —— 网关已经查过吊销。（读于 [^）]+）/u);
    expect(read).toContain("依据 本机评审规则（个人依据 · 只作建议）");
    expect(read).toContain("依据代码本身；用户不采纳：这是有意为之的取舍");
    expect(read).toContain("- 时钟回拨时续期算错（apps/auth/session.ts:60）：要看时钟来源；缺少 clock.ts");
    expect(read).toContain("不代表 PR 已获批准");
    const missing = await mcp.call("get_pr_review", { id: uuid(99) });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toContain("用 list_pr_reviews 找到正确的 id");
  } finally {
    await mcp.close();
  }
});

it("dismisses and restores a finding, and posts chosen findings to the PR once each, through the App's own routes", async () => {
  const root = await mkdtemp(join(tmpdir(), "paraself-pr-review-write-"));
  roots.push(root);
  const history = new PrReviewHistoryStore(join(root, "history"));
  await history.save({ removed: [], entries: [
    record(1, "2026-11-10T10:00:00.000Z", "review", [finding("P2", "续期没有记录日志", "建议补日志。", 20)]),
    record(3, "2026-11-12T10:00:00.000Z", "review", [
      finding("P1", "续期没有检查吊销", "违反 REVIEW.md《认证》第 2 条：续期前要检查吊销。", 88),
      finding("P2", "错误码和登录接口不一致", "按 Ruleset 1，续期失败应返回 401。", 41),
      finding("P1", "续期窗口写死", "窗口时长写死在代码里，改配置不生效。", 30),
    ]),
  ] });
  // Record 3 has its first finding posted and its third turned down: posting the third waits for the 撤回.
  const posted: PrReviewCommentRequest[] = [];
  let refuse = "";
  let existing: Array<{ author: string; path: string | null; line: number | null; side: "old" | "new" | null; body: string }> = [];
  const poster = { connections: async () => [connection], comments: async () => existing, publishComment: async (comment: PrReviewCommentRequest) => {
    if (refuse) throw new Error(refuse);
    posted.push(comment);
    return { message: `${comment.blocking ? "任务" : "评论"}已发布到 ${comment.path}:${comment.line}。`, ...(comment.blocking ? { blocking: true } : {}) };
  } };
  const changed: string[][] = [];
  const token = "t".repeat(64);
  const app = new LocalCaptureServer({
    queue: new RationaleQueue(), token,
    updatePrReviewFinding: (request) => updateFinding(history, request, (ids) => changed.push(ids)),
    recordPrComments: (request) => recordComments(history, poster, request, (ids) => changed.push(ids)),
    getPrReviewRecord: async ({ id }) => {
      const list = await history.list();
      const entry = list.entries.find((item) => item.id === id);
      return { prReviewToolsVersion: 1, record: entry ? recordView(list.entries, entry) : null };
    },
  });
  servers.push(app);
  const { port } = await app.start();
  const runtimeFile = join(root, "runtime.json");
  await writeFile(runtimeFile, JSON.stringify({ protocolVersion: 1, port, token, pid: process.pid, startedAt: new Date().toISOString() }));
  const mcp = await connect(createDecisionMcpServer({ sourceClient: "codex", runtime: new RuntimeClient({ runtimeFile }), cwd: root }));
  try {
    // Dropped findings and personal ones as blocking are refused before anything goes out.
    const dropped = await mcp.call("record_pr_comments", { id: uuid(3), findings: [{ finding: 2 }, { finding: 3 }] });
    expect(dropped.isError).toBe(true);
    expect(dropped.content[0]!.text).toContain("没有发布任何评论：第 3 个问题用户不采纳过；要发布，先用 update_pr_review_finding 撤回不采纳。");
    const personal = await mcp.call("record_pr_comments", { id: uuid(3), findings: [{ finding: 2, blocking: true }] });
    expect(personal.content[0]!.text).toContain("第 2 个问题只有用户的个人依据，只能作建议，不能设为阻塞（只有依据标记为阻塞的本机规则的 P1 可以）。");
    expect(posted).toEqual([]);

    // 撤回, then 不采纳 needs its reason, and a posted finding stays posted.
    const restored = await mcp.call("update_pr_review_finding", { id: uuid(3), finding: 3, action: "restore" });
    expect(restored.content[0]!.text).toContain("已撤回第 3 个问题「续期窗口写死」的不采纳");
    expect((await mcp.call("update_pr_review_finding", { id: uuid(3), finding: 3, action: "restore" })).content[0]!.text).toContain("没有不采纳过，没有改动");
    expect((await mcp.call("update_pr_review_finding", { id: uuid(3), finding: 2, action: "dismiss" })).content[0]!.text).toContain("不采纳要写明原因");
    expect((await mcp.call("update_pr_review_finding", { id: uuid(3), finding: 1, action: "dismiss", reason: "误报" })).content[0]!.text).toContain("已经发布为 PR 评论，发出去的不能再不采纳");
    const dismissed = await mcp.call("update_pr_review_finding", { id: uuid(1), finding: 1, action: "dismiss", reason: "日志由网关统一记" });
    expect(dismissed.content[0]!.text).toContain("已不采纳第 1 个问题「续期没有记录日志」：日志由网关统一记。以后评审 TEAM/app 时");
    expect((await history.get(uuid(1)))!.verdicts).toEqual([expect.objectContaining({ finding: 0, verdict: "drop", reason: "日志由网关统一记", by: "reviewer" })]);

    // The posted one is not posted again; a P1 is blocking unless said otherwise, a P2 is not; each with the marker line.
    const sent = await mcp.call("record_pr_comments", { id: uuid(3), findings: [{ finding: 1 }, { finding: 3 }, { finding: 2, body: "建议和登录接口一样返回 401。" }] });
    expect(sent.isError).toBeUndefined();
    expect(sent.content[0]!.text).toContain("已发布到 TEAM/app#128：新发 2 条，其中 1 条阻塞。");
    expect(sent.content[0]!.text).toContain("- 第 1 个「续期没有检查吊销」：已经发布过，没有重发");
    expect(sent.content[0]!.text).toContain("- 第 3 个「续期窗口写死」：已发布（阻塞项），任务已发布到 apps/auth/session.ts:30。");
    expect(posted.map(({ line, blocking, body }) => ({ line, blocking, body }))).toEqual([
      { line: 30, blocking: true, body: "**P1 · 续期窗口写死**\n\n窗口时长写死在代码里，改配置不生效。\n\n— Paraself 预评审 · P1" },
      { line: 41, blocking: undefined, body: "建议和登录接口一样返回 401。\n\n— Paraself 预评审 · 审阅人的个人经验，仓库暂无此规则 · P2 · 建议" },
    ]);
    expect(posted[0]).toMatchObject({ connectionId: connection.id, reference: "TEAM/app#128", sourceCommit: "a".repeat(40), destinationCommit: "b".repeat(40), side: "new" });
    const kept = (await history.get(uuid(3)))!;
    expect(kept.published).toEqual([expect.objectContaining({ finding: 0 }), expect.objectContaining({ finding: 2, blocking: true }), { finding: 1, at: expect.any(String) }]);
    // Both records of the PR count the two comments, so the list does not read them as news.
    expect(kept.listedComments).toBe(2);
    expect((await history.get(uuid(1)))!.listedComments).toBe(2);
    expect(changed).toEqual([[uuid(3)], [uuid(1)], [uuid(3), uuid(1)]]);
    expect((await mcp.call("get_pr_review", { id: uuid(3) })).content[0]!.text).toContain("已发布为 PR 评论（阻塞项）");

    // Nothing left to post: said, nothing sent. A failure says what went out and what did not.
    expect((await mcp.call("record_pr_comments", { id: uuid(3), findings: [{ finding: 1 }, { finding: 2 }] })).content[0]!.text).toContain("新发 0 条");
    refuse = "没有写评论的权限（HTTP 403），请确认账号和令牌授权。";
    await history.save({ removed: [], entries: [record(4, "2026-11-13T10:00:00.000Z", "review", [finding("P2", "甲", "甲。", 1), finding("P2", "乙", "乙。", 2)])] });
    const failed = await mcp.call("record_pr_comments", { id: uuid(4), findings: [{ finding: 1 }, { finding: 2 }] });
    expect(failed.isError).toBe(true);
    expect(failed.content[0]!.text).toContain("发布到第 1 个问题时失败，这次没有发出任何评论");
    expect(failed.content[0]!.text).toContain("- 第 2 个「乙」：没有尝试");

    // Said at its place already by another reviewer's Paraself: not posted again unless the user insists.
    refuse = "";
    existing = [{ author: "示例审阅人 B", path: "apps/auth/session.ts", line: 3, side: "new", body: "**P2 · 乙**\n\n乙。\n\n— Paraself 预评审 · P2" }];
    const before = posted.length;
    const same = await mcp.call("record_pr_comments", { id: uuid(4), findings: [{ finding: 2 }] });
    expect(same.content[0]!.text).toContain("- 第 2 个「乙」：没有发布，PR 上已有同位置的同类意见（示例审阅人 B）");
    expect(same.content[0]!.text).toContain("evenIfDuplicate 传 true");
    expect(posted.length).toBe(before);
    const insisted = await mcp.call("record_pr_comments", { id: uuid(4), findings: [{ finding: 2, evenIfDuplicate: true }] });
    expect(insisted.content[0]!.text).toContain("新发 1 条");
    expect(posted.length).toBe(before + 1);
  } finally {
    await mcp.close();
  }
});

it("drafts the parts a PR's description lacks from what Paraself knows, and writes it back only over the version read", async () => {
  const root = await mkdtemp(join(tmpdir(), "paraself-pr-description-"));
  roots.push(root);
  const history = new PrReviewHistoryStore(join(root, "history"));
  const overview = { ...record(5, "2026-11-12T12:00:00.000Z", "chat"), turns: [{ id: uuid(95), at: "2026-11-12T12:00:00.000Z", model: "本机", question: "/describe", answer: "**类型**：新功能\n\n**撤回**\n回滚本 PR 即可；已续期的会话按旧规则过期。", state: "done" as const }] };
  await history.save({ removed: [], entries: [record(3, "2026-11-12T10:00:00.000Z", "review", [finding("P1", "续期没有检查吊销", "违反 REVIEW.md 第 2 条。", 88)]), overview] });
  let description = "会话续期改为滑动过期。";
  const sources: PrDescriptionToolSources = {
    connections: async () => [connection],
    read: async () => ({ title: "会话续期改为滑动过期", description, version: prDescriptionVersion(description) }),
    update: async (request) => {
      if (request.baseVersion !== prDescriptionVersion(description)) throw new PrDescriptionMovedError();
      description = request.description;
      return { message: "PR 描述已更新。" };
    },
    status: async () => ({ sourceCommit: "a".repeat(40), build: "passed", approvals: null, blockers: 0, blocking: "tasks", blockersHold: null, sections: null, problems: [] }),
    history: () => history.list(), snapshot: async () => null,
  };
  const token = "t".repeat(64);
  const app = new LocalCaptureServer({ queue: new RationaleQueue(), token,
    prDescriptionDraft: (query) => descriptionDraftForAgent(query, sources), updatePr: (request) => updatePrForAgent(request, sources) });
  servers.push(app);
  const { port } = await app.start();
  const runtimeFile = join(root, "runtime.json");
  await writeFile(runtimeFile, JSON.stringify({ protocolVersion: 1, port, token, pid: process.pid, startedAt: new Date().toISOString() }));
  const mcp = await connect(createDecisionMcpServer({ sourceClient: "codex", runtime: new RuntimeClient({ runtimeFile }), cwd: root }));
  try {
    const drafted = await mcp.call("get_pr_description_draft", { reference: "TEAM/app#128" });
    expect(drafted.isError).toBeUndefined();
    const text = drafted.content[0]!.text;
    expect(text).toContain("现在的描述：没有验证、风险、撤回三段。");
    expect(text).toContain(`补上了验证、风险、撤回，整份描述的草稿如下；括号里的是要作者补的。给用户看过、按他的意思改好后，再用 update_pr 写回，baseVersion 传 ${prDescriptionVersion(description)}：`);
    expect(text).toContain("会话续期改为滑动过期。\n\n## 验证\n\n构建通过。Paraself 预评审发现 1 个问题，1 条已发到 PR。（补上跑了哪些检查");
    expect(text).toContain("## 风险\n\n高风险：认证与会话（apps/auth/session.ts）。影响 apps/auth。");
    expect(text).toContain("## 撤回\n\n回滚本 PR 即可；已续期的会话按旧规则过期。");
    expect(text).toContain("依据：高风险；构建：构建通过；Paraself 预评审第 1 轮；撤回取自 PR 概览。只读");

    // Moved since it was read: refused, nothing written.
    const stale = await mcp.call("update_pr", { reference: "TEAM/app#128", description: "新描述", baseVersion: "0".repeat(16) });
    expect(stale.isError).toBe(true);
    expect(stale.content[0]!.text).toContain("没有写回：PR 描述在读取之后被改过");
    expect(description).toBe("会话续期改为滑动过期。");
    const written = await mcp.call("update_pr", { connection: "团队 Bitbucket", reference: "TEAM/app#128", description: "新描述", baseVersion: prDescriptionVersion(description) });
    expect(written.content[0]!.text).toBe("PR 描述已更新。（TEAM/app#128，以用户的平台账号写回）");
    expect(description).toBe("新描述");
    const unknown = await mcp.call("update_pr", { connection: "不存在", reference: "TEAM/app#128", description: "x", baseVersion: "0".repeat(16) });
    expect(unknown.content[0]!.text).toContain("没有叫「不存在」的连接。现有的连接：「团队 Bitbucket」");
  } finally {
    await mcp.close();
  }
});

it("starts a review as the review page does, on what came after the last one, and keeps its record from the start", async () => {
  const root = await mkdtemp(join(tmpdir(), "paraself-pr-review-run-"));
  roots.push(root);
  const history = new PrReviewHistoryStore(join(root, "history"));
  await history.save({ removed: [], entries: [record(3, "2026-11-12T10:00:00.000Z", "review", [
    finding("P1", "续期没有检查吊销", "违反 REVIEW.md 第 2 条。", 88), finding("P2", "错误码不一致", "应返回 401。", 41), finding("P1", "续期窗口写死", "改配置不生效。", 30),
  ])] });
  const latest = { ...record(3, "", "review").snapshot, snapshotId: uuid(70), sourceCommit: "c".repeat(40) };
  const runs: PrReviewRun[] = [];
  let finish: (report: PrReviewReport) => void = () => undefined;
  const changed: string[][] = [];
  const sources = {
    connections: async () => [connection],
    models: async () => [{ profileId: "local", label: "本机", kind: "qwen" as const, model: "qwen3", leavesDevice: false }, { profileId: "remote", label: "云端", kind: "qwen" as const, model: null, leavesDevice: true }],
    load: async () => latest,
    run: (request: PrReviewRun) => { runs.push(request); return new Promise<PrReviewReport>((resolve) => { finish = resolve; }); },
    running: () => runs.length > 0 && changed.length < 2,
    underWay: new Set<string>(),
    history, changed: (ids: string[]) => changed.push(ids),
  };
  const token = "t".repeat(64);
  const app = new LocalCaptureServer({ queue: new RationaleQueue(), token, runPrReview: (request) => startReviewForAgent(request, sources),
    getPrReviewRecord: async ({ id }) => {
      const list = await history.list();
      const entry = list.entries.find((item) => item.id === id);
      return { prReviewToolsVersion: 1, record: entry ? recordView(list.entries, entry) : null };
    } });
  servers.push(app);
  const { port } = await app.start();
  const runtimeFile = join(root, "runtime.json");
  await writeFile(runtimeFile, JSON.stringify({ protocolVersion: 1, port, token, pid: process.pid, startedAt: new Date().toISOString() }));
  const mcp = await connect(createDecisionMcpServer({ sourceClient: "codex", runtime: new RuntimeClient({ runtimeFile }), cwd: root }));
  try {
    const unknown = await mcp.call("run_pr_review", { reference: "TEAM/app#128", model: "不存在" });
    expect(unknown.content[0]!.text).toBe("没有开始评审：没有「不存在」这个模型。可用的：「本机 · qwen3」（id local）、「云端」（id remote）。");
    expect(runs).toHaveLength(0);

    // High risk, so deep; the PR moved on since the last review, so only what came after it; told what was turned down and posted.
    const started = await mcp.call("run_pr_review", { reference: "TEAM/app#128", focus: "续期" });
    expect(started.isError).toBeUndefined();
    const run = (started.structuredContent.prReview as { run: { id: string } }).run;
    expect(started.content[0]!.text).toBe([
      "已开始评审 TEAM/app#128「会话续期改为滑动过期」：第 2 轮，深度评审，模型 本机 · qwen3，高风险，只看提交 aaaaaaaaaaaa 之后的改动。",
      `记录 id ${run.id}。评审在 Paraself 里后台进行，评审页也能看到；用 get_pr_review 看它是否结束和结果，一般要几分钟，PR 大或深度评审更久。`,
      "没有向 PR 发布任何东西：要发布哪些问题，由用户说了再用 record_pr_comments。",
    ].join("\n"));
    expect(runs).toEqual([expect.objectContaining({ snapshotId: uuid(70), runId: run.id, profileId: "local", focus: "续期", depth: "deep", since: "a".repeat(40),
      dismissed: [expect.objectContaining({ title: "续期窗口写死", reason: "这是有意为之的取舍" })], published: [expect.objectContaining({ title: "续期没有检查吊销" })] })]);
    expect(changed).toEqual([[run.id]]);
    expect([...sources.underWay]).toEqual([run.id]);
    expect((await mcp.call("get_pr_review", { id: run.id })).content[0]!.text).toContain("进行中");

    // One at a time, whoever started it.
    const busy = await mcp.call("run_pr_review", { reference: "TEAM/app#128", scope: "all" });
    expect(busy.content[0]!.text).toBe("没有开始评审：已有评审正在运行（评审页或别的 agent 发起的），等它结束再开始。");

    finish({ status: "completed", summary: "新提交补上了吊销检查。", findings: [finding("P2", "吊销检查没有缓存", "每次续期都查库。", 90)], evidence: [], readFiles: [], unreadFiles: [], reviewedFiles: [], unreviewedFiles: [], warnings: [], steps: 2,
      history: [{ runId: run.id, id: "s1", at: "2026-11-13T10:00:00.000Z", kind: "status", status: "done", message: "读取 apps/auth/session.ts" }] } as unknown as PrReviewReport);
    await expect.poll(() => changed.length).toBe(2);
    const done = await mcp.call("get_pr_review", { id: run.id });
    expect(done.content[0]!.text).toContain("吊销检查没有缓存");
    const saved = (await history.list()).entries.find((item) => item.id === run.id)!;
    expect(saved).toMatchObject({ state: "finished", focus: "续期", profileId: "local", report: { history: [] }, snapshot: { sourceCommit: "c".repeat(40) } });
    expect(saved.events).toHaveLength(1);
    expect(sources.underWay.size).toBe(0);
  } finally {
    await mcp.close();
  }
});

it("lists the comments on the user's own PR with what they answered, and answers one only once, filing 转后续 as a todo", async () => {
  const root = await mkdtemp(join(tmpdir(), "paraself-pr-comments-"));
  roots.push(root);
  const thread = (id: string, body: string, login: string, extra: Partial<PrThread> = {}): PrThread => ({ id, url: `https://code.example/c/${id}`, author: login.toUpperCase(), login, path: null, line: null, body,
    createdAt: "2026-11-12T10:00:00.000Z", task: null, resolved: null, side: extra.path ? "new" : null, replies: [], ...extra });
  const threads = [
    thread("11", "**P1 · 续期没查吊销**\n\n违反 REVIEW.md 第 2 条。\n\n— Paraself 预评审 · 依据 REVIEW.md · P1", "bob", { path: "src/a.ts", line: 8, task: "open" }),
    thread("15", "能不能拆小一点？", "carol"),
    thread("16", "自己写的说明", "alice"),
  ];
  const replies: Array<[string, string]> = [];
  const filed: unknown[] = [];
  const sources: PrResponseToolSources = {
    connections: async () => [connection],
    exclusive: (operation) => operation(),
    client: async () => ({
      account: async () => "Alice",
      threads: async () => ({ threads: structuredClone(threads), more: false }),
      reply: async (_reference, answered, body) => {
        replies.push([answered.id, body]);
        threads.find((item) => item.id === answered.id)!.replies.push({ id: `r${replies.length}`, author: "ALICE", login: "alice", body, createdAt: "2026-11-12T12:00:00.000Z" });
        return `r${replies.length}`;
      },
    }),
    todos: {
      list: async () => ({ todoVersion: 1, lists: [], total: 0, nextOffset: null, unreadable: [] }) as never,
      recordManual: async (input) => { filed.push(input); return { todoVersion: 1, status: "created", list: { id: "list-1" }, added: [{ number: 1, title: input.items![0]!.title }], skipped: [] } as never; },
    },
  };
  const token = "t".repeat(64);
  const app = new LocalCaptureServer({ queue: new RationaleQueue(), token, listPrComments: (query) => commentsForAgent(query, sources), updatePrComment: (request) => updateCommentForAgent(request, sources) });
  servers.push(app);
  const { port } = await app.start();
  const runtimeFile = join(root, "runtime.json");
  await writeFile(runtimeFile, JSON.stringify({ protocolVersion: 1, port, token, pid: process.pid, startedAt: new Date().toISOString() }));
  const mcp = await connect(createDecisionMcpServer({ sourceClient: "codex", runtime: new RuntimeClient({ runtimeFile }), cwd: root }));
  try {
    // The user's own comment is not one they received.
    const listed = await mcp.call("list_pr_comments", { reference: "TEAM/app#128" });
    expect(listed.isError).toBeUndefined();
    expect(listed.content[0]!.text).toContain("TEAM/app#128 收到 2 条意见，0 条有去向（1 条来自 Paraself 预评审）。\n1. [阻塞，未完成] P1 续期没查吊销 — BOB · Paraself 预评审 · 依据 REVIEW.md · src/a.ts:8（意见 id 11）\n   去向：还没有，等用户决定");
    expect(listed.content[0]!.text).toContain("2. 人工 能不能拆小一点？ — CAROL（意见 id 15）");

    const bare = await mcp.call("update_pr_comment", { reference: "TEAM/app#128", comment: "11", response: "wrong" });
    expect(bare.isError).toBe(true);
    expect(bare.content[0]!.text).toBe("没有回复：输入不符合要求（不修（wrong、intended、wontfix）要在 reason 里写明用户的理由）。");
    const intended = await mcp.call("update_pr_comment", { reference: "TEAM/app#128", comment: "11", response: "intended", reason: "网关已经查过吊销。" });
    expect(intended.content[0]!.text).toBe("已回复「续期没查吊销」：有意为之。（TEAM/app#128，以用户的平台账号回复）");
    expect(replies).toEqual([["11", "**有意为之**：网关已经查过吊销。\n\n— Paraself 作者回应"]]);
    const again = await mcp.call("update_pr_comment", { reference: "TEAM/app#128", comment: "11", response: "wontfix", reason: "再说一次。" });
    expect(again.isError).toBe(true);
    expect(again.content[0]!.text).toBe("没有回复：这条意见已经回应过：有意为之。");

    const later = await mcp.call("update_pr_comment", { reference: "TEAM/app#128", comment: "15", response: "later", todo: "拆小续期的 PR" });
    expect(later.content[0]!.text).toBe("已回复「能不能拆小一点？」：转后续，并建了待办「拆小续期的 PR」。（TEAM/app#128，以用户的平台账号回复）");
    expect(filed).toEqual([expect.objectContaining({ title: "PR 后续", project: "TEAM/app", longTerm: true, items: [expect.objectContaining({ title: "拆小续期的 PR", detail: expect.stringContaining("CAROL 在 TEAM/app#128 的意见：https://code.example/c/15") })] })]);
    expect(replies[1]).toEqual(["15", "**转后续**：已建待办「拆小续期的 PR」。\n\n— Paraself 作者回应"]);
    expect((await mcp.call("list_pr_comments", { reference: "TEAM/app#128" })).content[0]!.text).toContain("收到 2 条意见，2 条有去向");
  } finally {
    await mcp.close();
  }
});

it("reads each link's 自动预评审 and turns it on or off through the App's own routes, the rest of the link left as it was", async () => {
  const root = await mkdtemp(join(tmpdir(), "paraself-pr-review-settings-"));
  roots.push(root);
  let saved: PrConnection[] = [{ ...connection, baseUrl: "https://code.example", recognition: { profileId: "local", skipAuthors: [] } }];
  const usage = new PrAutoReviewUsage(join(root, "pr-auto-review.json"));
  const sources = { connections: async () => saved, usage,
    models: async () => [{ profileId: "local", label: "本机", kind: "qwen" as const, model: "qwen3", leavesDevice: false }],
    save: async (input: PrConnectionInput) => { saved = saved.map((item) => item.id === input.id ? { ...input, id: item.id } as PrConnection : item); return saved; } };
  const token = "t".repeat(64);
  const app = new LocalCaptureServer({ queue: new RationaleQueue(), token,
    getPrReviewSettings: (query) => reviewSettingsFor(query, sources), updatePrReviewSettings: (request) => updateReviewSettings(request, sources) });
  servers.push(app);
  const { port } = await app.start();
  const runtimeFile = join(root, "runtime.json");
  await writeFile(runtimeFile, JSON.stringify({ protocolVersion: 1, port, token, pid: process.pid, startedAt: new Date().toISOString() }));
  const mcp = await connect(createDecisionMcpServer({ sourceClient: "codex", runtime: new RuntimeClient({ runtimeFile }), cwd: root }));
  try {
    expect((await mcp.call("get_pr_review_settings", {})).content[0]!.text).toMatch(/^「团队 Bitbucket」（bitbucket-server，id [0-9a-f-]{36}）：自动预评审没开。\n开着时/u);
    const tooMany = await mcp.call("update_pr_review_settings", { autoReview: true, dailyReviews: 99 });
    expect(tooMany.isError).toBe(true);
    const unknown = await mcp.call("update_pr_review_settings", { autoReview: true, model: "云端" });
    expect(unknown.content[0]!.text).toBe("没有改动评审设置：没有「云端」这个模型。可用的：「本机 · qwen3」（id local）。");

    const turnedOn = await mcp.call("update_pr_review_settings", { autoReview: true, dailyReviews: 3 });
    expect(turnedOn.content[0]!.text).toMatch(/^已打开自动预评审。「团队 Bitbucket」（bitbucket-server，id [0-9a-f-]{36}）：自动预评审已开，模型 本机 · qwen3，每天最多 3 次，今天用了 0 次。\n开着时[\s\S]*会花模型额度。$/u);
    expect(saved[0]).toMatchObject({ autoReview: { profileId: "local", dailyReviews: 3 }, recognition: { profileId: "local" } });
    await usage.spend(connection.id, localDay(Date.now())); await usage.spend(connection.id, localDay(Date.now())); await usage.spend(connection.id, localDay(Date.now()));
    expect((await mcp.call("get_pr_review_settings", { connection: "团队 Bitbucket" })).content[0]!.text).toContain("每天最多 3 次，今天用了 3 次，今天的额度用完了。");

    const turnedOff = await mcp.call("update_pr_review_settings", { connection: connection.id, autoReview: false });
    expect(turnedOff.content[0]!.text).toMatch(/^已关闭自动预评审。「团队 Bitbucket」.*自动预评审没开。$/u);
    expect(saved[0]!.autoReview).toBeUndefined();
    expect(saved[0]!.recognition).toEqual({ profileId: "local", skipAuthors: [] });
  } finally {
    await mcp.close();
  }
});

it("reads 评审质量 and turns a noisy local rule off through the App's own routes", async () => {
  const root = await mkdtemp(join(tmpdir(), "paraself-review-quality-tools-"));
  roots.push(root);
  const rules = join(root, "review-rules");
  await mkdir(rules);
  await writeFile(join(rules, "list-pagination.md"), "列表接口都要分页。\n");
  const history = new PrReviewHistoryStore(join(root, "history"));
  const said = (kind: "wrong" | "wontfix", words: string) => ({ kind, words, at: new Date().toISOString() });
  const posted = (n: number) => {
    const entry = record(n, new Date().toISOString(), "review", [finding("P2", "没分页", "Ruleset 1 要求列表分页。", 12)]);
    return { ...entry, snapshot: { ...entry.snapshot, reference: `TEAM/app#${n}`, rules: [{ id: "list-pagination.md", source: "decision" as const }] },
      published: [{ finding: 0, at: new Date().toISOString(), outcome: said(n === 1 ? "wrong" : "wontfix", n === 1 ? "只读的小表不需要分页。" : "先不改。") }] };
  };
  await history.save({ removed: [], entries: [posted(1), posted(2)] });
  const sources = { connections: async () => [connection], history, pullRequests: async () => ({ items: [], nextPage: null }),
    facts: async () => { throw new Error("不该读"); }, cache: new PrTeamFactsCache(join(root, "facts.json")) };
  const token = "t".repeat(64);
  const app = new LocalCaptureServer({ queue: new RationaleQueue(), token,
    getReviewQuality: (query) => reviewQualityFor(query, sources), updateReviewRule: (request) => setReviewRuleEnabled(rules, request.rule, request.enabled) });
  servers.push(app);
  const { port } = await app.start();
  const runtimeFile = join(root, "runtime.json");
  await writeFile(runtimeFile, JSON.stringify({ protocolVersion: 1, port, token, pid: process.pid, startedAt: new Date().toISOString() }));
  const mcp = await connect(createDecisionMcpServer({ sourceClient: "codex", runtime: new RuntimeClient({ runtimeFile }), cwd: root }));
  try {
    const read = await mcp.call("get_review_quality", {});
    expect(read.isError).toBeUndefined();
    expect(read.content[0]!.text).toContain("「团队 Bitbucket」近 30 天的评审质量（只用代码平台和本机记录，不收集同学的使用数据）：\n团队：0 个已合并的 PR（之前 30 天 0 个），每个 PR 的人工批准 —（之前 —）");
    expect(read.content[0]!.text).toContain("已发布意见的结果 · 2 条：\n- 仓库规则：发布 0，");
    expect(read.content[0]!.text).toContain("- 个人决策与本机规则：发布 2，修了 0，说错了 1，有意为之 0，无所谓 1，转后续 0，未回应 0");
    expect(read.content[0]!.text).toContain("常被说错或说无所谓的规则（改写或停用前先问用户）：\n- Paraself 本机规则 list-pagination.md：作者答复过的 2 条里说错了 1、无所谓 1，涉及 2 个 PR。作者说：");
    expect((await mcp.call("update_review_rule", { rule: "../elsewhere.md", enabled: false })).content[0]!.text).toBe("没有停用规则：Paraself 的评审规则目录里没有「../elsewhere.md」。");
    const off = await mcp.call("update_review_rule", { rule: "list-pagination.md", enabled: false });
    expect(off.content[0]!.text).toBe("已停用 Paraself 评审规则 list-pagination.md：之后的评审不再用它，文件还在，可以再启用。");
    expect(await readFile(join(rules, "list-pagination.md"), "utf8")).toBe("---\nenabled: false\n---\n列表接口都要分页。\n");
  } finally {
    await mcp.close();
  }
});

it("records an escape the user names, lists it, writes its four lines and makes it a benchmark candidate, through the App's own routes", async () => {
  const root = await mkdtemp(join(tmpdir(), "paraself-review-escape-tools-"));
  roots.push(root);
  const history = new PrReviewHistoryStore(join(root, "history"));
  await history.save({ removed: [], entries: [record(3, "2026-11-12T10:00:00.000Z", "review")] });
  const recorded: unknown[] = [];
  const sources = {
    connections: async () => [connection], store: new ReviewEscapeStore(join(root, "escapes.json")), history,
    get: async (_id: string, reference: string) => ({ title: reference === "TEAM/app#130" ? "修复续期窗口" : "会话续期改为滑动过期", source: { repository: "TEAM/app", commit: reference === "TEAM/app#130" ? "c".repeat(40) : "a".repeat(40) }, destination: { repository: "TEAM/app", commit: "b".repeat(40) } }),
    localPath: async () => "/repos/app",
    benchmark: { record: async (request: unknown) => { recorded.push(request); return { reviewBenchmarkVersion: 1 as const, status: "processed" as const, repository: null, cases: [{ outcome: "recorded" as const, caseId: "case-00000000beef", status: "candidate" as const, split: "holdout" as const, reasons: [] }] }; } },
  };
  const token = "t".repeat(64);
  const app = new LocalCaptureServer({ queue: new RationaleQueue(), token,
    recordReviewEscape: (request) => recordEscape(request, sources), listReviewEscapes: (query) => escapesFor(query, sources), updateReviewEscape: (request) => updateEscape(request, sources) });
  servers.push(app);
  const { port } = await app.start();
  const runtimeFile = join(root, "runtime.json");
  await writeFile(runtimeFile, JSON.stringify({ protocolVersion: 1, port, token, pid: process.pid, startedAt: new Date().toISOString() }));
  const mcp = await connect(createDecisionMcpServer({ sourceClient: "codex", runtime: new RuntimeClient({ runtimeFile }), cwd: root }));
  try {
    const made = await mcp.call("record_review_escape", { reference: "TEAM/app#128", by: "#130" });
    const id = /^已记下漏网：\n([0-9a-f-]{36}) /u.exec(made.content[0]!.text)?.[1];
    expect(made.content[0]!.text).toBe(`已记下漏网：\n${id} · TEAM/app#128「会话续期改为滑动过期」· 待写：合并后被 TEAM/app#130「修复续期窗口」修复\n复盘的四行等用户说了再用 update_review_escape 写。`);
    expect((await mcp.call("list_review_escapes", { state: "open" })).content[0]!.text).toContain(`漏网复盘 1 条：\n${id} · TEAM/app#128`);
    // Made a candidate only from the four lines and where the problem sat.
    const early = await mcp.call("update_review_escape", { id, action: "add_to_benchmark" });
    expect(early.content[0]!.text).toBe("没有改动漏网复盘：输入不符合要求（add_to_benchmark 要用 location 给出问题所在的位置）。");
    const written = await mcp.call("update_review_escape", { id, action: "write", writeup: { problem: "续期窗口写死 30 秒", layer: "pre_review", why: "没有规则说窗口要可配置", change: "rule", changeText: "REVIEW.md 加一条" } });
    expect(written.content[0]!.text).toBe(`已写好复盘：\n${id} · TEAM/app#128「会话续期改为滑动过期」· 已写：合并后被 TEAM/app#130「修复续期窗口」修复\n  问题：续期窗口写死 30 秒\n  本该拦住的一层：Paraself 预评审\n  为什么没拦住：没有规则说窗口要可配置\n  改在哪里：规则，REVIEW.md 加一条`);
    const candidate = await mcp.call("update_review_escape", { id, action: "add_to_benchmark", location: { path: "apps/auth/session.ts", startLine: 30 } });
    expect(candidate.content[0]!.text).toContain("已加入评测集的候选样本（用户核对后才入集）：");
    expect(candidate.content[0]!.text).toContain("已是评测集样本 case-00000000beef（候选，用户核对后才入集）");
    expect(recorded).toEqual([expect.objectContaining({ repositoryPath: "/repos/app", cases: [expect.objectContaining({ set: "defect", headSha: "a".repeat(40), targetSha: "b".repeat(40),
      issues: [expect.objectContaining({ fixShas: ["c".repeat(40)], locations: [{ path: "apps/auth/session.ts", side: "new", startLine: 30, endLine: 30 }] })] })] })]);
  } finally {
    await mcp.close();
  }
});

it("lists the rules review keeps needing for REVIEW.md, through the App's own routes", async () => {
  const root = await mkdtemp(join(tmpdir(), "paraself-promotion-tools-"));
  roots.push(root);
  const history = new PrReviewHistoryStore(join(root, "history"));
  const posted = (n: number) => {
    const entry = record(n, new Date(Date.now() - n * 1_000).toISOString(), "review", [finding("P2", "没分页", "Ruleset 1 要求列表分页。", 12)]);
    return { ...entry, snapshot: { ...entry.snapshot, reference: `TEAM/app#${n}`, rules: [{ id: "list-pagination.md", source: "decision" as const }] },
      published: [{ finding: 0, at: new Date().toISOString(), outcome: { kind: "fixed" as const, at: new Date().toISOString() } }] };
  };
  await history.save({ removed: [], entries: [posted(1), posted(2)] });
  const sources = { connections: async () => [connection], history, escapes: new ReviewEscapeStore(join(root, "escapes.json")), ledger: new PromotionLedger(join(root, "ledger.json")), propose: async () => "job" };
  const token = "t".repeat(64);
  const app = new LocalCaptureServer({ queue: new RationaleQueue(), token, listRulePromotionCandidates: (query) => promotionsForAgent(query, sources) });
  servers.push(app);
  const { port } = await app.start();
  const runtimeFile = join(root, "runtime.json");
  await writeFile(runtimeFile, JSON.stringify({ protocolVersion: 1, port, token, pid: process.pid, startedAt: new Date().toISOString() }));
  const mcp = await connect(createDecisionMcpServer({ sourceClient: "codex", runtime: new RuntimeClient({ runtimeFile }), cwd: root }));
  try {
    const listed = await mcp.call("list_rule_promotion_candidates", {});
    expect(listed.isError).toBeUndefined();
    expect(listed.content[0]!.text).toContain("晋升提议 1 条：只在 Paraself 里的规则，评审一再用到，适合写进仓库的 REVIEW.md，让作者和大家的评审都看得到。\n- 本机规则「list-pagination」→ TEAM/app 的 REVIEW.md\n  支撑的意见出现在 2 个 PR，修了 2 次");
    expect(listed.content[0]!.text).toContain("  草稿：- list-pagination");
    expect(listed.content[0]!.text).toMatch(/record_local_review_job[\s\S]*只读。$/u);
  } finally {
    await mcp.close();
  }
});

it("posts a P1 on a local rule the user marked blocking as blocking, quoting the rule, and says so when the record is read", async () => {
  const root = await mkdtemp(join(tmpdir(), "paraself-pr-review-blocking-rule-"));
  roots.push(root);
  const history = new PrReviewHistoryStore(join(root, "history"));
  const entry = record(5, "2026-11-12T10:00:00.000Z", "review", [finding("P1", "金额用了浮点", "违反 Ruleset 2：金额要用整数分。", 30), finding("P2", "金额字段没注释", "Ruleset 2 要求写单位。", 31)]);
  await history.save({ removed: [], entries: [{ ...entry, published: [], verdicts: [],
    snapshot: { ...entry.snapshot, rules: [{ id: "list-pagination.md", source: "decision" }, { id: "money.md", source: "decision", enforcement: "blocking", text: "金额一律用整数分，不用浮点数。" }] } }] });
  const posted: PrReviewCommentRequest[] = [];
  const poster = { connections: async () => [connection], comments: async () => [], publishComment: async (comment: PrReviewCommentRequest) => {
    posted.push(comment);
    return { message: "已发布。", ...(comment.blocking ? { blocking: true } : {}) };
  } };
  const token = "t".repeat(64);
  const app = new LocalCaptureServer({ queue: new RationaleQueue(), token, recordPrComments: (request) => recordComments(history, poster, request, () => undefined),
    getPrReviewRecord: async ({ id }) => { const list = await history.list(); const found = list.entries.find((item) => item.id === id); return { prReviewToolsVersion: 1, record: found ? recordView(list.entries, found) : null }; } });
  servers.push(app);
  const { port } = await app.start();
  const runtimeFile = join(root, "runtime.json");
  await writeFile(runtimeFile, JSON.stringify({ protocolVersion: 1, port, token, pid: process.pid, startedAt: new Date().toISOString() }));
  const mcp = await connect(createDecisionMcpServer({ sourceClient: "codex", runtime: new RuntimeClient({ runtimeFile }), cwd: root }));
  try {
    const read = (await mcp.call("get_pr_review", { id: uuid(5) })).content[0]!.text;
    expect(read).toContain("依据 本机评审规则 money.md（个人规则，标记为阻塞：可以设为阻塞，评论会引用规则原文）");
    expect(read).toContain("依据 本机评审规则 money.md（个人规则，标记为阻塞：只有 P1 能设为阻塞，这条只作建议）");
    // The P2 on the same rule stays a suggestion.
    expect((await mcp.call("record_pr_comments", { id: uuid(5), findings: [{ finding: 2, blocking: true }] })).isError).toBe(true);
    const sent = await mcp.call("record_pr_comments", { id: uuid(5), findings: [{ finding: 1 }] });
    expect(sent.isError).toBeUndefined();
    expect(posted).toEqual([expect.objectContaining({ blocking: true, line: 30,
      body: "**P1 · 金额用了浮点**\n\n违反 Ruleset 2：金额要用整数分。\n\n> 审阅人的规则「money」（标记为阻塞）：\n> 金额一律用整数分，不用浮点数。\n\n— Paraself 预评审 · 依据 审阅人的规则（标记为阻塞） · P1" })]);
  } finally {
    await mcp.close();
  }
});
