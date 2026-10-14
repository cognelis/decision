import type { MethodologyEvidenceMatch } from "@cognelis/decision-core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  DecisionLibraryItem,
  MethodologyItem,
  MethodologyRecordsApi,
} from "../../../../shared/renderer-api.js";

/**
 * Picking the reviewed decisions behind a principle, lifted out of
 * MethodologyPanel.
 *
 * Nine pieces of state, one request sequence and two derived lists, covering
 * both uses of the same picker: choosing sources to distil a new principle
 * from, and linking evidence to one that already exists.
 *
 * Extracting it finishes the intents round. Manual drafting needed this block
 * too and was handed five raw setters for it — a `Dispatch<SetStateAction<T>>`
 * is permission to set that state to anything — plus the request counter and
 * the opener. Those are now the `SourceChooser` below: the same reach, said as
 * the six things that flow actually does.
 */
export type EvidenceLinkingApi = Pick<
  MethodologyRecordsApi,
  "listDecisions" | "getMethodologyEvidenceMatches"
>;

/** How many sources one principle may be distilled from. */
const MAX_SOURCES = 5;

const normalizedSearch = (value: string): string =>
  value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");

/**
 * What another flow may ask of the picker. Manual drafting opens it, restores
 * it onto a saved draft, and puts it away; it never needed to set the reviewed
 * list or the loading flag by hand.
 */
export interface SourceChooser {
  /** Which reviewed decisions are ticked. */
  selected: string[];
  /** True while the reviewed decisions are being read. */
  loading: boolean;
  /** Opens the picker and loads what it offers. */
  open(preselected?: string[], mode?: "generate" | "link"): void;
  /** Brings the picker back without reloading or changing the ticks. */
  show(): void;
  /** Puts the picker away. */
  close(): void;
  /** Replaces what is ticked, keeping the five-source ceiling. */
  choose(ids: string[]): void;
  /**
   * Re-opens the picker onto a restored draft: ticks the draft's sources and
   * loads the reviewed decisions plus any of those sources that have since
   * fallen out of that list. Rejects with the reason if the read fails.
   */
  restore(sourceDecisionIds: string[]): Promise<void>;
  /** Abandons any in-flight read so a late answer cannot overwrite the ticks. */
  cancelPendingLoad(): void;
}

export interface EvidenceLinkingOptions {
  api: EvidenceLinkingApi;
  selected: MethodologyItem | null;
  /** Where the picker's own load failure is shown, or cleared with null. */
  reportError(message: string | null): void;
}

export const useEvidenceLinking = ({
  api,
  selected,
  reportError,
}: EvidenceLinkingOptions) => {
  const [choosingSources, setChoosingSources] = useState(false);
  const [linkingEvidence, setLinkingEvidence] = useState(false);
  const [reviewedDecisions, setReviewedDecisions] = useState<
    DecisionLibraryItem[]
  >([]);
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [sourceQuery, setSourceQuery] = useState("");
  const [evidenceMatches, setEvidenceMatches] = useState<
    MethodologyEvidenceMatch[]
  >([]);
  const [evidenceMatchLoading, setEvidenceMatchLoading] = useState(false);
  const [evidenceMatchError, setEvidenceMatchError] = useState<string | null>(
    null,
  );
  const [sourceLoading, setSourceLoading] = useState(false);
  /**
   * Opening the picker again, or leaving it, has to make the previous read's
   * answer irrelevant — it would otherwise land on top of the newer ticks.
   */
  const sourceRequestSequence = useRef(0);

  const evidenceMatchById = useMemo(
    () =>
      new Map(
        evidenceMatches.map((match, index) => [
          match.sourceDecisionId,
          { match, index },
        ]),
      ),
    [evidenceMatches],
  );

  // Loaded, the picker holds the 200 latest reviews; searched, it asks for the rest, as the knowledge page
  // does. Filtered only from what it had, an older review the reader remembered could not be found.
  const [queryMatches, setQueryMatches] = useState<{ query: string; ids: Set<string> }>({ query: "", ids: new Set() });
  useEffect(() => {
    const query = sourceQuery.trim();
    if (!choosingSources || query.length === 0) return;
    const sequence = sourceRequestSequence.current;
    // An older query answering after a newer one was typed is not taken: it put its matches in place of the
    // newer query's, and a review found only by the index (its expected outcome, its tags) dropped out.
    let live = true;
    const timer = setTimeout(() => {
      void api
        .listDecisions({ query, reviewState: "reviewed", limit: 200 })
        .then((found) => {
          if (!live || sourceRequestSequence.current !== sequence) return;
          setReviewedDecisions((current) => [...new Map([...current, ...found].map((record) => [record.id, record])).values()]);
          setQueryMatches({ query, ids: new Set(found.map((record) => record.id)) });
        })
        .catch(() => undefined);
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, choosingSources, sourceQuery]);

  const visibleReviewedDecisions = useMemo(() => {
    const query = normalizedSearch(sourceQuery);
    return reviewedDecisions
      .filter((decision) => {
        if (query.length === 0) return true;
        if (queryMatches.query === sourceQuery.trim() && queryMatches.ids.has(decision.id)) return true;
        return normalizedSearch(
          [
            decision.question,
            decision.selectedAnswer,
            decision.project,
            decision.rationale ?? "",
            decision.context ?? "",
            decision.outcome ?? "",
            decision.outcomeReview?.lesson ?? "",
          ].join("\n"),
        ).includes(query);
      })
      .sort((left, right) => {
        const leftRank = evidenceMatchById.get(left.id)?.index;
        const rightRank = evidenceMatchById.get(right.id)?.index;
        return (
          (leftRank ?? Number.MAX_SAFE_INTEGER) -
            (rightRank ?? Number.MAX_SAFE_INTEGER) ||
          (right.outcomeReview?.reviewedAt ?? "").localeCompare(
            left.outcomeReview?.reviewedAt ?? "",
          ) ||
          left.id.localeCompare(right.id)
        );
      });
  }, [evidenceMatchById, queryMatches, reviewedDecisions, sourceQuery]);

  const openSourceChooser = useCallback((
    preselected: string[] = [],
    mode: "generate" | "link" = "generate",
  ): void => {
    const requestSequence = sourceRequestSequence.current + 1;
    sourceRequestSequence.current = requestSequence;
    setChoosingSources(true);
    setLinkingEvidence(mode === "link");
    setSelectedSources([...new Set(preselected)].slice(0, MAX_SOURCES));
    setSourceQuery("");
    setEvidenceMatches([]);
    setEvidenceMatchError(null);
    setEvidenceMatchLoading(mode === "link");
    reportError(null);
    setSourceLoading(true);
    void api
      .listDecisions({ query: "", reviewState: "reviewed", limit: 200 })
      .then(async (records) => {
        const missing = [...new Set(preselected)].slice(0, MAX_SOURCES)
          .filter((id) => !records.some((record) => record.id === id));
        const additional = await Promise.all(missing.map((decisionId) =>
          api.listDecisions({ query: "", decisionId, reviewState: "reviewed", limit: 1 }),
        ));
        if (sourceRequestSequence.current !== requestSequence) return;
        const availableRecords = [...new Map([...records, ...additional.flat()]
          .map((record) => [record.id, record])).values()];
        setReviewedDecisions(availableRecords);
        const available = new Set(availableRecords.map((record) => record.id));
        setSelectedSources((current) => current.filter((id) => available.has(id)));
        if (preselected.some((id) => !available.has(id))) {
          reportError("部分来源已不存在或不再是完整复盘，请重新选择证据。");
        }
      })
      .catch((caught: unknown) => {
        if (sourceRequestSequence.current !== requestSequence) return;
        setReviewedDecisions([]);
        reportError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (sourceRequestSequence.current === requestSequence) {
          setSourceLoading(false);
        }
      });
    if (mode === "link" && selected !== null) {
      void api
        .getMethodologyEvidenceMatches(selected.id)
        .then((matches) => {
          if (sourceRequestSequence.current === requestSequence) {
            setEvidenceMatches(matches);
          }
        })
        .catch((caught: unknown) => {
          if (sourceRequestSequence.current !== requestSequence) return;
          setEvidenceMatches([]);
          setEvidenceMatchError(
            caught instanceof Error ? caught.message : String(caught),
          );
        })
        .finally(() => {
          if (sourceRequestSequence.current === requestSequence) {
            setEvidenceMatchLoading(false);
          }
        });
    } else {
      setEvidenceMatchLoading(false);
    }
  }, [api, selected, reportError]);

  const toggleSource = (id: string): void => {
    setSelectedSources((current) =>
      current.includes(id)
        ? current.filter((value) => value !== id)
        : current.length >= MAX_SOURCES
          ? current
          : [...current, id],
    );
  };

  const closeSourceChooser = (): void => {
    setChoosingSources(false);
    setLinkingEvidence(false);
    // Opening it again always reloads, so a query left behind would only
    // narrow the next list for reasons the reader has forgotten.
    setSourceQuery("");
  };

  const cancelPendingLoad = (): void => {
    sourceRequestSequence.current += 1;
  };

  const restoreSources = async (
    sourceDecisionIds: string[],
  ): Promise<void> => {
    cancelPendingLoad();
    setSelectedSources([...sourceDecisionIds]);
    setSourceLoading(true);
    try {
      const groups = await Promise.all([
        api.listDecisions({ query: "", reviewState: "reviewed", limit: 200 }),
        // A source can leave the reviewed list after the draft was saved; the
        // draft still names it, so the picker has to be able to show it.
        ...sourceDecisionIds.map((decisionId) =>
          api.listDecisions({ query: "", decisionId, limit: 1 }),
        ),
      ]);
      setReviewedDecisions([
        ...new Map(
          groups.flat().map((decision) => [decision.id, decision]),
        ).values(),
      ]);
    } catch (caught) {
      setReviewedDecisions([]);
      throw caught instanceof Error ? caught : new Error(String(caught));
    } finally {
      setSourceLoading(false);
    }
  };

  const chooser: SourceChooser = {
    selected: selectedSources,
    loading: sourceLoading,
    open: openSourceChooser,
    show: () => setChoosingSources(true),
    close: closeSourceChooser,
    choose: (ids) => setSelectedSources([...ids].slice(0, MAX_SOURCES)),
    restore: restoreSources,
    cancelPendingLoad,
  };

  return {
    cancelPendingLoad,
    choosingSources,
    chooser,
    closeSourceChooser,
    evidenceMatchError,
    evidenceMatchLoading,
    evidenceMatches,
    linkingEvidence,
    openSourceChooser,
    reviewedDecisions,
    selectedSources,
    searchSources: setSourceQuery,
    sourceLoading,
    sourceQuery,
    toggleSource,
    visibleReviewedDecisions,
  };
};
