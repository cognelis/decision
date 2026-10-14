import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

// Each receipt read takes a tick: a listing of a hundred is in progress long enough for a claim to start meanwhile.
const counted = vi.hoisted(() => ({ readFile: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      counted.readFile += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return (actual.readFile as (...inner: Parameters<typeof actual.readFile>) => Promise<unknown>)(...args);
    }) as typeof actual.readFile,
  };
});

import { CaptureSpool } from "../src/capture-spool.js";

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

it("finds a receipt written while the hourly tidy is still reading the others, for a claim that starts meanwhile", async () => {
  const root = join(await mkdtemp(join(tmpdir(), "spool-receipt-race-")), "capture-spool");
  const spool = new CaptureSpool(root);
  const at = new Date().toISOString();
  for (let index = 0; index < 120; index += 1) {
    await spool.rememberSemanticOccurrence(sha(`o${index}`), sha(`k${index}`), "structured_tool", at);
  }

  // No marker yet: list() tidies, and the tidy reads every receipt.
  counted.readFile = 0;
  const listing = spool.list();
  while (counted.readFile < 30) await tick();
  // Written while the tidy reads (after its readdir): the twin's receipt; a claim for it starts now.
  await spool.rememberSemanticOccurrence(sha("twin"), sha("k-twin"), "structured_tool", at);
  const claim = spool.claimCrossModeSemantic(sha("k-twin"), "transcript", at, 30 * 60 * 1000, sha("alias-twin"));
  const [, claimed] = await Promise.all([listing, claim]);

  // Read in by the claim, the receipt was dropped by the tidy as one gone, and the claim said no twin with it on disk.
  expect(claimed).toBe(true);
});
