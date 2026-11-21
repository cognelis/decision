import { emptyOrganizationState, type OrganizationState, type StoredSuggestion } from "../src/main/organization-store.js";

export const CAPACITY_AT = "2026-11-15T00:00:00.000Z";
const fingerprint = "a".repeat(64);

/** Synthetic historical revisions: repeated payloads, but distinct identities and durable receipts. */
export const capacityState = (count: number, start = 0): OrganizationState => {
  const state = emptyOrganizationState();
  state.ledger.forgotten["preference:forgotten"] = CAPACITY_AT;
  state.ledger.forgottenEvidence["preference:forgotten"] = "b".repeat(64);
  state.ledger.queue = [{ key: "decision:queued", reason: "changed", at: CAPACITY_AT }];
  for (let index = start; index < start + count; index += 1) {
    const id = `history-${index}`;
    const source = `decision:source-${index}`;
    const body = {
      title: `合成历史 ${index}`,
      scene: "这是仅用于容量验证的项目边界。".repeat(10),
      action: "已记录的操作步骤，不能代替新的授权。".repeat(8),
      observation: `用户确认的独立选择 ${index}：先验证，发布另行决定。`,
      inference: "机器推断不是用户选择，适用范围仍需核对。".repeat(8),
      exceptions: "没有覆盖的情况保留为未知。".repeat(8),
    };
    const suggestion: StoredSuggestion = {
      id, type: "experience", project: "capacity-lab", anchor: [source], revision: 2,
      evidence: { version: 1, inputFingerprint: fingerprint, sources: [{ key: source, kind: "decision", role: "statement", label: `来源 ${index}`, rootKeys: [source], lineage: "self", fingerprint, evidenceFingerprint: fingerprint, basis: { excerpt: body.observation, excerptHash: fingerprint }, project: "capacity-lab", relativePath: null, at: CAPACITY_AT }], counter: [] },
      content: { type: "experience", memoryKind: "knowledge", body, outcome: "unknown", reporter: "user", verification: "user_reported" },
      title: body.title, why: "旧建议及其判断原样保留", effect: "保留历史", unchanged: "原始来源不变", model: null,
      inputKeys: [source], directInputKeys: [source], state: "merged", mergedInto: "current", stale: null, deferUntil: null, draft: null, reopenReason: null,
      receipts: [{ action: "adopt", at: CAPACITY_AT, revision: 1, note: body.observation }, { action: "undo", at: CAPACITY_AT, revision: 1, evidence: { [source]: fingerprint } }, { action: "reject", at: CAPACITY_AT, revision: 2, evidence: { [source]: fingerprint }, note: "相同证据不再提醒" }],
      apply: { opId: `op-${index}`, action: "undo", dependencies: [{ key: source, fingerprint }], phase: "done", startedAt: CAPACITY_AT,
        steps: [{ stepId: `${id}:archive`, kind: "experience_archive", target: `experience:${id}`, expected: { noteHash: fingerprint }, before: { body, status: "active" }, after: { status: "archived" }, state: "written", result: { hash: fingerprint } }] },
      appliedAt: CAPACITY_AT, automatic: false, redacted: false, createdAt: CAPACITY_AT, updatedAt: CAPACITY_AT,
    };
    state.suggestions[id] = suggestion;
  }
  return state;
};
