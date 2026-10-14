import { DecisionStore, JournalEntryRepository, MarkdownRepository, SqliteIndex } from "@cognelis/decision-storage";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ActiveRecordService, journalNotice } from "../src/main/active-record-service.js";
import { journalEntryBasis } from "../src/shared/journal-basis.js";

const preferenceRequest = () => ({
  recordVersion: 1 as const,
  requestId: "preference-request-1",
  sourceClient: "codex" as const,
  sourceKind: "agent_capture" as const,
  sourceForm: "machine_summary" as const,
  sensitivity: "private" as const,
  project: "decision",
  kind: "preference" as const,
  title: "常规实现决策默认由系统自主完成",
  content: "普通可逆的方向与实现由系统自行判断并交付结果。",
  appliesWhen: "既定目标和仓库范围内的普通产品与工程取舍。",
  exceptions: "权限、付费、不可逆操作、公开范围或核心验收冲突。",
  tags: ["协作偏好"],
});

describe("ActiveRecordService", () => {
  it("creates and deduplicates one explicit scoped preference", async () => {
    const vault = await mkdtemp(join(tmpdir(), "active-record-service-"));
    const save = vi.fn(async () => ({ indexed: true }));
    const service = new ActiveRecordService({
      decisionStore: { save },
      decisionIndex: { findByCaptureSemanticKey: () => null },
      journalRepository: new JournalEntryRepository(vault),
      idFactory: () => "preference-1",
      clock: () => new Date("2026-08-26T10:00:00.000Z"),
    });

    await expect(service.create(preferenceRequest())).resolves.toEqual({
      recordVersion: 1,
      status: "created",
      recordKind: "preference",
      recordId: "preference-1",
      knowledgeStatus: "active",
      sensitivity: "private",
      storedTranscript: false,
    });
    await expect(service.create(preferenceRequest())).resolves.toMatchObject({
      status: "duplicate",
      recordId: "preference-1",
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("says each time it writes a preference or idea, and not for a restatement that adds nothing", async () => {
    const vault = await mkdtemp(join(tmpdir(), "active-record-written-"));
    const written = vi.fn();
    const service = new ActiveRecordService({
      decisionStore: { save: vi.fn(async () => ({ indexed: true })) },
      decisionIndex: { findByCaptureSemanticKey: () => null },
      journalRepository: new JournalEntryRepository(vault),
      idFactory: () => "preference-1",
      clock: () => new Date("2026-08-26T10:00:00.000Z"),
      onJournalWritten: written,
    });

    // An agent's, through the bridge: said nowhere, a list left open in the app never showed it.
    await service.create(preferenceRequest());
    expect(written).toHaveBeenCalledTimes(1);
    await service.create(preferenceRequest());
    expect(written).toHaveBeenCalledTimes(1);
    await service.create({ ...preferenceRequest(), requestId: "preference-request-2", exceptions: "仅限周末发布。" });
    expect(written).toHaveBeenCalledTimes(2);
    const [shown] = await service.listJournalEntries();
    if (shown?.kind !== "preference") throw new Error("expected a preference");
    await service.reviseJournalEntry("preference-1", {
      draft: {
        kind: "preference", title: shown.title, content: shown.content, knowledgeStatus: "archived",
        context: shown.context, rationale: shown.rationale, tags: [...shown.tags],
        appliesWhen: shown.appliesWhen, exceptions: shown.exceptions,
        strength: shown.strength, evidenceMaturity: shown.evidenceMaturity,
      },
      change: { changeNote: "归档记录", sourceKind: "app_manual", sourceForm: "user_original" },
    });
    expect(written).toHaveBeenCalledTimes(3);
  });

  it("keeps a restated preference's new exception as a revision, and only what was said changes", async () => {
    const vault = await mkdtemp(join(tmpdir(), "active-record-restated-"));
    const journalRepository = new JournalEntryRepository(vault);
    const service = new ActiveRecordService({
      decisionStore: { save: vi.fn(async () => ({ indexed: true })) },
      decisionIndex: { findByCaptureSemanticKey: () => null },
      journalRepository,
      idFactory: () => "preference-1",
      clock: () => new Date("2026-09-30T10:00:00.000Z"),
    });
    await service.create({ ...preferenceRequest(), strength: "hard_constraint" });

    // The same preference, restated with one more exception and nothing said of its strength.
    const restated = await service.create({
      ...preferenceRequest(),
      requestId: "preference-request-2",
      exceptions: "权限、付费、不可逆操作、公开范围或核心验收冲突；以及需要用户签字的发布。",
    });

    expect(restated).toMatchObject({ status: "updated", recordId: "preference-1" });
    const stored = await journalRepository.find("preference-1");
    expect(stored).toMatchObject({
      revision: 2,
      exceptions: "权限、付费、不可逆操作、公开范围或核心验收冲突；以及需要用户签字的发布。",
      // Left out, it stays what it was: a hard constraint is not softened by being restated.
      strength: "hard_constraint",
    });
    // Restated word for word, it is the same entry again.
    await expect(service.create({ ...preferenceRequest(), requestId: "preference-request-3", exceptions: stored?.kind === "preference" ? stored.exceptions ?? undefined : undefined }))
      .resolves.toMatchObject({ status: "duplicate" });
    // The same tags in another order, or one named twice, are the same tags: no revision for nothing.
    await expect(service.create({
      ...preferenceRequest(),
      requestId: "preference-request-4",
      exceptions: stored?.kind === "preference" ? stored.exceptions ?? undefined : undefined,
      tags: ["协作偏好", "协作偏好"],
    })).resolves.toMatchObject({ status: "duplicate" });
    expect((await journalRepository.find("preference-1"))?.revision).toBe(2);
  });

  it("keeps the languages a preference is recorded for, and takes a restatement's new ones as a revision", async () => {
    const vault = await mkdtemp(join(tmpdir(), "active-record-languages-"));
    const journalRepository = new JournalEntryRepository(vault);
    const service = new ActiveRecordService({
      decisionStore: { save: vi.fn(async () => ({ indexed: true })) },
      decisionIndex: { findByCaptureSemanticKey: () => null },
      journalRepository,
      idFactory: () => "preference-1",
      clock: () => new Date("2026-09-30T10:00:00.000Z"),
    });
    await service.create({ ...preferenceRequest(), languages: ["Golang"] });
    expect((await journalRepository.find("preference-1"))?.languages).toEqual(["go"]);

    // Said again by another name of the same language: nothing new.
    await expect(service.create({ ...preferenceRequest(), requestId: "preference-request-2", languages: ["go"] }))
      .resolves.toMatchObject({ status: "duplicate" });
    // Left out, the entry keeps its own; sent empty, as agents fill an optional list, too (it was made general); said
    // differently, a revision.
    await expect(service.create({ ...preferenceRequest(), requestId: "preference-request-3" })).resolves.toMatchObject({ status: "duplicate" });
    await expect(service.create({ ...preferenceRequest(), requestId: "preference-request-5", languages: [] })).resolves.toMatchObject({ status: "duplicate" });
    expect((await journalRepository.find("preference-1"))?.languages).toEqual(["go"]);
    await expect(service.create({ ...preferenceRequest(), requestId: "preference-request-4", languages: ["go", "rust"] }))
      .resolves.toMatchObject({ status: "updated" });
    expect(await journalRepository.find("preference-1")).toMatchObject({ revision: 2, languages: ["go", "rust"] });
  });

  it("works out a restated entry's standing from what it now holds, not from what the restatement left out", async () => {
    const vault = await mkdtemp(join(tmpdir(), "active-record-standing-"));
    const journalRepository = new JournalEntryRepository(vault);
    const service = new ActiveRecordService({
      decisionStore: { save: vi.fn(async () => ({ indexed: true })) },
      decisionIndex: { findByCaptureSemanticKey: () => null },
      journalRepository,
      idFactory: () => "preference-1",
      clock: () => new Date("2026-09-30T10:00:00.000Z"),
    });
    const { appliesWhen: _scope, exceptions: _exceptions, ...bare } = preferenceRequest();
    // Said quickly, without its scope: 待澄清.
    await expect(service.create(bare)).resolves.toMatchObject({ status: "created", knowledgeStatus: "inbox" });
    // Given its scope and exception later, it is 有效, as the same words recorded fresh would be.
    await expect(service.create({ ...preferenceRequest(), requestId: "standing-2" }))
      .resolves.toMatchObject({ status: "updated", knowledgeStatus: "active" });
    // Recorded again without them, it stays 有效: nothing new was said.
    await expect(service.create({ ...bare, requestId: "standing-3" }))
      .resolves.toMatchObject({ status: "duplicate", knowledgeStatus: "active" });
    // A strength said, the default among them, is said: softening a hard constraint is a restatement too.
    await service.create({ ...preferenceRequest(), requestId: "standing-5", strength: "hard_constraint" });
    await service.create({ ...preferenceRequest(), requestId: "standing-6", strength: "default" });
    expect(await journalRepository.find("preference-1")).toMatchObject({ strength: "default", knowledgeStatus: "active" });

    // Archived in the app: the user's own choice, which an agent stating it again does not undo. Stated
    // again in the app, by the user, it stands again.
    const shown = (await journalRepository.find("preference-1"))!;
    if (shown.kind !== "preference") throw new Error("expected a preference");
    await service.reviseJournalEntry("preference-1", {
      draft: {
        kind: "preference", title: shown.title, content: shown.content, knowledgeStatus: "archived",
        context: shown.context, rationale: shown.rationale, tags: [...shown.tags],
        appliesWhen: shown.appliesWhen, exceptions: shown.exceptions,
        strength: shown.strength, evidenceMaturity: shown.evidenceMaturity,
      },
      change: { changeNote: "归档记录", sourceKind: "app_manual", sourceForm: "user_original" },
    });
    await expect(service.create({ ...preferenceRequest(), requestId: "standing-4" }))
      .resolves.toMatchObject({ status: "duplicate", knowledgeStatus: "archived" });
    await expect(service.create({
      ...preferenceRequest(), requestId: "standing-7", sourceClient: "manual", sourceKind: "app_manual", sourceForm: "user_original",
    })).resolves.toMatchObject({ status: "updated", knowledgeStatus: "active" });
  });

  it("leaves a preference an agent recorded as it is once the user changed it in Obsidian", async () => {
    const { readFile, readdir, writeFile } = await import("node:fs/promises");
    const vault = await mkdtemp(join(tmpdir(), "active-record-obsidian-"));
    const journalRepository = new JournalEntryRepository(vault);
    const service = new ActiveRecordService({
      decisionStore: { save: vi.fn(async () => ({ indexed: true })) },
      decisionIndex: { findByCaptureSemanticKey: () => null },
      journalRepository,
      idFactory: () => "preference-1",
      clock: () => new Date("2026-10-03T10:00:00.000Z"),
    });
    await service.create(preferenceRequest());
    // Made a hard constraint with no exception, in Obsidian: no revision of the app's says so.
    const folder = join(vault, "Decision Journal", "preferences");
    const [name] = await readdir(folder);
    const path = join(folder, name!);
    const edited = (await readFile(path, "utf8"))
      .replace("preference_strength: default", "preference_strength: hard_constraint")
      .replace(preferenceRequest().exceptions, "没有例外。");
    await writeFile(path, edited, "utf8");

    // Restated by an agent, softer and with a loophole: it wrote over what the user had just made of it.
    await expect(service.create({ ...preferenceRequest(), requestId: "agent-again", strength: "weak_signal", exceptions: "赶时间可以跳过。" }))
      .resolves.toMatchObject({ status: "duplicate" });
    expect(await readFile(path, "utf8")).toBe(edited);
  });

  it("leaves a preference the user wrote as it is when an agent restates it, and files an agent's decision as the agent's", async () => {
    const vault = await mkdtemp(join(tmpdir(), "active-record-user-own-"));
    const journalRepository = new JournalEntryRepository(vault);
    const save = vi.fn(async () => ({ indexed: true }));
    const service = new ActiveRecordService({
      decisionStore: { save },
      decisionIndex: { findByCaptureSemanticKey: () => null },
      journalRepository,
      idFactory: () => "record-1",
      clock: () => new Date("2026-10-03T10:00:00.000Z"),
    });
    const user = { sourceClient: "manual" as const, sourceKind: "app_manual" as const, sourceForm: "user_original" as const };
    await service.create({ ...preferenceRequest(), ...user, strength: "hard_constraint" });

    // An agent (or a prompt that reached it) restating it with a loophole, or archiving it: the user's own
    // words stood with the agent's in them, and every later agent was read the loophole as the user's.
    for (const restated of [
      { exceptions: "智能体判断紧急时可以不问。", strength: "weak_signal" as const },
      { knowledgeStatus: "archived" as const },
    ]) {
      await expect(service.create({ ...preferenceRequest(), requestId: "agent-restated", ...restated }))
        .resolves.toMatchObject({ status: "duplicate", knowledgeStatus: "active" });
    }
    expect(await journalRepository.find("record-1")).toMatchObject({
      revision: 1, strength: "hard_constraint", exceptions: preferenceRequest().exceptions, sourceForm: "user_original",
    });

    const { appliesWhen: _when, exceptions: _exceptions, ...agent } = preferenceRequest();
    await service.create({ ...agent, requestId: "agent-decision", kind: "decision", title: "后台任务用哪个队列？", content: "沿用现有的 Redis。", options: [] });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ sourceClient: "codex", sourceKind: "agent_capture" }));
  });

  it("refuses a revision made from a copy the entry has since moved on from", async () => {
    const vault = await mkdtemp(join(tmpdir(), "active-record-stale-"));
    const journalRepository = new JournalEntryRepository(vault);
    const service = new ActiveRecordService({
      decisionStore: { save: vi.fn(async () => ({ indexed: true })) },
      decisionIndex: { findByCaptureSemanticKey: () => null },
      journalRepository,
      idFactory: () => "preference-1",
      clock: () => new Date("2026-09-30T10:00:00.000Z"),
    });
    await service.create(preferenceRequest());
    const shown = (await journalRepository.find("preference-1"))!;
    if (shown.kind !== "preference") throw new Error("expected a preference");
    // The page still shows v1 when an agent restates the preference with a new exception: v2.
    await service.create({ ...preferenceRequest(), requestId: "preference-request-2", exceptions: "需要用户签字的发布。" });

    const archive = (basis: string) => service.reviseJournalEntry("preference-1", {
      draft: {
        kind: "preference", title: shown.title, content: shown.content, knowledgeStatus: "archived",
        context: shown.context, rationale: shown.rationale, tags: [...shown.tags],
        appliesWhen: shown.appliesWhen, exceptions: shown.exceptions,
        strength: shown.strength, evidenceMaturity: shown.evidenceMaturity,
      },
      change: { changeNote: "归档记录", sourceKind: "app_manual", sourceForm: "user_original" },
      basis,
    });
    // Archived from the stale copy, v3 put the old exception back without a word.
    await expect(archive(journalEntryBasis(shown))).rejects.toThrow(/又被更新过/u);
    expect(await journalRepository.find("preference-1")).toMatchObject({ revision: 2, exceptions: "需要用户签字的发布。" });
    await expect(archive(journalEntryBasis((await journalRepository.find("preference-1"))!)))
      .resolves.toMatchObject({ revision: 3, knowledgeStatus: "archived" });
  });

  it("says what the latest read found, even when an earlier read finishes after it", async () => {
    const releases: Array<() => void> = [];
    const results = [
      { entries: [], diagnostics: [{ path: "/vault/手改坏的偏好.md", message: "unreadable" }] },
      { entries: [], diagnostics: [] },
    ];
    let calls = 0;
    const journalRepository = {
      list: () => {
        const result = results[calls++]!;
        return new Promise((resolve) => releases.push(() => resolve(result)));
      },
    } as unknown as JournalEntryRepository;
    const said: number[] = [];
    const service = new ActiveRecordService({
      decisionStore: { save: vi.fn(async () => ({ indexed: true })) },
      decisionIndex: { findByCaptureSemanticKey: () => null },
      journalRepository,
      idFactory: () => "unused",
      onJournalScan: (diagnostics) => said.push(diagnostics.length),
    });

    // The first read saw the note still broken; the second, begun after it was fixed, sees it read.
    const earlier = service.listJournalEntries();
    const later = service.listJournalEntries();
    releases[1]!();
    await later;
    releases[0]!();
    await earlier;

    expect(said).toEqual([0]);
  });

  it("says which preference or idea notes it could not read, and stops once they read again", async () => {
    const { unlink, writeFile } = await import("node:fs/promises");
    const vault = await mkdtemp(join(tmpdir(), "active-record-journal-"));
    const scans: string[][] = [];
    const service = new ActiveRecordService({
      decisionStore: { save: vi.fn(async () => ({ indexed: true })) },
      decisionIndex: { findByCaptureSemanticKey: () => null },
      journalRepository: new JournalEntryRepository(vault),
      idFactory: () => "preference-1",
      onJournalScan: (diagnostics) => scans.push(diagnostics.map((diagnostic) => diagnostic.path)),
    });
    await service.create(preferenceRequest());
    // Edited in Obsidian into something the app cannot read.
    const broken = join(vault, "Decision Journal", "preferences", "手改坏的偏好.md");
    await writeFile(broken, "---\ntype: decision-journal-entry\n: [\n---\n", "utf8");

    expect(await service.listJournalEntries()).toHaveLength(1);
    expect(scans.at(-1)).toEqual([broken]);

    await unlink(broken);
    await service.listJournalEntries();
    expect(scans.at(-1)).toEqual([]);
  });

  it("leaves a list it could not read at all to its own error, with no notes said unreadable under it", async () => {
    const { chmod, writeFile } = await import("node:fs/promises");
    const vault = await mkdtemp(join(tmpdir(), "active-record-journal-folder-"));
    const scans: string[][] = [];
    const service = new ActiveRecordService({
      decisionStore: { save: vi.fn(async () => ({ indexed: true })) },
      decisionIndex: { findByCaptureSemanticKey: () => null },
      journalRepository: new JournalEntryRepository(vault),
      idFactory: () => "preference-1",
      onJournalScan: (diagnostics) => scans.push(diagnostics.map((diagnostic) => diagnostic.path)),
    });
    await service.create(preferenceRequest());
    const preferences = join(vault, "Decision Journal", "preferences");
    const broken = join(preferences, "手改坏的偏好.md");
    await writeFile(broken, "---\ntype: decision-journal-entry\n: [\n---\n", "utf8");
    await service.listJournalEntries();
    expect(scans.at(-1)).toEqual([broken]);
    // A sync tool, or a chown after a sudo run: the folder itself can no longer be listed.
    await chmod(preferences, 0o000);
    try {
      // The list shows this error, and an agent's consultation is told it. Said as one more note it could not
      // read, it was "1 篇…：preferences, check its properties" under it.
      await expect(service.listJournalEntries()).rejects.toThrow();
      expect(scans.at(-1)).toEqual([]);
    } finally {
      await chmod(preferences, 0o700);
    }

    await service.listJournalEntries();
    expect(scans.at(-1)).toEqual([broken]);
  });

  it("counts only notes as ones to check in Obsidian; a folder or a note iCloud holds says its own reason", () => {
    const preferences = "/vault/Decision Journal/preferences";
    expect(journalNotice([])).toBeUndefined();
    expect(journalNotice([
      { path: `${preferences}/手改坏的偏好.md`, message: "Nested mappings are not allowed in compact mappings at line 2" },
      { path: `${preferences}/2026-10`, message: "无法读取这个文件夹，没有读取它的权限" },
      { path: `${preferences}/.先写测试.md.icloud`, message: "这篇笔记被 iCloud 移到了云端（优化 Mac 储存空间），还没下载回本机；在 Finder 里下载后即可读取。" },
    ])).toBe(
      "1 篇偏好或想法笔记读不出来，没有出现在列表里：手改坏的偏好.md。在 Obsidian 中检查它们的属性后会自动出现。"
        + "2 处偏好或想法这次没能读取：2026-10（无法读取这个文件夹，没有读取它的权限）；"
        + "先写测试.md（这篇笔记被 iCloud 移到了云端（优化 Mac 储存空间），还没下载回本机；在 Finder 里下载后即可读取）。",
    );
  });

  it("routes a manual decision through the existing decision store", async () => {
    const vault = await mkdtemp(join(tmpdir(), "active-record-decision-"));
    const repository = new MarkdownRepository(vault);
    const index = new SqliteIndex(join(vault, "index.sqlite"));
    const store = new DecisionStore(repository, index);
    const save = vi.spyOn(store, "save");
    const service = new ActiveRecordService({
      decisionStore: store,
      decisionIndex: index,
      journalRepository: new JournalEntryRepository(vault),
      idFactory: () => "decision-1",
      clock: () => new Date("2026-08-26T10:00:00.000Z"),
    });

    const result = await service.create({
      recordVersion: 1,
      requestId: "decision-request-1",
      sourceClient: "manual",
      sourceKind: "offline_conversation",
      sourceForm: "user_paraphrase",
      sensitivity: "private",
      project: "decision",
      kind: "decision",
      title: "线下讨论后是否采用渐进式记录？",
      content: "先快速捕获，再澄清为有效记录。",
      rationale: "减少记录摩擦。",
      expectedOutcome: "值得复用的信息不会丢失。",
      reviewDueDate: "2026-10-01",
      options: [],
      tags: [],
    });

    expect(result).toMatchObject({
      status: "created",
      recordKind: "decision",
      recordId: "decision-1",
      sensitivity: "private",
      storedTranscript: false,
    });
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceClient: "manual",
        selectedAnswer: {
          kind: "custom",
          values: ["先快速捕获，再澄清为有效记录。"],
        },
        expectedOutcome: "值得复用的信息不会丢失。",
        reviewDueDate: "2026-10-01",
      }),
    );
    expect(index.queryDecisions({ decisionId: "decision-1" })[0]?.reviewDueDate).toBe("2026-10-01");
    expect((await repository.scan()).notes[0]?.record.reviewDueDate).toBe("2026-10-01");
    index.close();
  });
});
