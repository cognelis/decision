import type { MethodologyRelationRecord } from "@cognelis/decision-core";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  MethodologyRelationRepository,
  parseMethodologyRelation,
  serializeMethodologyRelation,
} from "../src/index.js";

const fixture = (
  overrides: Partial<MethodologyRelationRecord> = {},
): MethodologyRelationRecord => ({
  id: "relation-1",
  createdAt: "2026-08-06T10:00:00.000Z",
  updatedAt: "2026-08-06T10:00:00.000Z",
  principleIds: ["principle-b", "principle-a"],
  principleTitles: ["先扩大再验证", "先验证再扩大"],
  disposition: "conflict",
  note: "两条原则适用于同一发布窗口，但行动顺序相反。",
  ...overrides,
});

describe("MethodologyRelationRepository", () => {
  it("writes current markers and reads legacy relation markers", () => {
    const record = fixture();
    const current = serializeMethodologyRelation(record);
    const legacy = current.replaceAll(
      "<!-- decision:",
      "<!-- decision-island:",
    );

    expect(current).not.toContain("<!-- decision-island:");
    expect(parseMethodologyRelation(legacy)).toEqual(
      parseMethodologyRelation(current),
    );
  });

  it("round-trips one canonical, human-readable relationship note", () => {
    const markdown = serializeMethodologyRelation(fixture());
    const parsed = parseMethodologyRelation(markdown);

    expect(markdown).toContain("type: decision-methodology-relation");
    expect(markdown).toContain("disposition: conflict");
    expect(markdown).toContain("两条原则适用于同一发布窗口");
    expect(parsed).toEqual({
      ...fixture(),
      principleIds: ["principle-a", "principle-b"],
      principleTitles: ["先验证再扩大", "先扩大再验证"],
    });
  });

  it("atomically replaces and removes the single relation fact", async () => {
    const vault = await mkdtemp(join(tmpdir(), "methodology-relation-"));
    const repository = new MethodologyRelationRepository(vault);
    await repository.save(fixture());
    await repository.save(
      fixture({
        updatedAt: "2026-08-06T11:00:00.000Z",
        disposition: "unrelated",
        note: "文本相近，但一个约束发布、另一个约束数据迁移。",
      }),
    );

    await expect(repository.list()).resolves.toEqual([
      expect.objectContaining({
        disposition: "unrelated",
        note: "文本相近，但一个约束发布、另一个约束数据迁移。",
      }),
    ]);
    const directory = join(vault, "Decision Journal", "principle-relations");
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    expect(await readFile(join(directory, files[0]!), "utf8")).toContain(
      "无关",
    );

    await repository.remove("relation-1");
    await expect(repository.list()).resolves.toEqual([]);
    await expect(repository.remove("relation-1")).resolves.toBeUndefined();
  });

  it("rejects self-relations and oversized notes", () => {
    expect(() =>
      serializeMethodologyRelation(
        fixture({ principleIds: ["same", "same"] }),
      ),
    ).toThrow("must differ");
    expect(() =>
      serializeMethodologyRelation(fixture({ note: "x".repeat(501) })),
    ).toThrow("relation note");
  });
});
