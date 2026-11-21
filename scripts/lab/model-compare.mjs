#!/usr/bin/env node
/**
 * Rules + model through the app's own SemanticDecisionCoordinator, offline.
 *
 *   node scripts/lab/model-compare.mjs --cases F [--cases F2 …] --user-data DIR [--model qwen3.5-4b-q4-k-m]
 *     [--timeout 5000] [--replay RAW.json] [--no-model] [--via-host] [--out OUT.json]
 *
 * Cases use the rules-compare format (`id`, `group`, `assistantText`, `userText`, `decision`, `expectedBand`).
 * `--user-data` must hold a `models` directory (link the local models read-only into an isolated root; never the
 * real Paraself data). `--replay` feeds the raw model classifications of an earlier run back instead of calling the
 * model, so a router or validation change can be measured on the same model outputs; a prompt change needs a live
 * run. `--no-model` routes with the model unavailable, which must equal the rules alone. `--via-host` calls the model as
 * the app does since IMP-135: through the local model host and its client, on the one Llama the embedding model is
 * loaded on too (every message cloned as the port clones it; the utility process itself needs Electron).
 *
 * Every row keeps the rule band, the model's raw output, and where the coordinator finally put it: `high` (written),
 * `medium` (pending), `low` (dropped).
 */
import { readFile, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const values = (key) => args.flatMap((arg, i) => arg === key ? [args[i + 1]] : arg.startsWith(`${key}=`) ? [arg.slice(key.length + 1)] : []);
const flag = (key) => args.includes(key);

async function load() {
  const { createServer } = await import("vite");
  const server = await createServer({ root, configFile: resolve(root, "vitest.config.ts"), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  const core = await server.ssrLoadModule(resolve(root, "packages/core/src/index.ts"));
  const coordinator = await server.ssrLoadModule(resolve(root, "apps/desktop/src/main/semantic/semantic-coordinator.ts"));
  const qwen = await server.ssrLoadModule(resolve(root, "apps/desktop/src/main/semantic/qwen-provider.ts"));
  const prompt = await server.ssrLoadModule(resolve(root, "apps/desktop/src/main/model/semantic-prompt.ts"));
  const host = await server.ssrLoadModule(resolve(root, "apps/desktop/src/main/semantic/local-model-host.ts"));
  const client = await server.ssrLoadModule(resolve(root, "apps/desktop/src/main/semantic/local-model-client.ts"));
  return { server, core, coordinator, qwen, prompt, host, client };
}

const emptyGroup = () => ({ pos: 0, posHigh: 0, posMedium: 0, FN: 0, neg: 0, negHigh: 0, negMedium: 0, negLow: 0 });

export function summarize(rows, band) {
  const groups = {};
  const add = (g, b, decision) => {
    if (decision) { g.pos++; if (b === "high") g.posHigh++; else if (b === "medium") g.posMedium++; else g.FN++; }
    else { g.neg++; if (b === "high") g.negHigh++; else if (b === "medium") g.negMedium++; else g.negLow++; }
  };
  for (const row of rows.filter((x) => typeof x.decision === "boolean")) {
    add(groups[row.group] ??= emptyGroup(), row[band], row.decision);
    add(groups["*total"] ??= emptyGroup(), row[band], row.decision);
  }
  return groups;
}

async function main() {
  const casePaths = values("--cases");
  const userData = values("--user-data")[0];
  const replayPath = values("--replay")[0];
  const noModel = flag("--no-model");
  if (!casePaths.length || (!noModel && !userData && !replayPath)) throw Error("usage: model-compare.mjs --cases FILE … (--user-data DIR | --replay RAW.json | --no-model) [--model ID] [--timeout MS] [--out FILE]");
  const cases = [];
  for (const path of casePaths) for (const sample of JSON.parse(await readFile(resolve(path), "utf8"))) cases.push({ ...sample, file: path.split("/").at(-1) });
  const key = (row) => `${row.file}\u0000${row.id}`;
  const replay = replayPath ? new Map(JSON.parse(await readFile(resolve(replayPath), "utf8")).rows.map((row) => [key(row), row])) : null;
  const { server, core, coordinator: { SemanticDecisionCoordinator }, qwen, prompt, host, client } = await load();
  const model = values("--model")[0] ?? "qwen3.5-4b-q4-k-m";
  const providerOptions = { modelsDirectory: resolve(userData ?? ".", "models"), model, timeoutMs: Number(values("--timeout")[0] ?? 5_000) };
  const viaHost = flag("--via-host") && !noModel && !replay;
  let local;
  if (viaHost) {
    const shared = host.createSharedRuntime(async () => await import("node-llama-cpp"));
    let deliver = () => undefined;
    const receive = host.serveLocalModels((reply) => setImmediate(() => deliver(structuredClone(reply))), { runtime: shared.load, disposeRuntime: shared.dispose });
    local = new client.LocalModelHost({
      spawn: () => ({
        postMessage: (message) => { const copy = structuredClone(message); setImmediate(() => receive(copy)); },
        onMessage: (listener) => { deliver = listener; },
        onExit: () => undefined,
        kill: () => undefined,
      }),
      log: () => undefined,
    });
    // The embedding model on the same Llama, as in the app.
    await new client.LocalEmbeddingClient(local, { modelsDirectory: providerOptions.modelsDirectory }).embed(["warm"]);
  }
  const provider = noModel || replay ? null : viaHost ? new client.LocalClassifierClient(local, providerOptions) : new qwen.QwenModelProvider(providerOptions);
  const analyzer = new core.TextDecisionAnalyzer();
  const rows = [];
  const started = Date.now();
  try {
    for (const [index, sample] of cases.entries()) {
      const row = { id: sample.id, file: sample.file, group: `${sample.file.replace(/\.json$/u, "")}:${sample.group ?? "ungrouped"}`, decision: sample.decision, expectedBand: sample.expectedBand };
      const pending = analyzer.analyze({ userText: null, assistantText: sample.assistantText });
      const rule = pending && (core.ruleReading ?? ((x) => x))(analyzer.complete(pending, sample.userText));
      row.ruleBand = rule?.band ?? "low";
      row.ruleSignals = rule?.signals ?? [];
      let finalBand = "low";
      const audit = [];
      const classifier = noModel ? undefined : {
        classify: async (input, signal) => {
          if (replay) {
            const before = replay.get(key(sample));
            if (before?.raw === undefined) throw Object.assign(new Error("no replayed output"), { code: "provider_unavailable" });
            row.raw = before.raw;
            return before.raw;
          }
          const t = performance.now();
          try {
            const attempt = await provider.invoke(input, signal);
            row.raw = attempt.classification;
            return attempt.classification;
          } catch (error) {
            row.modelError = error?.code ?? error?.name ?? "error";
            throw error;
          } finally { row.modelMs = Math.round(performance.now() - t); row.load1 = Number(loadavg()[0].toFixed(1)); }
        },
      };
      const runner = new SemanticDecisionCoordinator({
        runtime: {
          ingest: async (event) => { finalBand = "high"; row.signals = event.detection.signals; },
          ingestCandidate: async (candidate) => { finalBand = "medium"; row.signals = candidate.event.detection.signals; },
        },
        audit: { record: async (entry) => { audit.push(entry); } },
        classifier,
        timeoutMs: 60_000,
      });
      const capturedAt = new Date().toISOString();
      await runner.process({ version: 1, pairId: `lab-${index}`, sourceClient: "claude-code", sessionId: "lab-model-compare", cwd: root, assistantText: sample.assistantText, userText: sample.userText, capturedAt, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
      row.modelBand = audit.find((x) => x.stage === "classification_completed")?.modelBand ?? "unavailable";
      row.auditError = audit.find((x) => x.stage === "failed")?.errorCode;
      row.finalBand = finalBand;
      rows.push(row);
      if ((index + 1) % 25 === 0) process.stderr.write(`${index + 1}/${cases.length} ${Math.round((Date.now() - started) / 1000)}s\n`);
    }
  } finally {
    await provider?.close();
    await local?.shutdown();
    await server.close();
  }
  const output = {
    model: noModel ? "none" : replay ? `replay:${replayPath}` : model,
    viaHost,
    promptVersion: prompt.SEMANTIC_PROMPT_VERSION,
    cases: cases.length,
    elapsedMs: Date.now() - started,
    modelErrors: rows.filter((x) => x.auditError).length,
    rules: summarize(rows, "ruleBand"),
    final: summarize(rows, "finalBand"),
    rows,
  };
  const out = values("--out")[0];
  if (out) await writeFile(resolve(out), `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify({ ...output, rows: undefined, rules: output.rules["*total"], final: output.final["*total"] }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error); process.exitCode = 1; });
