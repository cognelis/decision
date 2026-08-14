export type MethodologyRelationDisposition =
  "duplicate" | "conflict" | "unrelated";

export interface MethodologyRelationRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  principleIds: [string, string];
  principleTitles: [string, string];
  disposition: MethodologyRelationDisposition;
  note: string | null;
}

export const canonicalMethodologyPair = (
  first: string,
  second: string,
): [string, string] =>
  first.localeCompare(second) <= 0 ? [first, second] : [second, first];

export interface MethodologyDuplicateGroupCoverage {
  sourceCount: number;
  requiredPairCount: number;
  confirmedPairCount: number;
  complete: boolean;
  missingPairs: Array<[string, string]>;
}

export const assessMethodologyDuplicateGroup = (
  sourcePrincipleIds: string[],
  relations: MethodologyRelationRecord[],
): MethodologyDuplicateGroupCoverage => {
  const ids = [...new Set(sourcePrincipleIds.map((id) => id.trim()))].filter(
    Boolean,
  );
  const duplicatePairs = new Set(
    relations
      .filter((relation) => relation.disposition === "duplicate")
      .map((relation) =>
        canonicalMethodologyPair(...relation.principleIds).join("\0"),
      ),
  );
  const missingPairs: Array<[string, string]> = [];
  let requiredPairCount = 0;
  for (let left = 0; left < ids.length; left += 1) {
    for (let right = left + 1; right < ids.length; right += 1) {
      requiredPairCount += 1;
      const pair = canonicalMethodologyPair(ids[left]!, ids[right]!);
      if (!duplicatePairs.has(pair.join("\0"))) missingPairs.push(pair);
    }
  }
  return {
    sourceCount: ids.length,
    requiredPairCount,
    confirmedPairCount: requiredPairCount - missingPairs.length,
    complete: ids.length >= 2 && missingPairs.length === 0,
    missingPairs,
  };
};
