import {
  DECISION_SCOPE_REJECTIONS,
  decisionScopeSchema,
  type DecisionScope,
  type DecisionTaskScope,
  type DecisionApplicability,
} from "@cognelis/decision-protocol";

const equal = (left: string, right: string) => left.normalize("NFKC").toLowerCase() === right.normalize("NFKC").toLowerCase();
const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/** Match explicit dimensions only. Textual conditions and exceptions always remain reviewable. */
export const assessDecisionApplicability = (
  recorded: { project: string | null; scope?: DecisionScope | null; appliesWhen: string | null; scopeState?: string },
  task: DecisionTaskScope | undefined,
  project?: string,
): DecisionApplicability => {
  const scope = recorded.scope ?? decisionScopeSchema.parse({});
  const reasons: string[] = [];
  let excluded = false;
  let uncertain = false;
  let checked = 0;
  const reject = (reason: string) => { excluded = true; reasons.push(reason); };
  const review = (reason: string) => { uncertain = true; reasons.push(reason); };
  const targetProject = project ?? task?.repository?.project;
  const projects = scope.projects.length > 0 ? scope.projects : scope.repositoryIds.length > 0 || recorded.project === null ? [] : [recorded.project];
  if (recorded.scopeState === "stale" || recorded.scopeState === "unavailable") {
    return { status: "needs_review", scope, reasons: [recorded.scopeState === "stale"
      ? "原笔记已变化，之前确认的范围需要重新核对；旧范围不参与自动排除。"
      : "范围元数据未成功读取，不能根据残缺范围判断适用性。"] };
  }

  if (scope.repositoryIds.length > 0) {
    if (task?.repository === undefined) review("记录限定了仓库身份，本次没有提供可确认的仓库。");
    else {
      checked += 1;
      if (!scope.repositoryIds.includes(task.repository.id)) reject(DECISION_SCOPE_REJECTIONS.repository);
      else reasons.push("仓库身份与明确记录的范围一致。");
    }
  }
  if (targetProject !== undefined && (scope.repositoryIds.length === 0 || scope.projects.length > 0 || project !== undefined)) {
    if (projects.length === 0) review("记录没有明确项目范围，不能视为跨项目通用。");
    else {
      checked += 1;
      if (!projects.some((name) => equal(name, targetProject))) reject(DECISION_SCOPE_REJECTIONS.project);
      else reasons.push("项目与记录范围一致。");
    }
  } else if (projects.length > 0) review("尚未提供当前项目，记录的项目范围仍需核对。");

  if (scope.layers.length > 0) {
    if (task?.layer === undefined) review("记录限定了技术层次，本次未明确技术层次。");
    else {
      checked += 1;
      if (!scope.layers.includes(task.layer)) reject(DECISION_SCOPE_REJECTIONS.layer);
      else reasons.push("技术层次与明确记录的范围一致。");
    }
  } else if (task?.layer !== undefined) review("记录没有明确技术层次；不能仅凭项目名或关键词套用前后端规则。");

  const module = task?.module;
  if (scope.modules.length > 0) {
    if (module === undefined) review("记录限定了模块，本次未指定模块。");
    else {
      checked += 1;
      if (scope.modules.some((prefix) => under(module, prefix))) reasons.push("模块与明确记录的范围一致。");
      // The task names a module above the recorded one: it may well be working inside it, and hidden as out of
      // scope, the record was missing just where it applied.
      else if (scope.modules.some((prefix) => under(prefix, module))) {
        if ((task?.files ?? []).some((file) => scope.modules.some((prefix) => under(file, prefix)))) reasons.push("本次文件位于记录明确限定的模块内。");
        else review("当前模块包含记录限定的模块，请核对本次改动是否涉及它。");
      } else reject(DECISION_SCOPE_REJECTIONS.module);
    }
  } else if (module !== undefined) review("记录未明确模块范围，仍需回查原文。");

  if (scope.paths.length > 0 || scope.excludedPaths.length > 0) {
    const files = task?.files ?? [];
    if (files.length === 0) review("记录有路径范围或路径例外，本次未提供文件列表。");
    else {
      checked += 1;
      const included = files.filter((file) => (scope.paths.length === 0 || scope.paths.some((prefix) => under(file, prefix))) &&
        !scope.excludedPaths.some((prefix) => under(file, prefix)));
      if (included.length === 0) reject(DECISION_SCOPE_REJECTIONS.paths);
      else if (included.length < files.length) review("只有部分文件在适用范围内；请按文件分别判断，不扩大为整个改动的要求。");
      else reasons.push("本次文件均在明确路径范围内，且未命中排除路径。");
    }
  }

  if (scope.exceptions.length > 0) review("记录存在文字例外，需要结合本次任务逐项核对，系统没有自动判定例外成立与否。");
  if (recorded.appliesWhen !== null) review("文字适用条件仍需结合当前事实判断，字段匹配不等于条件已经成立。");
  if (recorded.scope == null || checked === 0) review("缺少完整的结构化适用范围，本次只能提供历史参考。");
  return { status: excluded ? "out_of_scope" : uncertain ? "needs_review" : "scope_match", reasons, scope };
};
