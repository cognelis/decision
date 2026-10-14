import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { LocalModelClientStatus } from "@cognelis/decision-protocol";
import { HttpModelTransport } from "../http-model-transport.js";
import type { LocalModelClient } from "./cli-discovery.js";

const tokenSchema = z.string().min(1).max(32_000).regex(/^[^\s\x00-\x1f\x7f]+$/u);
const text = z.string().trim().min(1).max(200);
const execFileAsync = promisify(execFile);
const readCredentialFile = async (path: string): Promise<unknown> => {
  if (!isAbsolute(path) || (await stat(path)).size > 128 * 1024) return undefined;
  const data = await readFile(path, "utf8");
  if (Buffer.byteLength(data) > 128 * 1024) return undefined;
  return JSON.parse(data);
};

/** Read only access tokens; no copying, renewal, persistence or changes to CLI accounts. */
export const readCliCatalogCredential = async (client: LocalModelClient, environment: NodeJS.ProcessEnv): Promise<{ token: string; accountId?: string } | undefined> => {
  const home = environment.HOME || environment.USERPROFILE;
  const directory = client === "codex" ? environment.CODEX_HOME || (home ? join(home, ".codex") : undefined) : environment.CLAUDE_CONFIG_DIR || (home ? join(home, ".claude") : undefined);
  if (!directory || !isAbsolute(directory)) return undefined;
  try {
    let credentials: unknown;
    if (client === "codex") {
      if (environment.OPENAI_API_KEY || environment.CODEX_API_KEY) return undefined;
      credentials = await readCredentialFile(join(directory, "auth.json"));
      const auth = z.object({ auth_mode: z.literal("chatgpt").optional(), tokens: z.object({ access_token: tokenSchema, account_id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u).optional() }) }).parse(credentials);
      return { token: auth.tokens.access_token, ...(auth.tokens.account_id ? { accountId: auth.tokens.account_id } : {}) };
    }
    // Do not mix saved subscription credentials with API-key or third-party CLI sessions.
    if (environment.ANTHROPIC_API_KEY || ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"].some(name => environment[name] === "1")) return undefined;
    if (environment.ANTHROPIC_BASE_URL && new URL(environment.ANTHROPIC_BASE_URL).origin !== "https://api.anthropic.com") return undefined;
    if (environment.CLAUDE_CODE_OAUTH_TOKEN) return { token: tokenSchema.parse(environment.CLAUDE_CODE_OAUTH_TOKEN) };
    try { credentials = await readCredentialFile(join(directory, ".credentials.json")); } catch { /* macOS normally uses Keychain instead. */ }
    if (credentials === undefined && process.platform === "darwin" && (!environment.CLAUDE_CONFIG_DIR || (home !== undefined && directory === join(home, ".claude")))) {
      const result = await execFileAsync("/usr/bin/security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8", timeout: 1_500, maxBuffer: 128 * 1024 });
      credentials = JSON.parse(result.stdout);
    }
    return { token: z.object({ claudeAiOauth: z.object({ accessToken: tokenSchema }) }).parse(credentials).claudeAiOauth.accessToken };
  } catch { return undefined; }
};

/** Only fixed official endpoints receive a token; redirects and raw failure bodies never escape. */
export const queryCliServerModels = async (
  client: LocalModelClient,
  environment: NodeJS.ProcessEnv,
  transport: Pick<HttpModelTransport, "getJson"> = new HttpModelTransport(environment),
  clientVersion?: string,
): Promise<NonNullable<LocalModelClientStatus["models"]> | undefined> => {
  try {
    if (client === "codex" && (!clientVersion || !/^\d+\.\d+\.\d+$/u.test(clientVersion))) return undefined;
    const credential = await readCliCatalogCredential(client, environment);
    if (!credential) return undefined;
    const { token, accountId } = credential;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json", "Cache-Control": "no-cache, no-store", Pragma: "no-cache" };
    if (client === "claude-code") Object.assign(headers, { "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20" });
    // Native CLI OAuth is scoped for Codex's catalog, not the public API model-list route.
    if (client === "codex") Object.assign(headers, { originator: "decision_model_catalog", "User-Agent": `decision_model_catalog/${clientVersion}`, ...(accountId ? { "ChatGPT-Account-ID": accountId } : {}) });
    const endpoint = client === "codex" ? "https://chatgpt.com/backend-api/codex/models" : "https://api.anthropic.com/v1/models";
    const models = new Map<string, { id: string; label: string }>();
    let cursor: string | undefined;
    const deadline = Date.now() + 4_000;
    for (let page = 0; page < 10; page++) {
      const url = new URL(endpoint);
      if (client === "codex") url.searchParams.set("client_version", clientVersion!);
      if (client === "claude-code") { url.searchParams.set("limit", "100"); if (cursor) url.searchParams.set("after_id", cursor); }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;
      const response = await transport.getJson({ url: url.toString(), headers, timeoutMs: remaining, maximumResponseBytes: 1024 * 1024, secrets: [token, ...(accountId ? [accountId] : [])] });
      if (client === "codex") {
        const catalog = z.object({ models: z.array(z.unknown()).max(1000) }).parse(response.json);
        for (const item of catalog.models) {
          const model = z.object({ slug: text, display_name: text, visibility: z.literal("list") }).safeParse(item);
          if (model.success && !models.has(model.data.slug)) models.set(model.data.slug, { id: model.data.slug, label: model.data.display_name });
        }
        break;
      }
      const catalog = z.object({ data: z.array(z.unknown()).max(1000), has_more: z.boolean(), last_id: text.nullable().optional() }).parse(response.json);
      for (const item of catalog.data) {
        const model = z.object({ id: text, display_name: text, lifecycle: z.string().optional() }).safeParse(item);
        if (model.success && model.data.lifecycle !== "retired" && !models.has(model.data.id)) models.set(model.data.id, { id: model.data.id, label: model.data.display_name });
      }
      if (!catalog.has_more || models.size >= 100) break;
      if (!catalog.last_id || catalog.last_id === cursor || page === 9) return undefined;
      cursor = catalog.last_id;
    }
    const found = [...models.values()].slice(0, 100);
    return found.length ? found : undefined;
  } catch { return undefined; }
};
