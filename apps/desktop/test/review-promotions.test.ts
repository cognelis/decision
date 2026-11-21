import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { PrReviewHistoryEntry, ReviewEscape } from "@cognelis/decision-protocol";

import { ReviewEscapeStore } from "../src/main/review-escapes.js";
import { PromotionLedger, actOnPromotion, promotionsFor } from "../src/main/review-promotions.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const link = "00000000-0000-4000-8000-0000000000c1";
let ids = 0;
const finding = (title: string, body: string, priority: "P1" | "P2" = "P2", decisionIndexes: number[] = []) => ({ priority, title, body, path: "src/a.ts", side: "new" as const, line: 10, decisionIndexes });
const review = (reference: string, findings: ReturnType<typeof finding>[], outcomes: Array<{ kind: string; words?: string } | null>): PrReviewHistoryEntry => ({
  id: `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`, kind: "review", connectionId: link, at: `2026-11-${String(10 + ids).padStart(2, "0")}T00:00:00.000Z`, state: "finished",
  snapshot: { reference, title: "PR", guides: ["docs/REVIEW.md"], rules: [{ id: "list-pagination.md", source: "decision" }, { id: "money.md", source: "decision" }] },
  report: { findings, evidence: [{ index: 1, record: { id: "dec-9", title: "续期失败返回 401 + SESSION_EXPIRED", sourceRef: { relativePath: "Decision Journal/decisions/dec-9.md" } } }] },
  published: outcomes.flatMap((outcome, index) => [{ finding: index, at: "2026-11-12T00:00:00.000Z", ...(outcome ? { outcome: { ...outcome, at: "2026-11-13T00:00:00.000Z" } } : {}) }]),
}) as unknown as PrReviewHistoryEntry;

it("proposes the rules review keeps needing, not the noisy ones, and hands one to the local review as a comment on the rules file", async () => {
  const root = await mkdtemp(join(tmpdir(), "paraself-promotions-")); roots.push(root);
  const entries = [
    // The decision behind findings in three PRs, fixed twice.
    review("org/app#1", [finding("续期返回码", "按决策 1 应返回 401。", "P2", [1])], [{ kind: "fixed" }]),
    review("org/app#2", [finding("续期返回码", "按决策 1 应返回 401。", "P2", [1])], [{ kind: "fixed" }]),
    review("org/web#3", [finding("续期返回码", "按决策 1 应返回 401。", "P2", [1])], [null]),
    // A local rule an author said the repository does not have; once only.
    review("org/app#4", [finding("金额用了浮点", "Ruleset 2 要求金额用整数分。", "P1")], [{ kind: "intended", words: "仓库里没有这条规则，先这样。" }]),
    // A local rule called wrong more than fixed: noise to rewrite, not to promote.
    review("org/app#5", [finding("没分页", "Ruleset 1 要求分页。")], [{ kind: "wrong", words: "小表不用分页。" }]),
    review("org/app#6", [finding("没分页", "Ruleset 1 要求分页。")], [{ kind: "wrong", words: "只读表。" }]),
    review("org/app#7", [finding("没分页", "Ruleset 1 要求分页。")], [{ kind: "fixed" }]),
  ];
  const escapes = new ReviewEscapeStore(join(root, "escapes.json"));
  const escape: ReviewEscape = { id: "00000000-0000-4000-8000-0000000000e1", connectionId: link, reference: "org/app#119", title: "导出", mergedAt: null, by: { kind: "fix", reference: "org/app#124", title: "修复时区" },
    foundAt: "2026-11-15T00:00:00.000Z", state: "written", dismissed: null, benchmarkCase: null, writeup: { problem: "导出时间按服务器时区", layer: "pre_review", why: "没有规则", change: "rule", changeText: "时间按用户时区格式化" } };
  await escapes.change((all) => { all.push(escape); });
  const propose = vi.fn(async () => "00000000-0000-4000-8000-0000000000ab");
  const sources = { connections: async () => [], history: { list: async () => ({ entries, unreadable: 0 }), save: async () => undefined }, escapes, ledger: new PromotionLedger(join(root, "ledger.json")), propose };

  const found = await promotionsFor(link, sources);
  expect(found.map((item) => [item.kind, item.title, item.repository, item.signals])).toEqual([
    ["decision", "续期失败返回 401 + SESSION_EXPIRED", "org/app", ["支撑的意见出现在 3 个 PR，修了 2 次"]],
    ["local_rule", "money", "org/app", ["作者回复仓库里没有这条规则"]],
    ["escape", "时间按用户时区格式化", "org/app", ["来自 org/app#119 的漏网复盘"]],
  ]);
  expect(found[0]!.evidence.map((item) => item.outcome)).toEqual(["修了", "修了", "未回应"]);

  // Proposed with the line as the user left it, as a comment on the file the repository's reviews read.
  const done = await actOnPromotion({ action: "propose", connectionId: link, key: found[0]!.key, draft: "- 续期失败一律返回 401 和 SESSION_EXPIRED。" }, sources);
  expect(done).toEqual({ ok: true, message: expect.stringContaining("已交给本地审阅（任务 00000000-0000-4000-8000-0000000000ab）"), jobId: "00000000-0000-4000-8000-0000000000ab" });
  expect(propose).toHaveBeenCalledWith({ connectionId: link, repository: "org/app", path: "docs/REVIEW.md", body: expect.stringContaining("在 docs/REVIEW.md 的规则里加一条") });
  expect((propose.mock.calls[0] as unknown as [{ body: string }])[0].body).toContain("- 续期失败一律返回 401 和 SESSION_EXPIRED。\n\n依据：支撑的意见出现在 3 个 PR，修了 2 次。");
  expect((await promotionsFor(link, sources))[2]).toMatchObject({ key: found[0]!.key, proposed: { jobId: "00000000-0000-4000-8000-0000000000ab" } });
  expect((await actOnPromotion({ action: "propose", connectionId: link, key: found[0]!.key, draft: "- 再来" }, sources)).ok).toBe(false);
  // Left, it is not offered again; the local review refusing says why.
  await actOnPromotion({ action: "dismiss", key: found[1]!.key }, sources);
  expect((await promotionsFor(link, sources)).map((item) => item.kind)).toEqual(["escape", "decision"]);
  propose.mockRejectedValueOnce(new Error("本地审阅里没有 org/app 的本地仓库"));
  expect(await actOnPromotion({ action: "propose", connectionId: link, key: found[2]!.key, draft: found[2]!.draft }, sources)).toEqual({ ok: false, message: "没有交给本地审阅：本地审阅里没有 org/app 的本地仓库", jobId: null });
});

it("proposes a rule the reviewer marked blocking once a finding on it went out, whatever came of it", async () => {
  const root = await mkdtemp(join(tmpdir(), "paraself-promotions-blocking-")); roots.push(root);
  const entry = review("org/app#8", [finding("金额用了浮点", "违反 Ruleset 2：金额要用整数分。", "P1")], [null]);
  const marked = { ...entry, snapshot: { ...entry.snapshot, rules: [{ id: "list-pagination.md", source: "decision" }, { id: "money.md", source: "decision", enforcement: "blocking", text: "金额一律用整数分。" }] } } as PrReviewHistoryEntry;
  const sources = { connections: async () => [], history: { list: async () => ({ entries: [marked], unreadable: 0 }), save: async () => undefined },
    escapes: new ReviewEscapeStore(join(root, "escapes.json")), ledger: new PromotionLedger(join(root, "ledger.json")), propose: async () => "job" };
  expect((await promotionsFor(link, sources)).map((item) => [item.kind, item.title, item.signals])).toEqual([
    ["local_rule", "money", ["你把它标记为阻塞：拿只在你这里的规则要求别人，应该写进仓库"]],
  ]);
});
