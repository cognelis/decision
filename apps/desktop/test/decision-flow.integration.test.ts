import {
  CandidateSpool,
  CaptureAuditStore,
  CaptureSpool,
  DecisionStore,
  DecisionWatcher,
  MarkdownRepository,
  ModelTraceStore,
  SqliteIndex,
  SemanticPairSpool,
  serializeDecision,
} from "@cognelis/decision-storage";
import {
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CaptureRuntime } from "../src/main/capture-runtime.js";
import { LocalCaptureServer } from "../src/main/local-server.js";
import { StructuredModelGateway } from "../src/main/model/model-gateway.js";
import { SemanticPairInbox } from "../src/main/semantic-pair-inbox.js";
import type {
  SemanticClassifier,
} from "../src/main/semantic/semantic-classifier.js";
import { SemanticDecisionCoordinator } from "../src/main/semantic/semantic-coordinator.js";
import {
  semanticPairFixture,
  serverCaptureFixture,
} from "./fixtures.js";
import { TextCaptureFallback } from "../../bridge/src/text-fallback.js";
import { TextCaptureStore } from "../../bridge/src/text-capture-store.js";

const token = "integration-token-".padEnd(64, "x");

const setup = async (
  options: { tracedClassifier?: boolean } = {},
) => {
  const now = () => new Date("2026-07-27T01:03:00.000Z");
  const root = await mkdtemp(
    join(tmpdir(), "decision-flow-"),
  );
  const repository = new MarkdownRepository(join(root, "vault"));
  const index = new SqliteIndex(join(root, "index.sqlite"));
  const spool = new CaptureSpool(join(root, "spool"));
  const candidateSpool = new CandidateSpool(
    join(root, "candidate-spool"),
    { now },
  );
  const store = new DecisionStore(repository, index);
  let sequence = 0;
  const runtime = new CaptureRuntime({
    spool,
    candidateSpool,
    store,
    index,
    idFactory: () => `id-${++sequence}`,
    now,
  });
  const semanticPairSpool = new SemanticPairSpool(
    join(root, "semantic-pair-spool"),
    { now },
  );
  const audit = new CaptureAuditStore(
    join(root, "capture-audit"),
  );
  const modelTraces = new ModelTraceStore(
    join(root, "model-traces"),
  );
  const unavailableApple: SemanticClassifier = {
    id: "apple",
    status: async () => ({
      id: "apple",
      availability: "device_not_eligible",
      modelVersion: "system-language-model",
      promptVersion: "semantic-v1",
    }),
    invoke: async () => {
      throw new Error("unavailable Apple must not be invoked");
    },
    classify: async () => {
      throw new Error("unavailable Apple must not be invoked");
    },
    close: async () => undefined,
  };
  const successfulQwen: SemanticClassifier = {
    id: "qwen",
    status: async () => ({
      id: "qwen",
      availability: "available",
      modelVersion: "qwen3.5-2b-q4-k-m",
      promptVersion: "semantic-v1",
    }),
    invoke: async (input) => {
      const classification = {
        decisionIntent: "decision" as const,
        answerRelation: "answers" as const,
        question: input.assistantText,
        optionLabels: ["先处理技术债", "先提交当前这批"],
        answerExcerpt: input.userText,
        confidence: 0.95,
        provider: "qwen",
        modelVersion: "qwen3.5-2b-q4-k-m",
        promptVersion: "semantic-v1",
      };
      return {
        classification,
        visibleOutput: JSON.stringify(classification),
        traceInput: {
          systemPrompt: "Classify without reasoning.",
          userPrompt: `${input.assistantText}\n${input.userText}`,
          outputSchema: { type: "object" },
          clientSystemPromptVisibility: "visible",
        },
        usage: {
          source: "runtime_measured",
          inputTokens: 20,
          outputTokens: 10,
          totalTokens: 30,
        },
        providerDurationMs: 5,
      };
    },
    classify: async function (input, signal) {
      return (await this.invoke(input, signal)).classification;
    },
    close: async () => undefined,
  };
  const classifier =
    options.tracedClassifier === true
      ? new StructuredModelGateway({
          appleFactory: () => unavailableApple,
          qwenFactory: () => successfulQwen,
          traces: modelTraces,
          audit,
        })
      : undefined;
  const semanticCoordinator =
    new SemanticDecisionCoordinator({
      runtime,
      audit,
      ...(classifier === undefined ? {} : { classifier }),
      now,
    });
  const semanticInbox = new SemanticPairInbox({
    spool: semanticPairSpool,
    consume: (pair) => semanticCoordinator.process(pair),
  });
  const server = new LocalCaptureServer({
    queue: runtime.queue,
    ingest: (event) => runtime.ingest(event),
    ingestCandidate: (candidate) =>
      runtime.ingestCandidate(candidate),
    token,
  });
  const address = await server.start();
  return {
    repository,
    root,
    index,
    spool,
    candidateSpool,
    semanticPairSpool,
    semanticInbox,
    modelTraces,
    runtime,
    server,
    url: `http://${address.host}:${address.port}/v1/captures`,
  };
};

const post = (url: string, body: unknown): Promise<Response> =>
  fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

describe("passive decision flow", () => {
  it("preserves the decision outcome while recording each model backend attempt", async () => {
    const {
      index,
      modelTraces,
      runtime,
      semanticInbox,
      server,
    } = await setup({ tracedClassifier: true });
    const pair = semanticPairFixture({
      assistantText:
        "先处理技术债，还是先提交当前这批？",
      userText: "先处理技术债",
      capturedAt: "2026-07-27T01:02:00.000Z",
      expiresAt: "2026-08-03T01:02:00.000Z",
    });

    await semanticInbox.enqueue(pair);
    await semanticInbox.flush();

    expect(runtime.queue.snapshot().current).not.toBeNull();
    expect(
      (await modelTraces.list()).map((trace) => ({
        backend: trace.profile.backend,
        status: trace.status,
      })),
    ).toEqual([
      { backend: "apple", status: "unavailable" },
      { backend: "qwen", status: "succeeded" },
    ]);

    await server.stop();
    index.close();
  });

  it("routes a high-confidence text pair and persists bounded context", async () => {
    const {
      root,
      repository,
      index,
      spool,
      runtime,
      semanticInbox,
      semanticPairSpool,
      server,
    } = await setup();
    const now = () =>
      new Date("2026-07-27T01:02:03.000Z");
    const fallback = new TextCaptureFallback({
      store: new TextCaptureStore(join(root, "text-pending"), {
        now,
      }),
      readLastDecisionTurn: async () => ({
        userText: "继续开发 Decision。",
        assistantText:
          "规则方案延迟低，本地模型以后再接入。\n\n" +
          "1. 先规则后模型\n3. 再接本地模型\n\n" +
          "请选择一种推进顺序",
      }),
      now,
    });
    await fallback.onStop(
      {
        session_id: "high-context",
        turn_id: "question-turn",
        cwd: "/tmp/decision",
        transcript_path: "/tmp/high-context.jsonl",
      },
      "claude-code",
    );

    const result = await fallback.onUserPrompt(
      {
        session_id: "high-context",
        turn_id: "answer-turn",
        cwd: "/tmp/decision",
        prompt: "先 1 后 3",
      },
      "claude-code",
    );
    if (result === null) {
      throw new Error("Expected a semantic pair");
    }
    expect(result).toMatchObject({
      assistantText:
        "规则方案延迟低，本地模型以后再接入。\n\n" +
        "1. 先规则后模型\n3. 再接本地模型\n\n" +
        "请选择一种推进顺序",
      userText: "先 1 后 3",
      context: {
        taskBackground: "继续开发 Decision。",
      },
    });
    await semanticInbox.enqueue(result);
    await semanticInbox.flush();
    await runtime.queue.submit({
      status: "captured",
      rationale: "先用可解释规则积累语料。",
    });

    const scan = await repository.scan();
    const markdown = await readFile(scan.notes[0]!.path, "utf8");
    expect(markdown).toContain("### 任务背景");
    expect(markdown).toContain("继续开发 Decision。");
    expect(markdown).toContain("### 约束与考虑");
    expect(markdown).toContain(
      "规则方案延迟低，本地模型以后再接入。",
    );
    expect(markdown).toContain("先 1 后 3");
    expect(index.search("规则方案延迟低")).toHaveLength(1);
    expect(await semanticPairSpool.list()).toEqual([]);

    await server.stop();
    index.close();
  });

  it("routes a medium text pair through candidate review before Markdown", async () => {
    const {
      root,
      repository,
      index,
      candidateSpool,
      runtime,
      semanticInbox,
      server,
    } = await setup();
    const now = () =>
      new Date("2026-07-27T02:03:04.000Z");
    const fallback = new TextCaptureFallback({
      store: new TextCaptureStore(join(root, "text-pending"), {
        now,
      }),
      readLastDecisionTurn: async () => ({
        userText: "提高普通文本决策的采集质量。",
        assistantText:
          "本地规则成本最低。我倾向先做规则版本，等你确认后再继续。",
      }),
      now,
    });
    await fallback.onStop(
      {
        session_id: "medium-context",
        turn_id: "question-turn",
        cwd: "/tmp/decision",
        transcript_path: "/tmp/medium-context.jsonl",
      },
      "claude-code",
    );
    const result = await fallback.onUserPrompt(
      {
        session_id: "medium-context",
        turn_id: "answer-turn",
        cwd: "/tmp/decision",
        prompt: "可以",
      },
      "claude-code",
    );
    if (result === null) {
      throw new Error("Expected a semantic pair");
    }
    expect(result).toMatchObject({
      assistantText:
        "本地规则成本最低。我倾向先做规则版本，等你确认后再继续。",
      userText: "可以",
      context: {
        taskBackground: "提高普通文本决策的采集质量。",
      },
    });
    await semanticInbox.enqueue(result);
    await semanticInbox.flush();
    expect((await repository.scan()).notes).toEqual([]);
    expect(index.count()).toBe(0);
    expect(await candidateSpool.list()).toHaveLength(1);
    expect(runtime.candidates.snapshot().current).not.toBeNull();
    await runtime.confirmCurrentCandidate();
    await runtime.queue.submit({
      status: "captured",
      rationale: "先验证规则方案的覆盖率。",
    });

    expect(await candidateSpool.list()).toEqual([]);
    const scan = await repository.scan();
    const markdown = await readFile(scan.notes[0]!.path, "utf8");
    expect(markdown).toContain('capture_confidence: "medium"');
    expect(markdown).toContain(
      "提高普通文本决策的采集质量。",
    );
    expect(index.count()).toBe(1);

    await server.stop();
    index.close();
  });

  it("ignores a medium semantic candidate without a fact record", async () => {
    const {
      root,
      repository,
      index,
      spool,
      candidateSpool,
      runtime,
      semanticInbox,
      server,
    } = await setup();
    const now = () =>
      new Date("2026-07-27T03:04:05.000Z");
    const fallback = new TextCaptureFallback({
      store: new TextCaptureStore(join(root, "text-pending"), {
        now,
      }),
      now,
    });
    await fallback.onStop(
      {
        session_id: "medium-ignore",
        cwd: "/tmp/decision",
        last_assistant_message:
          "本地规则成本最低。我倾向先做规则版本，等你确认后再继续。",
      },
      "codex",
    );
    const result = await fallback.onUserPrompt(
      {
        session_id: "medium-ignore",
        cwd: "/tmp/decision",
        prompt: "可以",
      },
      "codex",
    );
    if (result === null) {
      throw new Error("Expected a semantic pair");
    }
    expect(result).toMatchObject({
      assistantText:
        "本地规则成本最低。我倾向先做规则版本，等你确认后再继续。",
      userText: "可以",
    });
    await semanticInbox.enqueue(result);
    await semanticInbox.flush();
    await runtime.ignoreCurrentCandidate();

    expect(await candidateSpool.list()).toEqual([]);
    expect(await spool.list()).toEqual([]);
    expect((await repository.scan()).notes).toEqual([]);
    expect(index.count()).toBe(0);

    await server.stop();
    index.close();
  });

  it("returns immediately, then persists rationale and external edits", async () => {
    const {
      repository,
      index,
      spool,
      runtime,
      server,
      url,
    } = await setup();
    const event = serverCaptureFixture();
    await spool.append(event);

    const response = await post(url, event);

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      accepted: 1,
      duplicates: 0,
    });
    await runtime.queue.submit({
      status: "captured",
      rationale: "  Loopback 更容易诊断。  ",
      reasonFactors: ["maintainability"],
    });

    const scan = await repository.scan();
    expect(scan.notes).toHaveLength(1);
    expect(scan.notes[0]?.record).toMatchObject({
      selectedAnswer: {
        kind: "preset",
        values: ["Loopback HTTP"],
      },
      rationaleOriginal: "  Loopback 更容易诊断。  ",
      captureMode: "structured_tool",
    });
    expect(index.search("Loopback")).toHaveLength(1);
    expect(await spool.list()).toEqual([]);

    const note = scan.notes[0]!;
    await writeFile(
      note.path,
      serializeDecision({
        ...note.record,
        rationaleOriginal:
          "后来在 Obsidian 里补充了 reversibleedit。",
      }),
      "utf8",
    );
    const watcher = new DecisionWatcher(repository, index);
    await watcher.synchronizePath(note.path);
    expect(index.search("reversibleedit")).toHaveLength(1);

    await server.stop();
    index.close();
  });

  it("keeps one structured candidate when transcript fallback sees the same decision", async () => {
    const { index, runtime, server, spool, url } = await setup();
    const structured = serverCaptureFixture();
    const {
      toolUseId: _toolUseId,
      ...transcript
    } = serverCaptureFixture({
      captureMode: "transcript",
      sourceEventId: "stop-1:prompt-1",
      batchId: "text-batch",
    });

    await spool.append(structured);
    await spool.append(transcript);
    expect(await (await post(url, structured)).json()).toEqual({
      accepted: 1,
      duplicates: 0,
    });
    expect(await (await post(url, transcript)).json()).toEqual({
      accepted: 0,
      duplicates: 1,
    });
    expect(runtime.queue.snapshot()).toMatchObject({
      current: {
        event: { captureMode: "structured_tool" },
      },
      waitingCount: 0,
    });
    await runtime.queue.submit({ status: "not_recorded" });
    expect(await spool.list()).toEqual([]);

    await server.stop();
    index.close();
  });

  it("covers custom, deferred, skipped, no-record, and replay dedupe", async () => {
    const {
      repository,
      index,
      spool,
      runtime,
      server,
      url,
    } = await setup();

    const dispositions = [
      {
        suffix: "custom",
        answer: {
          kind: "custom" as const,
          values: ["Named Pipe"],
        },
        submission: { status: "deferred" as const },
      },
      {
        suffix: "skipped",
        answer: {
          kind: "preset" as const,
          values: ["Unix Socket"],
        },
        submission: { status: "skipped" as const },
      },
      {
        suffix: "no-record",
        answer: {
          kind: "preset" as const,
          values: ["Loopback HTTP"],
        },
        submission: { status: "not_recorded" as const },
      },
    ];

    for (const item of dispositions) {
      const base = serverCaptureFixture();
      const question = {
        ...base.questions[0]!,
        answer: item.answer,
      };
      const event = {
        ...base,
        sourceEventId: `event-${item.suffix}`,
        toolUseId: `tool-${item.suffix}`,
        batchId: `batch-${item.suffix}`,
        questions: [question],
      };
      await spool.append(event);
      expect((await post(url, event)).status).toBe(202);
      await runtime.queue.submit(item.submission);
    }

    const duplicate = serverCaptureFixture({
      sourceEventId: "event-duplicate",
      toolUseId: "tool-duplicate",
      batchId: "batch-duplicate",
    });
    await spool.append(duplicate);
    expect(await (await post(url, duplicate)).json()).toEqual({
      accepted: 1,
      duplicates: 0,
    });
    expect(await (await post(url, duplicate)).json()).toEqual({
      accepted: 0,
      duplicates: 1,
    });
    await runtime.queue.submit({
      status: "captured",
      rationale: "重放只记录一次。",
    });

    expect((await repository.scan()).notes).toHaveLength(2);
    expect(index.count()).toBe(2);
    expect(index.listByRationaleStatus("deferred")).toHaveLength(0);
    expect(index.listByRationaleStatus("skipped")).toHaveLength(1);
    expect(await spool.list()).toEqual([
      expect.objectContaining({ batchId: "batch-custom" }),
    ]);
    await server.stop();
    index.close();
  });
});
