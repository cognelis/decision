import { expect, it, vi } from "vitest";
import { PrPlatformError } from "../src/main/pr-platform-client.js";
import { confirm, harness, pr } from "./pr-review-run-fakes.js";

// withSources pads every group with the code around its hunks up to 1.3 × the unit (62,400 characters for a remote
// model), whatever the group's own size, before the fitting ladder runs. The ladder only steps down when the group's
// own context overflows, so the room the guides (up to 20,000 characters for a remote model) and the rules were meant
// to have is taken by optional surrounding code: a medium PR of 28,000 diff characters in one group loses most of an
// 8,000-character CLAUDE.md, and the report blames the guides for being long.
it("gives a medium PR's one group the repository's whole CLAUDE.md, not the code around its hunks in its place", async () => {
  const paths: string[] = [], sources = new Map<string, string>(), diffs: string[] = [];
  const text = (i: number) => `  const result${i} = await client.fetch(request${i}, { timeout: ${i} });`;
  for (let f = 0; f < 20; f++) {
    const path = `src/module${f}/service.ts`;
    paths.push(path);
    sources.set(path, Array.from({ length: 8 * 12 + 12 }, (_, i) => (i + 1) % 12 === 6 ? `${text(i + 1)} // v2` : text(i + 1)).join("\n"));
    const body = Array.from({ length: 8 }, (_, h) => { const at = h * 12 + 6; return `@@ -${at},1 +${at},1 @@\n-${text(at)}\n+${text(at)} // v2`; }).join("\n");
    diffs.push(`diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}\n`);
  }
  const guide = `# 项目约定\n\n${Array.from({ length: 240 }, (_, i) => `- 约定 ${i + 1}：服务层调用外部接口必须传入超时并记录请求编号。`).join("\n")}`;
  const test = harness(paths, diffs.join(""), (request) => request.promptVersion.startsWith("pr-review-verify") ? confirm(request)
    : { action: "finish_review", summary: "已核对", findings: [] });
  vi.mocked(test.client.get).mockResolvedValue({ ...pr, description: "为各服务调用加版本标记。" });
  vi.mocked(test.client.files).mockResolvedValue(paths.map((path) => ({ path, status: "modified" })));
  vi.mocked(test.client.readFileContent).mockImplementation(async (_pr, path) => {
    if (path === "CLAUDE.md") return guide;
    if (path === "AGENTS.md") throw new PrPlatformError(404);
    return sources.get(path) ?? "";
  });
  const report = await test.run({ profileId: "remote" });
  expect(report.groups).toBe(1);
  expect(diffs.join("").length).toBeLessThan(30_000);
  expect(guide.length).toBeLessThan(10_000);
  const said = JSON.parse(test.requests.find((request) => request.promptVersion === "pr-review-v9")!.userPrompt.split("\n最近步骤")[0]!);
  expect(report.warnings).not.toContain("仓库规范较长，本组只纳入了前一部分。");
  expect(said.repoGuides).toBe(`## CLAUDE.md\n\n${guide}`);
});
