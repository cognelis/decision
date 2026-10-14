import { describe, expect, it } from "vitest";
import { decisionRelationRecordSchema } from "@cognelis/decision-protocol";
import { buildDecisionLifecycle, canonicalDecisionRelation, decisionRelationKey, type DecisionLifecycleDocument } from "../src/decision-lifecycle.js";

const hash = "a".repeat(64);
const document = (id: string, overrides: Partial<DecisionLifecycleDocument> = {}): DecisionLifecycleDocument => ({ source: "summarize", id, status: "accepted", contentHash: hash, supersedes: [], supersededBy: [], ...overrides });
const relation = (overrides: Record<string, unknown> = {}) => decisionRelationRecordSchema.parse({
  relationVersion: 1, first: { source: "summarize", recordId: "A", contentHash: hash }, second: { source: "summarize", recordId: "B", contentHash: hash },
  disposition: "supersedes", successor: "second", reason: "用户明确确认后继", revision: 1, updatedAt: "2026-09-10T00:00:00.000Z", history: [], ...overrides,
});

describe("decision lifecycle projection", () => {
  it("canonicalizes pair identity without reversing the intended successor", () => {
    const original = relation();
    const reversed = relation({ first: original.second, second: original.first, successor: "first" });
    expect(canonicalDecisionRelation(reversed)).toEqual(original);
    expect(decisionRelationKey(reversed)).toBe(decisionRelationKey(original));
  });
  it("lets an explicit judgment override inline relationships, then restores them on withdrawal", () => {
    const documents = [document("A", { supersededBy: ["B"] }), document("B")];
    const unrelated = relation({ disposition: "unrelated", successor: null });
    expect(buildDecisionLifecycle(documents, [unrelated]).state(documents[0]!)).toBe("current");
    const withdrawn = relation({ disposition: "revoked", successor: null });
    expect(buildDecisionLifecycle(documents, [withdrawn]).state(documents[0]!)).toBe("superseded");
    expect(documents[0]!.supersededBy).toEqual(["B"]);
  });
  it("does not apply stale or dangling relationship claims", () => {
    const changed = [document("A"), document("B", { contentHash: "b".repeat(64) })];
    const stale = buildDecisionLifecycle(changed, [relation()]);
    expect(stale.successors.get("summarize:A")?.size).toBe(0);
    expect(stale.state(changed[0]!)).toBe("uncertain");
    const missing = buildDecisionLifecycle([document("A")], [relation()]);
    expect(missing.states.get(decisionRelationKey(relation()))).toBe("missing_source");
    expect(missing.state(document("A"))).toBe("uncertain");
  });
  it("keeps equal IDs from different sources distinct", () => {
    const docs = [document("A"), document("A", { source: "decisions", status: "completed" })];
    const cross = relation({ second: { source: "decisions", recordId: "A", contentHash: hash } });
    const projected = buildDecisionLifecycle(docs, [cross]);
    expect(projected.state(docs[0]!)).toBe("superseded");
    expect(projected.state(docs[1]!)).toBe("current");
  });
  it("finds imported cycles and their predecessors without recursive traversal", () => {
    const docs = Array.from({ length: 2_000 }, (_, i) => document(String(i), { supersededBy: i === 1_999 ? ["1900"] : [String(i + 1)] }));
    const projected = buildDecisionLifecycle(docs, []);
    expect(projected.cycleAffected.size).toBe(2_000);
    expect(projected.state(docs[0]!)).toBe("uncertain");
  });
});
