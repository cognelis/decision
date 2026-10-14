import type { MethodologySuggestion } from "@cognelis/decision-core";
import { useEffect, useState } from "react";

import type { MethodologyRecordsApi } from "../../../../shared/renderer-api.js";
import type { MethodologyWorkspaceHost } from "./methodology-view-types.js";

/**
 * The inbox of reviewed-evidence groups waiting to be distilled, lifted out of
 * MethodologyPanel.
 *
 * Nine pieces of state, two effects and three functions covering one flow:
 * read the groups, set one aside, and put a set-aside one back. It reaches
 * outside only to report and to be reloaded when the records change, which is
 * why it takes three options where manual drafting needed five.
 */
export type SuggestionInboxApi = Pick<
  MethodologyRecordsApi,
  | "getMethodologySuggestions"
  | "getDeferredMethodologySuggestions"
  | "deferMethodologySuggestion"
  | "restoreMethodologySuggestion"
>;

export interface SuggestionInboxOptions {
  api: SuggestionInboxApi;
  host: MethodologyWorkspaceHost;
  /** The panel's record revision; a new principle changes what is left to distil. */
  revisionKey: number;
}

export const useSuggestionInbox = ({
  api,
  host,
  revisionKey,
}: SuggestionInboxOptions) => {
  const [suggestions, setSuggestions] = useState<MethodologySuggestion[]>([]);
  const [deferredSuggestions, setDeferredSuggestions] = useState<
    MethodologySuggestion[]
  >([]);
  const [suggestionLoading, setSuggestionLoading] = useState(true);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const [suggestionActionError, setSuggestionActionError] = useState<
    string | null
  >(null);
  const [suggestionRevision, setSuggestionRevision] = useState(0);
  const [suggestionInboxOpen, setSuggestionInboxOpen] = useState(false);
  const [suggestionInboxMode, setSuggestionInboxMode] = useState<
    "active" | "deferred"
  >("active");
  const [suggestionActionId, setSuggestionActionId] = useState<string | null>(
    null,
  );

  useEffect(() => {
    let active = true;
    setSuggestionLoading(true);
    setSuggestionError(null);
    void Promise.all([
      api.getMethodologySuggestions(),
      api.getDeferredMethodologySuggestions(),
    ])
      .then(([records, deferred]) => {
        if (active) {
          setSuggestions(records);
          setDeferredSuggestions(deferred);
        }
      })
      .catch((caught: unknown) => {
        if (active) {
          setSuggestions([]);
          setDeferredSuggestions([]);
          setSuggestionError(
            caught instanceof Error ? caught.message : String(caught),
          );
        }
      })
      .finally(() => {
        if (active) setSuggestionLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, revisionKey, suggestionRevision]);

  // Setting the last group aside empties the tab the reader is looking at; the
  // inbox moves them to the one that still has something in it.
  useEffect(() => {
    if (
      suggestionInboxOpen &&
      suggestionInboxMode === "active" &&
      suggestions.length === 0 &&
      deferredSuggestions.length > 0
    ) {
      setSuggestionInboxMode("deferred");
    } else if (
      suggestionInboxOpen &&
      suggestionInboxMode === "deferred" &&
      deferredSuggestions.length === 0 &&
      suggestions.length > 0
    ) {
      setSuggestionInboxMode("active");
    }
  }, [
    deferredSuggestions.length,
    suggestionInboxMode,
    suggestionInboxOpen,
    suggestions.length,
  ]);

  const openSuggestionInbox = (): void => {
    setSuggestionInboxMode(
      suggestions.length > 0 || deferredSuggestions.length === 0
        ? "active"
        : "deferred",
    );
    setSuggestionActionError(null);
    setSuggestionInboxOpen(true);
  };

  const closeSuggestionInbox = (): void => setSuggestionInboxOpen(false);

  const showSuggestions = (mode: "active" | "deferred"): void =>
    setSuggestionInboxMode(mode);

  const deferSuggestion = async (
    suggestion: MethodologySuggestion,
  ): Promise<void> => {
    setSuggestionActionId(suggestion.id);
    setSuggestionActionError(null);
    try {
      await api.deferMethodologySuggestion(suggestion.id);
      host.notify({
        tone: "success",
        text: "已搁置这组复盘素材；有新复盘形成新组合时仍会再次提示。",
      });
      setSuggestionRevision((value) => value + 1);
    } catch (caught) {
      setSuggestionActionError(
        caught instanceof Error ? caught.message : String(caught),
      );
      // Mostly "已变化，请刷新后再操作": read again, rather than leave a stale group to be set aside again.
      setSuggestionRevision((value) => value + 1);
    } finally {
      setSuggestionActionId(null);
    }
  };

  const restoreSuggestion = async (
    suggestion: MethodologySuggestion,
  ): Promise<void> => {
    setSuggestionActionId(suggestion.id);
    setSuggestionActionError(null);
    try {
      await api.restoreMethodologySuggestion(suggestion.id);
      host.notify({ tone: "success", text: "已恢复到可提炼素材。" });
      setSuggestionInboxMode("active");
      setSuggestionRevision((value) => value + 1);
    } catch (caught) {
      setSuggestionActionError(
        caught instanceof Error ? caught.message : String(caught),
      );
      setSuggestionRevision((value) => value + 1);
    } finally {
      setSuggestionActionId(null);
    }
  };

  return {
    closeSuggestionInbox,
    deferSuggestion,
    deferredSuggestions,
    openSuggestionInbox,
    restoreSuggestion,
    showSuggestions,
    suggestionActionError,
    suggestionActionId,
    suggestionError,
    suggestionInboxMode,
    suggestionInboxOpen,
    suggestionLoading,
    suggestions,
    visibleSuggestionInboxItems:
      suggestionInboxMode === "active" ? suggestions : deferredSuggestions,
  };
};
