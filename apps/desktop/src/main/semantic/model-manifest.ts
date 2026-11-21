import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import manifestData from "../../../assets/models/qwen3.5-2b-q4-k-m.json";
import manifest4bData from "../../../assets/models/qwen3.5-4b-q4-k-m.json";
import embeddingManifestData from "../../../assets/models/qwen3-embedding-0.6b-q8-0.json";

const qwenModelManifestSchema = z
  .object({
    id: z.literal("qwen3.5-2b-q4-k-m"),
    fileName: z.literal("Qwen_Qwen3.5-2B-Q4_K_M.gguf"),
    url: z
      .string()
      .url()
      .startsWith("https://huggingface.co/"),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    license: z.literal("Apache-2.0"),
  })
  .strict();

const qwenEmbeddingModelManifestSchema = z
  .object({
    id: z.literal("qwen3-embedding-0.6b-q8-0"),
    fileName: z.literal("Qwen3-Embedding-0.6B-Q8_0.gguf"),
    url: z
      .string()
      .url()
      .startsWith("https://huggingface.co/Qwen/"),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    license: z.literal("Apache-2.0"),
  })
  .strict();

export interface QwenModelManifest {
  id: string;
  fileName: string;
  url: string;
  bytes: number;
  sha256: string;
  license: "Apache-2.0";
}

export const QWEN_MODEL_MANIFEST =
  qwenModelManifestSchema.parse(
    manifestData,
  ) satisfies QwenModelManifest;

export const QWEN_4B_MODEL_MANIFEST = qwenModelManifestSchema.extend({
  id: z.literal("qwen3.5-4b-q4-k-m"),
  fileName: z.literal("Qwen_Qwen3.5-4B-Q4_K_M.gguf"),
}).parse(manifest4bData) satisfies QwenModelManifest;

export const QWEN_MODEL_MANIFESTS = [QWEN_MODEL_MANIFEST, QWEN_4B_MODEL_MANIFEST];
export const qwenModelManifest = (id: string): QwenModelManifest => {
  const manifest = QWEN_MODEL_MANIFESTS.find((item) => item.id === id);
  if (manifest === undefined) throw new Error("请选择受支持的 2B 或 4B 本地模型。");
  return manifest;
};

export const QWEN_EMBEDDING_MODEL_MANIFEST =
  qwenEmbeddingModelManifestSchema.parse(
    embeddingManifestData,
  ) satisfies QwenModelManifest;

export type QwenModelVerification =
  | {
      availability: "available";
      modelPath: string;
      manifest: QwenModelManifest;
    }
  | {
      availability: "model_missing" | "checksum_failed";
    };

interface VerifyQwenModelOptions {
  modelsDirectory: string;
  manifest?: QwenModelManifest;
}

interface VerifyQwenEmbeddingModelOptions {
  modelsDirectory: string;
  manifest?: QwenModelManifest;
}

const verifiedFiles = new Set<string>();
// The digest of a file being read, by its identity: the search's embedding and the knowledge page's each read the 609
// MiB of the same model at a start, side by side, and the first search after a launch waited out both (R9).
const hashing = new Map<string, Promise<string>>();

const identityKey = (
  stats: Awaited<ReturnType<typeof lstat>>,
): string =>
  [
    stats.dev,
    stats.ino,
    stats.size,
    stats.mtimeMs,
  ].join(":");

const hashFile = async (
  modelPath: string,
): Promise<{
  digest: string;
  identity: string;
  size: number;
}> => {
  const file = await open(
    modelPath,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stats = await file.stat();
    if (!stats.isFile()) {
      throw new Error("model is not a regular file");
    }
    const identity = identityKey(stats);
    if (verifiedFiles.has(identity)) {
      return {
        digest: "",
        identity,
        size: stats.size,
      };
    }

    const pending = hashing.get(identity);
    if (pending !== undefined) {
      return { digest: await pending, identity, size: stats.size };
    }
    const reading = (async () => {
      const hash = createHash("sha256");
      const stream = file.createReadStream({ autoClose: false });
      for await (const chunk of stream) {
        hash.update(chunk);
      }
      return hash.digest("hex");
    })();
    hashing.set(identity, reading);
    try {
      return {
        digest: await reading,
        identity,
        size: stats.size,
      };
    } finally {
      hashing.delete(identity);
    }
  } finally {
    await file.close();
  }
};

/** What is at a model's path, by one lstat: a regular file, nothing, or something that cannot be the model. */
const modelFilePlaced = async (modelPath: string): Promise<"file" | "missing" | "other"> => {
  try {
    const pathStats = await lstat(modelPath);
    return pathStats.isSymbolicLink() || !pathStats.isFile() ? "other" : "file";
  } catch (error) {
    return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing"
      : "other";
  }
};

/**
 * Whether a model was never downloaded, as its check above reads it, without reading the file: asked before every
 * captured turn (IMP-153), where a model not there is no failure, the hash is left to the call.
 */
export const qwenModelMissing = async (modelsDirectory: string, id: string): Promise<boolean> =>
  (await modelFilePlaced(join(modelsDirectory, qwenModelManifest(id).fileName))) === "missing";

const verifyModel = async ({
  modelsDirectory,
  manifest,
}: {
  modelsDirectory: string;
  manifest: QwenModelManifest;
}): Promise<QwenModelVerification> => {
  const modelPath = join(modelsDirectory, manifest.fileName);
  const placed = await modelFilePlaced(modelPath);
  if (placed !== "file") {
    return { availability: placed === "missing" ? "model_missing" : "checksum_failed" };
  }

  try {
    const result = await hashFile(modelPath);
    if (result.size !== manifest.bytes) {
      return { availability: "checksum_failed" };
    }
    if (
      result.digest !== "" &&
      result.digest !== manifest.sha256
    ) {
      return { availability: "checksum_failed" };
    }
    verifiedFiles.add(result.identity);
    return {
      availability: "available",
      modelPath,
      manifest,
    };
  } catch {
    return { availability: "checksum_failed" };
  }
};

export const verifyQwenModel = ({
  modelsDirectory,
  manifest = QWEN_MODEL_MANIFEST,
}: VerifyQwenModelOptions): Promise<QwenModelVerification> =>
  verifyModel({ modelsDirectory, manifest });

export const verifyQwenEmbeddingModel = ({
  modelsDirectory,
  manifest = QWEN_EMBEDDING_MODEL_MANIFEST,
}: VerifyQwenEmbeddingModelOptions): Promise<QwenModelVerification> =>
  verifyModel({ modelsDirectory, manifest });

export const clearQwenModelVerificationCache = (): void => {
  verifiedFiles.clear();
};
