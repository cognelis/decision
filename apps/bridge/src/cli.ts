#!/usr/bin/env node

import { installIntegrations } from "@cognelis/decision-integrations";
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
      throw new Error("Hook input is too large");
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
  ): Promise<boolean>;
  doctor(): Promise<unknown>;
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

const persistAndDeliver = async (
  event: CapturedDecisionEvent,
  dependencies: CliDependencies,
): Promise<void> => {
  const spool =
    dependencies.spool ??
    new CaptureSpool(defaultCaptureSpoolPath(dependencies.environment));
  const runtime =
    dependencies.runtime ??
    new RuntimeClient({
      environment: dependencies.environment ?? process.env,
    });
  await spool.append(event);
  await runtime.deliver(event).catch(() => undefined);
};

const runPassivePostToolUse = async (
  client: string | undefined,
  dependencies: CliDependencies,
): Promise<number> => {
  try {
    const input = await (dependencies.readStdin ?? readStdin)();
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
    const input = await (dependencies.readStdin ?? readStdin)();
    const audit =
      dependencies.audit ??
      new CaptureAuditStore(defaultCaptureAuditPath(dependencies.environment));
    await recordAudit(audit, input, client, "hook_received");
    const fallback =
      dependencies.fallback ??
      new TextCaptureFallback({
        store: new TextCaptureStore(
          defaultTextCaptureStorePath(dependencies.environment),
        ),
        audit,
      });
    if (operation === "stop") {
      const events = await fallback.onStop(input, client);
      for (const event of events) {
        await persistAndDeliver(event, dependencies);
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
    try {
      await pairSpool.append(pair);
    } catch {
      await recordAudit(
        audit,
        input,
        client,
        "failed",
        "pair_write_failed",
      );
      return 0;
    }
    await recordAudit(audit, input, client, "pair_spooled");
    const runtime =
      dependencies.runtime ??
      new RuntimeClient({
        environment: dependencies.environment ?? process.env,
      });
    if (
      "deliverSemanticPair" in runtime &&
      typeof runtime.deliverSemanticPair === "function"
    ) {
      await runtime.deliverSemanticPair(pair).catch(async () => {
        await recordAudit(
          audit,
          input,
          client,
          "failed",
          "pair_delivery_failed",
        );
        return false;
      });
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
  if (
    command === "hook" &&
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

  if (command === "doctor") {
    const runtime =
      dependencies.runtime ??
      new RuntimeClient({ environment });
    output(await runtime.doctor());
    return 0;
  }

  if (command === "install") {
    if (subcommand !== "--dry-run" && subcommand !== "--apply") {
      printError(
        "Usage: decision-bridge install <--dry-run|--apply>\n",
      );
      return 2;
    }
    const userHome = dependencies.userHome ?? homedir();
    const report = await (dependencies.installer ?? installIntegrations)({
      mode: subcommand === "--apply" ? "apply" : "dry-run",
      bridgePath:
        dependencies.bridgePath ??
        readDecisionEnvironment(environment, "BRIDGE_PATH") ??
        process.argv[1] ??
        process.execPath,
      claudeSettingsPath: join(userHome, ".claude", "settings.json"),
      codexHooksPath: join(userHome, ".codex", "hooks.json"),
    });
    output(report);
    return 0;
  }

  printError(
    "Usage: decision-bridge <doctor|install --dry-run|install --apply|mcp <claude-code|codex>|hook <post-tool-use|stop|user-prompt-submit> <claude-code|codex>>\n",
  );
  return 2;
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
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
