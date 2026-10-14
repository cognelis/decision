import { mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
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
  it("keeps cleaning up after a hook ran under a clock that ran ahead", async () => {
    const path = await mkdtemp(join(tmpdir(), "decision-text-pending-"));
    let now = new Date("2027-10-05T09:00:00.000Z"); // a date typed a year ahead: the cleanup marker says 2027
    const store = new TextCaptureStore(path, { now: () => now });
    await store.save(pending("while-ahead", now.toISOString()));

    now = new Date("2026-10-05T09:00:00.000Z");
    await store.save(pending("left-unanswered", now.toISOString()));
    now = new Date("2026-10-08T09:00:00.000Z");
    await store.save(pending("another-session", now.toISOString()));

    // Trusted, the marker skipped every cleanup until 2027: the turn from the clock ahead and the one left three
    // days ago stayed, the assistant's text in each.
    expect((await readdir(path)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    await expect(store.consume("codex", "another-session")).resolves.toMatchObject({ pending: expect.objectContaining({ sessionId: "another-session" }) });
  });

  it("removes what a hook cut short left behind, once a pending turn would have gone", async () => {
    const path = await mkdtemp(join(tmpdir(), "decision-text-pending-"));
    // Killed after taking a turn and before reading it, or while writing one: a hook has five seconds.
    await writeFile(join(path, "abc.json.consuming-1234"), JSON.stringify(pending("cut-short", new Date().toISOString())), "utf8");
    await writeFile(join(path, "abc.json.5678.tmp"), "{\"assistantText\":", "utf8");
    const leftovers = async () => (await readdir(path)).filter((name) => name.includes(".consuming-") || name.endsWith(".tmp"));

    await new TextCaptureStore(path, { now: () => new Date(Date.now() + 60_000), cleanupIntervalMs: 0 }).pruneExpired();
    expect(await leftovers()).toHaveLength(2);
    // One dated by a clock a year ahead: it goes with the others once a pending turn would have, not in a year.
    await writeFile(join(path, "abc.json.consuming-9999"), "{}", "utf8");
    const ahead = new Date(Date.now() + 365 * 86_400_000);
    await utimes(join(path, "abc.json.consuming-9999"), ahead, ahead);
    // Kept for good, the assistant's text outlived the day a pending turn is kept.
    await new TextCaptureStore(path, { now: () => new Date(Date.now() + 2 * 86_400_000), cleanupIntervalMs: 0 }).pruneExpired();
    expect(await leftovers()).toEqual([]);
  });

  it("actively removes expired and malformed pending text while keeping recent data", async () => {
    const path = await mkdtemp(join(tmpdir(), "decision-text-pending-"));
    const store = new TextCaptureStore(path, {
      now: () => new Date("2026-08-03T12:00:00.000Z"),
      cleanupIntervalMs: 0,
    });
    await store.save(pending("expired-session", "2026-08-01T11:59:59.000Z"));
    await writeFile(join(path, "malformed.json"), "not-json", "utf8");

    await store.save(pending("recent-session", "2026-08-03T11:00:00.000Z"));

    await expect(store.consume("codex", "expired-session")).resolves.toEqual({
      pending: null,
      reason: "absent",
    });
    await expect(store.consume("codex", "missing-session")).resolves.toEqual({
      pending: null,
      reason: "absent",
    });
    await expect(store.consume("codex", "recent-session")).resolves.toMatchObject({
      pending: {
        sessionId: "recent-session",
        capturedAt: "2026-08-03T11:00:00.000Z",
      },
    });
    expect(await readdir(path)).toEqual([".last-cleanup"]);
  });

  it("names every pending turn it drops, without its text", async () => {
    const path = await mkdtemp(join(tmpdir(), "decision-text-pending-"));
    const dropped: unknown[] = [];
    const store = new TextCaptureStore(path, {
      now: () => new Date("2026-08-03T12:00:00.000Z"),
      cleanupIntervalMs: 0,
      onExpired: (turn) => {
        dropped.push(turn);
      },
    });
    await store.save({
      ...pending("aged-session", "2026-08-01T11:59:59.000Z"),
      turnId: "assistant-turn",
    });
    await writeFile(join(path, "malformed.json"), "not-json", "utf8");
    await store.save(pending("recent-session", "2026-08-03T11:00:00.000Z"));

    expect(dropped).toEqual([
      {
        sourceClient: "codex",
        sessionId: "aged-session",
        turnId: "assistant-turn",
        capturedAt: "2026-08-01T11:59:59.000Z",
      },
    ]);
    expect(JSON.stringify(dropped)).not.toContain("做决定");
  });

  it("still cleans up when reporting the loss throws", async () => {
    const path = await mkdtemp(join(tmpdir(), "decision-text-pending-"));
    const store = new TextCaptureStore(path, {
      now: () => new Date("2026-08-03T12:00:00.000Z"),
      cleanupIntervalMs: 0,
      onExpired: () => {
        throw new Error("audit unavailable");
      },
    });
    await store.save(pending("aged-session", "2026-08-01T11:59:59.000Z"));

    await expect(
      store.save(pending("recent-session", "2026-08-03T11:00:00.000Z")),
    ).resolves.toBeUndefined();
    expect(
      (await readdir(path)).filter((name) => name.endsWith(".json")),
    ).toHaveLength(1);
  });

  it("reports a pending turn that aged out before the next cleanup was due", async () => {
    const path = await mkdtemp(join(tmpdir(), "decision-text-pending-"));
    let now = new Date("2026-08-01T12:00:00.000Z");
    const store = new TextCaptureStore(path, {
      now: () => now,
      cleanupIntervalMs: 30 * 24 * 60 * 60 * 1_000,
    });
    await store.save(pending("aged-session", now.toISOString()));
    now = new Date("2026-08-02T13:00:00.000Z");

    await expect(store.consume("codex", "aged-session")).resolves.toEqual({
      pending: null,
      reason: "expired",
    });
  });
});
