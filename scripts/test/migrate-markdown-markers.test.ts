import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { convertMarkers, planMarkerMigration, applyMarkerMigration } from "../migrate-markdown-markers.mjs";
import { parseDecision, serializeDecision } from "@cognelis/decision-storage";
import { recordFixture } from "../../packages/storage/test/fixtures.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-format-test-")); roots.push(root);
  const vault = join(root, "vault"); await mkdir(join(vault, "Decision Journal/decisions"), { recursive: true });
  const path = join(vault, "Decision Journal/decisions/note.md");
  const record = recordFixture();
  const original = serializeDecision(record).replaceAll("<!-- decision:", "<!-- previous:");
  await writeFile(path, original);
  return { root, vault, path, record, original };
};
describe("one-time marker migration", () => {
  it("previews without writes, backs up bytes, and preserves parsed decision facts", async () => {
    const { root, vault, path, record, original } = await setup();
    const plan = await planMarkerMigration(vault, "previous");
    expect(await readFile(path, "utf8")).toBe(original);
    const result = await applyMarkerMigration(plan, join(root, "backups"));
    expect(await readFile(join(result.backup, "0.backup"), "utf8")).toBe(original);
    expect(parseDecision(await readFile(path, "utf8"))).toEqual(record);
    expect((await planMarkerMigration(vault, "previous")).changes).toHaveLength(0);
  });
  it("preserves escaped literal text and rejects stale previews", async () => {
    expect(convertMarkers("\\<!-- previous:user-literal -->", "previous")).toBe("<!-- previous:user-literal -->");
    const { root, vault, path, original } = await setup();
    await writeFile(path, `\uFEFF${original}`);
    const plan = await planMarkerMigration(vault, "previous");
    expect(plan.changes[0]?.converted.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    await writeFile(path, "independent user change");
    await expect(applyMarkerMigration(plan, join(root, "backups"))).rejects.toThrow("Source changed");
    expect(await readFile(path, "utf8")).toBe("independent user change");
  });
});
