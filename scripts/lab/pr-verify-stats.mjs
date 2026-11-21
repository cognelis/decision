#!/usr/bin/env node
// Read-only stats over PR replay outputs (`npm run replay:pr -- run`), for the judge and the lead:
// - of the confirmed (final) findings, how many premises stand on `functions` or `callerSearch`;
// - the waiting-for-context split: downgraded by the program (premises not found), not verified (call failed,
//   cancelled, out of reads), and judged so by the verifier itself;
// - the verify calls' input tokens.
// Usage: node scripts/lab/pr-verify-stats.mjs [--json] [FILE_OR_DIR ...]
//   default: $PARASELF_LAB_ROOT/pr-replay/runs-r7 (dirs are walked for *.json)
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

// Prefixes the service writes into `missing` (pr-review-service.ts, verify).
const DOWNGRADED = "确认所依据的前提没能在本次评审的材料里核对到";
const UNVERIFIED = "核验结论：这条候选没有经过核验";
const VERIFY_EVENT = /^核验候选问题/u;

const key = (f) => JSON.stringify([f.path, f.side, f.line, f.title]);
const within = (spans, p) => spans.some(([path, side, first, last]) => path === p.path && side === p.side && p.line >= first && p.line <= last);

/** The verify calls' traces: by promptVersion when the replay kept it; else (older replays kept none) the last as many traces as verify calls ended, verification running after every group. */
function verifyCalls(run) {
  if (run.traces.some((t) => t.promptVersion)) return { calls: run.traces.filter((t) => t.promptVersion?.startsWith("pr-review-verify")), source: "promptVersion" };
  const ended = run.progress.filter((e) => e.kind === "model" && e.status !== "running");
  const n = ended.filter((e) => VERIFY_EVENT.test(e.message)).length;
  const aligned = ended.length === run.traces.length && ended.slice(ended.length - n).every((e) => VERIFY_EVENT.test(e.message));
  return aligned ? { calls: run.traces.slice(run.traces.length - n), source: "aligned" } : { calls: null, source: "unaligned" };
}

/** Each final finding's last verdict (a later round replaces an earlier), and how many of its premises stand on the gathered material. */
function premiseStats(run) {
  const recorded = run.traces.filter((t) => t.verify);
  if (!recorded.length) return null;
  const last = new Map();
  for (const { verify } of recorded) for (const verdict of verify.verdicts) {
    const candidate = verify.candidates[verdict.id - 1];
    if (candidate) last.set(key(candidate), { verdict, verify });
  }
  // A line can be in both (the candidate's own file is searched too): citeAny counts each premise once.
  const out = { confirmed: 0, unmatched: 0, premises: 0, citeFunctions: 0, citeCallerSearch: 0, citeAny: 0, findingsCiting: 0 };
  for (const finding of run.report.findings) {
    const found = last.get(key(finding));
    if (found?.verdict.verdict !== "confirmed") { out.unmatched++; continue; }
    out.confirmed++;
    const { verify } = found, premises = found.verdict.premises ?? [];
    const hits = verify.callerSearch.flatMap((scope) => scope.symbols.flatMap((s) => s.hits));
    const searched = (p) => verify.callerSearch.some((scope) => scope.path === p.path && scope.symbols.some((s) => s.symbol === p.query));
    const onFunctions = (p) => p.kind === "source" && within(verify.functions, p);
    const onCallers = (p) => (p.kind === "source" && within(hits, p)) || (p.kind === "search" && searched(p));
    const any = premises.filter((p) => onFunctions(p) || onCallers(p)).length;
    out.premises += premises.length; out.citeFunctions += premises.filter(onFunctions).length; out.citeCallerSearch += premises.filter(onCallers).length; out.citeAny += any;
    if (any) out.findingsCiting++;
  }
  return out;
}

/** Per verify call, the candidates citing decisions and those of them sent without one they cite (the room ran out). */
function decisionStats(run) {
  const recorded = run.traces.filter((t) => t.verify?.decisions);
  if (!recorded.length) return null;
  const citing = recorded.flatMap(({ verify }) => verify.candidates.filter((c) => c.decisionIndexes?.length).map((c) => ({ c, given: new Set(verify.decisions) })));
  return { citing: citing.length, missing: citing.filter(({ c, given }) => c.decisionIndexes.some((index) => !given.has(index))).length };
}

export function runStats(run) {
  const needs = run.report.needsContext ?? [];
  const downgraded = needs.filter((n) => n.missing.startsWith(DOWNGRADED)).length;
  const unverified = needs.filter((n) => n.missing.startsWith(UNVERIFIED)).length;
  const { calls, source } = verifyCalls(run);
  const reported = calls?.filter((t) => t.usage && t.usage.source !== "unavailable") ?? [];
  return {
    caseId: run.caseId, status: run.report.status, model: run.model,
    candidates: run.candidates.length, findings: run.report.findings.length, rejected: (run.report.filtered ?? []).length,
    needsContext: needs.length, downgraded, unverified, selfJudged: needs.length - downgraded - unverified,
    verifyCalls: calls?.length ?? null, tokenSource: source, unreportedCalls: calls ? calls.length - reported.length : null,
    verifyInputTokens: calls ? reported.reduce((sum, t) => sum + (t.usage.inputTokens ?? 0), 0) : null,
    verifyCachedTokens: calls ? reported.reduce((sum, t) => sum + (t.usage.cachedInputTokens ?? 0), 0) : null,
    premises: premiseStats(run), verifyDecisions: decisionStats(run),
  };
}

async function files(path) {
  if (!(await stat(path)).isDirectory()) return [path];
  const entries = await readdir(path, { withFileTypes: true });
  return (await Promise.all(entries.map((e) => e.isDirectory() ? files(join(path, e.name)) : e.name.endsWith(".json") ? [join(path, e.name)] : []))).flat();
}

const SUMS = ["candidates", "findings", "rejected", "needsContext", "downgraded", "unverified", "selfJudged", "verifyCalls", "verifyInputTokens", "verifyCachedTokens"];
const PREMISE_SUMS = ["confirmed", "unmatched", "premises", "citeFunctions", "citeCallerSearch", "citeAny", "findingsCiting"];

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { json: { type: "boolean" } } });
  const lab = process.env.PARASELF_LAB_ROOT ?? join(tmpdir(), "decision-lab");
  const paths = positionals.length ? positionals : [join(lab, "pr-replay", "runs-r7")];
  const rows = [];
  for (const file of (await Promise.all(paths.map((p) => files(resolve(p))))).flat().sort()) {
    const run = JSON.parse(await readFile(file, "utf8"));
    if (!run.report || !Array.isArray(run.traces) || !Array.isArray(run.progress)) continue;
    // runs-r7/<case>/<version>-<n>.json; elsewhere the file name stands for the version.
    rows.push({ file, group: basename(file, ".json").replace(/-\d+$/u, ""), case: basename(dirname(file)), ...runStats(run) });
  }
  const groups = {};
  for (const row of rows) {
    const g = groups[row.group] ??= { runs: 0, ...Object.fromEntries(SUMS.map((k) => [k, 0])), tokensUnknown: 0, premises: Object.fromEntries(PREMISE_SUMS.map((k) => [k, 0])), premisesUnrecorded: 0 };
    g.runs++;
    for (const k of SUMS) g[k] += row[k] ?? 0;
    if (row.verifyCalls === null || row.unreportedCalls) g.tokensUnknown++;
    if (row.premises) for (const k of PREMISE_SUMS) g.premises[k] += row.premises[k]; else if (row.findings) g.premisesUnrecorded++;
  }
  for (const g of Object.values(groups)) g.inputTokensPerVerifyCall = g.verifyCalls ? Math.round(g.verifyInputTokens / g.verifyCalls) : null;
  if (values.json) { console.log(JSON.stringify({ rows, groups }, null, 2)); return; }
  const cols = ["case", "group", "status", "candidates", "findings", "rejected", "needsContext", "downgraded", "unverified", "selfJudged", "verifyCalls", "verifyInputTokens", "tokenSource"];
  const pcols = ["confirmed", "premises", "citeFunctions", "citeCallerSearch", "citeAny", "findingsCiting"];
  console.log([...cols, ...pcols.map((k) => `p.${k}`)].join("\t"));
  for (const row of rows) console.log([...cols.map((k) => row[k] ?? "-"), ...pcols.map((k) => row.premises ? row.premises[k] : "-")].join("\t"));
  console.log("\n# 按版本合计（tokensUnknown：核验 token 对不上或有调用没报用量的回放数；premisesUnrecorded：有最终问题但回放没记下核验判定的回放数）");
  console.log(JSON.stringify(groups, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
