import { describe, expect, it } from "vitest";

import {
  capturedDecisionCandidateSchema,
  capturedDecisionEventSchema,
  captureReceiptSchema,
  runtimeDescriptorSchema,
} from "../src/index.js";

const validCapture = {
  eventVersion: 1,
  captureMode: "structured_tool",
  sourceClient: "codex",
  sessionId: "session-1",
  turnId: "turn-1",
  sourceEventId: "event-1",
  toolUseId: "tool-1",
  batchId: "codex:session-1:tool-1",
  project: "decision",
  cwd: "/Users/demo/decision",
  capturedAt: "2026-07-25T00:00:00.000Z",
  questions: [
    {
      questionIndex: 0,
      header: "Storage",
      question: "Which storage format?",
      options: [
        {
          id: "markdown",
          label: "Markdown",
          description: "Readable",
        },
        {
          id: "sqlite",
          label: "SQLite",
          description: "Queryable",
        },
      ],
      answer: { kind: "preset", values: ["Markdown"] },
      multiSelect: false,
    },
  ],
} as const;

describe("capturedDecisionEventSchema", () => {
  it("accepts a complete structured capture", () => {
    expect(capturedDecisionEventSchema.parse(validCapture)).toEqual(
      validCapture,
    );
  });

  it("preserves a multi-select answer", () => {
    const event = {
      ...validCapture,
      questions: [
        {
          ...validCapture.questions[0],
          multiSelect: true,
          answer: {
            kind: "multiple",
            values: ["Risk", "Time"],
          },
        },
      ],
    } as const;

    expect(capturedDecisionEventSchema.parse(event)).toEqual(event);
  });

  it("accepts bounded context and versioned detection metadata", () => {
    const event = {
      ...validCapture,
      captureMode: "transcript",
      context: {
        taskBackground: "继续开发 Decision。",
        decisionFraming:
          "规则方案低延迟，本地模型以后再接入。",
        truncated: false,
      },
      detection: {
        band: "high",
        score: 86,
        detectorVersion: "rules-v1",
        signals: [
          "has_choice_prompt",
          "answer_matches_option",
        ],
      },
    } as const;

    expect(capturedDecisionEventSchema.parse(event)).toEqual(event);
    expect(
      capturedDecisionEventSchema.parse(validCapture).context,
    ).toBeUndefined();
  });

  it("rejects oversized combined context and invalid detection scores", () => {
    expect(() =>
      capturedDecisionEventSchema.parse({
        ...validCapture,
        context: {
          taskBackground: "a".repeat(3_001),
          decisionFraming: "b".repeat(3_000),
        },
      }),
    ).toThrow(/6000/u);

    expect(() =>
      capturedDecisionEventSchema.parse({
        ...validCapture,
        detection: {
          band: "high",
          score: 101,
          detectorVersion: "rules-v1",
          signals: [],
        },
      }),
    ).toThrow();
  });

  it("rejects unknown context and detection fields", () => {
    expect(() =>
      capturedDecisionEventSchema.parse({
        ...validCapture,
        context: {
          taskBackground: "继续开发。",
          rawTranscript: "must not be accepted",
        },
      }),
    ).toThrow();

    expect(() =>
      capturedDecisionEventSchema.parse({
        ...validCapture,
        detection: {
          band: "high",
          score: 80,
          detectorVersion: "rules-v1",
          signals: [],
          rawEvidence: "must not be accepted",
        },
      }),
    ).toThrow();
  });

  it("rejects duplicate question indexes", () => {
    expect(() =>
      capturedDecisionEventSchema.parse({
        ...validCapture,
        questions: [
          validCapture.questions[0],
          validCapture.questions[0],
        ],
      }),
    ).toThrow(/question indexes/i);
  });

  it("validates capture receipts", () => {
    expect(
      captureReceiptSchema.parse({
        accepted: 1,
        duplicates: 0,
      }),
    ).toEqual({ accepted: 1, duplicates: 0 });
  });
});

describe("capturedDecisionCandidateSchema", () => {
  const mediumEvent = {
    ...validCapture,
    captureMode: "transcript",
    detection: {
      band: "medium",
      score: 64,
      detectorVersion: "rules-v1",
      signals: ["implicit_choice_prompt"],
    },
  } as const;

  it("accepts an expiring medium-confidence candidate", () => {
    const candidate = {
      candidateVersion: 1,
      candidateId: "candidate-1",
      createdAt: "2026-07-27T00:00:00.000Z",
      expiresAt: "2026-08-03T00:00:00.000Z",
      event: mediumEvent,
    } as const;

    expect(capturedDecisionCandidateSchema.parse(candidate)).toEqual(
      candidate,
    );
  });

  it("rejects high-confidence events and unknown candidate fields", () => {
    expect(() =>
      capturedDecisionCandidateSchema.parse({
        candidateVersion: 1,
        candidateId: "candidate-1",
        createdAt: "2026-07-27T00:00:00.000Z",
        expiresAt: "2026-08-03T00:00:00.000Z",
        event: {
          ...mediumEvent,
          detection: {
            ...mediumEvent.detection,
            band: "high",
          },
        },
      }),
    ).toThrow(/medium/u);

    expect(() =>
      capturedDecisionCandidateSchema.parse({
        candidateVersion: 1,
        candidateId: "candidate-1",
        createdAt: "2026-07-27T00:00:00.000Z",
        expiresAt: "2026-08-03T00:00:00.000Z",
        event: mediumEvent,
        transcript: "must not be accepted",
      }),
    ).toThrow();
  });
});

describe("runtimeDescriptorSchema", () => {
  it("accepts a protected local runtime descriptor", () => {
    const descriptor = {
      protocolVersion: 1,
      port: 43123,
      token: "a".repeat(64),
      pid: 4242,
      startedAt: "2026-07-24T00:00:00.000Z",
    };

    expect(runtimeDescriptorSchema.parse(descriptor)).toEqual(
      descriptor,
    );
  });

  it("rejects a short bearer token", () => {
    expect(() =>
      runtimeDescriptorSchema.parse({
        protocolVersion: 1,
        port: 43123,
        token: "short",
        pid: 4242,
        startedAt: "2026-07-24T00:00:00.000Z",
      }),
    ).toThrow();
  });
});
