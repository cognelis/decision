import { zonedFormatter } from "../../../calendar-date.js";
import { PrPlatformActions } from "./PrPlatformActions.js";
import { PrDiffDialog, type DiffFocus } from "./PrDiffDialog.js";
import { PrReviewCommentDialog, findingCommentDraft } from "./PrReviewCommentDialog.js";
import { PrReviewScopeDialog, plannedGroups } from "./PrReviewScopeDialog.js";
import { PrReviewBatchCommentDialog } from "./PrReviewBatchCommentDialog.js";
import { PrDiscussionDialog, commentDraft } from "./PrDiscussionDialog.js";
import { ActiveRecordDialog, type ActiveRecordDraft } from "../decisions/ActiveRecordDialog.js";
import { ListWidthHandle } from "../../ListWidthHandle.js";
import { PR_REVIEW_BATCH_MAX_CALLS, clipText, otherProjectOf, prReviewLanes, prReviewUnitChars } from "@cognelis/decision-protocol";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { PrReviewFinding, PrReviewReport, PrReviewUsage, PrReviewSnapshot, RetrievalAnswerProvider, PrConnection, PrListItem } from "@cognelis/decision-protocol";
import type { DecisionApi } from "../../../../shared/renderer-api.js";
import { PLATFORM_LABELS } from "./PrConnectionsPanel.js";
import { dismissalsIn, dismissedIn, publishedIn, loadReviewHistory, saveReviewHistory, mergeReviewEvents, type Dismissal, type ReviewHistoryEntry } from "./review-history.js";
import { LENS, ReviewSteps, reviewSteps } from "./review-steps.js";
import { FENCE, renderMarkdown } from "../assistant/markdown.js";
import { ModalDialog, PageHidden } from "../../ModalDialog.js";
import { ActionIcon, IconButton } from "../../IconButton.js";
import { platformMessage } from "./platform-message.js";

type ReviewApi = Pick<DecisionApi, "listPrDiscussion" | "openPrLink" | "createProactiveRecord" | "getPrActionContext" | "performPrAction" | "publishPrGeneralComment" | "openPr" | "peekPrReview" | "prefetchPrReviews" | "publishPrReviewComment" | "reevaluatePrReviewFinding" | "openReviewRulesDirectory" | "listPrConnections" | "openSurface" | "listPullRequests" | "loadPrReview" | "loadPrReviewDiff" | "loadPrReviewFile" | "runPrReview" | "followUpPrReview" | "cancelPrReview" | "onPrReviewProgress" | "listAssistantModels" | "openVaultDocument" | "exportAssistantConversation">;
// The same wording as dates elsewhere in the app (2026年9月30日 09:05), whatever the system region is.
const fullTime = zonedFormatter({ year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const dayTime = zonedFormatter({ month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const clock = zonedFormatter({ hour: "2-digit", minute: "2-digit", second: "2-digit" });
/** A day of this year without the year; an older one with it. */
const listDay = (at: string) => new Date(at).toLocaleDateString("zh-CN", { ...(new Date(at).getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }), month: "short", day: "numeric" });
const STATUS: Record<PrReviewReport["status"], string> = { completed: "评审完成", incomplete: "部分完成", cancelled: "已停止", failed: "评审失败", stale: "PR 已更新" };
const VERDICT: Record<"keep" | "replace" | "drop", string> = { keep: "保留", replace: "取代", drop: "撤销（误报）" };
/**
 * code-meeseeks drives pr-agent with slash commands. Both work on a PR straight away, as a record
 * of their own, and inside a finished review, where they leave the review's findings alone.
 */
const COMMANDS: Record<string, string> = {
  "/describe": "按 PR 概览格式回答（对应 pr-agent 的 /describe）：1) 类型：缺陷修复、新功能、重构、文档、测试或其它；2) 一段摘要，说明这次变更做了什么、为什么；3) 逐文件说明表（文件 | 变更要点），文件多时按目录或模块合并，表格不超过 20 行；4) 评审者需要重点关注的地方。全文控制在 3000 字以内。只依据本次提交的 diff 与描述；已有评审报告时不重复其中的问题清单。",
  "/improve": "按代码建议格式回答（对应 pr-agent 的 /improve）：给出最多 6 条最有价值的具体改进，每条写明文件与行号、重要度（1–10）、一句话说明，并用 ```diff 代码块给出原代码（-）与改进后代码（+）。只针对本次变更；已有评审报告时不重复其中已列出的问题；没有值得改进的地方就直接说明。",
};
const COMMAND_LABELS: Record<string, string> = { "/describe": "PR 概览", "/improve": "改进建议" };
/** The three ways to start on a PR; the composer's one button runs the chosen one. */
const MODES = [
  { id: "review", title: "完整评审", body: "整个 PR 一起读（大 PR 按相关文件分组），找出新引入的问题并逐条核验，核对历史决策与团队评审规则，结果可转为 PR 评论。", action: "开始评审" },
  { id: "/describe", title: "PR 概览", body: "类型、摘要、逐文件说明表和评审关注点，先弄清这次改了什么。", action: "生成 PR 概览" },
  { id: "/improve", title: "改进建议", body: "附 diff 代码块的具体改进，逐条复核打分后按重要度列出，只针对本次变更。", action: "生成改进建议" },
] as const;
const withoutHistory = ({ history: _history, ...report }: PrReviewReport) => report;
/**
 * A review runs for minutes and the reader goes elsewhere meanwhile: when it ends and the window
 * is not in front, a system notification says so. In front, the page already shows it.
 */
const notifyAway = (title: string, body: string, onOpen: () => void) => {
  try {
    if (!document.hasFocus() && typeof Notification !== "undefined" && Notification.permission !== "denied") {
      // Clicking it goes to the result, wherever the window was left.
      new Notification(title, { body }).onclick = () => { window.focus(); onOpen(); };
    }
  } catch { /* Best effort: the result is on the page either way. */ }
};
/** How many findings of each priority, most serious first. */
const priorityCounts = (findings: PrReviewReport["findings"]) => {
  const counts = new Map<PrReviewFinding["priority"], number>();
  for (const finding of findings) counts.set(finding.priority, (counts.get(finding.priority) ?? 0) + 1);
  return [...counts].sort(([left], [right]) => left.localeCompare(right));
};
/** "3 个问题（P1 ×1 · P2 ×2）": how much a review found, and how serious, at a glance. */
const findingSummary = (findings: PrReviewReport["findings"]) => !findings.length ? "没有发现问题"
  : `${findings.length} 个问题（${priorityCounts(findings).map(([priority, count]) => `${priority} ×${count}`).join(" · ")}）`;
const count = (value: number) => value < 1_000 ? `${value}` : `${(value / 1_000).toFixed(1)}k`;
/** What the calls reported spending; a call that failed or reported nothing makes the total a floor, as in answers. */
const usageText = (usage: PrReviewUsage | undefined) => {
  if (!usage || usage.input + usage.output === 0) return "";
  const money = usage.cost ? ` ≈ ${usage.cost.currency}${usage.cost.amount.toFixed(usage.cost.amount < 1 ? 4 : 2)}` : "";
  return `${usage.unreportedCalls ? "至少 " : ""}${count(usage.input + usage.output)} tokens${money}`;
};
const usageLabel = (usage: PrReviewUsage | undefined) => usageText(usage) && `（${usageText(usage)}）`;
/** A finding as a decision to record: the practice it asks for, and the PR and line it came up on. */
const findingDraft = (finding: PrReviewFinding, snapshot: PrReviewSnapshot): ActiveRecordDraft => ({
  title: `${finding.title}：以后怎么处理？`.slice(0, 500),
  content: finding.body,
  project: snapshot.project,
  context: [`PR：${snapshot.title}（${snapshot.reference}）`, `位置：${finding.path}:${finding.line}（${finding.side === "new" ? "新版本" : "旧版本"}）`,
    `来源：AI 评审发现的问题（提交 ${snapshot.sourceCommit.slice(0, 12)}）`].join("\n"),
});
/**
 * How far a running review is, from its group events (the service writes "评审分组 3/12：path"; older ones "评审批次"): the
 * group at work, or, with several at once (a remote model), how many are done, and how many ended unfinished.
 */
const batchProgress = (events: ReviewHistoryEntry["events"]) => {
  const groups = events.flatMap(event => {
    const match = /^评审(?:分组|批次) (\d+)\/(\d+)/u.exec(event.message);
    return match ? [{ at: match[1]!, of: match[2]!, status: event.status }] : [];
  });
  const running = groups.filter(group => group.status === "running").length;
  if (running > 1) {
    const done = groups.filter(group => group.status === "done").length, unfinished = groups.length - running - done;
    return ` · 已完成 ${done}/${groups[0]!.of} 组${unfinished ? `，${unfinished} 组未评完` : ""}`;
  }
  const latest = groups.at(-1);
  return latest ? ` · ${latest.at}/${latest.of} 组` : "";
};
/** One finding to hand to a coding agent or a chat: what is wrong, and exactly which line of which commit. */
const findingMarkdown = (snapshot: PrReviewSnapshot, finding: PrReviewFinding, evidence: PrReviewReport["evidence"]) => {
  // The decisions it cites, by source and id, so an agent with the Decision tools can read them.
  const cited = finding.decisionIndexes.flatMap(number => evidence.filter(item => item.index === number).map(({ record }) => `- [${number}] ${record.source}/${record.id} ${record.title}`));
  return `${findingCommentDraft(finding)}\n\n位置：\`${finding.path}:${finding.line}\`（${finding.side === "new" ? "新版本" : "旧版本"}，${snapshot.reference} @ ${(finding.side === "new" ? snapshot.sourceCommit : snapshot.baseCommit ?? snapshot.destinationCommit).slice(0, 12)}）${cited.length ? `\n\n相关决策：\n${cited.join("\n")}` : ""}`;
};
/** The files picked for a PR that this snapshot can still review; none left means the whole PR. */
const scopedPaths = (scope: { reference: string; paths: string[] } | null, snapshot: PrReviewSnapshot) => {
  const paths = scope?.reference === snapshot.reference ? scope.paths.filter(path => snapshot.fileBatches?.[path]) : [];
  return paths.length ? paths : null;
};
/**
 * What moved since this PR's latest review, when that review was of other commits and kept digests:
 * files whose change differs, and files that review did not cover (left out, or not finished).
 * A target branch that moved alone counts: some platforms diff against it, not a fixed merge base.
 */
const changedSinceReview = (snapshot: PrReviewSnapshot, history: ReviewHistoryEntry[], connectionId: string | undefined) => {
  const last = history.find(item => item.kind === "review" && item.report && item.connectionId === connectionId && item.snapshot.reference === snapshot.reference);
  const before = last?.snapshot.fileDigests;
  if (!last?.report || !before || !snapshot.fileDigests
    || (last.snapshot.sourceCommit === snapshot.sourceCommit && last.snapshot.destinationCommit === snapshot.destinationCommit)) return null;
  const reviewed = new Set(last.report.reviewedFiles);
  const paths = Object.keys(snapshot.fileBatches ?? {}).filter(path => snapshot.fileDigests![path] !== before[path] || !reviewed.has(path));
  return { at: last.at, commit: last.snapshot.sourceCommit, paths };
};
/**
 * This PR's reviews before this one on the same connection, newest first. A stopped or failed one counts too: it
 * keeps the findings of the batches it finished, and speaks only for the files it finished.
 */
const olderReviews = (entry: ReviewHistoryEntry, history: ReviewHistoryEntry[]) =>
  history.slice(history.findIndex(item => item.id === entry.id) + 1).filter(item => item.kind === "review" && item.report
    && item.connectionId === entry.connectionId && item.snapshot.reference === entry.snapshot.reference);
/** A finding goes by its file and title, and by the title a re-evaluation replaced it with. */
const findingKeys = (finding: PrReviewFinding, replacement?: { title: string } | null) =>
  [finding.title, replacement?.title ?? finding.title].map(title => `${finding.path}\n${title}`);
const OPEN_SETTINGS_FAILED = "无法打开设置，请从侧边栏进入。";
/** A status with its standing P1s set off, so a PR that needs changes first stands out in a list. */
const markP1 = (status: string) => status.split(/(（\d+ 个 P1）)/u).map((part, index) => index % 2 ? <strong key={index} className="review-status-p1">{part}</strong> : part);
/** What a draft from here was saved as: the dialog lets it become a preference or an idea instead. */
const RECORD_KIND = { decision: "决策", preference: "偏好", idea: "想法" } as const;
const CARRIED_PLACE = { same: "文件没有改动，应当还在", gone: "文件已不在这次的变更里", changed: "文件有改动，尚未复核" } as const;
const CARRIED_CHECK = { keep: "仍然存在", replace: "仍然存在，位置或表述有变", drop: "已不存在" } as const;
/** List items as a read-ahead request: the list time lets an unchanged PR cost nothing. */
const prefetchItems = (items: readonly { reference: string; updatedAt?: string | undefined }[]) =>
  items.map(({ reference, updatedAt }) => ({ reference, ...(updatedAt ? { updatedAt } : {}) }));
/** The pipeline a preset command runs as, when the question is one. */
const commandOf = (question: string): "describe" | "improve" | undefined => {
  const command = question.trim().split(/\s+/u)[0]?.toLowerCase();
  return command === "/describe" ? "describe" : command === "/improve" ? "improve" : undefined;
};
const expandCommand = (question: string): string => {
  const [command = "", ...rest] = question.split(/\s+/u);
  const preset = COMMANDS[command.toLowerCase()];
  return preset === undefined ? question : [preset, rest.join(" ")].filter(Boolean).join("\n补充要求：").slice(0, 2_000);
};
/** What to look at now, and what already merged: a merged PR's discussion can still be recorded. */
const SCOPES = {
  "review-requested": { filters: ["review-requested"], merged: false, label: "待我评审" },
  created: { filters: ["created"], merged: false, label: "我创建的" },
  // What merged that I reviewed or wrote, in one list: one switch, where whose and which state were two.
  merged: { filters: ["review-requested", "created"], merged: true, label: "已合并" },
} as const;
type Scope = keyof typeof SCOPES;
type ListFilter = (typeof SCOPES)[Scope]["filters"][number];
/**
 * Files of the PR a review did not cover by design: those not picked, and lockfiles or generated output kept from the
 * model. Said in the summary's last sentence only, which the page no longer shows once each group's conclusion is
 * listed: the header's file count and the review's then disagreed with nothing to say why.
 */
const coverageNote = (snapshot: PrReviewSnapshot | undefined, report: PrReviewReport): string => {
  if (!snapshot) return "";
  const skipped = snapshot.skippedFiles?.length ?? 0;
  const unchosen = Math.max(0, snapshot.files.length - skipped - report.reviewedFiles.length - report.unreviewedFiles.length);
  const notes = [unchosen ? `${unchosen} 个文件未选入这次评审` : "", skipped ? `${skipped} 个锁定或生成文件未送模型` : ""].filter(Boolean);
  return notes.length ? `（另有 ${notes.join("，")}）` : "";
};
/** How large a change is at a glance: lines added and removed, and whether code changed without a test (pr-agent's "relevant tests"). */
const changeNote = (size: NonNullable<PrReviewSnapshot["changeSize"]>): string =>
  `+${size.added} −${size.removed}${size.testFiles ? ` · 含 ${size.testFiles} 个测试文件` : size.codeFiles ? " · 没有改测试" : ""}`;
const ruleNames = (rules: NonNullable<PrReviewSnapshot["rules"]>): string =>
  rules.map(rule => rule.source === "code-meeseeks" ? `${rule.id}（code-meeseeks）` : rule.id).join("、");

/** A finding's state after the review: re-evaluated and/or posted to the PR, here or by another review of these commits. */
const findingFollowUp = (index: number, entry?: Pick<ReviewHistoryEntry, "verdicts" | "published">, postedElsewhere: ReadonlySet<number> = new Set()): string => {
  const verdict = entry?.verdicts.find(item => item.finding === index);
  return [
    verdict ? `${verdict.by ? "评审者不采纳" : `复评：${VERDICT[verdict.verdict]}`} · ${verdict.reason}${verdict.replacement ? `\n替代评论：${verdict.replacement.title}\n${verdict.replacement.body}` : ""}` : "",
    entry?.published.some(item => item.finding === index) ? "已发布为 PR 评论" : postedElsewhere.has(index) ? "同一提交的另一次评审已发布为 PR 评论" : "",
  ].filter(Boolean).map(line => `\n\n${line}`).join("");
};

const reportTime = zonedFormatter({ year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
/**
 * As the handoff says it: a decision whose scope was checked and found not to apply is not one still to check. One kept
 * out only by the project it is filed under is named by that project, as a deep review reads those too.
 */
const applicabilityLabel = (record: PrReviewReport["evidence"][number]["record"]): string => {
  const elsewhere = otherProjectOf(record), status = record.applicability?.status;
  return elsewhere ? `其它项目（${elsewhere}）` : status === "scope_match" ? "结构化范围匹配" : status === "out_of_scope" ? "明确不适用" : "适用范围需核对";
};
/**
 * A step's detail with any code fence it left open closed: a model's raw output cut at its clip may end inside one,
 * and the rest of an exported report (the evidence, the closing note) rendered as code. Fences counted as the app's
 * own Markdown reads them, so the one added never opens a fence it would not have.
 */
const closedFences = (detail: string): string => (detail.split("\n").filter((line) => FENCE.test(line)).length % 2 ? `${detail}\n\`\`\`` : detail);
/** A step of the review as the page says it, not "2026-10-05T02:30:00.000Z · … · done"; one still running in a stopped review was cut off. */
const eventLine = (event: PrReviewReport["history"][number], running: boolean): string =>
  `${reportTime.format(new Date(event.at))} · ${event.message} · ${({ running: running ? "进行中" : "已中断", done: "已完成", error: "失败", cancelled: "已停止" })[event.status]}\n${closedFences(event.detail ?? "")}`;
/**
 * What the review concluded, as the page shows it: the overview and every group's conclusion in full. The summary they
 * were run into is cut at 4,000 characters, and an export of three groups lost the third and the count of what was
 * covered; that count is its last paragraph. A review saved before the conclusions were kept apart has its summary.
 */
const conclusionsMarkdown = (report: PrReviewReport): string => !report.conclusions?.length ? report.summary : [
  report.overview,
  ...(report.conclusions.length === 1 && !report.conclusions[0]!.lens ? [report.conclusions[0]!.text]
    : report.conclusions.map((item) => `### ${item.label}${item.lens ? `（${LENS[item.lens]}）` : ""}\n\n${item.text}`)),
  report.summary.split("\n\n").at(-1)?.startsWith("分 ") ? report.summary.split("\n\n").at(-1) : undefined,
].filter(Boolean).join("\n\n");

export function reviewMarkdown(snapshot: PrReviewSnapshot, report: PrReviewReport, entry?: Pick<ReviewHistoryEntry, "verdicts" | "published"> & { focus?: string }, postedElsewhere?: ReadonlySet<number>): string {
  return [`# PR 评审：${snapshot.title}`, snapshot.reference,
    `源提交：${snapshot.sourceCommit}\n目标提交：${snapshot.destinationCommit}${snapshot.baseCommit ? `\n分叉点：${snapshot.baseCommit}` : ""}\n评审规则：${snapshot.rules?.length ? ruleNames(snapshot.rules) : "无"}\n仓库规范：${snapshot.guides?.length ? snapshot.guides.join("、") : "无"}\n关注点：${entry?.focus || "未指定"}`,
    `状态：${STATUS[report.status]}\n\n${conclusionsMarkdown(report)}`,
    ...report.findings.map((finding, index) => `## ${finding.priority} ${finding.title}\n${finding.path}:${finding.line}（${finding.side === "new" ? "新版本" : "旧版本"}）\n\n${finding.body}\n\n决策证据：${finding.decisionIndexes.map((index) => `[${index}]`).join("、") || "无"}${findingFollowUp(index, entry, postedElsewhere)}`),
    ...(report.filtered?.length ? [`## 核验未通过的候选问题\n置信度低于 80，没有列入问题：\n${report.filtered.map(({ finding, score, reason }) => `- ${finding.priority} ${finding.title}（${finding.path}:${finding.line}）· 置信度 ${score} · ${reason}`).join("\n")}`] : []),
    `## 覆盖\n已完成评审：${report.reviewedFiles.join("、") || "无"}\n未完成评审：${report.unreviewedFiles.join("、") || "无"}\n已读取完整文本 diff：${report.readFiles.join("、") || "无"}\n未完整读取：${report.unreadFiles.join("、") || "无"}\n${report.groups ? `评审分组：${report.groups} 组\n` : ""}${report.depth === "deep" ? "评审方式：深度评审（每组两位审查者：缺陷；规则与决策）\n" : ""}模型调用：${report.steps} 次${usageLabel(report.usage)}\n\n${report.warnings.join("\n")}`,
    "## 评审过程", ...report.history.map((event) => eventLine(event, false)),
    "## 决策证据", ...report.evidence.map(({ index, record }) => `[${index}] ${record.source}/${record.id} ${record.title}\n来源：${record.sourceRef.relativePath}\n版本：${record.sourceRef.contentHash ?? "未知"}\n范围：${applicabilityLabel(record)}\n状态：${record.lifecycleState === "uncertain" ? "有效状态待核对" : record.current ? "未识别到替代" : "已替代或退役"}\n\n${record.summary}\n适用条件：${record.appliesWhen ?? "未记录"}\n注意：${record.caution ?? "无"}\n${record.warnings.join("\n")}`),
    "本报告由 AI 评审生成，未执行测试，未批准或合并 PR，也未更改决策记录；评论只在评审者确认后逐条发布。",
  ].join("\n\n");
}

function VerdictNote({ verdict, onWithdraw }: { verdict: ReviewHistoryEntry["verdicts"][number]; onWithdraw(): void }) {
  // The reviewer's own no reads as theirs, with what it does to later reviews and a way back.
  if (verdict.by) return <div className="review-finding-verdict" data-verdict={verdict.verdict} role="note" aria-label="不采纳">
    <p><strong>你不采纳</strong> · {verdict.reason}</p>
    <small>以后评审这个仓库时，会告诉模型不再提同类问题。<button type="button" className="review-note-link" onClick={onWithdraw}>撤回</button></small>
  </div>;
  return <div className="review-finding-verdict" data-verdict={verdict.verdict} role="note" aria-label="复评结论">
    <p><strong>复评：{VERDICT[verdict.verdict]}</strong> · {verdict.reason}</p>
    {verdict.replacement ? <div><strong>{verdict.replacement.title}</strong><p className="review-text">{verdict.replacement.body}</p></div> : null}
    <small>{verdict.model}</small>
  </div>;
}

export function PrReviewPanel({ api, hidden = false, onOpenDecision, onActivity, openRun }: { api: ReviewApi; hidden?: boolean; onOpenDecision?(id: string): void;
  /** For the sidebar while this page is elsewhere: a review running, or one that ended unseen. */
  onActivity?(activity: "running" | "done" | null): void;
  /** A record picked elsewhere (quick jump); each new object opens it again. */
  openRun?: { id: string } | null }) {
  const [connections, setConnections] = useState<PrConnection[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [scope, setScope] = useState<Scope>("review-requested");
  const merged = SCOPES[scope].merged;
  const [items, setItems] = useState<PrListItem[]>([]);
  // Where each list read goes on from: a platform's own cursor (Bitbucket's an offset), one per list the scope reads.
  const [cursors, setCursors] = useState<Partial<Record<ListFilter, number | null>>>({});
  const more = Object.values(cursors).some((cursor) => cursor != null);
  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState("");
  const [storedHistory] = useState(loadReviewHistory);
  const [history, setHistory] = useState(storedHistory.entries);
  const [selectedRun, setSelectedRun] = useState(storedHistory.entries[0]?.id ?? "");
  const [historyError, setHistoryError] = useState(storedHistory.error);
  const [deleteHistory, setDeleteHistory] = useState(false);
  const [commentFinding, setCommentFinding] = useState<number | null>(null);
  // The finding being turned down, and why so far; and the list of those turned down in the repository, open.
  // `opened`: the reason it began with; changed since, Escape no longer closes it with what was typed.
  const [dismissing, setDismissing] = useState<{ index: number; reason: string; opened: string } | null>(null);
  const [showDismissals, setShowDismissals] = useState(false);
  // The answer being posted to the PR as a whole, by its turn.
  const [commentTurn, setCommentTurn] = useState<string | null>(null);
  // The discussion stays chosen while a comment is being recorded, so saving returns to the list.
  const [discussion, setDiscussion] = useState<{ connectionId: string; pr: Pick<PrReviewSnapshot, "title" | "reference" | "project"> } | null>(null);
  const [recordDraft, setRecordDraft] = useState<ActiveRecordDraft | null>(null);
  const verdictFor = (index: number) => entry?.verdicts.find(item => item.finding === index);
  const [showDetails, setShowDetails] = useState(false);
  // Opened from a finding: the diff lands on its line.
  const [diffFocus, setDiffFocus] = useState<DiffFocus | null>(null);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [listView, setListView] = useState<"prs" | "history">("prs");
  const [search, setSearch] = useState("");
  const moreActions = useRef<HTMLDetailsElement>(null);
  const chatLog = useRef<HTMLOListElement>(null);
  const followLatest = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const entry = history.find(item => item.id === selectedRun);
  const events = entry?.events ?? [];
  const steps = reviewSteps(events);
  // What the review is doing now, or did last: the newest step shown, not a group's model call.
  const lastStep = steps.flatMap(item => "step" in item ? [item.step] : item.group.steps.length ? [item.group.steps.at(-1)!] : item.group.head ? [item.group.head] : []).at(-1)?.message;
  const report = entry?.report ?? null;
  // A review can be discussed once it has a report; a record asked straight away ("chat") from the start.
  const discussable = report !== null || entry?.kind === "chat";
  const reportSnapshot = entry?.snapshot;
  useLayoutEffect(() => { followLatest.current = true; setShowLatest(false); }, [selectedRun]);
  useLayoutEffect(() => {
    if (hidden) return;
    const log = chatLog.current;
    if (log && followLatest.current) log.scrollTop = log.scrollHeight;
  }, [events, report, entry?.turns, selectedRun, hidden]);
  // A running review changes the history on every progress event, and writing the whole history (megabytes once it
  // holds large reports) each time stalls the window; while one runs it is written at most once a second.
  const lastSave = useRef(0);
  // Typing a question changes the history on every key; it is written once the typing pauses, not key by key. Whatever
  // is still waiting is written when the window goes away.
  const typing = useRef(false);
  const unsaved = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (storedHistory.error || history === storedHistory.entries) return;
    const save = () => {
      unsaved.current = null;
      lastSave.current = Date.now();
      const { saved, dropped, logDropped } = saveReviewHistory(history);
      setHistoryError(!saved ? "评审历史保存失败（本机存储可能已满）；当前记录仍可查看，请导出报告后重试。"
        : dropped > 0 || logDropped ? `本机存储已满，${[dropped > 0 ? `最早的 ${dropped} 条评审记录不再保存` : "", logDropped ? "最新一次评审只保存了结果、没有保存评审过程" : ""].filter(Boolean).join("，")}（这次打开期间仍可查看）；需要的话请先导出。` : "");
    };
    const wait = history.some(item => item.state === "running") ? lastSave.current + 1_000 - Date.now() : typing.current ? 600 : 0;
    typing.current = false;
    if (wait <= 0) { save(); return; }
    unsaved.current = save;
    const timer = setTimeout(save, wait);
    return () => clearTimeout(timer);
  }, [history, storedHistory]);
  useEffect(() => {
    const flush = () => unsaved.current?.();
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); flush(); };
  }, []);
  const updateRun = (id: string, update: (entry: ReviewHistoryEntry) => ReviewHistoryEntry) => {
    setHistory(previous => previous.map(item => item.id === id ? update(item) : item));
  };
  // What a review found, as one PR comment: the count, then each finding with its line, as re-evaluation left them.
  const reviewSummaryDraft = (item: ReviewHistoryEntry, earlier: string[] = []) => {
    const findings = (item.report?.findings ?? []).flatMap((finding, index) => {
      const verdict = item.verdicts.find(done => done.finding === index);
      return verdict?.verdict === "drop" ? [] : [{ ...finding, ...(verdict?.replacement ?? {}) }];
    });
    // Stopped or partial, the comment says so, with how many files it never reviewed: read on the PR, it passed for a
    // finished review's word.
    const standing = !item.report || item.report.status === "completed" ? ""
      : `，${STATUS[item.report.status]}${item.report.unreviewedFiles.length ? `，${item.report.unreviewedFiles.length} 个文件未评审` : ""}`;
    return [`**AI 评审**：${findingSummary(findings)}（提交 \`${item.snapshot.sourceCommit.slice(0, 12)}\`${standing}）`,
      ...findings.map(finding => `- **${finding.priority}** ${finding.title}（\`${finding.path}:${finding.line}\`）`), ...earlier].join("\n");
  };
  // A finding posted to the PR, one comment or a batch: it is not offered for posting again.
  const markPosted = (id: string, finding: number) =>
    updateRun(id, item => ({ ...item, published: [...item.published.filter(done => done.finding !== finding), { finding, at: new Date().toISOString() }] }));
  const listRequest = useRef(0);
  const [focus, setFocus] = useState("");
  // Files picked for a PR's next review, kept per PR so newer commits keep the choice.
  const [reviewScope, setReviewScope] = useState<{ reference: string; paths: string[] } | null>(null);
  const [choosingScope, setChoosingScope] = useState(false);
  // The findings offered when the batch dialog opened; posting some does not reshuffle the list.
  const [batch, setBatch] = useState<{ index: number; finding: PrReviewFinding }[] | null>(null);
  // A long report read one priority at a time; another record starts from all of them.
  // A priority, or "open": what is neither posted nor dropped yet.
  const [priorityFilter, setPriorityFilter] = useState<PrReviewFinding["priority"] | "open" | null>(null);
  // Whose run it is: another record opened meanwhile shows its own state, not this progress.
  const [reevaluatingAll, setReevaluatingAll] = useState<{ entryId: string; done: number; total: number } | null>(null);
  const [rechecking, setRechecking] = useState<{ entryId: string; done: number; total: number } | null>(null);
  const [summaryDraft, setSummaryDraft] = useState<string | null>(null);
  const stopReevaluation = useRef(false);
  // The re-evaluation the reader stopped: its ending is theirs, not a failure to report.
  const stoppedRequest = useRef<string | null>(null);
  useEffect(() => setPriorityFilter(null), [selectedRun]);
  const [mode, setMode] = useState<(typeof MODES)[number]["id"]>("review");
  // Claude Code's parallel reviewers, on request: a second one per group for the team's rules and past decisions.
  const [deep, setDeep] = useState(false);
  const [models, setModels] = useState<RetrievalAnswerProvider[]>([]);
  const [profileId, setProfileId] = useState("");
  const [loadTarget, setLoadTarget] = useState<{ connectionId: string; reference: string; title: string } | null>(null);
  const [snapshot, setSnapshot] = useState<PrReviewSnapshot | null>(null);
  const [busy, setBusy] = useState<"load" | "review" | "follow-up" | "reevaluate" | "platform" | null>(null);

  const [unseen, setUnseen] = useState(false);
  const wasReviewing = useRef(false);
  useEffect(() => {
    const reviewing = busy === "review";
    if (wasReviewing.current && !reviewing && hidden) setUnseen(true);
    wasReviewing.current = reviewing;
  }, [busy, hidden]);
  useEffect(() => { if (!hidden) setUnseen(false); }, [hidden]);
  useEffect(() => { onActivity?.(busy === "review" ? "running" : unseen ? "done" : null); }, [busy, unseen, onActivity]);
  const [reevaluating, setReevaluating] = useState<{ entryId: string; index: number } | null>(null);
  const [message, setMessage] = useState("");
  // A PR read from the platform, as opposed to one shown at once from the cache: the page says it is on its way.
  const [reading, setReading] = useState(false);
  // A review that ended while the reader was on another record: the page there says so, and leads back.
  const [finishedAway, setFinishedAway] = useState<string | null>(null);
  const [error, setError] = useState("");
  // A re-evaluation or re-check that failed, said on its own record: said on the page, it showed on whichever
  // record was open when it landed, one nothing had been asked of.
  const [reevaluationError, setReevaluationError] = useState<{ entryId: string; text: string } | null>(null);
  const runId = useRef<string | null>(null);
  const pending = useRef(false);
  // The review running now, once its record exists: the lists stay open meanwhile, and only that record offers to stop it.
  const reviewing = useRef<string | null>(null);
  const loadRequest = useRef(0);
  /** The platform check of a PR shown from the cache; a review started meanwhile waits for it. */
  const confirming = useRef<Promise<PrReviewSnapshot | null> | null>(null);
  const followUpCancelled = useRef(false);
  const currentModel = models.find((model) => model.profileId === profileId);

  useEffect(() => {
    if (hidden) return;
    let disposed = false;
    void api.listAssistantModels().then((available) => {
      if (disposed) return;
      setModels(available);
      setProfileId((previous) => available.some((model) => model.profileId === previous) ? previous : available[0]?.profileId ?? "");
    }).catch(() => { if (!disposed) setError("读取模型列表失败，请检查模型设置。"); });
    return () => { disposed = true; };
  }, [api, hidden]);
  useEffect(() => {
    if (hidden || busy !== null) return;
    let disposed = false;
    void api.listPrConnections().then((loaded) => {
      if (disposed) return;
      setConnections((current) => JSON.stringify(current) === JSON.stringify(loaded) ? current : loaded); setConnectionId((current) => loaded.some((item) => item.id === current) ? current : loaded[0]?.id ?? "");
    }).catch(() => { if (!disposed) setListError("读取代码平台链接失败，请重试。"); });
    return () => { disposed = true; };
  }, [api, hidden, busy]);
  /**
   * The scope's PRs, from the first page or (`further`) on from each list's cursor. 已合并 reads what I reviewed and
   * what I wrote, each from its own cursor, and shows them as one list, newest first, a PR in both shown once.
   */
  const list = async (further = false) => {
    const generation = ++listRequest.current;
    // No link left (the last removed on 链接): its list's failure goes with it, rather than standing over a page with none.
    if (!connectionId) { setItems([]); setCursors({}); setListing(false); setListError(""); return; }
    setListing(true); setListError("");
    try {
      const reads = SCOPES[scope].filters.flatMap((filter) => { const page = further ? cursors[filter] : 1; return page == null ? [] : [{ filter, page }]; });
      const responses = await Promise.all(reads.map(({ filter, page }) => api.listPullRequests({ connectionId, filter, ...(merged ? { state: "merged" as const } : {}), page })));
      if (generation !== listRequest.current) return;
      const when = (item: PrListItem) => Date.parse(item.updatedAt) || 0;
      const read = responses.flatMap((response) => response.items).sort((a, b) => when(b) - when(a));
      setItems((previous) => {
        const kept = further ? previous : [];
        return [...kept, ...read.filter((item, index) => !kept.some((old) => old.reference === item.reference) && read.findIndex((other) => other.reference === item.reference) === index)];
      });
      setCursors((previous) => ({ ...(further ? previous : {}), ...Object.fromEntries(reads.map(({ filter }, index) => [filter, responses[index]!.nextPage])) }));
      // Read the first PRs ahead so opening them is instant; unchanged ones cost nothing.
      // History opens its discussion, never the diff, so there is nothing to read ahead.
      if (!further && read.length && !merged) {
        void api.prefetchPrReviews({ connectionId, items: prefetchItems(read.slice(0, 5)) }).catch(() => undefined);
      }
    } catch (cause) { if (generation === listRequest.current) setListError(platformMessage(cause, "PR 列表读取失败。")); }
    finally { if (generation === listRequest.current) setListing(false); }
  };
  useEffect(() => {
    setItems([]); setCursors({});
    void list();
    return () => { listRequest.current++; };
  }, [connectionId, scope, connections]);
  useEffect(() => api.onPrReviewProgress((event) => {
    if (event.runId !== runId.current) return;
    updateRun(event.runId, item => ({ ...item, events: mergeReviewEvents(item.events, [event]) }));
  }), [api]);
  useEffect(() => () => { if (runId.current) void api.cancelPrReview(runId.current).catch(() => undefined); }, [api]);

  const selectRun = (id: string) => {
    loadRequest.current++;
    setSelectedRun(id); setSnapshot(null); setLoadTarget(null); setMessage(""); setError(""); setNavigationOpen(false);
    // A dialog opened on the record left behind resolves its target from the record shown: kept open, it
    // would post that record's comment to this one's PR, or delete this one — or, the PR 详情, show this one's PR
    // where the reader had opened the other's.
    setCommentFinding(null); setSummaryDraft(null); setBatch(null); setDismissing(null); setDeleteHistory(false);
    setShowDetails(false); setDiffFocus(null);
    // Hidden with the PR they were opened on, the file choice and the dismissed list came back, unasked, on the next.
    setChoosingScope(false); setShowDismissals(false);
  };
  useEffect(() => {
    if (!openRun || !history.some(item => item.id === openRun.id)) return;
    setListView("history");
    selectRun(openRun.id);
  }, [openRun]);
  // A PR read before shows at once from the local cache while its commits are confirmed in the
  // background, silently unless they moved, so switching never flashes a busy panel and opening
  // another PR meanwhile just moves on. Only a PR never read blocks for a full read.
  const load = async (target: { connectionId: string; reference: string; title: string; updatedAt?: string }) => {
    // A running review holds the lock throughout; a PR opened meanwhile is read beside it, without taking the lock.
    const beside = reviewing.current !== null;
    if (pending.current && !beside) return;
    const generation = ++loadRequest.current;
    const release = () => { if (!beside) pending.current = false; };
    if (!beside) pending.current = true;
    const request = { connectionId: target.connectionId, reference: target.reference, ...(target.updatedAt ? { updatedAt: target.updatedAt } : {}) };
    const reason = (cause: unknown) => platformMessage(cause, "PR 读取失败。");
    const cached = await api.peekPrReview(request).catch(() => null);
    if (generation !== loadRequest.current) { release(); return; }
    // The panel switches in one step, never through an empty state.
    setError(""); setSelectedRun(""); setLoadTarget(target); setNavigationOpen(false); setFocus(""); setSnapshot(cached);
    if (cached) {
      release(); setMessage("");
      confirming.current = api.loadPrReview(request).then((fresh) => {
        if (generation !== loadRequest.current) return null;
        setSnapshot(fresh);
        if (fresh.snapshotId !== cached.snapshotId) setMessage("PR 有新提交，已读取最新变更。");
        return fresh;
      }, (cause: unknown) => {
        if (generation === loadRequest.current) setError(`无法核对最新提交，显示的是上次读取的内容：${reason(cause)}`);
        return null;
      });
      return;
    }
    confirming.current = null;
    if (!beside) setBusy("load");
    setReading(true); setMessage("正在读取 PR 最新快照…");
    // Beside a review another PR may be opened before this one arrives: the later choice wins.
    try { const fresh = await api.loadPrReview(request); if (generation === loadRequest.current) { setSnapshot(fresh); setMessage(""); } }
    catch (cause) { if (generation === loadRequest.current) { setError(reason(cause)); setMessage(""); } }
    finally {
      if (generation === loadRequest.current) setReading(false);
      if (!beside) { pending.current = false; setBusy(null); }
    }
  };
  const selectedReference = entry?.snapshot.reference ?? loadTarget?.reference;
  const selectedConnection = entry?.connectionId ?? loadTarget?.connectionId;
  const review = async () => {
    if (pending.current || !snapshot || !loadTarget || !currentModel) return;
    pending.current = true; setBusy("review"); setError(""); setMessage("");
    // Reviewed as the platform has it now: a PR shown from the cache, or read a while ago, may have
    // newer commits, and its snapshot may have expired or been replaced by a read-ahead since; a review
    // of that would fail. Unchanged commits keep the same snapshot, confirmed again.
    await confirming.current;
    const latest = await api.loadPrReview({ connectionId: loadTarget.connectionId, reference: loadTarget.reference }).catch(() => null);
    if (latest !== null && latest.snapshotId !== snapshot.snapshotId) setMessage("PR 有新提交，已读取最新变更。");
    const reviewed = latest ?? snapshot;
    const id = crypto.randomUUID(); runId.current = id; reviewing.current = id;
    // A PR still being opened beside the review that just ended does not pull the page away from this one.
    loadRequest.current++;
    setSelectedRun(id); setSnapshot(null);
    setHistory(previous => [{ id, kind: "review", at: new Date().toISOString(), model: [currentModel.label, currentModel.model].filter(Boolean).join(" · "), focus, snapshot: reviewed,
      connectionId: loadTarget.connectionId, profileId, draft: "", turns: [], events: [], report: null, state: "running", error: "", published: [], verdicts: [], rechecks: [] }, ...previous]);
    const openResult = () => openRecord(id);
    try {
      const paths = scopedPaths(reviewScope, reviewed);
      const dismissed = dismissedIn(history, loadTarget.connectionId, reviewed.reference);
      const published = publishedIn(history, loadTarget.connectionId, reviewed.reference);
      const result = await api.runPrReview({ snapshotId: reviewed.snapshotId, runId: id, profileId, focus, ...(paths ? { paths } : {}), ...(deep ? { depth: "deep" as const } : {}),
        ...(dismissed.length ? { dismissed } : {}), ...(published.length ? { published } : {}) });
      updateRun(id, item => ({ ...item, state: "finished", report: { ...result, history: [] }, events: mergeReviewEvents(item.events, result.history) }));
      notifyAway(`PR 评审 · ${STATUS[result.status]}`, `${reviewed.reference} · ${findingSummary(result.findings)}`, openResult);
    } catch (cause) {
      // The main process's own reason (a snapshot gone stale, a review already running) names the next step; the
      // model-and-link advice is for a failure that gives none.
      const reason = platformMessage(cause, "评审失败，请检查模型与平台连接后重试。");
      updateRun(id, item => ({ ...item, state: "failed", error: reason }));
      notifyAway("PR 评审 · 评审失败", `${reviewed.reference} · ${reason}`, openResult);
    }
    finally {
      runId.current = null; reviewing.current = null; pending.current = false; setBusy(null); setFinishedAway(id);
      // Stopped: the report says so now.
      setMessage(current => current === "正在停止…" ? "" : current);
    }
  };
  useEffect(() => { if (finishedAway !== null && selectedRun === finishedAway) setFinishedAway(null); }, [selectedRun, finishedAway]);
  // Once per record: the model list is read again each time the page shows, and applying the record's
  // backend then undid one the reader had just picked, a local model swapped back for a remote one.
  const profileAppliedFor = useRef<string | null>(null);
  useEffect(() => {
    if (profileAppliedFor.current === selectedRun) return;
    const saved = history.find(item => item.id === selectedRun)?.profileId;
    if (saved && models.some(model => model.profileId === saved)) {
      setProfileId(saved);
      profileAppliedFor.current = selectedRun;
    }
  }, [selectedRun, models]);

  /**
   * `command` sends a slash command directly and leaves whatever is being typed in place; `target`
   * is a record created a moment ago, before it is on screen. A review is discussed once it has a
   * report, a record of its own ("chat") from the start.
   */
  const ask = async (retryId?: string, command?: string, target = entry) => {
    if (pending.current || !target || !(target.report || target.kind === "chat") || !currentModel) return;
    const previous = retryId ? target.turns.find(turn => turn.id === retryId) : undefined;
    const question = (previous?.question ?? command ?? target.draft).trim();
    if (!question) return;
    const entryId = target.id, turnId = previous?.id ?? crypto.randomUUID();
    const requestId = crypto.randomUUID();
    pending.current = true; followUpCancelled.current = false; runId.current = requestId;
    setBusy("follow-up"); setError(""); followLatest.current = true; setShowLatest(false);
    const turn: ReviewHistoryEntry["turns"][number] = { id: turnId, at: new Date().toISOString(), question, answer: "", model: [currentModel.label, currentModel.model].filter(Boolean).join(" · "), state: "pending" };
    updateRun(entryId, item => ({ ...item, profileId, draft: retryId || command ? item.draft : "", turns: previous ? item.turns.map(old => old.id === turnId ? turn : old) : [...item.turns, turn] }));
    const updateTurn = (changes: Partial<typeof turn>) => updateRun(entryId, item => ({ ...item, turns: item.turns.map(old => old.id === turnId ? { ...old, ...changes } : old) }));
    try {
      const reviewed = target.report ? { report: withoutHistory(target.report), excerpts: target.events.filter(event => event.kind === "tool").slice(-12).map(event => `${event.message}\n${event.detail ?? ""}`).join("\n").slice(-12000) } : { excerpts: "" };
      const result = await api.followUpPrReview({ runId: requestId, profileId, ...(target.connectionId ? { connectionId: target.connectionId } : {}), snapshot: target.snapshot, ...reviewed, focus: target.focus,
        messages: target.turns.filter(item => item.state === "done").slice(-6).flatMap(item => [{ role: "user" as const, content: expandCommand(item.question) }, { role: "assistant" as const, content: item.answer }]), question: expandCommand(question),
        // An overview or suggestions runs as its own pipeline over the whole PR.
        ...(commandOf(question) ? { command: commandOf(question) } : {}) });
      updateTurn(followUpCancelled.current ? { state: "cancelled" } : { state: "done", answer: result.answer, ...(result.usage ? { usage: result.usage } : {}) });
    } catch (cause) { updateTurn(followUpCancelled.current ? { state: "cancelled" } : { state: "failed", error: clipText(platformMessage(cause, "请重试。"), 2_000) }); }
    finally { runId.current = null; pending.current = false; setBusy(null); }
  };
  // Posting can take away the button a dialog came from (a posted finding's, the batch one), leaving focus on the page:
  // it goes to the first of these still on screen instead. Focus left anywhere else stays where it is. It is looked at
  // after the change that closes the dialog is committed, when the dialog's own cleanup has handed focus back, not on an
  // animation frame that a busy machine can run while the dialog is still there.
  const [refocusTo, setRefocusTo] = useState<string[] | null>(null);
  useEffect(() => {
    if (!refocusTo) return;
    setRefocusTo(null);
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    for (const selector of refocusTo) {
      const target = document.querySelector<HTMLElement>(selector);
      if (target) { target.focus(); return; }
    }
  }, [refocusTo]);
  const refocus = (...selectors: string[]) => setRefocusTo(selectors);
  const copyMarkdown = async (markdown: string) => {
    try {
      await navigator.clipboard.writeText(markdown);
      setMessage("已复制为 Markdown。");
    } catch { setError("复制失败，请稍后重试。"); }
  };
  /** Runs the way picked on the preparation page; review() and quickCommand() refuse while busy. */
  const start = () => void (mode === "review" ? review() : quickCommand(mode));
  const startLabel = MODES.find(option => option.id === mode)!.action;
  /** PR 概览 / 改进建议 straight on a PR, before any review: a record of its own to keep and follow up. */
  const quickCommand = async (command: "/describe" | "/improve") => {
    if (pending.current || !snapshot || !loadTarget || !currentModel) return;
    pending.current = true; setBusy("follow-up"); setError(""); setMessage("");
    const asked = (await confirming.current) ?? snapshot;
    const created: ReviewHistoryEntry = { id: crypto.randomUUID(), kind: "chat", at: new Date().toISOString(), model: [currentModel.label, currentModel.model].filter(Boolean).join(" · "), focus, snapshot: asked,
      connectionId: loadTarget.connectionId, profileId, draft: "", turns: [], events: [], report: null, state: "finished", error: "", published: [], verdicts: [], rechecks: [] };
    setHistory(previous => [created, ...previous]);
    loadRequest.current++;
    setSelectedRun(created.id); setSnapshot(null);
    pending.current = false;
    await ask(undefined, command, created);
  };

  // A question about one finding starts from its name and place in the follow-up box, after whatever is typed there.
  const askAbout = (entryId: string, finding: PrReviewFinding) => {
    const about = `关于「${finding.title}」（${finding.path}:${finding.line}）：`;
    // Should both not fit, what is typed gives way at its end: naming the finding is the point.
    updateRun(entryId, item => ({ ...item, draft: `${item.draft.trim() ? `${item.draft.trimEnd().slice(0, Math.max(0, 2_000 - about.length - 1))}\n` : ""}${about}`.slice(0, 2_000) }));
    document.getElementById("review-question")?.focus();
  };
  // The reviewer's own drop of a finding, and taking it back: later reviews of the repository are told of what stands.
  const dismiss = (entryId: string, index: number, reason: string) => updateRun(entryId, item => ({ ...item, verdicts: [...item.verdicts.filter(done => done.finding !== index),
    { verdict: "drop" as const, reason: reason.trim() || "没有写原因。", replacement: null, finding: index, at: new Date().toISOString(), model: "评审者", by: "reviewer" as const }] }));
  const withdraw = (entryId: string, index: number) => updateRun(entryId, item => ({ ...item, verdicts: item.verdicts.filter(done => !(done.finding === index && done.by)) }));
  // From the list of the repository's: taken back in every review it was turned down in.
  const withdrawEverywhere = (dismissal: Dismissal) => setHistory(previous => previous.map(item => dismissal.sources.some(source => source.run === item.id)
    ? { ...item, verdicts: item.verdicts.filter(done => !(done.by && dismissal.sources.some(source => source.run === item.id && source.finding === done.finding))) } : item));
  const reevaluate = async (index: number): Promise<boolean> => {
    const finding = entry?.report?.findings[index];
    if (pending.current || !entry?.report || !finding || !currentModel) return false;
    const entryId = entry.id, requestId = crypto.randomUUID();
    const model = [currentModel.label, currentModel.model].filter(Boolean).join(" · ");
    pending.current = true; runId.current = requestId; setBusy("reevaluate"); setReevaluating({ entryId, index }); setError(""); setReevaluationError(null);
    try {
      const verdict = await api.reevaluatePrReviewFinding({ runId: requestId, profileId, ...(entry.connectionId ? { connectionId: entry.connectionId } : {}), snapshot: entry.snapshot, finding, summary: entry.report.summary, focus: entry.focus });
      // Dropped by the reviewer while this ran: their own word stands over the model's.
      updateRun(entryId, item => item.verdicts.some(done => done.finding === index && done.by === "reviewer")
        ? item
        : ({ ...item, verdicts: [...item.verdicts.filter(done => done.finding !== index), { ...verdict, finding: index, at: new Date().toISOString(), model }] }));
      return true;
    } catch (cause) {
      if (stoppedRequest.current !== requestId) setReevaluationError({ entryId, text: `复评未完成：${platformMessage(cause, "请重试或检查模型设置。")}` });
      return false;
    } finally { runId.current = null; pending.current = false; setBusy(null); setReevaluating(null); }
  };
  /** Back on this record, from a notification clicked wherever the window was left. */
  const openRecord = (id: string) => { void api.openSurface("pr-review").catch(() => undefined); setListView("history"); selectRun(id); };
  // Every finding without a verdict, one after another; stopping or a failure ends the run.
  const reevaluateAll = async () => {
    const waiting = entry?.report?.findings.flatMap((_, index) => entry.verdicts.some(item => item.finding === index) ? [] : [index]) ?? [];
    if (pending.current || !entry || !waiting.length) return;
    stopReevaluation.current = false;
    let done = 0;
    for (const [position, index] of waiting.entries()) {
      setReevaluatingAll({ entryId: entry.id, done: position, total: waiting.length });
      if (stopReevaluation.current || !(await reevaluate(index))) break;
      done++;
    }
    setReevaluatingAll(null);
    notifyAway(`PR 评审 · ${done === waiting.length ? "全部复评完成" : "全部复评已停下"}`, `${entry.snapshot.reference} · 已复评 ${done} / ${waiting.length} 条`, () => openRecord(entry.id));
  };

  /** One finding of an earlier review of the PR, judged on this review's commits: still there, fixed, or moved. */
  const recheck = async (run: ReviewHistoryEntry, index: number): Promise<boolean> => {
    const finding = run.report?.findings[index];
    if (pending.current || !entry?.report || !run.report || !finding || !currentModel) return false;
    const entryId = entry.id, requestId = crypto.randomUUID();
    const model = [currentModel.label, currentModel.model].filter(Boolean).join(" · ");
    const replaced = run.verdicts.find(item => item.finding === index)?.replacement;
    // Rechecks of reviews no longer shown (deleted since) go, so they cannot pile up past the history's limits.
    const shown = new Set(carried.map(item => item.run.id));
    pending.current = true; runId.current = requestId; setBusy("reevaluate"); setError(""); setReevaluationError(null);
    try {
      const verdict = await api.reevaluatePrReviewFinding({ runId: requestId, profileId, ...(entry.connectionId ? { connectionId: entry.connectionId } : {}), snapshot: entry.snapshot,
        finding: { ...finding, ...(replaced ?? {}) }, summary: run.report.summary, focus: entry.focus, earlierCommit: run.snapshot.sourceCommit });
      updateRun(entryId, item => ({ ...item, rechecks: [...item.rechecks.filter(done => shown.has(done.run) && (done.run !== run.id || done.finding !== index)), { ...verdict, run: run.id, finding: index, at: new Date().toISOString(), model }].slice(-200) }));
      return true;
    } catch (cause) {
      if (stoppedRequest.current !== requestId) setReevaluationError({ entryId, text: `复核未完成：${platformMessage(cause, "请重试或检查模型设置。")}` });
      return false;
    } finally { runId.current = null; pending.current = false; setBusy(null); }
  };
  const recheckAll = async (items: { run: ReviewHistoryEntry; index: number }[]) => {
    if (pending.current || !entry || !items.length) return;
    stopReevaluation.current = false;
    let done = 0;
    for (const [position, { run, index }] of items.entries()) {
      setRechecking({ entryId: entry.id, done: position, total: items.length });
      if (stopReevaluation.current || !(await recheck(run, index))) break;
      done++;
    }
    setRechecking(null);
    notifyAway(`PR 评审 · ${done === items.length ? "复核完成" : "复核已停下"}`, `${entry.snapshot.reference} · 已复核之前评审的 ${done} / ${items.length} 个问题`, () => openRecord(entry.id));
  };

  /** The whole record as Markdown, for the file export and the clipboard alike. */
  const recordMarkdown = () => {
    if (!reportSnapshot || !entry) return null;
    const markdown = report ? reviewMarkdown(reportSnapshot, { ...report, history: events }, entry, new Set(postedAlready.keys())) : [`# ${entry.kind === "chat" ? "PR 问答" : "PR 评审"}：${reportSnapshot.title}`, reportSnapshot.reference, `源提交：${reportSnapshot.sourceCommit}`, `关注点：${entry.focus || "未指定"}`,
      ...(entry.kind === "chat" ? [] : [entry.error || (entry.state === "running" ? "评审尚未完成" : "评审已中断")]), ...events.map(event => eventLine(event, entry.state === "running"))].join("\n\n");
    const discussion = entry.turns.map(turn => `## 你 · ${turn.at}\n\n${turn.question}\n\n## 助手 · ${turn.model}${usageLabel(turn.usage)}\n\n${turn.answer || ({ pending: "回答中", failed: turn.error ? `回答失败：${turn.error}` : "回答失败", cancelled: "已停止", interrupted: "已中断", done: "" })[turn.state]}`).join("\n\n");
    return [markdown, carriedMarkdown, discussion].filter(Boolean).join("\n\n");
  };
  const exportReport = async () => {
    const markdown = recordMarkdown();
    if (markdown === null || !reportSnapshot || !entry) return;
    try {
      const result = await api.exportAssistantConversation({ suggestedName: `PR-review-${reportSnapshot.sourceCommit.slice(0, 8)}.md`, markdown });
      setMessage(result.status === "saved" ? (entry.kind === "chat" ? "问答记录已导出。" : "评审报告已导出。") : result.status === "failed" ? "导出失败，请重试。" : "已取消导出。");
    } catch { setError("导出失败，请重试。"); }
  };
  const activeSnapshot = entry?.snapshot ?? snapshot;
  const chosenPaths = snapshot ? scopedPaths(reviewScope, snapshot) : null;
  // Findings still to post: not posted yet, not dropped on re-evaluation, reworded where one replaced them.
  const older = entry?.kind === "review" && entry.report && entry.state === "finished" ? olderReviews(entry, history) : [];
  const sameCommits = (item: ReviewHistoryEntry) => item.snapshot.sourceCommit === entry?.snapshot.sourceCommit && item.snapshot.destinationCommit === entry?.snapshot.destinationCommit;
  // Posted already by another review of these very commits, older or newer: each comment it posted stands for one finding
  // here, the nearest within three lines on the same side of the same file under a shared title; posting that one again
  // repeats it. Kept as finding → the comment ("review:finding"), so the comment is counted for that finding alone.
  const postedAlready = new Map<number, string>();
  if (entry?.report) {
    const mine = entry.report.findings.map((finding, index) => ({ index, finding, keys: findingKeys(finding, verdictFor(index)?.replacement) }));
    const posted = history.filter(item => item !== entry && item.kind === "review" && item.connectionId === entry.connectionId && item.snapshot.reference === entry.snapshot.reference && sameCommits(item))
      .flatMap(run => run.published.flatMap(({ finding: index }) => {
        const finding = run.report?.findings[index];
        return finding ? [{ id: `${run.id}:${index}`, finding, keys: findingKeys(finding, run.verdicts.find(item => item.finding === index)?.replacement) }] : [];
      }));
    const pairs = mine.flatMap(own => posted.filter(other => other.finding.path === own.finding.path && other.finding.side === own.finding.side && other.keys.some(key => own.keys.includes(key)))
      .map(other => ({ own, other, distance: Math.abs(other.finding.line - own.finding.line) }))).filter(pair => pair.distance <= 3);
    pairs.sort((a, b) => a.distance - b.distance || a.own.index - b.own.index);
    const used = new Set<string>();
    for (const { own, other } of pairs) {
      if (postedAlready.has(own.index) || used.has(other.id)) continue;
      postedAlready.set(own.index, other.id); used.add(other.id);
    }
  }
  const postedBefore = (index: number) => postedAlready.has(index);
  // Posted to the PR (here, or by that rerun), or dropped on re-evaluation: the rest still wants a decision from the reviewer.
  const handled = (index: number) => entry?.published.some(item => item.finding === index) || postedBefore(index) || verdictFor(index)?.verdict === "drop";
  const openCount = entry?.report?.findings.filter((_, index) => !handled(index)).length ?? 0;
  const postable = entry?.report && entry.connectionId ? entry.report.findings.flatMap((finding, index) => handled(index)
    ? [] : [{ index, finding: { ...finding, ...(verdictFor(index)?.replacement ?? {}) } }]) : [];
  const sinceReview = snapshot ? changedSinceReview(snapshot, history, loadTarget?.connectionId) : null;
  // The last review was on these very commits: another one calls the model again for the same code.
  const lastReview = snapshot ? history.find(item => item.kind === "review" && item.report && item.connectionId === loadTarget?.connectionId && item.snapshot.reference === snapshot.reference) : undefined;
  const sameAsLast = lastReview?.report && lastReview.snapshot.sourceCommit === snapshot?.sourceCommit && lastReview.snapshot.destinationCommit === snapshot?.destinationCommit ? lastReview : undefined;
  // What no review of this very commit has read whole yet (not chosen, or not finished): all another one would add.
  const reviewedHere = new Set(sameAsLast && snapshot ? history.filter(item => item.kind === "review" && item.connectionId === loadTarget?.connectionId && item.snapshot.reference === snapshot.reference
    && item.snapshot.sourceCommit === snapshot.sourceCommit && item.snapshot.destinationCommit === snapshot.destinationCommit).flatMap(item => item.report?.reviewedFiles ?? []) : []);
  const leftOut = sameAsLast && snapshot ? Object.keys(snapshot.fileBatches ?? {}).filter(path => !reviewedHere.has(path)) : [];
  // What this PR was last looked at for: a re-review usually asks the same, so it is one click away.
  const lastFocus = snapshot ? history.find(item => item.connectionId === loadTarget?.connectionId && item.snapshot.reference === snapshot.reference && item.focus.trim())?.focus.trim() : undefined;
  // Other PRs and records can be read while a review runs; nothing else starts until it ends.
  const browsable = busy === null || (busy === "review" && reviewing.current !== null);
  const running = busy === "review" && entry?.id !== reviewing.current ? history.find(item => item.id === reviewing.current) : undefined;
  // An answer on another record holds the composer here too: said, with the way to it, or the read-only box and its
  // 停止回答 (which stops that answer) explained nothing.
  const answering = busy === "follow-up" ? history.find(item => item.turns.some(turn => turn.state === "pending")) : undefined;
  const runningElsewhere = running ? <p className="review-history-note" role="status">「{running.snapshot.title}」正在评审{batchProgress(running.events)}，完成或停止后才能开始新的评审或追问。<button type="button" className="review-note-link" onClick={() => selectRun(running.id)}>回到正在进行的评审</button></p>
    : answering && answering.id !== entry?.id ? <p className="review-history-note" role="status">「{answering.snapshot.title}」正在回答追问，完成或停止后才能在这里提问。<button type="button" className="review-note-link" onClick={() => selectRun(answering.id)}>回到正在回答的记录</button></p> : null;
  // Every finding still standing (dropped ones left out, replaced ones as replaced), one after another, to hand to a
  // coding agent in one go; posted ones stay in, since posting a comment does not fix the code.
  const standing = entry?.kind === "review" && entry.report ? entry.report.findings.flatMap((finding, index) => verdictFor(index)?.verdict === "drop" ? [] : [{ ...finding, ...(verdictFor(index)?.replacement ?? {}) }]) : [];
  // The findings closed, by who closed them: a re-evaluation's drop, or the reviewer's own no.
  const closedCounts = [`${entry?.verdicts.filter(item => item.verdict === "drop" && !item.by).length ?? 0} 个已撤销`, `${entry?.verdicts.filter(item => item.by).length ?? 0} 个不采纳`].filter(text => !text.startsWith("0 ")).join("、");
  const fixList = entry?.report && standing.length ? [`# ${entry.snapshot.title}（${entry.snapshot.reference}）的评审问题\n\n共 ${standing.length} 个，复评判为误报的和评审者不采纳的没有列出。请逐条核对后修复。`,
    ...standing.map(finding => findingMarkdown(entry.snapshot, finding, entry.report!.evidence))].join("\n\n---\n\n") : null;
  const unjudged = entry?.report?.findings.filter((_, index) => !entry.verdicts.some(item => item.finding === index)).length ?? 0;
  // After a re-review: what earlier reviews found, as it stands on these commits. The newest speaks for the files it
  // looked at; a file it left out (a partial or unfinished review) keeps what an older one found. Dropped ones are left out.
  // Reviews of other commits; one of these same commits is a rerun, with nothing new to look at again.
  const earlier = older.filter(item => !sameCommits(item));
  /**
   * One problem across reviews. Going from the newest review back, each report joins at most one problem a newer review
   * reported (same file, a shared title, the nearest line), so two findings of one review that share a title stay two
   * problems. The newest report speaks for the problem, and any report of it that was posted makes it posted.
   */
  type Report = { run: ReviewHistoryEntry; index: number; finding: PrReviewFinding; dropped: boolean };
  type Problem = { head: Report; keys: Set<string>; line: number; lastRun: string; published: boolean; covered: boolean };
  const problems: Problem[] = [];
  const reportsOf = (run: ReviewHistoryEntry) => (run.report?.findings ?? []).map((finding, index) => {
    const verdict = run.verdicts.find(item => item.finding === index);
    return { index, finding, verdict, keys: findingKeys(finding, verdict?.replacement), published: run.published.some(item => item.finding === index) };
  });
  // One review's reports against the problems still open to them: the nearest pair of all goes first, and so on, each
  // report and each problem at most once, so a report cannot take the problem another one of its review sits right next to.
  const pairUp = (reports: ReturnType<typeof reportsOf>, open: Problem[], line: (problem: Problem) => number) => {
    const pairs = reports.flatMap(report => open.filter(problem => report.keys.some(key => problem.keys.has(key)))
      .map(problem => ({ report, problem, distance: Math.abs(line(problem) - report.finding.line) })));
    // Equally near either way, the pair that keeps both sides' order goes first (the second of two to the second), counted
    // among what could pair at all: the same file under a shared title.
    const rankOf = <T,>(items: T[], keys: (item: T) => Iterable<string>, at: (item: T) => number) => new Map<T, number>(items.map(item => {
      const own = new Set(keys(item));
      return [item, items.filter(other => [...keys(other)].some(key => own.has(key)) && at(other) < at(item)).length];
    }));
    const reportRank = rankOf(reports, report => report.keys, report => report.finding.line);
    const problemRank = rankOf(open, problem => problem.keys, line);
    pairs.sort((a, b) => a.distance - b.distance
      || Math.abs(reportRank.get(a.report)! - problemRank.get(a.problem)!) - Math.abs(reportRank.get(b.report)! - problemRank.get(b.problem)!)
      || a.report.index - b.report.index);
    const matched = new Map<number, Problem>(), taken = new Set<Problem>();
    for (const { report, problem } of pairs) {
      if (matched.has(report.index) || taken.has(problem)) continue;
      matched.set(report.index, problem); taken.add(problem);
    }
    return matched;
  };
  const covered = new Set<string>();
  for (const run of earlier) {
    const reports = reportsOf(run);
    const matched = pairUp(reports, problems.filter(problem => problem.lastRun !== run.id), problem => problem.line);
    for (const report of reports) {
      const same = matched.get(report.index);
      if (same) {
        same.lastRun = run.id; same.line = report.finding.line; same.published ||= report.published;
        for (const key of report.keys) same.keys.add(key);
        continue;
      }
      // A later review is told not to repeat what the PR's comments already say, so a posted problem stays until a recheck
      // finds it gone; an unposted one gives way to a later review that read its file whole (a stop or a failed batch
      // leaves a file half read, and what older reviews found there stands).
      problems.push({ head: { run, index: report.index, finding: { ...report.finding, ...(report.verdict?.replacement ?? {}) }, dropped: report.verdict?.verdict === "drop" },
        keys: new Set(report.keys), line: report.finding.line, lastRun: run.id, published: report.published, covered: covered.has(report.finding.path) });
    }
    for (const path of run.report?.reviewedFiles ?? []) covered.add(path);
  }
  // This review, and reruns of these very commits after it, read the same code: each pairs its findings with every problem
  // on its own (a rerun much like this review would otherwise be left the far ones), and the newest word on a problem stands.
  // One dropped there is no problem. One posted there is posted; one this review posts after a later review let it go stays
  // let go, as this review lists it anyway. One this review found again is listed below already, and its title says it was
  // raised before (not dropped then).
  const pairedNow = new Map<Problem, boolean>(), foundHere = new Set<Problem>(), raisedAgain = new Set<number>();
  let pairedHere = new Map<number, Problem>();
  for (const run of entry?.report ? [entry, ...older.filter(sameCommits)] : []) {
    const reports = reportsOf(run);
    const matched = pairUp(reports, problems, problem => problem.head.finding.line);
    if (run === entry) pairedHere = matched;
    for (const [index, problem] of matched) {
      const report = reports[index]!;
      if (report.published) {
        // A rerun's comment that stands for one of this review's findings belongs to the problem that finding is.
        const own = [...postedAlready].find(([, comment]) => comment === `${run.id}:${index}`)?.[0];
        const posted = run === entry ? problem : own !== undefined ? pairedHere.get(own) : problem;
        if (posted && !(run === entry && posted.covered)) posted.published = true;
      }
      if (pairedNow.has(problem)) continue;
      pairedNow.set(problem, report.verdict?.verdict === "drop");
      if (run !== entry) continue;
      foundHere.add(problem);
      if (!problem.head.dropped) raisedAgain.add(index);
    }
  }
  // A recheck of a problem's newest report: this review's own, or a rerun's on these commits, read the same code and is
  // shown as it is; otherwise the newest other review's word settles it only when that found the problem gone.
  const recheckOf = (report: Report) => {
    const matches = (check: ReviewHistoryEntry["rechecks"][number]) => check.run === report.run.id && check.finding === report.index;
    const here = entry?.rechecks.find(matches) ?? older.filter(sameCommits).flatMap(item => item.rechecks.filter(matches))[0];
    return { here, before: here ? undefined : earlier.flatMap(item => item.rechecks.filter(matches))[0] };
  };
  const carried = entry ? problems.flatMap(problem => {
    const { head } = problem, { here, before } = recheckOf(head);
    if (head.dropped || pairedNow.get(problem) || before?.verdict === "drop" || (problem.covered && !problem.published)) return [];
    const digest = head.run.snapshot.fileDigests?.[head.finding.path];
    const place = !entry.snapshot.files.some(file => file.path === head.finding.path) ? "gone" as const
      : digest !== undefined && digest === entry.snapshot.fileDigests?.[head.finding.path] ? "same" as const : "changed" as const;
    return [{ run: head.run, index: head.index, finding: head.finding, place, published: problem.published, check: here, again: foundHere.has(problem) }];
  }) : [];
  const carriedState = (item: (typeof carried)[number]) => item.check ? CARRIED_CHECK[item.check.verdict] : item.again ? "这次评审又报了" : CARRIED_PLACE[item.place];
  // "上次评审" is the latest review, and only when everything shown came from it; otherwise each finding names its commit.
  const previous = earlier[0];
  const oneSource = carried.every(item => item.run === previous);
  const carriedTitle = oneSource ? "上次评审的问题" : "之前评审的问题";
  const fromCommit = (run: ReviewHistoryEntry, length = 12) => oneSource ? "" : ` · 提交 ${run.snapshot.sourceCommit.slice(0, length)}`;
  // Found again by this review, it is judged there already: rechecking it would spend a call for nothing.
  const recheckable = carried.filter(item => item.place === "changed" && !item.check && !item.again).map(item => ({ run: item.run, index: item.index }));
  // For the summary comment: only what is known — rechecked, or in a file that did not change. The rest is left out,
  // and so is one this review found again under the same title: the comment already lists it above.
  const settled = carried.flatMap(item => item.again ? []
    : item.check ? [{ ...item, gone: item.check.verdict === "drop" }] : item.place === "same" ? [{ ...item, gone: false }] : []);
  // The whole of it for the record's export, unknowns included, as the section shows it.
  const carriedMarkdown = previous && carried.length ? [`## ${carriedTitle}${oneSource ? `（提交 \`${previous.snapshot.sourceCommit.slice(0, 12)}\`）` : ""}`,
    carried.map(item => `- **${item.finding.priority}** ${item.finding.title}（\`${item.finding.path}:${item.finding.line}\`${fromCommit(item.run)}）：${carriedState(item)}`
      + (item.check ? ` · ${item.check.verdict === "replace" && item.check.replacement ? `${item.check.replacement.title}：${item.check.replacement.body}` : item.check.reason}` : "")
      + (item.published ? " · 已发布为 PR 评论" : "")).join("\n")].join("\n\n") : "";
  const carriedLines = previous && settled.length ? ["",
    `**${carriedTitle}**${oneSource ? `（提交 \`${previous.snapshot.sourceCommit.slice(0, 12)}\`）` : ""}：${[settled.filter(item => item.gone).length ? `已不存在 ${settled.filter(item => item.gone).length} 个` : "", settled.filter(item => !item.gone).length ? `仍然存在 ${settled.filter(item => !item.gone).length} 个` : ""].filter(Boolean).join("，")}`,
    ...settled.map(item => `- ${item.gone ? "已不存在" : "仍然存在"}：${item.finding.title}（\`${item.finding.path}:${item.finding.line}\`${fromCommit(item.run)}）`)] : [];
  // Groups as the chosen model reads them: a local one a page at a time, a remote one most PRs whole.
  const unitChars = prReviewUnitChars(currentModel?.kind ?? "qwen");
  // What the reviewer turned down in this repository before, which the review about to start is told of.
  const dismissedHere = snapshot && loadTarget ? dismissalsIn(history, loadTarget.connectionId, snapshot.reference) : [];
  // And what they put on its PRs as comments, which it is told the team cares about.
  const publishedHere = snapshot && loadTarget ? publishedIn(history, loadTarget.connectionId, snapshot.reference) : [];
  // A finding of this review like one turned down in another review of the repository before this one started (the same
  // file and title), which the review raised anyway: it says so, with the reason, so it can be turned down again at once.
  const declinedBefore = new Map(entry?.report ? dismissalsIn(history.filter(item => item.id !== entry.id), entry.connectionId, entry.snapshot.reference, entry.at)
    .map(item => [`${item.path}\n${item.title}`, item] as const) : []);
  const declinedFor = (finding: PrReviewFinding) => declinedBefore.get(`${finding.path}\n${finding.title}`);
  const lanes = prReviewLanes(currentModel?.kind ?? "qwen");
  const plannedBatches = snapshot ? plannedGroups(snapshot, chosenPaths, unitChars) : undefined;
  const query = search.trim().toLocaleLowerCase();
  const runStatus = (item: ReviewHistoryEntry) => {
    // The P1s still standing (a dropped one is not), so the list shows which PR needs changes first; "P1" is searchable too.
    const p1 = item.report?.findings.filter((finding, index) => finding.priority === "P1" && item.verdicts.find(verdict => verdict.finding === index)?.verdict !== "drop").length ?? 0;
    const state = item.kind === "chat" ? COMMAND_LABELS[item.turns[0]?.question ?? ""] ?? "问答"
      : item.state === "running" ? `评审中${batchProgress(item.events)}` : item.report ? `${STATUS[item.report.status]}${item.report.findings.length ? ` · ${item.report.findings.length} 个问题${p1 ? `（${p1} 个 P1）` : ""}` : ""}` : item.state === "failed" ? "评审失败" : "已中断";
    // Which PRs already carry comments from here, visible from the list.
    return item.published.length ? `${state} · 已发布 ${item.published.length}` : state;
  };
  const finished = finishedAway && entry?.id !== finishedAway && busy !== "review" ? history.find(item => item.id === finishedAway) : undefined;
  const finishedElsewhere = finished ? <p className="review-history-note" role="status">「{finished.snapshot.title}」{runStatus(finished)}。<button type="button" className="review-note-link" onClick={() => selectRun(finished.id)}>查看结果</button></p> : null;
  // What the list says about a PR: its latest review or overview here, and whether the PR moved since.
  const prStatus = (item: PrListItem) => {
    const saved = history.find(run => run.connectionId === connectionId && run.snapshot.reference === item.reference);
    const changedSince = !merged && saved !== undefined && item.updatedAt !== undefined && Date.parse(item.updatedAt) > Date.parse(saved.at);
    const status = merged ? "已合并" : saved ? runStatus(saved) : "未评审";
    return { saved, changedSince, status, label: changedSince ? `${status} · 之后有更新` : status };
  };
  // The status is searchable too, so "未评审" or "之后有更新" narrows the list to what still needs a look.
  const visibleItems = items.filter(item => `${item.number} ${item.title} ${item.repository} ${item.author} ${prStatus(item).label}`.toLocaleLowerCase().includes(query));
  // The label is searchable too, so "概览" finds the overviews.
  // By what a record found and was asked, too: "which review said something about the timeout?"
  const visibleHistory = history.filter(item => [item.snapshot.title, item.snapshot.reference, item.snapshot.sourceCommit, item.model, runStatus(item),
    ...(item.report?.findings ?? []).map(finding => finding.title), ...item.verdicts.flatMap(verdict => verdict.replacement ? [verdict.replacement.title] : []), ...item.turns.map(turn => turn.question)].join(" ").toLocaleLowerCase().includes(query));
  const closeActions = () => { if (moreActions.current) moreActions.current.open = false; };
  // A record's PR can be read again while its connection still exists.
  const reviewable = entry?.connectionId !== undefined && connections.some(connection => connection.id === entry.connectionId);
  // The list says the PR moved after this record: say it where the record is read, with the way to review again.
  const listed = entry && entry.connectionId === connectionId && !merged ? items.find(item => item.reference === entry.snapshot.reference) : undefined;
  const movedSince = entry !== undefined && entry.state !== "running" && listed?.updatedAt !== undefined && Date.parse(listed.updatedAt) > Date.parse(entry.at);
  /** Back to the preparation page for this record's PR; from an overview or suggestions the next step is usually the full review. */
  const reviewLatest = (item: ReviewHistoryEntry) => {
    if (item.kind === "chat") setMode("review");
    void load({ connectionId: item.connectionId!, reference: item.snapshot.reference, title: item.snapshot.title });
  };
  /** ↑/↓ walk a list and open each item: a PR read before shows at once, so browsing by key is cheap. */
  /**
   * ↑/↓ within a list. `opens`: whether arriving at an item opens it, as it does an open PR (read on arrival) or a
   * record; a merged PR's discussion is a dialog, which took the focus at every step down the list. Said by the list
   * the keys are in: the PR list's scope decided it for the history list too, which no control there showed.
   */
  const moveInList = (opens: boolean) => (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".review-pr-item")];
    const next = items[items.indexOf(event.target as HTMLButtonElement) + (event.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
    if (opens) next.click();
  };
  const modelControl = <select id={entry ? "follow-up-model" : "review-model"} className="review-model-picker" aria-label={entry ? "对话模型" : "评审模型"} value={profileId} disabled={busy !== null} onChange={event => setProfileId(event.target.value)}>
    {models.length ? models.map(model => <option key={model.profileId} value={model.profileId}>{model.label}{model.model ? ` · ${model.model}` : ""}</option>) : <option value="">请先启用可用模型</option>}
  </select>;
  // Kept across a newer snapshot of the same PR (the background check of a cached one finding a new commit): keyed
  // by the snapshot, the 需要修改 dialog closed on its own with the comment typed into it. It reads the platform
  // again for the snapshot it is given. Keyed by the link too: the same `team/app#7` on a GitHub and a GitLab
  // mirror is two PRs, and one merged showed the other as merged, with a comment typed for one carried to it.
  const platformActions = activeSnapshot ? <PrPlatformActions key={`${entry?.connectionId ?? loadTarget?.connectionId ?? ""}|${activeSnapshot.reference}`} api={api} snapshot={activeSnapshot} connectionId={entry?.connectionId ?? loadTarget?.connectionId} disabled={busy !== null}
    openP1={entry?.report ? entry.report.findings.filter((finding, index) => finding.priority === "P1" && verdictFor(index)?.verdict !== "drop").length : 0}
    onPending={value => { pending.current = value; setBusy(value ? "platform" : null); }}
    onComplete={result => { setMessage(result.message); void list(); }} /> : null;
  return <section className="desktop-view pr-review-panel" hidden={hidden} aria-label="PR 评审">
    <header className="desktop-view-header drag-region">
      <div><h1>评审</h1><p>结合代码与历史决策，审视每一次变更。</p></div>
      <IconButton className="review-nav-toggle no-drag" aria-label="切换 PR 导航" aria-expanded={navigationOpen || (!entry && !loadTarget)} aria-controls="review-navigation" onClick={() => setNavigationOpen(value => !value)}><ActionIcon name="panel" /></IconButton>
    </header>
    <div className="review-workspace" data-navigation={navigationOpen || (!entry && !loadTarget)}>
    <aside id="review-navigation" className="review-sidebar" aria-label="PR 列表">
      <div className="review-sidebar-heading"><h2>工作列表</h2><IconButton aria-label="刷新 PR 列表" disabled={!browsable || listing || !connectionId} onClick={() => void list()}><ActionIcon name="refresh" /></IconButton></div>
      <div className="review-list-controls">
        <select id="review-connection" aria-label="代码平台链接" value={connectionId} disabled={!browsable || !connections.length} onChange={event => setConnectionId(event.target.value)}>
          {!connections.length ? <option value="">尚未添加平台</option> : connections.map(item => <option key={item.id} value={item.id}>{item.label} · {PLATFORM_LABELS[item.platform]}</option>)}
        </select>
        <div className="review-list-tabs" role="group" aria-label="列表视图">
          <button aria-pressed={listView === "prs"} onClick={() => { setListView("prs"); setSearch(""); }}>PR <span>{items.length}{more ? "+" : ""}</span></button>
          <button aria-pressed={listView === "history"} onClick={() => { setListView("history"); setSearch(""); }}>历史评审 <span>{history.length}</span></button>
        </div>
        <div className="review-search"><ActionIcon name="search" /><input type="search" aria-label="搜索评审列表" placeholder={listView === "prs" ? "搜索已加载的 PR…" : "搜索历史评审…"} value={search} onChange={event => setSearch(event.target.value)} /></div>
        {/* One switch, a click away and always in view: a dropdown took two and went unseen, and two switches (whose,
            which state) read as a menu and a submenu. */}
        {listView === "prs" ? <div className="review-list-filter" role="group" aria-label="PR 范围">
          {(Object.keys(SCOPES) as Scope[]).map((key) => <button key={key} type="button" aria-pressed={scope === key} disabled={!browsable} onClick={() => setScope(key)}>{SCOPES[key].label}</button>)}
        </div> : null}
      </div>
      <div className="review-list-scroll">
      {listView === "prs" ? <>
        {!connections.length ? <div className="review-list-empty"><p>连接代码平台，查看你的 PR。</p><button className="text-button" onClick={() => void api.openSurface("connections").catch(() => setListError(OPEN_SETTINGS_FAILED))}>管理链接</button></div> : null}
        {/* A token that expired or lost access is the usual cause; the links page signs in with each one. */}
        {/* Not after a failed opening of the settings: that is the very step that just failed. */}
        {listError ? <p role="alert">{listError} {listError === OPEN_SETTINGS_FAILED ? null : <button type="button" className="review-note-link" onClick={() => void api.openSurface("connections").catch(() => setListError(OPEN_SETTINGS_FAILED))}>检查链接</button>}</p> : null}
        {listing ? <p role="status">正在读取 PR 列表…</p> : !visibleItems.length && connectionId && !listError ? <p className="review-list-empty">{query ? "没有匹配的 PR。" : merged ? "当前范围没有已合并的 PR。" : "当前范围没有待处理的 PR。"}</p> : null}
        <ul className="review-pr-list" onKeyDown={moveInList(!merged)}>{visibleItems.map(item => {
          // The PR moved after the last review or overview: worth another look.
          const { saved, changedSince, status } = prStatus(item);
          return <li key={item.reference}><button className="review-pr-item" aria-label={`${item.repository} #${item.number} ${item.title}`} aria-describedby={`review-status-${item.reference}`} disabled={!browsable} aria-pressed={selectedConnection === connectionId && selectedReference === item.reference} onClick={() => {
            // History is read, not reviewed again: its discussion opens without fetching the diff.
            if (merged) { setDiscussion({ connectionId, pr: { title: item.title, reference: item.reference, project: item.repository.split("/").at(-1)! } }); setNavigationOpen(false); }
            else if (saved) selectRun(saved.id);
            else if (selectedConnection !== connectionId || selectedReference !== item.reference) {
              void load({ ...item, connectionId });
              // The next two are read ahead, so walking down the list with ↓ stays instant.
              const next = visibleItems.slice(visibleItems.indexOf(item) + 1).slice(0, 2);
              if (next.length) void api.prefetchPrReviews({ connectionId, items: prefetchItems(next) }).catch(() => undefined);
            }
            else setNavigationOpen(false);
          }}>
            {/* Title first, where the eye goes; where it lives and who wrote it in one quiet line; then how it stands (Claude Design: "PR 列表条目", option B). */}
            <strong>{item.title}</strong>
            <span className="review-item-meta"><span>{item.repository} #{item.number} · {item.author || "未知作者"}{item.updatedAt ? <> · <time dateTime={item.updatedAt} title={fullTime.format(new Date(item.updatedAt))}>{listDay(item.updatedAt)} 更新</time></> : null}</span></span>
            {/* The label names the PR; how it stands is read after it. */}
            <span className="review-item-meta" id={`review-status-${item.reference}`}><span>{markP1(status)}</span>{changedSince ? <span data-changed title="上次评审或问答之后，PR 又有新提交或新评论">之后有更新</span> : null}</span>
          </button></li>;
        })}</ul>
        {more ? <button className="text-button review-load-more" disabled={!browsable || listing} onClick={() => void list(true)}>加载更多 PR</button> : null}
      </> : <>
        {!visibleHistory.length ? <p className="review-list-empty">{query ? "没有匹配的评审。" : "完成一次评审后，过程与对话会保存在这里。"}</p> : null}
        <ul className="review-pr-list" aria-label="历史评审" onKeyDown={moveInList(true)}>{visibleHistory.map(item => <li key={item.id}><button className="review-pr-item" data-run-id={item.id} disabled={!browsable} aria-pressed={selectedRun === item.id} onClick={() => selectRun(item.id)}>
          <strong>{item.snapshot.title}</strong>
          <span className="review-item-meta"><span>{item.snapshot.reference} · <code>{item.snapshot.sourceCommit.slice(0, 8)}</code> · <time dateTime={item.at} title={fullTime.format(new Date(item.at))}>{dayTime.format(new Date(item.at))}</time> · {item.model}</span></span>
          <span className="review-item-meta"><span>{markP1(runStatus(item))}</span></span>
        </button></li>)}</ul>
      </>}
      </div>
      <p className="review-sidebar-foot">{listView === "prs" ? merged ? "选择已合并的 PR，把讨论里的决定记为决策" : "选择 PR 开始评审或继续讨论 · ↑↓ 切换" : "仅保存在本机 · 含代码与决策摘录"}</p>
    </aside>
      <ListWidthHandle storageKey="decision.pr-review.list-width" label="调整 PR 列表宽度" controls="review-navigation" />
    <div className="review-detail" aria-label="当前评审">
      {message ? <p className="review-notice" role="status">{message}</p> : null}
      {error ? <p className="review-notice" role="alert">{error}</p> : null}
      {reevaluationError && reevaluationError.entryId === entry?.id ? <p className="review-notice" role="alert">{reevaluationError.text}</p> : null}
      {historyError ? <p className="review-notice" role="alert">{historyError}</p> : null}
      {!entry && !loadTarget ? <div className="review-empty"><ActionIcon name="record" /><h2>从一次变更开始</h2><p>选择 PR，结合历史决策检查问题；也可以先生成 PR 概览或改进建议。<br />已有评审与问答可以继续追问。</p></div> : null}
      {loadTarget && !snapshot && !entry ? <div className="review-empty"><h2>{loadTarget.title}</h2>{!reading ? <button className="secondary-button" onClick={() => void load(loadTarget)}>重试读取 PR</button> : <p>正在读取变更内容…</p>}</div> : null}
      {snapshot ? <div className="review-preparation">
        <div className="review-context"><div><p className="review-context-meta">{snapshot.reference}</p><h2>{snapshot.title}</h2><p className="review-context-meta"><code>{snapshot.sourceCommit.slice(0, 12)}</code> · <button className="review-files-link" aria-label="查看 PR 详情" onClick={() => setShowDetails(true)}><ActionIcon name="diff" /><span>{snapshot.files.length} 个文件</span></button>{loadTarget ? <> · <button type="button" className="review-files-link" onClick={() => setDiscussion({ connectionId: loadTarget.connectionId, pr: snapshot })}>PR 讨论</button> · <button type="button" className="review-files-link" onClick={() => void api.openPr({ connectionId: loadTarget.connectionId, reference: snapshot.reference }).catch(() => setError("无法在浏览器中打开这个 PR，请检查平台链接。"))}>在平台打开</button></> : null}</p></div>
          {platformActions}</div>
        <div className="review-preparation-body">
          {/* What the author says first; without it, an overview is the quicker way in. */}
          {snapshot.description.trim()
            ? <details key={snapshot.snapshotId} className="review-description" open={snapshot.description.length <= 280 || undefined}><summary>PR 描述</summary><div className="assistant-answer">{renderMarkdown(snapshot.description)}</div></details>
            : <p className="review-history-note">PR 没有填写描述，可以先生成 PR 概览。{mode === "/describe" ? null : <> <button type="button" className="review-note-link" onClick={() => setMode("/describe")}>选择 PR 概览</button></>}</p>}
          <section aria-labelledby="review-scope-title"><h3 id="review-scope-title">这次会带上</h3>
            <div className="review-scope">
              <div>{chosenPaths ? <><strong>{chosenPaths.length} / {Object.keys(snapshot.fileBatches ?? {}).length}</strong><span>个文件将评审</span></> : <><strong>{snapshot.files.length}</strong><span>个变更文件</span></>}<small>{chosenPaths ? `共 ${snapshot.files.length} 个变更文件` : `${snapshot.files[0]?.path ?? ""}${snapshot.files.length > 1 ? " 等" : ""}`}{Object.keys(snapshot.fileBatches ?? {}).length > 1 ? <> · <button type="button" className="review-note-link" onClick={() => setChoosingScope(true)}>选择文件</button></> : null}</small>
                {snapshot.changeSize ? <small>{changeNote(snapshot.changeSize)}</small> : null}</div>
              <div><strong>{snapshot.rules?.length ?? 0}</strong><span>条评审规则</span><small>{snapshot.rules?.length ? ruleNames(snapshot.rules) : "没有命中"} · <button type="button" className="review-note-link" onClick={() => void api.openReviewRulesDirectory().catch(() => setError("无法打开评审规则目录，请检查权限后重试。"))}>{snapshot.rules?.length ? "管理规则" : "添加规则"}</button></small></div>
              {mode === "review" ? <div><strong>{snapshot.guides?.length ?? 0}</strong><span>份仓库规范</span><small>{snapshot.guides?.length ? `${snapshot.guides.join("、")} · 只按能在代码上核对的约定检查` : "没有读到根目录的 CLAUDE.md 或 AGENTS.md"}</small></div> : null}
              <div><strong>{snapshot.existingComments ?? 0}</strong><span>条已有评论</span><small>{snapshot.existingComments ? "会参考，不重复提出已被指出的问题" : "PR 上还没有可参考的评论"}</small></div>
              {mode === "review" && dismissedHere.length ? <div><strong>{dismissedHere.length}</strong><span>条不采纳过的问题</span><small>{dismissedHere[0]!.title}{dismissedHere.length > 1 ? " 等" : ""} · 告诉模型不再提同类问题 · <button type="button" className="review-note-link" aria-label="查看不采纳过的问题" onClick={() => setShowDismissals(true)}>查看</button></small></div> : null}
              {mode === "review" && publishedHere.length ? <div><strong>{publishedHere.length}</strong><span>条发布过的问题</span><small>{publishedHere[0]!.title}{publishedHere.length > 1 ? " 等" : ""} · 告诉模型团队在意同类问题</small></div> : null}
              {plannedBatches !== undefined ? <div><strong>{plannedBatches}</strong><span>个评审分组</span><small>{plannedBatches > 1 ? `按所选模型一次能读的长度，相关文件放在一组${lanes > 1 ? `，最多 ${lanes} 组同时评审` : ""}；` : "整个 PR 一次读完；"}每组最多 {PR_REVIEW_BATCH_MAX_CALLS} 次模型调用，之后逐条核验，可随时停止</small></div> : null}
            </div>
            {sinceReview && sinceReview.paths.length < Object.keys(snapshot.fileBatches ?? {}).length ? <p className="review-history-note" role="note">上次评审（{dayTime.format(new Date(sinceReview.at))} · 提交 <code>{sinceReview.commit.slice(0, 8)}</code>）之后，{sinceReview.paths.length
              ? <>有 {sinceReview.paths.length} 个文件的改动变了或尚未评审：{sinceReview.paths.slice(0, 3).join("、")}{sinceReview.paths.length > 3 ? " 等" : ""}。{chosenPaths?.join("\n") === sinceReview.paths.join("\n") ? "已只选这些。" : <button type="button" className="review-note-link" onClick={() => setReviewScope({ reference: snapshot.reference, paths: sinceReview.paths })}>只评审这些</button>}</>
              : "各文件的改动没有变化。"}</p> : null}
            {sameAsLast?.report ? <p className="review-history-note" role="note">上次评审（{dayTime.format(new Date(sameAsLast.at))} · {STATUS[sameAsLast.report.status]}）就是这个提交{leftOut.length
              ? <>，但有 {leftOut.length} 个文件没评审：{leftOut.slice(0, 3).join("、")}{leftOut.length > 3 ? " 等" : ""}。{chosenPaths?.join("\n") === leftOut.join("\n") ? "已只选这些。" : <button type="button" className="review-note-link" onClick={() => setReviewScope({ reference: snapshot.reference, paths: leftOut })}>只评审这些</button>}</>
              : "；再评审会重新调用模型。"}</p> : null}
            {snapshot.skippedFiles?.length ? <p className="review-history-note">不送模型的锁定或生成文件：{snapshot.skippedFiles.slice(0, 3).join("、")}{snapshot.skippedFiles.length > 3 ? ` 等 ${snapshot.skippedFiles.length} 个` : ""}。它们不计入评审分组，回答里也不带这部分 diff。</p> : null}
            {snapshot.warnings.map(warning => <p role="status" className="review-warning" key={warning}>{warning}</p>)}
          </section>
          <fieldset className="review-modes"><legend>选择方式</legend>
            {MODES.map(option => <label key={option.id} className="review-mode" data-selected={mode === option.id || undefined}>
              <span><input type="radio" name="review-mode" value={option.id} checked={mode === option.id} onChange={() => setMode(option.id)} /><strong>{option.title}</strong></span>
              <span>{option.body}</span>
              <small>{option.id === "review" ? `${plannedBatches === undefined ? "" : `${plannedBatches} 组 · `}每组${deep ? "两位审查者各" : ""}最多 ${PR_REVIEW_BATCH_MAX_CALLS} 次调用，另加核验` : "大 PR 分块后汇总 · 存为问答记录，可继续追问"}</small>
            </label>)}
          </fieldset>
          {mode === "review" ? <label className="review-deep"><input type="checkbox" checked={deep} onChange={event => setDeep(event.target.checked)} />
            <span><strong>深度评审</strong>每组再派一位审查者，专门核对团队评审规则与历史决策，和缺陷审查同时进行；模型调用约多一倍。</span></label> : null}
        </div>
        <div className="review-compose-area">{runningElsewhere}{finishedElsewhere}{lastFocus && !focus.trim() ? <p className="review-history-note">上次对这个 PR 的关注点：{lastFocus.length > 60 ? `${lastFocus.slice(0, 60)}…` : lastFocus} <button type="button" className="review-note-link" disabled={busy !== null} onClick={() => { setFocus(lastFocus); document.getElementById("review-focus")?.focus(); }}>沿用</button></p> : null}<div className="review-composer">
          <textarea id="review-focus" aria-label="本次关注点（可选）" rows={3} value={focus} maxLength={2000} disabled={busy !== null} placeholder="补充关注点（可选），例如权限边界、异常处理…" onChange={event => setFocus(event.target.value)}
            onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); start(); } }} />
          <div className="review-composer-tools">{modelControl}<button className="primary-button" disabled={busy !== null || !currentModel} onClick={start}>{startLabel}</button></div>
        </div><p className="review-compose-hint">{currentModel?.leavesDevice ? "代码、决策摘录、命中的评审规则和 PR 上已有的评论将发送给所选模型服务，可能消耗额度。" : "使用本机模型。"} 关注点对三种方式都生效；正文保存遵循模型调用记录设置。<span>⌘ / Ctrl + Enter {startLabel}</span></p></div>
      </div> : null}
      {entry ? <div className="review-conversation" role="region" aria-label="评审过程">
        <div className="review-context"><div><p className="review-context-meta">{entry.snapshot.reference} <span>{markP1(runStatus(entry))}</span></p><h2>{entry.snapshot.title}</h2><p className="review-context-meta"><code>{entry.snapshot.sourceCommit.slice(0, 12)}</code> · <button className="review-files-link" aria-label="查看 PR 详情" onClick={() => setShowDetails(true)}><ActionIcon name="diff" /><span>{entry.snapshot.files.length} 个文件</span></button> · {fullTime.format(new Date(entry.at))}{entry.connectionId ? <> · <button type="button" className="review-files-link" onClick={() => setDiscussion({ connectionId: entry.connectionId!, pr: entry.snapshot })}>PR 讨论</button> · <button type="button" className="review-files-link" onClick={() => void api.openPr({ connectionId: entry.connectionId!, reference: entry.snapshot.reference }).catch(() => setError("无法在浏览器中打开这个 PR，请检查平台链接。"))}>在平台打开</button></> : null}</p></div>
          <div className="review-context-actions">
            {platformActions}
            {entry.connectionId ? <IconButton aria-label={entry.kind === "chat" ? "评审最新提交" : "重新评审最新提交"} disabled={busy !== null || !reviewable} onClick={() => reviewLatest(entry)}><ActionIcon name="refresh" /></IconButton> : null}
            <details className="review-more" ref={moreActions} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) closeActions(); }} onKeyDown={event => { if (event.key === "Escape") { closeActions(); event.currentTarget.querySelector("summary")?.focus(); } }}>
              <summary aria-label="评审操作"><ActionIcon name="more" /></summary>
              <div className="review-more-menu"><button onClick={() => { closeActions(); void exportReport(); }}><ActionIcon name="download" />{entry.kind === "chat" ? "导出记录" : "导出报告"}</button><button onClick={() => { closeActions(); const markdown = recordMarkdown(); if (markdown !== null) void copyMarkdown(markdown); }}><ActionIcon name="copy" />复制为 Markdown</button>{fixList ? <button onClick={() => { closeActions(); void copyMarkdown(fixList); }}><ActionIcon name="copy" />复制问题清单</button> : null}{entry.kind === "review" && entry.report && entry.connectionId ? <button disabled={busy !== null} onClick={() => { moreActions.current?.querySelector("summary")?.focus(); closeActions(); setSummaryDraft(reviewSummaryDraft(entry, carriedLines)); }}><ActionIcon name="send" />发布评审摘要到 PR</button> : null}<button className="danger-text" disabled={busy !== null} onClick={() => { moreActions.current?.querySelector("summary")?.focus(); closeActions(); setDeleteHistory(true); }}><ActionIcon name="trash" />{entry.kind === "chat" ? "删除记录" : "删除评审"}</button></div>
            </details>
          </div>
        </div>
        <div className="review-chat-viewport">
        <ol ref={chatLog} className="review-chat-messages" role="log" aria-label="执行记录" aria-live={hidden ? "off" : "polite"} tabIndex={0}
          onScroll={event => {
            const log = event.currentTarget;
            const distance = log.scrollHeight - log.scrollTop - log.clientHeight;
            if (distance <= 16) followLatest.current = true;
            else if (distance >= 64) followLatest.current = false;
            setShowLatest(!followLatest.current);
          }}>
          {entry.kind === "review" || entry.focus ? <li className="assistant-turn user" aria-label={entry.kind === "chat" ? "关注点" : "评审要求"}><div><p>{entry.kind === "chat" ? `关注点：${entry.focus}` : entry.focus || "检查变更新引入的问题，并核对历史决策。"}</p><small>{entry.model}</small></div></li> : null}
          {steps.length ? <li className="review-process"><details key={entry.id} open={entry.state === "running" ? true : undefined}><summary><span>{entry.state === "running" ? "正在评审" : "评审过程"}</span><span>{lastStep}</span></summary>
            <ReviewSteps items={steps} running={entry.state === "running"} onOpenCode={code => { setDiffFocus(code); setShowDetails(true); }}
              opens={code => code.view === "diff" || Boolean(activeSnapshot?.files.some(file => file.path === code.path))}
              onOpenNote={path => void api.openVaultDocument(path).catch(() => setError("无法打开来源笔记，可能已移动或删除。"))} />
          </details></li> : null}
    {report ? <li className="assistant-turn assistant review-chat-result" aria-label="评审结果">
      {/* The verdict and how serious, then the summary; the rest of the numbers are one quiet line (Claude Design: "报告开头", option B). */}
      <div className="review-actions review-result-head"><h2 tabIndex={-1}>{STATUS[report.status]}</h2>
        {standing.length ? <span className="review-result-counts">{priorityCounts(standing).map(([priority, count]) => <span key={priority} className="pr-diff-finding-priority" data-priority={priority}>{priority} ×{count}</span>)}</span> : null}
        {entry.published.length ? <span className="review-result-published"><ActionIcon name="check" />已发布 {entry.published.length} 条评论</span> : null}</div>
      {/* What each group found, under its files and reviewer: run into one text, the summary read as a wall of prose.
          A review saved before the conclusions were kept apart shows its summary as it was. */}
      {report.conclusions?.length ? <div className="review-result-summary">
        {report.overview ? <p className="review-result-overview">{report.overview}</p> : null}
        {report.conclusions.length === 1 && !report.conclusions[0]!.lens ? <div className="assistant-answer">{renderMarkdown(report.conclusions[0]!.text)}</div>
          : <ul className="review-conclusions" aria-label="各组结论">{report.conclusions.map((item, index) => <li key={index}>
            <div className="review-conclusion-head"><strong>{item.label}</strong>{item.lens ? <span className="review-step-lens">{LENS[item.lens]}</span> : null}</div>
            <div className="assistant-answer">{renderMarkdown(item.text)}</div>
          </li>)}</ul>}
      </div> : <div className="assistant-answer">{renderMarkdown(report.summary)}</div>}
      <p className="review-result-meta">{report.findings.length ? `${report.findings.length} 个问题${standing.length < report.findings.length ? `（${closedCounts}）` : ""}` : "没有发现问题"} · 完成评审 {report.reviewedFiles.length}/{report.reviewedFiles.length + report.unreviewedFiles.length} 个文件{coverageNote(reportSnapshot, report)}{report.groups ? ` · 分 ${report.groups} 组` : ""}{report.depth === "deep" ? " · 深度评审" : ""} · 已读取 {report.readFiles.length} 个文件的文本 diff · {report.steps} 次模型调用{usageLabel(report.usage)}{reportSnapshot?.rules?.length ? ` · 按 ${reportSnapshot.rules.length} 条评审规则` : ""}</p>
      {report.warnings.length ? <ul className="review-result-warnings" aria-label="评审限制">{report.warnings.map((warning) => <li key={warning}><ActionIcon name="warning" />{warning}</li>)}</ul> : null}
      {report.unreviewedFiles.length ? <details><summary>未完成评审的文件（{report.unreviewedFiles.length}）</summary><ul>{report.unreviewedFiles.map((file) => <li key={file}>{file}</li>)}</ul></details> : null}
      {report.findings.length > 3 && (new Set(report.findings.map(finding => finding.priority)).size > 1 || openCount < report.findings.length) ? <div className="review-finding-filter" role="group" aria-label="筛选问题">
        <button type="button" aria-pressed={priorityFilter === null} onClick={() => setPriorityFilter(null)}>全部 {report.findings.length}</button>
        {openCount < report.findings.length ? <button type="button" aria-pressed={priorityFilter === "open"} onClick={() => setPriorityFilter("open")}>待处理 {openCount}</button> : null}
        {new Set(report.findings.map(finding => finding.priority)).size > 1 ? (["P1", "P2", "P3"] as const).map(priority => { const count = report.findings.filter(finding => finding.priority === priority).length;
          return count ? <button key={priority} type="button" aria-pressed={priorityFilter === priority} onClick={() => setPriorityFilter(priority)}>{priority} {count}</button> : null; }) : null}
      </div> : null}
      {priorityFilter === "open" && openCount === 0 ? <p>这份评审的问题都处理过了：已发布为 PR 评论或已撤销。</p> : null}
      {unjudged > 1 || postable.length > 1 || reevaluatingAll?.entryId === entry.id ? <p className="review-batch-publish">
        {reevaluatingAll?.entryId === entry.id ? <span role="status">正在复评 {reevaluatingAll.done + 1} / {reevaluatingAll.total}…</span>
          : unjudged > 1 ? <button type="button" className="secondary-button" disabled={busy !== null || !currentModel} onClick={event => { event.currentTarget.closest(".review-conversation")?.querySelector<HTMLElement>(".review-actions h2")?.focus({ preventScroll: true }); void reevaluateAll(); }}>全部复评（{unjudged}）</button> : null}
        {postable.length > 1 ? <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => setBatch(postable)}>批量发布为 PR 评论（{postable.length}）</button> : null}
      </p> : null}
      {previous && carried.length ? <details className="review-previous">
        <summary>{oneSource ? "上次评审" : "之前评审"}的 {carried.length} 个问题 · {carried.filter(item => item.place === "changed" && !item.again).length} 个所在文件有改动</summary>
        <p>{oneSource ? <>上次评审（{dayTime.format(new Date(previous.at))} · 提交 <code>{previous.snapshot.sourceCommit.slice(0, 8)}</code>）的问题</> : <>之前几次评审的问题（最近一次没评完的文件沿用更早的结论；发布过评论的问题一直跟到复核为已不存在）</>}，放到这次的提交上看：所在文件没改动的应当还在，有改动的可以逐条复核。</p>
        <ul>{carried.map(item => <li key={`${item.run.id}-${item.index}`}>
          <header className="review-finding-head"><span className="pr-diff-finding-priority" data-priority={item.finding.priority}>{item.finding.priority}</span><strong>{item.finding.title}</strong></header>
          <p><code>{item.finding.path}:{item.finding.line}</code>{fromCommit(item.run, 8)} · <span className="review-previous-state" data-state={item.check?.verdict ?? (item.again ? "again" : item.place)}>{carriedState(item)}</span>{item.published ? " · 已发布为 PR 评论" : ""}</p>
          {item.check ? <p className="review-previous-reason">{item.check.verdict === "replace" && item.check.replacement ? `${item.check.replacement.title}：${item.check.replacement.body}` : item.check.reason}</p> : null}
        </li>)}</ul>
        {rechecking?.entryId === entry.id ? <p role="status">正在复核 {rechecking.done + 1} / {rechecking.total}…</p>
          : recheckable.length ? <button type="button" className="secondary-button" disabled={busy !== null || !currentModel} onClick={event => { event.currentTarget.closest("details")?.querySelector("summary")?.focus(); void recheckAll(recheckable); }}>复核有改动的 {recheckable.length} 个</button> : null}
      </details> : null}
      {report.findings.length === 0 ? <p>本次已覆盖范围内没有形成有效问题；不代表 PR 已获批准。</p> : report.findings.map((finding, index) => (priorityFilter === "open" ? handled(index) : priorityFilter !== null && finding.priority !== priorityFilter) ? null : <article className="review-finding" key={index} data-finding={index} data-verdict={verdictFor(index)?.verdict}>
        {/* The priority is part of the heading, so reading by headings still hears it. */}
        <h3 className="review-finding-head" tabIndex={-1}><span className="pr-diff-finding-priority" data-priority={finding.priority}>{finding.priority}</span> {finding.title}{raisedAgain.has(index) ? <>{" "}<span className="review-finding-again">之前也报过</span></> : null}{declinedFor(finding) && !verdictFor(index)?.by ? <>{" "}<span className="review-finding-again">以前不采纳过</span></> : null}</h3>
        <button type="button" className="review-files-link review-finding-location" title="在 PR 详情的 diff 里定位到这一行" onClick={() => { setDiffFocus({ path: finding.path, side: finding.side, line: finding.line }); setShowDetails(true); }}><code>{finding.path}:{finding.line}（{finding.side === "new" ? "新版本" : "旧版本"}）</code></button>
        <p className="review-text">{finding.body}</p>
        {declinedFor(finding) && !verdictFor(index)?.by ? <p className="review-history-note">你在 {declinedFor(finding)!.reference} 不采纳过同一问题：{declinedFor(finding)!.reason}</p> : null}
        {finding.decisionIndexes.length ? <p>决策依据：{finding.decisionIndexes.map((number) => <a key={number} href={`#review-evidence-${number}`} onClick={event => {
          const evidence = document.getElementById(`review-evidence-${number}`);
          if (evidence instanceof HTMLDetailsElement) {
            event.preventDefault();
            evidence.open = true;
            const group = evidence.parentElement?.closest("details");
            if (group) group.open = true;
            evidence.scrollIntoView?.({ block: "nearest" });
          }
        }}>[{number}] </a>)}</p> : null}
        {verdictFor(index) ? <VerdictNote verdict={verdictFor(index)!} onWithdraw={() => { withdraw(entry.id, index); refocus(`[data-finding="${index}"] h3`, ".review-actions h2"); }} /> : null}
        <div className="review-finding-actions">
          {/* One the reviewer turned down stays theirs until they take it back. */}
          {verdictFor(index)?.by ? null : <button type="button" className="text-button" aria-label={`复评「${finding.title}」`} disabled={busy !== null || !currentModel} onClick={() => void reevaluate(index)}>{reevaluating?.entryId === entry.id && reevaluating.index === index ? "复评中…" : verdictFor(index) ? "重新复评" : "复评"}</button>}
          {/* Asking about this one: the follow-up box names it, so the answer is about this finding rather than the report. */}
          <button type="button" className="text-button" aria-label={`追问「${finding.title}」`} disabled={busy !== null} onClick={() => askAbout(entry.id, finding)}>追问</button>
          {/* A replacing re-evaluation is copied as its replacement, as it is drafted for a comment. */}
          <button type="button" className="text-button" aria-label={`复制「${finding.title}」`} onClick={() => void copyMarkdown(findingMarkdown(entry.snapshot, { ...finding, ...(verdictFor(index)?.replacement ?? {}) }, report.evidence))}>复制</button>
          {/* A finding that names a team practice goes into the journal, where later reviews can find it. */}
          <button type="button" className="text-button" aria-label={`把「${finding.title}」记为决策`} onClick={() => setRecordDraft(findingDraft({ ...finding, ...(verdictFor(index)?.replacement ?? {}) }, entry.snapshot))}>记为决策</button>
          {/* The reviewer's own no, which a model's drop is not: closed like a drop, and later reviews of the repository are
              told not to raise its like. A model's drop reason is a start for theirs. */}
          {verdictFor(index)?.by || entry.published.some(item => item.finding === index) || postedBefore(index) ? null
            : <button type="button" className="text-button" aria-label={`不采纳「${finding.title}」`} onClick={() => {
              const reason = verdictFor(index)?.verdict === "drop" ? verdictFor(index)!.reason.slice(0, 500) : declinedFor(finding)?.reason ?? "";
              setDismissing({ index, reason, opened: reason });
            }}>不采纳</button>}
          {/* A dropped finding is closed, as code-meeseeks closes it; re-evaluate again to reopen it. */}
          {/* What was posted stays posted; a later drop only stops new posts. */}
          {!entry.connectionId ? null : entry.published.some(item => item.finding === index)
            ? <span>已发布为 PR 评论</span>
            : postedBefore(index) ? <span>同一提交的另一次评审已发布</span>
            : verdictFor(index)?.verdict === "drop" ? null
              : <button type="button" className="text-button" aria-label={`把「${finding.title}」转为 PR 评论`} disabled={busy !== null} onClick={() => setCommentFinding(index)}>转为评论</button>}
        </div>
      </article>)}
      {/* What the verification left out, with its score and why: quieter than the findings, there to disagree with. */}
      {report.filtered?.length ? <details className="review-filtered"><summary>核验未通过的候选问题 · {report.filtered.length}</summary>
        <p className="review-history-note">逐条核验时置信度低于 80（按 Claude Code 的做法），没有列入上面的问题。</p>
        <ul>{report.filtered.map(({ finding, score, reason }, index) => <li key={index}><span className="pr-diff-finding-priority" data-priority={finding.priority}>{finding.priority}</span> <strong>{finding.title}</strong> <code>{finding.path}:{finding.line}</code><small>置信度 {score} · {reason}</small></li>)}</ul>
      </details> : null}
      {/* No evidence is worth saying at once: it does not mean nothing in the history applies. */}
      {!report.evidence.length ? <p className="review-evidence">决策证据：未取得相关决策证据；不能据此断言没有历史约束。</p> : <details className="review-evidence"><summary>决策证据 · {report.evidence.length}</summary>
      {report.evidence.map(({ index, record }) => <details id={`review-evidence-${index}`} key={index}>
        <summary>[{index}] {record.source}/{record.id} · {record.title}</summary>
        <p>{record.kind === "adopted_principle" ? "已采纳原则" : "历史选择"} · {record.lifecycleState === "uncertain" ? "有效状态待核对" : record.current ? "未识别到替代" : "已替代或退役"} · {applicabilityLabel(record)}</p>
        <p className="review-text">{record.summary}</p>
        <p>来源：{record.sourceRef.relativePath} · 版本 {record.sourceRef.contentHash?.slice(0, 12) ?? "未确认"}</p>
        {record.applicability ? <><p>{record.applicability.reasons.join("；")}</p><p>例外：{record.applicability.scope.exceptions.join("；") || "未记录"}</p></> : null}<p>适用条件：{record.appliesWhen ?? "未记录"}</p><p>注意：{record.caution ?? "无"}</p>
        {record.warnings.map((warning) => <p key={warning}>{warning}</p>)}
        <button className="secondary-button" onClick={() => void api.openVaultDocument(record.sourceRef.relativePath).catch(() => setError("无法打开来源笔记，可能已移动或删除。"))}>打开来源笔记</button>
      </details>)}
      </details>}
      <p className="review-history-note">结果由 AI 评审生成，只是草稿：未执行测试，未批准或合并 PR，未修改决策记录；评论只在你确认后逐条发布。</p>
    </li> : null}
        {entry.turns.map((turn, index) => <Fragment key={turn.id}>
          {/* Two columns say who speaks to the eye; a screen reader is told by name, as the answer beside it is. */}
          <li className="assistant-turn user" aria-label="追问"><div><p className="review-text">{turn.question}</p></div></li>
          <li className="assistant-turn assistant" aria-label="追问回答">
            <div className="review-message-meta"><strong>{turn.model}</strong><time dateTime={turn.at}>{clock.format(new Date(turn.at))}</time>{usageText(turn.usage) ? <span>{usageText(turn.usage)}</span> : null}
              {/* A PR overview is usually pasted into the PR description, as pr-agent's /describe does. */}
              {turn.state === "done" ? <button type="button" className="text-button" aria-label="复制这条回答" onClick={() => void copyMarkdown(turn.answer)}>复制</button> : null}
              {/* Posting is the reader's act, after a confirm with the text in hand; once is enough. */}
              {turn.state !== "done" || !entry.connectionId ? null : turn.publishedAt
                ? <span>已发布到 PR</span>
                : <button type="button" className="text-button" aria-label="把这条回答发布到 PR" disabled={busy !== null} onClick={() => setCommentTurn(turn.id)}>发布到 PR</button>}</div>
            {turn.state === "done" ? <div className="assistant-answer">{renderMarkdown(turn.answer)}</div> : <p role={turn.state === "failed" ? "alert" : "status"}>{({ pending: "正在回答…", failed: turn.error ? `回答失败：${turn.error}` : "回答失败，请重试。", cancelled: "已停止回答。", interrupted: "上次回答已中断。" })[turn.state]}</p>}
            {index === entry.turns.length - 1 && ["failed", "cancelled", "interrupted"].includes(turn.state) ? <button className="secondary-button" disabled={busy !== null || !currentModel} onClick={() => void ask(turn.id)}>重试回答</button> : null}
          </li>
        </Fragment>)}
        </ol>
        </div>
        {entry.state === "running" && !events.length ? <p className="review-notice" role="status">正在准备评审…</p> : null}
        {movedSince ? <p className="review-notice" role="status">这份{entry.kind === "chat" ? "记录" : "评审"}之后，PR 又有新提交或新评论。<button type="button" className="review-note-link" disabled={busy !== null || !reviewable} onClick={() => reviewLatest(entry)}>评审最新提交</button></p> : null}
        {entry.state === "interrupted" ? <p className="review-notice" role="status">上次评审已中断。已保存执行记录；重新评审将读取最新快照。</p> : null}
        {entry.error ? <p className="review-notice" role="alert">{entry.error}</p> : null}
        <form className="review-follow-up review-compose-area" onSubmit={event => { event.preventDefault(); void ask(); }}>
          {runningElsewhere}{finishedElsewhere}<div className="review-composer">
            <textarea id="review-question" aria-label="继续追问" rows={2} maxLength={2000} value={entry.draft} readOnly={busy !== null} disabled={!discussable} placeholder={!discussable ? "评审完成后，继续讨论" : entry.kind === "chat" ? "继续问这个 PR…（/describe 生成 PR 概览，/improve 生成代码建议）" : "追问原因，讨论修复，或补充背景…（/describe 生成 PR 概览，/improve 生成代码建议）"} onChange={event => { typing.current = true; updateRun(entry.id, item => ({ ...item, draft: event.target.value })); }}
              onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void ask(); } }} />
            <div className="review-composer-tools">{modelControl}<div className="review-quick-commands" role="group" aria-label="评审指令">
              <button type="button" className="review-note-link" title="/describe：类型、摘要、逐文件说明与关注点" disabled={busy !== null || !discussable || !currentModel} onClick={() => void ask(undefined, "/describe")}>PR 概览</button>
              <button type="button" className="review-note-link" title="/improve：附 diff 代码块的具体改进建议" disabled={busy !== null || !discussable || !currentModel} onClick={() => void ask(undefined, "/improve")}>改进建议</button>
              {entry.kind === "chat" && entry.connectionId ? <button type="button" className="review-note-link" title="读取最新提交，回到准备页做完整评审" disabled={busy !== null || !reviewable} onClick={() => reviewLatest(entry)}>完整评审</button> : null}
            </div><div className="review-send-actions">
              <IconButton hidden={!showLatest} className="review-jump-latest" aria-label="滚动到底部" onClick={() => { followLatest.current = true; setShowLatest(false); if (chatLog.current) chatLog.current.scrollTop = chatLog.current.scrollHeight; }}><ActionIcon name="down" /></IconButton>
              {busy === "review" && entry.id === reviewing.current ? <IconButton aria-label="停止评审" onClick={() => { const stopping = runId.current; if (stopping) void api.cancelPrReview(stopping).then(() => { if (runId.current === stopping) setMessage("正在停止…"); }).catch(() => setError("取消失败，请重试。")); }}><ActionIcon name="stop" /></IconButton> : busy === "reevaluate" ? <IconButton aria-label="停止复评" onClick={() => { stopReevaluation.current = true; stoppedRequest.current = runId.current; if (runId.current) void api.cancelPrReview(runId.current).catch(() => setError("停止失败，请重试。")); }}><ActionIcon name="stop" /></IconButton> : busy === "follow-up" ? <IconButton aria-label="停止回答" onClick={() => {
                if (!runId.current) return;
                followUpCancelled.current = true;
                void api.cancelPrReview(runId.current).catch(() => { followUpCancelled.current = false; setError("停止失败，请重试。"); });
              }}><ActionIcon name="stop" /></IconButton> : <IconButton type="submit" className="review-send" aria-label="发送" disabled={busy !== null || !discussable || !currentModel || !entry.draft.trim()}><ActionIcon name="send" /></IconButton>}
            </div></div>
          </div>
          <p className="review-compose-hint">{currentModel?.leavesDevice ? "代码、评审与对话将发送给所选模型服务。" : "围绕本次提交与评审继续讨论。"}<span>Enter 发送 · Shift+Enter 换行</span></p>
        </form>
      </div> : null}
    </div>
    </div>
    {commentTurn !== null && entry?.connectionId && entry.turns.some(turn => turn.id === commentTurn) ? <PrReviewCommentDialog api={api} snapshot={entry.snapshot} connectionId={entry.connectionId}
      draft={entry.turns.find(turn => turn.id === commentTurn)!.answer}
      onClose={() => setCommentTurn(null)}
      onPublished={message => {
        const turnId = commentTurn;
        updateRun(entry.id, item => ({ ...item, turns: item.turns.map(turn => turn.id === turnId ? { ...turn, publishedAt: new Date().toISOString() } : turn) }));
        setCommentTurn(null); setMessage(message);
        refocus("#review-question");
      }} /> : null}
    {commentFinding !== null && entry?.connectionId && entry.report?.findings[commentFinding] ? <PrReviewCommentDialog api={api} snapshot={entry.snapshot} connectionId={entry.connectionId} platform={connections.find(item => item.id === entry.connectionId)?.platform}
      // A replacing re-evaluation drafts the comment from its replacement text.
      finding={{ ...entry.report.findings[commentFinding]!, ...(verdictFor(commentFinding)?.replacement ?? {}) }}
      onClose={() => setCommentFinding(null)}
      onPublished={message => { markPosted(entry.id, commentFinding); setCommentFinding(null); setMessage(message); refocus(`[data-finding="${commentFinding}"] h3`, ".review-actions h2"); }} /> : null}
    {discussion && recordDraft === null && !hidden ? <PrDiscussionDialog api={api} connectionId={discussion.connectionId} pr={discussion.pr}
      onRecord={comment => setRecordDraft(commentDraft(comment, discussion.pr, connections.find(item => item.id === discussion.connectionId)?.label ?? "代码平台"))}
      onOpenDecision={onOpenDecision ? id => { setDiscussion(null); onOpenDecision(id); } : undefined}
      onClose={() => setDiscussion(null)} /> : null}
    {/* Out of sight while the page is, not unmounted: a captured decision taking the window threw away the edits. */}
    {recordDraft ? <PageHidden.Provider value={hidden}><ActiveRecordDialog api={api} draft={recordDraft} onClose={() => setRecordDraft(null)}
      onSaved={result => { setRecordDraft(null); setMessage(`已记为${RECORD_KIND[result.recordKind]}${recordDraft.source ? "，并保留了评论链接" : ""}。`); }} /></PageHidden.Provider> : null}
    {summaryDraft !== null && entry?.connectionId ? <PrReviewCommentDialog api={api} snapshot={entry.snapshot} connectionId={entry.connectionId} draft={summaryDraft}
      onClose={() => setSummaryDraft(null)} onPublished={message => { setSummaryDraft(null); setMessage(message); }} /> : null}
    {batch && entry?.connectionId ? <PrReviewBatchCommentDialog api={api} snapshot={entry.snapshot} connectionId={entry.connectionId} findings={batch}
      onPosted={index => markPosted(entry.id, index)}
      onClose={message => { setBatch(null); if (message) setMessage(message); refocus(".review-actions h2"); }} /> : null}
    {choosingScope && snapshot ? <PrReviewScopeDialog snapshot={snapshot} chosen={chosenPaths} unitChars={unitChars} onClose={() => setChoosingScope(false)}
      onConfirm={paths => { setReviewScope(paths ? { reference: snapshot.reference, paths } : null); setChoosingScope(false); }} /> : null}
    {showDetails && activeSnapshot ? <PrDiffDialog api={api} snapshot={activeSnapshot} reviewModel={entry?.model} connectionId={entry?.connectionId ?? loadTarget?.connectionId} focus={diffFocus ?? undefined}
      // The findings as they stand after re-evaluation: replaced ones reworded, dropped ones left out.
      findings={entry?.report?.findings.flatMap((finding, index) => verdictFor(index)?.verdict === "drop" ? [] : [{ ...finding, ...(verdictFor(index)?.replacement ?? {}) }])} onClose={() => { setShowDetails(false); setDiffFocus(null); }} /> : null}
    {showDismissals && snapshot ? <ModalDialog title="不采纳过的问题" size="wide" onClose={() => setShowDismissals(false)}
      description={`评审 ${snapshot.reference.replace(/#\d+$/u, "")} 时会告诉模型的内容，最新的在前：远端模型和 CLI 带最近 20 条，本机模型带最近 5 条。撤回后，以后的评审不再带上它。`}>
      {dismissedHere.length ? <ul className="review-dismissals" aria-label="不采纳过的问题">{dismissedHere.map((item, index) => <li key={`${item.path}\n${item.title}`}>
        {/* The button goes with its row: focus stays in the dialog, on the row taking its place, else the last, else closing. */}
        <header><strong>{item.title}</strong><button type="button" className="text-button" aria-label={`撤回「${item.title}」（${item.path}）的不采纳`} onClick={() => {
          withdrawEverywhere(item);
          refocus(`.review-dismissals li:nth-child(${index + 1}) button`, ".review-dismissals li:last-child button", ".modal-dialog-close");
        }}>撤回</button></header>
        <p>{item.reason}</p>
        <small><code>{item.path}</code> · {item.reference} · <time dateTime={item.at}>{dayTime.format(new Date(item.at))}</time>{item.sources.length > 1 ? ` · 不采纳过 ${item.sources.length} 次` : ""}</small>
      </li>)}</ul> : <p>都已撤回，以后评审这个仓库时不再告诉模型。</p>}
    </ModalDialog> : null}
    {dismissing && entry?.report?.findings[dismissing.index] ? <ModalDialog title="不采纳这条问题" size="compact" dismissible={dismissing.reason === dismissing.opened} onClose={() => setDismissing(null)}>
      <form className="pr-action-form" aria-label="不采纳这条问题" onSubmit={event => {
        event.preventDefault();
        dismiss(entry.id, dismissing.index, dismissing.reason);
        setDismissing(null);
        refocus(`[data-finding="${dismissing.index}"] h3`, ".review-actions h2");
      }}>
        <p>「{entry.report.findings[dismissing.index]!.title}」会像撤销的问题一样收起。以后评审 {entry.snapshot.reference.replace(/#\d+$/u, "")} 时，会把它和原因告诉模型，不再提同类问题。</p>
        <div className="pr-comment-field"><div className="pr-comment-field-head"><span>原因（可选）</span></div>
          <textarea aria-label="不采纳的原因" rows={3} maxLength={500} value={dismissing.reason} placeholder="例如：有意为之，超时由上层统一处理" onChange={event => setDismissing({ ...dismissing, reason: event.target.value })} /></div>
        <div className="modal-form-actions"><button type="button" className="secondary-button" onClick={() => setDismissing(null)}>取消</button><button type="submit" className="primary-button">不采纳</button></div>
      </form>
    </ModalDialog> : null}
    {deleteHistory && entry ? <ModalDialog title={entry.kind === "chat" ? "删除问答记录" : "删除评审记录"} size="compact" onClose={() => setDeleteHistory(false)}>
      <p>{entry.kind === "chat" ? `删除「${entry.snapshot.title}」的这条问答记录？` : `删除「${entry.snapshot.title}」本次评审的本地过程和报告？`}不会修改代码平台上的 PR。{entry.verdicts.some(item => item.by) ? `这次评审里你不采纳的 ${entry.verdicts.filter(item => item.by).length} 条问题，以后评审这个仓库时也不再告诉模型。` : ""}</p>
      <div className="modal-form-actions"><button className="secondary-button" onClick={() => setDeleteHistory(false)}>取消</button><button className="primary-button" onClick={() => {
        const remaining = history.filter(item => item.id !== selectedRun);
        setHistory(remaining); selectRun(remaining.find(item => item.connectionId === entry.connectionId && item.snapshot.reference === entry.snapshot.reference)?.id ?? ""); setDeleteHistory(false);
      }}>确认删除</button></div>
    </ModalDialog> : null}
  </section>;
}
