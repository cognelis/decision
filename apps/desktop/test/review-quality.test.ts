import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadReviewRules } from "@cognelis/decision-storage";
import type { PrConnection, PrListQuery, PrReviewHistoryEntry } from "@cognelis/decision-protocol";

import type { PrTeamFacts } from "../src/main/pr-platform-client.js";
import { PrTeamFactsCache, reviewQualityFor, setReviewRuleEnabled } from "../src/main/review-quality.js";
import { ReviewEscapeStore } from "../src/main/review-escapes.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const directory = async () => { const root = await mkdtemp(join(tmpdir(), "paraself-review-quality-")); roots.push(root); return root; };

const link = { id: "00000000-0000-4000-8000-0000000000c1", label: "团队 Bitbucket", platform: "bitbucket-server", baseUrl: "https://code.example" } as PrConnection;
const now = Date.parse("2026-11-19T00:00:00.000Z");
const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();
const finding = (title: string, body: string, decisionIndexes: number[] = []) => ({ priority: "P2" as const, title, body, path: "src/a.ts", side: "new" as const, line: 10, decisionIndexes });
let ids = 0;
const review = (reference: string, findings: ReturnType<typeof finding>[], published: PrReviewHistoryEntry["published"]): PrReviewHistoryEntry => ({
  id: `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`, kind: "review", at: daysAgo(20), model: "本机", focus: "", draft: "", turns: [], events: [], state: "finished", error: "",
  verdicts: [], rechecks: [], connectionId: link.id, published,
  snapshot: { snapshotId: "00000000-0000-4000-8000-000000000051", reference, title: "PR", description: "", project: "app", sourceCommit: "a".repeat(40), destinationCommit: "b".repeat(40), files: [], warnings: [],
    guides: ["REVIEW.md"], rules: [{ id: "list-pagination.md", source: "decision" }] },
  report: { status: "completed", summary: "", findings, readFiles: [], unreadFiles: [], reviewedFiles: [], unreviewedFiles: [], warnings: [], steps: 1, history: [],
    evidence: [{ index: 1, record: { id: "dec-7", title: "列表接口都要分页", sourceRef: { relativePath: "Decision Journal/decisions/dec-7.md" } } }] as never },
});
const outcome = (kind: string, days: number, words?: string) => ({ kind, at: daysAgo(days), ...(words ? { words } : {}) }) as never;

it("counts the findings posted lately by what they stood on, and names the rules authors keep calling wrong", async () => {
  const entries = [
    review("org/app#1", [
      finding("超时写死", "违反 REVIEW.md 第 3 条。"), finding("没分页", "按决策 1 应分页。", [1]), finding("空值", "这里会空指针。"), finding("没分页 2", "Ruleset 1 要求列表分页。"),
    ], [
      { finding: 0, at: daysAgo(10), outcome: outcome("fixed", 5) },
      { finding: 1, at: daysAgo(10), outcome: outcome("wrong", 5, "只读的小表不需要分页。") },
      { finding: 2, at: daysAgo(10), outcome: outcome("maybe_fixed", 5) },
      { finding: 3, at: daysAgo(10), outcome: outcome("wrong", 4, "字典表只有十几行。") },
    ]),
    // Posted 40 days ago: out of the table's 30 days, still counted against its rules.
    review("org/app#2", [finding("没分页", "Ruleset 1 要求列表分页。", [1])], [{ finding: 0, at: daysAgo(40), outcome: outcome("wontfix", 35, "先不改。") }]),
  ];
  const sources = {
    connections: async () => [link], history: { list: async () => ({ entries, unreadable: 0 }), save: async () => undefined },
    pullRequests: vi.fn(async (_query: PrListQuery) => ({ items: [] as never[], nextPage: null })), facts: vi.fn(), cache: new PrTeamFactsCache(join(await directory(), "facts.json")), now: () => now,
  };
  const { quality } = await reviewQualityFor({}, sources);
  expect(quality!.outcomes).toEqual({
    rows: [
      { basis: "repository", published: 1, fixed: 1, wrong: 0, intended: 0, wontfix: 0, later: 0, none: 0 },
      { basis: "personal", published: 2, fixed: 0, wrong: 2, intended: 0, wontfix: 0, later: 0, none: 0 },
      { basis: "none", published: 0, fixed: 0, wrong: 0, intended: 0, wontfix: 0, later: 0, none: 0 },
    ],
    maybeFixed: 1, total: 4,
  });
  expect(quality!.noise).toEqual([
    { kind: "decision", id: "dec-7", source: null, title: "列表接口都要分页", notePath: "Decision Journal/decisions/dec-7.md", settled: 2, wrong: 1, wontfix: 1, prs: 2, words: ["只读的小表不需要分页。", "先不改。"] },
    { kind: "local_rule", id: "list-pagination.md", source: "decision", title: "list-pagination", notePath: null, settled: 2, wrong: 1, wontfix: 1, prs: 2, words: ["字典表只有十几行。", "先不改。"] },
  ]);
});

it("reads the team's figures from the PRs merged in the last two windows, each PR once, and carries on with what it could not read", async () => {
  const merged = (reference: string, days: number) => ({ reference, title: reference, repository: "org/app", number: reference.split("#")[1]!, author: "a", updatedAt: daysAgo(days) });
  const lists: Record<string, ReturnType<typeof merged>[]> = {
    "review-requested": [merged("org/app#1", 2), merged("org/app#2", 40), merged("org/app#9", 70)],
    created: [merged("org/app#1", 2), merged("org/app#3", 5)],
  };
  const facts: Record<string, PrTeamFacts> = {
    "org/app#1": { title: "会话续期", description: "顺带修复 #3 的时区。", createdAt: daysAgo(4), mergedAt: daysAgo(2), approvals: [{ login: "bob", at: new Date(now - 4 * 86_400_000 + 3 * 3_600_000).toISOString() }, { login: "carol", at: daysAgo(3) }], humanComments: 3 },
    "org/app#2": { title: "Revert \"导出\"", description: "", createdAt: daysAgo(41), mergedAt: daysAgo(40), approvals: [], humanComments: 0 },
  };
  let failing = true;
  const read = vi.fn(async (_id: string, reference: string) => {
    if (reference === "org/app#3" && failing) throw new Error("平台超时");
    return facts[reference] ?? { title: "导出时区", description: "", createdAt: daysAgo(6), mergedAt: daysAgo(5), approvals: [{ login: "bob", at: new Date(now - 6 * 86_400_000 + 7 * 3_600_000).toISOString() }], humanComments: 1 };
  });
  const sources = {
    connections: async () => [link], history: { list: async () => ({ entries: [], unreadable: 0 }), save: async () => undefined },
    pullRequests: async (query: PrListQuery) => ({ items: lists[query.filter]!, nextPage: null }), facts: read, cache: new PrTeamFactsCache(join(await directory(), "facts.json")), now: () => now,
    escapes: new ReviewEscapeStore(join(await directory(), "escapes.json")),
  };
  const first = (await reviewQualityFor({ connection: "团队 Bitbucket" }, sources)).quality!.team;
  expect(first).toEqual({
    current: { prs: 1, approvalsPerPr: 2, humanCommentsPerPr: 3, waitHours: 3, rollbacks: 0, escapes: 0 },
    previous: { prs: 1, approvalsPerPr: 0, humanCommentsPerPr: 0, waitHours: null, rollbacks: 1, escapes: 0 },
    unread: 1, error: "平台超时",
  });
  expect(read.mock.calls.map(([, reference]) => reference).sort()).toEqual(["org/app#1", "org/app#2", "org/app#3"]);
  // Read again: only the one that failed; the others come from the cache.
  failing = false;
  read.mockClear();
  const second = (await reviewQualityFor({}, sources)).quality!.team;
  expect(read.mock.calls.map(([, reference]) => reference)).toEqual(["org/app#3"]);
  // #3, read now, was fixed by #1 merged after it: 漏网, counted where #3 merged.
  expect(second.current).toEqual({ prs: 2, approvalsPerPr: 1.5, humanCommentsPerPr: 2, waitHours: 5, rollbacks: 0, escapes: 1 });
  expect((await reviewQualityFor({}, sources)).quality!.escapes).toEqual([expect.objectContaining({ reference: "org/app#3", by: { kind: "fix", reference: "org/app#1", title: "会话续期" }, state: "open" })]);
  expect(second.unread).toBe(0);
  expect((await reviewQualityFor({ connection: "不存在" }, sources)).status).toBe("connection_not_found");
});

it("turns one of Paraself's own rules off in its frontmatter and on again, leaving the rest of it, and nothing outside its directory", async () => {
  const rules = await directory();
  await writeFile(join(rules, "scoped.md"), "---\napplies_to:\n  repo: \"^app$\"\nenabled: true\n---\n列表接口都要分页。\n");
  await writeFile(join(rules, "plain.md"), "金额用整数分。\n");
  await writeFile(join(rules, "bare.md"), "---\npriority: 2\n---\n错误要带错误码。\n");
  for (const rule of ["scoped.md", "plain.md", "bare.md"]) expect((await setReviewRuleEnabled(rules, rule, false)).status).toBe("updated");
  expect((await loadReviewRules(rules)).rules).toEqual([]);
  expect(await readFile(join(rules, "scoped.md"), "utf8")).toBe("---\napplies_to:\n  repo: \"^app$\"\nenabled: false\n---\n列表接口都要分页。\n");
  expect(await readFile(join(rules, "bare.md"), "utf8")).toBe("---\npriority: 2\nenabled: false\n---\n错误要带错误码。\n");
  expect((await setReviewRuleEnabled(rules, "plain.md", true)).status).toBe("updated");
  expect((await loadReviewRules(rules)).rules.map((rule) => rule.id)).toEqual(["plain.md"]);
  expect(await setReviewRuleEnabled(rules, "../outside.md", false)).toMatchObject({ status: "not_found" });
  expect(await setReviewRuleEnabled(rules, "missing.md", false)).toMatchObject({ status: "not_found" });
});
