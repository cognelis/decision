#!/usr/bin/env node

import {
  BUILT_IN_CLIENTS,
  KNOWN_CLIENTS,
  clientById,
  clientHookPaths,
  customClientDescriptor,
  readCustomClients,
  type ClientDescriptor,
  decisionProjectFor,
  detectIntegrationStatus,
  hookBridgeReference,
  installIntegrations,
  removeIntegrations,
} from "@cognelis/decision-integrations";
import {
  sourceClientSchema,
  type CapturedDecisionEvent,
  type SemanticDecisionPair,
} from "@cognelis/decision-protocol";
import {
  CaptureAuditStore,
  CaptureSpool,
  SemanticPairSpool,
  type CaptureAuditRecordInput,
} from "@cognelis/decision-storage";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readParaselfEnvironment } from "../../../config/paraself-environment.mjs";
import { resolveUserData } from "../../../config/user-data-directory.mjs";

import { normalizeHookInput } from "./client-input.js";
import { runProbeHook } from "./client-probe.js";
import {
  adaptClaudePostToolUse,
  adaptCodexPostToolUse,
} from "./hook-adapters.js";
import {
  RuntimeClient,
  defaultBridgeDataDirectory,
  useDataDirectory,
} from "./runtime-client.js";
import {
  TextCaptureFallback,
} from "./text-fallback.js";
import {
  TextCaptureStore,
  type TextCaptureClient,
} from "./text-capture-store.js";
import {
  serveDecisionMcp,
  type DecisionMcpClient,
} from "./mcp-server.js";

const MAXIMUM_HOOK_INPUT_BYTES = 256 * 1_024;

/** Input past the limit, with what was read before it: enough to say whose capture was lost. */
export class HookInputTooLargeError extends Error {
  constructor(readonly head: string) {
    super("Hook input is too large");
    this.name = "HookInputTooLargeError";
  }
}

export const readHookInput = async (
  stream: AsyncIterable<unknown>,
  maximumBytes = MAXIMUM_HOOK_INPUT_BYTES,
): Promise<unknown> => {
  if (!Number.isInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("Hook input limit is invalid");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer =
      Buffer.isBuffer(chunk) ||
      typeof chunk === "string" ||
      chunk instanceof Uint8Array
        ? Buffer.from(chunk)
        : null;
    if (buffer === null) {
      throw new Error("Hook input contains an unsupported chunk");
    }
    size += buffer.length;
    if (size > maximumBytes) {
      throw new HookInputTooLargeError(Buffer.concat([...chunks, buffer]).subarray(0, maximumBytes).toString("utf8"));
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw.length === 0 ? {} : JSON.parse(raw);
};

const readStdin = (): Promise<unknown> =>
  readHookInput(process.stdin);

const printJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

interface CaptureSpoolLike {
  append(event: CapturedDecisionEvent): Promise<void>;
}

interface SemanticPairSpoolLike {
  append(
    pair: SemanticDecisionPair,
  ): Promise<"accepted" | "duplicate">;
}

interface CaptureAuditStoreLike {
  record(input: CaptureAuditRecordInput): Promise<unknown>;
}

interface RuntimeLike {
  deliver(
    event: CapturedDecisionEvent,
  ): Promise<unknown>;
  deliverSemanticPair?(
    pair: SemanticDecisionPair,
  ): Promise<boolean | null>;
  doctor(): Promise<object>;
}

interface TextCaptureFallbackLike {
  onStop(
    input: unknown,
    client: TextCaptureClient,
  ): Promise<CapturedDecisionEvent[]>;
  onUserPrompt(
    input: unknown,
    client: TextCaptureClient,
  ): Promise<SemanticDecisionPair | null>;
}

export interface CliDependencies {
  environment?: NodeJS.ProcessEnv;
  runtime?: RuntimeLike;
  spool?: CaptureSpoolLike;
  semanticPairSpool?: SemanticPairSpoolLike;
  audit?: CaptureAuditStoreLike;
  fallback?: TextCaptureFallbackLike;
  readStdin?: () => Promise<unknown>;
  installer?: typeof installIntegrations;
  remover?: typeof removeIntegrations;
  serveMcp?: (options: { sourceClient: DecisionMcpClient }) => void;
  bridgePath?: string;
  userHome?: string;
  /** Paraself's bundled skills folder; worked out from where this module is when not given (bundledSkillsDirectory). */
  skillsSource?: string | null;
  printJson?: (value: unknown) => void;
  printError?: (value: string) => void;
}

/**
 * The skills this bridge ships with: packaged, Resources/skills beside Resources/bridge; run from source, the
 * repository's skills/. Null when neither is there (a bare bridge build), and no skills are touched.
 */
export const bundledSkillsDirectory = (moduleUrl: string = import.meta.url): string | null => {
  const here = fileURLToPath(new URL(".", moduleUrl));
  return [join(here, "..", "skills"), join(here, "..", "..", "..", "skills")]
    .find((candidate) => existsSync(join(candidate, "paraself-memory", "SKILL.md"))) ?? null;
};

export const defaultCaptureSpoolPath = (
  environment: NodeJS.ProcessEnv = process.env,
): string =>
  readParaselfEnvironment(environment, "CAPTURE_SPOOL") ??
  join(defaultBridgeDataDirectory(), "capture-spool");

export const defaultTextCaptureStorePath = (
  environment: NodeJS.ProcessEnv = process.env,
): string =>
  readParaselfEnvironment(environment, "TEXT_PENDING") ??
  join(defaultBridgeDataDirectory(), "text-pending");

export const defaultSemanticPairSpoolPath = (
  environment: NodeJS.ProcessEnv = process.env,
): string =>
  readParaselfEnvironment(environment, "SEMANTIC_PAIR_SPOOL") ??
  join(defaultBridgeDataDirectory(), "semantic-pair-spool");

export const defaultCaptureAuditPath = (
  environment: NodeJS.ProcessEnv = process.env,
): string =>
  readParaselfEnvironment(environment, "CAPTURE_AUDIT") ??
  join(defaultBridgeDataDirectory(), "capture-audit");

/** Where the reader's own clients are described, as the App keeps them: moved as the bridge's other files are. */
export const defaultCustomClientsPath = (
  environment: NodeJS.ProcessEnv = process.env,
): string =>
  readParaselfEnvironment(environment, "CUSTOM_CLIENTS") ??
  join(defaultBridgeDataDirectory(), "custom-clients.json");

/** A built-in client the registry knows: one it does not is not read here. */
const asTextCaptureClient = (
  value: string | undefined,
): TextCaptureClient | null =>
  clientById(value, KNOWN_CLIENTS)?.id ?? null;

/**
 * A client by its id: a built-in one, else one the reader added on the 接入 page, as its file describes it. Neither (no
 * such client, or a file not read): null, and the hook does nothing.
 */
const describeClient = async (
  id: string | undefined,
  environment: NodeJS.ProcessEnv,
): Promise<ClientDescriptor | null> => {
  // Written in code first, then the catalog's, then the reader's own: one of theirs by a catalog id is not read.
  const builtIn = clientById(id, KNOWN_CLIENTS);
  if (builtIn !== undefined) return builtIn;
  if (id === undefined || !sourceClientSchema.safeParse(id).success) return null;
  const found = (await readCustomClients(defaultCustomClientsPath(environment))).clients.find((client) => client.id === id);
  return found === undefined ? null : customClientDescriptor(found);
};

const auditIdentity = (
  input: unknown,
): { sessionId: string; turnId?: string } | null => {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input)
  ) {
    return null;
  }
  const object = input as Record<string, unknown>;
  const sessionId = object.session_id;
  const turnId = object.turn_id;
  if (
    typeof sessionId !== "string" ||
    sessionId.trim().length === 0 ||
    sessionId.length > 500
  ) {
    return null;
  }
  return {
    sessionId: sessionId.trim(),
    ...(typeof turnId === "string" &&
    turnId.trim().length > 0 &&
    turnId.length <= 500
      ? { turnId: turnId.trim() }
      : {}),
  };
};

const recordAudit = async (
  audit: CaptureAuditStoreLike,
  input: unknown,
  client: TextCaptureClient,
  stage: CaptureAuditRecordInput["stage"],
  errorCode?: CaptureAuditRecordInput["errorCode"],
): Promise<void> => {
  const identity = auditIdentity(input);
  if (identity === null) {
    return;
  }
  await audit
    .record({
      sourceClient: client,
      ...identity,
      stage,
      ...(errorCode === undefined ? {} : { errorCode }),
    })
    .catch(() => undefined);
};

const auditStore = (dependencies: CliDependencies): CaptureAuditStoreLike =>
  dependencies.audit ??
  new CaptureAuditStore(defaultCaptureAuditPath(dependencies.environment));

/**
 * The hook's input. One past the limit (a question with a whole log pasted into it) is not read, but is said in
 * the capture log under the session its first bytes name, rather than lost without a trace.
 */
const readInput = async (
  client: TextCaptureClient | null,
  dependencies: CliDependencies,
): Promise<unknown> => {
  try {
    return await (dependencies.readStdin ?? readStdin)();
  } catch (error) {
    if (error instanceof HookInputTooLargeError && client !== null) {
      const field = (name: string) =>
        new RegExp(`"${name}"\\s*:\\s*"([^"\\\\]{1,500})"`, "u").exec(error.head)?.[1];
      await recordAudit(
        auditStore(dependencies),
        { session_id: field("session_id"), turn_id: field("turn_id") },
        client,
        "failed",
        "input_too_large",
      );
    }
    throw error;
  }
};

const spoolOf = (dependencies: CliDependencies): CaptureSpoolLike =>
  dependencies.spool ?? new CaptureSpool(defaultCaptureSpoolPath(dependencies.environment));

const runtimeOf = (dependencies: CliDependencies): RuntimeLike =>
  dependencies.runtime ?? new RuntimeClient({ environment: dependencies.environment ?? process.env });

interface Persisted {
  event: CapturedDecisionEvent;
  spooled: boolean;
}

/** The capture on disk, as far as the spool takes it, before the App is asked for it. */
const persist = async (
  event: CapturedDecisionEvent,
  spool: CaptureSpoolLike,
  locate: (cwd: string) => Promise<string> = decisionProjectFor,
): Promise<Persisted> => {
  // The repository's name, as search resolves it, not the working directory's: a linked worktree or a
  // subdirectory is the same project. Every capture path, the Stop recovery included, comes through here.
  const located = { ...event, project: await locate(event.cwd) };
  // The spool is for when the App is not there to take it: one that cannot be written (a full disk, a
  // locked folder) is no reason not to hand the capture to the App that is.
  return { event: located, spooled: await spool.append(located).then(() => true, () => false) };
};

const deliver = async (
  { event, spooled }: Persisted,
  runtime: RuntimeLike,
  dependencies: CliDependencies,
): Promise<void> => {
  const delivered = await runtime.deliver(event).catch(() => null);
  // Taken by neither, the capture is gone: said in the capture log (a folder of its own), where it went without a
  // trace. As a text capture's pair not written is said, and in words 1.1.0 reads. Sent to an App that did not
  // answer in time (false) is not that: it may well have it, and was called lost.
  const client = asTextCaptureClient(event.sourceClient);
  if (!spooled && delivered === null && client !== null) {
    await recordAudit(auditStore(dependencies), { session_id: event.sessionId, turn_id: event.turnId }, client, "failed", "pair_write_failed");
  }
};

const persistAndDeliver = async (
  event: CapturedDecisionEvent,
  dependencies: CliDependencies,
): Promise<void> => {
  await deliver(await persist(event, spoolOf(dependencies)), runtimeOf(dependencies), dependencies);
};

const runPassivePostToolUse = async (
  client: string | undefined,
  dependencies: CliDependencies,
): Promise<number> => {
  try {
    const descriptor = await describeClient(client, dependencies.environment ?? process.env);
    if (descriptor === null) {
      return 0;
    }
    const input = await readInput(descriptor.id, dependencies);
    if (runByAnotherClient(descriptor.id, input, dependencies.environment ?? process.env, hookHome(dependencies))) {
      return 0;
    }
    const adapter = descriptor.capture.postToolUse;
    const event =
      adapter === "claude-code"
        ? adaptClaudePostToolUse(input)
        : adapter === "codex"
          ? adaptCodexPostToolUse(input)
          : null;
    if (event === null) {
      return 0;
    }

    await persistAndDeliver(event, dependencies);
  } catch {
    // Hooks are observers. They must never alter the native client flow.
  }
  return 0;
};

/**
 * Claude Code's hooks run by another client that reads them too, told by the input itself. Cursor runs those in
 * ~/.claude/settings.json (its third-party hooks, on by default): its input has `cursor_version`, or, where it is not
 * Claude Code's (no `session_id`, which Claude Code always sends), the CURSOR_VERSION its hooks run with is enough.
 * Droid's one-time "Claude Code Hooks Auto-Migration" may copy this app's Claude Code hooks into its own: its input's
 * transcript is under ~/.factory/. A variable a terminal can have left over (FACTORY_PROJECT_DIR) is no sign alone.
 * Recorded as Claude Code's, such a turn was Claude Code's, and again beside the client's own hook.
 */
const runByAnotherClient = (client: string, input: unknown, environment: NodeJS.ProcessEnv, home: string | undefined): boolean => {
  if (client !== "claude-code" || typeof input !== "object" || input === null) return false;
  const transcript = (input as Record<string, unknown>).transcript_path;
  return (
    Object.hasOwn(input, "cursor_version") ||
    (environment.CURSOR_VERSION !== undefined && !Object.hasOwn(input, "session_id")) ||
    (home !== undefined && typeof transcript === "string" && isAbsolute(transcript) && resolve(transcript).startsWith(`${join(home, ".factory")}${sep}`))
  );
};

/** The reader's home folder as the hook's environment names it: a hook does not look it up anew (no os.homedir()). */
const hookHome = (dependencies: CliDependencies): string | undefined => {
  const environment = dependencies.environment ?? process.env;
  return dependencies.userHome ?? (environment.HOME || environment.USERPROFILE || undefined);
};

const runPassiveTextHook = async (
  operation: "stop" | "user-prompt-submit",
  clientValue: string | undefined,
  dependencies: CliDependencies,
): Promise<number> => {
  try {
    const descriptor = await describeClient(clientValue, dependencies.environment ?? process.env);
    if (descriptor === null) {
      return 0;
    }
    const client = descriptor.id;
    const raw = await readInput(client, dependencies);
    if (runByAnotherClient(client, raw, dependencies.environment ?? process.env, hookHome(dependencies))) {
      return 0;
    }
    const audit = auditStore(dependencies);
    const fallback =
      dependencies.fallback ??
      new TextCaptureFallback({
        store: new TextCaptureStore(
          defaultTextCaptureStorePath(dependencies.environment),
          {
            onExpired: async (turn) => {
              await audit
                .record({
                  sourceClient: turn.sourceClient,
                  sessionId: turn.sessionId,
                  ...(turn.turnId === undefined
                    ? {}
                    : { turnId: turn.turnId }),
                  stage: "pending_expired",
                })
                .catch(() => undefined);
            },
          },
        ),
        audit,
        describe: (id) => (id === descriptor.id ? descriptor : clientById(id)),
      });
    // A client that sends the turn's prompt and its reply in one event: the prompt first, as the answer to the turn
    // before's question, then the reply. Not the prompt of a turn a Stop hook made go on (`stop_hook_active`): it is
    // the one already read.
    if (operation === "stop" && descriptor.capture.promptInStop === true) {
      const continued = typeof raw === "object" && raw !== null && (raw as Record<string, unknown>).stop_hook_active === true;
      if (!continued) await capturePrompt(raw, descriptor, client, fallback, audit, dependencies);
    } else if (operation === "user-prompt-submit") {
      // Such a client's prompt is read in its Stop: a prompt handler of its own is one an earlier build wrote beside it
      // (two on one event), and read as well it took the reply just saved. Ignored until 重新接入 takes it out.
      if (descriptor.capture.promptInStop !== true) await capturePrompt(raw, descriptor, client, fallback, audit, dependencies);
      return 0;
    }
    // In the client's own names, and not at all where it is no reply.
    const input = await normalizeHookInput(raw, descriptor, "stop");
    if (input === null) {
      return 0;
    }
    await recordAudit(audit, input, client, "hook_received");
    // Every decision of the turn on disk before the App is asked for any: a delivery that hung until the hook's
    // five seconds were up took the ones behind it with it, unspooled and unaudited.
    const events = await fallback.onStop(input, client);
    if (events.length === 0) {
      return 0;
    }
    const spool = spoolOf(dependencies);
    // One turn, one working directory: its repository looked up once, not again for each decision (a few git
    // calls each, which a slow disk stretches toward the hook's five seconds before the first delivery).
    const projects = new Map<string, Promise<string>>();
    const locate = (cwd: string): Promise<string> => {
      const project = projects.get(cwd) ?? decisionProjectFor(cwd);
      projects.set(cwd, project);
      return project;
    };
    const persisted: Persisted[] = [];
    for (const event of events) {
      persisted.push(await persist(event, spool, locate));
    }
    const runtime = runtimeOf(dependencies);
    for (const entry of persisted) {
      await deliver(entry, runtime, dependencies);
    }
  } catch {
    // Text fallback is also a silent observer of native interaction.
  }
  return 0;
};

/** The reader's prompt, paired with the question waiting from the turn before. */
const capturePrompt = async (
  raw: unknown,
  descriptor: ClientDescriptor,
  client: TextCaptureClient,
  fallback: TextCaptureFallbackLike,
  audit: CaptureAuditStoreLike,
  dependencies: CliDependencies,
): Promise<void> => {
  // In the client's own names, and not at all where it is no new prompt.
  const input = await normalizeHookInput(raw, descriptor, "user-prompt-submit");
  if (input === null) {
    return;
  }
  await recordAudit(audit, input, client, "hook_received");
  const pair = await fallback.onUserPrompt(input, client);
  if (pair === null) {
    return;
  }
  const pairSpool =
    dependencies.semanticPairSpool ??
    new SemanticPairSpool(
      defaultSemanticPairSpoolPath(dependencies.environment),
    );
  // Not spooled is no reason not to deliver: the App, if it is there, still takes it.
  const spooled = await pairSpool.append(pair).then(() => true, () => false);
  if (spooled) {
    await recordAudit(audit, input, client, "pair_spooled");
  } else {
    await recordAudit(
      audit,
      input,
      client,
      "failed",
      "pair_write_failed",
    );
  }
  const runtime =
    dependencies.runtime ??
    new RuntimeClient({
      environment: dependencies.environment ?? process.env,
    });
  if (
    "deliverSemanticPair" in runtime &&
    typeof runtime.deliverSemanticPair === "function"
  ) {
    // An App that is not running is what the spool is for; one that is, and did not take it, is said.
    const delivered = await runtime.deliverSemanticPair(pair).catch(() => false);
    if (delivered === false) {
      await recordAudit(
        audit,
        input,
        client,
        "failed",
        "pair_delivery_failed",
      );
    }
  }
};

export const main = async (
  arguments_: string[] = process.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<number> => {
  const [command, subcommand, client] = arguments_;
  const environment =
    dependencies.environment ?? process.env;
  // Grok runs Claude Code's hooks too, unless told not to: one of them run by Grok was recorded as Claude Code's, and
  // again beside Grok's own hook once that is connected. Grok's own hook records its turns.
  if (command === "hook" && client === "claude-code" && environment.GROK_HOOK_EVENT !== undefined) {
    return 0;
  }
  // A model call the App started (a Claude Code or Codex CLI backend) records nothing of its own: its hooks do
  // nothing, and Paraself's MCP server, write tools and all, does not start in it.
  if (
    (command === "hook" || command === "mcp") &&
    readParaselfEnvironment(environment, "PROVIDER_CHILD") === "1"
  ) {
    return 0;
  }
  const output = dependencies.printJson ?? printJson;
  const printError =
    dependencies.printError ??
    ((value: string) => process.stderr.write(value));

  if (command === "mcp") {
    const sourceClient = (await describeClient(subcommand, environment).catch(() => null))?.id ?? null;
    // A client's id no file describes now (deleted, or its file not read): the client still starts it, and it starts
    // nothing, without a word, as its hooks do. Only a command line with no id in it is a mistake to say.
    if (sourceClient === null && subcommand !== undefined && sourceClientSchema.safeParse(subcommand).success) {
      return 0;
    }
    if (sourceClient === null) {
      printError(
        `Usage: paraself-bridge mcp <${BUILT_IN_CLIENTS.map((entry) => entry.id).join("|")}>\n`,
      );
      return 2;
    }
    (dependencies.serveMcp ?? serveDecisionMcp)({ sourceClient });
    return 0;
  }
  // A 接入新工具 probe: what the client sends, recorded for the App while its probe stands (client-probe.ts).
  if (command === "hook" && subcommand === "probe") {
    return runProbeHook(client, arguments_[3], {
      environment,
      readInput: (maximumBytes) => dependencies.readStdin?.() ?? readHookInput(process.stdin, maximumBytes),
    });
  }
  if (command === "hook" && subcommand === "post-tool-use") {
    return runPassivePostToolUse(client, dependencies);
  }

  if (
    command === "hook" &&
    (subcommand === "stop" ||
      subcommand === "user-prompt-submit")
  ) {
    return runPassiveTextHook(
      subcommand,
      client,
      dependencies,
    );
  }

  // Where each client reads its settings: CLAUDE_CONFIG_DIR, CODEX_HOME and GROK_HOME move them, as they move
  // where its `mcp add` registers the server.
  const userHome = dependencies.userHome ?? homedir();
  const paths = clientHookPaths(BUILT_IN_CLIENTS, environment, userHome);
  const bridgePath =
    dependencies.bridgePath ??
    readParaselfEnvironment(environment, "BRIDGE_PATH") ??
    process.argv[1] ??
    process.execPath;

  if (command === "doctor") {
    const runtime =
      dependencies.runtime ??
      new RuntimeClient({ environment });
    // Whether a client's hooks will reach the App at all, as its 接入 page says: the App's state alone said
    // healthy with none connected, or with hooks naming a bridge no longer there.
    let reference: string | undefined;
    try {
      reference = hookBridgeReference(bridgePath, process.platform);
    } catch {
      reference = undefined;
    }
    const hooks = await detectIntegrationStatus(paths, reference, process.platform);
    output({ ...(await runtime.doctor()), hooks });
    const statuses = Object.values(hooks);
    return statuses.includes("installed") &&
      statuses.every((status) => status === "installed" || status === "not-installed")
      ? 0
      : 1;
  }

  if (command === "install") {
    if (subcommand !== "--dry-run" && subcommand !== "--apply") {
      printError(
        "Usage: paraself-bridge install <--dry-run|--apply>\n",
      );
      return 2;
    }
    const skillsSource = dependencies.skillsSource === undefined ? bundledSkillsDirectory() : dependencies.skillsSource;
    const report = await (dependencies.installer ?? installIntegrations)({
      mode: subcommand === "--apply" ? "apply" : "dry-run",
      bridgePath,
      paths,
      home: userHome,
      environment,
      ...(skillsSource === null ? {} : { skillsSource }),
    });
    output(report);
    // A client not connected, or a skill not written, is a failure a script must see, though the rest went in.
    return report.targets.some((target) => target.status === "failed") || report.skills?.some((skill) => skill.status === "failed") ? 1 : 0;
  }

  // Takes Paraself out of every client again. Only says what it would do, until asked to with --apply.
  if (command === "uninstall") {
    if (subcommand !== undefined && subcommand !== "--dry-run" && subcommand !== "--apply") {
      printError("Usage: paraself-bridge uninstall [--apply]\n");
      return 2;
    }
    const report = await (dependencies.remover ?? removeIntegrations)({
      mode: subcommand === "--apply" ? "apply" : "dry-run",
      bridgePath,
      paths,
    });
    output(report);
    return report.targets.some((target) => target.status === "failed") ? 1 : 0;
  }

  printError(
    `Usage: paraself-bridge <doctor|install --dry-run|install --apply|uninstall [--apply]|mcp <client>|hook <post-tool-use|stop|user-prompt-submit> <client>>, <client> one of ${BUILT_IN_CLIENTS.map((entry) => entry.id).join("|")}\n`,
  );
  return 2;
};

/**
 * Whether this module is the program Node was started with. Node runs it from its real path, and argv[1] is
 * the path it was given, through a link or a junction (AppData moved to another drive with mklink /J):
 * compared as given they differed, and every hook exited having done nothing.
 */
export const startedAsProgram = (moduleUrl: string, entry: string | undefined): boolean => {
  if (entry === undefined) return false;
  let real = entry;
  try {
    real = realpathSync(entry);
  } catch {
    // Compared as given.
  }
  return moduleUrl === pathToFileURL(real).href || moduleUrl === pathToFileURL(entry).href;
};

if (startedAsProgram(import.meta.url, process.argv[1])) {
  // Decision's data folder moved to its new name once, as the App does, before anything here reads or writes in it.
  try {
    useDataDirectory(resolveUserData(process.env).path);
  } catch {
    // Worked out again where it is needed: a hook goes on quietly whatever happens.
  }
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
