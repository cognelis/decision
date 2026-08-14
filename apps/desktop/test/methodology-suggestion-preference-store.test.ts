import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { MethodologySuggestionPreferenceStore } from "../src/main/methodology-suggestion-preference-store.js";

describe("MethodologySuggestionPreferenceStore", () => {
  it("persists reversible deferrals without storing source decision ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "methodology-suggestions-"));
    const path = join(root, "preferences.json");
    const store = new MethodologySuggestionPreferenceStore(path);
    const suggestionId = "suggestion:decision-private-1:decision-private-2";

    await store.defer(suggestionId, "2026-08-08T10:00:00.000Z");

    await expect(store.isDeferred(suggestionId)).resolves.toBe(true);
    await expect(
      store.partition([{ id: suggestionId }, { id: "suggestion:other" }]),
    ).resolves.toEqual({
      active: [{ id: "suggestion:other" }],
      deferred: [{ id: suggestionId }],
    });
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("decision-private");
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    await expect(store.restore(suggestionId)).resolves.toBe(true);
    await expect(store.isDeferred(suggestionId)).resolves.toBe(false);
    await expect(store.restore(suggestionId)).resolves.toBe(false);
  });

  it("does not overwrite a corrupted preference file", async () => {
    const root = await mkdtemp(join(tmpdir(), "methodology-suggestions-"));
    const path = join(root, "preferences.json");
    const store = new MethodologySuggestionPreferenceStore(path);
    await store.defer("suggestion:one", "2026-08-08T10:00:00.000Z");
    await writeFile(path, "not json", "utf8");

    await expect(
      store.defer("suggestion:two", "2026-08-08T11:00:00.000Z"),
    ).rejects.toThrow("搁置状态损坏");
    await expect(readFile(path, "utf8")).resolves.toBe("not json");
  });
});
