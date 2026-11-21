import type { SemanticDecisionPair } from "@cognelis/decision-protocol";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { main } from "../src/cli.js";

// Grok 1.0.70's hook input, as CL1-LAB recorded it (samples/grok/run1, run1-turn2): one session, two turns, its
// end. Only the paths are moved off the machine that recorded them.
const grokSession = "01a17c8c-7654-7c92-bff9-1c33830cdd85";
const grokCommon = {
  sessionId: grokSession,
  cwd: "/work/ws-grok",
  workspaceRoot: "/work/ws-grok",
  transcriptPath: `/work/.grok/sessions/ws-grok/${grokSession}/updates.jsonl`,
  permissionMode: "auto",
  session_id: grokSession,
  transcript_path: `/work/.grok/sessions/ws-grok/${grokSession}/updates.jsonl`,
  permission_mode: "auto",
};
const grokPrompt = (promptId: string, prompt: string) => ({
  ...grokCommon,
  hookEventName: "user_prompt_submit",
  hook_event_name: "UserPromptSubmit",
  timestamp: "2026-10-27T08:49:02.840000+00:00",
  promptId,
  prompt,
});
const grokStop = (promptId: string, reply: string) => ({
  ...grokCommon,
  hookEventName: "stop",
  hook_event_name: "Stop",
  timestamp: "2026-10-27T08:49:30.082798+00:00",
  promptId,
  reason: "end_turn",
  stopHookActive: false,
  stop_hook_active: false,
  lastAssistantMessage: reply,
  last_assistant_message: reply,
  backgroundTasks: [],
  sessionCrons: [],
});
// The session's end: Stop once more, with no reply and no promptId.
const grokShutdown = {
  ...grokCommon,
  hookEventName: "stop",
  hook_event_name: "Stop",
  timestamp: "2026-10-27T08:49:30.988420+00:00",
  reason: "shutdown",
  stopHookActive: false,
  stop_hook_active: false,
};
const grokReply = "方案 A：用一个 SQLite 数据库文件保存记录，通过 SQL 查询和事务来读写。\n方案 B：用一个 JSON 文件保存全部记录，修改后整份写回。";

/** One hook run as the client starts it, the bridge's own stores in a folder of the test's. */
const harness = async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-client-hooks-"));
  const pairs: SemanticDecisionPair[] = [];
  const audit = { record: vi.fn(async (_input: unknown) => undefined) };
  const printJson = vi.fn();
  const dependencies = {
    audit,
    spool: { append: vi.fn(async () => undefined) },
    semanticPairSpool: { append: vi.fn(async (pair: SemanticDecisionPair) => { pairs.push(pair); return "accepted" as const; }) },
    runtime: { deliver: vi.fn(async () => null), deliverSemanticPair: vi.fn(async () => true), doctor: vi.fn(async () => ({})) },
    printJson,
  };
  const run = (operation: string, client: string, input: unknown) =>
    main(["hook", operation, client], {
      ...dependencies,
      environment: { PARASELF_TEXT_PENDING: join(root, "text-pending") },
      readStdin: async () => input,
    });
  return { root, pairs, audit, run, printJson };
};

describe("a Stop with no reply it can read, for the clients that keep the turn before's", () => {
  // Claude Code's and Codex's behaviour as it was: the reply waiting from the turn before stays, for the answer to it.
  it.each(["claude-code", "codex", "grok"])("leaves %s's waiting reply where it was", async (client) => {
    const { root, pairs, run } = await harness();
    const stop = (reply: string | undefined) => ({
      session_id: "s1", cwd: root, ...(reply === undefined ? {} : { last_assistant_message: reply }),
      ...(client === "grok" ? { reason: "end_turn", promptId: "p" } : {}),
    });
    await run("stop", client, stop(grokReply));
    await run("stop", client, stop(undefined));
    await run("user-prompt-submit", client, { session_id: "s1", cwd: root, prompt: "就用方案 A。", ...(client === "grok" ? { promptId: "q" } : {}) });
    expect(pairs.map((pair) => pair.assistantText)).toEqual([grokReply]);
  });
});

describe("Grok's hooks", () => {
  it("pairs a turn's reply with the reader's next prompt, by Grok's own input", async () => {
    const { pairs, run, printJson } = await harness();

    await run("user-prompt-submit", "grok", grokPrompt("e1e254fe-e8b3-4191-aad4-04e0d2e9fe9d", "请给我两个方案：方案 A 用 SQLite，方案 B 用 JSON 文件，各一句话。"));
    await run("stop", "grok", grokStop("e1e254fe-e8b3-4191-aad4-04e0d2e9fe9d", grokReply));
    await run("stop", "grok", grokShutdown);
    await run("user-prompt-submit", "grok", grokPrompt("015503ed-b863-45ea-8af2-a0190a6f69b8", "就用方案 A。"));

    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      sourceClient: "grok",
      sessionId: grokSession,
      // Grok sends no turn id: its promptId, the same in a turn's prompt and its Stop, stands for one.
      assistantTurnId: "e1e254fe-e8b3-4191-aad4-04e0d2e9fe9d",
      userTurnId: "015503ed-b863-45ea-8af2-a0190a6f69b8",
      cwd: "/work/ws-grok",
      assistantText: grokReply,
      userText: "就用方案 A。",
    });
    expect(printJson).not.toHaveBeenCalled();
  });

  it("takes the Stop a session's end fires for no turn's end at all", async () => {
    const { pairs, run, audit } = await harness();

    await run("stop", "grok", grokShutdown);
    // Not received at all: no reply looked for, none said missing.
    expect(audit.record).not.toHaveBeenCalled();
    await run("user-prompt-submit", "grok", grokPrompt("015503ed-b863-45ea-8af2-a0190a6f69b8", "就用方案 A。"));

    expect(pairs).toEqual([]);
  });

  it("leaves a Claude Code hook Grok runs through its compatibility layer to Grok's own", async () => {
    const readStdin = vi.fn(async () => grokStop("p", grokReply));
    const audit = { record: vi.fn() };

    for (const operation of ["post-tool-use", "stop", "user-prompt-submit"]) {
      expect(await main(["hook", operation, "claude-code"], {
        environment: { GROK_HOOK_EVENT: "stop", GROK_SESSION_ID: grokSession },
        readStdin,
        audit,
      })).toBe(0);
    }
    expect(readStdin).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});

// Antigravity's hook input as antigravity.google/docs/hooks and agy 1.4.8's hooks guide give it, and its transcript.jsonl
// as claude-mem reads it (src/shared/transcript-parser.ts, src/cli/adapters/antigravity-cli.ts): no sample of either
// taken on a real agy.
const antigravityConversation = "ec33ebf9-0cba-4100-8142-c61503f6c587";
const wrapped = (request: string) =>
  `<USER_REQUEST>\n${request}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is 2026-10-27T17:00:00+08:00.\n</ADDITIONAL_METADATA>`;
const antigravityCommon = (transcriptPath: string, lastUserInput: string) => ({
  conversationId: antigravityConversation,
  workspacePaths: ["/work/ws-agy"],
  transcriptPath,
  artifactDirectoryPath: "/work/.gemini/antigravity-cli/artifacts",
  modelName: "auto",
  lastUserInput: wrapped(lastUserInput),
});
const first = "请给我两个方案：方案 A 用 SQLite，方案 B 用 JSON 文件，各一句话。";
const userStep = (index: number, request: string) =>
  ({ step_index: index, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-10-27T09:00:00Z", content: wrapped(request) });
const writeTranscript = async (root: string, steps: object[]) => {
  const path = join(root, "transcript.jsonl");
  await writeFile(path, steps.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
};
const turnSteps = (reply: string) => [
  userStep(0, first),
  { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-10-27T09:00:05Z", content: "", tool_calls: [{ name: "list_dir", args: { DirectoryPath: "\"/work/ws-agy\"" } }] },
  { step_index: 2, source: "SYSTEM", type: "GENERIC", status: "DONE", created_at: "2026-10-27T09:00:06Z", content: "a tool's output" },
  // Not always a bare string: a list of text parts too.
  { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-10-27T09:00:09Z", content: [{ text: reply }] },
];

describe("Antigravity's hooks", () => {
  it("reads the reply off the transcript and the prompt off the turn's first model call", async () => {
    const { root, pairs, run, printJson } = await harness();
    const transcript = await writeTranscript(root, turnSteps(grokReply));

    await run("user-prompt-submit", "antigravity", { ...antigravityCommon(transcript, first), invocationNum: 0, initialNumSteps: 0 });
    await run("stop", "antigravity", { ...antigravityCommon(transcript, first), executionNum: 1, terminationReason: "NO_TOOL_CALL", error: "", fullyIdle: true });
    // A later model call of the same turn says the same prompt again, the agent's step last in the transcript: no answer.
    await run("user-prompt-submit", "antigravity", { ...antigravityCommon(transcript, first), invocationNum: 3, initialNumSteps: 4 });
    expect(pairs).toEqual([]);
    // The next turn: its first call, however the count runs, with the reader's message last in the transcript.
    await writeTranscript(root, [...turnSteps(grokReply), userStep(4, "就用方案 A。")]);
    await run("user-prompt-submit", "antigravity", { ...antigravityCommon(transcript, "就用方案 A。"), invocationNum: 4, initialNumSteps: 5 });

    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      sourceClient: "antigravity",
      sessionId: antigravityConversation,
      cwd: "/work/ws-agy",
      assistantText: grokReply,
      // Without the envelope the client wraps it in.
      userText: "就用方案 A。",
      context: { taskBackground: first },
    });
    // A Stop hook that prints anything may be read as "continue".
    expect(printJson).not.toHaveBeenCalled();
  });

  it("takes the web docs' model_stop as a turn's own end too", async () => {
    const { root, pairs, run } = await harness();
    const transcript = await writeTranscript(root, turnSteps(grokReply));

    await run("stop", "antigravity", { ...antigravityCommon(transcript, first), terminationReason: "model_stop" });
    await run("user-prompt-submit", "antigravity", { ...antigravityCommon(transcript, "就用方案 A。"), invocationNum: 0 });

    expect(pairs).toHaveLength(1);
  });

  it("records no reply for a turn that did not end of itself", async () => {
    const { root, pairs, run } = await harness();
    const transcript = await writeTranscript(root, turnSteps(grokReply));

    await run("stop", "antigravity", { ...antigravityCommon(transcript, "x"), executionNum: 1, terminationReason: "USER_CANCELED", fullyIdle: true });
    await run("user-prompt-submit", "antigravity", { ...antigravityCommon(transcript, "就用方案 A。"), invocationNum: 0 });

    expect(pairs).toEqual([]);
  });

  it("pairs nothing with a turn whose message it cannot read, rather than with the turn before", async () => {
    const { root, pairs, run } = await harness();
    const transcript = await writeTranscript(root, [
      ...turnSteps("方案 A：SQLite；方案 B：JSON。请选择。"),
      // A newer turn, its content in a form not known.
      { step_index: 4, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: { text: "新问题" } },
      { step_index: 5, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: { text: "新回复" } },
    ]);

    await run("stop", "antigravity", { ...antigravityCommon(transcript, "新问题"), terminationReason: "NO_TOOL_CALL" });
    await run("user-prompt-submit", "antigravity", { ...antigravityCommon(transcript, "选 A"), invocationNum: 0 });

    expect(pairs).toEqual([]);
  });

  it("drops the turn before's reply when a turn's own cannot be read, so a later answer is not paired with it", async () => {
    // The chain CL1-REVIEW-2 found: a reply waiting from the turn before; the next turn's message empty in the hook and
    // unread in the transcript, so its prompt consumes nothing; its reply unread too. The answer after that went to the
    // first turn's question.
    const { root, pairs, run, audit } = await harness();
    const oldTurn = turnSteps(grokReply);
    const transcript = await writeTranscript(root, oldTurn);
    await run("stop", "antigravity", { ...antigravityCommon(transcript, first), terminationReason: "NO_TOOL_CALL" });

    const image = { step_index: 4, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: [{ type: "image", url: "synthetic" }] };
    await writeTranscript(root, [...oldTurn, image]);
    await run("user-prompt-submit", "antigravity", { ...antigravityCommon(transcript, ""), lastUserInput: "", invocationNum: 0 });
    await writeTranscript(root, [...oldTurn, image, { step_index: 5, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: { text: "无法读取的新回复" } }]);
    await run("stop", "antigravity", { ...antigravityCommon(transcript, ""), lastUserInput: "", terminationReason: "NO_TOOL_CALL" });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ sourceClient: "antigravity", errorCode: "assistant_text_unavailable" }));

    await run("user-prompt-submit", "antigravity", { ...antigravityCommon(transcript, "选 A"), invocationNum: 0 });
    expect(pairs).toEqual([]);
  });

  it("skips a transcript it cannot read the lines of", async () => {
    const { root, pairs, run, audit } = await harness();
    const transcript = join(root, "transcript.jsonl");
    await writeFile(transcript, `${JSON.stringify({ kind: "something-else", text: "?" })}\nnot json\n`);

    expect(await run("stop", "antigravity", { ...antigravityCommon(transcript, "x"), executionNum: 1, terminationReason: "NO_TOOL_CALL" })).toBe(0);
    // Nor does one it cannot read start a turn: only the first call does.
    await run("user-prompt-submit", "antigravity", { ...antigravityCommon(transcript, "就用方案 A。"), invocationNum: 2 });
    expect(audit.record).not.toHaveBeenCalledWith(expect.objectContaining({ stage: "user_prompt_unpaired" }));
    await run("user-prompt-submit", "antigravity", { ...antigravityCommon(transcript, "就用方案 A。"), invocationNum: 0 });

    expect(pairs).toEqual([]);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ sourceClient: "antigravity", errorCode: "assistant_text_unavailable" }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ sourceClient: "antigravity", stage: "user_prompt_unpaired" }));
  });
});
