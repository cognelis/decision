import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  RuntimeClient,
  defaultRuntimeFile,
  legacyRuntimeFile,
} from "../src/runtime-client.js";
import { captureFixture } from "./fixtures.js";
import {
  DECISION_CONSULTATION_FEEDBACK_VERSION,
  DECISION_CONSULTATION_VERSION,
  type DecisionConsultationRequest,
  type SemanticDecisionPair,
} from "@cognelis/decision-protocol";

const descriptor = {
  protocolVersion: 1,
  port: 43123,
  token: "a".repeat(64),
  pid: 4242,
  startedAt: "2026-07-24T00:00:00.000Z",
} as const;

const makeRuntimeFile = async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-bridge-"));
  const path = join(root, "runtime.json");
  await writeFile(path, JSON.stringify(descriptor), "utf8");
  return path;
};

const candidateFixture = () => ({
  candidateVersion: 1 as const,
  candidateId: "candidate-1",
  createdAt: "2026-07-27T00:00:00.000Z",
  expiresAt: "2026-08-03T00:00:00.000Z",
  event: {
    ...captureFixture(),
    captureMode: "transcript" as const,
    detection: {
      band: "medium" as const,
      score: 65,
      detectorVersion: "rules-v1",
      signals: ["awaits_confirmation"],
    },
  },
});

const semanticPairFixture = (): SemanticDecisionPair => ({
  version: 1,
  pairId: "pair-runtime-1",
  sourceClient: "codex",
  sessionId: "session-runtime-1",
  cwd: "/tmp/project",
  assistantText: "先处理技术债，还是先提交？",
  userText: "先处理本次引入的技术债",
  capturedAt: "2026-07-27T00:00:00.000Z",
  expiresAt: "2026-08-03T00:00:00.000Z",
});

const consultationFixture = (): DecisionConsultationRequest => ({
  consultationVersion: DECISION_CONSULTATION_VERSION,
  requestId: "consultation-runtime-1",
  sourceClient: "codex",
  project: "project",
  question: "是否先验证兼容边界？",
  options: [{ label: "先验证" }, { label: "直接上线" }],
  context: null,
  requestedAt: "2026-08-08T10:00:00.000Z",
});

describe("RuntimeClient", () => {
  it("discovers the platform runtime file", () => {
    expect(defaultRuntimeFile("darwin", "/Users/demo")).toBe(
      "/Users/demo/Library/Application Support/Decision/runtime.json",
    );
    expect(defaultRuntimeFile("linux", "/home/demo", "/tmp/config")).toBe(
      "/tmp/config/decision/runtime.json",
    );
    expect(
      defaultRuntimeFile("win32", "C:\\Users\\demo", undefined, "C:\\AppData"),
    ).toBe("C:\\AppData\\Decision\\runtime.json");
    expect(legacyRuntimeFile("darwin", "/Users/demo")).toBe(
      "/Users/demo/Library/Application Support/Decision Island/runtime.json",
    );
  });

  it("falls back to the legacy runtime file when migration cannot move it", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-runtime-fallback-"));
    const current = join(root, "Decision", "runtime.json");
    const legacy = join(root, "Decision Island", "runtime.json");
    await import("node:fs/promises").then(async ({ mkdir }) => {
      await mkdir(join(root, "Decision Island"), { recursive: true });
    });
    await writeFile(legacy, JSON.stringify(descriptor), "utf8");
    const client = new RuntimeClient({
      runtimeFile: current,
      legacyRuntimeFile: legacy,
      fetcher: async () =>
        new Response(JSON.stringify({ ok: true, protocolVersion: 1 })),
    });

    await expect(client.doctor()).resolves.toMatchObject({
      runtimeFile: legacy,
      appStatus: "healthy",
    });
  });

  it("delivers an authenticated capture without waiting for health", async () => {
    const runtimeFile = await makeRuntimeFile();
    const fetcher = vi.fn(
      async (
        _input: string | URL | globalThis.Request,
        _init?: RequestInit,
      ) =>
        new Response(
          JSON.stringify({ accepted: 1, duplicates: 0 }),
          { status: 202 },
        ),
    );
    const client = new RuntimeClient({ runtimeFile, fetcher });

    await expect(client.deliver(captureFixture())).resolves.toEqual({
      accepted: 1,
      duplicates: 0,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:43123/v1/captures",
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        authorization: `Bearer ${descriptor.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(captureFixture()),
    });
  });

  it("stays passive and returns null when the app runtime is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-missing-"));
    const fetcher = vi.fn();
    const client = new RuntimeClient({
      runtimeFile: join(root, "runtime.json"),
      fetcher,
    });

    await expect(client.deliver(captureFixture())).resolves.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("stays passive when delivery cannot be confirmed", async () => {
    const runtimeFile = await makeRuntimeFile();
    const client = new RuntimeClient({
      runtimeFile,
      fetcher: async () => {
        throw new Error("offline");
      },
    });

    await expect(client.deliver(captureFixture())).resolves.toBeNull();
  });

  it("delivers a candidate to a running app", async () => {
    const runtimeFile = await makeRuntimeFile();
    const fetcher = vi.fn(async () => new Response(null, { status: 202 }));
    const client = new RuntimeClient({
      runtimeFile,
      fetcher,
    });

    await expect(
      client.deliverCandidate(candidateFixture()),
    ).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:43123/v1/candidates",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(candidateFixture()),
      }),
    );
  });

  it.each(["missing-runtime", "failed-fetch", "non-2xx"] as const)(
    "never launches the app for candidate delivery: %s",
    async (scenario) => {
      const root = await mkdtemp(
        join(tmpdir(), "decision-candidate-runtime-"),
      );
      const runtimeFile =
        scenario === "missing-runtime"
          ? join(root, "missing.json")
          : await makeRuntimeFile();
      const fetcher = vi.fn(async () => {
        if (scenario === "failed-fetch") {
          throw new Error("offline");
        }
        return new Response(null, { status: 503 });
      });
      const client = new RuntimeClient({
        runtimeFile,
        fetcher,
      });

      await expect(
        client.deliverCandidate(candidateFixture()),
      ).resolves.toBe(false);
      if (scenario === "missing-runtime") {
        expect(fetcher).not.toHaveBeenCalled();
      }
    },
  );

  it("requests a read-only consultation from a running app", async () => {
    const runtimeFile = await makeRuntimeFile();
    const consultation = consultationFixture();
    const response = {
      consultationVersion: DECISION_CONSULTATION_VERSION,
      requestId: consultation.requestId,
      status: "no_match",
      generatedBy: "deterministic_local_match",
      matches: [],
      feedback: null,
      boundary: {
        advisoryOnly: true,
        noDecisionWritten: true,
        noPrincipleApplied: true,
      },
    };
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify(response), { status: 200 }),
    );
    const client = new RuntimeClient({ runtimeFile, fetcher });

    await expect(client.consult(consultation)).resolves.toEqual(response);
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:43123/v1/consultations",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(consultation),
      }),
    );
  });

  it.each(["missing-runtime", "failed-fetch", "non-2xx"] as const)(
    "never launches the app for consultation: %s",
    async (scenario) => {
      const root = await mkdtemp(
        join(tmpdir(), "decision-consultation-runtime-"),
      );
      const runtimeFile =
        scenario === "missing-runtime"
          ? join(root, "missing.json")
          : await makeRuntimeFile();
      const fetcher = vi.fn(async () => {
        if (scenario === "failed-fetch") throw new Error("offline");
        return new Response(null, { status: 503 });
      });
      const client = new RuntimeClient({ runtimeFile, fetcher });

      await expect(client.consult(consultationFixture())).resolves.toBeNull();
      if (scenario === "missing-runtime") {
        expect(fetcher).not.toHaveBeenCalled();
      }
    },
  );

  it("submits one anonymous consultation rating to a running app", async () => {
    const runtimeFile = await makeRuntimeFile();
    const feedback = {
      feedbackVersion: DECISION_CONSULTATION_FEEDBACK_VERSION,
      token: "opaque-feedback-token",
      rating: "helpful" as const,
    };
    const result = {
      feedbackVersion: DECISION_CONSULTATION_FEEDBACK_VERSION,
      status: "accepted" as const,
    };
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify(result), { status: 200 }),
    );
    const client = new RuntimeClient({ runtimeFile, fetcher });

    await expect(client.submitConsultationFeedback(feedback)).resolves.toEqual(
      result,
    );
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:43123/v1/consultations/feedback",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(feedback),
      }),
    );
  });

  it("delivers a semantic pair to a running app", async () => {
    const runtimeFile = await makeRuntimeFile();
    const pair = semanticPairFixture();
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ accepted: true }), {
          status: 202,
        }),
    );
    const client = new RuntimeClient({
      runtimeFile,
      fetcher,
    });

    await expect(
      client.deliverSemanticPair(pair),
    ).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:43123/v1/semantic-pairs",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(pair),
      }),
    );
  });

  it.each(["missing-runtime", "failed-fetch", "non-2xx"] as const)(
    "never launches for semantic pair delivery: %s",
    async (scenario) => {
      const root = await mkdtemp(
        join(tmpdir(), "decision-semantic-runtime-"),
      );
      const runtimeFile =
        scenario === "missing-runtime"
          ? join(root, "missing.json")
          : await makeRuntimeFile();
      const fetcher = vi.fn(async () => {
        if (scenario === "failed-fetch") {
          throw new Error("offline");
        }
        return new Response(null, { status: 503 });
      });
      const client = new RuntimeClient({
        runtimeFile,
        fetcher,
      });

      await expect(
        client.deliverSemanticPair(semanticPairFixture()),
      ).resolves.toBe(false);
      if (scenario === "missing-runtime") {
        expect(fetcher).not.toHaveBeenCalled();
      }
    },
  );

  it("removes an invalid runtime descriptor and reports it safely", async () => {
    const runtimeFile = await makeRuntimeFile();
    await writeFile(
      runtimeFile,
      JSON.stringify({ ...descriptor, token: "short" }),
      "utf8",
    );
    const client = new RuntimeClient({ runtimeFile });

    await expect(client.doctor()).resolves.toMatchObject({
      appStatus: "invalid_runtime",
    });
    await expect(readFile(runtimeFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports doctor status without exposing the bearer token", async () => {
    const runtimeFile = await makeRuntimeFile();
    const client = new RuntimeClient({
      runtimeFile,
      fetcher: async () =>
        new Response(JSON.stringify({ ok: true, protocolVersion: 1 })),
    });

    const report = await client.doctor();

    expect(report).toEqual({
      runtimeFile,
      appStatus: "healthy",
      protocolVersion: 1,
      port: 43123,
    });
    expect(JSON.stringify(report)).not.toContain(descriptor.token);
  });
});
