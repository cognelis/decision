import { assessMethodologyQuality, assessPracticeAssetFreshness, type MethodologyRecord, type PracticeAssetRecord } from "@cognelis/decision-core";
import { DecisionStore, DecisionWatcher, MarkdownRepository, SqliteIndex, LocalDecisionStore, DecisionContextRepository, DecisionRelationRepository, DecisionScopeRepository, SemanticVectorIndex, MethodologyRepository, PracticeAssetRepository } from "@cognelis/decision-storage";
import { decisionContextQuerySchema } from "@cognelis/decision-protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { recordFixture } from "../../../packages/storage/test/fixtures.js";
import { DecisionContextService } from "../src/main/decision-context-service.js";
import { DecisionAnalyticsService } from "../src/main/decision-analytics-service.js";
import { readDashboardSnapshot } from "../src/main/dashboard-snapshot.js";
import { buildKnowledgeGraph } from "../src/main/knowledge-graph-service.js";
import { buildMethodologyUsageSnapshot } from "../src/main/methodology-usage-service.js";

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

// Synthetic data: this characterizes the public external-delete path before adding App deletion.
it("keeps independent facts readable after an external decision deletion and shows which projections lose it", async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-delete-existing-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repository = new MarkdownRepository(root), index = new SqliteIndex(join(root, "index.sqlite"));
  const vectors = new SemanticVectorIndex(join(root, "vectors.sqlite"));
  cleanups.push(() => index.close(), () => vectors.close());
  const store = new DecisionStore(repository, index);
  const removed = recordFixture({ id: "gone", batchId: "batch", questionIndex: 0, appliedPrincipleIds: ["principle"], sourceClient: "pr-comment", sourceEventId: "https://example.test/pull/1#comment-2" });
  const sibling = recordFixture({ id: "sibling", batchId: "batch", questionIndex: 1, supersedes: "gone", related: ["gone"] });
  const note = (await store.save(removed)).note;
  const other = (await store.save(sibling)).note;
  const scopes = new DecisionScopeRepository(root), relations = new DecisionRelationRepository(root);
  const context = new DecisionContextService(new DecisionContextRepository(root, scopes, relations), scopes, relations);
  const first = { source: "decisions" as const, recordId: removed.id, contentHash: note.contentHash };
  const second = { source: "decisions" as const, recordId: sibling.id, contentHash: other.contentHash };
  await relations.save({ first, second, disposition: "supersedes", successor: "second", reason: "synthetic replacement", expectedRevision: 0 });
  await scopes.save({ source: "decisions", recordId: removed.id, expectedContentHash: note.contentHash, expectedRevision: 0, scope: { projects: ["decision"], repositoryIds: [], modules: [], layers: [], paths: [], excludedPaths: [], exceptions: [] }, changeReason: "synthetic scope" });
  vectors.upsert([{ entityType: "decision", entityId: "gone", model: "synthetic", contentHash: note.contentHash, vector: [1, 0] }]);
  expect(buildMethodologyUsageSnapshot("principle", index.queryDecisions({ everything: true })).linkedDecisionCount).toBe(1);
  await rm(note.path);
  const watcher = new DecisionWatcher(repository, store.watchedIndex);
  cleanups.push(() => watcher.close());
  watcher.removePath(note.path);
  expect(index.findDecisions(["gone"])).toEqual([]);
  expect(index.findDecisions(["sibling"])).toHaveLength(1);
  expect(index.findDecisions(["sibling"])[0]?.batchId).toBe("batch");
  expect((await repository.read(other.path)).record.related).toEqual(["gone"]);
  const dashboard = readDashboardSnapshot(index);
  expect(dashboard.totalDecisions).toBe(1); expect(dashboard.recentDecisions.map(item => item.id)).toEqual(["sibling"]);
  expect(index.queryDecisions({ everything: true }).filter(item => item.sourceEventId === removed.sourceEventId)).toEqual([]);
  expect((await new DecisionAnalyticsService().analyze(index.queryDecisions({ everything: true }))).totals.decisions).toBe(1);
  expect(buildMethodologyUsageSnapshot("principle", index.queryDecisions({ everything: true })).linkedDecisionCount).toBe(0);
  expect((await scopes.scan()).records.has("decisions:gone")).toBe(true);
  expect((await relations.scan()).records.size).toBe(1);
  expect((await context.search(decisionContextQuerySchema.parse({ source: "decisions", recordId: "gone" }))).results).toEqual([]);
  const standing = await context.search(decisionContextQuerySchema.parse({ source: "decisions", recordId: "sibling" }));
  expect(standing.results[0]?.relations?.[0]).toMatchObject({ state: "missing_source", other: { recordId: "gone", title: null } });
  // The deleted end says nothing of the one left (R8): a wrong write deleted no longer holds the decision it named under review.
  expect(standing.results[0]?.lifecycleState).toBe("current");
  // The index's deletion by itself does not synchronously remove its cached vector.
  expect(vectors.metadata("decision").map(item => item.entityId)).toEqual(["gone"]);
});

it("retains principle and practice content while reporting missing evidence; local discard already erases content and prevents replay", async () => {
  const principle: MethodologyRecord = { id: "principle", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", origin: "decision_evidence", status: "accepted", confirmedAt: "2026-08-01T00:00:00.000Z", title: "先验证", principle: "先验证再扩大", appliesWhen: "有未知风险", caution: "考虑成本", evidenceSummary: "合成证据", sourceDecisionIds: ["gone"], confidence: "medium", generation: { requestId: "test", profileId: "test", provider: "test", model: "test" } };
  expect(assessMethodologyQuality(principle, [principle], []).missingEvidenceCount).toBe(1);
  expect(principle.sourceDecisionIds).toEqual(["gone"]);
  const asset: PracticeAssetRecord = { id: "asset", slug: "asset", kind: "skill", status: "accepted", createdAt: principle.createdAt, updatedAt: principle.updatedAt, acceptedAt: principle.confirmedAt, sourcePrincipleIds: [principle.id], generation: principle.generation, title: "验证", summary: "验证后扩大", trigger: "有风险", steps: ["验证", "核对结果"], checks: ["结果"], fallback: "回退" };
  expect(assessPracticeAssetFreshness(asset, [principle]).state).toBe("current");
  const root = await mkdtemp(join(tmpdir(), "decision-delete-local-existing-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const local = new LocalDecisionStore(join(root, "local.sqlite")); cleanups.push(() => local.close());
  const record = recordFixture(); local.save(record); local.resolve(record.id, "discarded");
  expect(local.get(record.id)).toBeNull(); expect(local.content(record.id)).toBeNull(); expect(local.list().total).toBe(0);
  local.save(record);
  expect(local.get(record.id)).toBeNull(); expect(local.has(record.id)).toBe(true);
  const repository = new MarkdownRepository(root), index = new SqliteIndex(join(root, "index.sqlite"));
  cleanups.push(() => index.close());
  const decisions = new DecisionStore(repository, index), principles = new MethodologyRepository(root), assets = new PracticeAssetRepository(root);
  const note = (await decisions.save(recordFixture({ id: "gone" }))).note;
  await principles.save(principle); await assets.save(asset);
  await rm(note.path); new DecisionWatcher(repository, decisions.watchedIndex).removePath(note.path);
  const retained = (await principles.find(principle.id))!;
  expect(retained.sourceDecisionIds).toEqual(["gone"]);
  expect(assessMethodologyQuality(retained, [retained], index.findDecisions(retained.sourceDecisionIds).map(({ id, project, sourceClient }) => ({ id, project, sourceClient, outcomeVerdict: null }))).missingEvidenceCount).toBe(1);
  expect(await assets.find(asset.id)).toMatchObject({ sourcePrincipleIds: [principle.id], steps: ["验证", "核对结果"] });
  expect(assessPracticeAssetFreshness((await assets.find(asset.id))!, [retained]).state).toBe("current");
  const graph = buildKnowledgeGraph([retained], index.queryDecisions({ everything: true }));
  expect(graph.missingSourceDecisionIds).toEqual(["gone"]); expect(graph.principles).toHaveLength(1); expect(graph.decisions).toEqual([]);
});
