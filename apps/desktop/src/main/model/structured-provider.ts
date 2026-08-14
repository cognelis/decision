import type {
  NormalizedTokenUsage,
  StructuredGenerationRequest,
} from "@cognelis/decision-protocol";

import type { SemanticClassifier } from "../semantic/semantic-classifier.js";
import { ModelProviderError } from "./http-model-transport.js";

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

export const parseStructuredJson = (
  visibleOutput: string,
  providerRequestId?: string,
): unknown => {
  try {
    return JSON.parse(visibleOutput) as unknown;
  } catch {
    throw new ModelProviderError(
      "invalid_output",
      "Model provider returned malformed structured JSON",
      providerRequestId === undefined
        ? {}
        : { providerRequestId },
    );
  }
};
