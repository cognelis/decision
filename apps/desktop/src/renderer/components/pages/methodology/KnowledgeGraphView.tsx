import type {
  KnowledgeGraphSnapshot,
  OutcomeVerdict,
} from "@cognelis/decision-core";
import { useState } from "react";

interface KnowledgeGraphViewProps {
  graph: KnowledgeGraphSnapshot | null;
  loading: boolean;
  error: string | null;
  mergeLoading: boolean;
  onOpenPrinciples(): void;
  onOpenPrinciple(id: string): void;
  onMergePrinciples(sourceId: string, targetId: string): void;
}

type RelationFilter = "all" | "duplicate" | "conflict";

const verdictLabels: Record<OutcomeVerdict, string> = {
  better: "优于预期",
  as_expected: "符合预期",
  mixed: "部分符合",
  worse: "低于预期",
  unclear: "暂无法判断",
};

const confidenceLabels: Record<
  KnowledgeGraphSnapshot["principles"][number]["confidence"],
  string
> = {
  low: "单点证据",
  medium: "多条印证",
  high: "稳定模式",
};

const relationLabels = {
  duplicate: "确认重复",
  conflict: "确认冲突",
} as const;

const normalizedSearch = (value: string): string =>
  value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");

export const KnowledgeGraphView = ({
  graph,
  loading,
  error,
  mergeLoading,
  onOpenPrinciples,
  onOpenPrinciple,
  onMergePrinciples,
}: KnowledgeGraphViewProps) => {
  const [query, setQuery] = useState("");
  const [relationFilter, setRelationFilter] =
    useState<RelationFilter>("all");
  const [focusedRelationId, setFocusedRelationId] = useState<string | null>(
    null,
  );
  if (loading) {
    return <p className="methodology-message">正在整理关系…</p>;
  }
  if (error !== null) {
    return (
      <p className="methodology-message error-message" role="alert">
        关系图谱暂时无法读取：{error}
      </p>
    );
  }
  if (graph === null || graph.principles.length === 0) {
    return (
      <div className="methodology-empty knowledge-graph-empty">
        <strong>还没有正式关系</strong>
        <span>采纳方法论候选后，这里会连接项目、决策、结果与原则。</span>
        <button type="button" className="primary-button" onClick={onOpenPrinciples}>
          去生成并采纳原则
        </button>
      </div>
    );
  }

  const decisionMap = new Map(
    graph.decisions.map((decision) => [decision.id, decision]),
  );
  const projectMap = new Map(
    graph.projects.map((project) => [project.id, project]),
  );
  const outcomeMap = new Map(
    graph.outcomes.map((outcome) => [outcome.decisionId, outcome]),
  );
  const principleMap = new Map(
    graph.principles.map((principle) => [principle.id, principle]),
  );
  const normalizedQuery = normalizedSearch(query);
  const focusedRelation =
    graph.principleRelations.find(
      (relation) => relation.id === focusedRelationId,
    ) ?? null;
  const visibleRelations = graph.principleRelations.filter((relation) => {
    if (
      relationFilter !== "all" &&
      relation.disposition !== relationFilter
    ) {
      return false;
    }
    if (normalizedQuery.length === 0) return true;
    const source = principleMap.get(relation.sourcePrincipleId);
    const target = principleMap.get(relation.targetPrincipleId);
    return normalizedSearch(
      [source?.title ?? "", target?.title ?? "", relation.note ?? ""].join(
        "\n",
      ),
    ).includes(normalizedQuery);
  });
  const focusedPrincipleIds =
    focusedRelation === null
      ? null
      : new Set([
          focusedRelation.sourcePrincipleId,
          focusedRelation.targetPrincipleId,
        ]);
  const visiblePrinciples = graph.principles.filter((principle) => {
    if (focusedPrincipleIds !== null) {
      return focusedPrincipleIds.has(principle.id);
    }
    if (normalizedQuery.length === 0) return true;
    return normalizedSearch(
      [
        principle.title,
        principle.principle,
        ...principle.projectIds.map((id) => projectMap.get(id)?.name ?? ""),
      ].join("\n"),
    ).includes(normalizedQuery);
  });

  return (
    <section className="knowledge-graph" aria-label="知识关系图谱">
      <dl className="knowledge-graph-summary">
        {[
          ["项目", graph.projects.length],
          ["决策", graph.decisions.length],
          ["结果", graph.outcomes.length],
          ["原则", graph.principles.length],
          ["确认关系", graph.principleRelations.length],
        ].map(([label, count]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{count}</dd>
          </div>
        ))}
      </dl>

      {graph.missingSourceDecisionIds.length === 0 ? null : (
        <p className="knowledge-graph-warning" role="status">
          {graph.missingSourceDecisionIds.length} 条来源决策已在仓库中移除，相关原则仍保留。
        </p>
      )}

      <div className="knowledge-graph-toolbar">
        <label className="knowledge-graph-search">
          <span className="sr-only">搜索图谱</span>
          <input
            type="search"
            aria-label="搜索图谱"
            value={query}
            placeholder="搜索原则或项目"
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setFocusedRelationId(null);
            }}
          />
        </label>
        <label className="knowledge-graph-relation-filter">
          <span>关系</span>
          <select
            aria-label="关系类型"
            value={relationFilter}
            onChange={(event) =>
              setRelationFilter(event.currentTarget.value as RelationFilter)
            }
          >
            <option value="all">全部</option>
            <option value="conflict">冲突</option>
            <option value="duplicate">重复</option>
          </select>
        </label>
        <span className="knowledge-graph-result-count" role="status">
          {visiblePrinciples.length} / {graph.principles.length} 条原则
        </span>
        {focusedRelation?.disposition === "duplicate" ? (
          <button
            type="button"
            className="primary-button knowledge-graph-merge-button"
            disabled={mergeLoading}
            onClick={() =>
              onMergePrinciples(
                focusedRelation.sourcePrincipleId,
                focusedRelation.targetPrincipleId,
              )
            }
          >
            {mergeLoading ? "正在准备…" : "建立合并草案"}
          </button>
        ) : null}
        {focusedRelation === null ? null : (
          <button
            type="button"
            className="text-button"
            onClick={() => setFocusedRelationId(null)}
          >
            退出成对查看
          </button>
        )}
      </div>

      {graph.principleRelations.length === 0 ? null : (
        <section
          className="knowledge-principle-relations"
          aria-label="已确认原则关系"
        >
          <header>
            <div>
              <strong>已确认原则关系</strong>
              <span>只展示双方均已采纳的重复与冲突结论。</span>
            </div>
            <em>{visibleRelations.length} 组</em>
          </header>
          {visibleRelations.length === 0 ? (
            <p>当前搜索和关系筛选下没有匹配项。</p>
          ) : (
            <ol>
              {visibleRelations.map((relation) => {
                const source = principleMap.get(relation.sourcePrincipleId);
                const target = principleMap.get(relation.targetPrincipleId);
                if (source === undefined || target === undefined) return null;
                return (
                  <li key={relation.id} className={relation.disposition}>
                    <button
                      type="button"
                      aria-pressed={focusedRelationId === relation.id}
                      onClick={() => {
                        setQuery("");
                        setFocusedRelationId((current) =>
                          current === relation.id ? null : relation.id,
                        );
                      }}
                    >
                      <span>
                        <em>{relationLabels[relation.disposition]}</em>
                        <small>查看这一组</small>
                      </span>
                      <strong>
                        {source.title}
                        <b aria-hidden="true">↔</b>
                        {target.title}
                      </strong>
                      <p>
                        {relation.note ??
                          (relation.disposition === "conflict"
                            ? "适用范围存在交集，但行动方向不同。"
                            : "两条原则表达同一条可复用规则。")}
                      </p>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      )}

      {visiblePrinciples.length === 0 ? (
        <div className="methodology-empty compact knowledge-graph-no-results">
          <strong>没有匹配的原则</strong>
          <span>换一个关键词，或清空搜索查看全部图谱。</span>
        </div>
      ) : (
      <ol className="knowledge-graph-principles">
        {visiblePrinciples.map((principle) => {
          const sourceDecisions = principle.sourceDecisionIds
            .map((id) => decisionMap.get(id))
            .filter(
              (
                decision,
              ): decision is KnowledgeGraphSnapshot["decisions"][number] =>
                decision !== undefined,
            );
          return (
            <li key={principle.id} className="knowledge-graph-cluster">
              <header className="knowledge-principle-node">
                <div>
                  <span>已采纳原则</span>
                  <div>
                    <em>{confidenceLabels[principle.confidence]}</em>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => onOpenPrinciple(principle.id)}
                    >
                      查看详情
                    </button>
                  </div>
                </div>
                <strong>{principle.title}</strong>
                <p>{principle.principle}</p>
              </header>

              <div className="knowledge-graph-projects" aria-label="关联项目">
                {principle.projectIds.map((id) => {
                  const project = projectMap.get(id);
                  return project === undefined ? null : (
                    <span key={project.id}>{project.name}</span>
                  );
                })}
              </div>

              <ol className="knowledge-graph-evidence">
                {sourceDecisions.map((decision) => {
                  const outcome = outcomeMap.get(decision.id);
                  return (
                    <li key={decision.id}>
                      <div className="knowledge-decision-node">
                        <span>来源决策</span>
                        <strong>{decision.question}</strong>
                        <p>选择：{decision.selectedAnswer}</p>
                      </div>
                      <span className="knowledge-edge" aria-hidden="true">→</span>
                      {outcome === undefined ? (
                        <div className="knowledge-outcome-node missing">
                          <span>实际结果</span>
                          <p>复盘结果已不可用</p>
                        </div>
                      ) : (
                        <div className={`knowledge-outcome-node ${outcome.verdict}`}>
                          <div>
                            <span>实际结果</span>
                            <em>{verdictLabels[outcome.verdict]}</em>
                          </div>
                          <p>{outcome.summary}</p>
                          {outcome.lesson === null ? null : (
                            <small>{outcome.lesson}</small>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
            </li>
          );
        })}
      </ol>
      )}
    </section>
  );
};
