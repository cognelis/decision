import {
  chmod,
  link,
  mkdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  QWEN_EMBEDDING_MODEL_MANIFEST,
  QWEN_MODEL_MANIFEST,
  clearQwenModelVerificationCache,
  verifyQwenModel,
  type QwenModelManifest,
} from "../src/main/semantic/model-manifest.js";

const temporaryDirectories: string[] = [];

const createModelDirectory = async (): Promise<string> => {
  const directory = join(
    tmpdir(),
    `decision-model-test-${crypto.randomUUID()}`,
  );
  await mkdir(directory, { recursive: true });
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  clearQwenModelVerificationCache();
  for (const directory of temporaryDirectories.splice(0)) {
    await import("node:fs/promises").then(({ rm }) =>
      rm(directory, { recursive: true, force: true }),
    );
  }
});

describe("Qwen model manifest", () => {
  it("pins one immutable, licensed artifact", () => {
    expect(QWEN_MODEL_MANIFEST).toEqual({
      id: "qwen3.5-2b-q4-k-m",
      fileName: "Qwen_Qwen3.5-2B-Q4_K_M.gguf",
      url: "https://huggingface.co/bartowski/Qwen_Qwen3.5-2B-GGUF/resolve/915a52556175c333102d04f996380950d35155d9/Qwen_Qwen3.5-2B-Q4_K_M.gguf",
      bytes: 1_329_766_560,
      sha256:
        "84aeb7fe40e7b833d71303d7f1b9f9c1991b931b5dbd214e0aa48d56a0af1f85",
      license: "Apache-2.0",
    });
  });

  it("pins the official multilingual embedding artifact", () => {
    expect(QWEN_EMBEDDING_MODEL_MANIFEST).toEqual({
      id: "qwen3-embedding-0.6b-q8-0",
      fileName: "Qwen3-Embedding-0.6B-Q8_0.gguf",
      url: "https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/d20cf9c16f82914a21dbd9c645f56895fb1d7750/Qwen3-Embedding-0.6B-Q8_0.gguf",
      bytes: 639_150_592,
      sha256:
        "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439",
      license: "Apache-2.0",
    });
  });

  it("distinguishes a missing model from a bad checksum", async () => {
    const modelsDirectory = await createModelDirectory();
    const manifest: QwenModelManifest = {
      ...QWEN_MODEL_MANIFEST,
      fileName: "mini.gguf",
      bytes: 5,
      sha256:
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    };

    await expect(
      verifyQwenModel({ modelsDirectory, manifest }),
    ).resolves.toEqual({
      availability: "model_missing",
    });

    await writeFile(join(modelsDirectory, "mini.gguf"), "wrong");
    await expect(
      verifyQwenModel({ modelsDirectory, manifest }),
    ).resolves.toEqual({
      availability: "checksum_failed",
    });
  });

  it("accepts only a regular non-symlink file with matching size and hash", async () => {
    const modelsDirectory = await createModelDirectory();
    const manifest: QwenModelManifest = {
      ...QWEN_MODEL_MANIFEST,
      fileName: "mini.gguf",
      bytes: 5,
      sha256:
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    };
    const modelPath = join(modelsDirectory, manifest.fileName);
    await writeFile(modelPath, "hello");
    await chmod(modelPath, 0o600);

    await expect(
      verifyQwenModel({ modelsDirectory, manifest }),
    ).resolves.toEqual({
      availability: "available",
      modelPath,
      manifest,
    });

    clearQwenModelVerificationCache();
    const hardLinkPath = join(modelsDirectory, "same-inode.gguf");
    await link(modelPath, hardLinkPath);
    await import("node:fs/promises").then(({ rm }) => rm(modelPath));
    await symlink(hardLinkPath, modelPath);
    await expect(
      verifyQwenModel({ modelsDirectory, manifest }),
    ).resolves.toEqual({
      availability: "checksum_failed",
    });
  });

  it("caches success by inode, size and mtime rather than path alone", async () => {
    const modelsDirectory = await createModelDirectory();
    const manifest: QwenModelManifest = {
      ...QWEN_MODEL_MANIFEST,
      fileName: "mini.gguf",
      bytes: 5,
      sha256:
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    };
    const modelPath = join(modelsDirectory, manifest.fileName);
    await writeFile(modelPath, "hello");

    await verifyQwenModel({ modelsDirectory, manifest });
    await writeFile(modelPath, "wrong");

    await expect(
      verifyQwenModel({ modelsDirectory, manifest }),
    ).resolves.toEqual({
      availability: "checksum_failed",
    });
  });
});
