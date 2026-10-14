import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ReviewReminderService,
  type DueDecision,
  type ReviewReminderNotice,
} from "../src/main/review-reminder-service.js";

const storePath = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "review-reminders-"));
  return join(directory, "review-reminders.json");
};

const due = (
  id: string,
  question: string,
  date = "2026-09-10",
): DueDecision => ({ id, question, reviewDueDate: date });

const harness = async (
  options: {
    listDue?: (asOfDate: string, limit: number) => DueDecision[];
    enabled?: boolean;
    path?: string;
  } = {},
) => {
  const notices: ReviewReminderNotice[] = [];
  const asked: string[] = [];
  const path = options.path ?? (await storePath());
  const service = new ReviewReminderService({
    path,
    enabled: () => options.enabled ?? true,
    listDue: (asOfDate, limit) => {
      asked.push(asOfDate);
      return (
        options.listDue?.(asOfDate, limit) ?? [due("dec-1", "要不要先留测试环境？")]
      );
    },
    notify: (notice) => notices.push(notice),
    now: () => new Date("2026-09-14T09:00:00.000Z"),
  });
  return { service, notices, asked, path };
};

describe("review reminder service", () => {
  it("announces a decision whose review has come due", async () => {
    const { service, notices, asked } = await harness();

    await expect(service.check()).resolves.toEqual(["dec-1"]);
    expect(asked).toEqual(["2026-09-14"]);
    expect(notices).toEqual([
      {
        title: "决策到期复盘",
        body: "要不要先留测试环境？",
        decisionIds: ["dec-1"],
      },
    ]);
  });

  it("never announces the same decision twice for one due date", async () => {
    const { service, notices } = await harness();

    await service.check();
    await expect(service.check()).resolves.toEqual([]);

    // A reminder that repeats every refresh is one the reader learns to ignore.
    expect(notices).toHaveLength(1);
  });

  it("announces again when the reader moves the date", async () => {
    const path = await storePath();
    const first = await harness({ path });
    await first.service.check();

    const moved = await harness({
      path,
      listDue: () => [due("dec-1", "要不要先留测试环境？", "2026-10-01")],
    });
    await expect(moved.service.check()).resolves.toEqual(["dec-1"]);
  });

  it("names one decision and counts the rest", async () => {
    const { service, notices } = await harness({
      listDue: () => [
        due("dec-1", "要不要先留测试环境？"),
        due("dec-2", "要不要直接上线？"),
        due("dec-3", "要不要回滚？"),
      ],
    });

    await service.check();

    expect(notices[0]).toMatchObject({
      title: "3 条决策到期复盘",
      body: "要不要先留测试环境？另有 2 条。",
    });
  });

  it("counts every review come due, not the newest twenty", async () => {
    const all = Array.from({ length: 25 }, (_, index) => due(`dec-${index}`, `数据库选型 ${index}`));
    // As the index lists them: newest first, as many as asked for.
    const { service, notices } = await harness({ listDue: (_asOfDate, limit) => all.filter((_, index) => index < limit) });

    await service.check();
    await service.check();

    expect(notices).toEqual([{ title: "25 条决策到期复盘", body: "数据库选型 0，另有 24 条。", decisionIds: all.map((decision) => decision.id) }]);
  });

  it("forgets what is no longer due before what is, once it remembers 500", async () => {
    const day = (index: number): string => new Date(Date.UTC(2025, 4, 1) + index * 86_400_000).toISOString().slice(0, 10);
    const all = Array.from({ length: 500 }, (_, index) => due(`dec-${index}`, `数据库选型 ${index}`, day(index)));
    // As the index lists them: newest due first, as many as asked for.
    const listDue = (_asOfDate: string, limit: number): DueDecision[] =>
      [...all].sort((left, right) => right.reviewDueDate.localeCompare(left.reviewDueDate)).slice(0, limit);
    const path = await storePath();
    const first = await harness({ path, listDue });
    await first.service.check();
    expect(first.notices).toHaveLength(1);
    all.push(due("dec-500", "数据库选型 500", day(500)));
    await expect(first.service.check()).resolves.toEqual(["dec-500"]);

    // Opened again (a restart): filed by age alone, the one filed first had gone with the 501st, not the one no
    // longer listed, and still due it was announced again, then at the next start the one filed after it.
    const restarted = await harness({ path, listDue });
    for (let round = 0; round < 5; round += 1) await expect(restarted.service.check()).resolves.toEqual([]);
    expect(restarted.notices).toHaveLength(0);
  });

  it("stays silent while reminders are switched off", async () => {
    const { service, notices, asked } = await harness({ enabled: false });

    await expect(service.check()).resolves.toEqual([]);
    // Off means the question is not even asked.
    expect(asked).toEqual([]);
    expect(notices).toEqual([]);
  });

  it("says nothing when nothing is due", async () => {
    const { service, notices } = await harness({ listDue: () => [] });

    await expect(service.check()).resolves.toEqual([]);
    expect(notices).toEqual([]);
  });

  it("keeps announcing after a corrupt store rather than going quiet", async () => {
    const path = await storePath();
    await writeFile(path, "{not json", "utf8");
    const { service, notices } = await harness({ path });

    await expect(service.check()).resolves.toEqual(["dec-1"]);
    expect(notices).toHaveLength(1);
  });

  it("keeps the store readable only by its owner", async () => {
    const { service, path } = await harness();

    await service.check();

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const file = JSON.parse(await readFile(path, "utf8")) as {
      notified: Array<Record<string, unknown>>;
    };
    expect(file.notified[0]).toEqual({
      decisionId: "dec-1",
      dueDate: "2026-09-10",
      notifiedAt: "2026-09-14T09:00:00.000Z",
    });
  });

  it("announces once while its store cannot be written", async () => {
    const directory = await mkdtemp(join(tmpdir(), "review-reminders-"));
    // Where the store's folder should be, a file: no write gets through, as on a full disk.
    await writeFile(join(directory, "app"), "", "utf8");
    const { service, notices } = await harness({ path: join(directory, "app", "review-reminders.json") });

    // A save, a watcher refresh, a status update: each published a snapshot, and each raised the notice again.
    await service.check();
    await service.check();
    await service.check();
    expect(notices).toHaveLength(1);
  });

  it("reads its store once, and keeps what it knows from then on", async () => {
    const path = await storePath();
    let listed = [due("dec-1", "要不要先留测试环境？")];
    const { service, notices } = await harness({ path, listDue: () => listed });
    await service.check();

    // Read again on every snapshot while anything stayed due: unreadable since (a sync tool, a disk error), it
    // was taken for empty, and the notice was raised again.
    await writeFile(path, "{not json", "utf8");
    await expect(service.check()).resolves.toEqual([]);
    expect(notices).toHaveLength(1);
    // What it knows goes with the next filing.
    listed = [...listed, due("dec-2", "要不要直接上线？")];
    await expect(service.check()).resolves.toEqual(["dec-2"]);
    const file = JSON.parse(await readFile(path, "utf8")) as { notified: Array<{ decisionId: string }> };
    expect(file.notified.map((entry) => entry.decisionId)).toEqual(["dec-1", "dec-2"]);
  });

  it("announces what came due after a clock that once ran ahead filed it as announced", async () => {
    const path = await storePath();
    let now = new Date("2027-03-01T09:00:00.000Z");
    const notices: ReviewReminderNotice[] = [];
    const service = (): ReviewReminderService => new ReviewReminderService({
      path,
      enabled: () => true,
      listDue: (asOfDate) => [due("dec-1", "要不要先留测试环境？", "2026-11-15")].filter((decision) => decision.reviewDueDate <= asOfDate),
      notify: (notice) => notices.push(notice),
      now: () => now,
    });
    await service().check();
    expect(notices).toHaveLength(1);

    // The date put right; the review really comes due on 2026-11-15, and is said then, once.
    now = new Date("2026-11-15T09:00:00.000Z");
    const restarted = service();
    await expect(restarted.check()).resolves.toEqual(["dec-1"]);
    await expect(restarted.check()).resolves.toEqual([]);
    expect(notices).toHaveLength(2);
  });

  it("does not announce again once a time sync puts the clock back a few seconds", async () => {
    let now = new Date("2026-09-14T09:00:05.000Z");
    const notices: ReviewReminderNotice[] = [];
    const service = new ReviewReminderService({
      path: await storePath(),
      enabled: () => true,
      listDue: () => [due("dec-1", "要不要先留测试环境？")],
      notify: (notice) => notices.push(notice),
      now: () => now,
    });
    await service.check();

    now = new Date("2026-09-14T09:00:01.000Z");
    await expect(service.check()).resolves.toEqual([]);
    expect(notices).toHaveLength(1);
  });

  it("does not interleave two checks into a double announcement", async () => {
    const { service, notices } = await harness();

    await Promise.all([service.check(), service.check()]);

    expect(notices).toHaveLength(1);
  });
});
