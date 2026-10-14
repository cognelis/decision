import type {
  MethodologyQualityRelation,
  MethodologyRelationDisposition,
} from "@cognelis/decision-core";
import { useState } from "react";

import type {
  MethodologyItem,
  MethodologyRecordsApi,
} from "../../../../shared/renderer-api.js";
import {
  buildRelationReviewQueue,
  type MethodologyRelationReviewItem,
} from "./methodology-relation-model.js";
import type { MethodologyWorkspaceHost } from "./methodology-view-types.js";

/**
 * Reviewing the relations between principles, lifted out of MethodologyPanel.
 *
 * Twelve pieces of state and seven functions covering two related flows: one
 * relation opened on its own, and a queue worked through in order, returned
 * under their original 31 names so the panel's JSX did not move.
 *
 * The cleanest of the clusters lifted out so far: three options, where manual
 * drafting still needs five. The earlier guess that relations would be the most
 * tangled was simply wrong; the block reaches outside only to refresh the
 * record list and report.
 */
export interface RelationReviewOptions {
  api: MethodologyRecordsApi;
  selected: MethodologyItem | null;
  host: MethodologyWorkspaceHost;
}

export const useRelationReview = ({
  api,
  selected,
  host,
}: RelationReviewOptions) => {
  const [reviewingRelation, setReviewingRelation] =
    useState<MethodologyQualityRelation | null>(null);
  const [relationDisposition, setRelationDisposition] =
    useState<MethodologyRelationDisposition | null>(null);
  const [relationNote, setRelationNote] = useState("");
  const [relationSaving, setRelationSaving] = useState(false);
  const [relationError, setRelationError] = useState<string | null>(null);
  const [relationQueue, setRelationQueue] = useState<
    MethodologyRelationReviewItem[] | null
  >(null);
  const [relationQueueTotal, setRelationQueueTotal] = useState(0);
  const [relationQueueLoading, setRelationQueueLoading] = useState(false);
  const [relationQueueSaving, setRelationQueueSaving] = useState(false);
  const [relationQueueDisposition, setRelationQueueDisposition] =
    useState<MethodologyRelationDisposition | null>(null);
  const [relationQueueNote, setRelationQueueNote] = useState("");
  const [relationQueueError, setRelationQueueError] = useState<string | null>(
    null,
  );

  const beginRelationReview = (relation: MethodologyQualityRelation): void => {
    setReviewingRelation(relation);
    setRelationDisposition(relation.resolution ?? null);
    setRelationNote(relation.resolutionNote ?? "");
    setRelationError(null);
    host.dismissAcceptancePrompt();
  };

  const saveRelationReview = async (): Promise<void> => {
    if (
      selected === null ||
      reviewingRelation === null ||
      relationDisposition === null
    ) {
      return;
    }
    setRelationSaving(true);
    setRelationError(null);
    try {
      const updated = await api.setMethodologyRelation(
        selected.id,
        reviewingRelation.id,
        relationDisposition,
        relationNote.trim() || null,
      );
      host.showRecord(updated);
      setReviewingRelation(null);
      setRelationDisposition(null);
      setRelationNote("");
      host.refreshRecords();
    } catch (caught) {
      setRelationError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setRelationSaving(false);
    }
  };

  const clearRelationReview = async (): Promise<void> => {
    if (selected === null || reviewingRelation === null) return;
    setRelationSaving(true);
    setRelationError(null);
    try {
      const updated = await api.clearMethodologyRelation(
        selected.id,
        reviewingRelation.id,
      );
      host.showRecord(updated);
      setReviewingRelation(null);
      setRelationDisposition(null);
      setRelationNote("");
      host.refreshRecords();
    } catch (caught) {
      setRelationError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setRelationSaving(false);
    }
  };

  const closeRelationQueue = (): void => {
    setRelationQueue(null);
    setRelationQueueTotal(0);
    setRelationQueueDisposition(null);
    setRelationQueueNote("");
    setRelationQueueError(null);
  };

  const openRelationQueue = async (): Promise<void> => {
    const current = host.opening();
    setRelationQueueLoading(true);
    host.notify(null);
    try {
      const records = await api.listMethodologies();
      // Read once the reader had opened a principle themselves: the queue does not close it to open over it.
      if (!current()) return;
      const queue = buildRelationReviewQueue(records);
      if (queue.length === 0) {
        host.notify({ tone: "success", text: "当前没有待核对的原则关系。" });
        return;
      }
      host.showRecord(null);
      setReviewingRelation(null);
      setRelationQueue(queue);
      setRelationQueueTotal(queue.length);
      setRelationQueueDisposition(null);
      setRelationQueueNote("");
      setRelationQueueError(null);
    } catch (caught) {
      host.notify({
        tone: "error",
        text: `关系整理失败：${caught instanceof Error ? caught.message : String(caught)}`,
      });
    } finally {
      setRelationQueueLoading(false);
    }
  };

  const saveRelationQueueItem = async (): Promise<void> => {
    const queue = relationQueue;
    if (queue === null || relationQueueDisposition === null) return;
    const current = queue[0];
    if (current === undefined) return;
    setRelationQueueSaving(true);
    setRelationQueueError(null);
    try {
      const updated = await api.setMethodologyRelation(
        current.left.id,
        current.right.id,
        relationQueueDisposition,
        relationQueueNote.trim() || null,
      );
      host.replaceRecord(updated);
      // A conclusion belongs to both sides of the pair, and the queue may be left before it is done:
      // the records are read again after each one, not only after the last.
      host.refreshRecords();
      const remaining = queue.slice(1);
      setRelationQueueDisposition(null);
      setRelationQueueNote("");
      if (remaining.length === 0) {
        closeRelationQueue();
        host.notify({
          tone: "success",
          text: `已完成 ${relationQueueTotal} 组原则关系核对。`,
        });
      } else {
        setRelationQueue(remaining);
      }
    } catch (caught) {
      setRelationQueueError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setRelationQueueSaving(false);
    }
  };

  const postponeRelationQueueItem = (): void => {
    if (relationQueue === null || relationQueue.length <= 1) {
      closeRelationQueue();
      return;
    }
    const [current, ...remaining] = relationQueue;
    setRelationQueue([...remaining, current!]);
    setRelationQueueDisposition(null);
    setRelationQueueNote("");
    setRelationQueueError(null);
  };

  return {
    beginRelationReview,
    clearRelationReview,
    closeRelationQueue,
    openRelationQueue,
    postponeRelationQueueItem,
    relationDisposition,
    relationError,
    relationNote,
    relationQueue,
    relationQueueDisposition,
    relationQueueError,
    relationQueueLoading,
    relationQueueNote,
    relationQueueSaving,
    relationQueueTotal,
    relationSaving,
    reviewingRelation,
    saveRelationQueueItem,
    saveRelationReview,
    setRelationDisposition,
    setRelationError,
    setRelationNote,
    setRelationQueue,
    setRelationQueueDisposition,
    setRelationQueueError,
    setRelationQueueLoading,
    setRelationQueueNote,
    setRelationQueueSaving,
    setRelationQueueTotal,
    setRelationSaving,
    setReviewingRelation,
  };
};
