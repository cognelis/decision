// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { loadReviewHistory, saveReviewHistory, type ReviewHistoryEntry } from "../src/renderer/components/pages/pr-review/review-history.js";
import { platformMessage } from "../src/renderer/components/pages/pr-review/platform-message.js";

afterEach(() => localStorage.clear());

const entry = (id: string, overrides: Partial<ReviewHistoryEntry>): ReviewHistoryEntry => ({
  id, kind: "review", at: "2026-10-01T10:00:00.000Z", model: "本机", focus: "", draft: "", turns: [], events: [],
  connectionId: "00000000-0000-4000-8000-000000000011", profileId: "local",
  snapshot: { snapshotId: "00000000-0000-4000-8000-0000000000a1", reference: "acme/app#12", title: "修复登录", description: "", project: "app",
    sourceCommit: "a".repeat(40), destinationCommit: "b".repeat(40), files: [{ path: "src/login.ts", status: "modified" }], warnings: [] },
  report: null, state: "finished", error: "", published: [], verdicts: [], rechecks: [], ...overrides,
});

// saveReviewHistory() writes whatever the panel holds; loadReviewHistory() validates all of it at once. The one field
// the panel fills from an unbounded source is `error` (platformMessage(cause) is the main process's message as is),
// and the schema held it to 2,000. One failed review whose message ran past that, and the next launch read no
// history at all: every earlier review, every 不采纳 the reviewer recorded, gone from the page.
it("still shows the earlier reviews after one review failed with a long message", () => {
  const good = entry("00000000-0000-4000-8000-0000000000e1", { report: {
    status: "completed", summary: "没有问题。", findings: [], evidence: [], readFiles: ["src/login.ts"], unreadFiles: [], reviewedFiles: ["src/login.ts"],
    unreviewedFiles: [], warnings: [], steps: 1, history: [] } });
  // As review() stores it: the rejection's message, Electron's wrapper stripped.
  const cause = new Error(`Error invoking remote method 'decision:pr-review-run': Error: ${"评审失败：模型返回了无法解析的内容。".repeat(120)}`);
  const failed = entry("00000000-0000-4000-8000-0000000000e2", { at: "2026-10-02T10:00:00.000Z", state: "failed", error: platformMessage(cause, "评审失败，请检查模型与平台连接后重试。") });
  expect(saveReviewHistory([failed, good]).saved).toBe(true);
  const loaded = loadReviewHistory();
  expect(loaded.error).toBe("");
  expect(loaded.entries.map((item) => item.id)).toContain(good.id);
});

it("reads a history an earlier version saved with such a message, the message cut to what a record holds", () => {
  const long = "评审失败：模型返回了无法解析的内容。".repeat(200);
  const turn = { id: "00000000-0000-4000-8000-0000000000f1", at: "2026-10-02T10:00:00.000Z", model: "本机", question: "为什么？", answer: "", state: "failed", error: long };
  // Written straight to the store, as a version that did not bound it had: saving then stopped, so it stayed so.
  localStorage.setItem("decision.pr-review.history.v1", JSON.stringify([
    entry("00000000-0000-4000-8000-0000000000e2", { state: "failed", error: long, turns: [turn as never] }),
    entry("00000000-0000-4000-8000-0000000000e1", {}),
  ]));
  const loaded = loadReviewHistory();
  expect(loaded.error).toBe("");
  expect(loaded.entries.map((item) => item.id)).toEqual(["00000000-0000-4000-8000-0000000000e2", "00000000-0000-4000-8000-0000000000e1"]);
  expect(loaded.entries[0]!.error).toHaveLength(2_000);
  expect(loaded.entries[0]!.turns[0]!.error).toHaveLength(2_000);
});
