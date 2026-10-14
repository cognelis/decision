import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

/** How long what was set aside as unreadable is kept: as long as what it was set aside from. */
export const QUARANTINE_MAXIMUM_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * Removes what was set aside as unreadable once it is older than `maximumAgeMs`. A file the app cannot read can
 * still hold a question, a reply or a prompt, and nothing read the quarantine again: kept, it outlived every
 * limit the rest of its store keeps. Aged by the time in its name (`.corrupt-<ms>-…`), or by when it was last
 * written where the name has none.
 */
export const expireQuarantined = async (
  directory: string,
  maximumAgeMs: number,
  now: number,
  setAside: (name: string) => boolean = (name) => name.includes(".corrupt-"),
): Promise<void> => {
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    if (!setAside(name)) continue;
    const path = join(directory, name);
    // `<ms>`, or `<yyyymmddThhmmssmmmZ>` as the search index stamps its own: aged by when it was last written, an
    // index set aside after a week unopened went the moment it was set aside.
    const stamp = /\.corrupt-(\d{13}|\d{8}T\d{9}Z)-/u.exec(name)?.[1] ?? "";
    const named = stamp.length === 13
      ? Number(stamp)
      : Date.parse(stamp.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)(\d{3})Z$/u, "$1-$2-$3T$4:$5:$6.$7Z"));
    const at = Number.isFinite(named) ? named : await stat(path).then((status) => status.mtimeMs, () => Number.NaN);
    // One whose age it cannot tell is kept: deleted, a passing stat failure took it at once.
    // Either way past its keeping: set aside under a clock that ran ahead, it stayed until that date came round.
    if (Number.isFinite(at) && Math.abs(now - at) >= maximumAgeMs) await unlink(path).catch(() => undefined);
  }
};
