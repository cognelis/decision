import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { ObsidianVaultRepository } from "@cognelis/decision-storage";
import { describe, expect, it } from "vitest";

import {
  applicationSupportPaths,
  resolveDecisionUserData,
} from "../src/main/application-paths.js";
import {
  createObsidianSearchRuntime,
  obsidianSearchIndexPath,
  obsidianVaultIdentity,
  type ObsidianSearchRuntime,
  type ObsidianSearchRuntimeFactories,
} from "../src/main/obsidian-search/obsidian-search-runtime.js";
import type { ObsidianSearchStatus } from "../src/shared/obsidian-search.js";

const requiredEnvironmentNames = [
  "DECISION_REAL_VAULT_PATH",
  "DECISION_REAL_VAULT_QUERY",
  "DECISION_REAL_VAULT_EXPECTED_PATH",
] as const;
const childFlagName = "DECISION_REAL_VAULT_CHILD";
const childTemporaryDirectoryName = "DECISION_REAL_VAULT_TEMP_DIR";
const validationChildFlagName = "DECISION_REAL_VAULT_VALIDATE_CHILD";
const childDeadlineMs = 8 * 60 * 1_000;
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const testFilePath = fileURLToPath(import.meta.url);
const vitestPath = fileURLToPath(
  new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url),
);
const isAcceptanceChild = process.env[childFlagName] === "1";
const isValidationChild = process.env[validationChildFlagName] === "1";

const realVaultEnvironment = (): {
  vaultPath: string;
  query: string;
  expectedPath: string;
} | null => {
  const values = requiredEnvironmentNames.map((name) =>
    process.env[name]?.trim(),
  );
  if (values.some((value) => value === undefined || value.length === 0)) {
    return null;
  }
  return {
    vaultPath: values[0]!,
    query: values[1]!,
    expectedPath: values[2]!,
  };
};

const normalize = (value: string): string =>
  value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();

const assertPrivateCondition: (
  condition: boolean,
  message: string,
) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};

const readOnlyUserDataResolution = () => resolveDecisionUserData(process.env);

const readyStatus = (): ObsidianSearchStatus => ({
  state: "ready",
  discoveredNotes: 0,
  indexedNotes: 0,
  chunkCount: 0,
  processedNotes: 0,
  totalNotes: 0,
  skippedNotes: 0,
  failedNotes: 0,
  synchronizedAt: null,
  semanticAvailable: true,
  message: null,
});

const runFocusedChild = (
  childEnvironment: NodeJS.ProcessEnv,
  deadlineMs: number,
): Promise<boolean> =>
  new Promise((resolvePromise) => {
    let spawned = false;
    let settled = false;
    let timedOut = false;
    const child = spawn(
      process.execPath,
      [
        vitestPath,
        "run",
        testFilePath,
        "--reporter=dot",
        "--pool=threads",
        "--maxWorkers=1",
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          ...childEnvironment,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.resume();
    child.stderr.resume();
    const finish = (succeeded: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolvePromise(succeeded && !timedOut);
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, deadlineMs);
    child.once("spawn", () => {
      spawned = true;
    });
    child.once("error", () => {
      if (!spawned) finish(false);
    });
    child.once("exit", (code) => finish(code === 0));
  });

const runAcceptanceChild = (temporaryDirectory: string): Promise<boolean> =>
  runFocusedChild(
    {
      [childFlagName]: "1",
      [childTemporaryDirectoryName]: temporaryDirectory,
    },
    childDeadlineMs,
  );

describe("Obsidian real-vault acceptance boundary", () => {
  it("keeps opt-in inputs exact and production dependencies local", async () => {
    expect(requiredEnvironmentNames).toEqual([
      "DECISION_REAL_VAULT_PATH",
      "DECISION_REAL_VAULT_QUERY",
      "DECISION_REAL_VAULT_EXPECTED_PATH",
    ]);
    expect(requiredEnvironmentNames).not.toContain(childFlagName);
    expect(requiredEnvironmentNames).not.toContain(
      childTemporaryDirectoryName,
    );
    expect(requiredEnvironmentNames).not.toContain(validationChildFlagName);

    const productionFiles = [
      "../src/main/obsidian-search/obsidian-search-runtime.ts",
      "../src/main/obsidian-search/obsidian-search-service.ts",
      "../src/main/semantic/qwen-embedding-provider.ts",
    ];
    const sources = await Promise.all(
      productionFiles.map((path) =>
        readFile(fileURLToPath(new URL(path, import.meta.url)), "utf8"),
      ),
    );
    for (const source of sources) {
      expect(source).not.toMatch(/ProfiledModelGateway|ModelTraceStore/u);
    }
    expect(sources[0]).toContain("new ObsidianVaultRepository(");
    expect(sources[0]).toContain("new ObsidianSearchIndex(");
    expect(sources[0]).toContain("new QwenEmbeddingProvider(");
    expect(sources[0]).toContain("new ObsidianSearchService(");

    const boundarySource = await readFile(testFilePath, "utf8");
    const privateChildStart = boundarySource.lastIndexOf(
      "it.skipIf(!isAcceptanceChild)(",
    );
    expect(privateChildStart).toBeGreaterThan(0);
    const privateChildSource = boundarySource.slice(privateChildStart);
    expect(privateChildSource).toContain(
      'expected.matchKind === "semantic"',
    );
    expect(privateChildSource).not.toContain(
      'expected.matchKind === "semantic" ||',
    );
    expect(privateChildSource).toContain("const lexicalTerms = [...new Set(");
    expect(privateChildSource).toContain("const searchableCorpus = [");
    expect(privateChildSource).toContain("expected.relativePath,");
    expect(privateChildSource).toContain("for (const term of lexicalTerms)");
    expect(privateChildSource).toContain(
      "!field.includes(normalizedPhrase)",
    );
    expect(privateChildSource).toContain("!field.includes(term)");
  });

  it("composes the dedicated production seam through typed factories", async () => {
    const status = readyStatus();
    const calls: string[] = [];
    const repository = {
      iterate: async function* (): AsyncIterableIterator<never> { return; },
      resolveNotePath: async () => {
        throw new Error("synthetic path is never opened");
      },
    };
    const index = {
      semanticCoverage: () => ({ totalNotes: 0, semanticNotes: 0, keywordOnlyNotes: 0, mismatchedModelNotes: 0 }),
      noteMetadataForPath: () => null,
      hasNoteDescendant: () => false,
      replaceNote: () => undefined,
      prune: () => undefined,
      markSynchronized: () => undefined,
      snapshot: () => ({
        noteCount: 0,
        chunkCount: 0,
        synchronizedAt: null,
      }),
      hasNote: () => false,
      iterateChunks: function* () {
        return;
      },
      bindVault: () => undefined,
      vaultIdentity: () => "a".repeat(64),
      close: () => undefined,
    };
    const embedding = {
      embed: async () => ({ model: "synthetic-local", vectors: [] }),
      close: async () => undefined,
    };
    const runtimeFixture: ObsidianSearchRuntime = {
      start: () => undefined,
      status: () => status,
      search: async ({ query }) => ({ query, results: [], status }),
      rebuild: async () => status,
      openNote: async () => undefined,
      close: async () => undefined,
    };
    let serviceOptions: Record<string, unknown> | undefined;
    const factories: ObsidianSearchRuntimeFactories = {
      repository: () => {
        calls.push("repository");
        return repository;
      },
      index: () => {
        calls.push("index");
        return index;
      },
      embedding: () => {
        calls.push("embedding");
        return embedding;
      },
      watcher: () => {
        throw new Error("watcher must stay lazy");
      },
      service: (options) => {
        calls.push("service");
        serviceOptions = options as unknown as Record<string, unknown>;
        return runtimeFixture;
      },
    };
    const openExternal = async () => {
      throw new Error("opening is outside composition proof");
    };

    const runtime = await createObsidianSearchRuntime({
      vaultPath: join(tmpdir(), "synthetic-vault"),
      indexRoot: join(tmpdir(), "synthetic-user-data", "obsidian-search"),
      modelsDirectory: join(tmpdir(), "synthetic-user-data", "models"),
      openExternal,
      realpath: async (path) => path,
      factories,
    });

    expect(calls).toEqual(["repository", "index", "embedding", "service"]);
    expect(serviceOptions).toMatchObject({ repository, index, embedding });
    expect(serviceOptions?.openExternal).toBe(openExternal);
    // Answered through the runtime that can set a damaged index aside, by the service composed here.
    expect(runtime.status()).toBe(status);
    expect(await runtime.rebuild()).toBe(status);
    await runtime.close();
  });

  it.skipIf(isAcceptanceChild || isValidationChild)(
    "launches the focused child with the installed Vitest CLI",
    async () => {
      const succeeded = await runFocusedChild(
        { [validationChildFlagName]: "1" },
        30_000,
      );
      assertPrivateCondition(
        succeeded,
        "Focused acceptance child did not start successfully",
      );
    },
    45_000,
  );

  it.skipIf(
    isAcceptanceChild ||
      isValidationChild ||
      realVaultEnvironment() === null,
  )(
    "runs private acceptance in a killable child",
    async () => {
      const temporaryDirectory = await mkdtemp(
        join(tmpdir(), "decision-obsidian-search-acceptance-"),
      );
      let succeeded = false;
      let cleanupSucceeded = false;
      try {
        succeeded = await runAcceptanceChild(temporaryDirectory);
      } catch {
        succeeded = false;
      } finally {
        try {
          await rm(temporaryDirectory, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 100,
          });
          cleanupSucceeded = true;
        } catch {
          cleanupSucceeded = false;
        }
      }
      assertPrivateCondition(
        succeeded && cleanupSucceeded,
        "Real-vault acceptance child did not complete successfully",
      );
    },
    600_000,
  );

  it.skipIf(!isAcceptanceChild)(
    "recalls a nonliteral note with the production local runtime",
    async () => {
      const acceptance = realVaultEnvironment();
      const temporaryDirectory =
        process.env[childTemporaryDirectoryName]?.trim();
      assertPrivateCondition(
        acceptance !== null &&
          temporaryDirectory !== undefined &&
          temporaryDirectory.length > 0,
        "Real-vault acceptance child configuration is incomplete",
      );
      assertPrivateCondition(
        !acceptance.expectedPath.startsWith("Decision Journal/"),
        "Expected note must be outside the Decision library",
      );

      const indexRoot = join(
        temporaryDirectory,
        "obsidian-search",
      );
      const canonicalVault = await realpath(acceptance.vaultPath);
      const indexPath = obsidianSearchIndexPath(
        indexRoot,
        obsidianVaultIdentity(canonicalVault),
      );
      const userData = readOnlyUserDataResolution();
      let runtime: ObsidianSearchRuntime | undefined;
      let database: DatabaseSync | undefined;
      try {
        runtime = await createObsidianSearchRuntime({
          vaultPath: acceptance.vaultPath,
          indexRoot,
          modelsDirectory: applicationSupportPaths(userData.path).models,
          openExternal: async () => {
            throw new Error("Opening notes is outside real-vault acceptance");
          },
        });
        const status = await runtime.rebuild();
        assertPrivateCondition(
          status.state === "ready" && status.semanticAvailable,
          "Real-vault semantic index did not become ready",
        );
        assertPrivateCondition(
          status.indexedNotes > 0,
          "Real-vault index did not contain Markdown notes",
        );

        database = new DatabaseSync(indexPath, { readOnly: true });
        const outsideDecisionJournal = database
          .prepare(
            `SELECT 1 AS present
             FROM notes
             WHERE relative_path NOT GLOB 'Decision Journal/*'
             LIMIT 1`,
          )
          .get();
        assertPrivateCondition(
          outsideDecisionJournal !== undefined,
          "Real-vault index did not cover notes outside the Decision library",
        );

        const response = await runtime.search({
          query: acceptance.query,
          limit: 20,
        });
        assertPrivateCondition(
          response.status.state === "ready" &&
            response.status.semanticAvailable,
          "Semantic search did not remain ready",
        );
        const expected = response.results.find(
          (result) => result.relativePath === acceptance.expectedPath,
        );
        assertPrivateCondition(
          expected !== undefined,
          "Expected nonliteral note was not recalled",
        );
        assertPrivateCondition(
          expected.matchKind === "semantic",
          "Expected note was not recalled by semantic search alone",
        );

        const repository = new ObsidianVaultRepository(acceptance.vaultPath);
        const scan = await repository.scan();
        const sourceNote = scan.notes.find(
          (note) => note.relativePath === acceptance.expectedPath,
        );
        assertPrivateCondition(
          sourceNote !== undefined,
          "Expected note was not present in the Vault scan",
        );
        const normalizedPhrase = normalize(acceptance.query);
        const lexicalTerms = [...new Set(
          normalizedPhrase.split(/\s+/u).filter(Boolean),
        )];
        const searchableCorpus = [
          expected.relativePath,
          expected.title,
          expected.heading ?? "",
          expected.snippet,
          sourceNote.content,
        ].map(normalize);
        assertPrivateCondition(
          searchableCorpus.every(
            (field) => !field.includes(normalizedPhrase),
          ),
          "Acceptance query phrase had a lexical overlap",
        );
        for (const term of lexicalTerms) {
          assertPrivateCondition(
            searchableCorpus.every((field) => !field.includes(term)),
            "Acceptance query term had a lexical overlap",
          );
        }

        const publicStrings = [
          response.status.message ?? "",
          ...response.results.flatMap((result) => [
            result.relativePath,
            result.title,
            result.heading ?? "",
            result.snippet,
          ]),
        ];
        assertPrivateCondition(
          publicStrings.every(
            (value) => !value.includes(acceptance.vaultPath),
          ),
          "Search output exposed the absolute Vault path",
        );
      } finally {
        try {
          database?.close();
        } finally {
          await runtime?.close();
        }
      }
    },
    600_000,
  );
});
