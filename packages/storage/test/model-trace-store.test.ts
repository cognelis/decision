import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, unlink: vi.fn(fs.unlink), readFile: vi.fn(fs.readFile) };
});

import type { ModelTraceRecordInput } from "../src/index.js";
import {
  CaptureAuditStore,
  ModelTraceStore,
} from "../src/index.js";

const successfulTraceInput = (
  overrides: Partial<ModelTraceRecordInput> = {},
): ModelTraceRecordInput => ({
  requestId: "request-1",
  attemptId: "attempt-1",
  attemptIndex: 0,
  purpose: "semantic-classification",
  profile: {
    profileId: "qwen",
    backend: "qwen",
    provider: "qwen",
    model: "qwen3.5-2b-q4-k-m",
    promptVersion: "semantic-v1",
    schemaVersion: "semantic-classification-v1",
  },
  input: {
    systemPrompt: "Classify without reasoning.",
    userPrompt: "Assistant: choose A or B. User: A.",
    outputSchema: { type: "object" },
    clientSystemPromptVisibility: "visible",
  },
  output: {
    visibleText: "{\"decisionIntent\":\"decision\"}",
    parsed: { decisionIntent: "decision" },
  },
  usage: {
    source: "runtime_measured",
    inputTokens: 40,
    outputTokens: 8,
    totalTokens: 48,
  },
  timing: {
    queuedMs: 0,
    providerMs: 31,
    totalMs: 31,
  },
  status: "succeeded",
  ...overrides,
});

describe("ModelTraceStore", () => {
  it("reports a failed request deletion so forgetting can retain its retry receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "trace-forget-failure-"));
    const store = new ModelTraceStore(root);
    const trace = await store.record(successfulTraceInput());
    vi.mocked(unlink).mockRejectedValueOnce(Object.assign(new Error("synthetic trace deletion failure"), { code: "EACCES" }));
    await expect(store.deleteRequest("request-1")).rejects.toMatchObject({ cause: { message: "synthetic trace deletion failure", code: "EACCES" } });
    expect((await store.list()).some(entry => entry.traceId === trace.traceId)).toBe(true);
    await expect(store.deleteRequest("request-1")).resolves.toBe(1);
    expect(await store.list()).toEqual([]);
  });
  it("does not treat an unreadable target trace as an already completed deletion", async () => {
    const root = await mkdtemp(join(tmpdir(), "trace-forget-unreadable-"));
    const store = new ModelTraceStore(root); await store.record(successfulTraceInput());
    vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error("synthetic trace read failure"), { code: "EACCES" }));
    await expect(store.deleteRequest("request-1")).rejects.toThrow();
    await expect(store.deleteRequest("request-1")).resolves.toBe(1);
  });
  it("reports deletion failure even when the matching trace has expired", async () => {
    const root = await mkdtemp(join(tmpdir(), "trace-forget-expired-"));
    let now = new Date("2026-11-15T00:00:00Z");
    const store = new ModelTraceStore(root, { now: () => now }); await store.record(successfulTraceInput());
    now = new Date("2026-11-23T00:00:00Z");
    vi.mocked(unlink).mockRejectedValueOnce(Object.assign(new Error("synthetic expired trace deletion failure"), { code: "EACCES" }));
    await expect(store.deleteRequest("request-1")).rejects.toThrow();
    await expect(store.deleteRequest("request-1")).resolves.toBe(1);
  });
  it("does not claim forgetting is complete while an interrupted trace file is unreadable", async () => {
    const root = await mkdtemp(join(tmpdir(), "trace-forget-temporary-"));
    const store = new ModelTraceStore(root); const trace = await store.record(successfulTraceInput());
    const path = join(root, `${createHash('sha256').update(trace.traceId).digest('hex')}.json`);
    await unlink(path);
    await writeFile(`${path}.${randomUUID()}.tmp`, '{"requestId":"request-1","input":');
    await expect(store.deleteRequest("request-1")).rejects.toThrow();
  });
  it("clears a matching valid trace that was previously set aside", async () => {
    const root = await mkdtemp(join(tmpdir(), "trace-forget-quarantine-"));
    const store = new ModelTraceStore(root); const trace = await store.record(successfulTraceInput());
    const filename = `${createHash('sha256').update(trace.traceId).digest('hex')}.json`;
    await rename(join(root, filename), join(root, 'quarantine', `${filename}.corrupt-${Date.now()}-${randomUUID()}`));
    await expect(store.deleteRequest("request-1")).resolves.toBe(1);
    expect(await readdir(join(root, 'quarantine'))).toEqual([]);
  });
  // R15-JEVSET: a purpose and a backend added to the protocol leave the records written before them readable.
  it("still reads a trace written before the decisions backend, beside one of its own", async () => {
    const root = await mkdtemp(join(tmpdir(), "trace-legacy-"));
    const legacy = {
      version: 1, traceId: "legacy-trace", requestId: "legacy-request", attemptId: "legacy-attempt", attemptIndex: 0,
      purpose: "pr-review", contentMode: "metadata-only",
      profile: { profileId: "remote-openai", backend: "openai", provider: "OpenAI", model: "gpt-test", promptVersion: "p", schemaVersion: "s" },
      usage: { source: "provider_reported", inputTokens: 10, outputTokens: 2, totalTokens: 12, costUsd: 0.001 },
      timing: { queuedMs: 0, providerMs: 20, totalMs: 20 }, status: "succeeded",
      createdAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
    const store = new ModelTraceStore(root, { contentMode: () => "metadata-only" });
    await store.list();
    await writeFile(join(root, `${createHash("sha256").update("legacy-trace", "utf8").digest("hex")}.json`), JSON.stringify(legacy), { mode: 0o600 });
    await store.record(successfulTraceInput({ purpose: "structured-judgment", profile: { profileId: "jev", backend: "openrouter-decisions", provider: "jev", model: "typesafe/jev-1.14", promptVersion: "decisions-alpha", schemaVersion: "decisions-alpha" } }));
    const traces = await new ModelTraceStore(root).list();
    expect(traces.map((trace) => [trace.purpose, trace.profile.backend]).sort()).toEqual([["pr-review", "openai"], ["structured-judgment", "openrouter-decisions"]]);
  });
  it("retains the call's peak and cache price snapshot across a metadata-only reload", async () => {
    const root = await mkdtemp(join(tmpdir(), "trace-price-snapshot-"));
    const pricing = { currency: "¥", inputPerMillion: 1, cachedInputPerMillion: 0.02, outputPerMillion: 4, peak: { inputPerMillion: 2, cachedInputPerMillion: 0.04, outputPerMillion: 8, holidayYear: 2026, holidays: ["2026-10-01"] } };
    const input = successfulTraceInput();
    await new ModelTraceStore(root, { contentMode: () => "metadata-only" }).record({ ...input, profile: { ...input.profile, pricing } });
    const [trace] = await new ModelTraceStore(root).list();
    expect(trace!.profile.pricing).toEqual(pricing);
    expect(trace!.input).toBeUndefined(); expect(trace!.output).toBeUndefined();
  });
  it("retains numeric request settings with metadata-only traces while dropping all request and response bodies", async () => {
    const root = await mkdtemp(join(tmpdir(), "trace-request-metadata-"));
    const store = new ModelTraceStore(root, { contentMode: () => "metadata-only" });
    const trace = await store.record(successfulTraceInput({ request: { configuredTimeoutMs: 5000, generationTimeoutMs: 30000, requestedMaxOutputTokens: 8192, systemPromptChars: 20, userPromptChars: 30 }, timing: { queuedMs: 160000, providerMs: 300000, totalMs: 460000 } }));
    expect(trace.input).toBeUndefined(); expect(trace.output).toBeUndefined();
    expect(trace.timing).toEqual({ queuedMs: 160000, providerMs: 300000, totalMs: 460000 });
    expect((await store.list())[0]!.request).toEqual(trace.request);
    const filename = (await readdir(root)).find(name => name.endsWith(".json"))!;
    const content = await readFile(join(root, filename), "utf8");
    expect(content).not.toContain("Classify without reasoning");
    expect(content).not.toContain("Assistant: choose A or B");
  });
  it("records private traces and supports trace, request, and all deletion", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-traces-"));
    const path = join(root, "model-traces");
    let sequence = 0;
    const store = new ModelTraceStore(path, {
      now: () => new Date("2026-07-30T00:00:00.000Z"),
      idFactory: () => `trace-${sequence++}`,
      maximumItems: 10,
    });

    const first = await store.record(successfulTraceInput());
    expect(first.traceId).toBe("trace-0");
    expect(await store.list()).toEqual([first]);
    expect((await stat(path)).mode & 0o777).toBe(0o700);
    const [traceFile] = (await readdir(path)).filter((entry) =>
      entry.endsWith(".json"),
    );
    expect(traceFile).toBeDefined();
    expect((await stat(join(path, traceFile!))).mode & 0o777).toBe(
      0o600,
    );

    await expect(store.deleteTrace(first.traceId)).resolves.toBe(
      true,
    );
    await expect(store.deleteTrace(first.traceId)).resolves.toBe(
      false,
    );

    await store.record(
      successfulTraceInput({
        requestId: "group-1",
        attemptId: "group-attempt-1",
      }),
    );
    await store.record(
      successfulTraceInput({
        requestId: "group-1",
        attemptId: "group-attempt-2",
        attemptIndex: 1,
      }),
    );
    await expect(store.deleteRequest("group-1")).resolves.toBe(2);
    // A deleted conversation's turns, the folder listed once for all of them.
    await store.record(successfulTraceInput({ requestId: "turn-a", attemptId: "turn-a-1" }));
    await store.record(successfulTraceInput({ requestId: "turn-b", attemptId: "turn-b-1" }));
    await expect(store.deleteRequest(["turn-a", "turn-b", "turn-none"])).resolves.toBe(2);

    await store.record(successfulTraceInput());
    await expect(store.clear()).resolves.toBe(1);
    expect(await store.list()).toEqual([]);
  });

  it("expires old traces and keeps the newest configured capacity", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-retention-"));
    let now = new Date("2026-07-20T00:00:00.000Z");
    let sequence = 0;
    const store = new ModelTraceStore(root, {
      now: () => now,
      idFactory: () => `trace-${sequence++}`,
      maximumItems: 2,
      maximumAgeMs: 7 * 24 * 60 * 60 * 1_000,
    });
    await store.record(
      successfulTraceInput({ requestId: "expired" }),
    );

    now = new Date("2026-07-30T00:00:00.000Z");
    for (const requestId of ["new-1", "new-2", "new-3"]) {
      await store.record(successfulTraceInput({ requestId }));
      now = new Date(now.getTime() + 1_000);
    }

    expect(
      (await store.list()).map((trace) => trace.requestId),
    ).toEqual(["new-2", "new-3"]);
  });

  it("quarantines corrupt JSON and summarizes attempts without reading bodies", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-corrupt-"));
    let sequence = 0;
    const store = new ModelTraceStore(root, {
      now: () => new Date("2026-07-30T00:00:00.000Z"),
      idFactory: () => `trace-${sequence++}`,
    });
    await store.record(successfulTraceInput());
    await store.record(
      successfulTraceInput({
        requestId: "request-2",
        attemptId: "attempt-2",
        status: "failed",
        errorCode: "network_error",
        output: undefined,
      }),
    );
    await writeFile(
      join(root, `${"f".repeat(64)}.json`),
      "{private corrupt contents",
      { mode: 0o600 },
    );

    expect(await store.summary()).toEqual({
      total: 2,
      requests: 2,
      succeeded: 1,
      failed: 1,
      contentMode: "full",
      oldestCreatedAt: "2026-07-30T00:00:00.000Z",
      newestCreatedAt: "2026-07-30T00:00:00.000Z",
    });
    expect(await readdir(join(root, "quarantine"))).toHaveLength(1);
  });

  it("lets go a trace written under a clock that ran ahead once the clock is right again", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-ahead-"));
    let now = new Date("2027-10-05T09:00:00.000Z"); // a date typed a year ahead
    let sequence = 0;
    const store = new ModelTraceStore(root, { now: () => now, idFactory: () => `trace-${sequence++}` });
    await store.record(successfulTraceInput({ requestId: "while-ahead" }));

    now = new Date("2026-10-20T09:00:00.000Z");
    await store.record(successfulTraceInput({ requestId: "ordinary" }));
    // Kept as dated, the prompt and reply said to go after 7 days stayed until October 2027.
    expect((await store.list()).map((trace) => trace.requestId)).toEqual(["ordinary"]);
  });

  it("applies retention from record at most hourly, so a model call does not read every trace", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-throttle-"));
    let now = new Date("2026-07-30T00:00:00.000Z");
    let sequence = 0;
    const store = new ModelTraceStore(root, { now: () => now, idFactory: () => `trace-${sequence++}` });
    await store.record(successfulTraceInput());
    // Only a scan moves this aside: a record that scans quarantines it.
    await writeFile(join(root, `${"e".repeat(64)}.json`), "not-json");

    now = new Date("2026-07-30T00:59:00.000Z");
    await store.record(successfulTraceInput());
    expect(await readdir(join(root, "quarantine"))).toHaveLength(0);

    now = new Date("2026-07-30T01:01:00.000Z");
    await store.record(successfulTraceInput());
    expect(await readdir(join(root, "quarantine"))).toHaveLength(1);
  });

  it("ages out what it set aside, and clears it with everything else", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-quarantine-"));
    let now = new Date("2026-07-30T00:00:00.000Z");
    const store = new ModelTraceStore(root, { now: () => now });
    await writeFile(join(root, `${"e".repeat(64)}.json`), "{\"prompt\":\"private\"");
    await store.list();
    expect(await readdir(join(root, "quarantine"))).toHaveLength(1);

    now = new Date("2026-08-07T00:00:00.000Z");
    await store.list();
    expect(await readdir(join(root, "quarantine"))).toHaveLength(0);

    // Set aside under a clock a year ahead: gone once the clock is right again, not kept until that day.
    now = new Date("2027-08-07T00:00:00.000Z");
    await writeFile(join(root, `${"d".repeat(64)}.json`), "{\"prompt\":\"private\"");
    await store.list();
    expect(await readdir(join(root, "quarantine"))).toHaveLength(1);
    now = new Date("2026-08-07T00:00:00.000Z");
    await store.list();
    expect(await readdir(join(root, "quarantine"))).toHaveLength(0);

    await writeFile(join(root, `${"f".repeat(64)}.json`), "{\"prompt\":\"private\"");
    await store.list();
    await store.clear();
    expect(await readdir(join(root, "quarantine")).catch(() => [])).toHaveLength(0);
  });

  it("omits model input and output when content tracing is disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-metadata-"));
    const store = new ModelTraceStore(root, {
      now: () => new Date("2026-07-30T00:00:00.000Z"),
      idFactory: () => "trace-metadata",
      contentMode: () => "metadata-only",
    });

    const saved = await store.record(successfulTraceInput());
    expect(saved.contentMode).toBe("metadata-only");
    expect(saved.input).toBeUndefined();
    expect(saved.output).toBeUndefined();
    const [filename] = (await readdir(root)).filter((entry) =>
      entry.endsWith(".json"),
    );
    const serialized = await readFile(join(root, filename!), "utf8");
    expect(serialized).not.toContain("Classify without reasoning");
    expect(serialized).not.toContain("decisionIntent");
  });

  it("does not count trace write failures as capture failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "capture-audit-"));
    const audit = new CaptureAuditStore(root, {
      now: () => new Date("2026-07-30T00:00:00.000Z"),
      salt: Buffer.alloc(32, 7),
      idFactory: () => "receipt-trace-failure",
    });
    await audit.record({
      sourceClient: "codex",
      sessionId: "session-1",
      stage: "failed",
      errorCode: "trace_write_failed",
    });

    expect((await audit.summary()).failures).toBe(0);
  });
});
