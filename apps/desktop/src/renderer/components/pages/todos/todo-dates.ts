import type { TodoPriority } from "@cognelis/decision-protocol";

/*
 * Days are `YYYY-MM-DD` strings, with no time and no zone: 截止日期 is a date, and "today" is the reader's local one.
 * Arithmetic goes through UTC midnights so a daylight-saving change never moves a day.
 */
const DAY = 86_400_000;
const utc = (day: string): number => {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return Date.UTC(year, month - 1, date);
};
const pad = (value: number): string => String(value).padStart(2, "0");

/** The reader's local date for a moment. */
export const localDay = (now: Date): string => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

export const addDays = (day: string, days: number): string => new Date(utc(day) + days * DAY).toISOString().slice(0, 10);

/** Days from `from` to `to`; negative when `to` is earlier. */
export const daysBetween = (from: string, to: string): number => Math.round((utc(to) - utc(from)) / DAY);

/** Monday is 0, Sunday 6. */
export const weekdayOf = (day: string): number => (new Date(utc(day)).getUTCDay() + 6) % 7;

export const isRealDay = (year: number, month: number, date: number): boolean => {
  const moment = new Date(Date.UTC(year, month - 1, date));
  return moment.getUTCFullYear() === year && moment.getUTCMonth() === month - 1 && moment.getUTCDate() === date;
};

export const makeDay = (year: number, month: number, date: number): string => `${String(year).padStart(4, "0")}-${pad(month)}-${pad(date)}`;

export const WEEKDAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"] as const;

export const PRIORITY_LABELS: Readonly<Record<TodoPriority, string>> = { p0: "P0", p1: "P1", p2: "P2", p3: "P3" };

/** P0 first, none last. */
export const priorityRank = (priority: TodoPriority | null): number => (priority === null ? 4 : Number(priority.slice(1)));

const monthDay = (day: string): string => {
  const [, month = 0, date = 0] = day.split("-").map(Number);
  return `${month}月${date}日`;
};

/** A due date in words: 今天, 明天, 周五 within the week, otherwise 11月20日 (with the year when it is not this one). */
export const dueLabel = (due: string, today: string): string => {
  const days = daysBetween(today, due);
  if (days === 0) return "今天";
  if (days === 1) return "明天";
  if (days === 2) return "后天";
  if (days === -1) return "昨天";
  if (days >= 3 && days <= 6) return WEEKDAY_NAMES[weekdayOf(due)]!;
  return due.slice(0, 4) === today.slice(0, 4) ? monthDay(due) : `${due.slice(0, 4)}年${monthDay(due)}`;
};

/** A day as a date, for the record of a change: 11月12日, with the year when it is not this one. */
export const dayText = (day: string, today: string): string => due4(day, today);

/** A date with its weekday, for a group heading or a confirmation: 11月12日 周三. */
export const dayHeading = (day: string, today: string): string => {
  const base = `${due4(day, today)} ${WEEKDAY_NAMES[weekdayOf(day)]}`;
  const days = daysBetween(today, day);
  return days === 0 ? `今天 · ${base}` : days === 1 ? `明天 · ${base}` : base;
};
const due4 = (day: string, today: string): string => (day.slice(0, 4) === today.slice(0, 4) ? monthDay(day) : `${day.slice(0, 4)}年${monthDay(day)}`);
