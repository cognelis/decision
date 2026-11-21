import { DecisionContextRepository, DecisionRelationRepository, DecisionScopeRepository, DecisionStore, MarkdownRepository } from "@cognelis/decision-storage";
import { decisionContextQuerySchema, decisionRelationUpdateSchema } from "@cognelis/decision-protocol";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordFixture } from "../../../packages/storage/test/fixtures.js";
import { DecisionContextService } from "../src/main/decision-context-service.js";
import { DecisionOutcomeService } from "../src/main/decision-outcome-service.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

// A review written by the App changes no choice: the relation and scope bound to the version it replaced follow it.
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-review-rebind-")); roots.push(root);
  const repository = new MarkdownRepository(root);
  const scopes = new DecisionScopeRepository(root);
  const relations = new DecisionRelationRepository(root);
  const index = { upsert: () => undefined, removePath: () => undefined, rebuild: () => undefined, close: () => undefined };
  const store = new DecisionStore(repository, index, () => undefined, (id, from, to) => Promise.all([
    relations.rebind({ source: "decisions", recordId: id }, from, to), scopes.rebind({ source: "decisions", recordId: id }, from, to),
  ]).then(([relation, scope]) => relation < 0 || scope < 0 ? -1 : relation + scope));
  const context = new DecisionContextService(new DecisionContextRepository(root, scopes, relations), scopes, relations);
  await store.save(recordFixture({ id: "dec_old", selectedAnswer: { kind: "preset", values: ["数据库"] } }));
  await store.save(recordFixture({ id: "dec_new" }));
  const read = async (id: string) => (await context.search(decisionContextQuerySchema.parse({ recordId: id, source: "decisions" }))).results[0]!;
  const a = await read("dec_old"); const b = await read("dec_new");
  expect(await context.updateRelation(decisionRelationUpdateSchema.parse({
    first: { source: "decisions", recordId: a.id, contentHash: a.sourceRef.contentHash }, second: { source: "decisions", recordId: b.id, contentHash: b.sourceRef.contentHash },
    disposition: "supersedes", successor: "second", expectedRevision: 0, reason: "用户确认 Markdown 替代数据库",
  }))).toMatchObject({ status: "saved" });
  return { root, read, relations, outcomes: new DecisionOutcomeService(store, root) };
};

describe("a review the App writes keeps what was bound to the decision", () => {
  it("leaves the replacement standing after the successor's outcome and review", async () => {
    const { read, outcomes, relations } = await setup();
    const before = await read("dec_new");
    const saved = await outcomes.update({ source: "decisions", recordId: "dec_new", expectedContentHash: before.sourceRef.contentHash, outcome: "上线一个月命中率 92%" } as never);
    expect(saved.status).toBe("saved");
    expect(saved.warnings.join("")).not.toContain("重新核对");
    expect(await read("dec_old")).toMatchObject({ lifecycleState: "superseded" });
    expect(await read("dec_new")).toMatchObject({ lifecycleState: "current", current: true });
    // Bound anew in place: no revision, no history, the reason as the reader gave it.
    expect([...(await relations.scan()).records.values()][0]).toMatchObject({ revision: 1, history: [], reason: "用户确认 Markdown 替代数据库" });
  });

  it("keeps an edit made in Obsidian under review", async () => {
    const { root, read, outcomes } = await setup();
    const path = join(root, (await read("dec_new")).sourceRef.relativePath);
    await writeFile(path, (await readFile(path, "utf8")).replace("对人友好", "对人很友好"));
    const edited = await read("dec_new");
    expect(edited).toMatchObject({ lifecycleState: "uncertain" });
    const saved = await outcomes.update({ source: "decisions", recordId: "dec_new", expectedContentHash: edited.sourceRef.contentHash, outcome: "上线" } as never);
    expect(saved.status).toBe("saved");
    // Bound to a version before the edit, not the one this write replaced: not carried, and said so.
    expect(saved.warnings.join("")).toContain("重新核对");
    expect(await read("dec_old")).toMatchObject({ lifecycleState: "uncertain" });
  });
});
