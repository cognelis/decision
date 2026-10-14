#!/usr/bin/env node

import {
  decisionProjectFor,
  detectIntegrationStatus,
  hookBridgeReference,
  installIntegrations,
  removeIntegrations,
} from "@cognelis/decision-integrations";
import type {
  CapturedDecisionEvent,
  SemanticDecisionPair,
} from "@cognelis/decision-protocol";
import {
  CaptureAuditStore,
  CaptureSpool,
  SemanticPairSpool,
  type CaptureAuditRecordInput,
} from "@cognelis/decision-storage";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { readDecisionEnvironment } from "../../../config/decision-environment.mjs";

import {
  adaptClaudePostToolUse,
  adaptCodexPostToolUse,
} from "./hook-adapters.js";
import {
  RuntimeClient,
  defaultBridgeDataDirectory,
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
  printJson?: (value: unknown) => void;
  printError?: (value: string) => void;
}

export const defaultCaptureSpoolPath = (
  environment: NodeJS.ProcessEnv = process.env,
): string =>
  readDecisionEnvironment(environment, "CAPTURE_SPOOL") ??
  join(defaultBridgeDataDirectory(), "capture-spool");

export const defaultTextCaptureStorePath = (
  environment: NodeJS.ProcessEnv = process.env,
): string =>
  readDecisionEnvironment(environment, "TEXT_PENDING") ??
  join(defaultBridgeDataDirectory(), "text-pending");

export const defaultSemanticPairSpoolPath = (
  environment: NodeJS.ProcessEnv = process.env,
): string =>
  readDecisionEnvironment(environment, "SEMANTIC_PAIR_SPOOL") ??
  join(defaultBridgeDataDirectory(), "semantic-pair-spool");

export const defaultCaptureAuditPath = (
  environment: NodeJS.ProcessEnv = process.env,
): string =>
  readDecisionEnvironment(environment, "CAPTURE_AUDIT") ??
  join(defaultBridgeDataDirectory(), "capture-audit");

const asTextCaptureClient = (
  value: string | undefined,
): TextCaptureClient | null =>
  value === "claude-code" || value === "codex"
    ? value
    : null;

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
    const input = await readInput(asTextCaptureClient(client), dependencies);
    const event =
      client === "claude-code"
        ? adaptClaudePostToolUse(input)
        : client === "codex"
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

const runPassiveTextHook = async (
  operation: "stop" | "user-prompt-submit",
  clientValue: string | undefined,
  dependencies: CliDependencies,
): Promise<number> => {
  try {
    const client = asTextCaptureClient(clientValue);
    if (client === null) {
      return 0;
    }
    const input = await readInput(client, dependencies);
    const audit = auditStore(dependencies);
    await recordAudit(audit, input, client, "hook_received");
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
      });
    if (operation === "stop") {
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
      return 0;
    }
    const pair = await fallback.onUserPrompt(input, client);
    if (pair === null) {
      return 0;
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
  } catch {
    // Text fallback is also a silent observer of native interaction.
  }
  return 0;
};

export const main = async (
  arguments_: string[] = process.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<number> => {
  const [command, subcommand, client] = arguments_;
  const environment =
    dependencies.environment ?? process.env;
  // A model call the App started (a Claude Code or Codex CLI backend) records nothing of its own: its hooks do
  // nothing, and Decision's MCP server, write tools and all, does not start in it.
  if (
    (command === "hook" || command === "mcp") &&
    readDecisionEnvironment(environment, "PROVIDER_CHILD") === "1"
  ) {
    return 0;
  }
  const output = dependencies.printJson ?? printJson;
  const printError =
    dependencies.printError ??
    ((value: string) => process.stderr.write(value));

  if (command === "mcp") {
    const sourceClient = asTextCaptureClient(subcommand);
    if (sourceClient === null) {
      printError(
        "Usage: decision-bridge mcp <claude-code|codex>\n",
      );
      return 2;
    }
    (dependencies.serveMcp ?? serveDecisionMcp)({ sourceClient });
    return 0;
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

  // Where each client reads its settings: CLAUDE_CONFIG_DIR and CODEX_HOME move them, as they move
  // where `claude mcp add` and `codex mcp add` register the server.
  const userHome = dependencies.userHome ?? homedir();
  const clientPaths = {
    claudeSettingsPath: join(environment.CLAUDE_CONFIG_DIR || join(userHome, ".claude"), "settings.json"),
    codexHooksPath: join(environment.CODEX_HOME || join(userHome, ".codex"), "hooks.json"),
  };
  const bridgePath =
    dependencies.bridgePath ??
    readDecisionEnvironment(environment, "BRIDGE_PATH") ??
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
    const hooks = await detectIntegrationStatus(clientPaths, reference, process.platform);
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
        "Usage: decision-bridge install <--dry-run|--apply>\n",
      );
      return 2;
    }
    const report = await (dependencies.installer ?? installIntegrations)({
      mode: subcommand === "--apply" ? "apply" : "dry-run",
      bridgePath,
      ...clientPaths,
    });
    output(report);
    // A client not connected is a failure a script must see, though the other connected.
    return report.targets.some((target) => target.status === "failed") ? 1 : 0;
  }

  // Takes Decision out of both clients again. Only says what it would do, until asked to with --apply.
  if (command === "uninstall") {
    if (subcommand !== undefined && subcommand !== "--dry-run" && subcommand !== "--apply") {
      printError("Usage: decision-bridge uninstall [--apply]\n");
      return 2;
    }
    const report = await (dependencies.remover ?? removeIntegrations)({
      mode: subcommand === "--apply" ? "apply" : "dry-run",
      bridgePath,
      ...clientPaths,
    });
    output(report);
    return report.targets.some((target) => target.status === "failed") ? 1 : 0;
  }

  printError(
    "Usage: decision-bridge <doctor|install --dry-run|install --apply|uninstall [--apply]|mcp <claude-code|codex>|hook <post-tool-use|stop|user-prompt-submit> <claude-code|codex>>\n",
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
