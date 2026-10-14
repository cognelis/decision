import { useEffect, useState } from "react";

import type {
  MethodologyRecordsApi,
  MethodologyValidationItem,
} from "../../../../shared/renderer-api.js";
import type { MethodologyWorkspaceHost } from "./methodology-view-types.js";

/**
 * The inbox of accepted principles that have picked up new reviews since they
 * were adopted, lifted out of MethodologyPanel.
 *
 * Six pieces of state, one effect and two functions: open the principle behind
 * an entry, or record that it still holds. Acknowledging is deliberately not
 * offered for an entry that already has a revision draft — the draft is the
 * answer, and confirming past it would bury it.
 */
export type ValidationInboxApi = Pick<
  MethodologyRecordsApi,
  "getMethodologyValidationInbox" | "acknowledgeMethodologyValidation"
>;

export interface ValidationInboxOptions {
  api: ValidationInboxApi;
  host: MethodologyWorkspaceHost;
  /** The panel's record revision; acknowledging changes what is left here. */
  revisionKey: number;
  /** Brings the principle behind an entry into view. */
  openPrinciple(id: string): void;
}

export const useValidationInbox = ({
  api,
  host,
  revisionKey,
  openPrinciple,
}: ValidationInboxOptions) => {
  const [validationItems, setValidationItems] = useState<
    MethodologyValidationItem[]
  >([]);
  const [validationLoading, setValidationLoading] = useState(true);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [validationInboxOpen, setValidationInboxOpen] = useState(false);
  const [validationActionId, setValidationActionId] = useState<string | null>(
    null,
  );
  const [validationActionError, setValidationActionError] = useState<
    string | null
  >(null);

  useEffect(() => {
    let active = true;
    setValidationLoading(true);
    setValidationError(null);
    void api
      .getMethodologyValidationInbox()
      .then((items) => {
        if (active) setValidationItems(items);
      })
      .catch((caught: unknown) => {
        if (active) {
          setValidationItems([]);
          setValidationError(
            caught instanceof Error ? caught.message : String(caught),
          );
        }
      })
      .finally(() => {
        if (active) setValidationLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, revisionKey]);

  const openValidationInbox = (): void => {
    setValidationActionError(null);
    setValidationInboxOpen(true);
  };

  const closeValidationInbox = (): void => setValidationInboxOpen(false);

  const openValidationItem = (item: MethodologyValidationItem): void => {
    closeValidationInbox();
    setValidationActionError(null);
    openPrinciple(item.revisionDraftId ?? item.principleId);
  };

  const acknowledgeValidation = async (
    item: MethodologyValidationItem,
  ): Promise<void> => {
    if (item.revisionDraftId !== null) return;
    setValidationActionId(item.principleId);
    setValidationActionError(null);
    try {
      const newest = item.decisions[0];
      if (newest === undefined) return;
      await api.acknowledgeMethodologyValidation(item.principleId, { reviewedAt: newest.reviewedAt, decisionId: newest.id });
      setValidationItems((current) =>
        current.filter(
          (candidate) => candidate.principleId !== item.principleId,
        ),
      );
      host.notify({
        tone: "success",
        text: `已确认“${item.title}”在这批新增复盘中仍适用；原则内容与可信度未改变。`,
      });
      host.refreshRecords();
    } catch (caught) {
      setValidationActionError(
        caught instanceof Error ? caught.message : String(caught),
      );
      // Mostly "已经变化，请刷新": read again, rather than leave what changed to be tried again as it was.
      host.refreshRecords();
    } finally {
      setValidationActionId(null);
    }
  };

  return {
    acknowledgeValidation,
    closeValidationInbox,
    openValidationInbox,
    openValidationItem,
    validationActionError,
    validationActionId,
    validationError,
    validationInboxOpen,
    validationItems,
    validationLoading,
  };
};
