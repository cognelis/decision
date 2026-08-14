import { access, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  removeRuntimeDescriptor,
  writeRuntimeDescriptor,
} from "../src/main/runtime-file.js";

const descriptor = {
  protocolVersion: 1,
  port: 43123,
  token: "a".repeat(64),
  pid: 4242,
  startedAt: "2026-07-24T00:00:00.000Z",
} as const;

describe("runtime descriptor", () => {
  it("writes atomically with owner-only permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-runtime-"));
    const path = join(root, "nested", "runtime.json");

    await writeRuntimeDescriptor(path, descriptor);

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(descriptor);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "nested"))).mode & 0o777).toBe(0o700);
  });

  it("rejects an invalid descriptor without creating a file", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-runtime-"));
    const path = join(root, "runtime.json");

    await expect(
      writeRuntimeDescriptor(path, { ...descriptor, token: "short" }),
    ).rejects.toThrow();
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes the descriptor idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-runtime-"));
    const path = join(root, "runtime.json");
    await writeRuntimeDescriptor(path, descriptor);

    await removeRuntimeDescriptor(path);
    await removeRuntimeDescriptor(path);

    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
