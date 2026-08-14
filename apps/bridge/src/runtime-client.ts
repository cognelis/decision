import {
  PROTOCOL_VERSION,
  captureReceiptSchema,
  capturedDecisionCandidateSchema,
  capturedDecisionEventSchema,
  decisionConsultationFeedbackRequestSchema,
  decisionConsultationFeedbackResultSchema,
  decisionConsultationRequestSchema,
  decisionConsultationResponseSchema,
  runtimeDescriptorSchema,
  semanticDecisionPairSchema,
  semanticPairDeliveryReceiptSchema,
  type CaptureReceipt,
  type CapturedDecisionCandidate,
  type CapturedDecisionEvent,
  type DecisionConsultationRequest,
  type DecisionConsultationResponse,
  type DecisionConsultationFeedbackRequest,
  type DecisionConsultationFeedbackResult,
  type RuntimeDescriptor,
  type SemanticDecisionPair,
} from "@cognelis/decision-protocol";
import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, posix, win32 } from "node:path";

import { readDecisionEnvironment } from "../../../config/decision-environment.mjs";

type Fetcher = typeof fetch;

export type RuntimeClientErrorCode = "invalid_runtime";

export class RuntimeClientError extends Error {
  readonly code: RuntimeClientErrorCode;

  constructor(code: RuntimeClientErrorCode, message: string) {
    super(message);
    this.name = "RuntimeClientError";
    this.code = code;
  }
}

export interface DoctorReport {
  runtimeFile: string;
  appStatus: "healthy" | "unavailable" | "invalid_runtime";
  protocolVersion?: number;
  port?: number;
}

interface RuntimeClientOptions {
  runtimeFile?: string;
  legacyRuntimeFile?: string;
  environment?: NodeJS.ProcessEnv;
  fetcher?: Fetcher;
  deliveryTimeoutMs?: number;
  healthTimeoutMs?: number;
}

const platformRuntimeFile = (
  directoryName: string,
  linuxDirectoryName: string,
  platform: NodeJS.Platform = process.platform,
  userHome: string = homedir(),
  xdgConfigHome: string | undefined = process.env.XDG_CONFIG_HOME,
  appData: string | undefined = process.env.APPDATA,
): string => {
  if (platform === "win32") {
    return win32.join(
      appData ?? win32.join(userHome, "AppData", "Roaming"),
      directoryName,
      "runtime.json",
    );
  }
  if (platform === "darwin") {
    return posix.join(
      userHome,
      "Library",
      "Application Support",
      directoryName,
      "runtime.json",
    );
  }
  return posix.join(
    xdgConfigHome ?? posix.join(userHome, ".config"),
    linuxDirectoryName,
    "runtime.json",
  );
};

export const defaultRuntimeFile = (
  platform: NodeJS.Platform = process.platform,
  userHome: string = homedir(),
  xdgConfigHome: string | undefined = process.env.XDG_CONFIG_HOME,
  appData: string | undefined = process.env.APPDATA,
): string =>
  platformRuntimeFile(
    "Decision",
    "decision",
    platform,
    userHome,
    xdgConfigHome,
    appData,
  );

export const legacyRuntimeFile = (
  platform: NodeJS.Platform = process.platform,
  userHome: string = homedir(),
  xdgConfigHome: string | undefined = process.env.XDG_CONFIG_HOME,
  appData: string | undefined = process.env.APPDATA,
): string =>
  platformRuntimeFile(
    "Decision Island",
    "decision-island",
    platform,
    userHome,
    xdgConfigHome,
    appData,
  );

export const defaultBridgeDataDirectory = (): string => {
  const current = dirname(defaultRuntimeFile());
  const legacy = dirname(legacyRuntimeFile());
  return existsSync(current) || !existsSync(legacy) ? current : legacy;
};

export class RuntimeClient {
  #runtimeFile: string;
  readonly #runtimeFiles: string[];
  readonly #fetch: Fetcher;
  readonly #deliveryTimeoutMs: number;
  readonly #healthTimeoutMs: number;

  constructor(options: RuntimeClientOptions = {}) {
    const configuredRuntimeFile =
      options.runtimeFile ??
      readDecisionEnvironment(
        options.environment ?? process.env,
        "RUNTIME_FILE",
      );
    this.#runtimeFiles =
      configuredRuntimeFile === undefined
        ? [defaultRuntimeFile(), legacyRuntimeFile()]
        : [
            configuredRuntimeFile,
            ...(options.legacyRuntimeFile === undefined
              ? []
              : [options.legacyRuntimeFile]),
          ];
    this.#runtimeFile = this.#runtimeFiles[0]!;
    this.#fetch = options.fetcher ?? fetch;
    this.#deliveryTimeoutMs = options.deliveryTimeoutMs ?? 750;
    this.#healthTimeoutMs = options.healthTimeoutMs ?? 1_000;
  }

  async deliver(
    input: CapturedDecisionEvent,
  ): Promise<CaptureReceipt | null> {
    const event = capturedDecisionEventSchema.parse(input);
    const runtime = await this.#readRuntime().catch(() => null);
    if (runtime === null) {
      return null;
    }

    try {
      const response = await this.#fetch(
        `http://127.0.0.1:${runtime.port}/v1/captures`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${runtime.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(this.#deliveryTimeoutMs),
        },
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return captureReceiptSchema.parse(await response.json());
    } catch {
      return null;
    }
  }

  async deliverCandidate(
    input: CapturedDecisionCandidate,
  ): Promise<boolean> {
    const candidate =
      capturedDecisionCandidateSchema.parse(input);
    const runtime = await this.#readRuntime().catch(() => null);
    if (runtime === null) {
      return false;
    }
    try {
      const response = await this.#fetch(
        `http://127.0.0.1:${runtime.port}/v1/candidates`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${runtime.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(candidate),
          signal: AbortSignal.timeout(this.#deliveryTimeoutMs),
        },
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  async deliverSemanticPair(
    input: SemanticDecisionPair,
  ): Promise<boolean> {
    const pair = semanticDecisionPairSchema.parse(input);
    const runtime = await this.#readRuntime().catch(() => null);
    if (runtime === null) {
      return false;
    }
    try {
      const response = await this.#fetch(
        `http://127.0.0.1:${runtime.port}/v1/semantic-pairs`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${runtime.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(pair),
          signal: AbortSignal.timeout(this.#deliveryTimeoutMs),
        },
      );
      if (!response.ok) {
        return false;
      }
      return semanticPairDeliveryReceiptSchema.parse(
        await response.json(),
      ).accepted;
    } catch {
      return false;
    }
  }

  async consult(
    input: DecisionConsultationRequest,
  ): Promise<DecisionConsultationResponse | null> {
    const request = decisionConsultationRequestSchema.parse(input);
    const runtime = await this.#readRuntime().catch(() => null);
    if (runtime === null) {
      return null;
    }
    try {
      const response = await this.#fetch(
        `http://127.0.0.1:${runtime.port}/v1/consultations`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${runtime.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(this.#deliveryTimeoutMs),
        },
      );
      if (!response.ok) {
        return null;
      }
      return decisionConsultationResponseSchema.parse(await response.json());
    } catch {
      return null;
    }
  }

  async submitConsultationFeedback(
    input: DecisionConsultationFeedbackRequest,
  ): Promise<DecisionConsultationFeedbackResult | null> {
    const feedback = decisionConsultationFeedbackRequestSchema.parse(input);
    const runtime = await this.#readRuntime().catch(() => null);
    if (runtime === null) return null;
    try {
      const response = await this.#fetch(
        `http://127.0.0.1:${runtime.port}/v1/consultations/feedback`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${runtime.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(feedback),
          signal: AbortSignal.timeout(this.#deliveryTimeoutMs),
        },
      );
      if (!response.ok) return null;
      return decisionConsultationFeedbackResultSchema.parse(
        await response.json(),
      );
    } catch {
      return null;
    }
  }

  async doctor(): Promise<DoctorReport> {
    let runtime: RuntimeDescriptor | null;
    try {
      runtime = await this.#readRuntime();
    } catch (error) {
      if (
        error instanceof RuntimeClientError &&
        error.code === "invalid_runtime"
      ) {
        return {
          runtimeFile: this.#runtimeFile,
          appStatus: "invalid_runtime",
        };
      }
      throw error;
    }
    if (runtime === null || !(await this.#healthy(runtime))) {
      return {
        runtimeFile: this.#runtimeFile,
        appStatus: "unavailable",
      };
    }
    return {
      runtimeFile: this.#runtimeFile,
      appStatus: "healthy",
      protocolVersion: runtime.protocolVersion,
      port: runtime.port,
    };
  }

  async #readRuntime(): Promise<RuntimeDescriptor | null> {
    this.#runtimeFile = this.#runtimeFiles[0]!;
    for (const runtimeFile of this.#runtimeFiles) {
      let raw: string;
      try {
        raw = await readFile(runtimeFile, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }
      this.#runtimeFile = runtimeFile;
      try {
        return runtimeDescriptorSchema.parse(JSON.parse(raw));
      } catch {
        await unlink(runtimeFile).catch(() => undefined);
        throw new RuntimeClientError(
          "invalid_runtime",
          "Decision runtime descriptor is invalid",
        );
      }
    }
    return null;
  }

  async #healthy(runtime: RuntimeDescriptor): Promise<boolean> {
    try {
      const response = await this.#fetch(
        `http://127.0.0.1:${runtime.port}/health`,
        {
          headers: { "cache-control": "no-store" },
          signal: AbortSignal.timeout(this.#healthTimeoutMs),
        },
      );
      if (!response.ok) {
        return false;
      }
      const body = (await response.json()) as {
        ok?: unknown;
        protocolVersion?: unknown;
      };
      return (
        body.ok === true && body.protocolVersion === PROTOCOL_VERSION
      );
    } catch {
      return false;
    }
  }
}
