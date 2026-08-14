import {
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
