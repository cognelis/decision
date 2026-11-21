import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, realpath, rm, symlink, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewEvaluation, reviewFix, reviewAgentOutput, reviewToolEvents, reviewPermissionSettings, reviewToolEnvironment, REVIEW_AGENT_SETTINGS, reviewToolReadRoot } from "../src/main/local-review-agent.js";
const accept = (id: string) => ({ id, verdict: "accept", reason: "核实成立" });
const group = (annotationIds: string[]) => ({ title: "修复", annotationIds, reason: "相同根因且可独立合并" });
describe("local review agent validation", () => {
  it.each([".volta", ".rustup", ".cargo", "tools/node", "tools/node/22.22.2"])("does not grant the unknown or manager directory %s", async layout => {
    const root = await mkdtemp(join(tmpdir(), "lr-prefix-")), home = join(root, "home"), prefix = join(home, layout), executable = join(prefix, "bin/node");
    try {
      await mkdir(join(prefix, "bin"), { recursive: true }); await copyFile(process.execPath, executable);
      expect(await reviewToolReadRoot(executable, prefix, home)).toBe(await realpath(executable));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("canonicalizes HOME, executable and prefix before refusing HOME or its ancestors", async () => {
    const root = await mkdtemp(join(tmpdir(), "lr-home-alias-")), home = join(root, "home"), logical = join(root, "logical-home"), executable = join(home, "bin/node");
    try {
      await mkdir(join(home, "bin"), { recursive: true }); await copyFile(process.execPath, executable); await symlink(home, logical);
      for (const prefix of [home, logical, root, "/"]) expect(await reviewToolReadRoot(join(logical, "bin/node"), prefix, logical)).toBe(await realpath(executable));
      expect(await reviewToolReadRoot(executable, home)).toBe(await realpath(executable));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("keeps a canonical versioned Node installation usable without granting an ancestor", async () => {
    const root = await mkdtemp(join(tmpdir(), "lr-versioned-")), home = join(root, "home"), prefix = join(home, ".volta/tools/image/node/22.22.2"), executable = join(prefix, "bin/node"), alias = join(root, "install-alias");
    try {
      await mkdir(join(prefix, "bin"), { recursive: true }); await copyFile(process.execPath, executable); await symlink(prefix, alias);
      expect(await reviewToolReadRoot(join(alias, "bin/node"), alias, home)).toBe(await realpath(prefix));
      expect(execFileSync(executable, ["-e", "process.stdout.write('LR_NODE_OK')"], { env: { OPENSSL_CONF: "/dev/null" }, encoding: "utf8" })).toBe("LR_NODE_OK");
      const nestedHome = join(prefix, "..home"); await mkdir(nestedHome);
      expect(await reviewToolReadRoot(executable, prefix, nestedHome)).toBe(await realpath(executable));
      for (const aggregate of ["/opt/homebrew", "/usr/local"]) expect(await reviewToolReadRoot(executable, aggregate, home)).toBe(await realpath(executable));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps Python caches and temporary files outside the working tree", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lr-scratch-")), tree = join(directory, "tree"), scratch = join(directory, "scratch");
    try {
      await mkdir(tree); await mkdir(scratch);
      const copy = { directory, tree, git: join(directory, "git") }, environment = reviewToolEnvironment(copy);
      for (const name of ["HOME", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"] as const) expect(environment[name]).toMatch(new RegExp(`^${scratch}`));
      expect(environment.OPENSSL_CONF).toBe("/dev/null");
      const result = JSON.parse(execFileSync("/usr/bin/python3", ["-c", "import pathlib, urllib.parse, tempfile, json, os; print(json.dumps({'home':os.environ['HOME'],'temp':tempfile.gettempdir()}))"], { cwd: tree, env: environment, encoding: "utf8" }));
      expect(result.home).toBe(scratch); expect(result.temp.replace(/^\/private/u, "")).toBe(scratch.replace(/^\/private/u, ""));
      expect(await readdir(tree)).toEqual([]);
      for (const write of [false, true]) expect(reviewPermissionSettings(copy, "/cli/codex", write).join("\n")).toContain(`${JSON.stringify(scratch)}="write"`);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("fails closed on unknown tool events", () => {
    expect(() => reviewToolEvents(JSON.stringify({type:"item.completed",item:{type:"mcp_tool_call"}}))).toThrow("未知工具事件");
  });
  it.each([[], [accept("a"), accept("a")], [accept("a"), accept("unknown")]].map(verdicts => ({ verdicts })))("never turns damaged verdicts into acceptance: $verdicts", ({ verdicts }) => {
    expect(() => reviewEvaluation({ verdicts, groups: [] }, ["a", "b"])).toThrow();
  });
  it.each([undefined, null, {}, [], [group([])], [group(["a", "b"])], [group(["a"]), group(["a"])], Array.from({ length: 9 }, () => group(["a"]))])("falls back only for invalid partition %j", groups => {
    const result = reviewEvaluation({ verdicts: [accept("a"), { id: "b", verdict: "reject", reason: "不成立" }], groups }, ["a", "b"]);
    expect(result.groups.map(g => g.annotationIds)).toEqual([["a"]]);
    expect(result.fallback).toBe("invalid_group_partition");
  });
  it("keeps no_changes, needs_input and valid groups distinct", () => {
    expect(reviewEvaluation({ verdicts: [{ id: "a", verdict: "needs_input", reason: "需要上下文" }], groups: [{}] }, ["a"]).groups).toEqual([]);
    expect(reviewEvaluation({ verdicts: [accept("a"), accept("b")], groups: [group(["a"]), group(["b"])] }, ["a", "b"]).fallback).toBeNull();
  });
  it("requires complete fix IDs, a single-line title and verification", () => {
    expect(() => reviewFix({ changedFiles: [], outcomes: [], commitTitle: "修复", verification: "未运行" }, ["a"])).toThrow();
    expect(() => reviewFix({ outcomes: [{ id: "a", outcome: "fixed", summary: "已修复" }], commitTitle: "修复\nbody", verification: "未运行" }, ["a"])).toThrow();
  });
  it("requires a completed turn, rejects malformed logs and bounds the final answer independently", () => {
    const message = { type: "item.completed", item: { type: "agent_message", text: '{"ok":true}' } };
    expect(() => reviewAgentOutput(JSON.stringify(message))).toThrow();
    expect(reviewAgentOutput([message, { type: "turn.completed" }].map(v => JSON.stringify(v)).join("\n"))).toEqual({ ok: true });
    expect(() => reviewAgentOutput('{"type":"error"}')).toThrow();
    expect(() => reviewAgentOutput("not json")).toThrow();
  });
  it("uses named permission profiles with no sandbox fallback or credential environment in tools", () => {
    const settings = reviewPermissionSettings({ directory: "/jobs/a", tree: "/jobs/a/tree", git: "/jobs/a/git" }, "/cli/bin/codex", true);
    expect(settings.join("\n")).toContain('":workspace_roots"="write"');
    expect(settings.join("\n")).toContain('"/jobs/a/git"="read"');
    expect(settings.join("\n")).not.toContain("sandbox_mode");
    expect(settings.join("\n")).toContain('"/cli/bin/codex"="read"');
    expect(settings.join("\n")).not.toContain('"/cli/bin"="read"');
    expect(REVIEW_AGENT_SETTINGS).toContain('shell_environment_policy.inherit="none"');
    expect(REVIEW_AGENT_SETTINGS).toContain("features.hooks=false");
  });
});
