import type { JournalEntry } from "@cognelis/decision-core";
import { DECISION_CONTEXT_VERSION, TODO_VERSION, decisionContextQuerySchema, type DecisionAmendmentRequest, type ModelProviderProfile } from "@cognelis/decision-protocol";
import { ExperienceRepository, TodoHistoryStore, TodoListRepository, serializeExperience, type DecisionContextSnapshot, type StoredAmendment } from "@cognelis/decision-storage";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ContextSearch } from "../src/main/decision-context-signals.js";
import { OrganizationService, type OrganizationGateway, type OrganizationServiceOptions } from "../src/main/organization-service.js";
import { OrganizationStore, type OrganizationState } from "../src/main/organization-store.js";
import { TodoService } from "../src/main/todo-service.js";
import { shutdownApplication } from "../src/main/application-shutdown.js";
import { capacityState } from "./organization-capacity-fixture.js";

/** Model answers by kind of call; each call counted. `hold` keeps a call open until it is aborted. */
const fakeGateway = (answers: { experience?: unknown; todo?: unknown; conflict?: unknown; knowledge?: unknown | ((prompt: string) => unknown) } = {}) => {
  const calls: Array<{ kind: string; profileId: string; prompt: string; maxOutputTokens: number }> = [];
  const control = { fail: false, hold: false, failureUsage: undefined as { inputTokens?: number; outputTokens?: number } | undefined, usage: { inputTokens: 100, outputTokens: 50 } as { inputTokens?: number; outputTokens?: number } | undefined };
  const profiles = [
    { profileId: "cloud-a", kind: "openai", model: "model-a", enabled: true },
    { profileId: "cloud-b", kind: "openai", model: "model-b", enabled: true },
  ] as unknown as ModelProviderProfile[];
  const gateway: OrganizationGateway = {
    listGenerationProfiles: async () => profiles,
    async generate(request, parse, signal, profileId) {
      const kind = request.systemPrompt.includes("自动维护知识") ? "knowledge" : request.systemPrompt.includes("执行经验") ? "experience" : request.systemPrompt.includes("整理同一个项目里的待办") ? "todo" : "conflict";
      calls.push({ kind, profileId, prompt: request.userPrompt, maxOutputTokens: request.maxOutputTokens });
      if (control.hold) {
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { code: "cancelled" })), { once: true }));
      }
      if (control.fail) throw Object.assign(new Error("model down"), { code: "provider_failed", usage: control.failureUsage });
      const output = kind === "knowledge" ? (typeof answers.knowledge === "function" ? answers.knowledge(request.userPrompt) : answers.knowledge ?? { memory: null, triage: null, question: null }) : kind === "experience" ? answers.experience ?? { hasObservation: false } : kind === "todo" ? answers.todo ?? { groups: [], acceptance: [], links: [] } : answers.conflict ?? { pairs: [] };
      return { parsedOutput: parse(output), model: profileId === "cloud-a" ? "model-a" : "model-b", requestId: request.requestId, usage: control.usage ?? {} };
    },
  };
  return { gateway, calls, control };
};

const experienceAnswer = {
  hasObservation: true, title: "修复重复发送后在重试场景验证", scene: "弱网自动重试", action: "带上幂等键", observation: "已验证，完全修好了", inference: "自动重试路径有效", exceptions: "手动重发未验证", outcome: "effective",
};

const setup = async (options: { answers?: Parameters<typeof fakeGateway>[0]; budget?: object; promptChars?: number } = {}) => {
  const vault = await mkdtemp(join(tmpdir(), "paraself-organization-"));
  await mkdir(join(vault, "Decision Journal"), { recursive: true });
  let ids = 0;
  const clock = { now: new Date(Date.UTC(2026, 10, 11, 2)) };
  const repository = new TodoListRepository(vault, { existingVault: true, history: new TodoHistoryStore(`${vault}-history`) });
  const todos = new TodoService({ repository, idFactory: () => `list-${++ids}`, clock: () => clock.now });
  const experiences = new ExperienceRepository(vault);
  const journal: JournalEntry[] = [];
  const pending: import("../src/main/organization-sources.js").PendingOrganizationSource[] = [];
  const amendmentCalls: DecisionAmendmentRequest[] = [];
  const decisions: DecisionContextSnapshot = { documents: [], sources: [{ source: "decisions", status: "ready", records: 0, skipped: 0 }] };
  const trashed: string[] = [];
  const deletedTraces: string[] = [];
  const fake = fakeGateway(options.answers);
  const storePath = join(`${vault}-app`, "organization", "state.json");
  const unreadable = { todos: false, journal: false };
  const amendments = { records: new Map<string, StoredAmendment>(), unavailable: false };
  const relationCalls: unknown[] = [];
  // Run once, right after the service has read: an edit made between a check and the write it guards.
  const hooks: { afterFind?: (() => Promise<void>) | undefined; afterScan?: (() => Promise<void>) | undefined; failTraceDelete?: boolean;
    beforeCreate?: (() => Promise<void>) | undefined; beforeArchivePreview?: (() => Promise<void>) | undefined; beforeJournal?: (() => Promise<void>) | undefined; beforeTraceDelete?: (() => Promise<void>) | undefined; afterAmend?: (() => void) | undefined } = {};
  const once = async (name: "afterFind" | "afterScan") => { const hook = hooks[name]; hooks[name] = undefined; await hook?.(); };
  const idle = { seconds: 0 };
  const make = (override: { promptChars?: number; store?: OrganizationStore; similar?: OrganizationServiceOptions["similar"]; monotonic?: () => number; background?: OrganizationServiceOptions["background"]; onChanged?: () => void } = {}) => new OrganizationService({
    store: override.store ?? new OrganizationStore(storePath),
    readers: {
      todos: async () => {
        if (unreadable.todos) throw new Error("vault offline");
        return repository.scan();
      },
      journal: async () => { const hook = hooks.beforeJournal; hooks.beforeJournal = undefined; await hook?.(); if (unreadable.journal) throw new Error("synthetic journal unavailable"); return { entries: journal, diagnostics: [] }; },
      pending: async () => ({ records: pending, complete: true }),
      decisions: async () => decisions,
      amendments: async () => amendments,
      experiences: () => experiences.scan(),
      relative: (path) => path,
    },
    gateway: fake.gateway,
    ...(override.similar === undefined ? {} : { similar: override.similar }),
    todos,
    amendments: { update: async (input) => {
      amendmentCalls.push(input);
      // Kept as the real repository keeps it: a revision more, the rewrite in force (or gone, on a revert).
      const key = `${input.source}:${input.recordId}`;
      const current = amendments.records.get(key) as unknown as { revision: number; overrides: unknown } | undefined;
      const revision = (current?.revision ?? 0) + 1;
      const overrides = input.action === "revise" ? { contentHash: input.expectedContentHash, fields: input.fields, at: clock.now.toISOString(), client: "manual", reason: input.reason } : null;
      amendments.records.set(key, { amendVersion: 1, source: input.source, recordId: input.recordId, revision, updatedAt: clock.now.toISOString(), amendments: [], overrides, withdrawn: null, history: [] } as never);
      const after = hooks.afterAmend; hooks.afterAmend = undefined; after?.();
      return { amendVersion: 1, status: "saved", revision, relativePath: null, originalUnchanged: true };
    } },
    relations: { update: async (input) => {
      relationCalls.push(input);
      const existing = decisions.relations?.[0];
      const revision = (existing?.revision ?? 0) + 1;
      decisions.relations = [{ ...input, relationVersion: 1, revision, updatedAt: clock.now.toISOString(), history: [] } as never];
      return { status: "saved", revision, originalNotesUnchanged: true };
    } },
    experiences: {
      create: async (record) => { const hook = hooks.beforeCreate; hooks.beforeCreate = undefined; await hook?.(); return experiences.create(record); },
      reviseProperties: (id, hash, change, at) => experiences.reviseProperties(id, hash, change, at),
      previewProperties: async (id, hash, change, at) => { const hook = hooks.beforeArchivePreview; hooks.beforeArchivePreview = undefined; await hook?.(); return experiences.previewProperties(id, hash, change, at); },
      trash: (id, hash, trash) => experiences.trash(id, hash, trash),
      find: async (id, options) => { const found = await experiences.find(id, options); await once("afterFind"); return found; },
      scan: async () => { const scan = await experiences.scan(); await once("afterScan"); return scan; },
    },
    trash: async (path) => { trashed.push(path); await writeFile(path, ""); await import("node:fs/promises").then((fs) => fs.unlink(path)); },
    traces: { deleteRequest: async (requestIds) => {
      const hook = hooks.beforeTraceDelete; hooks.beforeTraceDelete = undefined; await hook?.();
      if (hooks.failTraceDelete === true) { hooks.failTraceDelete = false; throw new Error("trace store busy"); }
      deletedTraces.push(...requestIds);
      return requestIds.length;
    } },
    clock: () => clock.now,
    ...(override.monotonic ? { monotonic: override.monotonic } : {}),
    ...(override.background ? { background: override.background } : {}),
    ...(override.onChanged ? { onChanged: override.onChanged } : {}),
    systemIdleSeconds: () => idle.seconds,
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...((override.promptChars ?? options.promptChars) === undefined ? {} : { promptChars: override.promptChars ?? options.promptChars }),
  });
  const service = make();
  const record = (items: Array<{ title: string; detail?: string; priority?: "p1" | "p2" }>, title = "消息服务缺陷") =>
    todos.recordManual({ title, project: "消息服务", items } as never);
  const decision = (id: string, summary: string) => decisions.documents.push({ source: "decisions", kind: "recorded_decision", id, title: summary, project: "消息服务", status: "active", created: clock.now.toISOString(), summary, appliesWhen: null, caution: null, tags: [], supersedes: [], supersededBy: [], relativePath: `${id}.md`, client: null, sessionId: null, body: summary, bodyStartLine: 1, contentHash: "a".repeat(64) });
  const run = async (target = service, profileId = "cloud-a") => {
    const started = await target.run({ scope: "project", project: "消息服务", profileId });
    await target.settled();
    return started;
  };
  const view = (target = service) => target.snapshot({ scope: "project", project: "消息服务" });
  return { vault, pending, service, make, todos, repository, experiences, fake, record, decision, run, view, clock, trashed, deletedTraces, amendmentCalls, journal, storePath, unreadable, idle, amendments, decisions, relationCalls, hooks };
};

const finishWithNote = async (context: Awaited<ReturnType<typeof setup>>, listId: string, item: number, note: string) => {
  // An agent's report, as update_todo_item writes it.
  await context.todos.updateItem({ todoVersion: TODO_VERSION, listId, item, status: "done", note, sourceClient: "codex" } as never);
};

describe("RSI-14: calendar changes and elapsed time", () => {
  it("a clock rollback does not prolong foreground quiet or a persisted future background interval", async () => {
    const c = await setup(); let elapsed = 1000;
    const service = c.make({ monotonic: () => elapsed, background: { quietMs: 100, spacingMs: 200 } });
    c.idle.seconds = 3600; c.decision("clock", "合成选择");
    await service.setSettings({ background: true, backgroundProfileId: "cloud-a", automatic: true });
    await new OrganizationStore(c.storePath).update(state => { state.lastBackgroundAt = new Date(c.clock.now.getTime() + 3600000).toISOString(); return { state, value: null }; });
    service.noteForeground(); c.clock.now = new Date(c.clock.now.getTime() - 3600000);
    elapsed += 101; await service.checkBackground();
    expect(c.fake.calls).toHaveLength(0);
    elapsed += 201; await service.checkBackground(); await service.settled();
    expect(c.fake.calls.length).toBeGreaterThan(0);
    const calls = c.fake.calls.length; c.decision("wakeup", "唤醒后的新合成选择");
    c.clock.now = new Date(c.clock.now.getTime() + 7200000);
    await service.checkBackground(); await service.settled(); expect(c.fake.calls).toHaveLength(calls);
    service.resume(); await service.checkBackground(); await service.settled();
    expect(c.fake.calls.length).toBeGreaterThan(calls);
    await service.close();
  });

  it("an older attention read cannot erase a newly scheduled deadline", async () => {
    const c = await setup({ answers: { experience: experienceAnswer } });
    const list = await c.record([{ title: "合成重试" }]);
    await finishWithNote(c, list.list!.id, 1, "在测试环境重试 50 次，未再出现重复消息。"); await c.run();
    const suggestion = (await c.view()).suggestions.find(view => view.type === "experience")!;
    let entered!: () => void; let release!: () => void;
    const inside = new Promise<void>(resolve => { entered = resolve; });
    const paused = new Promise<void>(resolve => { release = resolve; });
    class DelayedStore extends OrganizationStore {
      first = true;
      override async read() { const state = await super.read(); if (this.first) { this.first = false; entered(); await paused; } return state; }
    }
    const changed = vi.fn(); const service = c.make({ store: new DelayedStore(c.storePath), onChanged: changed, background: { tickMs: 20 } });
    const earlier = service.attention(); await inside;
    await c.service.decide({ id: suggestion.id, expectedRevision: suggestion.revision, expectedEvidenceVersion: suggestion.evidenceVersion, action: "defer", deferUntil: "2026-11-12" });
    expect((await service.attention()).pending).toBe(0);
    release(); await earlier;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      service.start(); c.clock.now = new Date(2026, 10, 12, 0, 0, 1);
      await vi.advanceTimersByTimeAsync(20); expect(changed).toHaveBeenCalledOnce();
      await service.close(); await vi.advanceTimersByTimeAsync(20); expect(changed).toHaveBeenCalledOnce();
    } finally { await service.close(); vi.useRealTimers(); }
  });

  it("keeps the run budget bounded when wall time moves backwards", async () => {
    const c = await setup({ answers: { experience: experienceAnswer }, budget: { ms: 50 } }); let elapsed = 0;
    const service = c.make({ monotonic: () => elapsed });
    for (let index = 0; index < 2; index++) {
      const list = await c.record([{ title: `合成重试 ${index}` }]);
      await finishWithNote(c, list.list!.id, 1, "在测试环境重试 50 次，未再出现重复消息。");
    }
    const generate = c.fake.gateway.generate;
    c.fake.gateway.generate = async (...args) => { const result = await generate(...args); elapsed += 100; c.clock.now = new Date(c.clock.now.getTime() - 3600000); return result; };
    await c.run(service);
    expect(c.fake.calls).toHaveLength(1);
    expect((await c.view(service)).run?.partialReason).toBe("time");
    await service.close();
  });

  it.each([false, true])("discards an old result across forget, rollback and new source evidence (empty=%s)", async empty => {
    const c = await setup({ answers: { experience: empty ? { hasObservation: false } : experienceAnswer } });
    const list = await c.record([{ title: "合成重试" }]);
    await finishWithNote(c, list.list!.id, 1, "在测试环境重试 50 次，未再出现重复消息。");
    let entered!: () => void; let release!: () => void;
    const inside = new Promise<void>(resolve => { entered = resolve; });
    const paused = new Promise<void>(resolve => { release = resolve; });
    const generate = c.fake.gateway.generate;
    c.fake.gateway.generate = async (...args) => { entered(); await paused; return generate(...args); };
    await c.service.run({ scope: "project", project: "消息服务", profileId: "cloud-a" }); await inside;
    c.clock.now = new Date(c.clock.now.getTime() - 3600000);
    const key = `todo_item:${list.list!.id}#1`; const preview = await c.service.previewForget({ key });
    await c.service.forget({ key, confirm: true, expectedPreviewHash: preview.previewHash });
    await finishWithNote(c, list.list!.id, 1, "新增验证：在另一设备重试 100 次，仍然出现重复消息。");
    release(); await c.service.settled();
    expect((await c.view()).suggestions.filter(view => view.type === "experience" && !view.redacted)).toHaveLength(0);
    expect(c.deletedTraces.length).toBeGreaterThan(0);
    expect((await new OrganizationStore(c.storePath).read()).ledger.processed).toEqual({});
    await c.run(); expect(c.fake.calls).toHaveLength(2);
  });

  it.each(["2026-11-12", "2026-11-11T02:01:00.000Z"])("refreshes due attention across midnight, same-day expiry, resume and rollback: %s", async deadline => {
    const c = await setup({ answers: { experience: experienceAnswer } });
    const list = await c.record([{ title: "合成修复" }]);
    await finishWithNote(c, list.list!.id, 1, "重试无重复，合成结果"); await c.run();
    const suggestion = (await c.view()).suggestions.find(view => view.type === "experience")!;
    await c.service.decide({ id: suggestion.id, expectedRevision: suggestion.revision, expectedEvidenceVersion: suggestion.evidenceVersion, action: "defer", deferUntil: deadline });
    const changed = vi.fn(); const service = c.make({ onChanged: changed });
    expect((await service.attention()).pending).toBe(0);
    const before = c.clock.now;
    c.clock.now = deadline.length === 10 ? new Date(2026, 10, 12, 0, 0, 1) : new Date("2026-11-11T02:01:01Z");
    service.checkClock(); expect(changed).toHaveBeenCalledOnce();
    expect((await service.attention()).pending).toBe(1);
    service.checkClock(); expect(changed).toHaveBeenCalledOnce();
    c.clock.now = before; service.resume(); expect(changed).toHaveBeenCalledTimes(2);
    expect((await service.attention()).pending).toBe(0);
    await service.close(); c.clock.now = new Date(2026, 10, 13); service.checkClock();
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("allows substantive evidence after forgetting across a rollback, but not metadata-only edits", async () => {
    const c = await setup({ answers: { experience: experienceAnswer } });
    const list = await c.record([{ title: "合成修复" }]);
    await finishWithNote(c, list.list!.id, 1, "在测试环境重试 50 次，未再出现重复消息。"); await c.run();
    const key = `todo_item:${list.list!.id}#1`;
    const preview = await c.service.previewForget({ key });
    await c.service.forget({ key, confirm: true, expectedPreviewHash: preview.previewHash });
    const calls = c.fake.calls.length; expect(calls).toBeGreaterThan(0);
    c.clock.now = new Date(c.clock.now.getTime() - 3600000);
    await c.todos.updateItem({ todoVersion: TODO_VERSION, listId: list.list!.id, item: 1, priority: "p1", sourceClient: "codex" } as never);
    await c.run(); expect(c.fake.calls).toHaveLength(calls);
    await finishWithNote(c, list.list!.id, 1, "新增验证：在另一设备重试 100 次，仍然出现重复消息。");
    await c.run(); expect(c.fake.calls.length).toBeGreaterThan(calls);
    const restored = (await c.view()).suggestions.find(view => view.type === "experience")!;
    expect(restored.redacted).toBe(false); expect(restored.state).toBe("pending");
    expect((await c.service.decide({ id: restored.id, expectedRevision: restored.revision, expectedEvidenceVersion: restored.evidenceVersion, action: "adopt" })).status).toBe("saved");
    expect((await c.experiences.scan()).experiences.some(entry => entry.record.status === "active")).toBe(true);
    expect((await new OrganizationStore(c.storePath).read()).ledger.forgotten[key]).toBeDefined();
  });
});

describe("RSI-13: repeated activity and shutdown", () => {
  const barrier = () => {
    let entered!: () => void; let release!: () => void;
    const inside = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    return { inside, release, wait: async () => { entered(); await gate; } };
  };
  class CountedStore extends OrganizationStore {
    reads = 0;
    beforeRead: (() => Promise<void>) | undefined;
    override async read() { this.reads += 1; await this.beforeRead?.(); return super.read(); }
  }
  it("does not read the whole state for foreground activity when no background run is active", async () => {
    const c = await setup(); const store = new CountedStore(c.storePath); const service = c.make({ store });
    for (let index = 0; index < 40; index += 1) service.noteForeground();
    await new Promise(resolve => setImmediate(resolve));
    expect(store.reads).toBe(0);
    await service.close();
  });
  it("persists only start and finish checkpoints for a run with no work", async () => {
    const c = await setup();
    class Writes extends OrganizationStore {
      writes = 0;
      override update<T>(change: (state: OrganizationState) => { state: OrganizationState | null; value: T }): Promise<T> {
        return super.update(state => { const result = change(state); if (result.state !== null) this.writes += 1; return result; });
      }
    }
    const store = new Writes(c.storePath); const service = c.make({ store });
    await service.run({ scope: "all", project: null, profileId: "cloud-a" }); await service.settled();
    expect((await store.read()).runs.at(-1)?.state).toBe("no_change");
    expect(c.fake.calls).toHaveLength(0); expect(store.writes).toBe(2);
  });
  it("does not overlap background checks waiting for storage", async () => {
    const c = await setup(); const store = new CountedStore(c.storePath); const service = c.make({ store });
    c.idle.seconds = 3600;
    const held = barrier(); store.beforeRead = held.wait;
    const first = service.checkBackground(); await held.inside;
    const second = service.checkBackground();
    const reads = store.reads; held.release();
    await Promise.all([first, second]);
    expect(reads).toBe(1);
  });
  it.each(["manual", "background"] as const)("does not start work or write after closing during %s preparation", async trigger => {
    const c = await setup();
    await c.record([{ title: "退出期间的待处理事项" }]);
    await c.service.setSettings({ background: trigger === "background", backgroundProfileId: "cloud-a" });
    c.idle.seconds = 3600;
    const held = barrier(); c.hooks.beforeJournal = held.wait;
    const original = await readFile(c.storePath, "utf8");
    const preparing = trigger === "background" ? c.service.checkBackground() : c.service.run({ scope: "project", project: "消息服务", profileId: "cloud-a" });
    await held.inside;
    await c.service.close();
    held.release(); await preparing; await c.service.settled();
    expect(c.fake.calls).toHaveLength(0);
    expect(await readFile(c.storePath, "utf8")).toBe(original);
  });
  it("yields when foreground activity arrives during the background run's final preparation", async () => {
    const c = await setup(); await c.record([{ title: "前台活动应优先" }]);
    await c.service.setSettings({ background: true, backgroundProfileId: "cloud-a" }); c.idle.seconds = 3600;
    const held = barrier(); c.hooks.beforeJournal = async () => { c.hooks.beforeJournal = held.wait; };
    const original = await readFile(c.storePath, "utf8");
    const preparing = c.service.checkBackground(); await held.inside;
    c.service.noteForeground(); held.release(); await preparing; await c.service.settled();
    expect(c.fake.calls).toHaveLength(0); expect(await readFile(c.storePath, "utf8")).toBe(original);
  });
  it("waits for an accepted choice to finish its write before closing", async () => {
    const c = await setup({ answers: { experience: experienceAnswer } });
    const list = await c.record([{ title: "退出前已确认的记录" }]);
    await finishWithNote(c, list.list!.id, 1, "重试五十次未重复。"); await c.run();
    const suggestion = (await c.view()).suggestions.find(entry => entry.type === "experience")!;
    const held = barrier(); c.hooks.beforeCreate = held.wait;
    const adopting = c.service.decide({ id: suggestion.id, expectedRevision: suggestion.revision, expectedEvidenceVersion: suggestion.evidenceVersion, action: "adopt" });
    await held.inside;
    let closed = false; const closing = c.service.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    const closedWhileWriting = closed;
    held.release(); await adopting; await closing;
    expect(closedWhileWriting).toBe(false);
    expect((await new OrganizationStore(c.storePath).read()).suggestions[suggestion.id]!.state).toBe("applied");
    expect((await c.experiences.scan()).experiences).toHaveLength(1);
  });
  it("does not reconcile a late snapshot into storage after closing", async () => {
    const c = await setup({ answers: { experience: experienceAnswer } });
    const list = await c.record([{ title: "退出时的来源更新" }]);
    await finishWithNote(c, list.list!.id, 1, "重试五十次未重复。"); await c.run();
    await finishWithNote(c, list.list!.id, 1, "更正：网络切换仍然重复。");
    const held = barrier(); c.hooks.beforeJournal = held.wait;
    const original = await readFile(c.storePath, "utf8");
    const reading = c.view(); await held.inside;
    await c.service.close(); held.release(); await reading;
    expect(await readFile(c.storePath, "utf8")).toBe(original);
  });
  it("waits for an already-started reconciliation cleanup before closing", async () => {
    const c = await setup({ answers: { experience: experienceAnswer } });
    const list = await c.record([{ title: "已删除记忆的清理" }]);
    await finishWithNote(c, list.list!.id, 1, "重试五十次未重复。");
    await c.service.setSettings({ automatic: true, background: false, backgroundProfileId: "cloud-a" }); await c.run();
    const note = (await c.experiences.scan()).experiences[0]!;
    await rm(note.path);
    const held = barrier(); c.hooks.beforeTraceDelete = held.wait;
    const reading = c.view(); await held.inside;
    let closed = false; const closing = c.service.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve)); const closedDuringCleanup = closed;
    held.release(); await reading; await closing;
    expect(closedDuringCleanup).toBe(false);
    expect((await new OrganizationStore(c.storePath).read()).ledger.calls).toHaveLength(0);
  });
  it("finishes accepted forgetting and preserves its receipt before closing", async () => {
    const c = await setup({ answers: { experience: experienceAnswer } });
    const list = await c.record([{ title: "退出前明确遗忘" }]);
    await finishWithNote(c, list.list!.id, 1, "重试五十次未重复。");
    await c.service.setSettings({ automatic: true, background: false, backgroundProfileId: "cloud-a" }); await c.run();
    const key = `todo_item:${list.list!.id}#1`;
    const preview = await c.service.previewForget({ key });
    const held = barrier(); c.hooks.beforeTraceDelete = held.wait;
    const forgetting = c.service.forget({ key, confirm: true, expectedPreviewHash: preview.previewHash }); await held.inside;
    let closed = false; const closing = c.service.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve)); const closedDuringForget = closed;
    held.release(); const result = await forgetting; await closing;
    expect(closedDuringForget).toBe(false); expect(result.status).toBe("done");
    expect((await new OrganizationStore(c.storePath).read()).ledger.forgotten[key]).toBeDefined();
    expect((await c.experiences.scan()).experiences).toHaveLength(0);
  });
  it("flushes forgetting without waiting for an unresponsive model and clears its late trace", async () => {
    const c = await setup({ answers: { experience: experienceAnswer } });
    const list = await c.record([{ title: "模型取消不应阻塞本地遗忘" }]);
    await finishWithNote(c, list.list!.id, 1, "重试五十次未重复。");
    const held = barrier(); const generate = c.fake.gateway.generate;
    let requestId = ''; let deletionsAtLateResult = 0;
    c.fake.gateway.generate = async (...args) => {
      requestId = args[0].requestId;
      await held.wait();
      deletionsAtLateResult = c.deletedTraces.length;
      return generate(...args);
    };
    await c.service.run({ scope: "project", project: "消息服务", profileId: "cloud-a" }); await held.inside;
    const key = `todo_item:${list.list!.id}#1`; const preview = await c.service.previewForget({ key });
    const forgetting = c.service.forget({ key, confirm: true, expectedPreviewHash: preview.previewHash });
    const closing = c.service.close();
    let flushed = false; const flushing = c.service.finishWrites().then(() => { flushed = true; });
    let shutdown: Promise<void> | undefined; let fakeTimers = false;
    try {
      await vi.waitFor(() => expect(flushed).toBe(true), { timeout: 2000 });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); fakeTimers = true;
      let ended = false;
      shutdown = shutdownApplication({ closeObsidian: async () => undefined, flushSemanticPairs: async () => undefined,
        closeSemanticCoordinator: async () => undefined, closeDecisionSemanticSearch: async () => undefined,
        closeLocalModels: () => new Promise<void>(() => undefined), flushOrganization: () => c.service.finishWrites(), stopController: () => closing }).then(() => { ended = true; });
      await vi.advanceTimersByTimeAsync(15000);
      expect(ended).toBe(true);
    } finally {
      held.release(); await forgetting; await closing; await flushing;
      if (fakeTimers) { await vi.advanceTimersByTimeAsync(30000); vi.useRealTimers(); }
      await shutdown;
    }
    expect(c.deletedTraces.length).toBeGreaterThan(deletionsAtLateResult);
    expect(c.deletedTraces).toContain(requestId);
    const stored = await new OrganizationStore(c.storePath).read();
    expect(stored.ledger.forgotten[key]).toBeDefined(); expect(stored.ledger.calls).toHaveLength(0);
    expect(Object.keys(stored.suggestions)).toHaveLength(0);
  });
  it("keeps a failed trace-cleanup checkpoint and retries it after restart without changing user receipts", async () => {
    const c = await setup(); const store = new OrganizationStore(c.storePath);
    const seed = capacityState(1);
    seed.ledger.pendingTraceDeletes = ['old-forgotten-call'];
    await store.update(() => ({ state: seed, value: null }));
    c.hooks.failTraceDelete = true;
    await c.service.recover();
    expect((await store.read()).ledger.pendingTraceDeletes).toEqual(['old-forgotten-call']);
    await c.make().recover();
    const restored = await store.read();
    expect(restored.ledger.pendingTraceDeletes).toBeUndefined();
    expect(restored.suggestions).toEqual(seed.suggestions);
    expect(restored.ledger.forgotten).toEqual(seed.ledger.forgotten);
    expect(restored.ledger.forgottenEvidence).toEqual(seed.ledger.forgottenEvidence);
  });
});

describe("organization: the same input is not judged twice", () => {
  it("makes no model call and no new suggestion the second time, with another model too", async () => {
    const context = await setup({ answers: { experience: experienceAnswer } });
    const list = await context.record([{ title: "修复客户端弱网重试时消息重复发送" }, { title: "调研重复消息的幂等方案" }]);
    await finishWithNote(context, list.list!.id, 1, "在测试环境断网 3 秒后恢复重试 50 次，未再出现重复消息。");
    await context.run();
    const first = context.fake.calls.length;
    const before = await context.view();
    expect(first).toBeGreaterThan(0);
    expect(before.counts.memory).toBe(1);
    await context.run();
    await context.run(context.service, "cloud-b");
    expect(context.fake.calls.length).toBe(first);
    const after = await context.view();
    expect(after.suggestions.map((view) => [view.id, view.revision])).toEqual(before.suggestions.map((view) => [view.id, view.revision]));
    expect(after.run?.state).toBe("no_change");
  });
});

describe("organization: experiences", () => {
  it("keeps an agent's report unverified whatever the model says of it, and skips a bare tick", async () => {
    const context = await setup({ answers: { experience: experienceAnswer } });
    const list = await context.record([{ title: "修复重复发送" }, { title: "清理旧回调" }]);
    await finishWithNote(context, list.list!.id, 1, "在测试环境重试 50 次，未再出现重复消息。");
    await finishWithNote(context, list.list!.id, 2, "已处理");
    await context.run();
    expect(context.fake.calls.filter((call) => call.kind === "experience")).toHaveLength(1);
    const snapshot = await context.view();
    const experience = snapshot.suggestions.find((view) => view.type === "experience")!;
    expect(experience.attribution).toMatchObject({ reporter: "agent", verification: "agent_reported_unverified" });
    expect(experience.content).toMatchObject({ verification: "agent_reported_unverified" });
  });

  it("never takes a 处置备注 for an observation", async () => {
    const context = await setup({ answers: { experience: experienceAnswer } });
    const list = await context.record([{ title: "修复重复发送" }]);
    const listId = list.list!.id;
    await context.todos.changeItem({ listId, item: 1, expectedStatus: "open", disposition: "已验证：重试 50 次未重复，结果很好" } as never);
    await context.run();
    expect(context.fake.calls.filter((call) => call.kind === "experience")).toHaveLength(0);
    const prompts = context.fake.calls.map((call) => call.prompt).join("\n");
    expect(prompts).not.toContain("结果很好");
  });

  it("adopts into a note that is searched only once every source checked out, and undoes only what is unchanged", async () => {
    const context = await setup({ answers: { experience: experienceAnswer } });
    const list = await context.record([{ title: "修复重复发送" }]);
    await finishWithNote(context, list.list!.id, 1, "在测试环境重试 50 次，未再出现重复消息。");
    await context.run();
    const suggestion = (await context.view()).suggestions.find((view) => view.type === "experience")!;
    const adopted = await context.service.decide({ id: suggestion.id, expectedRevision: suggestion.revision, expectedEvidenceVersion: suggestion.evidenceVersion, action: "adopt" });
    expect(adopted.status).toBe("saved");
    const notes = (await context.experiences.scan()).experiences;
    expect(notes).toHaveLength(1);
    expect(notes[0]!.record).toMatchObject({ status: "active", verification: "agent_reported_unverified", reporter: "agent" });
    // Edited in Obsidian after the adoption: the undo shows a diff first, then needs that diff's hash.
    await writeFile(notes[0]!.path, `${await readFile(notes[0]!.path, "utf8")}\n读者的补充\n`);
    const applied = (await context.view()).suggestions.find((view) => view.id === suggestion.id)!;
    expect(applied.canUndo).toBe(true);
    const review = await context.service.undo({ id: suggestion.id, expectedRevision: applied.revision });
    expect(review.status).toBe("needs_review");
    expect(review.diffHash).toMatch(/^[a-f0-9]{64}$/u);
    expect((await context.service.undo({ id: suggestion.id, expectedRevision: applied.revision, expectedDiffHash: "0".repeat(64) })).status).toBe("needs_review");
    expect((await context.service.undo({ id: suggestion.id, expectedRevision: applied.revision, expectedDiffHash: review.diffHash! })).status).toBe("saved");
    expect((await context.experiences.scan()).experiences).toHaveLength(0);
  });

  it("refuses an adoption whose source changed since, and writes nothing", async () => {
    const context = await setup({ answers: { experience: experienceAnswer } });
    const list = await context.record([{ title: "修复重复发送" }]);
    await finishWithNote(context, list.list!.id, 1, "在测试环境重试 50 次，未再出现重复消息。");
    await context.run();
    const suggestion = (await context.view()).suggestions.find((view) => view.type === "experience")!;
    // The result said again, differently: what the experience rests on changed.
    await context.todos.updateItem({ todoVersion: TODO_VERSION, listId: list.list!.id, item: 1, note: "重试 50 次，其中 2 次仍出现重复消息。", sourceClient: "codex" } as never);
    const stale = (await context.view()).suggestions.find((view) => view.id === suggestion.id)!;
    expect(stale.canAdopt).toBe(false);
    expect(stale.stale?.reason).toBe("source_changed");
    expect(stale.sources[0]!.currentText).toContain("2 次仍出现");
    const answer = await context.service.decide({ id: suggestion.id, expectedRevision: stale.revision, expectedEvidenceVersion: stale.evidenceVersion, action: "adopt" });
    expect(answer.status).toBe("stale");
    expect((await context.experiences.scan()).experiences).toHaveLength(0);
  });
});

describe("organization: rejection, deferral and new evidence", () => {
  it("RSI-12 keeps a rejection after compressed persistence and regeneration on the same evidence", async () => {
    const c = await setup({ answers: { experience: experienceAnswer } });
    const list = await c.record([{ title: "修复重复发送" }]);
    await finishWithNote(c, list.list!.id, 1, "重试五十次未重复。");
    await c.run();
    const suggestion = (await c.view()).suggestions.find(entry => entry.type === "experience")!;
    await c.service.decide({ id: suggestion.id, expectedRevision: suggestion.revision, expectedEvidenceVersion: suggestion.evidenceVersion, action: "reject" });
    const store = new OrganizationStore(c.storePath);
    const receipts = (await store.read()).suggestions[suggestion.id]!.receipts;
    await store.update(state => { Object.assign(state.suggestions, capacityState(1600).suggestions); return { state, value: null }; });
    const restarted = c.make();
    const calls = c.fake.calls.length;
    await restarted.regenerate({ id: suggestion.id, profileId: "cloud-b" }); await restarted.settled();
    expect(c.fake.calls.length).toBeGreaterThan(calls);
    expect((await store.read()).suggestions[suggestion.id]).toMatchObject({ state: "rejected", receipts });
    expect((await c.view(restarted)).suggestions.some(entry => entry.id === suggestion.id)).toBe(false);
  });
  it("keeps a rejection through a priority change and another model, and reopens only on new evidence, saying why", async () => {
    const context = await setup({ answers: { experience: experienceAnswer } });
    const list = await context.record([{ title: "修复重复发送" }]);
    const listId = list.list!.id;
    await finishWithNote(context, listId, 1, "在测试环境重试 50 次，未再出现重复消息。");
    await context.run();
    const suggestion = (await context.view()).suggestions.find((view) => view.type === "experience")!;
    await context.service.decide({ id: suggestion.id, expectedRevision: suggestion.revision, expectedEvidenceVersion: suggestion.evidenceVersion, action: "reject" });
    await context.todos.changeItem({ listId, item: 1, expectedStatus: "done", priority: "p1" } as never);
    await context.run(context.service, "cloud-b");
    expect((await context.view()).suggestions.some((view) => view.id === suggestion.id)).toBe(false);
    await context.todos.updateItem({ todoVersion: TODO_VERSION, listId, item: 1, note: "补充：在 Wi-Fi 切换时仍复现过一次。", sourceClient: "codex" } as never);
    await context.run(context.service, "cloud-b");
    const reopened = (await context.view()).suggestions.find((view) => view.id === suggestion.id)!;
    expect(reopened.state).toBe("pending");
    expect(reopened.reopenReason).toContain("内容已改变");
  });

  it("hides a deferred suggestion until its day, then shows it again without a new call", async () => {
    const context = await setup({ answers: { experience: experienceAnswer } });
    const list = await context.record([{ title: "修复重复发送" }]);
    await finishWithNote(context, list.list!.id, 1, "在测试环境重试 50 次，未再出现重复消息。");
    await context.run();
    const suggestion = (await context.view()).suggestions.find((view) => view.type === "experience")!;
    await context.service.decide({ id: suggestion.id, expectedRevision: suggestion.revision, expectedEvidenceVersion: suggestion.evidenceVersion, action: "defer", deferUntil: "2026-11-15" });
    expect((await context.view()).counts.memory).toBe(0);
    const calls = context.fake.calls.length;
    context.clock.now = new Date(Date.UTC(2026, 10, 15, 3));
    const later = await context.view();
    expect(later.counts.memory).toBe(1);
    expect(context.fake.calls.length).toBe(calls);
  });

  it("lets only one of two adoptions of the same suggestion through", async () => {
    const context = await setup({ answers: { experience: experienceAnswer } });
    const list = await context.record([{ title: "修复重复发送" }]);
    await finishWithNote(context, list.list!.id, 1, "在测试环境重试 50 次，未再出现重复消息。");
    await context.run();
    const suggestion = (await context.view()).suggestions.find((view) => view.type === "experience")!;
    const ask = () => context.service.decide({ id: suggestion.id, expectedRevision: suggestion.revision, expectedEvidenceVersion: suggestion.evidenceVersion, action: "adopt" });
    const [left, right] = await Promise.all([ask(), ask()]);
    expect([left.status, right.status].sort()).toEqual(["busy", "saved"].sort());
    expect((await context.experiences.scan()).experiences).toHaveLength(1);
  });
});

describe("organization: todo suggestions", () => {
  const todoAnswer = {
    groups: [{ title: "消息重复发送", members: [{ ref: "T1", difference: "修复动作" }, { ref: "T2", difference: "方案调研" }, { ref: "T9", difference: "不存在的别名" }] }],
    acceptance: [{ ref: "T1", missing: "可检查的完成标准", draftDetail: "完成标准：弱网下重试 50 次无重复。" }],
    links: [],
  };

  it("groups only in the reading layer and writes an accepted draft only on the item as it was", async () => {
    const context = await setup({ answers: { todo: todoAnswer } });
    const list = await context.record([{ title: "修复客户端消息重复发送问题" }, { title: "调研消息重复发送的幂等方案" }]);
    const listId = list.list!.id;
    await context.run();
    const snapshot = await context.view();
    const group = snapshot.suggestions.find((view) => view.type === "todo_group")!;
    expect(group.content).toMatchObject({ members: [{ key: `todo_item:${listId}#1` }, { key: `todo_item:${listId}#2` }] });
    expect((await context.service.decide({ id: group.id, expectedRevision: group.revision, expectedEvidenceVersion: group.evidenceVersion, action: "adopt" })).status).toBe("saved");
    const annotations = await context.service.annotations({ listIds: [listId] });
    expect(annotations.groups).toEqual([expect.objectContaining({ suggestionId: group.id, revision: group.revision })]);
    // The items themselves untouched.
    const lists = await context.todos.list({ listId });
    expect(lists.lists[0]!.items.map((item) => [item.number, item.status, item.detail])).toEqual([[1, "open", null], [2, "open", null]]);

    const acceptance = snapshot.suggestions.find((view) => view.type === "todo_acceptance")!;
    // The title changed in Obsidian after the draft was made: nothing written.
    const path = (await context.repository.scan()).lists[0]!.path;
    await writeFile(path, (await readFile(path, "utf8")).replace("修复客户端消息重复发送问题", "修复客户端消息重复发送问题（含服务端）"));
    const refused = await context.service.decide({ id: acceptance.id, expectedRevision: acceptance.revision, expectedEvidenceVersion: acceptance.evidenceVersion, action: "adopt" });
    expect(refused.status).toBe("stale");
    expect((await context.todos.list({ listId })).lists[0]!.items[0]!.detail).toBeNull();
  });

  it("clears every text of a suggestion whose item was deleted, and never brings it back", async () => {
    const context = await setup({ answers: { todo: todoAnswer } });
    const list = await context.record([{ title: "修复客户端消息重复发送问题" }, { title: "调研消息重复发送的幂等方案" }]);
    const listId = list.list!.id;
    await context.run();
    const acceptance = (await context.view()).suggestions.find((view) => view.type === "todo_acceptance")!;
    await context.todos.deleteItems({ listId, items: [{ item: 1, expectedStatus: "open" }] } as never);
    const after = await context.view();
    expect(after.suggestions.some((view) => view.id === acceptance.id)).toBe(false);
    const raw = await readFile(context.storePath, "utf8");
    expect(raw).not.toContain("弱网下重试 50 次无重复");
    expect(context.deletedTraces.length).toBeGreaterThan(0);
  });

  it("does not take an unreadable vault for deleted items", async () => {
    const context = await setup({ answers: { todo: todoAnswer } });
    await context.record([{ title: "修复客户端消息重复发送问题" }, { title: "调研消息重复发送的幂等方案" }]);
    await context.run();
    const acceptance = (await context.view()).suggestions.find((view) => view.type === "todo_acceptance")!;
    context.unreadable.todos = true;
    const frozen = (await context.view()).suggestions.find((view) => view.id === acceptance.id)!;
    expect(frozen.stale?.reason).toBe("source_unreadable");
    expect(frozen.content).not.toBeNull();
    expect((await context.service.decide({ id: acceptance.id, expectedRevision: acceptance.revision, expectedEvidenceVersion: acceptance.evidenceVersion, action: "adopt" })).status).toBe("source_unavailable");
  });
});

describe("organization: budget, failure and cancellation", () => {
  it("stops at the call budget as partial, keeping the rest queued; a failed call is counted and not marked done", async () => {
    const context = await setup({ answers: { experience: experienceAnswer }, budget: { calls: 1 } });
    const list = await context.record([{ title: "修复重复发送" }, { title: "完全无关的另一件事情" }]);
    await finishWithNote(context, list.list!.id, 1, "在测试环境重试 50 次，未再出现重复消息。");
    await finishWithNote(context, list.list!.id, 2, "改了配置并在预发环境确认过两次。");
    await context.run();
    const first = await context.view();
    expect(first.run?.state).toBe("partial");
    expect(first.run?.partialReason).toBe("calls");
    expect(first.run?.usage).toMatchObject({ calls: 1, reportedInputTokens: 100, estimatedInputTokens: 0 });
    context.fake.control.fail = true;
    context.fake.control.usage = undefined;
    await context.run();
    const failed = await context.view();
    expect(["failed", "partial"]).toContain(failed.run?.state);
    expect(failed.run?.usage.failedCalls).toBeGreaterThan(0);
    expect(failed.run?.usage.estimatedInputTokens).toBeGreaterThan(0);
    context.fake.control.fail = false;
    context.fake.control.usage = { inputTokens: 100, outputTokens: 50 };
    await context.run();
    // The one that failed is still there to be done: two experiences in the end.
    expect((await context.view()).counts.memory).toBe(2);
  });

  it("drops what a stopped run's model answers late", async () => {
    const context = await setup({ answers: { experience: experienceAnswer } });
    const list = await context.record([{ title: "修复重复发送" }]);
    await finishWithNote(context, list.list!.id, 1, "在测试环境重试 50 次，未再出现重复消息。");
    context.fake.control.hold = true;
    const started = await context.service.run({ scope: "project", project: "消息服务", profileId: "cloud-a" });
    while (context.fake.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const stopped = await context.service.control({ runId: started.run!.runId, action: "stop" });
    expect(stopped.state).toBe("stopped");
    const view = await context.view();
    expect(view.counts.memory).toBe(0);
    expect(view.activeRun).toBeNull();
    context.fake.control.hold = false;
    await context.run();
    expect((await context.view()).counts.memory).toBe(1);
  });

  it("does not run outside the scope it was given", async () => {
    const context = await setup();
    await context.record([{ title: "别的项目的事" }]);
    expect((await context.service.run({ scope: "list", project: "消息服务", listId: "no-such-list", profileId: "cloud-a" })).status).toBe("out_of_scope");
    expect((await context.service.run({ scope: "selection", project: "别的项目", listId: "list-1", items: ["todo_item:list-1#1"], profileId: "cloud-a" })).status).toBe("out_of_scope");
    expect((await context.service.run({ scope: "project", project: "消息服务", profileId: "no-such-model" })).status).toBe("model_unavailable");
  });
});

describe("organization: the store", () => {
  it("never writes over a file it cannot read", async () => {
    const context = await setup();
    await mkdir(join(context.storePath, ".."), { recursive: true });
    await writeFile(context.storePath, "{ broken");
    const snapshot = await context.view();
    expect(snapshot.damaged).not.toBeNull();
    expect((await context.service.run({ scope: "project", project: "消息服务", profileId: "cloud-a" })).status).toBe("damaged");
    expect(await readFile(context.storePath, "utf8")).toBe("{ broken");
  });

  it("says a run cut short by a quit interrupted, its queue kept", async () => {
    const context = await setup({ answers: { experience: experienceAnswer } });
    const list = await context.record([{ title: "修复重复发送" }]);
    await finishWithNote(context, list.list!.id, 1, "在测试环境重试 50 次，未再出现重复消息。");
    context.fake.control.hold = true;
    await context.service.run({ scope: "project", project: "消息服务", profileId: "cloud-a" });
    while (context.fake.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    // A new process over the same file, as after a quit.
    const restarted = context.make();
    await restarted.recover();
    expect((await restarted.snapshot({ scope: "project", project: "消息服务" })).run?.state).toBe("interrupted");
    context.fake.control.hold = false;
    await context.run(restarted);
    expect((await context.view(restarted)).counts.memory).toBe(1);
    await context.service.close();
  });
});

describe("organization: forgetting", () => {
  it("is bound to the preview that was seen, and takes the experience, the suggestion and its call records", async () => {
    const context = await setup({ answers: { experience: experienceAnswer } });
    const list = await context.record([{ title: "修复重复发送" }]);
    await finishWithNote(context, list.list!.id, 1, "在测试环境重试 50 次，未再出现重复消息。");
    await context.run();
    const suggestion = (await context.view()).suggestions.find((view) => view.type === "experience")!;
    await context.service.decide({ id: suggestion.id, expectedRevision: suggestion.revision, expectedEvidenceVersion: suggestion.evidenceVersion, action: "adopt" });
    const key = `todo_item:${list.list!.id}#1`;
    const preview = await context.service.previewForget({ key });
    expect(preview.experiences).toHaveLength(1);
    expect(preview.suggestions).toBe(1);
    expect((await context.service.forget({ key, confirm: true, expectedPreviewHash: "0".repeat(64) })).status).toBe("preview_changed");
    expect((await context.service.forget({ key, confirm: true, expectedPreviewHash: preview.previewHash })).status).toBe("done");
    expect((await context.experiences.scan()).experiences).toHaveLength(0);
    const raw = await readFile(context.storePath, "utf8");
    expect(raw).not.toContain("重试 50 次");
    expect(context.deletedTraces.length).toBeGreaterThan(0);
  });
});

describe("organization: adopted experiences in search", () => {
  it("are found only when named, as what they are; a candidate or a pending note never", async () => {
    const context = await setup({ answers: { experience: experienceAnswer } });
    const list = await context.record([{ title: "修复重复发送" }, { title: "另一条" }]);
    await finishWithNote(context, list.list!.id, 1, "在测试环境重试 50 次，未再出现重复消息。");
    await finishWithNote(context, list.list!.id, 2, "改了配置，在预发环境确认过两次没有问题。");
    await context.run();
    const decisions = { search: async () => ({ contextVersion: DECISION_CONTEXT_VERSION, status: "empty" as const, coverage: "complete" as const, sources: [], results: [], total: 0, nextOffset: null, guidance: "", boundary: { advisoryOnly: true as const, noDecisionWritten: true as const, noPrincipleApplied: true as const } }) };
    const search = new ContextSearch(decisions, undefined, undefined, undefined, context.experiences);
    // Candidates only: nothing to find.
    expect((await search.search({ source: "experiences", query: "" } as never)).results).toHaveLength(0);
    const [first] = (await context.view()).suggestions.filter((view) => view.type === "experience");
    await context.service.decide({ id: first!.id, expectedRevision: first!.revision, expectedEvidenceVersion: first!.evidenceVersion, action: "adopt" });
    const found = await search.search({ source: "experiences", query: "" } as never);
    expect(found.results).toHaveLength(1);
    expect(found.results[0]).toMatchObject({ kind: "experience", source: "experiences" });
    expect(found.results[0]!.warnings).toContain("Agent 报告，未独立核验。");
    expect(found.results[0]!.experience).toMatchObject({ verification: "agent_reported_unverified" });
    // Not among the decision sources a search reads when none is named.
    expect((await search.search({ query: "" } as never)).results.every((result) => result.kind !== "experience")).toBe(true);
  });
});

describe("organization: records let go of outside the panel", () => {
  it("clears what was derived for an adopted experience whose note the reader deleted, and nothing for one not read", async () => {
    const context = await setup({ answers: { experience: experienceAnswer } });
    const list = await context.record([{ title: "修复重复发送" }]);
    await finishWithNote(context, list.list!.id, 1, "在测试环境重试 50 次，未再出现重复消息。");
    await context.run();
    const suggestion = (await context.view()).suggestions.find((view) => view.type === "experience")!;
    await context.service.decide({ id: suggestion.id, expectedRevision: suggestion.revision, expectedEvidenceVersion: suggestion.evidenceVersion, action: "adopt" });
    const note = (await context.experiences.scan()).experiences[0]!;
    await writeFile(note.path, "---\nbroken: [\n---\n");
    await context.view();
    // Unreadable is not deleted: the card keeps its text.
    expect(await readFile(context.storePath, "utf8")).toContain("重试 50 次");
    await import("node:fs/promises").then((fs) => fs.unlink(note.path));
    await context.view();
    const raw = await readFile(context.storePath, "utf8");
    expect(raw).not.toContain("重试 50 次");
    expect(context.deletedTraces.length).toBeGreaterThan(0);
  });

  it("takes a withdrawn preference for a changed source, never a deleted one", async () => {
    const context = await setup();
    const sources = await import("../src/main/organization-sources.js");
    const entry = { kind: "preference", id: "P-1", title: "去重放网关", content: "服务端按消息 ID 去重", knowledgeStatus: "active", project: "消息服务", sourceForm: "user_original", appliesWhen: null, exceptions: null, updatedAt: "2026-11-01T00:00:00.000Z" } as unknown as JournalEntry;
    const read = (withdrawn: boolean) => sources.readSources({
      todos: async () => ({ lists: [], diagnostics: [] }),
      journal: async () => ({ entries: [entry], diagnostics: [] }),
      decisions: async () => ({ documents: [], sources: [] }),
      amendments: async () => ({ records: new Map(withdrawn ? [["preferences:P-1", { withdrawn: { at: "2026-11-02T00:00:00.000Z", client: "manual", reason: "不再适用" }, revision: 1, overrides: null, amendments: [], history: [] } as unknown as StoredAmendment]] : []), unavailable: false }),
      experiences: async () => ({ experiences: [], diagnostics: [] }),
      relative: (path) => path,
    }, context.clock.now);
    const active = (await read(false)).units.get("preference:P-1")!;
    const withdrawn = (await read(true)).units.get("preference:P-1")!;
    expect(withdrawn).toBeDefined();
    expect(withdrawn.inactive).toBe(true);
    expect(withdrawn.evidenceFingerprint).not.toBe(active.evidenceFingerprint);
  });
});

describe("organization: background", () => {
  it("finds new records itself the first time it is on, runs only while idle, and gives way to the foreground", async () => {
    const context = await setup({ answers: { experience: experienceAnswer } });
    const list = await context.record([{ title: "修复重复发送" }]);
    await finishWithNote(context, list.list!.id, 1, "在测试环境重试 50 次，未再出现重复消息。");
    await context.service.setSettings({ background: true, backgroundProfileId: "cloud-a" });
    await context.service.checkBackground();
    expect(context.fake.calls).toHaveLength(0);
    context.idle.seconds = 600;
    context.fake.control.hold = true;
    const checking = context.service.checkBackground();
    while (context.fake.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    context.service.noteForeground();
    await checking;
    await context.service.settled();
    const paused = await context.view();
    expect(paused.run?.state).toBe("paused");
    expect(paused.run?.trigger).toBe("background");
    expect(paused.counts.memory).toBe(0);
  });
});

describe("organization: review findings (Astra)", () => {
  const decisionDoc = (id: string, summary: string, project = "消息服务") => ({
    source: "decisions" as const, kind: "recorded_decision" as const, id, title: `决策 ${id}`, project, status: "active", created: "2026-10-01T00:00:00.000Z",
    summary, appliesWhen: null, caution: null, tags: [], supersedes: [], supersededBy: [], relativePath: `Decision Journal/decisions/${id}.md`,
    client: null, sessionId: null, body: summary, bodyStartLine: 1, contentHash: id.padEnd(64, "0").slice(0, 64).replace(/[^a-f0-9]/gu, "a"),
  });
  const conflictAnswer = { pairs: [{ a: "K1", b: "K2", relation: "scope_differs", topic: "去重放在哪一层", conditionA: "客户端自动重试", conditionB: "网关多端同步", scopeA: "客户端模块 · 自动重试", scopeB: "网关模块 · 多端同步" }] };

  it("never writes back what a run read from a source forgotten while its call was out, and deletes that call's record", async () => {
    const context = await setup({ answers: { experience: experienceAnswer } });
    const list = await context.record([{ title: "修复重复发送" }]);
    await finishWithNote(context, list.list!.id, 1, "在测试环境重试 50 次，未再出现重复消息。");
    context.fake.control.hold = true;
    await context.service.run({ scope: "project", project: "消息服务", profileId: "cloud-a" });
    while (context.fake.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const key = `todo_item:${list.list!.id}#1`;
    const preview = await context.service.previewForget({ key });
    expect(preview.modelCalls).toBe(1);
    expect((await context.service.forget({ key, confirm: true, expectedPreviewHash: preview.previewHash })).status).toBe("done");
    context.fake.control.hold = false;
    await context.service.settled();
    const raw = await readFile(context.storePath, "utf8");
    expect(raw).not.toContain("重试 50 次");
    expect(context.deletedTraces.some((id) => id.startsWith("organization:"))).toBe(true);
    expect((await context.view()).counts.memory).toBe(0);
  });

  it("deletes the record of a call that made no suggestion when its source is forgotten", async () => {
    const context = await setup({ answers: { experience: { hasObservation: false } } });
    const list = await context.record([{ title: "修复重复发送" }]);
    await finishWithNote(context, list.list!.id, 1, "在测试环境重试 50 次，未再出现重复消息。");
    await context.run();
    expect((await context.view()).counts.memory).toBe(0);
    const key = `todo_item:${list.list!.id}#1`;
    const preview = await context.service.previewForget({ key });
    expect(preview.modelCalls).toBe(1);
    await context.service.forget({ key, confirm: true, expectedPreviewHash: preview.previewHash });
    expect(context.deletedTraces).toHaveLength(1);
  });

  it("takes a later addition (a counter-example) for changed substance, not a rebase, and gives it to the model", async () => {
    const context = await setup({ answers: { conflict: conflictAnswer } });
    context.decisions.documents.push(decisionDoc("dec-a", "在客户端用幂等键去重"), decisionDoc("dec-b", "在服务端按消息 ID 去重，客户端不处理"));
    await context.run();
    const conflict = (await context.view()).suggestions.find((view) => view.type === "conflict")!;
    expect(conflict.canAdopt).toBe(true);
    context.amendments.records.set("decisions:dec-a", { amendVersion: 1, source: "decisions", recordId: "dec-a", revision: 1, updatedAt: "2026-11-11T03:00:00.000Z",
      amendments: [{ n: 1, at: "2026-11-11T03:00:00.000Z", client: "manual", text: "补充：多设备同步时客户端去重无效。", basis: "user_said", reason: null }],
      overrides: null, withdrawn: null, history: [] } as never);
    const after = (await context.view()).suggestions.find((view) => view.id === conflict.id)!;
    expect(after.stale?.reason).toBe("source_changed");
    expect(after.canAdopt).toBe(false);
    await context.run();
    expect(context.fake.calls.at(-1)!.prompt).toContain("多设备同步时客户端去重无效");
  });

  it("voids a suggestion whose source moved to another project", async () => {
    const context = await setup({ answers: { conflict: conflictAnswer } });
    context.decisions.documents.push(decisionDoc("dec-a", "在客户端用幂等键去重"), decisionDoc("dec-b", "在服务端按消息 ID 去重，客户端不处理"));
    await context.run();
    const conflict = (await context.view()).suggestions.find((view) => view.type === "conflict")!;
    context.decisions.documents[0] = { ...context.decisions.documents[0]!, project: "别的项目" };
    expect((await context.view()).suggestions.some((view) => view.id === conflict.id)).toBe(false);
    const answer = await context.service.decide({ id: conflict.id, expectedRevision: conflict.revision, expectedEvidenceVersion: conflict.evidenceVersion, action: "adopt", choice: "keep_scopes" });
    expect(answer.status).not.toBe("saved");
    expect(context.amendmentCalls).toHaveLength(0);
  });

  it("does not take a record whose additions could not be read for current: nothing resting on it is adopted", async () => {
    const context = await setup({ answers: { conflict: conflictAnswer } });
    context.decisions.documents.push(decisionDoc("dec-a", "在客户端用幂等键去重"), decisionDoc("dec-b", "在服务端按消息 ID 去重，客户端不处理"));
    await context.run();
    const conflict = (await context.view()).suggestions.find((view) => view.type === "conflict")!;
    context.amendments.unavailable = true;
    const frozen = (await context.view()).suggestions.find((view) => view.id === conflict.id)!;
    expect(frozen.stale?.reason).toBe("source_unreadable");
    const answer = await context.service.decide({ id: conflict.id, expectedRevision: conflict.revision, expectedEvidenceVersion: conflict.evidenceVersion, action: "adopt", choice: "keep_scopes" });
    expect(answer.status).toBe("source_unavailable");
    expect(context.amendmentCalls).toHaveLength(0);
  });

  it("puts a supersedes relation back whole, its successor included, when the adoption is undone", async () => {
    const context = await setup({ answers: { conflict: conflictAnswer } });
    const [a, b] = [decisionDoc("dec-a", "在客户端用幂等键去重"), decisionDoc("dec-b", "在服务端按消息 ID 去重，客户端不处理")];
    context.decisions.documents.push(a, b);
    context.decisions.relations = [{ relationVersion: 1, first: { source: "decisions", recordId: "dec-a", contentHash: a.contentHash }, second: { source: "decisions", recordId: "dec-b", contentHash: b.contentHash },
      disposition: "supersedes", successor: "second", reason: "用户确认 B 替代 A", revision: 3, updatedAt: "2026-11-01T00:00:00.000Z", history: [] } as never];
    await context.run();
    const conflict = (await context.view()).suggestions.find((view) => view.type === "conflict")!;
    expect((await context.service.decide({ id: conflict.id, expectedRevision: conflict.revision, expectedEvidenceVersion: conflict.evidenceVersion, action: "adopt", choice: "keep_scopes" })).status).toBe("saved");
    expect(context.relationCalls.at(-1)).toMatchObject({ disposition: "unrelated", expectedRevision: 3 });
    const applied = (await context.view()).suggestions.find((view) => view.id === conflict.id)!;
    context.amendmentCalls.length = 0;
    const undone = await context.service.undo({ id: conflict.id, expectedRevision: applied.revision });
    expect(undone.status).toBe("saved");
    expect(context.relationCalls.at(-1)).toMatchObject({ disposition: "supersedes", successor: "second", first: { recordId: "dec-a" }, second: { recordId: "dec-b" }, expectedRevision: 4 });
  });
});

describe("organization: what the model is given is whole", () => {
  it("gives the model a long exception whole, its last line included", async () => {
    const context = await setup({ answers: { conflict: { pairs: [] } } });
    const exceptions = `${"适用范围说明：去重只在客户端完成，覆盖弱网重试的各种情形，".repeat(20)}仅测试环境，禁止生产。`;
    expect(exceptions.indexOf("仅测试环境")).toBeGreaterThan(400);
    context.journal.push({ kind: "preference", id: "P-1", title: "客户端去重", content: "客户端按幂等键去重重复消息", knowledgeStatus: "active", project: "消息服务", sourceForm: "user_original",
      appliesWhen: "客户端自动重试", exceptions, updatedAt: "2026-11-01T00:00:00.000Z" } as unknown as JournalEntry);
    context.journal.push({ kind: "preference", id: "P-2", title: "服务端去重", content: "服务端按消息 ID 去重重复消息，客户端不去重", knowledgeStatus: "active", project: "消息服务", sourceForm: "user_original",
      appliesWhen: null, exceptions: null, updatedAt: "2026-11-02T00:00:00.000Z" } as unknown as JournalEntry);
    await context.run();
    const conflictCalls = context.fake.calls.filter((call) => call.kind === "conflict");
    expect(conflictCalls.length).toBeGreaterThan(0);
    expect(conflictCalls.every((call) => call.prompt.includes("仅测试环境，禁止生产。"))).toBe(true);
  });

  it("waits with a source too long for one call, saying coverage, rather than cut it and judge", async () => {
    const context = await setup({ answers: { experience: experienceAnswer }, promptChars: 1_500 });
    const list = await context.record([{ title: "修复重复发送", detail: `${"背景说明，".repeat(300)}唯一例外：仅测试环境验证过。` }]);
    await finishWithNote(context, list.list!.id, 1, "在测试环境重试 50 次，未再出现重复消息。");
    await context.run();
    const first = await context.view();
    expect(context.fake.calls.filter((call) => call.kind === "experience")).toHaveLength(0);
    expect(first.run?.state).toBe("partial");
    expect(first.run?.partialReason).toBe("coverage");
    // Still queued: a call that holds it whole takes it up.
    const roomy = context.make({ promptChars: 8_000 });
    await context.run(roomy);
    const experienceCalls = context.fake.calls.filter((call) => call.kind === "experience");
    expect(experienceCalls).toHaveLength(1);
    expect(experienceCalls[0]!.prompt).toContain("唯一例外：仅测试环境验证过。");
  });
});

describe("organization: an adoption cut short by a quit", () => {
  it("finishes on the next start a step left writing whose target was not written, and makes the note active", async () => {
    const context = await setup({ answers: { experience: experienceAnswer } });
    const list = await context.record([{ title: "修复重复发送" }]);
    await finishWithNote(context, list.list!.id, 1, "在测试环境重试 50 次，未再出现重复消息。");
    await context.run();
    const suggestion = (await context.view()).suggestions.find((view) => view.type === "experience")!;
    await context.service.decide({ id: suggestion.id, expectedRevision: suggestion.revision, expectedEvidenceVersion: suggestion.evidenceVersion, action: "adopt" });
    // As if the app had quit with the plan written and the note's write under way, before it reached the disk.
    const note = (await context.experiences.scan()).experiences[0]!;
    await import("node:fs/promises").then((fs) => fs.unlink(note.path));
    const state = JSON.parse(await readFile(context.storePath, "utf8"));
    const stored = state.suggestions[suggestion.id];
    stored.state = "applying";
    stored.apply.phase = "writing";
    stored.apply.steps = stored.apply.steps.map((step: { kind: string }) => ({ ...step, state: step.kind === "experience_create" ? "writing" : "planned", result: undefined }));
    await writeFile(context.storePath, JSON.stringify(state));
    const restarted = context.make();
    await restarted.recover();
    const after = (await restarted.snapshot({ scope: "project", project: "消息服务" })).suggestions.find((view) => view.id === suggestion.id)!;
    expect(after.state).toBe("applied");
    const notes = (await context.experiences.scan()).experiences;
    expect(notes).toHaveLength(1);
    expect(notes[0]!.record.status).toBe("active");
  });
});

describe("organization: writes made on the version checked, never on a later one (Astra)", () => {
  const adopted = async () => {
    const context = await setup({ answers: { experience: experienceAnswer } });
    const list = await context.record([{ title: "修复重复发送" }]);
    await finishWithNote(context, list.list!.id, 1, "在测试环境重试 50 次，未再出现重复消息。");
    await context.run();
    const suggestion = (await context.view()).suggestions.find((view) => view.type === "experience")!;
    await context.service.decide({ id: suggestion.id, expectedRevision: suggestion.revision, expectedEvidenceVersion: suggestion.evidenceVersion, action: "adopt" });
    const note = (await context.experiences.scan()).experiences[0]!;
    return { context, suggestion, note, key: `todo_item:${list.list!.id}#1` };
  };
  const edit = (path: string) => async () => { await writeFile(path, `${await readFile(path, "utf8")}\n读者在核对之后加的一行\n`); };

  it("does not delete an experience edited after the undo checked it", async () => {
    const { context, suggestion, note } = await adopted();
    const applied = (await context.view()).suggestions.find((view) => view.id === suggestion.id)!;
    context.hooks.afterFind = edit(note.path);
    const undone = await context.service.undo({ id: suggestion.id, expectedRevision: applied.revision });
    expect(undone.status).not.toBe("saved");
    expect(await readFile(note.path, "utf8")).toContain("读者在核对之后加的一行");
  });

  it("does not make active, on the next start, a pending note changed to say something else", async () => {
    const { context, suggestion, note } = await adopted();
    // Pending again, with another observation, as an edit in Obsidian left it while the app was down mid-adoption.
    await writeFile(note.path, (await readFile(note.path, "utf8")).replace("status: active", "status: pending").replace("已验证，完全修好了", "其实还有 2 次重复"));
    const state = JSON.parse(await readFile(context.storePath, "utf8"));
    const stored = state.suggestions[suggestion.id];
    stored.state = "applying";
    stored.apply.phase = "writing";
    stored.apply.steps = stored.apply.steps.map((step: { kind: string }) => ({ ...step, state: step.kind === "experience_create" ? "writing" : "planned", result: undefined }));
    await writeFile(context.storePath, JSON.stringify(state));
    const restarted = context.make();
    await restarted.recover();
    const after = (await restarted.snapshot({ scope: "project", project: "消息服务" })).suggestions.find((view) => view.id === suggestion.id)!;
    expect(after.state).toBe("partially_applied");
    const now = (await context.experiences.scan()).experiences[0]!;
    expect(now.record.status).toBe("pending");
    expect(now.record.body.observation).toContain("其实还有 2 次重复");
  });

  it("keeps a call record to delete until it is deleted: a failed delete is found and done again", async () => {
    const context = await setup({ answers: { experience: { hasObservation: false } } });
    const list = await context.record([{ title: "修复重复发送" }]);
    await finishWithNote(context, list.list!.id, 1, "在测试环境重试 50 次，未再出现重复消息。");
    await context.run();
    const key = `todo_item:${list.list!.id}#1`;
    context.hooks.failTraceDelete = true;
    const first = await context.service.previewForget({ key });
    expect((await context.service.forget({ key, confirm: true, expectedPreviewHash: first.previewHash })).status).toBe("partial");
    const again = await context.service.previewForget({ key });
    expect(again.modelCalls).toBe(1);
    expect((await context.service.forget({ key, confirm: true, expectedPreviewHash: again.previewHash })).status).toBe("done");
    expect(context.deletedTraces).toHaveLength(1);
    expect((await context.service.previewForget({ key })).modelCalls).toBe(0);
  });

  it("does not delete an experience edited after the forget's preview was checked", async () => {
    const { context, note, key } = await adopted();
    const preview = await context.service.previewForget({ key });
    // Changed after the confirm's own check of the preview, before the delete.
    let scans = 0;
    const realScan = context.hooks;
    realScan.afterScan = async () => { scans += 1; await edit(note.path)(); };
    const result = await context.service.forget({ key, confirm: true, expectedPreviewHash: preview.previewHash });
    expect(scans).toBe(1);
    expect(result.status).toBe("partial");
    expect(await readFile(note.path, "utf8")).toContain("读者在核对之后加的一行");
  });
});

describe("organization: in-flight work and what it may publish (Astra, round 2)", () => {
  const gate = () => {
    let entered!: () => void; let release!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const open = new Promise<void>((resolve) => { release = resolve; });
    return { inside, release, hook: async () => { entered(); await open; } };
  };
  const decisionDoc = (id: string, summary: string) => ({
    source: "decisions" as const, kind: "recorded_decision" as const, id, title: `决策 ${id}`, project: "消息服务", status: "active", created: "2026-10-01T00:00:00.000Z",
    summary, appliesWhen: null, caution: null, tags: [], supersedes: [], supersededBy: [], relativePath: `Decision Journal/decisions/${id}.md`,
    client: null, sessionId: null, body: summary, bodyStartLine: 1, contentHash: id.padEnd(64, "0").slice(0, 64).replace(/[^a-f0-9]/gu, "a"),
  });
  const conflictAnswer = { pairs: [{ a: "K1", b: "K2", relation: "scope_differs", topic: "去重放在哪一层", conditionA: "客户端", conditionB: "网关", scopeA: "客户端模块 · 自动重试", scopeB: "网关模块 · 多端同步" }] };

  it("lets a forget wait for an adoption under way, then takes what it wrote: nothing forgotten is left published", async () => {
    const context = await setup({ answers: { experience: experienceAnswer } });
    const list = await context.record([{ title: "修复重复发送" }]);
    await finishWithNote(context, list.list!.id, 1, "在测试环境重试 50 次，未再出现重复消息。");
    await context.run();
    const suggestion = (await context.view()).suggestions.find((view) => view.type === "experience")!;
    const key = `todo_item:${list.list!.id}#1`;
    const paused = gate();
    context.hooks.beforeCreate = paused.hook;
    const adopting = context.service.decide({ id: suggestion.id, expectedRevision: suggestion.revision, expectedEvidenceVersion: suggestion.evidenceVersion, action: "adopt" });
    await paused.inside;
    const preview = await context.service.previewForget({ key });
    expect(preview.experiences).toHaveLength(0);
    const forgetting = context.service.forget({ key, confirm: true, expectedPreviewHash: preview.previewHash });
    paused.release();
    await adopting;
    // The adoption wrote a note the preview never showed: this forget does nothing, and says so.
    expect((await forgetting).status).toBe("preview_changed");
    const again = await context.service.previewForget({ key });
    expect(again.experiences).toHaveLength(1);
    expect((await context.service.forget({ key, confirm: true, expectedPreviewHash: again.previewHash })).status).toBe("done");
    expect((await context.experiences.scan()).experiences).toHaveLength(0);
  });

  it("does not make an experience visible whose source was deleted while it was being written", async () => {
    const context = await setup({ answers: { experience: experienceAnswer } });
    const list = await context.record([{ title: "修复重复发送" }, { title: "另一项" }]);
    await finishWithNote(context, list.list!.id, 1, "在测试环境重试 50 次，未再出现重复消息。");
    await context.run();
    const suggestion = (await context.view()).suggestions.find((view) => view.type === "experience")!;
    const paused = gate();
    context.hooks.beforeCreate = paused.hook;
    const adopting = context.service.decide({ id: suggestion.id, expectedRevision: suggestion.revision, expectedEvidenceVersion: suggestion.evidenceVersion, action: "adopt" });
    await paused.inside;
    await context.todos.deleteItems({ listId: list.list!.id, items: [{ item: 1, expectedStatus: "done" }] } as never);
    paused.release();
    expect((await adopting).status).toBe("partially_applied");
    expect((await context.experiences.scan()).experiences.every((stored) => stored.record.status !== "active")).toBe(true);
  });

  it("does not take a decision whose scope could not be read for current", async () => {
    const context = await setup({ answers: { conflict: conflictAnswer } });
    context.decisions.documents.push(decisionDoc("dec-a", "在客户端用幂等键去重"), decisionDoc("dec-b", "在服务端按消息 ID 去重，客户端不处理"));
    await context.run();
    const conflict = (await context.view()).suggestions.find((view) => view.type === "conflict")!;
    context.decisions.documents[0] = { ...context.decisions.documents[0]!, scopeState: "unavailable" };
    expect((await context.view()).suggestions.find((view) => view.id === conflict.id)!.stale?.reason).toBe("source_unreadable");
    expect((await context.service.decide({ id: conflict.id, expectedRevision: conflict.revision, expectedEvidenceVersion: conflict.evidenceVersion, action: "adopt", choice: "keep_scopes" })).status).toBe("source_unavailable");
  });

  it("does not report an adoption done when what it rests on became unreadable while it was written", async () => {
    const context = await setup({ answers: { conflict: conflictAnswer } });
    context.decisions.documents.push(decisionDoc("dec-a", "在客户端用幂等键去重"), decisionDoc("dec-b", "在服务端按消息 ID 去重，客户端不处理"));
    await context.run();
    const conflict = (await context.view()).suggestions.find((view) => view.type === "conflict")!;
    context.hooks.afterAmend = () => { context.amendments.unavailable = true; };
    const answer = await context.service.decide({ id: conflict.id, expectedRevision: conflict.revision, expectedEvidenceVersion: conflict.evidenceVersion, action: "adopt", choice: "keep_scopes" });
    expect(answer.status).toBe("partially_applied");
  });

  it("takes a 「开始前要看」 link away with the record it names, deleted", async () => {
    const context = await setup({ answers: { todo: { groups: [], acceptance: [], links: [{ ref: "T1", record: "K1", whyRelevant: "去重方式相关", scopeNote: "仅客户端" }] } } });
    context.journal.push({ kind: "preference", id: "P-1", title: "消息重复发送在客户端去重", content: "客户端按幂等键去重重复发送的消息", knowledgeStatus: "active", project: "消息服务", sourceForm: "user_original",
      appliesWhen: null, exceptions: null, updatedAt: "2026-11-01T00:00:00.000Z" } as unknown as JournalEntry);
    const list = await context.record([{ title: "修复消息重复发送" }]);
    await context.run();
    const link = (await context.view()).suggestions.find((view) => view.type === "todo_context")!;
    expect((await context.service.decide({ id: link.id, expectedRevision: link.revision, expectedEvidenceVersion: link.evidenceVersion, action: "adopt" })).status).toBe("saved");
    expect(Object.values((await context.service.annotations({ listIds: [list.list!.id] })).beforeStart).flat()).toHaveLength(1);
    context.journal.splice(0, 1);
    await context.view();
    const after = await context.service.annotations({ listIds: [list.list!.id] });
    expect(JSON.stringify(after)).not.toContain("去重方式相关");
    expect(await readFile(context.storePath, "utf8")).not.toContain("去重方式相关");
  });
});

describe("organization: background gives way to the reader's own input", () => {
  it("stops within a second once the system is no longer idle, and writes nothing late", async () => {
    const context = await setup({ answers: { experience: experienceAnswer } });
    const list = await context.record([{ title: "修复重复发送" }]);
    await finishWithNote(context, list.list!.id, 1, "在测试环境重试 50 次，未再出现重复消息。");
    await context.service.setSettings({ background: true, backgroundProfileId: "cloud-a" });
    context.idle.seconds = 600;
    context.fake.control.hold = true;
    const checking = context.service.checkBackground();
    while (context.fake.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    context.idle.seconds = 0;
    await checking;
    await context.service.settled();
    const view = await context.view();
    expect(view.run?.state).toBe("paused");
    expect(view.counts.memory).toBe(0);
  }, 10_000);
});

describe("organization: new evidence on what was already adopted", () => {
  it("offers a correction to an adopted experience for review, the adopted note left as it is until then", async () => {
    const context = await setup({ answers: { experience: experienceAnswer } });
    const list = await context.record([{ title: "修复重复发送" }]);
    const listId = list.list!.id;
    await finishWithNote(context, listId, 1, "在测试环境重试 50 次，未再出现重复消息。");
    await context.run();
    const first = (await context.view()).suggestions.find((view) => view.type === "experience")!;
    expect((await context.service.decide({ id: first.id, expectedRevision: first.revision, expectedEvidenceVersion: first.evidenceVersion, action: "adopt" })).status).toBe("saved");
    const adopted = (await context.experiences.scan()).experiences[0]!;
    await context.todos.updateItem({ todoVersion: TODO_VERSION, listId, item: 1, note: "更正：Wi-Fi 切换时仍复现过一次重复。", sourceClient: "codex" } as never);
    await context.run();
    const snapshot = await context.view();
    const revision = snapshot.suggestions.find((view) => view.type === "experience" && view.state === "pending")!;
    expect(revision).toBeDefined();
    expect(revision.id).not.toBe(first.id);
    expect(revision.reopenReason).toContain("修订已采纳的");
    expect(revision.effect).toContain("旧版");
    expect(revision.unchanged).toContain("回退");
    expect(revision.canAdopt).toBe(true);
    // Organized again on the same correction: still the one card.
    await context.run();
    expect((await context.view()).suggestions.filter((view) => view.type === "experience" && view.state === "pending").map((view) => view.id)).toEqual([revision.id]);
    // Nothing written to the adopted note before the reader decides.
    const untouched = (await context.experiences.scan()).experiences;
    expect(untouched).toHaveLength(1);
    expect(untouched[0]!.noteHash).toBe(adopted.noteHash);
    // Adopted: the new understanding active, the earlier one archived, not deleted; the undo puts it back.
    expect((await context.service.decide({ id: revision.id, expectedRevision: revision.revision, expectedEvidenceVersion: revision.evidenceVersion, action: "adopt" })).status).toBe("saved");
    const after = (await context.experiences.scan()).experiences;
    expect(after.map((stored) => [stored.record.id === adopted.record.id ? "earlier" : "revised", stored.record.status]).sort()).toEqual([["earlier", "archived"], ["revised", "active"]]);
    const applied = (await context.view()).suggestions.find((view) => view.id === revision.id)!;
    expect((await context.service.undo({ id: revision.id, expectedRevision: applied.revision })).status).toBe("saved");
    const undone = (await context.experiences.scan()).experiences;
    expect(undone.map((stored) => [stored.record.id, stored.record.status])).toEqual([[adopted.record.id, "active"]]);
    // The same correction again: no second card.
    await context.run();
    expect((await context.view()).suggestions.filter((view) => view.type === "experience" && view.state === "pending")).toHaveLength(0);
  });

  it("refuses a revision once the adopted note was edited outside, and keeps a rejected one rejected on the same evidence", async () => {
    const context = await setup({ answers: { experience: experienceAnswer } });
    const list = await context.record([{ title: "修复重复发送" }]);
    const listId = list.list!.id;
    await finishWithNote(context, listId, 1, "在测试环境重试 50 次，未再出现重复消息。");
    await context.run();
    const first = (await context.view()).suggestions.find((view) => view.type === "experience")!;
    await context.service.decide({ id: first.id, expectedRevision: first.revision, expectedEvidenceVersion: first.evidenceVersion, action: "adopt" });
    await context.todos.updateItem({ todoVersion: TODO_VERSION, listId, item: 1, note: "更正：Wi-Fi 切换时仍复现过一次重复。", sourceClient: "codex" } as never);
    await context.run();
    const revision = (await context.view()).suggestions.find((view) => view.type === "experience" && view.state === "pending")!;
    const note = (await context.experiences.scan()).experiences[0]!;
    await writeFile(note.path, `${await readFile(note.path, "utf8")}\n读者的补充\n`);
    const edited = (await readFile(note.path, "utf8"));
    expect((await context.service.decide({ id: revision.id, expectedRevision: revision.revision, expectedEvidenceVersion: revision.evidenceVersion, action: "adopt" })).status).toBe("not_allowed");
    expect((await context.experiences.scan()).experiences).toHaveLength(1);
    expect(await readFile(note.path, "utf8")).toBe(edited);
    await context.service.decide({ id: revision.id, expectedRevision: revision.revision, expectedEvidenceVersion: revision.evidenceVersion, action: "reject" });
    await context.todos.changeItem({ listId, item: 1, expectedStatus: "done", priority: "p1" } as never);
    await context.run();
    expect((await context.view()).suggestions.filter((view) => view.type === "experience" && view.state === "pending")).toHaveLength(0);
  });

  it("offers a new member of an adopted group for review, showing one group once that is adopted", async () => {
    const answer = { todo: { groups: [{ title: "消息重复发送", members: [{ ref: "T1", difference: "修复" }, { ref: "T2", difference: "调研" }] }], acceptance: [], links: [] } };
    const context = await setup({ answers: answer });
    const list = await context.record([{ title: "修复客户端消息重复发送问题" }, { title: "调研消息重复发送的幂等方案" }]);
    const listId = list.list!.id;
    await context.run();
    const group = (await context.view()).suggestions.find((view) => view.type === "todo_group")!;
    await context.service.decide({ id: group.id, expectedRevision: group.revision, expectedEvidenceVersion: group.evidenceVersion, action: "adopt" });
    const more = await context.record([{ title: "排查消息重复发送的服务端去重" }], "消息服务排查");
    answer.todo.groups[0]!.members.push({ ref: "T3", difference: "服务端" });
    await context.run();
    const revision = (await context.view()).suggestions.find((view) => view.type === "todo_group" && view.state === "pending")!;
    expect(revision.reopenReason).toContain("修订已采纳的");
    expect(revision.sources.map((source) => source.key)).toContain(`todo_item:${more.list!.id}#1`);
    expect((await context.service.annotations({ listIds: [listId] })).groups.map((entry) => entry.suggestionId)).toEqual([group.id]);
    await context.service.decide({ id: revision.id, expectedRevision: revision.revision, expectedEvidenceVersion: revision.evidenceVersion, action: "adopt" });
    const shown = (await context.service.annotations({ listIds: [listId] })).groups;
    expect(shown.map((entry) => [entry.suggestionId, entry.members.length])).toEqual([[revision.id, 3]]);
  });
});

describe("organization: the prompt's aliases stay in the prompt", () => {
  it("says the item a model's T1 stands for, by its title", async () => {
    const context = await setup({ answers: { todo: { groups: [{ title: "消息重复发送", members: [{ ref: "T1", difference: "T1 是修复，T2 是调研" }, { ref: "T2", difference: "同上" }] }], acceptance: [{ ref: "T1", missing: "和 T2 的分工", draftDetail: "完成标准：T1 弱网下重试 50 次无重复。" }], links: [] } } });
    await context.record([{ title: "修复客户端消息重复发送问题" }, { title: "调研消息重复发送的幂等方案" }]);
    await context.run();
    const shown = JSON.stringify((await context.view()).suggestions.map((view) => view.content));
    expect(shown).not.toMatch(/(?<![A-Za-z0-9])T\d/u);
    expect(shown).toContain("「修复客户端消息重复发送问题」是修复，「调研消息重复发送的幂等方案」是调研");
  });
});

describe("organization: an archive of a revised experience cut short by a quit (Astra)", () => {
  // Adopted, revised and the revision adopted; then put back as if the app had quit with the archive written but its
  // receipt not: the step left writing, no result. `edit` changes the earlier note outside, keeping it archived.
  const interrupted = async (edit?: (text: string) => string) => {
    const context = await setup({ answers: { experience: experienceAnswer } });
    const list = await context.record([{ title: "修复重复发送" }]);
    const listId = list.list!.id;
    await finishWithNote(context, listId, 1, "在测试环境重试 50 次，未再出现重复消息。");
    await context.run();
    const first = (await context.view()).suggestions.find((view) => view.type === "experience")!;
    await context.service.decide({ id: first.id, expectedRevision: first.revision, expectedEvidenceVersion: first.evidenceVersion, action: "adopt" });
    const earlier = (await context.experiences.scan()).experiences[0]!;
    const earlierBody = earlier.record.body;
    await context.todos.updateItem({ todoVersion: TODO_VERSION, listId, item: 1, note: "更正：Wi-Fi 切换时仍复现过一次重复。", sourceClient: "codex" } as never);
    await context.run();
    const revision = (await context.view()).suggestions.find((view) => view.type === "experience" && view.state === "pending")!;
    expect((await context.service.decide({ id: revision.id, expectedRevision: revision.revision, expectedEvidenceVersion: revision.evidenceVersion, action: "adopt" })).status).toBe("saved");
    const state = JSON.parse(await readFile(context.storePath, "utf8"));
    const stored = state.suggestions[revision.id];
    stored.state = "applying";
    stored.apply.phase = "writing";
    stored.apply.steps = stored.apply.steps.map((step: { kind: string }) => step.kind === "experience_archive" ? { ...step, state: "writing", result: undefined } : step);
    await writeFile(context.storePath, JSON.stringify(state));
    if (edit !== undefined) await writeFile(earlier.path, edit(await readFile(earlier.path, "utf8")));
    const outside = await readFile(earlier.path, "utf8");
    const restarted = context.make();
    await restarted.recover();
    const view = (await restarted.snapshot({ scope: "project", project: "消息服务" })).suggestions.find((item) => item.id === revision.id)!;
    return { context, restarted, view, earlier, earlierBody, outside };
  };
  const earlierOf = async (context: Awaited<ReturnType<typeof setup>>, id: string) => (await context.experiences.scan()).experiences.find((stored) => stored.record.id === id)!;

  it("takes the archive for written when the note is what it was to leave, the earlier text kept", async () => {
    const { context, view, earlier, earlierBody } = await interrupted();
    expect(view.state).toBe("applied");
    expect(view.steps.find((step) => step.kind === "experience_archive")?.state).toBe("written");
    const now = await earlierOf(context, earlier.record.id);
    expect(now.record.status).toBe("archived");
    expect(now.record.body).toEqual(earlierBody);
  });

  for (const [name, edit] of [
    ["its text edited", (text: string) => text.replace("带上幂等键", "带上幂等键（读者改过）")],
    ["a line of the reader's added", (text: string) => `${text}\n读者额外写的一行\n`],
  ] as const) {
    it(`does not take an archived note with ${name} outside for this write, nor make it active on an undo`, async () => {
      const { context, restarted, view, earlier, outside } = await interrupted(edit);
      expect(view.state).toBe("partially_applied");
      expect(view.steps.find((step) => step.kind === "experience_archive")?.state).toBe("conflict");
      const undone = await restarted.undo({ id: view.id, expectedRevision: view.revision });
      expect(["saved", "partially_applied", "needs_review"]).toContain(undone.status);
      const now = await earlierOf(context, earlier.record.id);
      expect(now.record.status).toBe("archived");
      expect(await readFile(now.path, "utf8")).toBe(outside);
    });
  }
});


describe("自动维护：授权、静默分诊、版本和恢复", () => {
  const enable = (context: Awaited<ReturnType<typeof setup>>, extra = {}) => context.service.setSettings({ automatic: true, background: true, backgroundProfileId: "cloud-a", ...extra });
  it("自动启用经验且可检索，结果仍为 agent 未核验报告；二次运行不循环消费自己的记忆", async () => {
    const c = await setup({ answers: { experience: experienceAnswer } });
    const list = await c.record([{ title: "消息自动重试" }]);
    await finishWithNote(c, list.list!.id, 1, "测试环境重复发送一百次，没有收到重复消息。");
    await enable(c); await c.run();
    const first = await c.view();
    expect(first.counts.pending).toBe(0);
    expect(first.suggestions.find((s) => s.type === "experience")).toMatchObject({ automatic: true, state: "applied" });
    expect((await c.service.searchableExperiences()).experiences[0]?.record).toMatchObject({ status: "active", verification: "agent_reported_unverified" });
    const calls = c.fake.calls.length;
    await c.run(); expect(c.fake.calls).toHaveLength(calls);
    expect((await c.view()).run?.state).toBe("no_change");
  });
  it("缺理由和结果保留为未知/等待，个人范围也能自动运行；不写原始记录", async () => {
    const c = await setup();
    c.pending.push({ kind: "pending_rationale", id: "why", project: null, title: "日志保留 14 天", material: "理由未记录", at: c.clock.now.toISOString() });
    await enable(c); c.idle.seconds = 3600;
    await c.service.checkBackground(); await c.service.settled();
    const view = await c.service.snapshot({ scope: "all", project: null });
    expect(view.counts.pending).toBe(0);
    expect(view.suggestions[0]).toMatchObject({ state: "applied", content: { type: "triage", disposition: "unknown" } });
    expect(c.pending[0]?.material).toBe("理由未记录");
    expect(c.amendmentCalls).toHaveLength(0);
  });
  it("来源关闭后不发送给模型；同名内容不跨项目归组", async () => {
    const c = await setup();
    c.pending.push({ kind: "pending_rationale", id: "a", project: "甲", title: "重试方案", material: "甲项目原文", at: c.clock.now.toISOString() }, { kind: "pending_confirmation", id: "b", project: "乙", title: "重试方案", material: "乙项目原文", at: c.clock.now.toISOString() });
    await enable(c, { sources: ["pending_rationale"] });
    await c.service.run({ scope: "all", project: null, profileId: "cloud-a" }); await c.service.settled();
    expect(c.fake.calls).toHaveLength(1);
    expect(c.fake.calls[0]?.prompt).not.toContain("乙项目原文");
    await enable(c, { sources: ["pending_rationale", "pending_confirmation"] });
    await c.service.run({ scope: "all", project: null, profileId: "cloud-a" }); await c.service.settled();
    for (const call of c.fake.calls) expect(call.prompt.includes("甲项目原文") && call.prompt.includes("乙项目原文")).toBe(false);
  });
  it("回退的自动记忆不会被同一份证据重新生成；临时不可读先暂停召回，恢复后继续", async () => {
    const c = await setup({ answers: { experience: experienceAnswer } });
    const list = await c.record([{ title: "消息重试" }]);
    await finishWithNote(c, list.list!.id, 1, "断网重连后测试 100 次，未发现重复消息。");
    await enable(c); await c.run();
    const memory = (await c.view()).suggestions.find((s) => s.type === "experience")!;
    c.unreadable.todos = true;
    expect((await c.service.searchableExperiences()).experiences).toHaveLength(0);
    expect((await c.experiences.scan()).experiences).toHaveLength(1);
    c.unreadable.todos = false;
    expect((await c.service.searchableExperiences()).experiences).toHaveLength(1);
    await c.service.undo({ id: memory.id, expectedRevision: memory.revision });
    await c.service.regenerate({ id: memory.id, profileId: "cloud-a" }); await c.service.settled();
    expect((await c.experiences.scan()).experiences).toHaveLength(0);
    expect((await c.view()).counts.pending).toBe(0);
  });
  it("纠正保存为新版本，旧版保留；回退新版恢复旧版", async () => {
    const c = await setup({ answers: { experience: experienceAnswer } });
    const list = await c.record([{ title: "弱网验证" }]);
    await finishWithNote(c, list.list!.id, 1, "测试环境自动重试完成 50 次；网络切换未覆盖。");
    await enable(c); await c.run();
    const memory = (await c.view()).suggestions.find((s) => s.type === "experience")!;
    const correction = await c.service.decide({ id: memory.id, expectedRevision: memory.revision, expectedEvidenceVersion: memory.evidenceVersion, action: "adopt", draft: { type: "experience", body: { inference: "仅对自动重试有效，网络切换仍未知。" } } });
    expect(correction.status).toBe("saved");
    const notes = (await c.experiences.scan()).experiences.map((entry) => entry.record);
    expect(notes.filter((entry) => entry.status === "active")).toHaveLength(1);
    expect(notes.find((entry) => entry.status === "active")?.body.inference).toContain("网络切换仍未知");
    expect(notes.find((entry) => entry.status === "archived")?.body.inference).toBe(experienceAnswer.inference);
    expect((await c.service.undo({ id: correction.id, expectedRevision: correction.suggestion!.revision })).status).toBe("saved");
    expect((await c.experiences.scan()).experiences[0]?.record.status).toBe("active");
  });
  it("预算不足时保留尚未处理的来源，不把未调度的记录当作完成", async () => {
    const c = await setup();
    for (let i = 0; i < 7; i += 1) c.pending.push({ kind: "pending_rationale", id: `r${i}`, project: "消息服务", title: `项目事件 ${i}`, material: `未记录理由 ${i}`, at: c.clock.now.toISOString() });
    await enable(c, { maxCalls: 1 }); await c.run();
    const state = await new OrganizationStore(c.storePath).read();
    expect(c.fake.calls).toHaveLength(1);
    expect(state.ledger.queue.length).toBeGreaterThan(0);
    expect(state.runs.at(-1)?.state).toBe("partial");
    await c.run(); expect(c.fake.calls).toHaveLength(2);
  });
  it("首次授权可迁移未编辑的常规候选，保留用户草稿", async () => {
    const c = await setup({ answers: { experience: experienceAnswer } });
    const list = await c.record([{ title: "重复消息验证" }]);
    await finishWithNote(c, list.list!.id, 1, "重试 50 次无重复；网络切换尚未验证。");
    await c.run(); expect((await c.view()).suggestions[0]?.state).toBe("pending");
    await enable(c); await c.run();
    expect((await c.view()).suggestions[0]?.state).toBe("applied");
  });
  it("遗忘决策时追踪待补理由的派生引用，并且同一份材料不会在下轮复活", async () => {
    const c = await setup({ answers: { knowledge: (prompt: string) => ({ memory: /K1（[^\n]*pending_rationale/u.test(prompt) ? { title: "日志保留", scene: "测试项目", observations: [{ ref: "K1", quote: "日志保留 14 天" }], inference: "只知道选择，理由未知", unknowns: "未记录理由" } : null, triage: null, question: null }) } });
    c.pending.push({ kind: "pending_rationale", id: "p1", root: "decision:d1", project: "消息服务", title: "日志保留", material: "日志保留 14 天", at: c.clock.now.toISOString() });
    c.decision("d1", "日志保留 14 天");
    await enable(c); await c.run();
    const preview = await c.service.previewForget({ key: "decision:d1" });
    expect(preview.experiences).toHaveLength(1);
    expect((await c.service.forget({ key: "decision:d1", confirm: true, expectedPreviewHash: preview.previewHash })).status).toBe("done");
    expect((await c.experiences.scan()).experiences).toHaveLength(0);
    const before = c.fake.calls.length; await c.run(); expect(c.fake.calls).toHaveLength(before);
    expect(await readFile(c.storePath, "utf8")).not.toContain("日志保留 14 天");
  });
  for (const mode of ["current", "pruned_calls", "legacy", "notes_only"] as const) it(`RSI-013: 遗忘未引用输入清除派生推断且保留无关笔记 (${mode})`, async () => {
    const secret = "合成未引用信息：演练代号雪鹭";
    const c = await setup({ answers: { knowledge: (prompt: string) => ({
      memory: /K1（[^\n]+）：\n公开缓存策略/u.test(prompt) && prompt.includes(secret)
        ? { title: "缓存维护记忆", scene: "缓存项目", observations: [{ ref: "K1", quote: "公开缓存策略" }], inference: secret, unknowns: "合成数据，未独立核验" } : null,
      triage: null, question: null,
    }) } });
    c.pending.push(
      { kind: "pending_confirmation", id: "public", project: "消息服务", title: "缓存策略", material: "公开缓存策略", at: c.clock.now.toISOString() },
      { kind: "pending_confirmation", id: "context", project: "消息服务", title: "缓存策略", material: `缓存策略\n${secret}`, at: c.clock.now.toISOString() },
    );
    await c.service.setSettings({ automatic: true, background: false, backgroundProfileId: "cloud-a" });
    await c.run();
    const notes = (await c.experiences.scan()).experiences;
    expect(notes).toHaveLength(1);
    expect(notes[0]!.record.body.inference).toContain(secret);
    expect(notes[0]!.record.sources.map((source) => source.key)).not.toContain("pending_confirmation:context");
    const independent = { ...notes[0]!.record, id: "independent-public", adoptedFrom: null, inputKeys: ["pending_confirmation:public"], body: { ...notes[0]!.record.body, inference: "仅公开内容的独立记忆" } };
    await c.experiences.create(independent);
    if (mode === "legacy") {
      const state = JSON.parse(await readFile(c.storePath, "utf8")) as OrganizationState;
      for (const suggestion of Object.values(state.suggestions)) delete suggestion.inputKeys;
      await writeFile(c.storePath, JSON.stringify(state));
      const { inputKeys: _inputs, ...legacy } = notes[0]!.record;
      await writeFile(notes[0]!.path, serializeExperience(legacy));
    } else if (mode !== "current") {
      await new OrganizationStore(c.storePath).update((state) => {
        state.ledger.calls = [];
        if (mode === "notes_only") state.suggestions = {};
        return { state, value: null };
      });
    }
    const preview = await c.service.previewForget({ key: "pending_confirmation:context" });
    expect(preview.experiences.map((note) => note.id)).toContain(notes[0]!.record.id);
    expect(preview.experiences.map((note) => note.id)).not.toContain(independent.id);
    expect((await c.service.forget({ key: preview.key, confirm: true, expectedPreviewHash: preview.previewHash })).status).toBe("done");
    expect((await c.experiences.scan()).experiences.map((note) => note.record.id)).toEqual([independent.id]);
    expect(await readFile(c.storePath, "utf8")).not.toContain(secret);
    expect(c.pending).toHaveLength(2);
  });
  it("RSI-013: 建议刷新后保留旧草稿的输入关联", async () => {
    const secret = "合成旧草稿：演练代号雪鹭";
    const c = await setup({ answers: { experience: experienceAnswer } });
    c.decisions.documents.push({ source: "decisions", kind: "recorded_decision", id: "context", title: "消息重复发送", project: "消息服务", status: "active", created: c.clock.now.toISOString(), summary: secret, appliesWhen: null, caution: null, tags: [], supersedes: [], supersededBy: [], relativePath: "context.md", client: null, sessionId: null, body: `消息重复发送 ${secret}`, bodyStartLine: 1, contentHash: "a".repeat(64) });
    const list = await c.record([{ title: "消息重复发送" }]);
    await finishWithNote(c, list.list!.id, 1, "消息重试五十次没有重复消息。");
    await c.run();
    const memory = (await c.view()).suggestions.find((entry) => entry.type === "experience")!;
    expect(memory.sources.map((source) => source.key)).toContain("decision:context");
    await c.service.saveDraft({ id: memory.id, expectedRevision: memory.revision, draft: { type: "experience", body: { inference: secret } } });
    await c.service.setSettings({ automatic: false, background: false, backgroundProfileId: "cloud-a", sources: ["todo_item"] });
    await finishWithNote(c, list.list!.id, 1, "更正：消息重试一百次没有重复消息。");
    await c.run();
    const refreshed = (await new OrganizationStore(c.storePath).read()).suggestions[memory.id]!;
    expect(refreshed.revision).toBeGreaterThan(memory.revision);
    expect(refreshed.draft).toMatchObject({ body: { inference: secret } });
    expect(refreshed.evidence.sources.map((source) => source.key)).not.toContain("decision:context");
    const preview = await c.service.previewForget({ key: "decision:context" });
    expect(preview.suggestions).toBeGreaterThan(0);
    await c.service.forget({ key: preview.key, confirm: true, expectedPreviewHash: preview.previewHash });
    expect(await readFile(c.storePath, "utf8")).not.toContain(secret);
  });
  it("RSI-013: 待办修订回退后旧计划仍受原输入遗忘约束", async () => {
    const secret = "合成旧计划：演练代号雪鹭";
    const todo = { groups: [], acceptance: [{ ref: "T1", missing: "完成标准", draftDetail: secret }], links: [] };
    const c = await setup({ answers: { todo } });
    c.journal.push({ kind: "preference", id: "context", title: "消息重复发送", content: `消息重复发送 ${secret}`, knowledgeStatus: "active", project: "消息服务", sourceForm: "user_original", appliesWhen: null, exceptions: null, updatedAt: c.clock.now.toISOString() } as unknown as JournalEntry);
    const list = await c.record([{ title: "消息重复发送" }]);
    await c.run();
    const suggestion = (await c.view()).suggestions.find((entry) => entry.type === "todo_acceptance")!;
    const adopted = await c.service.decide({ id: suggestion.id, expectedRevision: suggestion.revision, expectedEvidenceVersion: suggestion.evidenceVersion, action: "adopt" });
    expect(adopted.status).toBe("saved");
    expect((await c.service.undo({ id: suggestion.id, expectedRevision: adopted.suggestion!.revision })).status).toBe("saved");
    await c.service.setSettings({ automatic: false, background: false, backgroundProfileId: "cloud-a", sources: ["todo_item"] });
    await c.todos.updateItem({ todoVersion: TODO_VERSION, listId: list.list!.id, item: 1, status: "in_progress", sourceClient: "codex" } as never);
    todo.acceptance[0]!.draftDetail = "新的公开完成标准";
    await c.run();
    const refreshed = (await new OrganizationStore(c.storePath).read()).suggestions[suggestion.id]!;
    expect(refreshed.revision).toBeGreaterThan(suggestion.revision);
    expect(JSON.stringify(refreshed.apply)).toContain(secret);
    const preview = await c.service.previewForget({ key: "preference:context" });
    expect(preview.suggestions).toBeGreaterThan(0);
    await c.service.forget({ key: preview.key, confirm: true, expectedPreviewHash: preview.previewHash });
    expect(await readFile(c.storePath, "utf8")).not.toContain(secret);
  });
  it("RSI-013: 遗忘预览包含受未引用输入影响的开始前关联", async () => {
    const c = await setup({ answers: { todo: { groups: [], acceptance: [], links: [{ ref: "T1", record: "K1", whyRelevant: "去重方式相关", scopeNote: "仅客户端" }] } } });
    for (const id of ["P-1", "P-2"]) c.journal.push({ kind: "preference", id, title: "消息重复发送在客户端去重", content: "客户端按幂等键去重重复发送的消息", knowledgeStatus: "active", project: "消息服务", sourceForm: "user_original", appliesWhen: null, exceptions: null, updatedAt: c.clock.now.toISOString() } as unknown as JournalEntry);
    const list = await c.record([{ title: "修复消息重复发送" }]);
    await c.run();
    const link = (await c.view()).suggestions.find((entry) => entry.type === "todo_context")!;
    const key = ["preference:P-1", "preference:P-2"].find((candidate) => !link.sources.some((source) => source.key === candidate))!;
    expect(key).toBeDefined();
    await c.service.decide({ id: link.id, expectedRevision: link.revision, expectedEvidenceVersion: link.evidenceVersion, action: "adopt" });
    const preview = await c.service.previewForget({ key });
    expect(preview.annotations).toBe(1);
    await c.service.forget({ key, confirm: true, expectedPreviewHash: preview.previewHash });
    expect(Object.values((await c.service.annotations({ listIds: [list.list!.id] })).beforeStart).flat()).toHaveLength(0);
  });
  it("多次自动修订使用定长身份并保留回退链", async () => {
    const c = await setup({ answers: { experience: experienceAnswer } });
    const list = await c.record([{ title: "重复消息验证" }]);
    await enable(c);
    for (let round = 0; round < 4; round += 1) {
      await finishWithNote(c, list.list!.id, 1, `第 ${round} 次测试重试 50 次，结果已更新，网络切换未验证。`);
      await c.run();
    }
    const views = (await c.view()).suggestions.filter((entry) => entry.type === "experience");
    expect(views).toHaveLength(4);
    expect(views.every((entry) => entry.id.length < 45 && entry.id.split("~r").length <= 2)).toBe(true);
    const active = (await c.experiences.scan()).experiences.filter((entry) => entry.record.status === "active");
    expect(active).toHaveLength(1);
    expect((await c.service.undo({ id: views[0]!.id, expectedRevision: views[0]!.revision })).status).toBe("not_allowed");
  });

  it("迁移自动应用也遵守每轮变更上限，不一次写完所有积压", async () => {
    const c = await setup({ answers: { experience: experienceAnswer }, budget: { changes: 1 } });
    const list = await c.record([{ title: "消息重试验证" }, { title: "消息切换验证" }]);
    await finishWithNote(c, list.list!.id, 1, "重试 50 次没有重复消息，结果已记录。");
    await finishWithNote(c, list.list!.id, 2, "切换 50 次没有重复消息，结果已记录。");
    await c.run(); await c.run(); await enable(c); await c.run();
    expect((await c.experiences.scan()).experiences.filter((entry) => entry.record.status === "active")).toHaveLength(1);
    await c.run();
    expect((await c.experiences.scan()).experiences.filter((entry) => entry.record.status === "active")).toHaveLength(2);
  });

  it("自动写入失败如实报告部分完成，保留可重试进度", async () => {
    const c = await setup({ answers: { experience: experienceAnswer } });
    const list = await c.record([{ title: "消息重试验证" }]);
    await finishWithNote(c, list.list!.id, 1, "重试 50 次没有重复消息，结果已记录。");
    await enable(c); c.hooks.beforeCreate = async () => { throw new Error("模拟写入失败"); }; await c.run();
    expect((await c.view()).run).toMatchObject({ state: "partial", failure: { code: "automatic_write_incomplete" } });
    expect((await c.experiences.scan()).experiences).toHaveLength(0);
    await c.run();
    expect((await c.experiences.scan()).experiences.filter((entry) => entry.record.status === "active")).toHaveLength(1);
  });

  it("旧版后台配置不会把新增来源发送给模型，首次配置确认后才纳入", async () => {
    const c = await setup();
    c.pending.push({ kind: "pending_confirmation", id: "new-kind", project: "消息服务", title: "待确认内容", material: "未授权新增来源", at: c.clock.now.toISOString() });
    await c.service.setSettings({ background: true, backgroundProfileId: "cloud-a" });
    await c.run(); c.idle.seconds = 3600; await c.service.checkBackground(); await c.service.settled();
    expect(c.fake.calls).toHaveLength(0);
    await enable(c); await c.run();
    expect(c.fake.calls).toHaveLength(1);
    expect(c.fake.calls[0]?.prompt).toContain("未授权新增来源");
  });

});


describe("RSI-002: unexpected persistence failures", () => {
  class FailingStore extends OrganizationStore {
    armed = true;
    writes = 0;
    constructor(path: string, readonly mode: "early" | "finish" | "application" | "persistent" | "call_ledger" | "plan" | "retry_ledger") { super(path); }
    override update<T>(change: (state: OrganizationState) => { state: OrganizationState | null; value: T }): Promise<T> {
      return super.update((state) => {
        const result = change(state);
        const next = result.state;
        this.writes += 1;
        const failure = this.mode === "early" || this.mode === "persistent" ? this.writes > 1
          : this.mode === "plan" ? next !== null && Object.values(next.suggestions).some((entry) => entry.state === "applying" && entry.apply?.steps.some((step) => step.kind === "experience_create" && step.state === "writing"))
          : this.mode === "retry_ledger" ? (next?.ledger.calls.length ?? 0) > 1
          : this.mode === "call_ledger" ? (next?.ledger.calls.length ?? 0) > 0
          : this.mode === "finish" ? next?.activeRun === null && next.runs.at(-1)?.state === "done"
            : next !== null && Object.values(next.suggestions).some((entry) => entry.state === "applying" && entry.apply?.steps.some((step) => step.kind === "experience_create" && step.state === "written"));
        if (this.armed && failure) { if (this.mode !== "persistent") this.armed = false; throw new Error("synthetic storage write failure"); }
        return result;
      });
    }
  }
  it.each(["plan", "application"] as const)("RSI-12 recovers and undoes a compressed write plan without duplicate work: %s", async mode => {
    const c = await setup({ answers: { experience: experienceAnswer } });
    const list = await c.record([{ title: "发送重试验证" }]);
    await finishWithNote(c, list.list!.id, 1, "重试五十次未重复，网络切换仍未覆盖。");
    await c.service.setSettings({ automatic: true, background: false, backgroundProfileId: "cloud-a" });
    await new OrganizationStore(c.storePath).update(state => { Object.assign(state.suggestions, capacityState(1600).suggestions); return { state, value: null }; });
    await c.run(c.make({ store: new FailingStore(c.storePath, mode) }));
    expect(c.fake.calls).toHaveLength(1);
    const restarted = c.make(); await restarted.recover();
    const memory = (await c.view(restarted)).suggestions.find(entry => entry.type === "experience" && entry.project === "消息服务")!;
    expect(memory.state).toBe("applied");
    expect((await c.experiences.scan()).experiences.filter(entry => entry.record.status === "active")).toHaveLength(1);
    expect(c.fake.calls).toHaveLength(1);
    expect((await restarted.undo({ id: memory.id, expectedRevision: memory.revision })).status).toBe("saved");
    expect((await new OrganizationStore(c.storePath).read()).suggestions[memory.id]!.receipts.at(-1)?.action).toBe("undo");
    expect((await c.experiences.scan()).experiences.filter(entry => entry.record.status === "active")).toHaveLength(0);
  });
  for (const mode of ["early", "finish", "application", "persistent", "call_ledger"] as const) {
    it(`ends a failed run and can resume without duplicate work: ${mode}`, async () => {
      const c = await setup({ answers: { experience: experienceAnswer } });
      const list = await c.record([{ title: "发送重试验证" }]);
      await finishWithNote(c, list.list!.id, 1, "重试 50 次无重复，网络切换仍未覆盖。");
      const store = new FailingStore(c.storePath, mode);
      const service = c.make({ store });
      // Save the setting before arming the run's write failure.
      store.armed = false;
      await service.setSettings({ background: true, backgroundProfileId: "cloud-a", automatic: true });
      store.writes = 0; store.armed = true;
      await c.run(service);
      const failed = await c.view(service);
      expect(failed.activeRun).toBeNull();
      expect(failed.run?.state).toBe("failed");
      expect(failed.run?.failure?.message).toContain("synthetic storage write failure");
      expect((await store.read()).ledger.queue).toHaveLength(1);
      const calls = c.fake.calls.length;
      expect(failed.run?.usage.calls).toBe(calls);
      if (mode === "persistent") {
        const restarted = c.make({ store });
        await restarted.recover();
        expect((await c.view(restarted)).activeRun).toBeNull();
        expect((await c.view(restarted)).run?.state).toBe("failed");
      }
      store.armed = false;
      await c.run(service);
      const notes = (await c.experiences.scan()).experiences;
      expect(notes).toHaveLength(1);
      expect(notes[0]?.record.status).toBe("active");
      expect((await store.read()).ledger.queue).toHaveLength(0);
      expect(c.fake.calls.length).toBe(calls || 1);
    });
  }
  for (const mode of ["plan", "application"] as const) for (const revoked of ["source", "automatic"] as const) {
    it(`does not execute new recovery steps after ${revoked} is revoked (${mode})`, async () => {
      const c = await setup({ answers: { experience: experienceAnswer } });
      const list = await c.record([{ title: "暂停后不应继续的自动记忆" }]);
      await finishWithNote(c, list.list!.id, 1, "合成验证结果：重试五十次没有重复消息。");
      await c.service.setSettings({ automatic: true, background: true, backgroundProfileId: "cloud-a" });
      const store = new FailingStore(c.storePath, mode);
      const service = c.make({ store });
      await c.run(service);
      expect((await store.read()).suggestions[Object.keys((await store.read()).suggestions)[0]!]?.state).toBe("applying");
      const before = (await c.experiences.scan()).experiences.length;
      await service.setSettings({ automatic: revoked !== "automatic", background: false, backgroundProfileId: "cloud-a", ...(revoked === "source" ? { sources: ["preference" as const] } : {}) });
      await c.run(service);
      const notes = (await c.experiences.scan()).experiences;
      expect(notes.length).toBe(before);
      expect(notes.filter((entry) => entry.record.status === "active")).toHaveLength(0);
      await service.setSettings({ automatic: true, background: false, backgroundProfileId: "cloud-a" });
      await c.run(service);
      expect((await c.experiences.scan()).experiences.filter((entry) => entry.record.status === "active")).toHaveLength(1);
    });
  }
  for (const revoked of ["source", "automatic"] as const) {
    it(`does not archive after ${revoked} is revoked while the archive preview is pending`, async () => {
      const c = await setup({ answers: { experience: experienceAnswer } });
      const list = await c.record([{ title: "归档前暂停自动维护" }]);
      await finishWithNote(c, list.list!.id, 1, "重试五十次没有重复消息。");
      await c.service.setSettings({ automatic: true, background: false, backgroundProfileId: "cloud-a" });
      await c.run();
      const earlier = (await c.experiences.scan()).experiences[0]!;
      await finishWithNote(c, list.list!.id, 1, "更正：网络切换时仍复现一次重复消息。");
      let entered!: () => void; let release!: () => void;
      const inside = new Promise<void>((resolve) => { entered = resolve; });
      const open = new Promise<void>((resolve) => { release = resolve; });
      c.hooks.beforeArchivePreview = async () => { entered(); await open; };
      const running = c.run();
      await inside;
      try {
        await c.service.setSettings({ automatic: revoked !== "automatic", background: false, backgroundProfileId: "cloud-a", ...(revoked === "source" ? { sources: ["preference" as const] } : {}) });
      } finally { release(); }
      await running;
      expect((await c.experiences.find(earlier.record.id))?.record.status).toBe("active");
      const partial = (await c.view()).suggestions.find((entry) => entry.state === "partially_applied")!;
      expect(partial.steps.find((step) => step.kind === "experience_archive")?.state).toBe("failed");
      await c.service.setSettings({ automatic: true, background: false, backgroundProfileId: "cloud-a" });
      await c.run();
      expect((await c.experiences.find(earlier.record.id))?.record.status).toBe("archived");
      expect((await c.experiences.scan()).experiences.filter((entry) => entry.record.status === "active")).toHaveLength(1);
    });
  }
  it("retains first-attempt usage when the next retry cannot write its request ledger", async () => {
    const c = await setup();
    const list = await c.record([{ title: "失败调用的计量" }]);
    await finishWithNote(c, list.list!.id, 1, "合成验证结果：重试五十次没有重复消息。");
    const store = new FailingStore(c.storePath, "retry_ledger");
    const service = c.make({ store });
    c.fake.control.fail = true; c.fake.control.failureUsage = { inputTokens: 120, outputTokens: 7 };
    await c.run(service);
    expect(c.fake.calls).toHaveLength(1);
    expect((await c.view(service)).run?.usage).toMatchObject({ calls: 1, failedCalls: 1, reportedInputTokens: 120, reportedOutputTokens: 7 });
  });

});

describe("RSI-009: authorization changes during run preparation", () => {
  for (const change of ["forget", "disable_source", "pause_background", "change_background_model"] as const) {
    it(`does not send stale prepared inputs after ${change}`, async () => {
      const c = await setup({ answers: { experience: experienceAnswer } });
      const list = await c.record([{ title: "准备期间撤销的记录" }]);
      await finishWithNote(c, list.list!.id, 1, "这是准备期间被撤销的合成结果，不应发送给模型。");
      await c.service.setSettings({ automatic: true, background: true, backgroundProfileId: "cloud-a" });
      let entered!: () => void; let release!: () => void;
      const inside = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const profiles = c.fake.gateway.listGenerationProfiles;
      let first = true;
      c.fake.gateway.listGenerationProfiles = async () => { if (first) { first = false; entered(); await gate; } return profiles(); };
      const background = change === "pause_background" || change === "change_background_model";
      const starting = c.service.run({ scope: "project", project: "消息服务", profileId: "cloud-a" }, background ? "background" : "manual");
      await inside;
      if (change === "forget") {
        const key = `todo_item:${list.list!.id}#1`;
        const preview = await c.service.previewForget({ key });
        expect((await c.service.forget({ key, expectedPreviewHash: preview.previewHash, confirm: true })).status).toBe("done");
      } else if (change === "disable_source") await c.service.setSettings({ automatic: true, background: false, backgroundProfileId: "cloud-a", sources: ["preference"] });
      else await c.service.setSettings({ automatic: true, background: change !== "pause_background", backgroundProfileId: change === "change_background_model" ? "cloud-b" : "cloud-a" });
      c.clock.now = new Date(c.clock.now.getTime() + 1000);
      release(); await starting; await c.service.settled();
      expect(c.fake.calls).toHaveLength(0);
      expect((await c.experiences.scan()).experiences).toHaveLength(0);
      if (background) {
        await c.run(c.service, change === "change_background_model" ? "cloud-b" : "cloud-a");
        expect(c.fake.calls.length).toBeGreaterThan(0);
      }
    });
  }
  it("does not restore forgotten text through a legacy deterministic reminder", async () => {
    const c = await setup();
    const title = "RSI 需要遗忘的提醒原文";
    const list = await c.record([{ title }]);
    c.clock.now = new Date("2026-12-15T00:00:00.000Z");
    await c.run();
    expect((await c.view()).suggestions.some((entry) => entry.type === "todo_recheck")).toBe(true);
    let entered!: () => void; let release!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const profiles = c.fake.gateway.listGenerationProfiles;
    c.fake.gateway.listGenerationProfiles = async () => { entered(); await gate; return profiles(); };
    const starting = c.service.run({ scope: "project", project: "消息服务", profileId: "cloud-a" });
    await inside;
    const key = `todo_item:${list.list!.id}#1`;
    const preview = await c.service.previewForget({ key });
    expect((await c.service.forget({ key, expectedPreviewHash: preview.previewHash, confirm: true })).status).toBe("done");
    c.clock.now = new Date(c.clock.now.getTime() + 1000);
    release(); await starting; await c.service.settled();
    expect(await readFile(c.storePath, "utf8")).not.toContain(title);
  });
});

describe("RSI-011: historical source dates", () => {
  for (const date of ["2026-09-01", "2026-09-01T09:00:00+08:00", "日期待核实", "2026-02-30"]) {
    it(`preserves the source's recorded date without blocking memory: ${date}`, async () => {
      const c = await setup({ answers: { knowledge: { memory: { title: "缓存部署边界", scene: "单机服务", observations: [{ ref: "K1", quote: "单机采用内存缓存" }], inference: "仅限单机部署", unknowns: "多实例未验证" }, triage: null, question: null } } });
      c.decisions.documents.push({ id: "HIST-1", source: "summarize", kind: "summarized_decision", title: "缓存部署边界", project: "消息服务", status: "accepted", created: date, summary: "单机采用内存缓存", appliesWhen: "仅单机", caution: "多实例未验证", tags: [], supersedes: [], supersededBy: [], relativePath: "Decision Journal/summarize/HIST-1.md", client: null, sessionId: null, body: "单机采用内存缓存", bodyStartLine: 1, contentHash: "a".repeat(64) });
      await c.service.setSettings({ automatic: true, background: false, backgroundProfileId: "cloud-a" });
      await c.run();
      const notes = (await c.experiences.scan()).experiences;
      expect(notes).toHaveLength(1);
      expect(notes[0]?.record.status).toBe("active");
      expect(notes[0]?.record.sources[0]?.at).toBe(date);
    });
  }
});

describe("RSI-014: 传递来源授权", () => {
  const gate = () => {
    let entered!: () => void; let release!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const open = new Promise<void>((resolve) => { release = resolve; });
    return { inside, release, hook: async () => { entered(); await open; } };
  };
  const memory = async (c: Awaited<ReturnType<typeof setup>>, id: string, inputKeys: string[]) => {
    // 授权测试需要真实存在的原始叶子；来源缺失现在由独立的生命周期检查冻结。
    for (const key of inputKeys.filter((key) => key.startsWith("preference:"))) if (!c.journal.some((entry) => entry.id === key.slice(11))) c.journal.push({ kind: "preference", id: key.slice(11), title: "原始依据", content: "合成原始依据", knowledgeStatus: "active", project: "消息服务", sourceForm: "user_original", appliesWhen: null, exceptions: null, updatedAt: c.clock.now.toISOString() } as unknown as JournalEntry);
    const result = await c.experiences.create({
      id, revision: 1, status: "active", project: "消息服务", createdAt: c.clock.now.toISOString(), updatedAt: c.clock.now.toISOString(),
      reporter: "agent", verification: "machine_synthesis", outcome: "unknown", adoptedFrom: null, generator: null, inputKeys, sources: [],
      body: { title: "消息重复发送", scene: "合成场景", action: "整理已有记录", observation: `合成内容 ${id}`, inference: `消息重复发送 ${id}`, exceptions: "仅合成测试" },
    });
    if (result.status !== "saved") throw new Error("synthetic memory was not created");
    return result.stored;
  };
  const restricted = { automatic: false, background: false, backgroundProfileId: "cloud-a", sources: ["todo_item", "experience", "pending_rationale"] as const };
  const restrict = (service: OrganizationService) => service.setSettings({ ...restricted, sources: [...restricted.sources] });
  it("检索沿未引用输入和多级记忆继承停用权限，重新授权后恢复", async () => {
    const c = await setup();
    await memory(c, "private-parent", ["preference:P"]);
    await memory(c, "private-child", ["experience:private-parent"]);
    const safe = await memory(c, "independent", []);
    await restrict(c.service);
    expect((await c.service.searchableExperiences()).experiences.map((entry) => entry.record.id)).toEqual([safe.record.id]);
    await c.service.setSettings({ ...restricted, sources: [...restricted.sources, "preference"] });
    expect((await c.service.searchableExperiences()).experiences).toHaveLength(3);
    expect((await c.experiences.find(safe.record.id))?.noteHash).toBe(safe.noteHash);
  });
  it("模型提示词不经派生记忆带入已停用来源，允许的独立记忆仍可用", async () => {
    const c = await setup();
    await memory(c, "private-parent", ["preference:P"]);
    await memory(c, "private-child", ["experience:private-parent"]);
    await memory(c, "independent", []);
    await c.record([{ title: "消息重复发送" }]);
    await restrict(c.service);
    await c.run();
    expect(c.fake.calls.length).toBeGreaterThan(0);
    expect(c.fake.calls.some((call) => call.prompt.includes("independent"))).toBe(true);
    expect(c.fake.calls.some((call) => /private-parent|private-child/u.test(call.prompt))).toBe(false);
    expect((await c.experiences.scan()).experiences).toHaveLength(3);
  });
  it("待补理由继承原始决策的授权", async () => {
    const c = await setup();
    c.decision("original", "合成受限决策原文");
    c.pending.push({ kind: "pending_rationale", id: "pending", root: "decision:original", project: "消息服务", title: "消息重复发送", material: "合成受限决策原文", at: c.clock.now.toISOString() });
    await c.service.setSettings({ automatic: true, background: false, backgroundProfileId: "cloud-a", sources: ["pending_rationale"] });
    await c.run();
    expect(c.fake.calls).toHaveLength(0);
    await c.service.setSettings({ automatic: true, background: false, backgroundProfileId: "cloud-a", sources: ["pending_rationale", "decision"] });
    await c.run();
    expect(c.fake.calls.some((call) => call.prompt.includes("合成受限决策原文"))).toBe(true);
  });
  it("中间记忆缺失且无法还原来源时不把下游当成已授权", async () => {
    const c = await setup();
    const parent = await memory(c, "private-parent", ["preference:P"]);
    await memory(c, "private-child", ["experience:private-parent"]);
    await rm(parent.path);
    await restrict(c.service);
    expect((await c.service.searchableExperiences()).experiences).toHaveLength(0);
    expect((await c.experiences.scan()).experiences).toHaveLength(1);
  });
  it("中间笔记缺失时，旧写前计划能追溯权限但不代表内容仍然生效", async () => {
    const c = await setup({ answers: { experience: experienceAnswer } });
    const list = await c.record([{ title: "消息重复发送" }]);
    await finishWithNote(c, list.list!.id, 1, "重试五十次未出现重复消息。");
    await c.run();
    const suggestion = (await c.view()).suggestions.find((entry) => entry.type === "experience")!;
    expect((await c.service.decide({ id: suggestion.id, expectedRevision: suggestion.revision, expectedEvidenceVersion: suggestion.evidenceVersion, action: "adopt" })).status).toBe("saved");
    const parent = (await c.experiences.scan()).experiences[0]!;
    await memory(c, "child", [`experience:${parent.record.id}`]);
    await rm(parent.path);
    await c.service.setSettings({ ...restricted, sources: ["experience"] });
    expect((await c.service.searchableExperiences()).experiences).toHaveLength(0);
    await c.service.setSettings({ ...restricted, sources: ["experience", "todo_item"] });
    expect((await c.service.searchableExperiences()).experiences).toHaveLength(0);
    expect((await c.experiences.scan()).experiences.map((entry) => entry.record.id)).toEqual(["child"]);
  });
  it("不使用新版本的授权返回旧版本笔记正文", async () => {
    const c = await setup();
    const parent = await memory(c, "private-parent", ["preference:P"]);
    await memory(c, "private-child", ["experience:private-parent"]);
    await restrict(c.service);
    c.hooks.afterScan = async () => { await writeFile(parent.path, serializeExperience({ ...parent.record, inputKeys: [], body: { ...parent.record.body, observation: "更新后的公开内容" } })); };
    expect((await c.service.searchableExperiences()).experiences).toHaveLength(0);
    expect((await c.service.searchableExperiences()).experiences.find((entry) => entry.record.id === parent.record.id)?.record.body.observation).toBe("更新后的公开内容");
  });
  it("读取期间新增的父记忆也不能为本次旧子笔记补发授权", async () => {
    const c = await setup();
    await memory(c, "child", ["experience:restored-parent"]);
    await restrict(c.service);
    c.hooks.afterScan = async () => { await memory(c, "restored-parent", []); };
    expect((await c.service.searchableExperiences()).experiences).toHaveLength(0);
    expect((await c.service.searchableExperiences()).experiences).toHaveLength(2);
  });
  it("新记忆保存调用当时的祖先输入，父记忆后来改写不解除旧输入限制", async () => {
    const c = await setup({ answers: { knowledge: { memory: { title: "待处理记忆", scene: "合成", observations: [{ ref: "K1", quote: "公开记录" }], inference: "有限推断", unknowns: "合成" }, triage: null, question: null } } });
    const parent = await memory(c, "private-parent", ["preference:P"]);
    c.pending.push({ kind: "pending_rationale", id: "pending", root: "experience:private-parent", project: "消息服务", title: "消息重复发送", material: "公开记录", at: c.clock.now.toISOString() });
    await c.service.setSettings({ automatic: true, background: false, backgroundProfileId: "cloud-a" });
    await c.run();
    const created = (await c.experiences.scan()).experiences.find((entry) => entry.record.id !== parent.record.id)!;
    expect(created.record.inputKeys).toContain("preference:P");
    expect(created.record.sources.some((source) => source.key === "preference:P")).toBe(false);
    await writeFile(parent.path, serializeExperience({ ...parent.record, inputKeys: [], body: { ...parent.record.body, observation: "更新后的公开内容" } }));
    await restrict(c.service);
    const found = (await c.service.searchableExperiences()).experiences;
    expect(found.some((entry) => entry.record.id === parent.record.id)).toBe(true);
    expect(found.some((entry) => entry.record.id === created.record.id)).toBe(false);
  });
  it("输入祖先超过可保存范围时停止调用，不截断授权追踪", async () => {
    const c = await setup();
    const parent = await memory(c, "many-inputs", Array.from({ length: 2048 }, (_, index) => `preference:P${index}`));
    const list = await c.record([{ title: "消息重复发送" }]);
    await c.service.run({ scope: "list", listId: list.list!.id, project: "消息服务", profileId: "cloud-a" }, "manual", [`todo_item:${list.list!.id}#1`]);
    await c.service.settled();
    expect(c.fake.calls).toHaveLength(0);
    expect((await c.view()).run?.state).toBe("failed");
    expect((await c.experiences.find(parent.record.id))?.noteHash).toBe(parent.noteHash);
  });
  it("刷新后的累计输入留痕超限也在发送前停止，不重复消耗模型调用", async () => {
    const c = await setup({ answers: { knowledge: { memory: { title: "公开记忆", scene: "合成", observations: [{ ref: "K1", quote: "公开记录" }], inference: "有限推断", unknowns: "合成" }, triage: null, question: null } } });
    c.pending.push({ kind: "pending_rationale", id: "pending", project: "消息服务", title: "公开记录", material: "公开记录", at: c.clock.now.toISOString() });
    await c.service.setSettings({ automatic: true, background: false, backgroundProfileId: "cloud-a" });
    await c.run();
    const suggestion = (await c.view()).suggestions.find((entry) => entry.type === "experience")!;
    await new OrganizationStore(c.storePath).update((state) => {
      state.suggestions[suggestion.id]!.inputKeys = Array.from({ length: 2048 }, (_, index) => `preference:old${index}`);
      return { state, value: null };
    });
    c.pending[0]!.material = "公开记录已更新";
    const calls = c.fake.calls.length;
    await c.run();
    expect(c.fake.calls).toHaveLength(calls);
    expect((await c.view()).run?.state).toBe("failed");
    await c.run();
    expect(c.fake.calls).toHaveLength(calls);
    expect((await c.experiences.scan()).experiences).toHaveLength(1);
  });
  it("开始前关联继承未引用输入的停用权限，重新授权后可恢复", async () => {
    const c = await setup({ answers: { todo: { groups: [], acceptance: [], links: [{ ref: "T1", record: "K1", whyRelevant: "与消息重复发送相关", scopeNote: "仅测试" }] } } });
    for (const [kind, id] of [["preference", "P"], ["idea", "I"]] as const) c.journal.push({ kind, id, title: "消息重复发送", content: "消息重复发送先按幂等键去重", knowledgeStatus: "active", project: "消息服务", sourceForm: "user_original", appliesWhen: null, exceptions: null, updatedAt: c.clock.now.toISOString() } as unknown as JournalEntry);
    const list = await c.record([{ title: "消息重复发送" }]);
    await c.run();
    const link = (await c.view()).suggestions.find((entry) => entry.type === "todo_context")!;
    expect(link.sources.some((source) => source.key === "preference:P")).toBe(true);
    expect(link.sources.some((source) => source.key === "idea:I")).toBe(false);
    expect((await c.service.decide({ id: link.id, expectedRevision: link.revision, expectedEvidenceVersion: link.evidenceVersion, action: "adopt" })).status).toBe("saved");
    await c.service.setSettings({ ...restricted, sources: ["todo_item", "preference"] });
    expect(Object.values((await c.service.annotations({ listIds: [list.list!.id] })).beforeStart).flat()).toHaveLength(0);
    await c.service.setSettings({ ...restricted, sources: ["todo_item", "preference", "idea"] });
    expect(Object.values((await c.service.annotations({ listIds: [list.list!.id] })).beforeStart).flat()).toHaveLength(1);
  });
  it("检索读取来源期间撤销权限，返回前使用最新设置", async () => {
    const c = await setup();
    await memory(c, "private-parent", ["preference:P"]);
    const paused = gate();
    c.hooks.beforeJournal = paused.hook;
    const searching = c.service.searchableExperiences();
    await paused.inside;
    try { await restrict(c.make()); } finally { paused.release(); }
    expect((await searching).experiences).toHaveLength(0);
  });
  it("召回等待期间由另一个入口停用祖先来源，发模型前再次核对", async () => {
    const c = await setup();
    await memory(c, "private-parent", ["preference:P"]);
    await c.record([{ title: "消息重复发送" }]);
    const paused = gate(); let first = true;
    const service = c.make({ similar: async (_query, items) => {
      if (first) { first = false; await paused.hook(); }
      return { near: items.map((item) => ({ id: item.id, similarity: 1 })), pending: 0 };
    } });
    const running = c.run(service);
    await paused.inside;
    try { await restrict(c.make()); } finally { paused.release(); }
    await running;
    expect(c.fake.calls.some((call) => call.prompt.includes("private-parent"))).toBe(false);
  });
  it("中断的自动写入恢复也要检查祖先权限", async () => {
    const c = await setup({ answers: { knowledge: { memory: { title: "待处理记忆", scene: "合成", observations: [{ ref: "K1", quote: "公开记录" }], inference: "有限推断", unknowns: "合成" }, triage: null, question: null } } });
    await memory(c, "private-parent", ["preference:P"]);
    c.pending.push({ kind: "pending_rationale", id: "pending", root: "experience:private-parent", project: "消息服务", title: "消息重复发送", material: "公开记录", at: c.clock.now.toISOString() });
    await c.service.setSettings({ automatic: true, background: false, backgroundProfileId: "cloud-a" });
    c.hooks.beforeCreate = async () => { throw new Error("synthetic interrupted create"); };
    await c.run();
    expect((await c.view()).suggestions.some((entry) => entry.state === "partially_applied")).toBe(true);
    await c.service.setSettings({ ...restricted, automatic: true, sources: [...restricted.sources] });
    await c.run();
    expect((await c.experiences.scan()).experiences.map((entry) => entry.record.id)).toEqual(["private-parent"]);
    await c.service.setSettings({ ...restricted, automatic: true, sources: [...restricted.sources, "preference"] });
    await c.run();
    expect((await c.experiences.scan()).experiences).toHaveLength(2);
  });
});

describe("RSI-015: 来源生命周期与独立选择", () => {
  const machineMarker = "合成机器背景：雪鹭计划";
  const chosen = "先修复重试，仅本次发布";
  const pendingSeed = async (questionTitle = "消息重复发送先修复还是先发布？") => {
    const c = await setup({ answers: { knowledge: (prompt: string) => {
      const blocks = prompt.split(/\n\n(?=K\d+（)/u).flatMap((part) => {
        const match = /^(K\d+)（([^\n]+)）：\n([\s\S]*)/u.exec(part);
        return match ? [{ ref: match[1]!, heading: match[2]!, material: match[3]! }] : [];
      });
      const preference = blocks.find((entry) => entry.heading.includes("；preference；"));
      const task = blocks.find((entry) => entry.heading.includes("；todo_item；") && entry.material.includes("状态：open"));
      const first = blocks[0];
      return {
        memory: first?.heading.includes("；preference；") ? { title: "消息重复发送记忆", scene: "本次发布", observations: [{ ref: first.ref, quote: "先修复重试" }], inference: machineMarker, unknowns: "未经独立核验" }
          : first?.material.includes(`用户确认：${chosen}`) ? { title: "用户确认后的安排", scene: "本次发布", observations: [{ ref: first.ref, quote: `用户确认：${chosen}` }], inference: "确认的是本次安排", unknowns: "未执行" } : null,
        triage: null,
        question: preference && task ? { category: "priority", task: task.ref, commitments: [{ ref: preference.ref, quote: "先修复重试" }], question: questionTitle, impact: machineMarker, unknowns: "未核验", options: [chosen, "先发布再安排修复"], recommendation: "option_a", recommendationReason: "已有记录" } : null,
      };
    } } });
    c.journal.push(
      { kind: "preference", id: "P", title: "消息重复发送", content: "消息重复发送先修复重试", knowledgeStatus: "active", project: "消息服务", sourceForm: "user_original", appliesWhen: null, exceptions: null, updatedAt: c.clock.now.toISOString() } as unknown as JournalEntry,
      { kind: "idea", id: "I", title: "消息重复发送", content: "消息重复发送的合成补充资料", knowledgeStatus: "active", project: "消息服务", sourceForm: "user_original", whyInteresting: "合成输入", updatedAt: c.clock.now.toISOString() } as unknown as JournalEntry,
    );
    await c.record([{ title: "消息重复发送本周发布" }]);
    await c.service.setSettings({ automatic: true, background: false, backgroundProfileId: "cloud-a" });
    await c.run();
    const question = (await c.view()).suggestions.find((entry) => entry.type === "judgment" && entry.state === "pending")!;
    expect(question).toBeDefined();
    const notes = (await c.experiences.scan()).experiences;
    const derived = notes.find((entry) => !entry.record.userChoice)!;
    expect(derived.record.inputKeys).toContain("idea:I");
    expect(derived.record.sources.some((source) => source.key === "idea:I")).toBe(false);
    return { c, question, derived };
  };
  const seed = async (questionTitle?: string) => {
    const { c, question, derived } = await pendingSeed(questionTitle);
    expect((await c.service.decide({ id: question.id, expectedRevision: question.revision, expectedEvidenceVersion: question.evidenceVersion, action: "adopt", choice: "option_a" })).status).toBe("saved");
    const choice = (await c.experiences.scan()).experiences.find((entry) => entry.record.userChoice)!;
    expect(choice.record.body.observation).toBe(`用户确认：${chosen}`);
    return { c, choice, derived };
  };
  it("RSI-14 excludes a due deferred judgment whose source has become inactive", async () => {
    const { c, question } = await pendingSeed();
    expect((await c.service.attention()).pending).toBe(1);
    await c.service.decide({ id: question.id, expectedRevision: question.revision, expectedEvidenceVersion: question.evidenceVersion, action: "defer", deferUntil: "2026-11-12" });
    expect((await c.service.attention()).pending).toBe(0);
    c.clock.now = new Date(2026, 10, 12, 0, 0, 1);
    expect((await c.service.attention()).pending).toBe(1);
    c.journal[0] = { ...c.journal[0]!, knowledgeStatus: "archived" } as JournalEntry;
    expect((await c.service.attention()).pending).toBe(0);
  });
  it("RSI-12 preserves an independent choice through compressed ordinary deletion and retains explicit forgetting receipts", async () => {
    const { c, choice, derived } = await seed();
    const store = new OrganizationStore(c.storePath);
    await store.update(state => { Object.assign(state.suggestions, capacityState(1600).suggestions); return { state, value: null }; });
    const restarted = c.make();
    const ordinary = await restarted.previewForget({ key: "preference:P" }, { preserveChoices: true });
    expect(ordinary.experiences.some(entry => entry.id === derived.record.id)).toBe(true);
    expect(ordinary.experiences.some(entry => entry.id === choice.record.id)).toBe(false);
    expect((await restarted.forget({ key: ordinary.key, confirm: true, expectedPreviewHash: ordinary.previewHash }, { preserveChoices: true })).status).toBe("done");
    expect((await c.experiences.find(choice.record.id))?.noteHash).toBe(choice.noteHash);
    const explicit = await restarted.previewForget({ key: "preference:P" });
    expect((await restarted.forget({ key: explicit.key, confirm: true, expectedPreviewHash: explicit.previewHash })).status).toBe("done");
    expect(await c.experiences.find(choice.record.id)).toBeNull();
    const decoded = await new OrganizationStore(c.storePath).read();
    expect(decoded.ledger.forgotten["preference:P"]).toBeDefined();
    expect(decoded.ledger.forgottenEvidence["preference:P"]).toBeDefined();
    expect(Object.values(decoded.suggestions).filter(entry => entry.anchor.includes("preference:P")).every(entry => entry.redacted && entry.content === null && entry.draft === null && entry.apply?.steps.every(step => step.before === null && step.after === null) !== false)).toBe(true);
    const calls = c.fake.calls.length; await c.run(c.make());
    expect(c.fake.calls).toHaveLength(calls);
  });
  const change = (c: Awaited<ReturnType<typeof setup>>, id: "P" | "I", action: "withdraw" | "archive" | "delete") => {
    const index = c.journal.findIndex((entry) => entry.id === id);
    if (action === "delete") c.journal.splice(index, 1);
    else if (action === "archive") c.journal[index] = { ...c.journal[index]!, knowledgeStatus: "archived" } as JournalEntry;
    else c.amendments.records.set(`${id === "P" ? "preferences" : "ideas"}:${id}`, { amendVersion: 1, source: id === "P" ? "preferences" : "ideas", recordId: id, revision: 1, updatedAt: c.clock.now.toISOString(), amendments: [], overrides: null, withdrawn: { at: c.clock.now.toISOString(), client: "manual", reason: "合成撤回" }, history: [] } as StoredAmendment);
    c.clock.now = new Date(c.clock.now.getTime() + 1000);
  };
  for (const id of ["P", "I"] as const) for (const action of ["withdraw", "archive", "delete"] as const) {
    it(`${id} ${action}: 机器记忆不再作为现行输入，独立选择仍保留`, async () => {
      const { c, choice, derived } = await seed();
      change(c, id, action);
      const found = (await c.service.searchableExperiences()).experiences;
      expect(found.some((entry) => entry.record.id === derived.record.id)).toBe(false);
      expect(found.some((entry) => entry.record.id === choice.record.id)).toBe(true);
      await c.view();
      expect((await c.experiences.find(choice.record.id))?.noteHash).toBe(choice.noteHash);
      const before = c.fake.calls.length;
      await c.record([{ title: "消息重复发送后续安排" }]);
      await c.run();
      expect(c.fake.calls.slice(before).some((call) => call.prompt.includes(machineMarker))).toBe(false);
      expect(c.fake.calls.slice(before).some((call) => call.prompt.includes(`用户确认：${chosen}`))).toBe(true);
    });
  }
  it("普通源删除预览与清理保留独立选择，显式遗忘仍覆盖它", async () => {
    const { c, choice, derived } = await seed();
    const preview = await c.service.previewForget({ key: "preference:P" }, { preserveChoices: true });
    expect(preview.experiences.map((entry) => entry.id)).toContain(derived.record.id);
    expect(preview.experiences.map((entry) => entry.id)).not.toContain(choice.record.id);
    expect((await c.service.forget({ key: preview.key, confirm: true, expectedPreviewHash: preview.previewHash }, { preserveChoices: true })).status).toBe("done");
    change(c, "P", "delete"); await c.view();
    expect((await c.service.searchableExperiences()).experiences.some((entry) => entry.record.id === choice.record.id)).toBe(true);
    expect((await c.experiences.find(choice.record.id))?.noteHash).toBe(choice.noteHash);
    const explicit = await c.service.previewForget({ key: "preference:P" });
    expect(explicit.experiences.some((entry) => entry.id === choice.record.id)).toBe(true);
    expect((await c.service.forget({ key: explicit.key, confirm: true, expectedPreviewHash: explicit.previewHash })).status).toBe("done");
    expect(await c.experiences.find(choice.record.id)).toBeNull();
  });
  it("两种删除范围不能混用预览凭据", async () => {
    const { c, choice } = await seed();
    const ordinary = await c.service.previewForget({ key: "preference:P" }, { preserveChoices: true });
    const explicit = await c.service.previewForget({ key: "preference:P" });
    expect((await c.service.forget({ key: ordinary.key, confirm: true, expectedPreviewHash: ordinary.previewHash })).status).toBe("preview_changed");
    expect((await c.service.forget({ key: explicit.key, confirm: true, expectedPreviewHash: explicit.previewHash }, { preserveChoices: true })).status).toBe("preview_changed");
    expect((await c.experiences.find(choice.record.id))?.noteHash).toBe(choice.noteHash);
  });
  it("确认笔记已启用但最终回执失败，普通删除仍保留并能恢复这次选择", async () => {
    const { c, question } = await pendingSeed();
    class ReceiptFailure extends OrganizationStore {
      armed = true;
      override update<T>(change: (state: OrganizationState) => { state: OrganizationState | null; value: T }): Promise<T> {
        return super.update((state) => {
          const result = change(state);
          if (this.armed && result.state?.suggestions[question.id]?.state === "applied") { this.armed = false; throw new Error("synthetic choice receipt failure"); }
          return result;
        });
      }
    }
    const store = new ReceiptFailure(c.storePath); const service = c.make({ store });
    await expect(service.decide({ id: question.id, expectedRevision: question.revision, expectedEvidenceVersion: question.evidenceVersion, action: "adopt", choice: "option_a" })).rejects.toThrow("synthetic choice receipt failure");
    const choice = (await c.experiences.scan()).experiences.find((entry) => entry.record.userChoice)!;
    expect(choice.record.status).toBe("active");
    const preview = await service.previewForget({ key: "preference:P" }, { preserveChoices: true });
    await service.forget({ key: preview.key, confirm: true, expectedPreviewHash: preview.previewHash }, { preserveChoices: true });
    expect((await store.read()).suggestions[question.id]?.redacted).toBe(false);
    change(c, "P", "delete"); await service.recover();
    expect((await service.searchableExperiences()).experiences.some((entry) => entry.record.id === choice.record.id)).toBe(true);
    expect((await c.experiences.find(choice.record.id))?.noteHash).toBe(choice.noteHash);
  });
  it("选择的旧机器标题不再次进入检索与模型输入", async () => {
    const { c, choice } = await seed(`消息重复发送 ${machineMarker}，先修复还是发布？`);
    change(c, "I", "delete");
    const search = new ContextSearch({ search: async () => { throw new Error("unexpected decision search"); } }, undefined, undefined, undefined, { scan: () => c.service.searchableExperiences() });
    const response = await search.search(decisionContextQuerySchema.parse({ source: "experiences", query: "", recordId: choice.record.id }));
    expect(response.results[0]?.title).not.toContain(machineMarker);
    expect(response.results[0]?.sourceRef.excerpt).not.toContain(machineMarker);
    const before = c.fake.calls.length; await c.run();
    expect(c.fake.calls.slice(before).some((call) => call.prompt.includes(machineMarker))).toBe(false);
    expect((await c.experiences.find(choice.record.id))?.noteHash).toBe(choice.noteHash);
  });
  it("遗忘后出现实质新证据，即使发生日期不变也可以重新处理", async () => {
    const c = await setup({ answers: { knowledge: (prompt: string) => ({ memory: { title: "日志范围", scene: "合成", observations: [{ ref: "K1", quote: "日志保留 14 天" }], inference: prompt.includes("新范围") ? "新证据的限定范围" : "旧的记录", unknowns: "未独立核验" }, triage: null, question: null }) } });
    c.decision("D", "日志保留 14 天");
    await c.service.setSettings({ automatic: true, background: false, backgroundProfileId: "cloud-a" }); await c.run();
    const preview = await c.service.previewForget({ key: "decision:D" });
    await c.service.forget({ key: preview.key, confirm: true, expectedPreviewHash: preview.previewHash });
    c.clock.now = new Date(c.clock.now.getTime() + 1000); await c.run();
    const calls = c.fake.calls.length;
    const originalDate = c.decisions.documents[0]!.created;
    c.decisions.documents[0] = { ...c.decisions.documents[0]!, summary: "日志保留 14 天，新范围仅测试服务", body: "日志保留 14 天，新范围仅测试服务", contentHash: "b".repeat(64) };
    c.clock.now = new Date(c.clock.now.getTime() + 1000); await c.run();
    expect(c.fake.calls.length).toBeGreaterThan(calls);
    expect(c.decisions.documents[0]!.created).toBe(originalDate);
    expect((await c.service.searchableExperiences()).experiences[0]?.record.body.inference).toContain("新证据");
  });
  it("决策的撤回旁路也会暂停其派生记忆", async () => {
    const c = await setup({ answers: { knowledge: { memory: { title: "日志范围", scene: "合成", observations: [{ ref: "K1", quote: "日志保留 14 天" }], inference: "限定范围", unknowns: "未核验" }, triage: null, question: null } } });
    c.decision("D", "日志保留 14 天");
    await c.service.setSettings({ automatic: true, background: false, backgroundProfileId: "cloud-a" }); await c.run();
    expect((await c.service.searchableExperiences()).experiences).toHaveLength(1);
    c.amendments.records.set("decisions:D", { amendVersion: 1, source: "decisions", recordId: "D", revision: 1, updatedAt: c.clock.now.toISOString(), amendments: [], overrides: null, withdrawn: { at: c.clock.now.toISOString(), client: "manual", reason: "合成撤回" }, history: [] } as StoredAmendment);
    expect((await c.service.searchableExperiences()).experiences).toHaveLength(0);
    expect((await c.experiences.scan()).experiences).toHaveLength(1);
  });
  it("归档已完成的待办清单不等于撤销已记录的执行观察", async () => {
    const c = await setup({ answers: { experience: experienceAnswer } });
    const list = await c.record([{ title: "修复重复消息" }]);
    await finishWithNote(c, list.list!.id, 1, "重试五十次未重复，网络切换未覆盖。");
    await c.service.setSettings({ automatic: true, background: false, backgroundProfileId: "cloud-a" }); await c.run();
    const note = (await c.experiences.scan()).experiences[0]!;
    await c.todos.updateList({ listId: list.list!.id, archived: true });
    expect((await c.service.searchableExperiences()).experiences.some((entry) => entry.record.id === note.record.id)).toBe(true);
    expect((await c.experiences.find(note.record.id))?.noteHash).toBe(note.noteHash);
  });
  for (const result of ["memory", "none"] as const) for (const interrupted of ["archive", "unreadable"] as const) it(`模型返回时来源 ${interrupted}，${result} 结果不误记已完成且恢复后会重试`, async () => {
    const c = await setup({ answers: { knowledge: { memory: result === "memory" ? { title: "日志范围", scene: "合成", observations: [{ ref: "K1", quote: "日志保留 14 天" }], inference: "范围待核验", unknowns: "合成" } : null, triage: null, question: null } } });
    c.journal.push({ kind: "preference", id: "P", title: "日志范围", content: "日志保留 14 天", knowledgeStatus: "active", project: "消息服务", sourceForm: "user_original", appliesWhen: null, exceptions: null, updatedAt: c.clock.now.toISOString() } as unknown as JournalEntry);
    await c.service.setSettings({ automatic: true, background: false, backgroundProfileId: "cloud-a" });
    let entered!: () => void; let release!: () => void; let first = true;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const open = new Promise<void>((resolve) => { release = resolve; });
    const generate = c.fake.gateway.generate.bind(c.fake.gateway);
    c.fake.gateway.generate = async (request, parse, signal, profileId) => {
      const answer = await generate(request, parse, signal, profileId);
      if (first) { first = false; entered(); await open; }
      return answer;
    };
    const running = c.run(); await inside;
    if (interrupted === "archive") c.journal[0] = { ...c.journal[0]!, knowledgeStatus: "archived" } as JournalEntry;
    else c.unreadable.journal = true;
    release(); await running;
    expect((await new OrganizationStore(c.storePath).read()).ledger.queue.some((entry) => entry.key === "preference:P")).toBe(true);
    c.unreadable.journal = false; c.journal[0] = { ...c.journal[0]!, knowledgeStatus: "active" } as JournalEntry;
    const calls = c.fake.calls.length; await c.run();
    expect(c.fake.calls.length).toBe(calls + 1);
    expect((await c.experiences.scan()).experiences).toHaveLength(result === "memory" ? 1 : 0);
    await c.run(); expect(c.fake.calls.length).toBe(calls + 1);
  });
  it("从独立选择新整理的内容不再被原来源失效连带撤销", async () => {
    const { c, choice } = await seed();
    change(c, "P", "delete"); await c.run();
    const child = (await c.experiences.scan()).experiences.find((entry) => entry.record.body.title === "用户确认后的安排")!;
    expect(child).toBeDefined();
    expect(child.record.directInputKeys).toContain(`experience:${choice.record.id}`);
    expect(child.record.directInputKeys).not.toContain("preference:P");
    expect(child.record.inputKeys).toContain("preference:P");
    expect((await c.service.searchableExperiences()).experiences.some((entry) => entry.record.id === child.record.id)).toBe(true);
    const preview = await c.service.previewForget({ key: "preference:P" }, { preserveChoices: true });
    expect(preview.experiences.some((entry) => entry.id === child.record.id)).toBe(false);
  });
  for (const action of ["archive", "delete"] as const) it(`选择自身 ${action} 后，其机器下游停止使用`, async () => {
    const { c, choice } = await seed();
    await c.run();
    const child = (await c.experiences.scan()).experiences.find((entry) => entry.record.body.title === "用户确认后的安排")!;
    expect(child).toBeDefined();
    if (action === "archive") await c.experiences.reviseProperties(choice.record.id, choice.noteHash, (record) => ({ status: "archived", sources: record.sources }));
    else await rm(choice.path);
    expect((await c.service.searchableExperiences()).experiences.some((entry) => entry.record.id === child.record.id)).toBe(false);
    if (action === "archive") {
      const search = new ContextSearch({ search: async () => { throw new Error("unexpected decision search"); } }, undefined, undefined, undefined, { scan: () => c.service.searchableExperiences() });
      const found = await search.search(decisionContextQuerySchema.parse({ source: "experiences", query: "", recordId: choice.record.id, includeWithdrawn: true }));
      expect(found.results[0]?.current).toBe(false);
      expect(found.results[0]?.experience?.observation).toBe(`用户确认：${chosen}`);
    }
  });
  it("暂时读不到来源只冻结派生内容，不误清理笔记、草稿或独立选择", async () => {
    const { c, choice, derived } = await seed();
    c.unreadable.journal = true;
    const found = (await c.service.searchableExperiences()).experiences;
    expect(found.some((entry) => entry.record.id === derived.record.id)).toBe(false);
    expect(found.some((entry) => entry.record.id === choice.record.id)).toBe(true);
    const view = await c.view();
    const stored = view.suggestions.find((entry) => entry.id === derived.record.adoptedFrom!.split("@r")[0])!;
    expect(stored.redacted).toBe(false);
    expect(stored.stale?.reason).toBe("source_unreadable");
    expect((await c.experiences.find(derived.record.id))?.noteHash).toBe(derived.noteHash);
    const search = new ContextSearch({ search: async () => { throw new Error("unexpected decision search"); } }, undefined, undefined, undefined, { scan: () => c.service.searchableExperiences() });
    const response = await search.search(decisionContextQuerySchema.parse({ source: "experiences", query: "", recordId: derived.record.id }));
    expect(response.coverage).toBe("partial");
    c.unreadable.journal = false;
    expect((await c.service.searchableExperiences()).experiences.some((entry) => entry.record.id === derived.record.id)).toBe(true);
  });
  it("失效或暂不可读的未引用输入不会留下仍可确认的旧判断", async () => {
    const { c, question } = await pendingSeed();
    c.unreadable.journal = true;
    expect(await c.service.pendingCount()).toBe(0);
    expect((await c.view()).suggestions.find((entry) => entry.id === question.id)?.redacted).toBe(false);
    c.unreadable.journal = false; change(c, "I", "archive");
    expect(await c.service.pendingCount()).toBe(0);
    expect((await c.service.decide({ id: question.id, expectedRevision: question.revision, expectedEvidenceVersion: question.evidenceVersion, action: "adopt", choice: "option_a" })).status).toBe("stale");
    c.journal[1] = { ...c.journal[1]!, knowledgeStatus: "active" } as JournalEntry;
    expect(await c.service.pendingCount()).toBe(1);
  });
  it("独立选择对外只陈述实际确认，不把失效的机器背景继续作为依据", async () => {
    const { c, choice } = await seed();
    change(c, "I", "delete");
    const search = new ContextSearch({ search: async () => { throw new Error("unexpected decision search"); } }, undefined, undefined, undefined, { scan: () => c.service.searchableExperiences() });
    const response = await search.search(decisionContextQuerySchema.parse({ source: "experiences", query: "", recordId: choice.record.id }));
    expect(response.results).toHaveLength(1);
    expect(response.results[0]!.experience?.observation).toBe(`用户确认：${chosen}`);
    expect(JSON.stringify(response)).not.toContain(machineMarker);
    expect((await c.experiences.find(choice.record.id))?.noteHash).toBe(choice.noteHash);
  });
  it("召回等待中撤回来源，发送模型前重新核对生命周期", async () => {
    const { c } = await seed();
    await c.record([{ title: "消息重复发送后续安排" }]);
    let entered!: () => void; let release!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const open = new Promise<void>((resolve) => { release = resolve; }); let first = true;
    const service = c.make({ similar: async (_query, items) => {
      if (first) { first = false; entered(); await open; }
      return { near: items.map((item) => ({ id: item.id, similarity: 1 })), pending: 0 };
    } });
    const before = c.fake.calls.length;
    const running = c.run(service);
    await inside; change(c, "I", "withdraw"); release(); await running;
    expect(c.fake.calls.slice(before).some((call) => call.prompt.includes(machineMarker) || call.prompt.includes("合成补充资料"))).toBe(false);
  });
  it("归档旧版本的准备期间撤回输入，不继续新的自动写入", async () => {
    const { c, derived } = await seed();
    c.journal[0] = { ...c.journal[0]!, content: "消息重复发送先修复重试，补充本次验证范围" } as JournalEntry;
    c.clock.now = new Date(c.clock.now.getTime() + 1000);
    let entered!: () => void; let release!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const open = new Promise<void>((resolve) => { release = resolve; });
    c.hooks.beforeArchivePreview = async () => { entered(); await open; };
    const running = c.run();
    await inside; change(c, "I", "withdraw"); release(); await running;
    expect((await c.experiences.find(derived.record.id))?.record.status).toBe("active");
  });
});
