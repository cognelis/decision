import type { MethodologyRecord } from "@cognelis/decision-core";
import { mkdtemp, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  MethodologyRepository,
  parseMethodology,
  serializeMethodology,
} from "../src/index.js";

const fixture = (
  overrides: Partial<MethodologyRecord> = {},
): MethodologyRecord => ({
  id: "principle-1",
  createdAt: "2026-08-02T10:00:00.000Z",
  updatedAt: "2026-08-02T10:00:00.000Z",
  origin: "decision_evidence",
  status: "candidate",
  confirmedAt: null,
  title: "先保持可逆，再扩大改动",
  principle: "在信息不足时，优先选择可快速回退的实现。",
  appliesWhen: "需求仍可能变化，且多个方案都能满足当前目标。",
  caution: "当迁移成本会随时间快速增长时，需要重新评估。",
  evidenceSummary: "证据 1 显示该策略降低了返工成本。",
  sourceDecisionIds: ["decision-1"],
  confidence: "low",
  generation: {
    requestId: "methodology:request-1",
    profileId: "builtin-qwen",
    provider: "Qwen 本地模型",
    model: "qwen3.5-2b-q4-k-m",
  },
  ...overrides,
});

describe("MethodologyRepository", () => {
  it("saves a title broken over lines as the one line it is read back as", async () => {
    const repository = new MethodologyRepository(await mkdtemp(join(tmpdir(), "methodology-title-")));
    await repository.save(fixture({ title: "先保持可逆\n再扩大改动" }));
    await expect(repository.find("principle-1")).resolves.toMatchObject({ title: "先保持可逆 再扩大改动" });
  });

  it("refuses to save a principle into a vault folder that has gone", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-methodology-gone-"));
    await expect(new MethodologyRepository(join(root, "unmounted-vault"), { existingVault: true }).save(fixture()))
      .rejects.toThrow("找不到仓库目录");
    expect(await readdir(root)).toEqual([]);
  });

  it("round-trips current format markers", () => {
    const record = fixture();
    expect(parseMethodology(serializeMethodology(record))).toEqual(record);
  });

  it("round-trips a traceable methodology note", () => {
    const record = fixture();
    const markdown = serializeMethodology(record);

    expect(markdown).toContain("type: decision-methodology");
    expect(markdown).toContain("origin: decision_evidence");
    expect(markdown).toContain("source_decisions:\n  - decision-1");
    expect(markdown).toContain("## 证据摘要");
    expect(parseMethodology(markdown)).toEqual(record);
  });

  it("atomically saves, lists, and replaces the same principle", async () => {
    const vault = await mkdtemp(join(tmpdir(), "decision-methodology-"));
    const repository = new MethodologyRepository(vault);
    await repository.save(fixture());
    await repository.save(
      fixture({
        status: "accepted",
        confirmedAt: "2026-08-03T10:00:00.000Z",
        updatedAt: "2026-08-03T10:00:00.000Z",
        principle: "先验证可逆路径，再扩大不可逆改动。",
      }),
    );

    const records = await repository.list();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      status: "accepted",
      principle: "先验证可逆路径，再扩大不可逆改动。",
    });
    expect(await repository.find("principle-1")).toEqual(records[0]);
    const directory = join(vault, "Decision Journal", "principles");
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.md$/u);
    expect(await readFile(join(directory, files[0]!), "utf8")).toContain(
      "status: accepted",
    );
  });

  it("keeps what the reader added in Obsidian when a principle is saved again", async () => {
    const vault = await mkdtemp(join(tmpdir(), "decision-methodology-kept-"));
    const repository = new MethodologyRepository(vault);
    await repository.save(fixture({
      status: "accepted",
      confirmedAt: "2026-08-03T10:00:00.000Z",
      usageValidation: { reviewedAt: "2026-08-07T10:00:00.000Z", decisionId: "decision-validated-2", validatedAt: "2026-08-08T10:00:00.000Z" },
    }));
    const directory = join(vault, "Decision Journal", "principles");
    const [name] = await readdir(directory);
    const path = join(directory, name!);
    // Tagged, aliased and linked in Obsidian, with a section of the reader's own, saved by an editor on Windows.
    const edited = (await readFile(path, "utf8"))
      .replace("type: decision-methodology\n", "type: decision-methodology\ntags:\n  - 架构\naliases:\n  - 可逆优先\nticket: 0042\ntweet: 1790012345678901234\n")
      .concat("\n## 我的笔记\n\n见 [[迁移复盘]]。\n");
    await writeFile(path, `﻿${edited.replaceAll("\n", "\r\n")}`, "utf8");

    // Saved again with new wording and the usage cursor gone: one click took all of the reader's with it.
    await repository.save(fixture({
      status: "accepted",
      confirmedAt: "2026-08-03T10:00:00.000Z",
      updatedAt: "2026-08-09T10:00:00.000Z",
      principle: "先验证可逆路径，再扩大不可逆改动。",
    }));

    const saved = await readFile(path, "utf8");
    expect(saved.startsWith("﻿---\r\n")).toBe(true);
    expect(saved).not.toMatch(/[^\r]\n/u);
    // Re-rendered whole, 0042 came back as 42 and the id lost its last digits.
    expect(saved).toContain("tags:\r\n  - 架构\r\naliases:\r\n  - 可逆优先\r\nticket: 0042\r\ntweet: 1790012345678901234\r\n");
    expect(saved).toContain("## 我的笔记\r\n\r\n见 [[迁移复盘]]。");
    expect(saved).not.toContain("usage_validation");
    const read = await repository.find("principle-1");
    expect(read).toMatchObject({ principle: "先验证可逆路径，再扩大不可逆改动。", updatedAt: "2026-08-09T10:00:00.000Z" });
    expect(read?.usageValidation).toBeUndefined();
  });

  it("keeps the reader's own formatting in a section a save leaves unchanged, and escapes one it changes", async () => {
    const vault = await mkdtemp(join(tmpdir(), "decision-methodology-formatting-"));
    const repository = new MethodologyRepository(vault);
    await repository.save(fixture({ status: "accepted", confirmedAt: "2026-08-03T10:00:00.000Z" }));
    const directory = join(vault, "Decision Journal", "principles");
    const [name] = await readdir(directory);
    const path = join(directory, name!);
    // Formatted in Obsidian: a highlight, a heading of the reader's and an embed in the principle, a title underlined.
    const formatted = "在信息不足时，优先选择<mark>可快速回退</mark>的实现。\n\n### 例子\n\n![[rollback-diagram.png]]\n\n返回值写成 `Result<T>`。";
    await writeFile(path, (await readFile(path, "utf8"))
      .replace("在信息不足时，优先选择可快速回退的实现。", formatted)
      .replace("# 先保持可逆，再扩大改动", "# 先保持可逆，<u>再扩大改动</u>"));
    const current = (await repository.find("principle-1"))!;

    // 确认仍适用: only the usage validation changes. Written again escaped, the highlight, heading and embed turned
    // into literal text in Obsidian.
    await repository.save({ ...current, usageValidation: { reviewedAt: "2026-09-01T00:00:00.000Z", decisionId: "decision-2", validatedAt: "2026-10-05T00:00:00.000Z" } });
    const saved = await readFile(path, "utf8");
    expect(saved).toContain(formatted);
    expect(saved).toContain("# 先保持可逆，<u>再扩大改动</u>\n");
    expect(saved).toContain("usage_validation_decision: decision-2");

    // Changed text is written escaped, as the app writes every text.
    await repository.save({ ...current, principle: "先回退 <img src=x>，再扩大。" });
    expect(await readFile(path, "utf8")).toContain("先回退 \\<img src=x>，再扩大。");
  });

  it("keeps a heading the reader put above the app's title, and rewrites the app's own title line", async () => {
    const vault = await mkdtemp(join(tmpdir(), "decision-methodology-heading-"));
    const repository = new MethodologyRepository(vault);
    await repository.save(fixture());
    const directory = join(vault, "Decision Journal", "principles");
    const path = join(directory, (await readdir(directory))[0]!);
    // In Obsidian the reader puts a heading and a paragraph of their own above the app's part.
    await writeFile(path, (await readFile(path, "utf8")).replace("\n# 先保持可逆，再扩大改动\n", "\n# 迁移笔记\n\n这条原则来自 2026-08 的迁移。\n\n# 先保持可逆，再扩大改动\n"), "utf8");
    // Read as the first heading, the reader's was listed as the principle's title.
    expect(await repository.find("principle-1")).toMatchObject({ title: "先保持可逆，再扩大改动" });

    // Retitled in the app: written over the first heading, the reader's was gone and the app's title stood twice.
    await repository.save(fixture({ title: "先验证可逆路径", updatedAt: "2026-08-04T10:00:00.000Z" }));

    const saved = await readFile(path, "utf8");
    expect(saved).toContain("# 迁移笔记\n\n这条原则来自 2026-08 的迁移。\n\n# 先验证可逆路径\n");
    expect(saved).not.toContain("# 先保持可逆，再扩大改动");
    expect(await repository.find("principle-1")).toMatchObject({ title: "先验证可逆路径" });
  });

  it("knows its own title by the note's title property, with a heading of the reader's between it and its first section", async () => {
    const vault = await mkdtemp(join(tmpdir(), "decision-methodology-heading-between-"));
    const repository = new MethodologyRepository(vault);
    await repository.save(fixture());
    const directory = join(vault, "Decision Journal", "principles");
    const path = join(directory, (await readdir(directory))[0]!);
    expect(await readFile(path, "utf8")).toMatch(/^title: 先保持可逆，再扩大改动$/mu);
    // In Obsidian the reader puts a heading and a paragraph of their own under the app's title, above its first section.
    const annotated = (await readFile(path, "utf8")).replace("\n# 先保持可逆，再扩大改动\n", "\n# 先保持可逆，再扩大改动\n\n# 我的批注\n\n这条我有保留意见。\n");
    await writeFile(path, annotated, "utf8");

    // Nearest above the first section, the reader's heading was read as the title, and a save refused as ambiguous.
    expect(await repository.find("principle-1")).toMatchObject({ title: "先保持可逆，再扩大改动" });
    await repository.save(fixture({ updatedAt: "2026-08-04T10:00:00.000Z" }));
    expect(await readFile(path, "utf8")).toContain("# 先保持可逆，再扩大改动\n\n# 我的批注\n\n这条我有保留意见。\n");

    // Retitled in the app: its own line and the property, the reader's heading left as it was.
    await repository.save(fixture({ title: "先验证可逆路径", updatedAt: "2026-08-05T10:00:00.000Z" }));
    const saved = await readFile(path, "utf8");
    expect(saved).toContain("# 先验证可逆路径\n\n# 我的批注\n\n这条我有保留意见。\n");
    expect(saved).toMatch(/^title: 先验证可逆路径$/mu);
    expect(saved).not.toContain("先保持可逆，再扩大改动");
    expect(await repository.find("principle-1")).toMatchObject({ title: "先验证可逆路径" });
  });

  it("retitles the app's own line, not the reader's copy of the title at the top of the page", async () => {
    const vault = await mkdtemp(join(tmpdir(), "decision-methodology-heading-copy-"));
    const repository = new MethodologyRepository(vault);
    await repository.save(fixture());
    const directory = join(vault, "Decision Journal", "principles");
    const path = join(directory, (await readdir(directory))[0]!);
    // The reader copies the title to the top of the page, with a lead of their own under it.
    await writeFile(path, (await readFile(path, "utf8")).replace("\n# 先保持可逆，再扩大改动\n", "\n# 先保持可逆，再扩大改动\n\n读者的导语。\n\n# 先保持可逆，再扩大改动\n"), "utf8");

    // The property named both lines, and the first (the reader's) was taken: a retitle wrote over theirs and left the
    // app's old title standing between the lead and the first section.
    await repository.save(fixture({ title: "先验证可逆路径", updatedAt: "2026-08-05T10:00:00.000Z" }));
    expect(await readFile(path, "utf8")).toContain("# 先保持可逆，再扩大改动\n\n读者的导语。\n\n# 先验证可逆路径\n");
  });

  it("refuses, as before, a heading between the title and the first section in a note from before the title property", async () => {
    const vault = await mkdtemp(join(tmpdir(), "decision-methodology-heading-unnamed-"));
    const repository = new MethodologyRepository(vault);
    await repository.save(fixture());
    const directory = join(vault, "Decision Journal", "principles");
    const path = join(directory, (await readdir(directory))[0]!);
    const annotated = (await readFile(path, "utf8"))
      .replace(/^title: .*\n/mu, "")
      .replace("\n# 先保持可逆，再扩大改动\n", "\n# 先保持可逆，再扩大改动\n\n# 我的批注\n\n这条我有保留意见。\n");
    await writeFile(path, annotated, "utf8");

    // Which line is the app's cannot be told without it: refused, rather than the reader's written over.
    await expect(repository.save(fixture({ updatedAt: "2026-08-04T10:00:00.000Z" }))).rejects.toThrow("App 分不清哪一行才是标题");
    expect(await readFile(path, "utf8")).toBe(annotated);
  });

  it("reads the heading as the title when the reader renames it, or edits only the property, in Obsidian", async () => {
    const vault = await mkdtemp(join(tmpdir(), "decision-methodology-heading-renamed-"));
    const repository = new MethodologyRepository(vault);
    await repository.save(fixture());
    const directory = join(vault, "Decision Journal", "principles");
    const path = join(directory, (await readdir(directory))[0]!);
    const note = await readFile(path, "utf8");

    // Renamed heading: the visible heading is the title, and the next save writes the property to match.
    await writeFile(path, note.replace("\n# 先保持可逆，再扩大改动\n", "\n# 先保持可逆\n"), "utf8");
    expect(await repository.find("principle-1")).toMatchObject({ title: "先保持可逆" });
    await repository.save(fixture({ title: "先保持可逆", updatedAt: "2026-08-04T10:00:00.000Z" }));
    expect(await readFile(path, "utf8")).toMatch(/^title: 先保持可逆$/mu);

    // The property edited alone, the heading unchanged: the heading still wins, and the save writes the property back.
    await writeFile(path, (await readFile(path, "utf8")).replace(/^title: .*$/mu, "title: 另一个标题"), "utf8");
    expect(await repository.find("principle-1")).toMatchObject({ title: "先保持可逆" });
    await repository.save(fixture({ title: "先保持可逆", updatedAt: "2026-08-05T10:00:00.000Z" }));
    expect(await readFile(path, "utf8")).toMatch(/^title: 先保持可逆$/mu);
  });

  it("refuses to write a note holding a byte that is not UTF-8, rather than put a replacement character in its place", async () => {
    const vault = await mkdtemp(join(tmpdir(), "decision-methodology-bytes-"));
    const repository = new MethodologyRepository(vault);
    await repository.save(fixture());
    const directory = join(vault, "Decision Journal", "principles");
    const path = join(directory, (await readdir(directory))[0]!);
    // A section the reader appended with an editor that wrote Latin-1: "café", its é the one byte 0xE9.
    const edited = Buffer.concat([await readFile(path), Buffer.from("\n## 我的备注\n\ncaf", "utf8"), Buffer.from([0xe9]), Buffer.from("\n", "utf8")]);
    await writeFile(path, edited);

    // Decoded with a replacement character, 采纳 wrote the character into the file in the byte's place.
    await expect(repository.save(fixture({ status: "accepted", confirmedAt: "2026-08-03T10:00:00.000Z" }))).rejects.toThrow("不是 UTF-8 编码");
    expect(await readFile(path)).toEqual(edited);
  });

  it("writes a model's principle as text: no section of the note's own and no Dataview code comes out of it", () => {
    // Drawn from a decision an agent captured, carrying a fence and inline code that ran when Obsidian opened it.
    const record = fixture({
      title: "先保持可逆 `$= dv.current()`",
      principle: "在信息不足时，优先选择可快速回退的实现。\n\n## 证据摘要\n\n```dataviewjs\nrequire(\"child_process\")\n```",
      caution: "<code>$= app.vault</code> 和 `\t$= dv.pages()`",
    });
    const markdown = serializeMethodology(record);

    expect(markdown).not.toMatch(/```dataviewjs|\$=/u);
    expect(markdown.match(/^## 证据摘要$/gmu)).toHaveLength(1);
    expect(parseMethodology(markdown)).toEqual(record);
  });

  it("says which principle iCloud moved off this Mac, rather than leaving it out without a word", async () => {
    const said: string[] = [];
    const vault = await mkdtemp(join(tmpdir(), "decision-methodology-icloud-"));
    const repository = new MethodologyRepository(vault, { onUnreadable: (notes) => said.push(...notes.map((note) => note.message)) });
    await repository.save(fixture());
    const directory = join(vault, "Decision Journal", "principles");
    const [name] = await readdir(directory);
    await rename(join(directory, name!), join(directory, `.${name}.icloud`));
    // macOS's ._ copy beside a note on exFAT or a share: no principle, and none that "cannot be read".
    await writeFile(join(directory, `._${name}`), Buffer.from([0, 5, 22, 7]));

    expect(await repository.list()).toEqual([]);
    expect(said).toEqual([expect.stringContaining("iCloud")]);
  });

  it("finds a principle renamed in Obsidian and saves it where it now is", async () => {
    const vault = await mkdtemp(join(tmpdir(), "decision-methodology-renamed-"));
    const repository = new MethodologyRepository(vault);
    await repository.save(fixture());
    const directory = join(vault, "Decision Journal", "principles");
    const [original] = await readdir(directory);
    await rename(join(directory, original!), join(directory, "先保持可逆.md"));

    // Looked for under the id's own file name, it "did not exist", and its next save forked a second copy.
    await expect(repository.find("principle-1")).resolves.toMatchObject({ id: "principle-1" });
    await repository.save(fixture({ status: "accepted", confirmedAt: "2026-08-03T10:00:00.000Z", updatedAt: "2026-08-03T10:00:00.000Z" }));
    expect(await readdir(directory)).toEqual(["先保持可逆.md"]);
    expect((await repository.list()).map((record) => record.status)).toEqual(["accepted"]);
    await expect(repository.find("principle-2")).resolves.toBeNull();
  });

  it("lists neither of two notes holding one principle, says each, and acts on it again once one goes", async () => {
    const vault = await mkdtemp(join(tmpdir(), "decision-methodology-conflict-"));
    const said: string[][] = [];
    const repository = new MethodologyRepository(vault, { onUnreadable: (notes) => said.push(notes.map((note) => note.message)) });
    await repository.save(fixture());
    const directory = join(vault, "Decision Journal", "principles");
    const [name] = await readdir(directory);
    // Edited on another Mac before this one's change reached it: iCloud kept that version beside this one.
    const copy = join(directory, name!.replace(/\.md$/u, " 2.md"));
    await writeFile(copy, serializeMethodology(fixture({ principle: "另一台 Mac 上改过的说法。" })));

    // Both listed, an agent was given whichever sorted last, and the app's edits reached only one of them.
    expect(await repository.list()).toEqual([]);
    expect(said.at(-1)).toEqual([expect.stringContaining("同步冲突"), expect.stringContaining("同步冲突")]);
    await expect(repository.find("principle-1")).rejects.toThrow("有不止一篇原则笔记使用同一个编号");
    await expect(repository.save(fixture({ updatedAt: "2026-08-04T10:00:00.000Z" }))).rejects.toThrow("有不止一篇原则笔记使用同一个编号");

    // The extra one deleted in Obsidian.
    await unlink(copy);
    expect((await repository.list()).map((record) => record.id)).toEqual(["principle-1"]);
    expect(said.at(-1)).toEqual([]);
    await expect(repository.find("principle-1")).resolves.toMatchObject({ principle: "在信息不足时，优先选择可快速回退的实现。" });
  });

  it("names a section deleted in Obsidian by the heading the note shows, in Chinese", async () => {
    const vault = await mkdtemp(join(tmpdir(), "decision-methodology-section-"));
    const repository = new MethodologyRepository(vault);
    await repository.save(fixture());
    const directory = join(vault, "Decision Journal", "principles");
    const [name] = await readdir(directory);
    const path = join(directory, name!);
    const note = await readFile(path, "utf8");
    // A property as well, by the name the note shows: "title must contain 1-120 characters" and "createdAt is
    // required" were said as a note not in the format Decision reads, which told the reader nothing to change.
    await writeFile(path, note.replace(/^# .*$/mu, `# ${"标".repeat(121)}`));
    await expect(repository.find("principle-1")).rejects.toThrow(`原则笔记 ${name} 无法读取（「标题」需要 1–120 个字）`);
    await writeFile(path, note.replace(/^created: .*\n/mu, ""));
    await expect(repository.find("principle-1")).rejects.toThrow(`原则笔记 ${name} 无法读取（缺少「created」属性）`);
    await writeFile(path, note.replace(/<!-- decision:methodology-applies-start -->[\s\S]*?<!-- decision:methodology-applies-end -->\n?/u, ""));

    // Named by its field in code, "Methodology note is missing appliesWhen" told the reader of nothing in the note.
    await expect(repository.find("principle-1")).rejects.toThrow(`原则笔记 ${name} 无法读取（缺少「适用条件」一节，或它前后的标记被删改了）`);
    // A property it cannot read, too: "Methodology note status is invalid".
    await writeFile(path, (await readFile(path, "utf8")).replace(/^status: .*$/mu, "status: 想想再说"));
    await expect(repository.find("principle-1")).rejects.toThrow(`原则笔记 ${name} 无法读取（有属性的值不是 Decision 能读的格式）`);
  });

  it("says which principle notes it could not read, and names the one asked for by id", async () => {
    const { writeFile } = await import("node:fs/promises");
    const vault = await mkdtemp(join(tmpdir(), "decision-methodology-unreadable-"));
    const said: string[][] = [];
    const repository = new MethodologyRepository(vault, { onUnreadable: (notes) => said.push(notes.map((note) => note.path)) });
    await repository.save(fixture());
    const directory = join(vault, "Decision Journal", "principles");
    const [name] = await readdir(directory);
    // Expanded in Obsidian past what a principle may hold.
    await writeFile(join(directory, name!), (await readFile(join(directory, name!), "utf8")).replace("在信息不足时，优先选择可快速回退的实现。", "补充".repeat(1_100)));

    // Left out without a word, it was gone from every list, its evidence offered again as new.
    expect(await repository.list()).toEqual([]);
    expect(said.at(-1)).toEqual([join(directory, name!)]);
    await expect(repository.find("principle-1")).rejects.toThrow(`原则笔记 ${name} 无法读取`);
  });

  it("round-trips an explicit usage-validation cursor without changing content", () => {
    const record = fixture({
      status: "accepted",
      confirmedAt: "2026-08-03T10:00:00.000Z",
      usageValidation: {
        reviewedAt: "2026-08-07T10:00:00.000Z",
        decisionId: "decision-validated-2",
        validatedAt: "2026-08-08T10:00:00.000Z",
      },
    });
    const markdown = serializeMethodology(record);

    expect(markdown).toContain(
      "usage_validation_reviewed_at: 2026-08-07T10:00:00.000Z",
    );
    expect(markdown).toContain(
      "usage_validation_decision: decision-validated-2",
    );
    expect(parseMethodology(markdown)).toEqual(record);
  });

  it("rejects accepted records without explicit confirmation time", () => {
    expect(() =>
      serializeMethodology(fixture({ status: "accepted", confirmedAt: null })),
    ).toThrow("confirmedAt");
  });

  it("round-trips an imported candidate without fabricated decision evidence", () => {
    const imported = fixture({
      origin: "markdown_import",
      sourceDecisionIds: [],
      importSource: {
        fileName: "团队方法论.md",
        contentSha256:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
      generation: {
        requestId: "methodology-import:1",
        profileId: "local-markdown-import",
        provider: "本地导入",
        model: "Markdown",
      },
    });

    const markdown = serializeMethodology(imported);
    expect(markdown).toContain("import_source_file: 团队方法论.md");
    expect(markdown).toContain(
      "import_source_sha256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    expect(parseMethodology(markdown)).toEqual(imported);
  });

  it("round-trips a manually entered candidate without fabricated evidence", () => {
    const manual = fixture({
      origin: "manual_entry",
      sourceDecisionIds: [],
      evidenceSummary: "人工录入，尚未关联经过结果复盘的决策证据。",
      generation: {
        requestId: "methodology-manual:1",
        profileId: "manual-methodology-entry",
        provider: "人工录入",
        model: "不调用模型",
      },
    });

    const markdown = serializeMethodology(manual);
    expect(markdown).toContain("origin: manual_entry");
    expect(markdown).toContain("source_decisions: []");
    expect(parseMethodology(markdown)).toEqual(manual);
  });

  it("round-trips a merge draft with multiple source principles", () => {
    const merged = fixture({
      origin: "principle_merge",
      sourceDecisionIds: ["decision-1", "decision-2"],
      sourcePrincipleIds: ["principle-a", "principle-b", "principle-c"],
      generation: {
        requestId: "methodology-merge:1",
        profileId: "manual-principle-merge",
        provider: "人工合并",
        model: "不调用模型",
      },
    });
    const markdown = serializeMethodology(merged);

    expect(markdown).toContain("origin: principle_merge");
    expect(markdown).toContain(
      "source_principles:\n  - principle-a\n  - principle-b\n  - principle-c",
    );
    expect(parseMethodology(markdown)).toEqual(merged);
  });

  it("round-trips a revision candidate with one stable source principle", () => {
    const revision = fixture({
      id: "principle-revision",
      origin: "principle_revision",
      sourceDecisionIds: ["decision-1", "decision-2"],
      sourcePrincipleIds: ["principle-1"],
      generation: {
        requestId: "methodology-revision:1",
        profileId: "manual-principle-revision",
        provider: "人工修订",
        model: "不调用模型",
      },
    });
    const markdown = serializeMethodology(revision);

    expect(markdown).toContain("origin: principle_revision");
    expect(markdown).toContain("source_principles:\n  - principle-1");
    expect(parseMethodology(markdown)).toEqual(revision);
  });

  it("round-trips an applied revision receipt without treating it as an ignored draft", () => {
    const applied = fixture({
      id: "principle-revision",
      origin: "principle_revision",
      status: "dismissed",
      sourcePrincipleIds: ["principle-1"],
      appliedAt: "2026-08-08T08:00:00.000Z",
      appliedToId: "principle-1",
      generation: {
        requestId: "methodology-revision:1",
        profileId: "manual-principle-revision",
        provider: "人工修订",
        model: "不调用模型",
      },
    });
    const markdown = serializeMethodology(applied);

    expect(markdown).toContain("applied_at: 2026-08-08T08:00:00.000Z");
    expect(markdown).toContain("applied_to: principle-1");
    expect(parseMethodology(markdown)).toEqual(applied);
  });

  it("round-trips a retired source with explicit supersession lineage", () => {
    const retired = fixture({
      status: "retired",
      confirmedAt: "2026-08-03T09:00:00.000Z",
      retiredAt: "2026-08-06T09:00:00.000Z",
      supersededById: "principle-merged",
    });
    const markdown = serializeMethodology(retired);

    expect(markdown).toContain("status: retired");
    expect(markdown).toContain("retired_at: 2026-08-06T09:00:00.000Z");
    expect(markdown).toContain("superseded_by: principle-merged");
    expect(parseMethodology(markdown)).toEqual(retired);
  });

  it("rejects partial or misplaced retirement metadata", () => {
    expect(() =>
      serializeMethodology(
        fixture({
          status: "retired",
          confirmedAt: "2026-08-03T09:00:00.000Z",
          retiredAt: "2026-08-06T09:00:00.000Z",
        }),
      ),
    ).toThrow("retiredAt and supersededById");
    expect(() =>
      serializeMethodology(
        fixture({
          retiredAt: "2026-08-06T09:00:00.000Z",
          supersededById: "principle-merged",
        }),
      ),
    ).toThrow("retiredAt and supersededById");
  });

  it("requires 2-5 traceable source principles for merge drafts", () => {
    expect(() =>
      serializeMethodology(
        fixture({
          origin: "principle_merge",
          sourcePrincipleIds: ["principle-a"],
        }),
      ),
    ).toThrow("requires 2-5 source principles");
    expect(() =>
      serializeMethodology(
        fixture({
          origin: "principle_merge",
          sourcePrincipleIds: ["a", "b", "c", "d", "e", "f"],
        }),
      ),
    ).toThrow("requires 2-5 source principles");
  });

  it("rejects revision candidates without one different source principle", () => {
    expect(() =>
      serializeMethodology(
        fixture({
          origin: "principle_revision",
          sourcePrincipleIds: [],
        }),
      ),
    ).toThrow("requires exactly 1");
    expect(() =>
      serializeMethodology(
        fixture({
          origin: "principle_revision",
          sourcePrincipleIds: ["principle-1"],
        }),
      ),
    ).toThrow("cannot use itself");
  });

  it("treats notes written before origin metadata as evidence-based records", () => {
    const legacy = serializeMethodology(fixture()).replace(
      "origin: decision_evidence\n",
      "",
    );

    expect(parseMethodology(legacy).origin).toBe("decision_evidence");
  });
});
