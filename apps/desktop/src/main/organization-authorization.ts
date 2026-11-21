import { organizationSourceKeySchema, type OrganizationSettings, type OrganizationSourceKind } from "@cognelis/decision-protocol";

import type { SourceSnapshot } from "./organization-sources.js";
import type { OrganizationState, StoredSuggestion } from "./organization-store.js";

/** 授权依赖与支持证据分开；旧草稿、反例和版本说明同样受来源开关约束。 */
export const suggestionInputKeys = (suggestion: StoredSuggestion): string[] => [
  ...(suggestion.inputKeys ?? []), ...(suggestion.directInputKeys ?? []), ...suggestion.anchor,
  ...[...suggestion.evidence.sources, ...suggestion.evidence.counter].flatMap((source) => [source.key, ...source.rootKeys]),
];
export const suggestionDirectInputKeys = (suggestion: StoredSuggestion): string[] => suggestion.directInputKeys === undefined ? suggestionInputKeys(suggestion) : [...new Set([...suggestion.directInputKeys, ...suggestion.anchor, ...suggestion.evidence.sources.map((source) => source.key), ...suggestion.evidence.counter.map((source) => source.key)])];

const sourceEnabled = (settings: OrganizationSettings, kind: OrganizationSourceKind): boolean =>
  settings.sources?.includes(kind) ?? (settings.automatic === true || ["todo_item", "decision", "summary", "preference", "idea", "experience"].includes(kind));

/** 一次读取的来源图，按当前设置将禁用传播到所有下游；不修改笔记或增加独立证据。 */
export const organizationSourceAccess = (state: OrganizationState, sources: SourceSnapshot, changed: Iterable<string> = []) => {
  const graph = new Map<string, Set<string>>();
  const lifecycle = new Map<string, Set<string>>();
  const legacy = new Set<string>();
  const evidenceChanged = new Set<string>();
  const blocked = new Set<string>();
  const unavailable = new Set<string>();
  const derivedKinds: OrganizationSourceKind[] = ["experience", "pending_confirmation", "pending_rationale", "review", "principle"];
  const add = (key: string, inputs: Iterable<string>, target = graph) => {
    const dependencies = target.get(key) ?? new Set<string>();
    for (const input of inputs) if (input !== key) dependencies.add(input);
    target.set(key, dependencies);
  };
  for (const unit of sources.units.values()) {
    add(unit.key, [...unit.rootKeys, ...(unit.experience?.sourceKeys ?? []), ...(unit.experience?.inputKeys ?? []), ...(unit.experience?.directInputKeys ?? [])]);
    add(unit.key, unit.experience?.userChoice ? [] : [...(unit.experience?.directInputKeys ?? unit.experience?.inputKeys ?? unit.rootKeys), ...(unit.experience?.sourceKeys ?? [])], lifecycle);
    if (unit.experience !== undefined && !unit.experience.userChoice && unit.experience.directInputKeys === undefined) legacy.add(unit.key);
  }
  for (const suggestion of Object.values(state.suggestions)) {
    for (const source of [...suggestion.evidence.sources, ...suggestion.evidence.counter]) {
      // 这些来源的全部祖先在 rootKeys；经验还可能有未引用输入，不能仅凭 rootKeys 还原。
      if (!sources.units.has(source.key) && source.kind !== "experience" && derivedKinds.includes(source.kind)) add(source.key, source.rootKeys);
    }
    for (const step of suggestion.apply?.steps ?? []) if (step.kind === "experience_create") {
      add(step.target, suggestionInputKeys(suggestion));
      const independent = suggestion.type === "judgment" && suggestion.state === "applied";
      // 用户确认是新的事实；其自身的失效仍会向下游传播。
      if (independent) lifecycle.set(step.target, new Set());
      else if (sources.units.get(step.target)?.experience?.userChoice !== true) add(step.target, suggestionDirectInputKeys(suggestion), lifecycle);
      if (independent || sources.units.get(step.target)?.experience?.userChoice === true) legacy.delete(step.target);
      else if (suggestion.directInputKeys === undefined) legacy.add(step.target);
      if (!independent && sources.units.get(step.target)?.experience?.userChoice !== true && [...suggestion.evidence.sources, ...suggestion.evidence.counter].some((source) => {
        const unit = sources.units.get(source.key);
        return unit !== undefined && unit.evidenceFingerprint !== source.evidenceFingerprint;
      })) evidenceChanged.add(step.target);
      if (suggestion.redacted) unavailable.add(step.target);
    }
  }
  const inputs = (keys: Iterable<string>): string[] => {
    const found = new Set(keys);
    for (const key of found) for (const input of graph.get(key) ?? []) found.add(input);
    return [...found];
  };
  const dependents = new Map<string, Set<string>>();
  for (const [key, inputs] of graph) for (const input of inputs) {
    const next = dependents.get(input) ?? new Set<string>();
    next.add(key); dependents.set(input, next);
  }
  const permissions = new Map<string, boolean>();
  const permitted = (key: string): boolean => {
    if (!permissions.has(key)) {
      const valid = organizationSourceKeySchema.safeParse(key).success;
      const kind = key.slice(0, key.indexOf(":")) as OrganizationSourceKind;
      // 缺失的原始来源仍能按类型检查；缺失的派生节点无法确认其祖先，保守停用。
      permissions.set(key, valid && sourceEnabled(state.settings, kind));
      if (valid && derivedKinds.includes(kind) && !graph.has(key)) unavailable.add(key);
    }
    return permissions.get(key)!;
  };
  for (const key of new Set([...graph.keys(), ...dependents.keys()])) if (!permitted(key)) blocked.add(key);
  const queue = [...blocked];
  for (let index = 0; index < queue.length; index += 1) {
    for (const key of dependents.get(queue[index]!) ?? []) if (!blocked.has(key)) { blocked.add(key); queue.push(key); }
  }
  type LifecycleStatus = "current" | "changed" | "unreadable" | "gone";
  const stale = new Map<string, Exclude<LifecycleStatus, "current">>();
  const priority = { changed: 1, unreadable: 2, gone: 3 };
  const markStale = (key: string, reason: Exclude<LifecycleStatus, "current">): boolean => {
    const before = stale.get(key);
    if (before !== undefined && priority[before] >= priority[reason]) return false;
    stale.set(key, reason); return true;
  };
  for (const key of [...unavailable, ...changed, ...evidenceChanged]) markStale(key, "changed");
  const affected = new Map<string, Set<string>>();
  for (const [key, inputs] of lifecycle) for (const input of inputs) {
    const next = affected.get(input) ?? new Set<string>(); next.add(key); affected.set(input, next);
  }
  for (const key of new Set([...graph.keys(), ...dependents.keys(), ...lifecycle.keys(), ...affected.keys()])) {
    const unit = sources.units.get(key);
    if (unit === undefined) markStale(key, sources.incomplete.has(key.slice(0, key.indexOf(":")) as OrganizationSourceKind) ? "unreadable" : "gone");
    else if (unit.metadataUnreadable || sources.degraded.has(unit.kind)) markStale(key, "unreadable");
    else if (unit.inactive) markStale(key, "changed");
    const forgottenAt = state.ledger.forgotten[key];
    const forgottenFingerprint = state.ledger.forgottenEvidence[key];
    if (unit !== undefined && forgottenAt !== undefined && (forgottenFingerprint !== undefined ? forgottenFingerprint === unit.evidenceFingerprint : unit.at !== null && unit.at <= forgottenAt)) { markStale(key, "changed"); unavailable.add(key); }
  }
  const spread = (reasons: typeof stale, links: typeof affected) => {
    const queue = [...reasons.keys()];
    for (let index = 0; index < queue.length; index += 1) for (const key of links.get(queue[index]!) ?? []) {
      const reason = reasons.get(queue[index]!)!; const before = reasons.get(key);
      if (before === undefined || priority[before] < priority[reason]) { reasons.set(key, reason); queue.push(key); }
    }
  };
  // 旧机器产物可能读过选择的机器背景，先按完整图保守冻结；不展开成长链的平方规模。
  const legacyStatus = new Map(stale); spread(legacyStatus, dependents);
  for (const key of legacy) { const reason = legacyStatus.get(key); if (reason !== undefined) markStale(key, reason); }
  spread(stale, affected);
  const unavailableQueue = [...unavailable];
  for (let index = 0; index < unavailableQueue.length; index += 1) {
    for (const key of affected.get(unavailableQueue[index]!) ?? []) if (!unavailable.has(key)) { unavailable.add(key); unavailableQueue.push(key); }
  }
  const allows = (keys: Iterable<string>): boolean => {
    for (const key of keys) if (!permitted(key) || blocked.has(key) || unavailable.has(key)) return false;
    return true;
  };
  const status = (key: string): LifecycleStatus => stale.get(key) ?? (sources.units.has(key) ? "current" : sources.incomplete.has(key.slice(0, key.indexOf(":")) as OrganizationSourceKind) ? "unreadable" : "gone");
  return {
    allows,
    status,
    current: (keys: Iterable<string>): boolean => { for (const key of keys) if (status(key) !== "current") return false; return true; },
    usable: (keys: Iterable<string>): boolean => { const all = [...keys]; return allows(all) && all.every((key) => status(key) === "current"); },
    inputs,
    suggestionInputs: (suggestion: StoredSuggestion): string[] => suggestion.directInputKeys === undefined ? inputs(suggestionInputKeys(suggestion)) : suggestionDirectInputKeys(suggestion),
  };
};
