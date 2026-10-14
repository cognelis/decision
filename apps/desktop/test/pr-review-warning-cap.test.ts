import { expect, it, vi } from "vitest";
import { PrPlatformError } from "../src/main/pr-platform-client.js";
import { harness } from "./pr-review-run-fakes.js";

// Source reads that fail file by file (a merge request from a fork the token cannot read: 404 for every file) each add a
// "源码读取失败：…" line, ahead of what the verification and the decision check say. The report keeps its first 100
// warnings, so on a PR of 100+ files the warning that a finding was never verified is dropped: it reads as verified.
it("still says a finding went unverified on a PR whose files' sources could not be read", async () => {
  const paths = Array.from({ length: 110 }, (_, index) => `f${index}.ts`);
  const diff = paths.map((path) => `diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+x\n`).join("");
  const onFirst = { priority: "P2", title: "x 未定义", body: "运行时会抛出 ReferenceError，应先声明。", path: "f0.ts", side: "new", line: 1, decisionIndexes: [] };
  const test = harness(paths, diff, (request) => request.promptVersion.startsWith("pr-review-verify") ? new Error("模型不可用")
    : { action: "finish_review", summary: "已核对", findings: JSON.parse(request.userPrompt.split("\n最近步骤")[0]!).currentDiff.some((item: { path: string }) => item.path === "f0.ts") ? [onFirst] : [] });
  vi.mocked(test.client.readFileContent).mockRejectedValue(new PrPlatformError(404));
  const report = await test.run();
  expect(report.findings).toEqual([onFirst]);
  expect(report.warnings).toContain("1 条问题没能完成核验，按原样保留。");
});
