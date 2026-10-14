import type { DecisionRelationRecord, DecisionRelationReference } from "@cognelis/decision-protocol";

export interface DecisionLifecycleDocument {
  source: string;
  id: string;
  status: string;
  contentHash?: string;
  supersedes: string[];
  supersededBy: string[];
}

export const decisionReferenceKey = (record: Pick<DecisionRelationReference, "source" | "recordId">): string => `${record.source}:${record.recordId}`;
export const decisionRelationKey = (record: Pick<DecisionRelationRecord, "first" | "second">): string =>
  JSON.stringify([decisionReferenceKey(record.first), decisionReferenceKey(record.second)].sort());

export const canonicalDecisionRelation = <T extends Pick<DecisionRelationRecord, "first" | "second" | "successor">>(record: T): T =>
  decisionReferenceKey(record.first) < decisionReferenceKey(record.second) ? record : {
    ...record, first: record.second, second: record.first,
    successor: record.successor === null ? null : record.successor === "first" ? "second" : "first",
  };

export const decisionRelationState = (record: DecisionRelationRecord, documents: Map<string, DecisionLifecycleDocument>): "current" | "stale" | "missing_source" | "revoked" => {
  if (record.disposition === "revoked") return "revoked";
  const first = documents.get(decisionReferenceKey(record.first));
  const second = documents.get(decisionReferenceKey(record.second));
  if (first === undefined || second === undefined) return "missing_source";
  return first.contentHash === record.first.contentHash && second.contentHash === record.second.contentHash ? "current" : "stale";
};

export const buildDecisionLifecycle = (documents: DecisionLifecycleDocument[], relations: DecisionRelationRecord[], unavailable = false) => {
  const byKey = new Map(documents.map((document) => [`${document.source}:${document.id}`, document]));
  const successors = new Map(documents.map((document) => [`${document.source}:${document.id}`, new Set(document.supersededBy.map((id) => `${document.source}:${id}`))]));
  for (const document of documents) for (const id of document.supersedes) {
    const predecessor = `${document.source}:${id}`;
    if (!successors.has(predecessor)) successors.set(predecessor, new Set());
    successors.get(predecessor)!.add(`${document.source}:${document.id}`);
  }
  const needsReview = new Set<string>();
  const conflicts = new Set<string>();
  const byRecord = new Map<string, DecisionRelationRecord[]>();
  const states = new Map<string, ReturnType<typeof decisionRelationState>>();
  for (const relation of relations) {
    const first = decisionReferenceKey(relation.first);
    const second = decisionReferenceKey(relation.second);
    for (const key of [first, second]) {
      const list = byRecord.get(key);
      if (list === undefined) byRecord.set(key, [relation]); else list.push(relation);
    }
    const state = decisionRelationState(relation, byKey);
    states.set(decisionRelationKey(relation), state);
    if (state === "revoked") continue;
    if (state !== "current") { needsReview.add(first); needsReview.add(second); continue; }
    // A current explicit judgment supersedes the older inline relationship for
    // this pair, without rewriting either source note's fields or status.
    successors.get(first)?.delete(second);
    successors.get(second)?.delete(first);
    if (relation.disposition === "conflict") { conflicts.add(first); conflicts.add(second); }
    if (relation.disposition === "supersedes") {
      const newer = relation.successor === "first" ? first : second;
      const older = relation.successor === "first" ? second : first;
      successors.get(older)?.add(newer);
    }
  }

  const reverse = new Map<string, Set<string>>();
  for (const [from, targets] of successors) for (const target of targets) {
    if (!byKey.has(target)) needsReview.add(from);
    if (!reverse.has(target)) reverse.set(target, new Set());
    reverse.get(target)!.add(from);
  }
  // Iterative DFS avoids recursion limits on long imported lineage chains.
  const color = new Map<string, number>();
  const cycleAffected = new Set<string>();
  for (const root of successors.keys()) {
    if (color.has(root)) continue;
    const stack: Array<{ key: string; next: Iterator<string> }> = [];
    const positions = new Map<string, number>();
    const push = (key: string) => { color.set(key, 1); positions.set(key, stack.length); stack.push({ key, next: (successors.get(key) ?? new Set<string>()).values() }); };
    push(root);
    while (stack.length > 0) {
      const frame = stack.at(-1)!;
      const next = frame.next.next();
      if (next.done) { color.set(frame.key, 2); positions.delete(frame.key); stack.pop(); continue; }
      const target = next.value;
      if (!color.has(target)) push(target);
      else if (color.get(target) === 1) for (let i = positions.get(target)!; i < stack.length; i += 1) cycleAffected.add(stack[i]!.key);
    }
  }
  const propagate = (set: Set<string>) => {
    const queue = [...set];
    for (let index = 0; index < queue.length; index += 1) for (const predecessor of reverse.get(queue[index]!) ?? []) {
      if (!set.has(predecessor)) { set.add(predecessor); queue.push(predecessor); }
    }
  };
  propagate(cycleAffected);
  for (const key of cycleAffected) needsReview.add(key);
  propagate(needsReview);
  if (unavailable) for (const document of documents) if (document.source !== "principles") needsReview.add(`${document.source}:${document.id}`);
  const state = (document: DecisionLifecycleDocument): "current" | "superseded" | "uncertain" => {
    const key = `${document.source}:${document.id}`;
    if (needsReview.has(key)) return "uncertain";
    return document.status === "superseded" || document.status === "retired" || (successors.get(key)?.size ?? 0) > 0 ? "superseded" : "current";
  };
  return { successors, predecessors: reverse, conflicts, needsReview, cycleAffected, byRecord, states, state };
};
