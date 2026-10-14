import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AssistantFeedbackStore, forgetAssistantTurns } from "../src/main/assistant-feedback-store.js";

const storePath = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "assistant-feedback-"));
  return join(directory, "assistant-feedback.json");
};

const entry = (overrides: Record<string, unknown> = {}) => ({
  turnId: "turn-1",
  rating: "helpful" as const,
  question: "为什么先留测试环境？",
  citedReferences: ["Decision Journal/decisions/2026/07/配置变更.md"],
  ...overrides,
});

const read = async (path: string) =>
  JSON.parse(await readFile(path, "utf8")) as {
    version: number;
    entries: Array<Record<string, unknown>>;
  };

describe("assistant feedback store", () => {
  it("lets go of the ratings given a deleted conversation's turns, and only those", async () => {
    const path = await storePath();
    const store = new AssistantFeedbackStore(path);
    await store.record(entry({ turnId: "turn-1", question: "要不要和合伙人分家？" }));
    await store.record(entry({ turnId: "turn-2", question: "另一段对话的问题" }));

    // Kept, the question stayed on disk after its conversation was deleted.
    await expect(store.remove(["turn-1", "turn-unknown"])).resolves.toBe(1);
    const file = await read(path);
    expect(file.entries.map((item) => item.turnId)).toEqual(["turn-2"]);
    expect(JSON.stringify(file)).not.toContain("要不要和合伙人分家？");
    await expect(store.summary()).resolves.toEqual({ helpful: 1, notHelpful: 0 });
  });

  it("records feedback for a question at the supported message limit", async () => {
    const path = await storePath();
    const store = new AssistantFeedbackStore(path);
    const question = "问".repeat(8_000);
    await expect(store.record(entry({ question }))).resolves.toMatchObject({ status: "saved" });
    expect((await read(path)).entries[0]?.question).toBe(question);
  });

  it("records a rating with the question and the sources it cited", async () => {
    const path = await storePath();
    const store = new AssistantFeedbackStore(
      path,
      () => new Date("2026-09-13T21:30:00.000Z"),
    );

    await expect(store.record(entry())).resolves.toEqual({
      status: "saved",
      recorded: 1,
    });
    const file = await read(path);
    expect(file.entries[0]).toEqual({
      turnId: "turn-1",
      rating: "helpful",
      question: "为什么先留测试环境？",
      citedReferences: ["Decision Journal/decisions/2026/07/配置变更.md"],
      recordedAt: "2026-09-13T21:30:00.000Z",
    });
  });

  it("stores paths and never the words of the answer", async () => {
    const path = await storePath();
    const store = new AssistantFeedbackStore(path);

    await store.record(entry({ rating: "not_helpful", note: "答非所问" }));

    // The excerpts live in the vault; a second copy here would be a second
    // place to leak them from.
    const file = await read(path);
    expect(Object.keys(file.entries[0]!).sort()).toEqual([
      "citedReferences",
      "note",
      "question",
      "rating",
      "recordedAt",
      "turnId",
    ]);
  });

  it("replaces the verdict on a turn instead of stacking a second one", async () => {
    const path = await storePath();
    const store = new AssistantFeedbackStore(path);

    await store.record(entry());
    await expect(
      store.record(entry({ rating: "not_helpful", note: "改主意了" })),
    ).resolves.toMatchObject({ recorded: 1 });

    const file = await read(path);
    expect(file.entries).toHaveLength(1);
    expect(file.entries[0]).toMatchObject({ rating: "not_helpful" });
  });

  it("keeps both ratings when two turns are rated at once", async () => {
    const path = await storePath();
    const store = new AssistantFeedbackStore(path);

    // Serialised writes: the second must not read the file before the first
    // has landed, or one rating disappears.
    await Promise.all([
      store.record(entry({ turnId: "turn-1" })),
      store.record(entry({ turnId: "turn-2" })),
    ]);

    expect((await read(path)).entries).toHaveLength(2);
  });

  it("summarises what the reader thought", async () => {
    const path = await storePath();
    const store = new AssistantFeedbackStore(path);
    await store.record(entry({ turnId: "turn-1" }));
    await store.record(entry({ turnId: "turn-2", rating: "not_helpful" }));
    await store.record(entry({ turnId: "turn-3", rating: "not_helpful" }));

    await expect(store.summary()).resolves.toEqual({
      helpful: 1,
      notHelpful: 2,
    });
  });

  it.each([
    ["invalid JSON", "{not json"],
    ["unsupported version", JSON.stringify({ version: 2, entries: [entry()] })],
    ["invalid collection", JSON.stringify({ version: 1, entries: { old: entry() } })],
  ])("does not overwrite a document with %s", async (_label, original) => {
    const path = await storePath();
    await writeFile(path, original, "utf8");
    const store = new AssistantFeedbackStore(path);

    await expect(store.record(entry())).resolves.toEqual({ status: "unavailable", recorded: 0 });
    expect(await readFile(path, "utf8")).toBe(original);
    // Unreadable is not the same as nothing rated yet.
    await expect(store.summary()).resolves.toEqual({ helpful: 0, notHelpful: 0, unavailable: true });
  });

  it("keeps counting the ratings it lets go to stay bounded", async () => {
    const path = await storePath();
    const recordedAt = "2026-09-20T00:00:00.000Z";
    await writeFile(path, JSON.stringify({
      version: 1,
      entries: Array.from({ length: 500 }, (_, turn) => ({ ...entry({ turnId: `turn-${turn}` }), recordedAt })),
    }));
    const store = new AssistantFeedbackStore(path);

    await expect(store.record(entry({ turnId: "turn-new", rating: "not_helpful" }))).resolves.toEqual({ status: "saved", recorded: 500 });
    expect((await read(path)).entries).toHaveLength(500);
    await expect(store.summary()).resolves.toEqual({ helpful: 500, notHelpful: 1 });
  });

  it("retains valid ratings around a malformed entry when saving another", async () => {
    const path = await storePath();
    const recordedAt = "2026-09-20T00:00:00.000Z";
    const first = { ...entry({ turnId: "first", question: "保留旧问题一", note: "保留旧说明" }), recordedAt };
    const second = { ...entry({ turnId: "second", rating: "not_helpful", question: "保留旧问题二" }), recordedAt };
    await writeFile(path, JSON.stringify({ version: 1, entries: [
      first,
      { ...entry({ rating: "unknown" }), recordedAt },
      null,
      second,
    ] }));
    const store = new AssistantFeedbackStore(path);
    await expect(store.summary()).resolves.toEqual({ helpful: 1, notHelpful: 1 });
    await expect(store.record(entry({ turnId: "third" }))).resolves.toEqual({ status: "saved", recorded: 3 });
    const stored = (await read(path)).entries;
    expect(stored.map((item) => item.turnId)).toEqual(["first", "second", "third"]);
    expect(stored.slice(0, 2)).toEqual([first, second]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("keeps existing ratings when a read is denied and can retry later", async () => {
    const path = await storePath();
    const store = new AssistantFeedbackStore(path);
    await store.record(entry());
    const original = await readFile(path, "utf8");
    await chmod(path, 0o000);
    try {
      await expect(store.record(entry({ turnId: "second" }))).resolves.toEqual({ status: "unavailable", recorded: 0 });
    } finally {
      await chmod(path, 0o600);
    }
    expect(await readFile(path, "utf8")).toBe(original);
    await expect(store.record(entry({ turnId: "second" }))).resolves.toEqual({ status: "saved", recorded: 2 });
  });

  it("reports an empty summary when nothing has been rated", async () => {
    const store = new AssistantFeedbackStore(await storePath());

    await expect(store.summary()).resolves.toEqual({
      helpful: 0,
      notHelpful: 0,
    });
  });

  it("keeps the file readable only by its owner", async () => {
    const path = await storePath();
    await new AssistantFeedbackStore(path).record(entry());

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("forgets a conversation's call records even when its ratings file is damaged, and says the failure after", async () => {
    const path = await storePath();
    await writeFile(path, "{damaged", "utf8");
    const deleted: string[][] = [];
    const traces = { deleteRequest: async (ids: readonly string[]) => { deleted.push([...ids]); return ids.length; } };

    // Stopped at the ratings, the call records holding the question and the notes it read stayed.
    await expect(forgetAssistantTurns(["turn-1", "turn-2"], new AssistantFeedbackStore(path), traces)).rejects.toThrow();
    expect(deleted).toEqual([["turn-1", "turn-2"]]);
  });
});
