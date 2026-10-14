export interface ApplicationShutdownOptions {
  closeObsidian(): Promise<void>;
  writeObsidianMarker?: () => Promise<void>;
  flushSemanticPairs(): Promise<void>;
  closeSemanticCoordinator(): Promise<void>;
  closeDecisionSemanticSearch(): Promise<void>;
  stopController(): Promise<void>;
}

const attempt = async (operation: () => Promise<void>): Promise<void> => {
  try {
    await operation();
  } catch {
    // Every later shutdown stage must still run.
  }
};

// A quit is held by nothing for longer than this: a stage that never settled (a model call deaf to its abort) kept
// the window open, logout waiting, and the server and the bridge's descriptor up behind it, until the reader forced
// it. The Obsidian search gives itself 10 s (its SHUTDOWN_TIMEOUT_MS) inside the first.
const STAGES_DEADLINE_MS = 12_000;
const STOP_DEADLINE_MS = 3_000;

const within = async (work: Promise<void>, ms: number): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work, new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  })]);
  clearTimeout(timer);
};

export const shutdownApplication = async (
  options: ApplicationShutdownOptions,
): Promise<void> => {
  await within(stages(options), STAGES_DEADLINE_MS);
  await within(attempt(options.stopController), STOP_DEADLINE_MS);
};

const stages = async (options: ApplicationShutdownOptions): Promise<void> => {
  let obsidianShutdown: Promise<void>;
  try {
    obsidianShutdown = Promise.resolve(options.closeObsidian());
  } catch {
    obsidianShutdown = Promise.reject(new Error("Obsidian close failed"));
  }
  const obsidianCompletion = obsidianShutdown.then(
    async () => {
      if (options.writeObsidianMarker !== undefined) {
        await options.writeObsidianMarker();
      }
    },
    () => undefined,
  ).catch(() => undefined);

  // The inbox takes up no further pair, and the model calls are cut short before the one under way is waited on:
  // cut short, it stays in the spool with the rest, for the next start (SemanticDecisionCoordinator.process).
  const flushed = attempt(options.flushSemanticPairs);
  await attempt(options.closeSemanticCoordinator);
  await flushed;
  await obsidianCompletion;
  await attempt(options.closeDecisionSemanticSearch);
};
