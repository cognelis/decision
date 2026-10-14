interface ReminderNotification {
  readonly groupId?: string;
  on(event: "click" | "close", listener: () => void): unknown;
  show(): void;
}

interface ReminderNotificationClass {
  new (options: { title: string; body: string; groupId: string }): ReminderNotification;
  isSupported(): boolean;
  /** macOS: what is still in Notification Center, from this run or one before. */
  getHistory?(): Promise<ReminderNotification[]>;
}

// Told apart from any other notification in Notification Center by this.
const REMINDER_GROUP = "decision-review-reminders";

/**
 * Review reminders, each held until clicked or dismissed: held by nothing, one was garbage-collected, gone from
 * Notification Center by the morning, and a click on it did nothing. Clicked, it opens the decisions.
 */
export const reviewReminderNotifier = (Notifications: ReminderNotificationClass, onClick: () => void) => {
  const held = new Set<ReminderNotification>();
  const keep = (alert: ReminderNotification): void => {
    if (held.has(alert)) return;
    held.add(alert);
    alert.on("click", () => {
      held.delete(alert);
      onClick();
    });
    alert.on("close", () => held.delete(alert));
  };
  return {
    held,
    notify(notice: { title: string; body: string }): void {
      if (!Notifications.isSupported()) return;
      const alert = new Notifications({ title: notice.title, body: notice.body, groupId: REMINDER_GROUP });
      keep(alert);
      alert.show();
    },
    /** Reminders left in Notification Center by a run before this one: clicked, they open the decisions again. */
    async reattach(): Promise<void> {
      let delivered: ReminderNotification[] = [];
      try {
        delivered = (await Notifications.getHistory?.()) ?? [];
      } catch {
        // Not there to ask (unsigned builds, other platforms): nothing is left to re-attach.
      }
      for (const alert of delivered) if (alert.groupId === REMINDER_GROUP) keep(alert);
    },
  };
};
