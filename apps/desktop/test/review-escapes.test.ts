import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { PrConnection, PrReviewHistoryEntry, ReviewBenchmarkRecordRequest } from "@cognelis/decision-protocol";

import type { PrDetails, PrTeamFacts } from "../src/main/pr-platform-client.js";
import { ReviewEscapeStore, findEscapes, keepFound, recordEscape, updateEscape } from "../src/main/review-escapes.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const store = async () => { const root = await mkdtemp(join(tmpdir(), "paraself-escapes-")); roots.push(root); return new ReviewEscapeStore(join(root, "escapes.json")); };

const link = { id: "00000000-0000-4000-8000-0000000000c1", label: "团队 Bitbucket", platform: "bitbucket-server", baseUrl: "https://code.example" } as PrConnection;
const facts = (title: string, mergedAt: string, description = ""): PrTeamFacts => ({ title, description, createdAt: mergedAt, mergedAt, approvals: [], humanComments: 0 });
const sha = (c: string) => c.repeat(40);

it("finds a merged PR a later one reverted or said it fixes, in the same repository only", () => {
  const found = findEscapes([
    { reference: "org/app#119", facts: facts("导出时间按服务器时区", "2026-11-01T10:00:00Z") },
    { reference: "org/app#124", facts: facts("修复导出时区", "2026-11-03T10:00:00Z", "#119 用了服务器时区，跨时区用户偏 8 小时。") },
    { reference: "org/app#130", facts: facts("会话续期", "2026-11-04T10:00:00Z") },
    { reference: "org/app#131", facts: facts("Revert \"会话续期\"", "2026-11-05T10:00:00Z") },
    // Names #1190, not #119; another repository's #130 is not this one.
    { reference: "org/app#140", facts: facts("修复列表", "2026-11-06T10:00:00Z", "跟进 #1190") },
    { reference: "org/web#141", facts: facts("修复 #130 的样式", "2026-11-07T10:00:00Z") },
  ]);
  expect(found).toEqual([
    { reference: "org/app#119", title: "导出时间按服务器时区", mergedAt: "2026-11-01T10:00:00Z", by: { kind: "fix", reference: "org/app#124", title: "修复导出时区" } },
    { reference: "org/app#130", title: "会话续期", mergedAt: "2026-11-04T10:00:00Z", by: { kind: "revert", reference: "org/app#131", title: "Revert \"会话续期\"" } },
  ]);
});

it("keeps what it found once, takes the user's escapes, writes the four lines, and makes a defect candidate of where the problem sat", async () => {
  const escapes = await store();
  const found = findEscapes([
    { reference: "org/app#119", facts: facts("导出时间按服务器时区", "2026-11-01T10:00:00Z") },
    { reference: "org/app#124", facts: facts("修复导出时区", "2026-11-03T10:00:00Z", "修复 #119") },
  ]);
  expect(await keepFound(escapes, link.id, found)).toBe(1);
  expect(await keepFound(escapes, link.id, found)).toBe(0);
  const [first] = await escapes.list();
  const reviewed = { kind: "review", connectionId: link.id, snapshot: { reference: "org/app#119", sourceCommit: sha("a"), destinationCommit: sha("b") } } as PrReviewHistoryEntry;
  const recorded: ReviewBenchmarkRecordRequest[] = [];
  const sources = {
    connections: async () => [link], store: escapes, history: { list: async () => ({ entries: [reviewed], unreadable: 0 }), save: async () => undefined },
    get: vi.fn(async (_id: string, reference: string) => ({ title: reference === "org/app#124" ? "修复导出时区" : "会话续期", source: { repository: "org/app", commit: reference === "org/app#124" ? sha("c") : sha("d") }, destination: { repository: "org/app", commit: sha("b") } }) as PrDetails),
    localPath: async () => "/repos/app",
    benchmark: { record: async (request: ReviewBenchmarkRecordRequest) => { recorded.push(request); return { reviewBenchmarkVersion: 1 as const, status: "processed" as const, repository: null, cases: [{ outcome: "recorded" as const, caseId: "case-0123456789ab", status: "candidate" as const, split: "dev" as const, reasons: [] }] }; } },
  };
  // Made a case only with the four lines and where it sat.
  expect(await updateEscape({ id: first!.id, action: "add_to_benchmark", location: { path: "src/export.ts", startLine: 42, endLine: 44 }, priority: "P2" }, sources)).toMatchObject({ status: "refused", reason: expect.stringContaining("先写复盘") });
  const writeup = { problem: "导出时间按服务器时区格式化", layer: "pre_review" as const, why: "没有规则说时间要按用户时区", change: "rule" as const, changeText: "REVIEW.md 加时区规则" };
  expect(await updateEscape({ id: first!.id, action: "write", writeup, priority: "P2" }, sources)).toMatchObject({ status: "updated", escape: { state: "written", writeup } });
  const made = await updateEscape({ id: first!.id, action: "add_to_benchmark", location: { path: "src/export.ts", startLine: 42, endLine: 44 }, priority: "P2" }, sources);
  expect(made).toMatchObject({ status: "updated", escape: { benchmarkCase: "case-0123456789ab" } });
  expect(recorded).toEqual([{ reviewBenchmarkVersion: 1, sourceClient: "paraself", repositoryPath: "/repos/app", cases: [{
    set: "defect", title: "导出时间按服务器时区", pr: { platform: "bitbucket-server", repository: "org/app", number: 119 }, headSha: sha("a"), targetSha: sha("b"),
    provenance: [{ kind: "incident", reference: "漏网复盘：导出时间按服务器时区格式化" }, { kind: "fix_commit", reference: sha("c") }],
    issues: [{ title: "导出时间按服务器时区格式化", priority: "P2", evidence: "没有规则说时间要按用户时区", fixShas: [sha("c")], tradeoff: false, locations: [{ path: "src/export.ts", side: "new", startLine: 42, endLine: 44 }] }],
  }] }]);
  expect((await updateEscape({ id: first!.id, action: "add_to_benchmark", location: { path: "src/export.ts", startLine: 42 }, priority: "P2" }, sources)).status).toBe("refused");

  // The user's own: a PR a commit fixed. Named twice, kept once; dismissed with why, and opened again.
  const own = await recordEscape({ connection: "团队 Bitbucket", reference: "org/app#130", by: sha("e"), kind: "fix" }, sources);
  expect(own).toMatchObject({ status: "recorded", escape: { reference: "org/app#130", title: "会话续期", by: { kind: "fix", reference: sha("e"), title: "" }, state: "open" } });
  expect((await recordEscape({ reference: "org/app#130", by: "org/app#131", kind: "revert" }, sources)).status).toBe("exists");
  expect(await updateEscape({ id: own.escape!.id, action: "dismiss", reason: "是需求变了，不是缺陷", priority: "P2" }, sources)).toMatchObject({ escape: { state: "dismissed", dismissed: "是需求变了，不是缺陷" } });
  expect(await updateEscape({ id: own.escape!.id, action: "reopen", priority: "P2" }, sources)).toMatchObject({ escape: { state: "open", dismissed: null } });
  expect(await keepFound(escapes, link.id, findEscapes([
    { reference: "org/app#130", facts: facts("会话续期", "2026-11-04T10:00:00Z") }, { reference: "org/app#131", facts: facts("Revert \"会话续期\"", "2026-11-05T10:00:00Z") },
  ]))).toBe(0);
});
