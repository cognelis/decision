import { mkdir, mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { CandidateSpool } from "../src/candidate-spool.js";
import { expireQuarantined } from "../src/quarantine.js";
import { SemanticPairSpool } from "../src/semantic-pair-spool.js";

const DAY = 24 * 60 * 60 * 1_000;

it("lets what was set aside as unreadable go after a week, as the rest of its spool does", async () => {
  const root = await mkdtemp(join(tmpdir(), "quarantine-"));
  let now = Date.parse("2026-10-01T00:00:00.000Z");
  const pairs = new SemanticPairSpool(join(root, "pairs"), { now: () => new Date(now) });
  const candidates = new CandidateSpool(join(root, "candidates"), { now: () => new Date(now) });
  // A file cut short (a crash, a full disk) holds the reply and the answer as well as a whole one does.
  for (const items of [join(root, "pairs", "items"), join(root, "candidates", "items")]) {
    await mkdir(items, { recursive: true });
    await writeFile(join(items, `${"a".repeat(64)}.json`), '{"assistantText":"要不要把 Bob 的绩效降到 2');
  }
  await pairs.list();
  await candidates.list();
  const quarantined = async () => [
    ...await readdir(join(root, "pairs", "quarantine")),
    ...await readdir(join(root, "candidates", "quarantine")),
  ];
  expect(await quarantined()).toHaveLength(2);

  now += 6 * DAY;
  await pairs.list();
  await candidates.list();
  expect(await quarantined()).toHaveLength(2);

  now += 2 * DAY;
  await pairs.list();
  await candidates.list();
  expect(await quarantined()).toEqual([]);
});

it("ages a search index set aside by the time in its name, not by when it was last written", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quarantine-search-"));
  const now = Date.parse("2026-10-01T00:00:00.000Z");
  const setAside = join(directory, "index.sqlite.corrupt-20260930T235959000Z-schemarecovery");
  await writeFile(setAside, "SQLite format 3");
  // Not opened for a week and more, then set aside on this start.
  await utimes(setAside, new Date(now - 8 * DAY), new Date(now - 8 * DAY));

  await expireQuarantined(directory, 7 * DAY, now);
  expect(await readdir(directory)).toEqual(["index.sqlite.corrupt-20260930T235959000Z-schemarecovery"]);
});

it("ages one set aside without a time in its name by when it was last written", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quarantine-unnamed-"));
  const now = Date.parse("2026-10-01T00:00:00.000Z");
  // As the capture spool named them before: a uuid, no time.
  await writeFile(join(directory, "event.json.corrupt-12345678-aaaa-bbbb-cccc-dddddddddddd"), "{");
  await writeFile(join(directory, "event.json"), "{}");
  await utimes(join(directory, "event.json.corrupt-12345678-aaaa-bbbb-cccc-dddddddddddd"), new Date(now - 8 * DAY), new Date(now - 8 * DAY));

  await expireQuarantined(directory, 7 * DAY, now);
  expect(await readdir(directory)).toEqual(["event.json"]);
});
