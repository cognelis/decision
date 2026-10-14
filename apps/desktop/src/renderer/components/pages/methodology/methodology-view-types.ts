import type { MethodologyStatus } from "@cognelis/decision-core";

import type {
  ManualFormDraft,
  MethodologyItem,
} from "../../../../shared/renderer-api.js";

/**
 * Types the panel and the hooks split out of it both name. They lived inside
 * MethodologyPanel; importing them back from there would make the panel and
 * its own hooks import each other.
 */
export type StatusFilter = MethodologyStatus | "all";

export type MethodologyView = "records" | "analysis" | "graph" | "assets";

export interface MethodologyNotice {
  tone: "success" | "warning" | "error";
  text: string;
  action?: "discard_merge_draft" | "discard_revision_draft";
}

/**
 * What a workspace hook may ask of the page.
 *
 * The hooks lifted out of MethodologyPanel each took a list of raw setters,
 * and a `Dispatch<SetStateAction<T>>` is permission to set that state to
 * anything at any time — the contract said nothing about what the hook would
 * actually do. These say it: four intents the page knows how to carry out,
 * shared by every hook instead of four different setter lists.
 */
export interface MethodologyWorkspaceHost {
  /** Brings a record into view: selects it and leaves any editor. */
  openRecord(
    record: MethodologyItem,
    options?: { status?: StatusFilter; view?: MethodologyView },
  ): void;
  /**
   * Begins a read that will open a record: the answer says, once it lands, whether the reader is still where the
   * read began (opened or closed nothing since). A read that lands after they moved on opens nothing over theirs.
   */
  opening(): () => boolean;
  /** Replaces what is on screen with a newer copy, or clears the selection. */
  showRecord(record: MethodologyItem | null): void;
  /** Swaps one record in the loaded list without refetching. */
  replaceRecord(record: MethodologyItem): void;
  /** The records changed on disk; load them again. */
  refreshRecords(): void;
  /** Tells the reader what happened, or clears the last message. */
  notify(notice: MethodologyNotice | null): void;
  /** Puts away the "confirm acceptance" prompt. */
  dismissAcceptancePrompt(): void;
  /** Switches the workspace to one of its views. */
  showView(view: MethodologyView): void;
  /** Narrows the record list to one status. */
  filterBy(status: StatusFilter): void;
  /** Leaves whatever editor is open without saving. */
  leaveEditor(): void;
}

/**
 * The one place on-disk form drafts are held.
 *
 * Four flows autosave into it — manual entry, evidence-backed entry, merge and
 * revision — and each was doing the same list surgery inline. Three intents
 * instead, so no flow can reshape the store in a way the others do not expect.
 */
export interface ManualDraftStore {
  /** Stores a draft, replacing any earlier one under the same key. */
  remember(draft: ManualFormDraft): void;
  /** Drops the draft under this key. */
  forget(key: ManualFormDraft["key"]): void;
  /** Reports that the local store could not be written, or clears that report. */
  failed(message: string | null): void;
  /** Replaces the whole set, for the initial load. */
  replaceAll(drafts: ManualFormDraft[]): void;
}
