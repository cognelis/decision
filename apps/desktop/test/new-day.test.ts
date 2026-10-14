import { afterEach, describe, expect, it, vi } from "vitest";

import { watchForNewDay } from "../src/main/new-day.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("watchForNewDay", () => {
  it("calls back once when the local date turns over, and not again that day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 30, 23, 58));
    const onNewDay = vi.fn();
    const watch = watchForNewDay(onNewDay);

    vi.advanceTimersByTime(60_000);
    expect(onNewDay).not.toHaveBeenCalled();
    // Past midnight while the app idles in the tray: reviews due today are announced now.
    vi.advanceTimersByTime(2 * 60_000);
    expect(onNewDay).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(6 * 60 * 60_000);
    expect(onNewDay).toHaveBeenCalledOnce();
    watch.stop();
  });

  it("notices a day missed while asleep as soon as it is asked, and stops when told", () => {
    let now = new Date(2026, 8, 30, 22, 0);
    const onNewDay = vi.fn();
    const watch = watchForNewDay(onNewDay, () => now, 60_000);

    watch.check();
    expect(onNewDay).not.toHaveBeenCalled();
    // The lid opened the next morning: the timer may not have run, the resume check has.
    now = new Date(2026, 9, 1, 7, 30);
    watch.check();
    expect(onNewDay).toHaveBeenCalledOnce();
    watch.stop();
    // Quitting: a wake from sleep during shutdown refreshes nothing.
    now = new Date(2026, 9, 2, 7, 30);
    watch.check();
    expect(onNewDay).toHaveBeenCalledOnce();
  });
});
