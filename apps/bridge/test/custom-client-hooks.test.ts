import {
  customClientDescriptor,
  customHookPath,
  detectIntegrationStatus,
  hookBridgeReference,
  installIntegrations,
  writeCustomClients,
} from "@cognelis/decision-integrations";
import { previewCustomClientSample, type CustomClient, type SemanticDecisionPair } from "@cognelis/decision-protocol";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { main } from "../src/cli.js";

/** Grok, added by hand on the 接入 page as another client would be: by the fields its hooks send. */
const myGrok: CustomClient = {
  id: "my-grok",
  name: "My Grok",
  shortName: "MG",
  command: "grok",
  hooks: { file: "~/.my-grok/hooks.json", format: "claude-owned" },
  prompt: { event: "UserPromptSubmit", field: "prompt" },
  reply: { event: "Stop", source: "field", field: "lastAssistantMessage" },
  fields: { sessionId: "sessionId", cwd: "cwd", turnId: "promptId" },
  complete: { field: "reason", values: ["end_turn"] },
  mcp: { mode: "none" },
};

// Grok 1.0.70's hook input, as CL1-LAB recorded it (samples/grok/run1, run1-turn2), its paths moved off the machine.
const session = "01a17c8c-7654-7c92-bff9-1c33830cdd85";
const common = { sessionId: session, cwd: "/work/ws-grok", session_id: session, permissionMode: "auto" };
const prompt = (promptId: string, text: string) => ({ ...common, hookEventName: "user_prompt_submit", hook_event_name: "UserPromptSubmit", promptId, prompt: text });
const stop = (promptId: string | undefined, reason: string, reply?: string) => ({
  ...common,
  hookEventName: "stop",
  hook_event_name: "Stop",
  ...(promptId === undefined ? {} : { promptId }),
  reason,
  ...(reply === undefined ? {} : { lastAssistantMessage: reply, last_assistant_message: reply }),
});
const reply = "方案 A：用一个 SQLite 数据库文件保存记录，通过 SQL 查询和事务来读写。\n方案 B：用一个 JSON 文件保存全部记录，修改后整份写回。";

const harness = async (clients: CustomClient[] = [myGrok]) => {
  const root = await mkdtemp(join(tmpdir(), "decision-custom-hooks-"));
  const customClients = join(root, "user-data", "custom-clients.json");
  await writeCustomClients(customClients, clients);
  const pairs: SemanticDecisionPair[] = [];
  const audit = { record: vi.fn(async (_input: unknown) => undefined) };
  const environment = { PARASELF_TEXT_PENDING: join(root, "user-data", "text-pending"), PARASELF_CUSTOM_CLIENTS: customClients };
  const run = (operation: string, client: string, input: unknown) =>
    main(["hook", operation, client], {
      environment,
      audit,
      spool: { append: vi.fn(async () => undefined) },
      semanticPairSpool: { append: vi.fn(async (pair: SemanticDecisionPair) => { pairs.push(pair); return "accepted" as const; }) },
      runtime: { deliver: vi.fn(async () => null), deliverSemanticPair: vi.fn(async () => true), doctor: vi.fn(async () => ({})) },
      printJson: () => { throw new Error("a hook prints nothing"); },
      readStdin: async () => input,
    });
  return { root, customClients, environment, pairs, audit, run };
};

describe("a client the reader added on the 接入 page", () => {
  it("is connected in a home of its own and pairs Grok's turns by the fields the form named", async () => {
    const { root, pairs, run } = await harness();
    const home = join(root, "home");
    const bridgePath = "/Applications/Paraself.app/Contents/Resources/bridge/paraself-bridge";
    const clients = [customClientDescriptor(myGrok)];
    const paths = { "my-grok": customHookPath(myGrok.hooks.file, home) };
    await installIntegrations({ mode: "apply", bridgePath, platform: "darwin", paths, clients, runner: async () => ({ exitCode: 0 }) });
    expect(await detectIntegrationStatus(paths, hookBridgeReference(bridgePath, "darwin"), "darwin", clients)).toEqual({ "my-grok": "installed" });
    expect(await readFile(paths["my-grok"], "utf8")).toContain("hook stop my-grok");

    await run("user-prompt-submit", "my-grok", prompt("e1e254fe-e8b3-4191-aad4-04e0d2e9fe9d", "请给我两个方案：方案 A 用 SQLite，方案 B 用 JSON 文件，各一句话。"));
    await run("stop", "my-grok", stop("e1e254fe-e8b3-4191-aad4-04e0d2e9fe9d", "end_turn", reply));
    await run("stop", "my-grok", stop(undefined, "shutdown"));
    await run("user-prompt-submit", "my-grok", prompt("015503ed-b863-45ea-8af2-a0190a6f69b8", "就用方案 A。"));

    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      sourceClient: "my-grok",
      sessionId: session,
      assistantTurnId: "e1e254fe-e8b3-4191-aad4-04e0d2e9fe9d",
      userTurnId: "015503ed-b863-45ea-8af2-a0190a6f69b8",
      cwd: "/work/ws-grok",
      assistantText: reply,
      userText: "就用方案 A。",
    });
  });

  it("reads its fields by dotted paths, and a reply off a transcript of a format already read", async () => {
    const nested: CustomClient = {
      ...myGrok,
      id: "nested-cli",
      hooks: { file: "~/.nested/hooks.json", format: "antigravity" },
      prompt: { event: "BeforeModel", field: "turn.input.text" },
      reply: { event: "AfterTurn", source: "transcript", format: "claude", field: "logs.transcript" },
      fields: { sessionId: "conversation.id", cwd: "workspace.roots" },
      complete: { field: "turn.status", values: ["done"] },
    };
    const { root, pairs, run } = await harness([nested]);
    const transcript = join(root, "transcript.jsonl");
    await writeFile(transcript, [
      { type: "user", message: { role: "user", content: "选哪个存储？" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "SQLite 还是 JSON 文件？" }] } },
    ].map((line) => JSON.stringify(line)).join("\n"));
    const input = (extra: object) => ({ conversation: { id: "c1" }, workspace: { roots: ["/work/a", "/work/b"] }, logs: { transcript }, ...extra });

    await run("stop", "nested-cli", input({ turn: { status: "done" } }));
    await run("user-prompt-submit", "nested-cli", input({ turn: { input: { text: "SQLite。" } } }));

    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      sourceClient: "nested-cli",
      sessionId: "c1",
      cwd: "/work/a",
      assistantText: "SQLite 还是 JSON 文件？",
      userText: "SQLite。",
      context: { taskBackground: "选哪个存储？" },
    });
  });

  it("does nothing, silently, for a client no file describes, or one whose file cannot be read", async () => {
    const { customClients, run, audit, pairs } = await harness();
    const readStdin = vi.fn();
    expect(await main(["hook", "stop", "nobody-cli"], { environment: { PARASELF_CUSTOM_CLIENTS: customClients }, readStdin, audit })).toBe(0);
    await writeFile(customClients, "{ not json");
    expect(await run("stop", "my-grok", stop("p", "end_turn", reply))).toBe(0);
    expect(await main(["hook", "stop", "my-grok"], { environment: { PARASELF_CUSTOM_CLIENTS: customClients }, readStdin, audit })).toBe(0);
    expect(readStdin).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(pairs).toEqual([]);
    // Nor is the file the App reads moved by a hook.
    expect(await readFile(customClients, "utf8")).toBe("{ not json");
  });

  it("does nothing inside a model call the App started", async () => {
    const { customClients } = await harness();
    const readStdin = vi.fn();
    expect(await main(["hook", "stop", "my-grok"], { environment: { PARASELF_CUSTOM_CLIENTS: customClients, PARASELF_PROVIDER_CHILD: "1" }, readStdin })).toBe(0);
    expect(readStdin).not.toHaveBeenCalled();
  });

  it("starts the MCP server for it; for an id no file describes now, or one whose file cannot be read, quietly none", async () => {
    const { customClients } = await harness();
    const serveMcp = vi.fn();
    const errors: string[] = [];
    const mcp = (id: string) => main(["mcp", id], { environment: { PARASELF_CUSTOM_CLIENTS: customClients }, serveMcp, printError: (value) => errors.push(value) });
    expect(await mcp("my-grok")).toBe(0);
    expect(await mcp("nobody-cli")).toBe(0);
    await writeFile(customClients, "{ not json");
    expect(await mcp("my-grok")).toBe(0);
    expect(errors).toEqual([]);
    expect(serveMcp.mock.calls).toEqual([[{ sourceClient: "my-grok" }]]);
    // Not an id at all: a mistake in the command line, said so.
    expect(await mcp("Not An Id")).toBe(2);
    expect(errors.join("")).toContain("Usage");
  });
});

describe("what the form's 试解析 shows and what the bridge takes", () => {
  const plain: CustomClient = { ...myGrok, id: "plain-cli", fields: { sessionId: "session_id", cwd: "cwd" }, reply: { event: "Stop", source: "field", field: "last_assistant_message" }, complete: undefined as never };
  const { complete: _complete, ...withoutCondition } = plain;
  const client: CustomClient = withoutCondition;

  /** One turn and its answer, the reply's input as given; whether the bridge paired them. */
  const pairs = async (stopInput: Record<string, unknown>) => {
    const { pairs: found, run } = await harness([client]);
    await run("stop", client.id, stopInput);
    await run("user-prompt-submit", client.id, { ...stopInput, prompt: "就用方案 A。" });
    return found.length;
  };

  it.each([
    ["a number for the session id", { session_id: 42, cwd: "/work", last_assistant_message: reply }],
    ["a list for the session id, its field named as Claude Code names it", { session_id: ["s1", "s2"], cwd: "/work", last_assistant_message: reply }],
    ["a list for the working directory", { session_id: "s1", cwd: ["/work/a"], last_assistant_message: reply }],
    ["an object for the reply", { session_id: "s1", cwd: "/work", last_assistant_message: { text: reply } }],
    ["a session id past its limit", { session_id: "s".repeat(501), cwd: "/work", last_assistant_message: reply }],
  ])("agree on %s", async (_kind, input) => {
    const sample = previewCustomClientSample(client, input);
    const usable = [sample.sessionId, sample.cwd, sample.reply!].every((field) => field.state === "text");
    expect(await pairs(input)).toBe(usable ? 1 : 0);
  });
});

describe("a client the reader added whose reply is read off a transcript", () => {
  it("drops the turn before's reply when a turn ends of itself with none it can read, so a later answer is not paired with it", async () => {
    const named: CustomClient = {
      ...myGrok,
      id: "named-cli",
      hooks: { file: "~/.named/hooks.json", format: "antigravity" },
      prompt: { event: "PreInvocation", field: "lastUserInput" },
      reply: { event: "Stop", source: "transcript", format: "antigravity", field: "transcriptPath" },
      fields: { sessionId: "conversationId", cwd: "workspacePaths" },
      complete: { field: "terminationReason", values: ["NO_TOOL_CALL"] },
    };
    const { root, pairs, run } = await harness([named]);
    const transcript = join(root, "transcript.jsonl");
    const steps = (extra: object[]) => writeFile(transcript, [
      { type: "USER_INPUT", content: "旧问题" },
      { type: "PLANNER_RESPONSE", content: "方案 A：SQLite；方案 B：JSON。请选择。" },
      ...extra,
    ].map((line) => JSON.stringify(line)).join("\n"));
    const input = (extra: object) => ({ conversationId: "c1", workspacePaths: ["/work"], transcriptPath: transcript, ...extra });

    await steps([]);
    await run("stop", "named-cli", input({ terminationReason: "NO_TOOL_CALL" }));
    // The next turn: its message empty in the hook and in a form not known in the transcript, its reply unread too.
    await steps([{ type: "USER_INPUT", content: [{ type: "image" }] }, { type: "PLANNER_RESPONSE", content: { text: "新回复" } }]);
    await run("user-prompt-submit", "named-cli", input({ lastUserInput: "" }));
    await run("stop", "named-cli", input({ terminationReason: "NO_TOOL_CALL" }));
    await run("user-prompt-submit", "named-cli", input({ lastUserInput: "选 A" }));

    expect(pairs).toEqual([]);
  });
});
