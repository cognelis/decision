/**
 * Calls back once the local date has turned over. A day turning over while the app idles in the tray
 * publishes nothing else, so reviews that came due would wait for the reader's next action: the date is
 * looked at each minute, and whenever `check` is called (on waking from sleep).
 */
export const watchForNewDay = (
  onNewDay: () => void,
  now: () => Date = () => new Date(),
  every = 60_000,
): { check(): void; stop(): void } => {
  let day = now().toDateString();
  let stopped = false;
  const check = (): void => {
    // Once stopped (the app quitting), a wake from sleep refreshes nothing that is shutting down.
    if (stopped) return;
    const current = now().toDateString();
    if (current === day) return;
    day = current;
    onNewDay();
  };
  const timer = setInterval(check, every);
  return {
    check,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
};
