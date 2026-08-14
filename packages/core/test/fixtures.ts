import type {
  CapturedDecisionEvent,
  CapturedQuestion,
} from "@cognelis/decision-protocol";

export const questionFixture = (
  questionIndex = 0,
  overrides: Partial<CapturedQuestion> = {},
): CapturedQuestion => ({
  questionIndex,
  header: "Storage",
  question: `Which storage format? ${questionIndex}`,
  options: [
    { id: "markdown", label: "Markdown", description: "Readable" },
    { id: "sqlite", label: "SQLite", description: "Queryable" },
  ],
  answer: { kind: "preset", values: ["Markdown"] },
  multiSelect: false,
  ...overrides,
});

export const captureFixture = (
  overrides: Partial<CapturedDecisionEvent> = {},
): CapturedDecisionEvent => ({
  eventVersion: 1,
  captureMode: "structured_tool",
  sourceClient: "codex",
  sessionId: "session-1",
  turnId: "turn-1",
  sourceEventId: "event-1",
  toolUseId: "tool-1",
  batchId: "codex:session-1:tool-1",
  project: "decision",
  cwd: "/tmp/decision",
  capturedAt: "2026-07-25T00:00:00.000Z",
  questions: [questionFixture()],
  ...overrides,
});
