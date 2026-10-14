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
