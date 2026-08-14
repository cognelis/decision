export type PracticeAssetKind = "skill" | "workflow";
export type PracticeAssetStatus = "candidate" | "accepted" | "dismissed";

export interface PracticeAssetGeneration {
  requestId: string;
  profileId: string;
  provider: string;
  model: string;
}

export interface PracticeAssetSourceSnapshot {
  id: string;
  updatedAt: string;
  title: string;
  principle: string;
  appliesWhen: string;
  caution: string;
  confidence: "low" | "medium" | "high";
}

export interface PracticeAssetDraft {
  title: string;
  summary: string;
  trigger: string;
  steps: string[];
  checks: string[];
  fallback: string;
}

export interface PracticeAssetRecord extends PracticeAssetDraft {
  id: string;
  slug: string;
  kind: PracticeAssetKind;
  status: PracticeAssetStatus;
  createdAt: string;
  updatedAt: string;
  acceptedAt: string | null;
  sourcePrincipleIds: string[];
  sourceSnapshots?: PracticeAssetSourceSnapshot[];
  supersedesId?: string | null;
  migrationSourcePrincipleIds?: string[];
  generation: PracticeAssetGeneration;
}

export type PracticeAssetHistoryReason =
  | "manual_edit"
  | "replacement_applied"
  | "restore_checkpoint";

export interface PracticeAssetHistoryEntry {
  version: number;
  capturedAt: string;
  reason: PracticeAssetHistoryReason;
  snapshot: PracticeAssetRecord;
}
