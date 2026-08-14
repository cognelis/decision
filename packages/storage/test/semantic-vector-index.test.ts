import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SemanticVectorIndex } from "../src/index.js";

const makeIndex = async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-vectors-"));
  return new SemanticVectorIndex(join(root, "vectors.sqlite"));
};

describe("SemanticVectorIndex", () => {
  it("round-trips vectors and replaces stale content atomically", async () => {
    const index = await makeIndex();
    index.upsert([
      {
        entityType: "decision",
        entityId: "decision-1",
        contentHash: "hash-1",
        model: "qwen-embedding-v1",
        vector: [0.6, 0.8],
      },
    ]);

    expect(index.list("decision", "qwen-embedding-v1")).toEqual([
      {
        entityType: "decision",
        entityId: "decision-1",
        contentHash: "hash-1",
        model: "qwen-embedding-v1",
        vector: [expect.closeTo(0.6), expect.closeTo(0.8)],
      },
    ]);

    index.upsert([
      {
        entityType: "decision",
        entityId: "decision-1",
        contentHash: "hash-2",
        model: "qwen-embedding-v2",
        vector: [1, 0, 0],
      },
    ]);
    expect(index.metadata("decision")).toEqual([
      {
        entityId: "decision-1",
        contentHash: "hash-2",
        model: "qwen-embedding-v2",
        dimension: 3,
      },
    ]);
    expect(index.list("decision", "qwen-embedding-v1")).toEqual([]);
    index.close();
  });

  it("prunes only missing entities of the requested type", async () => {
    const index = await makeIndex();
    index.upsert([
      {
        entityType: "decision",
        entityId: "keep",
        contentHash: "hash-1",
        model: "model",
        vector: [1, 0],
      },
      {
        entityType: "decision",
        entityId: "remove",
        contentHash: "hash-2",
        model: "model",
        vector: [0, 1],
      },
      {
        entityType: "methodology",
        entityId: "principle-1",
        contentHash: "hash-3",
        model: "model",
        vector: [0.5, 0.5],
      },
    ]);

    index.prune("decision", ["keep"]);

    expect(index.metadata("decision").map((item) => item.entityId)).toEqual([
      "keep",
    ]);
    expect(index.metadata("methodology")).toHaveLength(1);
    index.close();
  });
});
