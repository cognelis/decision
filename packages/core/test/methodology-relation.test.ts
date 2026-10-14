import {
  assessMethodologyDuplicateGroup,
  type MethodologyRelationRecord,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

const duplicate = (
  first: string,
  second: string,
): MethodologyRelationRecord => ({
  id: `relation:${first}:${second}`,
  createdAt: "2026-08-08T10:00:00.000Z",
  updatedAt: "2026-08-08T10:00:00.000Z",
  principleIds: [first, second],
  principleTitles: [first, second],
  disposition: "duplicate",
  note: null,
});

describe("assessMethodologyDuplicateGroup", () => {
  it("requires every pair in a multi-principle group to be confirmed", () => {
    expect(
      assessMethodologyDuplicateGroup(
        ["principle-a", "principle-b", "principle-c"],
        [
          duplicate("principle-a", "principle-b"),
          duplicate("principle-b", "principle-c"),
        ],
      ),
    ).toMatchObject({
      sourceCount: 3,
      requiredPairCount: 3,
      confirmedPairCount: 2,
      complete: false,
      missingPairs: [["principle-a", "principle-c"]],
    });
  });

  it("takes a pair's newest verdict, as the quality view does", () => {
    const stale = duplicate("principle-a", "principle-b");
    const newer: MethodologyRelationRecord = {
      ...duplicate("principle-b", "principle-a"),
      id: "relation:principle-a:principle-b:2",
      updatedAt: "2026-08-09T10:00:00.000Z",
      disposition: "unrelated",
    };

    // Any duplicate fact counted, the pair since judged unrelated still opened a merge.
    for (const relations of [[stale, newer], [newer, stale]]) {
      expect(assessMethodologyDuplicateGroup(["principle-a", "principle-b"], relations)).toMatchObject({
        complete: false,
        missingPairs: [["principle-a", "principle-b"]],
      });
    }
  });

  it("accepts a complete five-principle duplicate group", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const relations = ids.flatMap((first, index) =>
      ids.slice(index + 1).map((second) => duplicate(first, second)),
    );

    expect(assessMethodologyDuplicateGroup(ids, relations)).toMatchObject({
      sourceCount: 5,
      requiredPairCount: 10,
      confirmedPairCount: 10,
      complete: true,
      missingPairs: [],
    });
  });
});
