import { useEffect, useState } from "react";
import { REVIEW_BASIS_ROW_LABELS, REVIEW_ESCAPE_CHANGES, REVIEW_ESCAPE_LAYERS, type ReviewPromotion, type ReviewEscape, type ReviewEscapeWriteup, type ReviewNoisyRule, type ReviewQualityResult, type ReviewTeamWindow } from "@cognelis/decision-protocol";
import type { DecisionApi } from "../../../../shared/renderer-api.js";
import { ReviewPromotions } from "./ReviewPromotions.js";

type Api = Pick<DecisionApi, "updateReviewRule" | "updateReviewEscape" | "actOnReviewPromotion" | "openSurface" | "openReviewRulesDirectory" | "openVaultDocument">;

const figure = (value: number | null, unit = "") => (value === null ? "—" : `${value}${unit}`);
// The design's four tiles, each beside the 30 days before.
const TILES: ReadonlyArray<readonly [string, (window: ReviewTeamWindow) => string]> = [
  ["每个 PR 的人工批准", (window) => figure(window.approvalsPerPr)],
  ["每个 PR 的人工评论", (window) => figure(window.humanCommentsPerPr, " 条")],
  ["等人批准（中位）", (window) => figure(window.waitHours, " 小时")],
  ["回滚 · 漏网", (window) => `${window.rollbacks} · ${window.escapes}`],
];
const COLUMNS = [["published", "已发布"], ["fixed", "修了"], ["wrong", "说错了"], ["intended", "有意为之"], ["wontfix", "无所谓"], ["later", "转后续"], ["none", "未回应"]] as const;
const ruleName = (rule: ReviewNoisyRule) => rule.kind === "decision" ? `决策「${rule.title}」` : `${rule.source === "decision" ? "本机" : "code-meeseeks"}规则「${rule.title}」`;

/**
 * 评审质量 (design board 4): the team's figures from the code platform, what became of the findings posted by what they
 * stood on, and the rules authors keep calling wrong, to rewrite or turn off. Read by the page; this lays it out.
 */
/** "src/export.ts:42" or "src/export.ts:42-48": where a problem sat. */
const locationOf = (text: string) => {
  const match = /^(.+?):(\d+)(?:-(\d+))?$/u.exec(text.trim());
  return match ? { path: match[1]!, startLine: Number(match[2]), ...(match[3] ? { endLine: Number(match[3]) } : {}) } : null;
};

/** One 漏网: its four lines to write, or as written, and from where the problem sat a defect benchmark candidate. */
function EscapeCard({ api, escape, onChanged }: { api: Api; escape: ReviewEscape; onChanged(escape: ReviewEscape): void }) {
  const [editing, setEditing] = useState(escape.writeup === null);
  const [draft, setDraft] = useState<ReviewEscapeWriteup>(escape.writeup ?? { problem: "", layer: "pre_review", why: "", change: "rule", changeText: "" });
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState("");
  const [where, setWhere] = useState("");
  const [priority, setPriority] = useState<"P1" | "P2" | "P3">("P2");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  const id = `escape-${escape.id}`;
  // Written or settled elsewhere (an agent, through the bridge), read again: the card shows it as it now stands.
  const signature = JSON.stringify([escape.state, escape.writeup, escape.benchmarkCase]);
  useEffect(() => {
    setEditing(escape.writeup === null);
    setDraft(escape.writeup ?? { problem: "", layer: "pre_review", why: "", change: "rule", changeText: "" });
  }, [signature]);
  const act = async (input: Parameters<Api["updateReviewEscape"]>[0], done: string) => {
    setBusy(true); setSaid("");
    try {
      const answer = await api.updateReviewEscape(input);
      if (answer.status !== "updated" || !answer.escape) { setSaid(answer.reason ?? "没有改动。"); return; }
      setSaid(done); setEditing(false); setDismissing(false);
      onChanged(answer.escape);
    } catch { setSaid("没有改动，请重试。"); }
    finally { setBusy(false); }
  };
  const location = locationOf(where);
  return <article className="review-quality-rule review-quality-escape" aria-labelledby={`${id}-title`}>
    <p id={`${id}-title`}><strong>{escape.reference}「{escape.title}」</strong>合并后被 {escape.by.reference}{escape.by.title ? `「${escape.by.title}」` : ""}{escape.by.kind === "revert" ? "回滚" : "修复"}。</p>
    {editing ? <form className="review-quality-escape-form" onSubmit={(event) => { event.preventDefault(); void act({ id: escape.id, action: "write", writeup: draft }, "复盘已保存。"); }}>
      <label>问题是什么<input value={draft.problem} maxLength={300} required onChange={(event) => setDraft({ ...draft, problem: event.target.value })} placeholder="例如：导出时间按服务器时区格式化" /></label>
      <label>本该哪一层拦住<select value={draft.layer} onChange={(event) => setDraft({ ...draft, layer: event.target.value as ReviewEscapeWriteup["layer"] })}>
        {Object.entries(REVIEW_ESCAPE_LAYERS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>为什么没拦住<input value={draft.why} maxLength={600} required onChange={(event) => setDraft({ ...draft, why: event.target.value })} /></label>
      <div className="review-quality-escape-change">
        <label>改在哪里<select value={draft.change} onChange={(event) => setDraft({ ...draft, change: event.target.value as ReviewEscapeWriteup["change"] })}>
          {Object.entries(REVIEW_ESCAPE_CHANGES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label>怎么改<input value={draft.changeText} maxLength={600} onChange={(event) => setDraft({ ...draft, changeText: event.target.value })} placeholder="例如：REVIEW.md 加一条时区规则" /></label>
      </div>
      <div className="review-quality-actions">
        <button type="submit" className="primary-button" disabled={busy}>保存复盘</button>
        {escape.writeup ? <button type="button" className="secondary-button" disabled={busy} onClick={() => setEditing(false)}>取消</button>
          : <button type="button" className="secondary-button" disabled={busy} onClick={() => setDismissing(true)}>不是漏网</button>}
      </div>
    </form> : escape.writeup ? <dl className="review-coverage">
      <dt>问题</dt><dd>{escape.writeup.problem}</dd>
      <dt>本该拦住的一层</dt><dd>{REVIEW_ESCAPE_LAYERS[escape.writeup.layer]}</dd>
      <dt>为什么没拦住</dt><dd>{escape.writeup.why}</dd>
      <dt>改在哪里</dt><dd>{REVIEW_ESCAPE_CHANGES[escape.writeup.change]}{escape.writeup.changeText ? `：${escape.writeup.changeText}` : ""}</dd>
    </dl> : null}
    {dismissing ? <form className="review-quality-escape-form" onSubmit={(event) => { event.preventDefault(); void act({ id: escape.id, action: "dismiss", reason }, "已记为不是漏网。"); }}>
      <label>为什么不是漏网<input value={reason} maxLength={600} required autoFocus onChange={(event) => setReason(event.target.value)} placeholder="例如：需求变了，不是缺陷" /></label>
      <div className="review-quality-actions"><button type="submit" className="secondary-button" disabled={busy}>记为不是漏网</button><button type="button" className="secondary-button" disabled={busy} onClick={() => setDismissing(false)}>取消</button></div>
    </form> : null}
    {!editing && escape.writeup ? escape.benchmarkCase ? <p className="review-history-note">已加入评测集的候选样本 {escape.benchmarkCase}，核对后在评测集里确认入集。 <button type="button" className="review-note-link" onClick={() => setEditing(true)}>修改复盘</button></p>
      : <form className="review-quality-escape-form review-quality-escape-case" onSubmit={(event) => { event.preventDefault(); if (location) void act({ id: escape.id, action: "add_to_benchmark", location, priority }, "已加入评测集的候选样本。"); }}>
        <label>问题在哪（PR 合入时的文件和行）<input value={where} onChange={(event) => setWhere(event.target.value)} placeholder="例如：src/export.ts:42-48" aria-invalid={where !== "" && !location} /></label>
        <label>优先级<select value={priority} onChange={(event) => setPriority(event.target.value as "P1" | "P2" | "P3")}><option>P1</option><option>P2</option><option>P3</option></select></label>
        <div className="review-quality-actions">
          <button type="submit" className="secondary-button" disabled={busy || !location}>加入评测集</button>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => setEditing(true)}>修改复盘</button>
        </div>
      </form> : null}
    {said ? <p className="review-history-note" role="status">{said}</p> : null}
  </article>;
}

export function ReviewQualityView({ api, result, loading, error, onReload, onEscapeChanged, onPromotionChanged }: { api: Api; result: ReviewQualityResult | null; loading: boolean; error: string; onReload(): void;
  onEscapeChanged(escape: ReviewEscape): void; onPromotionChanged(key: string, promotion: ReviewPromotion | null): void }) {
  // Turned off here, the rule says so and offers to turn it on again.
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const quality = result?.quality;
  if (!quality) {
    return <div className="review-detail review-quality" aria-label="评审质量" aria-busy={loading}>
      <div className="review-empty">{loading ? <p role="status">正在读取评审质量…第一次会从代码平台读已合并的 PR，要一会儿。</p>
        : error ? <><p role="alert">{error}</p><button type="button" className="secondary-button" onClick={onReload}>重试</button></>
          : <p>选择代码平台链接，查看它的评审质量。</p>}</div>
    </div>;
  }
  const { team, outcomes, noise } = quality;
  const escapes = quality.escapes.filter((item) => item.state !== "dismissed");
  const open = escapes.filter((item) => item.state === "open").length;
  const turn = async (rule: ReviewNoisyRule, enabled: boolean) => {
    setBusy(rule.id); setSaid("");
    try {
      const answer = await api.updateReviewRule({ rule: rule.id, enabled });
      if (answer.status !== "updated") { setSaid(answer.reason ?? "没有改动规则。"); return; }
      setOff((current) => { const next = new Set(current); if (enabled) next.delete(rule.id); else next.add(rule.id); return next; });
      setSaid(enabled ? `已重新启用「${rule.title}」。` : `已停用「${rule.title}」：之后的评审不再用它，文件还在。`);
    } catch { setSaid("没有改动规则，请重试。"); }
    finally { setBusy(null); }
  };
  return <div className="review-detail review-quality" aria-label="评审质量" aria-busy={loading}>
    <div className="review-context"><div><p className="review-context-meta">近 {quality.days} 天 · {quality.label}</p><h2>评审质量</h2></div>
      <button type="button" className="secondary-button" disabled={loading} onClick={onReload}>{loading ? "正在读取…" : "重新读取"}</button></div>
    <div className="review-quality-body">
      {error ? <p className="review-notice" role="alert">{error}</p> : null}
      <section aria-labelledby="quality-team">
        <h3 id="quality-team">团队指标</h3>
        <dl className="review-quality-tiles">{TILES.map(([term, value]) => <div key={term}>
          <dt>{term}</dt><dd className="review-quality-value">{value(team.current)}</dd><dd className="review-quality-before">之前 30 天 {value(team.previous)}</dd>
        </div>)}</dl>
        <p className="review-history-note">护栏：只用代码平台和本机记录，不收集同学的使用数据。算的是近 {quality.days} 天合并、你评审或创建的 {team.current.prs} 个 PR（之前 30 天 {team.previous.prs} 个）。
          {team.unread ? ` 还有 ${team.unread} 个 PR 没读到，重新读取时接着读。` : ""}{team.error ? ` 读平台时出错：${team.error}` : ""}</p>
      </section>
      <section aria-labelledby="quality-outcomes">
        <h3 id="quality-outcomes">已发布意见的结果 · {outcomes.total} 条</h3>
        <div className="review-quality-table-wrap"><table className="review-quality-table">
          <thead><tr><th scope="col">依据</th>{COLUMNS.map(([key, label]) => <th key={key} scope="col">{label}</th>)}</tr></thead>
          <tbody>{outcomes.rows.map((row) => <tr key={row.basis}><th scope="row">{REVIEW_BASIS_ROW_LABELS[row.basis]}</th>{COLUMNS.map(([key]) => <td key={key}>{row[key]}</td>)}</tr>)}</tbody>
        </table></div>
        <p className="review-history-note">{outcomes.maybeFixed ? `原位置之后被改过、作者没回复的“可能修了”另有 ${outcomes.maybeFixed} 条，不计入上表。` : ""}结果来自作者的标准回复；近 {quality.days} 天发布的才算。</p>
      </section>
      {escapes.length ? <section aria-labelledby="quality-escapes">
        <h3 id="quality-escapes">漏网复盘 · {open ? `${open} 条待写` : `${escapes.length} 条`}</h3>
        <p className="review-history-note">合并后被回滚、或被后来的 PR 指名修复的 PR。写下四行：问题、本该哪一层拦住、为什么没拦住、改在哪里；给出问题在哪，它就成为评测集缺陷集的候选样本。</p>
        {escapes.map((escape) => <EscapeCard key={escape.id} api={api} escape={escape} onChanged={onEscapeChanged} />)}
      </section> : null}
      <section aria-labelledby="quality-noise">
        <h3 id="quality-noise">常被说错的规则</h3>
        {noise.length ? noise.map((rule) => <article className="review-quality-rule" key={`${rule.kind}|${rule.source}|${rule.id}`}>
          <p><strong>{ruleName(rule)}</strong>被说错 {rule.wrong} 次{rule.wontfix ? `、说无所谓 ${rule.wontfix} 次` : ""}（作者答复过 {rule.settled} 条，涉及 {rule.prs} 个 PR）{rule.words.length ? "：" : "。"}</p>
          {rule.words.map((words) => <blockquote key={words}>{words}</blockquote>)}
          <div className="review-quality-actions">
            {rule.kind === "decision" ? rule.notePath ? <button type="button" className="secondary-button" onClick={() => void api.openVaultDocument(rule.notePath!).catch(() => setSaid("无法打开决策笔记，可能已移动或删除。"))}>打开决策笔记</button> : null
              : rule.source === "decision" ? <>
                <button type="button" className="secondary-button" onClick={() => void api.openReviewRulesDirectory().catch(() => setSaid("无法打开评审规则目录。"))}>改写规则</button>
                {off.has(rule.id) ? <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void turn(rule, true)}>重新启用</button>
                  : <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void turn(rule, false)}>停用</button>}
              </> : <span className="review-history-note">code-meeseeks 的规则，到它的规则目录里改。</span>}
          </div>
        </article>) : <p className="review-history-note">还没有规则被作者两次以上说错或说无所谓。</p>}
        {said ? <p className="review-history-note" role="status">{said}</p> : null}
      </section>
      <ReviewPromotions api={api} connectionId={quality.connectionId} promotions={quality.promotions} onChanged={onPromotionChanged} />
    </div>
  </div>;
}
