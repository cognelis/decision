import { fetch as proxyFetch, type Dispatcher } from "undici";
import type {
  ModelProxy,
  NormalizedTokenUsage,
} from "@cognelis/decision-protocol";
import { createProviderDispatcher, isLoopback, proxyPrivateValues } from "./provider-network.js";
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
): ModelInvocationErrorCode => {
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

export class HttpModelTransport {
  constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    /** Tests only: a loopback server standing in for a remote endpoint, to exercise proxy routing. */
    private readonly options: { proxyLoopback?: boolean } = {},
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
    try {
      // Loopback never goes through a proxy: plain HTTP is allowed only because it does not leave the
      // machine, and a proxy would see the key and the prompt (and its own "localhost" is not this one).
      try { dispatcher = createProviderDispatcher(input.proxy, this.environment, this.options.proxyLoopback === true ? undefined : url); }
      catch { throw new ModelProviderError("invalid_configuration", "Model proxy configuration is invalid"); }
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
          "Model API request failed",
          {
            diagnosticExcerpt: sanitize(failureText(error)),
          },
        );
      }
      const providerRequestId = requestIdFrom(response.headers);
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
        throw new ModelProviderError(
          statusErrorCode(response.status),
          `Model API returned HTTP ${response.status}`,
          {
            providerRequestId,
            diagnosticExcerpt: sanitize(
              `HTTP ${response.status}: ${text}`,
            ),
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
            diagnosticExcerpt: `HTTP ${response.status}: the body is not JSON (length=${text.length}${text.trimStart().startsWith("<") ? ", opens as markup" : ""})`,
          },
        );
      }

      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        ...(providerRequestId === undefined
          ? {}
          : { requestId: providerRequestId }),
        json,
      };
    } catch (error) {
      if (timedOut) throw new ModelProviderError("timeout", "Model API request timed out");
      if (input.signal?.aborted) throw new ModelProviderError("cancelled", "Model API request was cancelled");
      if (error instanceof ModelProviderError) throw error;
      throw new ModelProviderError("network_error", "Model API response could not be read", { diagnosticExcerpt: sanitize(failureText(error)) });
    } finally {
      // Destroy also closes incomplete/error bodies, so a dead proxy cannot stall fallback cleanup.
      await dispatcher?.destroy().catch(() => undefined);
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
    }
  }
}
