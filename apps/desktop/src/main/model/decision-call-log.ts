import type { ModelInvocationTrace } from "@cognelis/decision-protocol";
import { ModelTraceStore } from "@cognelis/decision-storage";

// ponytail: 90 days and 5,000 calls, a fixed ceiling; make it a setting if someone needs jev's history for longer.
export const DECISION_CALLS_MAXIMUM_AGE_MS = 90 * 24 * 60 * 60 * 1_000;
export const DECISION_CALLS_MAXIMUM_ITEMS = 5_000;

/**
 * jev's call records (IMP-166), apart from the shared traces: those keep 7 days and 1,000 calls, and everyday
 * recognition would push jev's out. Their input and output are always kept, whatever the content switch says.
 */
export const createDecisionCallStore = (path: string, now?: () => Date): ModelTraceStore =>
  new ModelTraceStore(path, {
    contentMode: () => "full",
    maximumAgeMs: DECISION_CALLS_MAXIMUM_AGE_MS,
    maximumItems: DECISION_CALLS_MAXIMUM_ITEMS,
    ...(now === undefined ? {} : { now }),
  });

type TraceStoreLike = Pick<ModelTraceStore, "list" | "deleteTrace" | "deleteRequest" | "clear">;

/**
 * The log page's one list over the shared traces and jev's own, oldest first as each store lists. jev's records are
 * optional, as jev is: a store of them that cannot be read (its folder taken by a file, its permissions broken) is
 * reported apart and left out, and never stands between the reader and the shared records or their usage counts.
 */
export const combinedTraces = (
  shared: TraceStoreLike,
  optional: readonly TraceStoreLike[],
  onOptionalError: (error: unknown) => void,
) => {
  const all = async <T>(operation: (store: TraceStoreLike) => Promise<T>): Promise<T[]> => {
    const [own, ...rest] = await Promise.allSettled([shared, ...optional].map(operation));
    for (const result of rest) if (result.status === "rejected") onOptionalError(result.reason);
    if (own!.status === "rejected") throw own!.reason;
    return [own!.value, ...rest.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))];
  };
  return {
    list: async (): Promise<ModelInvocationTrace[]> =>
      (await all((store) => store.list()))
        .flat()
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.traceId.localeCompare(right.traceId)),
    deleteTrace: async (traceId: string): Promise<boolean> =>
      (await all((store) => store.deleteTrace(traceId))).some(Boolean),
    deleteRequest: async (requestId: string | readonly string[]): Promise<number> =>
      (await all((store) => store.deleteRequest(requestId))).reduce((sum, count) => sum + count, 0),
    clear: async (): Promise<number> =>
      (await all((store) => store.clear())).reduce((sum, count) => sum + count, 0),
  };
};
