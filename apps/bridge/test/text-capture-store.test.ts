import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { TextCaptureStore } from "../src/text-capture-store.js";

const pending = (sessionId: string, capturedAt: string) => ({
  version: 3 as const,
  sourceClient: "codex" as const,
  sessionId,
  cwd: "/tmp/project",
  assistantText: `需要为 ${sessionId} 做决定吗？`,
  capturedAt,
});

describe("TextCaptureStore cleanup", () => {
  it("actively removes expired and malformed pending text while keeping recent data", async () => {
    const path = await mkdtemp(join(tmpdir(), "decision-text-pending-"));
    const store = new TextCaptureStore(path, {
      now: () => new Date("2026-08-03T12:00:00.000Z"),
      cleanupIntervalMs: 0,
    });
    await store.save(pending("expired-session", "2026-08-01T11:59:59.000Z"));
    await writeFile(join(path, "malformed.json"), "not-json", "utf8");

    await store.save(pending("recent-session", "2026-08-03T11:00:00.000Z"));

    await expect(store.consume("codex", "expired-session")).resolves.toBeNull();
    await expect(store.consume("codex", "recent-session")).resolves.toMatchObject({
      sessionId: "recent-session",
      capturedAt: "2026-08-03T11:00:00.000Z",
    });
    expect(await readdir(path)).toEqual([".last-cleanup"]);
  });
});
