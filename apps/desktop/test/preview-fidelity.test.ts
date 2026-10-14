// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import { DESKTOP_PRIMARY_SURFACES } from "../src/shared/renderer-api.js";
import { createPreviewApi } from "../src/renderer/preview-api.js";

/**
 * The preview API stands in for the real one in every layout check and in the
 * captured screenshots. Where it answers differently from the real thing, the
 * measurements are taken against data the app never produces — and the check
 * still passes, which is the part that makes it worth pinning.
 */
describe("preview API fidelity", () => {
  // The API reads the surface off the URL, so a test that picks one has to
  // put it back: the suite runs shuffled.
  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("can open every primary surface", async () => {
    // A surface no preview can reach is a page no screenshot and no layout
    // check has ever drawn — 问答 sat that way until this test was written.
    for (const surface of DESKTOP_PRIMARY_SURFACES) {
      window.history.replaceState({}, "", `?preview=${surface}`);
      const snapshot = await createPreviewApi().getSnapshot();
      expect({ surface, opened: snapshot.primarySurface }).toEqual({
        surface,
        opened: surface,
      });
    }
  });

  it("caps a decision read the way the index does", async () => {
    const api = createPreviewApi();

    const all = await api.listDecisions({ query: "" });
    const capped = await api.listDecisions({ query: "", limit: 5 });

    expect(all.length).toBeGreaterThan(5);
    expect(capped).toHaveLength(5);
    expect(capped).toEqual(all.slice(0, 5));
  });

  it("answers with the fourth kind of record, not an empty list", async () => {
    const api = createPreviewApi();

    const all = await api.listJournalEntries({});
    const ideas = await api.listJournalEntries({ kind: "idea" });

    // Preferences and ideas are sedimented knowledge like decisions and
    // principles; a preview that has none of them renders a view and a quick
    // jump group nobody ever sees.
    expect(all.length).toBeGreaterThan(1);
    expect(new Set(all.map((entry) => entry.kind))).toEqual(
      new Set(["preference", "idea"]),
    );
    expect(ideas.every((entry) => entry.kind === "idea")).toBe(true);
    expect(ideas.length).toBeLessThan(all.length);
  });

  it("spreads model traces over more than one purpose", async () => {
    window.history.replaceState({}, "", "?preview=activity");
    const api = createPreviewApi();

    const traces = await api.listModelTraces();

    // The log page hides the 用途 filter below two purposes, so a single-purpose
    // sample leaves that control out of every screenshot and layout check.
    expect(traces.length).toBeGreaterThan(1);
    expect(new Set(traces.map((trace) => trace.purpose)).size).toBeGreaterThan(1);
  });

  it("keeps a saved remote backend among the model profiles", async () => {
    window.history.replaceState({}, "", "?preview=models");
    const api = createPreviewApi();

    const profiles = await api.listModelProviderProfiles();

    // Built-ins alone leave the row that says 远程调用, its edit and delete
    // actions, and the editor that opens for a saved remote backend — locked
    // kind, key field, proxy fieldset — outside every screenshot and check.
    expect(profiles.length).toBeGreaterThan(1);
    expect(
      profiles.some(
        (profile) =>
          profile.kind === "openai" ||
          profile.kind === "anthropic" ||
          profile.kind === "openai-compatible",
      ),
    ).toBe(true);
  });

  it("shows a local client that is not healthy", async () => {
    window.history.replaceState({}, "", "?preview=models");
    const api = createPreviewApi();

    const statuses = await api.listLocalModelClientStatuses();

    // Six availability states share one column. With every client available,
    // five of them — including the longest string of the six — are never laid
    // out anywhere.
    expect(statuses.length).toBeGreaterThan(1);
    expect(statuses.some((status) => status.availability !== "available")).toBe(
      true,
    );
  });

  it("caps a filtered read too, not only the unfiltered one", async () => {
    const api = createPreviewApi();

    // Every branch returns its own list; a cap applied to one of them is the
    // kind of thing that reads as fixed and is not.
    const reviewed = await api.listDecisions({
      query: "",
      reviewState: "reviewed",
      limit: 1,
    });

    expect(reviewed.length).toBeLessThanOrEqual(1);
  });
});
