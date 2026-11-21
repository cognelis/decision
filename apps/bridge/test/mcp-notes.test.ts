import { RationaleQueue } from "@cognelis/decision-core";
import { ObsidianSearchIndex, ObsidianVaultRepository } from "@cognelis/decision-storage";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LocalCaptureServer } from "../../desktop/src/main/local-server.js";
import { readObsidianNote, searchObsidianNotes } from "../../desktop/src/main/obsidian-search/obsidian-note-tools.js";
import { ObsidianSearchService } from "../../desktop/src/main/obsidian-search/obsidian-search-service.js";
import { QwenEmbeddingProviderError } from "../../desktop/src/main/semantic/qwen-embedding-provider.js";
import type { ObsidianSearchStatus } from "../../desktop/src/shared/obsidian-search.js";
import { createDecisionMcpServer } from "../src/mcp-server.js";
import { RuntimeClient } from "../src/runtime-client.js";

const roots: string[] = [];
const servers: LocalCaptureServer[] = [];
const services: ObsidianSearchService[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.allSettled(services.splice(0).map((service) => service.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Result = { isError?: boolean; content: Array<{ text: string }>; structuredContent: Record<string, unknown> };

const connect = async (runtime: RuntimeClient) => {
  const server = createDecisionMcpServer({ sourceClient: "codex", runtime, cwd: "/work/decision" });
  const [client, transport] = InMemoryTransport.createLinkedPair();
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  client.onmessage = (message) => {
    if ("id" in message) waiting.get(message.id as number)?.(message as Record<string, unknown>);
  };
  await Promise.all([server.connect(transport), client.start()]);
  let id = 0;
  const request = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const current = ++id;
      waiting.set(current, resolve);
      void client.send({ jsonrpc: "2.0", id: current, method, params });
    });
  await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "notes-test", version: "1" } });
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return (name: string, args: Record<string, unknown>) => request("tools/call", { name, arguments: args }).then((message) => message.result as Result);
};

const writeNote = async (vault: string, path: string, content: string) => {
  await mkdir(join(vault, ...path.split("/").slice(0, -1)), { recursive: true });
  await writeFile(join(vault, ...path.split("/")), content);
};

const LONG_LINE = "长".repeat(30_000);

/** A real vault, indexed by the real service (keyword only: no model), served by the App's own server with its token. */
const app = async (handlers: "real" | "off" | "old" = "real") => {
  const root = await mkdtemp(join(tmpdir(), "paraself-notes-"));
  roots.push(root);
  const vault = join(root, "vault");
  const outside = join(root, "outside");
  await mkdir(outside, { recursive: true });
  await writeNote(vault, "设计/缓存方案.md", "# 缓存方案\n\n## 结论\n\n我们决定用 Redis 做会话缓存。\n不用 Memcached。\n");
  await writeNote(vault, ".private/私密.md", "Redis 私密笔记\n");
  await writeNote(vault, "归档/旧方案.md", "Redis 旧方案\n");
  await writeNote(vault, "Decision Journal/决策.md", "Redis 决策\n");
  await writeNote(vault, ".obsidian/app.json", JSON.stringify({ userIgnoreFilters: ["归档/"] }));
  await writeNote(vault, "长/长笔记.md", `${Array.from({ length: 450 }, (_, index) => `第 ${index + 1} 行 Kafka`).join("\n")}\n${LONG_LINE}\n末行\n`);
  // A heading path the index bounds at 600 code points, astral ones: up to 1,200 UTF-16 units in a result.
  await writeNote(vault, "表情/长标题.md", `# A\n\n## ${"😀".repeat(700)}\n\n表情笔记 Zeppelin\n`);
  await writeNote(vault, "大/超大.md", `Redis ${"x".repeat(6 * 1024 * 1024)}`);
  await writeFile(join(outside, "外部.md"), "Redis 外部秘密\n");
  await symlink(join(outside, "外部.md"), join(vault, "链接.md"));
  await symlink(outside, join(vault, "链接目录"));
  const service = new ObsidianSearchService({
    repository: new ObsidianVaultRepository(vault),
    index: new ObsidianSearchIndex(join(root, "index.sqlite")),
    embedding: { embed: async () => { throw new QwenEmbeddingProviderError("model_missing", "missing"); } },
    watcherFactory: () => ({ start: () => undefined, close: async () => undefined }),
    openExternal: async () => undefined,
    now: () => new Date("2026-11-17T00:00:00.000Z"),
  });
  services.push(service);
  await service.rebuild();
  const off: ObsidianSearchStatus = { ...service.status(), state: "error", indexedNotes: 0, discoveredNotes: 0, message: "off" };
  const runtime = handlers === "off"
    ? { status: () => off, search: async ({ query }: { query: string }) => ({ query, results: [], status: off }), readIndexedNote: async () => { throw new Error("off"); } }
    : service;
  const token = "n".repeat(64);
  const server = new LocalCaptureServer({
    queue: new RationaleQueue(),
    token,
    ...(handlers === "old" ? {} : {
      searchObsidianNotes: (input) => searchObsidianNotes(runtime, input),
      readObsidianNote: (input) => readObsidianNote(runtime, input),
    }),
  });
  servers.push(server);
  const { port } = await server.start();
  const runtimeFile = join(root, "runtime.json");
  await writeFile(runtimeFile, JSON.stringify({ protocolVersion: 1, port, token, pid: process.pid, startedAt: new Date().toISOString() }));
  return { root, vault, outside, port, service, call: await connect(new RuntimeClient({ runtimeFile })) };
};

describe("ordinary note tools over MCP, the bridge's client and the App's server", () => {
  it("finds a note with its line, and nothing hidden, excluded, the app's own, a link or too large", async () => {
    const { root, call } = await app();
    const found = await call("search_obsidian_notes", { query: "Redis" });

    expect(found.isError).toBeUndefined();
    const search = found.structuredContent.search as { availability: string; projectScope: string; results: Array<Record<string, unknown>> };
    expect(search.projectScope).toBe("none");
    expect(search.results.map((hit) => [hit.path, hit.line, hit.changedSinceIndexed])).toEqual([["设计/缓存方案.md", 5, false]]);
    expect(found.content[0]!.text).toContain("`设计/缓存方案.md:5` 《缓存方案》 › 缓存方案 > 结论（关键词）");
    // The note over 5 MiB was found and not indexed: said, the search counted as partial rather than complete.
    expect(search.availability).toBe("partial");
    expect(found.content[0]!.text).toContain("有的笔记没能建立索引");
    expect(found.content[0]!.text).toContain("普通笔记没有项目范围");
    // The vault's place on this machine is not said, in the text or the structure.
    expect(JSON.stringify(found)).not.toContain(root);
  });

  it("returns a hit under the longest heading path the index keeps, with its line, rather than failing the search", async () => {
    const { call } = await app();
    const found = await call("search_obsidian_notes", { query: "Zeppelin" });
    expect(found.isError).toBeUndefined();
    const hits = (found.structuredContent.search as { results: Array<{ path: string; heading: string; line: number }> }).results;
    expect(hits.map((hit) => [hit.path, hit.line])).toEqual([["表情/长标题.md", 5]]);
    expect(hits[0]!.heading.length).toBeGreaterThan(1_000);
    expect(hits[0]!.heading.endsWith("😀")).toBe(true);
  });

  it("reads an indexed note, and refuses alike every path the index does not keep, saying nothing of what is there", async () => {
    const { root, call } = await app();
    const read = await call("get_obsidian_note", { path: "设计/缓存方案.md" });
    expect(read.isError).toBeUndefined();
    expect(read.structuredContent.read).toMatchObject({
      status: "ok",
      note: { title: "缓存方案", totalLines: 6, startLine: 1, endLine: 6, truncated: false, nextStartLine: null, changedSinceIndexed: false },
    });
    expect(read.content[0]!.text).toContain("我们决定用 Redis 做会话缓存。");

    for (const path of [".private/私密.md", "归档/旧方案.md", "Decision Journal/决策.md", "链接.md", "链接目录/外部.md", "大/超大.md", "没有/这篇.md", "设计.md"]) {
      const refused = await call("get_obsidian_note", { path });
      expect(refused.isError, path).toBe(true);
      expect(refused.structuredContent.read, path).toMatchObject({ status: "not_available", note: null });
      expect(JSON.stringify(refused), path).not.toMatch(/外部秘密|私密笔记|旧方案\n|决策\n/u);
    }
    // Not a Vault-relative Markdown path at all: refused before it reaches the App.
    for (const path of ["../outside/外部.md", `${root}/outside/外部.md`, "设计", "设计/缓存方案.txt", "设计\\缓存方案.md", "./设计/缓存方案.md"]) {
      const refused = await call("get_obsidian_note", { path });
      expect(refused.isError, path).toBe(true);
      expect(JSON.stringify(refused), path).not.toContain("外部秘密");
    }
  });

  it("refuses a path the reader excluded after it was indexed, and leaves such a hit out of a search as partial", async () => {
    const { vault, call } = await app();
    await writeNote(vault, ".obsidian/app.json", JSON.stringify({ userIgnoreFilters: ["归档/", "设计/"] }));

    expect((await call("get_obsidian_note", { path: "设计/缓存方案.md" })).structuredContent.read).toMatchObject({ status: "not_available" });
    const search = (await call("search_obsidian_notes", { query: "Redis" })).structuredContent.search as { availability: string; results: unknown[]; message: string };
    expect(search).toMatchObject({ availability: "partial", results: [] });
    expect(search.message).toContain("已从结果里去掉");
  });

  it("says a note changed since it was indexed, and gives its text as it is now", async () => {
    const { vault, call } = await app();
    await writeNote(vault, "设计/缓存方案.md", "# 缓存方案\n\n改成了 Valkey。\n");
    const read = await call("get_obsidian_note", { path: "设计/缓存方案.md" });
    expect(read.structuredContent.read).toMatchObject({ status: "ok", note: { changedSinceIndexed: true, text: "# 缓存方案\n\n改成了 Valkey。" } });
    const search = (await call("search_obsidian_notes", { query: "缓存方案" })).structuredContent.search as { results: Array<{ changedSinceIndexed: boolean }> };
    expect(search.results[0]?.changedSinceIndexed).toBe(true);
  });

  it("pages a long note by lines, and a line longer than one read by columns, to its end, nothing skipped", async () => {
    const { call } = await app();
    const page = async (args: Record<string, unknown>) =>
      ((await call("get_obsidian_note", { path: "长/长笔记.md", ...args })).structuredContent.read as { note: { text: string; truncated: boolean; nextStartLine: number | null; nextStartColumn: number | null; endLine: number; totalLines: number } }).note;

    const first = await page({ maxLines: 400 });
    expect(first).toMatchObject({ endLine: 400, truncated: true, nextStartLine: 401, nextStartColumn: 0, totalLines: 452 });
    let text = first.text;
    let next: { line: number | null; column: number | null } = { line: first.nextStartLine, column: first.nextStartColumn };
    let reads = 1;
    while (next.line !== null) {
      const more = await page({ startLine: next.line, startColumn: next.column, maxLines: 400 });
      expect(more.text.length).toBeLessThanOrEqual(24_000);
      // Gone on with inside a line, joined back with no newline; at a new line, with one.
      text += `${next.column === 0 ? "\n" : ""}${more.text}`;
      next = { line: more.nextStartLine, column: more.nextStartColumn };
      reads += 1;
      expect(reads).toBeLessThan(10);
    }
    expect(text).toBe(`${Array.from({ length: 450 }, (_, index) => `第 ${index + 1} 行 Kafka`).join("\n")}\n${LONG_LINE}\n末行`);
  });

  it("says the index is off, and an App without these tools, as no search at all, never as nothing found", async () => {
    const off = await app("off");
    const search = await off.call("search_obsidian_notes", { query: "Redis" });
    expect(search.isError).toBe(true);
    expect(search.structuredContent.search).toMatchObject({ availability: "unavailable", results: [] });
    expect(search.content[0]!.text).toContain("不代表没有相关笔记");
    expect((await off.call("get_obsidian_note", { path: "设计/缓存方案.md" })).structuredContent.read).toMatchObject({ status: "unavailable", note: null });

    const old = await app("old");
    const unknown = await old.call("search_obsidian_notes", { query: "Redis" });
    expect(unknown.isError).toBe(true);
    expect(unknown.structuredContent.search).toBeNull();
    expect(unknown.content[0]!.text).toContain("可能还不支持普通笔记检索");
  });

  it("answers only the bridge holding the App's token", async () => {
    const { port } = await app();
    for (const route of ["search", "read"]) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/obsidian-notes/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${"x".repeat(64)}` },
        body: JSON.stringify(route === "search" ? { query: "Redis" } : { path: "设计/缓存方案.md" }),
      });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain("Redis");
    }
  });
});
