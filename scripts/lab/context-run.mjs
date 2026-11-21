import { mkdir, readFile, writeFile, appendFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { tmpdir } from 'node:os';
import { startIsolatedApp, connectMcp, ISOLATION_KEYS, CODEX_TOOLS_OFF, defaultBridge, writeCodexCatalog } from './isolated-app.mjs';
import { ALLOWLIST, CONSULT, GUARD_FAULT, LEAK, SEARCH, checkResult, guardCommand, normalizedLanguageIds } from './mcp-guard.mjs';

// Agent steps: a real claude or codex session asks the isolated App through scripts/lab/mcp-guard.mjs and answers in
// one line. The prompt is fixed here and logged word for word with every run.
export const AGENT_PROMPT = [
  '请先用 search_decision_context 工具查询历史决策（project 参数填 "lab"），可以换说法多查几次。',
  '只依据工具返回的记录回答；不要读写文件，也不要运行命令。',
  '回答的最后一行只写「答案：<答案>」：这一行只写现在有效的答案本身，不写历史值，不加括号注释。',
  '',
  '问题：',
].join('\n');
// No hint to tell old from new or to search again (R16B): what is measured is the agent's own reading of the results.
// One value on the answer line keeps the score readable without saying which one is wanted.
export const AGENT_PROMPTS = {
  default: AGENT_PROMPT,
  neutral: [
    '请用 search_decision_context 工具查询历史决策（project 参数填 "lab"）后回答。',
    '只依据工具返回的记录回答；不要读写文件，也不要运行命令。',
    '回答的最后一行只写「答案：<一个值>」。',
    '',
    '问题：',
  ].join('\n'),
  // R18: consult alone, the tool an agent asks before it presents a choice.
  consult: [
    '请先用 consult_decision_principles 工具核对（project 参数填 "lab"），再回答。',
    '只依据工具返回的内容回答；不要读写文件，也不要运行命令。',
    '回答的最后一行只写「答案：<一个选项>」。',
    '',
    '问题：',
  ].join('\n'),
};
/** The one paraself tool each prompt style opens to the client under test; search where none is named. */
export const PROMPT_TOOLS = { consult: CONSULT };
const AGENT_TIMEOUT_MS = 180_000;
// What a client needs to start and sign in, as the App's own model calls pass (minimalClientEnvironment), and nothing
// else: a credential under a name no pattern foresees stays behind as well.
const CLIENT_ENV = ['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', '__CF_USER_TEXT_ENCODING',
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'VOLTA_HOME', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'];
const SECRET_ENV = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i;
/** The client under test: the names above, the isolation paths, and the user's own Paraself hooks told to return. */
export const testedEnvironment = env => {
  const kept = Object.fromEntries([...CLIENT_ENV, ...ISOLATION_KEYS].filter(name => env[name] !== undefined).map(name => [name, env[name]]));
  const left = Object.keys(kept).filter(name => SECRET_ENV.test(name));
  if (left.length) throw new Error(`Secret variables left for the client under test: ${left.join(', ')}`);
  return { ...kept, PARASELF_PROVIDER_CHILD: '1', DECISION_PROVIDER_CHILD: '1' };
};
/** Claude's MCP config: paraself alone, through the guard, every isolation path, and the off-markers turned back. */
export const claudeMcpConfig = (guard, env) => ({ mcpServers: { paraself: { type: 'stdio', command: guard.command, args: guard.args,
  env: { ...Object.fromEntries(ISOLATION_KEYS.map(name => [name, env[name]])), PARASELF_PROVIDER_CHILD: '0', DECISION_PROVIDER_CHILD: '0' } } } });
/**
 * Neither client keeps a way to read a file or run anything: Claude has ToolSearch alone among its own tools (paraself
 * is loaded through it), Codex has every reading and running feature off and no user config, paraself kept.
 */
export const agentCommand = ({ client, model, question, cwd, guard, mcpConfig, settingSources, codexCatalog, prompt = AGENT_PROMPT, tool = SEARCH }) => client === 'claude'
  ? { command: 'claude', args: ['-p', prompt + question, '--model', model, '--tools', 'ToolSearch', '--strict-mcp-config', '--mcp-config', mcpConfig,
    '--allowedTools', `mcp__paraself__${tool}`, '--output-format', 'stream-json', '--verbose',
    ...(settingSources === undefined ? [] : ['--setting-sources', settingSources])] }
  : { command: 'codex', args: ['exec', '--ignore-user-config', '--ephemeral', '--json', '--skip-git-repo-check', '-s', 'read-only', '-m', model,
    ...[...CODEX_TOOLS_OFF, 'features.hooks=false', ...(codexCatalog === undefined ? [] : [`model_catalog_json=${JSON.stringify(codexCatalog)}`])].flatMap(setting => ['-c', setting]),
    '-c', 'mcp_servers.paraself.enabled=true',
    '-c', `mcp_servers.paraself.command=${JSON.stringify(guard.command)}`, '-c', `mcp_servers.paraself.args=${JSON.stringify(guard.args)}`,
    '-c', `mcp_servers.paraself.env_vars=${JSON.stringify(ISOLATION_KEYS)}`, '-C', cwd, prompt + question] };

const jsonLines = stdout => stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const contentText = content => typeof content === 'string' ? content : (content ?? []).map(part => part.text ?? '').join('\n');
/** Record ids in one tool result, or null when it holds no context to read them from. */
export const resultIds = value => {
  if (typeof value === 'string') { try { return resultIds(JSON.parse(value)); } catch { return null; } }
  const consultation = value?.consultation;
  const results = value?.context?.results ?? (consultation ? [...consultation.matches ?? [], ...consultation.signals ?? []] : undefined);
  return Array.isArray(results) ? results.map(item => item.id ?? item.principleId ?? item.recordId) : null;
};
/**
 * Tool calls and the final text of a claude stream-json or codex --json run. Each call keeps what its client was
 * shown (`visible`, as a JSON-RPC message): Claude Code's tool result is the structuredContent as JSON, or plain text.
 */
export const parseAgentRun = (client, stdout) => {
  const events = jsonLines(stdout);
  const calls = [];
  let text = '';
  if (client === 'claude') {
    const byId = new Map();
    for (const event of events) {
      for (const part of event.message?.content ?? []) {
        if (event.type === 'assistant' && part.type === 'tool_use') { const call = { name: part.name, args: part.input, ids: null, error: false, visible: null }; byId.set(part.id, call); calls.push(call); }
        if (event.type === 'user' && part.type === 'tool_result' && byId.has(part.tool_use_id)) {
          const call = byId.get(part.tool_use_id);
          const shown = contentText(part.content);
          let structured;
          try { structured = JSON.parse(shown); } catch { structured = undefined; }
          call.error = part.is_error === true;
          call.ids = resultIds(structured);
          call.visible = { result: { isError: call.error, ...(structured && typeof structured === 'object' ? { structuredContent: structured } : { content: [{ type: 'text', text: shown }] }) } };
          call.textShown = !(structured && typeof structured === 'object');
        }
      }
      if (event.type === 'result') text = event.result ?? '';
    }
  } else {
    for (const event of events) {
      const item = event.item;
      if (!item) continue;
      // A command, a file change, a web search: none is left to the client, so any one counts the moment it starts.
      if (!['mcp_tool_call', 'agent_message', 'reasoning', 'error'].includes(item.type) && ['item.started', 'item.completed'].includes(event.type)) {
        calls.push({ name: `codex.${item.type}`, args: item, ids: null, error: false, visible: { result: { isError: false } } });
      }
      if (event.type !== 'item.completed') continue;
      if (item.type === 'mcp_tool_call') calls.push({ name: `${item.server}.${item.tool}`, args: item.arguments, error: item.status !== 'completed' || !!item.error || item.result?.is_error === true,
        ids: resultIds(item.result?.structured_content) ?? resultIds(contentText(item.result?.content)), textShown: true,
        // A call that failed is logged with structured_content: null where the result had none (R18, the guard's own notice):
        // read as none, exactly null alone; any other shape goes to the canary as it came.
        visible: item.result ? { result: { isError: item.status !== 'completed' || item.result.is_error === true,
          ...(item.result.structured_content === null ? {} : { structuredContent: item.result.structured_content }), content: item.result.content } }
          : { error: item.error ?? { message: 'no result' } } });
      if (item.type === 'agent_message') text = item.text ?? '';
    }
  }
  const answers = text.split('\n').map(line => line.match(/答案\s*[:：]\s*(.*)$/)?.[1]).filter(value => value !== undefined);
  return { calls, text, answer: answers.at(-1)?.trim() ?? null };
};
/** current: every new value and no old one; stale: any old value; other: neither (no answer line counts here). Case is
 * not compared: "valkey" is Valkey. */
export const scoreAnswer = (answer, { mustInclude = [], mustExclude = [] } = {}) => {
  if (answer === null) return 'other';
  const has = value => answer.toLowerCase().includes(value.toLowerCase());
  return mustExclude.some(has) ? 'stale' : mustInclude.every(has) ? 'current' : 'other';
};
const PARASELF_CALL = /^(mcp__paraself__|paraself\.)/;
export const isParaselfCall = call => PARASELF_CALL.test(call.name);
// Codex's own resource tools reach only MCP servers, and the guard refuses paraself's resources/* outright.
const HARMLESS = new Set(['ToolSearch', 'codex.list_mcp_resources', 'codex.list_mcp_resource_templates', 'codex.read_mcp_resource']);
/**
 * The second line behind the guard, on what the client says it was shown: every paraself result held to the seeded
 * catalog the way the guard holds it, an error passing only as a short notice without records. Any other tool that
 * ran is one too (none is left to either client); a call still waiting for its result is checked once it has one.
 */
export const canary = (calls, allow) => {
  const violations = calls.flatMap(call => {
    if (call.visible === null || HARMLESS.has(call.name)) return [];
    // Another tool asked for and refused (Claude Code has none to give) left nothing behind; one that ran did.
    if (!isParaselfCall(call)) return call.visible.result?.isError === true && JSON.stringify(call.visible).length <= 800 ? [] : [`tool ${call.name}`];
    const reason = checkResult(call.visible, allow, { text: call.textShown, args: call.args, tool: call.name.replace(PARASELF_CALL, '') });
    return reason ? [reason] : [];
  });
  const known = new Set(allow.map(item => item.id));
  const foreign = [...new Set(calls.filter(isParaselfCall).flatMap(call => call.ids ?? []).filter(id => !known.has(id)))];
  return { foreign, violations, ok: foreign.length === 0 && violations.length === 0 };
};
/** The decision a seed call made: record_decision_journal_entry alone creates one (or, a duplicate, names the one there). */
export const createdRecordId = (tool, response) => {
  const record = response?.result?.structuredContent?.record;
  return tool === 'record_decision_journal_entry' && record?.recordKind === 'decision' && typeof record.recordId === 'string' ? record.recordId : null;
};
/** A preference or idea note: never in search's catalog, read by consult alone. */
export const isJournalSeed = path => /^Decision Journal\/(preferences|ideas)\//u.test(path);
const journalSection = (note, name) =>
  note.match(new RegExp(`<!-- decision:journal-${name}-start -->\\n([\\s\\S]*?)\\n?<!-- decision:journal-${name}-end -->`, 'u'))?.[1]?.trim() || null;
/**
 * A preference or idea note (packages/storage/src/journal-entry.ts writes it) as the guard holds it: the fields consult
 * shows and works out its signal from, and its languages as the App keeps them. Plain text only: the seeds are checked to read
 * back the same through parseJournalEntry (context-run.test.mjs), and a note this cannot read fails closed.
 */
export const journalSnapshot = note => {
  const frontmatter = note.split('\n---\n')[0];
  const property = name => frontmatter.match(new RegExp(`^${name}: (.*)$`, 'mu'))?.[1];
  // A list property as the serializer writes it, one `  - value` line each (a value YAML had to quote, as JSON).
  const list = name => (frontmatter.match(new RegExp(`^${name}:\\n((?:  - .*\\n?)*)`, 'mu'))?.[1] ?? '').split('\n').filter(Boolean)
    .map(line => line.slice(4)).map(value => (value.startsWith('"') ? JSON.parse(value) : value));
  const history = JSON.parse(note.match(/\n```decision-journal-history\n([\s\S]*?)\n```/u)?.[1] ?? 'null');
  const kind = property('record_kind');
  if (!['preference', 'idea'].includes(kind) || !Array.isArray(history)) throw new Error('Not a preference or idea note');
  return { kind, id: property('id'), title: note.match(/^# (.+)$/mu)?.[1] ?? null, content: journalSection(note, 'content'), knowledgeStatus: property('knowledge_status'),
    appliesWhen: journalSection(note, 'applies'), exceptions: journalSection(note, 'exceptions'), whyInteresting: journalSection(note, 'interest'),
    openQuestions: (journalSection(note, 'questions') ?? '').split('\n').map(line => line.trim().replace(/^-\s*/u, '')).filter(Boolean),
    languages: normalizedLanguageIds(list('languages')) };
};
/** The App must list exactly what was seeded: the seed files' ids and the decisions seed calls made, nothing else. */
export const checkSeedCatalog = (listed, files, created) => {
  const seeded = [...new Set([...files.map(file => file.content.match(/^id: "?([^"\n]+)"?$/m)?.[1]), ...created])];
  if (new Set(listed).size !== listed.length || seeded.length !== listed.length || !seeded.every(id => listed.includes(id))) {
    throw new Error(`The App's catalog is not the seeds: listed ${listed.join(', ')}; seeded ${seeded.join(', ')}`);
  }
};
export const agentCounts = rows => {
  const tally = key => rows.reduce((counts, row) => {
    const bucket = counts[row[key]] ??= { current: 0, stale: 0, other: 0, timeout: 0 };
    bucket[row.verdict] += 1;
    return counts;
  }, {});
  return { byAgent: tally('agent'), byMechanism: tally('mechanism'), byAgentMechanism: tally('agentMechanism') };
};
/** Unmanaged clients can ignore proxy variables, so required policy blocks them before spawn. */
export const runAgent = async () => {
  throw new Error('ModelNetworkPolicy required: unmanaged lab model processes are blocked; use an HTTP provider');
};

const LAB = process.env.PARASELF_LAB_ROOT ?? join(tmpdir(), 'decision-lab');
export const at = (value, path) => path.split('.').reduce((part, key) => part?.[key], value);
export const expand = (value, history) => {
  if (Array.isArray(value)) return value.map(item => expand(item, history));
  if (value && typeof value === 'object') {
    if (Object.keys(value).length === 1 && typeof value.$ref === 'string') {
      const found = at(history, value.$ref);
      if (found === undefined) throw new Error(`Unresolved reference: ${value.$ref}`);
      return found;
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item, history)]));
  }
  return value;
};
export const vaultFile = (vault, path) => {
  const target = resolve(vault, path);
  if (!relative(vault, target).startsWith('Decision Journal/')) throw new Error(`Invalid seed path: ${path}`);
  return target;
};
const SEMANTIC_LATE = '本机嵌入未在时限内完成';
const exitOf = app => ({ pid: app.child.pid, exitCode: app.child.exitCode, signalCode: app.child.signalCode, stderrTail: app.stderr().slice(-1_500) });
const bodyOf = response => response.result?.structuredContent ?? response.result ?? response;
export const score = (response, expect = {}) => {
  const body = bodyOf(response);
  const data = body.context ?? body.consultation ?? body;
  const records = data.results ?? data.matches ?? [];
  // A consultation's preferences and ideas: asserted on their own, never counted into a principle's recall.
  const signals = data.signals ?? [];
  const signalIds = signals.map(item => item.recordId);
  const ids = records.map(item => item.id ?? item.principleId ?? item.recordId);
  const k = expect.k ?? 8;
  const relevant = expect.mustInclude ?? [];
  const ranks = relevant.map(id => ids.indexOf(id) + 1).filter(rank => rank > 0 && rank <= k);
  const checks = [];
  // A field not there is null, as it is logged: `equals: { path: null }` asserts it absent.
  const check = (label, actual, wanted) => checks.push({ label, actual: actual ?? null, expected: wanted, pass: JSON.stringify(actual ?? null) === JSON.stringify(wanted) });
  for (const id of relevant) check(`include@${k}:${id}`, ids.slice(0, k).includes(id), true);
  const leaks = (expect.mustExclude ?? []).filter(id => ids.includes(id));
  for (const id of expect.mustExclude ?? []) check(`exclude:${id}`, ids.includes(id), false);
  for (const id of expect.mustSignal ?? []) check(`signal:${id}`, signalIds.includes(id), true);
  for (const id of expect.mustNotSignal ?? []) check(`noSignal:${id}`, signalIds.includes(id), false);
  for (const flag of expect.mustFlag ?? []) {
    const value = at(ids.includes(flag.id) ? records[ids.indexOf(flag.id)] : signals[signalIds.indexOf(flag.id)], flag.path);
    // `includes`: whether a stretch of text is in it (a standing, a qualifier), `present: false` that it is not.
    if ('includes' in flag) check(`flag:${flag.id}:${flag.path}:${flag.includes}`, typeof value === 'string' && value.includes(flag.includes), flag.present ?? true);
    else check(`flag:${flag.id}:${flag.path}`, value, flag.equals);
  }
  for (const key of ['status', 'noMatchReason']) if (key in expect) check(key, data[key], expect[key]);
  for (const [path, wanted] of Object.entries(expect.equals ?? {})) check(path, at(body, path), wanted);
  const text = JSON.stringify(response.result ?? response);
  for (const value of expect.contains ?? []) check(`contains:${value}`, text.includes(value), true);
  for (const value of expect.notContains ?? []) check(`notContains:${value}`, text.includes(value), false);
  if ('isError' in expect) check('isError', !!response.error || response.result?.isError === true, expect.isError);
  return { ids, checks, pass: checks.every(item => item.pass), relevant: relevant.length, hits: ranks.length,
    recall: relevant.length ? ranks.length / relevant.length : null, reciprocalRank: relevant.length ? (ranks.length ? 1 / Math.min(...ranks) : 0) : null,
    leaks: leaks.length, flags: (expect.mustFlag ?? []).length, correctFlags: checks.filter(item => item.label.startsWith('flag:') && item.pass).length,
    writeReadback: expect.writeReadback === true };
};
export const metrics = rows => {
  const judged = rows.filter(row => row.checks.length);
  const recall = rows.filter(row => row.recall !== null);
  const flags = rows.reduce((sum, row) => sum + row.flags, 0);
  const readbacks = rows.filter(row => row.writeReadback);
  return { steps: judged.length, passed: judged.filter(row => row.pass).length,
    recallQueries: recall.length, recallAtK: recall.length ? recall.reduce((sum, row) => sum + row.recall, 0) / recall.length : null,
    mrr: recall.length ? recall.reduce((sum, row) => sum + row.reciprocalRank, 0) / recall.length : null,
    exclusionLeaks: rows.reduce((sum, row) => sum + row.leaks, 0), flags,
    correctFlags: rows.reduce((sum, row) => sum + row.correctFlags, 0),
    flagAccuracy: flags ? rows.reduce((sum, row) => sum + row.correctFlags, 0) / flags : null,
    writeReadbacks: readbacks.length, writeReadbackPassed: readbacks.filter(row => row.pass).length,
    writeReadbackRate: readbacks.length ? readbacks.filter(row => row.pass).length / readbacks.length : null };
};

// Seed and scenario instances that ended on a signal or a non-zero code (a SIGABRT at quit among them): listed and
// counted, never failing a step, which reads only what the instance answered.
export const abnormalExits = lifecycle => lifecycle.flatMap(life => [
  { scenario: life.scenario, instance: 'seed', pid: life.seedPid, exitCode: life.seedExitCode, signalCode: life.seedSignalCode },
  { scenario: life.scenario, instance: 'scenario', pid: life.pid, exitCode: life.exitCode, signalCode: life.signalCode },
].filter(item => item.signalCode != null || (item.exitCode != null && item.exitCode !== 0)));

export const CLI_OPTIONS = {
  scenarios: { type: 'string', default: 'scripts/lab/scenarios/context-development.json' }, only: { type: 'string' }, out: { type: 'string' },
  app: { type: 'string' }, bridge: { type: 'string' }, root: { type: 'string' }, 'local-models': { type: 'boolean', default: false },
  // Empty: agent steps (real model calls) run only when --agents names who answers them.
  agents: { type: 'string', default: '' }, reps: { type: 'string', default: '2' },
  'claude-setting-sources': { type: 'string' }, prompt: { type: 'string', default: 'default' },
};
/** `claude:sonnet,codex:gpt-6.1-sol` as the agents to run; empty for none. */
export const parseAgents = value => value.split(',').filter(Boolean).map(entry => {
  const [client, ...rest] = entry.split(':');
  if (!['claude', 'codex'].includes(client) || !rest.length) throw new Error(`Bad agent ${entry}`);
  return { client, model: rest.join(':'), label: entry };
});

async function main() {
  const { values } = parseArgs({ options: CLI_OPTIONS });
  const agentPrompt = AGENT_PROMPTS[values.prompt];
  const agentTool = PROMPT_TOOLS[values.prompt] ?? SEARCH;
  if (agentPrompt === undefined) throw new Error(`--prompt must be one of ${Object.keys(AGENT_PROMPTS).join(', ')}`);
  const agents = parseAgents(values.agents);
  const reps = Number(values.reps);
  if (!Number.isInteger(reps) || reps < 1) throw new Error('--reps must be a positive integer');
  if (!values.out) throw new Error('--out is required (must not exist)');
  const input = await readFile(values.scenarios);
  const suite = JSON.parse(input);
  if (suite.version !== 1 || suite.synthetic !== true || !Array.isArray(suite.scenarios)) throw new Error('Expected synthetic scenario format v1');
  const selected = suite.scenarios.filter(item => !values.only || values.only.split(',').includes(item.id));
  if (!selected.length) throw new Error('No scenarios selected');
  const out = resolve(values.out);
  await mkdir(dirname(out), { recursive: true });
  await mkdir(out);
  await writeFile(join(out, 'scenarios.json'), input);
  const summary = { started: new Date().toISOString(), scenarioSha256: createHash('sha256').update(input).digest('hex'), localModels: values['local-models'],
    promptStyle: values.prompt, agentPrompt, agentTool, agents: [], scenarios: [] };
  const hasAgentSteps = selected.some(scenario => scenario.steps.some(step => step.tool === 'agent'));
  const lifecycle = [];
  const dataRoot = values.root ? resolve(values.root) : join(LAB, 'context');
  await mkdir(dataRoot, { recursive: true });
  const log = value => appendFile(join(out, 'requests.jsonl'), JSON.stringify({ time: new Date().toISOString(), ...value }) + '\n');
  try {
    for (const scenario of selected) {
      const root = await mkdtemp(join(dataRoot, `${values['local-models'] ? 'on' : 'off'}-`));
      let app, mcp;
      const life = { scenario: scenario.id, root, start: new Date().toISOString() };
      lifecycle.push(life);
      const history = { runtime: { repositoryPath: process.cwd() } };
      const rows = [];
      const writeSeed = async file => {
        const target = vaultFile(app.env.PARASELF_VAULT_PATH, file.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.content);
        await log({ scenario: scenario.id, file });
      };
      // Everything this scenario seeded, as the App lists it: the canary for what a client under test is shown.
      const readCatalog = async () => {
        const records = [];
        let offset = 0;
        do {
          const response = await call({ id: `catalog-${Date.now()}-${offset}`, tool: 'search_decision_context', args: { query: '', limit: 20, offset, includeOutOfScope: true } }, 'warmup', false);
          const context = bodyOf(response).context;
          if (!context) throw new Error('Cannot read seed catalog');
          records.push(...context.results);
          offset = context.nextOffset;
        } while (offset !== null);
        return records;
      };
      let allow, guard, mcpConfig, agentCwd, codexCatalog;
      const createdBySeed = [];
      // Guarded connections for deterministic steps, by tool: the result a client would be shown, checked as it is.
      const guarded = new Map();
      const closeGuarded = () => { for (const connection of guarded.values()) connection.close(); guarded.clear(); };
      const ensureAllow = async () => {
        if (allow) return;
        // The guard's only trusted source: the seeds, as the App lists them and as their notes read on disk. The App must
        // list exactly what was seeded (a note it skipped, or one it found elsewhere, ends the run), and each note's
        // text is tied to its record by the hash the App gave.
        const files = scenario.seed?.files ?? [];
        const catalog = await readCatalog();
        checkSeedCatalog(catalog.map(item => item.id), files.filter(file => !isJournalSeed(file.path)), createdBySeed);
        allow = [];
        for (const record of catalog) {
          const note = await readFile(vaultFile(app.env.PARASELF_VAULT_PATH, record.sourceRef.relativePath), 'utf8');
          if (createHash('sha256').update(note).digest('hex') !== record.sourceRef.contentHash) throw new Error(`Note ${record.id} does not match its contentHash`);
          allow.push({ source: record.source, id: record.id, contentHash: record.sourceRef.contentHash, record, note });
        }
        // Preferences and ideas are in no catalog: each note as written, read back from the vault, and the App must have
        // read every one (one it passed over makes a consultation say signalsIncomplete).
        const journal = files.filter(file => isJournalSeed(file.path));
        for (const file of journal) {
          const note = await readFile(vaultFile(app.env.PARASELF_VAULT_PATH, file.path), 'utf8');
          const contentHash = createHash('sha256').update(note).digest('hex');
          if (contentHash !== createHash('sha256').update(file.content).digest('hex')) throw new Error(`Seed ${file.path} is not as written`);
          const entry = journalSnapshot(note);
          allow.push({ source: 'journal', id: entry.id, contentHash, note, entry });
        }
        if (journal.length) {
          const consulted = bodyOf(await call({ id: `journal-read-${Date.now()}`, tool: CONSULT, args: { question: '种子读取核对', project: 'lab' } }, 'warmup', false)).consultation;
          if (!consulted || consulted.signalsIncomplete === true || consulted.signalsUnavailable === true) throw new Error('The App did not read every seeded preference and idea');
        }
        await writeFile(join(root, ALLOWLIST), JSON.stringify(allow, null, 2));
      };
      const agentStep = async step => {
        if (!guard) {
          await ensureAllow();
          guard = { claude: guardCommand(root, values.bridge ?? defaultBridge(), 'claude-code', agentTool), codex: guardCommand(root, values.bridge ?? defaultBridge(), 'codex', agentTool) };
          mcpConfig = join(root, 'agent-mcp.json');
          await writeFile(mcpConfig, JSON.stringify(claudeMcpConfig(guard.claude, app.env), null, 2));
          agentCwd = join(root, 'agent-cwd');
          await mkdir(agentCwd, { recursive: true });
          if (agents.some(agent => agent.client === 'codex')) codexCatalog = await writeCodexCatalog(root);
          await log({ scenario: scenario.id, phase: 'agent-setup', allow, guard, mcpConfig, agentCwd, agentTool });
        }
        // The client's own sign-in from the outer environment (the App's holds only the lab's names), the paths from the App's.
        const env = testedEnvironment({ ...process.env, ...app.env });
        const mechanism = step.mechanism ?? scenario.mechanism ?? scenario.id;
        // A probe asks for a file outside root: one written here, its marker never in any seed.
        let question = step.prompt;
        if (step.outside !== undefined) {
          const outside = join(dataRoot, `outside-${scenario.id}-${step.id}.txt`);
          await writeFile(outside, `${step.outside}\n`);
          question = question.replaceAll('{outside}', outside);
        }
        for (const agent of agents) for (let rep = 1; rep <= reps; rep += 1) {
          const command = agentCommand({ ...agent, question, cwd: agentCwd, guard: guard[agent.client], mcpConfig, settingSources: values['claude-setting-sources'], codexCatalog, prompt: agentPrompt, tool: agentTool });
          const started = new Date();
          const run = await runAgent(command, { env, cwd: agentCwd, leakFile: join(root, LEAK),
            check: stdout => canary(parseAgentRun(agent.client, stdout).calls, allow).violations[0] ?? null });
          const name = `${scenario.id}__${step.id}__${agent.label.replace(/[^\w.-]+/g, '-')}__${rep}.jsonl`;
          await mkdir(join(out, 'agents'), { recursive: true });
          await writeFile(join(out, 'agents', name), run.stdout);
          await writeFile(join(out, 'agents', name.replace(/\.jsonl$/, '.stderr.txt')), run.stderr);
          const parsed = parseAgentRun(agent.client, run.stdout);
          const seen = canary(parsed.calls, allow);
          const row = { scenario: scenario.id, step: step.id, mechanism, agent: agent.label, agentMechanism: `${agent.label} ${mechanism}`, rep,
            localModels: values['local-models'], started: started.toISOString(), elapsedMs: Date.now() - started.getTime(),
            pid: run.pid, exitCode: run.code, signal: run.signal, stderrTail: run.stderr.slice(-1_500), stdout: join('agents', name),
            calls: parsed.calls.map(({ visible: _visible, ...call }) => call), answer: parsed.answer, finalText: parsed.text, canary: seen, leak: run.leak,
            verdict: run.timedOut ? 'timeout' : scoreAnswer(parsed.answer, step.expect?.answer) };
          summary.agents.push(row);
          await log({ scenario: scenario.id, phase: 'agent', step: step.id, agent: agent.label, rep, command: command.command, args: command.args, verdict: row.verdict, canary: seen, leak: run.leak });
          if (run.leak || !seen.ok) {
            summary.leak = { scenario: scenario.id, step: step.id, agent: agent.label, rep, halted: run.leak, ...seen,
              guard: existsSync(join(root, LEAK)) ? await readFile(join(root, LEAK), 'utf8') : null,
              fault: existsSync(join(root, GUARD_FAULT)) ? await readFile(join(root, GUARD_FAULT), 'utf8') : null };
            throw Object.assign(new Error(`Leak: ${run.leak ?? seen.violations[0] ?? `foreign ${seen.foreign.join(', ')}`}`), { leak: true });
          }
        }
      };
      const call = async (step, phase, judged = true) => {
        if (step.file) { await writeSeed(expand(step.file, history)); return; }
        // A note gone from the journal, as the App's delete or the reader's trash leaves it.
        if (step.remove) { const path = expand(step.remove, history); await rm(vaultFile(app.env.PARASELF_VAULT_PATH, path)); await log({ scenario: scenario.id, step: step.id, removed: path }); return; }
        // The App started again and asked at once, as an agent's first search after a launch: vectors stay on disk.
        if (step.restart) {
          closeGuarded();
          mcp.close();
          await app.stop();
          life.exits = [...life.exits ?? [], exitOf(app)];
          const started = Date.now();
          app = await startIsolatedApp({ root, executable: values.app, useLocalModels: values['local-models'] });
          life.pid = app.child.pid;
          mcp = await connectMcp({ env: app.env, bridge: values.bridge });
          await log({ scenario: scenario.id, step: step.id, restarted: app.child.pid, readyMs: Date.now() - started });
          return;
        }
        if (history[step.id] !== undefined) throw new Error(`Duplicate step id: ${step.id}`);
        const args = expand(step.args ?? {}, history);
        const started = Date.now();
        // `guarded`: asked through scripts/lab/mcp-guard.mjs, opened for this tool, as a client under test would be.
        let connection = mcp;
        if (step.guarded) {
          await ensureAllow();
          if (!guarded.has(step.tool)) guarded.set(step.tool, await connectMcp({ env: app.env, ...guardCommand(root, values.bridge ?? defaultBridge(), 'claude-code', step.tool) }));
          connection = guarded.get(step.tool);
        }
        const response = await connection.call(step.tool, args);
        if (step.guarded) {
          // The guard writes its file before the notice that ends its answer.
          const flagged = [LEAK, GUARD_FAULT].find(file => existsSync(join(root, file)));
          if (flagged) {
            summary.leak = { scenario: scenario.id, step: step.id, guarded: true, [flagged === LEAK ? 'guard' : 'fault']: await readFile(join(root, flagged), 'utf8') };
            throw Object.assign(new Error(`Leak: guard wrote ${flagged}`), { leak: true });
          }
        }
        await log({ scenario: scenario.id, phase, step: step.id, ...(step.guarded ? { guarded: true } : {}), request: { jsonrpc: '2.0', id: response.id, method: 'tools/call', params: { name: step.tool, arguments: args } }, response, elapsedMs: Date.now() - started });
        history[step.id] = bodyOf(response);
        if (phase === 'beforeSeed' || phase === 'seed') { const created = createdRecordId(step.tool, response); if (created) createdBySeed.push(created); }
        if (judged) {
          const expected = expand({ ...step.expect, ...step.expectByMode?.[values['local-models'] ? 'on' : 'off'] }, history);
          rows.push({ id: step.id, tool: step.tool, phase, ...score(response, expected) });
        }
        return response;
      };
      try {
        app = await startIsolatedApp({ root, executable: values.app, useLocalModels: values['local-models'] });
        life.pid = app.child.pid;
        mcp = await connectMcp({ env: app.env, bridge: values.bridge });
        await log({ scenario: scenario.id, tools: await mcp.listTools() });
        for (const step of scenario.beforeSeed ?? []) await call(step, 'beforeSeed');
        for (const file of scenario.seed?.files ?? []) await writeSeed(file);
        for (const step of scenario.seed?.calls ?? []) await call(step, 'seed');
        // Decisions sync vectors at startup; restart after seeding so this barrier covers all three sources.
        if (values['local-models'] && ((scenario.seed?.files?.length ?? 0) + (scenario.seed?.calls?.length ?? 0)) > 0) {
          mcp.close();
          await app.stop();
          life.exits = [...life.exits ?? [], exitOf(app)];
          life.seedPid = app.child.pid;
          life.seedExitCode = app.child.exitCode;
          life.seedSignalCode = app.child.signalCode;
          life.seedClosed = life.seedExitCode !== null || life.seedSignalCode !== null;
          app = await startIsolatedApp({ root, executable: values.app, useLocalModels: true });
          life.pid = app.child.pid;
          mcp = await connectMcp({ env: app.env, bridge: values.bridge });
          const expectedVectors = (await readCatalog()).map(item => ({
            entity_id: item.id, entity_type: { summarize: 'summary', principles: 'methodology', decisions: 'decision' }[item.source],
          }));
          const deadline = Date.now() + 120_000;
          const waited = Date.now();
          let ready = false;
          do {
            await call({ id: `warm-consult-${Date.now()}`, tool: 'consult_decision_principles', args: { question: '索引准备：验证迁移可逆性', project: 'lab' } }, 'warmup', false);
            // Ready once a search's meaning is in time as well: steps run in the minutes after a start (the model hashed and
            // loaded) found by keyword alone, and the numbers changed with the load, not the version.
            const searched = await call({ id: `warm-search-${Date.now()}`, tool: 'search_decision_context', args: { query: '索引准备' } }, 'warmup', false);
            const inTime = !JSON.stringify(searched).includes(SEMANTIC_LATE);
            let db;
            try {
              db = new DatabaseSync(join(app.env.PARASELF_USER_DATA, 'semantic-vectors.sqlite'), { readOnly: true });
              const vectors = db.prepare('SELECT entity_id, entity_type, model, dimension FROM semantic_vectors').all();
              ready = inTime && expectedVectors.every(expected => vectors.some(item => item.entity_id === expected.entity_id && item.entity_type === expected.entity_type));
              await log({ scenario: scenario.id, phase: 'index-ready', ready, expectedVectors, vectors });
            } finally { db?.close(); }
            if (!ready) await new Promise(resolve => setTimeout(resolve, 500));
          } while (!ready && Date.now() < deadline);
          if (!ready) throw new Error('Seed vectors not ready within 120s');
          life.semanticReadyMs = Date.now() - waited;
        } else {
          await call({ id: 'index-probe', tool: 'search_decision_context', args: { query: '', limit: 20 } }, 'warmup', false);
        }
        for (const step of scenario.steps) await (step.tool === 'agent' ? agentStep(step) : call(step, 'steps'));
      } finally {
        closeGuarded();
        mcp?.close();
        if (app) {
          await app.stop();
          life.exits = [...life.exits ?? [], exitOf(app)];
          life.exitCode = app.child.exitCode;
          life.signalCode = app.child.signalCode;
          life.closed = life.exitCode !== null || life.signalCode !== null;
          life.stop = 'MCP close; isolated-app.stop (POST /v1/smoke/shutdown, fallback SIGTERM/SIGKILL)';
        }
        life.end = new Date().toISOString();
        summary.scenarios.push({ id: scenario.id, root, rows, metrics: metrics(rows) });
        await writeFile(join(out, 'lifecycle.json'), JSON.stringify(lifecycle, null, 2));
      }
    }
  } catch (error) {
    summary.error = error.stack;
    process.exitCode = 2;
  } finally {
    summary.finished = new Date().toISOString();
    summary.metrics = metrics(summary.scenarios.flatMap(item => item.rows));
    summary.abnormalExits = abnormalExits(lifecycle);
    if (hasAgentSteps) summary.agentCounts = agentCounts(summary.agents);
    await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ out, ...summary.metrics, abnormalExits: summary.abnormalExits.length, agentCounts: summary.agentCounts?.byAgent, leak: summary.leak, error: summary.error }));
    if (!summary.error && summary.metrics.passed !== summary.metrics.steps) process.exitCode = 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
