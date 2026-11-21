#!/usr/bin/env node
// Read-only score of the decision dimension of PR replays (`replay:pr -- run --decisions`): per labelled decision,
// whether the reviewer saw it (report.evidence), a candidate cited it, a final finding cited it, and whether that is
// what the label wants (report: a final finding cites it; silent: none does). Citations go by decisionIndexes. A label's
// `allowWith` names decisions a finding may cite it beside (a superseded one, said to be replaced by its successor):
// such a finding does not rest on it.
// Usage: node scripts/lab/pr-decision-score.mjs [--json] --labels LABELS.json RUN.json [RUN.json ...]
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const citing = (findings, index) => findings.filter((f) => f.decisionIndexes?.includes(index)).length;

export function scoreDecisions(run, labels) {
  const indexOf = new Map(run.report.evidence.map((item) => [item.record.id, item.index]));
  const labelled = new Set(labels.decisions.map((d) => d.id));
  const rows = labels.decisions.map((decision) => {
    const index = indexOf.get(decision.id);
    const row = { id: decision.id, kind: decision.kind, expect: decision.expect, seen: index !== undefined,
      candidates: index === undefined ? 0 : citing(run.candidates, index),
      final: index === undefined ? 0 : citing(run.report.findings.filter((f) => !(decision.allowWith ?? []).some((id) => indexOf.has(id) && f.decisionIndexes?.includes(indexOf.get(id)))), index),
      needsContext: index === undefined ? 0 : citing((run.report.needsContext ?? []).map((n) => n.finding), index),
      rejected: index === undefined ? 0 : citing((run.report.filtered ?? []).map((n) => n.finding), index) };
    return { ...row, pass: decision.expect === "report" ? row.final > 0 : row.final === 0 };
  });
  // Final findings resting on a decision the labels do not name: neither right nor wrong here, for the judge.
  const unlabelled = run.report.findings.flatMap((f) => (f.decisionIndexes ?? []).map((index) => run.report.evidence.find((e) => e.index === index)?.record.id)
    .filter((id) => id && !labelled.has(id)));
  return { rows, unlabelled, report: rows.filter((r) => r.expect === "report").map((r) => r.pass), silent: rows.filter((r) => r.expect === "silent").map((r) => r.pass) };
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { json: { type: "boolean" }, labels: { type: "string" } } });
  if (!values.labels || !positionals.length) throw new Error("--labels LABELS.json RUN.json [RUN.json ...]");
  const labels = JSON.parse(await readFile(values.labels, "utf8"));
  const results = [];
  for (const file of positionals) results.push({ file: resolve(file), ...scoreDecisions(JSON.parse(await readFile(file, "utf8")), labels) });
  if (values.json) { console.log(JSON.stringify(results, null, 2)); return; }
  for (const { file, rows, unlabelled, report, silent } of results) {
    console.log(`# ${file}\n应报 ${report.filter(Boolean).length}/${report.length}，不应报 ${silent.filter(Boolean).length}/${silent.length}${unlabelled.length ? `；引用了标签外的决策：${unlabelled.join("、")}` : ""}`);
    console.log(["id", "kind", "expect", "seen", "candidates", "final", "needsContext", "rejected", "pass"].join("\t"));
    for (const r of rows) console.log([r.id, r.kind, r.expect, r.seen, r.candidates, r.final, r.needsContext, r.rejected, r.pass].join("\t"));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
