import { describe, expect, it } from "vitest";
import { estimatePrReviewUnits } from "@cognelis/decision-protocol";
import { parseReviewDiff } from "../src/main/pr-review-diff.js";
import { dedupeFindings, diffDigest, diffSize, planReviewUnits, renderDiffLine, reviewOrder, splitHunks, withContext } from "../src/main/pr-review-plan.js";

const added = (path: string, lines: number, width = 20) =>
  `diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines} @@\n${Array.from({ length: lines }, (_, i) => `+${`line ${i} `.padEnd(width, "x")}`).join("\n")}\n`;
const files = (diff: string) => [...parseReviewDiff(diff)].map(([path, lines]) => ({ path, lines }));

describe("review groups", () => {
  it("reviews a directory's files together, each file's tests right after it", () => {
    expect(reviewOrder(["test/request.test.ts", "src/retry.ts", "src/request.ts", "docs/readme.md", "test/other.test.ts"]))
      .toEqual(["docs/readme.md", "src/request.ts", "test/request.test.ts", "src/retry.ts", "test/other.test.ts"]);
  });

  it("finds hunks where either side's line numbers jump", () => {
    const [lines] = [...parseReviewDiff("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n@@ -10,1 +10,2 @@\n x\n+y\n").values()];
    expect(splitHunks(lines!).map((hunk) => hunk.length)).toEqual([3, 2]);
  });

  it("puts a small PR in one group and packs whole files while they fit", () => {
    const small = files(added("src/a.ts", 3) + added("src/b.ts", 3));
    expect(planReviewUnits(small, 48_000)).toHaveLength(1);
    // Two 40-line files do not fit one 1,200-character group together.
    const units = planReviewUnits(files(added("src/a.ts", 40) + added("src/b.ts", 40) + added("src/c.ts", 2)), 1_200);
    expect(units.map((unit) => unit.segments.map((segment) => segment.path))).toEqual([["src/a.ts"], ["src/b.ts", "src/c.ts"]]);
    expect(units.every((unit) => unit.size <= 1_200)).toBe(true);
  });

  it("cuts a file too large for a group between hunks, and its last piece shares a group with what follows", () => {
    const hunks = Array.from({ length: 6 }, (_, i) => `@@ -${i * 100 + 1},1 +${i * 100 + 1},2 @@\n ${"context".padEnd(30, "c")}\n+${"added".padEnd(30, "a")}`).join("\n");
    const large = files(`diff --git a/src/big.ts b/src/big.ts\n--- a/src/big.ts\n+++ b/src/big.ts\n${hunks}\n${added("src/small.ts", 1).slice(0, -1)}\n`);
    const perHunk = diffSize(splitHunks(large[0]!.lines)[0]!);
    // Two hunks a piece, with room for the file's own place in the prompt and the small file after the last piece.
    const units = planReviewUnits(large, perHunk * 2 + 110);
    expect(units.map((unit) => unit.segments.map((segment) => `${segment.path}${segment.part ? ` ${segment.part.index}/${segment.part.total}` : ""}`)))
      .toEqual([["src/big.ts 1/3"], ["src/big.ts 2/3"], ["src/big.ts 3/3", "src/small.ts"]]);
    // No hunk is cut: every piece starts where a hunk does.
    for (const unit of units) expect(unit.segments[0]!.lines[0]!.text).toMatch(/^ context/u);
    // The review page counts as many at any group size: each piece with the file's place in the prompt, so the small file
    // is not counted into a last piece it does not fit beside.
    const sized = large.map((file) => [file.path, splitHunks(file.lines).map(diffSize)] as const);
    for (let budget = 120; budget <= 600; budget++) expect([budget, estimatePrReviewUnits(sized, budget)]).toEqual([budget, planReviewUnits(large, budget).length]);
  });

  it("counts as many groups for any selection as the service makes", () => {
    // Three hunks each a little over half a group: cut between hunks, the file takes three groups, not two.
    const spread = Array.from({ length: 3 }, (_, i) => `@@ -${i * 100 + 1},1 +${i * 100 + 1},3 @@\n context\n+${"a".repeat(28)}\n+${"b".repeat(28)}`).join("\n");
    const spreadFile = files(`diff --git a/src/e.ts b/src/e.ts\n--- a/src/e.ts\n+++ b/src/e.ts\n${spread}\n`);
    const spreadHunks = splitHunks(spreadFile[0]!.lines).map(diffSize);
    const tight = Math.ceil(spreadHunks[0]! * 1.6);
    expect(planReviewUnits(spreadFile, tight)).toHaveLength(3);
    expect(estimatePrReviewUnits([["src/e.ts", spreadHunks]], tight)).toBe(3);
    const diff = [...files(added("src/a.ts", 40) + added("src/b.ts", 40) + added("src/c.ts", 2) + added("src/d.ts", 200)), ...spreadFile];
    const hunks = reviewOrder(diff.map((file) => file.path)).map((path) => [path, splitHunks(diff.find((file) => file.path === path)!.lines).map(diffSize)] as const);
    for (const budget of [1_200, 4_000, 48_000]) expect(estimatePrReviewUnits(hunks, budget)).toBe(planReviewUnits(diff, budget).length);
  });
});

describe("context around each hunk", () => {
  const source = ["import x from \"y\";", "", "export function run(value: number) {", ...Array.from({ length: 7 }, (_, i) => `  const v${i} = ${i};`),
    "  return compute(v0, v1);", "}", "", "export const other = 1;"];
  const diffOf = (text: string) => [...parseReviewDiff(`diff --git a/src/flow.ts b/src/flow.ts\n--- a/src/flow.ts\n+++ b/src/flow.ts\n${text}`).values()][0]!;

  it("reaches up to the function a hunk sits in, and a line below, as unchanged lines", () => {
    const lines = withContext(diffOf("@@ -10,3 +10,3 @@\n   const v6 = 6;\n-  return old(v0);\n+  return compute(v0, v1);\n }\n"), source);
    expect(lines.map(renderDiffLine)).toEqual([
      "3/3  export function run(value: number) {", ...Array.from({ length: 6 }, (_, i) => `${i + 4}/${i + 4}    const v${i} = ${i};`),
      "10/10    const v6 = 6;", "11/- -  return old(v0);", "-/11 +  return compute(v0, v1);", "12/12  }", "13/13  ",
    ]);
    expect(lines.filter((line) => line.changed)).toHaveLength(2);
  });

  it("never reaches into a neighbouring hunk, and leaves a deletion alone", () => {
    const lines = withContext(diffOf("@@ -4,1 +4,1 @@\n-  const v0 = 9;\n+  const v0 = 0;\n@@ -7,1 +7,1 @@\n-  const v3 = 9;\n+  const v3 = 3;\n"), source);
    const numbers = lines.map((line) => line.new).filter((line) => line !== null);
    expect(numbers).toEqual([...new Set(numbers)].sort((a, b) => a! - b!));
    // Three lines above the first hunk reach the top of the file; the second starts after the first one's line below.
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const deletion = diffOf("@@ -14,1 +13,0 @@\n-export const gone = 1;\n");
    expect(withContext(deletion, source)).toEqual(deletion);
  });

  it("gives context to the hunks it has room for, in order, and leaves the rest bare", () => {
    const diff = diffOf("@@ -4,1 +4,1 @@\n-  const v0 = 9;\n+  const v0 = 0;\n@@ -7,1 +7,1 @@\n-  const v3 = 9;\n+  const v3 = 3;\n");
    // Room for the lines around the first hunk, and none left for the second's.
    const first = withContext(diff, source).filter((line) => !line.changed && line.new !== null && line.new <= 5);
    expect(withContext(diff, source, { room: diffSize(first) }).map((line) => line.new)).toEqual([1, 2, 3, null, 4, 5, null, 7]);
  });

  it("reaches past an if, a loop or a catch to the function they sit in", () => {
    const nested = ["", "", "export async function run(items: string[]) {", "  try {", "    for (const item of items) {", "      if (item) {",
      "        await send(item);", "      } else {", "        skip();", "      }", "    }", "  } catch (error) {", "    report(error);", "  }", "}"];
    const hunk = [...parseReviewDiff("diff --git a/src/flow.ts b/src/flow.ts\n--- a/src/flow.ts\n+++ b/src/flow.ts\n@@ -13,1 +13,1 @@\n-    log(error);\n+    report(error);\n").values()][0]!;
    expect(withContext(hunk, nested).map((line) => line.new)[0]).toBe(3);
  });

  it("numbers the old side of the lines above a hunk that opens with an added line", () => {
    const lines = withContext(diffOf("@@ -6,1 +6,2 @@\n+  const extra = 1;\n   const v2 = 2;\n"), source, { before: 1, after: 0, reach: 0 });
    expect(lines.map(renderDiffLine)).toEqual(["5/5    const v1 = 1;", "-/6 +  const extra = 1;", "6/7    const v2 = 2;"]);
  });
});

describe("PR diff digest", () => {
  it("gives the whole diff when it fits and every file a share when it does not", () => {
    const diff = files(added("src/small.ts", 2) + added("src/large.ts", 400, 60));
    expect(diffDigest(diff, 100_000)).toMatchObject({ complete: true });
    const digest = diffDigest(diff, 4_000);
    expect(digest.complete).toBe(false);
    expect(digest.text.length).toBeLessThanOrEqual(4_000);
    expect(digest.text).toContain("### src/small.ts\n-/1 +line 0");
    expect(digest.text).toMatch(/### src\/large\.ts\n[\s\S]*…（本文件另有 \d+ 行 diff 未列出）/u);
  });

  it("names as many of thousands of files as the budget gives a few lines each, and counts the rest", () => {
    const many = files(Array.from({ length: 3_000 }, (_, index) => added(`src/module-${index}/file.ts`, 3)).join(""));
    const digest = diffDigest(many, 60_000);
    // Every one named, it ran to three times its budget with not a line of diff in it.
    expect(digest.text.length).toBeLessThanOrEqual(60_000);
    expect(digest.text).toContain("### src/module-0/file.ts\n-/1 +line 0");
    expect(digest.text).toMatch(/…（另有 \d+ 个文件的 diff 未列出）$/u);
  });
});

describe("one finding per problem", () => {
  const base = { priority: "P2" as const, title: "请求没有取消", path: "src/a.ts", side: "new" as const, line: 10, decisionIndexes: [1] };
  it("merges the same title on the same side within three lines, keeping the more severe word and every citation", () => {
    expect(dedupeFindings([base, { ...base, priority: "P1", line: 12, decisionIndexes: [2] }, { ...base, line: 30 }, { ...base, title: "别的问题" }]))
      .toEqual([{ ...base, priority: "P1", line: 12, decisionIndexes: [1, 2] }, { ...base, line: 30 }, { ...base, title: "别的问题" }]);
  });
});
