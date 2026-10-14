import { createHash } from "node:crypto";
import { mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { CaptureSpool } from "../src/capture-spool.js";

// Counted, not stubbed: how many files a list and a claim open.
const counted = vi.hoisted(() => ({ readFile: 0, stat: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: ((...args: Parameters<typeof actual.readFile>) => {
      counted.readFile += 1;
      return (actual.readFile as (...inner: Parameters<typeof actual.readFile>) => ReturnType<typeof actual.readFile>)(...args);
    }) as typeof actual.readFile,
    stat: ((...args: Parameters<typeof actual.stat>) => {
      counted.stat += 1;
      return (actual.stat as (...inner: Parameters<typeof actual.stat>) => ReturnType<typeof actual.stat>)(...args);
    }) as typeof actual.stat,
  };
});

const DAY = 24 * 60 * 60 * 1_000;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

const event = (index: number, capturedAt: string) => ({
  eventVersion: 1 as const, captureMode: "structured_tool" as const, sourceClient: "codex" as const,
  sessionId: `s-${index}`, toolUseId: `t-${index}`, batchId: `b-${index}`, project: "p", cwd: "/p", capturedAt,
  questions: [{ questionIndex: 0, question: `q${index}`, options: [], answer: { kind: "custom" as const, values: ["a"] }, multiSelect: false }],
});

// Tidied once an hour: an hour on.
const hourOn = (root: string) => writeFile(join(root, ".last-cleanup"), String(Date.now() - 2 * 60 * 60 * 1_000), "utf8");

it("forgets what it remembered of questions handled long ago, and keeps what a waiting event may still need", async () => {
  const root = join(await mkdtemp(join(tmpdir(), "capture-spool-retention-")), "capture-spool");
  const spool = new CaptureSpool(root);
  const age = async (directory: string, days: number) => {
    for (const name of await readdir(join(root, directory))) {
      const then = new Date(Date.now() - days * DAY);
      await utimes(join(root, directory, name), then, then);
    }
  };

  // Handled and done with: kept for good, every one, and each capture read all the semantic ones.
  const handled = event(0, new Date(Date.now() - 200 * DAY).toISOString());
  await spool.append(handled);
  await spool.rememberSemanticOccurrence(sha("o0"), sha("k0"), "structured_tool", handled.capturedAt);
  await spool.acknowledge(handled, 0);
  await age("receipts", 179);
  await spool.list();
  expect(await readdir(join(root, "semantic-receipts"))).toEqual([]);
  // An acknowledgement keeps a question read again from being asked twice: half a year.
  expect(await readdir(join(root, "receipts"))).toHaveLength(1);
  await age("receipts", 181);
  await hourOn(root);
  await spool.list();
  expect(await readdir(join(root, "receipts"))).toEqual([]);

  // An event still waiting (the app was closed for days) may meet its twin from the other mode as of when it
  // was captured: what was remembered since a day before it stays.
  const waiting = event(1, new Date(Date.now() - 10 * DAY).toISOString());
  await spool.append(waiting);
  await spool.rememberSemanticOccurrence(sha("o1"), sha("k1"), "structured_tool", waiting.capturedAt);
  await hourOn(root);
  await spool.list();
  expect(await readdir(join(root, "semantic-receipts"))).toHaveLength(1);

  // A receipt cut short by a crash: read as it was, it failed every list, and no question waiting was asked.
  await writeFile(join(root, "semantic-receipts", `${sha("broken")}.json`), "{\"capturedAt\":", "utf8");
  await hourOn(root);
  await expect(spool.list()).resolves.toHaveLength(1);
  const receipts = await readdir(join(root, "semantic-receipts"));
  expect([receipts.filter((name) => name.endsWith(".json")).length, receipts.filter((name) => name.includes(".corrupt-")).length]).toEqual([1, 1]);
});

it("reads each semantic receipt once and tidies once an hour, where every capture read and stat()ed all of them", async () => {
  const root = join(await mkdtemp(join(tmpdir(), "capture-spool-reads-")), "capture-spool");
  const spool = new CaptureSpool(root);
  const at = new Date().toISOString();
  for (let index = 0; index < 20; index += 1) {
    await spool.rememberSemanticOccurrence(sha(`o${index}`), sha(`k${index}`), "structured_tool", at);
    const handled = event(index, at);
    await spool.append(handled);
    await spool.acknowledge(handled, 0);
  }
  await spool.list();

  // A capture's twin is looked for among the receipts: read once and kept, so only one written since is read.
  counted.readFile = 0;
  await expect(spool.claimCrossModeSemantic(sha("k3"), "transcript", at, 30 * 60 * 1_000, sha("alias-3"))).resolves.toBe(true);
  expect(counted.readFile).toBeLessThan(20);
  await spool.rememberSemanticOccurrence(sha("o20"), sha("k20"), "structured_tool", at);
  counted.readFile = 0;
  await expect(spool.claimCrossModeSemantic(sha("k20"), "transcript", at, 30 * 60 * 1_000, sha("alias-20"))).resolves.toBe(true);
  expect(counted.readFile).toBeLessThan(20);

  // Listed again within the hour, no acknowledgement is stat()ed for its age again.
  counted.stat = 0;
  await spool.list();
  expect(counted.stat).toBe(0);
});
