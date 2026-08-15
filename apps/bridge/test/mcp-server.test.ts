import {
  DECISION_CONSULTATION_FEEDBACK_VERSION,
  DECISION_CONSULTATION_VERSION,
  type DecisionConsultationResponse,
} from "@cognelis/decision-protocol";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";

import {
  consultDecisionPrinciples,
  createDecisionMcpServer,
  recordDecisionConsultationFeedback,
} from "../src/mcp-server.js";

const matchedResponse = (): DecisionConsultationResponse => ({
  consultationVersion: DECISION_CONSULTATION_VERSION,
  requestId: "consultation-1",
  status: "matched",
  generatedBy: "deterministic_local_match",
  feedback: {
    token: "opaque-feedback-token",
    expiresAt: "2026-08-08T10:30:00.000Z",
  },
  matches: [
    {
      principleId: "principle-1",
      title: "先验证再扩大",
      principle: "先验证关键边界，再扩大不可逆投入。",
      appliesWhen: "真实运行效果仍不明确时。",
      caution: "验证成本过高时重新评估。",
      confidence: "medium",
      evidenceCount: 2,
      relevanceScore: 45,
      relevance: "strong",
      reason: "适用条件与当前决策存在文本重合。",
      matchedTerms: ["边界"],
    },
  ],
  boundary: {
    advisoryOnly: true,
    noDecisionWritten: true,
    noPrincipleApplied: true,
  },
});

describe("decision consultation MCP", () => {
  it("advertises and serves the read-only tool over MCP transport", async () => {
    const server = createDecisionMcpServer({
      sourceClient: "codex",
      runtime: { consult: async () => matchedResponse() },
      requestIdFactory: () => "consultation-1",
      now: () => new Date("2026-08-08T10:00:00.000Z"),
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const responses = new Map<
      string | number,
      (message: Record<string, unknown>) => void
    >();
    clientTransport.onmessage = (message) => {
      if (
        "id" in message &&
        (typeof message.id === "string" || typeof message.id === "number")
      ) {
        responses.get(message.id)?.(message as Record<string, unknown>);
      }
    };
    await Promise.all([server.connect(serverTransport), clientTransport.start()]);
    const request = async (
      id: number,
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`MCP ${method} timed out`)),
          2_000,
        );
        responses.set(id, (message) => {
          clearTimeout(timer);
          responses.delete(id);
          resolve(message);
        });
        void clientTransport.send({
          jsonrpc: "2.0",
          id,
          method,
          params,
        });
      });

    const initialized = await request(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    });
    expect(initialized).toMatchObject({
      result: {
        serverInfo: { name: "decision", version: "1.1.0" },
      },
    });
    await clientTransport.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    const listed = await request(2, "tools/list");
    expect(listed).toMatchObject({
      result: {
        tools: [
          expect.objectContaining({
            name: "consult_decision_principles",
            annotations: expect.objectContaining({
              readOnlyHint: true,
              destructiveHint: false,
            }),
          }),
          expect.objectContaining({
            name: "record_decision_consultation_feedback",
            annotations: expect.objectContaining({
              readOnlyHint: false,
              destructiveHint: false,
            }),
          }),
        ],
      },
    });
    const called = await request(3, "tools/call", {
      name: "consult_decision_principles",
      arguments: {
        question: "上线前是否先验证兼容边界？",
        options: [{ label: "先验证" }, { label: "直接上线" }],
      },
    });
    expect(called).toMatchObject({
      result: {
        structuredContent: {
          availability: "available",
          consultation: { status: "matched" },
        },
      },
    });

    await Promise.all([clientTransport.close(), server.close()]);
  });

  it("sends a pre-answer request and returns bounded non-causal guidance", async () => {
    const consult = vi.fn(async () => matchedResponse());

    const result = await consultDecisionPrinciples(
      {
        question: "上线前是否先验证兼容边界？",
        options: [{ label: "直接上线" }, { label: "先小范围验证" }],
        context: "真实运行兼容性仍不明确。",
      },
      {
        sourceClient: "codex",
        runtime: { consult },
        cwd: "/work/decision",
        now: () => new Date("2026-08-08T10:00:00.000Z"),
        requestIdFactory: () => "consultation-1",
      },
    );

    expect(consult).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "consultation-1",
        project: "decision",
        question: "上线前是否先验证兼容边界？",
        requestedAt: "2026-08-08T10:00:00.000Z",
      }),
    );
    expect(result.structuredContent).toEqual({
      availability: "available",
      consultation: matchedResponse(),
    });
    expect(result.content[0]?.text).toContain("不代表某个选项是答案");
    expect(result.content[0]?.text).toContain("没有建立原则采用关系");
  });

  it("fails open when the desktop app is unavailable", async () => {
    const result = await consultDecisionPrinciples(
      { question: "是否继续？" },
      {
        sourceClient: "claude-code",
        runtime: { consult: async () => null },
      },
    );

    expect(result.structuredContent).toEqual({
      availability: "unavailable",
      consultation: null,
    });
    expect(result.content[0]?.text).toContain("不要因此阻断原生决策流程");
  });

  it("records only an explicit user rating through the anonymous receipt", async () => {
    const submitConsultationFeedback = vi.fn(async () => ({
      feedbackVersion: DECISION_CONSULTATION_FEEDBACK_VERSION,
      status: "accepted" as const,
    }));

    const result = await recordDecisionConsultationFeedback(
      { token: "opaque-feedback-token", rating: "misleading" },
      {
        sourceClient: "codex",
        runtime: {
          consult: async () => matchedResponse(),
          submitConsultationFeedback,
        },
      },
    );

    expect(submitConsultationFeedback).toHaveBeenCalledWith({
      feedbackVersion: DECISION_CONSULTATION_FEEDBACK_VERSION,
      token: "opaque-feedback-token",
      rating: "misleading",
    });
    expect(result.content[0]?.text).toContain("匿名计入");
    expect(result.content[0]?.text).toContain("没有保存问题");
  });
});
