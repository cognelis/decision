import { expect, it, vi } from "vitest";
import { PrPlatformError } from "../src/main/pr-platform-client.js";
import { added, confirm, harness, pr } from "./pr-review-run-fakes.js";

// One transient gateway error (HTTP 502) on one group's "did the PR move?" check. The same check failing as a network
// error (or a source read failing with 5xx) only fails that group; as a PrPlatformError 5xx it is taken for a refusal
// "every group would meet", so the review stops: the rest of the PR is never reviewed and the review reports "failed".
it("a single platform 5xx on one group's version check does not stop the rest of the review", async () => {
  const paths = ["src/a.ts", "src/b.ts", "src/c.ts"];
  const test = harness(paths, paths.map((path) => added(path, 40)).join(""), (request) =>
    request.promptVersion.startsWith("pr-review-verify") ? confirm(request) : { action: "finish_review", summary: "已核对", findings: [] });
  let calls = 0;
  vi.mocked(test.client.get).mockImplementation(async () => {
    calls++;
    // load reads the PR twice; group 1 checks it at #3 and #4; group 2's first check (#5) meets a 502.
    if (calls === 5) throw new PrPlatformError(502);
    return pr;
  });
  const report = await test.run();
  expect(report.groups).toBe(3);
  // Only the group that met the 502 is left unreviewed; the third group is still reviewed.
  expect({ status: report.status, reviewedFiles: report.reviewedFiles, stoppedRest: report.warnings.includes("另有 1 组因此没有开始评审。") })
    .toEqual({ status: "incomplete", reviewedFiles: ["src/a.ts", "src/c.ts"], stoppedRest: false });
});

it("keeps a group already reviewed when the check after it meets a passing 5xx", async () => {
  const paths = ["src/a.ts", "src/b.ts", "src/c.ts"];
  const test = harness(paths, paths.map((path) => added(path, 40)).join(""), (request) =>
    request.promptVersion.startsWith("pr-review-verify") ? confirm(request) : { action: "finish_review", summary: "已核对", findings: [] });
  let calls = 0;
  vi.mocked(test.client.get).mockImplementation(async () => {
    calls++;
    // Group 1's check after its review (#4) meets a 502: its work was done, and was counted as not reviewed.
    if (calls === 4) throw new PrPlatformError(502);
    return pr;
  });
  const report = await test.run();
  expect(report.reviewedFiles).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  // Kept, yet not "completed" on a PR version nobody could confirm.
  expect(report.status).toBe("incomplete");
  expect(report.warnings).toContain("本组评审完成后没能确认 PR 是否有更新（平台暂时不可用），结果对应评审开始时的提交。");
});

it("a fork gone by the check after a group still fails it in the platform's words, not as a passing outage", async () => {
  const paths = ["src/a.ts"];
  const test = harness(paths, added("src/a.ts", 40), (request) =>
    request.promptVersion.startsWith("pr-review-verify") ? confirm(request) : { action: "finish_review", summary: "已核对", findings: [] });
  let calls = 0;
  vi.mocked(test.client.get).mockImplementation(async () => {
    calls++;
    if (calls === 4) throw new Error("PR 的来源仓库已不可用。");
    return pr;
  });
  const report = await test.run();
  // Its answer is tied to no PR anyone can confirm: not reviewed, as when the same check fails before the group.
  expect({ status: report.status, reviewedFiles: report.reviewedFiles }).toEqual({ status: "failed", reviewedFiles: [] });
  expect(report.warnings).toContain("PR 的来源仓库已不可用。");
  expect(report.warnings.some((warning) => warning.includes("平台暂时不可用"))).toBe(false);
});

it("control: the same check failing as a network error only fails that group", async () => {
  const paths = ["src/a.ts", "src/b.ts", "src/c.ts"];
  const test = harness(paths, paths.map((path) => added(path, 40)).join(""), (request) =>
    request.promptVersion.startsWith("pr-review-verify") ? confirm(request) : { action: "finish_review", summary: "已核对", findings: [] });
  let calls = 0;
  vi.mocked(test.client.get).mockImplementation(async () => {
    calls++;
    if (calls === 5) throw new Error("代码平台连接失败，请检查地址、网络和系统代理；不允许重定向凭据。");
    return pr;
  });
  const report = await test.run();
  expect(report.reviewedFiles).toEqual(["src/a.ts", "src/c.ts"]);
  expect(report.status).toBe("incomplete");
});
