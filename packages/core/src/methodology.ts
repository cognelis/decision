export type MethodologyStatus =
  | "candidate"
  | "accepted"
  | "retired"
  | "dismissed";

export type MethodologyConfidence = "low" | "medium" | "high";

export type MethodologyOrigin =
  | "decision_evidence"
  | "markdown_import"
  | "manual_entry"
  | "principle_merge"
  | "principle_revision";

export interface MethodologyGeneration {
  requestId: string;
  profileId: string;
  provider: string;
  model: string;
}

export interface MethodologyImportSource {
  fileName: string;
  contentSha256: string;
}

export interface MethodologyUsageValidation {
  reviewedAt: string;
  decisionId: string;
  validatedAt: string;
}

export interface MethodologyRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  origin: MethodologyOrigin;
  status: MethodologyStatus;
  confirmedAt: string | null;
  title: string;
  principle: string;
  appliesWhen: string;
  caution: string;
  evidenceSummary: string;
  sourceDecisionIds: string[];
  sourcePrincipleIds?: string[];
  importSource?: MethodologyImportSource;
  appliedAt?: string;
  appliedToId?: string;
  retiredAt?: string;
  supersededById?: string;
  usageValidation?: MethodologyUsageValidation;
  confidence: MethodologyConfidence;
  generation: MethodologyGeneration;
}

export type MethodologyHistoryReason =
  | "revision_applied"
  | "restore_checkpoint";

export interface MethodologyHistoryEntry {
  version: number;
  capturedAt: string;
  reason: MethodologyHistoryReason;
  snapshot: MethodologyRecord;
}

export interface MethodologyDraft {
  title: string;
  principle: string;
  appliesWhen: string;
  caution: string;
  evidenceSummary: string;
  confidence: MethodologyConfidence;
}
