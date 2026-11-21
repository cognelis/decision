import { expect, it, vi } from "vitest";
import type { PrReviewHistoryEntry } from "@cognelis/decision-protocol";

import type { PrThread } from "../src/main/pr-platform-client.js";
import { followOutcomes, readOutcomes } from "../src/main/pr-review-outcomes.js";

const reviewed = "a".repeat(40), head = "c".repeat(40), base = "b".repeat(40);
const finding = (title: string, line: number) => ({ priority: "P2" as const, title, body: `${title}。`, path: "src/a.ts", side: "new" as const, line, decisionIndexes: [] });
const entry = (published: PrReviewHistoryEntry["published"]): PrReviewHistoryEntry => ({
  id: "00000000-0000-4000-8000-000000000001", kind: "review", at: "2026-11-12T10:00:00.000Z", model: "本机", focus: "", draft: "", turns: [], events: [], state: "finished", error: "", verdicts: [], rechecks: [],
  connectionId: "00000000-0000-4000-8000-0000000000c1", published,
  snapshot: { snapshotId: "00000000-0000-4000-8000-000000000051", reference: "org/app#1", title: "PR", description: "", project: "app", sourceCommit: reviewed, destinationCommit: base, files: [{ path: "src/a.ts", status: "modified" }], warnings: [] },
  report: { status: "completed", summary: "", evidence: [], readFiles: [], unreadFiles: [], reviewedFiles: [], unreviewedFiles: [], warnings: [], steps: 1, history: [],
    findings: [finding("空值没处理", 10), finding("超时写死", 40), finding("日志太多", 80)] },
});
const thread = (id: string, line: number, body: string, replies: string[] = []): PrThread => ({ id, url: `https://code.example/c/${id}`, author: "me", login: "me", path: "src/a.ts", line, side: "new", body, createdAt: "2026-11-12T10:00:00.000Z",
  task: null, resolved: null, replies: replies.map((text, index) => ({ id: `${id}-${index}`, author: "author", login: "author", body: text, createdAt: "2026-11-13T10:00:00.000Z" })) });
// The PR moved on: a later commit rewrote lines 39 to 41 of src/a.ts as the review read it.
const rangeDiff = ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -39,3 +39,3 @@", "-const a = 1;", "-const timeout = 3000;", "-const b = 2;", "+const a = 1;", "+const timeout = options.timeout;", "+const b = 2;", ""].join("\n");

it("reads each posted finding's outcome from its thread: the author's standard reply, else a change at its place, else none", async () => {
  const client = {
    threads: vi.fn(async () => ({ threads: [
      thread("c1", 10, "**P2 · 空值没处理**\n\n…\n\n— Paraself 预评审 · P2", ["我看看", "**误报**：调用方保证不为空。\n\n— Paraself 作者回应"]),
      // Posted before ids were kept: found at its place by its title and closing line.
      thread("c2", 41, "**P2 · 超时写死**\n\n…\n\n— Paraself 预评审 · P2"),
      thread("c3", 80, "**P2 · 日志太多**\n\n…\n\n— Paraself 预评审 · P2"),
    ] })),
    get: vi.fn(async () => ({ title: "PR", source: { repository: "org/app", commit: head }, destination: { repository: "org/app", commit: base } })),
    rangeDiff: vi.fn(async () => rangeDiff),
  };
  const now = Date.parse("2026-11-14T00:00:00.000Z");
  const read = await readOutcomes(entry([{ finding: 0, at: "2026-11-12T11:00:00.000Z", comment: "c1" }, { finding: 1, at: "2026-11-12T11:00:00.000Z" }, { finding: 2, at: "2026-11-12T11:00:00.000Z", comment: "c3" }]),
    { client: async () => client, now: () => now });
  const at = new Date(now).toISOString();
  expect(read!.published).toEqual([
    { finding: 0, at: "2026-11-12T11:00:00.000Z", comment: "c1", outcome: { kind: "wrong", words: "调用方保证不为空。", at } },
    { finding: 1, at: "2026-11-12T11:00:00.000Z", comment: "c2", outcome: { kind: "maybe_fixed", at } },
    { finding: 2, at: "2026-11-12T11:00:00.000Z", comment: "c3", outcome: { kind: "none", at } },
  ]);
  expect(client.rangeDiff).toHaveBeenCalledWith(expect.objectContaining({ source: { repository: "org/app", commit: head } }), reviewed, head, undefined);
  // Read again with nothing new: nothing to save. Answered ones are read no more.
  expect(await readOutcomes(read!, { client: async () => client, now: () => now + 60_000 })).toBeNull();
  const answered = entry([{ finding: 0, at: "2026-11-12T11:00:00.000Z", comment: "c1", outcome: { kind: "fixed", at } }]);
  expect(await readOutcomes(answered, { client: async () => client })).toBeNull();
  expect(client.threads).toHaveBeenCalledTimes(2);
});

it("follows the records with findings posted lately and not answered, saving and telling only what moved", async () => {
  const now = Date.parse("2026-11-14T00:00:00.000Z");
  const recent = entry([{ finding: 0, at: "2026-11-12T11:00:00.000Z", comment: "c1" }]);
  const old = { ...entry([{ finding: 0, at: "2026-09-01T11:00:00.000Z", comment: "c1" }]), id: "00000000-0000-4000-8000-000000000002" };
  const saved: PrReviewHistoryEntry[] = [], changed: string[][] = [];
  const client = { threads: async () => ({ threads: [thread("c1", 10, "**P2 · 空值没处理**", ["**已修**：加了判断。\n\n— Paraself 作者回应"])] }),
    get: async () => ({ title: "PR", source: { repository: "org/app", commit: reviewed }, destination: { repository: "org/app", commit: base } }) };
  const ids = await followOutcomes({ client: async () => client, now: () => now, changed: (value) => changed.push(value),
    store: { list: async () => ({ entries: [recent, old], unreadable: 0 }), save: async ({ entries }) => { saved.push(...(entries as PrReviewHistoryEntry[])); return { dropped: 0, logDropped: [], refused: [] }; } } });
  expect(ids).toEqual([recent.id]);
  expect(saved.map((item) => item.published[0]!.outcome?.kind)).toEqual(["fixed"]);
  expect(changed).toEqual([[recent.id]]);
});
