import type {
  ModelInvocationErrorCode,
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
  readonly providerRequestId: string | undefined;

  constructor(
    code: ModelInvocationErrorCode,
    message: string,
    options: {
      diagnosticExcerpt?: string;
      providerRequestId?: string | undefined;
    } = {},
  ) {
    super(message);
    this.name = "ModelProviderError";
    this.code = code;
    this.diagnosticExcerpt =
      options.diagnosticExcerpt ?? message;
    this.providerRequestId = options.providerRequestId;
  }
}

const validateUrl = (value: string): URL => {
  const url = new URL(value);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]";
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

const statusErrorCode = (
  status: number,
): ModelInvocationErrorCode => {
  if (status === 401) {
    return "authentication_failed";
  }
  if (status === 403) {
    return "authorization_failed";
  }
  if (status === 429) {
    return "rate_limited";
  }
  return status >= 500
    ? "provider_unavailable"
    : "invalid_output";
};

const requestIdFrom = (headers: Headers): string | undefined =>
  headers.get("x-request-id") ??
  headers.get("request-id") ??
  headers.get("anthropic-request-id") ??
  undefined;

const readBoundedBody = async (
  response: Response,
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
  async postJson(
    input: HttpModelRequest,
  ): Promise<HttpModelResponse> {
    const url = validateUrl(input.url);
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
      input.secrets,
      input.sensitivePaths ?? [],
    );
    let serialized: string;
    try {
      serialized = JSON.stringify(input.body);
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
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, input.timeoutMs);
    timer.unref();
    try {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: input.headers,
          body: serialized,
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
          input.signal?.aborted === true ||
          (error instanceof Error && error.name === "AbortError")
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
            diagnosticExcerpt: sanitize(
              error instanceof Error
                ? error.message
                : String(error),
            ),
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
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ModelProviderError(
          "invalid_output",
          "Model API returned malformed JSON",
          {
            providerRequestId,
            diagnosticExcerpt: sanitize(
              `HTTP ${response.status}: ${text}`,
            ),
          },
        );
      }
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
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        ...(providerRequestId === undefined
          ? {}
          : { requestId: providerRequestId }),
        json,
      };
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
    }
  }
}
