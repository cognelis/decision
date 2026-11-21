import { describe, expect, it } from "vitest";

import {
  customClientSchema,
  customClientsFileSchema,
  previewCustomClientSample,
  readHookField,
  upgradeCustomClientsFile,
  type CustomClient,
} from "../src/index.js";

/** Grok, as a reader would add it by hand. */
const myGrok: CustomClient = {
  id: "my-grok",
  name: "My Grok",
  shortName: "MG",
  command: "grok",
  hooks: { file: "~/.grok/hooks/decision.json", format: "claude-owned" },
  prompt: { event: "UserPromptSubmit", field: "prompt" },
  reply: { event: "Stop", source: "field", field: "last_assistant_message" },
  fields: { sessionId: "session_id", cwd: "cwd", turnId: "promptId" },
  complete: { field: "reason", values: ["end_turn"] },
  mcp: {
    mode: "command",
    add: ["mcp", "add", "-s", "user", "decision", "--", "{bridge}", "mcp", "{client}"],
    remove: ["mcp", "remove", "decision"],
    list: { output: "json", args: ["mcp", "list", "--json"] },
  },
};

const rejects = (change: (client: CustomClient) => unknown): string => {
  const result = customClientSchema.safeParse(change(structuredClone(myGrok)));
  expect(result.success).toBe(false);
  return result.success ? "" : result.error.issues.map((issue) => issue.message).join("；");
};

describe("a custom client", () => {
  it("reads one written as the form writes it", () => {
    expect(customClientSchema.parse(myGrok)).toEqual(myGrok);
    const { command: _command, ...noCommand } = myGrok;
    expect(customClientSchema.parse({ ...noCommand, mcp: { mode: "none" } }).mcp).toEqual({ mode: "none" });
  });

  it.each([
    ["an id not in form", (client: CustomClient) => ({ ...client, id: "My Grok" })],
    ["an id too short", (client: CustomClient) => ({ ...client, id: "g" })],
    ["a badge of three letters", (client: CustomClient) => ({ ...client, shortName: "MGK" })],
    ["no name", (client: CustomClient) => ({ ...client, name: "  " })],
    ["a field it does not know", (client: CustomClient) => ({ ...client, run: "rm -rf ~" })],
  ])("refuses %s", (_kind, change) => {
    rejects(change);
  });

  it.each([
    ["/usr/local/bin/grok"],
    ["grok; rm -rf ~"],
    ["grok $(id)"],
    ["../grok"],
    ["gr ok"],
    ["grok|tee"],
  ])("refuses the command %s: a name alone, run without a shell", (command) => {
    expect(rejects((client) => ({ ...client, command }))).toMatch(/命令名只能是一个名字/u);
  });

  it.each([
    ["/etc/hosts", /~\//u],
    ["~/../other/hooks.json", /\.\./u],
    ["~/.grok/./hooks.json", /\.\./u],
    ["~/.grok//hooks.json", /连续/u],
    ["~/", /~\//u],
    ["~/.grok\\hooks.json", /反斜杠/u],
    ["~/.grok/hooks\n.json", /换行/u],
  ])("refuses the hook file %j: under the home folder only", (file, message) => {
    expect(rejects((client) => ({ ...client, hooks: { ...client.hooks, file } }))).toMatch(message);
  });

  it.each([
    [["mcp", "add", "decision", "{bridge}", "{home}"], /不认识 \{home\}/u],
    [["mcp", "add", "decision", "--bridge={bridge}"], /单独作为一个参数/u],
    [["mcp", "add", "decision", "{bridge}", "{bridge}"], /一个 \{bridge\}/u],
    [["mcp", "add", "decision"], /一个 \{bridge\}/u],
    [["mcp", "add", "decision", "{bridge}", "x}"], /花括号/u],
    [["mcp", "add", "decision", "{bridge}", "a\nb"], /换行/u],
  ])("refuses the MCP add template %j", (add, message) => {
    expect(rejects((client) => ({ ...client, mcp: { ...client.mcp, add } }))).toMatch(message);
  });

  it("asks for the command an MCP registered by command is run through", () => {
    expect(rejects(({ command: _command, ...client }) => client)).toMatch(/要填命令名/u);
  });

  it.each([
    ["an event with a space", (client: CustomClient) => ({ ...client, prompt: { ...client.prompt, event: "User Prompt" } })],
    ["a field path with code in it", (client: CustomClient) => ({ ...client, prompt: { ...client.prompt, field: "prompt()" } })],
    ["a field path with an empty step", (client: CustomClient) => ({ ...client, fields: { ...client.fields, cwd: "a..b" } })],
    ["a transcript format not known", (client: CustomClient) => ({ ...client, reply: { event: "Stop", source: "transcript", format: "kimi", field: "transcript_path" } })],
  ])("refuses %s", (_kind, change) => {
    rejects(change);
  });

  it("refuses a file that names one client twice, or of another version", () => {
    expect(customClientsFileSchema.safeParse({ version: 1, clients: [myGrok, myGrok] }).success).toBe(false);
    expect(customClientsFileSchema.safeParse({ version: 2, clients: [] }).success).toBe(false);
    expect(customClientsFileSchema.parse({ version: 1, clients: [myGrok] }).clients).toHaveLength(1);
  });
});

describe("an MCP server registered by the client's own command", () => {
  it("is always one whose servers it can list: there is no telling otherwise whose a decision server is", () => {
    expect(rejects((client) => ({ ...client, mcp: { ...client.mcp, list: { output: "none" } } }))).not.toBe("");
  });

  it("reads one an earlier version saved that could not list as registering none, and says which", () => {
    const old = { ...myGrok, mcp: { ...myGrok.mcp, list: { output: "none" } } };
    const { file, mcpDropped } = upgradeCustomClientsFile({ version: 1, clients: [old, { ...myGrok, id: "other-grok" }] });
    expect(mcpDropped).toEqual(["my-grok"]);
    expect(customClientsFileSchema.parse(file).clients.map((client) => client.mcp.mode)).toEqual(["none", "command"]);
    expect(upgradeCustomClientsFile("not a file")).toEqual({ file: "not a file", mcpDropped: [] });
  });
});

describe("reading a hook's field", () => {
  const input = { a: { b: [{ c: "deep" }] }, workspacePaths: ["/work/one", "/work/two"] };

  it("follows a dotted path, into a list by its index", () => {
    expect(readHookField(input, "a.b.0.c")).toBe("deep");
    expect(readHookField(input, "workspacePaths.1")).toBe("/work/two");
  });

  it("gives a list at the end by its first item", () => {
    expect(readHookField(input, "workspacePaths")).toBe("/work/one");
  });

  it("finds nothing where the path leads nowhere, nor in what an object inherits", () => {
    expect(readHookField(input, "a.x.c")).toBeUndefined();
    expect(readHookField(input, "workspacePaths.first")).toBeUndefined();
    expect(readHookField(input, "toString")).toBeUndefined();
    expect(readHookField(input, "constructor.name")).toBeUndefined();
  });
});

describe("trying a pasted hook input", () => {
  it("shows each field of Grok's Stop as the bridge reads it", () => {
    expect(previewCustomClientSample(myGrok, {
      session_id: "s1", cwd: "/work", promptId: "p1", reason: "end_turn", last_assistant_message: "方案 A 还是方案 B？",
    })).toEqual({
      prompt: { state: "missing" },
      reply: { state: "text", text: "方案 A 还是方案 B？" },
      transcriptPath: null,
      sessionId: { state: "text", text: "s1" },
      cwd: { state: "text", text: "/work" },
      turnId: { state: "text", text: "p1" },
      complete: true,
    });
  });

  it("says a field the bridge would not take as unusable, as the bridge reads it", () => {
    const sample = previewCustomClientSample(myGrok, {
      session_id: 42,
      cwd: ["/work/first", "/work/second"],
      promptId: "p".repeat(501),
      last_assistant_message: { text: "回复" },
      prompt: "",
    });
    expect(sample.sessionId).toEqual({ state: "unusable", reason: "数字" });
    expect(sample.cwd).toEqual({ state: "text", text: "/work/first" });
    expect(sample.turnId).toEqual({ state: "unusable", reason: "超过 500 字" });
    expect(sample.reply).toEqual({ state: "unusable", reason: "对象" });
    expect(sample.prompt).toEqual({ state: "missing" });
  });

  it("says a turn that did not end of itself, and names the transcript a reply would be read from without reading it", () => {
    const fromTranscript = { ...myGrok, reply: { event: "Stop", source: "transcript" as const, format: "claude" as const, field: "transcript_path" } };
    expect(previewCustomClientSample(fromTranscript, { reason: "shutdown", transcript_path: "/nowhere/t.jsonl" })).toMatchObject({
      reply: null,
      transcriptPath: { state: "text", text: "/nowhere/t.jsonl" },
      complete: false,
    });
    const { complete: _complete, ...noCondition } = myGrok;
    expect(previewCustomClientSample(noCondition, {}).complete).toBeNull();
  });
});

describe("the catalog and the formats it is written in", () => {
  it("is described by the schema a reader's own client is, each id its own", async () => {
    const { CLIENT_CATALOG, HOOK_FILE_FORMATS, TRANSCRIPT_FORMATS, customClientsFileSchema } = await import("../src/index.js");
    expect(customClientsFileSchema.safeParse({ version: 1, clients: CLIENT_CATALOG.map(({ client }) => client) }).success).toBe(true);
    // The lists CL2-ASSIST reads: one place each.
    expect(HOOK_FILE_FORMATS).toEqual(["claude", "claude-owned", "antigravity", "flat", "flat-owned"]);
    expect(TRANSCRIPT_FORMATS).toEqual(["claude", "codex", "antigravity", "copilot", "codebuddy", "droid"]);
  });

  it("takes extra fields as JSON alone, never in place of this app's own", async () => {
    const { customClientSchema } = await import("../src/index.js");
    const base = {
      id: "extra-cli", name: "Extra", shortName: "EX",
      hooks: { file: "~/.extra/settings.json", format: "claude" },
      prompt: { event: "UserPromptSubmit", field: "prompt" },
      reply: { event: "Stop", source: "field", field: "last_assistant_message" },
      fields: { sessionId: "session_id", cwd: "cwd" },
      mcp: { mode: "none" },
    };
    expect(customClientSchema.safeParse({ ...base, hooks: { ...base.hooks, group: { metadata: { includeConversationData: true } } } }).success).toBe(true);
    expect(customClientSchema.safeParse({ ...base, hooks: { ...base.hooks, group: { hooks: [] } } }).success).toBe(false);
    expect(customClientSchema.safeParse({ ...base, hooks: { file: "~/.extra/hooks.json", format: "flat", group: { metadata: {} } } }).success).toBe(false);
    expect(customClientSchema.safeParse({ ...base, mcp: { mode: "file", file: "~/.extra/mcp.json", entry: { type: "stdio" } } }).success).toBe(true);
    expect(customClientSchema.safeParse({ ...base, mcp: { mode: "file", file: "~/.extra/mcp.json", entry: { command: "sh" } } }).success).toBe(false);
    expect(customClientSchema.safeParse({ ...base, mcp: { mode: "file", file: "/etc/mcp.json" } }).success).toBe(false);
    expect(customClientSchema.safeParse({ ...base, hooks: { ...base.hooks, invocation: "argv" } }).success).toBe(true);
    expect(customClientSchema.safeParse({ ...base, hooks: { ...base.hooks, invocation: "shell" } }).success).toBe(false);
  });
});
