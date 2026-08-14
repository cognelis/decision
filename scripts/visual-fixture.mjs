import { spawn } from "node:child_process";
import {
  access,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mode = process.argv[2] ?? "island";
const repositoryRoot = process.cwd();
const appPath = join(
  repositoryRoot,
  "out",
  "Decision-darwin-arm64",
  "Decision.app",
);
const executable = join(appPath, "Contents", "MacOS", "Decision");
const root = await mkdtemp(join(tmpdir(), "decision-visual-"));
const runtimeFile = join(root, "runtime.json");
const vault = join(root, "vault");
const userData = join(root, "user-data");

const child = spawn(executable, [], {
  env: {
    ...process.env,
    DECISION_SMOKE: "1",
    DECISION_VAULT_PATH: vault,
    DECISION_USER_DATA: userData,
    DECISION_RUNTIME_FILE: runtimeFile,
    ...(mode === "settings"
      ? { DECISION_START_SETTINGS: "1" }
      : {}),
  },
  stdio: ["ignore", "ignore", "inherit"],
});

const waitForRuntime = async () => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const runtime = JSON.parse(await readFile(runtimeFile, "utf8"));
      const response = await fetch(`http://127.0.0.1:${runtime.port}/health`);
      if (response.ok) {
        return runtime;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Visual fixture runtime did not start");
};

try {
  await access(executable);
  const runtime = await waitForRuntime();
  if (mode !== "settings") {
    const request = {
      protocolVersion: 1,
      question:
        mode === "island"
          ? "选择记录格式"
          : "这个功能应该采用哪种持久化方式？",
      contextSummary:
        mode === "island"
          ? "兼顾直接阅读与后续检索。"
          : "需要让决策记录既能在 Obsidian 中直接阅读，又能支持未来的检索、聚合和方法论提炼。Markdown 是事实来源，数据库只承担可重建索引。",
      options: [
        {
          id: "markdown-sqlite",
          label: "Markdown + SQLite",
          description: "兼顾人类可读、版本管理与本地全文检索。",
          tradeoffs: ["需要维护可重建索引"],
        },
        {
          id: "sqlite-only",
          label: "只用 SQLite",
          description: "结构化查询直接，但日常阅读和手工编辑不够自然。",
          tradeoffs: ["对人不够友好"],
        },
      ],
      recommendedOptionId: "markdown-sqlite",
      allowCustom: true,
      sourceClient: "codex",
      sessionId: "visual-session",
      project: "decision",
      workflow: "superpowers",
      decisionType: "architecture",
      idempotencyKey: `visual:${mode}`,
    };
    void fetch(`http://127.0.0.1:${runtime.port}/v1/decisions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${runtime.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    }).catch(() => undefined);
  }
  process.stdout.write(
    `${JSON.stringify({ ready: true, mode, appPath, root })}\n`,
  );
  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  await rm(root, { recursive: true, force: true });
}
