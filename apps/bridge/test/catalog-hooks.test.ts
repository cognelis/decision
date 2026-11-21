import type { SemanticDecisionPair } from "@cognelis/decision-protocol";
import { CATALOG_CLIENTS, clientHookPaths, installIntegrations, writeCustomClients } from "@cognelis/decision-integrations";
import type { CustomClient } from "@cognelis/decision-protocol";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/cli.js";
import { readLastDecisionTurn } from "../src/transcript-tail.js";
import { auggie } from "./catalog-fixtures/auggie.js";
import { codebuddy } from "./catalog-fixtures/codebuddy.js";
import { copilot } from "./catalog-fixtures/copilot.js";
import { cursor } from "./catalog-fixtures/cursor.js";
import { droid } from "./catalog-fixtures/droid.js";
import { geminiCli } from "./catalog-fixtures/gemini-cli.js";
import { qoder, qoderCn } from "./catalog-fixtures/qoder.js";
import { qwenCode } from "./catalog-fixtures/qwen-code.js";
import { ANSWER, QUESTION, type CatalogFixture } from "./catalog-fixtures/types.js";

const FIXTURES = [qwenCode, qoder, qoderCn, auggie, geminiCli, cursor, copilot, codebuddy, droid];

const harness = async (environment: NodeJS.ProcessEnv = {}) => {
  const root = await mkdtemp(join(tmpdir(), "decision-catalog-hooks-"));
  const pairs: SemanticDecisionPair[] = [];
  const env = {
    ...environment,
    PARASELF_TEXT_PENDING: join(root, "text-pending"),
    // No file of the reader's own: a catalog tool is found without one.
    PARASELF_CUSTOM_CLIENTS: join(root, "custom-clients.json"),
  };
  const run = (operation: string, client: string, input: unknown) =>
    main(["hook", operation, client], {
      environment: env,
      audit: { record: vi.fn(async () => undefined) },
      spool: { append: vi.fn(async () => undefined) },
      semanticPairSpool: { append: vi.fn(async (pair: SemanticDecisionPair) => { pairs.push(pair); return "accepted" as const; }) },
      runtime: { deliver: vi.fn(async () => null), deliverSemanticPair: vi.fn(async () => true), doctor: vi.fn(async () => ({})) },
      printJson: () => { throw new Error("a hook prints nothing"); },
      readStdin: async () => input,
    });
  return { root, pairs, run };
};

/** What a client's hook writes to stdout reaches its model (Qwen's, Qoder's, Droid's UserPromptSubmit) or keeps it going (Cursor's stop). */
const stdout = vi.spyOn(process.stdout, "write");
afterEach(() => stdout.mockClear());

describe("the catalog's tools, by their documented hook inputs", () => {
  it.each(FIXTURES.map((fixture) => [fixture.id, fixture] as const))(
    "%s: pairs the second turn's prompt with the first turn's reply, printing nothing",
    async (_id, fixture: CatalogFixture) => {
      const { root, pairs, run } = await harness();
      const transcript = join(root, "transcript.jsonl");
      if (fixture.transcript !== undefined) await writeFile(transcript, `${fixture.transcript.map((line) => JSON.stringify(line)).join("\n")}\n`);
      for (const { operation, input } of fixture.events) {
        const value = JSON.parse(JSON.stringify(input).replaceAll('"{transcript}"', JSON.stringify(transcript))) as unknown;
        expect(await run(operation, fixture.id, value)).toBe(0);
      }
      expect(stdout).not.toHaveBeenCalled();
      expect(pairs).toHaveLength(1);
      expect(pairs[0]).toMatchObject({ sourceClient: fixture.id, ...fixture.pair });
      if (fixture.pair.assistantTurnId === undefined) expect(pairs[0]!.assistantTurnId).toBeUndefined();
    },
  );

  it("reads Auggie's prompt before its reply in the one Stop", async () => {
    // Saved first, the turn's own reply was paired with the prompt that asked for it.
    const { pairs, run } = await harness();
    const stop = (prompt: string, reply: string) => ({
      hook_event_name: "Stop", conversation_id: "c1", workspace_roots: ["/w"], agent_stop_cause: "end_turn",
      conversation: { userPrompt: prompt, agentTextResponse: reply },
    });
    await run("stop", "auggie", stop("存储怎么选？", QUESTION));
    expect(pairs).toHaveLength(0);
    await run("stop", "auggie", stop(ANSWER, "好的。"));
    expect(pairs.map((pair) => [pair.assistantText, pair.userText])).toEqual([[QUESTION, ANSWER]]);
  });

  it("keeps no reply of a Copilot turn that did not end of itself", async () => {
    const { root, pairs, run } = await harness();
    const transcript = join(root, "events.jsonl");
    await writeFile(transcript, `${JSON.stringify({ type: "assistant.message", data: { content: QUESTION } })}\n`);
    const base = { session_id: "s", cwd: "/w" };
    await run("stop", "copilot", { ...base, hook_event_name: "Stop", transcript_path: transcript, stop_reason: "aborted" });
    await run("user-prompt-submit", "copilot", { ...base, hook_event_name: "UserPromptSubmit", prompt: ANSWER });
    expect(pairs).toEqual([]);
  });
});

describe("Claude Code's hooks run by another client", () => {
  const claudeTurn = async (environment: NodeJS.ProcessEnv, stop: Record<string, unknown>, prompt: Record<string, unknown>) => {
    const { pairs, run } = await harness(environment);
    expect(await run("stop", "claude-code", stop)).toBe(0);
    expect(await run("user-prompt-submit", "claude-code", prompt)).toBe(0);
    return pairs;
  };
  const claude = { session_id: "cc-1", cwd: "/w", transcript_path: "/nowhere.jsonl" };

  it("records nothing of a Cursor turn, told by Cursor's input or by its hook's CURSOR_VERSION", async () => {
    const cursorInput = { conversation_id: "c-1", generation_id: "g-1", cursor_version: "2026.10.22", workspace_roots: ["/w"] };
    expect(await claudeTurn({}, { ...cursorInput, session_id: "c-1", cwd: "/w", last_assistant_message: QUESTION }, { ...cursorInput, session_id: "c-1", prompt: ANSWER })).toEqual([]);
    expect(await claudeTurn({ CURSOR_VERSION: "2026.10.22" }, { conversation_id: "c-1", cwd: "/w", status: "completed" }, { conversation_id: "c-1", prompt: ANSWER })).toEqual([]);
  });

  it("records nothing of a Droid turn its migration copied Claude Code's hooks into, told by its transcript under ~/.factory", async () => {
    const droid = { ...claude, transcript_path: "/Users/me/.factory/projects/w/abc123.jsonl" };
    expect(await claudeTurn({ HOME: "/Users/me" }, { ...droid, last_assistant_message: QUESTION }, { ...droid, prompt: ANSWER })).toEqual([]);
    // `..` resolved: a path that climbs out of ~/.factory is not under it.
    const outside = { ...claude, transcript_path: "/Users/me/.factory/../.claude/projects/w/s.jsonl" };
    expect(await claudeTurn({ HOME: "/Users/me" }, { ...outside, last_assistant_message: QUESTION }, { ...outside, prompt: ANSWER })).toHaveLength(1);
  });

  // CL2-REVIEW-CAT CAP-2: a variable a terminal left over is no sign the turn is another client's.
  it.each([{}, { CURSOR_VERSION: "inherited" }, { FACTORY_PROJECT_DIR: "/left-over-project" }])("still records Claude Code's own turn with %j about", async (environment) => {
    const turn = { ...claude, transcript_path: "/Users/me/.claude/projects/w/cc-1.jsonl" };
    const pairs = await claudeTurn({ HOME: "/Users/me", ...environment }, { ...turn, last_assistant_message: QUESTION }, { ...turn, prompt: ANSWER });
    expect(pairs.map((pair) => [pair.assistantText, pair.userText])).toEqual([[QUESTION, ANSWER]]);
  });

  it("still records Claude Code's own turn in a terminal that has CURSOR_VERSION for another reason", async () => {
    const pairs = await claudeTurn({ CURSOR_VERSION: "1.7.2" }, { ...claude, last_assistant_message: QUESTION }, { ...claude, prompt: ANSWER });
    expect(pairs.map((pair) => [pair.sourceClient, pair.userText])).toEqual([["claude-code", ANSWER]]);
  });
});

describe("what a catalog tool sends beside its documented fields", () => {
  it("takes CodeBuddy's undocumented last_assistant_message before its transcript, and no Qwen placeholder for a reply", async () => {
    const { pairs, run } = await harness();
    const base = { session_id: "cb", cwd: "/w", transcript_path: "/nowhere.jsonl" };
    await run("stop", "codebuddy", { ...base, hook_event_name: "Stop", last_assistant_message: QUESTION });
    await run("user-prompt-submit", "codebuddy", { ...base, hook_event_name: "UserPromptSubmit", prompt: ANSWER });
    expect(pairs.map((pair) => pair.assistantText)).toEqual([QUESTION]);

    const qwen = { session_id: "qw", cwd: "/w" };
    await run("stop", "qwen-code", { ...qwen, hook_event_name: "Stop", last_assistant_message: QUESTION });
    await run("stop", "qwen-code", { ...qwen, hook_event_name: "Stop", last_assistant_message: "[no response text]" });
    await run("user-prompt-submit", "qwen-code", { ...qwen, hook_event_name: "UserPromptSubmit", submitted_prompt: ANSWER });
    // The placeholder turn's reply is no question: the answer after it is not paired with it.
    expect(pairs.filter((pair) => pair.sourceClient === "qwen-code").map((pair) => pair.assistantText)).not.toContain("[no response text]");
  });
});

describe("Auggie's hook as Auggie runs it", () => {
  it("runs the bridge with its arguments and no shell, as 0.36.0 runs a command with args, and pairs its turns", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-auggie-argv-"));
    const home = join(root, "home");
    // A stand-in bridge that says how it was called.
    const bridgePath = join(root, "paraself-bridge");
    await writeFile(bridgePath, `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(root, "argv.txt")}"\n`);
    await chmod(bridgePath, 0o755);
    const auggie = CATALOG_CLIENTS.find((client) => client.id === "auggie")!;
    const paths = clientHookPaths([auggie], {}, home);
    await installIntegrations({ mode: "apply", bridgePath, platform: "darwin", clients: [auggie], paths, home, runner: async () => ({ exitCode: 0 }) });
    const groups = (JSON.parse(await readFile(paths.auggie!, "utf8")) as { hooks: { Stop: { hooks: { command: string; args?: string[] }[] }[] } }).hooks.Stop;
    const handler = groups.flatMap((group) => group.hooks).find((entry) => entry.command === bridgePath)!;

    // augment.mjs 0.36.0 (dao): a command with args is spawned as it is, `shell: false`.
    const run = spawnSync(handler.command, handler.args ?? [], { shell: false });
    expect(run.error).toBeUndefined();
    expect((await readFile(join(root, "argv.txt"), "utf8")).trim().split("\n")).toEqual(["hook", "stop", "auggie", "PARASELF_HOOK=1"]);
    // The command line it wrote before: no shell character in it, so split on spaces, its first word the program.
    expect(spawnSync("PARASELF_HOOK=1", [`'${bridgePath}'`, "hook", "stop", "auggie"], { shell: false }).error).toMatchObject({ code: "ENOENT" });

    // The bridge, called with those arguments, reads Auggie's Stop as its hook would.
    const { pairs, run: hook } = await harness();
    const stop = (prompt: string, reply: string) => ({
      hook_event_name: "Stop", conversation_id: "c1", workspace_roots: ["/w"], agent_stop_cause: "end_turn",
      conversation: { userPrompt: prompt, agentTextResponse: reply },
    });
    expect(handler.args!.slice(0, 3)).toEqual(["hook", "stop", "auggie"]);
    await hook(handler.args![1]!, handler.args![2]!, stop("存储怎么选？", QUESTION));
    await hook(handler.args![1]!, handler.args![2]!, stop(ANSWER, "好的。"));
    expect(pairs.map((pair) => [pair.sourceClient, pair.assistantText, pair.userText])).toEqual([["auggie", QUESTION, ANSWER]]);
  });

  it("is read by the bridge with the marker as a fourth argument", async () => {
    const { pairs } = await harness();
    const environment = { PARASELF_TEXT_PENDING: join(await mkdtemp(join(tmpdir(), "decision-auggie-main-")), "p"), PARASELF_CUSTOM_CLIENTS: "/nowhere.json" };
    const stop = (prompt: string, reply: string) => ({
      hook_event_name: "Stop", conversation_id: "c2", workspace_roots: ["/w"], agent_stop_cause: "end_turn",
      conversation: { userPrompt: prompt, agentTextResponse: reply },
    });
    const call = (input: unknown) => main(["hook", "stop", "auggie", "PARASELF_HOOK=1"], {
      environment,
      audit: { record: vi.fn(async () => undefined) },
      spool: { append: vi.fn(async () => undefined) },
      semanticPairSpool: { append: vi.fn(async (pair: SemanticDecisionPair) => { pairs.push(pair); return "accepted" as const; }) },
      runtime: { deliver: vi.fn(async () => null), deliverSemanticPair: vi.fn(async () => true), doctor: vi.fn(async () => ({})) },
      readStdin: async () => input,
    });
    expect(await call(stop("存储怎么选？", QUESTION))).toBe(0);
    expect(await call(stop(ANSWER, "好的。"))).toBe(0);
    expect(pairs.map((pair) => pair.userText)).toEqual([ANSWER]);
    expect(stdout).not.toHaveBeenCalled();
  });
});

// CL2-REVIEW-CAT (rounds/CL2/review-cat/bridge): the reviewer's reproductions, kept as the behaviour they asked for.
describe("turns as the review found them", () => {
  const legacy: CustomClient = {
    id: "legacy-same-event", name: "旧同事件工具", shortName: "LS",
    hooks: { file: "~/.legacy/hooks.json", format: "claude" },
    prompt: { event: "AfterAgent", field: "prompt" },
    reply: { event: "AfterAgent", source: "field", field: "reply" },
    fields: { sessionId: "session_id", cwd: "cwd" }, mcp: { mode: "none" },
  };
  const NEXT = "部署选择方案 C 还是方案 D？";

  it.each([["user-prompt-submit", "stop"], ["stop", "user-prompt-submit"]])(
    "pairs across turns alone while an earlier build's two handlers on one event are still there, %s first (CAP-1)",
    async (first, second) => {
      const { root, pairs, run } = await harness();
      const customClients = join(root, "custom-clients.json");
      await writeCustomClients(customClients, [legacy]);
      const call = (operation: string, input: unknown) => main(["hook", operation, legacy.id], {
        environment: { PARASELF_TEXT_PENDING: join(root, "text-pending"), PARASELF_CUSTOM_CLIENTS: customClients },
        audit: { record: vi.fn(async () => undefined) },
        spool: { append: vi.fn(async () => undefined) },
        semanticPairSpool: { append: vi.fn(async (pair: SemanticDecisionPair) => { pairs.push(pair); return "accepted" as const; }) },
        runtime: { deliver: vi.fn(async () => null), deliverSemanticPair: vi.fn(async () => true), doctor: vi.fn(async () => ({})) },
        readStdin: async () => input,
      });
      const turn1 = { session_id: "legacy-session", cwd: "/w", prompt: "请选择存储方案", reply: QUESTION };
      const turn2 = { ...turn1, prompt: "选 A", reply: NEXT };
      for (const turn of [turn1, turn2]) for (const operation of [first!, second!]) expect(await call(operation, turn)).toBe(0);
      expect(pairs.map((pair) => [pair.assistantText, pair.userText])).toEqual([[QUESTION, "选 A"]]);
    },
  );

  const row = (client: string, role: "user" | "assistant", content: string) =>
    client === "copilot"
      ? { type: `${role}.message`, data: { content, ...(role === "user" && content === "" ? { attachments: [{ type: "file", path: "/synthetic/diagram.png" }] } : {}) } }
      : client === "codebuddy"
        ? { type: "message", role, content }
        : { type: "message", message: { role, content } };

  it.each(["copilot", "codebuddy", "droid"])("%s: a new turn of the reader's with no text ends the reply before it (CAP-3)", async (client) => {
    const { root, pairs, run } = await harness();
    const path = join(root, "events.jsonl");
    await writeFile(path, [row(client, "user", "旧任务"), row(client, "assistant", QUESTION), row(client, "user", "")].map((line) => JSON.stringify(line)).join("\n"));
    expect(await run("stop", client, { session_id: "s", cwd: "/w", transcript_path: path, stop_reason: "end_turn" })).toBe(0);
    await run("user-prompt-submit", client, { session_id: "s", cwd: "/w", prompt: "选 C" });
    expect(pairs).toEqual([]);
  });

  it.each(["copilot", "codebuddy", "droid"])("%s: a tool's result or the client's own line is no new turn (CAP-3)", async (client) => {
    const { root } = await harness();
    const path = join(root, "events.jsonl");
    const lines: unknown[] = [row(client, "user", "旧任务"), row(client, "assistant", QUESTION)];
    if (client === "codebuddy") lines.push({ type: "message", role: "user", content: [{ type: "input_text", text: "<system-reminder>提醒</system-reminder>" }] }, { type: "function_call_result", call_id: "c", output: "" });
    if (client === "droid") lines.push({ type: "message", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "" }] } });
    if (client === "copilot") lines.push({ type: "user.message", agentId: "sub-1", data: { content: "" } }, { type: "user.message", ephemeral: true, data: { content: "" } });
    await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n"));
    const format = client === "droid" ? "droid" : client;
    expect((await readLastDecisionTurn(path, { format: format as "copilot" | "codebuddy" | "droid" }))?.assistantText).toBe(QUESTION);
  });

  it.each(["copilot", "codebuddy", "droid"])("%s: a transcript not there at all drops the reply waiting from before", async (client) => {
    const { root, pairs, run } = await harness();
    const base = { session_id: "s", cwd: "/w", stop_reason: "end_turn" };
    await run("stop", client, { ...base, last_assistant_message: QUESTION });
    await run("stop", client, { ...base, transcript_path: join(root, "absent.jsonl") });
    await run("user-prompt-submit", client, { ...base, prompt: "选 C" });
    expect(pairs).toEqual([]);
  });

  it("joins Copilot's chunks as written, a space at a chunk's edge and a chunk of spaces alone kept (CAP-4)", async () => {
    const { root } = await harness();
    const path = join(root, "events.jsonl");
    await writeFile(path, ["Use ", "SQLite", " ", "or\n", "  JSON?"].map((content, chunkIndex) => JSON.stringify({
      type: "assistant.message", data: { apiCallId: "a", content, chunkIndex, chunkCount: 5 },
    })).join("\n"));
    expect((await readLastDecisionTurn(path, { format: "copilot" }))?.assistantText).toBe("Use SQLite or\n  JSON?");
  });

  it("skips Copilot's thinking, joins one call's chunks, and reads the last 64 KiB alone", async () => {
    const { root } = await harness();
    const path = join(root, "events.jsonl");
    const event = (content: string, extra = {}) => JSON.stringify({ type: "assistant.message", data: { content, apiCallId: "a", ...extra } });
    await writeFile(path, `${"x".repeat(100_000)}\n${[event("A"), event("secret", { phase: "thinking" }), event("B")].join("\n")}`);
    const reads: { length: number; position: number }[] = [];
    const turn = await readLastDecisionTurn(path, {
      format: "copilot",
      read: async (file, options) => { reads.push(options); return file.read(options); },
    });
    expect(turn?.assistantText).toBe("AB");
    expect(reads[0]).toMatchObject({ length: 65_536 });
    expect(reads.every((read) => read.length <= 65_536)).toBe(true);
  });
});
