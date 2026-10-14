import {
  assistantFeedbackInputSchema,
  type AssistantFeedbackInput,
  type AssistantFeedbackResult,
  type AssistantFeedbackSummary,
} from "@cognelis/decision-protocol";
import { renameReplacing } from "@cognelis/decision-storage";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

/**
 * Ratings the reader gave assistant answers.
 *
 * What it holds is a deliberate line: the question, the rating, an optional
 * note, and the vault-relative paths the answer cited — never the excerpts or
 * the answer text. That is enough to ask "which sources keep turning up in
 * answers that missed", and it stops this store from becoming a second copy of
 * the notes it points at.
 */

const MAX_ENTRIES = 500;

const entrySchema = assistantFeedbackInputSchema.extend({
  recordedAt: z.string().min(1).max(64),
});

const NO_EARLIER = { helpful: 0, notHelpful: 0 };

const fileSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(z.unknown()).transform((entries) =>
      entries.flatMap((entry) => {
        const parsed = entrySchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      }),
    ),
    /** Ratings let go to keep the file bounded, still counted in the totals. */
    earlier: z
      .object({
        helpful: z.number().int().nonnegative(),
        notHelpful: z.number().int().nonnegative(),
      })
      .strip()
      .catch(NO_EARLIER),
  })
  .strip();

type Entry = z.infer<typeof entrySchema>;
type FeedbackFile = z.infer<typeof fileSchema>;

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/**
 * A deleted conversation's turns let go of everywhere they were kept: their ratings, and the model call records that
 * hold the question and the notes it read. Each is tried whatever the other did: with the ratings file damaged, the
 * call records stayed, the more private of the two.
 */
export const forgetAssistantTurns = async (
  turnIds: readonly string[],
  feedback: Pick<AssistantFeedbackStore, "remove">,
  traces: { deleteRequest(requestIds: readonly string[]): Promise<number> },
): Promise<void> => {
  const results = await Promise.allSettled([feedback.remove(turnIds), traces.deleteRequest(turnIds)]);
  const failed = results.find((result) => result.status === "rejected");
  if (failed !== undefined) throw failed.reason;
};

export class AssistantFeedbackStore {
  readonly #path: string;
  readonly #now: () => Date;
  /** Serialises writes so two quick ratings cannot lose one another. */
  #tail: Promise<unknown> = Promise.resolve();

  constructor(path: string, now: () => Date = () => new Date()) {
    this.#path = resolve(path);
    this.#now = now;
  }

  async record(
    input: AssistantFeedbackInput,
  ): Promise<AssistantFeedbackResult> {
    const parsed = assistantFeedbackInputSchema.parse(input);
    const run = this.#tail.then(async () => {
      const { entries, earlier } = await this.#read();
      // One rating per turn: changing your mind replaces the old verdict
      // instead of stacking a second one beside it.
      const kept = entries.filter((entry) => entry.turnId !== parsed.turnId);
      kept.push({ ...parsed, recordedAt: this.#now().toISOString() });
      const dropped = kept.slice(0, Math.max(0, kept.length - MAX_ENTRIES));
      const trimmed = kept.slice(-MAX_ENTRIES);
      await this.#write(trimmed, {
        helpful: earlier.helpful + dropped.filter((entry) => entry.rating === "helpful").length,
        notHelpful: earlier.notHelpful + dropped.filter((entry) => entry.rating === "not_helpful").length,
      });
      return trimmed.length;
    });
    this.#tail = run.catch(() => undefined);
    try {
      return { status: "saved", recorded: await run };
    } catch {
      // A rating that cannot be filed must not take the answer down with it.
      return { status: "unavailable", recorded: 0 };
    }
  }

  /** Lets go of the ratings given these turns (a conversation deleted): kept, its question stayed on disk. */
  async remove(turnIds: readonly string[]): Promise<number> {
    const gone = new Set(turnIds);
    const run = this.#tail.then(async () => {
      const { entries, earlier } = await this.#read();
      const kept = entries.filter((entry) => !gone.has(entry.turnId));
      if (kept.length !== entries.length) await this.#write(kept, earlier);
      return entries.length - kept.length;
    });
    this.#tail = run.catch(() => undefined);
    return run;
  }

  async summary(): Promise<AssistantFeedbackSummary> {
    const file = await this.#read().catch(() => null);
    // Unreadable is not the same as nothing rated yet.
    if (file === null) return { helpful: 0, notHelpful: 0, unavailable: true };
    const { entries, earlier } = file;
    return {
      helpful:
        earlier.helpful +
        entries.filter((entry) => entry.rating === "helpful").length,
      notHelpful:
        earlier.notHelpful +
        entries.filter((entry) => entry.rating === "not_helpful").length,
    };
  }

  async #read(): Promise<FeedbackFile> {
    try {
      return fileSchema.parse(JSON.parse(await readFile(this.#path, "utf8")));
    } catch (error) {
      if (isMissing(error)) return { version: 1, entries: [], earlier: NO_EARLIER };
      // An unreadable or unsupported document is not an empty history.
      // Let record() report unavailability without replacing the original.
      throw error;
    }
  }

  async #write(entries: Entry[], earlier: FeedbackFile["earlier"]): Promise<void> {
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => undefined);
    const temporary = `${this.#path}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify(
        earlier.helpful + earlier.notHelpful === 0
          ? { version: 1, entries }
          : { version: 1, entries, earlier },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await renameReplacing(temporary, this.#path);
    await chmod(this.#path, 0o600).catch(() => undefined);
  }
}
