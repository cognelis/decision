import { describe, expect, it, vi } from "vitest";

import type { ModelProviderError } from "../src/main/model/http-model-transport.js";
import { withProviderDeadline } from "../src/main/model/provider-deadline.js";

const never = () => new Promise<never>(() => undefined);

const rejectionOf = async (
  run: () => Promise<unknown>,
): Promise<ModelProviderError> => {
  try {
    await run();
  } catch (error) {
    return error as ModelProviderError;
  }
  throw new Error("expected the deadline to reject");
};

describe("withProviderDeadline", () => {
  it("names the budget it enforced", async () => {
    vi.useFakeTimers();
    try {
      const pending = rejectionOf(() =>
        withProviderDeadline(never, 30_000),
      );
      await vi.advanceTimersByTimeAsync(30_000);
      const failure = await pending;
      expect(failure.code).toBe("timeout");
      expect(failure.diagnosticExcerpt).toBe(
        "Model provider attempt timed out after 30000ms",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("says so when the timer itself was late", async () => {
    // A blocked main process makes every deadline late, and then the elapsed
    // time describes the process rather than the provider. One real turn
    // reported 120s against a 30s budget with no way to tell them apart.
    vi.useFakeTimers();
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      const pending = rejectionOf(() =>
        withProviderDeadline(never, 30_000),
      );
      clock = 120_000;
      await vi.advanceTimersByTimeAsync(30_000);
      const failure = await pending;
      expect(failure.diagnosticExcerpt).toContain("fired 90000ms late");
      expect(failure.diagnosticExcerpt).toContain("main process was blocked");
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("returns the value when the call beats the deadline", async () => {
    await expect(
      withProviderDeadline(async () => "ok", 30_000),
    ).resolves.toBe("ok");
  });
});
