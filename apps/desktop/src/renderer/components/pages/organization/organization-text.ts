import { isCalendarDate } from "@cognelis/decision-protocol";
import type { OrganizationRunState, OrganizationRunView, OrganizationUsage, SuggestionState, SuggestionType, SuggestionView } from "@cognelis/decision-protocol";

export type OrganizationTab = "overview" | "todo" | "memory" | "conflict";

export const TAB_LABEL: Record<OrganizationTab, string> = { overview: "总览", todo: "待处理", memory: "记忆", conflict: "需要你判断" };
export const TAB_ORDER: readonly OrganizationTab[] = ["overview", "todo", "memory", "conflict"];

export const TYPE_LABEL: Record<SuggestionType, string> = {
  todo_group: "相似事项归组",
  todo_context: "补充执行上下文",
  todo_acceptance: "缺验收条件",
  todo_recheck: "需要重新判断",
  experience: "记忆",
  conflict: "历史冲突",
  triage: "自动分诊",
  judgment: "需要你判断",
};

export const STATE_LABEL: Record<SuggestionState, string> = {
  pending: "待审阅",
  deferred: "已稍后",
  rejected: "已不采纳",
  applying: "正在应用",
  applied: "已采纳",
  partially_applied: "部分写入",
  undone: "已撤销",
  merged: "已并入其它建议",
  invalid: "来源已删除",
};

export const OUTCOME_LABEL = { effective: "有效", partial: "部分有效", failed: "失败", mixed: "混合结果", unknown: "结果未知" } as const;

export const RUN_LABEL: Record<OrganizationRunState, string> = {
  waiting_idle: "等待空闲",
  running: "整理中",
  paused: "已暂停",
  partial: "本轮部分完成",
  no_change: "没有新增建议",
  done: "已完成",
  failed: "失败",
  stopped: "已停止",
  interrupted: "被打断",
};

export const PARTIAL_REASON: Record<NonNullable<OrganizationRunView["partialReason"]>, string> = {
  budget: "本轮用量额度已用完",
  time: "本轮时长额度已用完",
  calls: "本轮调用次数已用完",
  coverage: "有些来源没能完整读取",
  foreground: "前台有操作，后台整理先让行",
};

export const ACTIVE_STATES: readonly OrganizationRunState[] = ["waiting_idle", "running", "paused"];

/** 「11 月 12 日」；读不出来的日期原样给回，不编造。 */
export const shortDate = (value: string | null): string => {
  if (value === null) return "";
  if (!/^\d{4}-\d{2}-\d{2}(?:T|$)/u.test(value) || !isCalendarDate(value.slice(0, 10))) return value;
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/u.test(value) ? `${value}T00:00:00` : value);
  return Number.isNaN(parsed.getTime()) ? value : `${parsed.getMonth() + 1} 月 ${parsed.getDate()} 日`;
};

export const localDayOf = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** 稍后的几个预设日：明天、下周一，另外可以选日期。 */
export const deferPresets = (now: Date): { label: string; day: string }[] => {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (((8 - now.getDay()) % 7) || 7));
  return [{ label: "明天", day: localDayOf(tomorrow) }, { label: "下周一", day: localDayOf(monday) }];
};

export const formatTokens = (value: number): string => (value >= 10_000 ? `${Math.round(value / 1_000)}k` : value.toLocaleString("zh-CN"));

/** 报告的用量和估算的用量分开写，估算标「约」，不相加冒充真实值。 */
export const usageText = (usage: OrganizationUsage): string => {
  const reported = usage.reportedInputTokens + usage.reportedOutputTokens;
  const estimated = usage.estimatedInputTokens + usage.estimatedOutputTokens;
  const parts = [`服务商报告 ${formatTokens(reported)} tokens`];
  if (estimated > 0) parts.push(`另有未报告用量的调用，约 ${formatTokens(estimated)} tokens（估算）`);
  return parts.join("；");
};

export const runSummary = (run: OrganizationRunView | null): string => {
  if (run === null) return "还没有整理过";
  const when = shortDate(run.endedAt ?? run.startedAt);
  const how = run.trigger === "manual" ? "手动" : run.trigger === "background" ? "后台" : "重新整理";
  return `最近运行 ${when} · ${how} · ${RUN_LABEL[run.state]}${run.created > 0 ? `，本轮新增 ${run.created} 条` : ""}`;
};

/** 来源标签的文字：谁的内容、是否独立核验。不靠颜色表达。 */
export const verificationText = (view: SuggestionView): { reporter: string; verification: string; adoption: string; source: string } => {
  const { reporter, verification } = view.attribution;
  return {
    reporter: reporter === "agent" ? "Agent 报告" : reporter === "user" ? "你自己写的" : "未标明",
    verification: verification === "agent_reported_unverified" ? "未独立核验" : verification === "machine_synthesis" ? "机器归纳，未独立核验" : verification === "user_reported" ? "你的报告，不是独立核验" : "未标明",
    adoption: view.state === "applied" ? (view.automatic ? "已自动更新，可检索" : "已保存") : view.state === "partially_applied" ? "部分写入，未生效" : "机器整理",
    source: view.stale === null ? "未发现来源变更" : STALE_TEXT[view.stale.reason],
  };
};

export const STALE_TEXT = {
  source_changed: "来源已更新",
  source_gone: "来源已删除",
  source_unreadable: "来源这次没能读取（不是删除）",
  dependency_changed_during_apply: "应用期间来源有变化",
} as const;

export const SOURCE_KIND_LABEL = { todo_item: "事项", decision: "决策", summary: "历史沉淀", preference: "偏好", idea: "想法", experience: "经验", pending_confirmation: "待确认", pending_rationale: "待补理由", review: "需复盘", principle: "原则" } as const;

export const ROLE_LABEL = { observation: "观察", statement: "陈述", derived: "转述 / 摘要" } as const;

export const runResultText = (status: "started" | "busy" | "damaged" | "model_unavailable" | "nothing_to_do" | "out_of_scope"): string => ({
  started: "已开始。",
  busy: "已经有一轮在进行，等它结束或先停止。",
  damaged: "整理记录读不出来，已停止写入。",
  model_unavailable: "选定的模型现在不可用，没有改用别的后端。",
  nothing_to_do: "没有可整理的内容。",
  out_of_scope: "所选清单或事项不属于这个项目（或已经不在了），没有扩大范围去整理。",
})[status];
