import { describe, expect, it } from "vitest";

import { relativeTime } from "../src/renderer/relative-time.js";

// Local times, so the calendar days are the same in whatever zone the suite runs.
const now = new Date(2026, 9, 23, 14, 30).getTime();
const at = (month: number, day: number, hour = 12, minute = 0, year = 2026) => new Date(year, month - 1, day, hour, minute);

describe("relativeTime", () => {
  it("says how long ago from minutes to a date", () => {
    expect(relativeTime(now - 20_000, now)).toBe("刚刚");
    expect(relativeTime(now + 60_000, now)).toBe("刚刚");
    expect(relativeTime(at(10, 23, 14, 27), now)).toBe("3 分钟前");
    expect(relativeTime(at(10, 23, 9, 0), now)).toBe("5 小时前");
    expect(relativeTime(at(10, 22, 23, 50), now)).toBe("昨天");
    expect(relativeTime(at(10, 20), now)).toBe("周二");
    expect(relativeTime(at(10, 16), now)).toBe("10月16日");
    expect(relativeTime(at(12, 30, 12, 0, 2025), now)).toBe("2025年12月30日");
  });

  it("reads timestamps and ISO strings alike, and says nothing of a date it cannot read", () => {
    expect(relativeTime(at(10, 22).toISOString(), now)).toBe("昨天");
    expect(relativeTime("不是日期", now)).toBe("");
  });
});
