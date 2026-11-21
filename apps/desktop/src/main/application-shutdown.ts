export interface ApplicationShutdownOptions {
  closeObsidian(): Promise<void>;
  writeObsidianMarker?: () => Promise<void>;
  flushSemanticPairs(): Promise<void>;
  closeSemanticCoordinator(): Promise<void>;
  closeDecisionSemanticSearch(): Promise<void>;
  /** The local models' process closed, or killed after its grace (LocalModelHost.shutdown). */
  closeLocalModels(): Promise<void>;
  /** Accepted local mutations drain independently of model cancellation and the controller deadline. */
  flushOrganization?: () => Promise<void>;
  stopController(): Promise<void>;
}

const attempt = async (operation: () => Promise<void>): Promise<void> => {
  try {
    await operation();
  } catch {
    // Every later shutdown stage must still run.
  }
};

// Model/read cleanup has a deadline: a stage that never settled (a model call deaf to its abort) kept
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
  // The model closes abort their calls as they are called, so the pair being classified is cut short before the inbox
  // waits on it; and nothing else waits on them: the server, the descriptor and Obsidian go at their own pace. No llama
  // call runs in this process any more (IMP-135): the local models' process is given its grace and then killed, and a
  // client's close after that still succeeds, so the knowledge page's close writes its marker.
  const coordinatorClosed = attempt(options.closeSemanticCoordinator);
  const searchClosed = attempt(options.closeDecisionSemanticSearch);
  const localModelsClosed = attempt(options.closeLocalModels);
  const organizationWrites = options.flushOrganization === undefined ? Promise.resolve() : attempt(options.flushOrganization);
  let obsidianShutdown: Promise<void>;
  try {
    obsidianShutdown = Promise.resolve(options.closeObsidian());
  } catch {
    obsidianShutdown = Promise.reject(new Error("Obsidian close failed"));
  }
  await within(stages(options, obsidianShutdown), STAGES_DEADLINE_MS);
  await organizationWrites;
  await within(attempt(options.stopController), STOP_DEADLINE_MS);
  await within(Promise.all([coordinatorClosed, searchClosed, localModelsClosed]).then(() => undefined), STAGES_DEADLINE_MS);
};

const stages = async (options: ApplicationShutdownOptions, obsidianShutdown: Promise<void>): Promise<void> => {
  const obsidianCompletion = obsidianShutdown.then(
    async () => {
      if (options.writeObsidianMarker !== undefined) {
        await options.writeObsidianMarker();
      }
    },
    () => undefined,
  ).catch(() => undefined);

  // The inbox takes up no further pair; the one cut short stays in the spool with the rest, for the next start
  // (SemanticDecisionCoordinator.process).
  await attempt(options.flushSemanticPairs);
  await obsidianCompletion;
};
