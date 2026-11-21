import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { serializeDecision } from "@cognelis/decision-storage";
import type { DecisionRecord } from "@cognelis/decision-core";

import { recordFixture } from "../../../packages/storage/test/fixtures.js";
import { createNoteFollow } from "../src/main/note-follow.js";

const record = (answer: string): DecisionRecord =>
  recordFixture({
    options: [
      { label: "兼容迁移（推荐）", tradeoffs: [] },
      { label: "直接替换", tradeoffs: [] },
    ],
    selectedAnswer: { kind: "preset", values: [answer] },
    rationaleStatus: "deferred",
    rationaleOriginal: null,
  });

describe("createNoteFollow", () => {
  it("reads a note back from the vault: the stored answer without the marker still follows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "note-follow-"));
    const followed = join(dir, "a.md");
    const other = join(dir, "b.md");
    await writeFile(followed, serializeDecision(record("兼容迁移")));
    await writeFile(other, serializeDecision(record("直接替换")));
    const follow = createNoteFollow();
    expect(follow({ id: "a", filePath: followed })).toBe("followed");
    expect(follow({ id: "b", filePath: other })).toBe("not_followed");
    expect(follow({ id: "c", filePath: join(dir, "missing.md") })).toBeNull();
    expect(follow({ id: "d" })).toBeNull();
  });
});
