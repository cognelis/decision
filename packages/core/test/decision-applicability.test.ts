import { decisionScopeSchema, decisionTaskScopeSchema } from "@cognelis/decision-protocol";
import { describe, expect, it } from "vitest";
import { assessDecisionApplicability } from "../src/decision-applicability.js";

const record = (scope: unknown) => ({ project: "project", appliesWhen: null, scope: decisionScopeSchema.parse(scope) });
const task = (scope: unknown) => decisionTaskScopeSchema.parse(scope);

describe("explicit decision applicability", () => {
  it("rejects a frontend constraint for a backend task without guessing from tags", () => {
    const result = assessDecisionApplicability(record({ layers: ["frontend"] }), task({ layer: "backend" }), "project");
    expect(result.status).toBe("out_of_scope");
    expect(assessDecisionApplicability({ project: "project", appliesWhen: null }, task({ layer: "backend" }), "project").status).toBe("needs_review");
  });
  it("matches literal module boundaries and keeps mixed file scopes for review", () => {
    const scoped = record({ modules: ["src/api"], paths: ["src/api"], excludedPaths: ["src/api/generated"] });
    expect(assessDecisionApplicability(scoped, task({ module: "src/apiculture", files: ["src/api/request.ts"] }), "project").status).toBe("out_of_scope");
    expect(assessDecisionApplicability(scoped, task({ module: "src/api", files: ["src/api/request.ts"] }), "project").status).toBe("scope_match");
    expect(assessDecisionApplicability(scoped, task({ module: "src/api", files: ["src/api/generated/schema.ts"] }), "project").status).toBe("out_of_scope");
    expect(assessDecisionApplicability(scoped, task({ module: "src/api", files: ["src/api/request.ts", "src/api/generated/schema.ts"] }), "project").status).toBe("needs_review");
  });
  it("keeps a decision about a submodule in view of a task on the module around it", () => {
    const refunds = record({ modules: ["services/payments/refund"] });
    // Changing the refund service, as a task on services/payments: hidden as out of scope, it went missing just there.
    expect(assessDecisionApplicability(refunds, task({ module: "services/payments", files: ["services/payments/refund/RefundService.java"] }), "project").status).toBe("scope_match");
    expect(assessDecisionApplicability(refunds, task({ module: "services/payments" }), "project").status).toBe("needs_review");
    expect(assessDecisionApplicability(refunds, task({ module: "services/orders" }), "project").status).toBe("out_of_scope");
  });
  it("requires review for textual exceptions, incomplete context and changed source versions", () => {
    expect(assessDecisionApplicability(record({ exceptions: ["一次性迁移脚本例外"] }), task({}), "project").status).toBe("needs_review");
    expect(assessDecisionApplicability(record({ layers: ["frontend"] }), undefined, "project").status).toBe("needs_review");
    const changed = { ...record({ layers: ["frontend"] }), scopeState: "stale" };
    expect(assessDecisionApplicability(changed, task({ layer: "backend" }), "other").status).toBe("needs_review");
  });
  it("lets an explicit repository identity disambiguate equal names and renamed clones", () => {
    const id = `repo:${"a".repeat(64)}`;
    const scope = record({ repositoryIds: [id] });
    expect(assessDecisionApplicability(scope, task({ repository: { id, project: "renamed", relativeDirectory: "", identitySource: "remote" } })).status).toBe("scope_match");
    expect(assessDecisionApplicability(scope, task({ repository: { id: `repo:${"b".repeat(64)}`, project: "project", relativeDirectory: "", identitySource: "remote" } })).status).toBe("out_of_scope");
  });
  it("rejects path traversal and glob patterns in explicit file/module constraints", () => {
    for (const path of ["../server", "/private", "src/**", "src\\file", "src/../server"]) expect(decisionScopeSchema.safeParse({ paths: [path] }).success).toBe(false);
  });
});
