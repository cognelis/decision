import { RationaleQueue } from "@cognelis/decision-core";
import {
  DECISION_CONSULTATION_FEEDBACK_VERSION,
  DECISION_CONSULTATION_VERSION,
} from "@cognelis/decision-protocol";
import { describe, expect, it, vi } from "vitest";

import { LocalCaptureServer } from "../src/main/local-server.js";
import {
  serverCandidateFixture,
  serverCaptureFixture,
  semanticPairFixture,
} from "./fixtures.js";

const token = "test-token-".padEnd(64, "x");

const startServer = async (smokeMode = false) => {
  let sequence = 0;
  const queue = new RationaleQueue(() => `candidate-${++sequence}`);
  const ingestCandidate = vi.fn(async () => undefined);
  const ingestSemanticPair = vi.fn(async () => undefined);
  const consult = vi.fn(async (request) => ({
    consultationVersion: DECISION_CONSULTATION_VERSION,
    requestId: request.requestId,
    status: "no_match" as const,
    generatedBy: "deterministic_local_match" as const,
    matches: [],
    feedback: null,
    boundary: {
      advisoryOnly: true as const,
      noDecisionWritten: true as const,
      noPrincipleApplied: true as const,
    },
  }));
  const submitConsultationFeedback = vi.fn(async () => ({
    feedbackVersion: DECISION_CONSULTATION_FEEDBACK_VERSION,
    status: "accepted" as const,
  }));
  const server = new LocalCaptureServer({
    queue,
    token,
    smokeMode,
    ingestCandidate,
    ingestSemanticPair,
    consult,
    submitConsultationFeedback,
  });
  const address = await server.start();
  const baseUrl = `http://${address.host}:${address.port}`;
  return {
    baseUrl,
    ingestCandidate,
    ingestSemanticPair,
    consult,
    submitConsultationFeedback,
    queue,
    server,
  };
};

const authorizedFetch = (
  url: string,
  init: RequestInit = {},
): Promise<Response> =>
  fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });

describe("LocalCaptureServer", () => {
  it("binds loopback and exposes a non-secret health response", async () => {
    const { baseUrl, server } = await startServer();

    const response = await fetch(`${baseUrl}/health`);

    expect(server.address()).toMatchObject({ host: "127.0.0.1" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      protocolVersion: 1,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    await server.stop();
  });

  it("returns 202 immediately after queueing a capture", async () => {
    const { baseUrl, queue, server } = await startServer();

    const response = await authorizedFetch(`${baseUrl}/v1/captures`, {
      method: "POST",
      body: JSON.stringify(serverCaptureFixture()),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      accepted: 1,
      duplicates: 0,
    });
    expect(queue.snapshot()).toMatchObject({
      current: { status: "awaiting_rationale" },
    });
    await server.stop();
  });

  it("deduplicates replay without waiting for rationale", async () => {
    const { baseUrl, server } = await startServer();
    const body = JSON.stringify(serverCaptureFixture());

    const first = await authorizedFetch(`${baseUrl}/v1/captures`, {
      method: "POST",
      body,
    });
    const replay = await authorizedFetch(`${baseUrl}/v1/captures`, {
      method: "POST",
      body,
    });

    expect(await first.json()).toEqual({ accepted: 1, duplicates: 0 });
    expect(await replay.json()).toEqual({ accepted: 0, duplicates: 1 });
    await server.stop();
  });

  it("accepts one authenticated medium-confidence candidate", async () => {
    const { baseUrl, ingestCandidate, server } =
      await startServer();
    const candidate = serverCandidateFixture();

    const response = await authorizedFetch(
      `${baseUrl}/v1/candidates`,
      {
        method: "POST",
        body: JSON.stringify(candidate),
      },
    );

    expect(response.status).toBe(202);
    expect(ingestCandidate).toHaveBeenCalledWith(candidate);
    await server.stop();
  });

  it("rejects unauthorized and invalid candidates", async () => {
    const { baseUrl, ingestCandidate, server } =
      await startServer();

    const unauthorized = await fetch(
      `${baseUrl}/v1/candidates`,
      {
        method: "POST",
        body: JSON.stringify(serverCandidateFixture()),
        headers: { "content-type": "application/json" },
      },
    );
    const invalid = await authorizedFetch(
      `${baseUrl}/v1/candidates`,
      {
        method: "POST",
        body: JSON.stringify({
          ...serverCandidateFixture(),
          event: serverCaptureFixture(),
        }),
      },
    );

    expect(unauthorized.status).toBe(401);
    expect(invalid.status).toBe(400);
    expect(ingestCandidate).not.toHaveBeenCalled();
    await server.stop();
  });

  it("accepts one authenticated strict semantic pair", async () => {
    const { baseUrl, ingestSemanticPair, server } =
      await startServer();
    const pair = semanticPairFixture();

    const response = await authorizedFetch(
      `${baseUrl}/v1/semantic-pairs`,
      {
        method: "POST",
        body: JSON.stringify(pair),
      },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(ingestSemanticPair).toHaveBeenCalledWith(pair);
    await server.stop();
  });

  it("serves one authenticated read-only pre-decision consultation", async () => {
    const { baseUrl, consult, queue, server } = await startServer();
    const request = {
      consultationVersion: DECISION_CONSULTATION_VERSION,
      requestId: "consultation-1",
      sourceClient: "codex",
      project: "decision",
      question: "是否先验证兼容边界？",
      options: [{ label: "先小范围验证" }, { label: "直接上线" }],
      context: "真实运行效果仍不明确。",
      requestedAt: "2026-08-08T10:00:00.000Z",
    };

    const response = await authorizedFetch(
      `${baseUrl}/v1/consultations`,
      { method: "POST", body: JSON.stringify(request) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      requestId: "consultation-1",
      status: "no_match",
      boundary: {
        advisoryOnly: true,
        noDecisionWritten: true,
        noPrincipleApplied: true,
      },
    });
    expect(consult).toHaveBeenCalledWith(request);
    expect(queue.snapshot().current).toBeNull();
    await server.stop();
  });

  it("rejects invalid consultations without invoking the matcher", async () => {
    const { baseUrl, consult, server } = await startServer();

    const response = await authorizedFetch(
      `${baseUrl}/v1/consultations`,
      {
        method: "POST",
        body: JSON.stringify({ question: "missing envelope" }),
      },
    );

    expect(response.status).toBe(400);
    expect(consult).not.toHaveBeenCalled();
    await server.stop();
  });

  it("accepts one authenticated anonymous consultation rating", async () => {
    const { baseUrl, submitConsultationFeedback, server } =
      await startServer();
    const feedback = {
      feedbackVersion: DECISION_CONSULTATION_FEEDBACK_VERSION,
      token: "opaque-feedback-token",
      rating: "not_helpful",
    };

    const response = await authorizedFetch(
      `${baseUrl}/v1/consultations/feedback`,
      { method: "POST", body: JSON.stringify(feedback) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      feedbackVersion: DECISION_CONSULTATION_FEEDBACK_VERSION,
      status: "accepted",
    });
    expect(submitConsultationFeedback).toHaveBeenCalledWith(feedback);
    await server.stop();
  });

  it("rejects unauthorized, unknown-field, and oversized semantic pairs", async () => {
    const { baseUrl, ingestSemanticPair, server } =
      await startServer();
    const pair = semanticPairFixture();

    const unauthorized = await fetch(
      `${baseUrl}/v1/semantic-pairs`,
      {
        method: "POST",
        body: JSON.stringify(pair),
        headers: { "content-type": "application/json" },
      },
    );
    const invalid = await authorizedFetch(
      `${baseUrl}/v1/semantic-pairs`,
      {
        method: "POST",
        body: JSON.stringify({
          ...pair,
          transcriptPath: "/tmp/private.jsonl",
        }),
      },
    );
    const oversized = await authorizedFetch(
      `${baseUrl}/v1/semantic-pairs`,
      {
        method: "POST",
        body: JSON.stringify({
          ...pair,
          assistantText: "x".repeat(300 * 1_024),
        }),
      },
    );

    expect(unauthorized.status).toBe(401);
    expect(invalid.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(ingestSemanticPair).not.toHaveBeenCalled();
    await server.stop();
  });

  it("rejects missing authorization, invalid input, and oversized bodies", async () => {
    const { baseUrl, queue, server } = await startServer();

    const unauthorized = await fetch(`${baseUrl}/v1/captures`, {
      method: "POST",
      body: JSON.stringify(serverCaptureFixture()),
      headers: { "content-type": "application/json" },
    });
    const invalid = await authorizedFetch(`${baseUrl}/v1/captures`, {
      method: "POST",
      body: JSON.stringify({ question: "missing envelope" }),
    });
    const oversized = await authorizedFetch(`${baseUrl}/v1/captures`, {
      method: "POST",
      body: JSON.stringify({ payload: "x".repeat(300 * 1024) }),
    });

    expect(unauthorized.status).toBe(401);
    expect(invalid.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(queue.snapshot().current).toBeNull();
    await server.stop();
  });

  it("exposes rationale completion only in explicit smoke mode", async () => {
    const normal = await startServer();
    const unavailable = await authorizedFetch(
      `${normal.baseUrl}/v1/smoke/complete`,
      { method: "POST", body: JSON.stringify({ status: "skipped" }) },
    );
    expect(unavailable.status).toBe(404);
    await normal.server.stop();

    const smoke = await startServer(true);
    await authorizedFetch(`${smoke.baseUrl}/v1/captures`, {
      method: "POST",
      body: JSON.stringify(serverCaptureFixture()),
    });
    const completion = await authorizedFetch(
      `${smoke.baseUrl}/v1/smoke/complete`,
      {
        method: "POST",
        body: JSON.stringify({
          status: "captured",
          rationale: "打包冒烟测试",
        }),
      },
    );

    expect(completion.status).toBe(204);
    expect(smoke.queue.snapshot().current).toBeNull();
    await smoke.server.stop();
  });
});
