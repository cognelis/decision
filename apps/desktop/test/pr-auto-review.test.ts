import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { PrConnection, PrConnectionInput, PrListItem, PrReviewHistoryEntry, PrReviewRunToolRequest, PrReviewRunToolResult, RetrievalAnswerProvider } from "@cognelis/decision-protocol";

import { PrAutoReviewUsage, autoReviewPass, localDay, reviewSettingsFor, updateReviewSettings } from "../src/main/pr-auto-review.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const usageFile = async () => { const root = await mkdtemp(join(tmpdir(), "paraself-auto-review-")); roots.push(root); return join(root, "pr-auto-review.json"); };

const on = { id: "00000000-0000-4000-8000-0000000000c1", label: "团队 Bitbucket", platform: "bitbucket-server", baseUrl: "https://code.example",
  recognition: { profileId: "local", skipAuthors: ["ci-bot"] }, autoReview: { profileId: "local", dailyReviews: 2 } } as PrConnection;
const off = { id: "00000000-0000-4000-8000-0000000000c2", label: "GitHub", platform: "github", baseUrl: "https://github.com" } as PrConnection;
const now = Date.parse("2026-11-19T09:00:00.000Z");
const sha = (c: string) => c.repeat(40);
const pr = (n: number, updatedAt: string): PrListItem => ({ reference: `TEAM/app#${n}`, title: `PR ${n}`, repository: "TEAM/app", number: String(n), author: "a", updatedAt });
let ids = 0;
const review = (n: number, at: string, commit: string, more: Partial<PrReviewHistoryEntry> = {}): PrReviewHistoryEntry => ({
  id: `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`, kind: "review", at, model: "本机", focus: "", draft: "", turns: [], events: [], state: "finished", error: "",
  published: [], verdicts: [], rechecks: [], connectionId: on.id,
  snapshot: { snapshotId: "00000000-0000-4000-8000-000000000051", reference: `TEAM/app#${n}`, title: `PR ${n}`, description: "", project: "app", sourceCommit: commit, destinationCommit: sha("b"), files: [], warnings: [] },
  report: { status: "completed", summary: "", findings: [], evidence: [], readFiles: [], unreadFiles: [], reviewedFiles: [], unreviewedFiles: [], warnings: [], steps: 1, history: [] },
  ...more,
});

it("pre-reviews the newest PR waiting for the user that is new or moved on, within the link's day and before its third round", async () => {
  const entries = [
    // #1: three rounds with reports already; talking it over beats a fourth.
    review(1, "2026-11-18T10:00:00.000Z", sha("1")), review(1, "2026-11-17T10:00:00.000Z", sha("2")), review(1, "2026-11-16T10:00:00.000Z", sha("3")),
    // #2: updated since its review, by a comment; the commits did not move.
    review(2, "2026-11-18T10:00:00.000Z", sha("4")),
    // #3: not updated since its review: not even read.
    review(3, "2026-11-18T10:00:00.000Z", sha("5")),
    // #4: moved on, but pre-reviewing that commit failed: not tried again by itself.
    review(4, "2026-11-18T12:00:00.000Z", sha("7"), { auto: true, state: "failed", report: null }), review(4, "2026-11-18T10:00:00.000Z", sha("6")),
  ];
  const heads: Record<string, string> = { "TEAM/app#2": sha("4"), "TEAM/app#4": sha("7"), "TEAM/app#5": sha("8") };
  const started: PrReviewRunToolRequest[] = [];
  let answer: PrReviewRunToolResult["status"] = "started";
  const usage = new PrAutoReviewUsage(await usageFile());
  const sources = {
    connections: async () => [off, on],
    pullRequests: vi.fn(async () => ({ items: [pr(1, "2026-11-19T08:00:00.000Z"), pr(2, "2026-11-19T08:00:00.000Z"), pr(3, "2026-11-17T08:00:00.000Z"), pr(4, "2026-11-19T08:00:00.000Z"), pr(5, "2026-11-19T08:00:00.000Z")], nextPage: null })),
    head: vi.fn(async (_: string, reference: string) => heads[reference]!),
    history: { list: async () => ({ entries, unreadable: 0 }), save: async () => undefined },
    running: () => false,
    start: async (request: PrReviewRunToolRequest) => {
      started.push(request);
      return { status: answer, reason: null, run: answer === "started" ? { id: "00000000-0000-4000-8000-0000000000aa" } : null } as unknown as PrReviewRunToolResult;
    },
    usage, now: () => now,
  };
  expect(await autoReviewPass(sources)).toEqual({ connectionId: on.id, reference: "TEAM/app#5", id: "00000000-0000-4000-8000-0000000000aa" });
  // Only the link turned on is listed; #3 not read at all; what came after the last review, with the link's model.
  expect(sources.pullRequests).toHaveBeenCalledTimes(1);
  expect(sources.pullRequests).toHaveBeenCalledWith({ connectionId: on.id, filter: "review-requested", page: 1 });
  expect(sources.head.mock.calls.map(([, reference]) => reference)).toEqual(["TEAM/app#2", "TEAM/app#4", "TEAM/app#5"]);
  expect(started).toEqual([{ prReviewToolsVersion: 1, connection: on.id, reference: "TEAM/app#5", scope: "since_last_review", focus: "", model: "local" }]);
  expect(await usage.used(on.id, localDay(now))).toBe(1);

  // One review at a time: none while one runs; one started elsewhere meanwhile, nothing spent.
  expect(await autoReviewPass({ ...sources, running: () => true })).toBeNull();
  answer = "busy";
  expect(await autoReviewPass(sources)).toBeNull();
  expect(await usage.used(on.id, localDay(now))).toBe(1);
  // The day's reviews spent: the link's PRs are not even listed until tomorrow.
  answer = "started";
  await autoReviewPass(sources);
  sources.pullRequests.mockClear();
  expect(await autoReviewPass(sources)).toBeNull();
  expect(sources.pullRequests).not.toHaveBeenCalled();
  expect(await new PrAutoReviewUsage((usage as unknown as { path: string }).path).used(on.id, localDay(now))).toBe(2);
  expect(await usage.used(on.id, localDay(now + 86_400_000))).toBe(0);
});

it("reads and sets each link's 自动预评审, leaving the rest of the link as it was", async () => {
  let saved = [on, off];
  const models = [
    { profileId: "apple", label: "Apple", kind: "apple", model: null, leavesDevice: false },
    { profileId: "local", label: "本机", kind: "qwen", model: "qwen3", leavesDevice: false },
    { profileId: "remote", label: "云端", kind: "anthropic", model: null, leavesDevice: true },
  ] as RetrievalAnswerProvider[];
  const usage = new PrAutoReviewUsage(await usageFile());
  await usage.spend(on.id, localDay(now));
  const sources = { connections: async () => saved, models: async () => models, usage, now: () => now,
    save: async (input: PrConnectionInput) => { saved = saved.map((item) => item.id === input.id ? { ...input, id: item.id } as PrConnection : item); return saved; } };

  const read = await reviewSettingsFor({}, sources);
  expect(read.models.map((model) => model.id)).toEqual(["local", "remote"]);
  expect(read.settings).toEqual([
    { connectionId: on.id, label: "团队 Bitbucket", platform: "bitbucket-server", autoReview: { profileId: "local", model: "本机 · qwen3", dailyReviews: 2 }, usedToday: 1 },
    { connectionId: off.id, label: "GitHub", platform: "github", autoReview: null, usedToday: 0 },
  ]);
  expect((await reviewSettingsFor({ connection: "不存在" }, sources)).status).toBe("connection_not_found");

  // On with nothing said: the first model that writes, five a day.
  const turnedOn = await updateReviewSettings({ prReviewToolsVersion: 1, connection: "GitHub", autoReview: true }, sources);
  expect(turnedOn).toMatchObject({ status: "updated", settings: { autoReview: { profileId: "local", dailyReviews: 5 } } });
  expect(saved[1]).toEqual({ ...off, autoReview: { profileId: "local", dailyReviews: 5 } });
  expect((await updateReviewSettings({ prReviewToolsVersion: 1, connection: "GitHub", autoReview: true, model: "Apple" }, sources)).status).toBe("model_not_found");
  // Off: only 自动预评审 goes; the link's comment recognition stays.
  expect(await updateReviewSettings({ prReviewToolsVersion: 1, connection: on.id, autoReview: false }, sources)).toMatchObject({ status: "updated", settings: { autoReview: null } });
  expect(saved[0]).toEqual({ id: on.id, label: on.label, platform: on.platform, baseUrl: on.baseUrl, recognition: on.recognition });
});
