import { createHistoricalDecision, historicalChangeSummary, historicalDecisionLink, planHistoricalDecisionRecord, planHistoricalDecisionUpdate } from "@cognelis/decision-core/historical-decision";
import { HISTORICAL_DECISION_VERSION, type HistoricalDecision, type HistoricalDecisionEvent, type RecordHistoricalDecisionRequest } from "@cognelis/decision-protocol";

import type { DecisionApi } from "../shared/renderer-api.js";

type Written = Omit<RecordHistoricalDecisionRequest, "version" | "sourceClient"> & { id: string; client?: string; status?: HistoricalDecision["status"]; statusNote?: string; promotedDecisionId?: string };

const sample = ({ id, client, status, statusNote, promotedDecisionId, ...written }: Written): HistoricalDecision => ({
  ...createHistoricalDecision({ ...written, sourceClient: client ?? null }, id, new Date(`${written.decidedOn}T10:00:00.000Z`)),
  status: status ?? "active",
  statusNote: statusNote ?? null,
  promotedDecisionId: promotedDecisionId ?? null,
});

/**
 * Every form a record takes on the page: each status, one that replaced another and the one it replaced, one made
 * into a decision record, one with every optional field and one with none, each reversibility, and a second project.
 */
const samples = (): HistoricalDecision[] => [
  sample({ id: "hdec-preview-update", title: "桌面端更新包走哪种分发方式？", decision: "沿用 zip 手动替换，暂不接自动更新", decidedOn: "2026-11-18", project: "decision", scope: "桌面端 · 发版流程", participants: ["个人"], reversibility: "easy", tags: ["发布"] }),
  sample({
    id: "hdec-preview-nav", client: "claude-code", title: "首页待办入口放在哪一层？", decision: "放进主导航第六项，首页只留计数", decidedOn: "2026-11-12", project: "decision", scope: "桌面端导航",
    participants: ["个人"], reversibility: "easy", tags: ["信息架构", "导航"], options: ["放在首页卡片区第二屏", "只做全局快捷键，不放入口"],
    context: "待办刚上线两周；首页已有五张卡片，再加一张会把复盘收件箱挤到第二屏。", notes: "侧栏图标沿用待办页现有那一枚。", revisitCondition: "待办日活超过首页访问的一半时",
    references: [{ url: "https://example.com/pr/482", label: "PR 482 · 首页入口调整" }, { url: "https://example.com/rfc/navigation", label: "导航改版 RFC" }],
    relatedNotes: ["导航改版记录", "待办上线复盘"], supersedesId: "hdec-preview-nav-old",
  }),
  sample({ id: "hdec-preview-report", title: "周报用哪种模板？", decision: "改用「结论在前」三段式，旧的流水账模板停用", decidedOn: "2026-11-06", scope: "个人习惯", participants: ["个人"], tags: ["写作"] }),
  sample({ id: "hdec-preview-limit", client: "codex", title: "本地模型输出上限定多少？", decision: "上限 2048 token，超出走规则回退", decidedOn: "2026-10-29", project: "local-tools", scope: "语义识别", participants: ["个人", "Codex"], reversibility: "costly", promotedDecisionId: "recent-2" }),
  sample({ id: "hdec-preview-vectors", title: "向量索引放在哪里？", decision: "放本机 SQLite，不上云", decidedOn: "2026-10-21", project: "decision", scope: "存储层", participants: ["个人"], sourceKind: "meeting", reversibility: "irreversible", tags: ["存储"] }),
  sample({ id: "hdec-preview-nav-old", title: "首页待办入口放在哪一层？", decision: "放在首页卡片区第二屏", decidedOn: "2026-09-30", project: "decision", scope: "桌面端导航", participants: ["个人"], reversibility: "easy", tags: ["信息架构"], status: "superseded", statusNote: "11-12 改为放进主导航，见后任决定。" }),
  sample({ id: "hdec-preview-review", title: "评审意见先发草稿还是直接发布？", decision: "试行两周「先草稿」，到 10 月中旬为止", decidedOn: "2026-09-22", project: "sample/app", scope: "评审流程", participants: ["前端组"], sourceKind: "offline_conversation", tags: ["评审"], status: "ended" }),
  sample({ id: "hdec-preview-signing", title: "团队仓库是否开启强制签名提交？", decision: "开启，对全部分支生效", decidedOn: "2026-09-15", project: "sample/app", scope: "全部分支", participants: ["前端组", "平台组"], sourceKind: "pr_comment", tags: ["仓库"], status: "withdrawn", statusNote: "记录有误，实际没有开启强制签名。" }),
  sample({ id: "hdec-preview-tone", title: "错误提示统一用哪种语气？", decision: "陈述事实加下一步，不用感叹号", decidedOn: "2026-09-08", project: "decision", scope: "桌面端文案", participants: ["个人"], tags: ["文案"] }),
  sample({ id: "hdec-preview-bare", title: "团建去哪？", decision: "去海边", decidedOn: "2026-08-30" }),
];

const fold = (text: string): string => text.normalize("NFKC").toLowerCase();

export type HistoricalDecisionPreviewState = "empty" | "unreadable" | "index";

/**
 * The 历史决定 page's calls, answered from records held in memory and changed by the same rules the App applies
 * (planHistoricalDecisionRecord / Update). `state` shows a list with no record, with notes it could not read, or
 * with its index out of reach.
 */
export function createHistoricalDecisionPreview(state: HistoricalDecisionPreviewState | null = null): Pick<DecisionApi, "listHistoricalDecisions" | "getHistoricalDecision" | "recordHistoricalDecision" | "updateHistoricalDecision" | "rebuildHistoricalDecisionIndex" | "openHistoricalDecision"> {
  let records = state === "empty" ? [] : samples();
  let indexDown = state === "index";
  let created = 0;
  // Two records arrive with a past: one changed since it was recorded, one withdrawn. The rest were written in Obsidian.
  const history = new Map<string, HistoricalDecisionEvent[]>(state === "empty" ? [] : [
    ["hdec-preview-nav", [
      { at: "2026-11-20T08:05:00.000Z", actor: "codex", kind: "updated", summary: "修改：备选方案、当时背景", changes: [
        { field: "备选方案", before: "放在首页卡片区第二屏", after: "放在首页卡片区第二屏、只做全局快捷键，不放入口" },
        { field: "当时背景", before: "", after: "待办刚上线两周；首页已有五张卡片，再加一张会把复盘收件箱挤到第二屏。" },
      ] },
      { at: "2026-11-12T01:31:00.000Z", actor: "app", kind: "updated", summary: "修改：最终决定", changes: [{ field: "最终决定", before: "放进主导航第五项", after: "放进主导航第六项，首页只留计数" }] },
      { at: "2026-11-12T01:30:00.000Z", actor: "claude-code", kind: "created", summary: "记录" },
    ]],
    ["hdec-preview-signing", [
      { at: "2026-11-20T06:12:00.000Z", actor: "app", kind: "status", summary: "状态：有效 → 已撤回", changes: [{ field: "状态说明", before: "", after: "记录有误，实际没有开启强制签名。" }] },
      { at: "2026-09-15T02:00:00.000Z", actor: "app", kind: "created", summary: "记录" },
    ]],
  ]);
  const remember = (id: string, kind: HistoricalDecisionEvent["kind"], summary: string, changes: HistoricalDecisionEvent["changes"] = []): void => {
    history.set(id, [{ at: new Date().toISOString(), actor: "app", kind, summary, ...(changes.length === 0 ? {} : { changes }) }, ...(history.get(id) ?? [])]);
  };
  const put = (record: HistoricalDecision): void => {
    records = records.some((kept) => kept.id === record.id) ? records.map((kept) => (kept.id === record.id ? record : kept)) : [record, ...records];
  };
  const indexState = () => ({ state: "ready" as const, message: null, indexed: records.length, found: records.length, syncedAt: "2026-11-21T01:40:00.000Z" });
  return {
    listHistoricalDecisions: async (query) => {
      const diagnostics = state === "unreadable"
        ? [{ path: "Decision Journal/history/2026/2026-10-08-缓存失效策略-a3f9c2d1.md", message: "属性区无法解析" }, { path: "Decision Journal/history/2026/2026-09-02-日志保留期-77c1e0aa.md", message: "缺少 id" }]
        : [];
      if (indexDown) {
        return { version: HISTORICAL_DECISION_VERSION, records: [], total: 0, kept: records.length, projects: [], tags: [], diagnostics, index: { state: "unavailable", message: "database disk image is malformed", indexed: null, found: records.length, syncedAt: null } };
      }
      const words = fold(query.query ?? "").split(/\s+/u).filter((word) => word.length > 0);
      const matched = records
        .filter((record) =>
          (query.status === undefined ? query.includeWithdrawn === true || record.status !== "withdrawn" : record.status === query.status) &&
          (query.project === undefined || record.project === query.project) &&
          (query.reversibility === undefined || record.reversibility === query.reversibility) &&
          (query.tag === undefined || record.tags.includes(query.tag)) &&
          (query.fromDate === undefined || record.decidedOn >= query.fromDate) &&
          (query.toDate === undefined || record.decidedOn <= query.toDate) &&
          (query.promotedDecisionId === undefined || record.promotedDecisionId === query.promotedDecisionId) &&
          words.every((word) => fold([record.title, record.decision, record.context, record.notes, record.project, record.scope, ...record.options, ...record.tags].join("\n")).includes(word)))
        .sort((left, right) => right.decidedOn.localeCompare(left.decidedOn) || right.id.localeCompare(left.id));
      const offset = query.offset ?? 0;
      return {
        version: HISTORICAL_DECISION_VERSION,
        records: matched.slice(offset, offset + (query.limit ?? 100)),
        total: matched.length,
        kept: records.length,
        projects: [...new Set(records.flatMap((record) => (record.project === null ? [] : [record.project])))].sort(),
        tags: [...new Set(records.flatMap((record) => record.tags))].sort(),
        diagnostics,
        index: indexState(),
      };
    },
    getHistoricalDecision: async (id) => {
      const record = records.find((kept) => kept.id === id);
      if (record === undefined) throw new Error("这条历史决定在 Obsidian 里已经找不到了（可能已被删除、移走或改坏），列表已重新读取。");
      const predecessor = records.find((kept) => kept.id === record.supersedesId);
      return {
        version: HISTORICAL_DECISION_VERSION,
        record,
        predecessor: predecessor === undefined ? null : historicalDecisionLink(predecessor),
        successors: records.filter((kept) => kept.supersedesId === id).map(historicalDecisionLink),
        notePath: `Decision Journal/history/${record.decidedOn.slice(0, 4)}/${record.decidedOn}-${record.id}.md`,
        history: history.get(id) ?? [],
      };
    },
    recordHistoricalDecision: async (input) => {
      created += 1;
      const plan = planHistoricalDecisionRecord(records, { ...input, sourceClient: null }, `hdec-preview-new-${created}`, new Date());
      if (plan.status === "created") {
        put(plan.record);
        remember(plan.record.id, "created", "记录");
      }
      if (plan.superseded !== null) put(plan.superseded);
      return { version: HISTORICAL_DECISION_VERSION, status: plan.status, record: plan.record, supersededId: plan.superseded?.id ?? null };
    },
    updateHistoricalDecision: async (input) => {
      const now = new Date();
      const plan = planHistoricalDecisionUpdate(records, input, now, input.promote === true ? { promotedDecisionId: "recent-1" } : {});
      if (plan.changed.length === 0) return { version: HISTORICAL_DECISION_VERSION, record: plan.record, supersededId: null, releasedIds: [], promotedDecisionId: null };
      put(plan.record);
      remember(plan.record.id, input.promote === true ? "promoted" : plan.statusChanged ? "status" : "updated", historicalChangeSummary(plan.changed), plan.changes);
      if (plan.superseded !== null) put(plan.superseded);
      plan.released.forEach(put);
      return { version: HISTORICAL_DECISION_VERSION, record: plan.record, supersededId: plan.superseded?.id ?? null, releasedIds: plan.released.map((released) => released.id), promotedDecisionId: input.promote === true ? "recent-1" : null };
    },
    rebuildHistoricalDecisionIndex: async () => {
      indexDown = false;
      return { version: HISTORICAL_DECISION_VERSION, index: indexState() };
    },
    openHistoricalDecision: async ({ id, link, relatedNote }) => ({
      version: HISTORICAL_DECISION_VERSION, opened: link !== undefined ? "link" : relatedNote !== undefined ? "relatedNote" : "note", target: link ?? relatedNote ?? id,
    }),
  };
}
