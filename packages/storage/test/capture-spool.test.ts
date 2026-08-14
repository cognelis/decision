import {
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type {
  CapturedDecisionEvent,
  CapturedQuestion,
} from "@cognelis/decision-protocol";

import {
  CaptureDispositionCorruptError,
  CaptureSpool,
  captureEventKey,
  captureQuestionKey,
} from "../src/index.js";

const questionFixture = (questionIndex = 0): CapturedQuestion => ({
  questionIndex,
  header: "Storage",
  question: `Which storage format? ${questionIndex}`,
  options: [
    { id: "markdown", label: "Markdown", description: "Readable" },
    { id: "sqlite", label: "SQLite", description: "Queryable" },
  ],
  answer: { kind: "preset", values: ["Markdown"] },
  multiSelect: false,
});

const captureFixture = (
  overrides: Partial<CapturedDecisionEvent> = {},
): CapturedDecisionEvent => ({
  eventVersion: 1,
  captureMode: "structured_tool",
  sourceClient: "test",
  sessionId: "session-1",
  turnId: "turn-1",
  sourceEventId: "event-1",
  toolUseId: "tool-1",
  batchId: "test:session-1:tool-1",
  project: "decision",
  cwd: "/tmp/decision",
  capturedAt: "2026-07-25T00:00:00.000Z",
  questions: [questionFixture()],
  ...overrides,
});

describe("CaptureSpool", () => {
  it("atomically stores, lists, acknowledges, and removes capture bodies", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-spool-"));
    const spool = new CaptureSpool(root);
    const event = captureFixture();

    await spool.append(event);
    await spool.append(event);
    expect(await spool.list()).toEqual([event]);

    await spool.acknowledge(event, 0);

    expect(await spool.list()).toEqual([]);
    expect(await spool.isAcknowledged(event, 0)).toBe(true);
    expect((await stat(join(root, "receipts"))).mode & 0o777).toBe(0o700);
  });

  it("keeps unacknowledged questions from the same batch", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-spool-"));
    const spool = new CaptureSpool(root);
    const event = captureFixture({
      questions: [questionFixture(0), questionFixture(1)],
    });

    await spool.append(event);
    await spool.acknowledge(event, 0);

    expect(
      (await spool.list())[0]?.questions.map(
        (question) => question.questionIndex,
      ),
    ).toEqual([1]);
  });

  it("derives stable opaque event and question keys", () => {
    const event = captureFixture();
    const replayedLater = captureFixture({
      capturedAt: "2026-07-25T00:05:00.000Z",
    });

    expect(captureEventKey(event)).toMatch(/^[a-f0-9]{64}$/);
    expect(captureEventKey(replayedLater)).toBe(
      captureEventKey(event),
    );
    expect(captureQuestionKey(event, 0)).toMatch(/^[a-f0-9]{64}$/);
    expect(captureQuestionKey(event, 0)).not.toBe(captureEventKey(event));
    expect(captureQuestionKey(event, 1)).not.toBe(
      captureQuestionKey(event, 0),
    );
  });

  it("acknowledges retries even when their observation time differs", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-spool-"));
    const spool = new CaptureSpool(root);
    const event = captureFixture();
    const replayedLater = captureFixture({
      capturedAt: "2026-07-25T00:05:00.000Z",
    });

    await spool.append(event);
    await spool.append(replayedLater);
    expect(await spool.list()).toEqual([event]);

    await spool.acknowledge(event, 0);

    expect(await spool.list()).toEqual([]);
    expect(await spool.isAcknowledged(replayedLater, 0)).toBe(true);
  });

  it("journals a rationale privately until the question is acknowledged", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-spool-"));
    const spool = new CaptureSpool(root);
    const event = captureFixture();
    const submission = {
      status: "captured" as const,
      rationale: "  用户的原始理由。  ",
      reasonFactors: ["risk"],
      appliedPrincipleIds: ["principle-1", "principle-2"],
    };
    await spool.append(event);

    await spool.saveDisposition(event, 0, submission);

    await expect(
      spool.loadDisposition(event, 0),
    ).resolves.toEqual(submission);
    const dispositionPath = join(
      root,
      "dispositions",
      `${captureQuestionKey(event, 0)}.json`,
    );
    expect((await stat(join(root, "dispositions"))).mode & 0o777).toBe(
      0o700,
    );
    expect((await stat(dispositionPath)).mode & 0o777).toBe(0o600);

    await spool.acknowledge(event, 0);

    await expect(
      spool.loadDisposition(event, 0),
    ).resolves.toBeNull();
  });

  it("preserves applied principles in deferred recovery and rejects tampering", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-spool-"));
    const spool = new CaptureSpool(root);
    const event = captureFixture();
    await spool.append(event);
    await spool.saveDisposition(event, 0, {
      status: "deferred",
      appliedPrincipleIds: ["principle-1"],
    });

    await expect(spool.loadDisposition(event, 0)).resolves.toEqual({
      status: "deferred",
      appliedPrincipleIds: ["principle-1"],
    });

    const dispositionPath = join(
      root,
      "dispositions",
      `${captureQuestionKey(event, 0)}.json`,
    );
    await writeFile(
      dispositionPath,
      JSON.stringify({
        status: "deferred",
        appliedPrincipleIds: ["principle-1", "principle-1"],
      }),
      "utf8",
    );
    await expect(spool.loadDisposition(event, 0)).rejects.toBeInstanceOf(
      CaptureDispositionCorruptError,
    );
  });

  it("accepts an explicit principle as the only captured rationale basis", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-spool-"));
    const spool = new CaptureSpool(root);
    const event = captureFixture();
    await spool.append(event);
    await spool.saveDisposition(event, 0, {
      status: "captured",
      appliedPrincipleIds: ["principle-1"],
    });

    await expect(spool.loadDisposition(event, 0)).resolves.toEqual({
      status: "captured",
      appliedPrincipleIds: ["principle-1"],
    });
  });

  it("atomically replaces a deferred disposition when its rationale is completed", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-spool-"));
    const spool = new CaptureSpool(root);
    const event = captureFixture();
    await spool.append(event);
    await spool.saveDisposition(event, 0, { status: "deferred" });
    const replaceDisposition = (
      spool as unknown as {
        replaceDisposition(
          input: CapturedDecisionEvent,
          questionIndex: number,
          submission: {
            status: "captured";
            rationale: string;
          },
        ): Promise<void>;
      }
    ).replaceDisposition;

    expect(replaceDisposition).toBeTypeOf("function");
    await replaceDisposition.call(spool, event, 0, {
      status: "captured",
      rationale: "现在补充完整理由。",
    });

    await expect(spool.loadDisposition(event, 0)).resolves.toEqual({
      status: "captured",
      rationale: "现在补充完整理由。",
    });
    expect(await spool.list()).toEqual([event]);
  });

  it("quarantines and reports a corrupt rationale disposition", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-spool-"));
    const spool = new CaptureSpool(root);
    const event = captureFixture();
    await spool.append(event);
    await spool.saveDisposition(event, 0, { status: "deferred" });
    const dispositionName = `${captureQuestionKey(event, 0)}.json`;
    await writeFile(
      join(root, "dispositions", dispositionName),
      "{invalid",
      "utf8",
    );

    await expect(
      spool.loadDisposition(event, 0),
    ).rejects.toBeInstanceOf(CaptureDispositionCorruptError);
    expect(
      (await readdir(join(root, "dispositions"))).some((name) =>
        name.startsWith(`${dispositionName}.corrupt-`),
      ),
    ).toBe(true);
    expect(await spool.list()).toEqual([event]);
  });

  it("cleans a disposition left behind after its receipt was persisted", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-spool-"));
    const spool = new CaptureSpool(root);
    const event = captureFixture();
    const questionKey = captureQuestionKey(event, 0);
    await spool.append(event);
    await spool.saveDisposition(event, 0, {
      status: "not_recorded",
    });
    await writeFile(
      join(root, "receipts", `${questionKey}.ack`),
      "",
      "utf8",
    );

    expect(await spool.list()).toEqual([]);
    expect(
      await readdir(join(root, "dispositions")),
    ).not.toContain(`${questionKey}.json`);
  });

  it("propagates disposition I/O failures without calling them corruption", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-spool-"));
    const spool = new CaptureSpool(root);
    const event = captureFixture();
    const dispositionPath = join(
      root,
      "dispositions",
      `${captureQuestionKey(event, 0)}.json`,
    );
    await spool.append(event);
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(dispositionPath),
    );

    const error = await spool.loadDisposition(event, 0).catch(
      (failure: unknown) => failure,
    );

    expect(error).not.toBeInstanceOf(CaptureDispositionCorruptError);
    await expect(stat(dispositionPath)).resolves.toBeDefined();
  });

  it("keeps one-to-one semantic claims in hash-only spool state", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-spool-"));
    const spool = new CaptureSpool(root);
    const primaryKey = "a".repeat(64);
    const semanticKey = "b".repeat(64);
    const firstAlias = "c".repeat(64);
    const secondAlias = "d".repeat(64);
    await spool.rememberSemanticOccurrence(
      primaryKey,
      semanticKey,
      "structured_tool",
      "2026-07-25T00:00:00.000Z",
    );

    await expect(
      spool.claimCrossModeSemantic(
        semanticKey,
        "transcript",
        "2026-07-25T00:05:00.000Z",
        30 * 60 * 1_000,
        firstAlias,
      ),
    ).resolves.toBe(true);
    await expect(
      spool.claimCrossModeSemantic(
        semanticKey,
        "transcript",
        "2026-07-25T00:05:00.000Z",
        30 * 60 * 1_000,
        firstAlias,
      ),
    ).resolves.toBe(true);
    await expect(
      spool.claimCrossModeSemantic(
        semanticKey,
        "transcript",
        "2026-07-25T00:06:00.000Z",
        30 * 60 * 1_000,
        secondAlias,
      ),
    ).resolves.toBe(false);

    const serialized = (
      await Promise.all(
        (await Promise.all(
          [
            "semantic-receipts",
            "semantic-claims",
            "semantic-aliases",
          ].map(
            async (directory) =>
              (await readdir(join(root, directory))).map(
                (name) => join(root, directory, name),
              ),
          ),
        ))
          .flat()
          .map((path) => readFile(path, "utf8")),
      )
    ).join("\n");
    expect(serialized).not.toContain("Which storage format");
    expect(serialized).not.toContain("Markdown");
    expect(serialized).toContain(primaryKey);
    expect(serialized).toContain(semanticKey);
  });

  it("keeps a retried alias bound to its original occurrence", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-spool-"));
    const spool = new CaptureSpool(root);
    const firstOccurrence = "a".repeat(64);
    const nearerOccurrence = "b".repeat(64);
    const semanticKey = "c".repeat(64);
    const retriedAlias = "d".repeat(64);
    const nextAlias = "e".repeat(64);
    await spool.rememberSemanticOccurrence(
      firstOccurrence,
      semanticKey,
      "structured_tool",
      "2026-07-25T00:00:00.000Z",
    );
    await expect(
      spool.claimCrossModeSemantic(
        semanticKey,
        "transcript",
        "2026-07-25T00:05:00.000Z",
        30 * 60 * 1_000,
        retriedAlias,
      ),
    ).resolves.toBe(true);
    const aliasBinding = (
      await readdir(join(root, "semantic-aliases"))
    )[0]!;
    await import("node:fs/promises").then(({ unlink }) =>
      unlink(join(root, "semantic-aliases", aliasBinding)),
    );
    await spool.rememberSemanticOccurrence(
      nearerOccurrence,
      semanticKey,
      "structured_tool",
      "2026-07-25T00:04:00.000Z",
    );

    await expect(
      spool.claimCrossModeSemantic(
        semanticKey,
        "transcript",
        "2026-07-25T00:05:00.000Z",
        30 * 60 * 1_000,
        retriedAlias,
      ),
    ).resolves.toBe(true);
    await expect(
      spool.claimCrossModeSemantic(
        semanticKey,
        "transcript",
        "2026-07-25T00:05:00.000Z",
        30 * 60 * 1_000,
        nextAlias,
      ),
    ).resolves.toBe(true);
  });

  it("isolates corrupt semantic state and continues with valid receipts", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-spool-"));
    const spool = new CaptureSpool(root);
    const semanticKey = "a".repeat(64);
    await spool.rememberSemanticOccurrence(
      "b".repeat(64),
      semanticKey,
      "structured_tool",
      "2026-07-25T00:00:00.000Z",
    );
    const corruptReceipt = (
      await readdir(join(root, "semantic-receipts"))
    )[0]!;
    await writeFile(
      join(root, "semantic-receipts", corruptReceipt),
      "{invalid",
      "utf8",
    );
    await spool.rememberSemanticOccurrence(
      "c".repeat(64),
      semanticKey,
      "structured_tool",
      "2026-07-25T00:01:00.000Z",
    );

    await expect(
      spool.claimCrossModeSemantic(
        semanticKey,
        "transcript",
        "2026-07-25T00:02:00.000Z",
        30 * 60 * 1_000,
        "d".repeat(64),
      ),
    ).resolves.toBe(true);
    expect(spool.recoveryIssue()).toMatch(/语义去重状态损坏/u);
    expect(
      (await readdir(join(root, "semantic-receipts"))).some(
        (name) => name.includes(".corrupt-"),
      ),
    ).toBe(true);
  });

  it("reconstructs a corrupt occurrence claim from its alias binding", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-spool-"));
    const spool = new CaptureSpool(root);
    const occurrenceId = "a".repeat(64);
    const semanticKey = "b".repeat(64);
    const aliasKey = "c".repeat(64);
    await spool.rememberSemanticOccurrence(
      occurrenceId,
      semanticKey,
      "structured_tool",
      "2026-07-25T00:00:00.000Z",
    );
    await spool.claimCrossModeSemantic(
      semanticKey,
      "transcript",
      "2026-07-25T00:01:00.000Z",
      30 * 60 * 1_000,
      aliasKey,
    );
    const corruptClaim = (
      await readdir(join(root, "semantic-claims"))
    )[0]!;
    await writeFile(
      join(root, "semantic-claims", corruptClaim),
      "{invalid",
      "utf8",
    );

    await expect(
      spool.claimCrossModeSemantic(
        semanticKey,
        "transcript",
        "2026-07-25T00:01:00.000Z",
        30 * 60 * 1_000,
        aliasKey,
      ),
    ).resolves.toBe(true);
    expect(spool.recoveryIssue()).toMatch(/语义去重状态损坏/u);
  });

  it("reports receipt cleanup failures without blocking event recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-spool-"));
    const spool = new CaptureSpool(root);
    const event = captureFixture();
    const questionKey = captureQuestionKey(event, 0);
    await spool.append(event);
    await spool.saveDisposition(event, 0, {
      status: "not_recorded",
    });
    const dispositionPath = join(
      root,
      "dispositions",
      `${questionKey}.json`,
    );
    await import("node:fs/promises").then(async ({ mkdir, unlink }) => {
      await unlink(dispositionPath);
      await mkdir(dispositionPath);
    });
    await writeFile(
      join(root, "receipts", `${questionKey}.ack`),
      "",
      "utf8",
    );

    await expect(spool.list()).resolves.toEqual([]);
    expect(spool.recoveryIssue()).toMatch(/无法清理/u);
  });

  it("preserves a valid event when receipt I/O fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-spool-"));
    const spool = new CaptureSpool(root);
    const event = captureFixture();
    await spool.append(event);
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(
        join(
          root,
          "receipts",
          `${captureQuestionKey(event, 0)}.ack`,
        ),
      ),
    );

    await expect(spool.list()).resolves.toEqual([event]);
    expect(spool.recoveryIssue()).toMatch(/确认回执/u);
    expect(
      (await readdir(join(root, "events"))).some((name) =>
        name.endsWith(".json"),
      ),
    ).toBe(true);
  });

  it("keeps confirmed questions excluded when another receipt has an I/O failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-spool-"));
    const spool = new CaptureSpool(root);
    const event = captureFixture({
      questions: [questionFixture(0), questionFixture(1)],
    });
    await spool.append(event);
    await spool.acknowledge(event, 0);
    const eventName = (
      await readdir(join(root, "events"))
    )[0]!;
    await writeFile(
      join(root, "events", eventName),
      JSON.stringify(event),
      "utf8",
    );
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(
        join(
          root,
          "receipts",
          `${captureQuestionKey(event, 1)}.ack`,
        ),
      ),
    );

    const [recovered] = await spool.list();

    expect(
      recovered?.questions.map(
        (question) => question.questionIndex,
      ),
    ).toEqual([1]);
    expect(spool.recoveryIssue()).toMatch(/确认回执/u);
  });
});
