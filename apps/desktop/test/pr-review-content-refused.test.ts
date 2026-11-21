import type { StructuredGenerationRequest } from "@cognelis/decision-protocol";
import { expect, it } from "vitest";
import { modelFailureMessage, ProfiledModelGatewayError } from "../src/main/model/profiled-model-gateway.js";
import { added, confirm, harness } from "./pr-review-run-fakes.js";

/** The group a review call is about, by the first file of its currentDiff, wherever the prompt's JSON starts. */
const about = (request: StructuredGenerationRequest) => /"currentDiff":\[\{"path":"([^"]+)"/u.exec(request.userPrompt)?.[1];

// The provider's moderation refused one group's diff. Filed as a refused key (OpenRouter's 403), it stopped the review;
// filed as any other failure, the same diff went again: twice more as it was, then once more in one piece.
it("reports the group whose content the provider's moderation refused, sends it no second time, and reviews the rest", async () => {
  const paths = ["src/a.ts", "src/b.ts", "src/c.ts"];
  const test = harness(paths, paths.map((path) => added(path, 40)).join(""), (request) =>
    request.promptVersion.startsWith("pr-review-verify") ? confirm(request)
      : about(request) === "src/b.ts" ? new ProfiledModelGatewayError("The structured model fallback chain failed or was stopped", "content_refused")
      : { action: "finish_review", summary: "已核对", findings: [] });

  const report = await test.run();

  expect(test.requests.filter((request) => about(request) === "src/b.ts")).toHaveLength(1);
  expect(report.history.some((event) => event.kind === "retry")).toBe(false);
  expect({ status: report.status, reviewedFiles: report.reviewedFiles }).toEqual({ status: "incomplete", reviewedFiles: ["src/a.ts", "src/c.ts"] });
  expect(report.warnings).toContain("第 2 组（src/b.ts）的内容被服务商审核拒绝，没能评完，其余各组照常评审。");
  expect(report.warnings).toContain(modelFailureMessage("content_refused"));
  expect(report.warnings.some((warning) => warning.includes("因此没有开始评审"))).toBe(false);
});
