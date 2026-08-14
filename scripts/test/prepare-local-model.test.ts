import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// @ts-expect-error The production downloader is an executable ESM module.
import {
  inspectLocalModel,
  prepareLocalModel,
} from "../prepare-local-model.mjs";

const model = Buffer.from(
  "decision-local-model-fixture",
  "utf8",
);
const sha256 = createHash("sha256")
  .update(model)
  .digest("hex");
const roots: string[] = [];
let server: Server;
let origin = "";
let requests = 0;
let ranges: Array<string | undefined> = [];

const manifest = (url: string) => ({
  id: "fixture",
  fileName: "fixture.gguf",
  url,
  bytes: model.byteLength,
  sha256,
  license: "Apache-2.0",
});

const temporaryModels = async (): Promise<string> => {
  const root = await mkdtemp(
    join(tmpdir(), "decision-model-download-"),
  );
  roots.push(root);
  return join(root, "models");
};

beforeAll(async () => {
  server = createServer((request, response) => {
    requests += 1;
    ranges.push(
      Array.isArray(request.headers.range)
        ? request.headers.range[0]
        : request.headers.range,
    );
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/redirect-loop") {
      response.writeHead(302, {
        location: `${origin}/redirect-loop`,
      });
      response.end();
      return;
    }
    if (url.pathname.startsWith("/redirect/")) {
      const remaining = Number(url.pathname.split("/").at(-1));
      response.writeHead(302, {
        location:
          remaining > 0
            ? `${origin}/redirect/${remaining - 1}`
            : `${origin}/model`,
      });
      response.end();
      return;
    }

    const range = request.headers.range;
    const start =
      typeof range === "string"
        ? Number(/^bytes=(\d+)-$/u.exec(range)?.[1] ?? 0)
        : 0;
    const body = model.subarray(start);
    const headers: Record<string, string | number> = {
      "content-length":
        url.pathname === "/wrong-length"
          ? body.byteLength - 1
          : body.byteLength,
      "content-type": "application/octet-stream",
    };
    if (start > 0) {
      headers["content-range"] =
        `bytes ${start}-${model.byteLength - 1}/${model.byteLength}`;
    }
    response.writeHead(start > 0 ? 206 : 200, headers);
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture server did not bind");
  }
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(() => {
  requests = 0;
  ranges = [];
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) =>
      error === undefined ? resolve() : reject(error),
    ),
  );
  await Promise.all(
    roots.map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("prepareLocalModel", () => {
  it("documents its non-downloading CLI options", () => {
    const scriptPath = new URL(
      "../prepare-local-model.mjs",
      import.meta.url,
    );
    const result = spawnSync(
      process.execPath,
      [scriptPath.pathname, "--help"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "prepare-local-model.mjs [--check] [--models-dir PATH]",
    );
    expect(result.stdout).toContain(
      "Downloads only after an explicit invocation",
    );
  });

  it("streams a fresh download to a private partial and atomically renames it", async () => {
    const modelsDirectory = await temporaryModels();
    const progress = vi.fn();

    await expect(
      prepareLocalModel({
        manifest: manifest(`${origin}/model`),
        modelsDirectory,
        onProgress: progress,
      }),
    ).resolves.toMatchObject({
      status: "downloaded",
      downloadedBytes: model.byteLength,
    });

    const modelPath = join(modelsDirectory, "fixture.gguf");
    expect(await readFile(modelPath)).toEqual(model);
    await expect(
      stat(`${modelPath}.partial`),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(modelPath)).mode & 0o777).toBe(0o600);
    expect(progress).toHaveBeenLastCalledWith({
      downloadedBytes: model.byteLength,
      totalBytes: model.byteLength,
    });
  });

  it("resumes a valid partial with an exact range request", async () => {
    const modelsDirectory = await temporaryModels();
    await mkdir(modelsDirectory, { recursive: true });
    const prefix = model.subarray(0, 9);
    await writeFile(
      join(modelsDirectory, "fixture.gguf.partial"),
      prefix,
      { mode: 0o600 },
    );

    await prepareLocalModel({
      manifest: manifest(`${origin}/model`),
      modelsDirectory,
    });

    expect(ranges).toEqual([`bytes=${prefix.byteLength}-`]);
    expect(
      await readFile(join(modelsDirectory, "fixture.gguf")),
    ).toEqual(model);
  });

  it("skips an existing verified file without making a request", async () => {
    const modelsDirectory = await temporaryModels();
    await mkdir(modelsDirectory, { recursive: true });
    await writeFile(
      join(modelsDirectory, "fixture.gguf"),
      model,
      { mode: 0o600 },
    );

    await expect(
      prepareLocalModel({
        manifest: manifest(`${origin}/model`),
        modelsDirectory,
      }),
    ).resolves.toMatchObject({ status: "already_available" });
    expect(requests).toBe(0);
  });

  it("removes invalid partials after length or checksum failures", async () => {
    const wrongLengthDirectory = await temporaryModels();
    await expect(
      prepareLocalModel({
        manifest: manifest(`${origin}/wrong-length`),
        modelsDirectory: wrongLengthDirectory,
      }),
    ).rejects.toMatchObject({ code: "content_length_mismatch" });
    await expect(
      stat(
        join(
          wrongLengthDirectory,
          "fixture.gguf.partial",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const wrongHashDirectory = await temporaryModels();
    await expect(
      prepareLocalModel({
        manifest: {
          ...manifest(`${origin}/model`),
          sha256: "0".repeat(64),
        },
        modelsDirectory: wrongHashDirectory,
      }),
    ).rejects.toMatchObject({ code: "checksum_failed" });
    await expect(
      stat(join(wrongHashDirectory, "fixture.gguf.partial")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("limits redirects and rejects non-local insecure URLs", async () => {
    const modelsDirectory = await temporaryModels();
    await expect(
      prepareLocalModel({
        manifest: manifest(`${origin}/redirect/2`),
        modelsDirectory,
      }),
    ).resolves.toMatchObject({ status: "downloaded" });

    await expect(
      prepareLocalModel({
        manifest: manifest(`${origin}/redirect-loop`),
        modelsDirectory: await temporaryModels(),
        maximumRedirects: 2,
      }),
    ).rejects.toMatchObject({ code: "redirect_limit" });

    await expect(
      prepareLocalModel({
        manifest: manifest("http://example.com/model.gguf"),
        modelsDirectory: await temporaryModels(),
      }),
    ).rejects.toMatchObject({ code: "insecure_url" });
  });

  it("never writes into the application bundle", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "Decision.app-"),
    );
    roots.push(root);
    const resourcesPath = join(
      root,
      "Decision.app",
      "Contents",
      "Resources",
    );
    const modelsDirectory = join(resourcesPath, "models");

    await expect(
      prepareLocalModel({
        manifest: manifest(`${origin}/model`),
        modelsDirectory,
        resourcesPath,
      }),
    ).rejects.toMatchObject({ code: "app_bundle_path" });
    expect(requests).toBe(0);
  });

  it("supports a read-only check without downloading", async () => {
    const modelsDirectory = await temporaryModels();

    await expect(
      inspectLocalModel({
        manifest: manifest(`${origin}/model`),
        modelsDirectory,
      }),
    ).resolves.toEqual({ status: "missing" });
    expect(requests).toBe(0);

    await mkdir(modelsDirectory, { recursive: true });
    const modelPath = join(modelsDirectory, "fixture.gguf");
    await writeFile(modelPath, model);
    await chmod(modelPath, 0o600);
    await expect(
      inspectLocalModel({
        manifest: manifest(`${origin}/model`),
        modelsDirectory,
      }),
    ).resolves.toEqual({
      status: "available",
      modelPath,
    });
  });
});
