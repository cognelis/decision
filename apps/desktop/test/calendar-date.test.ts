import { describe, expect, it, vi } from "vitest";

import { dueLabel, zonedFormatter } from "../src/renderer/calendar-date.js";

describe("calendar dates and moments", () => {
  it("dates a due day and a moment in the zone the Mac is in now, after it moves", () => {
    const zone = process.env.TZ;
    process.env.TZ = "Asia/Shanghai";
    try {
      const day = zonedFormatter({ month: "short", day: "numeric" });
      // 10:00 on 5 October in Los Angeles: 01:00 on the 6th in Shanghai.
      const created = new Date("2026-10-05T17:00:00.000Z");
      expect(dueLabel("2026-10-05")).toBe("10月5日");
      expect(day.format(created)).toBe("10月6日");

      // Taken to Los Angeles with the app kept open: built once, both kept Shanghai's dates, a review due on the
      // 5th said "10月6日复盘" and a decision recorded on the 5th was dated the 6th.
      process.env.TZ = "America/Los_Angeles";
      expect(dueLabel("2026-10-05")).toBe("10月5日");
      expect(day.format(created)).toBe("10月5日");
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });

  it("tells apart two zones at one offset today whose winters differ, with the app kept open through the move", () => {
    const zone = process.env.TZ;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
      process.env.TZ = "Europe/Berlin";
      const moment = zonedFormatter({ month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      // 22:30 UTC on 15 January: 23:30 in Berlin, 00:30 on the 16th in Johannesburg.
      const winter = new Date("2026-01-15T22:30:00.000Z");
      expect(moment.format(winter)).toBe("1月15日 23:30");

      // Both at +2 in July: told by the offset now alone, the move was no move, and every winter moment stayed
      // Berlin's until a restart.
      process.env.TZ = "Africa/Johannesburg";
      expect(moment.format(winter)).toBe("1月16日 00:30");
    } finally {
      vi.useRealTimers();
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });
});
