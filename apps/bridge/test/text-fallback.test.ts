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

  it("preserves a final text pair after native decisions", async () => {
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
      version: 3,
      assistantText: "继续吗？",
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
      version: 3,
      assistantText: "采用 A 还是 B？",
      context: { taskBackground: "当前任务" },
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
    ).resolves.toBeNull();
  });
});
