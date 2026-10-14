import type {
  CapturedDecisionCandidate,
  CapturedDecisionEvent,
} from "@cognelis/decision-protocol";
import {
  chmod,
  mkdtemp,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CandidateSpool } from "../src/index.js";

const eventFixture = (
  id: string,
  capturedAt: string,
): CapturedDecisionEvent => ({
  eventVersion: 1,
  captureMode: "transcript",
  sourceClient: "codex",
  sessionId: "session-1",
  sourceEventId: `event-${id}`,
  batchId: `batch-${id}`,
  project: "decision",
  cwd: "/tmp/decision",
  capturedAt,
  detection: {
    band: "medium",
    score: 60,
    detectorVersion: "rules-v1",
    signals: ["awaits_confirmation"],
  },
  questions: [
    {
      questionIndex: 0,
      question: "现在继续吗？",
      options: [],
      answer: { kind: "custom", values: ["可以"] },
      multiSelect: false,
    },
  ],
});

const candidateFixture = (
  id: string,
  createdAt = "2026-07-27T00:00:00.000Z",
  expiresAt = "2026-08-03T00:00:00.000Z",
): CapturedDecisionCandidate => ({
  candidateVersion: 1,
  candidateId: id,
  createdAt,
  expiresAt,
  event: eventFixture(id, createdAt),
});

describe("CandidateSpool", () => {
  it("stores one opaque private body and acknowledges it with a content-free receipt", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "decision-candidate-spool-"),
    );
    const spool = new CandidateSpool(root, {
      now: () => new Date("2026-07-28T00:00:00.000Z"),
    });
    const candidate = candidateFixture("candidate-private");

    await spool.append(candidate);
    await spool.append(candidate);
    expect(await spool.list()).toEqual([candidate]);

    const itemFiles = await readdir(join(root, "items"));
    expect(itemFiles).toHaveLength(1);
    expect(itemFiles[0]).toMatch(/^[a-f0-9]{64}\.json$/u);
    expect(itemFiles[0]).not.toContain("candidate-private");
    expect((await stat(join(root, "items"))).mode & 0o777).toBe(
      0o700,
    );
    expect(
      (await stat(join(root, "items", itemFiles[0]!))).mode &
        0o777,
    ).toBe(0o600);

    await spool.acknowledge(candidate.candidateId);

    expect(await spool.list()).toEqual([]);
    expect(
      await spool.isAcknowledged(candidate.candidateId),
    ).toBe(true);
    const receipts = await readdir(join(root, "receipts"));
    expect(receipts).toHaveLength(1);
    expect(
      (await stat(join(root, "receipts", receipts[0]!))).size,
    ).toBe(0);
  });

  it("removes expired items and keeps only the newest 100 candidates", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "decision-candidate-capacity-"),
    );
    const spool = new CandidateSpool(root, {
      now: () => new Date("2026-07-28T00:00:00.000Z"),
    });
    await spool.append(
      candidateFixture(
        "expired",
        "2026-07-20T00:00:00.000Z",
        "2026-07-27T00:00:00.000Z",
      ),
    );
    for (let index = 0; index < 101; index += 1) {
      const day = String(index + 1).padStart(3, "0");
      await spool.append(
        candidateFixture(
          `candidate-${day}`,
          new Date(
            Date.parse("2026-07-28T00:00:00.000Z") + index * 1_000,
          ).toISOString(),
          "2026-08-10T00:00:00.000Z",
        ),
      );
    }

    const candidates = await spool.list();

    expect(candidates).toHaveLength(100);
    expect(candidates[0]?.candidateId).toBe("candidate-002");
    expect(candidates.at(-1)?.candidateId).toBe(
      "candidate-101",
    );
  });

  it("lets go a candidate written under a clock that ran ahead", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-candidate-ahead-"));
    const spool = new CandidateSpool(root, { now: () => new Date("2026-07-28T00:00:00.000Z") });
    await spool.append(candidateFixture("while-ahead", "2027-07-27T00:00:00.000Z", "2027-08-03T00:00:00.000Z"));
    await spool.append(candidateFixture("ordinary"));

    // Kept as dated, the exchange said to go after 7 days stayed until August 2027.
    expect((await spool.list()).map((candidate) => candidate.candidateId)).toEqual(["ordinary"]);
  });

  it("quarantines corrupt bodies without returning their contents", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "decision-candidate-corrupt-"),
    );
    const spool = new CandidateSpool(root, {
      now: () => new Date("2026-07-28T00:00:00.000Z"),
    });
    await spool.append(candidateFixture("candidate-corrupt"));
    const [file] = await readdir(join(root, "items"));
    if (file === undefined) {
      throw new Error("candidate fixture missing");
    }
    await writeFile(
      join(root, "items", file),
      "{private corrupt contents",
      "utf8",
    );

    await expect(spool.list()).resolves.toEqual([]);
    expect(
      (await readdir(join(root, "quarantine"))).some((name) =>
        name.startsWith(file),
      ),
    ).toBe(true);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("keeps a body it cannot read now, to read it again", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-candidate-unread-"));
    const spool = new CandidateSpool(root, { now: () => new Date("2026-07-28T00:00:00.000Z") });
    const candidate = candidateFixture("candidate-held");
    await spool.append(candidate);
    const [file] = await readdir(join(root, "items"));
    await chmod(join(root, "items", file!), 0o000);

    await expect(spool.list()).resolves.toEqual([]);
    expect(await readdir(join(root, "quarantine"))).toEqual([]);

    await chmod(join(root, "items", file!), 0o600);
    await expect(spool.list()).resolves.toEqual([candidate]);
  });
});
