import {
  createDecisionRecord,
  rationaleCandidateKey,
} from "@cognelis/decision-core";
import {
  CandidateSpool,
  CaptureSpool,
  DecisionStore,
  MarkdownRepository,
  SqliteIndex,
  SemanticPairSpool,
  captureEventKey,
  captureQuestionKey,
} from "@cognelis/decision-storage";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { CaptureRuntime } from "../src/main/capture-runtime.js";
import { SemanticPairInbox } from "../src/main/semantic-pair-inbox.js";
import {
  serverCandidateFixture,
  serverCaptureFixture,
  semanticPairFixture,
} from "./fixtures.js";

const semanticSpoolDelegates = (spool: CaptureSpool) => ({
  isAcknowledged: (
    event: Parameters<CaptureSpool["isAcknowledged"]>[0],
    questionIndex: number,
  ) => spool.isAcknowledged(event, questionIndex),
  rememberSemanticOccurrence: (
    occurrenceId: string,
    semanticKey: string,
    mode: "structured_tool" | "transcript",
    capturedAt: string,
  ) =>
    spool.rememberSemanticOccurrence(
      occurrenceId,
      semanticKey,
      mode,
      capturedAt,
    ),
  claimCrossModeSemantic: (
    semanticKey: string,
    mode: "structured_tool" | "transcript",
    capturedAt: string,
    maximumAgeMs: number,
    aliasCandidateKey: string,
  ) =>
    spool.claimCrossModeSemantic(
      semanticKey,
      mode,
      capturedAt,
      maximumAgeMs,
      aliasCandidateKey,
    ),
  claimKnownSemanticOccurrence: (
    occurrenceId: string,
    aliasMode: "structured_tool" | "transcript",
    aliasCandidateKey: string,
  ) =>
    spool.claimKnownSemanticOccurrence(
      occurrenceId,
      aliasMode,
      aliasCandidateKey,
    ),
});

describe("recovery", () => {
  it("acknowledges a recovered semantic pair only after its consumer succeeds", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "decision-semantic-recovery-"),
    );
    const spool = new SemanticPairSpool(join(root, "semantic-pairs"));
    const first = semanticPairFixture({ pairId: "first" });
    const second = semanticPairFixture({ pairId: "second" });
    await spool.append(first);
    await spool.append(second);
    const attempts: string[] = [];
    const inbox = new SemanticPairInbox({
      spool,
      consume: async (pair) => {
        attempts.push(pair.pairId);
        if (pair.pairId === "second") {
          throw new Error("semantic worker unavailable");
        }
        return "processed";
      },
    });

    await inbox.recover();
    await inbox.flush();

    expect(attempts).toEqual(["first", "second"]);
    expect(
      (await spool.list()).map((pair) => pair.pairId),
    ).toEqual(["second"]);
    expect(await spool.isAcknowledged("first")).toBe(true);
    expect(await spool.isAcknowledged("second")).toBe(false);
  });

  it("does not decide again a pair decided already", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-semantic-decided-"));
    const spool = new SemanticPairSpool(join(root, "semantic-pairs"));
    const pair = semanticPairFixture();
    await spool.append(pair);
    await spool.acknowledge(pair.pairId);
    const consume = vi.fn(async () => "processed" as const);
    const inbox = new SemanticPairInbox({ spool, consume });

    // The hook delivers it again: a replay, or the same answer given twice in a Claude Code session.
    await inbox.enqueue(pair);
    await inbox.recover();
    await inbox.flush();

    expect(consume).not.toHaveBeenCalled();
  });

  it("tries a pair that failed again when the next one arrives, not only at the next start", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-semantic-retry-"));
    const spool = new SemanticPairSpool(join(root, "semantic-pairs"));
    const attempts: string[] = [];
    let failing = true;
    const inbox = new SemanticPairInbox({
      spool,
      consume: async (pair) => {
        attempts.push(pair.pairId);
        if (failing) throw new Error("disk full");
        return "processed";
      },
    });

    await inbox.enqueue(semanticPairFixture({ pairId: "first" }));
    await inbox.flush();
    failing = false;
    await inbox.enqueue(semanticPairFixture({ pairId: "second" }));

    await vi.waitFor(async () => {
      await inbox.flush();
      expect(await spool.list()).toEqual([]);
    });
    expect(attempts.filter((pairId) => pairId === "first").length).toBeGreaterThan(1);
    expect(attempts).toContain("second");
  });

  it("finishes only the pair being classified at quit, and keeps the rest for the next start", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-semantic-quit-"));
    const spool = new SemanticPairSpool(join(root, "semantic-pairs"));
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const attempts: string[] = [];
    const inbox = new SemanticPairInbox({
      spool,
      consume: async (pair) => {
        attempts.push(pair.pairId);
        await blocked;
        return "processed";
      },
    });
    for (const pairId of ["first", "second", "third"]) {
      await spool.append(semanticPairFixture({ pairId }));
    }
    await inbox.recover();
    await vi.waitFor(() => expect(attempts).toHaveLength(1));

    const closed = inbox.close();
    release?.();
    await closed;

    expect(attempts).toHaveLength(1);
    expect(await spool.list()).toHaveLength(2);
  });

  it("returns from enqueue before a semantic consumer finishes", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "decision-semantic-inbox-"),
    );
    const spool = new SemanticPairSpool(join(root, "semantic-pairs"));
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inbox = new SemanticPairInbox({
      spool,
      consume: async () => {
        await blocked;
        return "processed";
      },
    });
    const pair = semanticPairFixture();

    await expect(inbox.enqueue(pair)).resolves.toBe("accepted");
    expect(await spool.list()).toEqual([pair]);
    release?.();
    await inbox.flush();
    expect(await spool.list()).toEqual([]);
  });

  it("does not restore a candidate already promoted into the capture spool", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "decision-promotion-recovery-"),
    );
    const repository = new MarkdownRepository(join(root, "vault"));
    const index = new SqliteIndex(join(root, "index.sqlite"));
    const captureSpool = new CaptureSpool(
      join(root, "capture-spool"),
    );
    const candidateSpool = new CandidateSpool(
      join(root, "candidate-spool"),
    );
    const candidate = serverCandidateFixture();
    await candidateSpool.append(candidate);
    await captureSpool.append(candidate.event);
    const runtime = new CaptureRuntime({
      spool: captureSpool,
      candidateSpool,
      store: new DecisionStore(repository, index),
      index,
      idFactory: () => "recovered-promotion",
    });

    const pendingCaptures = await captureSpool.list();
    await runtime.resumeCandidates(
      await candidateSpool.list(),
      pendingCaptures,
    );
    for (const event of pendingCaptures) {
      await runtime.ingest(event);
    }

    expect(runtime.candidates.snapshot()).toEqual({
      current: null,
      count: 0,
    });
    expect(await candidateSpool.list()).toEqual([]);
    expect(runtime.queue.snapshot().current).toMatchObject({
      event: candidate.event,
    });
    index.close();
  });

  it("retries a failed recovered promotion receipt before disposing the capture", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "decision-promotion-receipt-"),
    );
    const repository = new MarkdownRepository(join(root, "vault"));
    const index = new SqliteIndex(join(root, "index.sqlite"));
    const captureSpool = new CaptureSpool(
      join(root, "capture-spool"),
    );
    const candidateSpool = new CandidateSpool(
      join(root, "candidate-spool"),
    );
    const candidate = serverCandidateFixture();
    await candidateSpool.append(candidate);
    await captureSpool.append(candidate.event);
    let acknowledgeAttempts = 0;
    const recoveringCandidateSpool = {
      append: (
        input: Parameters<CandidateSpool["append"]>[0],
      ) => candidateSpool.append(input),
      acknowledge: async (candidateId: string) => {
        acknowledgeAttempts += 1;
        if (acknowledgeAttempts === 1) {
          throw new Error("temporary receipt failure");
        }
        await candidateSpool.acknowledge(candidateId);
      },
      isAcknowledged: (candidateId: string) =>
        candidateSpool.isAcknowledged(candidateId),
    };
    const runtime = new CaptureRuntime({
      spool: captureSpool,
      candidateSpool: recoveringCandidateSpool,
      store: new DecisionStore(repository, index),
      index,
      idFactory: () => "recovered-receipt",
    });

    const pendingCaptures = await captureSpool.list();
    await runtime.resumeCandidates(
      await candidateSpool.list(),
      pendingCaptures,
    );
    for (const event of pendingCaptures) {
      await runtime.ingest(event);
    }
    await runtime.queue.submit({ status: "skipped" });

    expect(acknowledgeAttempts).toBe(2);
    expect(await captureSpool.list()).toEqual([]);
    expect(await candidateSpool.list()).toEqual([]);

    const restarted = new CaptureRuntime({
      spool: captureSpool,
      candidateSpool,
      store: new DecisionStore(repository, index),
      index,
      idFactory: () => "must-not-restore",
    });
    const restartedCaptures = await captureSpool.list();
    for (const event of restartedCaptures) {
      await restarted.ingest(event);
    }
    await restarted.resumeCandidates(
      await candidateSpool.list(),
      restartedCaptures,
    );
    expect(restarted.candidates.snapshot()).toEqual({
      current: null,
      count: 0,
    });
    index.close();
  });

  it("keeps durable promotion evidence when Markdown exists but candidate receipts still fail", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "decision-existing-promotion-"),
    );
    const repository = new MarkdownRepository(join(root, "vault"));
    const index = new SqliteIndex(join(root, "index.sqlite"));
    const captureSpool = new CaptureSpool(
      join(root, "capture-spool"),
    );
    const candidateSpool = new CandidateSpool(
      join(root, "candidate-spool"),
    );
    const candidate = serverCandidateFixture();
    const question = candidate.event.questions[0]!;
    const candidateKey = rationaleCandidateKey(
      candidate.event,
      question,
    );
    await new DecisionStore(repository, index).save(
      createDecisionRecord(
        {
          status: "awaiting_rationale",
          candidateId: "already-persisted",
          candidateKey,
          event: candidate.event,
          question,
        },
        { status: "skipped" },
        `decision-${candidateKey}`,
        new Date(candidate.event.capturedAt),
      ),
    );
    await candidateSpool.append(candidate);
    await captureSpool.append(candidate.event);
    let failures = 0;
    const failingCandidateSpool = {
      append: (
        input: Parameters<CandidateSpool["append"]>[0],
      ) => candidateSpool.append(input),
      acknowledge: async () => {
        failures += 1;
        throw new Error("candidate receipt unavailable");
      },
      isAcknowledged: (candidateId: string) =>
        candidateSpool.isAcknowledged(candidateId),
    };
    const first = new CaptureRuntime({
      spool: captureSpool,
      candidateSpool: failingCandidateSpool,
      store: new DecisionStore(repository, index),
      index,
      idFactory: () => "existing-promotion-first",
    });
    const firstCaptures = await captureSpool.list();
    await first.resumeCandidates(
      await candidateSpool.list(),
      firstCaptures,
    );
    await expect(
      Promise.all(
        firstCaptures.map((event) => first.ingest(event)),
      ),
    ).rejects.toThrow(/candidate receipt unavailable/u);
    expect((await repository.scan()).notes).toHaveLength(1);
    expect(await captureSpool.list()).toHaveLength(1);
    expect(await candidateSpool.list()).toHaveLength(1);

    const second = new CaptureRuntime({
      spool: captureSpool,
      candidateSpool: failingCandidateSpool,
      store: new DecisionStore(repository, index),
      index,
      idFactory: () => "existing-promotion-second",
    });
    const secondCaptures = await captureSpool.list();
    await second.resumeCandidates(
      await candidateSpool.list(),
      secondCaptures,
    );
    await expect(
      Promise.all(
        secondCaptures.map((event) => second.ingest(event)),
      ),
    ).rejects.toThrow(/candidate receipt unavailable/u);
    expect(await captureSpool.list()).toHaveLength(1);
    expect(await candidateSpool.list()).toHaveLength(1);

    const third = new CaptureRuntime({
      spool: captureSpool,
      candidateSpool,
      store: new DecisionStore(repository, index),
      index,
      idFactory: () => "existing-promotion-third",
    });
    const thirdCaptures = await captureSpool.list();
    await third.resumeCandidates(
      await candidateSpool.list(),
      thirdCaptures,
    );
    for (const event of thirdCaptures) {
      await third.ingest(event);
    }
    expect(third.candidates.snapshot()).toEqual({
      current: null,
      count: 0,
    });
    expect(third.queue.snapshot().current).toBeNull();
    expect(await captureSpool.list()).toEqual([]);
    expect(await candidateSpool.list()).toEqual([]);
    index.close();
  });

  it("restores an unreviewed candidate and promotes it through the durable capture spool", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "decision-candidate-recovery-"),
    );
    const repository = new MarkdownRepository(join(root, "vault"));
    const index = new SqliteIndex(join(root, "index.sqlite"));
    const captureSpool = new CaptureSpool(
      join(root, "capture-spool"),
    );
    const candidateSpool = new CandidateSpool(
      join(root, "candidate-spool"),
      { now: () => new Date("2026-07-28T00:00:00.000Z") },
    );
    const candidate = serverCandidateFixture();
    await candidateSpool.append(candidate);
    const runtime = new CaptureRuntime({
      spool: captureSpool,
      candidateSpool,
      store: new DecisionStore(repository, index),
      index,
      idFactory: () => "recovered-rationale",
    });

    await runtime.resumeCandidates(await candidateSpool.list());
    expect(runtime.candidates.snapshot()).toMatchObject({
      current: candidate,
      count: 1,
    });

    await runtime.confirmCurrentCandidate();

    expect(await candidateSpool.list()).toEqual([]);
    expect(await captureSpool.list()).toEqual([candidate.event]);
    expect(runtime.queue.snapshot().current).toMatchObject({
      event: candidate.event,
    });
    index.close();
  });

  it("keeps a capture waiting while its vault has gone, and saves it once the vault is back", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-vault-gone-"));
    const vault = join(root, "vault");
    const index = new SqliteIndex(join(root, "index.sqlite"));
    const captureSpool = new CaptureSpool(join(root, "capture-spool"));
    const runtime = new CaptureRuntime({
      spool: captureSpool,
      store: new DecisionStore(new MarkdownRepository(vault, { existingVault: true }), index),
      index,
      idFactory: () => "vault-gone-decision",
    });

    // The vault is on a drive that is not connected: the decision cannot be written, and nothing is made up.
    await runtime.ingest(serverCaptureFixture());
    await runtime.queue.submit({ status: "skipped" }).catch(() => undefined);
    await expect(readdir(root)).resolves.not.toContain("vault");
    expect(await captureSpool.list()).toHaveLength(1);
    expect(index.count()).toBe(0);

    // The drive is back: the same capture, still waiting, is saved.
    await mkdir(vault);
    await runtime.queue.retryCurrentPersistence();
    expect(index.count()).toBe(1);
    index.close();
  });

  it("keeps a decision recognised in memory, not from a hook, across a restart, put off or not", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-ingest-recovery-"));
    const open = () => {
      const index = new SqliteIndex(join(root, "index.sqlite"));
      const captureSpool = new CaptureSpool(join(root, "capture-spool"));
      const runtime = new CaptureRuntime({
        spool: captureSpool,
        store: new DecisionStore(new MarkdownRepository(join(root, "vault")), index),
        index,
        idFactory: () => "recovered-rationale",
      });
      // What the app does as it starts: every spooled capture is taken in again.
      const boot = async () => {
        for (const event of await captureSpool.list()) await runtime.ingest(event);
      };
      return { index, runtime, boot };
    };
    // A text answer the semantic path found: handed straight to the runtime, the bridge never saw it.
    const first = open();
    await first.runtime.ingest(serverCaptureFixture());
    expect(first.runtime.queue.snapshot().current).not.toBeNull();
    first.index.close();

    const second = open();
    await second.boot();
    expect(second.runtime.queue.snapshot().current).not.toBeNull();
    // Read once more, as the app does after its service starts: nothing is taken in twice.
    await second.boot();
    expect(second.runtime.queue.snapshot().waitingCount).toBe(0);
    await second.runtime.queue.submit({ status: "deferred", expectedOutcome: "两周内规则够用。" });
    expect(second.runtime.pendingRationales()).toHaveLength(1);
    second.index.close();

    const third = open();
    await third.boot();
    expect(third.runtime.pendingRationales()).toHaveLength(1);
    third.index.close();
  });

  it("keeps bootstrap running when one question receipt is unreadable", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "decision-recovery-"),
    );
    const repository = new MarkdownRepository(join(root, "vault"));
    const index = new SqliteIndex(join(root, "index.sqlite"));
    const spoolRoot = join(root, "spool");
    const spool = new CaptureSpool(spoolRoot);
    const first = serverCaptureFixture().questions[0]!;
    const event = serverCaptureFixture({
      questions: [
        first,
        {
          ...first,
          questionIndex: 1,
          question: "Which fallback should remain pending?",
        },
      ],
    });
    await spool.append(event);
    await spool.acknowledge(event, 0);
    await writeFile(
      join(
        spoolRoot,
        "events",
        `${captureEventKey(event)}.json`,
      ),
      JSON.stringify(event),
      "utf8",
    );
    await mkdir(
      join(
        spoolRoot,
        "receipts",
        `${captureQuestionKey(event, 1)}.ack`,
      ),
    );
    const runtime = new CaptureRuntime({
      spool,
      store: new DecisionStore(repository, index),
      index,
      idFactory: () => "must-not-queue-unknown-receipt",
    });

    const pending = await spool.list();
    await expect(
      Promise.all(
        pending.map((captured) => runtime.ingest(captured)),
      ),
    ).resolves.toEqual([{ accepted: 0, duplicates: 0 }]);

    expect(runtime.queue.snapshot().current).toBeNull();
    expect(runtime.health()).toMatchObject({
      recovery: "degraded",
    });
    expect(
      (await spool.list())[0]?.questions.map(
        (question) => question.questionIndex,
      ),
    ).toEqual([1]);
    index.close();
  });

  it("recovers a local deferred rationale without writing Markdown", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "decision-recovery-"),
    );
    const repository = new MarkdownRepository(join(root, "vault"));
    const index = new SqliteIndex(join(root, "index.sqlite"));
    const spool = new CaptureSpool(join(root, "spool"));
    const store = new DecisionStore(repository, index);
    let sequence = 0;
    const runtime = new CaptureRuntime({
      spool,
      store,
      index,
      idFactory: () => `id-${++sequence}`,
    });
    await spool.append(serverCaptureFixture());

    for (const event of await spool.list()) {
      await runtime.ingest(event);
    }
    expect(runtime.queue.snapshot().current?.status).toBe(
      "awaiting_rationale",
    );
    await runtime.queue.submit({ status: "deferred" });

    expect(await spool.list()).toEqual([serverCaptureFixture()]);
    expect((await repository.scan()).notes).toEqual([]);
    expect(index.count()).toBe(0);
    const pending = runtime.pendingRationales()[0]!;

    const restarted = new CaptureRuntime({
      spool,
      store,
      index,
      idFactory: () => "must-not-queue-deferred",
    });
    for (const event of await spool.list()) {
      await restarted.ingest(event);
    }

    expect(restarted.queue.snapshot().current).toBeNull();
    expect(restarted.pendingRationales()).toEqual([pending]);
    expect((await repository.scan()).notes).toEqual([]);
    expect(index.count()).toBe(0);

    await restarted.completeDeferredRationale(pending.id, {
      rationale: "  补上的原始理由。  ",
      reasonFactors: ["reversibility"],
    });

    expect(restarted.pendingRationales()).toEqual([]);
    expect(await spool.list()).toEqual([]);
    expect(index.search("补上的原始理由")).toHaveLength(1);
    const note = (await repository.scan()).notes[0]!;
    expect(note.record).toMatchObject({
      id: pending.id,
      status: "completed",
      rationaleStatus: "captured",
    });

    index.rebuild([]);
    expect(index.count()).toBe(0);
    const report = await restarted.rebuildIndex();
    expect(report.indexedCount).toBe(1);
    expect(index.search("补上的原始理由")).toHaveLength(1);
    index.close();
  });

  it("restores a submitted rationale after a failed Markdown write", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "decision-recovery-"),
    );
    const repository = new MarkdownRepository(join(root, "vault"));
    const index = new SqliteIndex(join(root, "index.sqlite"));
    const spool = new CaptureSpool(join(root, "spool"));
    const event = serverCaptureFixture();
    await spool.append(event);
    const failing = new CaptureRuntime({
      spool,
      store: {
        save: async () => {
          throw new Error("temporary vault failure");
        },
      },
      index,
      idFactory: () => "failed-process-candidate",
    });
    await failing.ingest(event);

    await expect(
      failing.queue.submit({
        status: "captured",
        rationale: "不能因重启丢失的原始理由",
        reasonFactors: ["risk"],
      }),
    ).rejects.toThrow(/决策没能写入 Obsidian/u);

    const recovered = new CaptureRuntime({
      spool,
      store: new DecisionStore(repository, index),
      index,
      idFactory: () => "recovered-process-candidate",
    });
    for (const pending of await spool.list()) {
      await recovered.ingest(pending);
    }

    expect(recovered.queue.snapshot().current).toBeNull();
    expect(await spool.list()).toEqual([]);
    expect((await repository.scan()).notes[0]?.record).toMatchObject({
      rationaleOriginal: "不能因重启丢失的原始理由",
      reasonFactors: ["risk"],
    });
    index.close();
  });

  it("does not re-prompt after Markdown saved before acknowledgement", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "decision-recovery-"),
    );
    const repository = new MarkdownRepository(join(root, "vault"));
    const databasePath = join(root, "index.sqlite");
    const firstIndex = new SqliteIndex(databasePath);
    const spool = new CaptureSpool(join(root, "spool"));
    const event = serverCaptureFixture();
    await spool.append(event);
    const first = new CaptureRuntime({
      spool: {
        ...semanticSpoolDelegates(spool),
        saveDisposition: (captured, questionIndex, submission) =>
          spool.saveDisposition(
            captured,
            questionIndex,
            submission,
          ),
        loadDisposition: (captured, questionIndex) =>
          spool.loadDisposition(captured, questionIndex),
        acknowledge: async () => {
          throw new Error("process exited before acknowledgement");
        },
      },
      store: new DecisionStore(repository, firstIndex),
      index: firstIndex,
      idFactory: () => "first-process-candidate",
    });
    await first.ingest(event);
    await expect(
      first.queue.submit({ status: "skipped" }),
    ).rejects.toThrow(/决策已写入 Obsidian，但本机恢复队列没能更新/u);
    firstIndex.close();

    const recoveredIndex = new SqliteIndex(databasePath);
    const recoveredStore = new DecisionStore(
      repository,
      recoveredIndex,
    );
    await recoveredStore.rebuildIndex();
    const recovered = new CaptureRuntime({
      spool,
      store: recoveredStore,
      index: recoveredIndex,
      idFactory: () => "recovered-process-candidate",
    });
    for (const pending of await spool.list()) {
      await recovered.ingest(pending);
    }

    expect(recovered.queue.snapshot().current).toBeNull();
    expect(await spool.list()).toEqual([]);
    expect((await repository.scan()).notes).toHaveLength(1);
    recoveredIndex.close();
  });

  it("deduplicates a semantic cross-mode replay after a clean restart", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "decision-recovery-"),
    );
    const repository = new MarkdownRepository(join(root, "vault"));
    const databasePath = join(root, "index.sqlite");
    const spool = new CaptureSpool(join(root, "spool"));
    const structured = serverCaptureFixture();
    const {
      toolUseId: _toolUseId,
      ...transcript
    } = serverCaptureFixture({
      captureMode: "transcript",
      sourceEventId: "stop-1:prompt-1",
      batchId: "text-batch",
      capturedAt: "2026-07-25T00:05:00.000Z",
    });
    const firstIndex = new SqliteIndex(databasePath);
    const first = new CaptureRuntime({
      spool,
      store: new DecisionStore(repository, firstIndex),
      index: firstIndex,
      idFactory: () => "first-candidate",
    });
    await spool.append(structured);
    await first.ingest(structured);
    await first.queue.submit({ status: "skipped" });
    firstIndex.close();

    const recoveredIndex = new SqliteIndex(databasePath);
    const recovered = new CaptureRuntime({
      spool,
      store: new DecisionStore(repository, recoveredIndex),
      index: recoveredIndex,
      idFactory: () => "must-not-create-candidate",
    });
    await spool.append(transcript);

    await expect(recovered.ingest(transcript)).resolves.toEqual({
      accepted: 0,
      duplicates: 1,
    });
    expect(recovered.queue.snapshot().current).toBeNull();
    expect(await spool.list()).toEqual([]);
    expect((await repository.scan()).notes).toHaveLength(1);
    recoveredIndex.close();
  });

  it("retries a claimed unrecorded alias after acknowledgement failure and restart", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "decision-recovery-"),
    );
    const repository = new MarkdownRepository(join(root, "vault"));
    const index = new SqliteIndex(join(root, "index.sqlite"));
    const spool = new CaptureSpool(join(root, "spool"));
    const store = new DecisionStore(repository, index);
    const structured = serverCaptureFixture();
    const {
      toolUseId: _toolUseId,
      ...transcript
    } = serverCaptureFixture({
      captureMode: "transcript",
      sourceEventId: "stop-1:prompt-1",
      batchId: "text-batch",
      capturedAt: "2026-07-25T00:05:00.000Z",
    });
    const primary = new CaptureRuntime({
      spool,
      store,
      index,
      idFactory: () => "primary-candidate",
    });
    await spool.append(structured);
    await primary.ingest(structured);
    await primary.queue.submit({ status: "not_recorded" });
    await spool.append(transcript);

    const failingAlias = new CaptureRuntime({
      spool: {
        ...semanticSpoolDelegates(spool),
        acknowledge: async () => {
          throw new Error("temporary acknowledgement failure");
        },
      },
      store,
      index,
      idFactory: () => "must-not-create-alias",
    });
    await expect(
      failingAlias.ingest(transcript),
    ).rejects.toThrow(/temporary acknowledgement failure/i);

    await store.rebuildIndex();
    const recovered = new CaptureRuntime({
      spool,
      store,
      index,
      idFactory: () => "must-not-create-after-restart",
    });
    for (const pending of await spool.list()) {
      await recovered.ingest(pending);
    }

    expect(recovered.queue.snapshot().current).toBeNull();
    expect(await spool.list()).toEqual([]);
    expect((await repository.scan()).notes).toHaveLength(0);
    index.close();
  });

  it("deduplicates only one persisted alias before accepting a repeated decision", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "decision-recovery-"),
    );
    const repository = new MarkdownRepository(join(root, "vault"));
    const index = new SqliteIndex(join(root, "index.sqlite"));
    const spool = new CaptureSpool(join(root, "spool"));
    const store = new DecisionStore(repository, index);
    const structured = serverCaptureFixture();
    const transcript = (sequence: number) => {
      const {
        toolUseId: _toolUseId,
        ...captured
      } = serverCaptureFixture({
        captureMode: "transcript",
        sourceEventId: `stop-${sequence}:prompt-${sequence}`,
        batchId: `text-batch-${sequence}`,
        capturedAt: `2026-07-25T00:0${sequence}:00.000Z`,
      });
      return captured;
    };
    const primary = new CaptureRuntime({
      spool,
      store,
      index,
      idFactory: () => "primary",
    });
    await primary.ingest(structured);
    await primary.queue.submit({ status: "skipped" });

    const recovered = new CaptureRuntime({
      spool,
      store,
      index,
      idFactory: () => "repeated-decision",
    });
    await expect(recovered.ingest(transcript(1))).resolves.toEqual({
      accepted: 0,
      duplicates: 1,
    });
    await expect(recovered.ingest(transcript(2))).resolves.toEqual({
      accepted: 1,
      duplicates: 0,
    });
    expect(recovered.queue.snapshot().current?.candidateId).toBe(
      "repeated-decision",
    );
    index.close();
  });

  it("counts an alias paired while the primary was still pending", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "decision-recovery-"),
    );
    const repository = new MarkdownRepository(join(root, "vault"));
    const index = new SqliteIndex(join(root, "index.sqlite"));
    const spool = new CaptureSpool(join(root, "spool"));
    const store = new DecisionStore(repository, index);
    const structured = serverCaptureFixture();
    const transcript = (sequence: number) => {
      const {
        toolUseId: _toolUseId,
        ...captured
      } = serverCaptureFixture({
        captureMode: "transcript",
        sourceEventId: `stop-${sequence}:prompt-${sequence}`,
        batchId: `pending-text-batch-${sequence}`,
        capturedAt: `2026-07-25T00:0${sequence}:00.000Z`,
      });
      return captured;
    };
    const pending = new CaptureRuntime({
      spool,
      store,
      index,
      idFactory: () => "primary",
    });
    await pending.ingest(structured);
    await expect(pending.ingest(transcript(1))).resolves.toEqual({
      accepted: 0,
      duplicates: 1,
    });
    await pending.queue.submit({ status: "skipped" });

    const recovered = new CaptureRuntime({
      spool,
      store,
      index,
      idFactory: () => "repeated-decision",
    });
    await expect(recovered.ingest(transcript(2))).resolves.toEqual({
      accepted: 1,
      duplicates: 0,
    });
    index.close();
  });

  it("does not revive a consumed alias claim after an exact primary replay", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "decision-recovery-"),
    );
    const repository = new MarkdownRepository(join(root, "vault"));
    const index = new SqliteIndex(join(root, "index.sqlite"));
    const spool = new CaptureSpool(join(root, "spool"));
    const store = new DecisionStore(repository, index);
    const structured = serverCaptureFixture();
    const transcript = (sequence: number) => {
      const {
        toolUseId: _toolUseId,
        ...captured
      } = serverCaptureFixture({
        captureMode: "transcript",
        sourceEventId: `stop-${sequence}:prompt-${sequence}`,
        batchId: `exact-text-batch-${sequence}`,
        capturedAt: `2026-07-25T00:0${sequence}:00.000Z`,
      });
      return captured;
    };
    const primary = new CaptureRuntime({
      spool,
      store,
      index,
      idFactory: () => "primary",
    });
    await primary.ingest(structured);
    await primary.queue.submit({ status: "skipped" });

    const recovered = new CaptureRuntime({
      spool,
      store,
      index,
      idFactory: () => "repeated-decision",
    });
    await expect(recovered.ingest(transcript(1))).resolves.toEqual({
      accepted: 0,
      duplicates: 1,
    });
    await expect(recovered.ingest(structured)).resolves.toEqual({
      accepted: 0,
      duplicates: 1,
    });
    await expect(recovered.ingest(transcript(2))).resolves.toEqual({
      accepted: 1,
      duplicates: 0,
    });
    index.close();
  });

  it("does not re-prompt an exact unrecorded event after restart", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "decision-recovery-"),
    );
    const repository = new MarkdownRepository(join(root, "vault"));
    const index = new SqliteIndex(join(root, "index.sqlite"));
    const spool = new CaptureSpool(join(root, "spool"));
    const store = new DecisionStore(repository, index);
    const event = serverCaptureFixture();
    const first = new CaptureRuntime({
      spool,
      store,
      index,
      idFactory: () => "primary",
    });
    await spool.append(event);
    await first.ingest(event);
    await first.queue.submit({ status: "not_recorded" });

    const recovered = new CaptureRuntime({
      spool,
      store,
      index,
      idFactory: () => "must-not-create",
    });

    await expect(recovered.ingest(event)).resolves.toEqual({
      accepted: 0,
      duplicates: 1,
    });
    expect(recovered.queue.snapshot().current).toBeNull();
    expect((await repository.scan()).notes).toHaveLength(0);
    index.close();
  });
});
