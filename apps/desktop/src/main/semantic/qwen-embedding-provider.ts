import { homedir } from "node:os";

import type {
  EmbeddingBatch,
  EmbeddingProvider,
} from "../model/embedding-provider.js";
import {
  QWEN_EMBEDDING_MODEL_MANIFEST,
  verifyQwenEmbeddingModel,
  type QwenModelVerification,
} from "./model-manifest.js";

interface EmbeddingResult {
  readonly vector: readonly number[];
}

interface EmbeddingContext {
  getEmbeddingFor(text: string): Promise<EmbeddingResult>;
  dispose(): Promise<void>;
}

interface EmbeddingModel {
  createEmbeddingContext(options: {
    contextSize: number;
  }): Promise<EmbeddingContext>;
  dispose(): Promise<void>;
}

interface EmbeddingLlama {
  loadModel(options: { modelPath: string }): Promise<EmbeddingModel>;
  dispose(): Promise<void>;
}

export interface QwenEmbeddingRuntimeModule {
  getLlama(options: {
    build: "never";
    gpu: "auto";
    skipDownload: true;
    progressLogs: false;
    logger: (level: unknown, message: string) => void;
  }): Promise<EmbeddingLlama>;
}

interface EmbeddingResources {
  llama: EmbeddingLlama;
  model: EmbeddingModel;
  context: EmbeddingContext;
}

export class QwenEmbeddingProviderError extends Error {
  readonly code:
    | "model_missing"
    | "checksum_failed"
    | "runtime_unavailable";

  constructor(
    code: QwenEmbeddingProviderError["code"],
    message: string,
  ) {
    super(message);
    this.name = "QwenEmbeddingProviderError";
    this.code = code;
  }
}

export interface QwenEmbeddingProviderOptions {
  modelsDirectory: string;
  verifyModel?: (options: {
    modelsDirectory: string;
  }) => Promise<QwenModelVerification>;
  loadRuntime?: () => Promise<QwenEmbeddingRuntimeModule>;
}

const defaultRuntimeLoader = async (): Promise<QwenEmbeddingRuntimeModule> =>
  (await import("node-llama-cpp")) as unknown as QwenEmbeddingRuntimeModule;

const abortError = (): Error => {
  const error = new Error("Local embedding was aborted");
  error.name = "AbortError";
  return error;
};

const isAborted = (signal?: AbortSignal): boolean =>
  signal?.aborted === true;

export class QwenEmbeddingProvider implements EmbeddingProvider {
  readonly #modelsDirectory: string;
  readonly #verifyModel: NonNullable<
    QwenEmbeddingProviderOptions["verifyModel"]
  >;
  readonly #loadRuntime: NonNullable<
    QwenEmbeddingProviderOptions["loadRuntime"]
  >;
  #resources: Promise<EmbeddingResources> | undefined;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: QwenEmbeddingProviderOptions) {
    this.#modelsDirectory = options.modelsDirectory;
    this.#verifyModel = options.verifyModel ?? verifyQwenEmbeddingModel;
    this.#loadRuntime = options.loadRuntime ?? defaultRuntimeLoader;
  }

  embed(texts: string[], signal?: AbortSignal): Promise<EmbeddingBatch> {
    const result = this.#tail.then(() => this.#embedNow(texts, signal));
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#tail.catch(() => undefined);
    if (this.#resources === undefined) return;
    let resources: EmbeddingResources;
    try {
      resources = await this.#resources;
    } catch {
      return;
    }
    await resources.context.dispose();
    await resources.model.dispose();
    await resources.llama.dispose();
    this.#resources = undefined;
  }

  async #embedNow(
    texts: string[],
    signal?: AbortSignal,
  ): Promise<EmbeddingBatch> {
    if (this.#closed) {
      throw new QwenEmbeddingProviderError(
        "runtime_unavailable",
        "The local embedding provider is closed",
      );
    }
    if (
      texts.length === 0 ||
      texts.length > 32 ||
      texts.some((text) => text.trim().length === 0 || text.length > 12_000)
    ) {
      throw new QwenEmbeddingProviderError(
        "runtime_unavailable",
        "The local embedding input is invalid",
      );
    }
    if (isAborted(signal)) throw abortError();
    const verification = await this.#verifyModel({
      modelsDirectory: this.#modelsDirectory,
    });
    if (verification.availability !== "available") {
      throw new QwenEmbeddingProviderError(
        verification.availability,
        "The managed local embedding model is unavailable",
      );
    }

    let resources: EmbeddingResources;
    try {
      resources = await this.#getResources(verification);
    } catch {
      throw new QwenEmbeddingProviderError(
        "runtime_unavailable",
        "Unable to initialize the managed local embedding model",
      );
    }
    const vectors: number[][] = [];
    for (const text of texts) {
      if (isAborted(signal)) throw abortError();
      let result: EmbeddingResult;
      try {
        result = await resources.context.getEmbeddingFor(text.trim());
      } catch {
        throw new QwenEmbeddingProviderError(
          "runtime_unavailable",
          "The managed local embedding model failed",
        );
      }
      const magnitude = Math.sqrt(
        result.vector.reduce((total, value) => total + value * value, 0),
      );
      if (!Number.isFinite(magnitude) || magnitude <= 0) {
        throw new QwenEmbeddingProviderError(
          "runtime_unavailable",
          "The managed local embedding model returned an invalid vector",
        );
      }
      vectors.push(Array.from(result.vector, (value) => value / magnitude));
    }
    return {
      model: `${verification.manifest.id}:embedding-${vectors[0]?.length ?? 0}`,
      vectors,
    };
  }

  async #getResources(
    verification: Extract<
      QwenModelVerification,
      { availability: "available" }
    >,
  ): Promise<EmbeddingResources> {
    if (this.#resources === undefined) {
      this.#resources = (async () => {
        const runtime = await this.#loadRuntime();
        const llama = await runtime.getLlama({
          build: "never",
          gpu: "auto",
          skipDownload: true,
          progressLogs: false,
          logger: () => undefined,
        });
        let model: EmbeddingModel | undefined;
        try {
          model = await llama.loadModel({ modelPath: verification.modelPath });
          const context = await model.createEmbeddingContext({
            contextSize: 2_048,
          });
          return { llama, model, context };
        } catch (error) {
          await model?.dispose();
          await llama.dispose();
          throw error;
        }
      })();
    }
    const resources = this.#resources;
    try {
      return await resources;
    } catch (error) {
      if (this.#resources === resources) this.#resources = undefined;
      const message =
        error instanceof Error
          ? error.message.split(homedir()).join("[home]")
          : "unknown local runtime error";
      throw new Error(message.slice(0, 500));
    }
  }
}
