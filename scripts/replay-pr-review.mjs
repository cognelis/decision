#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, access, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createServer } from "vite";
import { resolveUserData } from "../config/user-data-directory.mjs";

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

/** Synthetic decisions for a replay: notes as the App writes them into its vault (the `files` a context-run seed takes). */
export const decisionFixtureSchema = z.object({
  version: z.literal(1), synthetic: z.literal(true),
  files: z.array(z.object({ path: z.string().min(1).max(1_000), content: z.string().max(200_000) }).strict()).max(500),
}).strict();
/**
 * A fixture's notes in a fresh vault, searched by the App's own repository and context service: scopes, relations,
 * applicability and lifecycle as the App works them out. Not as the App: no semantic supplement (a local embedding
 * model adds at most three records the words missed), so a fixture's decisions must be found by their words.
 */
export async function fixtureDecisions(input, { storage, DecisionContextService }) {
  const fixture = decisionFixtureSchema.parse(input);
  const vault = await mkdtemp(join(tmpdir(), "decision-pr-replay-vault-"));
  try {
    // Every source's folder, present though empty: one missing reads as a source unavailable, coverage incomplete.
    for (const source of ["summarize", "decisions", "principles"]) await mkdir(join(vault, "Decision Journal", source), { recursive: true });
    for (const file of fixture.files) {
      const target = resolve(vault, file.path);
      if (!relative(vault, target).startsWith(`Decision Journal${sep}`)) throw new Error(`Fixture path must stay in Decision Journal: ${file.path}`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, { flag: "wx" });
    }
  } catch (error) { await rm(vault, { recursive: true, force: true }); throw error; }
  const scopes = new storage.DecisionScopeRepository(vault), relations = new storage.DecisionRelationRepository(vault);
  const context = new DecisionContextService(new storage.DecisionContextRepository(vault, scopes, relations), scopes, relations);
  return { search: (query) => context.search(query), close: () => rm(vault, { recursive: true, force: true }) };
}
/** A directory of review rules, loaded and matched as the App's own (`userData/review-rules`) are. */
export const fixtureRules = (directory, storage) => async (target) => {
  const { rules, warnings } = await storage.loadReviewRules(resolve(directory));
  const matched = storage.matchReviewRules(rules, target);
  return { instructions: storage.combineReviewRules(matched), rules: matched.map((rule) => ({ id: rule.id.slice(0, 500), source: "decision" })),
    warnings: warnings.map((warning) => `Paraself ${warning}`) };
};

const span = (path, side, { startLine, text }) => [path, side, startLine, startLine + text.split("\n").length - 1];
/**
 * A trace as a replay keeps it. A verify call also keeps its verdicts and where the material the program gathered
 * (`functions`, `callerSearch`) sat, as [path, side, first, last] lines without their text, so a premise can be told
 * to stand on it. The versions are on the trace's profile: read off the trace itself, every replay kept them empty.
 */
export function traceSummary(trace) {
  const promptVersion = trace.profile?.promptVersion ?? trace.promptVersion;
  const kept = { promptVersion, schemaVersion: trace.profile?.schemaVersion ?? trace.schemaVersion, model: trace.profile?.model ?? trace.model,
    status: trace.status, errorCode: trace.errorCode, usage: trace.usage };
  if (!promptVersion?.startsWith("pr-review-verify") || typeof trace.input?.userPrompt !== "string") return kept;
  let sent;
  try { sent = JSON.parse(trace.input.userPrompt); } catch { return kept; }
  return { ...kept, verify: {
    candidates: (sent.candidates ?? []).map(({ id, path, side, line, title, decisionIndexes }) => ({ id, path, side, line, title, decisionIndexes: decisionIndexes ?? [] })),
    // The decisions this call was given, by evidence index: those its candidates cite and the room left them.
    decisions: (sent.decisions ?? []).map((item) => item.index),
    functions: (sent.functions ?? []).flatMap(({ path, old, new: next }) => [...(old ? [span(path, "old", old)] : []), ...(next ? [span(path, "new", next)] : [])]),
    callerSearch: (sent.callerSearch ?? []).map(({ path, complete, symbols }) => ({ path, complete,
      symbols: symbols.map(({ symbol, truncated, noMatch, hits }) => ({ symbol, truncated, noMatch, hits: hits.map((hit) => span(hit.path, hit.side, hit)) })) })),
    verdicts: (trace.output?.parsed?.verdicts ?? []).map(({ id, verdict, premises }) => ({ id, verdict, premises: premises ?? null })),
  } };
}

const findingKey = (finding) => JSON.stringify([finding.path, finding.side, finding.line, finding.title, finding.body]);
/** Human adjudication is deliberately separate from replay inputs and model prompts. */
export function scoreReplay(run, labelInput, judgmentInput) {
  const labels = z.object({ issues: z.array(z.object({ id: z.string().min(1), priority: z.enum(["P1", "P2", "P3"]), evidence: z.string().min(1) }).strict()) }).strict().parse(labelInput);
  // A false positive may say what acting on it would have done (harmful, noise) and which known false positive it repeats.
  const judgments = z.array(z.object({ candidate: z.number().int().nonnegative(), verdict: z.enum(["true_positive", "false_positive"]), issueIds: z.array(z.string()),
    impact: z.enum(["harmful", "noise"]).optional(), knownFalsePositive: z.number().int().positive().optional() }).strict()).parse(judgmentInput);
  const issues = new Set(labels.issues.map((issue) => issue.id));
  if (issues.size !== labels.issues.length) throw new Error("Duplicate issue labels");
  const judged = new Set();
  for (const item of judgments) {
    if (judged.has(item.candidate) || !run.candidates[item.candidate]) throw new Error("Duplicate or unknown candidate");
    if (item.issueIds.some((id) => !issues.has(id)) || (item.verdict === "false_positive" && item.issueIds.length)) throw new Error("Invalid issue adjudication");
    if (item.verdict === "true_positive" && (item.impact !== undefined || item.knownFalsePositive !== undefined)) throw new Error("Only a false positive has an impact or repeats a known one");
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
    finalComments: run.report.findings.length,
    finalHarmful: kept.filter((item) => item.impact === "harmful").length, finalNoise: kept.filter((item) => item.impact === "noise").length,
    finalValid: kept.filter((item) => item.verdict === "true_positive").length,
    knownFalsePositiveRepeats: [...new Set(kept.flatMap((item) => (item.knownFalsePositive === undefined ? [] : [item.knownFalsePositive])))],
    status: run.report.status, usage: run.report.usage, wallMs: run.wallMs,
  };
}

/** Below this many scored cases a set's rates are left out: a case or two moving says nothing (the design's pilot size). */
export const BENCHMARK_RATE_MINIMUM = 20;
/**
 * Each set's totals over its scored cases (scoreReplay each): the defect set by issues caught, the clean set by what its
 * final comments would have done. Rates only from BENCHMARK_RATE_MINIMUM cases up; counts always.
 */
export function scoreBenchmark(scored) {
  const sum = (items, key) => items.reduce((total, item) => total + item[key], 0);
  const rate = (items, value) => (items.length >= BENCHMARK_RATE_MINIMUM ? value : null);
  const defect = scored.filter((item) => item.set === "defect").map((item) => item.score);
  const clean = scored.filter((item) => item.set === "clean").map((item) => item.score);
  const known = sum(defect, "knownIssues");
  return {
    defect: {
      scored: defect.length, knownIssues: known, candidateCaught: sum(defect, "candidateCaught"), finalCaught: sum(defect, "finalCaught"),
      candidateRecall: rate(defect, known ? sum(defect, "candidateCaught") / known : null), finalRecall: rate(defect, known ? sum(defect, "finalCaught") / known : null),
      unjudgedFindings: sum(defect, "unjudgedFindings"),
    },
    clean: {
      scored: clean.length, finalComments: sum(clean, "finalComments"), harmful: sum(clean, "finalHarmful"), noise: sum(clean, "finalNoise"), valid: sum(clean, "finalValid"),
      harmfulPer10: rate(clean, clean.length ? (sum(clean, "finalHarmful") * 10) / clean.length : null),
      commentsPerCase: rate(clean, clean.length ? sum(clean, "finalComments") / clean.length : null),
      knownFalsePositiveRepeats: clean.reduce((total, item) => total + item.knownFalsePositiveRepeats.length, 0),
      unjudgedFindings: sum(clean, "unjudgedFindings"),
    },
  };
}

/** The implementation's TypeScript, loaded as the App runs it: `run` reviews with it, `export-benchmark` reads the App's cases. */
const implementationServer = (implementation, cacheDirectory) => createServer({ root: implementation, cacheDir: resolve(cacheDirectory ?? resolve(implementation, "node_modules/.vite")), configFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true }, resolve: { alias: {
  "@cognelis/decision-protocol": resolve(implementation, "packages/protocol/src/index.ts"), "@cognelis/decision-core": resolve(implementation, "packages/core/src/index.ts"),
  "@cognelis/decision-storage": resolve(implementation, "packages/storage/src/index.ts"),
  "@cognelis/decision-integrations": resolve(implementation, "packages/integrations/src/index.ts"),
} } });

/**
 * One confirmed review benchmark case as the replay takes it (docs/pr-review-replay.md「从评测集导出」): the case
 * without its answer, the answer `score` reads, and what a judge needs beside it.
 */
export function benchmarkReplayFiles(item, { repositoryDirectory, project, index }) {
  const reference = item.pr ? `${item.pr.repository}#${item.pr.number}` : `benchmark/${project.replace(/[^\p{L}\p{N}_.~@-]+/gu, "-") || "repository"}#${index + 1}`;
  const repository = reference.split("#")[0];
  const sample = replayCaseSchema.parse({ version: 1, id: item.id, reference, repositoryDirectory,
    pr: { title: item.title, description: "", source: { repository, commit: item.headSha }, destination: { repository, commit: item.targetSha }, base: item.baseSha },
    ...(item.scope.length > 0 ? { paths: item.scope } : {}) });
  const where = (location) => `${location.path}:${location.startLine}${location.endLine === location.startLine ? "" : `-${location.endLine}`}${location.side === "old" ? "（PR 之前的版本）" : ""}`;
  const counted = (item.issues ?? []).filter((issue) => !issue.tradeoff);
  const labels = { issues: counted.map((issue, number) => ({ id: `I${number + 1}`, priority: issue.priority, evidence: `${issue.title}（${issue.locations.map(where).join("、")}）：${issue.evidence}` })) };
  const tradeoffs = (item.issues ?? []).filter((issue) => issue.tradeoff);
  return {
    sample, labels,
    ...(tradeoffs.length > 0 ? { tradeoffs } : {}),
    ...((item.knownFalsePositives ?? []).length > 0 ? { knownFalsePositives: item.knownFalsePositives } : {}),
    manifest: { id: item.id, set: item.set, reference, ...(item.set === "defect" ? { issues: counted.map((issue, number) => ({ id: `I${number + 1}`, locations: issue.locations, fixShas: issue.fixShas })) } : { mergedAt: item.mergedAt }) },
  };
}

async function save(path, value) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
}

async function main() {
  const { positionals, values: args } = parseArgs({ allowPositionals: true, options: Object.fromEntries([
    "repository", "reference", "head", "target", "title", "output", "case", "executable", "model", "labels", "judgments", "run", "path", "implementation", "provider", "cache-dir", "decisions", "rules", "depth", "set", "split", "directory",
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
    console.log(`已保存固定提交回放定义：${args.output}（不含评论、过往决策或缺陷答案）`);
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
  if (command === "score-benchmark") {
    if (!args.directory) throw new Error("score-benchmark --directory EXPORT_DIR [--run run.json] [--judgments judgments.json] [--output SUMMARY.json]");
    const read = async (path) => JSON.parse(await readFile(path, "utf8"));
    const manifest = await read(join(args.directory, "manifest.json"));
    const scored = [], missing = [];
    for (const item of manifest.cases) {
      const directory = join(args.directory, item.id);
      const [run, judgments] = await Promise.all([args.run ?? "run.json", args.judgments ?? "judgments.json"].map((name) => read(join(directory, name)).catch((error) => (error.code === "ENOENT" ? null : Promise.reject(error)))));
      if (run === null || judgments === null) { missing.push({ id: item.id, run: run !== null, judgments: judgments !== null }); continue; }
      scored.push({ id: item.id, set: item.set, score: scoreReplay(run, await read(join(directory, "labels.json")), judgments) });
    }
    const summary = { version: 1, split: manifest.split, repository: manifest.repository, ...scoreBenchmark(scored), missing, cases: scored.map(({ id, set, score }) => ({ id, set, ...score })) };
    if (args.output) await save(args.output, summary);
    console.log(JSON.stringify({ defect: summary.defect, clean: summary.clean, missing }, null, 2));
    return;
  }
  if (command === "export-benchmark") {
    const usage = "export-benchmark --repository DIR --output NEW_DIR [--set defect|clean] [--split dev|holdout]";
    if (!args.repository || !args.output) throw new Error(usage);
    const split = args.split ?? "dev";
    if (!["dev", "holdout"].includes(split) || (args.set !== undefined && !["defect", "clean"].includes(args.set))) throw new Error(usage);
    const server = await implementationServer(root, args["cache-dir"]);
    try {
      const { ReviewBenchmarkService } = await server.ssrLoadModule(resolve(root, "apps/desktop/src/main/review-benchmark-service.ts"));
      const service = new ReviewBenchmarkService(join(resolveUserData(process.env, { migrate: false }).path, "review-benchmark"));
      const repositoryDirectory = resolve(args.repository);
      const found = await service.exportCases(repositoryDirectory, split, args.set);
      if (found === null) throw new Error("--repository is not in a Git repository");
      await access(args.output).then(() => { throw new Error("Output already exists; choose a new directory"); }, (error) => { if (error.code !== "ENOENT") throw error; });
      await mkdir(args.output, { recursive: true });
      const cases = [];
      for (const [index, item] of found.cases.entries()) {
        const files = benchmarkReplayFiles(item, { repositoryDirectory, project: found.repository.project, index });
        await createReplayClient(files.sample);
        await save(join(args.output, item.id, "case.json"), files.sample);
        await save(join(args.output, item.id, "labels.json"), files.labels);
        if (files.tradeoffs) await save(join(args.output, item.id, "tradeoffs.json"), files.tradeoffs);
        if (files.knownFalsePositives) await save(join(args.output, item.id, "known-false-positives.json"), files.knownFalsePositives);
        cases.push(files.manifest);
      }
      await save(join(args.output, "manifest.json"), { version: 1, repository: found.repository, split, set: args.set ?? null, exportedAt: new Date().toISOString(), cases });
      console.log(`已导出 ${cases.length} 个已确认的${split === "dev" ? "开发集" : "留出集"}样本：${args.output}（每个样本一个目录，case.json 不含答案，答案在 labels.json）`);
    } finally {
      await server.close();
    }
    return;
  }
  if (command !== "run" || !args.case || !args.executable || !args.output) throw new Error("run --case CASE.json --executable /path/to/codex|claude --output RESULT.json [--provider codex|claude-code] [--model MODEL] [--decisions FIXTURE.json] [--rules RULES_DIR] [--depth deep]");
  const backend = { codex: { kind: "codex-cli", module: "codex-cli-adapter.ts", adapter: "CodexCliAdapter", defaultModel: "codex-default" },
    "claude-code": { kind: "claude-code-cli", module: "claude-code-cli-adapter.ts", adapter: "ClaudeCodeCliAdapter", defaultModel: "claude-default" } }[args.provider ?? "codex"];
  if (!backend) throw new Error("--provider must be codex or claude-code");
  if (args.depth !== undefined && args.depth !== "deep") throw new Error("--depth must be deep");
  await access(args.output).then(() => { throw new Error("Output already exists; choose a new result path"); }, (error) => { if (error.code !== "ENOENT") throw error; });
  const input = await readFile(args.case, "utf8");
  const sample = replayCaseSchema.parse(JSON.parse(input));
  const implementation = resolve(args.implementation ?? root);
  const server = await implementationServer(implementation, args["cache-dir"]);
  let gateway, decisions;
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
    const { [backend.adapter]: Adapter } = await server.ssrLoadModule(resolve(implementation, "apps/desktop/src/main/model/adapters", backend.module));
    const client = await createReplayClient(sample, () => new PrPlatformError(404));
    const fixture = args.decisions ? await readFile(args.decisions, "utf8") : null;
    const storage = fixture || args.rules ? await server.ssrLoadModule(resolve(implementation, "packages/storage/src/index.ts")) : null;
    if (fixture) decisions = await fixtureDecisions(JSON.parse(fixture), { storage,
      DecisionContextService: (await server.ssrLoadModule(resolve(implementation, "apps/desktop/src/main/decision-context-service.ts"))).DecisionContextService });
    const profile = modelProviderProfileSchema.parse({ version: 1, profileId: "replay", kind: backend.kind, label: "PR 回放", enabled: true,
      executablePath: resolve(args.executable), priority: 0, timeoutMs: 120_000, ...(args.model ? { model: args.model } : {}) });
    gateway = new ProfiledModelGateway({ profiles: { load: async () => [profile] }, providerFactory: () => new Adapter({ profile }),
      traces: { record: async (trace) => { traces.push(traceSummary(trace)); } }, audit: {} });
    const service = new PrReviewService({ gateway, createClient: async () => client, onCandidates: (items) => { candidatesObserved = true; candidates.push(...items); },
      searchDecisions: decisions ? decisions.search : async () => ({ contextVersion: 1, status: "no_match", coverage: "complete", sources: [], results: [], total: 0, nextOffset: null, guidance: "回放未提供当时的过往决策。" }),
      ...(args.rules ? { loadRules: fixtureRules(args.rules, storage) } : {}),
      onProgress: (event) => { progress.push(event); console.log(`${event.status} ${event.message}`); } });
    const runId = randomUUID();
    const stop = () => service.cancel(runId);
    controller.signal.addEventListener("abort", stop, { once: true });
    const snapshot = await service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: sample.reference });
    if (controller.signal.aborted) throw new Error("Replay cancelled before review");
    const report = await service.run({ snapshotId: snapshot.snapshotId, runId, profileId: profile.profileId, focus: "", ...(sample.paths ? { paths: sample.paths } : {}), ...(args.depth ? { depth: args.depth } : {}) });
    controller.signal.removeEventListener("abort", stop);
    const implementationFiles = ["apps/desktop/src/main/pr-review-service.ts", "apps/desktop/src/main/pr-platform-client.ts", "apps/desktop/src/main/pr-review-plan.ts", "packages/protocol/src/pr-review.ts"];
    if (await access(resolve(implementation, "apps/desktop/src/main/pr-review-source.ts")).then(() => true, () => false)) implementationFiles.push("apps/desktop/src/main/pr-review-source.ts");
    const fingerprints = Object.fromEntries(await Promise.all(implementationFiles.map(async (path) => [path, createHash("sha256").update(await readFile(resolve(implementation, path))).digest("hex")])));
    const candidateObservation = candidatesObserved ? "before-verification" : "final-and-filtered";
    if (!candidatesObserved) candidates.push(...report.findings, ...(report.filtered ?? []).map((item) => item.finding));
    await save(args.output, { version: 1, caseId: sample.id, caseSha256: createHash("sha256").update(input).digest("hex"),
      implementation, implementationFiles: fingerprints, candidateObservation,
      ...(fixture ? { decisionsFixture: { path: resolve(args.decisions), sha256: createHash("sha256").update(fixture).digest("hex") } } : {}),
      ...(args.rules ? { rulesDirectory: resolve(args.rules) } : {}),
      sourceCommit: sample.pr.source.commit, baseCommit: sample.pr.base, model: profile.model ?? backend.defaultModel, profile,
      wallMs: Math.round(performance.now() - started), candidates, report, traces, progress });
    if (report.status !== "completed") process.exitCode = 2;
    console.log(`回放结果已保存：${args.output}`);
  } finally {
    process.removeListener("SIGINT", cancel);
    await gateway?.close();
    await decisions?.close();
    await server.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
