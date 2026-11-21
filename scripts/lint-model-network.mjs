import { parseSync } from "rolldown/utils";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const transport = "apps/desktop/src/main/model/http-model-transport.ts";
const network = "apps/desktop/src/main/model/provider-network.ts";
const platform = "apps/desktop/src/main/pr-platform-client.ts";
const server = "apps/desktop/src/main/local-server.ts";
const bridge = "apps/bridge/src/runtime-client.ts";
const factory = "apps/desktop/src/main/index.ts";
const adapters = "apps/desktop/src/main/model/adapters/";
const httpOwners = new Set([transport, platform, bridge]);
const processOwners = new Set([
  "packages/integrations/src/install.ts", // Client setup probes, no model turns.
  "packages/integrations/src/repository-context.ts", // Local git queries.
  "apps/desktop/src/main/local-review-git.ts", // Controlled Git only; model execution stays in ManagedChildProcessRunner.
  "apps/desktop/src/main/model/cli/managed-child-process.ts",
  "apps/desktop/src/main/model/cli/cli-model-server.ts", // Keychain read only.
  "apps/desktop/src/main/semantic/apple-foundation-provider.ts",
  "apps/desktop/src/main/login-shell-path.ts",
  "apps/desktop/src/main/client-onboarding-service.ts",
]);

export function violations(path, source) {
  const failures = [];
  const parsed = parseSync(path, source);
  if (parsed.errors.length) return [`${path}: 无法解析网络边界`];
  const tree = parsed.program;
  const text = node => source.slice(node.start, node.end);
  const fail = (node, reason) => failures.push(`${path}:${source.slice(0, node.start).split("\n").length}: ${reason}`);
  const visit = (node) => {
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) && node.source) {
      const name = node.source.value;
      if (/^(?:openai|@anthropic-ai\/sdk|@ai-sdk\/|axios|node-fetch|https?-proxy-agent)/u.test(name)) fail(node, "模型 SDK/HTTP 客户端必须通过统一 Transport 接入");
      if (name === "undici" && ![transport, network, platform].includes(path)) fail(node, "禁止在网络边界之外使用 undici");
      if (/^(?:node:)?(?:http|https|http2|net|tls)$/u.test(name) && path !== server && !(["apps/desktop/src/main/local-review-command-sandbox.ts", "apps/desktop/src/main/local-review-claude-probe.ts"].includes(path) && name === "node:net")) fail(node, "禁止直接创建网络连接");
      if (/^(?:node:)?child_process$/u.test(name) && !processOwners.has(path)) fail(node, "新增子进程必须审计模型网络边界");
      if (name.endsWith("provider-network.js") && ![transport, platform, factory, "apps/desktop/src/main/model/cli/cli-adapter-support.ts", "apps/desktop/src/main/model/cli/cli-discovery.ts", "apps/desktop/src/main/model/cli/managed-child-process.ts"].includes(path)) fail(node, "业务代码不得绕过模型 Transport 创建 dispatcher");
      if (name.endsWith("openrouter-decision-client.js") && node.type === "ImportDeclaration" && node.specifiers.some(e => e.imported?.name === "OpenRouterDecisionClient") && path !== factory) fail(node, "判定 Client 只允许由 Factory 创建");
      if (/adapters\/.*-adapter\.js$/u.test(name) && path !== factory && !path.startsWith(adapters)) fail(node, "模型 Client 只允许由现有 Factory 创建");
      if (name === "@earendil-works/pi-agent-core" && path !== "apps/desktop/src/main/model/gateway-agent.ts") fail(node, "Agent 模型执行只允许通过已审计的 Gateway streamFn");
      if (name === "@earendil-works/pi-ai" && !(path.endsWith("/gateway-agent.ts") && node.type === "ExportNamedDeclaration" && node.exportKind === "type") && (!path.endsWith("/gateway-agent.ts") || node.type !== "ImportDeclaration" || node.specifiers.some(e => e.importKind !== "type" && e.imported?.name !== "createAssistantMessageEventStream"))) fail(node, "pi-ai 只允许事件流工具，模型调用必须经过 Gateway");
    }
    if (node.type === "CallExpression") {
      const name = text(node.callee);
      if (/(?:^|\.)setGlobalDispatcher$/u.test(name)) fail(node, "禁止修改全局 dispatcher");
      if (name === "require" && node.arguments.some(a => typeof a.value !== "string" || /openai|anthropic|undici|axios|(?:node:)?(?:http|https|net|tls|child_process)/u.test(a.value))) fail(node, "禁止 require 绕过网络依赖边界");
      if (/(?:^|\.)(?:fetch|proxyFetch|request|get|connect|setGlobalDispatcher)$/u.test(name) && /(?:fetch|proxyFetch|setGlobalDispatcher)$|^(?:https?|net|tls)\./u.test(name) && !httpOwners.has(path)) fail(node, "未经约束的 HTTP/网络请求");

    }
    if (node.type === "NewExpression") {
      const name = text(node.callee);
      if (/^(?:WebSocket|XMLHttpRequest|EventSource)$/u.test(name)) fail(node, "禁止业务模块直接建立模型网络连接");
      if (name === "Agent" && path !== network && path !== "apps/desktop/src/main/model/gateway-agent.ts") fail(node, "禁止业务模块直接创建网络或模型 Agent");
      if (name === "Agent" && path === "apps/desktop/src/main/model/gateway-agent.ts" && !node.arguments.some(a => a.type === "ObjectExpression" && a.properties.some(p => p.key?.name === "streamFn"))) fail(node, "Agent 必须显式使用 Gateway streamFn");
      if (name === "HttpModelTransport" && path !== transport && path !== factory && !path.startsWith(adapters) && !path.endsWith("/openrouter-decision-client.ts") && !path.endsWith("/cli-model-server.ts")) fail(node, "HTTP Transport 仅由模型 Client 创建");
      if (name === "ManagedChildProcessRunner" && path !== "apps/desktop/src/main/local-review-git.ts" && path !== "apps/desktop/src/main/local-review-command-sandbox.ts" && path !== "apps/desktop/src/main/local-review-dependencies.ts" && !node.arguments?.some(a => text(a).includes('modelNetworkPolicy: "required"'))) fail(node, "模型子进程必须启用 required 策略");
    }
    if (node.type === "Identifier" && node.name === "fetch" && !httpOwners.has(path)) fail(node, "业务模块不得持有原生 fetch");
    if (node.type === "ImportExpression" && (typeof node.source.value !== "string" || /openai|anthropic|undici|axios|node:(?:http|https|net|tls|child_process)/u.test(node.source.value))) fail(node, "动态导入网络模块必须审计");
    for (const [key, value] of Object.entries(node)) {
      if (key === "parent") continue;
      if (Array.isArray(value)) { for (const child of value) if (child?.type) visit(child); }
      else if (value?.type) visit(value);
    }
  };
  visit(tree);
  return failures;
}

export async function lintModelNetwork(root = fileURLToPath(new URL("../", import.meta.url))) {
  const failures = [];
  for (const directory of ["apps", "packages"]) {
    for (const path of await readdir(resolve(root, directory), { recursive: true })) {
      const relative = `${directory}/${path}`;
      if (!relative.includes("/src/") || !/\.[cm]?[jt]sx?$/u.test(path) || relative.includes("node_modules/")) continue;
      failures.push(...violations(relative, await readFile(resolve(root, relative), "utf8")));
    }
  }
  for (const path of ["scripts/lab/context-run.mjs", "scripts/lab/capture-run.mjs"]) {
    if (parseSync(path, await readFile(resolve(root, path), "utf8")).errors.length) failures.push(`${path}: 无法解析模型脚本`);
  }
  return failures;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = await lintModelNetwork();
  if (failures.length) { console.error(failures.join("\n")); process.exitCode = 1; }
  else console.info("模型网络依赖边界检查通过");
}
