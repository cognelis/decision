import { zonedFormatter } from "./calendar-date.js";

const weekday = zonedFormatter({ weekday: "short" });
const monthDay = zonedFormatter({ month: "short", day: "numeric" });
const yearMonthDay = zonedFormatter({ year: "numeric", month: "short", day: "numeric" });

const startOfDay = (time: number): number => {
  const day = new Date(time);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
};

/**
 * How long ago, as a list row says it: 刚刚, 5 分钟前, 3 小时前, 昨天, 周二, 10月16日, 2025年10月16日. Worked out when
 * the row is drawn, not kept up to date while it stays on screen.
 */
export const relativeTime = (at: Date | number | string, now = Date.now()): string => {
  const time = new Date(at).getTime();
  if (Number.isNaN(time)) return "";
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return "刚刚";
  // Calendar days, not 24-hour spans: rounded, so a day shortened or lengthened by daylight saving still counts as one.
  const days = Math.round((startOfDay(now) - startOfDay(time)) / 86_400_000);
  if (days === 0) return minutes < 60 ? `${minutes} 分钟前` : `${Math.floor(minutes / 60)} 小时前`;
  if (days === 1) return "昨天";
  if (days < 7) return weekday.format(new Date(time));
  return new Date(time).getFullYear() === new Date(now).getFullYear()
    ? monthDay.format(new Date(time))
    : yearMonthDay.format(new Date(time));
};
