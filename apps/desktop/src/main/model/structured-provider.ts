import type {
  NormalizedTokenUsage,
  StructuredGenerationRequest,
} from "@cognelis/decision-protocol";

import type { SemanticClassifier } from "../semantic/semantic-classifier.js";
import { ModelProviderError } from "./http-model-transport.js";

/**
 * Reasoning models spend the output budget on thinking before they write a
 * single visible character, and both DeepSeek's `max_tokens` and the OpenAI
 * Responses API's `max_output_tokens` cover the whole completion, chain of
 * thought included. Our budgets are sized for the visible JSON alone, so a
 * model that thinks for longer than the budget returns empty content with
 * `finish_reason: "length"`. Raising the ceiling costs nothing on a model that
 * does not think — it stops at its own stop token either way.
 */
export const REASONING_HEADROOM_TOKENS = 2_048;

export interface StructuredProviderAttempt {
  parsedOutput: unknown;
  visibleOutput: string;
  providerRequestId?: string;
  modelVersion?: string;
  traceInput: {
    systemPrompt: string;
    userPrompt: string;
    outputSchema: Record<string, unknown>;
    clientSystemPromptVisibility: "visible" | "opaque";
  };
  usage: NormalizedTokenUsage;
  providerDurationMs: number;
}

export interface StructuredGenerationProvider extends SemanticClassifier {
  generate(
    request: StructuredGenerationRequest,
    signal?: AbortSignal,
  ): Promise<StructuredProviderAttempt>;
}

export const supportsStructuredGeneration = (
  provider: SemanticClassifier,
): provider is StructuredGenerationProvider =>
  "generate" in provider && typeof provider.generate === "function";

/**
 * Whether OpenAI's strict structured outputs take this schema: every object
 * names all its properties as required and allows no others. Sent as strict
 * otherwise, the request is refused before the model runs; sent as not strict,
 * the schema still guides the output, which is validated on arrival anyway.
 */
export const isStrictJsonSchema = (schema: unknown): boolean => {
  if (schema === null || typeof schema !== "object") return true;
  if (Array.isArray(schema)) return schema.every(isStrictJsonSchema);
  const node = schema as Record<string, unknown>;
  const types = Array.isArray(node.type) ? node.type : [node.type];
  const properties =
    node.properties !== null && typeof node.properties === "object"
      ? (node.properties as Record<string, unknown>)
      : {};
  if (types.includes("object") || node.properties !== undefined) {
    const required = Array.isArray(node.required) ? node.required : [];
    if (node.additionalProperties !== false) return false;
    if (Object.keys(properties).some((key) => !required.includes(key))) return false;
  }
  const nested = (value: unknown): unknown[] =>
    value !== null && typeof value === "object" ? Object.values(value) : [];
  return [
    ...Object.values(properties),
    node.items,
    node.anyOf,
    node.oneOf,
    node.allOf,
    ...nested(node.$defs),
    ...nested(node.definitions),
  ].every(isStrictJsonSchema);
};

/**
 * The floor a structured generation gets, whatever the profile says.
 *
 * `timeoutMs` is one field serving two jobs. Classification has to be quick or
 * it holds up capture, and a status probe is already capped at five seconds
 * here for the same reason — the built-in local profile's five seconds is that
 * budget. Generation is the opposite: the reader asked for it and is waiting,
 * and a small local model cannot write a cited answer in five seconds, so the
 * turn died on the one step that had to produce it. Narrowing per purpose is
 * what the status cap already does; this widens for the purpose that needs it,
 * and a profile set higher than this keeps its own value. The gateway's deadline
 * and every backend's own timer both use it, or the shorter one wins.
 */
export const MIN_GENERATION_TIMEOUT_MS = 30_000;

/**
 * What came back, by shape alone. A trace keeps `diagnosticExcerpt` even when
 * the reader turned trace content off, so this may describe the output and
 * never quote it — and shape already separates the cases that matter: an
 * answer wrapped in a markdown fence, a document that stopped before it
 * closed, and one that never looked like JSON at all. Without it the log says
 * only "malformed", which is the one thing the reader already knew.
 */
export const malformedJsonShape = (visibleOutput: string): string => {
  const trimmed = visibleOutput.trim();
  const opensWith = trimmed.startsWith("```")
    ? "fence"
    : trimmed.startsWith("{")
      ? "object"
      : trimmed.startsWith("[")
        ? "array"
        : "other";
  const endsWith = trimmed.endsWith("}")
    ? "object"
    : trimmed.endsWith("]")
      ? "array"
      : trimmed.endsWith("```")
        ? "fence"
        : "other";
  const reading =
    opensWith === "fence" || endsWith === "fence"
      ? "wrapped in a markdown fence"
      : opensWith === "other"
        ? "never opens as JSON"
        : endsWith === "other"
          ? "stops before it closes"
          : "opens and closes as JSON but will not parse";
  return `length=${trimmed.length} opens=${opensWith} ends=${endsWith} · ${reading}`;
};

export const parseStructuredJson = (
  visibleOutput: string,
  providerRequestId?: string,
  /**
   * The provider's own `finish_reason` / `stop_reason`, when it reports one.
   * It is an API enum, never the reader's content, and it is what separates
   * "the model wrote something we cannot read" from "the model was cut off
   * mid-sentence because the output budget ran out".
   */
  finishReason?: string | null,
  /** What the call cost before it failed, when the provider reported it. */
  usage?: NormalizedTokenUsage,
): unknown => {
  try {
    return JSON.parse(visibleOutput) as unknown;
  } catch {
    throw new ModelProviderError(
      "invalid_output",
      "Model provider returned malformed structured JSON",
      {
        diagnosticExcerpt: `Model provider returned malformed structured JSON · ${malformedJsonShape(
          visibleOutput,
        )}${
          finishReason === undefined || finishReason === null
            ? ""
            : ` · finish_reason=${finishReason}`
        }`,
        ...(providerRequestId === undefined
          ? {}
          : { providerRequestId }),
        ...(usage === undefined ? {} : { usage }),
        visibleOutput,
      },
    );
  }
};
