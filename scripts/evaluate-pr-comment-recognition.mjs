#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { createServer } from "vite";

import { resolveUserData } from "../config/user-data-directory.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const comment = z.object({
  id: z.string().min(1), author: z.string(), body: z.string(), createdAt: z.string(),
  replyTo: z.string().nullable(), path: z.string().nullable(), line: z.number().int().nullable(),
}).strict();
export const casesSchema = z.object({ version: z.literal(1), cases: z.array(z.object({
  reference: z.string().min(1), title: z.string(), comments: z.array(comment),
}).strict()).min(1) }).strict();
export const labelsSchema = z.object({
  version: z.literal(1), annotator: z.string().optional(), default: z.literal("no"),
  labels: z.record(z.string(), z.enum(["yes", "maybe", "no"])),
}).strict();

const key = (reference, id) => `${reference}/${id}`;
const ratio = (n, d) => d ? n / d : null;
const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};

/** Hand labels against one run: "maybe" is left out of both sides, a comment the run did not judge counts as missed. */
export function scoreRecognition(run, labelInput, casesInput) {
  const labels = labelsSchema.parse(labelInput);
  const cases = casesSchema.parse(casesInput);
  const bodies = new Map(cases.cases.flatMap((item) => item.comments.map((c) => [key(item.reference, c.id), c])));
  const counts = { truePositive: 0, falsePositive: 0, falseNegative: 0, trueNegative: 0, unjudgedPositive: 0, unjudged: 0, maybeFlagged: 0, maybe: 0 };
  const falsePositives = [], falseNegatives = [];
  for (const [id, judged] of Object.entries(run.judged)) {
    const label = labels.labels[id] ?? "no";
    if (label === "maybe") { counts.maybe += 1; if (judged?.decision) counts.maybeFlagged += 1; continue; }
    if (judged === null) { counts.unjudged += 1; if (label === "yes") { counts.unjudgedPositive += 1; counts.falseNegative += 1; falseNegatives.push(id); } continue; }
    if (judged.decision && label === "yes") counts.truePositive += 1;
    else if (judged.decision) { counts.falsePositive += 1; falsePositives.push(id); }
    else if (label === "yes") { counts.falseNegative += 1; falseNegatives.push(id); }
    else counts.trueNegative += 1;
  }
  const precision = ratio(counts.truePositive, counts.truePositive + counts.falsePositive);
  const recall = ratio(counts.truePositive, counts.truePositive + counts.falseNegative);
  const show = (id) => ({ id, author: bodies.get(id)?.author, body: bodies.get(id)?.body.replace(/\s+/gu, " ").slice(0, 160), verdict: run.judged[id] });
  return {
    profile: run.profile, model: run.model, ...counts, precision, recall,
    f1: precision !== null && recall !== null && precision + recall > 0 ? 2 * precision * recall / (precision + recall) : null,
    calls: run.calls.length, failedCalls: run.calls.filter((call) => call.error).length, refused: run.calls.reduce((sum, call) => sum + (call.refused ?? 0), 0),
    inputTokens: run.calls.reduce((sum, call) => sum + (call.usage?.inputTokens ?? 0), 0),
    outputTokens: run.calls.reduce((sum, call) => sum + (call.usage?.outputTokens ?? 0), 0),
    medianCallMs: percentile(run.calls.map((call) => call.ms), 0.5), p95CallMs: percentile(run.calls.map((call) => call.ms), 0.95),
    falsePositives: falsePositives.map(show), falseNegatives: falseNegatives.map(show),
  };
}

async function save(path, value) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
}

async function main() {
  const { positionals, values: args } = parseArgs({ allowPositionals: true, options: Object.fromEntries([
    "cases", "labels", "run", "output", "profiles", "profile-id", "timeout-ms", "skip-authors", "models-directory",
  ].map((name) => [name, { type: "string" }])) });
  const command = positionals[0];
  const read = async (path) => JSON.parse(await readFile(path, "utf8"));
  if (command === "score") {
    if (!args.run || !args.labels || !args.cases) throw new Error("score --run RUN.json --labels LABELS.json --cases CASES.json");
    console.log(JSON.stringify(scoreRecognition(await read(args.run), await read(args.labels), await read(args.cases)), null, 2));
    return;
  }
  if (command !== "run" || !args.cases || !args.output || !args["profile-id"]) {
    throw new Error("run --cases CASES.json --profile-id ID --output RUN.json [--profiles PROFILES.json] [--timeout-ms N] [--skip-authors a,b]");
  }
  await access(args.output).then(() => { throw new Error("Output already exists; choose a new result path"); }, (error) => { if (error.code !== "ENOENT") throw error; });
  const cases = casesSchema.parse(await read(args.cases));
  // The App's data folder where it is now: nothing moved from Decision's by an evaluation.
  const support = resolveUserData(process.env, { migrate: false }).path;
  const stored = (await read(args.profiles ?? resolve(support, "model-provider-profiles.json"))).profiles.find((item) => item.profileId === args["profile-id"]);
  if (!stored) throw new Error(`No model profile ${args["profile-id"]}`);
  // An API profile's key stays in the app's credential store: the evaluator never reads it.
  if (!["qwen", "codex-cli", "claude-code-cli"].includes(stored.kind)) throw new Error("Only Qwen and the Codex / Claude Code CLIs can be evaluated from the command line");
  const skip = new Set((args["skip-authors"] ?? "").split(",").map((name) => name.trim().toLowerCase()).filter(Boolean));
  const server = await createServer({ root, configFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true }, resolve: { alias: {
    "@cognelis/decision-protocol": resolve(root, "packages/protocol/src/index.ts"), "@cognelis/decision-core": resolve(root, "packages/core/src/index.ts"),
    "@cognelis/decision-storage": resolve(root, "packages/storage/src/index.ts"),
  } } });
  let gateway;
  try {
    const load = (path) => server.ssrLoadModule(resolve(root, path));
    const { modelProviderProfileSchema } = await load("packages/protocol/src/index.ts");
    const { ProfiledModelGateway } = await load("apps/desktop/src/main/model/profiled-model-gateway.ts");
    const { recognitionBatches, judgeBatch, PR_COMMENT_RECOGNITION_PROMPT_VERSION } = await load("apps/desktop/src/main/pr-comment-recognition.ts");
    const profile = modelProviderProfileSchema.parse({ ...stored, priority: 0, enabled: true, ...(args["timeout-ms"] ? { timeoutMs: Number(args["timeout-ms"]) } : {}) });
    const provider = profile.kind === "qwen"
      ? new (await load("apps/desktop/src/main/semantic/qwen-provider.ts")).QwenModelProvider({ modelsDirectory: args["models-directory"] ?? resolve(support, "models"), ...(profile.model ? { model: profile.model } : {}), timeoutMs: profile.timeoutMs })
      : profile.kind === "codex-cli"
        ? new (await load("apps/desktop/src/main/model/adapters/codex-cli-adapter.ts")).CodexCliAdapter({ profile })
        : new (await load("apps/desktop/src/main/model/adapters/claude-code-cli-adapter.ts")).ClaudeCodeCliAdapter({ profile });
    gateway = new ProfiledModelGateway({ profiles: { load: async () => [profile] }, providerFactory: () => provider, traces: { record: async (trace) => {
      // A failed call says why in its trace: kept out of the result file, shown here.
      if (trace.status !== "succeeded") console.error(JSON.stringify(Object.fromEntries(Object.entries(trace).filter(([name]) => !["input", "output", "profile"].includes(name)))).slice(0, 1500));
    } }, audit: {} });
    const judged = {}, calls = [];
    let model = profile.model ?? null;
    for (const item of cases.cases) {
      const subjects = new Set(item.comments.filter((c) => c.body.trim() && !skip.has(c.author.toLowerCase().split(/[\s-]/u)[0]) && !skip.has(c.author.toLowerCase())).map((c) => c.id));
      for (const id of subjects) judged[key(item.reference, id)] = null;
      const bodies = new Map(item.comments.map((c) => [c.id, c.body]));
      for (const batch of recognitionBatches({ title: item.title, reference: item.reference }, item.comments, subjects, profile.kind)) {
        const started = performance.now();
        try {
          const result = await judgeBatch(gateway, { requestId: `eval:${randomUUID()}`, profileId: profile.profileId, batch, bodies });
          model = result.model;
          for (const verdict of result.verdicts) judged[key(item.reference, verdict.id)] = verdict;
          calls.push({ reference: item.reference, subjects: batch.subjects.length, promptChars: batch.prompt.length, ms: Math.round(performance.now() - started), refused: result.refused, usage: result.usage });
        } catch (error) {
          calls.push({ reference: item.reference, subjects: batch.subjects.length, promptChars: batch.prompt.length, ms: Math.round(performance.now() - started), error: `${error?.failureCode ?? error?.name ?? "error"}: ${String(error?.message ?? error).slice(0, 300)}` });
        }
        const last = calls.at(-1);
        console.log(`${item.reference} · ${batch.subjects.length} 条 · ${last.ms} ms${last.error ? ` · 失败 ${last.error}` : ""}`);
      }
    }
    await save(args.output, { version: 1, promptVersion: PR_COMMENT_RECOGNITION_PROMPT_VERSION, profile: profile.profileId, kind: profile.kind, model,
      timeoutMs: profile.timeoutMs, skipAuthors: [...skip], judged, calls });
    console.log(`评测结果已保存：${args.output}`);
  } finally {
    await gateway?.close();
    await server.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
