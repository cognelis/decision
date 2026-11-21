import {
  ORGANIZATION_VERSION,
  SUGGESTION_TAB,
  type HandledSuggestionView,
  type OrganizationRunView,
  type OrganizationSnapshot,
  type OrganizationSettings,
  type SuggestionDecisionResult,
  type SuggestionSourceView,
  type SuggestionView,
} from "@cognelis/decision-protocol";

import type { DecisionApi } from "../shared/renderer-api.js";

/**
 * 整理与记忆的浏览器预览（IMP-191）：五张已确认画板里的状态，合成数据。动作在内存里真的改变状态，计数与按钮跟着变，
 * 不连 App；`?interaction=organization-<state>` 选一种运行状态（waiting_idle / running / partial / no_change / failed）。
 */

type OrganizationPreviewApi = Pick<DecisionApi,
  "getOrganization" | "runOrganization" | "controlOrganizationRun" | "decideSuggestion" | "adoptSuggestions" | "saveSuggestionDraft" |
  "undoSuggestion" | "regenerateSuggestion" | "setOrganizationSettings" | "previewOrganizationForget" | "forgetOrganizationSource" | "getTodoAnnotations">;

const PROJECT = "消息服务（示例）";
const NOW = "2026-11-11T02:20:00.000Z";

const source = (key: string, label: string, excerpt: string | null, extra: Partial<SuggestionSourceView> = {}): SuggestionSourceView => ({
  key, kind: key.slice(0, key.indexOf(":")) as SuggestionSourceView["kind"], role: "observation", label, status: "current", excerpt,
  currentText: null, relativePath: null, itemStatus: null, priority: null, project: PROJECT, at: null, ...extra,
});

const base = (fields: Partial<SuggestionView> & Pick<SuggestionView, "id" | "type" | "title" | "why" | "effect" | "unchanged" | "content">): SuggestionView => ({
  tab: SUGGESTION_TAB[fields.type], revision: 1, evidenceVersion: 1, project: PROJECT, state: "pending", stale: null, deferUntil: null, reopenReason: null,
  sources: [], counter: [], draft: null, attribution: { reporter: null, verification: null, generated: { model: "示例模型" } }, independentEvidence: 0,
  canAdopt: true, blockedReason: null, choices: [], canUndo: false, applied: [], steps: [], redacted: false, createdAt: NOW, updatedAt: NOW,
  ...fields,
});

const fixtures = (): SuggestionView[] => [
  base({
    id: "preview-org-group", type: "todo_group", title: "3 条事项都在说「消息重复发送」",
    why: "7 天内分在 3 个清单里先后出现，容易重复调研。", effect: "仅在阅读时放进一个主题组，事项本身不变。",
    unchanged: "3 条事项的状态、编号 #12 #4 #27、优先级、期限、所属清单与处理记录。",
    sources: [
      source("todo_item:preview-msg#12", "清单「消息服务缺陷」#12", "弱网重试后同一条消息出现两次", { itemStatus: "in_progress", priority: "p1" }),
      source("todo_item:preview-research#4", "清单「客户端调研」#4", "比较客户端幂等键与服务端去重", { itemStatus: "open" }),
      source("todo_item:preview-release#27", "清单「发布检查」#27", "按回归用例跑一遍", { itemStatus: "open", priority: "p2" }),
    ],
    content: { type: "todo_group", title: "消息重复发送", members: [
      { key: "todo_item:preview-msg#12", difference: "只覆盖客户端自动重试，是修复动作" },
      { key: "todo_item:preview-research#4", difference: "偏方案比较，不含实现，涉及服务端" },
      { key: "todo_item:preview-release#27", difference: "是验证动作，依赖前两条先有结论" },
    ] },
  }),
  base({
    id: "preview-org-context", type: "todo_context", title: "「升级客户端 SDK」开始前要看 2 条记录",
    why: "有相关决策与一条范围限制。", effect: "在事项详情加「开始前要看」引用，不改正文。", unchanged: "事项正文、处置备注与状态。",
    sources: [source("todo_item:preview-msg#15", "清单「消息服务缺陷」#15", "升级客户端 SDK 到 v2.3", { itemStatus: "open" })],
    content: { type: "todo_context", item: "todo_item:preview-msg#15", links: [
      { key: "decision:preview-dec-idem", title: "幂等键放在客户端", whyRelevant: "SDK 升级会改动重试路径", scopeNote: "只适用客户端自动重试" },
      { key: "preference:preview-pref-gw", title: "去重放在网关层", whyRelevant: "与 SDK 内去重方向相关", scopeNote: "需核对范围" },
    ] },
  }),
  base({
    id: "preview-org-acceptance", type: "todo_acceptance", title: "「优化推送体验」没有写完成标准",
    why: "只有方向，没有可检查的结果。", effect: "给出改写草稿，你确认后才改原事项的补充说明。", unchanged: "标题、状态、优先级与处置备注。",
    sources: [source("todo_item:preview-msg#18", "清单「消息服务缺陷」#18", "优化推送体验", { itemStatus: "open" })],
    content: { type: "todo_acceptance", item: "todo_item:preview-msg#18", missing: "可检查的完成标准", currentDetail: null, draftDetail: "完成标准：冷启动后 3 秒内收到推送；弱网下不重复提示。" },
  }),
  base({
    id: "preview-org-recheck", type: "todo_recheck", title: "「清理旧回调」逾期 9 天",
    why: "清单里有相似事项已完成，但这不能证明本项完成。", effect: "只提示重新判断，不自动延期、完成或放弃。", unchanged: "事项的一切内容。",
    attribution: { reporter: null, verification: null, generated: null },
    sources: [source("todo_item:preview-msg#9", "清单「消息服务缺陷」#9", "清理旧回调", { itemStatus: "open", priority: "p2" })],
    content: { type: "todo_recheck", item: "todo_item:preview-msg#9", reason: "overdue", days: 9, similarDone: "todo_item:preview-release#3" },
  }),
  base({
    id: "preview-org-exp", type: "experience", title: "修复重复发送后，在指定重试场景下验证",
    why: "事项 #12 完成时附了验证说明。", effect: "保存为执行经验，可在以后检索；不是原则，不证明因果。", unchanged: "事项、决策与偏好。",
    attribution: { reporter: "agent", verification: "agent_reported_unverified", generated: { model: "示例模型" } },
    sources: [
      source("todo_item:preview-msg#12", "清单「消息服务缺陷」#12 · 版本 3", "在测试环境用「断网 3 秒后恢复」脚本重试 50 次，未再出现重复消息。", { itemStatus: "done" }),
      { ...source("decision:preview-dec-idem", "决策「幂等键放在客户端」", "幂等键由客户端生成"), role: "statement" },
    ],
    independentEvidence: 1,
    content: { type: "experience", reporter: "agent", verification: "agent_reported_unverified", outcome: "effective", body: {
      title: "修复重复发送后，在指定重试场景下验证",
      scene: "项目：消息服务（示例）· 客户端 v2.3 · 问题：弱网下自动重试，同一条消息被发送两次。条件：仅「客户端自动重试」这条路径。",
      action: "在重试请求里带上客户端生成的幂等键（事项 #12，决策「幂等键放在客户端」）。",
      observation: "Agent 报告：在测试环境用「断网 3 秒后恢复」脚本重试 50 次，未再出现重复消息。未附原始日志。",
      inference: "对「客户端自动重试」这条路径，幂等键可以消除重复发送。",
      exceptions: "手动重发、多设备同步、服务端队列重投都没有验证。不能推广为「所有重复发送都已解决」。",
    } },
  }),
  base({
    id: "preview-org-exp-stale", type: "experience", title: "SDK 升级后回滚一次再重试",
    why: "事项 #19 完成时写了部分有效。", effect: "保存为执行经验。", unchanged: "事项、决策与偏好。",
    attribution: { reporter: "agent", verification: "agent_reported_unverified", generated: { model: "示例模型" } },
    stale: { reason: "source_changed", at: NOW, keys: ["todo_item:preview-msg#19"] },
    canAdopt: false, blockedReason: "来源已更新：需先重新核对来源，重新整理会生成新修订，不覆盖当前草稿。",
    sources: [source("todo_item:preview-msg#19", "清单「消息服务缺陷」#19", "重试 50 次，未再出现重复消息。", { status: "changed", currentText: "重试 50 次，其中 2 次仍出现重复消息，原因待查。", itemStatus: "done" })],
    draft: { type: "experience", body: { observation: "Agent 报告重试 50 次未再出现重复。我补充：仅在 Wi-Fi 切换场景下复现过。" } },
    independentEvidence: 1,
    content: { type: "experience", reporter: "agent", verification: "agent_reported_unverified", outcome: "mixed", body: {
      title: "SDK 升级后回滚一次再重试", scene: "SDK 升级后首次启动。", action: "回滚到上一版本后重试。",
      observation: "Agent 报告重试 50 次未再出现重复。", inference: "回滚可以暂时绕开问题。", exceptions: "未覆盖多设备。",
    } },
  }),
  base({
    id: "preview-org-conflict", type: "conflict", title: "重复消息的去重放在哪一层",
    why: "两条结论方向相反，但它们来自不同模块、不同触发场景，可能只是适用范围不同。", effect: "按你选的方式处理；不会按时间新旧自动选一条。",
    unchanged: "结论正文、时间、来源、状态；不标哪条胜出，不标「已被替代」。",
    attribution: { reporter: null, verification: null, generated: { model: "示例模型" } },
    sources: [
      { ...source("decision:preview-dec-idem", "决策记录 · 你做出的选择", "在客户端用幂等键去重"), role: "statement" },
      { ...source("preference:preview-pref-gw", "偏好记录 · 你明确说过", "在服务端按消息 ID 去重，客户端不处理"), role: "statement" },
    ],
    choices: ["keep_scopes", "hold"],
    content: { type: "conflict", topic: "重复消息的去重放在哪一层", sameScope: false,
      a: { key: "decision:preview-dec-idem", title: "在客户端用幂等键去重", project: "消息服务（示例）· 客户端模块", at: "2026-10-18", sourceLabel: "决策记录 · 你做出的选择", condition: "弱网自动重试，单设备", appliesWhen: null, scopeEditable: true },
      b: { key: "preference:preview-pref-gw", title: "在服务端按消息 ID 去重，客户端不处理", project: "消息服务（示例）· 网关模块", at: "2026-11-03", sourceLabel: "偏好记录 · 你明确说过", condition: "多端同步、队列重投", appliesWhen: null, scopeEditable: true },
      proposal: { a: "客户端模块 · 自动重试", b: "网关模块 · 多端同步与队列重投", relation: null } },
  }),
];

const handledFixtures = (): HandledSuggestionView[] => [
  { id: "preview-org-h1", type: "experience", tab: "memory", title: "清理旧回调后没有发现遗漏引用", state: "deferred", at: "2026-11-10T08:00:00.000Z", deferUntil: "2026-11-15", reopenReason: null, revision: 1, evidenceVersion: 1 },
  { id: "preview-org-h2", type: "experience", tab: "memory", title: "把重复发送归为网络问题", state: "rejected", at: "2026-11-08T08:00:00.000Z", deferUntil: null, reopenReason: null, revision: 1, evidenceVersion: 1 },
  { id: "preview-org-h3", type: "experience", tab: "memory", title: "把重复发送归为网络问题", state: "pending", at: "2026-11-12T08:00:00.000Z", deferUntil: null, reopenReason: "11 月 12 日新增 2 条验证记录，与之前不同。", revision: 2, evidenceVersion: 2 },
];

const usage = { calls: 0, failedCalls: 0, retries: 0, reportedInputTokens: 0, reportedOutputTokens: 0, estimatedInputTokens: 0, estimatedOutputTokens: 0 };
const run = (state: OrganizationRunView["state"]): OrganizationRunView => ({
  runId: `preview-run-${state}`, trigger: "manual", scope: "project", project: PROJECT, startedAt: NOW,
  endedAt: state === "running" || state === "waiting_idle" || state === "paused" ? null : NOW, state,
  stage: state === "running" ? "正在检查第 2/5 组相似记录" : null,
  progress: state === "partial" ? { checked: 32, total: 50, groupsDone: 5, groupsTotal: 5 } : state === "running" ? { checked: 18, total: 50, groupsDone: 1, groupsTotal: 5 }
    : state === "failed" ? { checked: 6, total: 50, groupsDone: 0, groupsTotal: 5 } : { checked: 12, total: 12, groupsDone: 0, groupsTotal: 0 },
  created: state === "partial" ? 4 : state === "failed" ? 1 : 0, updated: 0,
  partialReason: state === "partial" ? "budget" : null,
  failure: state === "failed" ? { code: "provider_unavailable", message: "模型暂不可用" } : null,
  usage: state === "no_change" ? usage : { ...usage, calls: 4, reportedInputTokens: 9_800, reportedOutputTokens: 1_900, estimatedInputTokens: state === "failed" ? 600 : 0 }, model: "示例云端模型",
});

export function createOrganizationPreview(interaction: string | null, onChange?: (state: { revision: number; pending: number }) => void): OrganizationPreviewApi {
  let suggestions: SuggestionView[] = fixtures().filter((view) => !["todo_acceptance", "todo_recheck", "conflict"].includes(view.type)).map((view) => ({ ...view, state: "applied" as const, automatic: true, canAdopt: false, canUndo: true }));
  suggestions.push(base({ id: "preview-org-triage", type: "triage", title: "日志保留 14 天", why: "没有找到用户理由。", effect: "标为未知，安静保留。", unchanged: "原始选择", state: "applied", automatic: true, canAdopt: false, canUndo: true, sources: [source("pending_rationale:logs", "待补理由", "日志保留 14 天")], content: { type: "triage", item: "pending_rationale:logs", disposition: "unknown", explanation: "保留未知，不要求逐条补理由。", links: [] } }));
  suggestions.push(base({ id: "preview-org-judgment", type: "judgment", title: "本周发布：按期交付，还是完成网络切换修复后再发？", why: "本周按期发布与本版修复的承诺冲突。", effect: "记录你的选择，未执行任务。", unchanged: "原始承诺", choices: ["option_a", "option_b", "hold"], sources: [source("decision:release", "本周发布承诺", "周五发布，且本版解决网络切换重复消息。", { role: "statement" })], content: { type: "judgment", question: "本周发布如何取舍？", impact: "当前无法同时履行两个承诺，尚无延期或缩减范围授权。", unknowns: "工程师估算需要 3 天，尚未核验；影响范围未知。", options: ["先完成已承诺的修复，再决定发布日期", "授权按期发布，将修复移到后续版本"], recommendation: "option_a", recommendationReason: "优先履行本版修复的已有承诺；排期仍待核实。" } }));
  let handled = handledFixtures();
  let revision = 1;
  let settings: OrganizationSettings = interaction === "organization-setup" ? { background: false, backgroundProfileId: null } : { automatic: true, background: true, backgroundProfileId: "p1" };
  const runState = /^organization-(waiting_idle|running|partial|no_change|failed)$/u.exec(interaction ?? "")?.[1] as OrganizationRunView["state"] | undefined;
  let last: OrganizationRunView | null = run("partial");
  let active: OrganizationRunView | null = runState === "running" || runState === "waiting_idle" ? run(runState) : null;
  if (runState !== undefined && active === null) last = run(runState);

  const visible = (view: SuggestionView) => view.state === "pending" || view.state === "applying" || view.state === "partially_applied";
  const snapshot = (): OrganizationSnapshot => {
    const shown = suggestions.filter((view) => visible(view) || (view.state === "applied" && view.canUndo));
    const counted = shown.filter((view) => view.type === "judgment" && (view.state === "pending" || view.state === "partially_applied"));
    const count = (tab: SuggestionView["tab"]) => counted.filter((view) => view.tab === tab).length;
    return {
      organizationVersion: ORGANIZATION_VERSION, revision, damaged: interaction === "organization-damaged" ? "整理记录读不出来，已停止写入以保护现有记录。" : null,
      counts: { todo: count("todo"), memory: count("memory"), conflict: count("conflict"), pending: counted.length },
      suggestions: shown, handled, run: last, activeRun: active, settings,
      projects: [PROJECT, "网关"], maintenance: { inputs: 38, automaticUpdates: 11, unknown: 6, waiting: 5 },
      usage7d: { runs: 5, calls: 21, failedCalls: 1, retries: 2, reportedInputTokens: 31_000, reportedOutputTokens: 7_000, estimatedInputTokens: 800, estimatedOutputTokens: 0 },
      coverage: { complete: true, unreadable: [] }, methodologyHint: null,
    };
  };
  function emit(): void { onChange?.({ revision, pending: snapshot().counts.pending }); }
  const answer = (id: string, status: SuggestionDecisionResult["status"], message: string | null = null): SuggestionDecisionResult =>
    ({ organizationVersion: ORGANIZATION_VERSION, id, status, message, suggestion: suggestions.find((view) => view.id === id) ?? null });
  const update = (id: string, change: (view: SuggestionView) => SuggestionView) => {
    suggestions = suggestions.map((view) => view.id === id ? change(view) : view);
    revision += 1; emit();
  };
  const decide: DecisionApi["decideSuggestion"] = async (input) => {
    const view = suggestions.find((item) => item.id === input.id);
    if (view === undefined) return answer(input.id, "not_found");
    if (view.revision !== input.expectedRevision || view.evidenceVersion !== input.expectedEvidenceVersion) return answer(input.id, "revision_conflict");
    if (input.action === "adopt") {
      if (!view.canAdopt) return answer(input.id, "stale", view.blockedReason);
      if (input.choice === "hold") {
        update(input.id, (item) => ({ ...item, state: "deferred" }));
        handled = [{ id: view.id, type: view.type, tab: view.tab, title: view.title, state: "deferred", at: new Date().toISOString(), deferUntil: null, reopenReason: null, revision: view.revision, evidenceVersion: view.evidenceVersion }, ...handled];
        return answer(input.id, "saved");
      }
      update(input.id, (item) => ({ ...item, state: "applied", canUndo: item.type !== "todo_recheck", canAdopt: false,
        applied: item.type === "experience" ? [{ kind: "experience", key: "experience:preview-exp-1", relativePath: "Decision Journal/experiences/2026/11/preview.md", ok: true }] : [] }));
    } else if (input.action === "defer") update(input.id, (item) => ({ ...item, state: "deferred", deferUntil: input.deferUntil ?? null }));
    else if (input.action === "reject") update(input.id, (item) => ({ ...item, state: "rejected" }));
    const after = suggestions.find((item) => item.id === input.id)!;
    if (after.state !== "pending") handled = [{ id: after.id, type: after.type, tab: after.tab, title: after.title, state: after.state, at: new Date().toISOString(), deferUntil: after.deferUntil, reopenReason: null, revision: after.revision, evidenceVersion: after.evidenceVersion }, ...handled.filter((item) => item.id !== after.id)];
    if (input.action === "reopen") {
      const closed = handled.find((item) => item.id === input.id);
      handled = handled.filter((item) => item.id !== input.id);
      if (closed !== undefined) update(input.id, (item) => ({ ...item, state: "pending", reopenReason: "你主动重新打开。" }));
    }
    return answer(input.id, "saved");
  };

  emit();
  return {
    getOrganization: async () => snapshot(),
    runOrganization: async () => {
      if (active !== null) return { status: "busy", run: active };
      active = run("running");
      revision += 1; emit();
      return { status: "started", run: active };
    },
    controlOrganizationRun: async ({ action }) => {
      const current = active ?? last ?? run("stopped");
      const next: OrganizationRunView = action === "pause" ? { ...current, state: "paused" } : action === "resume" ? { ...current, state: "running" } : { ...current, state: "stopped", endedAt: new Date().toISOString(), partialReason: null };
      if (action === "stop") { active = null; last = next; } else active = next;
      revision += 1; emit();
      return next;
    },
    decideSuggestion: decide,
    adoptSuggestions: async ({ items }) => ({ results: await Promise.all(items.map((item) => decide({ ...item, action: "adopt" }))) }),
    saveSuggestionDraft: async ({ id, expectedRevision, draft }) => {
      const view = suggestions.find((item) => item.id === id);
      if (view === undefined) return answer(id, "not_found");
      if (view.revision !== expectedRevision) return answer(id, "revision_conflict");
      update(id, (item) => ({ ...item, draft }));
      return answer(id, "saved");
    },
    undoSuggestion: async ({ id }) => {
      const view = suggestions.find((item) => item.id === id);
      if (view === undefined || !view.canUndo) return { organizationVersion: ORGANIZATION_VERSION, id, status: "not_allowed", message: null, diff: [], diffHash: null, suggestion: view ?? null };
      update(id, (item) => ({ ...item, state: "pending", canUndo: false, canAdopt: true, applied: [] }));
      handled = handled.filter((item) => item.id !== id);
      return { organizationVersion: ORGANIZATION_VERSION, id, status: "saved", message: null, diff: [], diffHash: null, suggestion: suggestions.find((item) => item.id === id) ?? null };
    },
    regenerateSuggestion: async () => {
      active = run("running");
      revision += 1; emit();
      return { status: "started", run: active };
    },
    setOrganizationSettings: async (input) => {
      settings = { ...input };
      revision += 1; emit();
      return settings;
    },
    previewOrganizationForget: async ({ key }) => ({ key, experiences: [], suggestions: suggestions.filter((view) => view.sources.some((item) => item.key === key)).length, annotations: 0, vectors: 0, modelCalls: 0, complete: true, previewHash: "b".repeat(64) }),
    forgetOrganizationSource: async () => ({ status: "done", failed: [] }),
    getTodoAnnotations: async () => ({
      groups: suggestions.filter((view) => view.type === "todo_group" && view.state === "applied" && view.content?.type === "todo_group")
        .map((view) => ({ suggestionId: view.id, revision: view.revision, title: view.content!.type === "todo_group" ? view.content!.title : view.title, members: view.content!.type === "todo_group" ? view.content!.members.map((member) => member.key) : [] })),
      beforeStart: Object.fromEntries(suggestions.filter((view) => view.type === "todo_context" && view.state === "applied" && view.content?.type === "todo_context")
        .map((view) => view.content!.type === "todo_context" ? [view.content!.item, view.content!.links.map((link) => ({ ...link, suggestionId: view.id, revision: view.revision }))] : ["", []])),
    }),
  };
}

/** The fixtures as data, for the schema test: every board's state parses as the App would answer it. */
export const organizationPreviewFixtures = { suggestions: fixtures, handled: handledFixtures, run };
