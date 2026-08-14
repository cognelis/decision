import { spawn } from "node:child_process";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const repositoryRoot = process.cwd();
const appPath = join(
  repositoryRoot,
  "out",
  "Decision-darwin-arm64",
  "Decision.app",
);
const executable = join(
  appPath,
  "Contents",
  "MacOS",
  "Decision",
);
const bridge = join(
  appPath,
  "Contents",
  "Resources",
  "bridge",
  "decision-bridge",
);
const foundationHelper = join(
  appPath,
  "Contents",
  "Resources",
  "semantic",
  "decision-foundation-model-helper",
);
const liquidGlassAddon = join(
  appPath,
  "Contents",
  "Resources",
  "native",
  "decision-liquid-glass.node",
);

const waitFor = async (operation, description, timeout = 20_000) => {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result !== undefined && result !== false) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `${description} timed out${
      lastError instanceof Error ? `: ${lastError.message}` : ""
    }`,
  );
};

const runJsonProcess = (
  command,
  arguments_,
  payload,
  environment,
) =>
  new Promise((resolve, reject) => {
    const hook = spawn(command, arguments_, {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    hook.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    hook.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    hook.once("error", reject);
    hook.once("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
    hook.stdin.end(JSON.stringify(payload));
  });

const runHook = (arguments_, payload, environment) =>
  runJsonProcess(
    bridge,
    arguments_,
    payload,
    environment,
  );

const runMcpConsultation = async (environment) => {
  const server = spawn(bridge, ["mcp", "codex"], {
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  const stderr = [];
  let buffer = "";
  let feedbackToken = "";
  server.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  server.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    while (buffer.includes("\n")) {
      const newline = buffer.indexOf("\n");
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length === 0) {
        continue;
      }
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve !== undefined) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  });

  const request = (id, method, params = {}) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`packaged MCP ${method} timed out`));
      }, 5_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      server.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });

  try {
    const initialized = await request(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "packaged-smoke", version: "1.0.0" },
    });
    if (initialized.error !== undefined) {
      throw new Error(
        `packaged MCP initialize failed: ${JSON.stringify(initialized.error)}`,
      );
    }
    server.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      })}\n`,
    );
    const listed = await request(2, "tools/list");
    const tool = listed.result?.tools?.find(
      (candidate) => candidate.name === "consult_decision_principles",
    );
    const feedbackTool = listed.result?.tools?.find(
      (candidate) =>
        candidate.name === "record_decision_consultation_feedback",
    );
    if (
      tool === undefined ||
      tool.annotations?.readOnlyHint !== true ||
      tool.annotations?.destructiveHint !== false
    ) {
      throw new Error("packaged MCP did not advertise the read-only consultation tool");
    }
    if (
      feedbackTool === undefined ||
      feedbackTool.annotations?.readOnlyHint !== false ||
      feedbackTool.annotations?.destructiveHint !== false
    ) {
      throw new Error("packaged MCP did not advertise anonymous consultation feedback");
    }
    const called = await request(3, "tools/call", {
      name: "consult_decision_principles",
      arguments: {
        question: "打包版本发布前是否需要先核对兼容边界？",
        options: [
          { label: "先核对" },
          { label: "直接发布" },
        ],
        context: "这是读取本地已采纳原则的只读冒烟测试。",
      },
    });
    if (
      called.result?.structuredContent?.availability !== "available" ||
      !["matched", "no_match"].includes(
        called.result?.structuredContent?.consultation?.status,
      )
    ) {
      throw new Error(
        `packaged MCP consultation failed: ${JSON.stringify(called)}`,
      );
    }
    feedbackToken =
      called.result?.structuredContent?.consultation?.feedback?.token ?? "";
    if (feedbackToken.length === 0) {
      throw new Error("packaged MCP consultation omitted its anonymous receipt");
    }
    const rated = await request(4, "tools/call", {
      name: "record_decision_consultation_feedback",
      arguments: { token: feedbackToken, rating: "helpful" },
    });
    if (rated.result?.structuredContent?.feedback?.status !== "accepted") {
      throw new Error(
        `packaged MCP consultation feedback failed: ${JSON.stringify(rated)}`,
      );
    }
  } finally {
    server.stdin.end();
    server.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => server.once("close", resolve)),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
  }

  if (stderr.length !== 0) {
    throw new Error(
      `packaged MCP wrote to stderr: ${Buffer.concat(stderr).toString("utf8")}`,
    );
  }
  return feedbackToken;
};

const root = await mkdtemp(join(tmpdir(), "decision-packaged-smoke-"));
const vault = join(root, "vault");
const userData = join(root, "user-data");
const runtimeFile = join(root, "runtime.json");
const databasePath = join(userData, "index.sqlite");
const consultationMetricsPath = join(
  userData,
  "decision-consultation-metrics.json",
);
const spoolPath = join(userData, "capture-spool");
const semanticPairSpoolPath = join(
  userData,
  "semantic-pair-spool",
);
const captureAuditPath = join(userData, "capture-audit");
const candidateSpoolPath = join(userData, "candidate-spool");
const textPendingPath = join(userData, "text-pending");
const transcriptPath = join(root, "session.jsonl");
const unrelatedTranscriptLine = "smoke unrelated private line";
const taskBackground = "继续打包验证 Decision。";
const decisionFraming =
  "规则方案便于解释，本地模型可以在积累语料后接入。";
let child;
let succeeded = false;

try {
  await access(executable);
  await access(bridge);
  await access(foundationHelper);
  await access(liquidGlassAddon);
  const bundleFiles = await readdir(appPath, {
    recursive: true,
  });
  if (
    bundleFiles.some((entry) =>
      String(entry).toLowerCase().endsWith(".gguf"),
    )
  ) {
    throw new Error("GGUF model weights must not be bundled in the app");
  }
  const helperStatus = await runJsonProcess(
    foundationHelper,
    [],
    { id: "smoke-status", operation: "status" },
    process.env,
  );
  if (
    helperStatus.code !== 0 ||
    helperStatus.stderr.length !== 0
  ) {
    throw new Error(
      `Foundation Models helper failed: ${JSON.stringify(helperStatus)}`,
    );
  }
  const helperResponse = JSON.parse(helperStatus.stdout.trim());
  if (
    helperResponse.id !== "smoke-status" ||
    helperResponse.ok !== true ||
    typeof helperResponse.status !== "string"
  ) {
    throw new Error("Foundation Models helper status is invalid");
  }
  await writeFile(
    transcriptPath,
    [
      JSON.stringify({
        message: {
          role: "user",
          content: [
            { type: "text", text: unrelatedTranscriptLine },
          ],
        },
      }),
      JSON.stringify({
        message: {
          role: "user",
          content: [{ type: "text", text: taskBackground }],
        },
      }),
      JSON.stringify({
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text:
                `${decisionFraming}\n\n` +
                "两仓仍未提交。是先处理本次技术债，还是先提交当前这批？",
            },
          ],
        },
      }),
    ].join("\n"),
    "utf8",
  );
  const appEnvironment = {
    ...process.env,
    DECISION_SMOKE: "1",
    DECISION_VAULT_PATH: vault,
    DECISION_USER_DATA: userData,
    DECISION_RUNTIME_FILE: runtimeFile,
    DECISION_CAPTURE_SPOOL: spoolPath,
  };
  child = spawn(executable, [], {
    env: appEnvironment,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const errors = [];
  child.stderr.on("data", (chunk) => errors.push(Buffer.from(chunk)));
  child.once("exit", (code) => {
    if (code !== 0 && !succeeded) {
      const detail = Buffer.concat(errors).toString("utf8").trim();
      process.stderr.write(
        `Packaged app exited early (${code ?? "signal"})${
          detail.length === 0 ? "" : `: ${detail}`
        }\n`,
      );
    }
  });

  const runtime = await waitFor(async () => {
    const parsed = JSON.parse(await readFile(runtimeFile, "utf8"));
    const response = await fetch(`http://127.0.0.1:${parsed.port}/health`);
    return response.ok ? parsed : undefined;
  }, "runtime health");
  const headers = {
    authorization: `Bearer ${runtime.token}`,
    "content-type": "application/json",
  };
  const hookEnvironment = {
    ...process.env,
    DECISION_RUNTIME_FILE: runtimeFile,
    DECISION_CAPTURE_SPOOL: spoolPath,
    DECISION_TEXT_PENDING: textPendingPath,
  };
  const feedbackToken = await runMcpConsultation(hookEnvironment);
  const consultationMetricsRaw = await waitFor(
    () => readFile(consultationMetricsPath, "utf8"),
    "content-free consultation metrics",
  );
  const consultationMetrics = JSON.parse(consultationMetricsRaw);
  if (
    consultationMetrics.requests !== 1 ||
    consultationMetrics.byClient?.codex !== 1 ||
    consultationMetrics.privacy?.storesQuestionText !== false ||
    consultationMetrics.privacy?.storesOptionText !== false ||
    consultationMetrics.privacy?.storesPrincipleIds !== false ||
    consultationMetrics.privacy?.storesFeedbackTokens !== false ||
    consultationMetrics.privacy?.storesIndividualEvents !== false ||
    consultationMetrics.feedback?.total !== 1 ||
    consultationMetrics.feedback?.helpful !== 1 ||
    consultationMetrics.feedback?.bySource?.codex !== 1 ||
    consultationMetricsRaw.includes("打包版本发布前") ||
    consultationMetricsRaw.includes("先核对") ||
    consultationMetricsRaw.includes(feedbackToken)
  ) {
    throw new Error("consultation metrics retained content or invalid counters");
  }
  const providerChildArtifactSnapshot = async () =>
    Object.fromEntries(
      await Promise.all(
        [
          ["capture-spool", spoolPath],
          ["semantic-pair-spool", semanticPairSpoolPath],
          ["candidate-spool", candidateSpoolPath],
          [
            "markdown",
            join(vault, "Decision Journal", "decisions"),
          ],
        ].map(async ([name, path]) => [
          name,
          (
            await readdir(path, {
              recursive: true,
            }).catch(() => [])
          )
            .map(String)
            .sort(),
        ]),
      ),
    );
  const beforeProviderChild =
    await providerChildArtifactSnapshot();
  const providerChildResults = await Promise.all([
    runHook(
      ["hook", "stop", "codex"],
      { private: "provider child smoke input" },
      {
        ...hookEnvironment,
        DECISION_PROVIDER_CHILD: "1",
      },
    ),
    runHook(
      ["hook", "user-prompt-submit", "claude-code"],
      { private: "provider child smoke input" },
      {
        ...hookEnvironment,
        DECISION_PROVIDER_CHILD: "1",
      },
    ),
    runHook(
      ["hook", "post-tool-use", "claude-code"],
      { private: "provider child smoke input" },
      {
        ...hookEnvironment,
        DECISION_PROVIDER_CHILD: "1",
      },
    ),
  ]);
  for (const result of providerChildResults) {
    if (
      result.code !== 0 ||
      result.stdout.length !== 0 ||
      result.stderr.length !== 0
    ) {
      throw new Error(
        `provider child hook was not silent: ${JSON.stringify(result)}`,
      );
    }
  }
  const afterProviderChild =
    await providerChildArtifactSnapshot();
  if (
    JSON.stringify(afterProviderChild) !==
    JSON.stringify(beforeProviderChild)
  ) {
    throw new Error(
      "provider child hook created recursive capture artifacts",
    );
  }
  const hookResults = [
    await runHook(
      ["hook", "stop", "claude-code"],
      {
        session_id: "packaged-smoke",
        turn_id: "question-turn",
        cwd: repositoryRoot,
        transcript_path: transcriptPath,
      },
      hookEnvironment,
    ),
    await runHook(
      ["hook", "user-prompt-submit", "claude-code"],
      {
        session_id: "packaged-smoke",
        turn_id: "answer-turn",
        cwd: repositoryRoot,
        prompt: "先处理本次技术债。",
      },
      hookEnvironment,
    ),
  ];
  for (const result of hookResults) {
    if (
      result.code !== 0 ||
      result.stdout.length !== 0 ||
      result.stderr.length !== 0
    ) {
      throw new Error(
        `passive hook was not silent: ${JSON.stringify(result)}`,
      );
    }
  }
  await waitFor(async () => {
    const receipts = await readdir(
      join(semanticPairSpoolPath, "receipts"),
    ).catch(() => []);
    return receipts.some((name) => name.endsWith(".ack"));
  }, "semantic pair spool acknowledgement");
  const semanticAudit = await waitFor(async () => {
    const filenames = await readdir(
      join(captureAuditPath, "items"),
    ).catch(() => []);
    const receipts = await Promise.all(
      filenames
        .filter((name) => name.endsWith(".json"))
        .map(async (name) =>
          JSON.parse(
            await readFile(
              join(captureAuditPath, "items", name),
              "utf8",
            ),
          ),
        ),
    );
    return receipts.find(
      (receipt) =>
        receipt.stage === "classification_completed" &&
        receipt.modelBand === "unavailable" &&
        (receipt.finalBand === "high" ||
          receipt.finalBand === "medium"),
    );
  }, "provider-unavailable semantic route");
  if (semanticAudit === undefined) {
    throw new Error(
      "provider-unavailable semantic pair did not reach at least medium",
    );
  }
  const decisionDirectory = join(
    vault,
    "Decision Journal",
    "decisions",
  );
  const notesBeforeRationale = await readdir(decisionDirectory, {
    recursive: true,
  }).catch(() => []);
  if (
    notesBeforeRationale.some((name) =>
      String(name).endsWith(".md"),
    )
  ) {
    throw new Error(
      "Markdown was written before rationale submission",
    );
  }
  await waitFor(async () => {
    const response = await fetch(
      `http://127.0.0.1:${runtime.port}/v1/smoke/complete`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          status: "captured",
          rationale: "打包后的完整链路通过。",
        }),
      },
    );
    return response.status === 204 ? true : undefined;
  }, "smoke completion");

  const notePath = await waitFor(async () => {
    const entries = await readdir(decisionDirectory, {
      recursive: true,
      withFileTypes: true,
    });
    const markdown = entries.find(
      (entry) => entry.isFile() && entry.name.endsWith(".md"),
    );
    return markdown === undefined ? undefined : join(markdown.parentPath, markdown.name);
  }, "Markdown decision note");
  const markdown = await readFile(notePath, "utf8");
  if (
    !markdown.includes(
      "是先处理本次技术债，还是先提交当前这批？",
    ) ||
    !markdown.includes("打包后的完整链路通过。") ||
    !markdown.includes("先处理本次技术债。") ||
    !markdown.includes("### 任务背景") ||
    !markdown.includes(taskBackground) ||
    !markdown.includes("### 约束与考虑") ||
    !markdown.includes(decisionFraming) ||
    !markdown.includes('capture_mode: "transcript"') ||
    markdown.includes(unrelatedTranscriptLine)
  ) {
    throw new Error(
      "Markdown note does not contain the bounded contextual capture",
    );
  }

  const structuredCapture = {
    eventVersion: 1,
    captureMode: "structured_tool",
    sourceClient: "codex",
    sessionId: "packaged-structured-smoke",
    turnId: "structured-answer",
    sourceEventId: "structured-tool-1",
    toolUseId: "structured-tool-1",
    batchId: "packaged-structured-smoke:structured-tool-1",
    project: "decision",
    cwd: repositoryRoot,
    capturedAt: new Date().toISOString(),
    questions: [
      {
        questionIndex: 0,
        question: "结构化捕获是否保持原有行为？",
        options: [
          { id: "yes", label: "保持" },
          { id: "no", label: "改变" },
        ],
        answer: {
          kind: "preset",
          values: ["保持"],
        },
        multiSelect: false,
      },
    ],
  };
  const structuredResponse = await fetch(
    `http://127.0.0.1:${runtime.port}/v1/captures`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(structuredCapture),
    },
  );
  if (structuredResponse.status !== 202) {
    throw new Error(
      `structured capture failed with ${structuredResponse.status}`,
    );
  }
  await waitFor(async () => {
    const response = await fetch(
      `http://127.0.0.1:${runtime.port}/v1/smoke/complete`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          status: "captured",
          rationale: "结构化链路保持不变。",
        }),
      },
    );
    return response.status === 204 ? true : undefined;
  }, "structured rationale completion");
  const notes = await waitFor(async () => {
    const entries = await readdir(decisionDirectory, {
      recursive: true,
      withFileTypes: true,
    });
    const markdownEntries = entries.filter(
      (entry) => entry.isFile() && entry.name.endsWith(".md"),
    );
    return markdownEntries.length === 2
      ? Promise.all(
          markdownEntries.map((entry) =>
            readFile(
              join(entry.parentPath, entry.name),
              "utf8",
            ),
          ),
        )
      : undefined;
  }, "structured Markdown decision note");
  if (
    !notes.some(
      (note) =>
        note.includes("结构化捕获是否保持原有行为？") &&
        note.includes("结构化链路保持不变。") &&
        note.includes('capture_mode: "structured_tool"'),
    )
  ) {
    throw new Error("structured capture behavior changed");
  }

  const database = new DatabaseSync(databasePath, { readOnly: true });
  const row = database
    .prepare("SELECT count(*) AS count FROM decisions")
    .get();
  database.close();
  if (Number(row.count) !== 2) {
    throw new Error("SQLite index does not contain exactly two decisions");
  }
  const pendingBodies = (
    await Promise.all(
      ["events", "dispositions"].map((directory) =>
        readdir(join(spoolPath, directory)).catch(() => []),
      ),
    )
  ).flat();
  if (pendingBodies.some((name) => name.endsWith(".json"))) {
    throw new Error(
      "capture spool still contains an event or disposition body",
    );
  }

  child.kill("SIGTERM");
  await waitFor(
    async () => (child.exitCode === null ? undefined : true),
    "application shutdown",
  );
  await waitFor(async () => {
    try {
      await access(runtimeFile);
      return undefined;
    } catch {
      return true;
    }
  }, "runtime cleanup");
  await Promise.all(
    [
      databasePath,
      `${databasePath}-shm`,
      `${databasePath}-wal`,
    ].map((path) => rm(path, { force: true })),
  );
  child = spawn(executable, [], {
    env: appEnvironment,
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) =>
    errors.push(Buffer.from(chunk)),
  );
  await waitFor(async () => {
    const parsed = JSON.parse(await readFile(runtimeFile, "utf8"));
    const response = await fetch(
      `http://127.0.0.1:${parsed.port}/health`,
    );
    return response.ok ? parsed : undefined;
  }, "rebuild runtime health");
  await waitFor(async () => {
    try {
      const rebuilt = new DatabaseSync(databasePath, {
        readOnly: true,
      });
      const rebuiltRow = rebuilt
        .prepare("SELECT count(*) AS count FROM decisions")
        .get();
      rebuilt.close();
      return Number(rebuiltRow.count) === 2;
    } catch {
      return undefined;
    }
  }, "SQLite rebuild from Markdown");
  child.kill("SIGTERM");
  await waitFor(
    async () => (child.exitCode === null ? undefined : true),
    "rebuilt application shutdown",
  );
  await waitFor(async () => {
    try {
      await access(runtimeFile);
      return undefined;
    } catch {
      return true;
    }
  }, "rebuilt runtime cleanup");
  succeeded = true;
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      appPath,
      bridge,
      markdown: true,
      sqlite: true,
      sqliteRebuiltFromMarkdown: true,
      spoolEmpty: true,
      hybridHooksSilent: true,
      preDecisionConsultation: true,
      contentFreeConsultationMetrics: true,
      anonymousConsultationFeedback: true,
      rawPairSpooled: true,
      semanticFallbackCaptured: true,
      providerUnavailableRuleFallback: true,
      providerChildRecursionGuard: true,
      structuredCapture: true,
      markdownAfterRationale: true,
      foundationHelperStatus: helperResponse.status,
      liquidGlassAddon: true,
      modelWeightsBundled: false,
      transcriptPrivacy: true,
      contextualCapture: true,
      runtimeCleanup: true,
    })}\n`,
  );
} finally {
  if (child !== undefined && child.exitCode === null) {
    child.kill("SIGTERM");
  }
  if (succeeded) {
    await rm(root, { recursive: true, force: true });
  } else {
    process.stderr.write(`Smoke artifacts kept at ${root}\n`);
  }
}
