import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CaptureAuditStore } from "../src/index.js";

const FIXED_SALT = Buffer.alloc(32, 7);

describe("CaptureAuditStore", () => {
  it("retains the newest receipts across read batches while expiring and quarantining others", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-audit-batches-"));
    let now = new Date("2026-07-18T00:00:00.000Z");
    const store = new CaptureAuditStore(root, {
      now: () => now,
      maximumItems: 3,
      salt: FIXED_SALT,
    });
    const expired = await store.record({
      sourceClient: "codex",
      sessionId: "synthetic",
      stage: "hook_received",
    });
    now = new Date("2026-07-27T12:00:00.000Z");
    await Promise.all(Array.from({ length: 35 }, (_, index) => {
      const receiptId = `receipt-${String(index).padStart(2, "0")}`;
      const filename = createHash("sha256").update(receiptId).digest("hex");
      return writeFile(join(root, "items", `${filename}.json`), JSON.stringify({
        ...expired,
        receiptId,
        // Equal timestamps exercise the receipt ID tie-break across batches.
        createdAt: now.toISOString(),
      }));
    }));
    for (const digit of ["e", "f"]) {
      await writeFile(join(root, "items", `${digit.repeat(64)}.json`), "not-json");
    }

    expect((await store.list()).map((receipt) => receipt.receiptId)).toEqual([
      "receipt-32", "receipt-33", "receipt-34",
    ]);
    expect(await readdir(join(root, "items"))).toHaveLength(3);
    expect(await readdir(join(root, "quarantine"))).toHaveLength(2);
  });

  it("counts the week at most once a minute, and at once again after a receipt it writes itself", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-audit-summary-"));
    let now = new Date("2026-07-27T12:00:00.000Z");
    const store = new CaptureAuditStore(root, { now: () => now, salt: FIXED_SALT });
    const receipt = { sourceClient: "codex", sessionId: "one", stage: "hook_received" } as const;
    await store.record(receipt);
    expect((await store.summary()).total).toBe(1);

    // The bridge, a process of its own, writes one: counted within the minute, not read again at every turn.
    await new CaptureAuditStore(root, { now: () => now, salt: FIXED_SALT }).record(receipt);
    expect((await store.summary()).total).toBe(1);
    now = new Date(now.getTime() + 61_000);
    expect((await store.summary()).total).toBe(2);

    // One it writes itself counts at once.
    await store.record(receipt);
    expect((await store.summary()).total).toBe(3);
  });

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

  it("replaces a salt cut short, and tries again after a read the disk refused", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-audit-salt-"));
    const store = new CaptureAuditStore(root, { now: () => new Date("2026-07-27T12:00:00.000Z") });
    const receipt = { sourceClient: "codex", sessionId: "session", stage: "hook_received" } as const;
    // Not readable as a file once: the next record reads it again.
    await mkdir(join(root, "salt"), { recursive: true });
    await expect(store.record(receipt)).rejects.toThrow();
    await rm(join(root, "salt"), { recursive: true });
    // Cut short by an earlier version's write: replaced, not refused for good.
    await writeFile(join(root, "salt"), Buffer.alloc(10, 1));

    await expect(store.record(receipt)).resolves.toMatchObject({ stage: "hook_received" });
    expect(await readFile(join(root, "salt"))).toHaveLength(32);
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
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
      // A lost pair and a routing error are terminal; an unavailable provider
      // and a classification timeout still fall back to the rules.
      failures: 2,
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

  it("applies retention from record at most hourly, so a hook does not read a week of receipts", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-audit-throttle-"));
    let now = new Date("2026-07-27T12:00:00.000Z");
    const store = new CaptureAuditStore(root, { now: () => now, salt: FIXED_SALT });
    const receipt = { sourceClient: "codex", sessionId: "synthetic", stage: "hook_received" } as const;
    await store.record(receipt);
    // Only a scan moves this aside: a record that scans quarantines it.
    await writeFile(join(root, "items", `${"e".repeat(64)}.json`), "not-json");

    now = new Date("2026-07-27T12:59:00.000Z");
    await store.record(receipt);
    expect(await readdir(join(root, "quarantine"))).toHaveLength(0);

    now = new Date("2026-07-27T13:01:00.000Z");
    await store.record(receipt);
    expect(await readdir(join(root, "quarantine"))).toHaveLength(1);
  });
});
