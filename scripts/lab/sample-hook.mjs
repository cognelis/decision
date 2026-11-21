#!/usr/bin/env node
// A stand-in hook for lab runs: saves the raw stdin a client sends one hook call, plus the hook-related environment, as
// one JSON file, and prints nothing (a Stop reply on stdout could make agy or grok continue). Always exits 0.
//
//   node scripts/lab/sample-hook.mjs <out dir> <label>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [outDir, label = "hook"] = process.argv.slice(2);
const SECRET = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i;
const HOOK_ENV = /^(GROK_|CLAUDE_PROJECT_DIR$|ANTIGRAVITY|GEMINI_|DECISION_)/;

const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  try {
    const raw = Buffer.concat(chunks).toString("utf8");
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      // keep raw only
    }
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => HOOK_ENV.test(name) && !SECRET.test(name)));
    mkdirSync(outDir, { recursive: true });
    const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}-${process.pid}.json`;
    writeFileSync(join(outDir, name), `${JSON.stringify({ label, receivedAt: new Date().toISOString(), argv: process.argv.slice(2), env, raw, json }, null, 2)}\n`);
  } catch {
    // a lab hook never blocks the client
  }
  process.exit(0);
});
