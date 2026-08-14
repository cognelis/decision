import {
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CaptureAuditStore } from "../src/index.js";

const FIXED_SALT = Buffer.alloc(32, 7);

describe("CaptureAuditStore", () => {
  it("records only HMAC identifiers in private files", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-audit-"));
    const store = new CaptureAuditStore(root, {
      now: () => new Date("2026-07-27T12:00:00.000Z"),
      salt: FIXED_SALT,
      idFactory: () => "receipt-private",
    });

    await store.record({
      sourceClient: "codex",
      sessionId: "raw-session",
      turnId: "raw-turn",
      stage: "pair_spooled",
      textSource: "transcript_tail",
      durationMs: 12,
    });

    const [receipt] = await store.list();
    expect(receipt).toMatchObject({
      receiptId: "receipt-private",
      sourceClient: "codex",
      stage: "pair_spooled",
      durationMs: 12,
    });
    expect(receipt?.sessionFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt?.turnFingerprint).toMatch(/^[a-f0-9]{64}$/u);

    const [filename] = await readdir(join(root, "items"));
    if (filename === undefined) {
      throw new Error("audit receipt fixture missing");
    }
    const serialized = await readFile(
      join(root, "items", filename),
      "utf8",
    );
    expect(serialized).not.toContain("raw-session");
    expect(serialized).not.toContain("raw-turn");
    expect(serialized).not.toContain("/Users/");
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "items"))).mode & 0o777).toBe(
      0o700,
    );
    expect(
      (await stat(join(root, "items", filename))).mode & 0o777,
    ).toBe(0o600);
  });

  it("uses stable installation-salted fingerprints", async () => {
    const firstRoot = await mkdtemp(
      join(tmpdir(), "decision-audit-first-"),
    );
    const secondRoot = await mkdtemp(
      join(tmpdir(), "decision-audit-second-"),
    );
    const create = (root: string, salt: Buffer) =>
      new CaptureAuditStore(root, {
        salt,
        now: () => new Date("2026-07-27T12:00:00.000Z"),
      });
    const first = create(firstRoot, FIXED_SALT);
    const sameSalt = create(secondRoot, FIXED_SALT);

    await first.record({
      sourceClient: "claude-code",
      sessionId: "session",
      stage: "hook_received",
    });
    await sameSalt.record({
      sourceClient: "claude-code",
      sessionId: "session",
      stage: "pending_saved",
    });

    const firstReceipt = (await first.list())[0];
    const secondReceipt = (await sameSalt.list())[0];
    expect(firstReceipt?.sessionFingerprint).toBe(
      secondReceipt?.sessionFingerprint,
    );
    expect(await first.fingerprint("session")).toBe(
      firstReceipt?.sessionFingerprint,
    );
  });

  it("expires seven-day receipts and keeps the newest capacity", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "decision-audit-retention-"),
    );
    let now = new Date("2026-07-18T00:00:00.000Z");
    let sequence = 0;
    const store = new CaptureAuditStore(root, {
      salt: FIXED_SALT,
      now: () => now,
      idFactory: () => `receipt-${sequence++}`,
      maximumItems: 3,
    });
    await store.record({
      sourceClient: "codex",
      sessionId: "expired",
      stage: "hook_received",
    });
    now = new Date("2026-07-27T00:00:00.000Z");
    for (const stage of [
      "hook_received",
      "pending_saved",
      "pair_spooled",
      "routed",
    ] as const) {
      await store.record({
        sourceClient: "codex",
        sessionId: stage,
        stage,
      });
      now = new Date(now.getTime() + 1_000);
    }

    const receipts = await store.list();

    expect(receipts).toHaveLength(3);
    expect(receipts.map((receipt) => receipt.stage)).toEqual([
      "pending_saved",
      "pair_spooled",
      "routed",
    ]);
  });

  it("quarantines corrupt receipts and summarizes content-free stages", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "decision-audit-corrupt-"),
    );
    let sequence = 0;
    const store = new CaptureAuditStore(root, {
      salt: FIXED_SALT,
      now: () => new Date("2026-07-27T12:00:00.000Z"),
      idFactory: () => `receipt-${sequence++}`,
    });
    await store.record({
      sourceClient: "codex",
      sessionId: "one",
      stage: "classification_completed",
      ruleBand: "high",
      modelBand: "high",
      finalBand: "high",
    });
    for (const errorCode of [
      "pair_not_found",
      "provider_unavailable",
      "classification_timeout",
      "routing_failed",
    ] as const) {
      await store.record({
        sourceClient: "codex",
        sessionId: errorCode,
        stage: "failed",
        errorCode,
      });
    }
    await store.record({
      sourceClient: "codex",
      sessionId: "one",
      stage: "routed",
      ruleBand: "high",
      modelBand: "high",
      finalBand: "high",
    });
    await writeFile(
      join(root, "items", `${"f".repeat(64)}.json`),
      "{private corrupt contents",
      { encoding: "utf8", mode: 0o600 },
    );

    expect(await store.list()).toHaveLength(6);
    expect(await readdir(join(root, "quarantine"))).toHaveLength(1);
    expect(await store.summary()).toEqual({
      total: 6,
      processed: 1,
      high: 1,
      medium: 0,
      failures: 1,
      stages: {
        classification_completed: 1,
        failed: 4,
        routed: 1,
      },
      errorCodes: {
        pair_not_found: 1,
        provider_unavailable: 1,
        classification_timeout: 1,
        routing_failed: 1,
      },
    });
  });
});
