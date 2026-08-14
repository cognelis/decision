import type { SemanticDecisionPair } from "@cognelis/decision-protocol";
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

import { SemanticPairSpool } from "../src/index.js";

const pairFixture = (
  id: string,
  capturedAt = "2026-07-27T00:00:00.000Z",
  expiresAt = "2026-08-03T00:00:00.000Z",
): SemanticDecisionPair => ({
  version: 1,
  pairId: id,
  sourceClient: "codex",
  sessionId: "session-private",
  assistantTurnId: "assistant-private",
  userTurnId: "user-private",
  cwd: "/Users/private/project",
  assistantText: "先处理技术债，还是先提交？",
  userText: "本次引入的需要处理。另外，为什么要拆字段？",
  capturedAt,
  expiresAt,
});

describe("SemanticPairSpool", () => {
  it("atomically stores one private pair and removes it after acknowledgement", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "decision-semantic-pair-"),
    );
    const spool = new SemanticPairSpool(root, {
      now: () => new Date("2026-07-28T00:00:00.000Z"),
    });
    const pair = pairFixture("pair-private");

    await expect(spool.append(pair)).resolves.toBe("accepted");
    await expect(spool.append(pair)).resolves.toBe("duplicate");
    await expect(spool.list()).resolves.toEqual([pair]);

    const [filename] = await readdir(join(root, "items"));
    if (filename === undefined) {
      throw new Error("semantic pair fixture missing");
    }
    expect(filename).toMatch(/^[a-f0-9]{64}\.json$/u);
    expect(filename).not.toContain(pair.pairId);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "items"))).mode & 0o777).toBe(
      0o700,
    );
    expect(
      (await stat(join(root, "items", filename))).mode & 0o777,
    ).toBe(0o600);
    expect(
      await readFile(join(root, "items", filename), "utf8"),
    ).toContain(pair.assistantText);

    await spool.acknowledge(pair.pairId);

    await expect(spool.list()).resolves.toEqual([]);
    await expect(spool.isAcknowledged(pair.pairId)).resolves.toBe(
      true,
    );
    const [receipt] = await readdir(join(root, "receipts"));
    if (receipt === undefined) {
      throw new Error("semantic receipt fixture missing");
    }
    expect((await stat(join(root, "receipts", receipt))).size).toBe(
      0,
    );
  });

  it("accepts a concurrent pair only once", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "decision-semantic-concurrent-"),
    );
    const pair = pairFixture("pair-concurrent");
    const spools = Array.from(
      { length: 8 },
      () =>
        new SemanticPairSpool(root, {
          now: () => new Date("2026-07-28T00:00:00.000Z"),
        }),
    );

    const results = await Promise.all(
      spools.map((spool) => spool.append(pair)),
    );

    expect(
      results.filter((result) => result === "accepted"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result === "duplicate"),
    ).toHaveLength(7);
    await expect(spools[0]?.list()).resolves.toEqual([pair]);
  });

  it("expires old pairs and keeps only the newest configured capacity", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "decision-semantic-retention-"),
    );
    const spool = new SemanticPairSpool(root, {
      now: () => new Date("2026-07-28T00:00:00.000Z"),
      maximumItems: 2,
    });
    await spool.append(
      pairFixture(
        "expired",
        "2026-07-20T00:00:00.000Z",
        "2026-07-27T00:00:00.000Z",
      ),
    );
    for (let index = 0; index < 3; index += 1) {
      await spool.append(
        pairFixture(
          `pair-${index}`,
          new Date(
            Date.parse("2026-07-28T00:00:00.000Z") + index * 1_000,
          ).toISOString(),
          "2026-08-04T00:00:00.000Z",
        ),
      );
    }

    expect(
      (await spool.list()).map((pair) => pair.pairId),
    ).toEqual(["pair-1", "pair-2"]);
  });

  it("quarantines corrupt bodies and keeps valid bodies after a consumer failure", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "decision-semantic-corrupt-"),
    );
    const spool = new SemanticPairSpool(root, {
      now: () => new Date("2026-07-28T00:00:00.000Z"),
    });
    const pair = pairFixture("pair-retry");
    await spool.append(pair);
    await writeFile(
      join(root, "items", `${"f".repeat(64)}.json`),
      "{private corrupt contents",
      { encoding: "utf8", mode: 0o600 },
    );

    const pending = await spool.list();
    await expect(
      Promise.reject(new Error(`consumer failed for ${pending[0]?.pairId}`)),
    ).rejects.toThrow("consumer failed");

    await expect(spool.list()).resolves.toEqual([pair]);
    await expect(readdir(join(root, "quarantine"))).resolves.toHaveLength(
      1,
    );
  });
});
