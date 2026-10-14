import { describe, expect, it } from "vitest";

import { findTermRanges } from "../src/renderer/use-search-highlight.js";

describe("findTermRanges", () => {
  it("finds every term case-insensitively and merges overlaps in order", () => {
    expect(findTermRanges("Cache 缓存策略与缓存失效", "缓存 cache")).toEqual([
      [0, 5],
      [6, 8],
      [11, 13],
    ]);
    expect(findTermRanges("aaaa", "aa a")).toEqual([[0, 4]]);
  });

  it("keeps its offsets within a text whose lower case is longer, and takes the query's symbols as they are", () => {
    // "İ" lower-cases to two UTF-16 units: offsets from a lower-cased copy ran one past the end.
    expect(findTermRanges("İstanbul cache", "cache")).toEqual([[9, 14]]);
    expect(findTermRanges("a+b (c)", "a+b (c)")).toEqual([[0, 3], [4, 7]]);
  });

  it("marks nothing for a blank query or a missing term", () => {
    expect(findTermRanges("缓存策略", "   ")).toEqual([]);
    expect(findTermRanges("缓存策略", "日志")).toEqual([]);
  });
});
