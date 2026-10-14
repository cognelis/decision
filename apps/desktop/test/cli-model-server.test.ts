import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryCliServerModels, readCliCatalogCredential } from "../src/main/model/cli/cli-model-server.js";
import type { HttpModelResponse, HttpModelTransport } from "../src/main/model/http-model-transport.js";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const directory = async () => { const path = await mkdtemp(join(tmpdir(), "decision-catalog-auth-")); directories.push(path); return path; };
const response = (json: unknown): HttpModelResponse => ({ status: 200, headers: {}, json });

describe("server model catalog", () => {
  it("reads Codex access token from the configured home, ignoring refresh tokens", async () => {
    const path = await directory();
    await writeFile(join(path, "auth.json"), JSON.stringify({ tokens: { access_token: "fake-access", account_id: "account-test", refresh_token: "never-use-refresh" } }));
    expect(await readCliCatalogCredential("codex", { CODEX_HOME: path })).toEqual({ token: "fake-access", accountId: "account-test" });
    const getJson = vi.fn<HttpModelTransport["getJson"]>(async () => response({ models: [{ slug: "latest", display_name: "Latest", visibility: "list", instructions: "private" }, { slug: "hidden", display_name: "Hidden", visibility: "hide" }] }));
    expect(await queryCliServerModels("codex", { CODEX_HOME: path }, { getJson }, "0.161.0")).toEqual([{ id: "latest", label: "Latest" }]);
    expect(getJson.mock.calls[0]?.[0]).toMatchObject({ url: "https://chatgpt.com/backend-api/codex/models?client_version=0.161.0", headers: { Authorization: "Bearer fake-access", "Cache-Control": "no-cache, no-store", "ChatGPT-Account-ID": "account-test", originator: "decision_model_catalog" }, secrets: ["fake-access", "account-test"] });
    expect(JSON.stringify(getJson.mock.calls)).not.toContain("never-use-refresh");
  });

  it("does not send Codex credentials without a valid CLI version, or with unsafe account metadata", async () => {
    const path = await directory();
    await writeFile(join(path, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "fake-access", account_id: "account-test" } }));
    const getJson = vi.fn();
    for (const version of [undefined, "0.161.0&redirect=https://other.invalid", "latest"]) {
      expect(await queryCliServerModels("codex", { CODEX_HOME: path }, { getJson }, version)).toBeUndefined();
    }
    expect(getJson).not.toHaveBeenCalled();
    for (const account of ["bad\r\nHeader: injected", "x".repeat(201)]) {
      await writeFile(join(path, "auth.json"), JSON.stringify({ tokens: { access_token: "fake-access", account_id: account } }));
      expect(await queryCliServerModels("codex", { CODEX_HOME: path }, { getJson }, "0.161.0")).toBeUndefined();
    }
    expect(getJson).not.toHaveBeenCalled();
    await writeFile(join(path, "auth.json"), JSON.stringify({ auth_mode: "api_key", tokens: { access_token: "fake-access" } }));
    expect(await readCliCatalogCredential("codex", { CODEX_HOME: path })).toBeUndefined();
  });

  it("reads Claude credential files and paginates official server models only", async () => {
    const path = await directory();
    await writeFile(join(path, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fake-access", refreshToken: "never-use-refresh" } }));
    expect(await readCliCatalogCredential("claude-code", { CLAUDE_CONFIG_DIR: path })).toEqual({ token: "fake-access" });
    const getJson = vi.fn().mockResolvedValueOnce(response({ data: [{ id: "latest", display_name: "Latest" }, { id: "retired", display_name: "Retired", lifecycle: "retired" }], has_more: true, last_id: "latest" }))
      .mockResolvedValueOnce(response({ data: [{ id: "next", display_name: "Next" }], has_more: false }));
    const models = await queryCliServerModels("claude-code", { CLAUDE_CONFIG_DIR: path }, { getJson });
    expect(models).toEqual([{ id: "latest", label: "Latest" }, { id: "next", label: "Next" }]);
    expect(getJson.mock.calls[0]?.[0]).toMatchObject({ url: "https://api.anthropic.com/v1/models?limit=100", headers: { Authorization: "Bearer fake-access", "anthropic-beta": "oauth-2025-04-20" } });
    expect(getJson.mock.calls[1]?.[0].url).toBe("https://api.anthropic.com/v1/models?limit=100&after_id=latest");
  });

  it.each(["bad JSON", JSON.stringify({ tokens: { access_token: "fake\r\nInjected: bad" } }), "x".repeat(129 * 1024)])("rejects unsafe or malformed credentials without a request", async content => {
    const path = await directory(); await writeFile(join(path, "auth.json"), content);
    const getJson = vi.fn();
    expect(await queryCliServerModels("codex", { CODEX_HOME: path }, { getJson }, "0.161.0")).toBeUndefined();
    expect(getJson).not.toHaveBeenCalled();
  });

  it("does not look up the default account for custom/relative homes or third-party Claude endpoints", async () => {
    expect(await readCliCatalogCredential("codex", { CODEX_HOME: "relative" })).toBeUndefined();
    expect(await readCliCatalogCredential("claude-code", { CLAUDE_CONFIG_DIR: "relative" })).toBeUndefined();
    const getJson = vi.fn();
    expect(await queryCliServerModels("claude-code", { CLAUDE_CONFIG_DIR: await directory(), CLAUDE_CODE_OAUTH_TOKEN: "fake-access", ANTHROPIC_BASE_URL: "https://other.invalid" }, { getJson })).toBeUndefined();
    expect(getJson).not.toHaveBeenCalled();
  });

  it("does not mix a stored subscription token with API-key or third-party sessions", async () => {
    const path = await directory();
    await writeFile(join(path, "auth.json"), JSON.stringify({ tokens: { access_token: "fake-access" } }));
    expect(await readCliCatalogCredential("codex", { CODEX_HOME: path, OPENAI_API_KEY: "fake-key" })).toBeUndefined();
    for (const mode of [{ ANTHROPIC_API_KEY: "fake-key" }, { CLAUDE_CODE_USE_BEDROCK: "1" }, { CLAUDE_CODE_USE_VERTEX: "1" }, { CLAUDE_CODE_USE_FOUNDRY: "1" }]) {
      expect(await readCliCatalogCredential("claude-code", { CLAUDE_CONFIG_DIR: path, CLAUDE_CODE_OAUTH_TOKEN: "fake-access", ...mode })).toBeUndefined();
    }
  });

  it.each([new Error("HTTP 403 secret fake-access"), new Error("timeout"), new Error("redirect")])("returns no candidates on request failure, without returning raw errors", async error => {
    expect(await queryCliServerModels("claude-code", { CLAUDE_CONFIG_DIR: await directory(), CLAUDE_CODE_OAUTH_TOKEN: "fake-access" }, { getJson: vi.fn().mockRejectedValue(error) })).toBeUndefined();
  });

  it("rejects malformed/empty responses and repeated pagination, so CLI fallback can run", async () => {
    const environment = { CLAUDE_CONFIG_DIR: await directory(), CLAUDE_CODE_OAUTH_TOKEN: "fake-access" };
    for (const json of [null, { data: [], has_more: false }, { data: "wrong", has_more: false }]) {
      expect(await queryCliServerModels("claude-code", environment, { getJson: vi.fn().mockResolvedValue(response(json)) })).toBeUndefined();
    }
    const getJson = vi.fn().mockResolvedValue(response({ data: [{ id: "one", display_name: "One" }], has_more: true, last_id: "repeat" }));
    expect(await queryCliServerModels("claude-code", environment, { getJson })).toBeUndefined();
    expect(getJson).toHaveBeenCalledTimes(2);
  });
});
