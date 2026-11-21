import type { SemanticDecisionPair } from "@cognelis/decision-protocol";
import {
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { TextCaptureFallback } from "../src/text-fallback.js";
import { TextCaptureStore } from "../src/text-capture-store.js";
import { readLastDecisionTurn } from "../src/transcript-tail.js";

const fixedNow = () =>
  new Date("2026-07-25T02:03:04.000Z");

const setup = async (options: {
  readLastAssistantText?: (
    path: string,
  ) => Promise<string | null>;
  audit?: {
    record(input: Record<string, unknown>): Promise<unknown>;
  };
} = {}) => {
  const root = await mkdtemp(
    join(tmpdir(), "decision-text-capture-"),
  );
  const store = new TextCaptureStore(
    join(root, "text-pending"),
    { now: fixedNow },
  );
  const readLastAssistantText =
    options.readLastAssistantText ??
    vi.fn(async () => null as string | null);
  const fallback = new TextCaptureFallback({
    store,
    readLastAssistantText,
    ...(options.audit === undefined
      ? {}
      : { audit: options.audit }),
    now: fixedNow,
  });
  return { fallback, readLastAssistantText, root, store };
};

const expectPair = (
  value: SemanticDecisionPair | null,
): SemanticDecisionPair => {
  if (value === null) {
    throw new Error("Expected a semantic decision pair");
  }
  return value;
};

describe("TextCaptureFallback", () => {
  it("cuts a long answer and a long reply on whole characters, never half an emoji", async () => {
    const lone = (value: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
    const { fallback, root } = await setup();
    // The 8,000-unit edge counted from the end falls inside 😀, and so does the answer's 2,000th unit.
    const tail = `${"分析".repeat(3_998)}\n\n先上线 A 方案还是 B 方案？`;
    await fallback.onStop({ session_id: "s-emoji", cwd: root, last_assistant_message: `开头😀${tail.slice(-(8_000 - 1))}` }, "claude-code");
    const prompt = `${"选 A，理由如下：".padEnd(1_999, "。")}😀${"补充".repeat(200)}`;

    const pair = expectPair(await fallback.onUserPrompt({ session_id: "s-emoji", cwd: root, prompt }, "claude-code"));
    // Half a character was written into the note as U+FFFD.
    expect(lone(pair.userText)).toBe(false);
    expect(lone(pair.assistantText)).toBe(false);
  });

  it("pairs a long transcript reply with current bounded context", async () => {
    const { fallback, root } = await setup();
    const transcriptPath = join(root, "session.jsonl");
    const background = "当前任务：" + "背景".repeat(4_100);
    const assistantText = "分析".repeat(4_100) + "\n\n选择 C 还是 D？";
    await writeFile(transcriptPath, [
      { role: "user", text: "旧任务" },
      { role: "assistant", text: "旧问题：选择 A 还是 B？" },
      { role: "user", text: background },
      { role: "assistant", text: assistantText },
    ].map(({ role, text }) => JSON.stringify({
      message: { role, content: [{ type: "text", text }] },
    })).join("\n"));

    await fallback.onStop({
      session_id: "long-turn",
      cwd: "/tmp/project",
      transcript_path: transcriptPath,
    }, "claude-code");
    const pair = expectPair(await fallback.onUserPrompt({
      session_id: "long-turn",
      prompt: "C",
    }, "claude-code"));

    expect(pair.assistantText).toBe(assistantText.slice(-8_000));
    expect(pair.userText).toBe("C");
    expect(pair.context).toEqual({
      taskBackground: background.slice(0, 4_000),
      truncated: true,
    });
    expect(JSON.stringify(pair)).not.toContain("旧任务");
    expect(JSON.stringify(pair)).not.toContain("旧问题");
  });

  it("keeps completed Codex native decisions on the structured path", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "decision-native-capture-"),
    );
    const readCodexDecisions = vi.fn(async () => [
      {
        turnId: "turn-native",
        toolUseId: "call-native",
        toolInput: {
          questions: [
            {
              id: "working_style",
              question: "你希望采用哪种起步方式？",
              options: [
                { label: "先写测试" },
                { label: "先做原型" },
              ],
            },
          ],
        },
        toolResponse: {
          answers: {
            working_style: { answers: ["先写测试"] },
          },
        },
      },
    ]);
    const fallback = new TextCaptureFallback({
      store: new TextCaptureStore(
        join(root, "text-pending"),
        { now: fixedNow },
      ),
      readCodexDecisions,
      now: fixedNow,
    });

    const events = await fallback.onStop(
      {
        session_id: "session-native",
        turn_id: "turn-native",
        cwd: "/tmp/project",
        transcript_path: "/tmp/session.jsonl",
      },
      "codex",
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      captureMode: "structured_tool",
      toolUseId: "call-native",
      questions: [
        {
          question: "你希望采用哪种起步方式？",
          answer: { values: ["先写测试"] },
        },
      ],
    });
  });

  it("still hands over Codex native decisions when the text pairing cannot be saved", async () => {
    const audit = { record: vi.fn(async () => undefined) };
    const fallback = new TextCaptureFallback({
      // A full disk, or a folder left owned by root after a sudo run.
      store: { save: async () => { throw new Error("EACCES: permission denied"); } } as never,
      readCodexDecisions: async () => [{
        turnId: "turn-native",
        toolUseId: "call-native",
        toolInput: { questions: [{ id: "style", question: "你希望采用哪种起步方式？", options: [{ label: "先写测试" }, { label: "先做原型" }] }] },
        toolResponse: { answers: { style: { answers: ["先写测试"] } } },
      }],
      audit,
      now: fixedNow,
    });

    const events = await fallback.onStop(
      { session_id: "session-native", turn_id: "turn-native", cwd: "/tmp/project", transcript_path: "/tmp/session.jsonl", last_assistant_message: "好的，先写测试。" },
      "codex",
    );

    expect(events).toEqual([expect.objectContaining({ toolUseId: "call-native" })]);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "pending_write_failed" }));
  });

  it("preserves answered native questions and the final text pair after an empty answer", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "decision-hybrid-capture-"),
    );
    const fallback = new TextCaptureFallback({
      store: new TextCaptureStore(
        join(root, "text-pending"),
        { now: fixedNow },
      ),
      readCodexDecisions: vi.fn(async () => [
        {
          turnId: "turn-hybrid",
          toolUseId: "call-unanswered",
          toolInput: {
            questions: [{ id: "skipped", question: "要补充说明吗？", options: [] }],
          },
          toolResponse: { answers: { skipped: { answers: [] } } },
        },
        {
          turnId: "turn-hybrid",
          toolUseId: "call-native",
          toolInput: {
            questions: [
              {
                id: "approach",
                question: "采用哪种方案？",
                options: [
                  { label: "方案 A" },
                  { label: "方案 B" },
                ],
              },
            ],
          },
          toolResponse: {
            answers: { approach: { answers: ["方案 A"] } },
          },
        },
      ]),
      readLastAssistantText: vi.fn(async () => "现在继续吗？"),
      now: fixedNow,
    });

    const nativeEvents = await fallback.onStop(
      {
        session_id: "session-hybrid",
        turn_id: "turn-hybrid",
        cwd: "/tmp/project",
        transcript_path: "/tmp/session.jsonl",
      },
      "codex",
    );
    const pair = expectPair(
      await fallback.onUserPrompt(
        {
          session_id: "session-hybrid",
          turn_id: "turn-answer",
          cwd: "/tmp/project",
          prompt: "继续",
        },
        "codex",
      ),
    );

    expect(nativeEvents.map((event) => event.toolUseId)).toEqual([
      "call-native",
    ]);
    expect(pair).toMatchObject({
      version: 1,
      sourceClient: "codex",
      assistantText: "现在继续吗？",
      userText: "继续",
    });
  });

  it("pairs one direct Stop message with the next same-session prompt", async () => {
    const { fallback } = await setup();
    await fallback.onStop(
      {
        session_id: "session-1",
        turn_id: "turn-question",
        cwd: "/tmp/project",
        last_assistant_message: "先做 A 还是 B？",
      },
      "codex",
    );

    const pair = expectPair(
      await fallback.onUserPrompt(
        {
          session_id: "session-1",
          turn_id: "turn-answer",
          cwd: "/tmp/project",
          prompt: "先做 A",
        },
        "codex",
      ),
    );

    expect(pair).toEqual({
      version: 1,
      pairId: expect.stringMatching(/^[a-f0-9]{64}$/u),
      sourceClient: "codex",
      sessionId: "session-1",
      assistantTurnId: "turn-question",
      userTurnId: "turn-answer",
      cwd: "/tmp/project",
      assistantText: "先做 A 还是 B？",
      userText: "先做 A",
      capturedAt: "2026-07-25T02:03:04.000Z",
      expiresAt: "2026-08-01T02:03:04.000Z",
    });
  });

  it("takes the turn that asked for a numbered reply paired with a later progress report", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-numbered-reply-"));
    const fallback = new TextCaptureFallback({
      store: new TextCaptureStore(join(root, "text-pending"), { now: fixedNow }),
      now: fixedNow,
      readEarlierDecisionTurns: async () => [
        { userText: "继续", assistantText: "在跑测试。" },
        {
          userText: "看看发版",
          assistantText: "三件事需要你定：\n\n1. 直推还是走 PR？\n2. 先合 S01 可以吗？\n3. 版本号升不升？\n\n请逐项回复。",
        },
      ],
    });
    await fallback.onStop({ session_id: "s", cwd: "/tmp/project", last_assistant_message: "还在复跑全量测试，大约还要几分钟。跑完发给你。" }, "codex");

    const pair = expectPair(await fallback.onUserPrompt(
      { session_id: "s", cwd: "/tmp/project", prompt: "1 直推，2 可以，3 升", transcript_path: "/tmp/transcript.jsonl" },
      "codex",
    ));

    expect(pair.assistantText).toContain("直推还是走 PR");
    expect(pair.context?.taskBackground).toBe("看看发版");
  });

  it("keeps the pair as it was when no earlier turn holds the numbers, or none can be read", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-numbered-reply-"));
    const fallback = new TextCaptureFallback({
      store: new TextCaptureStore(join(root, "text-pending"), { now: fixedNow }),
      now: fixedNow,
      readEarlierDecisionTurns: async () => { throw new Error("unreadable"); },
    });
    await fallback.onStop({ session_id: "s", cwd: "/tmp/project", last_assistant_message: "还在复跑全量测试。" }, "codex");

    const pair = expectPair(await fallback.onUserPrompt(
      { session_id: "s", cwd: "/tmp/project", prompt: "1 直推，2 可以，3 升", transcript_path: "/tmp/transcript.jsonl" },
      "codex",
    ));

    expect(pair.assistantText).toBe("还在复跑全量测试。");
  });

  it("leaves a prompt the client wrote itself unpaired, and pairs the reader's answer after it", async () => {
    const { fallback } = await setup();
    await fallback.onStop(
      { session_id: "session-1", turn_id: "turn-question", cwd: "/tmp/project", last_assistant_message: "先合并 A 还是等测试结果？" },
      "claude-code",
    );

    // A background test run finished meanwhile: the client tells the model so, as a prompt of its own.
    expect(
      await fallback.onUserPrompt(
        { session_id: "session-1", turn_id: "turn-notice", cwd: "/tmp/project", prompt: "<task-notification>\n<status>completed</status>\n<summary>测试全部通过。</summary>\n</task-notification>" },
        "claude-code",
      ),
    ).toBeNull();
    expect(
      expectPair(
        await fallback.onUserPrompt(
          { session_id: "session-1", turn_id: "turn-answer", cwd: "/tmp/project", prompt: "先合并 A" },
          "claude-code",
        ),
      ),
    ).toMatchObject({ assistantText: "先合并 A 还是等测试结果？", userText: "先合并 A" });
  });

  it("keeps the question through the model's reply to a notice, and lets the next question replace it", async () => {
    const { fallback } = await setup();
    const stop = (turnId: string, text: string) => fallback.onStop(
      { session_id: "session-1", turn_id: turnId, cwd: "/tmp/project", last_assistant_message: text },
      "claude-code",
    );
    const prompt = (turnId: string, text: string) => fallback.onUserPrompt(
      { session_id: "session-1", turn_id: turnId, cwd: "/tmp/project", prompt: text },
      "claude-code",
    );
    await stop("turn-question", "先合并 A 还是等测试结果？");
    await prompt("turn-notice", "<task-notification>\n<status>completed</status>\n</task-notification>");
    // The model answers the notice, and that turn ends as the question's did: it took the question's place,
    // and the reader's answer was paired with "测试都过了" and dropped as no decision.
    await stop("turn-notice-reply", "测试都过了。");
    expect(expectPair(await prompt("turn-answer", "先合并 A"))).toMatchObject({ assistantText: "先合并 A 还是等测试结果？", userText: "先合并 A" });

    // Held for that one turn only: a question asked after it is the one an answer pairs with.
    await stop("turn-question-2", "要不要同时发布文档？");
    await prompt("turn-notice-2", "<task-notification>\n<status>completed</status>\n</task-notification>");
    await stop("turn-notice-reply-2", "构建完成。");
    await stop("turn-question-3", "那发布说明用中文还是英文？");
    expect(expectPair(await prompt("turn-answer-3", "中文"))).toMatchObject({ assistantText: "那发布说明用中文还是英文？" });
  });

  it("takes a notice's reply that asks something as the question, and holds only for the client's own prompts", async () => {
    const { fallback, root, store } = await setup();
    const stop = (turnId: string, text: string) => fallback.onStop(
      { session_id: "session-1", turn_id: turnId, cwd: "/tmp/project", last_assistant_message: text },
      "claude-code",
    );
    const prompt = (turnId: string, text: string) => fallback.onUserPrompt(
      { session_id: "session-1", turn_id: turnId, cwd: "/tmp/project", prompt: text },
      "claude-code",
    );
    const notice = "<task-notification>\n<status>completed</status>\n</task-notification>";
    await stop("turn-status", "我已在后台启动完整构建，完成后会告诉你结果。");
    await prompt("turn-notice", notice);
    // Skipped as a notice's reply, the question asked in it went, and the answer was paired with the status line.
    await stop("turn-notice-reply", "构建通过了。接下来部署到 staging 还是直接上 production？");
    expect(expectPair(await prompt("turn-answer", "先上 staging"))).toMatchObject({
      assistantText: "构建通过了。接下来部署到 staging 还是直接上 production？",
    });

    // The reader's own markup is the reader's prompt, not a notice.
    await stop("turn-styles", "样式已经统一了。");
    expect(expectPair(await prompt("turn-jsx", "<Button> 在暗色模式下看不清，怎么改？"))).toMatchObject({
      assistantText: "样式已经统一了。",
    });

    // The hold travels in its question, and goes with it; a marker an earlier build left beside one is cleared.
    await stop("turn-question", "用 Redis 还是本地 LRU？");
    await prompt("turn-notice-2", notice);
    await writeFile(join(root, "text-pending", "earlier-build.json.held"), "");
    await store.pruneExpired();
    expect((await readdir(join(root, "text-pending"))).filter((name) => name.endsWith(".held"))).toEqual([]);
  });

  it("leaves the prompts Claude Code injects itself unpaired, by their wrapper or by the source it names", async () => {
    const { fallback } = await setup();
    const question = "CI 失败是依赖升级导致的。要我回滚依赖还是修复代码？";
    const reminder = "<system-reminder>\nThe user opened src/app.ts in the IDE.\n</system-reminder>";
    const injected: Array<Record<string, string>> = [
      // As 2.1.304 hands them to the hook: a background agent's report coming back, another session's message.
      { prompt: '<agent-message from="a1">\n[Subagent hand-back] The text below is the final report of a subagent.\n  评审已完成。\n</agent-message>' },
      { prompt: '<cross-session-message from="reviewer">PR #12 的评审已经完成。</cross-session-message>' },
      { prompt: reminder },
      // A /loop wakeup or a schedule repeats a configured prompt as plain text: only the source, once sent, tells.
      { prompt: "检查 CI 状态，失败就修复", source: "loop_wakeup" },
      { prompt: "每天早上汇总一下昨晚的构建结果", source: "schedule_wakeup" },
      { prompt: "PR #12 有新评论", source: "system" },
      // A subagent's own prompt (Codex gives it the session id of the thread that spawned it).
      { prompt: "回滚依赖", agent_id: "subagent-1" },
    ];
    for (const [index, fields] of injected.entries()) {
      const session = { session_id: `session-${index}`, cwd: "/tmp/project" };
      await fallback.onStop({ ...session, last_assistant_message: question }, "claude-code");
      // Paired, it took the question's place: a /loop wakeup was recorded as the reader's choice, and the reader's
      // own answer after it found nothing to pair with.
      expect(await fallback.onUserPrompt({ ...session, ...fields }, "claude-code")).toBeNull();
      expect(expectPair(await fallback.onUserPrompt({ ...session, prompt: "回滚依赖", source: "user" }, "claude-code")))
        .toMatchObject({ assistantText: question, userText: "回滚依赖" });
    }

    // What the reader typed into an app on the SDK is the answer, past the reminder the app joined before it.
    for (const [session, fields] of [
      ["session-reminded", { prompt: `${reminder}\n修复代码`, source: "sdk" }],
      ["session-sdk", { prompt: "修复代码", source: "sdk" }],
    ] as const) {
      await fallback.onStop({ session_id: session, cwd: "/tmp/project", last_assistant_message: question }, "claude-code");
      expect(expectPair(await fallback.onUserPrompt({ session_id: session, cwd: "/tmp/project", ...fields }, "claude-code")))
        .toMatchObject({ assistantText: question, userText: "修复代码" });
    }
  });

  it("leaves an autonomous /loop's firing and a missed task's notice unpaired, by the headings Claude Code writes them under", async () => {
    const { fallback } = await setup();
    const question = "CI 失败是依赖升级导致的。要我回滚依赖还是修复代码？";
    for (const [index, prompt] of [
      // As 2.1.304 hands them to the hook, with no `source` to tell: the loop's sentinel resolved to its instructions
      // on the first firing and to a reminder after, a loop.md loop's tasks, a one-shot task the scheduler missed.
      "# Autonomous loop check\nYou're being invoked on a timer while the user is away or occupied.\n\n# Autonomous loop tick (dynamic pacing)\nRun the autonomous check using the loop instructions established earlier in this conversation.",
      "# Autonomous loop tick\nRun the autonomous check using the loop instructions established earlier in this conversation.",
      "# /loop tick — tasks from /tmp/project/.claude/loop.md\nThe user configured a loop-tasks file.",
      "The following one-shot scheduled task was missed while Claude was not running. It has already been removed from .claude/scheduled_tasks.json.\nDo NOT execute this prompt yet.",
    ].entries()) {
      const session = { session_id: `loop-${index}`, cwd: "/tmp/project" };
      await fallback.onStop({ ...session, last_assistant_message: question }, "claude-code");
      // Paired, the loop's firing was recorded as the reader's choice, and their own answer found nothing to pair with.
      expect(await fallback.onUserPrompt({ ...session, prompt }, "claude-code")).toBeNull();
      expect(expectPair(await fallback.onUserPrompt({ ...session, prompt: "回滚依赖" }, "claude-code")))
        .toMatchObject({ assistantText: question, userText: "回滚依赖" });
    }
  });

  it("leaves a Codex automation's heartbeat unpaired, and pairs the reader's answer after it", async () => {
    const { fallback } = await setup();
    const session = { session_id: "codex-heartbeat", cwd: "/tmp/project" };
    const question = "要先修复登录超时，还是先补测试？";
    await fallback.onStop({ ...session, turn_id: "question", last_assistant_message: question }, "codex");
    // The scheduler's envelope as codex-rs (history/src/heartbeat.rs) reads it: the hook names no trigger to tell it by.
    const heartbeat = "<heartbeat>\n  <automation_id>nightly-check</automation_id>\n  <current_time_iso>2026-09-08T09:00:00Z</current_time_iso>\n  <instructions>\n检查 CI，失败就修复\n  </instructions>\n</heartbeat>\n";

    expect(await fallback.onUserPrompt({ ...session, turn_id: "heartbeat", prompt: heartbeat }, "codex")).toBeNull();
    expect(expectPair(await fallback.onUserPrompt({ ...session, turn_id: "answer", prompt: "先修复登录超时" }, "codex")))
      .toMatchObject({ assistantText: question, userText: "先修复登录超时" });
  });

  it("pairs what the reader typed into Codex, past the browser state and the context its app and IDE put before it", async () => {
    const { fallback } = await setup();
    const question = "要先修复登录超时，还是先补测试？";
    const browser = '<in-app-browser-context source="ambient-ui-state">\nThis block is automatically supplied ambient UI state, not part of the user\'s request.\n# In app browser:\n- The user has the in-app browser open with 1 tab.\n- Current URL: https://intranet.example.com/private-dashboard\n</in-app-browser-context>';
    for (const [index, prompt] of [
      // As the Codex app hands it to the hook: the browser's state, then the request under its heading. Paired whole,
      // the open page's URL went into the note and the index as the reader's answer.
      `\n${browser}\n\n## My request for Codex:\n先修复登录超时\n`,
      // The app also names the heading shorter, and puts the files the reader mentioned before it.
      `\n${browser}\n\n## My request:\n先修复登录超时\n`,
      "\n# Files mentioned by the user:\n\n## login.ts: /Users/me/src/login.ts\n\n## My request:\n先修复登录超时\n",
      // Codex's IDE context: the request follows the last heading, which a selection quoted in the context may hold too.
      "# Context from my IDE setup:\n\n## Active file: src/login.ts\n\n## Active selection of the file:\n## My request for Codex:\n\n## Open tabs:\n- login.ts: src/login.ts\n\n## My request for Codex:\n先修复登录超时",
      "## My request for Codex:\n先修复登录超时",
    ].entries()) {
      const session = { session_id: `codex-${index}`, cwd: "/tmp/project" };
      await fallback.onStop({ ...session, turn_id: `question-${index}`, last_assistant_message: question }, "codex");
      expect(expectPair(await fallback.onUserPrompt({ ...session, turn_id: `answer-${index}`, prompt }, "codex")))
        .toMatchObject({ assistantText: question, userText: "先修复登录超时" });
    }

    // The reader's own Markdown is kept whole, a heading of the same name further down included.
    const typed = "# 我的想法\n先修复登录超时\n## My request:\n顺手补测试";
    await fallback.onStop({ session_id: "codex-typed", turn_id: "question-typed", cwd: "/tmp/project", last_assistant_message: question }, "codex");
    expect(expectPair(await fallback.onUserPrompt({ session_id: "codex-typed", turn_id: "answer-typed", cwd: "/tmp/project", prompt: typed }, "codex")))
      .toMatchObject({ userText: typed });
  });

  it("tells apart the same question answered the same way twice in one Claude Code session", async () => {
    const { fallback } = await setup();
    const answer = async (promptId: string) => {
      await fallback.onStop(
        { session_id: "session-1", cwd: "/tmp/project", last_assistant_message: "测试已全部通过。要我提交这些改动吗？" },
        "claude-code",
      );
      return expectPair(await fallback.onUserPrompt(
        { session_id: "session-1", cwd: "/tmp/project", prompt_id: promptId, prompt: "提交" },
        "claude-code",
      )).pairId;
    };
    // Claude Code sends no turn id: the second commit's pair took the first one's id and was dropped as its replay.
    expect(await answer("prompt-1")).not.toBe(await answer("prompt-2"));
  });

  it("pairs non-decision text for asynchronous classification", async () => {
    const { fallback } = await setup();
    await fallback.onStop(
      {
        session_id: "status-session",
        cwd: "/tmp/project",
        last_assistant_message: "测试已经通过。",
      },
      "claude-code",
    );

    const pair = expectPair(
      await fallback.onUserPrompt(
        {
          session_id: "status-session",
          cwd: "/tmp/project",
          prompt: "继续处理下一个任务",
        },
        "claude-code",
      ),
    );

    expect(pair).toMatchObject({
      assistantText: "测试已经通过。",
      userText: "继续处理下一个任务",
    });
  });

  it("does not cross sessions or reuse a consumed pending turn", async () => {
    const { fallback } = await setup();
    await fallback.onStop(
      {
        session_id: "one",
        cwd: "/tmp/project",
        last_assistant_message: "采用 A 还是 B？",
      },
      "claude-code",
    );

    await expect(
      fallback.onUserPrompt(
        {
          session_id: "two",
          cwd: "/tmp/project",
          prompt: "A",
        },
        "claude-code",
      ),
    ).resolves.toBeNull();
    await expect(
      fallback.onUserPrompt(
        {
          session_id: "one",
          cwd: "/tmp/project",
          prompt: "A",
        },
        "claude-code",
      ),
    ).resolves.toMatchObject({ userText: "A" });
    await expect(
      fallback.onUserPrompt(
        {
          session_id: "one",
          cwd: "/tmp/project",
          prompt: "A again",
        },
        "claude-code",
      ),
    ).resolves.toBeNull();
  });

  it("uses direct text first and bounds it to the final 8000 characters", async () => {
    const reader = vi.fn(async () => "transcript fallback");
    const { fallback } = await setup({
      readLastAssistantText: reader,
    });
    const suffix = "最后要采用 A 还是 B？";
    await fallback.onStop(
      {
        session_id: "bounded",
        transcript_path: "/tmp/ignored.jsonl",
        cwd: "/tmp/project",
        last_assistant_message: `${"前".repeat(8_100)}${suffix}`,
      },
      "codex",
    );

    const pair = expectPair(
      await fallback.onUserPrompt(
        {
          session_id: "bounded",
          cwd: "/tmp/project",
          prompt: "A",
        },
        "codex",
      ),
    );

    expect(pair.assistantText).toHaveLength(8_000);
    expect(pair.assistantText.endsWith(suffix)).toBe(true);
    expect(reader).not.toHaveBeenCalled();
  });

  it("keeps current transcript task context but excludes older history", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "decision-text-context-"),
    );
    const fallback = new TextCaptureFallback({
      store: new TextCaptureStore(
        join(root, "text-pending"),
        { now: fixedNow },
      ),
      readLastDecisionTurn,
      now: fixedNow,
    });
    const transcriptPath = join(root, "session.jsonl");
    const unrelated = "unrelated secret line";
    const related = "继续提高 Decision 的采集质量";
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          message: {
            role: "user",
            content: [{ type: "text", text: unrelated }],
          },
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: [{ type: "text", text: "旧回复" }],
          },
        }),
        JSON.stringify({
          message: {
            role: "user",
            content: [{ type: "text", text: related }],
          },
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "先提高采集质量，还是先做方法论提炼？",
              },
            ],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    await fallback.onStop(
      {
        session_id: "session-privacy",
        cwd: "/tmp/project",
        transcript_path: transcriptPath,
      },
      "claude-code",
    );
    const pair = expectPair(
      await fallback.onUserPrompt(
        {
          session_id: "session-privacy",
          cwd: "/tmp/project",
          prompt: "先提高采集质量",
        },
        "claude-code",
      ),
    );

    expect(pair).toMatchObject({
      assistantText: "先提高采集质量，还是先做方法论提炼？",
      userText: "先提高采集质量",
      context: { taskBackground: related },
    });
    expect(JSON.stringify(pair)).not.toContain(unrelated);
  });

  it("takes as the task only what the reader typed, past the browser state Codex joined to it in the transcript", async () => {
    // With no last_assistant_message the turn is read from the transcript, and its task was the whole prompt there:
    // the open page's URL went into the note's background.
    const root = await mkdtemp(join(tmpdir(), "decision-text-context-"));
    const fallback = new TextCaptureFallback({ store: new TextCaptureStore(join(root, "text-pending"), { now: fixedNow }), readLastDecisionTurn, now: fixedNow });
    const transcriptPath = join(root, "rollout.jsonl");
    const url = "https://intranet.example.com/private-dashboard";
    const typed = `\n<in-app-browser-context source="ambient-ui-state">\n# In app browser:\n- Current URL: ${url}\n</in-app-browser-context>\n\n## My request:\n修复登录超时\n`;
    await writeFile(transcriptPath, [
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: typed }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "先修复登录超时，还是先补测试？" }] } }),
    ].join("\n"), "utf8");

    await fallback.onStop({ session_id: "codex-transcript", turn_id: "question", cwd: "/tmp/project", transcript_path: transcriptPath }, "codex");
    const pair = expectPair(await fallback.onUserPrompt({ session_id: "codex-transcript", turn_id: "answer", cwd: "/tmp/project", prompt: "先修复" }, "codex"));

    expect(pair).toMatchObject({ assistantText: "先修复登录超时，还是先补测试？", context: { taskBackground: "修复登录超时" } });
    expect(JSON.stringify(pair)).not.toContain(url);
  });

  it("does not attach stale transcript context to direct text", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "decision-stale-turn-"),
    );
    const readTurn = vi.fn(async () => ({
      userText: "这是上一轮无关的私密任务。",
      assistantText: "上一轮要采用 X 还是 Y？",
    }));
    const fallback = new TextCaptureFallback({
      store: new TextCaptureStore(
        join(root, "text-pending"),
        { now: fixedNow },
      ),
      readLastDecisionTurn: readTurn,
      now: fixedNow,
    });
    await fallback.onStop(
      {
        session_id: "session-direct-current",
        cwd: "/tmp/project",
        transcript_path: "/tmp/lagging.jsonl",
        last_assistant_message: "当前要采用 A 还是 B？",
      },
      "claude-code",
    );

    const pair = expectPair(
      await fallback.onUserPrompt(
        {
          session_id: "session-direct-current",
          cwd: "/tmp/project",
          prompt: "A",
        },
        "claude-code",
      ),
    );

    expect(pair.context).toBeUndefined();
    expect(JSON.stringify(pair)).not.toContain(
      "这是上一轮无关的私密任务。",
    );
    expect(readTurn).not.toHaveBeenCalled();
  });

  it("preserves the field regression and mixed answer verbatim", async () => {
    const { fallback } = await setup();
    const assistantText = [
      "但两件事要说清楚：",
      "1. 这是既有代码，不是本次引入。",
      "2. 搬家不是纯机械的，需要先在 domain 定义输入契约。",
      "",
      "两仓仍未提交。是先处理上面的技术债，还是先提交当前这批？",
    ].join("\n");
    const userText =
      "另外，为什么要拆为两个字段，不能直接传完整 data 吗？本次引入的需要处理。";
    await fallback.onStop(
      {
        session_id: "field-regression",
        turn_id: "assistant-field",
        cwd: "/tmp/project",
        last_assistant_message: assistantText,
      },
      "codex",
    );

    const pair = expectPair(
      await fallback.onUserPrompt(
        {
          session_id: "field-regression",
          turn_id: "user-field",
          cwd: "/tmp/project",
          prompt: userText,
        },
        "codex",
      ),
    );

    expect(pair.assistantText).toBe(assistantText);
    expect(pair.userText).toBe(userText);
  });

  it("records internal observation stages without exposing text", async () => {
    const record = vi.fn(
      async (_input: Record<string, unknown>) => undefined,
    );
    const { fallback } = await setup({ audit: { record } });
    await fallback.onStop(
      {
        session_id: "audit-session",
        turn_id: "assistant-turn",
        cwd: "/tmp/project",
        last_assistant_message: "现在继续吗？",
      },
      "codex",
    );
    await fallback.onUserPrompt(
      {
        session_id: "audit-session",
        turn_id: "user-turn",
        cwd: "/tmp/project",
        prompt: "继续",
      },
      "codex",
    );

    expect(record.mock.calls.map(([input]) => input.stage)).toEqual([
      "assistant_text_resolved",
      "pending_saved",
      "user_prompt_matched",
    ]);
    expect(JSON.stringify(record.mock.calls)).not.toContain(
      "现在继续吗？",
    );
    expect(JSON.stringify(record.mock.calls)).not.toContain("继续");
  });

  it("names the hook payloads it cannot use instead of dropping them silently", async () => {
    const record = vi.fn(
      async (_input: Record<string, unknown>) => undefined,
    );
    const { fallback } = await setup({ audit: { record } });

    await fallback.onStop(
      {
        session_id: "no-cwd",
        turn_id: "assistant-turn",
        last_assistant_message: "现在继续吗？",
      },
      "codex",
    );
    await fallback.onUserPrompt(
      {
        session_id: "no-prompt",
        turn_id: "user-turn",
        cwd: "/tmp/project",
      },
      "codex",
    );

    expect(record.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({
        sessionId: "no-cwd",
        turnId: "assistant-turn",
        stage: "stop_cwd_missing",
      }),
      expect.objectContaining({
        sessionId: "no-prompt",
        turnId: "user-turn",
        stage: "prompt_text_missing",
      }),
    ]);
  });

  it("does not call the first prompt of a session a failure", async () => {
    const record = vi.fn(
      async (_input: Record<string, unknown>) => undefined,
    );
    const { fallback } = await setup({ audit: { record } });

    await expect(
      fallback.onUserPrompt(
        {
          session_id: "fresh-session",
          turn_id: "user-turn",
          cwd: "/tmp/project",
          prompt: "继续",
        },
        "codex",
      ),
    ).resolves.toBeNull();

    expect(record.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({
        stage: "user_prompt_unpaired",
      }),
    ]);
    expect(record.mock.calls[0]?.[0]).not.toHaveProperty(
      "errorCode",
    );
  });

  it.each(["rules-v1", "rules-v2", "rules-v3", "rules-v4", "rules-v5", "rules-v6", "rules-v7", "rules-v8", "rules-v9", "rules-v10"])(
    "accepts a pending analysis saved by %s rules",
    async (detectorVersion) => {
      const store = new TextCaptureStore(
        join(await mkdtemp(join(tmpdir(), "decision-text-version-")), "text-pending"),
      );
      await store.save({
        version: 2,
        sourceClient: "codex",
        sessionId: `version-${detectorVersion}`,
        cwd: "/tmp/project",
        analysis: {
          question: "1 和 3 要做吗？",
          options: [],
          preScore: 80,
          signals: ["has_choice_prompt"],
          detectorVersion,
        },
        capturedAt: new Date().toISOString(),
      } as never);
      await expect(
        store.consume("codex", `version-${detectorVersion}`),
      ).resolves.toMatchObject({
        pending: { version: 3, assistantText: "1 和 3 要做吗？" },
      });
    },
  );

  it("does not read a pending analysis from unknown rules", async () => {
    const store = new TextCaptureStore(
      join(await mkdtemp(join(tmpdir(), "decision-text-version-")), "text-pending"),
    );
    await expect(
      store.save({
        version: 2,
        sourceClient: "codex",
        sessionId: "version-rules-v11",
        cwd: "/tmp/project",
        analysis: {
          question: "继续吗？",
          options: [],
          preScore: 80,
          signals: [],
          detectorVersion: "rules-v11",
        },
        capturedAt: new Date().toISOString(),
      } as never),
    ).rejects.toThrow();
  });

  it("stores private version-3 pending data and migrates legacy versions", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "decision-text-expiry-"),
    );
    let now = new Date("2026-07-25T00:00:00.000Z");
    const store = new TextCaptureStore(
      join(root, "text-pending"),
      { now: () => now },
    );
    await store.save({
      version: 1,
      sourceClient: "codex",
      sessionId: "legacy-one",
      cwd: "/tmp/project",
      question: "继续吗？",
      capturedAt: now.toISOString(),
    });
    await expect(
      store.consume("codex", "legacy-one"),
    ).resolves.toMatchObject({
      pending: { version: 3, assistantText: "继续吗？" },
    });
    await store.save({
      version: 2,
      sourceClient: "codex",
      sessionId: "legacy-two",
      cwd: "/tmp/project",
      analysis: {
        question: "采用 A 还是 B？",
        options: [],
        context: { taskBackground: "当前任务" },
        preScore: 100,
        signals: ["has_choice_prompt"],
        detectorVersion: "rules-v1",
      },
      capturedAt: now.toISOString(),
    });
    await expect(
      store.consume("codex", "legacy-two"),
    ).resolves.toMatchObject({
      pending: {
        version: 3,
        assistantText: "采用 A 还是 B？",
        context: { taskBackground: "当前任务" },
      },
    });

    await store.save({
      version: 3,
      sourceClient: "codex",
      sessionId: "private-session-name",
      cwd: "/tmp/project",
      assistantText: "现在继续吗？",
      capturedAt: now.toISOString(),
    });
    const directory = join(root, "text-pending");
    const [filename] = (await readdir(directory)).filter((name) =>
      name.endsWith(".json"),
    );
    if (filename === undefined) {
      throw new Error("pending text fixture missing");
    }
    expect(filename).toMatch(/^[a-f0-9]{64}\.json$/u);
    expect(filename).not.toContain("private-session-name");
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, filename))).mode & 0o777).toBe(
      0o600,
    );
    expect(await readFile(join(directory, filename), "utf8")).toContain(
      "现在继续吗？",
    );
    now = new Date("2026-07-26T00:00:00.001Z");
    await expect(
      store.consume("codex", "private-session-name"),
    ).resolves.toEqual({ pending: null, reason: "absent" });
  });
});
