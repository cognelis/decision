import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { atomicWrite } from "../src/main/atomic-write.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, writeFile: vi.fn(fs.writeFile), rename: vi.fn(fs.rename) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.mocked(writeFile).mockReset();
  vi.mocked(rename).mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("atomic private file writes", () => {
  it.each(["partial write", "rename"])("preserves an existing export after a failed %s and permits retry", async (failure) => {
    const root = await mkdtemp(join(tmpdir(), "decision-export-write-"));
    roots.push(root);
    const path = join(root, "conversation.md");
    const original = "原文件，不能丢失\n";
    await writeFile(path, original);
    const error = Object.assign(new Error("Injected storage failure"), { code: "EIO" });
    if (failure === "partial write") {
      const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      vi.mocked(writeFile).mockImplementationOnce(async (target, _content, options) => {
        await fs.writeFile(target, "只写入了一部分", options);
        throw error;
      });
    } else {
      vi.mocked(rename).mockRejectedValueOnce(error);
    }
    await expect(atomicWrite(path, "完整的新对话\n")).rejects.toBe(error);
    expect(await readFile(path, "utf8")).toBe(original);
    expect(await readdir(root)).toEqual(["conversation.md"]);
    await atomicWrite(path, "完整的新对话\n");
    expect(await readFile(path, "utf8")).toBe("完整的新对话\n");
    expect(await readdir(root)).toEqual(["conversation.md"]);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
