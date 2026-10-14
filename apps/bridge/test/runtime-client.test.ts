import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  RuntimeClient,
  defaultRuntimeFile,
} from "../src/runtime-client.js";
import { runtimeIdentityProof } from "@cognelis/decision-storage";
import { captureFixture } from "./fixtures.js";
import {
  DECISION_CONSULTATION_FEEDBACK_VERSION,
  CONSULTATION_SHAPE,
  CONSULTATION_SHAPE_HEADER,
  DECISION_CONSULTATION_VERSION,
  type DecisionConsultationRequest,
  type ProactiveRecordRequest,
  type SemanticDecisionPair,
} from "@cognelis/decision-protocol";

const descriptor = {
  protocolVersion: 1,
  port: 43123,
  token: "a".repeat(64),
  // A live process: a runtime file whose writer has gone is read as the App not running.
  pid: process.pid,
  startedAt: "2026-07-24T00:00:00.000Z",
} as const;

/** The App's answer to the bridge's identity challenge, which a fake fetcher would not give: the rest is passed on. */
const withIdentity = (fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) =>
    String(input).endsWith("/v1/identity")
      ? Response.json({ proof: runtimeIdentityProof(descriptor.token, new Headers(init?.headers).get("x-decision-challenge") ?? "") })
      : fetcher(input, init)) as typeof fetch;

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

const proactiveRecordFixture = (): ProactiveRecordRequest => ({
  recordVersion: 1,
  requestId: "preference-runtime-1",
  sourceClient: "codex",
  sourceKind: "agent_capture",
  sourceForm: "machine_summary",
  sensitivity: "private",
  project: "decision",
  kind: "preference",
  title: "常规实现决策默认由系统自主完成",
  content: "普通可逆的方向与实现由系统自行判断并交付结果。",
  appliesWhen: "既定目标和仓库范围内的普通产品与工程取舍。",
  exceptions: "权限、付费、不可逆操作、公开范围或核心验收冲突。",
  strength: "default",
  evidenceMaturity: "self_declared",
  tags: ["协作偏好"],
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

  });

  it("reports a missing configured runtime as unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-runtime-missing-"));
    const client = new RuntimeClient({ runtimeFile: join(root, "runtime.json") });
    expect(await client.doctor()).toMatchObject({ appStatus: "unavailable", message: expect.stringContaining("请启动 Decision") });
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
    const client = new RuntimeClient({ runtimeFile, fetcher: withIdentity(fetcher) });

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
      fetcher: withIdentity(fetcher),
    });

    await expect(client.deliver(captureFixture())).resolves.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends nothing to a program on the App's old port that cannot prove it holds the token", async () => {
    const runtimeFile = await makeRuntimeFile();
    const seen: Array<{ url: string; authorization: string | null }> = [];
    // A crashed App's port, taken by another program: it answers, but cannot compute the proof.
    const squatter = async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
      return String(input).endsWith("/v1/identity") ? Response.json({ proof: "forged" }) : Response.json({ ok: true });
    };

    await expect(new RuntimeClient({ runtimeFile, fetcher: squatter }).deliver(captureFixture())).resolves.toBeNull();
    expect(seen).toEqual([{ url: `http://127.0.0.1:${descriptor.port}/v1/identity`, authorization: null }]);

    // A pid another user's process holds now (launchd's 1, after a restart): not even asked.
    await writeFile(runtimeFile, JSON.stringify({ ...descriptor, pid: 1 }), "utf8");
    seen.length = 0;
    await expect(new RuntimeClient({ runtimeFile, fetcher: squatter }).deliver(captureFixture())).resolves.toBeNull();
    expect(seen).toEqual([]);
  });

  it("asks for the proof at every request, so a session's long-lived client stops once the port is someone else's", async () => {
    const runtimeFile = await makeRuntimeFile();
    let genuine = true;
    const seen: Array<{ path: string; authorization: string | null }> = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const headers = new Headers(init?.headers);
      seen.push({ path, authorization: headers.get("authorization") });
      if (path !== "/v1/identity") return Response.json({ whatever: true });
      return Response.json({ proof: genuine ? runtimeIdentityProof(descriptor.token, headers.get("x-decision-challenge") ?? "") : "x".repeat(43) });
    }) as typeof fetch;
    // One client for the session, as the MCP server keeps it.
    const session = new RuntimeClient({ runtimeFile, fetcher });
    await session.record(proactiveRecordFixture());
    expect(seen.map((request) => request.path)).toEqual(["/v1/identity", "/v1/journal-entries"]);

    // The App crashes, and another program answers on its port: confirmed once and remembered, it was sent the token.
    genuine = false;
    seen.length = 0;
    const reports: unknown[] = [];
    await expect(session.record(proactiveRecordFixture(), (failure) => reports.push(failure))).resolves.toBeNull();
    expect(seen).toEqual([{ path: "/v1/identity", authorization: null }]);
    expect(reports).toEqual([{ reason: "not_running" }]);
  });

  it("tells an App too old for its challenge from no App, and sends it nothing", async () => {
    const runtimeFile = await makeRuntimeFile();
    const seen: string[] = [];
    // Decision from before the challenge: the route is unknown, and refused as any without the token.
    const older = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      seen.push(`${path} ${new Headers(init?.headers).get("authorization") ?? "-"}`);
      return path === "/health" ? Response.json({ ok: true, protocolVersion: 1 }) : Response.json({ error: "unauthorized" }, { status: 401 });
    }) as typeof fetch;
    const client = new RuntimeClient({ runtimeFile, fetcher: older });
    const reports: unknown[] = [];

    // Read as not running: the reader was told to start an App that was running, and only needed a restart.
    await expect(client.record(proactiveRecordFixture(), (failure) => reports.push(failure))).resolves.toBeNull();
    expect(reports).toEqual([{ reason: "outdated" }]);
    await expect(client.doctor()).resolves.toMatchObject({ appStatus: "outdated", message: expect.stringContaining("重启或更新 Decision") });
    expect(seen).toEqual(["/v1/identity -", "/health -", "/v1/identity -", "/health -"]);
  });

  it("gives an App busy past a hook's second the time of the operation that asks", async () => {
    const runtimeFile = await makeRuntimeFile();
    const seen: string[] = [];
    const answer = withIdentity(async (input) => {
      seen.push(new URL(String(input)).pathname);
      return Response.json({ whatever: true });
    });
    // Its main thread held for a moment: the proof comes late.
    const late = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/v1/identity")) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 150);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(init.signal?.reason);
          });
        });
      }
      return answer(input, init);
    }) as typeof fetch;
    const client = new RuntimeClient({ runtimeFile, fetcher: late, healthTimeoutMs: 50, contextTimeoutMs: 1_000 });

    // Asked within a hook's time, the agent was told Decision was not running.
    await client.record(proactiveRecordFixture());
    expect(seen).toEqual(["/v1/journal-entries"]);
    // A hook keeps to its own time, the capture left in the spool for the App to take in.
    await expect(client.deliver(captureFixture())).resolves.toBeNull();
    expect(seen).toEqual(["/v1/journal-entries"]);
    // Past the operation's own time too, it is said to be busy, not absent.
    const reports: unknown[] = [];
    await new RuntimeClient({ runtimeFile, fetcher: late, contextTimeoutMs: 50 }).record(proactiveRecordFixture(), (failure) => reports.push(failure));
    expect(reports).toEqual([{ reason: "busy" }]);
    // doctor read it as no App at all, and said nothing more.
    await expect(client.doctor()).resolves.toMatchObject({ appStatus: "busy", message: expect.stringContaining("正在运行，但没有及时回应") });
  });

  it("proves the App and asks it within one operation's time, not each within the whole of it", async () => {
    const runtimeFile = await makeRuntimeFile();
    const slow = (ms: number, init?: RequestInit) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(init.signal?.reason);
        });
      });
    // Stalled for a moment on both: the proof comes late, and so would the answer.
    let cutShort = false;
    const answer = withIdentity(async (_input, init) => {
      await slow(400, init).catch((reason: unknown) => {
        cutShort = true;
        throw reason;
      });
      return Response.json({ whatever: true });
    });
    const stalled = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/v1/identity")) await slow(400, init);
      return answer(input, init);
    }) as typeof fetch;
    const reports: unknown[] = [];

    // Each given the whole of it, the call took twice its time, past what an agent's tool call allowed.
    await expect(new RuntimeClient({ runtimeFile, fetcher: stalled, contextTimeoutMs: 600 })
      .record(proactiveRecordFixture(), (failure) => reports.push(failure))).resolves.toBeNull();
    expect(cutShort).toBe(true);
    expect(reports).toEqual([{ reason: "no_answer" }]);
  });

  it("leaves the App the rest of its time to answer, though the clock was stepped forward as it proved itself", async () => {
    const runtimeFile = await makeRuntimeFile();
    const realNow = Date.now.bind(Date);
    let step = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + step);
    let cutShort = false;
    const answering = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/v1/identity")) {
        step = 10_000; // a time sync while the App proved itself
        return Response.json({ proof: runtimeIdentityProof(descriptor.token, new Headers(init?.headers).get("x-decision-challenge") ?? "") });
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      cutShort = init?.signal?.aborted === true;
      return Response.json({ whatever: true });
    }) as typeof fetch;
    try {
      // Timed by the wall clock, the answer had a millisecond: an App answering at once was said not to answer.
      await new RuntimeClient({ runtimeFile, fetcher: answering }).record(proactiveRecordFixture(), () => undefined);
      expect(cutShort).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it("says the App refused, with its reason, and that nothing came back, apart from not running", async () => {
    const runtimeFile = await makeRuntimeFile();
    const reports: unknown[] = [];
    const refusing = new RuntimeClient({
      runtimeFile,
      fetcher: withIdentity(async () => Response.json({ error: "internal_error", message: "找不到仓库目录 /vault。" }, { status: 500 })),
    });
    await expect(refusing.record(proactiveRecordFixture(), (failure) => reports.push(failure))).resolves.toBeNull();

    const dropped = new RuntimeClient({
      runtimeFile,
      fetcher: withIdentity(async () => {
        throw new TypeError("fetch failed");
      }),
    });
    await expect(dropped.record(proactiveRecordFixture(), (failure) => reports.push(failure))).resolves.toBeNull();
    expect(reports).toEqual([{ reason: "refused", message: "找不到仓库目录 /vault。" }, { reason: "no_answer" }]);
  });

  it("stays passive when delivery cannot be confirmed, telling one that reached an App from one that did not", async () => {
    const runtimeFile = await makeRuntimeFile();
    const refused = new RuntimeClient({
      runtimeFile,
      fetcher: withIdentity(async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1");
      }),
    });
    // Refused before it was sent (the App quit since its challenge): nothing reached it, and with the spool full, lost.
    await expect(refused.deliver(captureFixture())).resolves.toBeNull();

    const late = new RuntimeClient({
      runtimeFile,
      deliveryTimeoutMs: 20,
      fetcher: withIdentity(async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })),
    });
    // Cut off by a hook's time: an App too busy to answer may well have taken it.
    await expect(late.deliver(captureFixture())).resolves.toBe(false);

    // Refused before it was taken in (an older App's schema, a body too large): not taken, and said lost with no spool.
    const answering = (status: number) => new RuntimeClient({
      runtimeFile,
      fetcher: withIdentity(async () => Response.json({ error: status === 400 ? "invalid_request" : "internal_error" }, { status })),
    });
    await expect(answering(400).deliver(captureFixture())).resolves.toBeNull();
    // Failed after the App had it in hand: it may hold it.
    await expect(answering(500).deliver(captureFixture())).resolves.toBe(false);
  });

  it("delivers a candidate to a running app", async () => {
    const runtimeFile = await makeRuntimeFile();
    const fetcher = vi.fn(async () => new Response(null, { status: 202 }));
    const client = new RuntimeClient({
      runtimeFile,
      fetcher: withIdentity(fetcher),
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
        fetcher: withIdentity(fetcher),
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
    const client = new RuntimeClient({ runtimeFile, fetcher: withIdentity(fetcher) });

    // An app on the previous shape sends neither field; the schema fills them
    // in rather than rejecting the payload, so a bridge can outrun the app it
    // talks to without losing the consultation.
    await expect(client.consult(consultation)).resolves.toEqual({
      ...response,
      signals: [],
      boundary: { ...response.boundary, noPreferencePromoted: true },
    });
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:43123/v1/consultations",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(consultation),
        // Without it, the App answers as 1.1.0 did, for 1.1.0's bridge.
        headers: expect.objectContaining({ [CONSULTATION_SHAPE_HEADER]: CONSULTATION_SHAPE }),
      }),
    );

    // An App newer than this bridge, saying something it does not know: refused, the agent heard "unavailable".
    fetcher.mockImplementation(async () => new Response(JSON.stringify({ ...response, addedLater: true, boundary: { ...response.boundary, alsoLater: true } }), { status: 200 }));
    await expect(client.consult(consultation)).resolves.toMatchObject({ status: "no_match" });
  });

  it("records an explicit proactive entry through the running app", async () => {
    const runtimeFile = await makeRuntimeFile();
    const result = {
      recordVersion: 1 as const,
      status: "created" as const,
      recordKind: "preference" as const,
      recordId: "preference-1",
      knowledgeStatus: "active" as const,
      sensitivity: "private" as const,
      storedTranscript: false as const,
    };
    const fetcher = vi.fn(
      async (
        _input: string | URL | globalThis.Request,
        _init?: RequestInit,
      ) => new Response(JSON.stringify(result), { status: 200 }),
    );
    const client = new RuntimeClient({ runtimeFile, fetcher: withIdentity(fetcher) });

    await expect(client.record(proactiveRecordFixture())).resolves.toEqual(result);
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:43123/v1/journal-entries",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual(
      proactiveRecordFixture(),
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
      const client = new RuntimeClient({ runtimeFile, fetcher: withIdentity(fetcher) });

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
    const client = new RuntimeClient({ runtimeFile, fetcher: withIdentity(fetcher) });

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
      fetcher: withIdentity(fetcher),
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
        fetcher: withIdentity(fetcher),
      });

      await expect(
        client.deliverSemanticPair(semanticPairFixture()),
      ).resolves.toBe(scenario === "missing-runtime" ? null : false);
      if (scenario === "missing-runtime") {
        expect(fetcher).not.toHaveBeenCalled();
      }
    },
  );

  it("reports an invalid runtime descriptor safely and leaves it to the App", async () => {
    const runtimeFile = await makeRuntimeFile();
    const invalid = JSON.stringify({ ...descriptor, token: "short" });
    await writeFile(runtimeFile, invalid, "utf8");
    const client = new RuntimeClient({ runtimeFile });

    await expect(client.doctor()).resolves.toMatchObject({
      appStatus: "invalid_runtime",
      message: expect.stringContaining("请重启 Decision"),
    });
    await expect(readFile(runtimeFile, "utf8")).resolves.toBe(invalid);
  });

  it("reads a runtime file left by an App that has exited as the App not running", async () => {
    const runtimeFile = await makeRuntimeFile();
    const exited = spawnSync(process.execPath, ["-e", ""]).pid;
    await writeFile(runtimeFile, JSON.stringify({ ...descriptor, pid: exited }), "utf8");
    const fetcher = vi.fn<typeof fetch>();
    const client = new RuntimeClient({ runtimeFile, fetcher: withIdentity(fetcher) });

    await expect(client.deliver(captureFixture())).resolves.toBeNull();
    await expect(client.doctor()).resolves.toMatchObject({ appStatus: "unavailable" });
    // Neither the token nor the capture goes to whatever listens on that port now.
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reads a runtime file that says more than this bridge knows", async () => {
    const runtimeFile = await makeRuntimeFile();
    await writeFile(runtimeFile, JSON.stringify({ ...descriptor, capabilities: ["later"] }), "utf8");
    const client = new RuntimeClient({
      runtimeFile,
      fetcher: withIdentity(async () => new Response(JSON.stringify({ ok: true, protocolVersion: 1 }))),
    });

    await expect(client.doctor()).resolves.toMatchObject({ appStatus: "healthy", port: 43123 });
  });

  it("reports doctor status without exposing the bearer token", async () => {
    const runtimeFile = await makeRuntimeFile();
    const client = new RuntimeClient({
      runtimeFile,
      fetcher: withIdentity(async () =>
        new Response(JSON.stringify({ ok: true, protocolVersion: 1 }))),
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
