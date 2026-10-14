import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as serverCatalog from "../src/main/model/cli/cli-model-server.js";
import { queryCliModels } from "../src/main/model/cli/cli-model-catalog.js";
import { ManagedChildProcessRunner } from "../src/main/model/cli/managed-child-process.js";
import type { ManagedProcessRequest } from "../src/main/model/cli/managed-child-process.js";

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const base = { executable: process.execPath, cwd: tmpdir(), timeoutMs: 1000, maximumStdoutBytes: 1000, maximumStderrBytes: 1000, environment: {} };
const result = (stdout: string) => ({ stdout, stderr: "", exitCode: 0, durationMs: 1 });

describe("CLI model catalog", () => {
  it("uses server candidates before the CLI, persists them, and restores them when both lookups fail", async () => {
    const directory = await mkdtemp(join(tmpdir(), "decision-catalog-")); directories.push(directory);
    const models = [{ id: "server-model", label: "Server model" }];
    const lookup = vi.spyOn(serverCatalog, "queryCliServerModels").mockResolvedValue(models);
    const run = vi.fn(async () => { throw new Error("offline"); });
    expect(await queryCliModels("claude-code", base, { run }, directory)).toEqual({ modelsSource: "server", models });
    expect(run).not.toHaveBeenCalled();
    lookup.mockResolvedValue(undefined);
    expect(await queryCliModels("claude-code", base, { run }, directory)).toEqual({ modelsSource: "cache", models });
    expect(run).toHaveBeenCalledOnce();
  });

  it("queries Codex after initialization, handles fragmented pages, and omits hidden/account metadata", async () => {
    const run = vi.fn(async (request: ManagedProcessRequest) => {
      expect(request.args).toEqual(["app-server", "--listen", "stdio://"]);
      expect(JSON.parse(request.stdin).method).toBe("initialize");
      const init = '{"id":1,"result":{"account":"private"}}\n';
      expect(request.conversation!(init.slice(0, 10))).toEqual({ input: "", complete: false });
      const next = request.conversation!(init).input!;
      expect(next).toContain('"method":"initialized"');
      expect(next).toContain('"method":"model/list"');
      const first = init + JSON.stringify({ id: 2, result: { data: [{ model: "live", displayName: "Live" }, { model: "hidden", displayName: "Hidden", hidden: true }, { model: "x".repeat(201), displayName: "Invalid" }], nextCursor: "page2" } }) + "\n";
      expect(request.conversation!(first).input).toContain('"cursor":"page2"');
      const all = first + '{"id":3,"result":{"data":[{"model":"next","displayName":"Next"}],"nextCursor":null}}\n';
      expect(request.conversation!(all).complete).toBe(true);
      return result(all);
    });
    expect(await queryCliModels("codex", base, { run })).toEqual({ modelsSource: "client", models: [{ id: "live", label: "Live" }, { id: "next", label: "Next" }] });
  });

  it.each(["codex", "claude-code"] as const)("persists only %s model names and falls back after timeout, with separate proxy caches", async (client) => {
    const directory = await mkdtemp(join(tmpdir(), "decision-catalog-")); directories.push(directory);
    const stdout = client === "codex"
      ? '{"id":1,"result":{}}\n{"id":2,"result":{"data":[{"model":"live-model","displayName":"Live"}],"nextCursor":null}}\n'
      : '{"type":"control_response","response":{"subtype":"success","request_id":"catalog-init","response":{"account":"private","models":[{"value":"sonnet","displayName":"Sonnet","description":"private"}]}}}\n';
    const run = vi.fn(async (request: ManagedProcessRequest) => {
      expect(request.timeoutMs).toBe(8000);
      expect(request.stdin).not.toContain('"type":"user"');
      request.conversation!(stdout);
      return result(stdout);
    });
    const first = await queryCliModels(client, base, { run }, directory);
    expect(first.modelsSource).toBe("client");
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    expect(await readFile(join(directory, files[0]!), "utf8")).not.toContain("private");
    run.mockClear();
    expect(await queryCliModels(client, base, { run }, directory, false)).toEqual({ modelsSource: "cache", models: first.models });
    expect(run).not.toHaveBeenCalled();
    run.mockRejectedValue(new Error("timeout"));
    expect(await queryCliModels(client, base, { run }, directory)).toEqual({ modelsSource: "cache", models: first.models });
    expect(await queryCliModels(client, { ...base, environment: { HTTPS_PROXY: "http://different:8080" } }, { run }, directory)).toEqual({ models: [] });
    // A new discovery instance can use persisted candidates after a restart.
    expect(await queryCliModels(client, base, { run: async () => { throw new Error("offline"); } }, directory)).toEqual({ modelsSource: "cache", models: first.models });
  });

  it.each(["bad JSON", '{"id":1,"error":{"message":"private"}}\n', '{"type":"control_response","response":{"request_id":"catalog-init","subtype":"error"}}\n'])("tolerates invalid protocol responses: %s", async stdout => {
    for (const client of ["codex", "claude-code"] as const) {
      expect(await queryCliModels(client, base, { run: async () => result(stdout) })).toEqual({ models: [] });
    }
  });
});


it.runIf(process.env.DECISION_LIVE_CLI_CATALOG === "1")("reads both installed CLI catalogs without a user/model turn, then restores offline candidates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "decision-live-catalog-")); directories.push(directory);
  for (const [client, executable] of [["codex", process.env.DECISION_CODEX_EXECUTABLE!], ["claude-code", process.env.DECISION_CLAUDE_EXECUTABLE!]] as const) {
    const request = { ...base, executable, environment: { ...process.env, DECISION_PROVIDER_CHILD: "1" } };
    const runner = new ManagedChildProcessRunner();
    const output = await runner.run({ ...request, args: ["--version"], stdin: "", timeoutMs: 2000 });
    const version = output.stdout.match(/\b(\d+\.\d+\.\d+)\b/u)?.[1];
    expect(version).toBeDefined();
    const live = await queryCliModels(client, request, runner, directory, true, version);
    expect(live.modelsSource).toBe("server");
    expect(live.models.length).toBeGreaterThan(0);
    const fallback = await queryCliModels(client, request, { run: async () => { throw new Error("offline"); } }, directory, false);
    expect(fallback).toEqual({ modelsSource: "cache", models: live.models });
  }
}, 25_000);
