import {
  createJournalEntry,
  reviseJournalEntry,
  type JournalEntry,
} from "@cognelis/decision-core";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  JournalEntryRepository,
  parseJournalEntry,
  serializeJournalEntry,
} from "../src/index.js";

const preference = (id = "preference-1"): JournalEntry =>
  createJournalEntry(
    {
      kind: "preference",
      title: "常规实现决策默认由系统自主完成",
      content: "普通可逆的方向与实现由系统自行判断并交付结果。",
      appliesWhen: "既定目标和仓库范围内的普通产品与工程取舍。",
      exceptions: "权限、付费、不可逆操作、公开范围或核心验收冲突。",
      strength: "default",
      evidenceMaturity: "self_declared",
      context: "用户明确要求不要反复确认。",
      rationale: "减少低价值打断。",
      tags: ["协作偏好"],
    },
    {
      sourceKind: "agent_capture",
      sourceForm: "machine_summary",
      project: "decision",
      occurredAt: "2026-08-26T09:55:00.000Z",
      sensitivity: "private",
    },
    id,
    new Date("2026-08-26T10:00:00.000Z"),
  );

describe("JournalEntryRepository", () => {
  it("round-trips a readable scoped preference", () => {
    const entry = preference();
    const markdown = serializeJournalEntry(entry);

    expect(markdown).toContain("type: decision-journal-entry");
    expect(markdown).toContain("record_kind: preference");
    expect(markdown).toContain("## 当前偏好");
    expect(markdown).toContain("## 适用条件");
    expect(markdown).toContain("## 例外与边界");
    expect(markdown).toContain("machine_summary");
    expect(parseJournalEntry(markdown)).toEqual(entry);
  });

  it("keeps a language-specific entry's languages as a property, and writes a general one as before", () => {
    const general = preference();
    const generalNote = serializeJournalEntry(general);
    expect(generalNote).not.toContain("languages");
    // The hash the app kept before languages were: unchanged, a general note is not taken for one changed in Obsidian.
    const { languages: _none, ...before } = general;
    const sorted = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
      item !== null && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => (left < right ? -1 : 1)))
        : item);
    expect(generalNote).toContain(`app_written: ${createHash("sha256").update(sorted(before), "utf8").digest("hex")}`);

    const specific = createJournalEntry({ kind: "preference", title: "错误一律包一层上下文", content: "返回错误时用 fmt.Errorf 包装。", languages: ["Go"] },
      { sourceKind: "app_manual", sourceForm: "user_original" }, "go-1", new Date("2026-08-26T10:00:00.000Z"));
    const note = serializeJournalEntry(specific);
    expect(note).toMatch(/\nlanguages:\n {2}- go\n/u);
    expect(parseJournalEntry(note)).toEqual(specific);
    // Typed in Obsidian as one value, as a list property holding one is written.
    expect(parseJournalEntry(note.replace(/\nlanguages:\n {2}- go\n/u, "\nlanguages: golang\n")).languages).toEqual(["go"]);
  });

  it("takes the languages out of the note when a revision makes the entry general", async () => {
    const vault = await mkdtemp(join(tmpdir(), "decision-journal-languages-"));
    const repository = new JournalEntryRepository(vault);
    const { entry } = await repository.create(createJournalEntry({ kind: "idea", title: "试试 Rust 的 newtype", content: "给 id 包一层类型。", languages: ["rust"] },
      { sourceKind: "app_manual", sourceForm: "user_original" }, "idea-rust", new Date("2026-08-26T10:00:00.000Z")));
    const revised = reviseJournalEntry(entry, { kind: "idea", title: entry.title, content: entry.content, languages: [] },
      { changeNote: "各语言都适用", sourceKind: "app_manual", sourceForm: "user_original" }, new Date("2026-08-27T10:00:00.000Z"));
    await repository.revise(entry.id, revised);

    const directory = join(vault, "Decision Journal", "ideas", "2026", "08");
    const note = await readFile(join(directory, (await readdir(directory)).find((name) => name.endsWith(".md"))!), "utf8");
    // Left in the note, the cleared languages were read back, and the entry still kept to Rust.
    expect(note).not.toMatch(/^languages:/mu);
    expect((await repository.find(entry.id))?.languages).toEqual([]);
  });

  it("round-trips an idea and its append-only revision snapshot", () => {
    const initial = createJournalEntry(
      { kind: "idea", title: "冲突提示", content: "冲突时建议重审。" },
      {
        sourceKind: "app_manual",
        sourceForm: "user_original",
        sensitivity: "private",
      },
      "idea-1",
      new Date("2026-08-26T10:00:00.000Z"),
    );
    const revised = reviseJournalEntry(
      initial,
      {
        kind: "idea",
        title: initial.title,
        content: initial.content,
        knowledgeStatus: "active",
        ideaForm: "hypothesis",
        whyInteresting: "比定时提醒更少打扰。",
        openQuestions: ["怎样识别真实冲突？"],
        nextTest: "先展示只读冲突原因。",
        incubateUntil: "2026-09-26",
      },
      {
        changeNote: "补充验证方式",
        sourceKind: "app_manual",
        sourceForm: "user_original",
      },
      new Date("2026-08-27T10:00:00.000Z"),
    );

    const markdown = serializeJournalEntry(revised);
    expect(markdown).toContain("### v2 · 2026-08-27T10:00:00.000Z");
    expect(markdown).toContain("补充验证方式");
    expect(parseJournalEntry(markdown)).toEqual(revised);
  });

  it("lists what it can read when a month's folder cannot be read, and says which folder", async () => {
    const { chmod } = await import("node:fs/promises");
    const vault = await mkdtemp(join(tmpdir(), "decision-journal-locked-"));
    const repository = new JournalEntryRepository(vault);
    const idea = (id: string, month: number) => createJournalEntry(
      { kind: "idea", title: `想法 ${id}`, content: `${id} 的内容。`, ideaForm: "possibility", whyInteresting: null, openQuestions: [], nextTest: null, incubateUntil: null, context: null, rationale: null, tags: [] },
      { sourceKind: "app_manual", sourceForm: "user_original", project: "decision", occurredAt: null, sensitivity: "private" },
      id,
      new Date(Date.UTC(2026, month, 1)),
    );
    await repository.create(preference());
    await repository.create(idea("idea-august", 7));
    await repository.create(idea("idea-september", 8));
    // macOS's ._ copy beside a note on exFAT or a share is no entry that "cannot be read".
    const preferences = join(vault, "Decision Journal", "preferences");
    const [note] = await readdir(preferences);
    await writeFile(join(preferences, `._${note}`), Buffer.from([0, 5, 22, 7]));
    const locked = join(vault, "Decision Journal", "ideas", "2026", "08");
    await chmod(locked, 0o000);
    try {
      // One such folder made every list, lookup and record fail, an agent's included.
      const scan = await repository.list({ everything: true });
      expect(scan.entries.map((entry) => entry.id).sort()).toEqual(["idea-september", "preference-1"]);
      expect(scan.diagnostics).toEqual([expect.objectContaining({ path: locked })]);
    } finally {
      await chmod(locked, 0o700);
    }
  });

  it("keeps an entry sent with Windows line breaks, an escaped heading or backslashes before a marker, as its note reads it", async () => {
    const vault = await mkdtemp(join(tmpdir(), "decision-journal-kept-"));
    const repository = new JournalEntryRepository(vault);
    const sent = createJournalEntry(
      { kind: "idea", title: "换行", content: "第一行\r\n第二行 \\#\\# 不是标题 \\\\<!-- decision:rationale-end -->", ideaForm: "possibility", whyInteresting: null, openQuestions: [], nextTest: null, incubateUntil: null, context: null, rationale: null, tags: [] },
      { sourceKind: "agent_capture", sourceForm: "machine_summary", project: "decision", occurredAt: null, sensitivity: "private" },
      "idea-crlf",
      new Date("2026-10-03T10:00:00.000Z"),
    );

    // Not read back exactly as sent, it was refused, and the agent told it might not have been recorded.
    const { created, entry } = await repository.create(sent);
    expect(created).toBe(true);
    // Each reading took one more backslash off before the marker: read once, it still read back as another text.
    expect(entry.content).toBe("第一行\n第二行 ## 不是标题 <!-- decision:rationale-end -->");
    expect(await repository.find("idea-crlf")).toEqual(entry);
  });

  it("atomically creates, scans, deduplicates, and revises entries", async () => {
    const vault = await mkdtemp(join(tmpdir(), "decision-journal-entry-"));
    const repository = new JournalEntryRepository(vault);
    const entry = preference();

    const first = await repository.create(entry);
    const duplicate = await repository.create(preference("other-id"));
    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.entry.id).toBe(entry.id);

    const revised = reviseJournalEntry(
      first.entry,
      {
        kind: "preference",
        title: first.entry.title,
        content: "普通可逆的实现由系统自行完成，并给出验证结果。",
        appliesWhen: first.entry.kind === "preference" ? first.entry.appliesWhen : null,
        exceptions: first.entry.kind === "preference" ? first.entry.exceptions : null,
        strength: "default",
        evidenceMaturity: "self_declared",
      },
      {
        changeNote: "明确需要验证结果",
        sourceKind: "app_manual",
        sourceForm: "user_original",
      },
      new Date("2026-08-27T10:00:00.000Z"),
    );
    const stored = await repository.revise(entry.id, revised);
    expect(stored.revision).toBe(2);
    expect((await repository.find(entry.id))?.content).toContain("验证结果");

    const scan = await repository.list({ query: "验证结果", limit: 20 });
    expect(scan.entries).toHaveLength(1);
    expect(scan.diagnostics).toEqual([]);
    const directory = join(vault, "Decision Journal", "preferences");
    expect((await readdir(directory)).filter((name) => name.endsWith(".md"))).toHaveLength(1);
  });

  it("reads an entry saved with Windows line endings and a BOM, and revises it keeping them", async () => {
    const vault = await mkdtemp(join(tmpdir(), "decision-journal-crlf-"));
    const repository = new JournalEntryRepository(vault);
    const { entry } = await repository.create(preference());
    const directory = join(vault, "Decision Journal", "preferences");
    const [name] = (await readdir(directory)).filter((file) => file.endsWith(".md"));
    const path = join(directory, name!);
    // Checked out by Git for Windows (autocrlf on by default): read as it was, it left every list.
    await writeFile(path, `﻿${(await readFile(path, "utf8")).replaceAll("\n", "\r\n")}`);
    expect((await repository.list()).entries.map((item) => item.id)).toEqual([entry.id]);

    const revised = reviseJournalEntry(
      entry,
      {
        kind: "preference",
        title: entry.title,
        content: "普通可逆的实现由系统自行完成，并给出验证结果。",
        appliesWhen: entry.kind === "preference" ? entry.appliesWhen : null,
        exceptions: entry.kind === "preference" ? entry.exceptions : null,
        strength: "default",
        evidenceMaturity: "self_declared",
      },
      { changeNote: "明确需要验证结果", sourceKind: "app_manual", sourceForm: "user_original" },
      new Date("2026-08-27T10:00:00.000Z"),
    );
    await repository.revise(entry.id, revised);
    const written = await readFile(path, "utf8");
    expect(written.startsWith("﻿---\r\n")).toBe(true);
    expect(written).not.toMatch(/[^\r]\n/u);
    expect((await repository.find(entry.id))?.content).toContain("验证结果");
  });

  it("keeps what the reader added in Obsidian when the app revises an entry", async () => {
    const vault = await mkdtemp(join(tmpdir(), "decision-journal-entry-"));
    const repository = new JournalEntryRepository(vault);
    const { entry } = await repository.create(preference());
    if (entry.kind !== "preference") throw new Error("expected a preference");
    const folder = join(vault, "Decision Journal", "preferences");
    const path = join(folder, (await readdir(folder)).find((name) => name.endsWith(".md"))!);
    // Edited in Obsidian: a property of their own, a link after a section, a section of their own.
    const written = await readFile(path, "utf8");
    await writeFile(path, written
      .replace("---\ntype:", "---\naliases:\n  - 结构化错误偏好\nticket: 0042\ntype:")
      .replace("<!-- decision:journal-context-end -->", "<!-- decision:journal-context-end -->\n\n另见 [[接口错误码清单]]")
      .concat("\n## 我的补充\n\n只对外部接口生效。\n"));

    const revised = reviseJournalEntry(
      (await repository.find(entry.id))!,
      {
        kind: "preference", title: entry.title, content: entry.content, knowledgeStatus: "archived",
        context: entry.context, rationale: entry.rationale, tags: [...entry.tags],
        appliesWhen: entry.appliesWhen, exceptions: entry.exceptions,
        strength: entry.strength, evidenceMaturity: entry.evidenceMaturity,
      },
      { changeNote: "归档", sourceKind: "app_manual", sourceForm: "user_original" },
      new Date("2026-08-27T10:00:00.000Z"),
    );
    await repository.revise(entry.id, revised);

    // Written out whole, one click on 归档 took all of it.
    const note = await readFile(path, "utf8");
    for (const kept of ["结构化错误偏好", "ticket: 0042\n", "另见 [[接口错误码清单]]", "## 我的补充", "只对外部接口生效。"]) expect(note).toContain(kept);
    expect(await repository.find(entry.id)).toMatchObject({ knowledgeStatus: "archived", revision: 2 });
  });

  it("keeps a heading the reader put above the app's title when a revision changes the title", async () => {
    const vault = await mkdtemp(join(tmpdir(), "decision-journal-heading-"));
    const repository = new JournalEntryRepository(vault);
    const { entry } = await repository.create(preference());
    if (entry.kind !== "preference") throw new Error("expected a preference");
    const folder = join(vault, "Decision Journal", "preferences");
    const path = join(folder, (await readdir(folder)).find((name) => name.endsWith(".md"))!);
    // In Obsidian the reader puts a heading and a paragraph of their own above the app's part.
    await writeFile(path, (await readFile(path, "utf8")).replace(`\n# ${entry.title}\n`, `\n# 迁移笔记\n\n从旧仓库搬来的偏好。\n\n# ${entry.title}\n`), "utf8");
    // Read as the first heading, the reader's was listed as the entry's title.
    expect(await repository.find(entry.id)).toMatchObject({ title: entry.title });

    const revised = reviseJournalEntry(
      (await repository.find(entry.id))!,
      {
        kind: "preference", title: "实现决策默认自主完成", content: entry.content, knowledgeStatus: entry.knowledgeStatus,
        context: entry.context, rationale: entry.rationale, tags: [...entry.tags],
        appliesWhen: entry.appliesWhen, exceptions: entry.exceptions,
        strength: entry.strength, evidenceMaturity: entry.evidenceMaturity,
      },
      { changeNote: "改标题", sourceKind: "app_manual", sourceForm: "user_original" },
      new Date("2026-08-27T10:00:00.000Z"),
    );
    await repository.revise(entry.id, revised);

    // Written over the first heading, the reader's was gone and the app's title stood twice.
    const note = await readFile(path, "utf8");
    expect(note).toContain("# 迁移笔记\n\n从旧仓库搬来的偏好。\n\n# 实现决策默认自主完成\n");
    expect(note).not.toContain(`# ${entry.title}\n`);
    expect(await repository.find(entry.id)).toMatchObject({ title: "实现决策默认自主完成", revision: 2 });
  });

  const retitled = (entry: JournalEntry, title: string, at: string) => {
    if (entry.kind !== "preference") throw new Error("expected a preference");
    return reviseJournalEntry(
      entry,
      {
        kind: "preference", title, content: entry.content, knowledgeStatus: entry.knowledgeStatus,
        context: entry.context, rationale: entry.rationale, tags: [...entry.tags],
        appliesWhen: entry.appliesWhen, exceptions: entry.exceptions,
        strength: entry.strength, evidenceMaturity: entry.evidenceMaturity,
      },
      { changeNote: "改标题", sourceKind: "app_manual", sourceForm: "user_original" },
      new Date(at),
    );
  };

  it("knows its own title by the note's title property, with a heading of the reader's between it and its first section", async () => {
    const vault = await mkdtemp(join(tmpdir(), "decision-journal-title-"));
    const repository = new JournalEntryRepository(vault);
    const { entry } = await repository.create(preference());
    const folder = join(vault, "Decision Journal", "preferences");
    const path = join(folder, (await readdir(folder)).find((name) => name.endsWith(".md"))!);
    expect(await readFile(path, "utf8")).toContain(`\ntitle: ${entry.title}\n`);
    await writeFile(path, (await readFile(path, "utf8")).replace(`\n# ${entry.title}\n`, `\n# ${entry.title}\n\n# 我的批注\n\n读者自己的话。\n`), "utf8");

    // Read as the heading nearest the app's part, the reader's stood as the title, and a save was refused.
    expect(await repository.find(entry.id)).toMatchObject({ title: entry.title });
    await repository.revise(entry.id, retitled((await repository.find(entry.id))!, entry.title, "2026-08-27T10:00:00.000Z"));
    expect(await readFile(path, "utf8")).toContain(`\n# ${entry.title}\n\n# 我的批注\n\n读者自己的话。\n`);

    await repository.revise(entry.id, retitled((await repository.find(entry.id))!, "实现决策默认自主完成", "2026-08-28T10:00:00.000Z"));
    const note = await readFile(path, "utf8");
    expect(note).toContain("\n# 实现决策默认自主完成\n\n# 我的批注\n\n读者自己的话。\n");
    expect(note).toContain("\ntitle: 实现决策默认自主完成\n");
    expect(await repository.find(entry.id)).toMatchObject({ title: "实现决策默认自主完成", revision: 3 });
  });

  it("reads and revises a note from before the title property as before, not as one edited in Obsidian", async () => {
    const vault = await mkdtemp(join(tmpdir(), "decision-journal-old-title-"));
    const repository = new JournalEntryRepository(vault);
    const { entry } = await repository.create(preference());
    const folder = join(vault, "Decision Journal", "preferences");
    const path = join(folder, (await readdir(folder)).find((name) => name.endsWith(".md"))!);
    const old = (await readFile(path, "utf8")).replace(/^title: .*\n/mu, "");
    expect(old).toContain("\napp_written: ");
    await writeFile(path, old, "utf8");

    // Its app_written hash and fingerprint still match: found again, and not taken for one changed in Obsidian.
    expect(await repository.create(preference("other-id"))).toMatchObject({ created: false, editedOutsideApp: false, entry: { id: entry.id, title: entry.title } });

    // Without the property, a heading of the reader's between the title and the first section is refused, as it was.
    const annotated = old.replace(`\n# ${entry.title}\n`, `\n# ${entry.title}\n\n# 我的批注\n`);
    await writeFile(path, annotated, "utf8");
    await expect(repository.revise(entry.id, retitled((await repository.find(entry.id))!, entry.title, "2026-08-27T10:00:00.000Z")))
      .rejects.toThrow("App 分不清哪一行才是标题");
    expect(await readFile(path, "utf8")).toBe(annotated);

    await writeFile(path, old, "utf8");
    await repository.revise(entry.id, retitled((await repository.find(entry.id))!, "实现决策默认自主完成", "2026-08-27T10:00:00.000Z"));
    const note = await readFile(path, "utf8");
    expect(note).toContain("\ntitle: 实现决策默认自主完成\n");
    expect(note).toContain("\n# 实现决策默认自主完成\n");
    expect(await repository.find(entry.id)).toMatchObject({ title: "实现决策默认自主完成", revision: 2 });
  });

  it("refuses to revise a note holding a byte that is not UTF-8, rather than write a replacement character into it", async () => {
    const vault = await mkdtemp(join(tmpdir(), "decision-journal-bytes-"));
    const repository = new JournalEntryRepository(vault);
    const { entry } = await repository.create(preference());
    if (entry.kind !== "preference") throw new Error("expected a preference");
    const folder = join(vault, "Decision Journal", "preferences");
    const path = join(folder, (await readdir(folder)).find((name) => name.endsWith(".md"))!);
    // A section the reader appended with an editor that wrote Latin-1: "café", its é the one byte 0xE9.
    const edited = Buffer.concat([await readFile(path), Buffer.from("\n## 我的补充\n\ncaf", "utf8"), Buffer.from([0xe9]), Buffer.from("\n", "utf8")]);
    await writeFile(path, edited);

    const revised = reviseJournalEntry(
      (await repository.find(entry.id))!,
      {
        kind: "preference", title: entry.title, content: entry.content, knowledgeStatus: "archived",
        context: entry.context, rationale: entry.rationale, tags: [...entry.tags],
        appliesWhen: entry.appliesWhen, exceptions: entry.exceptions,
        strength: entry.strength, evidenceMaturity: entry.evidenceMaturity,
      },
      { changeNote: "归档", sourceKind: "app_manual", sourceForm: "user_original" },
      new Date("2026-08-27T10:00:00.000Z"),
    );
    // Decoded with a replacement character, 归档 wrote the character into the file in the byte's place.
    await expect(repository.revise(entry.id, revised)).rejects.toThrow("不是 UTF-8 编码");
    expect(await readFile(path)).toEqual(edited);
  });

  it("keeps the reader's own formatting in a section the app writes again unchanged", async () => {
    const vault = await mkdtemp(join(tmpdir(), "decision-journal-entry-"));
    const repository = new JournalEntryRepository(vault);
    const { entry } = await repository.create(preference());
    const folder = join(vault, "Decision Journal", "preferences");
    const path = join(folder, (await readdir(folder)).find((name) => name.endsWith(".md"))!);
    // A screenshot pasted and a highlight typed in Obsidian.
    await writeFile(path, (await readFile(path, "utf8")).replace("交付结果。", "交付结果。<mark>重点</mark>\n\n![[Pasted image 1.png]]"));
    const found = (await repository.find(entry.id))!;
    if (found.kind !== "preference") throw new Error("expected a preference");

    await repository.revise(entry.id, reviseJournalEntry(
      found,
      {
        kind: "preference", title: found.title, content: found.content, knowledgeStatus: "archived",
        context: found.context, rationale: found.rationale, tags: [...found.tags],
        appliesWhen: found.appliesWhen, exceptions: found.exceptions,
        strength: found.strength, evidenceMaturity: found.evidenceMaturity,
      },
      { changeNote: "归档", sourceKind: "app_manual", sourceForm: "user_original" },
      new Date("2026-08-27T10:00:00.000Z"),
    ));

    // Written again escaped, the screenshot no longer showed and the highlight turned into text.
    expect(await readFile(path, "utf8")).toContain("交付结果。<mark>重点</mark>\n\n![[Pasted image 1.png]]");
  });

  it("writes an agent's Templater tag kept in the change history as text too", async () => {
    const vault = await mkdtemp(join(tmpdir(), "decision-journal-entry-"));
    const repository = new JournalEntryRepository(vault);
    const { entry } = await repository.create({ ...preference(), content: "用表格汇报 <%* tR = app.vault.getName() %>。" });
    if (entry.kind !== "preference") throw new Error("expected a preference");
    const revised = reviseJournalEntry(
      entry,
      {
        kind: "preference", title: entry.title, content: "用表格汇报。", knowledgeStatus: entry.knowledgeStatus,
        context: entry.context, rationale: entry.rationale, tags: [...entry.tags],
        appliesWhen: entry.appliesWhen, exceptions: entry.exceptions,
        strength: entry.strength, evidenceMaturity: entry.evidenceMaturity,
      },
      { changeNote: "改写", sourceKind: "app_manual", sourceForm: "user_original" },
      new Date("2026-08-27T10:00:00.000Z"),
    );
    await repository.revise(entry.id, revised);

    const folder = join(vault, "Decision Journal", "preferences");
    const note = await readFile(join(folder, (await readdir(folder)).find((name) => name.endsWith(".md"))!), "utf8");
    // The previous text, kept in the history block, held the tag as Templater runs it.
    expect(note).not.toContain("<%");
    expect((await repository.find(entry.id))?.revisionEvents).toEqual(revised.revisionEvents);
  });

  it("lists every entry for the app's own recall, an older standing preference among them", async () => {
    const vault = await mkdtemp(join(tmpdir(), "decision-journal-entry-"));
    const repository = new JournalEntryRepository(vault);
    await repository.create(preference());
    // Two hundred newer ideas on top of it: the 200 last updated no longer held the preference.
    for (let n = 0; n < 200; n += 1) {
      await repository.create(createJournalEntry(
        { kind: "idea", title: `想法 ${n}`, content: `第 ${n} 个想法。`, ideaForm: "possibility", whyInteresting: null, openQuestions: [], nextTest: null, incubateUntil: null, context: null, rationale: null, tags: [] },
        { sourceKind: "app_manual", sourceForm: "user_original", project: "decision", occurredAt: null, sensitivity: "private" },
        `idea-${n}`,
        new Date(Date.UTC(2026, 8, 1, 0, n)),
      ));
    }

    expect((await repository.list({ limit: 200 })).entries.map((entry) => entry.id)).not.toContain("preference-1");
    expect((await repository.list({ everything: true })).entries.map((entry) => entry.id)).toContain("preference-1");
    // Two hundred notes written one by one, each checked against those before it: seconds on their own, past the default
    // timeout when the whole suite runs on a loaded machine.
  }, 60_000);

  it("keeps text that quotes its own markers, and writes nothing it could not read back", async () => {
    const vault = await mkdtemp(join(tmpdir(), "decision-journal-markers-"));
    const repository = new JournalEntryRepository(vault);
    const source = { sourceKind: "app_manual", sourceForm: "user_original", sensitivity: "private" } as const;
    const content = "解析时遇到 <!-- decision:journal-content-end --> 这样的标记要先转义。\n<!-- decision:journal-content-end -->\n后面的话也要留下。";
    const quoting = createJournalEntry({ kind: "idea", title: "标记转义", content }, source, "idea-markers", new Date("2026-08-26T10:00:00.000Z"));
    await repository.create(quoting);
    expect((await repository.find("idea-markers"))?.content).toBe(content);
    // Read back whole, it is the same entry again rather than a second, shorter one.
    expect((await repository.create(quoting)).created).toBe(false);

    const split = createJournalEntry(
      { kind: "idea", title: "复盘提醒节奏", content: "按风险分级提醒。", openQuestions: ["高风险：提前 7 天\n低风险：提前 1 天"] },
      source, "idea-split", new Date("2026-08-26T10:00:00.000Z"),
    );
    await expect(repository.create(split)).rejects.toThrow("would not read back");
    // A note an editor touched, leaving spaces around a marker, still reads.
    const touched = serializeJournalEntry(quoting)
      .replace("<!-- decision:journal-content-start -->", "<!-- decision:journal-content-start -->  ")
      .replace("<!-- decision:journal-content-end -->\n\n", "  <!-- decision:journal-content-end -->\t\n\n");
    expect(parseJournalEntry(touched).content).toBe(content);
    const ideas = await readdir(join(vault, "Decision Journal", "ideas"), { recursive: true });
    expect(ideas.filter((name) => name.endsWith(".md"))).toHaveLength(1);
  });

  it("writes an agent's code into the note as text, which Obsidian then shows rather than runs", () => {
    const planted = {
      ...preference(),
      title: "报告格式 ` $= app.vault`",
      content: "用表格。\n\n```dataviewjs\nrequire(\"child_process\")\n```\n\n> ~~~js-engine\n> return 1\n> ~~~",
    };
    const note = serializeJournalEntry(planted);
    expect(note).not.toMatch(/```dataviewjs|~~~js-engine|(?<!\\)` \$=/u);
    expect(parseJournalEntry(note)).toEqual(planted);
  });

  it("searches the text a person can read, not field names or states, and still finds an entry by its id", async () => {
    const vault = await mkdtemp(join(tmpdir(), "decision-journal-search-"));
    const repository = new JournalEntryRepository(vault);
    const { entry } = await repository.create(preference());
    for (const word of ["source", "default", "manual", "appliesWhen", "self_declared"]) {
      expect((await repository.list({ query: word, limit: 20 })).entries).toEqual([]);
    }
    expect((await repository.list({ query: "低价值打断", limit: 20 })).entries.map((item) => item.id)).toEqual([entry.id]);
    expect((await repository.list({ query: entry.id, limit: 20 })).entries.map((item) => item.id)).toEqual([entry.id]);
  });

  it("finds an entry by words typed in the other width, as the decisions beside it are found", async () => {
    const vault = await mkdtemp(join(tmpdir(), "decision-journal-width-"));
    const repository = new JournalEntryRepository(vault);
    const { entry } = await repository.create({ ...preference(), title: "接口统一走 API 网关", content: "外部调用都经过网关限流。" });
    // Typed with the IME in full-width mode.
    expect((await repository.list({ query: "ＡＰＩ", limit: 20 })).entries.map((item) => item.id)).toEqual([entry.id]);
    expect((await repository.list({ query: "API网关", limit: 20 })).entries.map((item) => item.id)).toEqual([entry.id]);
  });

  it("does not say an entry is gone, when asked to be sure, while a note could not be read", async () => {
    const vault = await mkdtemp(join(tmpdir(), "decision-journal-sure-"));
    const repository = new JournalEntryRepository(vault);
    const { entry } = await repository.create(preference());
    expect(await repository.find(entry.id, { sure: true })).toEqual(entry);
    expect(await repository.find("preference-deleted", { sure: true })).toBeNull();

    // Another note moved off this Mac by iCloud: an entry not found may be that one.
    await writeFile(join(vault, "Decision Journal", "preferences", ".elsewhere.md.icloud"), "");
    await expect(repository.find("preference-deleted", { sure: true })).rejects.toThrow("不能确定这条已不在");
    // Asked as before, it answers as before.
    expect(await repository.find("preference-deleted")).toBeNull();
  });

  it("reads a tags property given as one value, as Obsidian writes a list holding one and the decision notes read it", () => {
    const note = serializeJournalEntry(preference()).replace(/^tags:\n  - 协作偏好$/mu, "tags: 协作偏好");
    expect(note).toContain("tags: 协作偏好");
    expect(parseJournalEntry(note).tags).toEqual(["协作偏好"]);
  });

  it("says which property was typed outside its values, rather than reading the entry and refusing it later", async () => {
    const vault = await mkdtemp(join(tmpdir(), "decision-journal-enum-"));
    const repository = new JournalEntryRepository(vault);
    await repository.create(preference());
    const folder = join(vault, "Decision Journal", "preferences");
    const path = join(folder, (await readdir(folder)).find((name) => name.endsWith(".md"))!);
    // Written in Obsidian the way the app's form names it.
    await writeFile(path, (await readFile(path, "utf8")).replace("preference_strength: default", "preference_strength: 硬约束"), "utf8");

    // Read as it stood, it was listed, then every archive and revision of it refused without naming the field.
    const scan = await repository.list();
    expect(scan.entries).toEqual([]);
    expect(scan.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([expect.stringContaining("preference_strength 的值「硬约束」无效")]);
  });

  it("lists a sync conflict's copy once and says it, and names the way out when asked to change either", async () => {
    const { copyFile } = await import("node:fs/promises");
    const vault = await mkdtemp(join(tmpdir(), "decision-journal-copy-"));
    const repository = new JournalEntryRepository(vault);
    const { entry } = await repository.create(preference());
    const folder = join(vault, "Decision Journal", "preferences");
    const [note] = await readdir(folder);
    await copyFile(join(folder, note!), join(folder, note!.replace(/\.md$/u, " 2.md")));

    // Shown twice under one key, and every action failed with "Multiple journal entries use ID".
    const scan = await repository.list();
    expect(scan.entries.map((item) => item.id)).toEqual([entry.id]);
    expect(scan.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([expect.stringContaining("同步冲突留下的副本")]);
    await expect(repository.find(entry.id)).rejects.toThrow("请在 Obsidian 里删掉多余的那篇后再试");
    await expect(repository.revise(entry.id, { ...entry, revision: 2 })).rejects.toThrow("请在 Obsidian 里删掉多余的那篇后再试");
    await expect(repository.revise("gone", { ...entry, id: "gone", revision: 2 })).rejects.toThrow("已经找不到了");
  });

  it("reports malformed notes without hiding valid records", async () => {
    const vault = await mkdtemp(join(tmpdir(), "decision-journal-diagnostic-"));
    const repository = new JournalEntryRepository(vault);
    await repository.create(preference());
    const directory = join(vault, "Decision Journal", "ideas", "2026", "08");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "broken.md"), "not a journal entry", "utf8");

    const scan = await repository.list();
    expect(scan.entries).toHaveLength(1);
    expect(scan.diagnostics).toHaveLength(1);
    const stored = await readFile(
      join(vault, "Decision Journal", "preferences", (await readdir(join(vault, "Decision Journal", "preferences")))[0]!),
      "utf8",
    );
    expect(stored).toContain("常规实现决策默认由系统自主完成");
  });

  it("puts an entry whose title holds the words searched for before newer ones that only mention them elsewhere", async () => {
    const vault = await mkdtemp(join(tmpdir(), "decision-journal-rank-"));
    const repository = new JournalEntryRepository(vault);
    const source = { sourceKind: "app_manual", sourceForm: "user_original", sensitivity: "private" } as const;
    await repository.create(createJournalEntry({ kind: "preference", title: "checkout 页面优先服务端渲染", content: "结算页首屏用服务端渲染。" },
      source, "pref-checkout", new Date("2026-09-01T00:00:00.000Z")));
    for (let n = 0; n < 5; n += 1) {
      await repository.create(createJournalEntry({ kind: "idea", title: `想法 ${n}`, content: `第 ${n} 个观察。` },
        { ...source, project: "checkout-web" }, `idea-${n}`, new Date(Date.UTC(2026, 8, 2, n))));
    }

    // Ranked by recency alone, the five newer ideas filed under a project of that name held ⌘K's five places.
    expect((await repository.list({ query: "checkout", limit: 5 })).entries[0]?.id).toBe("pref-checkout");
  });
});
