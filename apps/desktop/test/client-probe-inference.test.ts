import type { ClientProbeRecord, CustomClient } from "@cognelis/decision-protocol";
import { describe, expect, it } from "vitest";

import { checkPlan, describeRecords, inferMapping, probePhrase } from "../src/main/client-probe-inference.js";

const SECRET = "DECISION-7F3K2Q";
const PHRASE = probePhrase(SECRET);
const record = (event: string, input: unknown, receivedAt: number, transcripts: ClientProbeRecord["transcripts"] = []): ClientProbeRecord =>
  ({ event, input, receivedAt, transcripts });

// Claude Code's shape: snake_case, the reply in the Stop input, a reason to tell a turn's end from a session's.
const claudeStyle = [
  record("UserPromptSubmit", { session_id: "sess-91ab", cwd: "/work/app", hook_event_name: "UserPromptSubmit", turn_id: "turn-1", prompt: PHRASE, transcript_path: "/home/u/.fake/t.jsonl" }, 1),
  record("Stop", { session_id: "sess-91ab", cwd: "/work/app", hook_event_name: "Stop", turn_id: "turn-1", reason: "end_turn", last_assistant_message: `\`${SECRET}\``, transcript_path: "/home/u/.fake/t.jsonl" }, 2),
];
const claudeProbe = { hooks: { file: "~/.fake/hooks.json", format: "claude" as const }, events: ["UserPromptSubmit", "Stop"], secret: SECRET };

// A named hook's (Antigravity's) shape: camelCase, the folder a list, no reply in the input, read off the transcript.
const namedStyle = [
  record("PreInvocation", { conversationId: "conv-55", workspacePaths: ["/work/agy", "/work/other"], lastUserInput: PHRASE, invocationNum: 0 }, 10),
  record("PreInvocation", { conversationId: "conv-55", workspacePaths: ["/work/agy"], lastUserInput: PHRASE, invocationNum: 1 }, 11),
  record("Stop", { conversationId: "conv-55", workspacePaths: ["/work/agy"], terminationReason: "NO_TOOL_CALL", transcriptPath: "/home/u/.gemini/t.jsonl" }, 12, [
    { field: "transcriptPath", format: "claude", matched: false },
    { field: "transcriptPath", format: "antigravity", matched: true },
  ]),
];
const namedProbe = { hooks: { file: "~/.gemini/config/hooks.json", format: "antigravity" as const }, events: ["PreInvocation", "Stop"], secret: SECRET };

describe("the fields, worked out from what the tool sent", () => {
  it("reads a Claude-style tool's prompt, reply, session, folder, turn and turn's end", () => {
    expect(inferMapping(claudeStyle, claudeProbe)).toEqual({
      ok: true,
      notes: [expect.stringContaining("reason")],
      mapping: {
        hooks: claudeProbe.hooks,
        prompt: { event: "UserPromptSubmit", field: "prompt" },
        reply: { event: "Stop", source: "field", field: "last_assistant_message" },
        fields: { sessionId: "session_id", cwd: "cwd", turnId: "turn_id" },
        complete: { field: "reason", values: ["end_turn"] },
      },
    });
  });

  it("reads a named hook's, its reply off the transcript format that held the secret, its folder a list", () => {
    const inferred = inferMapping(namedStyle, namedProbe);
    expect(inferred).toMatchObject({
      ok: true,
      mapping: {
        prompt: { event: "PreInvocation", field: "lastUserInput" },
        reply: { event: "Stop", source: "transcript", format: "antigravity", field: "transcriptPath" },
        fields: { sessionId: "conversationId", cwd: "workspacePaths" },
        complete: { field: "terminationReason", values: ["NO_TOOL_CALL"] },
      },
    });
    expect(inferred.ok && inferred.mapping.fields.turnId).toBeUndefined();
  });

  it("finds a reply in the transcript where a Claude-style input holds none, and the secret as a substring", () => {
    const [prompt] = claudeStyle;
    const stop = record("Stop", { session_id: "sess-91ab", cwd: "/work/app", transcript_path: "/home/u/.fake/t.jsonl" }, 2, [{ field: "transcript_path", format: "claude", matched: true }]);
    expect(inferMapping([prompt!, stop], claudeProbe)).toMatchObject({ ok: true, mapping: { reply: { source: "transcript", format: "claude", field: "transcript_path" } } });
    const formatted = record("Stop", { session_id: "sess-91ab", cwd: "/work/app", output: { text: `好的：**${SECRET}**。` } }, 3);
    expect(inferMapping([prompt!, formatted], claudeProbe)).toMatchObject({ ok: true, mapping: { reply: { field: "output.text" } } });
  });

  it("says why where the line, the reply, the session or the folder cannot be found", () => {
    expect(inferMapping([], claudeProbe)).toMatchObject({ ok: false });
    expect(inferMapping([claudeStyle[0]!], claudeProbe)).toMatchObject({ ok: false, reasons: [expect.stringContaining("暗号")] });
    const noSession = [record("UserPromptSubmit", { cwd: "/w", prompt: PHRASE }, 1), record("Stop", { cwd: "/w", reply: SECRET }, 2)];
    expect(inferMapping(noSession, claudeProbe)).toMatchObject({ ok: false, reasons: [expect.stringContaining("会话 id")] });
    const noFolder = [record("UserPromptSubmit", { session_id: "s", prompt: PHRASE }, 1), record("Stop", { session_id: "s", reply: SECRET }, 2)];
    expect(inferMapping(noFolder, claudeProbe)).toMatchObject({ ok: false, reasons: [expect.stringContaining("工作目录")] });
    // The secret is the program's, never said in a reason the model is given.
    for (const records of [[], [claudeStyle[0]!], noSession, noFolder]) {
      expect(JSON.stringify(inferMapping(records, claudeProbe))).not.toContain(SECRET);
    }
  });
});

describe("what the model is told of the catch", () => {
  it("names events, paths, types and where the secret was, and no value the tool sent", () => {
    const told = describeRecords([...claudeStyle, ...namedStyle], SECRET);
    expect(told).toContain("事件 1：UserPromptSubmit");
    expect(told).toContain("prompt: 文本（含整句暗号）");
    expect(told).toContain("last_assistant_message: 文本（含暗号）");
    expect(told).toContain("transcriptPath 按 antigravity 格式读出了暗号");
    for (const value of ["sess-91ab", "/work/app", "turn-1", "end_turn", "conv-55", "/work/agy", "NO_TOOL_CALL", "/home/u", SECRET]) {
      expect(told).not.toContain(value);
    }
  });

  it("does not say a key that looks like a value", () => {
    const told = describeRecords([record("Stop", { sessions: { "0f8e7d6c-1234-4abc-9def-001122334455": { cwd: "/w" } } }, 1)], SECRET);
    expect(told).not.toContain("0f8e7d6c");
    expect(told).toContain("sessions.‹键›.cwd");
  });
});

const kimi = (overrides: Partial<CustomClient> = {}): CustomClient => ({
  id: "kimi",
  name: "Kimi CLI",
  shortName: "KM",
  command: "kimi",
  hooks: claudeProbe.hooks,
  prompt: { event: "UserPromptSubmit", field: "prompt" },
  reply: { event: "Stop", source: "field", field: "last_assistant_message" },
  fields: { sessionId: "session_id", cwd: "cwd", turnId: "turn_id" },
  complete: { field: "reason", values: ["end_turn"] },
  mcp: { mode: "none" },
  ...overrides,
});

describe("a proposed client, tried on the catch", () => {
  const context: { command: string | null; mcpAddSeen: boolean } = { command: "kimi", mcpAddSeen: false };

  it("passes and shows what the capture would read", () => {
    expect(checkPlan(kimi(), claudeStyle, claudeProbe, context)).toEqual({
      problems: [],
      preview: { prompt: PHRASE, reply: `\`${SECRET}\``, sessionId: "sess-91ab", cwd: "/work/app", turnId: "turn-1", complete: true },
    });
  });

  it("is refused, with why, where its fields, hooks, command or MCP do not hold", () => {
    const problems = (client: CustomClient, at = context) => checkPlan(client, claudeStyle, claudeProbe, at).problems.join("；");
    expect(problems(kimi({ prompt: { event: "UserPromptSubmit", field: "input" } }))).toContain("prompt.field");
    expect(problems(kimi({ reply: { event: "Stop", source: "field", field: "prompt" } }))).toContain("回复");
    expect(problems(kimi({ fields: { sessionId: "sid", cwd: "cwd" } }))).toContain("会话 id");
    expect(problems(kimi({ hooks: { file: "~/.other/hooks.json", format: "claude" } }))).toContain("探针");
    expect(problems(kimi({ prompt: { event: "BeforeModel", field: "prompt" } }))).toContain("BeforeModel");
    expect(problems(kimi({ command: "other" }))).toContain("kimi");
    expect(problems(kimi(), { command: null, mcpAddSeen: false })).toContain("command 要留空");
    expect(problems(kimi({ complete: { field: "reason", values: ["shutdown"] } }))).toContain("正常完成");
    expect(problems(kimi({ mcp: { mode: "command", add: ["mcp", "add", "decision", "--", "{bridge}", "mcp", "{client}"], remove: ["mcp", "remove", "decision"], list: { output: "json", args: ["mcp", "list", "--json"] } } }))).toContain("mcp add");
  });
});

describe("a reply read off each transcript format the engine reads", () => {
  const stopWith = (transcripts: ClientProbeRecord["transcripts"]) =>
    [claudeStyle[0]!, record("Stop", { session_id: "sess-91ab", cwd: "/work/app", transcript_path: "/home/u/t.jsonl" }, 2, transcripts)];
  const tried = (matched: string[]): ClientProbeRecord["transcripts"] =>
    ["claude", "codex", "antigravity", "copilot", "codebuddy", "droid"].map((format) => ({ field: "transcript_path", format, matched: matched.includes(format) }));

  it.each(["copilot", "codebuddy"])("takes %s where it alone read the secret", (format) => {
    expect(inferMapping(stopWith(tried([format])), claudeProbe)).toMatchObject({
      ok: true,
      mapping: { reply: { event: "Stop", source: "transcript", format, field: "transcript_path" } },
    });
  });

  it("takes the first format the engine lists where Droid's lines read as Claude Code's do, and says which others did", () => {
    const inferred = inferMapping(stopWith(tried(["claude", "codex", "droid"])), claudeProbe);
    expect(inferred).toMatchObject({ ok: true, mapping: { reply: { format: "claude" } } });
    expect(inferred.ok && inferred.notes.join()).toContain("codex、droid 格式也读得出");
    expect(inferMapping(stopWith(tried(["droid"])), claudeProbe)).toMatchObject({ ok: true, mapping: { reply: { format: "droid" } } });
  });
});
