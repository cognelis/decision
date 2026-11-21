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

/** Non-model platform traffic only; ModelNetworkPolicy owns all model requests.
 * `target` on this Mac is reached directly, whatever the proxy settings: through a proxy, the proxy was handed the
 * credential and the request in clear text, and its own "localhost" is not this machine.
 */
export const createPlatformDispatcher = (input?: ModelProxy, source: NodeJS.ProcessEnv = process.env, target?: URL): Dispatcher => {
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
export const proxyPrivateValues = (source: NodeJS.ProcessEnv): string[] => [...proxyEnvironmentNames, "MODEL_PROXY_URL"].flatMap((name) => {
  const value = source[name]; if (!value) return [];
  try { const url = new URL(value); const user = decodeURIComponent(url.username); const password = decodeURIComponent(url.password); return [value, user, password, ...(user || password ? [Buffer.from(`${user}:${password}`).toString("base64")] : [])].filter(Boolean); } catch { return [value]; }
});

/** Keep late login-shell PATH/client-home updates visible as well as live proxy settings. */
export const modelNetworkEnvironment = (source: NodeJS.ProcessEnv, proxyUrl: () => string | null | undefined): NodeJS.ProcessEnv => new Proxy(source, {
  get(target, name) { return name === "MODEL_PROXY_URL" ? target.MODEL_PROXY_URL ?? proxyUrl() ?? undefined : Reflect.get(target, name); },
});

/** Model traffic never uses environment bypass rules or an implicit DIRECT route. */
export class ModelNetworkPolicy {
  readonly mode = "required" as const;
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  route(target: URL, input?: ModelProxy): { kind: "proxy"; uri: string } | { kind: "loopback" } {
    const proxy = modelProxySchema.parse(input ?? { mode: "environment" });
    if (proxy.noProxy) throw new Error("Model network policy forbids proxy bypass lists");
    if (isLoopback(target) && (proxy.mode === "direct" || this.environment.MODEL_ALLOW_LOOPBACK === "true")) {
      // localhost is pinned to a literal address so a hosts/DNS change cannot turn the exception into remote egress.
      if (target.hostname === "localhost") target.hostname = "127.0.0.1";
      return { kind: "loopback" };
    }
    if (proxy.mode === "direct") throw new Error("Model network policy forbids external DIRECT requests");
    const value = this.environment.MODEL_PROXY_URL ?? (proxy.mode === "custom" ? proxy.url : undefined);
    if (!value || /[\x00-\x20\x7f]/u.test(value)) throw new Error("Model network policy requires MODEL_PROXY_URL or an explicit model proxy");
    let uri: URL;
    try { uri = new URL(value); } catch { throw new Error("Invalid model proxy URL"); }
    if (!["http:", "https:"].includes(uri.protocol) || !uri.hostname || uri.pathname !== "/" || uri.search || uri.hash) {
      throw new Error("Model proxy must be an HTTP(S) origin");
    }
    return { kind: "proxy", uri: uri.href };
  }

  cliEnvironment(input?: ModelProxy): NodeJS.ProcessEnv {
    // CLI profiles can hide their endpoint in user config; no implicit loopback/direct exception is safe here.
    const route = this.route(new URL("https://model-policy.invalid"), input);
    if (route.kind !== "proxy") throw new Error("CLI model requests require a proxy");
    const uri = route.uri.replace(/\/$/u, "");
    return Object.fromEntries([
      ["MODEL_PROXY_URL", uri],
      ...proxyEnvironmentNames.map(name => [name, /no_proxy/iu.test(name) ? "" : uri]),
    ]);
  }

  dispatcher(route: ReturnType<ModelNetworkPolicy["route"]>): Dispatcher {
    return route.kind === "loopback" ? new Agent() : new ProxyAgent({ uri: route.uri, proxyTunnel: true });
  }
}
