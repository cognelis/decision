#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const values = (key) => args.flatMap((arg, i) => arg === key ? [args[i + 1]] : arg.startsWith(`${key}=`) ? [arg.slice(key.length + 1)] : []);
const flag = (key) => args.includes(key);

async function loadAnalyzer(rev) {
  const read = (file) => rev === "worktree"
    ? readFile(resolve(root, file), "utf8")
    : new Promise((done, fail) => { try { done(execFileSync("git", ["show", `${rev}:${file}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); } catch (error) { fail(error); } });
  const dir = await mkdtemp(resolve(tmpdir(), "decision-rules-"));
  try {
    // The analyzer imports its sibling modules (recommendation.ts since R16); a revision without them has none to copy.
    await writeFile(resolve(dir, "text-decision-analyzer.ts"), await read("packages/core/src/text-decision-analyzer.ts"));
    await writeFile(resolve(dir, "recommendation.ts"), await read("packages/core/src/recommendation.ts").catch(() => ""));
    const { outputFiles } = await build({ entryPoints: [resolve(dir, "text-decision-analyzer.ts")], bundle: true, write: false, format: "esm", target: "es2022", platform: "node", logLevel: "silent" });
    const mod = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);
    return { Analyzer: mod.TextDecisionAnalyzer, selectedOptions: mod.selectedOptions, ruleReading: mod.ruleReading ?? ((x) => x) };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

function classify(mod, sample, withSourceUser = false) {
  const analyzer = new mod.Analyzer();
  const pending = analyzer.analyze({ userText: withSourceUser ? sample.sourceUserText ?? null : null, assistantText: sample.assistantText });
  const result = pending && mod.ruleReading(analyzer.complete(pending, sample.userText));
  return {
    band: result?.band ?? "none", score: result?.score ?? 0,
    signals: result?.signals ?? [], optionCount: pending?.options.length ?? 0,
    question: pending?.question ?? null, options: pending?.options ?? [],
    selected: result?.selected?.map(({ id }) => id) ?? [],
    selectedOptions: pending && typeof mod.selectedOptions === "function"
      ? mod.selectedOptions(sample.userText, pending.options).map(({ id }) => id) : null,
  };
}

function summarize(rows) {
  const groups = {};
  for (const row of rows.filter((x) => typeof x.decision === "boolean" && x.expectedBand !== "any")) {
    const g = groups[row.group] ??= { TP: 0, FN: 0, FP: 0, TN: 0, high: 0, selectedMatch: 0, selectedScored: 0 };
    const hit = row.band === "high" || row.band === "medium";
    g[hit ? row.decision ? "TP" : "FP" : row.decision ? "FN" : "TN"]++;
    if (row.band === "high") g.high++;
    if (row.expectedSelected !== undefined) { g.selectedScored++; if (JSON.stringify([...(row.selectedOptions ?? [])].sort()) === JSON.stringify([...row.expectedSelected].sort())) g.selectedMatch++; }
  }
  return groups;
}

async function main() {
  if (flag("--self-test")) {
    const cases = [
      { id: "yes", group: "self", decision: true, assistantText: "1. A: local\n2. B: cloud\n\nWhich do you choose?", userText: "1", expectedSelected: ["1"] },
      { id: "no", group: "self", decision: false, assistantText: "Which version is deployed?", userText: "Version 2" },
    ];
    const mod = await loadAnalyzer("worktree");
    const rows = cases.map((x) => ({ id: x.id, ...classify(mod, x) }));
    if (rows.length !== 2 || !rows[0].band || !Array.isArray(rows[0].signals) || !("selectedOptions" in rows[0])) throw Error("self-test structure assertion failed");
    const framed = { assistantText: "我建议 YAML。你怎么看？", userText: "A", sourceUserText: "配置用 A（YAML）还是 B（TOML）？给出推荐" };
    if (classify(mod, framed, true).optionCount !== 2 || classify(mod, framed).optionCount !== 0) throw Error("self-test source-user assertion failed");
    console.log(JSON.stringify({ selfTest: "passed", rows })); return;
  }
  const casePath = values("--cases")[0];
  const revs = values("--rev");
  if (!casePath || !revs.length) throw Error("usage: rules-compare.mjs --cases FILE --rev SHA [--rev worktree] [--out FILE] [--with-source-user] | --self-test");
  const cases = JSON.parse(await readFile(resolve(casePath), "utf8"));
  const results = {};
  for (const rev of revs) {
    const mod = await loadAnalyzer(rev);
    const rows = cases.map((sample) => ({ id: sample.id, group: sample.group ?? "ungrouped", decision: sample.decision, expectedBand: sample.expectedBand, expectedSelected: sample.expectedSelected, rev, ...classify(mod, sample, flag("--with-source-user")) }));
    results[rev] = { summary: summarize(rows), rows };
  }
  const bandChanges = [];
  for (let i = 0; i < revs.length; i++) for (let j = i + 1; j < revs.length; j++) {
    const a = results[revs[i]].rows, b = results[revs[j]].rows;
    for (let k = 0; k < a.length; k++) if (a[k].band !== b[k].band) bandChanges.push({ id: a[k].id, from: revs[i], fromBand: a[k].band, to: revs[j], toBand: b[k].band });
  }
  const output = { cases: cases.length, results, bandChanges };
  const out = values("--out")[0];
  if (out) await writeFile(resolve(out), `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output, null, 2));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
