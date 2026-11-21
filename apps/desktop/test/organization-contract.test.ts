import { describe, expect, it } from "vitest";
import {
  contextAsReleased,
  contextShapeLevel,
  contextShapeNeeded,
  decisionContextQuerySchema,
  decisionSourceOf,
  handledSuggestionViewSchema,
  isDecisionSource,
  organizationForgetSchema,
  organizationQuerySchema,
  organizationRunRequestSchema,
  organizationRunViewSchema,
  organizationSettingsSchema,
  organizationSourceKey,
  organizationSourceKeySchema,
  parseOrganizationSourceKey,
  parseTodoItemSourceKey,
  suggestionUndoSchema,
  todoItemSourceKey,
  suggestionDecisionSchema,
  suggestionViewSchema,
  type DecisionContextResponse,
} from "@cognelis/decision-protocol";

import { organizationPreviewFixtures } from "../src/renderer/preview-organization.js";

describe("organization contract (IMP-191)", () => {
  it("parses every preview board's state as the App answers it", () => {
    for (const view of organizationPreviewFixtures.suggestions()) expect(() => suggestionViewSchema.parse(view)).not.toThrow();
    for (const view of organizationPreviewFixtures.handled()) expect(() => handledSuggestionViewSchema.parse(view)).not.toThrow();
    for (const state of ["waiting_idle", "running", "partial", "no_change", "failed"] as const) {
      expect(() => organizationRunViewSchema.parse(organizationPreviewFixtures.run(state))).not.toThrow();
    }
  });

  it("keeps the source kind in every key: a decision and a summary with one id are two sources", () => {
    expect(parseOrganizationSourceKey("decision:abc")).toEqual({ kind: "decision", id: "abc" });
    expect(parseOrganizationSourceKey("summary:abc")).toEqual({ kind: "summary", id: "abc" });
    expect(parseOrganizationSourceKey("todo_item:list-1#12")).toEqual({ kind: "todo_item", id: "list-1#12" });
    expect(parseOrganizationSourceKey("abc")).toBeNull();
  });

  it("takes every id already written, spaces, 中文, # and : included, and reads it back unchanged", () => {
    for (const id of ["abc", "带 空格 的 编号", "DEC-2026 #12", "a:b:c", "清单#1"]) {
      const key = organizationSourceKey("decision", id);
      expect(organizationSourceKeySchema.safeParse(key).success).toBe(true);
      expect(parseOrganizationSourceKey(key)).toEqual({ kind: "decision", id });
    }
    const item = todoItemSourceKey("消息 服务#草稿", 12);
    expect(organizationSourceKeySchema.safeParse(item).success).toBe(true);
    expect(parseTodoItemSourceKey(item)).toEqual({ listId: "消息 服务#草稿", item: 12 });
    expect(parseTodoItemSourceKey("todo_item:list#0")).toBeNull();
    expect(organizationSourceKeySchema.safeParse("decision: ").success).toBe(false);
  });

  it("does not widen a scope a field is missing from", () => {
    const base = { project: "P", profileId: "m" };
    expect(organizationRunRequestSchema.safeParse({ ...base, scope: "list" }).success).toBe(false);
    expect(organizationRunRequestSchema.safeParse({ ...base, scope: "selection", listId: "L", items: [] }).success).toBe(false);
    expect(organizationRunRequestSchema.safeParse({ ...base, scope: "selection", items: ["decision:x"] }).success).toBe(false);
    expect(organizationRunRequestSchema.safeParse({ ...base, scope: "project", items: ["todo_item:L#1"] }).success).toBe(false);
    expect(organizationRunRequestSchema.safeParse({ ...base, scope: "selection", listId: "L", items: ["todo_item:L#1"] }).success).toBe(true);
    expect(organizationQuerySchema.safeParse({ project: null, scope: "list" }).success).toBe(false);
    expect(organizationQuerySchema.safeParse({ project: null, scope: "list", listId: "L" }).success).toBe(true);
  });

  it("binds a forget and a restore to the preview and the diff that were seen", () => {
    expect(organizationForgetSchema.safeParse({ key: "decision:x", confirm: true }).success).toBe(false);
    expect(organizationForgetSchema.safeParse({ key: "decision:x", confirm: true, expectedPreviewHash: "a".repeat(64) }).success).toBe(true);
    expect(suggestionUndoSchema.safeParse({ id: "s", expectedRevision: 1, confirmDiff: true }).success).toBe(false);
    expect(suggestionUndoSchema.safeParse({ id: "s", expectedRevision: 1, expectedDiffHash: "b".repeat(64) }).success).toBe(true);
  });

  it("takes a defer date only as a real day or an ISO time", () => {
    const decide = (deferUntil: string) => suggestionDecisionSchema.safeParse({ id: "s", expectedRevision: 1, expectedEvidenceVersion: 1, action: "defer", deferUntil }).success;
    expect(decide("2026-11-15")).toBe(true);
    expect(decide("2026-11-15T09:00:00+08:00")).toBe(true);
    expect(decide("2026-02-30")).toBe(false);
    expect(decide("下周一")).toBe(false);
  });

  it("refuses a defer without a date, and background without a model", () => {
    expect(suggestionDecisionSchema.safeParse({ id: "s", expectedRevision: 1, expectedEvidenceVersion: 1, action: "defer" }).success).toBe(false);
    expect(organizationSettingsSchema.safeParse({ background: true, backgroundProfileId: null }).success).toBe(false);
    expect(organizationSettingsSchema.safeParse({ background: false, backgroundProfileId: null }).success).toBe(true);
  });
});

describe("context shape levels (experiences)", () => {
  const q = (input: object) => decisionContextQuerySchema.parse(input);

  it("reads the header by level", () => {
    expect(contextShapeLevel(undefined)).toBe(1);
    expect(contextShapeLevel("2")).toBe(2);
    expect(contextShapeLevel("3")).toBe(3);
    expect(contextShapeLevel("9")).toBe(1);
  });

  it("asks shape 3 only of a query that names experiences", () => {
    expect(contextShapeNeeded(q({ source: "decisions" }))).toBe(1);
    expect(contextShapeNeeded(q({ source: "preferences" }))).toBe(2);
    expect(contextShapeNeeded(q({ source: ["decisions", "ideas"] }))).toBe(2);
    expect(contextShapeNeeded(q({ source: "experiences" }))).toBe(3);
    expect(contextShapeNeeded(q({ source: ["decisions", "experiences"] }))).toBe(3);
  });

  it("answers a shape-2 bridge with its signals and without experience, a shape-1 one with neither", () => {
    const response = {
      results: [{ similarity: 0.5, signal: { standing: "s" }, amendment: { revision: 1 }, experience: { reporter: "agent" }, id: "x" }],
    } as unknown as DecisionContextResponse;
    const two = contextAsReleased(response, 2).results[0]!;
    expect(two).toHaveProperty("similarity");
    expect(two).toHaveProperty("signal");
    expect(two).toHaveProperty("amendment");
    expect(two).not.toHaveProperty("experience");
    const one = contextAsReleased(response).results[0]!;
    expect(Object.keys(one)).toEqual(["id"]);
    expect(contextAsReleased(response, 3).results[0]).toHaveProperty("experience");
  });

  it("never takes an experience, preference or idea for a decision source", () => {
    expect(isDecisionSource("experiences")).toBe(false);
    expect(isDecisionSource("ideas")).toBe(false);
    expect(isDecisionSource("summarize")).toBe(true);
    expect(() => decisionSourceOf({ source: "experiences" })).toThrow();
  });
});
