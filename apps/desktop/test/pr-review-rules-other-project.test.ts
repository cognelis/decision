import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { PrReviewService } from "../src/main/pr-review-service.js";
import { DecisionContextService } from "../src/main/decision-context-service.js";
import { connectionId, harness } from "./pr-review-run-fakes.js";

// The rules reviewer searches with includeOutOfScope so it can read what other projects decided, five records at a time,
// and only afterwards drops the out-of-scope records that are not another project's (a recorded path scope that leaves
// this change out). Five such records of this project ranking first fill the page and are all dropped: the other
// project's decision behind them is never shown, and the search tool has no offset to reach it.
it("shows the rules reviewer another project's decision behind records a recorded path scope keeps out", async () => {
  const test = harness(["src/request.ts"], "diff --git a/src/request.ts b/src/request.ts\n--- a/src/request.ts\n+++ b/src/request.ts\n@@ -1,2 +1,2 @@\n const timeout = 100;\n-old();\n+changed();\n", () => ({ action: "finish_review", summary: "已核对", findings: [] }));
  const scope = (paths: string[]) => ({ projects: [], repositoryIds: [], modules: [], layers: [], paths, excludedPaths: [], exceptions: [] });
  const document = (id: string, project: string, created: string, paths?: string[]) => ({
    source: "summarize" as const, kind: "historical_decision" as const, id, title: `请求超时 ${id}`, project, status: "accepted", created, summary: "请求超时后必须释放资源", appliesWhen: null, caution: null,
    tags: [], supersedes: [], supersededBy: [], relativePath: `summarize/${id}.md`, client: "codex", sessionId: null, body: "请求超时后取消实际调用", bodyStartLine: 1, contentHash: id.replace(/\D/gu, "").padStart(64, "0"),
    ...(paths ? { scope: scope(paths), scopeState: "current" as const } : {}),
  });
  // Five of this project's decisions scoped to docs/ (out of scope for src/request.ts), newer; one of "web", older.
  const documents = [...Array.from({ length: 5 }, (_, index) => document(`DEC-${index + 1}`, "app", `2026-09-1${index}`, ["docs"])), document("DEC-9", "web", "2026-08-01")];
  const context = new DecisionContextService({ scan: async () => ({ sources: [{ source: "summarize", status: "ready", records: documents.length, skipped: 0 }], documents }) });
  const service = new PrReviewService({ gateway: test.gateway, searchDecisions: context.search.bind(context), createClient: async () => test.client });
  const view = await service.load({ connectionId, reference: "AI/app#1" });
  const report = await service.run({ snapshotId: view.snapshotId, runId: randomUUID(), profileId: "local", focus: "", depth: "deep" });
  const seen = report.history.filter((event) => event.lens === "rules").flatMap((event) => event.decisions ?? []).map((item) => `${item.id}${item.otherProject ? ` · ${item.otherProject}` : ""}`);
  expect(seen).toContain("DEC-9 · web");
});
