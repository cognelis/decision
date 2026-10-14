import type { ManagedQwenModelId, ManagedQwenModelStatus } from "@cognelis/decision-protocol";
// @ts-expect-error Shared standalone download implementation.
import { prepareLocalModel } from "../../../../../scripts/prepare-local-model.mjs";
import { QWEN_MODEL_MANIFESTS, qwenModelManifest, verifyQwenModel } from "./model-manifest.js";

export class LocalModelInstaller {
  #active: ManagedQwenModelStatus | undefined;
  #failure: ManagedQwenModelStatus | undefined;
  constructor(readonly modelsDirectory: string, readonly prepare = prepareLocalModel) {}

  async list(): Promise<ManagedQwenModelStatus[]> {
    return Promise.all(QWEN_MODEL_MANIFESTS.map(async (manifest) => {
      if (this.#active?.modelId === manifest.id) return { ...this.#active };
      const verification = await verifyQwenModel({ modelsDirectory: this.modelsDirectory, manifest });
      if (verification.availability !== "available" && this.#failure?.modelId === manifest.id) return { ...this.#failure };
      return { modelId: manifest.id as ManagedQwenModelId, status: verification.availability === "model_missing" ? "missing" : verification.availability === "available" ? "available" : "checksum_failed", downloadedBytes: verification.availability === "available" ? manifest.bytes : 0, totalBytes: manifest.bytes };
    }));
  }

  async install(modelId: ManagedQwenModelId): Promise<void> {
    if (this.#active !== undefined) throw new Error("已有本地模型正在安装，请等待完成。");
    const manifest = qwenModelManifest(modelId);
    this.#failure = undefined;
    this.#active = { modelId, status: "installing", downloadedBytes: 0, totalBytes: manifest.bytes };
    try {
      await this.prepare({ manifest, modelsDirectory: this.modelsDirectory, onProgress: ({ downloadedBytes, totalBytes }: { downloadedBytes: number; totalBytes: number }) => {
        this.#active = { modelId, status: "installing", downloadedBytes, totalBytes };
      } });
    } catch {
      this.#failure = { ...this.#active, status: "failed", error: "模型安装未完成，请检查网络与磁盘空间后重试；已下载的部分会保留。" };
      throw new Error(this.#failure.error);
    } finally {
      this.#active = undefined;
    }
  }
}
