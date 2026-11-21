import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { abortFailure } from "../src/main/model/provider-deadline.js";
import { added, connectionId, harness } from "./pr-review-run-fakes.js";

/**
 * A review's own time limits end its model calls through their signal. Aborted with no reason (or a plain Error), the
 * model call log filed each such call as 已取消 although nobody had stopped anything; a TimeoutError says it was a
 * deadline. What the review page and its steps say of it stays as it was.
 */
const hanging = (reasons: unknown[]) => (_request: unknown, signal?: AbortSignal) =>
  new Promise<never>((_resolve, reject) => {
    // As the gateway ends a call whose signal is aborted.
    signal?.addEventListener("abort", () => { reasons.push(signal.reason); reject(abortFailure(signal)); }, { once: true });
  });

afterEach(() => {
  vi.useRealTimers();
});

describe("a review's own time limits", () => {
  it("end a follow-up and a re-evaluation as deadlines, said on the page as before", async () => {
    vi.useFakeTimers();
    const reasons: unknown[] = [];
    const test = harness(["src/a.ts"], added("src/a.ts", 3), hanging(reasons));
    const snapshot = await test.service.load({ connectionId, reference: "AI/app#1" });

    const asked = test.service.followUp({ runId: randomUUID(), profileId: "local", connectionId, snapshot, excerpts: "", messages: [], question: "改了什么？" })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(await asked).toMatchObject({ message: "Model call was cancelled" });

    const judged = test.service.reevaluate({ runId: randomUUID(), profileId: "local", connectionId, snapshot, summary: "一处问题",
      finding: { priority: "P2", title: "请求仍未取消", body: "超时后请求仍在执行。", path: "src/a.ts", side: "new", line: 1, decisionIndexes: [] } })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(await judged).toMatchObject({ message: "复评超过 3 分钟没有完成，请重试或换用更快的模型。" });

    expect(reasons).toEqual([expect.objectContaining({ name: "TimeoutError" }), expect.objectContaining({ name: "TimeoutError" })]);
  });

  it("end a group out of its ten minutes as a deadline, reported as before", async () => {
    vi.useFakeTimers();
    const reasons: unknown[] = [];
    const test = harness(["src/a.ts"], added("src/a.ts", 3), hanging(reasons));

    const reviewing = test.run();
    await vi.advanceTimersByTimeAsync(600_000);
    const report = await reviewing;

    expect(reasons).toEqual([expect.objectContaining({ name: "TimeoutError", message: "当前这组评审达到 10 分钟时限。" })]);
    expect(report.warnings).toEqual(expect.arrayContaining(["第 1 组（src/a.ts）达到 10 分钟时限，没有评完。"]));
  });
});
