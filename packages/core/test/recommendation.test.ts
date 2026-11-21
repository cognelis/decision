import { describe, expect, it } from "vitest";

import { recommendationFollow } from "../src/recommendation.js";

const labels = (...values: string[]) => values.map((label) => ({ label }));
const pick = (value: string) => ({ kind: "preset", values: [value] });

describe("recommendationFollow", () => {
  it.each([
    "兼容迁移（推荐）",
    "兼容迁移(推荐)",
    "兼容迁移【推荐】",
    "兼容迁移［推荐］",
    "推荐：兼容迁移",
    "兼容迁移 (Recommended)",
    "兼容迁移 [recommended]",
    "Recommended: 兼容迁移",
  ])("reads %s as the recommendation, answered without the marker", (label) => {
    expect(recommendationFollow(labels(label, "直接替换"), pick("兼容迁移"))).toBe("followed");
    expect(recommendationFollow(labels(label, "直接替换"), pick(label))).toBe("followed");
    expect(recommendationFollow(labels(label, "直接替换"), pick("直接替换"))).toBe("not_followed");
  });

  it("has no recommendation when none or several options carry a marker", () => {
    expect(recommendationFollow(labels("A", "B"), pick("A"))).toBeNull();
    expect(recommendationFollow(labels("A（推荐）", "B（推荐）"), pick("A"))).toBeNull();
  });

  it("ignores a marker that is only in the description or not in brackets", () => {
    expect(
      recommendationFollow(
        [{ label: "A", description: "（推荐）用于小团队" }, { label: "B" }],
        pick("A"),
      ),
    ).toBeNull();
    expect(recommendationFollow(labels("推荐用于小团队", "B"), pick("B"))).toBeNull();
  });

  it("counts a custom answer as not following and leaves multi-select out", () => {
    const options = labels("A（推荐）", "B");
    expect(recommendationFollow(options, { kind: "custom", values: ["自己的办法"] })).toBe("not_followed");
    expect(recommendationFollow(options, { kind: "multiple", values: ["A", "B"] })).toBeNull();
  });
});
