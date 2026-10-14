import { describe, expect, it } from "vitest";

import { decisionLifecycleSteps } from "../src/renderer/components/pages/decisions/DecisionLifecycle.js";

const base = {
  created: new Date(2026, 6, 29, 16, 30).toISOString(),
  rationaleStatus: "captured" as const,
  outcome: null,
  outcomeReview: null,
  reviewDueDate: null,
};

const states = (steps: ReturnType<typeof decisionLifecycleSteps>) =>
  steps.map(({ label, value, state }) => `${label}:${value}:${state}`);

describe("decisionLifecycleSteps", () => {
  it("marks a due outcome as the reader's turn and leaves later steps unreached", () => {
    expect(
      states(
        decisionLifecycleSteps(
          { ...base, rationaleStatus: "deferred", reviewDueDate: "2026-08-01" },
          0,
          "2026-08-01",
        ),
      ),
    ).toEqual([
      "记录:7.29:done",
      "理由:待补:waiting",
      "预期:可补写:pending",
      "实际结果:8.1 到期:attention",
      "复盘:—:pending",
      "沉淀原则:—:pending",
    ]);
  });

  it("counts an expectation written down, and stops offering one once the outcome is in", () => {
    expect(
      states(decisionLifecycleSteps({ ...base, expectedOutcome: "错误率不升。" }, 0, "2026-08-01"))[2],
    ).toBe("预期:已写下:done");
    expect(
      states(decisionLifecycleSteps({ ...base, outcome: "上线稳定。" }, 0, "2026-08-01"))[2],
    ).toBe("预期:未写:pending");
  });

  it("waits for a scheduled outcome without asking for it early", () => {
    expect(
      states(
        decisionLifecycleSteps(
          { ...base, rationaleStatus: "skipped", reviewDueDate: "2026-08-10" },
          0,
          "2026-08-01",
        ),
      ).slice(1, 4),
    ).toEqual(["理由:未补:pending", "预期:可补写:pending", "实际结果:8.10 复盘:pending"]);
    expect(
      states(decisionLifecycleSteps(base, 0, "2026-08-01"))[3],
    ).toBe("实际结果:未安排复盘:pending");
  });

  it("asks for the review once the outcome is in, then offers distillation", () => {
    expect(
      states(
        decisionLifecycleSteps({ ...base, outcome: "上线稳定。" }, 0, "2026-08-01"),
      ).slice(3),
    ).toEqual([
      "实际结果:已记录:done",
      "复盘:待复盘:attention",
      "沉淀原则:—:pending",
    ]);
    const reviewed = {
      ...base,
      outcome: "上线稳定。",
      outcomeReview: {
        verdict: "worse" as const,
        lesson: null,
        reviewedAt: new Date(2026, 7, 2, 9, 0).toISOString(),
      },
    };
    expect(states(decisionLifecycleSteps(reviewed, 0, "2026-08-03")).slice(4)).toEqual([
      "复盘:低于预期 · 8.2:done",
      "沉淀原则:可提炼:pending",
    ]);
    expect(states(decisionLifecycleSteps(reviewed, 2, "2026-08-03"))[5]).toBe(
      "沉淀原则:2 条:done",
    );
  });
});
