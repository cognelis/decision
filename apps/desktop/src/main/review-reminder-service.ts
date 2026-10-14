import { renameReplacing } from "@cognelis/decision-storage";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

/**
 * Tells the reader when a decision they scheduled has come due.
 *
 * Without this the review loop has one ambient signal: a tray tooltip showing
 * candidates, pending rationales and due reviews added together, which cannot
 * say that a review came due and has to be hovered to be seen at all. A tool
 * built on "record it now, look at it later" has to be able to reach the later.
 *
 * Two rules keep it from becoming noise: a decision is announced once per due
 * date, ever, and nothing is announced while the reader has reminders off.
 */

const MAX_REMEMBERED = 500;
/** How far ahead a clock may have been and its entries still count: a time sync, a wake, puts one back seconds. */
const CLOCK_STEP_TOLERANCE_MS = 60 * 60 * 1_000;

const entrySchema = z
  .object({
    decisionId: z.string().min(1).max(200),
    dueDate: z.string().min(1).max(32),
    notifiedAt: z.string().min(1).max(64),
  })
  .strip();

const fileSchema = z
  .object({
    version: z.literal(1),
    notified: z.array(entrySchema).catch([]),
  })
  .strip();

type Entry = z.infer<typeof entrySchema>;

export interface DueDecision {
  id: string;
  question: string;
  reviewDueDate: string;
}

export interface ReviewReminderNotice {
  title: string;
  body: string;
  /** Ids announced, so a caller can report exactly what was raised. */
  decisionIds: string[];
}

export interface ReviewReminderServiceOptions {
  path: string;
  /** Newest due first, at most `limit`. */
  listDue(asOfDate: string, limit: number): DueDecision[];
  notify(notice: ReviewReminderNotice): void;
  enabled(): boolean;
  now?: () => Date;
}

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const calendarDate = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    "0",
  )}-${String(date.getDate()).padStart(2, "0")}`;

/** One decision is named; several are counted, so the notice stays readable. */
const noticeFor = (due: readonly DueDecision[]): ReviewReminderNotice => {
  const first = due[0]!;
  // A question that ends itself takes no comma after: "？，" ran the two together.
  const joint = /[。！？.!?]$/u.test(first.question) ? "" : "，";
  return {
    title: due.length === 1 ? "决策到期复盘" : `${due.length} 条决策到期复盘`,
    body:
      due.length === 1
        ? first.question
        : `${first.question}${joint}另有 ${due.length - 1} 条。`,
    decisionIds: due.map((decision) => decision.id),
  };
};

export class ReviewReminderService {
  readonly #options: ReviewReminderServiceOptions;
  readonly #now: () => Date;
  #tail: Promise<unknown> = Promise.resolve();
  /**
   * What is filed, read once and kept: every snapshot the app published (each save, each refresh) read the file
   * again while anything stayed due. Announced and not filed yet (a full disk, a folder it may not write) is
   * known here as well, or each snapshot raised the same notice again.
   */
  #notified: Entry[] | null = null;

  constructor(options: ReviewReminderServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  /** Announces anything newly due. Safe to call as often as the app refreshes. */
  async check(): Promise<string[]> {
    const run = this.#tail.then(async () => {
      if (!this.#options.enabled()) return [];
      const now = this.#now();
      const today = calendarDate(now);
      // As many as it remembers: given the newest twenty, 25 come due at once were "20 条", and the other five
      // never said.
      const due = this.#options.listDue(today, MAX_REMEMBERED);
      if (due.length === 0) return [];

      // Filed under a clock that ran ahead (a date typed wrong, a VM restored): read as announced, a decision due
      // before that date said nothing when it really came due, nor any day after. Not one filed moments ahead: a
      // clock put back a few seconds announced today's reviews again.
      const notified = (this.#notified ??= await this.#read()).filter(
        (entry) => !(Date.parse(entry.notifiedAt) > now.getTime() + CLOCK_STEP_TOLERANCE_MS),
      );
      const seen = new Set(
        notified.map((entry) => `${entry.decisionId}@${entry.dueDate}`),
      );
      const fresh = due.filter(
        (decision) => !seen.has(`${decision.id}@${decision.reviewDueDate}`),
      );
      if (fresh.length === 0) return [];

      const at = now.toISOString();
      const announced = fresh.map((decision) => ({
        decisionId: decision.id,
        dueDate: decision.reviewDueDate,
        notifiedAt: at,
      }));
      this.#options.notify(noticeFor(fresh));
      // Kept to 500 by forgetting first what is no longer due: forgotten by age alone, one still due went with the
      // 501st announced, and was announced again at the next snapshot, then the next.
      const stillDue = new Set(due.map((decision) => `${decision.id}@${decision.reviewDueDate}`));
      let excess = Math.max(0, notified.length + announced.length - MAX_REMEMBERED);
      this.#notified = [...notified, ...announced].filter((entry) => {
        if (excess === 0 || stillDue.has(`${entry.decisionId}@${entry.dueDate}`)) return true;
        excess -= 1;
        return false;
      });
      await this.#write(this.#notified);
      return fresh.map((decision) => decision.id);
    });
    // A reminder that cannot be filed must not take the app down with it.
    this.#tail = run.catch(() => undefined);
    return run.catch(() => []);
  }

  async #read(): Promise<Entry[]> {
    try {
      const parsed = fileSchema.safeParse(
        JSON.parse(await readFile(this.#options.path, "utf8")),
      );
      return parsed.success ? parsed.data.notified : [];
    } catch (error) {
      if (isMissing(error)) return [];
      // A corrupt file would otherwise silence reminders for good; better to
      // risk announcing one twice than to stop announcing at all.
      return [];
    }
  }

  async #write(notified: Entry[]): Promise<void> {
    const path = resolve(this.#options.path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700).catch(() => undefined);
    const temporary = `${path}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify(
        { version: 1, notified },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await renameReplacing(temporary, path);
    await chmod(path, 0o600).catch(() => undefined);
  }
}
