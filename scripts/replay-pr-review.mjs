#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createServer } from "vite";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const sha = z.string().regex(/^[a-f0-9]{40,64}$/u);
const reference = z.string().regex(/^[\p{L}\p{N}_.~@/-]+#[1-9]\d*$/u);
const revision = z.object({ repository: z.string().min(1), commit: sha }).strict();
export const replayCaseSchema = z.object({
  version: z.literal(1), id: z.string().min(1).max(200), reference,
  repositoryDirectory: z.string().min(1),
  pr: z.object({ title: z.string().min(1).max(2_000), description: z.string().max(20_000), source: revision, destination: revision, base: sha }).strict(),
  paths: z.array(z.string().min(1)).min(1).optional(),
}).strict();
const git = async (directory, args, signal) => (await exec("git", ["-C", directory, ...args], {
  encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 30_000, signal,
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1" },
})).stdout;
const validPath = (path) => {
  if (typeof path !== "string" || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Invalid repository path");
  return path;
};

/** Uses immutable Git objects only: no checkout, fetch, hooks, working-tree files, or review labels. */
export async function createReplayClient(input, missingFile = () => new Error("File missing at the pinned revision")) {
  const sample = replayCaseSchema.parse(input);
  const directory = resolve(sample.repositoryDirectory);
  for (const commit of [sample.pr.base, sample.pr.source.commit, sample.pr.destination.commit]) {
    if ((await git(directory, ["rev-parse", "--verify", `${commit}^{commit}`])).trim() !== commit) throw new Error("Missing pinned commit");
  }
  const diffArgs = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames"];
  const diff = await git(directory, [...diffArgs, "--unified=3", sample.pr.base, sample.pr.source.commit, "--"]);
  if (Buffer.byteLength(diff) > 2 * 1024 * 1024) throw new Error("Replay diff exceeds the production 2 MiB cap");
  const names = (await git(directory, [...diffArgs, "--name-status", "-z", sample.pr.base, sample.pr.source.commit, "--"])).split("\0");
  const files = [];
  for (let index = 0; index + 1 < names.length; index += 2) files.push({ path: validPath(names[index + 1]), status: names[index] === "A" ? "added" : names[index] === "D" ? "deleted" : "modified" });
  const revisionOf = (pr, side) => side === "old" ? pr.base : pr.source.commit;
  const cache = new Map();
  const client = {
    get: async () => structuredClone(sample.pr), files: async () => files, diff: async () => diff,
    readFileContent: async (pr, path, side, signal) => {
      const commit = sha.parse(revisionOf(pr, side));
      const key = `${commit}:${validPath(path)}`;
      signal?.throwIfAborted();
      if (cache.has(key)) return cache.get(key);
      const content = await git(directory, ["show", "--no-ext-diff", "--no-textconv", key], signal).catch((error) => {
        if (/does not exist in|exists on disk, but not in/u.test(error.stderr ?? "")) throw missingFile();
        throw error;
      });
      if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error("Source exceeds 2 MiB");
      cache.set(key, content);
      while (cache.size > 50) cache.delete(cache.keys().next().value);
      return content;
    },
    readFile: async (pr, path, start, signal) => (await client.readFileContent(pr, path, "new", signal)).split("\n").slice(start - 1, start + 79).join("\n"),
    repositoryFiles: async (pr, side, signal) => {
      const tree = await git(directory, ["ls-tree", "-r", "-z", sha.parse(revisionOf(pr, side))], signal);
      const paths = tree.split("\0").filter((entry) => /^100(?:644|755) blob /u.test(entry)).map((entry) => validPath(entry.slice(entry.indexOf("\t") + 1))).sort();
      return { paths: paths.slice(0, 20_000), complete: paths.length <= 20_000 };
    },
    comments: async () => [],
  };
  return client;
}

const findingKey = (finding) => JSON.stringify([finding.path, finding.side, finding.line, finding.title, finding.body]);
/** Human adjudication is deliberately separate from replay inputs and model prompts. */
export function scoreReplay(run, labelInput, judgmentInput) {
  const labels = z.object({ issues: z.array(z.object({ id: z.string().min(1), priority: z.enum(["P1", "P2", "P3"]), evidence: z.string().min(1) }).strict()) }).strict().parse(labelInput);
  const judgments = z.array(z.object({ candidate: z.number().int().nonnegative(), verdict: z.enum(["true_positive", "false_positive"]), issueIds: z.array(z.string()) }).strict()).parse(judgmentInput);
  const issues = new Set(labels.issues.map((issue) => issue.id));
  if (issues.size !== labels.issues.length) throw new Error("Duplicate issue labels");
  const judged = new Set();
  for (const item of judgments) {
    if (judged.has(item.candidate) || !run.candidates[item.candidate]) throw new Error("Duplicate or unknown candidate");
    if (item.issueIds.some((id) => !issues.has(id)) || (item.verdict === "false_positive" && item.issueIds.length)) throw new Error("Invalid issue adjudication");
    judged.add(item.candidate);
  }
  const final = new Set(run.report.findings.map(findingKey));
  const kept = judgments.filter((item) => final.has(findingKey(run.candidates[item.candidate])));
  const caught = (items) => new Set(items.filter((item) => item.verdict === "true_positive").flatMap((item) => item.issueIds));
  const candidates = caught(judgments), retained = caught(kept);
  const ratio = (n, d) => d ? n / d : null;
  return {
    knownIssues: issues.size, candidateCaught: candidates.size, finalCaught: retained.size,
    candidateRecall: ratio(candidates.size, issues.size), finalRecall: ratio(retained.size, issues.size),
    verificationLossRate: ratio(candidates.size - retained.size, candidates.size),
    finalPrecision: ratio(kept.filter((item) => item.verdict === "true_positive").length, kept.length),
    unjudgedCandidates: run.candidates.length - judged.size, unjudgedFindings: run.report.findings.length - kept.length,
    missedIssueIds: [...issues].filter((id) => !retained.has(id)),
    status: run.report.status, usage: run.report.usage, wallMs: run.wallMs,
  };
}

async function save(path, value) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
}

async function main() {
  const { positionals, values: args } = parseArgs({ allowPositionals: true, options: Object.fromEntries([
    "repository", "reference", "head", "target", "title", "output", "case", "executable", "model", "labels", "judgments", "run", "path", "implementation",
  ].map((name) => [name, { type: "string" }])) });
  const command = positionals[0];
  if (command === "prepare") {
    if (!args.repository || !args.reference || !args.head || !args.target || !args.title || !args.output) throw new Error("prepare --repository DIR --reference OWNER/REPO#N --head SHA --target SHA --title TITLE --output CASE.json [--path PATH]");
    const head = sha.parse(args.head), target = sha.parse(args.target);
    const base = sha.parse((await git(args.repository, ["merge-base", head, target])).trim());
    const repo = reference.parse(args.reference).split("#")[0];
    const sample = replayCaseSchema.parse({ version: 1, id: args.reference.replace(/[\/#]/gu, "-"), reference: args.reference,
      repositoryDirectory: resolve(args.repository), pr: { title: args.title, description: "", source: { repository: repo, commit: head }, destination: { repository: repo, commit: target }, base },
      ...(args.path ? { paths: [validPath(args.path)] } : {}) });
    await createReplayClient(sample);
    await save(args.output, sample);
    console.log(`已保存固定提交回放定义：${args.output}（不含评论、历史决策或缺陷答案）`);
    return;
  }
  if (command === "score") {
    if (!args.run || !args.labels || !args.judgments) throw new Error("score --run RESULT.json --labels LABELS.json --judgments JUDGMENTS.json");
    const read = async (path) => JSON.parse(await readFile(path, "utf8"));
    const result = scoreReplay(await read(args.run), await read(args.labels), await read(args.judgments));
    if (args.output) await save(args.output, result);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command !== "run" || !args.case || !args.executable || !args.output) throw new Error("run --case CASE.json --executable /path/to/codex --output RESULT.json [--model MODEL]");
  await access(args.output).then(() => { throw new Error("Output already exists; choose a new result path"); }, (error) => { if (error.code !== "ENOENT") throw error; });
  const input = await readFile(args.case, "utf8");
  const sample = replayCaseSchema.parse(JSON.parse(input));
  const implementation = resolve(args.implementation ?? root);
  const server = await createServer({ root: implementation, configFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true }, resolve: { alias: {
    "@cognelis/decision-protocol": resolve(implementation, "packages/protocol/src/index.ts"), "@cognelis/decision-core": resolve(implementation, "packages/core/src/index.ts"),
    "@cognelis/decision-storage": resolve(implementation, "packages/storage/src/index.ts"),
  } } });
  let gateway;
  const started = performance.now(), candidates = [], traces = [], progress = [];
  let candidatesObserved = false;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  try {
    const { modelProviderProfileSchema } = await server.ssrLoadModule(resolve(implementation, "packages/protocol/src/index.ts"));
    const { PrReviewService } = await server.ssrLoadModule(resolve(implementation, "apps/desktop/src/main/pr-review-service.ts"));
    const { PrPlatformError } = await server.ssrLoadModule(resolve(implementation, "apps/desktop/src/main/pr-platform-client.ts"));
    const { ProfiledModelGateway } = await server.ssrLoadModule(resolve(implementation, "apps/desktop/src/main/model/profiled-model-gateway.ts"));
    const { CodexCliAdapter } = await server.ssrLoadModule(resolve(implementation, "apps/desktop/src/main/model/adapters/codex-cli-adapter.ts"));
    const client = await createReplayClient(sample, () => new PrPlatformError(404));
    const profile = modelProviderProfileSchema.parse({ version: 1, profileId: "replay", kind: "codex-cli", label: "PR 回放", enabled: true,
      executablePath: resolve(args.executable), priority: 0, timeoutMs: 120_000, ...(args.model ? { model: args.model } : {}) });
    gateway = new ProfiledModelGateway({ profiles: { load: async () => [profile] }, providerFactory: () => new CodexCliAdapter({ profile }),
      traces: { record: async (trace) => { traces.push({ promptVersion: trace.promptVersion, schemaVersion: trace.schemaVersion, model: trace.model,
        status: trace.status, errorCode: trace.errorCode, usage: trace.usage }); } }, audit: {} });
    const service = new PrReviewService({ gateway, createClient: async () => client, onCandidates: (items) => { candidatesObserved = true; candidates.push(...items); },
      searchDecisions: async () => ({ contextVersion: 1, status: "no_match", coverage: "complete", sources: [], results: [], total: 0, nextOffset: null, guidance: "回放未提供当时的历史决策。" }),
      onProgress: (event) => { progress.push(event); console.log(`${event.status} ${event.message}`); } });
    const runId = randomUUID();
    const stop = () => service.cancel(runId);
    controller.signal.addEventListener("abort", stop, { once: true });
    const snapshot = await service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: sample.reference });
    if (controller.signal.aborted) throw new Error("Replay cancelled before review");
    const report = await service.run({ snapshotId: snapshot.snapshotId, runId, profileId: profile.profileId, focus: "", ...(sample.paths ? { paths: sample.paths } : {}) });
    controller.signal.removeEventListener("abort", stop);
    const implementationFiles = ["apps/desktop/src/main/pr-review-service.ts", "apps/desktop/src/main/pr-platform-client.ts", "apps/desktop/src/main/pr-review-plan.ts", "packages/protocol/src/pr-review.ts"];
    if (await access(resolve(implementation, "apps/desktop/src/main/pr-review-source.ts")).then(() => true, () => false)) implementationFiles.push("apps/desktop/src/main/pr-review-source.ts");
    const fingerprints = Object.fromEntries(await Promise.all(implementationFiles.map(async (path) => [path, createHash("sha256").update(await readFile(resolve(implementation, path))).digest("hex")])));
    const candidateObservation = candidatesObserved ? "before-verification" : "final-and-filtered";
    if (!candidatesObserved) candidates.push(...report.findings, ...(report.filtered ?? []).map((item) => item.finding));
    await save(args.output, { version: 1, caseId: sample.id, caseSha256: createHash("sha256").update(input).digest("hex"),
      implementation, implementationFiles: fingerprints, candidateObservation,
      sourceCommit: sample.pr.source.commit, baseCommit: sample.pr.base, model: profile.model ?? "codex-default", profile,
      wallMs: Math.round(performance.now() - started), candidates, report, traces, progress });
    if (report.status !== "completed") process.exitCode = 2;
    console.log(`回放结果已保存：${args.output}`);
  } finally {
    process.removeListener("SIGINT", cancel);
    await gateway?.close();
    await server.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
