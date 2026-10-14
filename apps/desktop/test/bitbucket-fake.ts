import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { HostedPrClient } from "../src/main/pr-platform-client.js";
import type { PrConnection } from "@cognelis/decision-protocol";

export const head = "a".repeat(40), tip = "b".repeat(40), mergeBase = "c".repeat(40);
export const repo = (key: string, slug = "app") => ({ slug, project: { key } });
export const bbPr = (extra: Record<string, unknown> = {}) => ({
  id: 1, title: "PR", description: "", state: "OPEN", version: 3, updatedDate: 0, author: { user: { name: "author" } },
  fromRef: { latestCommit: head, displayId: "feature", repository: repo("AI") },
  toRef: { latestCommit: tip, displayId: "dev", repository: repo("AI") }, ...extra,
});

export interface Seen { method: string; url: string; body: string; headers: IncomingMessage["headers"] }
export type Handler = (req: Seen, res: ServerResponse) => void | Promise<void>;

/** A fake Bitbucket Server on 127.0.0.1; proxies unset as the repo's own tests do. */
export async function fakeBitbucket(handler: Handler) {
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy"]) vi.stubEnv(name, "");
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const entry = { method: req.method ?? "GET", url: req.url ?? "", body, headers: req.headers };
    seen.push(entry);
    res.setHeader("x-ausername", "alice");
    await handler(entry, res);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No port");
  const config: PrConnection = { id: randomUUID(), label: "bb", platform: "bitbucket-server", baseUrl: `http://127.0.0.1:${address.port}` };
  const client = HostedPrClient.create(config, "example-token");
  return { config, client, seen, close: async () => { server.close(); await once(server, "close"); vi.unstubAllEnvs(); } };
}

export const json = (res: ServerResponse, value: unknown, status = 200) => {
  res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value));
};
