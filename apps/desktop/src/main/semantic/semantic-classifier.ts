import type {
  ModelProviderKind,
  NormalizedTokenUsage,
  SemanticClassification,
  SemanticRecognitionStatus,
} from "@cognelis/decision-protocol";

export interface SemanticClassifierInput {
  pairId: string;
  assistantText: string;
  userText: string;
  locale: "zh-CN" | "en";
}

export interface SemanticClassificationAuditContext {
  sourceClient: "claude-code" | "codex";
  sessionId: string;
  turnId?: string;
}

export interface SemanticProviderStatus {
  id: ModelProviderKind;
  availability: SemanticRecognitionStatus["availability"];
  modelVersion?: string;
  promptVersion?: string;
}

export interface SemanticClassificationService {
  classify(
    input: SemanticClassifierInput,
    signal?: AbortSignal,
    auditContext?: SemanticClassificationAuditContext,
  ): Promise<SemanticClassification>;
  close?(): Promise<void>;
}

export interface SemanticProviderAttempt {
  classification: SemanticClassification;
  visibleOutput: string;
  providerRequestId?: string;
  traceInput: {
    systemPrompt: string;
    userPrompt: string;
    outputSchema: Record<string, unknown>;
    clientSystemPromptVisibility: "visible" | "opaque";
  };
  usage: NormalizedTokenUsage;
  providerDurationMs: number;
}

export interface SemanticClassifier
  extends SemanticClassificationService {
  readonly id: ModelProviderKind;
  status(): Promise<SemanticProviderStatus>;
  invoke(
    input: SemanticClassifierInput,
    signal?: AbortSignal,
  ): Promise<SemanticProviderAttempt>;
  close(): Promise<void>;
  /** How a backend kept for the life of the app takes a timeout changed in settings. */
  setTimeoutMs?(timeoutMs: number): void;
  setModel?(model: string): void;
  /**
   * Takes one call at a time and times each itself once it runs (the bundled Qwen). The gateway, which sees a
   * call only as it is made, leaves the timing to it: counted from the call, a capture queued behind the reader's
   * own answer was filed as this backend's timeout and handed down the chain, to a remote backend among them.
   */
  readonly queuesCalls?: boolean;
}
