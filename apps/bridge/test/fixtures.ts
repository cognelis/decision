import type { CapturedDecisionEvent } from "@cognelis/decision-protocol";

export const captureFixture = (): CapturedDecisionEvent => ({
  eventVersion: 1,
  captureMode: "structured_tool",
  sourceClient: "claude-code",
  sessionId: "claude-session",
  sourceEventId: "toolu_1",
  toolUseId: "toolu_1",
  batchId: "claude-code:claude-session:toolu_1",
  project: "project",
  cwd: "/tmp/project",
  capturedAt: "2026-07-25T00:00:00.000Z",
  questions: [
    {
      questionIndex: 0,
      header: "Framework",
      question: "Which framework?",
      options: [
        { label: "React", description: "Established" },
        { label: "Vue", description: "Compact" },
      ],
      answer: { kind: "preset", values: ["React"] },
      multiSelect: false,
    },
  ],
});

export const claudePostToolUseFixture = () => ({
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
    ],
  },
  tool_response: {
    answers: {
      "Which framework?": "React",
    },
  },
});

export const codexPostToolUseFixture = () => ({
  session_id: "codex-session",
  cwd: "/tmp/project",
  hook_event_name: "PostToolUse",
  tool_name: "request_user_input",
  tool_use_id: "call_1",
  tool_input: {
    questions: [
      {
        id: "framework",
        header: "Framework",
        question: "Which framework?",
        options: [{ label: "React" }, { label: "Vue" }],
      },
    ],
  },
  tool_response: {
    answers: {
      framework: { answers: ["React"] },
    },
  },
});
