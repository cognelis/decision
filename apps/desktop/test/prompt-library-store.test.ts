import { mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PromptLibraryStore } from "../src/main/prompt-library-store.js";
import { PROMPT_EXAMPLES } from "../src/shared/prompt-examples.js";

const storePath = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), "prompt-library-")), "prompts.json");
const fixedClock = (iso = "2026-11-17T09:00:00.000Z") => () => new Date(iso);

describe("prompt library store", () => {
  it("writes the three examples the first time, as editable prompts", async () => {
    const path = await storePath();
    const listed = await new PromptLibraryStore(path).list();
    expect(listed.map(({ title, body }) => ({ title, body }))).toEqual(PROMPT_EXAMPLES);
    expect(new Set(listed.map((prompt) => prompt.id)).size).toBe(3);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("never puts the examples back once the file exists: deleted stays deleted, edited stays edited", async () => {
    const path = await storePath();
    const store = new PromptLibraryStore(path);
    const [first, second, third] = await store.list();
    await store.update({ id: first!.id, expectedUpdatedAt: first!.updatedAt, title: "我的检查", body: "改过的正文" });
    await store.delete(second!.id);
    await store.delete(third!.id);
    // A restart, or an upgrade: a new store over the same file.
    const after = await new PromptLibraryStore(path).list();
    expect(after.map(({ title, body }) => ({ title, body }))).toEqual([{ title: "我的检查", body: "改过的正文" }]);
    await store.delete(first!.id);
    expect(await new PromptLibraryStore(path).list()).toEqual([]);
    expect(await new PromptLibraryStore(path).list()).toEqual([]);
  });

  it("seeds only once when the first reads come together", async () => {
    const path = await storePath();
    const store = new PromptLibraryStore(path);
    const [a, b] = await Promise.all([store.list(), store.list()]);
    expect(a).toEqual(b);
    expect((JSON.parse(await readFile(path, "utf8")) as { prompts: unknown[] }).prompts).toHaveLength(3);
  });

  it("creates prompts first in the list and keeps the body as written", async () => {
    const store = new PromptLibraryStore(await storePath());
    const body = "  第一行缩进\n\n- 列表\n    代码缩进\n";
    const created = await store.create({ title: "  新的  ", body });
    expect(created).toMatchObject({ title: "新的", body });
    expect((await store.list())[0]).toEqual(created);
  });

  it("keeps every one of several prompts created at once", async () => {
    const store = new PromptLibraryStore(await storePath());
    await Promise.all(Array.from({ length: 5 }, (_, index) => store.create({ title: `并发 ${index}`, body: "正文" })));
    expect(await store.list()).toHaveLength(8);
  });

  it("refuses an empty title or body, a title on two lines, and a body of blanks", async () => {
    const store = new PromptLibraryStore(await storePath());
    await expect(store.create({ title: "  ", body: "正文" })).rejects.toThrow("标题不能为空");
    await expect(store.create({ title: "两\n行", body: "正文" })).rejects.toThrow("标题只能是一行");
    await expect(store.create({ title: "标题", body: " \n\t " })).rejects.toThrow("正文不能为空");
    await expect(store.create({ title: "x".repeat(121), body: "正文" })).rejects.toThrow();
    expect(await store.list()).toHaveLength(3);
  });

  it("refuses an edit made from a prompt that has changed since, even within the same millisecond", async () => {
    const store = new PromptLibraryStore(await storePath(), fixedClock());
    const [first] = await store.list();
    const saved = await store.update({ id: first!.id, expectedUpdatedAt: first!.updatedAt, title: "一", body: "一" });
    expect(saved.updatedAt).not.toBe(first!.updatedAt);
    await expect(store.update({ id: first!.id, expectedUpdatedAt: first!.updatedAt, title: "二", body: "二" })).rejects.toThrow("在别处被修改过");
    const again = await store.update({ id: first!.id, expectedUpdatedAt: saved.updatedAt, title: "三", body: "三" });
    expect(Date.parse(again.updatedAt)).toBeGreaterThan(Date.parse(saved.updatedAt));
    await store.delete(first!.id);
    await expect(store.update({ id: first!.id, expectedUpdatedAt: again.updatedAt, title: "四", body: "四" })).rejects.toThrow("已被删除");
  });

  it("stops at a damaged file rather than writing over it or seeding again", async () => {
    const path = await storePath();
    await writeFile(path, "{not json", { mode: 0o600 });
    const store = new PromptLibraryStore(path);
    await expect(store.list()).rejects.toThrow("提示词文件损坏");
    await expect(store.create({ title: "新", body: "新" })).rejects.toThrow("提示词文件损坏");
    expect(await readFile(path, "utf8")).toBe("{not json");

    await writeFile(path, JSON.stringify({ version: 1, prompts: [{ id: "x", title: "", body: "" }] }));
    await expect(store.list()).rejects.toThrow("提示词文件损坏");
  });

  it("refuses a file reached through a link", async () => {
    const path = await storePath();
    const real = `${path}.real`;
    await writeFile(real, JSON.stringify({ version: 1, prompts: [] }));
    await symlink(real, path);
    await expect(new PromptLibraryStore(path).list()).rejects.toThrow("路径不安全");
  });
});
