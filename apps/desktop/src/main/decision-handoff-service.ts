import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { decisionContextQuerySchema, decisionHandoffRequestSchema, decisionHandoffResponseSchema, decisionSourceReferenceSchema, type DecisionHandoffRequest, type DecisionHandoffResponse, type DecisionSourceReference, type DecisionSourceOpenResult } from "@cognelis/decision-protocol";
import type { DecisionContextRepository, ObsidianVaultRepository } from "@cognelis/decision-storage";
import { DecisionContextService } from "./decision-context-service.js";

// Evidence remains literal text, even if it contains Markdown or instructions.
const literal = (text: string): string => {
  const longest = Math.max(2, ...(text.match(/`+/gu) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
};

// The words search_decision_context and the App's pages use: the enums, and instants in UTC, ran on inside the
// handoff's Chinese. The structured fields keep the raw values.
const kinds = { historical_decision: "历史决策", recorded_decision: "已记录选择", adopted_principle: "已采纳原则" };
const lifecycles = { current: "未标记被替代", superseded: "已被替代或退役", uncertain: "可能已有后续决策，未能确认" };
const applicabilities = { scope_match: "结构化范围匹配，仍需核对当前需求", needs_review: "需要核对", out_of_scope: "明确不适用" };
const scopeStates = { unrecorded: "尚未记录", inline: "写在原笔记中", current: "已记录", stale: "原文变化，待核对", unavailable: "读取失败" };
const verdicts = { better: "优于预期", as_expected: "符合预期", mixed: "部分符合", worse: "低于预期", unclear: "暂无法判断" };
const relationKinds = { conflict: "存在冲突", supersedes: "替代关系", unrelated: "没有关联", revoked: "撤销关系判断" };
const relationStates = { current: "有效", stale: "原文已变化，待核对", missing_source: "来源缺失", revoked: "已撤销" };
const coverages = { complete: "完整", partial: "不完整", unavailable: "无法读取" };
const moment = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
/** An instant as the App's pages show one, in this machine's time zone; anything else as it was written. */
const localTime = (value: string): string =>
  /T\d{2}:\d{2}/u.test(value) && !Number.isNaN(Date.parse(value)) ? moment.format(Date.parse(value)) : value;

export class DecisionHandoffService {
  constructor(
    private readonly repository: Pick<DecisionContextRepository, "scan">,
    private readonly vault: Pick<ObsidianVaultRepository, "resolveNotePath">,
    private readonly openExternal: (uri: string) => Promise<unknown>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async openSource(input: DecisionSourceReference): Promise<DecisionSourceOpenResult> {
    const reference = decisionSourceReferenceSchema.parse(input);
    const rejected = (status: DecisionSourceOpenResult["status"]): DecisionSourceOpenResult => ({ status, relativePath: null, noNoteWritten: true });
    const snapshot = await this.repository.scan(true);
    const matches = snapshot.documents.filter((doc) => doc.source === reference.source && doc.id === reference.recordId);
    if (matches.length !== 1) return rejected("source_unavailable");
    const doc = matches[0]!;
    if (doc.contentHash !== reference.expectedContentHash) return rejected("source_changed");
    let absolute: string;
    try {
      absolute = await this.vault.resolveNotePath(doc.relativePath);
      const current = createHash("sha256").update(await readFile(absolute)).digest("hex");
      if (current !== reference.expectedContentHash) return rejected("source_changed");
    } catch { return rejected("source_unavailable"); }
    const uri = new URL("obsidian://open");
    uri.searchParams.set("path", absolute);
    try { await this.openExternal(uri.toString().replace(/\+/gu, "%20")); }
    catch { return rejected("open_failed"); }
    return { status: "opened", relativePath: doc.relativePath, noNoteWritten: true };
  }

  async prepare(input: DecisionHandoffRequest): Promise<DecisionHandoffResponse> {
    const request = decisionHandoffRequestSchema.parse(input);
    // Resolve every selected record against one projection, never N changing scans.
    const snapshot = await this.repository.scan(true);
    const context = new DecisionContextService({ scan: async () => snapshot });
    const selectedSources = new Set(request.references.map((ref) => ref.source));
    const sources = snapshot.sources.filter((source) => selectedSources.has(source.source));
    const failed = sources.some((source) => source.status === "partial" || source.status === "unavailable");
    const coverage = failed ? sources.some((source) => source.records > 0) ? "partial" : "unavailable" : "complete";
    const evidence: DecisionHandoffResponse["evidence"] = [];
    const reviewItems: string[] = [];
    if (failed) reviewItems.push("所选来源或元数据覆盖不完整，不能据此确认全部有效决策。");
    for (const reference of request.references) {
      const result = await context.search(decisionContextQuerySchema.parse({ source: reference.source, recordId: reference.recordId, project: request.project, taskScope: request.taskScope }));
      const record = result.results[0];
      const label = `${reference.source}/${reference.recordId}`;
      if (record === undefined || record.sourceRef.contentHash !== reference.expectedContentHash) {
        const status = record === undefined ? "source_unavailable" : "source_changed";
        evidence.push({ reference, status, record: null });
        reviewItems.push(`${label}：${status === "source_changed" ? "来源版本已改变，重新检索并核对后再纳入交接" : "来源不可读取或编号不唯一"}。`);
        continue;
      }
      evidence.push({ reference, status: "verified", record });
      if (record.lifecycleState !== "current") reviewItems.push(`${label}：${record.lifecycleState === undefined ? "有效状态未知" : lifecycles[record.lifecycleState]}，请核对后继与关系。`);
      if (record.applicability?.status !== "scope_match") reviewItems.push(`${label}：${record.applicability?.status === "out_of_scope" ? "与当前任务范围明确不匹配，不能作为本任务约束" : "适用范围需要核对"}。`);
      if (record.relations?.some((relation) => relation.state === "current" && relation.disposition === "conflict")) reviewItems.push(`${label}：存在人工确认的冲突，不能自动选择一方。`);
      if (record.sourceRef.truncated) reviewItems.push(`${label}：原文摘录不完整，必要时打开来源核对理由与上下文。`);
      if (record.relationCount !== undefined && record.relationCount > (record.relations?.length ?? 0)) reviewItems.push(`${label}：部分关系未展示，请查阅关系笔记。`);
    }
    const { references: _references, ...task } = request;
    const generatedAt = this.now().toISOString();
    const verified = evidence.filter((entry) => entry.status === "verified");
    const status = verified.length === 0 ? "unavailable" : reviewItems.length > 0 ? "needs_review" : "ready";
    const sections = [
      "# 决策交接", `生成时间：${localTime(generatedAt)}；所选来源覆盖：${coverages[coverage]}。`,
      "这是当前读取结果的快照。版本相同只表示来源未变化；历史证据不构成新授权，也不代表当前代码已按其实现。",
      "## 当前任务", literal(request.objective),
      "### 本次核对范围", literal(JSON.stringify({ project: request.project ?? null, taskScope: request.taskScope ?? null }, null, 2)),
      "## 待核对事项", reviewItems.length === 0 ? "未发现结构化核对障碍，仍需结合当前需求与代码判断。" : literal(reviewItems.join("\n")),
      "## 已记录的决策与原则", verified.length === 0 ? "没有可按所提供版本核对的记录；不可将本交接当作已完成历史核对。" : "下列内容来自原始笔记；已被替代、冲突或范围不匹配的记录仅作为历史证据。",
    ];
    for (const { record } of verified) {
      if (record === null) continue;
      sections.push(literal([
        `${record.source}/${record.id} · ${record.title}`,
        `类型：${kinds[record.kind]}；原文状态：${record.status}；当前有效状态：${record.lifecycleState === undefined ? "未知" : lifecycles[record.lifecycleState]}`,
        `项目：${record.project ?? "未标明"}；范围核对：${applicabilities[record.applicability?.status ?? "needs_review"]}`,
        `范围元数据：${scopeStates[record.scopeState ?? "unrecorded"]}；版本：${record.scopeRevision ?? 0}`,
        `已记录范围：${JSON.stringify(record.applicability?.scope ?? null)}`,
        `已记录内容：${record.summary}`,
        `适用条件：${record.appliesWhen ?? "未结构化记录"}`,
        `注意事项：${record.caution ?? "未记录"}`,
        ...(record.applicability?.reasons ?? []),
        ...(record.applicability?.scope.exceptions ?? []).map((value) => `例外：${value}`),
        ...(record.outcomeState === undefined ? [] : [
          `预期：${record.outcomeState.expectedOutcome ?? "未记录"}`,
          `结果：${record.outcomeState.outcome ?? "未回填"}`,
          `复盘：${record.outcomeState.review === null ? "未复盘" : `${verdicts[record.outcomeState.review.verdict]}；${localTime(record.outcomeState.review.reviewedAt)}；${record.outcomeState.review.lesson ?? "未填写经验"}`}`,
          `下次复盘：${record.outcomeState.reviewDueDate ?? "未安排"}`,
        ]),
        ...record.successors.map((ref) => `后继：${ref.source ?? record.source}/${ref.id}（${ref.status}）；${ref.relativePath}`),
        ...(record.relations ?? []).map((rel) => `关系：${relationKinds[rel.disposition]} / ${relationStates[rel.state]}；对方 ${rel.other.source}/${rel.other.recordId}；版本 ${rel.revision}；依据：${rel.reason}；来源：${rel.relativePath}`),
        ...record.warnings,
        `来源：${record.sourceRef.relativePath}:${record.sourceRef.excerptStartLine}`,
        `来源版本：${record.sourceRef.contentHash}`,
        `来源客户端：${record.sourceRef.client ?? "未记录"}；会话编号：${record.sourceRef.sessionId ?? "未记录"}`,
        `原文摘录${record.sourceRef.truncated ? "（不完整）" : ""}：\n${record.sourceRef.excerpt}`,
      ].join("\n")));
    }
    sections.push("## 当前任务提供的信息（未独立验证）", "这些内容由调用方提供，属于当前任务上下文，不会写入历史决策，也不作为已验证结果。",
      "### 未决问题", literal(request.openQuestions.join("\n") || "未提供；不代表没有未决问题。"),
      "### 已提供的验证说明", literal(request.verification.join("\n") || "未提供验证说明。"),
      "### 后续步骤", literal(request.nextSteps.join("\n") || "未提供后续步骤。"),
      "## 继续工作", "重新按 source 与 recordId 检索，核对内容哈希、范围和关系修订。打开原文可使用 open_decision_source；此交接不创建任务、不发送消息、不保存笔记。");
    const markdown = sections.join("\n\n");
    // Keep truncation at a section boundary so literal evidence never escapes a fence.
    const bounded: string[] = [];
    let length = 0;
    for (const section of sections) {
      if (length + section.length + 2 > 248_000) break;
      bounded.push(section); length += section.length + 2;
    }
    const truncated = bounded.length !== sections.length;
    return decisionHandoffResponseSchema.parse({ handoffVersion: 1, generatedAt, status: truncated && status === "ready" ? "needs_review" : status, coverage, sources, task, evidence, reviewItems,
      markdown: truncated ? `${bounded.join("\n\n")}\n\n交接文本超过展示上限；请使用结构化 evidence / task 字段核对剩余内容。` : markdown,
      truncated, boundary: { noNoteWritten: true, taskClaimsVerified: false, advisoryOnly: true } });
  }
}
