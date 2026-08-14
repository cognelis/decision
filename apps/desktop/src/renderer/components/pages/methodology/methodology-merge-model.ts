import type {
  DecisionLibraryItem,
  MethodologyItem,
  MethodologyMergeInput,
} from "../../../../shared/renderer-api.js";

export interface MethodologyMergeDraftState {
  sources: MethodologyItem[];
  availablePrinciples: MethodologyItem[];
  availableEvidence: DecisionLibraryItem[];
  autoEvidenceSummary: string;
  input: MethodologyMergeInput;
}

export const mergeEvidence = (
  sources: MethodologyItem[],
): DecisionLibraryItem[] => {
  const byId = new Map<string, DecisionLibraryItem>();
  for (const decision of sources.flatMap((source) => source.sourceDecisions)) {
    byId.set(decision.id, decision);
  }
  return [...byId.values()];
};

export const mergeEvidenceSummary = (sources: MethodologyItem[]): string =>
  sources
    .map((source, index) => `来源原则 ${index + 1}：${source.evidenceSummary}`)
    .join("\n")
    .slice(0, 3_000);

export const sameIdSet = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((id) => right.includes(id));

export const updateMergeSources = (
  current: MethodologyMergeDraftState,
  sources: MethodologyItem[],
  availablePrinciples = current.availablePrinciples,
): MethodologyMergeDraftState => {
  const availableEvidence = mergeEvidence(sources);
  const allowedEvidence = new Set(
    availableEvidence.map((decision) => decision.id),
  );
  const retainedEvidence = current.input.sourceDecisionIds.filter((id) =>
    allowedEvidence.has(id),
  );
  const sourceDecisionIds = [
    ...retainedEvidence,
    ...availableEvidence
      .map((decision) => decision.id)
      .filter((decisionId) => !retainedEvidence.includes(decisionId)),
  ].slice(0, 5);
  const autoEvidenceSummary = mergeEvidenceSummary(sources);
  return {
    ...current,
    sources,
    availablePrinciples,
    availableEvidence,
    autoEvidenceSummary,
    input: {
      ...current.input,
      sourceDecisionIds,
      evidenceSummary:
        current.input.evidenceSummary === current.autoEvidenceSummary
          ? autoEvidenceSummary
          : current.input.evidenceSummary,
    },
  };
};
