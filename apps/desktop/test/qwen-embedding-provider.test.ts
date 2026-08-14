import { describe, expect, it, vi } from "vitest";

import {
  QwenEmbeddingProvider,
  type QwenEmbeddingRuntimeModule,
} from "../src/main/semantic/qwen-embedding-provider.js";
import { QWEN_EMBEDDING_MODEL_MANIFEST } from "../src/main/semantic/model-manifest.js";

const availableModel = () => ({
  availability: "available" as const,
  modelPath: "/models/Qwen3-Embedding-0.6B-Q8_0.gguf",
  manifest: QWEN_EMBEDDING_MODEL_MANIFEST,
});

const runtimeFixture = () => {
  const calls: string[] = [];
  const context = {
    getEmbeddingFor: vi.fn(async (text: string) => ({
      vector: text === "第二条" ? [0, 5] : [3, 4],
    })),
    dispose: vi.fn(async () => {
      calls.push("context");
    }),
  };
  const model = {
    createEmbeddingContext: vi.fn(async () => context),
    dispose: vi.fn(async () => {
      calls.push("model");
    }),
  };
  const llama = {
    loadModel: vi.fn(async () => model),
    dispose: vi.fn(async () => {
      calls.push("llama");
    }),
  };
  const runtime = {
    getLlama: vi.fn(async () => llama),
  } as unknown as QwenEmbeddingRuntimeModule;
  return { calls, context, llama, model, runtime };
};

describe("QwenEmbeddingProvider", () => {
  it("loads the dedicated model once and returns normalized vectors", async () => {
    const fake = runtimeFixture();
    const provider = new QwenEmbeddingProvider({
      modelsDirectory: "/models",
      verifyModel: async () => availableModel(),
      loadRuntime: async () => fake.runtime,
    });

    await expect(provider.embed(["第一条", "第二条"])).resolves.toEqual({
      model: `${QWEN_EMBEDDING_MODEL_MANIFEST.id}:embedding-2`,
      vectors: [
        [0.6, 0.8],
        [0, 1],
      ],
    });
    await provider.embed(["第一条"]);

    expect(fake.runtime.getLlama).toHaveBeenCalledOnce();
    expect(fake.llama.loadModel).toHaveBeenCalledWith({
      modelPath: "/models/Qwen3-Embedding-0.6B-Q8_0.gguf",
    });
    expect(fake.model.createEmbeddingContext).toHaveBeenCalledWith({
      contextSize: 2_048,
    });
    expect(fake.context.getEmbeddingFor).toHaveBeenCalledTimes(3);
  });

  it("falls back cleanly when the dedicated artifact is unavailable", async () => {
    const fake = runtimeFixture();
    const provider = new QwenEmbeddingProvider({
      modelsDirectory: "/models",
      verifyModel: async () => ({ availability: "model_missing" }),
      loadRuntime: async () => fake.runtime,
    });

    await expect(provider.embed(["查询"])).rejects.toMatchObject({
      code: "model_missing",
    });
    expect(fake.runtime.getLlama).not.toHaveBeenCalled();
  });

  it("serializes requests and disposes resources in dependency order", async () => {
    const fake = runtimeFixture();
    const provider = new QwenEmbeddingProvider({
      modelsDirectory: "/models",
      verifyModel: async () => availableModel(),
      loadRuntime: async () => fake.runtime,
    });
    await provider.embed(["第一条"]);

    await provider.close();
    await provider.close();

    expect(fake.calls).toEqual(["context", "model", "llama"]);
    await expect(provider.embed(["第一条"])).rejects.toMatchObject({
      code: "runtime_unavailable",
    });
  });
});
