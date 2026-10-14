import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { reviewReminderNotifier } from "../src/main/review-notifications.js";

// Electron's Notification as far as reminders use it: shown, clicked, closed, and listed from Notification Center.
class FakeNotification extends EventEmitter {
  static supported = true;
  static delivered: FakeNotification[] = [];
  static isSupported(): boolean {
    return FakeNotification.supported;
  }
  static async getHistory(): Promise<FakeNotification[]> {
    return FakeNotification.delivered;
  }
  readonly groupId?: string;
  readonly show = vi.fn();
  constructor(options: { title: string; body: string; groupId?: string }) {
    super();
    if (options.groupId !== undefined) this.groupId = options.groupId;
  }
}

describe("review reminder notifications", () => {
  it("holds each reminder until it is clicked or dismissed, and opens the decisions when clicked", () => {
    const opened = vi.fn();
    const notifier = reviewReminderNotifier(FakeNotification, opened);

    notifier.notify({ title: "有 1 条决策到期复盘", body: "缓存放在哪一层？" });
    notifier.notify({ title: "有 1 条决策到期复盘", body: "协议用哪个版本？" });
    // Held by nothing, one was collected: gone from Notification Center by the morning, its click did nothing.
    expect(notifier.held.size).toBe(2);

    const [first, second] = [...notifier.held] as FakeNotification[];
    first!.emit("click");
    expect(opened).toHaveBeenCalledOnce();
    second!.emit("close");
    expect(notifier.held.size).toBe(0);
  });

  it("re-attaches the clicks of reminders a run before this one left in Notification Center", async () => {
    const opened = vi.fn();
    const notifier = reviewReminderNotifier(FakeNotification, opened);
    const leftOver = new FakeNotification({ title: "有 1 条决策到期复盘", body: "缓存放在哪一层？", groupId: "decision-review-reminders" });
    const another = new FakeNotification({ title: "别的通知", body: "" });
    FakeNotification.delivered = [leftOver, another];

    await notifier.reattach();
    // After a restart, a click on yesterday's reminder only brought the app forward.
    leftOver.emit("click");
    expect(opened).toHaveBeenCalledOnce();
    expect(another.listenerCount("click")).toBe(0);
  });
});
