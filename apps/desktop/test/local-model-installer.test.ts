import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LocalModelInstaller } from "../src/main/semantic/local-model-installer.js";

describe("local model installation", () => {
  it("reports selected-model progress, rejects overlapping downloads and keeps failures retryable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "decision-install-"));
    let fail!: (error: Error) => void;
    const prepare = vi.fn(async ({ onProgress }: { onProgress: (value: { downloadedBytes: number; totalBytes: number }) => void }) => {
      onProgress({ downloadedBytes: 10, totalBytes: 3013027808 });
      await new Promise((_, reject) => { fail = reject; });
    });
    const installer = new LocalModelInstaller(directory, prepare);
    try {
      expect((await installer.list()).map((item) => item.status)).toEqual(["missing", "missing"]);
      const installing = installer.install("qwen3.5-4b-q4-k-m");
      const refused = expect(installing).rejects.toThrow(/已下载的部分会保留/);
      await expect(installer.install("qwen3.5-2b-q4-k-m")).rejects.toThrow(/已有本地模型/);
      expect(await installer.list()).toContainEqual(expect.objectContaining({ modelId: "qwen3.5-4b-q4-k-m", status: "installing", downloadedBytes: 10 }));
      fail(new Error("network failed")); await refused;
      expect(await installer.list()).toContainEqual(expect.objectContaining({ modelId: "qwen3.5-4b-q4-k-m", status: "failed", downloadedBytes: 10 }));
      prepare.mockImplementationOnce(async () => undefined);
      await installer.install("qwen3.5-4b-q4-k-m");
      expect(prepare.mock.calls[1]![0]).toMatchObject({ manifest: { id: "qwen3.5-4b-q4-k-m", bytes: 3013027808 } });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
