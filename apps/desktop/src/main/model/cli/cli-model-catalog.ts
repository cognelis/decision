import { queryCliServerModels } from "./cli-model-server.js";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { LocalModelClientStatus } from "@cognelis/decision-protocol";
import { atomicWrite } from "../../atomic-write.js";
import type { LocalModelClient } from "./cli-discovery.js";
import type { ManagedProcessRequest, ManagedProcessResult } from "./managed-child-process.js";

type Models = NonNullable<LocalModelClientStatus["models"]>;
const text = z.string().trim().min(1).max(200);
const candidates = z.array(z.object({ id: text, label: text }).strict()).max(100);
const wire = (value: unknown): string => `${JSON.stringify(value)}\n`;
const readCache = async (path: string): Promise<unknown> => {
  if ((await stat(path)).size > 4 * 1024 * 1024) throw new Error("Catalog too large");
  const content = await readFile(path, "utf8");
  if (Buffer.byteLength(content) > 4 * 1024 * 1024) throw new Error("Catalog too large");
  return JSON.parse(content);
};

// shortcut: unsupported server credentials fall back to CLI catalogs, never force renewal of CLI tokens.
/** Only candidate names are retained, never initialization account details or client instructions. */
export const queryCliModels = async (
  client: LocalModelClient,
  request: Omit<ManagedProcessRequest, "args" | "stdin" | "conversation">,
  runner: { run(request: ManagedProcessRequest): Promise<ManagedProcessResult> },
  cacheDirectory?: string,
  online = true,
  clientVersion?: string,
): Promise<{ models: Models; modelsSource?: "server" | "client" | "cache" }> => {
  const environment = request.environment;
  const home = environment.CODEX_HOME || (environment.HOME || environment.USERPROFILE ? join((environment.HOME || environment.USERPROFILE)!, ".codex") : undefined);
  const key = createHash("sha256").update(JSON.stringify([client, request.executable, home, environment.CLAUDE_CONFIG_DIR, environment.HTTPS_PROXY, environment.HTTP_PROXY])).digest("hex");
  const cache = cacheDirectory ? join(cacheDirectory, `${key}.json`) : undefined;
  try {
    if (!online) throw new Error("Client unavailable");
    const serverModels = await queryCliServerModels(client, environment, undefined, clientVersion);
    if (serverModels?.length) {
      if (cache) await atomicWrite(cache, JSON.stringify(serverModels)).catch(() => undefined);
      return { models: serverModels, modelsSource: "server" };
    }
    let initialized = false;
    let cursor: string | undefined;
    let responseId = 2;
    let offset = 0;
    let done = false;
    const models = new Map<string, { id: string; label: string }>();
    const conversation: NonNullable<ManagedProcessRequest["conversation"]> = (stdout) => {
      let input = "";
      const end = stdout.lastIndexOf("\n") + 1;
      for (const line of stdout.slice(offset, end).split("\n").filter(Boolean)) {
        const message = z.record(z.string(), z.unknown()).parse(JSON.parse(line));
        if (client === "codex") {
          if (message.id === 1 && !initialized) {
            if (message.error || !message.result) throw new Error("Initialization failed");
            initialized = true;
            input += wire({ method: "initialized" }) + wire({ id: responseId, method: "model/list", params: { limit: 100, includeHidden: false } });
          } else if (message.id === responseId && initialized) {
            if (message.error) throw new Error("Catalog failed");
            const page = z.object({ data: z.array(z.unknown()).max(500), nextCursor: z.string().max(2_000).nullable().optional() }).parse(message.result);
            for (const value of page.data) {
              const model = z.object({ model: text, displayName: text, hidden: z.boolean().optional() }).safeParse(value);
              if (model.success && !model.data.hidden) models.set(model.data.model, { id: model.data.model, label: model.data.displayName });
            }
            if (page.nextCursor && models.size < 100) {
              if (cursor === page.nextCursor || responseId >= 12) throw new Error("Invalid catalog pagination");
              cursor = page.nextCursor;
              input += wire({ id: ++responseId, method: "model/list", params: { limit: 100, includeHidden: false, cursor } });
            } else done = true;
          }
        } else if (message.type === "control_response") {
          const response = z.object({ request_id: z.string(), subtype: z.string(), response: z.unknown().optional() }).parse(message.response);
          if (response.request_id !== "catalog-init") continue;
          if (response.subtype !== "success") throw new Error("Initialization failed");
          const catalog = z.object({ models: z.array(z.unknown()).max(500) }).parse(response.response);
          for (const value of catalog.models) {
            const model = z.object({ value: text, displayName: text }).safeParse(value);
            if (model.success) models.set(model.data.value, { id: model.data.value, label: model.data.displayName });
          }
          done = true;
        }
      }
      offset = end;
      return { input, complete: done };
    };
    const result = await runner.run({
      ...request,
      timeoutMs: 8_000,
      maximumStdoutBytes: 1024 * 1024,
      args: client === "codex" ? ["app-server", "--listen", "stdio://"] : ["-p", "--safe-mode", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-session-persistence", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
      stdin: client === "codex" ? wire({ id: 1, method: "initialize", params: { clientInfo: { name: "decision_model_catalog", title: "Decision", version: "1.0.0" } } }) : wire({ type: "control_request", request_id: "catalog-init", request: { subtype: "initialize" } }),
      conversation,
    });
    conversation(result.stdout);
    const found = candidates.parse([...models.values()].slice(0, 100));
    if (!done || !found.length) throw new Error("Empty catalog");
    if (cache) await atomicWrite(cache, JSON.stringify(found)).catch(() => undefined);
    return { models: found, modelsSource: "client" };
  } catch {
    if (cache) {
      try { const models = candidates.parse(await readCache(cache)); if (models.length) return { models, modelsSource: "cache" }; } catch { /* Try the client's own cache next. */ }
    }
    if (client === "codex" && home && isAbsolute(home)) {
      try {
        const document = z.object({ models: z.array(z.unknown()).max(500) }).parse(await readCache(join(home, "models_cache.json")));
        const entries = document.models.flatMap(value => {
          const model = z.object({ slug: text, display_name: text.optional(), visibility: z.literal("list"), priority: z.number().finite().optional() }).safeParse(value);
          return model.success ? [model.data] : [];
        }).sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity));
        const unique = new Map<string, { id: string; label: string }>();
        for (const model of entries) if (!unique.has(model.slug)) unique.set(model.slug, { id: model.slug, label: model.display_name ?? model.slug });
        const models = [...unique.values()].slice(0, 100);
        if (models.length) return { models, modelsSource: "cache" };
      } catch { /* Manual entry and the client default remain available. */ }
    }
    return { models: [] };
  }
};
