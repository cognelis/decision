import { RationaleQueue } from "@cognelis/decision-core";
import {
  CONSULTATION_SHAPE,
  CONSULTATION_SHAPE_HEADER,
  DECISION_CONSULTATION_FEEDBACK_VERSION,
  DECISION_CONSULTATION_VERSION,
} from "@cognelis/decision-protocol";
import { runtimeIdentityProof } from "@cognelis/decision-storage";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { LocalCaptureServer } from "../src/main/local-server.js";
import {
  serverCandidateFixture,
  serverCaptureFixture,
  semanticPairFixture,
} from "./fixtures.js";

const token = "test-token-".padEnd(64, "x");
const preferenceRequest = () => ({
  recordVersion: 1 as const,
  requestId: "preference-request-1",
  sourceClient: "codex" as const,
  sourceKind: "agent_capture" as const,
  sourceForm: "machine_summary" as const,
  sensitivity: "private" as const,
  project: "decision",
  kind: "preference" as const,
  title: "常规实现决策默认由系统自主完成",
  content: "普通可逆的方向与实现由系统自行判断并交付结果。",
  appliesWhen: "既定目标和仓库范围内的普通产品与工程取舍。",
  exceptions: "权限、付费、不可逆操作、公开范围或核心验收冲突。",
  strength: "default" as const,
  evidenceMaturity: "self_declared" as const,
  tags: ["协作偏好"],
});

const startServer = async (smokeMode = false, vaultPath = "/Volumes/Notes Disk/My Vault") => {
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
    signals: [],
    feedback: null,
    boundary: {
      advisoryOnly: true as const,
      noDecisionWritten: true as const,
      noPrincipleApplied: true as const,
      noPreferencePromoted: true as const,
    },
  }));
  const submitConsultationFeedback = vi.fn(async () => ({
    feedbackVersion: DECISION_CONSULTATION_FEEDBACK_VERSION,
    status: "accepted" as const,
  }));
  const smokeShutdown = vi.fn();
  const recordJournalEntry = vi.fn(async (request) => ({
    recordVersion: 1 as const,
    status: "created" as const,
    recordKind: request.kind,
    recordId: "record-1",
    knowledgeStatus: "active" as const,
    sensitivity: request.sensitivity,
    storedTranscript: false as const,
  }));
  const server = new LocalCaptureServer({
    queue,
    token,
    vaultPath,
    smokeMode,
    smokeShutdown,
    ingestCandidate,
    ingestSemanticPair,
    consult,
    submitConsultationFeedback,
    recordJournalEntry,
  });
  const address = await server.start();
  const baseUrl = `http://${address.host}:${address.port}`;
  return {
    baseUrl,
    ingestCandidate,
    ingestSemanticPair,
    consult,
    submitConsultationFeedback,
    recordJournalEntry,
    smokeShutdown,
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

  it("proves to a bridge that it holds the token without sending it, and refuses a malformed challenge", async () => {
    const { baseUrl, server } = await startServer();
    const nonce = "n".repeat(43);

    const response = await fetch(`${baseUrl}/v1/identity`, { headers: { "x-decision-challenge": nonce } });
    const body = await response.json();
    expect(body).toEqual({ proof: runtimeIdentityProof(token, nonce) });
    expect(JSON.stringify(body)).not.toContain(token);
    expect((await fetch(`${baseUrl}/v1/identity`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/v1/identity`, { headers: { "x-decision-challenge": "short" } })).status).toBe(400);
    await server.stop();
  });

  it("holds no more than a few dozen connections, however many a local program opens", async () => {
    const { server } = await startServer();
    const { port } = server.address();
    // Idle and without a token: uncapped, a few hundred took every file descriptor the App had.
    const closed = new Set<Socket>();
    const sockets = await Promise.all(Array.from({ length: 80 }, () => new Promise<Socket>((resolve) => {
      const socket = connect(port, "127.0.0.1", () => resolve(socket));
      socket.on("error", () => undefined);
      socket.on("close", () => closed.add(socket));
    })));
    await vi.waitFor(() => expect(closed.size).toBeGreaterThanOrEqual(80 - 64));
    for (const socket of sockets) socket.destroy();
    await server.stop();
  });

  it("closes a connection that sends nothing once it has stayed silent", async () => {
    const server = new LocalCaptureServer({ queue: new RationaleQueue(() => "candidate"), token, idleTimeoutMs: 300 });
    const { port } = await server.start();
    // Not yet a request, so no request timeout reached it: held open, one per program that connected.
    const socket = connect(port, "127.0.0.1");
    socket.on("error", () => undefined);
    await new Promise((resolve) => socket.on("close", resolve));
    await server.stop();
  });

  it("still answers the bridge while 64 sockets that never show the token are open", async () => {
    const { baseUrl, server } = await startServer();
    const { port } = server.address();
    // Any local account sees the port: sharing every slot with them, the bridge's own calls were reset for as long as
    // they stayed.
    const squatters = await Promise.all(Array.from({ length: 64 }, () => new Promise<Socket>((resolve) => {
      const socket = connect(port, "127.0.0.1", () => resolve(socket));
      socket.on("error", () => undefined);
    })));
    await new Promise((resolve) => setTimeout(resolve, 100));

    const response = await authorizedFetch(`${baseUrl}/v1/captures`, { method: "POST", body: JSON.stringify(serverCaptureFixture()) });
    expect(response.status).toBe(202);
    for (const socket of squatters) socket.destroy();
    await server.stop();
  });

  it("lets go of a connection that has not shown the token within a couple of seconds, however busy it keeps", async () => {
    const { server } = await startServer();
    const { port } = server.address();
    const socket = connect(port, "127.0.0.1");
    socket.on("error", () => undefined);
    socket.resume();
    const closed = new Promise<"closed">((resolve) => socket.on("close", () => resolve("closed")));
    // Asking for /health every half second, it was never idle, and kept its slot for as long as it went on.
    const asking = setInterval(() => socket.write("GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"), 500);
    try {
      const after = await Promise.race([closed, new Promise<"open">((resolve) => setTimeout(() => resolve("open"), 3_500))]);
      expect(after).toBe("closed");
    } finally {
      clearInterval(asking);
      socket.destroy();
      await server.stop();
    }
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

  it("records one authenticated strict proactive entry", async () => {
    const { baseUrl, recordJournalEntry, server } = await startServer();
    const request = preferenceRequest();

    const response = await authorizedFetch(`${baseUrl}/v1/journal-entries`, {
      method: "POST",
      body: JSON.stringify(request),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "created",
      recordKind: "preference",
      storedTranscript: false,
    });
    expect(recordJournalEntry).toHaveBeenCalledWith(request);
    await server.stop();
  });

  it("logs which route failed and how, but nothing that was sent", async () => {
    const { baseUrl, recordJournalEntry, server } = await startServer();
    const note = "/Volumes/Notes Disk/My Vault/Decision Journal/preferences/x.md.4242.7f3c.tmp";
    recordJournalEntry.mockRejectedValueOnce(
      Object.assign(new Error(`EACCES: permission denied, open '${note}'`), { code: "EACCES", path: note }),
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await authorizedFetch(`${baseUrl}/v1/journal-entries?debug=1`, {
      method: "POST",
      body: JSON.stringify(preferenceRequest()),
    });

    expect(response.status).toBe(500);
    // Its own reason, for the bridge to tell the agent (refused, not "maybe not running"); nothing that was sent.
    // In words, naming the folder (Node's own line was English, with the temporary file's name in it).
    const body = await response.json();
    expect(body).toEqual({ error: "internal_error", message: "没有访问 仓库目录/Decision Journal/preferences 的权限，请检查它的权限设置" });
    expect(JSON.stringify(body)).not.toContain("常规实现决策");
    expect(errors).toHaveBeenCalledWith("[decision] POST /v1/journal-entries failed: EACCES");
    expect(JSON.stringify(errors.mock.calls)).not.toContain("常规实现决策");

    // A vault under the reader's home: its path, the account's name in it, went on to the agent and its provider.
    recordJournalEntry.mockRejectedValueOnce(new Error(`找不到仓库目录 ${join(homedir(), "Notes")}。`));
    const refused = await authorizedFetch(`${baseUrl}/v1/journal-entries`, {
      method: "POST",
      body: JSON.stringify(preferenceRequest()),
    });
    expect(await refused.json()).toEqual({ error: "internal_error", message: `找不到仓库目录 ${join("~", "Notes")}。` });
    // Not a folder whose name only begins as the home folder's does.
    recordJournalEntry.mockRejectedValueOnce(new Error(`找不到仓库目录 ${homedir()}-shared/Notes。`));
    const beside = await authorizedFetch(`${baseUrl}/v1/journal-entries`, {
      method: "POST",
      body: JSON.stringify(preferenceRequest()),
    });
    expect(await beside.json()).toEqual({ error: "internal_error", message: `找不到仓库目录 ${homedir()}-shared/Notes。` });
    // A Windows path, separated by backslashes.
    recordJournalEntry.mockRejectedValueOnce(new Error(`ENOENT: no such file or directory, open '${homedir()}\\Notes\\x.md'`));
    const windows = await authorizedFetch(`${baseUrl}/v1/journal-entries`, {
      method: "POST",
      body: JSON.stringify(preferenceRequest()),
    });
    expect(await windows.json()).toEqual({ error: "internal_error", message: "ENOENT: no such file or directory, open '~\\Notes\\x.md'" });

    // A vault on a disk outside the home folder: its whole location went on, the disk's name with it.
    const relayed = async (message: string) => {
      recordJournalEntry.mockRejectedValueOnce(new Error(message));
      return (await (await authorizedFetch(`${baseUrl}/v1/journal-entries`, { method: "POST", body: JSON.stringify(preferenceRequest()) })).json()).message;
    };
    expect(await relayed("找不到仓库目录 /Volumes/Notes Disk/My Vault：它可能被移动、改名，或所在的磁盘没有连接。"))
      .toBe("找不到仓库目录：它可能被移动、改名，或所在的磁盘没有连接。");
    expect(await relayed("EACCES: permission denied, open '/Volumes/Notes Disk/My Vault/Decision Journal/x.md'"))
      .toBe("EACCES: permission denied, open '仓库目录/Decision Journal/x.md'");
    // Not a folder beside it whose name only begins the same way.
    expect(await relayed("ENOENT: no such file or directory, open '/Volumes/Notes Disk/My Vault 2/x.md'"))
      .toBe("ENOENT: no such file or directory, open '/Volumes/Notes Disk/My Vault 2/x.md'");
    // The vault itself refused (a share mounted read-only, Decision Journal not yet made): named on its own before a
    // word, it went on whole where the ENOSPC line, naming it before a comma, was already said as 仓库目录.
    expect(await relayed("没有访问 /Volumes/Notes Disk/My Vault 的权限，请检查它的权限设置")).toBe("没有访问 仓库目录 的权限，请检查它的权限设置");
    expect(await relayed("/Volumes/Notes Disk/My Vault 所在的磁盘是只读的")).toBe("仓库目录 所在的磁盘是只读的");
    errors.mockRestore();
    await server.stop();
  });

  it("names a vault chosen at a disk's root as 仓库目录 too", async () => {
    // A disk's root keeps its separator (D:\): matched with it, no path under the vault was ever replaced.
    const { baseUrl, recordJournalEntry, server } = await startServer(false, "D:\\");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const relayed = async (message: string) => {
      recordJournalEntry.mockRejectedValueOnce(new Error(message));
      return (await (await authorizedFetch(`${baseUrl}/v1/journal-entries`, { method: "POST", body: JSON.stringify(preferenceRequest()) })).json()).message;
    };

    expect(await relayed("ENOENT: no such file or directory, open 'D:\\Decision Journal\\x.md'"))
      .toBe("ENOENT: no such file or directory, open '仓库目录\\Decision Journal\\x.md'");
    expect(await relayed("找不到仓库目录 D:\\：它可能被移动、改名，或所在的磁盘没有连接。"))
      .toBe("找不到仓库目录：它可能被移动、改名，或所在的磁盘没有连接。");
    errors.mockRestore();
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
      { method: "POST", body: JSON.stringify(request), headers: { [CONSULTATION_SHAPE_HEADER]: CONSULTATION_SHAPE } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      requestId: "consultation-1",
      status: "no_match",
      boundary: {
        advisoryOnly: true,
        noDecisionWritten: true,
        noPrincipleApplied: true,
        noPreferencePromoted: true,
      },
    });
    expect(consult).toHaveBeenCalledWith(request);
    expect(queue.snapshot().current).toBeNull();

    // Asked by a bridge from 1.1.0, whose parser refused every key it did not know: answered as 1.1.0 was.
    const released = await (await authorizedFetch(`${baseUrl}/v1/consultations`, { method: "POST", body: JSON.stringify(request) })).json();
    expect(Object.keys(released).sort()).toEqual(["boundary", "consultationVersion", "feedback", "generatedBy", "matches", "requestId", "status"]);
    expect(Object.keys(released.boundary).sort()).toEqual(["advisoryOnly", "noDecisionWritten", "noPrincipleApplied"]);
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

  it("exposes graceful shutdown only in explicit smoke mode", async () => {
    const normal = await startServer();
    const unavailable = await authorizedFetch(
      `${normal.baseUrl}/v1/smoke/shutdown`,
      { method: "POST" },
    );
    expect(unavailable.status).toBe(404);
    expect(normal.smokeShutdown).not.toHaveBeenCalled();
    await normal.server.stop();

    const smoke = await startServer(true);
    const shutdown = await authorizedFetch(
      `${smoke.baseUrl}/v1/smoke/shutdown`,
      { method: "POST" },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(shutdown.status).toBe(204);
    expect(smoke.smokeShutdown).toHaveBeenCalledTimes(1);
    await smoke.server.stop();
  });
});
