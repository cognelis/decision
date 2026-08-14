import type {
  CapturedDecisionCandidate,
  CapturedDecisionEvent,
  SemanticDecisionPair,
} from "@cognelis/decision-protocol";

export const serverCaptureFixture = (
  overrides: Partial<CapturedDecisionEvent> = {},
): CapturedDecisionEvent => ({
  eventVersion: 1,
  captureMode: "structured_tool",
  sourceClient: "test",
  sessionId: "server-test",
  turnId: "turn-1",
  sourceEventId: "event-1",
  toolUseId: "tool-1",
  batchId: "test:server-test:tool-1",
  project: "decision",
  cwd: "/tmp/decision",
  capturedAt: "2026-07-25T00:00:00.000Z",
  questions: [
    {
      questionIndex: 0,
      header: "Protocol",
      question: "选择本地服务协议",
      options: [
        {
          id: "http",
          label: "Loopback HTTP",
          description: "跨平台且便于诊断",
        },
        {
          id: "socket",
          label: "Unix Socket",
          description: "不占 TCP 端口",
        },
      ],
      answer: {
        kind: "preset",
        values: ["Loopback HTTP"],
      },
      multiSelect: false,
    },
  ],
  ...overrides,
});

export const serverCandidateFixture = (): CapturedDecisionCandidate => ({
  candidateVersion: 1,
  candidateId: "candidate-server-1",
  createdAt: "2026-07-27T00:00:00.000Z",
  expiresAt: "2036-08-03T00:00:00.000Z",
  event: serverCaptureFixture({
    captureMode: "transcript",
    detection: {
      band: "medium",
      score: 65,
      detectorVersion: "rules-v1",
      signals: ["awaits_confirmation"],
    },
  }),
});

export const semanticPairFixture = (
  overrides: Partial<SemanticDecisionPair> = {},
): SemanticDecisionPair => ({
  version: 1,
  pairId: "semantic-pair-server-1",
  sourceClient: "codex",
  sessionId: "semantic-session-1",
  assistantTurnId: "assistant-turn-1",
  userTurnId: "user-turn-1",
  cwd: "/tmp/decision",
  assistantText: "先处理技术债，还是先提交当前这批？",
  userText: "本次引入的需要处理。另外，为什么要拆字段？",
  context: {
    taskBackground: "继续处理当前开发任务。",
  },
  capturedAt: "2026-07-27T00:00:00.000Z",
  expiresAt: "2036-08-03T00:00:00.000Z",
  ...overrides,
});
