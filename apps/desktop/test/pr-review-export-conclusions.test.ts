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

describe("exported report of the verification's verdicts", () => {
  const finding = { priority: "P2" as const, title: "重试时重复提交", body: "失败后整体重试。", path: "src/a.ts", side: "new" as const, line: 3, decisionIndexes: [] };
  it("lists the candidates waiting for material apart, with what is missing", () => {
    const markdown = reviewMarkdown(snapshot, { ...report, needsContext: [{ finding, reason: "看不到调用方。", missing: "调用方是否只传入幂等请求。" }],
      filtered: [{ finding: { ...finding, title: "超时写死" }, reason: "调用方传入（src/a.ts:1）。" }] });
    expect(markdown).toContain("## 待核实的候选问题");
    expect(markdown).toContain("- P2 重试时重复提交（src/a.ts:3）· 缺少：调用方是否只传入幂等请求。 · 看不到调用方。");
    expect(markdown).toContain("核验找到了具体反证，没有列入问题：\n- P2 超时写死（src/a.ts:3）· 调用方传入（src/a.ts:1）。");
  });
  it("lists the candidates no changed line could hold, apart from the findings", () => {
    const markdown = reviewMarkdown(snapshot, { ...report, unplaced: [{ ...finding, line: 40 }] });
    expect(markdown).toContain("## 没能定位到变更行的候选问题");
    expect(markdown).toContain("- P2 重试时重复提交（src/a.ts:40）· 失败后整体重试。");
  });
  it("still reads a report saved with the old 0–100 scores", () => {
    const markdown = reviewMarkdown(snapshot, { ...report, filtered: [{ finding, score: 40, reason: "变更前就有。" }] });
    expect(markdown).toContain("置信度低于 80，没有列入问题：\n- P2 重试时重复提交（src/a.ts:3）· 置信度 40 · 变更前就有。");
    expect(markdown).not.toContain("待核实");
  });
});
