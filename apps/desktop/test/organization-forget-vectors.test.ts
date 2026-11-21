import { describe, expect, it } from "vitest";

import { ContextSearch } from "../src/main/decision-context-signals.js";
import { DecisionContextService } from "../src/main/decision-context-service.js";
import { SemanticSearchService } from "../src/main/semantic-search-service.js";

describe("forgetting what a search under way holds (IMP-191, Astra)", () => {
  it("neither answers nor caches again an entry let go of while it was being embedded", async () => {
    let calls = 0;
    let entered!: () => void; let release!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const open = new Promise<void>((resolve) => { release = resolve; });
    const service = new SemanticSearchService({
      vectors: { close: () => undefined } as never,
      gateway: { embed: async (texts: string[]) => {
        calls += 1;
        if (calls === 2) { entered(); await open; }
        return { model: "synthetic", vectors: texts.map(() => [1, 0]) };
      } } as never,
    });
    const items = [{ id: "experience:test", text: "合成遗忘内容" }];
    const pending = service.similarEntries("query", items, {}, 5_000);
    await inside;
    service.forgetEntries(["experience:test"]);
    release();
    const answered = await pending;
    expect("near" in answered ? answered.near : []).toEqual([]);
    const before = calls;
    await service.similarEntries("query", items, {}, 5_000);
    // The query and the entry again: nothing was kept of it.
    expect(calls - before).toBe(2);
    await service.close();
  });

  it("does not answer an experience forgotten after the search read it", async () => {
    const record = {
      id: "E-1", revision: 1, status: "active" as const, project: null, createdAt: "2026-11-11T00:00:00.000Z", updatedAt: "2026-11-11T00:00:00.000Z",
      reporter: "agent" as const, verification: "agent_reported_unverified" as const, outcome: "effective" as const, adoptedFrom: null, generator: null,
      body: { title: "重试验证", scene: "弱网", action: "幂等键", observation: "重试没有重复", inference: "有效", exceptions: "未验证多设备" }, sources: [],
    };
    let scans = 0;
    const search = new ContextSearch(
      new DecisionContextService({ scan: async () => ({ documents: [], sources: [] }) }),
      undefined, undefined, undefined,
      { scan: async () => ({ experiences: scans++ === 0 ? [{ record, path: "/v/e.md", relativePath: "e.md", noteHash: "a".repeat(64) }] : [], diagnostics: [] }) },
    );
    const found = await search.search({ source: "experiences", query: "" } as never);
    expect(found.results).toHaveLength(0);
    expect(found.coverage).toBe("partial");
    expect(JSON.stringify(found)).not.toContain("重试没有重复");
  });
});
