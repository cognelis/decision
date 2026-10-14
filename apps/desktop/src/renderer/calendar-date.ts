/** Review dates are local calendar days (YYYY-MM-DD), not instants. */
export const calendarDate = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export const dateAfter = (days: number): string => {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return calendarDate(date);
};

// A calendar day is that day in every zone: read as UTC. Built for the zone the page loaded in, it was the day after
// once the Mac moved west (noon there past midnight here), "10月6日复盘" for one due on the 5th.
const dueDateFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

export const dueLabel = (reviewDueDate: string): string =>
  dueDateFormatter.format(new Date(`${reviewDueDate}T00:00:00Z`));

// The zone the Mac is in, told by its offsets now, at midwinter and at midsummer: cheap to read, where its name
// costs a formatter. Told by the offset now alone, Berlin and Johannesburg (both +2 all summer) were one zone: a
// winter moment stayed dated Berlin's way, and once Berlin left summer time every current one ran an hour behind.
// ponytail: two zones alike at all three instants but switching on different dates differ only between those
// dates, and are told apart once now crosses one.
const zoneSignature = (): string => {
  const now = new Date();
  const year = now.getFullYear();
  return `${now.getTimezoneOffset()}/${new Date(year, 0, 1).getTimezoneOffset()}/${new Date(year, 6, 1).getTimezoneOffset()}`;
};

/**
 * Dates and times of instants in the zone the Mac is in now. A formatter built once keeps the zone the page loaded
 * in: carried across zones (the app kept in the tray), every date was the old zone's until a restart, while due
 * dates and the 近 7 天 filter went by the new one. Built again when the zone moves.
 */
export const zonedFormatter = (options: Intl.DateTimeFormatOptions): Pick<Intl.DateTimeFormat, "format"> => {
  let zone = zoneSignature();
  let formatter = new Intl.DateTimeFormat("zh-CN", options);
  return {
    format: (date) => {
      const current = zoneSignature();
      if (current !== zone) {
        zone = current;
        formatter = new Intl.DateTimeFormat("zh-CN", options);
      }
      return formatter.format(date);
    },
  };
};
