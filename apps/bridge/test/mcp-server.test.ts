import {
  DECISION_CONSULTATION_FEEDBACK_VERSION,
  DECISION_CONSULTATION_VERSION,
  type DecisionConsultationResponse,
} from "@cognelis/decision-protocol";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  consultDecisionPrinciples,
  createDecisionMcpServer,
  recordDecisionJournalEntry,
  recordDecisionConsultationFeedback,
} from "../src/mcp-server.js";

const matchedResponse = (): DecisionConsultationResponse => ({
  consultationVersion: DECISION_CONSULTATION_VERSION,
  requestId: "consultation-1",
  status: "matched",
  generatedBy: "deterministic_local_match",
  feedback: {
    token: "opaque-feedback-token",
    expiresAt: "2026-08-08T10:30:00.000Z",
  },
  matches: [
    {
      principleId: "principle-1",
      title: "先验证再扩大",
      principle: "先验证关键边界，再扩大不可逆投入。",
      appliesWhen: "真实运行效果仍不明确时。",
      caution: "验证成本过高时重新评估。",
      confidence: "medium",
      evidenceCount: 2,
      relevanceScore: 45,
      relevance: "strong",
      reason: "适用条件与当前决策存在文本重合。",
      matchedTerms: ["边界"],
    },
  ],
  signals: [],
  boundary: {
    advisoryOnly: true,
    noDecisionWritten: true,
    noPrincipleApplied: true,
    noPreferencePromoted: true,
  },
});

// What a model sees in Claude Code: only the structuredContent of a result that has one.
const modelView = (result: { structuredContent?: unknown }): string => JSON.stringify(result.structuredContent);

describe("decision consultation MCP", () => {
  it("advertises and serves the read-only tool over MCP transport", async () => {
    const server = createDecisionMcpServer({
      sourceClient: "codex",
      runtime: { consult: async () => matchedResponse() },
      requestIdFactory: () => "consultation-1",
      now: () => new Date("2026-08-08T10:00:00.000Z"),
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const responses = new Map<
      string | number,
      (message: Record<string, unknown>) => void
    >();
    clientTransport.onmessage = (message) => {
      if (
        "id" in message &&
        (typeof message.id === "string" || typeof message.id === "number")
      ) {
        responses.get(message.id)?.(message as Record<string, unknown>);
      }
    };
    await Promise.all([server.connect(serverTransport), clientTransport.start()]);
    const request = async (
      id: number,
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`MCP ${method} timed out`)),
          2_000,
        );
        responses.set(id, (message) => {
          clearTimeout(timer);
          responses.delete(id);
          resolve(message);
        });
        void clientTransport.send({
          jsonrpc: "2.0",
          id,
          method,
          params,
        });
      });

    const initialized = await request(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    });
    expect(initialized).toMatchObject({
      result: {
        serverInfo: { name: "decision", version: "1.2.0" },
        instructions: expect.stringContaining("returns the user's own preferences and ideas that bear on the question separately labelled"),
      },
    });
    await clientTransport.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    const listed = await request(2, "tools/list");
    expect(listed).toMatchObject({
      result: {
        tools: [
          expect.objectContaining({
            name: "consult_decision_principles",
            // Said as what it does: a local embedding model, the reader's preferences and ideas, a new token each call.
            description: expect.stringMatching(/local embedding model[\s\S]*preferences and ideas[\s\S]*new token/u),
            annotations: expect.objectContaining({
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: false,
            }),
          }),
          expect.objectContaining({
            name: "record_decision_consultation_feedback",
            annotations: expect.objectContaining({
              readOnlyHint: false,
              destructiveHint: false,
            }),
          }),
          expect.objectContaining({
            name: "record_decision_journal_entry",
            description: expect.stringContaining("explicit"),
            annotations: expect.objectContaining({
              readOnlyHint: false,
              destructiveHint: false,
            }),
          }),
          expect.objectContaining({
            name: "search_decision_context",
            annotations: expect.objectContaining({ readOnlyHint: true, destructiveHint: false }),
          }),
          expect.objectContaining({ name: "record_decision_scope", annotations: expect.objectContaining({ readOnlyHint: false }) }),
          expect.objectContaining({ name: "record_decision_relation", annotations: expect.objectContaining({ readOnlyHint: false }) }),
          expect.objectContaining({ name: "record_decision_outcome", annotations: expect.objectContaining({ readOnlyHint: false, destructiveHint: true }) }),
          expect.objectContaining({ name: "prepare_decision_handoff", annotations: expect.objectContaining({ readOnlyHint: true }) }),
          expect.objectContaining({ name: "open_decision_source", annotations: expect.objectContaining({ readOnlyHint: false, destructiveHint: false }) }),
          expect.objectContaining({ name: "record_decision_context_feedback", annotations: expect.objectContaining({ readOnlyHint: false }) }),
          expect.objectContaining({ name: "get_decision_context_feedback", annotations: expect.objectContaining({ readOnlyHint: true }) }),
        ],
      },
    });
    // One flat object: shown a union at the top, Claude Code offered its first branch alone, and a
    // preference or an idea could not be recorded at all.
    const journal = ((listed.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools)
      .find((tool) => tool.name === "record_decision_journal_entry")!.inputSchema;
    expect(journal).toMatchObject({
      type: "object",
      properties: { kind: { enum: ["decision", "preference", "idea"] }, appliesWhen: expect.any(Object), ideaForm: expect.any(Object) },
      required: expect.arrayContaining(["kind", "title", "content"]),
    });
    expect(journal).not.toHaveProperty("oneOf");
    expect(journal).not.toHaveProperty("anyOf");
    const called = await request(3, "tools/call", {
      name: "consult_decision_principles",
      arguments: {
        question: "上线前是否先验证兼容边界？",
        options: [{ label: "先验证" }, { label: "直接上线" }],
      },
    });
    expect(called).toMatchObject({
      result: {
        structuredContent: {
          availability: "available",
          consultation: { status: "matched" },
        },
      },
    });

    await Promise.all([clientTransport.close(), server.close()]);
  });

  it("sends a pre-answer request and returns bounded non-causal guidance", async () => {
    const consult = vi.fn(async () => matchedResponse());

    const result = await consultDecisionPrinciples(
      {
        question: "上线前是否先验证兼容边界？",
        options: [{ label: "直接上线" }, { label: "先小范围验证" }],
        context: "真实运行兼容性仍不明确。",
      },
      {
        sourceClient: "codex",
        runtime: { consult },
        cwd: "/work/decision",
        now: () => new Date("2026-08-08T10:00:00.000Z"),
        requestIdFactory: () => "consultation-1",
      },
    );

    expect(consult).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "consultation-1",
        project: "decision",
        question: "上线前是否先验证兼容边界？",
        requestedAt: "2026-08-08T10:00:00.000Z",
      }),
      expect.any(Function),
    );
    expect(result.structuredContent).toEqual({
      message: expect.stringContaining("不代表某个选项是答案"),
      availability: "available",
      consultation: matchedResponse(),
    });
    expect(modelView(result)).toContain("没有建立原则采用关系");
    expect(result.content[0]?.text).toContain("不代表某个选项是答案");
    expect(result.content[0]?.text).toContain("没有建立原则采用关系");
  });

  it("sends the languages of the code a consultation is about: the agent's, else those of the repository it runs in", async () => {
    const repository = await mkdtemp(join(tmpdir(), "decision-languages-"));
    await mkdir(join(repository, ".git"));
    await writeFile(join(repository, "go.mod"), "module example.com/app\n");
    await writeFile(join(repository, "package.json"), JSON.stringify({ devDependencies: { typescript: "^5.0.0" } }));
    await mkdir(join(repository, "cmd"));
    const consult = vi.fn(async () => matchedResponse());
    const sent = () => (consult.mock.calls.at(-1) as unknown as [{ languages?: string[] }])[0].languages;
    const ask = (input: Record<string, unknown>) =>
      consultDecisionPrinciples({ question: "错误要不要包一层？", ...input }, { sourceClient: "codex", runtime: { consult }, cwd: join(repository, "cmd") });

    // Not said: worked out from the repository's root, from a directory inside it.
    await ask({});
    expect(sent()).toEqual(["go", "javascript", "typescript"]);
    // Said by the agent: as it said them.
    await ask({ languages: ["rust"] });
    expect(sent()).toEqual(["rust"]);
    // About another repository, whose code this one's manifests say nothing of: left out, not known.
    await ask({ project: "another-repository" });
    expect(sent()).toBeUndefined();
    // A repository with no manifest: not known either, rather than none.
    const bare = await mkdtemp(join(tmpdir(), "decision-languages-bare-"));
    await mkdir(join(bare, ".git"));
    await consultDecisionPrinciples({ question: "错误要不要包一层？" }, { sourceClient: "codex", runtime: { consult }, cwd: bare });
    expect(sent()).toBeUndefined();
  });

  it("gives a manifest's whole family of languages, so a preference kept for one of them is not dropped", async () => {
    const consult = vi.fn(async () => matchedResponse());
    const sent = () => (consult.mock.calls.at(-1) as unknown as [{ languages?: string[] }])[0].languages;
    const repository = async (...manifests: string[]) => {
      const root = await mkdtemp(join(tmpdir(), "decision-languages-family-"));
      await mkdir(join(root, ".git"));
      for (const manifest of manifests) await writeFile(join(root, manifest), "");
      return root;
    };
    const ask = async (cwd: string) => {
      await consultDecisionPrinciples({ question: "错误要不要包一层？" }, { sourceClient: "codex", runtime: { consult }, cwd });
      return sent();
    };

    // A TypeScript monorepo naming typescript only in its packages read as JavaScript alone, and a Kotlin Android app
    // on a Groovy build as Java alone: the preference kept for TypeScript, or Kotlin, was dropped without a word.
    expect(await ask(await repository("package.json", "pnpm-workspace.yaml"))).toEqual(["javascript", "typescript"]);
    expect(await ask(await repository("build.gradle"))).toEqual(["java", "kotlin"]);
    expect(await ask(await repository("CMakeLists.txt"))).toEqual(["cpp", "c"]);
  });

  it("asks an App too old for the languages again without them, rather than losing the consultation", async () => {
    const repository = await mkdtemp(join(tmpdir(), "decision-languages-old-app-"));
    await mkdir(join(repository, ".git"));
    await writeFile(join(repository, "go.mod"), "module example.com/app\n");
    const consult = vi.fn(async (request: { languages?: string[] }, report?: (failure: { reason: "refused"; message: string | null }) => void) => {
      if (request.languages === undefined) return matchedResponse();
      report?.({ reason: "refused", message: null });
      return null;
    });

    const result = await consultDecisionPrinciples({ question: "错误要不要包一层？" }, { sourceClient: "codex", runtime: { consult } as never, cwd: repository });
    expect(consult).toHaveBeenCalledTimes(2);
    expect(result.structuredContent).toMatchObject({ availability: "available" });
  });

  it("records the languages a preference is specific to, and leaves them out of a decision", async () => {
    const create = vi.fn(async () => ({ recordVersion: 1 as const, status: "created" as const, recordKind: "preference" as const, recordId: "preference-1", knowledgeStatus: "inbox" as const, sensitivity: "private" as const, storedTranscript: false as const }));
    const options = { sourceClient: "codex" as const, cwd: "/work/decision", runtime: { record: create } as never };

    await recordDecisionJournalEntry({ kind: "preference", title: "错误一律包一层上下文", content: "返回错误时用 fmt.Errorf 包装。", languages: ["go"] }, options);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ kind: "preference", languages: ["go"] }), expect.anything());
    // Sent for another kind, as every field of one: left out, as the tool's shape says.
    await recordDecisionJournalEntry({ kind: "decision", title: "用游标分页", content: "统一游标分页。", languages: ["go"] } as never, options);
    expect(create).toHaveBeenLastCalledWith(expect.not.objectContaining({ languages: expect.anything() }), expect.anything());
  });

  it("words a principle by the decisions behind it, not 单点证据 beside a count of none or three", async () => {
    const base = matchedResponse();
    const match = (title: string, confidence: "low" | "medium" | "high", evidenceCount: number) => ({ ...base.matches[0]!, principleId: title, title, confidence, evidenceCount });
    const result = await consultDecisionPrinciples({ question: "要不要先验证边界？" }, {
      sourceClient: "codex",
      cwd: "/work/decision",
      runtime: { consult: async () => ({ ...base, matches: [match("原则零", "low", 0), match("原则一", "high", 1), match("原则三", "low", 3)] }) },
    });

    const text = result.content[0]!.text;
    expect(text).toContain("1. 原则零（待验证）");
    expect(text).toContain("2. 原则一（单点证据）");
    expect(text).toContain("3. 原则三（低可信，3 条证据）");
    expect((await consultDecisionPrinciples({ question: "要不要先验证边界？" }, { sourceClient: "codex", cwd: "/work/decision", runtime: { consult: async () => base } }))
      .content[0]!.text).toContain("1. 先验证再扩大（多条印证，2 条证据）");
  });

  it("fails open when the desktop app is unavailable", async () => {
    const result = await consultDecisionPrinciples(
      { question: "是否继续？" },
      {
        sourceClient: "claude-code",
        runtime: { consult: async () => null },
      },
    );

    expect(result.structuredContent).toEqual({
      message: expect.stringContaining("不要因此阻断原生决策流程"),
      availability: "unavailable",
      reason: "not_running",
      consultation: null,
    });
    expect(result.content[0]?.text).toContain("不要因此阻断原生决策流程");

    // An App too old for this bridge, running: said "unavailable", the reader was never told to restart or update it.
    const outdated = await consultDecisionPrinciples(
      { question: "是否继续？" },
      { sourceClient: "claude-code", runtime: { consult: async (_request, report) => (report?.({ reason: "outdated" }), null) } },
    );
    expect(outdated.content[0]?.text).toContain("请用户重启或更新 Decision");
  });

  it("records only an explicit user rating through the anonymous receipt", async () => {
    const submitConsultationFeedback = vi.fn(async () => ({
      feedbackVersion: DECISION_CONSULTATION_FEEDBACK_VERSION,
      status: "accepted" as const,
    }));

    const result = await recordDecisionConsultationFeedback(
      { token: "opaque-feedback-token", rating: "misleading" },
      {
        sourceClient: "codex",
        runtime: {
          consult: async () => matchedResponse(),
          submitConsultationFeedback,
        },
      },
    );

    expect(submitConsultationFeedback).toHaveBeenCalledWith({
      feedbackVersion: DECISION_CONSULTATION_FEEDBACK_VERSION,
      token: "opaque-feedback-token",
      rating: "misleading",
    }, expect.any(Function));
    expect(result.content[0]?.text).toContain("匿名计入");
    expect(result.content[0]?.text).toContain("没有保存问题");
    expect(result.isError).toBeUndefined();
  });

  it("flags as an error a rating or a record that was not saved", async () => {
    const rated = await recordDecisionConsultationFeedback(
      { token: "unknown-token", rating: "helpful" },
      { sourceClient: "codex", runtime: { consult: async () => null, submitConsultationFeedback: async () => ({ feedbackVersion: DECISION_CONSULTATION_FEEDBACK_VERSION, status: "not_found" as const }) } },
    );
    const unrecorded = await recordDecisionJournalEntry(
      { kind: "idea", title: "以后再想", content: "试试冲突触发复盘。" },
      { sourceClient: "codex", runtime: { consult: async () => null, record: async () => null } },
    );
    // Read as saved otherwise: Codex counts a call a success unless it says isError.
    expect([rated.isError, unrecorded.isError]).toEqual([true, true]);
  });

  it("records an explicit preference with safe agent provenance", async () => {
    const record = vi.fn(async (request) => ({
      recordVersion: 1 as const,
      status: "created" as const,
      recordKind: request.kind,
      recordId: "preference-1",
      knowledgeStatus: "active" as const,
      sensitivity: request.sensitivity,
      storedTranscript: false as const,
    }));

    const result = await recordDecisionJournalEntry(
      {
        kind: "preference",
        title: "常规实现决策默认由系统自主完成",
        content: "普通可逆的方向与实现由系统自行判断并交付结果。",
        appliesWhen: "既定目标和仓库范围内的普通产品与工程取舍。",
        exceptions: "权限、付费、不可逆操作、公开范围或核心验收冲突。",
      },
      {
        sourceClient: "codex",
        runtime: { consult: async () => null, record },
        cwd: "/work/decision",
        requestIdFactory: () => "preference-request-1",
      },
    );

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "preference-request-1",
        sourceKind: "agent_capture",
        sourceForm: "machine_summary",
        sensitivity: "private",
        project: "decision",
      }),
      expect.any(Function),
    );
    // In the App's words: it read "已记录preference，… 状态为 active".
    expect(result.content[0]?.text).toMatch(/^已记录偏好，项目 decision.*，状态为有效；未保存原始对话。$/u);
    expect(result.structuredContent).toMatchObject({ record: { recordKind: "preference", knowledgeStatus: "active" } });
    // Filed under the repository the MCP server started in when the agent names none: said, and said where from.
    expect(result.content[0]?.text).toContain("项目 decision（未指定，按 MCP 服务启动所在的仓库");
    expect(result.structuredContent).toMatchObject({ project: "decision" });
    // Put right in the note: recorded again under another project, a decision was a second note beside the misfiled
    // one, and a preference a duplicate left where it was.
    expect(result.content[0]?.text).toContain("在 Obsidian 里改这条笔记的 project 属性，不要重新记录");

    // A duplicate stays under the existing record's project, which the App does not say: named, it read as filed here.
    record.mockResolvedValueOnce({
      recordVersion: 1, status: "duplicate", recordKind: "preference", recordId: "preference-1",
      knowledgeStatus: "active", sensitivity: "private", storedTranscript: false,
    } as never);
    const again = await recordDecisionJournalEntry(
      { kind: "preference", title: "常规实现决策默认由系统自主完成", content: "普通可逆的方向与实现由系统自行判断并交付结果。", project: "another" },
      { sourceClient: "codex", runtime: { consult: async () => null, record }, cwd: "/work/decision" },
    );
    expect(again.structuredContent).not.toHaveProperty("project");
    expect(again.content[0]?.text).toMatch(/^该偏好已存在，没有重复记录；/u);
  });

  it("says in words what a record must change, rather than answering with zod's issue list", async () => {
    const record = vi.fn();
    const options = { sourceClient: "codex" as const, runtime: { consult: async () => null, record }, cwd: "/work/decision" };

    const results = await Promise.all([
      recordDecisionJournalEntry({ kind: "preference", title: "测试先行", content: "改动前先写失败测试", knowledgeStatus: "active", appliesWhen: "修 bug 时" }, options),
      recordDecisionJournalEntry({ kind: "idea", title: "第一行\n第二行", content: "一个想法" }, options),
      // Refused by the App only after the call, in English.
      recordDecisionJournalEntry({ kind: "decision", title: "缓存方案", content: "用 Redis", expectedOutcome: "## 预期结果\n- p99 下降" }, options),
    ]);

    expect(results.map((result) => result.isError)).toEqual([true, true, true]);
    expect(results.map((result) => result.content[0]!.text)).toEqual([
      expect.stringContaining("设为 active 的偏好需要同时写明 appliesWhen 和 exceptions"),
      expect.stringContaining("只能写一行"),
      expect.stringContaining("「## 预期结果」"),
    ]);
    expect(record).not.toHaveBeenCalled();

    // A rule with no words of its own (a title past its length): said by kind, not in zod's English.
    const long = await recordDecisionJournalEntry({ kind: "idea", title: "长".repeat(5_000), content: "一个想法" }, options);
    expect(long.isError).toBe(true);
    expect(long.content[0]!.text).toContain("title超出长度或数量上限");
    expect(long.content[0]!.text).not.toMatch(/[A-Za-z]{3,} must/u);
  });

  it("says in words what a record must change over MCP too, not in the SDK's English", async () => {
    const record = vi.fn(async () => null);
    const server = createDecisionMcpServer({ sourceClient: "codex", runtime: { consult: async () => null, record }, cwd: "/work/decision" });
    const [client, transport] = InMemoryTransport.createLinkedPair();
    const waiting = new Map<number, (message: Record<string, unknown>) => void>();
    client.onmessage = (message) => { if ("id" in message) waiting.get(message.id as number)?.(message as Record<string, unknown>); };
    await Promise.all([server.connect(transport), client.start()]);
    const request = (id: number, method: string, params: Record<string, unknown> = {}) =>
      new Promise<Record<string, unknown>>((resolve) => { waiting.set(id, resolve); void client.send({ jsonrpc: "2.0", id, method, params }); });
    await request(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const call = async (id: number, args: Record<string, unknown>) =>
      (await request(id, "tools/call", { name: "record_decision_journal_entry", arguments: args })).result as { isError?: boolean; content: Array<{ text: string }> };

    // Checked by the SDK against the advertised shape first, these reached the agent as zod's English issue list.
    const long = await call(2, { kind: "idea", title: "长".repeat(600), content: "一个想法" });
    const empty = await call(3, { kind: "decision", title: "缓存方案", content: "   " });
    expect([long.isError, empty.isError]).toEqual([true, true]);
    expect(long.content[0]!.text).toContain("title超出长度或数量上限");
    expect(empty.content[0]!.text).toContain("content为空或太短");
    expect(record).not.toHaveBeenCalled();
  });

  it("records an entry whose time carries the user's offset, as the instant it is", async () => {
    const record = vi.fn(async (_request: unknown) => ({
      recordVersion: 1, status: "created", recordKind: "idea", recordId: "idea-1", knowledgeStatus: "active", sensitivity: "private", storedTranscript: false,
    }) as never);
    const server = createDecisionMcpServer({ sourceClient: "codex", runtime: { consult: async () => null, record }, cwd: "/work/decision" });
    const [client, transport] = InMemoryTransport.createLinkedPair();
    const waiting = new Map<number, (message: Record<string, unknown>) => void>();
    client.onmessage = (message) => { if ("id" in message) waiting.get(message.id as number)?.(message as Record<string, unknown>); };
    await Promise.all([server.connect(transport), client.start()]);
    const request = (id: number, method: string, params: Record<string, unknown> = {}) =>
      new Promise<Record<string, unknown>>((resolve) => { waiting.set(id, resolve); void client.send({ jsonrpc: "2.0", id, method, params }); });
    await request(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    // An "ISO 8601 date-time" as an agent writes the user's local time: refused, nothing was recorded.
    const result = (await request(2, "tools/call", { name: "record_decision_journal_entry", arguments: { kind: "idea", title: "缓存预热", content: "启动时预热热点数据", occurredAt: "2026-10-13T15:30:00+08:00" } })).result as { isError?: boolean };
    expect(result.isError).not.toBe(true);
    expect(record.mock.calls[0]![0]).toMatchObject({ occurredAt: "2026-10-13T07:30:00.000Z" });
  });

  it("records a preference with a field meant for another kind left out, not refused", async () => {
    const record = vi.fn(async (request: { kind: string; sensitivity: "private" }) => ({
      recordVersion: 1 as const,
      status: "created" as const,
      recordKind: request.kind,
      recordId: "preference-1",
      knowledgeStatus: "active" as const,
      sensitivity: request.sensitivity,
      storedTranscript: false as const,
    }));
    const result = await recordDecisionJournalEntry(
      { kind: "preference", title: "包管理器", content: "新项目默认用 pnpm", options: ["pnpm", "npm"] } as never,
      { sourceClient: "claude-code", runtime: { consult: async () => null, record: record as never }, cwd: "/work/decision" },
    );
    expect(result.content[0]?.text).toContain("已记录");
    expect(record).toHaveBeenCalledWith(expect.not.objectContaining({ options: expect.anything() }), expect.any(Function));
  });

  it("reports that nothing was recorded when the app is unavailable", async () => {
    const result = await recordDecisionJournalEntry(
      { kind: "idea", title: "以后再想", content: "试试冲突触发复盘。" },
      {
        sourceClient: "codex",
        runtime: { consult: async () => null, record: async (_request, report) => (report?.({ reason: "no_answer" }), null) },
      },
    );

    // Not "not recorded": sent, and nothing came back, a slow App may have saved it; the agent is told to check.
    expect(result.content[0]?.text).toContain("无法确认这条是否已记录");
    expect(modelView(result)).toContain("不要声称已经沉淀");

    // Refused by an App that could not find its vault: said "maybe not running", the reader went to start it.
    const refused = await recordDecisionJournalEntry(
      { kind: "idea", title: "以后再想", content: "试试冲突触发复盘。" },
      {
        sourceClient: "codex",
        runtime: { consult: async () => null, record: async (_request, report) => (report?.({ reason: "refused", message: "找不到仓库目录 /vault。" }), null) },
      },
    );
    expect(refused.content[0]?.text).toContain("没有记录这条：Decision 没有完成这次请求：找不到仓库目录 /vault。");
    expect(refused.content[0]?.text).not.toContain("没有运行");

    // In Node's own words, which end with no stop: the tool's next sentence ran straight on from them.
    const denied = await recordDecisionJournalEntry(
      { kind: "idea", title: "以后再想", content: "试试冲突触发复盘。" },
      {
        sourceClient: "codex",
        runtime: { consult: async () => null, record: async (_request, report) => (report?.({ reason: "refused", message: "EACCES: permission denied, open '/vault/x.md'" }), null) },
      },
    );
    expect(denied.content[0]?.text).toContain("open '/vault/x.md'。不要声称已经沉淀");
  });

  it.each([
    // A decision restated keeps the first one, and says the rest was not written.
    ["decision", "duplicate", "其它字段也没有写入"],
    // A preference restated with a new exception keeps it, as a revision of the one already there.
    ["preference", "updated", "已作为一次修订保存到原记录"],
    // One restated word for word, or one the user wrote or changed, is left as it is: the user changes it in the App.
    ["preference", "duplicate", "其它字段也没有写入"],
  ] as const)("says what became of a restated %s (%s)", async (kind, status, said) => {
    const result = await recordDecisionJournalEntry(
      kind === "decision"
        ? { kind, title: "列表分页用游标还是偏移？", content: "统一用游标分页" }
        : { kind, title: "包管理器", content: "新项目默认用 pnpm", exceptions: "老项目沿用 npm；monorepo 用 yarn workspaces" },
      {
        sourceClient: "claude-code",
        runtime: {
          consult: async () => null,
          record: async (request) => ({
            recordVersion: 1 as const,
            status,
            recordKind: request.kind,
            recordId: `${request.kind}-1`,
            knowledgeStatus: "active" as const,
            sensitivity: request.sensitivity,
            storedTranscript: false as const,
          }),
        },
      },
    );

    expect(modelView(result)).toContain(said);
  });

  it("tells the agent what a recalled preference is, even with no principle", async () => {
    const result = await consultDecisionPrinciples(
      { question: "这次发布要不要先留回滚入口？" },
      {
        sourceClient: "codex",
        runtime: {
          consult: async () => ({
            ...matchedResponse(),
            status: "no_match" as const,
            noMatchReason: "no_accepted_principles" as const,
            matches: [],
            signals: [
              {
                recordId: "preference-rollback",
                kind: "preference" as const,
                title: "先留回滚入口，再扩大发布",
                summary: "不可逆的发布步骤要先有明确的回滚路径和负责人。",
                standing:
                  "偏好：当前立场，允许例外；未经方法论流程确认前不是已采纳原则",
                qualifier: "例外：只影响本机、随时可以重装的改动。",
                relevanceScore: 21,
                relevance: "possible" as const,
                reason: "偏好与当前决策存在文本重合。",
                matchedTerms: ["回滚"],
              },
            ],
          }),
        },
        requestIdFactory: () => "consultation-signal",
        now: () => new Date("2026-08-08T10:00:00.000Z"),
      },
    );

    const text = result.content[0]?.text ?? "";
    // Appended to the no-match text, not instead of it: the caller still
    // learns there is no accepted principle, and also sees the stance the
    // reader has actually stated.
    expect(text).toContain("当前尚无可读取的已采纳原则");
    expect(text).toContain("先留回滚入口，再扩大发布");
    expect(text).toContain("不是已采纳原则");
    expect(text).toContain("例外：只影响本机");
    expect(text).toContain("不要写成用户已经采用或已经决定");
    expect(modelView(result)).toContain("当前尚无可读取的已采纳原则");
    expect(modelView(result)).toContain("不要写成用户已经采用或已经决定");
  });

  it("tells the agent the reader's preferences and ideas were not read, rather than that there are none", async () => {
    const result = await consultDecisionPrinciples(
      { question: "要不要直接强制推送到 main 分支？" },
      {
        sourceClient: "codex",
        runtime: { consult: async () => ({ ...matchedResponse(), signalsUnavailable: true as const }) },
        requestIdFactory: () => "consultation-unread",
        now: () => new Date("2026-08-08T10:00:00.000Z"),
      },
    );

    // Read as none, a hard constraint the reader had written down went unsaid.
    expect(result.content[0]?.text).toContain("不能据此认为用户在这个问题上没有偏好或约束");
    expect(modelView(result)).toContain("不能据此认为用户在这个问题上没有偏好或约束");
  });
});
