import { getEventListeners } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  LocalClassifierClient,
  LocalEmbeddingClient,
  LocalModelHost,
  localModelEnvironment,
  restoreLocalModelError,
  type LocalModelProcess,
} from "../src/main/semantic/local-model-client.js";
import {
  createSharedRuntime,
  serveLocalModels,
  type LocalModelHostOptions,
  type LocalModelReply,
  type LocalModelRequest,
  type NativeLlamaModule,
} from "../src/main/semantic/local-model-host.js";
import { QWEN_EMBEDDING_MODEL_MANIFEST, QWEN_MODEL_MANIFEST } from "../src/main/semantic/model-manifest.js";
import { QwenEmbeddingProvider, QwenEmbeddingProviderError } from "../src/main/semantic/qwen-embedding-provider.js";
import { QwenProviderError } from "../src/main/semantic/qwen-provider.js";
import type { SemanticClassifier } from "../src/main/semantic/semantic-classifier.js";

const settle = async (rounds = 3) => {
  for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setImmediate(resolve));
};

const nativeFixture = () => {
  const disposed: string[] = [];
  const contexts: string[] = [];
  const llama = {
    loadModel: vi.fn(async ({ modelPath }: { modelPath: string }) => ({
      createEmbeddingContext: async () => {
        contexts.push(modelPath);
        return { getEmbeddingFor: async () => ({ vector: [3, 4] }), dispose: async () => undefined };
      },
      createContext: async () => ({}),
      dispose: async () => { disposed.push(modelPath); },
    })),
    createGrammarForJsonSchema: vi.fn(async () => ({})),
    dispose: vi.fn(async () => { disposed.push("llama"); }),
  };
  const module = { getLlama: vi.fn(async () => llama), LlamaChatSession: class {} };
  return { contexts, disposed, llama, module: module as unknown as NativeLlamaModule & typeof module };
};

/** The two ends of the channel in one process; each message cloned on its way, as the port does. */
const channel = (options: Omit<LocalModelHostOptions, "exit">, behaviour: { exitsOnShutdown?: boolean } = {}) => {
  const spawned: Array<{ crash(): void; received: LocalModelRequest[]; killed: boolean }> = [];
  const spawn = (): LocalModelProcess => {
    const replies: Array<(reply: LocalModelReply) => void> = [];
    const exits: Array<(code: number | null) => void> = [];
    let alive = true;
    const end = (code: number | null) => {
      if (!alive) return;
      alive = false;
      for (const listener of exits) listener(code);
    };
    const receive = serveLocalModels((reply) => {
      if (alive) setImmediate(() => { if (alive) for (const listener of replies) listener(structuredClone(reply)); });
    }, { ...options, exit: () => { if (behaviour.exitsOnShutdown !== false) end(0); } });
    const record = { received: [] as LocalModelRequest[], killed: false, crash: () => end(null) };
    spawned.push(record);
    return {
      postMessage: (message) => {
        const copy = structuredClone(message);
        record.received.push(copy);
        setImmediate(() => { if (alive) receive(copy); });
      },
      onMessage: (listener) => replies.push(listener),
      onExit: (listener) => exits.push(listener),
      kill: () => {
        record.killed = true;
        end(null);
      },
    };
  };
  return { spawn, spawned };
};

const availableEmbedding = async () => ({
  availability: "available" as const,
  modelPath: "/models/embedding.gguf",
  manifest: QWEN_EMBEDDING_MODEL_MANIFEST,
});

const unusedRuntime = async () => { throw new Error("unused"); };

describe("shared local model runtime", () => {
  const llamaOptions = { build: "never", gpu: "auto", skipDownload: true, progressLogs: false, logger: () => undefined } as const;

  it("makes one Llama and loads a model file once, unloading it with its last holder", async () => {
    const native = nativeFixture();
    const shared = createSharedRuntime(async () => native.module);
    const first = await (await shared.load()).getLlama(llamaOptions);
    const second = await (await shared.load()).getLlama(llamaOptions);
    const [a, b] = await Promise.all([
      first.loadModel({ modelPath: "/models/embedding.gguf" }),
      second.loadModel({ modelPath: "/models/embedding.gguf" }),
    ]);
    expect(native.module.getLlama).toHaveBeenCalledTimes(1);
    expect(native.llama.loadModel).toHaveBeenCalledTimes(1);

    await first.dispose();
    await a.dispose();
    await a.dispose();
    expect(native.disposed).toEqual([]);
    await b.dispose();
    expect(native.disposed).toEqual(["/models/embedding.gguf"]);
    await shared.dispose();
    expect(native.disposed).toEqual(["/models/embedding.gguf", "llama"]);
  });

  it("tries a failed Llama or model load again rather than keeping the failure", async () => {
    const native = nativeFixture();
    native.module.getLlama.mockRejectedValueOnce(new Error("no Metal"));
    native.llama.loadModel.mockRejectedValueOnce(new Error("bad file"));
    const shared = createSharedRuntime(async () => native.module);
    const runtime = await shared.load();
    await expect(runtime.getLlama(llamaOptions)).rejects.toThrow("no Metal");
    const llama = await runtime.getLlama(llamaOptions);
    await expect(llama.loadModel({ modelPath: "/m" })).rejects.toThrow("bad file");
    await expect(llama.loadModel({ modelPath: "/m" })).resolves.toBeDefined();
    expect(native.module.getLlama).toHaveBeenCalledTimes(2);
  });

  it("gives the search's and the knowledge page's embedding one model, a context each", async () => {
    const native = nativeFixture();
    const shared = createSharedRuntime(async () => native.module);
    const { spawn } = channel({
      runtime: shared.load,
      createEmbedding: (options, runtime) =>
        new QwenEmbeddingProvider({ modelsDirectory: options.modelsDirectory, verifyModel: availableEmbedding, loadRuntime: runtime }),
    });
    const host = new LocalModelHost({ spawn, log: () => undefined });
    const search = new LocalEmbeddingClient(host, { modelsDirectory: "/models" });
    const notes = new LocalEmbeddingClient(host, { modelsDirectory: "/models" });

    const [one, two] = await Promise.all([search.embed(["缓存"]), notes.embed(["笔记"])]);
    expect(one.vectors).toEqual([[0.6, 0.8]]);
    expect(two.vectors).toEqual([[0.6, 0.8]]);
    expect(native.llama.loadModel).toHaveBeenCalledTimes(1);
    expect(native.contexts).toHaveLength(2);

    await search.close();
    expect(native.disposed).toEqual([]);
    await notes.close();
    expect(native.disposed).toEqual(["/models/embedding.gguf"]);
  });
});

const fakeClassifier = (options: { blocks?: boolean } = {}) => {
  const models: string[] = [];
  const signals: AbortSignal[] = [];
  let release = (): void => undefined;
  const classifier = {
    id: "qwen",
    status: async () => ({ id: "qwen", availability: "available" }),
    invoke: vi.fn(async (_input: unknown, signal?: AbortSignal) => {
      if (signal !== undefined) signals.push(signal);
      if (options.blocks === true) await new Promise<void>((resolve) => { release = resolve; });
      if (options.blocks === true) {
        throw new QwenProviderError("timeout", "Qwen inference timed out", {
          diagnosticExcerpt: "Qwen inference timed out after 15000 ms",
          usage: { source: "unavailable" },
        });
      }
      return { classification: { model: models.at(-1) ?? "default" } };
    }),
    setModel: (model: string) => { models.push(model); },
    close: async () => undefined,
  } as unknown as SemanticClassifier;
  return { classifier, models, signals, release: () => release() };
};

const input = { pairId: "p1", assistantText: "a", userText: "u", locale: "zh-CN" as const };

describe("local model process errors", () => {
  it("hands back a provider's error as the class it threw, with its code, excerpt and usage", async () => {
    const fake = fakeClassifier({ blocks: true });
    const { spawn } = channel({
      runtime: unusedRuntime,
      createEmbedding: (options) =>
        new QwenEmbeddingProvider({ modelsDirectory: options.modelsDirectory, verifyModel: async () => ({ availability: "model_missing" }) }),
      createClassifier: () => fake.classifier,
    });
    const host = new LocalModelHost({ spawn, log: () => undefined });

    const embedding = new LocalEmbeddingClient(host, { modelsDirectory: "/models" }).embed(["缓存"]);
    await expect(embedding).rejects.toBeInstanceOf(QwenEmbeddingProviderError);
    await expect(embedding).rejects.toMatchObject({ code: "model_missing" });

    const attempt = new LocalClassifierClient(host, { modelsDirectory: "/models" }).invoke(input);
    await settle();
    fake.release();
    await expect(attempt).rejects.toBeInstanceOf(QwenProviderError);
    await expect(attempt).rejects.toMatchObject({
      name: "QwenProviderError",
      code: "timeout",
      diagnosticExcerpt: "Qwen inference timed out after 15000 ms",
      usage: { source: "unavailable" },
    });
  });

  it("says an error of the process's own in one fixed sentence, never its words", async () => {
    const { spawn } = channel({
      runtime: unusedRuntime,
      createEmbedding: () => ({
        embed: async () => { throw new Error("ENOENT: /Users/someone/Library/private/model.gguf"); },
        close: async () => undefined,
      }),
    });
    const embedding = new LocalEmbeddingClient(new LocalModelHost({ spawn, log: () => undefined }), { modelsDirectory: "/models" });
    const failed = await embedding.embed(["缓存"]).catch((error: unknown) => error as Error);
    expect(failed).toBeInstanceOf(QwenEmbeddingProviderError);
    expect(failed).toMatchObject({ code: "runtime_unavailable", message: "The local model call failed" });
  });

  // Every place in the main process that reads a provider's error, as it reads it.
  it.each([
    ["obsidian-search-service isUnavailableError", "embedding", { name: "QwenEmbeddingProviderError", code: "checksum_failed", message: "m" },
      (error: Error) => error instanceof QwenEmbeddingProviderError && (error.code === "model_missing" || error.code === "checksum_failed")],
    ["obsidian-search-service runtime failure", "embedding", { name: "QwenEmbeddingProviderError", code: "runtime_unavailable", message: "m" },
      (error: Error) => error instanceof QwenEmbeddingProviderError && error.code === "runtime_unavailable"],
    ["semantic-search-service model_missing", "embedding", { name: "QwenEmbeddingProviderError", code: "model_missing", message: "m" },
      (error: Error) => (error as { code?: unknown }).code === "model_missing"],
    ["profiled-model-gateway abort", "classifier", { name: "AbortError", message: "Qwen classification aborted" },
      (error: Error) => error.name === "AbortError"],
    ["profiled-model-gateway code", "classifier", { name: "QwenProviderError", code: "provider_invalid_output", message: "m" },
      (error: Error) => (error as { code?: unknown }).code === "provider_invalid_output"],
    ["profiled-model-gateway failure details", "classifier",
      { name: "QwenProviderError", code: "output_limit", message: "Qwen output exceeded", diagnosticExcerpt: "limit", usage: { source: "runtime_measured", inputTokens: 1, outputTokens: 512, totalTokens: 513 } },
      (error: Error) => error.name === "QwenProviderError" && error.message === "Qwen output exceeded" &&
        (error as QwenProviderError).diagnosticExcerpt === "limit" && (error as QwenProviderError).usage?.source === "runtime_measured"],
    ["semantic-coordinator timedOutError", "classifier", { name: "QwenProviderError", code: "timeout", message: "m" },
      (error: Error) => (error as { code?: unknown }).code === "timeout"],
    ["semantic-coordinator providerErrorCode", "classifier", { name: "QwenProviderError", code: "runtime_unavailable", message: "m" },
      (error: Error) => (error as { code?: unknown }).code === "runtime_unavailable"],
    ["model-gateway abort", "embedding", { name: "AbortError", message: "Local embedding was aborted" },
      (error: Error) => error.name === "AbortError"],
  ] as const)("restores what %s reads", (_reader, kind, failure, reads) => {
    expect(reads(restoreLocalModelError(kind, failure))).toBe(true);
  });
});

describe("local model process clients", () => {
  it("passes a model change on, and to the process started again after an exit", async () => {
    const fake = fakeClassifier();
    const { spawn, spawned } = channel({ runtime: unusedRuntime, createClassifier: () => fake.classifier });
    const host = new LocalModelHost({ spawn, log: () => undefined });
    const client = new LocalClassifierClient(host, { modelsDirectory: "/models", model: "qwen3.5-2b" });

    client.setModel("qwen3.5-4b");
    await client.invoke(input);
    expect(spawned[0]!.received[0]).toMatchObject({ op: "open", options: { model: "qwen3.5-4b" } });

    client.setModel("qwen3.5-2b");
    await settle();
    expect(fake.models).toEqual(["qwen3.5-2b"]);
    spawned[0]!.crash();
    await client.invoke(input);
    expect(spawned[1]!.received[0]).toMatchObject({ op: "open", options: { model: "qwen3.5-2b" } });
  });

  it("answers the classifier's status from the model file, without the process", async () => {
    const { spawn, spawned } = channel({ runtime: unusedRuntime });
    const verifyModel = vi.fn(async () => ({ availability: "available" as const, modelPath: "/models/q.gguf", manifest: QWEN_MODEL_MANIFEST }));
    const client = new LocalClassifierClient(new LocalModelHost({ spawn, log: () => undefined }), { modelsDirectory: "/models", verifyModel });
    await expect(client.status()).resolves.toMatchObject({ id: "qwen", availability: "available", modelVersion: QWEN_MODEL_MANIFEST.id });
    expect(spawned).toHaveLength(0);
  });

  it("settles an aborted call at once, and the instance's next call still waits for the native one", async () => {
    let finishNative = (): void => undefined;
    const order: string[] = [];
    const context = {
      getEmbeddingFor: vi.fn(async (text: string) => {
        order.push(`start ${text}`);
        if (text === "第一条") await new Promise<void>((resolve) => { finishNative = resolve; });
        order.push(`end ${text}`);
        return { vector: [1, 0] };
      }),
      dispose: async () => undefined,
    };
    const runtime = async () => ({
      getLlama: async () => ({
        loadModel: async () => ({ createEmbeddingContext: async () => context, dispose: async () => undefined }),
        dispose: async () => undefined,
      }),
    });
    const { spawn } = channel({
      runtime: runtime as never,
      createEmbedding: (options, load) =>
        new QwenEmbeddingProvider({ modelsDirectory: options.modelsDirectory, verifyModel: availableEmbedding, loadRuntime: load }),
    });
    const embedding = new LocalEmbeddingClient(new LocalModelHost({ spawn, log: () => undefined }), { modelsDirectory: "/models" });
    const controller = new AbortController();
    const first = embedding.embed(["第一条"], controller.signal);
    await settle(10);
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });

    const second = embedding.embed(["第二条"]);
    await settle(10);
    expect(order).toEqual(["start 第一条"]);
    finishNative();
    await second;
    expect(order).toEqual(["start 第一条", "end 第一条", "start 第二条", "end 第二条"]);
  });

  it("passes an abort on to the call running in the process", async () => {
    const fake = fakeClassifier({ blocks: true });
    const { spawn } = channel({ runtime: unusedRuntime, createClassifier: () => fake.classifier });
    const client = new LocalClassifierClient(new LocalModelHost({ spawn, log: () => undefined }), { modelsDirectory: "/models" });
    const controller = new AbortController();
    const attempt = client.invoke(input, controller.signal);
    await settle();
    controller.abort();
    await expect(attempt).rejects.toMatchObject({ name: "AbortError" });
    await settle();
    expect(fake.signals[0]?.aborted).toBe(true);
    fake.release();
  });

  it("fails what was running when the process crashes, and starts it again on the next call", async () => {
    const lines: string[] = [];
    const fake = fakeClassifier({ blocks: true });
    const { spawn, spawned } = channel({ runtime: unusedRuntime, createClassifier: () => fake.classifier,
      createEmbedding: () => ({ embed: async () => ({ model: "m", vectors: [[1]] }), close: async () => undefined }) });
    const host = new LocalModelHost({ spawn, log: (line) => lines.push(line) });
    const classifier = new LocalClassifierClient(host, { modelsDirectory: "/models" });
    const embedding = new LocalEmbeddingClient(host, { modelsDirectory: "/models" });

    const running = classifier.invoke(input);
    await settle();
    spawned[0]!.crash();
    await expect(running).rejects.toBeInstanceOf(QwenProviderError);
    await expect(running).rejects.toMatchObject({ code: "runtime_unavailable" });
    expect(lines).toEqual(["[local-models] exited code=null intentional=false"]);

    await expect(embedding.embed(["缓存"])).resolves.toMatchObject({ model: "m" });
    expect(spawned).toHaveLength(2);
  });

  it("backs off the kind whose calls crash the process, until one of them is answered", async () => {
    let now = 0;
    let crashes = true;
    const { spawn, spawned } = channel({
      runtime: unusedRuntime,
      createClassifier: () => ({
        ...fakeClassifier().classifier,
        invoke: async () => {
          if (crashes) spawned.at(-1)!.crash();
          return { classification: {} };
        },
      }) as unknown as SemanticClassifier,
      createEmbedding: () => ({ embed: async () => ({ model: "m", vectors: [[1]] }), close: async () => undefined }),
    });
    const host = new LocalModelHost({ spawn, now: () => now, log: () => undefined });
    const classifier = new LocalClassifierClient(host, { modelsDirectory: "/models", verifyModel: async () => ({ availability: "model_missing" }) });
    const embedding = new LocalEmbeddingClient(host, { modelsDirectory: "/models" });

    // The first crash: tried again at once.
    await expect(classifier.invoke(input)).rejects.toMatchObject({ code: "runtime_unavailable" });
    expect(spawned).toHaveLength(1);

    // The second, the process having lived past a minute (which does not start the count again): two seconds' wait for
    // the classifier, its status said unavailable; the embeddings go on.
    now = 70_000;
    await expect(classifier.invoke(input)).rejects.toMatchObject({ message: "The local model process ended" });
    expect(spawned).toHaveLength(2);
    await expect(classifier.invoke(input)).rejects.toMatchObject({ code: "runtime_unavailable", message: "The local model process is restarting" });
    await expect(classifier.status()).resolves.toMatchObject({ availability: "runtime_unavailable" });
    await expect(embedding.embed(["缓存"])).resolves.toMatchObject({ model: "m" });
    expect(spawned).toHaveLength(3);

    now = 72_000;
    await expect(classifier.invoke(input)).rejects.toMatchObject({ code: "runtime_unavailable" });
    now = 75_000;
    await expect(classifier.invoke(input)).rejects.toMatchObject({ message: "The local model process is restarting" });

    // Answered once, the count starts again.
    now = 82_000;
    crashes = false;
    await expect(classifier.invoke(input)).resolves.toEqual({ classification: {} });
    crashes = true;
    await expect(classifier.invoke(input)).rejects.toMatchObject({ message: "The local model process ended" });
    await expect(classifier.invoke(input)).rejects.toMatchObject({ message: "The local model process ended" });
  });

  it("carries a structured generation there and back, its trace input and usage as the provider gave them", async () => {
    const attempt = {
      parsedOutput: { summary: "在做什么" },
      visibleOutput: "{\"summary\":\"在做什么\"}",
      modelVersion: QWEN_MODEL_MANIFEST.id,
      traceInput: { systemPrompt: "s", userPrompt: "u", outputSchema: { type: "object" }, clientSystemPromptVisibility: "visible" },
      usage: { source: "runtime_measured", inputTokens: 12, outputTokens: 7, totalTokens: 19 },
      providerDurationMs: 840,
    };
    const generate = vi.fn(async () => attempt);
    const { spawn } = channel({
      runtime: unusedRuntime,
      createClassifier: (options) => (options.model === "no-generate"
        ? fakeClassifier().classifier
        : { ...fakeClassifier().classifier, generate }) as unknown as SemanticClassifier,
    });
    const host = new LocalModelHost({ spawn, log: () => undefined });
    const request = { systemPrompt: "s", userPrompt: "u", outputSchema: { type: "object" }, maxOutputTokens: 256 };

    await expect(new LocalClassifierClient(host, { modelsDirectory: "/models" }).generate(request as never)).resolves.toEqual(attempt);
    expect(generate).toHaveBeenCalledWith(request, expect.any(AbortSignal));

    const without = new LocalClassifierClient(host, { modelsDirectory: "/models", model: "no-generate" }).generate(request as never);
    await expect(without).rejects.toBeInstanceOf(QwenProviderError);
    await expect(without).rejects.toMatchObject({ code: "runtime_unavailable", message: "The local model call failed" });
  });

  it("passes a timeout change on, and to the process started again after an exit", async () => {
    const timeouts: number[] = [];
    const { spawn, spawned } = channel({
      runtime: unusedRuntime,
      createClassifier: () => ({ ...fakeClassifier().classifier, setTimeoutMs: (ms: number) => { timeouts.push(ms); } }) as unknown as SemanticClassifier,
    });
    const client = new LocalClassifierClient(new LocalModelHost({ spawn, log: () => undefined }), { modelsDirectory: "/models", timeoutMs: 5_000 });

    client.setTimeoutMs(8_000);
    await client.invoke(input);
    expect(spawned[0]!.received[0]).toMatchObject({ op: "open", options: { timeoutMs: 8_000 } });
    client.setTimeoutMs(20_000);
    await settle();
    expect(timeouts).toEqual([20_000]);
    spawned[0]!.crash();
    await client.invoke(input);
    expect(spawned[1]!.received[0]).toMatchObject({ op: "open", options: { timeoutMs: 20_000 } });
  });

  it("takes its abort listener off a long-lived signal as each call settles, answered or cut short by an exit", async () => {
    const fake = fakeClassifier({ blocks: true });
    const { spawn, spawned } = channel({ runtime: unusedRuntime, createClassifier: () => fake.classifier,
      createEmbedding: () => ({ embed: async () => ({ model: "m", vectors: [[1]] }), close: async () => undefined }) });
    const host = new LocalModelHost({ spawn, log: () => undefined });
    const signal = new AbortController().signal;
    const added = vi.spyOn(signal, "addEventListener");
    const removed = vi.spyOn(signal, "removeEventListener");

    await new LocalEmbeddingClient(host, { modelsDirectory: "/models" }).embed(["缓存"], signal);
    expect(removed).toHaveBeenCalledTimes(1);
    const running = new LocalClassifierClient(host, { modelsDirectory: "/models" }).invoke(input, signal);
    await settle();
    spawned[0]!.crash();
    await expect(running).rejects.toMatchObject({ code: "runtime_unavailable" });
    expect(removed).toHaveBeenCalledTimes(2);
    expect(removed.mock.calls.map((call) => call[1])).toEqual(added.mock.calls.map((call) => call[1]));
  });

  it("answers the calls of an instance the process could not make as unavailable, and goes on serving the others", async () => {
    const { spawn, spawned } = channel({
      runtime: unusedRuntime,
      createEmbedding: () => { throw new Error("cannot construct"); },
      createClassifier: () => fakeClassifier().classifier,
    });
    const host = new LocalModelHost({ spawn, log: () => undefined });
    const failed = new LocalEmbeddingClient(host, { modelsDirectory: "/models" }).embed(["缓存"]);
    await expect(failed).rejects.toBeInstanceOf(QwenEmbeddingProviderError);
    await expect(failed).rejects.toMatchObject({ code: "runtime_unavailable" });
    await expect(new LocalClassifierClient(host, { modelsDirectory: "/models" }).invoke(input)).resolves.toBeDefined();
    expect(spawned).toHaveLength(1);
    // Thrown out of the message handler, it was the process's uncaught exception: the process, every model in it, gone.
    const receive = serveLocalModels(() => undefined, { runtime: unusedRuntime, createEmbedding: () => { throw new Error("cannot construct"); } });
    expect(() => receive({ op: "open", instance: 1, kind: "embedding", options: { modelsDirectory: "/models" } })).not.toThrow();
  });

  it("refuses a call as unavailable when the process cannot be written to", async () => {
    const host = new LocalModelHost({
      spawn: () => ({
        postMessage: () => { throw new Error("Object has been destroyed"); },
        onMessage: () => undefined,
        onExit: () => undefined,
        kill: () => undefined,
      }),
      log: () => undefined,
    });
    const embedding = new LocalEmbeddingClient(host, { modelsDirectory: "/models" });
    const refused = embedding.embed(["缓存"]);
    await expect(refused).rejects.toBeInstanceOf(QwenEmbeddingProviderError);
    await expect(refused).rejects.toMatchObject({ code: "runtime_unavailable" });
    await expect(new LocalClassifierClient(host, { modelsDirectory: "/models" }).invoke(input)).rejects.toBeInstanceOf(QwenProviderError);
  });

  it("does not take a close's answer for the kind working again", async () => {
    let mode: "crash" | "fail" = "crash";
    const { spawn, spawned } = channel({
      runtime: unusedRuntime,
      createClassifier: () => ({
        ...fakeClassifier().classifier,
        invoke: async () => {
          if (mode === "crash") spawned.at(-1)!.crash();
          throw new QwenProviderError("runtime_unavailable", "Unable to initialize the local Qwen runtime");
        },
      }) as unknown as SemanticClassifier,
    });
    const host = new LocalModelHost({ spawn, now: () => 0, log: () => undefined });
    const first = new LocalClassifierClient(host, { modelsDirectory: "/models" });
    await expect(first.invoke(input)).rejects.toMatchObject({ message: "The local model process ended" });
    mode = "fail";
    await expect(first.invoke(input)).rejects.toMatchObject({ message: "Unable to initialize the local Qwen runtime" });
    await first.close();

    // The second crash in a row: the close answered between them did not start the count again.
    mode = "crash";
    const second = new LocalClassifierClient(host, { modelsDirectory: "/models" });
    await expect(second.invoke(input)).rejects.toMatchObject({ message: "The local model process ended" });
    await expect(second.invoke(input)).rejects.toMatchObject({ message: "The local model process is restarting" });
  });

  it("leaves no abort listener on a signal reused for twenty calls, nor after the process ends under one", async () => {
    const fake = fakeClassifier({ blocks: true });
    const { spawn, spawned } = channel({ runtime: unusedRuntime, createClassifier: () => fake.classifier,
      createEmbedding: () => ({ embed: async () => ({ model: "m", vectors: [[1]] }), close: async () => undefined }) });
    const host = new LocalModelHost({ spawn, log: () => undefined });
    const embedding = new LocalEmbeddingClient(host, { modelsDirectory: "/models" });
    const { signal } = new AbortController();

    for (let call = 0; call < 20; call += 1) await embedding.embed(["缓存"], signal);
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
    const running = new LocalClassifierClient(host, { modelsDirectory: "/models" }).invoke(input, signal);
    await settle();
    expect(getEventListeners(signal, "abort")).toHaveLength(1);
    spawned[0]!.crash();
    await expect(running).rejects.toMatchObject({ code: "runtime_unavailable" });
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
  });

  it("counts a crash against a classification its caller cancelled while the process still ran it", async () => {
    let now = 0;
    const { spawn, spawned } = channel({
      runtime: unusedRuntime,
      // Neither answers: the classification loading its model, the search waiting behind nothing.
      createClassifier: () => ({ ...fakeClassifier().classifier, invoke: () => new Promise(() => undefined) }) as unknown as SemanticClassifier,
      createEmbedding: () => ({ embed: () => new Promise(() => undefined), close: async () => undefined }),
    });
    const host = new LocalModelHost({ spawn, now: () => now, log: () => undefined });
    const classifier = new LocalClassifierClient(host, { modelsDirectory: "/models" });
    const embedding = new LocalEmbeddingClient(host, { modelsDirectory: "/models" });

    for (let round = 0; round < 4; round += 1) {
      now += 61_000;
      const controller = new AbortController();
      const cancelled = classifier.invoke(input, controller.signal);
      await settle();
      controller.abort();
      await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
      const searching = embedding.embed(["缓存"]);
      await settle();
      spawned.at(-1)!.crash();
      await expect(searching).rejects.toMatchObject({ code: "runtime_unavailable" });
    }
    // Four crashes in a row under the classification, none of its calls answered: its calls wait, as the searches' do.
    expect(host.available("classifier")).toBe(false);
    expect(host.available("embedding")).toBe(false);
  });

  it("starts no process to close a client that never called", async () => {
    const { spawn, spawned } = channel({ runtime: unusedRuntime });
    const client = new LocalEmbeddingClient(new LocalModelHost({ spawn, log: () => undefined }), { modelsDirectory: "/models" });
    await client.close();
    await expect(client.embed(["缓存"])).rejects.toMatchObject({ code: "runtime_unavailable" });
    expect(spawned).toHaveLength(0);
  });
});

describe("local model process shutdown", () => {
  const embeddingHost = (behaviour: { exitsOnShutdown?: boolean } = {}) => {
    const closed: string[] = [];
    const { spawn, spawned } = channel({
      runtime: unusedRuntime,
      createEmbedding: () => ({
        embed: async () => ({ model: "m", vectors: [[1]] }),
        close: async () => { closed.push("provider"); },
      }),
      disposeRuntime: async () => { closed.push("llama"); },
    }, behaviour);
    const lines: string[] = [];
    const host = new LocalModelHost({ spawn, log: (line) => lines.push(line), shutdownGraceMs: 50 });
    return { closed, host, lines, spawned };
  };

  it("closes every model in the process, then the Llama, and the exit is not a crash", async () => {
    const { closed, host, lines, spawned } = embeddingHost();
    const embedding = new LocalEmbeddingClient(host, { modelsDirectory: "/models" });
    await embedding.embed(["缓存"]);
    await host.shutdown();
    expect(closed).toEqual(["provider", "llama"]);
    expect(spawned[0]!.killed).toBe(false);
    expect(lines).toEqual(["[local-models] exited code=0 intentional=true"]);
  });

  it("waits for a close already under way before it disposes the Llama and exits", async () => {
    const order: string[] = [];
    let finishClose = (): void => undefined;
    const receive = serveLocalModels(() => undefined, {
      runtime: unusedRuntime,
      createEmbedding: () => ({
        embed: async () => ({ model: "m", vectors: [[1]] }),
        close: () => {
          order.push("close-start");
          return new Promise<void>((resolve) => { finishClose = () => { order.push("close-end"); resolve(); }; });
        },
      }),
      disposeRuntime: async () => { order.push("dispose-runtime"); },
      exit: () => order.push("exit"),
    });
    // The gateway's close of its long-lived client, then the quit's shutdown, one after the other on the port.
    receive({ op: "open", instance: 1, kind: "embedding", options: { modelsDirectory: "/models" } });
    receive({ op: "close", id: 1, instance: 1 });
    receive({ op: "shutdown" });
    await settle(5);
    expect(order).toEqual(["close-start"]);
    finishClose();
    await settle(5);
    expect(order).toEqual(["close-start", "close-end", "dispose-runtime", "exit"]);
  });

  it("succeeds at a client's close however the process went: shut down, killed, crashed or never holding it", async () => {
    const { host, spawned } = embeddingHost({ exitsOnShutdown: false });
    const before = new LocalEmbeddingClient(host, { modelsDirectory: "/models" });
    const during = new LocalEmbeddingClient(host, { modelsDirectory: "/models" });
    const never = new LocalEmbeddingClient(host, { modelsDirectory: "/models" });
    await before.embed(["缓存"]);
    await during.embed(["缓存"]);

    const closingDuring = during.close();
    const shutdown = host.shutdown();
    await expect(before.close()).resolves.toBeUndefined();
    await shutdown;
    expect(spawned[0]!.killed).toBe(true);
    await expect(closingDuring).resolves.toBeUndefined();
    await expect(never.close()).resolves.toBeUndefined();

    const crashed = embeddingHost();
    const client = new LocalEmbeddingClient(crashed.host, { modelsDirectory: "/models" });
    await client.embed(["缓存"]);
    crashed.spawned[0]!.crash();
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("succeeds at a client's close the process failed", async () => {
    const { spawn } = channel({
      runtime: unusedRuntime,
      createEmbedding: () => ({
        embed: async () => ({ model: "m", vectors: [[1]] }),
        close: async () => { throw new Error("dispose failed"); },
      }),
    });
    const embedding = new LocalEmbeddingClient(new LocalModelHost({ spawn, log: () => undefined }), { modelsDirectory: "/models" });
    await embedding.embed(["缓存"]);
    await expect(embedding.close()).resolves.toBeUndefined();
  });

  it("closes a client at once while the process is shutting down, not after the process stuck in a native call is killed", async () => {
    let answer = (_reply: LocalModelReply): void => undefined;
    let exit = (_code: number | null): void => undefined;
    let killed = false;
    let answering = true;
    const host = new LocalModelHost({
      spawn: () => ({
        postMessage: (message) => {
          if (answering && "id" in message) setImmediate(() => answer({ id: message.id, ok: true, value: { model: "m", vectors: [[1]] } }));
          if (message.op === "shutdown") answering = false;
        },
        onMessage: (listener) => { answer = listener; },
        onExit: (listener) => { exit = listener; },
        kill: () => { killed = true; exit(null); },
      }),
      log: () => undefined,
      shutdownGraceMs: 50,
    });
    const embedding = new LocalEmbeddingClient(host, { modelsDirectory: "/models" });
    await embedding.embed(["缓存"]);
    const shutdown = host.shutdown();
    await embedding.close();
    expect(killed).toBe(false);
    await shutdown;
    expect(killed).toBe(true);
  });

  it("kills a process that does not exit within its grace, and starts none after", async () => {
    const { host, lines, spawned } = embeddingHost({ exitsOnShutdown: false });
    const embedding = new LocalEmbeddingClient(host, { modelsDirectory: "/models" });
    await embedding.embed(["缓存"]);
    await host.shutdown();
    expect(spawned[0]!.killed).toBe(true);
    expect(lines).toEqual(["[local-models] exited code=null intentional=true"]);
    await expect(embedding.embed(["缓存"])).rejects.toMatchObject({ message: "The local model process is closing" });
    expect(spawned).toHaveLength(1);
  });
});

describe("the local models' process environment", () => {
  it("gives it no credential, nor Node's run-as-Node and options, and keeps what the runtime may read", () => {
    const environment = localModelEnvironment({
      PATH: "/usr/bin",
      HOME: "/Users/someone",
      NODE_LLAMA_CPP_DEBUG: "0",
      ELECTRON_RUN_AS_NODE: "1",
      NODE_OPTIONS: "--require /tmp/x.js",
      OPENAI_API_KEY: "sentinel-openai",
      AWS_SESSION_TOKEN: "sentinel-aws",
      GITHUB_TOKEN: "sentinel-github",
      DB_PASSWORD: "sentinel-password",
      client_secret: "sentinel-secret",
      GOOGLE_APPLICATION_CREDENTIALS: "sentinel-credentials",
    });
    expect(environment).toEqual({ PATH: "/usr/bin", HOME: "/Users/someone", NODE_LLAMA_CPP_DEBUG: "0" });
    expect(JSON.stringify(environment)).not.toContain("sentinel");
  });
});

describe("the main process's own llama", () => {
  it("leaves no provider to load llama in the main process but the local models' own", async () => {
    const root = fileURLToPath(new URL("../src/main/", import.meta.url));
    const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".ts"));
    const constructing: string[] = [];
    for (const file of files) {
      const source = await readFile(join(root, file), "utf8");
      if (/new Qwen(?:Embedding|Model)Provider\(/u.test(source)) constructing.push(file.replaceAll("\\", "/"));
    }
    // The knowledge page's default stays for its real-vault acceptance, run in plain Node; the app passes its own.
    expect(constructing.sort()).toEqual(["obsidian-search/obsidian-search-runtime.ts", "semantic/local-model-host.ts"]);
    const index = await readFile(join(root, "index.ts"), "utf8");
    expect(index).toContain("embedding: (options) => new LocalEmbeddingClient(localModels, options)");
    expect(index).toContain("new LocalClassifierClient(localModels");
  });
});
