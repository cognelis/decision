import { ModelProviderError } from "./http-model-transport.js";

/** Past this much lateness the timer says more about the process than the call. */
const LATE_DEADLINE_MS = 1_000;

/**
 * What ended a call its caller's signal aborted. A deadline the app sets itself (the capture's overall budget, the
 * bound on a draft nobody can stop, a review's time limits) aborts with a TimeoutError: that is a timeout, as the
 * caller reports it, and only a stop is a cancellation. Filed as cancelled, a call nobody stopped read 已取消 in the
 * call log. Its message stays a stop's, which a caller shows as it is (a review's follow-up does).
 */
export const abortFailure = (signal: AbortSignal | undefined): ModelProviderError =>
  (signal?.reason as { name?: unknown } | undefined)?.name === "TimeoutError"
    ? new ModelProviderError("timeout", "Model call was cancelled", { diagnosticExcerpt: "Model call reached its caller's deadline" })
    : new ModelProviderError("cancelled", "Model call was cancelled");

/**
 * Bounds even an adapter that ignores abort; caller cancellation never triggers fallback. With no `timeoutMs`
 * it only cancels: for a backend that times its own calls (SemanticClassifier.queuesCalls).
 */
export const withProviderDeadline = async <T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number | undefined, parent?: AbortSignal): Promise<T> => {
  if (parent?.aborted) throw abortFailure(parent);
  const armedAt = performance.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => { reject(abortFailure(parent)); controller.abort(); };
    parent?.addEventListener("abort", abort, { once: true });
    if (timeoutMs === undefined) return;
    timer = setTimeout(() => {
      /*
       * How late the timer itself was. This deadline is a plain timer racing
       * the call, so it cannot be late unless the main process was busy doing
       * something else — and then the elapsed time says nothing about the
       * provider. One real turn recorded a 30s budget that reported 120s, and
       * the log could not tell a slow endpoint from a stalled process.
       */
      const late = Math.round(performance.now() - armedAt - timeoutMs);
      reject(
        new ModelProviderError(
          "timeout",
          "Model provider attempt timed out",
          {
            diagnosticExcerpt:
              late <= LATE_DEADLINE_MS
                ? `Model provider attempt timed out after ${timeoutMs}ms`
                : `Model provider attempt timed out after ${timeoutMs}ms; the deadline itself fired ${late}ms late, so the main process was blocked and the elapsed time is not the provider's`,
          },
        ),
      );
      controller.abort();
    }, timeoutMs);
    timer.unref();
  });
  try { return await Promise.race([interrupted, Promise.resolve().then(() => { if (controller.signal.aborted) throw new ModelProviderError("cancelled", "Model call was cancelled"); return operation(controller.signal); })]); }
  finally { clearTimeout(timer); if (abort) parent?.removeEventListener("abort", abort); }
};
