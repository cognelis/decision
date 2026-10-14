import { ModelProviderError } from "./http-model-transport.js";

/** Past this much lateness the timer says more about the process than the call. */
const LATE_DEADLINE_MS = 1_000;

/**
 * Bounds even an adapter that ignores abort; caller cancellation never triggers fallback. With no `timeoutMs`
 * it only cancels: for a backend that times its own calls (SemanticClassifier.queuesCalls).
 */
export const withProviderDeadline = async <T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number | undefined, parent?: AbortSignal): Promise<T> => {
  if (parent?.aborted) throw new ModelProviderError("cancelled", "Model call was cancelled");
  const armedAt = performance.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => { reject(new ModelProviderError("cancelled", "Model call was cancelled")); controller.abort(); };
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
