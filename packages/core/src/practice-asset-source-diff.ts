import type { MethodologyRecord } from "./methodology.js";
import type {
  PracticeAssetRecord,
  PracticeAssetSourceSnapshot,
} from "./practice-asset.js";

export type PracticeAssetSourceChangeState =
  | "unchanged"
  | "updated"
  | "unavailable"
  | "baseline_missing";

export type PracticeAssetSourceField =
  | "title"
  | "principle"
  | "appliesWhen"
  | "caution"
  | "confidence";

export interface PracticeAssetSourceFieldChange {
  field: PracticeAssetSourceField;
  before: string;
  after: string;
}

export interface PracticeAssetSourceChange {
  id: string;
  title: string;
  state: PracticeAssetSourceChangeState;
  previousUpdatedAt: string | null;
  currentUpdatedAt: string | null;
  fields: PracticeAssetSourceFieldChange[];
}

const sourceFields: PracticeAssetSourceField[] = [
  "title",
  "principle",
  "appliesWhen",
  "caution",
  "confidence",
];

export const snapshotPracticeAssetSources = (
  sources: MethodologyRecord[],
): PracticeAssetSourceSnapshot[] =>
  sources.map((source) => ({
    id: source.id,
    updatedAt: source.updatedAt,
    title: source.title,
    principle: source.principle,
    appliesWhen: source.appliesWhen,
    caution: source.caution,
    confidence: source.confidence,
  }));

export const comparePracticeAssetSources = (
  asset: PracticeAssetRecord,
  sources: MethodologyRecord[],
): PracticeAssetSourceChange[] => {
  const currentById = new Map(sources.map((source) => [source.id, source]));
  const snapshotById = new Map(
    (asset.sourceSnapshots ?? []).map((snapshot) => [snapshot.id, snapshot]),
  );
  return asset.sourcePrincipleIds.map((id) => {
    const current = currentById.get(id);
    const previous = snapshotById.get(id);
    if (
      current === undefined ||
      current.status !== "accepted" ||
      current.confirmedAt === null
    ) {
      return {
        id,
        title: current?.title ?? previous?.title ?? id,
        state: "unavailable",
        previousUpdatedAt: previous?.updatedAt ?? null,
        currentUpdatedAt: current?.updatedAt ?? null,
        fields: [],
      };
    }
    if (previous === undefined) {
      return {
        id,
        title: current.title,
        state: "baseline_missing",
        previousUpdatedAt: null,
        currentUpdatedAt: current.updatedAt,
        fields: [],
      };
    }
    const fields = sourceFields.flatMap((field) =>
      previous[field] === current[field]
        ? []
        : [{ field, before: previous[field], after: current[field] }],
    );
    return {
      id,
      title: current.title,
      state:
        fields.length > 0 || previous.updatedAt !== current.updatedAt
          ? "updated"
          : "unchanged",
      previousUpdatedAt: previous.updatedAt,
      currentUpdatedAt: current.updatedAt,
      fields,
    };
  });
};
