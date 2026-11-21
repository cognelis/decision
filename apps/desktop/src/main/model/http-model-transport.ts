import { fetch as proxyFetch, type Dispatcher } from "undici";
import {
  clipText,
  type ModelProxy,
  type NormalizedTokenUsage,
} from "@cognelis/decision-protocol";
import { ModelNetworkPolicy, isLoopback, proxyPrivateValues } from "./provider-network.js";
import type {
  ModelInvocationErrorCode,
  ModelInvocationInput,
} from "@cognelis/decision-protocol";
import { homedir } from "node:os";

export interface HttpModelRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  maximumResponseBytes: number;
  secrets: string[];
  sensitivePaths?: string[];
  signal?: AbortSignal;
  proxy?: ModelProxy;
  provider?: string;
  model?: string | undefined;
}

export interface HttpModelResponse {
  status: number;
  headers: Record<string, string>;
  requestId?: string;
  json: unknown;
}

export class ModelProviderError extends Error {
  readonly code: ModelInvocationErrorCode;
  readonly diagnosticExcerpt: string;
  traceInput?: ModelInvocationInput;
  readonly providerRequestId: string | undefined;
  /**
   * What the provider said the call cost, when it answered before failing.
   * The gateway already reads this off the error and writes it into the trace;
   * without it a call that was billed and then rejected is filed as costing
   * nothing, which is exactly the call whose token counts explain the failure.
   */
  readonly usage: NormalizedTokenUsage | undefined;
  /**
   * What the provider actually sent, when it sent something unusable. Travels
   * to the trace's `output`, which the store drops unless the reader left
   * trace content on — so unlike `diagnosticExcerpt` it may hold the text, and
   * it is the only way to see what a "will not parse" answer really was.
   */
  readonly visibleOutput: string | undefined;

  constructor(
    code: ModelInvocationErrorCode,
    message: string,
    options: {
      diagnosticExcerpt?: string;
      providerRequestId?: string | undefined;
      usage?: NormalizedTokenUsage | undefined;
      visibleOutput?: string | undefined;
      traceInput?: ModelInvocationInput;
    } = {},
  ) {
    super(message);
    this.name = "ModelProviderError";
    this.code = code;
    this.diagnosticExcerpt =
      options.diagnosticExcerpt ?? message;
    this.providerRequestId = options.providerRequestId;
    this.usage = options.usage;
    this.visibleOutput = options.visibleOutput;
    if (options.traceInput !== undefined) Object.defineProperty(this, "traceInput", { value: options.traceInput, enumerable: false, writable: true, configurable: true });
  }
}

const validateUrl = (value: string): URL => {
  const url = new URL(value);
  const loopback = isLoopback(url);
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && loopback))
  ) {
    throw new ModelProviderError(
      "invalid_configuration",
      "Model API URLs require HTTPS or HTTP loopback",
    );
  }
  return url;
};

const replaceAll = (
  value: string,
  search: string,
  replacement: string,
): string =>
  search.length === 0 ? value : value.split(search).join(replacement);

const sanitizerFor = (
  secrets: string[],
  sensitivePaths: string[],
): ((value: string) => string) => {
  const replacements = [
    ...secrets,
    homedir(),
    ...sensitivePaths,
  ]
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);
  return (input) => {
    let value = input
      .replace(
        /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu,
        "Bearer [redacted]",
      )
      .replace(
        /\b(?:sk|key|token)-[A-Za-z0-9._-]{8,}/giu,
        "[redacted]",
      );
    for (const replacement of replacements) {
      value = replaceAll(value, replacement, "[redacted]");
    }
    return value.slice(0, 2_000);
  };
};

/**
 * A provider's API address: the base URL as given, then the path. Providers document their base URL
 * with its version (https://api.moonshot.cn/v1, http://localhost:1234/v1, .../api/paas/v4,
 * .../v1beta/openai) as often as without (https://api.openai.com): a base that already names a
 * version keeps it, and one that does not gets /v1, as it always did.
 */
export const providerEndpoint = (baseUrl: string, path: string): string => {
  // Built on the URL's path alone: a query the service wants on every call (a key, an api-version) stays
  // at the end rather than ending up in the middle of the path.
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/u, "");
  url.pathname = /(?:^|\/)v\d+[a-z0-9]*(?:\/|$)/iu.test(basePath)
    ? `${basePath}${path}`
    : `${basePath}/v1${path}`;
  return url.href;
};

/**
 * What a failed request says, with why: fetch reports only "fetch failed" and keeps the reason (a refused
 * port, a proxy asking for credentials, a certificate) in `cause`, which the diagnostic used to leave out.
 */
const failureText = (error: unknown): string => {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current !== undefined && current !== null; depth += 1) {
    if (!(current instanceof Error)) {
      parts.push(String(current));
      break;
    }
    const code = (current as { code?: unknown }).code;
    parts.push(typeof code === "string" ? `${current.message} (${code})` : current.message);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(" ← ");
};

const statusErrorCode = (
  status: number,
  body: unknown,
): ModelInvocationErrorCode => {
  if (refusedContent(status, body)) {
    return "content_refused";
  }
  // No such address or model: what is wrong is the configuration, not what came back.
  if (status === 404) {
    return "invalid_configuration";
  }
  if (status === 401) {
    return "authentication_failed";
  }
  if (status === 403) {
    return "authorization_failed";
  }
  if (status === 429) {
    return "rate_limited";
  }
  // Out of credit (DeepSeek, among others, says so with 402): no retry or setting fixes it but a top-up.
  if (status === 402) {
    return "quota_exhausted";
  }
  // Any other refusal is of the request itself (a model name, a parameter, a prompt too long): what came
  // back was never output, and calling it invalid output sent the reader looking in the wrong place.
  return status >= 500
    ? "provider_unavailable"
    : "invalid_configuration";
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/**
 * The codes a 400 names the provider's content moderation by, as each documents them: DashScope's data inspection and
 * its custom and FAQ rules, Zhipu's 1301, and Volcano Ark's codes for sensitive text in and out (its risk service
 * failing to answer, ContentSecurityDetectionError, is not one).
 */
const REFUSAL_CODES = new Set([
  "DataInspectionFailed", "data_inspection_failed", "CustomRoleBlocked", "FaqRuleBlocked",
  "1301",
  "SensitiveContentDetected", "SensitiveContentDetected.SevereViolation", "SensitiveContentDetected.Violence",
  "InputTextSensitiveContentDetected", "InputTextSensitiveContentDetected.PolicyViolation", "OutputTextSensitiveContentDetected",
  "InputTextRiskDetection", "OutputTextRiskDetection",
]);

/**
 * Whether the provider's content moderation refused the request, by the signals each documents: OpenRouter a 403
 * with the reasons the input was flagged for, or an error_type of content_policy_violation or refusal (in the error's
 * metadata, the error or the body, as each API puts it); Azure OpenAI and Kimi a 400 with code or type content_filter;
 * the rest a 400 with one of REFUSAL_CODES. Filed with the other 403s, it read as a key without access and a PR review
 * stopped every group for one group's diff; with the other 400s, as a setting to fix.
 */
const refusedContent = (status: number, body: unknown): boolean => {
  const root = record(body) ?? {};
  const error = record(root.error) ?? root;
  const metadata = record(error.metadata);
  if (status === 403) {
    const type = metadata?.error_type ?? error.error_type ?? root.error_type;
    return Array.isArray(metadata?.reasons) || type === "content_policy_violation" || type === "refusal";
  }
  return status === 400 && (error.code === "content_filter" || error.type === "content_filter" || REFUSAL_CODES.has(String(error.code)));
};

/** What a body that is not JSON looked like: its length and whether it opens as markup, never what it said. */
const unparsedBody = (status: number, text: string): string =>
  `HTTP ${status}: the body is not JSON (length=${text.length}${text.trimStart().startsWith("<") ? ", opens as markup" : ""})`;

/**
 * What a provider's error body calls itself (type, code, status, message), as JSON, never the rest of it; undefined
 * when it names none. Providers quote the request back in a refusal (OpenRouter's moderation names the flagged input,
 * a FastAPI service each invalid field's input, Azure what its filter matched, in innererror), and a trace keeps this
 * even with trace content off. Each value is cleaned before it is cut: cut first, a key or a path across the cut left
 * its first characters, which were no longer the whole value to replace.
 */
export const describedError = (body: unknown, clean: (value: string) => string): string | undefined => {
  // Gemini answers with a list of one error; FastAPI with `detail`, a sentence or a list of field errors.
  const root = record(Array.isArray(body) ? body[0] : body) ?? {};
  const field = Array.isArray(root.detail) ? record(root.detail[0]) : undefined;
  const error = record(root.error) ?? (field === undefined ? root : { type: field.type, message: field.msg });
  const message = typeof root.error === "string" ? root.error : typeof root.detail === "string" ? root.detail : error.message;
  const said = Object.fromEntries(
    ([["type", error.type], ["code", error.code], ["status", error.status], ["message", message]] as const)
      .filter(([, value]) => (typeof value === "string" && value.trim().length > 0) || Number.isInteger(value))
      .map(([key, value]) => [key, typeof value === "string" ? clipText(clean(value), key === "message" ? 300 : 100) : value]),
  );
  return Object.keys(said).length === 0 ? undefined : JSON.stringify({ error: said });
};

/** A body as JSON, or undefined when it is not JSON. */
const parsedBody = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** A refusal, described: its status and what its error calls itself. Written as "HTTP 403: {json}", which the trace page reads the message from. */
const refusalDiagnostic = (status: number, text: string, body: unknown, clean: (value: string) => string): string =>
  body === undefined
    ? unparsedBody(status, text)
    : `HTTP ${status}: ${describedError(body, clean) ?? `a JSON body without an error message (length=${text.length})`}`;

const requestIdFrom = (headers: Pick<Headers, "get">): string | undefined =>
  headers.get("x-request-id") ??
  headers.get("request-id") ??
  headers.get("anthropic-request-id") ??
  undefined;

const readBoundedBody = async (
  response: Awaited<ReturnType<typeof proxyFetch>>,
  maximumBytes: number,
  controller: AbortController,
): Promise<Buffer> => {
  if (response.body === null) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      const chunk = Buffer.from(result.value);
      total += chunk.byteLength;
      if (total > maximumBytes) {
        controller.abort();
        throw new ModelProviderError(
          "response_too_large",
          "Model API response exceeded the configured limit",
        );
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
};

export interface ModelNetworkAudit {
  provider: string;
  model: string;
  policy: "required";
  route: "proxy" | "loopback" | "blocked";
  result: "succeeded" | "proxy_failed" | "failed" | "blocked";
  status?: number;
  errorCode?: ModelInvocationErrorCode;
}

export class HttpModelTransport {
  constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly options: { audit?: (event: ModelNetworkAudit) => void } = {},
  ) {}
  async postJson(input: HttpModelRequest): Promise<HttpModelResponse> {
    return this.#requestJson(input, "POST");
  }

  async getJson(input: Omit<HttpModelRequest, "body">): Promise<HttpModelResponse> {
    return this.#requestJson({ ...input, body: undefined }, "GET");
  }

  async #requestJson(input: HttpModelRequest, method: "GET" | "POST"): Promise<HttpModelResponse> {
    const url = validateUrl(input.url);
    if (input.signal?.aborted) throw new ModelProviderError("cancelled", "Model API request was cancelled");
    if (
      !Number.isInteger(input.timeoutMs) ||
      input.timeoutMs < 1 ||
      !Number.isInteger(input.maximumResponseBytes) ||
      input.maximumResponseBytes < 1
    ) {
      throw new ModelProviderError(
        "invalid_configuration",
        "Model HTTP request limits are invalid",
      );
    }
    const sanitize = sanitizerFor(
      [...input.secrets, ...proxyPrivateValues(this.environment)],
      input.sensitivePaths ?? [],
    );
    let serialized: string | undefined;
    try {
      if (method === "POST") serialized = JSON.stringify(input.body);
    } catch {
      throw new ModelProviderError(
        "invalid_configuration",
        "Model HTTP request body is not JSON serializable",
      );
    }

    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    input.signal?.addEventListener("abort", onAbort, {
      once: true,
    });
    if (input.signal?.aborted) controller.abort();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, input.timeoutMs);
    timer.unref();
    let dispatcher: Dispatcher | undefined;
    let route: ModelNetworkAudit["route"] = "blocked";
    let status: number | undefined;
    let outcome: ModelNetworkAudit["result"] = "blocked";
    let errorCode: ModelInvocationErrorCode | undefined;
    try {
      try {
        const policy = new ModelNetworkPolicy(this.environment);
        const resolved = policy.route(url, input.proxy);
        dispatcher = policy.dispatcher(resolved);
        route = resolved.kind;
        outcome = "failed";
      } catch {
        throw new ModelProviderError("invalid_configuration", "Model network policy blocked request: configure a valid MODEL_PROXY_URL or model proxy; external DIRECT and bypass lists are forbidden");
      }
      let response: Awaited<ReturnType<typeof proxyFetch>>;
      try {
        response = await proxyFetch(url, {
          dispatcher,
          method,
          headers: input.headers,
          ...(serialized === undefined ? {} : { body: serialized }),
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error) {
        if (timedOut) {
          throw new ModelProviderError(
            "timeout",
            "Model API request timed out",
          );
        }
        if (
          input.signal?.aborted === true
        ) {
          throw new ModelProviderError(
            "cancelled",
            "Model API request was cancelled",
          );
        }
        throw new ModelProviderError(
          "network_error",
          route === "proxy" ? "Model proxy connection failed" : "Model API request failed",
          {
            diagnosticExcerpt: route === "proxy" ? "Model proxy connection failed (no direct fallback)" : sanitize(failureText(error)),
          },
        );
      }
      status = response.status;
      // Cleaned as the diagnostics are: a service that echoes the key in a request id would carry it into every
      // trace and test result that keeps the id, whatever the backend.
      const echoedRequestId = requestIdFrom(response.headers);
      const providerRequestId = echoedRequestId === undefined ? undefined : sanitize(echoedRequestId);
      if (response.status >= 300 && response.status < 400) {
        throw new ModelProviderError(
          "redirect_rejected",
          "Model API redirects are not followed",
          {
            providerRequestId,
            diagnosticExcerpt: sanitize(
              `HTTP ${response.status} redirect rejected`,
            ),
          },
        );
      }
      const bytes = await readBoundedBody(
        response,
        input.maximumResponseBytes,
        controller,
      );
      const text = bytes.toString("utf8");
      if (!response.ok) {
        const body = parsedBody(text);
        throw new ModelProviderError(
          statusErrorCode(response.status, body),
          `Model API returned HTTP ${response.status}`,
          {
            providerRequestId,
            diagnosticExcerpt: refusalDiagnostic(response.status, text, body, sanitize),
          },
        );
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        // Described, not quoted: a body that came back with 200 is the model's output, and the trace
        // keeps this excerpt even when the reader turned trace content off.
        throw new ModelProviderError(
          "invalid_output",
          "Model API returned malformed JSON",
          {
            providerRequestId,
            diagnosticExcerpt: unparsedBody(response.status, text),
          },
        );
      }

      outcome = "succeeded";
      return {
        status: response.status,
        headers: Object.fromEntries([...response.headers.entries()].map(([name, value]) => [name, sanitize(value)])),
        ...(providerRequestId === undefined
          ? {}
          : { requestId: providerRequestId }),
        json,
      };
    } catch (error) {
      errorCode = timedOut ? "timeout" : input.signal?.aborted ? "cancelled" : error instanceof ModelProviderError ? error.code : "network_error";
      if (route === "proxy" && status === undefined && errorCode !== "cancelled") outcome = "proxy_failed";
      if (timedOut) throw new ModelProviderError("timeout", "Model API request timed out");
      if (input.signal?.aborted) throw new ModelProviderError("cancelled", "Model API request was cancelled");
      if (error instanceof ModelProviderError) throw error;
      throw new ModelProviderError("network_error", "Model API response could not be read", { diagnosticExcerpt: route === "proxy" ? "Model proxy response stream failed (no direct fallback)" : sanitize(failureText(error)) });
    } finally {
      const event: ModelNetworkAudit = {
        provider: sanitize(input.provider ?? "http-model"),
        model: sanitize(input.model ?? "catalog"),
        policy: "required", route, result: outcome,
        ...(status === undefined ? {} : { status }),
        ...(errorCode === undefined ? {} : { errorCode }),
      };
      // Logging failures cannot prevent dispatcher cleanup or change the request result.
      try { (this.options.audit ?? ((value) => console.info("model-network", JSON.stringify(value))))(event); } catch {}
      // Destroy also closes incomplete/error bodies, so a dead proxy cannot stall fallback cleanup.
      await dispatcher?.destroy().catch(() => undefined);
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
    }
  }
}
