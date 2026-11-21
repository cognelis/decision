import { realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ModelProviderError } from "../http-model-transport.js";
import type { ModelProviderProfile } from "@cognelis/decision-protocol";
import type { ManagedChildProcessRunner } from "./managed-child-process.js";

const SETTINGS = [
  ...["shell_tool", "unified_exec", "code_mode", "code_mode_only", "view_image", "browser_use", "computer_use", "image_generation", "multi_agent", "multi_agent_v2", "plugins", "apps", "hooks", "shell_snapshot", "goals"].map(name => `features.${name}=false`),
  "tools.web_search=false", 'web_search="disabled"', "apps._default.enabled=false", "agents.enabled=false", "memories.generate_memories=false", "mcp_servers={}", "project_doc_max_bytes=0",
];
/** Local-review Pi models must advertise no execution tools; public metadata only. */
export async function codexTextOnlyArguments(runner: Pick<ManagedChildProcessRunner, "run">, profile: ModelProviderProfile, directory: string, environment: NodeJS.ProcessEnv, signal?: AbortSignal) {
  const executable = await realpath(profile.executablePath!); await stat(executable);
  const result = await runner.run({ executable, args: [...SETTINGS.flatMap(setting => ["-c", setting]), "debug", "models", "--bundled"], cwd: directory, stdin: "", timeoutMs: 30_000, maximumStdoutBytes: 16 * 1024 * 1024, maximumStderrBytes: 16000, environment, ...(signal ? { signal } : {}) });
  const catalog = JSON.parse(result.stdout);
  if (!Array.isArray(catalog.models) || !catalog.models.length || profile.model && !catalog.models.some((model: { slug?: string }) => model.slug === profile.model)) throw new ModelProviderError("invalid_configuration", "Codex 文本模型的内置目录不可用或未包含所选模型，未执行 Pi 模型调用。");
  const path = join(directory, "text-only-models.json");
  await writeFile(path, JSON.stringify({ models: catalog.models.map((model: Record<string, unknown>) => ({ ...model, tool_mode: undefined, apply_patch_tool_type: null, node_repl_disabled: true, experimental_supported_tools: [] })) }), { mode: 0o600 });
  return ["--ignore-rules", ...SETTINGS.flatMap(setting => ["-c", setting]), "-c", `model_catalog_json=${JSON.stringify(path)}`];
}
export function assertCodexTextOnlyEvents(stdout: string) {
  for (const line of stdout.split(/\r?\n/u).filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.item?.type && !["agent_message", "reasoning", "error"].includes(event.item.type)) throw new ModelProviderError("invalid_configuration", `Codex 模型调用出现执行工具事件 ${String(event.item.type).slice(0, 80)}，已停止 Pi 调用。`);
  }
}
