import { expect, it } from "vitest";
import { parseReviewDiff } from "../src/main/pr-review-diff.js";
import { planReviewUnits, renderDiffLine } from "../src/main/pr-review-plan.js";
import { isStrictJsonSchema } from "../src/main/model/structured-provider.js";
import { PR_REVIEW_BATCH_MAX_CALLS } from "@cognelis/decision-protocol";
import { harness } from "./pr-review-run-fakes.js";

const diffOf = (path: string, lines: string[]) =>
  `diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`;
const files = (diff: string) => [...parseReviewDiff(diff)].map(([path, lines]) => ({ path, lines }));
/** What a group's diff takes in the prompt's JSON, line breaks included. */
const escaped = (lines: Parameters<typeof renderDiffLine>[0][]) => lines.reduce((sum, line) => sum + JSON.stringify(renderDiffLine(line)).length - 1, 0);

// Grouped by raw length, a colored log (ESC is six characters escaped) or JSON held in JSON came to 1.4 to 5.6 times its
// size in the prompt: past its limit, the group failed without a model call and its files went unreviewed.
it("sizes groups as the prompt's JSON holds them, so escaping cannot push one past its limit", () => {
  const log = Array.from({ length: 200 }, (_, i) => `const line${i} = "\x1b[31m错误\x1b[0m \\"${i}\\"";`);
  for (const unit of planReviewUnits(files(diffOf("src/log.ts", log)), 4_000)) {
    expect(escaped(unit.segments.flatMap((segment) => segment.lines))).toBeLessThanOrEqual(4_000);
  }
});

it("cuts a line no group can hold to its head, saying how much was left out", () => {
  const units = planReviewUnits(files(diffOf("src/blob.ts", [`export const blob = "${"z".repeat(13_000)}";`])), 4_000);
  const [line] = units.flatMap((unit) => unit.segments.flatMap((segment) => segment.lines));
  expect(line).toMatchObject({ new: 1, changed: true, clipped: true });
  // Where it was cut too, so a verifier can read on from there.
  const [, given, left] = /…（本行过长，只给出前 (\d+) 字符，另有 (\d+) 字符未给出）$/u.exec(line!.text) ?? [];
  expect(Number(given) + Number(left)).toBe(`+export const blob = "${"z".repeat(13_000)}";`.length);
  expect(line!.text.startsWith(`+export const blob = "${"z".repeat(Number(given) - 22)}…`)).toBe(true);
  expect(escaped([line!])).toBeLessThanOrEqual(4_000);
});

// The review is given the line cut; verification read the whole diff, and the line came back whole: 130,000 characters
// past the prompt's limit, every candidate in its block was kept unverified, false ones too.
// Without its side a line number was taken as the new side's, and a deleted line's number read another line; and a page
// whose line was cut was left unread, every next offset leading back to it.
it("asks the reviewer for a line's side, and moves past a long line its page gave cut", async () => {
  const steps: string[] = [];
  const actions = [
    { action: "read_diff", path: "src/blob.ts", line: 1, from: 0 },
    { action: "read_diff", path: "src/blob.ts", offset: 0 },
    { action: "read_diff", path: "src/blob.ts", offset: 0 },
    { action: "finish_review", summary: "已核对", findings: [] },
  ];
  const test = harness(["src/blob.ts"], diffOf("src/blob.ts", [`export const blob = "${"z".repeat(8_000)}";`]), (request) => {
    if (request.promptVersion.startsWith("pr-review-verify")) return { verdicts: [], reads: null };
    steps.push(request.userPrompt);
    return actions[steps.length - 1]!;
  });
  await test.run();
  expect(steps[1]).toContain("按行号读取时要给出 side（old 或 new）。");
  expect(steps[2]).toContain("只给出前");
  expect(steps[3]).toContain('"alreadyRead":true');
});

it("verifies a finding on an over-long line on the line cut, within the prompt's limit", async () => {
  const finding = { priority: "P2" as const, title: "常量过长", body: "这个常量应拆到数据文件里。", path: "src/blob.ts", side: "new" as const, line: 1, decisionIndexes: [] };
  const test = harness(["src/blob.ts"], diffOf("src/blob.ts", [`export const blob = "${"z".repeat(130_000)}";`]), (request) =>
    request.promptVersion.startsWith("pr-review-verify") ? { verdicts: [{ id: 1, score: 20, reason: "只是数据。" }] } : { action: "finish_review", summary: "已核对", findings: [finding] });
  const report = await test.run();
  const verifying = test.requests.filter((request) => request.promptVersion.startsWith("pr-review-verify"));
  expect(verifying).toHaveLength(1);
  expect(verifying[0]!.userPrompt.length).toBeLessThanOrEqual(19_000);
  expect(verifying[0]!.userPrompt).toContain("本行过长");
  // Scored, and under the bar: filtered, not kept unverified.
  expect({ findings: report.findings.length, filtered: report.filtered?.length }).toEqual({ findings: 0, filtered: 1 });
});

// As Claude Code's verifiers read what they need: given the line cut, the verifier could only guess at the rest.
it("lets a verifier read on in a line cut short, and scores with what it read", async () => {
  const finding = { priority: "P1" as const, title: "末尾泄露了密钥", body: "常量末尾带着一段密钥。", path: "src/blob.ts", side: "new" as const, line: 1, decisionIndexes: [] };
  const verifying: string[] = [];
  const test = harness(["src/blob.ts"], diffOf("src/blob.ts", [`export const blob = "${"z".repeat(100_000)}SECRET_TAIL";`]), (request) => {
    if (!request.promptVersion.startsWith("pr-review-verify")) return { action: "finish_review", summary: "已核对", findings: [finding] };
    verifying.push(request.userPrompt);
    return verifying.length === 1 ? { verdicts: [], reads: [{ path: "src/blob.ts", side: "new", line: 1, from: 99_000 }] } : { verdicts: [{ id: 1, score: 95, reason: "末尾确有密钥。" }] };
  });
  const report = await test.run();
  expect(verifying).toHaveLength(2);
  const [read] = JSON.parse(verifying[1]!).readResults;
  expect(read).toMatchObject({ path: "src/blob.ts", line: 1, from: 99_000 });
  // Read to the line's end: nothing after it to read on from.
  expect(read.text).toMatch(/SECRET_TAIL";$/u);
  expect(read.next).toBeUndefined();
  expect(verifying.every((prompt) => prompt.length <= 19_000)).toBe(true);
  expect(report.findings.map((item) => item.title)).toEqual(["末尾泄露了密钥"]);
  expect(report.warnings.some((warning) => warning.includes("没能完成核验"))).toBe(false);
});

// No fixed count of reads or rounds, as a reviewer of a group has none: it reads on while it reads something new, within
// the calls a group's reviewer has, and answers when that runs out.
it("lets a verifier read on while it reads something new, up to a group reviewer's calls, then asks for its verdicts", async () => {
  const finding = { priority: "P2" as const, title: "常量过长", body: "这个常量应拆到数据文件里。", path: "src/blob.ts", side: "new" as const, line: 1, decisionIndexes: [] };
  const verifying: string[] = [];
  const test = harness(["src/blob.ts"], diffOf("src/blob.ts", [`export const blob = "${"z".repeat(50_000)}";`]), (request) => {
    if (!request.promptVersion.startsWith("pr-review-verify")) return { action: "finish_review", summary: "已核对", findings: [finding] };
    verifying.push(request.userPrompt);
    return { verdicts: [], reads: [{ path: "src/blob.ts", side: "new", line: 1, from: verifying.length * 1_000 }] };
  });
  const report = await test.run();
  expect(verifying).toHaveLength(PR_REVIEW_BATCH_MAX_CALLS);
  expect(verifying.slice(0, -1).some((prompt) => "mustAnswer" in JSON.parse(prompt))).toBe(false);
  expect(JSON.parse(verifying.at(-1)!)).toMatchObject({ mustAnswer: true });
  // The reads so far go along, the line's next piece said for each.
  expect(JSON.parse(verifying[2]!).readResults).toMatchObject([{ from: 1_000, next: expect.any(Number) }, { from: 2_000, next: expect.any(Number) }]);
  expect(report.warnings).toContain("1 条问题没能完成核验，按原样保留。");
});

it("asks for the verdicts once a verifier only asks again for what it was given", async () => {
  const finding = { priority: "P2" as const, title: "常量过长", body: "这个常量应拆到数据文件里。", path: "src/blob.ts", side: "new" as const, line: 1, decisionIndexes: [] };
  const verifying: string[] = [];
  const test = harness(["src/blob.ts"], diffOf("src/blob.ts", [`export const blob = "${"z".repeat(50_000)}";`]), (request) => {
    if (!request.promptVersion.startsWith("pr-review-verify")) return { action: "finish_review", summary: "已核对", findings: [finding] };
    verifying.push(request.userPrompt);
    return "mustAnswer" in JSON.parse(request.userPrompt) ? { verdicts: [{ id: 1, score: 10, reason: "只是数据。" }], reads: null }
      : { verdicts: [], reads: [{ path: "src/blob.ts", side: "new", line: 1, from: 1_000 }] };
  });
  const report = await test.run();
  expect(verifying).toHaveLength(3);
  expect(report.filtered?.map((item) => item.finding.title)).toEqual(["常量过长"]);
});

// Left out for room, a read was never given, and asked for again it was taken for going round: made to answer at once.
it("gives back a read left out for room when the verifier asks for it again", async () => {
  const path = "src/many.ts";
  const finding = { priority: "P2" as const, title: "问题", body: "说明。", path, side: "new" as const, line: 1, decisionIndexes: [] };
  const at = (lines: number[]) => lines.map((line) => ({ path, side: "new", line, from: null }));
  const early = [10, 30, 50, 70, 90, 110, 130, 150], late = [300, 320, 340, 360];
  const verifying: string[] = [];
  const test = harness([path], diffOf(path, Array.from({ length: 400 }, (_, i) => `export const value${i} = "${"v".repeat(40)}";`)), (request) => {
    if (!request.promptVersion.startsWith("pr-review-verify")) return { action: "finish_review", summary: "已核对", findings: [finding] };
    verifying.push(request.userPrompt);
    return verifying.length === 1 ? { verdicts: [], reads: at([...early, ...late]) }
      : verifying.length === 2 ? { verdicts: [], reads: at(early) } : { verdicts: [{ id: 1, score: 90, reason: "成立。" }], reads: null };
  });
  await test.run();
  const [, second, third] = verifying.map((prompt) => JSON.parse(prompt) as { droppedReads?: number; mustAnswer?: boolean; readResults: Array<{ line: number }> });
  expect(second!.droppedReads).toBeGreaterThan(0);
  expect(second!.readResults.map((read) => read.line)).not.toContain(10);
  // Asked for again, the ones left out come first; not taken for going round.
  expect(third!.mustAnswer).toBeUndefined();
  expect(third!.readResults.map((read) => read.line).every((line) => early.includes(line))).toBe(true);
});

// The reviewer of a group was given the line's head and could not read on: a page of it ended "单行内容过长".
it("lets the reviewer read on in a line cut short, from where its cut says", async () => {
  const steps: unknown[] = [];
  // Past a local group (4,000) and within a page (6,000) after the cut: one read reaches its end.
  const test = harness(["src/blob.ts"], diffOf("src/blob.ts", [`export const blob = "${"z".repeat(8_000)}TAIL";`]), (request) => {
    const prompt = request.userPrompt;
    if (request.promptVersion.startsWith("pr-review-verify")) return { verdicts: [], reads: null };
    steps.push(prompt);
    if (steps.length > 1) return { action: "finish_review", summary: "已核对", findings: [] };
    const given = Number(/只给出前 (\d+) 字符/u.exec(prompt)![1]);
    return { action: "read_diff", path: "src/blob.ts", side: "new", line: 1, from: given };
  });
  await test.run();
  // What it read came back to it, the line's end with it.
  expect(String(steps[1])).toContain("TAIL");
});

// Each read's own fields were left out of its share: six of them on a long path, the last call ran past a local budget.
it("keeps every verification call within a local model's budget, six reads on a long path included, and takes verdicts as they come", async () => {
  const path = `src/${"deep/".repeat(12)}file.ts`;
  const lines = Array.from({ length: 200 }, (_, i) => i === 99 ? `export const blob = "${"z".repeat(50_000)}";` : `export const value${i} = "${"v".repeat(40)}";`);
  const findings = [1, 50, 100].map((line) => ({ priority: "P2" as const, title: `问题 ${line}`, body: "说".repeat(1_500), path, side: "new" as const, line, decisionIndexes: [] }));
  const verifying: string[] = [];
  const test = harness([path], diffOf(path, lines), (request) => {
    if (!request.promptVersion.startsWith("pr-review-verify")) return { action: "finish_review", summary: "已核对", findings };
    verifying.push(request.userPrompt);
    const reads = [10, 20, 30, 40, 50, 60, 100].map((line) => ({ path, side: "new", line, from: line === 100 ? verifying.length * 5_000 : null }));
    // Sure of the first at once, of the second after reading, of the third only when made to answer.
    return verifying.length === 1 ? { verdicts: [{ id: 1, score: 90, reason: "成立。" }], reads }
      : verifying.length === 2 ? { verdicts: [{ id: 2, score: 10, reason: "不成立。" }], reads }
        : { verdicts: [{ id: 3, score: 90, reason: "成立。" }], reads: null };
  });
  const report = await test.run();
  expect(verifying).toHaveLength(3);
  expect(Math.max(...verifying.map((prompt) => prompt.length))).toBeLessThanOrEqual(19_000);
  // The first and third kept, the second set aside: each scored in the round it was sure of it, none left unverified.
  expect({ kept: report.findings.length, filtered: report.filtered?.map((item) => item.finding.line) }).toEqual({ kept: 2, filtered: [50] });
  expect(report.warnings.some((warning) => warning.includes("没能完成核验"))).toBe(false);
  // Required and nullable, not optional: OpenAI's strict structured outputs still take it.
  expect(isStrictJsonSchema(test.requests.find((request) => request.promptVersion.startsWith("pr-review-verify"))!.outputSchema)).toBe(true);
});

it("reviews a file with an over-long line in part, rather than failing its group, and does not count it reviewed", async () => {
  const diff = diffOf("src/blob.ts", [`export const blob = "${"z".repeat(13_000)}";`]) + diffOf("src/ok.ts", ["export const ok = 1;"]);
  const test = harness(["src/blob.ts", "src/ok.ts"], diff, () => ({ action: "finish_review", summary: "已核对", findings: [] }));
  const report = await test.run();
  expect(test.requests.some((request) => request.userPrompt.includes("本行过长"))).toBe(true);
  expect({ status: report.status, reviewedFiles: report.reviewedFiles, unreviewedFiles: report.unreviewedFiles })
    .toEqual({ status: "incomplete", reviewedFiles: ["src/ok.ts"], unreviewedFiles: ["src/blob.ts"] });
  expect(report.warnings).toContain("src/blob.ts 有超长的行，评审时先只给了每行开头（模型可按需往后读），按未完整评审计。");
});
