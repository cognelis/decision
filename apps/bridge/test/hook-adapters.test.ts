import { describe, expect, it } from "vitest";

import {
  adaptClaudePostToolUse,
  adaptCodexPostToolUse,
} from "../src/hook-adapters.js";

const now = () => new Date("2026-07-25T00:00:00.000Z");

describe("native question hook adapters", () => {
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
