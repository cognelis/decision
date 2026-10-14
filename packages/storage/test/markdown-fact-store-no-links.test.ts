import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownFactStore } from "../src/markdown-fact-store.js";

// A vault on a volume without hard links (exFAT, most SMB shares): link() is refused outright.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: vi.fn(async () => {
      throw Object.assign(new Error("ENOTSUP: operation not supported"), { code: "ENOTSUP" });
    }),
  };
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("versioned Markdown filesystem without hard links", () => {
  it("still creates a record, and only once", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-fact-store-no-links-")); roots.push(root);
    const schema = z.object({ id: z.string(), revision: z.number().int(), value: z.string() }).strict();
    const store = new MarkdownFactStore(root, "test-facts", { parse: (value) => schema.parse(value), key: (value) => value.id, heading: "测试元数据" });
    const first = { id: "one", revision: 1, value: "original" };

    expect(await store.replace(first, null)).toBe("saved");
    expect(await readFile(join(root, store.relativePath("one")), "utf8")).toContain("original");
    expect(await store.replace({ ...first, value: "second" }, null)).toBe("conflict");
  });
});
