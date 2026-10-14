import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  DecisionPersistenceError,
  fileSystemRefusal,
  RationaleQueue,
  RecoveryQueueWriteError,
} from "../src/index.js";
import {
  captureFixture,
  questionFixture,
} from "./fixtures.js";

describe("fileSystemRefusal", () => {
  it("names the folder refused when a folder could not be made in it, not one that is not there", async () => {
    const root = await mkdtemp(join(tmpdir(), "file-system-refusal-"));
    const decisions = join(root, "decisions");
    await mkdir(decisions);
    await chmod(decisions, 0o500);
    try {
      // A recursive mkdir names the whole path it was asked for: decisions/2026/10, neither of which is there.
      const refusal = await mkdir(join(decisions, "2026", "10"), { recursive: true }).catch((error: unknown) => error);
      expect(fileSystemRefusal(refusal)).toBe(`没有访问 ${decisions} 的权限，请检查它的权限设置`);
    } finally {
      await chmod(decisions, 0o700);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("says a file another program holds as held, not as a folder whose permissions to check", () => {
    const refusal = (code: string, syscall: string) =>
      Object.assign(new Error(`${code}: operation not permitted, ${syscall}`), { code, syscall, path: "/vault/Decision Journal/x.md.4242.tmp", dest: "/vault/Decision Journal/x.md" });
    // Windows, the note open in Obsidian or under an antivirus scan past the rename's retries: its folder's
    // permissions were never the trouble, and a reader sent to check them went the wrong way.
    for (const held of [refusal("EPERM", "rename"), refusal("EBUSY", "rename"), refusal("EPERM", "unlink")]) {
      expect(fileSystemRefusal(held)).toBe("文件正被其它程序占用（如 Obsidian、同步或杀毒软件），请稍后再试");
    }
    expect(fileSystemRefusal(refusal("EPERM", "open"))).toBe("没有访问 /vault/Decision Journal 的权限，请检查它的权限设置");
    expect(fileSystemRefusal(refusal("EBUSY", "open"))).toBeNull();
  });
});

describe("DecisionPersistenceError", () => {
  it("says in words why the vault would not take a decision", () => {
    // Shown under the save failure as "Decision persistence failed: EACCES: permission denied, mkdir '…'".
    const denied = Object.assign(new Error("EACCES: permission denied, mkdir '/vault/Decision Journal'"), { code: "EACCES" });
    expect(new DecisionPersistenceError(denied).message).toBe("决策没能写入 Obsidian：没有写入仓库目录的权限，请检查它的权限设置");
    expect(new DecisionPersistenceError(new Error("找不到仓库目录")).message).toBe("决策没能写入 Obsidian：找不到仓库目录");
  });

  it("says when it was the app's own recovery queue that failed, and whether the note was written", async () => {
    const full = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    const before = new DecisionPersistenceError(new RecoveryQueueWriteError(full, false));
    expect(before).toMatchObject({ store: "recovery_queue", message: "决策没能写入本机恢复队列：磁盘空间不足" });
    const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    expect(new DecisionPersistenceError(new RecoveryQueueWriteError(denied, true)).message)
      .toBe("决策已写入 Obsidian，但本机恢复队列没能更新：没有写入本机数据目录的权限，请检查它的权限设置");
    expect(new DecisionPersistenceError(full).store).toBe("vault");

    const queue = new RationaleQueue(() => "candidate-1", {
      onDisposition: () => Promise.reject(new RecoveryQueueWriteError(full, false)),
    });
    queue.ingest(captureFixture());
    await expect(queue.submit({ status: "skipped" })).rejects.toThrow("决策没能写入本机恢复队列");
    expect(queue.snapshot()).toMatchObject({ persistenceStatus: "failed", persistenceFailure: "recovery_queue" });
  });
});

describe("RationaleQueue", () => {
  it("splits a batch into FIFO candidates and deduplicates replays", () => {
    let sequence = 0;
    const queue = new RationaleQueue(() => `candidate-${++sequence}`);
    const event = captureFixture({
      questions: [questionFixture(0), questionFixture(1)],
    });

    expect(queue.ingest(event)).toEqual({ accepted: 2, duplicates: 0 });
    expect(queue.ingest(event)).toEqual({ accepted: 0, duplicates: 2 });
    expect(queue.snapshot()).toMatchObject({
      current: {
        status: "awaiting_rationale",
        candidateId: "candidate-1",
        question: { questionIndex: 0 },
      },
      waitingCount: 1,
    });
  });

  it("temporarily prioritizes a reviewed rationale and then resumes FIFO", async () => {
    let sequence = 0;
    const queue = new RationaleQueue(
      () => `candidate-${++sequence}`,
    );
    const existing = captureFixture({
      sourceEventId: "existing",
      toolUseId: "existing",
      batchId: "existing",
    });
    const reviewed = captureFixture({
      sourceEventId: "reviewed",
      toolUseId: "reviewed",
      batchId: "reviewed",
    });

    queue.ingest(existing);
    queue.ingestPrioritized(reviewed);

    expect(queue.snapshot()).toMatchObject({
      current: {
        candidateId: "candidate-2",
        event: { sourceEventId: "reviewed" },
      },
      waitingCount: 1,
    });

    await queue.submit({ status: "skipped" });

    expect(queue.snapshot()).toMatchObject({
      current: {
        candidateId: "candidate-1",
        event: { sourceEventId: "existing" },
      },
      waitingCount: 0,
    });
  });

  it("deduplicates the same native answer across structured and transcript capture", () => {
    let sequence = 0;
    const queue = new RationaleQueue(() => `candidate-${++sequence}`);
    const structured = captureFixture();
    const { toolUseId: _toolUseId, ...transcript } = captureFixture({
      captureMode: "transcript",
      sourceEventId: "stop-1:prompt-1",
      batchId: "text-batch",
    });

    expect(queue.ingest(structured)).toEqual({
      accepted: 1,
      duplicates: 0,
    });
    expect(queue.ingestDetailed(transcript)).toEqual({
      receipt: {
        accepted: 0,
        duplicates: 1,
      },
      crossModeDuplicates: [
        {
          primaryCandidateId: "candidate-1",
          event: transcript,
          question: transcript.questions[0],
        },
      ],
    });
    expect(queue.snapshot()).toMatchObject({
      current: {
        candidateId: "candidate-1",
        event: { captureMode: "structured_tool" },
      },
      waitingCount: 0,
    });
  });

  it("does not semantically deduplicate separate sessions", () => {
    let sequence = 0;
    const queue = new RationaleQueue(() => `candidate-${++sequence}`);
    const structured = captureFixture();
    const { toolUseId: _toolUseId, ...transcript } = captureFixture({
      captureMode: "transcript",
      sessionId: "another-session",
      sourceEventId: "stop-1:prompt-1",
      batchId: "text-batch",
    });

    expect(queue.ingest(structured)).toEqual({
      accepted: 1,
      duplicates: 0,
    });
    expect(queue.ingest(transcript)).toEqual({
      accepted: 1,
      duplicates: 0,
    });
  });

  it("promotes a transcript candidate when structured capture arrives later", () => {
    let sequence = 0;
    const queue = new RationaleQueue(() => `candidate-${++sequence}`);
    const structured = captureFixture();
    const { toolUseId: _toolUseId, ...transcript } = captureFixture({
      captureMode: "transcript",
      sourceEventId: "stop-1:prompt-1",
      batchId: "text-batch",
    });

    expect(queue.ingest(transcript)).toEqual({
      accepted: 1,
      duplicates: 0,
    });
    expect(queue.ingestDetailed(structured)).toMatchObject({
      receipt: {
        accepted: 0,
        duplicates: 1,
      },
      crossModeDuplicates: [
        {
          primaryCandidateId: "candidate-1",
          event: transcript,
          question: transcript.questions[0],
        },
      ],
    });
    expect(queue.snapshot()).toMatchObject({
      current: {
        candidateId: "candidate-1",
        event: { captureMode: "structured_tool" },
      },
      waitingCount: 0,
    });
  });

  it.each(
    ["captured", "deferred", "skipped", "not_recorded"] as const,
  )(
    "disposes a candidate as %s without waiting for an agent",
    async (status) => {
      const onDisposition = vi.fn(async () => undefined);
      const queue = new RationaleQueue(() => "candidate-1", {
        onDisposition,
      });
      queue.ingest(captureFixture());

      await queue.submit(
        status === "captured"
          ? {
              status,
              rationale: "Because it is maintainable.",
              reasonFactors: ["maintainability"],
            }
          : { status },
      );

      expect(onDisposition).toHaveBeenCalledWith(
        expect.objectContaining({ candidateId: "candidate-1" }),
        expect.objectContaining({ status }),
      );
      expect(queue.snapshot().current).toBeNull();
    },
  );

  it("accepts a bounded explicit principle as the rationale basis", async () => {
    const onDisposition = vi.fn(async () => undefined);
    const queue = new RationaleQueue(() => "candidate-1", {
      onDisposition,
    });
    queue.ingest(captureFixture());

    await queue.submit({
      status: "captured",
      appliedPrincipleIds: ["principle-1"],
    });

    expect(onDisposition).toHaveBeenCalledWith(expect.anything(), {
      status: "captured",
      appliedPrincipleIds: ["principle-1"],
    });
  });

  it("publishes serializable snapshots and advances FIFO", async () => {
    let sequence = 0;
    const queue = new RationaleQueue(() => `candidate-${++sequence}`);
    const snapshots: unknown[] = [];
    queue.subscribe((snapshot) => snapshots.push(snapshot));
    queue.ingest(
      captureFixture({
        questions: [questionFixture(0), questionFixture(1)],
      }),
    );

    await queue.submit({ status: "skipped" });

    expect(queue.snapshot()).toMatchObject({
      current: {
        candidateId: "candidate-2",
        question: { questionIndex: 1 },
      },
      waitingCount: 0,
    });
    expect(() => JSON.stringify(snapshots)).not.toThrow();
  });

  it("retains a completed candidate for persistence retry", async () => {
    let attempts = 0;
    const queue = new RationaleQueue(() => "candidate-1", {
      onDisposition: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("disk full");
        }
      },
    });
    queue.ingest(captureFixture());

    await expect(
      queue.submit({
        status: "captured",
        rationale: "Cannot lose this rationale.",
      }),
    ).rejects.toBeInstanceOf(DecisionPersistenceError);
    expect(queue.snapshot()).toMatchObject({
      current: { status: "completed" },
      persistenceStatus: "failed",
    });

    await queue.retryCurrentPersistence();

    expect(queue.snapshot().current).toBeNull();
  });

  it("reports synchronous persistence failures as rejected promises", async () => {
    const queue = new RationaleQueue(() => "candidate-1", {
      onDisposition: () => {
        throw new Error("synchronous disk failure");
      },
    });
    queue.ingest(captureFixture());

    let submission: Promise<void> | undefined;
    expect(() => {
      submission = queue.submit({ status: "skipped" });
    }).not.toThrow();
    await expect(submission).rejects.toBeInstanceOf(
      DecisionPersistenceError,
    );
    expect(queue.snapshot()).toMatchObject({
      current: { status: "completed" },
      persistenceStatus: "failed",
    });
  });
});
