import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { CredentialVaultError } from "../src/main/model/credential-vault.js";
import { PrConnections } from "../src/main/pr-connections.js";

it("keeps secrets out of connection metadata, requires new credentials across sites and serializes mutations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pr-connections-"));
  const path = join(directory, "connections.json");
  const secrets = new Map<string, string>();
  const credentials = { get: async (key: string) => secrets.get(key) ?? null, set: async (key: string, value: string) => { secrets.set(key, value); }, delete: async (key: string) => secrets.delete(key) };
  const store = new PrConnections(path, credentials);
  try {
    const saved = await store.save({ label: "GitHub", platform: "github", baseUrl: "https://github.com", token: "example-value" });
    const id = saved[0]!.id;
    expect(JSON.stringify(saved)).not.toContain("example-value");
    expect(await readFile(path, "utf8")).not.toContain("example-value");
    await expect(store.save({ id, label: "Other", platform: "github", baseUrl: "https://other.example" })).rejects.toThrow(/令牌/);
    await Promise.all([store.save({ label: "GitLab", platform: "gitlab", baseUrl: "https://gitlab.com", token: "another-example" }), store.save({ id, label: "Renamed", platform: "github", baseUrl: "https://github.com" })]);
    expect(await store.list()).toHaveLength(2);
    expect((await store.remove(id)).map((item) => item.platform)).toEqual(["gitlab"]);
    expect(secrets.size).toBe(1);
    await writeFile(path, "malformed");
    await expect(store.save({ label: "New", platform: "github", baseUrl: "https://github.com", token: "example-value" })).rejects.toThrow(/原文件已保留/);
    expect(await readFile(path, "utf8")).toBe("malformed");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("says to enter a token again when the keychain will not give it back", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pr-connections-"));
  const secrets = new Map<string, string>();
  let refuse = false;
  const credentials = {
    get: async (key: string) => {
      if (refuse) throw new Error("Credential decryption failed");
      return secrets.get(key) ?? null;
    },
    set: async (key: string, value: string) => { secrets.set(key, value); },
    delete: async (key: string) => secrets.delete(key),
  };
  const store = new PrConnections(join(directory, "connections.json"), credentials);
  try {
    const [saved] = await store.save({ label: "GitHub", platform: "github", baseUrl: "https://github.com", token: "example-value" });
    // Refused after the app was updated: English, and nothing said what to do.
    refuse = true;
    const failure = await store.client(saved!.id).catch((error: unknown) => error);
    expect((failure as Error).message).toMatch(/请在设置 › 链接中重新填写令牌/u);
    expect((failure as Error).message).not.toContain("Credential");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("says a token the keychain would not take was not stored, and what to do, rather than the vault's English", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pr-connections-"));
  const store = new PrConnections(join(directory, "connections.json"), {
    get: async () => null,
    set: async () => { throw new CredentialVaultError("credential_unavailable", "Credential encryption failed"); },
    delete: async () => true,
  });
  try {
    const failure = await store.save({ label: "GitHub", platform: "github", baseUrl: "https://github.com", token: "example-value" })
      .catch((error: unknown) => error);
    expect((failure as Error).message).toMatch(/没能把访问令牌存进系统钥匙串.*本地密钥模式/u);
    expect(await store.list()).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("opens a comment link only when it sits under a connected platform", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pr-connections-"));
  const secrets = new Map<string, string>();
  const credentials = { get: async (key: string) => secrets.get(key) ?? null, set: async (key: string, value: string) => { secrets.set(key, value); }, delete: async (key: string) => secrets.delete(key) };
  const store = new PrConnections(join(directory, "connections.json"), credentials);
  try {
    await store.save({ label: "Bitbucket", platform: "bitbucket-server", baseUrl: "https://code.example", token: "example-value" });
    const link = "https://code.example/projects/AI/repos/app/pull-requests/12/overview?commentId=5";
    expect(await store.webLink(link)).toBe(link);
    await expect(store.webLink("https://elsewhere.example/projects/AI/repos/app")).rejects.toThrow(/不属于已添加/);
    await expect(store.webLink("file:///etc/hosts")).rejects.toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
