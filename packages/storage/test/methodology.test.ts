import type { MethodologyRecord } from "@cognelis/decision-core";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  MethodologyRepository,
  parseMethodology,
  serializeMethodology,
} from "../src/index.js";

const fixture = (
  overrides: Partial<MethodologyRecord> = {},
): MethodologyRecord => ({
  id: "principle-1",
  createdAt: "2026-08-02T10:00:00.000Z",
  updatedAt: "2026-08-02T10:00:00.000Z",
  origin: "decision_evidence",
  status: "candidate",
  confirmedAt: null,
  title: "先保持可逆，再扩大改动",
  principle: "在信息不足时，优先选择可快速回退的实现。",
  appliesWhen: "需求仍可能变化，且多个方案都能满足当前目标。",
  caution: "当迁移成本会随时间快速增长时，需要重新评估。",
  evidenceSummary: "证据 1 显示该策略降低了返工成本。",
  sourceDecisionIds: ["decision-1"],
  confidence: "low",
  generation: {
    requestId: "methodology:request-1",
    profileId: "builtin-qwen",
    provider: "Qwen 本地模型",
    model: "qwen3.5-2b-q4-k-m",
  },
  ...overrides,
});

describe("MethodologyRepository", () => {
  it("writes current markers and reads legacy methodology markers", () => {
    const record = fixture();
    const current = serializeMethodology(record);
    const legacy = current.replaceAll(
      "<!-- decision:",
      "<!-- decision-island:",
    );

    expect(current).not.toContain("<!-- decision-island:");
    expect(parseMethodology(legacy)).toEqual(record);
  });

  it("round-trips a traceable methodology note", () => {
    const record = fixture();
    const markdown = serializeMethodology(record);

    expect(markdown).toContain("type: decision-methodology");
    expect(markdown).toContain("origin: decision_evidence");
    expect(markdown).toContain("source_decisions:\n  - decision-1");
    expect(markdown).toContain("## 证据摘要");
    expect(parseMethodology(markdown)).toEqual(record);
  });

  it("atomically saves, lists, and replaces the same principle", async () => {
    const vault = await mkdtemp(join(tmpdir(), "decision-methodology-"));
    const repository = new MethodologyRepository(vault);
    await repository.save(fixture());
    await repository.save(
      fixture({
        status: "accepted",
        confirmedAt: "2026-08-03T10:00:00.000Z",
        updatedAt: "2026-08-03T10:00:00.000Z",
        principle: "先验证可逆路径，再扩大不可逆改动。",
      }),
    );

    const records = await repository.list();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      status: "accepted",
      principle: "先验证可逆路径，再扩大不可逆改动。",
    });
    expect(await repository.find("principle-1")).toEqual(records[0]);
    const directory = join(vault, "Decision Journal", "principles");
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.md$/u);
    expect(await readFile(join(directory, files[0]!), "utf8")).toContain(
      "status: accepted",
    );
  });

  it("round-trips an explicit usage-validation cursor without changing content", () => {
    const record = fixture({
      status: "accepted",
      confirmedAt: "2026-08-03T10:00:00.000Z",
      usageValidation: {
        reviewedAt: "2026-08-07T10:00:00.000Z",
        decisionId: "decision-validated-2",
        validatedAt: "2026-08-08T10:00:00.000Z",
      },
    });
    const markdown = serializeMethodology(record);

    expect(markdown).toContain(
      "usage_validation_reviewed_at: 2026-08-07T10:00:00.000Z",
    );
    expect(markdown).toContain(
      "usage_validation_decision: decision-validated-2",
    );
    expect(parseMethodology(markdown)).toEqual(record);
  });

  it("rejects accepted records without explicit confirmation time", () => {
    expect(() =>
      serializeMethodology(fixture({ status: "accepted", confirmedAt: null })),
    ).toThrow("confirmedAt");
  });

  it("round-trips an imported candidate without fabricated decision evidence", () => {
    const imported = fixture({
      origin: "markdown_import",
      sourceDecisionIds: [],
      importSource: {
        fileName: "团队方法论.md",
        contentSha256:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
      generation: {
        requestId: "methodology-import:1",
        profileId: "local-markdown-import",
        provider: "本地导入",
        model: "Markdown",
      },
    });

    const markdown = serializeMethodology(imported);
    expect(markdown).toContain("import_source_file: 团队方法论.md");
    expect(markdown).toContain(
      "import_source_sha256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    expect(parseMethodology(markdown)).toEqual(imported);
  });

  it("round-trips a manually entered candidate without fabricated evidence", () => {
    const manual = fixture({
      origin: "manual_entry",
      sourceDecisionIds: [],
      evidenceSummary: "人工录入，尚未关联经过结果复盘的决策证据。",
      generation: {
        requestId: "methodology-manual:1",
        profileId: "manual-methodology-entry",
        provider: "人工录入",
        model: "不调用模型",
      },
    });

    const markdown = serializeMethodology(manual);
    expect(markdown).toContain("origin: manual_entry");
    expect(markdown).toContain("source_decisions: []");
    expect(parseMethodology(markdown)).toEqual(manual);
  });

  it("round-trips a merge draft with multiple source principles", () => {
    const merged = fixture({
      origin: "principle_merge",
      sourceDecisionIds: ["decision-1", "decision-2"],
      sourcePrincipleIds: ["principle-a", "principle-b", "principle-c"],
      generation: {
        requestId: "methodology-merge:1",
        profileId: "manual-principle-merge",
        provider: "人工合并",
        model: "不调用模型",
      },
    });
    const markdown = serializeMethodology(merged);

    expect(markdown).toContain("origin: principle_merge");
    expect(markdown).toContain(
      "source_principles:\n  - principle-a\n  - principle-b\n  - principle-c",
    );
    expect(parseMethodology(markdown)).toEqual(merged);
  });

  it("round-trips a revision candidate with one stable source principle", () => {
    const revision = fixture({
      id: "principle-revision",
      origin: "principle_revision",
      sourceDecisionIds: ["decision-1", "decision-2"],
      sourcePrincipleIds: ["principle-1"],
      generation: {
        requestId: "methodology-revision:1",
        profileId: "manual-principle-revision",
        provider: "人工修订",
        model: "不调用模型",
      },
    });
    const markdown = serializeMethodology(revision);

    expect(markdown).toContain("origin: principle_revision");
    expect(markdown).toContain("source_principles:\n  - principle-1");
    expect(parseMethodology(markdown)).toEqual(revision);
  });

  it("round-trips an applied revision receipt without treating it as an ignored draft", () => {
    const applied = fixture({
      id: "principle-revision",
      origin: "principle_revision",
      status: "dismissed",
      sourcePrincipleIds: ["principle-1"],
      appliedAt: "2026-08-08T08:00:00.000Z",
      appliedToId: "principle-1",
      generation: {
        requestId: "methodology-revision:1",
        profileId: "manual-principle-revision",
        provider: "人工修订",
        model: "不调用模型",
      },
    });
    const markdown = serializeMethodology(applied);

    expect(markdown).toContain("applied_at: 2026-08-08T08:00:00.000Z");
    expect(markdown).toContain("applied_to: principle-1");
    expect(parseMethodology(markdown)).toEqual(applied);
  });

  it("round-trips a retired source with explicit supersession lineage", () => {
    const retired = fixture({
      status: "retired",
      confirmedAt: "2026-08-03T09:00:00.000Z",
      retiredAt: "2026-08-06T09:00:00.000Z",
      supersededById: "principle-merged",
    });
    const markdown = serializeMethodology(retired);

    expect(markdown).toContain("status: retired");
    expect(markdown).toContain("retired_at: 2026-08-06T09:00:00.000Z");
    expect(markdown).toContain("superseded_by: principle-merged");
    expect(parseMethodology(markdown)).toEqual(retired);
  });

  it("rejects partial or misplaced retirement metadata", () => {
    expect(() =>
      serializeMethodology(
        fixture({
          status: "retired",
          confirmedAt: "2026-08-03T09:00:00.000Z",
          retiredAt: "2026-08-06T09:00:00.000Z",
        }),
      ),
    ).toThrow("retiredAt and supersededById");
    expect(() =>
      serializeMethodology(
        fixture({
          retiredAt: "2026-08-06T09:00:00.000Z",
          supersededById: "principle-merged",
        }),
      ),
    ).toThrow("retiredAt and supersededById");
  });

  it("requires 2-5 traceable source principles for merge drafts", () => {
    expect(() =>
      serializeMethodology(
        fixture({
          origin: "principle_merge",
          sourcePrincipleIds: ["principle-a"],
        }),
      ),
    ).toThrow("requires 2-5 source principles");
    expect(() =>
      serializeMethodology(
        fixture({
          origin: "principle_merge",
          sourcePrincipleIds: ["a", "b", "c", "d", "e", "f"],
        }),
      ),
    ).toThrow("requires 2-5 source principles");
  });

  it("rejects revision candidates without one different source principle", () => {
    expect(() =>
      serializeMethodology(
        fixture({
          origin: "principle_revision",
          sourcePrincipleIds: [],
        }),
      ),
    ).toThrow("requires exactly 1");
    expect(() =>
      serializeMethodology(
        fixture({
          origin: "principle_revision",
          sourcePrincipleIds: ["principle-1"],
        }),
      ),
    ).toThrow("cannot use itself");
  });

  it("treats notes written before origin metadata as evidence-based records", () => {
    const legacy = serializeMethodology(fixture()).replace(
      "origin: decision_evidence\n",
      "",
    );

    expect(parseMethodology(legacy).origin).toBe("decision_evidence");
  });
});
