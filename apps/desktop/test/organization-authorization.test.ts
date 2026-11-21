import { describe, expect, it } from "vitest";
import { organizationSourceAccess } from "../src/main/organization-authorization.js";
import { emptyOrganizationState } from "../src/main/organization-store.js";
import type { SourceSnapshot, SourceUnit } from "../src/main/organization-sources.js";

const note = (id: string, inputs: string[]): SourceUnit => ({
  key: `experience:${id}`, kind: "experience", project: null, title: id, label: id, material: id,
  relativePath: null, at: null, fingerprint: "a".repeat(64), evidenceFingerprint: "a".repeat(64),
  role: "derived", rootKeys: [`experience:${id}`], lineage: "self",
  experience: { id, noteHash: "a".repeat(64), status: "active", sourceKeys: [], inputKeys: inputs },
});
const snapshot = (units: SourceUnit[]): SourceSnapshot => ({ units: new Map(units.map((unit) => [unit.key, unit])), incomplete: new Set(), degraded: new Set(), unreadable: [], readAt: "2026-11-14T00:00:00.000Z" });

describe("传递授权图", () => {
  for (const kind of ["pending_confirmation", "pending_rationale", "review", "principle"] as const) it(`缺失的 ${kind} 不能当成没有祖先的原始叶子`, () => {
    const state = emptyOrganizationState(); state.settings.sources = ["experience", kind];
    expect(organizationSourceAccess(state, snapshot([note("child", [`${kind}:missing`])])).allows(["experience:child"])).toBe(false);
  });
  it("循环引用不会漏过停用的祖先，也不会阻止独立来源", () => {
    const state = emptyOrganizationState(); state.settings.sources = ["experience"];
    const { allows: allowed } = organizationSourceAccess(state, snapshot([note("a", ["experience:b"]), note("b", ["experience:a", "preference:root"]), note("safe", [])]));
    expect(allowed(["experience:a"])).toBe(false);
    expect(allowed(["experience:b"])).toBe(false);
    expect(allowed(["experience:safe"])).toBe(true);
    expect(allowed(["unknown:root"])).toBe(false);
    expect(allowed(["experience:missing"])).toBe(false);
  });
  it("长链按图传播，不递归溢出；重新授权后恢复整条链", () => {
    const state = emptyOrganizationState(); state.settings.sources = ["experience"];
    const sources = snapshot(Array.from({ length: 6000 }, (_, index) => note(String(index), [index === 0 ? "preference:root" : `experience:${index - 1}`])));
    expect(organizationSourceAccess(state, sources).allows(["experience:5999"])).toBe(false);
    state.settings.sources.push("preference");
    expect(organizationSourceAccess(state, sources).allows(["experience:5999"])).toBe(true);
    expect(organizationSourceAccess(state, sources).inputs(["experience:5999"])).toHaveLength(6001);
  });
  it("旧机器副本不猜独立边界，新记录只沿实际直接输入判断生命周期", () => {
    const state = emptyOrganizationState(); state.settings.sources = ["experience", "preference"];
    const choice = note("choice", ["preference:P"]); choice.experience!.userChoice = true;
    const current = note("current", ["experience:choice", "preference:P"]); current.experience!.directInputKeys = ["experience:choice"];
    const sources = snapshot([choice, note("legacy", ["experience:choice"]), current]);
    const access = organizationSourceAccess(state, sources);
    expect(access.current(["experience:choice"])).toBe(true);
    expect(access.current(["experience:current"])).toBe(true);
    expect(access.current(["experience:legacy"])).toBe(false);
    expect(access.inputs(["experience:current"])).toContain("preference:P");
  });
});
