import type { StructuredGenerationRequest } from "@cognelis/decision-protocol";

import type { EmbeddingProvider } from "../model/embedding-provider.js";
import { QwenEmbeddingProvider, type QwenEmbeddingRuntimeModule } from "./qwen-embedding-provider.js";
import { QwenModelProvider, type QwenRuntimeModule } from "./qwen-provider.js";
import type { SemanticClassifier, SemanticClassifierInput } from "./semantic-classifier.js";

// The local models' own process (IMP-135): every llama call the app makes runs here, never in the main process, where
// the first getLlama of a new build compiled Metal for seconds with the service and the bridge unanswered, a model
// loaded took the SIGTERM handler with it, and a native call still running at the quit aborted the app.

export type LocalModelKind = "embedding" | "classifier";

export interface LocalModelOptions {
  modelsDirectory: string;
  model?: string;
  timeoutMs?: number;
}

export type LocalModelRequest =
  | { op: "open"; instance: number; kind: LocalModelKind; options: LocalModelOptions }
  | { op: "embed"; id: number; instance: number; texts: string[] }
  | { op: "invoke"; id: number; instance: number; input: SemanticClassifierInput }
  | { op: "generate"; id: number; instance: number; request: StructuredGenerationRequest }
  | { op: "setModel"; instance: number; model: string }
  | { op: "setTimeoutMs"; instance: number; timeoutMs: number }
  | { op: "cancel"; target: number }
  | { op: "close"; id: number; instance: number }
  | { op: "shutdown" };

export interface LocalModelFailure {
  name: string;
  code?: string;
  message: string;
  diagnosticExcerpt?: string;
  usage?: unknown;
}

export type LocalModelReply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: LocalModelFailure };

// What of node-llama-cpp the providers reach, typed only as far as the host forwards it.
interface NativeModel {
  createEmbeddingContext(options: unknown): Promise<unknown>;
  createContext(options: unknown): Promise<unknown>;
  dispose(): Promise<void>;
}

interface NativeLlama {
  loadModel(options: { modelPath: string }): Promise<NativeModel>;
  createGrammarForJsonSchema(schema: Record<string, unknown>): Promise<unknown>;
  dispose(): Promise<void>;
}

export interface NativeLlamaModule {
  getLlama(options: unknown): Promise<NativeLlama>;
  LlamaChatSession: unknown;
}

export type SharedRuntimeModule = QwenEmbeddingRuntimeModule & QwenRuntimeModule;

/**
 * One Llama for the process and one load of each model file, whoever asks: the two embedding providers (the agents'
 * search and the knowledge page) each make their own context on the one embedding model, so neither queues behind the
 * other, and the vectors are the same bit for bit as two loads gave. A provider's dispose gives back its hold; the
 * model goes with the last, the Llama only with the process (dispose()).
 */
export const createSharedRuntime = (loadModule: () => Promise<NativeLlamaModule>) => {
  let llama: Promise<NativeLlama> | undefined;
  const models = new Map<string, { model: Promise<NativeModel>; holders: number }>();

  const getLlama = (options: unknown): Promise<NativeLlama> => {
    const pending = llama ?? (llama = loadModule().then((module) => module.getLlama(options)));
    // Failed, it is tried again by the next call, as each provider did with its own.
    pending.catch(() => { if (llama === pending) llama = undefined; });
    return pending;
  };

  const loadModel = async (owner: NativeLlama, modelPath: string): Promise<NativeModel> => {
    let entry = models.get(modelPath);
    if (entry === undefined) {
      entry = { model: owner.loadModel({ modelPath }), holders: 0 };
      models.set(modelPath, entry);
    }
    entry.holders += 1;
    let model: NativeModel;
    try {
      model = await entry.model;
    } catch (error) {
      if (models.get(modelPath) === entry) models.delete(modelPath);
      throw error;
    }
    const held = entry;
    let released = false;
    return {
      createEmbeddingContext: (options) => model.createEmbeddingContext(options),
      createContext: (options) => model.createContext(options),
      dispose: async () => {
        if (released) return;
        released = true;
        held.holders -= 1;
        if (held.holders > 0) return;
        if (models.get(modelPath) === held) models.delete(modelPath);
        await model.dispose();
      },
    };
  };

  return {
    load: async (): Promise<SharedRuntimeModule> => {
      const module = await loadModule();
      return {
        getLlama: async (options: unknown) => {
          const owner = await getLlama(options);
          return {
            loadModel: ({ modelPath }: { modelPath: string }) => loadModel(owner, modelPath),
            createGrammarForJsonSchema: (schema: Record<string, unknown>) => owner.createGrammarForJsonSchema(schema),
            dispose: async () => undefined,
          };
        },
        LlamaChatSession: module.LlamaChatSession,
      } as unknown as SharedRuntimeModule;
    },
    dispose: async (): Promise<void> => {
      const current = llama;
      llama = undefined;
      if (current === undefined) return;
      await (await current.catch(() => undefined))?.dispose();
    },
  };
};

type HostedModel =
  | { kind: "embedding"; provider: EmbeddingProvider & { close(): Promise<void> } }
  | { kind: "classifier"; provider: SemanticClassifier };

export interface LocalModelHostOptions {
  runtime: () => Promise<SharedRuntimeModule>;
  createEmbedding?: (options: LocalModelOptions, runtime: () => Promise<SharedRuntimeModule>) => EmbeddingProvider & { close(): Promise<void> };
  createClassifier?: (options: LocalModelOptions, runtime: () => Promise<SharedRuntimeModule>) => SemanticClassifier;
  /** After a shutdown has closed every model: the Llama's own dispose, then the process's exit. */
  disposeRuntime?: () => Promise<void>;
  exit?: () => void;
}

const PROVIDER_ERRORS = new Set(["AbortError", "QwenEmbeddingProviderError", "QwenProviderError"]);

// Only the providers' own errors cross with their words: theirs are written to be shown and kept (paths taken out),
// anything else (a path in an ENOENT, say) is said as one fixed sentence.
const failure = (error: unknown): LocalModelFailure => {
  if (!(error instanceof Error) || !PROVIDER_ERRORS.has(error.name)) return { name: "Error", message: "The local model call failed" };
  const fields = error as Error & { code?: unknown; diagnosticExcerpt?: unknown; usage?: unknown };
  return {
    name: error.name,
    message: error.message,
    ...(typeof fields.code === "string" ? { code: fields.code } : {}),
    ...(typeof fields.diagnosticExcerpt === "string" ? { diagnosticExcerpt: fields.diagnosticExcerpt } : {}),
    ...(fields.usage === undefined ? {} : { usage: fields.usage }),
  };
};

/** The host's side of the channel: takes each message the app sent, answers through `send`. */
export const serveLocalModels = (send: (reply: LocalModelReply) => void, options: LocalModelHostOptions) => {
  const createEmbedding = options.createEmbedding ??
    ((model, runtime) => new QwenEmbeddingProvider({ modelsDirectory: model.modelsDirectory, loadRuntime: runtime }));
  const createClassifier = options.createClassifier ??
    ((model, runtime) => new QwenModelProvider({
      modelsDirectory: model.modelsDirectory,
      loadRuntime: runtime,
      ...(model.model === undefined ? {} : { model: model.model }),
      ...(model.timeoutMs === undefined ? {} : { timeoutMs: model.timeoutMs }),
    }));
  const hosted = new Map<number, HostedModel>();
  const running = new Map<number, AbortController>();
  // Closes under way, taken out of `hosted` as they began: a shutdown arriving next waits on them too, or it disposed
  // the Llama and exited under a provider still closing.
  const closing = new Set<Promise<void>>();
  const closeOf = (entry: HostedModel): Promise<void> => {
    const closed = entry.provider.close();
    closing.add(closed);
    void closed.catch(() => undefined).finally(() => closing.delete(closed));
    return closed;
  };

  const answer = (id: number, work: (signal: AbortSignal) => Promise<unknown>): void => {
    const controller = new AbortController();
    running.set(id, controller);
    void work(controller.signal).then(
      (value) => send({ id, ok: true, value }),
      (error: unknown) => send({ id, ok: false, error: failure(error) }),
    ).finally(() => running.delete(id));
  };

  const classifier = (instance: number): SemanticClassifier => {
    const entry = hosted.get(instance);
    if (entry?.kind !== "classifier") throw new Error(`no local classifier ${instance}`);
    return entry.provider;
  };

  return (message: LocalModelRequest): void => {
    switch (message.op) {
      case "open":
        try {
          hosted.set(message.instance, message.kind === "embedding"
            ? { kind: "embedding", provider: createEmbedding(message.options, options.runtime) }
            : { kind: "classifier", provider: createClassifier(message.options, options.runtime) });
        } catch {
          // Not held: its calls are answered as unavailable, and the process goes on serving the others.
        }
        return;
      case "embed":
        answer(message.id, async (signal) => {
          const entry = hosted.get(message.instance);
          if (entry?.kind !== "embedding") throw new Error(`no local embedding ${message.instance}`);
          return entry.provider.embed(message.texts, signal);
        });
        return;
      case "invoke":
        answer(message.id, async (signal) => classifier(message.instance).invoke(message.input, signal));
        return;
      case "generate":
        answer(message.id, async (signal) => {
          const provider = classifier(message.instance) as SemanticClassifier & {
            generate?: (request: StructuredGenerationRequest, signal?: AbortSignal) => Promise<unknown>;
          };
          if (provider.generate === undefined) throw new Error("the local classifier does not generate");
          return provider.generate(message.request, signal);
        });
        return;
      case "setModel": {
        const entry = hosted.get(message.instance);
        if (entry?.kind === "classifier") entry.provider.setModel?.(message.model);
        return;
      }
      case "setTimeoutMs": {
        const entry = hosted.get(message.instance);
        if (entry?.kind === "classifier") entry.provider.setTimeoutMs?.(message.timeoutMs);
        return;
      }
      case "cancel":
        running.get(message.target)?.abort();
        return;
      case "close":
        answer(message.id, async () => {
          const entry = hosted.get(message.instance);
          hosted.delete(message.instance);
          if (entry !== undefined) await closeOf(entry);
          return null;
        });
        return;
      case "shutdown": {
        // Each provider's close waits for its native call still running before it disposes: exiting under one would
        // abort this process as it once aborted the app (IMP-127).
        for (const controller of running.values()) controller.abort();
        for (const entry of hosted.values()) closeOf(entry);
        hosted.clear();
        void Promise.all([...closing].map((closed) => closed.catch(() => undefined)))
          .then(() => options.disposeRuntime?.())
          .catch(() => undefined)
          .finally(() => options.exit?.());
        return;
      }
    }
  };
};

// Started by the app as a utility process: the channel is the parent port. Imported anywhere else (the tests), there
// is none and nothing is served.
const parentPort = (process as NodeJS.Process & { parentPort?: Electron.ParentPort }).parentPort;
if (parentPort !== undefined) {
  const runtime = createSharedRuntime(async () =>
    (await import("node-llama-cpp")) as unknown as NativeLlamaModule);
  const receive = serveLocalModels((reply) => parentPort.postMessage(reply), {
    runtime: runtime.load,
    disposeRuntime: runtime.dispose,
    exit: () => process.exit(0),
  });
  parentPort.on("message", (event) => receive(event.data as LocalModelRequest));
}
