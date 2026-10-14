import { expect, it, vi } from "vitest";
import { PrPlatformError } from "../src/main/pr-platform-client.js";
import { added, confirm, harness } from "./pr-review-run-fakes.js";

// A token that may read the PR but not its files' contents (a GitHub fine-grained token without "Contents: read"):
// the first source read is refused, and from then on no file's source is read at all. The report says one file was
// reviewed without the code around its hunks; all three were.
it("counts every file reviewed without its source once a refusal stops the reads", async () => {
  const paths = ["src/a.ts", "src/b.ts", "src/c.ts"];
  const test = harness(paths, paths.map((path) => added(path, 40)).join(""), (request) =>
    request.promptVersion.startsWith("pr-review-verify") ? confirm(request) : { action: "finish_review", summary: "已核对", findings: [] });
  vi.mocked(test.client.readFileContent).mockRejectedValue(new PrPlatformError(403));
  const report = await test.run();
  expect(report.groups).toBe(3);
  // No source was read for any of the three files: none of the groups got the code around its hunks.
  expect(vi.mocked(test.client.readFileContent).mock.calls.filter(([, path]) => paths.includes(path))).toHaveLength(1);
  expect(report.warnings).toContain("3 个文件没能读取源码，按原 diff 评审，没有补充上下文。");
});
