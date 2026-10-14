#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cpus, totalmem } from "node:os";
import { createServer } from "vite";
import { createRulePredictor, evaluateSemanticCorpus } from "./evaluate-semantic-classifier.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

export const summarizeRows = (rows) => {
  const positive = rows.filter((row) => row.expectedBand !== "low");
  const negative = rows.filter((row) => row.expectedBand === "low");
  const high = rows.filter((row) => row.prediction.band === "high");
  const latencies = rows.filter((row) => !row.error).map((row) => row.inferenceMs).sort((a, b) => a - b);
  const percentile = (p) => latencies.length ? latencies[Math.ceil(p * latencies.length) - 1] : null;
  const ratio = (n, d) => d ? n / d : null;
  return {
    samples: rows.length,
    successful: rows.filter((row) => !row.error).length,
    successRate: ratio(rows.filter((row) => !row.error).length, rows.length),
    highPredictions: high.length,
    highPrecision: ratio(high.filter((row) => row.expectedBand !== "low").length, high.length),
    recall: ratio(positive.filter((row) => row.prediction.band !== "low").length, positive.length),
    falsePositiveRate: ratio(negative.filter((row) => row.prediction.band !== "low").length, negative.length),
    bandAccuracy: ratio(rows.filter((row) => row.prediction.band === row.expectedBand).length, rows.length),
    relationAccuracy: ratio(rows.filter((row) => row.prediction.relation === row.expectedRelation).length, rows.length),
    medianInferenceMs: percentile(0.5),
    p95InferenceMs: percentile(0.95),
    maxProcessRssBytes: Math.max(0, ...rows.map((row) => row.rssBytes)),
    errors: Object.fromEntries([...new Set(rows.filter((row) => row.error).map((row) => row.error))].map((code) => [code, rows.filter((row) => row.error === code).length])),
  };
};

async function main() {
  const [manifestPath, modelPath, outputPath, timeoutArgument = "5000", repeatsArgument = "2", mode = "auto", corpusArgument] = process.argv.slice(2);
  if (!manifestPath || !modelPath || !outputPath) throw new Error("Usage: benchmark-decision-models.mjs MANIFEST MODEL OUTPUT [TIMEOUT_MS] [REPEATS] [auto|direct|fresh|direct-fresh] [CORPUS]");
  const timeoutMs = Number(timeoutArgument);
  const repeats = Number(repeatsArgument);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000 || !Number.isInteger(repeats) || repeats < 1 || repeats > 5) throw new Error("Invalid benchmark budget");
  if (!["auto", "direct", "fresh", "direct-fresh"].includes(mode)) throw new Error("Invalid Qwen benchmark mode");
  const document = JSON.parse(await readFile(manifestPath, "utf8"));
  const manifest = document.model && typeof document.model === "object" ? document.model : document;
  if (basename(resolve(modelPath)) !== manifest.fileName) throw new Error("Model filename does not match manifest");
  const corpusPath = resolve(root, corpusArgument ?? "apps/desktop/test/fixtures/semantic-evaluation.json");
  const corpus = await readFile(corpusPath, "utf8");
  const samples = JSON.parse(corpus);
  const server = await createServer({ root, configFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true }, resolve: { alias: { "@cognelis/decision-protocol": resolve(root, "packages/protocol/src/index.ts"), "@cognelis/decision-core": resolve(root, "packages/core/src/index.ts") } } });
  const rules = await createRulePredictor();
  let provider;
  const rows = [];
  let verificationMs;
  let coldFirstCallMs;
  const save = async () => {
    const pure = rows.map((row) => ({ ...row, prediction: row.modelPrediction }));
    const categories = [...new Set(rows.map((row) => row.category))];
    const report = {
      version: 1, model: manifest, date: new Date().toISOString(), hardware: { cpu: cpus()[0]?.model, memoryBytes: totalmem(), platform: process.platform, arch: process.arch },
      runtime: "node-llama-cpp@3.19.1", thinkingMode: mode, corpusSha256: createHash("sha256").update(corpus).digest("hex"), samples: samples.length, repeats, timeoutMs, contextTokens: 4096, maxOutputTokens: 512, temperature: 0,
      verificationMs, coldFirstCallMs, completed: rows.length === samples.length * repeats,
      hybrid: summarizeRows(rows), modelOnly: summarizeRows(pure),
      categories: Object.fromEntries(categories.map((category) => [category, { hybrid: summarizeRows(rows.filter((row) => row.category === category)), modelOnly: summarizeRows(pure.filter((row) => row.category === category)) }])), rows,
    };
    await writeFile(`${outputPath}.partial`, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    await rename(`${outputPath}.partial`, outputPath);
  };
  try {
    await evaluateSemanticCorpus({ samples, predictor: rules.predict });
    const { QwenModelProvider } = await server.ssrLoadModule(resolve(root, "apps/desktop/src/main/semantic/qwen-provider.ts"));
    const { verifyQwenModel } = await server.ssrLoadModule(resolve(root, "apps/desktop/src/main/semantic/model-manifest.ts"));
    const core = await server.ssrLoadModule(resolve(root, "packages/core/src/index.ts"));
    const start = performance.now();
    const verification = await verifyQwenModel({ modelsDirectory: dirname(resolve(modelPath)), manifest });
    verificationMs = Math.round(performance.now() - start);
    if (verification.availability !== "available") throw new Error(`Model verification failed: ${verification.availability}`);
    provider = new QwenModelProvider({ modelsDirectory: dirname(resolve(modelPath)), verifyModel: async () => verification, timeoutMs,
      ...(mode !== "auto" ? { loadRuntime: async () => {
        const runtime = await import("node-llama-cpp");
        return { ...runtime, LlamaChatSession: class extends runtime.LlamaChatSession {
          constructor(options) { super({ ...options, ...(mode.includes("direct") ? { chatWrapper: new runtime.QwenChatWrapper({ variation: "3.5", thoughts: "discourage" }) } : {}) }); }
          async prompt(input, options) {
            if (mode.includes("fresh")) await this.sequence.clearHistory();
            return super.prompt(input, options);
          }
        } };
      } } : {}),
    });
    // Cold load is measured separately; every scored call uses the same warmed runtime.
    const cold = performance.now();
    try { await provider.invoke({ pairId: "warmup", assistantText: "请选择 A 或 B？", userText: "A", locale: "zh-CN" }); } catch (error) { console.log(`Warmup: ${error.code ?? error.name}`); }
    coldFirstCallMs = Math.round(performance.now() - cold);
    for (let round = 0; round < repeats; round++) {
      // Reverse the second pass to reveal order effects without changing prompts.
      for (const sample of round % 2 ? [...samples].reverse() : samples) {
        const rule = await rules.predict(sample);
        const started = performance.now();
        let attempt, classification, errorCode;
        try {
          attempt = await provider.invoke({ pairId: sample.id, assistantText: sample.assistantText, userText: sample.userText, locale: sample.locale });
          classification = core.validateSemanticClassification({ assistantText: sample.assistantText, userText: sample.userText }, attempt.classification);
        } catch (error) { errorCode = error.code ?? error.name; }
        const elapsed = Math.round(performance.now() - started);
        const modelPrediction = classification ? { band: classification.band, relation: classification.answerRelation, question: classification.question, answerExcerpt: classification.answerExcerpt } : { band: "low", relation: "uncertain", question: null, answerExcerpt: null };
        const route = core.routeSemanticDecision({ ruleBand: rule.band, modelBand: classification?.band ?? "unavailable", answerRelation: classification?.answerRelation ?? null, ruleSignals: rule.signals ?? [], ...(classification ? { modelIntent: classification.decisionIntent } : {}) });
        const prediction = classification ? { ...modelPrediction, band: route.finalBand } : rule;
        rows.push({ id: sample.id, round: round + 1, category: sample.category, locale: sample.locale, expectedBand: sample.expectedBand, expectedRelation: sample.expectedRelation, rule, modelPrediction, prediction, classification: attempt?.classification ?? null, error: errorCode ?? null, inferenceMs: attempt?.providerDurationMs ?? elapsed, wallMs: elapsed, rssBytes: process.memoryUsage().rss, usage: attempt?.usage ?? null });
        await save();
        console.log(`${manifest.id} ${rows.length}/${samples.length * repeats} ${sample.id} ${errorCode ?? modelPrediction.band} ${elapsed}ms`);
      }
    }
    const report = await evaluateSemanticCorpus({ samples, predictor: async (sample) => rows.find((row) => row.id === sample.id).prediction });
    console.log(JSON.stringify({ model: manifest.id, hybrid: summarizeRows(rows), modelOnly: summarizeRows(rows.map((row) => ({ ...row, prediction: row.modelPrediction }))), existingEvaluator: report.summary }));
  } finally {
    await provider?.close();
    await rules.close();
    await server.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
