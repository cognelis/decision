#!/usr/bin/env node
// Scores capture-run.mjs output against the scenario labels: per pair, was a decision recognised (high or medium),
// at which band, and did the extracted answer name the chosen option. Prints JSON (rows + per-model totals).
//
//   node scripts/lab/capture-score.mjs runs.jsonl [--scenarios F]
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const args = process.argv.slice(2);
const runsPath = resolve(args[0] ?? "");
const scenariosPath = args.includes("--scenarios") ? resolve(args[args.indexOf("--scenarios") + 1]) : join(here, "capture-scenarios.json");
const scenarios = new Map(JSON.parse(readFileSync(scenariosPath, "utf8")).scenarios.map((scenario) => [scenario.id, scenario]));
const runs = readFileSync(runsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

// The first prompt of a session has nothing pending, so its user_prompt_unpaired is not a pair outcome.
const pairOutcomes = (receipts) => {
  const outcomes = [];
  let skippedFirstUnpaired = false;
  for (const receipt of receipts) {
    if (receipt.stage === "user_prompt_unpaired" && !skippedFirstUnpaired) {
      skippedFirstUnpaired = true;
    } else if (["routed", "failed", "user_prompt_unpaired", "pending_expired"].includes(receipt.stage)) {
      outcomes.push(receipt);
    }
  }
  return outcomes;
};

const classifications = (receipts) => receipts.filter((receipt) => receipt.stage === "classification_completed");

// Events carry the session id; the i-th recognised pair of a run owns the i-th event of its session. Files left
// behind by earlier runs are ignored because their session id differs.
const sessionEvents = (run) =>
  run.files
    // high goes to capture-spool/events, medium to candidate-spool/items (event nested inside)
    .map((file) => (file.path.includes("capture-spool/events/") ? file.content : file.path.includes("candidate-spool/items/") ? file.content?.event : undefined))
    .filter((event) => event?.sessionId === run.sessionId)
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));

const answerText = (event) => (event?.questions ?? []).flatMap((question) => question.answer?.values ?? []).join(" | ");

/** true/false when the label can be checked mechanically, null when it needs a human reading. */
const choiceCorrect = (choice, event, assistantText = "") => {
  if (event === undefined) return false;
  const answer = answerText(event);
  const options = (event.questions ?? []).flatMap((question) => question.options ?? []);
  if (/^[A-Za-z]$/.test(choice) || /^\d$/.test(choice)) {
    const pattern = new RegExp(`(^|[^A-Za-z0-9])${choice}([^A-Za-z0-9]|$)`, "i");
    if (pattern.test(answer)) return true;
    // The reply may name the option instead of its letter ("Let's go with Zustand" for B): look up its name.
    const named = assistantText.match(new RegExp(`(?:^|\\n)[\\s*\\-]*${choice}[.)、：:]\\s*\\**\\(?([^\\n*：:（()]{2,40})`, "i"))?.[1]?.trim();
    if (named !== undefined && answer.toLowerCase().includes(named.toLowerCase())) return true;
    return options.some((option) => pattern.test(option.label ?? "") && answer.includes(option.label));
  }
  if (choice.startsWith("partial:")) {
    const wanted = choice.slice(8).split(",");
    const mentioned = [...answer.matchAll(/\d/g)].map((match) => match[0]);
    return wanted.every((digit) => mentioned.includes(digit)) && mentioned.every((digit) => wanted.includes(digit));
  }
  return null;
};

const rows = [];
for (const run of runs) {
  const scenario = scenarios.get(run.scenario);
  if (scenario === undefined) continue;
  const outcomes = pairOutcomes(run.receipts);
  const classified = classifications(run.receipts);
  const events = sessionEvents(run);
  let nextEvent = 0;
  scenario.expectations.forEach((expectation, index) => {
    const outcome = outcomes[index];
    const classification = classified[index];
    const band = outcome?.finalBand ?? (outcome === undefined ? "none" : `none(${outcome.stage}${outcome.errorCode ? `:${outcome.errorCode}` : ""})`);
    const recognised = band === "high" || band === "medium";
    const event = recognised ? events[nextEvent++] : undefined;
    const label = expectation.decision ? (recognised ? "TP" : "FN") : recognised ? "FP" : "TN";
    rows.push({
      scenario: run.scenario,
      model: `${run.client}:${run.model}`,
      pair: index + 1,
      kind: expectation.kind ?? "negative",
      expected: expectation.decision ? `${expectation.minBand}+` : "none",
      band,
      ruleBand: classification?.ruleBand,
      modelBand: classification?.modelBand,
      label,
      bandBelowFloor: label === "TP" && expectation.minBand === "high" && band !== "high",
      choiceCorrect: label === "TP" ? choiceCorrect(expectation.choice, event, run.turns[index].assistantText) : undefined,
      extractedQuestion: event?.questions?.[0]?.question,
      extractedOptions: (event?.questions ?? []).flatMap((question) => (question.options ?? []).map((option) => option.label)),
      extractedAnswer: answerText(event),
      runErrors: run.errors,
    });
  });
}

const totals = {};
for (const row of rows) {
  const total = (totals[row.model] ??= { TP: 0, FN: 0, FP: 0, TN: 0, high: 0, medium: 0, low: 0, none: 0, belowFloor: 0, choiceCorrect: 0, choiceWrong: 0, choiceManual: 0 });
  total[row.label] += 1;
  total[row.band.startsWith("none") ? "none" : row.band] += 1;
  if (row.bandBelowFloor) total.belowFloor += 1;
  if (row.choiceCorrect === true) total.choiceCorrect += 1;
  else if (row.choiceCorrect === false) total.choiceWrong += 1;
  else if (row.choiceCorrect === null) total.choiceManual += 1;
}
console.log(JSON.stringify({ rows, totals }, null, 2));
