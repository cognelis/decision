import { describe, expect, it } from "vitest";

import {
  adaptClaudePostToolUse,
  adaptCodexPostToolUse,
} from "../src/hook-adapters.js";

const now = () => new Date("2026-07-25T00:00:00.000Z");

describe("native question hook adapters", () => {
  it.each([
    ["Claude", adaptClaudePostToolUse, "AskUserQuestion"],
    ["Codex", adaptCodexPostToolUse, "request_user_input"],
  ] as const)("skips empty %s answers without losing answered questions", (_client, adapt, toolName) => {
    const payload = {
      session_id: "partially-answered",
      cwd: "/tmp/project",
      tool_name: toolName,
      tool_use_id: "call-partial",
      tool_input: {
        questions: [
          { id: "single", question: "single", options: [] },
          { id: "multiple", question: "multiple", options: [], multiSelect: true },
          { id: "answered", question: "answered", options: [{ label: "Keep" }] },
        ],
      },
      tool_response: {
        answers: { single: [], multiple: { answers: [] }, answered: ["Keep"] },
      },
    };

    expect(adapt(payload, now)?.questions).toEqual([
      {
        questionIndex: 2,
        question: "answered",
        options: [{ label: "Keep" }],
        answer: { kind: "preset", values: ["Keep"] },
        multiSelect: false,
      },
    ]);
    expect(adapt({
      ...payload,
      tool_response: { answers: { single: [], multiple: { answers: [] } } },
    }, now)).toBeNull();
  });

  it("maps every answered Claude question into one normalized batch", () => {
    const event = adaptClaudePostToolUse(
      {
        session_id: "claude-session",
        cwd: "/tmp/project",
        hook_event_name: "PostToolUse",
        tool_name: "AskUserQuestion",
        tool_use_id: "toolu_1",
        tool_input: {
          questions: [
            {
              header: "Framework",
              question: "Which framework?",
              options: [
                { label: "React", description: "Established" },
                { label: "Vue", description: "Compact" },
              ],
              multiSelect: false,
            },
            {
              header: "Priorities",
              question: "Which priorities?",
              options: [
                { label: "Risk", description: "Reduce uncertainty" },
                { label: "Time", description: "Ship quickly" },
              ],
              multiSelect: true,
            },
          ],
        },
        tool_response: {
          answers: {
            "Which framework?": "React",
            "Which priorities?": "Risk, Time",
          },
        },
      },
      now,
    );

    expect(event).toMatchObject({
      eventVersion: 1,
      captureMode: "structured_tool",
      sourceClient: "claude-code",
      sessionId: "claude-session",
      toolUseId: "toolu_1",
      batchId: "claude-code:claude-session:toolu_1",
      project: "project",
      capturedAt: "2026-07-25T00:00:00.000Z",
      questions: [
        {
          questionIndex: 0,
          question: "Which framework?",
          answer: { kind: "preset", values: ["React"] },
          multiSelect: false,
        },
        {
          questionIndex: 1,
          question: "Which priorities?",
          answer: { kind: "multiple", values: ["Risk", "Time"] },
          multiSelect: true,
        },
      ],
    });
  });

  it("splits a multi-select answer into the options it names, a label's own comma included, and the rest as one answer", () => {
    const answered = (answer: string) => adaptClaudePostToolUse(
      {
        session_id: "claude-session",
        cwd: "/tmp/project",
        hook_event_name: "PostToolUse",
        tool_name: "AskUserQuestion",
        tool_use_id: "toolu_2",
        tool_input: {
          questions: [{
            header: "Checks",
            question: "Which checks?",
            options: [
              { label: "Unit tests, fast", description: "Seconds" },
              { label: "E2E", description: "Minutes" },
            ],
            multiSelect: true,
          }],
        },
        tool_response: { answers: { "Which checks?": answer } },
      },
      now,
    )?.questions[0]?.answer;

    expect(answered("Unit tests, fast, E2E")).toEqual({ kind: "multiple", values: ["Unit tests, fast", "E2E"] });
    // Typed in as well: kept as the reader wrote it, one value, however many commas it has.
    expect(answered("E2E, lint, typecheck, unit, perf, a11y, i18n, bundle size, docs")).toEqual({
      kind: "multiple",
      values: ["E2E", "lint, typecheck, unit, perf, a11y, i18n, bundle size, docs"],
    });
    // As written, its own commas and spacing too.
    expect(answered("E2E, batch size 1,000")).toEqual({ kind: "multiple", values: ["E2E", "batch size 1,000"] });
    // Written among the options, it stays where it was written.
    expect(answered("E2E, lint first, Unit tests, fast")).toEqual({ kind: "multiple", values: ["E2E", "lint first", "Unit tests, fast"] });
    expect(answered("lint, E2E")).toEqual({ kind: "multiple", values: ["lint", "E2E"] });
    // Kept in place it would pass eight values, the most a capture holds: the reader's own text becomes one
    // answer after the options instead, rather than the whole capture failing its check and being lost.
    expect(answered("E2E, a, Unit tests, fast, b, E2E, c, Unit tests, fast, d, E2E, e")).toEqual({
      kind: "multiple",
      values: ["E2E", "Unit tests, fast", "E2E", "Unit tests, fast", "E2E", "a, b, c, d, e"],
    });
  });

  it("answers a pasted list of thousands of commas well inside a hook's time", () => {
    const pasted = Array.from({ length: 4_000 }, (_unused, index) => `item${index}`).join(",");
    const started = performance.now();
    const answer = adaptClaudePostToolUse({
      session_id: "claude-session",
      cwd: "/tmp/project",
      tool_name: "AskUserQuestion",
      tool_use_id: "toolu_long",
      tool_input: { questions: [{ question: "Which?", options: [{ label: "A, B" }, { label: "C" }], multiSelect: true }] },
      tool_response: { answers: { "Which?": `C, ${pasted}` } },
    }, now)?.questions[0]?.answer;
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(answer?.values[0]).toBe("C");
  });

  it("keeps the other questions when one answer is past its limit, cutting that answer to fit", () => {
    const event = adaptClaudePostToolUse({
      session_id: "claude-session",
      cwd: "/tmp/project",
      tool_name: "AskUserQuestion",
      tool_use_id: "toolu_over",
      tool_input: {
        questions: [
          { question: "Framework?", options: [{ label: "React" }, { label: "Vue" }] },
          { question: "Why?", options: [{ label: "Speed" }] },
        ],
      },
      tool_response: { answers: { "Framework?": "React", "Why?": "长".repeat(2_001) } },
    }, now);
    expect(event?.questions.map((question) => question.question)).toEqual(["Framework?", "Why?"]);
    expect(event?.questions[1]?.answer.values[0]).toHaveLength(2_000);
  });

  it("finds the answer to a question sent with whitespace around it, and captures a session started at the root", () => {
    const event = adaptClaudePostToolUse({
      session_id: "claude-session",
      cwd: "/",
      tool_name: "AskUserQuestion",
      tool_use_id: "toolu_ws",
      tool_input: { questions: [{ question: "Which framework?\n", options: [{ label: "React" }] }] },
      tool_response: { answers: { "Which framework?\n": "React" } },
    }, now);
    expect(event).toMatchObject({ project: "unknown-project", questions: [{ question: "Which framework?", answer: { values: ["React"] } }] });
  });

  it("maps Codex request_user_input answers by question id", () => {
    const event = adaptCodexPostToolUse(
      {
        session_id: "codex-session",
        turn_id: "turn-1",
        cwd: "/tmp/project",
        hook_event_name: "PostToolUse",
        tool_name: "request_user_input",
        tool_use_id: "call-1",
        tool_input: {
          questions: [
            {
              id: "framework",
              header: "Framework",
              question: "Which framework?",
              options: [
                { label: "React", description: "Established" },
                { label: "Vue", description: "Compact" },
              ],
            },
          ],
        },
        tool_response: {
          answers: {
            framework: { answers: ["Something else"] },
          },
        },
      },
      now,
    );

    expect(event).toMatchObject({
      sourceClient: "codex",
      sessionId: "codex-session",
      turnId: "turn-1",
      toolUseId: "call-1",
      questions: [
        {
          answer: { kind: "custom", values: ["Something else"] },
        },
      ],
    });
  });

  it("takes what the reader wrote in Claude Code instead of an option as their answer", () => {
    const question = "前端状态管理用哪个？";
    const payload = (toolResponse: Record<string, unknown>) => ({
      session_id: "cc-session", cwd: "/tmp/project", tool_use_id: "toolu-notes", tool_name: "AskUserQuestion",
      tool_input: { questions: [{ header: "状态管理", question, options: [{ label: "Zustand", description: "轻量" }, { label: "Redux Toolkit", description: "成熟" }], multiSelect: false }] },
      tool_response: { questions: [], ...toolResponse },
    });

    // Notes, no option: filed under "(notes only)", which was recorded as the reader's answer.
    expect(adaptClaudePostToolUse(payload({
      answers: { [question]: "(notes only)" },
      annotations: { [question]: { notes: "两个都不要，先用 React context" } },
    }), now)?.questions[0]?.answer).toEqual({ kind: "custom", values: ["两个都不要，先用 React context"] });
    // Typed instead of choosing: nothing was captured from a question the reader did answer.
    expect(adaptClaudePostToolUse(payload({ answers: {}, response: "先别定，等我看完性能数据再说" }), now)?.questions[0]?.answer)
      .toEqual({ kind: "custom", values: ["先别定，等我看完性能数据再说"] });
  });

  it("records neither a request for another round of questions nor a dialog that closed while the reader was away", () => {
    const question = "缓存层先用 Redis 还是先用进程内 LRU？";
    const payload = (toolResponse: Record<string, unknown>) => ({
      session_id: "cc-session", cwd: "/tmp/project", tool_use_id: "toolu-followup", tool_name: "AskUserQuestion",
      tool_input: { questions: [{ header: "缓存", question, options: [{ label: "Redis", description: "多实例共享" }, { label: "进程内 LRU", description: "零依赖" }], multiSelect: false }] },
      tool_response: { questions: [], ...toolResponse },
    });

    // Claude Code told the model the reader wants more questions first: their words were filed as the answer.
    expect(adaptClaudePostToolUse(payload({ answers: {}, response: "先别定，先对比一下两者的运维成本", followUp: true }), now)).toBeNull();
    // Answered one and asked for more on the rest: the answer stands.
    expect(adaptClaudePostToolUse(payload({ answers: { [question]: "Redis" }, followUp: true }), now)?.questions[0]?.answer)
      .toEqual({ kind: "preset", values: ["Redis"] });
    // Closed after a minute idle: what stood selected was filed as the reader's choice.
    expect(adaptClaudePostToolUse(payload({ answers: { [question]: "Redis" }, afkTimeoutMs: 60_000 }), now)).toBeNull();
  });

  it("reads a Codex note as the reader's words, not as one more option chosen", () => {
    const payload = (answers: string[]) => ({
      session_id: "codex-session", turn_id: "turn-1", cwd: "/tmp/project", tool_name: "request_user_input", tool_use_id: "call-1",
      tool_input: { questions: [{ id: "start", header: "起步方式", question: "先写测试还是先做原型？", options: [{ label: "先写测试 (Recommended)" }, { label: "先做原型" }] }] },
      tool_response: { answers: { start: { answers } } },
    });

    // Beside a choice, a single-choice question was recorded as "multiple", the note as an option.
    expect(adaptCodexPostToolUse(payload(["先写测试 (Recommended)", "user_note: 只写单元测试"]), now)?.questions[0]?.answer)
      .toEqual({ kind: "preset", values: ["先写测试 (Recommended)"] });
    // In place of one, Codex's own prefix was kept in the reader's answer.
    expect(adaptCodexPostToolUse(payload(["user_note: 两个都不要，先做技术验证"]), now)?.questions[0]?.answer)
      .toEqual({ kind: "custom", values: ["两个都不要，先做技术验证"] });
  });

  it("returns null for unrelated, cancelled, and unanswered calls", () => {
    expect(
      adaptClaudePostToolUse({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
      }),
    ).toBeNull();
    expect(
      adaptClaudePostToolUse({
        session_id: "session",
        cwd: "/tmp/project",
        hook_event_name: "PostToolUse",
        tool_name: "AskUserQuestion",
        tool_use_id: "tool",
        tool_input: { questions: [] },
        tool_response: { answers: {} },
      }),
    ).toBeNull();
    expect(
      adaptCodexPostToolUse({
        session_id: "session",
        cwd: "/tmp/project",
        hook_event_name: "PostToolUse",
        tool_name: "request_user_input",
        tool_use_id: "tool",
        tool_input: {
          questions: [
            {
              id: "missing",
              header: "Missing",
              question: "No answer?",
              options: [],
            },
          ],
        },
        tool_response: { answers: {} },
      }),
    ).toBeNull();
  });
});
