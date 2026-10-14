import type { MethodologyRelationRecord } from "@cognelis/decision-core";
import { copyFile, mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  MethodologyRelationRepository,
  parseMethodologyRelation,
  serializeMethodologyRelation,
} from "../src/index.js";

const fixture = (
  overrides: Partial<MethodologyRelationRecord> = {},
): MethodologyRelationRecord => ({
  id: "relation-1",
  createdAt: "2026-08-06T10:00:00.000Z",
  updatedAt: "2026-08-06T10:00:00.000Z",
  principleIds: ["principle-b", "principle-a"],
  principleTitles: ["先扩大再验证", "先验证再扩大"],
  disposition: "conflict",
  note: "两条原则适用于同一发布窗口，但行动顺序相反。",
  ...overrides,
});

describe("MethodologyRelationRepository", () => {
  it("round-trips one canonical, human-readable relationship note", () => {
    const markdown = serializeMethodologyRelation(fixture());
    const parsed = parseMethodologyRelation(markdown);

    expect(markdown).toContain("type: decision-methodology-relation");
    expect(markdown).toContain("disposition: conflict");
    expect(markdown).toContain("两条原则适用于同一发布窗口");
    expect(parsed).toEqual({
      ...fixture(),
      principleIds: ["principle-a", "principle-b"],
      principleTitles: ["先验证再扩大", "先扩大再验证"],
    });
  });

  it("atomically replaces and removes the single relation fact", async () => {
    const vault = await mkdtemp(join(tmpdir(), "methodology-relation-"));
    const repository = new MethodologyRelationRepository(vault);
    await repository.save(fixture());
    await repository.save(
      fixture({
        updatedAt: "2026-08-06T11:00:00.000Z",
        disposition: "unrelated",
        note: "文本相近，但一个约束发布、另一个约束数据迁移。",
      }),
    );

    await expect(repository.list()).resolves.toEqual([
      expect.objectContaining({
        disposition: "unrelated",
        note: "文本相近，但一个约束发布、另一个约束数据迁移。",
      }),
    ]);
    const directory = join(vault, "Decision Journal", "principle-relations");
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    expect(await readFile(join(directory, files[0]!), "utf8")).toContain(
      "无关",
    );

    await repository.remove("relation-1");
    await expect(repository.list()).resolves.toEqual([]);
    await expect(repository.remove("relation-1")).resolves.toBeUndefined();
  });

  it("keeps what the reader added in Obsidian when the relation is set again", async () => {
    const vault = await mkdtemp(join(tmpdir(), "methodology-relation-kept-"));
    const repository = new MethodologyRelationRepository(vault);
    await repository.save(fixture());
    const directory = join(vault, "Decision Journal", "principle-relations");
    const path = join(directory, (await readdir(directory))[0]!);
    // Tagged in Obsidian, with a section of the reader's own after the app's, and one above it whose heading begins
    // as the app's title does.
    await writeFile(path, (await readFile(path, "utf8"))
      .replace("\n---\n", "\ntags:\n  - 原则冲突\n---\n")
      .replace("# 方法论关系核对\n", "# 方法论关系核对的补充想法\n\n这个结论值得商榷。\n\n# 方法论关系核对\n")
      .concat("\n## 我的补充\n\n见 [[2026-08 事故复盘]]。\n"));

    // Written whole, judging the pair again took both with it.
    await repository.save(fixture({ updatedAt: "2026-08-07T10:00:00.000Z", disposition: "unrelated", note: "一个约束发布，一个约束迁移。" }));

    const saved = await readFile(path, "utf8");
    expect(saved).toContain("tags:\n  - 原则冲突\n");
    expect(saved).toContain("# 方法论关系核对的补充想法\n\n这个结论值得商榷。\n\n# 方法论关系核对\n");
    expect(saved).toContain("## 我的补充\n\n见 [[2026-08 事故复盘]]。");
    expect(saved).toContain("## 人工结论\n\n无关\n");
    expect(saved).not.toContain("冲突\n\n## 核对说明");
    expect(parseMethodologyRelation(saved)).toMatchObject({ disposition: "unrelated", note: "一个约束发布，一个约束迁移。" });
  });

  it("says which relation notes it could not read, and refuses to write over one rather than replace the reader's", async () => {
    const vault = await mkdtemp(join(tmpdir(), "methodology-relation-unreadable-"));
    const said: string[][] = [];
    const repository = new MethodologyRelationRepository(vault, { onUnreadable: (notes) => said.push(notes.map((note) => note.path)) });
    await repository.save(fixture());
    const directory = join(vault, "Decision Journal", "principle-relations");
    const path = join(directory, (await readdir(directory))[0]!);
    // Edited in Obsidian: the conclusion put in words, and an analysis of the reader's own.
    const edited = (await readFile(path, "utf8")).replace("disposition: conflict", "disposition: 冲突").concat("\n## 我的分析\n\n两条只在紧急修复时冲突。\n");
    await writeFile(path, edited);

    // Left out without a word, its pair was shown again as one to check, and the next 核对 wrote the note over.
    expect(await repository.list()).toEqual([]);
    expect(said.at(-1)).toEqual([path]);
    await expect(repository.save(fixture({ updatedAt: "2026-08-07T10:00:00.000Z", disposition: "unrelated" }))).rejects.toThrow("无法安全写入");
    expect(await readFile(path, "utf8")).toBe(edited);
  });

  it("keeps the reader's text in a relation note retitled in Obsidian", async () => {
    const vault = await mkdtemp(join(tmpdir(), "methodology-relation-retitled-"));
    const repository = new MethodologyRelationRepository(vault);
    await repository.save(fixture());
    const directory = join(vault, "Decision Journal", "principle-relations");
    const path = join(directory, (await readdir(directory))[0]!);
    await writeFile(path, (await readFile(path, "utf8")).replace("# 方法论关系核对\n", "# 发布顺序之争\n").concat("\n## 我的补充\n\n见复盘。\n"));

    await repository.save(fixture({ updatedAt: "2026-08-07T10:00:00.000Z", disposition: "unrelated", note: "一个约束发布，一个约束迁移。" }));

    const saved = await readFile(path, "utf8");
    expect(saved).toContain("## 我的补充\n\n见复盘。");
    expect(parseMethodologyRelation(saved)).toMatchObject({ disposition: "unrelated", note: "一个约束发布，一个约束迁移。" });
  });

  it("finds a relation note renamed in Obsidian by its id, and leaves out both of two holding one id", async () => {
    const vault = await mkdtemp(join(tmpdir(), "methodology-relation-renamed-"));
    const said: string[][] = [];
    const repository = new MethodologyRelationRepository(vault, { onUnreadable: (notes) => said.push(notes.map((note) => note.message)) });
    await repository.save(fixture());
    const directory = join(vault, "Decision Journal", "principle-relations");
    await rename(join(directory, (await readdir(directory))[0]!), join(directory, "发布顺序之争.md"));

    // Judged again, the note is written where it now is, not forked under the id's own name; cleared, it goes.
    await repository.save(fixture({ updatedAt: "2026-08-07T10:00:00.000Z", disposition: "unrelated" }));
    expect(await readdir(directory)).toEqual(["发布顺序之争.md"]);
    expect((await repository.list()).map((relation) => relation.disposition)).toEqual(["unrelated"]);
    await repository.remove("relation-1");
    expect(await readdir(directory)).toEqual([]);

    // A sync conflict's copy holds the same id: neither is listed, each is said, and a write to the id is refused.
    await repository.save(fixture());
    await copyFile(join(directory, (await readdir(directory))[0]!), join(directory, "relation 2.md"));
    expect(await repository.list()).toEqual([]);
    expect(said.at(-1)).toEqual([expect.stringContaining("不止一篇"), expect.stringContaining("不止一篇")]);
    await expect(repository.save(fixture({ updatedAt: "2026-08-08T10:00:00.000Z" }))).rejects.toThrow("不止一篇");
    await expect(repository.remove("relation-1")).rejects.toThrow("不止一篇");
    expect(await readdir(directory)).toHaveLength(2);
  });

  it("rejects self-relations and oversized notes", () => {
    expect(() =>
      serializeMethodologyRelation(
        fixture({ principleIds: ["same", "same"] }),
      ),
    ).toThrow("must differ");
    expect(() =>
      serializeMethodologyRelation(fixture({ note: "x".repeat(501) })),
    ).toThrow("relation note");
  });
});
