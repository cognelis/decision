import { useEffect, useState } from "react";
import { REVIEW_BENCHMARK_VERDICTS, type ReviewBenchmarkPageRequest, type ReviewBenchmarkPageResult, type ReviewBenchmarkRunResult, type ReviewBenchmarkRunSummary } from "@cognelis/decision-protocol";
import type { DecisionApi } from "../../../../shared/renderer-api.js";

type Api = Pick<DecisionApi, "reviewBenchmarkPage">;
type Overview = NonNullable<ReviewBenchmarkPageResult["overview"]>;
const SPLIT = { holdout: "留出集", dev: "开发集" } as const;
const STATE = { running: "进行中", finished: "已跑完", failed: "失败", cancelled: "已取消", interrupted: "已中断" } as const;
const CHANGE = { same: "持平", up: "上升", down: "下降", unknown: "—" } as const;
const SOURCE = { fixed: "作者确认“修了”", wrong: "作者回复“说错了”", sampling: "自动抽样" } as const;
const SET = { defect: "缺陷集", clean: "干净集" } as const;
const when = (at: string) => new Date(at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

const defectLine = (run: ReviewBenchmarkRunSummary) => `${SPLIT[run.split]}命中 ${run.totals.defect.hit}/${run.totals.defect.issues} · 核验误杀 ${run.totals.defect.lost}${run.totals.defect.fixReported === null ? "" : ` · 修复后再报 ${run.totals.defect.fixReported}`}`;
const cleanLine = (run: ReviewBenchmarkRunSummary) => {
  const { clean } = run.totals;
  return `有害意见 ${clean.harmful} 条 / ${clean.cases} 个 PR · 每个 PR ${clean.cases ? Math.round((clean.findings / clean.cases) * 10) / 10 : "—"} 条意见 · 已知误报再犯 ${clean.knownRepeats}${clean.unjudged ? ` · ${clean.unjudged} 条待判` : ""}`;
};

/**
 * 评测集 (design board 4's variant): the two sets, the change compared before and after on the holdout, runs started
 * and followed, clean findings judged, and the candidates waiting for someone who knows the code to confirm them.
 */
export function ReviewBenchmarkView({ api, overview, loading, connectionId, onChanged }: { api: Api; overview: Overview | null; loading: boolean; connectionId: string; onChanged(): void }) {
  const [path, setPath] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReviewBenchmarkRunResult | null>(null);
  const [starting, setStarting] = useState(false);
  const [form, setForm] = useState({ label: "", split: "holdout" as "holdout" | "dev", model: "", fixControl: false });
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  const repository = overview?.repositories.find((item) => item.path === path) ?? overview?.repositories[0];
  const latest = repository?.runs[0];
  const shown = selected ?? latest?.id ?? null;
  useEffect(() => { if (repository && repository.path !== path) setPath(repository.path); }, [repository, path]);

  // The run shown, read again every few seconds while one is under way.
  const running = overview?.active ?? null;
  useEffect(() => {
    if (!shown) { setDetail(null); return; }
    let gone = false;
    const read = () => void api.reviewBenchmarkPage({ kind: "get", id: shown }).then((result) => { if (!gone) setDetail(result.run); }, () => undefined);
    read();
    const timer = running ? window.setInterval(() => { read(); onChanged(); }, 5_000) : undefined;
    return () => { gone = true; if (timer) window.clearInterval(timer); };
  }, [api, shown, running]);

  const act = async (request: ReviewBenchmarkPageRequest, after?: (result: ReviewBenchmarkPageResult) => void) => {
    setBusy(true); setSaid("");
    try {
      const result = await api.reviewBenchmarkPage(request);
      setSaid(result.message ?? "");
      if (result.run) setDetail(result.run);
      if (result.ok) { after?.(result); onChanged(); }
    } catch { setSaid("没有完成，请重试。"); }
    finally { setBusy(false); }
  };

  if (!overview) return <div className="review-detail review-quality" aria-label="评测集" aria-busy={loading}><div className="review-empty"><p role="status">{loading ? "正在读取评测集…" : "没有读到评测集。"}</p></div></div>;
  const waiting = (repository?.candidates.length ?? 0) + overview.suggestions.length;
  const comparison = detail?.comparison;
  return <div className="review-detail review-quality" aria-label="评测集" aria-busy={loading}>
    <div className="review-context"><div><p className="review-context-meta">{repository ? repository.project : "还没有评测集"}</p><h2>评测集</h2></div>
      <div className="review-quality-actions">
        {overview.repositories.length > 1 ? <select aria-label="仓库" value={repository?.path ?? ""} onChange={(event) => { setPath(event.target.value); setSelected(null); }}>
          {overview.repositories.map((item) => <option key={item.path} value={item.path}>{item.project}</option>)}</select> : null}
        <button type="button" className="primary-button" disabled={!repository || busy || running !== null} onClick={() => setStarting(true)}>运行评测</button>
      </div></div>
    <div className="review-quality-body">
      {said ? <p className="review-notice" role="status">{said}</p> : null}
      {!repository ? <p className="review-history-note">本地审阅里的仓库还没有评测样本。agent 可以用 record_review_benchmark_cases 整理历史 PR，下面的候选也可以收进来。</p> : <>
        <p className="review-history-note">改提示、规则或模型前后都要跑：在留出集上召回不降、有害意见不增才采用。只存仓库、提交号、标注位置和一句话说明，不复制源码；留出集的答案不给调提示的人看。</p>
        {starting ? <form className="review-quality-rule review-quality-escape-form" aria-label="运行评测" onSubmit={(event) => { event.preventDefault();
          void act({ kind: "run", repositoryPath: repository.path, label: form.label, split: form.split, fixControl: form.fixControl, ...(form.model ? { model: form.model } : {}) }, (result) => { setStarting(false); setSelected(result.run?.run?.id ?? null); }); }}>
          <label>改了什么<input value={form.label} maxLength={300} required autoFocus onChange={(event) => setForm({ ...form, label: event.target.value })} placeholder="例如：本机规则「列表接口都要分页」只管超过 100 条的列表" /></label>
          <div className="review-quality-escape-change">
            <label>样本<select value={form.split} onChange={(event) => setForm({ ...form, split: event.target.value as "holdout" | "dev" })}><option value="holdout">留出集（决定采用）</option><option value="dev">开发集（调提示时看）</option></select></label>
            <label>模型<select value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })}>{overview.models.map((model, index) => <option key={model.id} value={index === 0 ? "" : model.id}>{model.label}</option>)}</select></label>
          </div>
          <label className="settings-check"><input type="checkbox" checked={form.fixControl} onChange={(event) => setForm({ ...form, fixControl: event.target.checked })} />也在修复后的版本上跑（修复后再报；缺陷集的调用次数翻倍）</label>
          <p className="review-history-note">每个样本都会用模型完整评审一遍，一个要几分钟；一次只跑一个评测。</p>
          <div className="review-quality-actions"><button type="submit" className="primary-button" disabled={busy || !form.label.trim()}>开始评测</button><button type="button" className="secondary-button" onClick={() => setStarting(false)}>取消</button></div>
        </form> : null}
        <section aria-labelledby="benchmark-sets">
          <h3 id="benchmark-sets">两个集合</h3>
          <dl className="review-quality-tiles">
            {(["defect", "clean"] as const).map((set) => { const counts = repository.counts[set]; return <div key={set}>
              <dt>{SET[set]} · {counts.dev + counts.holdout} 个</dt>
              <dd className="review-quality-before">开发 {counts.dev} · 留出 {counts.holdout}{counts.candidate ? ` · 候选 ${counts.candidate}` : ""}</dd>
              <dd>{set === "defect" ? "有问题的 PR 加修复" : "没问题的 PR"}{latest ? `：${set === "defect" ? defectLine(latest) : cleanLine(latest)}` : "：还没跑过"}</dd>
            </div>; })}
          </dl>
        </section>
        {detail?.run ? <section aria-labelledby="benchmark-compare">
          <h3 id="benchmark-compare">改动前后对比</h3>
          <p>改动：{detail.run.label}<span className="review-context-meta"> · {SPLIT[detail.run.split]} · {STATE[detail.run.state]}（{detail.run.totals.done}/{detail.run.totals.total}）· {detail.run.model}</span></p>
          {detail.run.state === "running" ? <div className="review-quality-actions"><span role="status">正在评测第 {Math.min(detail.run.totals.done + detail.run.totals.failed + 1, detail.run.totals.total)} 个样本…</span>
            <button type="button" className="secondary-button" disabled={busy} onClick={() => void act({ kind: "cancel", id: detail.run!.id })}>取消评测</button></div> : null}
          {comparison ? <>
            <div className="review-quality-table-wrap"><table className="review-quality-table">
              <thead><tr><th scope="col">指标（{SPLIT[detail.run.split]}）</th><th scope="col">改前</th><th scope="col">改后</th><th scope="col">变化</th></tr></thead>
              <tbody>{comparison.rows.map((row) => <tr key={row.metric}><th scope="row">{row.label}</th><td>{row.before ?? "—"}</td><td>{row.after ?? "—"}</td><td>{CHANGE[row.change]}</td></tr>)}</tbody>
            </table></div>
            <p className="review-quality-verdict" data-verdict={comparison.verdict}><strong>{comparison.said}</strong></p>
          </> : detail.run.state === "finished" ? <p className="review-history-note">还没有可以对比的上一次评测：改动前先跑一次基线。</p> : null}
          {detail.run.adopted ? <p className="review-history-note">已采用（{when(detail.run.adopted.at)}）{detail.run.adopted.note ? `：${detail.run.adopted.note}` : ""}</p>
            : comparison?.verdict === "adopt" ? <div className="review-quality-actions"><button type="button" className="primary-button" disabled={busy} onClick={() => void act({ kind: "adopt", id: detail.run!.id, note: "" })}>采用</button></div> : null}
          {detail.cases?.some((item) => item.set === "clean" && item.findings.some((finding) => finding.kept)) ? <details className="review-quality-judging">
            <summary>判定干净集的意见{detail.run.totals.clean.unjudged ? `（${detail.run.totals.clean.unjudged} 条待判）` : ""}</summary>
            <p className="review-history-note">照做会引入错误或无谓改动的是有害；无害但没价值的是噪声；其实是真问题的是有效（可以转进缺陷集）。</p>
            {detail.cases.filter((item) => item.set === "clean").map((item) => item.findings.map((finding, index) => finding.kept ? <fieldset key={`${item.caseId}-${index}`} className="review-quality-rule">
              <legend>{item.title} · {finding.path}:{finding.line} · {finding.title}</legend>
              <p>{finding.body}</p>
              <div className="review-quality-actions" role="radiogroup" aria-label={`${finding.title} 的判定`}>
                {(Object.keys(REVIEW_BENCHMARK_VERDICTS) as Array<keyof typeof REVIEW_BENCHMARK_VERDICTS>).map((verdict) => <label key={verdict}>
                  <input type="radio" name={`${item.caseId}-${index}`} checked={item.judgments.find((judgment) => judgment.finding === index)?.verdict === verdict} disabled={busy}
                    onChange={() => void act({ kind: "judge", id: detail.run!.id, caseId: item.caseId, finding: index, verdict })} />{REVIEW_BENCHMARK_VERDICTS[verdict]}</label>)}
              </div>
            </fieldset> : null))}
          </details> : null}
        </section> : null}
        {repository.runs.length ? <section aria-labelledby="benchmark-runs">
          <h3 id="benchmark-runs">评测记录</h3>
          <ul className="review-quality-runs">{repository.runs.map((run) => <li key={run.id}><button type="button" className="review-note-link" aria-pressed={shown === run.id} onClick={() => setSelected(run.id)}>{run.label}</button>
            <span className="review-context-meta"> · {SPLIT[run.split]} · {STATE[run.state]} · {when(run.startedAt)}{run.adopted ? " · 已采用" : ""}</span></li>)}</ul>
        </section> : null}
      </>}
      <section aria-labelledby="benchmark-candidates">
        <h3 id="benchmark-candidates">待确认的候选样本 · {waiting}</h3>
        {repository?.candidates.map((item) => <article key={item.caseId} className="review-quality-rule review-quality-candidate">
          <p><span className="review-context-meta">{SET[item.set]}</span> <strong>{item.from} {item.title}</strong></p>
          <div className="review-quality-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => void act({ kind: "confirm", repositoryPath: repository.path, caseId: item.caseId })}>确认入集</button></div>
        </article>)}
        {overview.suggestions.map((item) => <article key={item.key} className="review-quality-rule review-quality-candidate">
          <p><span className="review-context-meta">{SET[item.set]}</span> <strong>{item.reference} {item.title}</strong></p>
          <p className="review-history-note">{item.source === "sampling" ? `${SOURCE.sampling}：${item.said}` : item.said}{item.blocked ? `（${item.blocked}）` : ""}</p>
          <div className="review-quality-actions">
            <button type="button" className="secondary-button" disabled={busy || item.blocked !== null} onClick={() => void act({ kind: "accept", connectionId, key: item.key })}>收为候选</button>
            <button type="button" className="secondary-button" disabled={busy} onClick={() => void act({ kind: "dismiss", key: item.key })}>不收</button>
          </div>
        </article>)}
        <p className="review-history-note">{waiting ? "都要熟悉代码的人核对后才入集：收为候选只是记下，确认入集才算数。" : "没有待确认的样本。作者确认“修了”、回复“说错了”的意见和合并已久的 PR 会列在这里。"}</p>
      </section>
    </div>
  </div>;
}
