export type PracticePublicationTarget = "codex" | "claude-code";

export type PracticePublicationState =
  | "not_published"
  | "up_to_date"
  | "update_available"
  | "target_modified"
  | "occupied"
  | "missing_target"
  | "unsafe_target";

export interface PracticePublicationStatus {
  target: PracticePublicationTarget;
  targetLabel: string;
  state: PracticePublicationState;
  version: number | null;
  publishedAt: string | null;
  canPublish: boolean;
  canRollback: boolean;
  requiresOverwriteConfirmation: boolean;
  message: string;
}

export interface PracticePublicationReceipt {
  target: PracticePublicationTarget;
  action: "published" | "unchanged" | "rolled_back";
  version: number | null;
  publishedAt: string | null;
  restoredPreviousContent: boolean;
}
