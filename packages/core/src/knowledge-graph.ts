import type { MethodologyConfidence } from "./methodology.js";
import type { OutcomeVerdict } from "./record.js";

export interface KnowledgeGraphProject {
  id: string;
  name: string;
  decisionIds: string[];
  principleIds: string[];
}

export interface KnowledgeGraphDecision {
  id: string;
  projectId: string;
  project: string;
  question: string;
  selectedAnswer: string;
  principleIds: string[];
}

export interface KnowledgeGraphOutcome {
  id: string;
  decisionId: string;
  summary: string;
  verdict: OutcomeVerdict;
  lesson: string | null;
  reviewedAt: string;
}

export interface KnowledgeGraphPrinciple {
  id: string;
  title: string;
  principle: string;
  confidence: MethodologyConfidence;
  confirmedAt: string;
  sourceDecisionIds: string[];
  projectIds: string[];
}

export interface KnowledgeGraphPrincipleRelation {
  id: string;
  sourcePrincipleId: string;
  targetPrincipleId: string;
  disposition: "duplicate" | "conflict";
  note: string | null;
  updatedAt: string;
}

export type KnowledgeGraphRelationship =
  | "project-decision"
  | "decision-outcome"
  | "decision-principle"
  | "principle-duplicate"
  | "principle-conflict";

export interface KnowledgeGraphEdge {
  sourceId: string;
  targetId: string;
  relationship: KnowledgeGraphRelationship;
}

export interface KnowledgeGraphSnapshot {
  projects: KnowledgeGraphProject[];
  decisions: KnowledgeGraphDecision[];
  outcomes: KnowledgeGraphOutcome[];
  principles: KnowledgeGraphPrinciple[];
  principleRelations: KnowledgeGraphPrincipleRelation[];
  edges: KnowledgeGraphEdge[];
  missingSourceDecisionIds: string[];
}
