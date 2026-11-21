import type { SourceRole, SuggestionType } from "@cognelis/decision-protocol";
import { canonical } from "@cognelis/decision-storage";
import { createHash } from "node:crypto";

/**
 * 整理与记忆的确定性部分（IMP-191）：指纹、建议身份与承接、拒绝后是否重开、独立证据、待办的确定性提示、预算。
 * 不读文件、不调模型，所以都能直接测。
 */

export const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
export const hashOf = (value: unknown): string => sha256(canonical(value));

/** 一条来源在一轮里的两种指纹、角色与血缘。 */
export interface SourceIdentity {
  key: string;
  /** 全部字段：只用于判断建议是否失效。 */
  fingerprint: string;
  /** 实质证据：只有它变了才算新证据（拒绝的建议据此才可能重开）。 */
  evidenceFingerprint: string;
  role: SourceRole;
  /** 血缘根；推不出时就是自己（lineage self）。 */
  rootKeys: string[];
  lineage: "self" | "traced";
}

/** 建议的身份：建卡后不变，证据怎么变都只增加 evidence.version。 */
export const suggestionId = (type: SuggestionType, project: string | null, anchor: readonly string[]): string =>
  `sug-${sha256(`${type}\n${project ?? ""}\n${[...anchor].sort().join("\n")}`).slice(0, 32)}`;

/** 一组输入的指纹：成员的完整指纹排序后的哈希，不含模型、提示词版本。 */
export const inputFingerprint = (members: ReadonlyArray<Pick<SourceIdentity, "key" | "fingerprint">>): string =>
  hashOf([...members].map((member) => [member.key, member.fingerprint]).sort(([left], [right]) => (left! < right! ? -1 : left! > right! ? 1 : 0)));

/**
 * 被拒绝的建议是否重开，以及为什么。只有三种情形：出现回执里没有的、不是派生的来源；某条来源的实质证据变了；
 * 用户主动重开（不经这里）。换模型、换提示词、改优先级或标签、历史被裁剪都不在其中。
 */
export const reopenReason = (
  rejected: Readonly<Record<string, string>>,
  now: ReadonlyArray<Pick<SourceIdentity, "key" | "evidenceFingerprint" | "role">>,
  labelOf: (key: string) => string,
): string | null => {
  const added = now.filter((source) => !(source.key in rejected) && source.role !== "derived");
  const changed = now.filter((source) => source.key in rejected && rejected[source.key] !== source.evidenceFingerprint);
  if (added.length === 0 && changed.length === 0) return null;
  return [
    added.length === 0 ? "" : `新增来源：${added.map((source) => labelOf(source.key)).join("、")}`,
    changed.length === 0 ? "" : `内容已改变：${changed.map((source) => labelOf(source.key)).join("、")}`,
  ].filter(Boolean).join("；");
};

/**
 * 带观察的独立根来源数：转述、摘要、候选（derived）与偏好、想法、决策本身（statement）都不计；同一个根只算一次。
 * 一条来源同时引用几个根，不说明它们是同一事件，不合并；只有另行证实的同根关系（mergedRoots）才合并，模型的说法只能合并、不能拆开。
 */
export const independentEvidence = (
  sources: ReadonlyArray<Pick<SourceIdentity, "role" | "rootKeys">>,
  mergedRoots: ReadonlyArray<readonly string[]> = [],
): number => {
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    let at = key;
    while (parent.has(at) && parent.get(at) !== at) at = parent.get(at)!;
    return at;
  };
  const union = (left: string, right: string) => {
    const [a, b] = [find(left), find(right)];
    if (a !== b) parent.set(b, a);
  };
  for (const source of sources) for (const root of source.rootKeys) if (!parent.has(root)) parent.set(root, root);
  // A source naming several roots cites them (an experience made from two findings); it does not make them one event.
  // Only a sameness shown otherwise (mergedRoots) joins two roots.
  for (const group of mergedRoots) for (const root of group.slice(1)) if (parent.has(root) && parent.has(group[0]!)) union(group[0]!, root);
  return new Set(sources.filter((source) => source.role === "observation").flatMap((source) => source.rootKeys.map(find))).size;
};

/**
 * 只说「已处理」「完成」之类、没有写做了什么或怎么验证的说明：不算结果报告，不交给模型提炼经验。
 * shortcut: 不足8字的有效结果也会跳过，出现真实漏记时用隔离样本校准。
 */
const VAGUE = /^(已?(处理|完成|解决|修复|做完|搞定|关闭|ok|done|fixed|完成了|处理了|解决了)[。.!！]*|ok|done|fixed|lgtm|已处理完毕)$/iu;
export const isVagueNote = (note: string | null): boolean => {
  if (note === null) return true;
  const text = note.normalize("NFKC").replace(/\s+/gu, "").trim();
  return text.length < 8 || VAGUE.test(text);
};

/** 待办需要重新判断：已逾期，或这么多天没有任何变化。只提示，不写任何东西。 */
export const UNTOUCHED_DAYS = 30;
export const recheckOf = (
  item: { status: string; due: string | null; lastChangedAt: string },
  today: string,
): { reason: "overdue" | "untouched"; days: number } | null => {
  if (item.status !== "open" && item.status !== "in_progress") return null;
  const day = (value: string) => Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)));
  if (item.due !== null && item.due < today) return { reason: "overdue", days: Math.round((day(today) - day(item.due)) / 86_400_000) };
  const idle = Math.floor((day(today) - day(item.lastChangedAt.slice(0, 10))) / 86_400_000);
  return idle >= UNTOUCHED_DAYS ? { reason: "untouched", days: idle } : null;
};

/**
 * 一轮的额度。token 是按字数保守估算的（每个字符记 1 个，中文实测约 0.82），不是硬上限；输出以 maxOutputTokens 约束，
 * 服务商不一定严格遵守，超出照实记账。失败与重试占同一份。
 */
export interface OrganizationBudget {
  changes: number;
  groups: number;
  groupSize: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
}
export const DEFAULT_BUDGET: OrganizationBudget = { changes: 50, groups: 5, groupSize: 10, calls: 8, inputTokens: 12_000, outputTokens: 3_000, ms: 120_000 };
/** 一次后台调用本机模型的提示词上限：读入阶段的取消要等这一批算完（实测 2.6k 字在负载 80 时 1.9–3.1 秒）。 */
export const ON_DEVICE_BACKGROUND_PROMPT_CHARS = 3_000;
const MIN_OUTPUT = 200;

export interface BudgetLedger {
  calls: number;
  failedCalls: number;
  retries: number;
  reportedInputTokens: number;
  reportedOutputTokens: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
}
export const emptyLedger = (): BudgetLedger => ({ calls: 0, failedCalls: 0, retries: 0, reportedInputTokens: 0, reportedOutputTokens: 0, estimatedInputTokens: 0, estimatedOutputTokens: 0 });

export const estimateTokens = (text: string): number => text.length;

/** 这次调用能不能发、输出最多给多少；null 是额度不够，不发。 */
export const allowance = (
  budget: OrganizationBudget,
  used: BudgetLedger,
  promptChars: number,
  typeMaxOutput: number,
  startedAt: number,
  now: number,
): { maxOutputTokens: number } | { stop: "calls" | "budget" | "time" } => {
  if (now - startedAt >= budget.ms) return { stop: "time" };
  if (used.calls >= budget.calls) return { stop: "calls" };
  const inputUsed = used.reportedInputTokens + used.estimatedInputTokens;
  const outputUsed = used.reportedOutputTokens + used.estimatedOutputTokens;
  if (inputUsed + promptChars > budget.inputTokens) return { stop: "budget" };
  const remaining = budget.outputTokens - outputUsed;
  if (remaining < MIN_OUTPUT) return { stop: "budget" };
  return { maxOutputTokens: Math.min(remaining, typeMaxOutput) };
};

/** 一次调用的用量记入：报告了的记报告值，没报告的按字数估算，分开放。 */
export const charge = (
  used: BudgetLedger,
  call: { ok: boolean; retry: boolean; promptChars: number; maxOutputTokens: number; usage?: { inputTokens?: number | undefined; outputTokens?: number | undefined } | undefined },
): BudgetLedger => {
  const input = call.usage?.inputTokens;
  const output = call.usage?.outputTokens;
  return {
    calls: used.calls + 1,
    failedCalls: used.failedCalls + (call.ok ? 0 : 1),
    retries: used.retries + (call.retry ? 1 : 0),
    reportedInputTokens: used.reportedInputTokens + (input ?? 0),
    reportedOutputTokens: used.reportedOutputTokens + (output ?? 0),
    estimatedInputTokens: used.estimatedInputTokens + (input === undefined ? call.promptChars : 0),
    // A call that failed without saying what it produced: counted at the most it was let produce.
    estimatedOutputTokens: used.estimatedOutputTokens + (output === undefined ? (call.ok ? 0 : call.maxOutputTokens) : 0),
  };
};

/** 一段原文的摘录：从原文里连续截取，不改写。 */
export const excerptOf = (text: string, maximum = 600): string => {
  const flat = text.trim();
  return flat.length <= maximum ? flat : `${flat.slice(0, maximum - 1)}…`;
};
