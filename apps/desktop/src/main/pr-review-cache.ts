import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { prReviewSnapshotSchema } from "@cognelis/decision-protocol";
import { atomicWrite } from "./atomic-write.js";
import { prDetailsSchema } from "./pr-platform-client.js";

/**
 * PR snapshots on disk, so a PR read before is on screen at once, also after a
 * restart. A snapshot is pinned to its commit pair, whose diff never changes;
 * the caller still asks the platform whether the pair moved before trusting it.
 * code-meeseeks gets the same from a local git mirror, at a GB-scale disk cost.
 */
export const cachedPrSnapshotSchema = z.object({
  version: z.literal(1),
  connectionId: z.string().uuid(),
  reference: z.string().min(1).max(2_000),
  snapshotId: z.string().uuid(),
  pr: prDetailsSchema,
  files: prReviewSnapshotSchema.shape.files,
  diff: z.string().max(2 * 1024 * 1024),
  fileWarnings: z.array(z.string().max(2_000)).max(100),
  comments: z.array(z.object({
    id: z.string().max(200), url: z.string().max(2_000),
    author: z.string().max(100), path: z.string().max(4_096).nullable(), line: z.number().int().nullable(),
    body: z.string().max(300), createdAt: z.string().max(100),
  }).strict()).max(20),
  commentsFailed: z.boolean(),
  /** The repository's own guides at the source commit; a snapshot cached before they were read has none. */
  guides: z.array(z.object({ path: z.string().min(1).max(4_096), text: z.string().max(20_000) }).strict()).max(4).optional(),
  updatedAt: z.string().max(100).nullable(),
  loadedAt: z.number().int().nonnegative(),
}).strict();
export type CachedPrSnapshot = z.infer<typeof cachedPrSnapshotSchema>;

const MAX_CACHED_PRS = 60;
const CACHE_FILE = /^[0-9a-f-]{36}-[0-9a-f]{40}\.json$/iu;

export class PrSnapshotStore {
  constructor(private readonly directory: string) {}

  /** Named by connection first, so a removed connection's snapshots can go without reading them. */
  private file(connectionId: string, reference: string): string {
    const name = createHash("sha256").update(`${connectionId}\u0000${reference}`).digest("hex").slice(0, 40);
    return join(this.directory, `${connectionId}-${name}.json`);
  }

  /** Best effort, as writing is: a removed connection leaves no PR diffs behind. */
  async forget(connectionId: string): Promise<void> {
    try {
      const names = (await readdir(this.directory)).filter((name) => name.startsWith(`${connectionId}-`));
      await Promise.all(names.map((name) => rm(join(this.directory, name), { force: true })));
    } catch {
      // Nothing cached yet, or the folder went away.
    }
  }

  /** A missing, unreadable or foreign file is simply not cached. */
  async read(connectionId: string, reference: string): Promise<CachedPrSnapshot | undefined> {
    try {
      const entry = cachedPrSnapshotSchema.parse(JSON.parse(await readFile(this.file(connectionId, reference), "utf8")));
      return entry.connectionId === connectionId && entry.reference === reference ? entry : undefined;
    } catch {
      return undefined;
    }
  }

  /** Best effort: a snapshot that cannot be written only costs the next open a fetch. */
  async write(entry: CachedPrSnapshot): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true });
      await atomicWrite(this.file(entry.connectionId, entry.reference), JSON.stringify(cachedPrSnapshotSchema.parse(entry)));
      await this.prune();
    } catch {
      // See above.
    }
  }

  /** Keeps the most recently written snapshots; a file named the older way is never read again, so it goes. */
  private async prune(): Promise<void> {
    const all = (await readdir(this.directory)).filter((name) => name.endsWith(".json"));
    await Promise.all(all.filter((name) => !CACHE_FILE.test(name)).map((name) => rm(join(this.directory, name), { force: true })));
    const names = all.filter((name) => CACHE_FILE.test(name));
    if (names.length <= MAX_CACHED_PRS) return;
    const dated = await Promise.all(names.map(async (name) => ({
      name, modified: (await stat(join(this.directory, name)).catch(() => null))?.mtimeMs ?? 0,
    })));
    dated.sort((left, right) => left.modified - right.modified);
    await Promise.all(dated.slice(0, names.length - MAX_CACHED_PRS)
      .map(({ name }) => rm(join(this.directory, name), { force: true })));
  }
}
