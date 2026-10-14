import { Agent, EnvHttpProxyAgent, ProxyAgent, type Dispatcher } from "undici";
import { modelProxySchema, type ModelProxy } from "@cognelis/decision-protocol";

export const proxyEnvironmentNames = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"] as const;
export const providerProxyEnvironment = (source: NodeJS.ProcessEnv, input?: ModelProxy): NodeJS.ProcessEnv => {
  const proxy = modelProxySchema.parse(input ?? { mode: "environment" });
  const environment: NodeJS.ProcessEnv = {};
  if (proxy.mode === "environment") {
    for (const name of proxyEnvironmentNames) if (source[name] !== undefined) environment[name] = source[name];
  } else if (proxy.mode === "custom") {
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) environment[name] = proxy.url!;
    // An inherited NO_PROXY=* must not silently defeat an explicit proxy.
    environment.NO_PROXY = proxy.noProxy ?? ""; environment.no_proxy = proxy.noProxy ?? "";
  }
  return environment;
};
export const isLoopback = (url: URL): boolean =>
  url.hostname === "localhost" ||
  url.hostname === "127.0.0.1" ||
  url.hostname === "::1" ||
  url.hostname === "[::1]";

/**
 * `target` on this Mac is reached directly, whatever the proxy settings: through a proxy, the proxy was handed the
 * credential and the request in clear text, and its own "localhost" is not this machine.
 */
export const createProviderDispatcher = (input?: ModelProxy, source: NodeJS.ProcessEnv = process.env, target?: URL): Dispatcher => {
  if (target !== undefined && isLoopback(target)) return new Agent();
  const proxy = modelProxySchema.parse(input ?? { mode: "environment" });
  if (proxy.mode === "direct") return new Agent();
  const environment = providerProxyEnvironment(source, proxy);
  if (proxy.mode === "custom" && !proxy.noProxy) return new ProxyAgent({ uri: proxy.url!, proxyTunnel: true });
  const all = environment.all_proxy ?? environment.ALL_PROXY;
  const http = environment.http_proxy ?? environment.HTTP_PROXY ?? all;
  const https = environment.https_proxy ?? environment.HTTPS_PROXY ?? http;
  for (const value of [http, https]) if (value) {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP(S) model proxies are supported");
  }
  return new EnvHttpProxyAgent({ httpProxy: http ?? "", httpsProxy: https ?? "", noProxy: environment.no_proxy ?? environment.NO_PROXY ?? "" });
};
export const proxyPrivateValues = (source: NodeJS.ProcessEnv): string[] => proxyEnvironmentNames.flatMap((name) => {
  const value = source[name]; if (!value) return [];
  try { const url = new URL(value); const user = decodeURIComponent(url.username); const password = decodeURIComponent(url.password); return [value, user, password, ...(user || password ? [Buffer.from(`${user}:${password}`).toString("base64")] : [])].filter(Boolean); } catch { return [value]; }
});
