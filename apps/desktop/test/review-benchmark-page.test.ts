import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { PrConnection, PrReviewHistoryEntry, ReviewBenchmarkRecordRequest } from "@cognelis/decision-protocol";

import { SuggestionLedger, benchmarkPage, suggestionsFor, type ReviewBenchmarkPageSources } from "../src/main/review-benchmark-page.js";
import { ReviewBenchmarkRuns } from "../src/main/review-benchmark-runs.js";
import { ReviewEscapeStore } from "../src/main/review-escapes.js";
import { PrTeamFactsCache } from "../src/main/review-quality.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const link = { id: "00000000-0000-4000-8000-0000000000c1", label: "团队 Bitbucket", platform: "bitbucket-server", baseUrl: "https://code.example" } as PrConnection;
const now = Date.parse("2026-11-19T00:00:00.000Z");
const sha = (c: string) => c.repeat(40);
const finding = (title: string, line: number) => ({ priority: "P2" as const, title, body: `${title}。`, path: "src/a.ts", side: "new" as const, line, decisionIndexes: [] });
const entry = {
  id: "00000000-0000-4000-8000-000000000001", kind: "review", at: "2026-08-01T10:00:00.000Z", connectionId: link.id, state: "finished",
  snapshot: { reference: "org/app#7", title: "导出报表", sourceCommit: sha("a"), destinationCommit: sha("b") },
  report: { findings: [finding("超时写死", 10), finding("列表要分页", 20)] },
  published: [{ finding: 0, at: "2026-08-01T11:00:00.000Z", outcome: { kind: "fixed", at: "2026-08-02T00:00:00.000Z" } },
    { finding: 1, at: "2026-08-01T11:00:00.000Z", outcome: { kind: "wrong", words: "只读的小表不需要分页。", at: "2026-08-02T00:00:00.000Z" } }],
} as unknown as PrReviewHistoryEntry;

it("offers what review left behind as candidate cases, records the one taken as the App checks it, and confirms on the user's click", async () => {
  const root = await mkdtemp(join(tmpdir(), "paraself-benchmark-page-")); roots.push(root);
  const facts = new PrTeamFactsCache(join(root, "facts.json"));
  await facts.add({ [`${link.id}|org/app#7`]: { title: "导出报表", description: "", createdAt: "2026-08-01T08:00:00.000Z", mergedAt: "2026-08-03T08:00:00.000Z", approvals: [], humanComments: 0 } });
  const recorded: ReviewBenchmarkRecordRequest[] = [];
  const update = vi.fn(async () => ({ reviewBenchmarkVersion: 1 as const, status: "saved" as const, reasons: [], repository: null, case: null }));
  const sources: ReviewBenchmarkPageSources = {
    runs: new ReviewBenchmarkRuns({ directory: join(root, "runs"), cases: async () => null, models: async () => [], reviewer: () => { throw new Error("no runs here"); } }),
    benchmark: {
      list: async () => ({ reviewBenchmarkVersion: 1, status: "ok", repository: { id: "repo", project: "org/app" }, total: 1, nextOffset: null,
        counts: { defect: { candidate: 1, confirmed: { dev: 3, holdout: 5 }, withdrawn: 0 }, clean: { candidate: 0, confirmed: { dev: 2, holdout: 4 }, withdrawn: 0 } },
        cases: [{ id: "case-000000000001", set: "defect", status: "candidate", split: "dev", title: "续期没查吊销", pr: { repository: "org/app", number: 9 }, headSha: sha("c"), targetSha: sha("b"), baseSha: sha("b"), scope: [], mergedAt: null }] }) as never,
      record: async (request) => { recorded.push(request); return { reviewBenchmarkVersion: 1, status: "processed", repository: null, cases: [{ outcome: "recorded", caseId: `case-00000000000${recorded.length + 1}`, status: "candidate", split: "holdout", reasons: [] }] }; },
      update,
    },
    repositories: async () => ["/repos/app"], connections: async () => [link], history: { list: async () => ({ entries: [entry], unreadable: 0 }), save: async () => undefined },
    facts, escapes: new ReviewEscapeStore(join(root, "escapes.json")),
    get: async () => ({ title: "导出报表", source: { repository: "org/app", commit: sha("d") }, destination: { repository: "org/app", commit: sha("b") } }),
    localPath: async () => "/repos/app", models: async () => [], ledger: new SuggestionLedger(join(root, "ledger.json")), now: () => now,
  };
  expect((await suggestionsFor(link.id, sources)).map((item) => [item.key, item.set, item.source, item.blocked])).toEqual([
    [`${entry.id}:0`, "defect", "fixed", null], [`${entry.id}:1`, "clean", "wrong", null], [`sample:${link.id}|org/app#7`, "clean", "sampling", null],
  ]);
  const overview = (await benchmarkPage({ kind: "overview", connectionId: link.id }, sources)).overview!;
  expect(overview.repositories).toEqual([{ path: "/repos/app", project: "org/app", counts: { defect: { candidate: 1, dev: 3, holdout: 5 }, clean: { candidate: 0, dev: 2, holdout: 4 } },
    candidates: [{ caseId: "case-000000000001", set: "defect", title: "续期没查吊销", from: "org/app#9" }], runs: [] }]);

  // 修了: a defect case at the commit it was raised on, the PR's head since as its fix.
  expect(await benchmarkPage({ kind: "accept", connectionId: link.id, key: `${entry.id}:0` }, sources)).toMatchObject({ ok: true, message: expect.stringContaining("已录为候选样本 case-000000000002") });
  expect(recorded[0]!.cases[0]).toMatchObject({ set: "defect", headSha: sha("a"), targetSha: sha("b"), pr: { platform: "bitbucket-server", repository: "org/app", number: 7 },
    issues: [{ title: "超时写死", fixShas: [sha("d")], locations: [{ path: "src/a.ts", side: "new", startLine: 10, endLine: 10 }] }] });
  // 说错了: a clean case with the finding as a known false positive, dated by its merge.
  await benchmarkPage({ kind: "accept", connectionId: link.id, key: `${entry.id}:1` }, sources);
  expect(recorded[1]!.cases[0]).toMatchObject({ set: "clean", mergedAt: "2026-08-03", knownFalsePositives: [{ finding: "列表要分页：列表要分页。", why: "只读的小表不需要分页。", location: { startLine: 20 } }] });
  await benchmarkPage({ kind: "dismiss", key: `sample:${link.id}|org/app#7` }, sources);
  expect(await suggestionsFor(link.id, sources)).toEqual([]);

  expect(await benchmarkPage({ kind: "confirm", repositoryPath: "/repos/app", caseId: "case-000000000001" }, sources)).toMatchObject({ ok: true, message: "已确认入集。" });
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ caseId: "case-000000000001", expectedStatus: "candidate", status: "confirmed", userConfirmation: expect.stringContaining("确认入集") }));
});
