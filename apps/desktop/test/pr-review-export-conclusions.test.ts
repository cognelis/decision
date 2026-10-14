import { describe, expect, it } from "vitest";
import type { PrReviewReport, PrReviewSnapshot } from "@cognelis/decision-protocol";
import { reviewMarkdown } from "../src/renderer/components/pages/pr-review/PrReviewPanel.js";

// A large PR reviewed in several groups: the page lists every group's conclusion in full (report.conclusions), while
// the exported report printed report.summary only, which holds 4,000 characters: everything past them was missing.
const snapshot: PrReviewSnapshot = {
  snapshotId: "00000000-0000-4000-8000-0000000000a1", reference: "acme/app#12", title: "大改动", description: "", project: "app",
  sourceCommit: "a".repeat(40), destinationCommit: "b".repeat(40),
  files: [{ path: "src/a.ts", status: "modified" }, { path: "src/b.ts", status: "modified" }, { path: "src/c.ts", status: "modified" }],
  warnings: [],
};

const conclusion = (group: number) => ({ label: `评审分组 ${group}/3：src/${"abc"[group - 1]}.ts`, text: `第 ${group} 组结论：${"这里是第" + group + "组审查者写下的说明。"}`.padEnd(1_600, `第${group}组细节。`) });
const conclusions = [conclusion(1), conclusion(2), conclusion(3)];
// As the service builds it: the brief's first line, each group's conclusion cut to fit, then the coverage sentence.
const counted = "分 3 组评审了 3/3 个文件，形成 0 条问题。";
const summary = ["这个 PR 调整了三个模块。", `${conclusions.map((item) => `- ${item.label}：${item.text}`).join("\n").slice(0, 3_900)}…`, counted].join("\n\n");

const report: PrReviewReport = {
  status: "completed", summary, findings: [], evidence: [], readFiles: ["src/a.ts", "src/b.ts", "src/c.ts"], unreadFiles: [],
  reviewedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"], unreviewedFiles: [], warnings: [], steps: 9, history: [], groups: 3,
  overview: "这个 PR 调整了三个模块。", conclusions,
};

describe("exported report of a multi-group review", () => {
  it("carries every group's conclusion, as the page shows them", () => {
    const markdown = reviewMarkdown(snapshot, report);
    // The page shows the third group's conclusion in full; the export must say the same.
    expect(markdown).toContain(conclusions[2]!.text);
    // The coverage sentence that closes the summary must survive too.
    expect(markdown).toContain(counted);
  });
});
