import type { SemanticClassification, StructuredGenerationRequest } from "@cognelis/decision-protocol";

import type { EmbeddingBatch, EmbeddingProvider } from "../model/embedding-provider.js";
import { SEMANTIC_PROMPT_VERSION } from "../model/semantic-prompt.js";
import type { StructuredProviderAttempt } from "../model/structured-provider.js";
import type {
  LocalModelFailure,
  LocalModelKind,
  LocalModelOptions,
  LocalModelReply,
  LocalModelRequest,
} from "./local-model-host.js";
import { qwenModelManifest, QWEN_MODEL_MANIFEST, verifyQwenModel, type QwenModelVerification } from "./model-manifest.js";
import { QwenEmbeddingProviderError } from "./qwen-embedding-provider.js";
import { QwenProviderError } from "./qwen-provider.js";
import type {
  SemanticClassifier,
  SemanticClassifierInput,
  SemanticProviderAttempt,
  SemanticProviderStatus,
} from "./semantic-classifier.js";

// The app's side of the local models' process (local-model-host.ts, IMP-135). Only this file knows the process is
// there: the search, the knowledge page and the gateway hold the same provider interfaces as before.

export interface LocalModelProcess {
  postMessage(message: LocalModelRequest): void;
  onMessage(listener: (reply: LocalModelReply) => void): void;
  onExit(listener: (code: number | null) => void): void;
  /** SIGKILL: nothing in the process is kept, and a kill leaves no crash report behind. */
  kill(): void;
}

export interface LocalModelHostOptions {
  spawn(): LocalModelProcess;
  now?: () => number;
  log?: (line: string) => void;
  shutdownGraceMs?: number;
}

// After the n-th crash in a row under a kind's calls, its next call waits this long; a call of the kind answered
// starts the count again. Counted by kind, not by how long the process lived: a classifier that crashed it at every
// call, the embeddings working in between, would otherwise have crashed it at every call (IMP-136).
const RESTART_DELAYS_MS = [0, 2_000, 10_000, 60_000] as const;
// How long a quit lets the process close its models before it is killed: it keeps nothing, and the main process no
// longer waits on a native call (IMP-135; IMP-127's 60 seconds were for those).
const SHUTDOWN_GRACE_MS = 5_000;
const EXIT_AFTER_KILL_MS = 1_000;

const unavailable = (kind: LocalModelKind, message: string): Error =>
  kind === "embedding"
    ? new QwenEmbeddingProviderError("runtime_unavailable", message)
    : new QwenProviderError("runtime_unavailable", message);

const abortError = (message: string): Error => {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
};

// What the local models' process is not given of the app's environment: started as Node or with Node options, and any
// credential (an API key or token in the shell the app was opened from), which reading a GGUF file never needs. By
// name, not a list of what may pass: a list would drop whatever the runtime turns out to read.
const WITHHELD_ENVIRONMENT = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/iu;

export const localModelEnvironment = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(environment).filter(([name]) =>
    name !== "ELECTRON_RUN_AS_NODE" && name !== "NODE_OPTIONS" && !WITHHELD_ENVIRONMENT.test(name)));

/** Back as the class it was thrown as, so `instanceof`, `code` and `name` read as they did in one process. */
export const restoreLocalModelError = (kind: LocalModelKind, failure: LocalModelFailure): Error => {
  if (failure.name === "AbortError") return abortError(failure.message);
  if (failure.name === "QwenEmbeddingProviderError" && failure.code !== undefined) {
    return new QwenEmbeddingProviderError(failure.code as QwenEmbeddingProviderError["code"], failure.message);
  }
  if (failure.name === "QwenProviderError" && failure.code !== undefined) {
    return new QwenProviderError(failure.code as QwenProviderError["code"], failure.message, {
      ...(failure.diagnosticExcerpt === undefined ? {} : { diagnosticExcerpt: failure.diagnosticExcerpt }),
      ...(failure.usage === undefined ? {} : { usage: failure.usage as NonNullable<QwenProviderError["usage"]> }),
    });
  }
  return unavailable(kind, "The local model call failed");
};

interface Pending {
  kind: LocalModelKind;
  /** Whether its answer shows the kind's calls work again (a close's does not: IMP-136 counts calls answered). */
  resets: boolean;
  /**
   * The caller has its answer (an abort) though the process has not answered yet: kept until it does, or exits, so a
   * crash it then causes still counts against its kind. Dropped at the abort, a classification cancelled while it
   * loaded crashed the process again and again with the count put on the searches running beside it.
   */
  settled: boolean;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

type CallMessage = Extract<LocalModelRequest, { id: number }>;
type CallBody<T> = T extends unknown ? Omit<T, "id" | "instance"> : never;

export class LocalModelHost {
  readonly #spawn: LocalModelHostOptions["spawn"];
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  readonly #graceMs: number;
  #process: LocalModelProcess | undefined;
  #exited: Promise<void> = Promise.resolve();
  #stopping = false;
  #shutdown: Promise<void> | undefined;
  readonly #crashes: Record<LocalModelKind, { inRow: number; nextCallAt: number }> = {
    embedding: { inRow: 0, nextCallAt: 0 },
    classifier: { inRow: 0, nextCallAt: 0 },
  };
  readonly #opened = new Set<number>();
  readonly #pending = new Map<number, Pending>();
  #nextId = 0;
  #nextInstance = 0;

  constructor(options: LocalModelHostOptions) {
    this.#spawn = options.spawn;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.#graceMs = options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;
  }

  instance(): number {
    this.#nextInstance += 1;
    return this.#nextInstance;
  }

  /** False while a kind's calls wait out their restart, or once the app is quitting. */
  available(kind: LocalModelKind): boolean {
    return this.#shutdown === undefined && this.#now() >= this.#crashes[kind].nextCallAt;
  }

  call<T>(
    instance: number,
    kind: LocalModelKind,
    options: () => LocalModelOptions,
    body: CallBody<CallMessage>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.available(kind)) {
      return Promise.reject(unavailable(kind, this.#shutdown === undefined
        ? "The local model process is restarting"
        : "The local model process is closing"));
    }
    let process: LocalModelProcess;
    try {
      process = this.#running();
    } catch {
      this.#crashed([kind]);
      return Promise.reject(unavailable(kind, "The local model process could not start"));
    }
    this.#nextId += 1;
    const id = this.#nextId;
    return new Promise<T>((resolve, reject) => {
      // Settled here at once, as the callers' own deadlines already were; the process stops the call where the provider
      // can (between two texts, two tokens), and the instance's next call still queues behind the native one.
      const onAbort = () => {
        const pending = this.#pending.get(id);
        if (pending === undefined || pending.settled) return;
        pending.settled = true;
        try {
          this.#process?.postMessage({ op: "cancel", target: id });
        } catch {
          // Gone as it was cancelled: nothing left to stop.
        }
        reject(abortError(kind === "embedding" ? "Local embedding was aborted" : "Qwen classification aborted"));
      };
      // Taken off as the call settles: a signal living longer than its calls (an app-long one) held one per call.
      const settled = () => signal?.removeEventListener("abort", onAbort);
      this.#pending.set(id, {
        kind,
        resets: body.op !== "close",
        settled: false,
        resolve: (value) => { settled(); resolve(value as T); },
        reject: (error) => { settled(); reject(error); },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        if (!this.#opened.has(instance)) {
          process.postMessage({ op: "open", instance, kind, options: options() });
          this.#opened.add(instance);
        }
        process.postMessage({ ...body, id, instance } as CallMessage);
      } catch {
        this.#pending.delete(id);
        settled();
        reject(unavailable(kind, "The local model process could not be reached"));
      }
    });
  }

  /** A setting for an instance the process holds; one it does not hold yet takes it with its open. */
  notify(instance: number, message: Extract<LocalModelRequest, { op: "setModel" | "setTimeoutMs" }>): void {
    if (this.#opened.has(instance)) this.#process?.postMessage(message);
  }

  /**
   * Always succeeds: an instance the process never held, one gone with a process that ended, or closed by the quit's
   * shutdown is as closed as asked. The knowledge page's close, refused, wrote no shutdown marker (IMP-135).
   */
  async close(instance: number, kind: LocalModelKind, options: () => LocalModelOptions): Promise<void> {
    if (this.#process === undefined || !this.#opened.has(instance)) return;
    // Refused at once while the app quits (call), refused or failed in the process, cut short by its end: all closed.
    await this.call<null>(instance, kind, options, { op: "close" }).catch(() => undefined);
    this.#opened.delete(instance);
  }

  /** The quit: the process closes every model it holds and exits, or is killed once the grace is over. */
  shutdown(): Promise<void> {
    this.#shutdown ??= (async () => {
      const process = this.#process;
      if (process === undefined) return;
      this.#stopping = true;
      const exited = this.#exited;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), this.#graceMs); });
      process.postMessage({ op: "shutdown" });
      const settled = await Promise.race([exited, late]);
      clearTimeout(timer);
      if (settled !== "late") return;
      process.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, EXIT_AFTER_KILL_MS))]);
    })();
    return this.#shutdown;
  }

  #running(): LocalModelProcess {
    if (this.#process !== undefined) return this.#process;
    const process = this.#spawn();
    this.#process = process;
    this.#opened.clear();
    let exited = (): void => undefined;
    this.#exited = new Promise((resolve) => { exited = resolve; });
    process.onMessage((reply) => {
      if (this.#process !== process) return;
      const pending = this.#pending.get(reply.id);
      if (pending === undefined) return;
      this.#pending.delete(reply.id);
      if (reply.ok && pending.resets) this.#crashes[pending.kind].inRow = 0;
      if (pending.settled) return;
      if (reply.ok) pending.resolve(reply.value);
      else pending.reject(restoreLocalModelError(pending.kind, reply.error));
    });
    process.onExit((code) => {
      if (this.#process !== process) return;
      this.#process = undefined;
      const intentional = this.#stopping;
      this.#log(`[local-models] exited code=${code ?? "null"} intentional=${intentional}`);
      const pending = [...this.#pending.values()];
      this.#pending.clear();
      this.#opened.clear();
      // A shutdown's exit or kill is no crash (nothing is called after it in any case; the line above says which it was).
      if (!intentional) this.#crashed([...new Set(pending.map((call) => call.kind))]);
      for (const call of pending) if (!call.settled) call.reject(unavailable(call.kind, "The local model process ended"));
      exited();
    });
    return process;
  }

  /** A crash counts against the kinds whose calls it cut short; one with none running, against both. */
  #crashed(kinds: LocalModelKind[]): void {
    const now = this.#now();
    for (const kind of kinds.length === 0 ? (["embedding", "classifier"] as const) : kinds) {
      const crashes = this.#crashes[kind];
      crashes.inRow += 1;
      crashes.nextCallAt = now + RESTART_DELAYS_MS[Math.min(crashes.inRow, RESTART_DELAYS_MS.length) - 1]!;
    }
  }
}

/** The agents' search's or the knowledge page's embedding, run in the local model process. */
export class LocalEmbeddingClient implements EmbeddingProvider {
  readonly #host: LocalModelHost;
  readonly #instance: number;
  readonly #options: LocalModelOptions;
  #closed = false;

  constructor(host: LocalModelHost, options: { modelsDirectory: string }) {
    this.#host = host;
    this.#instance = host.instance();
    this.#options = { modelsDirectory: options.modelsDirectory };
  }

  embed(texts: string[], signal?: AbortSignal): Promise<EmbeddingBatch> {
    if (this.#closed) {
      return Promise.reject(new QwenEmbeddingProviderError("runtime_unavailable", "The local embedding provider is closed"));
    }
    if (signal?.aborted === true) return Promise.reject(abortError("Local embedding was aborted"));
    return this.#host.call(this.#instance, "embedding", () => this.#options, { op: "embed", texts }, signal);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#host.close(this.#instance, "embedding", () => this.#options);
  }
}

/** The bundled Qwen classifier, run in the local model process. */
export class LocalClassifierClient implements SemanticClassifier {
  readonly id = "qwen" as const;
  readonly queuesCalls = true;
  readonly #host: LocalModelHost;
  readonly #instance: number;
  readonly #modelsDirectory: string;
  readonly #verifyModel: NonNullable<LocalClassifierClientOptions["verifyModel"]>;
  #model: string;
  #timeoutMs: number | undefined;
  #closed = false;

  constructor(host: LocalModelHost, options: LocalClassifierClientOptions) {
    this.#host = host;
    this.#instance = host.instance();
    this.#modelsDirectory = options.modelsDirectory;
    this.#model = options.model ?? QWEN_MODEL_MANIFEST.id;
    this.#timeoutMs = options.timeoutMs;
    this.#verifyModel = options.verifyModel ?? verifyQwenModel;
  }

  setModel(model: string): void {
    this.#model = model;
    this.#host.notify(this.#instance, { op: "setModel", instance: this.#instance, model });
  }

  setTimeoutMs(timeoutMs: number): void {
    this.#timeoutMs = timeoutMs;
    this.#host.notify(this.#instance, { op: "setTimeoutMs", instance: this.#instance, timeoutMs });
  }

  /**
   * Answered here, from the model's file as the provider checks it, never by the process: one compiling Metal for a
   * new build (some 8 seconds) answered nothing within the gateway's five, and the pair went on to the next backend,
   * a remote one among them. Waiting out a restart after crashes, it is said unavailable, and the chain goes on as its
   * fallbackOnFailure says (IMP-136).
   */
  async status(): Promise<SemanticProviderStatus> {
    const manifest = qwenModelManifest(this.#model);
    if (this.#closed || !this.#host.available("classifier")) {
      return { id: this.id, availability: "runtime_unavailable", modelVersion: manifest.id, promptVersion: SEMANTIC_PROMPT_VERSION };
    }
    const verification = await this.#verifyModel({ modelsDirectory: this.#modelsDirectory, manifest });
    return {
      id: this.id,
      availability: verification.availability,
      modelVersion: verification.availability === "available" ? verification.manifest.id : manifest.id,
      promptVersion: SEMANTIC_PROMPT_VERSION,
    };
  }

  classify(input: SemanticClassifierInput, signal?: AbortSignal): Promise<SemanticClassification> {
    return this.invoke(input, signal).then((attempt) => attempt.classification);
  }

  invoke(input: SemanticClassifierInput, signal?: AbortSignal): Promise<SemanticProviderAttempt> {
    return this.#call({ op: "invoke", input }, signal);
  }

  generate(request: StructuredGenerationRequest, signal?: AbortSignal): Promise<StructuredProviderAttempt> {
    return this.#call({ op: "generate", request }, signal);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#host.close(this.#instance, "classifier", () => this.#options());
  }

  #options(): LocalModelOptions {
    return {
      modelsDirectory: this.#modelsDirectory,
      model: this.#model,
      ...(this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs }),
    };
  }

  #call<T>(body: CallBody<CallMessage>, signal?: AbortSignal): Promise<T> {
    if (this.#closed) return Promise.reject(new QwenProviderError("runtime_unavailable", "Qwen provider is closed"));
    if (signal?.aborted === true) return Promise.reject(abortError("Qwen classification aborted"));
    return this.#host.call(this.#instance, "classifier", () => this.#options(), body, signal);
  }
}

export interface LocalClassifierClientOptions {
  modelsDirectory: string;
  model?: string;
  timeoutMs?: number;
  verifyModel?: (options: { modelsDirectory: string; manifest: ReturnType<typeof qwenModelManifest> }) => Promise<QwenModelVerification>;
}
