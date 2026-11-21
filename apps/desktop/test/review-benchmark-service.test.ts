import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  REVIEW_BENCHMARK_VERSION,
  reviewBenchmarkRecordRequestSchema,
  reviewBenchmarkUpdateRequestSchema,
} from "@cognelis/decision-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ReviewBenchmarkService } from "../src/main/review-benchmark-service.js";

const exec = promisify(execFile);
// Fixed names and dates: the same commit ids each run, so each case's split is the same each run too.
const environment = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};
const FILES = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts", "h.ts"];
const repositoryId = `repo:${"1".repeat(64)}`;

let root: string;
let repository: string;
let data: string;
let commits: { target: string; head: string; fix: string };
let service: ReviewBenchmarkService;

const git = async (...args: string[]) => (await exec("git", ["-C", repository, ...args], { env: environment })).stdout.trim();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "paraself-review-benchmark-"));
  repository = join(root, "repo");
  data = join(root, "review-benchmark");
  await exec("git", ["init", "-q", "-b", "main", repository], { env: environment });
  for (const file of FILES) await writeFile(join(repository, file), "one\ntwo\nthree\n");
  await writeFile(join(repository, "api.ts"), "throw error;\n");
  await git("add", ".");
  await git("commit", "-qm", "Initial");
  const target = await git("rev-parse", "HEAD");
  await git("checkout", "-qb", "feature");
  for (const file of FILES) await writeFile(join(repository, file), "one\ntwo\nthree\nfour\n");
  await writeFile(join(repository, "api.ts"), "return null;\nconst ready = true;\n");
  await git("commit", "-qam", "Change the API");
  const head = await git("rev-parse", "HEAD");
  await writeFile(join(repository, "api.ts"), "return value;\nconst ready = true;\n");
  await git("commit", "-qam", "Fix the API");
  commits = { target, head, fix: await git("rev-parse", "HEAD") };
  service = new ReviewBenchmarkService(data, {
    now: () => new Date("2026-11-18T08:00:00Z"),
    locate: async (path) => (path === repository ? { id: repositoryId, project: "demo", relativeDirectory: "", identitySource: "git_common_directory" } : null),
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const defect = (overrides: Record<string, unknown> = {}) => ({
  set: "defect",
  title: "Change the API",
  headSha: commits.head,
  targetSha: commits.target,
  provenance: [{ kind: "fix_commit", reference: commits.fix }],
  issues: [{ title: "返回 null 让调用方崩溃", priority: "P1", evidence: "修复提交改回返回值。", fixShas: [commits.fix], locations: [{ path: "api.ts", startLine: 1, endLine: 1 }] }],
  ...overrides,
});
const clean = (file: string, overrides: Record<string, unknown> = {}) => ({
  set: "clean",
  title: "Change the API",
  headSha: commits.head,
  targetSha: commits.target,
  scope: [file],
  provenance: [{ kind: "sampling", reference: `merged-${file}` }],
  mergedAt: "2026-02-01",
  cleanEvidence: "合并后没有回滚，新增的行没有被修改。",
  ...overrides,
});
const record = (...cases: unknown[]) => service.record(reviewBenchmarkRecordRequestSchema.parse({ reviewBenchmarkVersion: REVIEW_BENCHMARK_VERSION, sourceClient: "codex", repositoryPath: repository, cases }));
const update = (change: Record<string, unknown>) =>
  service.update(reviewBenchmarkUpdateRequestSchema.parse({ reviewBenchmarkVersion: REVIEW_BENCHMARK_VERSION, sourceClient: "codex", repositoryPath: repository, ...change }));
/** A defect case in the dev split, whose labels a read shows: the first of a few scopes that lands there. */
const devDefect = async () => {
  const recorded = await record(defect(), defect({ scope: ["api.ts"] }), defect({ scope: ["api.ts", "a.ts"] }), defect({ scope: ["api.ts", "b.ts"] }));
  return recorded.cases.find((item) => item.split === "dev")!.caseId!;
};
const stored = async () => JSON.parse(await readFile(join(data, `${"1".repeat(64)}.json`), "utf8")) as { cases: Array<{ id: string; status: string }> };

describe("recording cases", () => {
  it("keeps a checked case as a candidate in the repository's own file, once per version", async () => {
    const first = await record(defect(), clean("a.ts"));
    expect(first).toMatchObject({ status: "processed", repository: { id: repositoryId, project: "demo" } });
    expect(first.cases.map((item) => [item.outcome, item.status])).toEqual([["recorded", "candidate"], ["recorded", "candidate"]]);
    expect(first.cases[0]!.caseId).toMatch(/^case-[0-9a-f]{12}$/u);
    const file = join(data, `${"1".repeat(64)}.json`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stored()).cases).toHaveLength(2);

    // Sent again, as after a lost answer: the one already kept, and the same split.
    const again = await record(defect());
    expect(again.cases[0]).toMatchObject({ outcome: "duplicate", caseId: first.cases[0]!.caseId, split: first.cases[0]!.split });
    // One version cannot be both: the same head and scope in the other set is refused.
    const contradiction = await record(defect({ scope: ["a.ts"] }));
    expect(contradiction.cases[0]!.outcome).toBe("rejected");
    expect(contradiction.cases[0]!.reasons.join("")).toContain("已经作为干净集样本录入");
    expect((await stored()).cases).toHaveLength(2);
  });

  it("refuses what the repository does not bear out, each said as what to change, and writes nothing", async () => {
    const unknown = "f".repeat(40);
    const result = await record(
      defect({ headSha: unknown }),
      defect({ headSha: commits.fix, issues: [{ ...defect().issues[0], locations: [{ path: "api.ts", startLine: 1, endLine: 1 }] }] }),
      defect({ issues: [{ ...defect().issues[0], locations: [{ path: "api.ts", startLine: 2, endLine: 9 }] }] }),
      defect({ issues: [{ ...defect().issues[0], locations: [{ path: "gone.ts", startLine: 1, endLine: 1 }] }] }),
      clean("missing.ts"),
      clean("a.ts", { mergedAt: "2026-12-01" }),
      clean("a.ts", { knownFalsePositives: [{ finding: "缺少空值检查", why: "调用方已经检查过", location: { path: "b.ts", startLine: 1, endLine: 1 } }] }),
      clean("a.ts", { headSha: commits.target, targetSha: commits.head }),
    );
    const said = result.cases.map((item) => item.reasons.join("；"));
    expect(result.cases.every((item) => item.outcome === "rejected")).toBe(true);
    expect(said[0]).toContain(`headSha ${unknown.slice(0, 12)} 在这个仓库里不存在`);
    expect(said[1]).toContain("已经包含在 headSha 里");
    expect(said[2]).toContain("api.ts 第 2–9 行超出范围：PR 的版本（headSha）只有 2 行");
    expect(said[3]).toContain("gone.ts 在PR 的版本（headSha）里不存在");
    expect(said[4]).toContain("scope 里的 missing.ts 不是这个 PR 改过的文件");
    expect(said[5]).toContain("mergedAt 2026-12-01 晚于今天");
    expect(said[6]).toContain("knownFalsePositives 第 1 个的 b.ts 不在 scope 里");
    expect(said[7]).toContain("headSha 相对 targetSha 没有改动");
    await expect(stat(data)).rejects.toThrow();
  });

  it("says a directory outside any repository is one, and writes nothing", async () => {
    const result = await service.record(reviewBenchmarkRecordRequestSchema.parse({ reviewBenchmarkVersion: REVIEW_BENCHMARK_VERSION, sourceClient: "codex", repositoryPath: root, cases: [defect()] }));
    expect(result).toMatchObject({ status: "repository_not_found", repository: null, cases: [] });
  });

  it("leaves a file it cannot read as it is", async () => {
    await record(clean("a.ts"));
    const file = join(data, `${"1".repeat(64)}.json`);
    await writeFile(file, "{\"reviewBenchmarkVersion\":2}");
    await expect(record(clean("b.ts"))).rejects.toThrow("这个仓库的评测集文件读不了");
    expect(await readFile(file, "utf8")).toBe("{\"reviewBenchmarkVersion\":2}");
  });
});

describe("reading cases", () => {
  it("counts and filters without labels, and holds a holdout case's labels and notes back", async () => {
    const recorded = await record(...FILES.map((file) => clean(file)));
    const splits = new Set(recorded.cases.map((item) => item.split));
    // Fixed commit ids, so the same split each run; eight cases fall on both sides.
    expect(splits).toEqual(new Set(["dev", "holdout"]));
    const listed = await service.list({ reviewBenchmarkVersion: REVIEW_BENCHMARK_VERSION, repositoryPath: repository, offset: 0, limit: 3 });
    expect(listed.counts.clean.candidate).toBe(8);
    expect(listed).toMatchObject({ total: 8, nextOffset: 3 });
    expect(listed.cases).toHaveLength(3);
    expect(listed.cases[0]).not.toHaveProperty("cleanEvidence");
    expect(listed.cases[0]).not.toHaveProperty("history");
    const byProvenance = await service.list({ reviewBenchmarkVersion: REVIEW_BENCHMARK_VERSION, repositoryPath: repository, provenance: "merged-c.ts", offset: 0, limit: 50 });
    expect(byProvenance.cases.map((item) => item.scope)).toEqual([["c.ts"]]);
    expect((await service.list({ reviewBenchmarkVersion: REVIEW_BENCHMARK_VERSION, repositoryPath: repository, set: "defect", offset: 0, limit: 50 })).total).toBe(0);

    const dev = recorded.cases.find((item) => item.split === "dev")!;
    const holdout = recorded.cases.find((item) => item.split === "holdout")!;
    await update({ caseId: holdout.caseId!, expectedStatus: "candidate", note: "第 3 行的改动是有意的。" });
    const shown = await service.get({ reviewBenchmarkVersion: REVIEW_BENCHMARK_VERSION, repositoryPath: repository, caseId: dev.caseId! });
    expect(shown.case).toMatchObject({ labelsWithheld: false, cleanEvidence: "合并后没有回滚，新增的行没有被修改。", knownFalsePositives: [] });
    const withheld = await service.get({ reviewBenchmarkVersion: REVIEW_BENCHMARK_VERSION, repositoryPath: repository, caseId: holdout.caseId! });
    expect(withheld.case).toMatchObject({ labelsWithheld: true, cleanEvidence: null, knownFalsePositives: null, issues: null, split: "holdout" });
    expect(withheld.case!.history.map((event) => event.note)).toEqual([null, null]);
    expect((await service.get({ reviewBenchmarkVersion: REVIEW_BENCHMARK_VERSION, repositoryPath: repository, caseId: "case-000000000000" })).status).toBe("case_not_found");
  });
});

describe("changing a case", () => {
  it("confirms against the status just read, and takes a case whose answer changed back to a candidate", async () => {
    const id = await devDefect();
    expect((await update({ caseId: id, expectedStatus: "confirmed", note: "x" })).status).toBe("status_changed");

    const confirmed = await update({ caseId: id, expectedStatus: "candidate", status: "confirmed", userConfirmation: "核对过了，入集。" });
    expect(confirmed).toMatchObject({ status: "saved", case: { status: "confirmed" } });
    expect(confirmed.case!.history.at(-1)).toMatchObject({ previous: "candidate", status: "confirmed", userConfirmation: "核对过了，入集。", by: { kind: "agent", client: "codex" } });
    expect((await update({ caseId: id, expectedStatus: "confirmed", status: "confirmed", userConfirmation: "核对过了，入集。" })).status).toBe("unchanged");

    // A title is what the reviewer is shown, not the answer: it stays confirmed.
    expect((await update({ caseId: id, expectedStatus: "confirmed", title: "Change the API surface" })).case!.status).toBe("confirmed");
    const relabelled = await update({ caseId: id, expectedStatus: "confirmed", issues: [{ ...defect().issues[0], priority: "P2" }] });
    expect(relabelled.case).toMatchObject({ status: "candidate", issues: [{ priority: "P2" }] });
    expect(relabelled.case!.history.at(-1)).toMatchObject({ previous: "confirmed", status: "candidate", changed: ["issues"] });

    const wrong = await update({ caseId: id, expectedStatus: "candidate", issues: [{ ...defect().issues[0], locations: [{ path: "api.ts", startLine: 5, endLine: 5 }] }] });
    expect(wrong.status).toBe("rejected");
    expect(wrong.reasons.join("")).toContain("超出范围");
    const foreign = await update({ caseId: id, expectedStatus: "candidate", mergedAt: "2026-02-01" });
    expect(foreign).toMatchObject({ status: "rejected", reasons: ["mergedAt 只用于干净集样本，这个样本属于缺陷集"] });

    expect((await update({ caseId: id, expectedStatus: "candidate", note: "等用户核对。" })).status).toBe("saved");
    expect((await update({ caseId: id, expectedStatus: "candidate", note: "等用户核对。" })).status).toBe("unchanged");
    const withdrawn = await update({ caseId: id, expectedStatus: "candidate", status: "withdrawn", reason: "问题出在依赖升级，不是这个 PR。" });
    expect(withdrawn.case).toMatchObject({ status: "withdrawn" });
    expect(withdrawn.case!.history.map((event) => event.status)).toEqual(["candidate", "confirmed", "confirmed", "candidate", "candidate", "withdrawn"]);
    expect((await update({ caseId: "case-000000000000", expectedStatus: "candidate", note: "x" })).status).toBe("case_not_found");
  });

  it("exports only the confirmed cases of the split asked for", async () => {
    const recorded = await record(...FILES.map((file) => clean(file)));
    for (const item of recorded.cases.slice(0, 6)) await update({ caseId: item.caseId!, expectedStatus: "candidate", status: "confirmed", userConfirmation: "都核对过了。" });
    const confirmed = recorded.cases.slice(0, 6);
    for (const split of ["dev", "holdout"] as const) {
      const exported = await service.exportCases(repository, split);
      expect(exported!.cases.map((item) => item.id).sort()).toEqual(confirmed.filter((item) => item.split === split).map((item) => item.caseId).sort());
      expect(exported!.cases.every((item) => item.cleanEvidence !== null)).toBe(true);
    }
    expect((await service.exportCases(repository, "dev", "defect"))!.cases).toEqual([]);
    expect(await service.exportCases(root, "dev")).toBeNull();
  });
});
