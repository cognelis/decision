import { expect, it } from "vitest";
import { scoreRecognition } from "../evaluate-pr-comment-recognition.mjs";

it("scores hand labels against a run, leaving out the uncertain and counting the unjudged as missed", () => {
  const comment = (id: string, body: string) => ({ id, author: "Alice", body, createdAt: "2026-10-20T02:00:00Z", replyTo: null, path: null, line: null });
  const cases = { version: 1, cases: [{ reference: "org/repo#1", title: "示例", comments: [
    comment("1", "先不处理"), comment("2", "已改"), comment("3", "用 bulk 操作"), comment("4", "这样可以吗？"), comment("5", "统一用 token"),
  ] }] };
  const labels = { version: 1, default: "no", labels: { "org/repo#1/1": "yes", "org/repo#1/3": "yes", "org/repo#1/4": "maybe", "org/repo#1/5": "yes" } };
  const decision = { decision: true, question: "q", choice: "c", quote: "x" };
  const run = { profile: "p", model: "m", calls: [{ ms: 10, usage: { inputTokens: 5, outputTokens: 2 } }], judged: {
    "org/repo#1/1": decision, "org/repo#1/2": decision, "org/repo#1/3": { ...decision, decision: false }, "org/repo#1/4": decision, "org/repo#1/5": null,
  } };
  const score = scoreRecognition(run, labels, cases);
  expect({ tp: score.truePositive, fp: score.falsePositive, fn: score.falseNegative, unjudged: score.unjudged, maybeFlagged: score.maybeFlagged })
    .toEqual({ tp: 1, fp: 1, fn: 2, unjudged: 1, maybeFlagged: 1 });
  expect([score.precision, score.recall]).toEqual([0.5, 1 / 3]);
  expect(score.falseNegatives.map((item: { id: string }) => item.id)).toEqual(["org/repo#1/3", "org/repo#1/5"]);
});
