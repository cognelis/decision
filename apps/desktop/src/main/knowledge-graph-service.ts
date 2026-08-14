import type {
  KnowledgeGraphDecision,
  KnowledgeGraphEdge,
  KnowledgeGraphOutcome,
  KnowledgeGraphPrinciple,
  KnowledgeGraphPrincipleRelation,
  KnowledgeGraphProject,
  KnowledgeGraphSnapshot,
  MethodologyRecord,
  MethodologyRelationRecord,
  OutcomeVerdict,
} from "@cognelis/decision-core";
import type { IndexedDecision } from "@cognelis/decision-storage";

const reviewedVerdict = (value: string | null): OutcomeVerdict | null =>
  value === "better" ||
  value === "as_expected" ||
  value === "mixed" ||
  value === "worse" ||
  value === "unclear"
    ? value
    : null;

const projectName = (value: string): string =>
  value.trim().length > 0 ? value.trim() : "未命名项目";

const projectId = (value: string): string =>
  `project:${encodeURIComponent(projectName(value))}`;

const uniqueSorted = (values: Iterable<string>): string[] =>
  [...new Set(values)].sort((left, right) =>
    left.localeCompare(right, "zh-CN"),
  );

export const buildKnowledgeGraph = (
  records: MethodologyRecord[],
  indexedDecisions: IndexedDecision[],
  relationRecords: MethodologyRelationRecord[] = [],
): KnowledgeGraphSnapshot => {
  const principles = records
    .filter(
      (record) => record.status === "accepted" && record.confirmedAt !== null,
    )
    .sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.id.localeCompare(right.id),
    );
  const decisionsById = new Map(
    indexedDecisions.map((decision) => [decision.id, decision]),
  );
  const principleIdsByDecision = new Map<string, Set<string>>();
  const missingSourceDecisionIds = new Set<string>();

  for (const principle of principles) {
    for (const sourceId of principle.sourceDecisionIds) {
      if (!decisionsById.has(sourceId)) {
        missingSourceDecisionIds.add(sourceId);
        continue;
      }
      const linked = principleIdsByDecision.get(sourceId) ?? new Set<string>();
      linked.add(principle.id);
      principleIdsByDecision.set(sourceId, linked);
    }
  }

  const linkedDecisions = [...principleIdsByDecision.keys()]
    .map((id) => decisionsById.get(id))
    .filter((decision): decision is IndexedDecision => decision !== undefined)
    .sort(
      (left, right) =>
        right.created.localeCompare(left.created) ||
        left.id.localeCompare(right.id),
    );

  const decisions: KnowledgeGraphDecision[] = linkedDecisions.map(
    (decision) => ({
      id: decision.id,
      projectId: projectId(decision.project),
      project: projectName(decision.project),
      question: decision.question,
      selectedAnswer: decision.selectedAnswer,
      principleIds: uniqueSorted(
        principleIdsByDecision.get(decision.id) ?? [],
      ),
    }),
  );

  const outcomes: KnowledgeGraphOutcome[] = linkedDecisions.flatMap(
    (decision) => {
      const verdict = reviewedVerdict(decision.outcomeVerdict);
      if (
        decision.outcome === null ||
        verdict === null ||
        decision.outcomeReviewedAt === null
      ) {
        return [];
      }
      return [
        {
          id: `outcome:${decision.id}`,
          decisionId: decision.id,
          summary: decision.outcome,
          verdict,
          lesson: decision.outcomeLesson,
          reviewedAt: decision.outcomeReviewedAt,
        },
      ];
    },
  );

  const graphPrinciples: KnowledgeGraphPrinciple[] = principles.map(
    (record) => ({
      id: record.id,
      title: record.title,
      principle: record.principle,
      confidence: record.confidence,
      confirmedAt: record.confirmedAt!,
      sourceDecisionIds: [...record.sourceDecisionIds],
      projectIds: uniqueSorted(
        record.sourceDecisionIds.flatMap((id) => {
          const decision = decisionsById.get(id);
          return decision === undefined ? [] : [projectId(decision.project)];
        }),
      ),
    }),
  );
  const acceptedPrincipleIds = new Set(
    graphPrinciples.map((principle) => principle.id),
  );
  const principleRelations: KnowledgeGraphPrincipleRelation[] = relationRecords
    .filter(
      (
        relation,
      ): relation is MethodologyRelationRecord & {
        disposition: "duplicate" | "conflict";
      } =>
        (relation.disposition === "duplicate" ||
          relation.disposition === "conflict") &&
        acceptedPrincipleIds.has(relation.principleIds[0]) &&
        acceptedPrincipleIds.has(relation.principleIds[1]),
    )
    .map((relation) => ({
      id: relation.id,
      sourcePrincipleId: relation.principleIds[0],
      targetPrincipleId: relation.principleIds[1],
      disposition: relation.disposition,
      note: relation.note,
      updatedAt: relation.updatedAt,
    }))
    .sort(
      (left, right) =>
        Number(right.disposition === "conflict") -
          Number(left.disposition === "conflict") ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.id.localeCompare(right.id),
    );

  const projectMap = new Map<string, KnowledgeGraphProject>();
  for (const decision of decisions) {
    const current = projectMap.get(decision.projectId) ?? {
      id: decision.projectId,
      name: decision.project,
      decisionIds: [],
      principleIds: [],
    };
    current.decisionIds.push(decision.id);
    current.principleIds.push(...decision.principleIds);
    projectMap.set(decision.projectId, current);
  }
  const projects = [...projectMap.values()]
    .map((project) => ({
      ...project,
      decisionIds: uniqueSorted(project.decisionIds),
      principleIds: uniqueSorted(project.principleIds),
    }))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));

  const edges: KnowledgeGraphEdge[] = [
    ...decisions.map((decision) => ({
      sourceId: decision.projectId,
      targetId: decision.id,
      relationship: "project-decision" as const,
    })),
    ...outcomes.map((outcome) => ({
      sourceId: outcome.decisionId,
      targetId: outcome.id,
      relationship: "decision-outcome" as const,
    })),
    ...decisions.flatMap((decision) =>
      decision.principleIds.map((principleId) => ({
        sourceId: decision.id,
        targetId: principleId,
        relationship: "decision-principle" as const,
      })),
    ),
    ...principleRelations.map((relation) => ({
      sourceId: relation.sourcePrincipleId,
      targetId: relation.targetPrincipleId,
      relationship:
        relation.disposition === "conflict"
          ? ("principle-conflict" as const)
          : ("principle-duplicate" as const),
    })),
  ];

  return {
    projects,
    decisions,
    outcomes,
    principles: graphPrinciples,
    principleRelations,
    edges,
    missingSourceDecisionIds: uniqueSorted(missingSourceDecisionIds),
  };
};
