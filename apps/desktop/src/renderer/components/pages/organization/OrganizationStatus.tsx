import { useEffect, useState } from "react";
import { organizationSourceKindSchema, type OrganizationSettings, type OrganizationQuery, type OrganizationRunView, type OrganizationSnapshot, type RedactedModelProviderProfile } from "@cognelis/decision-protocol";

import type { OrganizationApi } from "./OrganizationPanel.js";
import { ActionIcon } from "../../IconButton.js";
import { ACTIVE_STATES, PARTIAL_REASON, runResultText, RUN_LABEL, formatTokens, shortDate, usageText, SOURCE_KIND_LABEL } from "./organization-text.js";

interface StatusProps {
  api: OrganizationApi;
  snapshot: OrganizationSnapshot | null;
  query: OrganizationQuery | null;
  scopeText: string;
  profiles: readonly RedactedModelProviderProfile[];
  profilesError: string | null;
  readOnly: boolean;
  reload(): Promise<unknown>;
  onBack(): void;
  onViewSuggestions(): void;
}

const errorText = (caught: unknown): string => (caught instanceof Error ? caught.message : String(caught));

const RunCard = ({ run, children, onControl, busy }: { run: OrganizationRunView; children?: React.ReactNode; onControl(action: "pause" | "resume" | "stop"): void; busy: boolean }) => {
  const percent = run.progress.total === 0 ? 0 : Math.min(100, Math.round((run.progress.checked / run.progress.total) * 100));
  const tone = run.state === "failed" || run.state === "interrupted" ? "error" : run.state === "partial" || run.state === "paused" ? "warn" : run.state === "no_change" || run.state === "done" ? "ok" : "accent";
  return (
    <section className={`org-run org-run-${tone}`} aria-label={`运行状态：${RUN_LABEL[run.state]}`}>
      <span className={`org-badge org-badge-${tone === "error" ? "error" : tone}`}>{run.state === "failed" ? `失败${run.failure === null ? "" : ` · ${run.failure.message}`}` : RUN_LABEL[run.state]}</span>
      {run.state === "waiting_idle" ? <p>App 空闲后才开始整理，现在不会打断你的操作。</p> : null}
      {run.state === "running" || run.state === "paused" ? (
        <>
          <p>{run.state === "paused" ? "已暂停，进度已保存。" : (run.stage ?? "正在整理。")}</p>
          <div className="org-progress"><progress max={Math.max(1, run.progress.total)} value={run.progress.checked} aria-label="已检查" /><span>已检查 {run.progress.checked}/{run.progress.total} 条（{percent}%）</span></div>
        </>
      ) : null}
      {run.state === "partial" ? (
        <>
          <p><strong>已检查 {run.progress.checked}/{run.progress.total} 条，生成 {run.created} 条更新，剩余下次继续。</strong>{run.partialReason === null ? "" : `${PARTIAL_REASON[run.partialReason]}；`}不是「已全部整理」。</p>
          <div className="org-progress"><progress max={Math.max(1, run.progress.total)} value={run.progress.checked} aria-label="已检查" /><span>{run.progress.checked}/{run.progress.total} 条</span></div>
        </>
      ) : null}
      {run.state === "no_change" ? <p>已检查 {run.progress.checked}/{run.progress.total} 条，没有新增更新。没有新材料时不会再调用模型；这不是失败。</p> : null}
      {run.state === "done" ? <p>已检查 {run.progress.checked}/{run.progress.total} 条，新增 {run.created} 条更新，更新 {run.updated} 条。</p> : null}
      {run.state === "stopped" ? <p>已停止。已生成的 {run.created} 条更新和进度都已保存，下次从这里继续。</p> : null}
      {run.state === "interrupted" ? <p>上次整理被打断（App 退出或睡眠）。已保存的进度下次继续，没有把它当作已完成。</p> : null}
      {run.state === "failed" ? <p>本轮在检查 {run.progress.checked}/{run.progress.total} 条后中断，已生成的 {run.created} 条更新和进度都已保存，已完成的自动更新仍然保留。{run.failure === null ? "" : `原因：${run.failure.message}（${run.failure.code}）`}</p> : null}
      {run.model === null ? null : <p className="org-muted">模型：{run.model} · {usageText(run.usage)}{run.usage.failedCalls > 0 ? ` · 失败 ${run.usage.failedCalls} 次也已计入` : ""}</p>}
      <div className="org-run-actions">
        {run.state === "running" ? <button type="button" className="secondary-button" disabled={busy} onClick={() => onControl("pause")}>暂停</button> : null}
        {run.state === "paused" ? <button type="button" className="primary-button" disabled={busy} onClick={() => onControl("resume")}>继续</button> : null}
        {ACTIVE_STATES.includes(run.state) ? <button type="button" className="secondary-button" disabled={busy} onClick={() => onControl("stop")}>{run.state === "waiting_idle" ? "取消" : "停止"}</button> : null}
        {children}
      </div>
    </section>
  );
};

export const OrganizationStatus = ({ api, snapshot, query, scopeText, profiles, profilesError, readOnly, reload }: StatusProps) => {
  const saved = snapshot?.settings;
  const [profile, setProfile] = useState(saved?.backgroundProfileId ?? "");
  const [sources, setSources] = useState([...(saved?.sources ?? organizationSourceKindSchema.options)]);
  const [calls, setCalls] = useState(saved?.maxCalls ?? 8);
  const [tokens, setTokens] = useState(saved?.inputTokens ?? 12000);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    setProfile(saved?.backgroundProfileId ?? ""); setSources([...(saved?.sources ?? organizationSourceKindSchema.options)]); setCalls(saved?.maxCalls ?? 8); setTokens(saved?.inputTokens ?? 12000);
  }, [saved?.backgroundProfileId, JSON.stringify(saved?.sources), saved?.maxCalls, saved?.inputTokens]);
  const work = async (action: () => Promise<void>) => { if (busy) return; setBusy(true); setMessage(null); try { await action(); await reload(); } catch (error) { setMessage(errorText(error)); } finally { setBusy(false); } };
  const save = (background: boolean) => work(async () => {
    const settings: OrganizationSettings = !background && saved !== undefined ? { ...saved, background: false } : { automatic: true, background, backgroundProfileId: profile || null, sources, maxCalls: calls, inputTokens: tokens };
    await api.setOrganizationSettings(settings); setMessage(background ? "自动维护已开启。App 运行且空闲时自动继续。" : "已暂停后台维护，已有记录与进度保留。");
  });
  const run = snapshot?.activeRun ?? snapshot?.run;
  return <div className="org-status-grid">
    <div className="org-status-col"><section className="org-card"><h3>{saved?.automatic ? "自动维护" : "首次设置"}</h3><p>常规分诊、关联和机器记忆自动生效。未知安静保留，真正的业务取舍才交给你。</p>
      <fieldset disabled={busy || readOnly}><legend>已采集内容中的来源</legend><div className="org-source-options">{organizationSourceKindSchema.options.map((kind) => <label key={kind}><input type="checkbox" checked={sources.includes(kind)} onChange={(event) => setSources(event.currentTarget.checked ? [...sources, kind] : sources.filter((entry) => entry !== kind))} />{SOURCE_KIND_LABEL[kind]}</label>)}</div></fieldset>
      <p className="org-muted">仅使用已接入 Paraself 的内容；关闭某类来源后，不再将它交给维护模型，相关派生记忆暂停使用。</p>
      <label className="org-field">维护模型<select aria-label="维护模型" value={profile} disabled={busy} onChange={(event) => setProfile(event.currentTarget.value)}><option value="">选择模型</option>{profile && !profiles.some((entry) => entry.profileId === profile) ? <option value={profile}>已配置模型暂不可用</option> : null}{profiles.map((entry) => <option key={entry.profileId} value={entry.profileId}>{entry.label} · {entry.model ?? entry.kind}</option>)}</select></label>
      <p className="org-muted">所选来源会交给此模型；云端模型沿用现有网络设置。只使用选定模型。</p>
      {profilesError === null ? null : <p role="alert">{profilesError}</p>}
      <div className="org-budget"><label>每轮最多调用<input aria-label="每轮最多调用" type="number" min={1} max={8} value={calls} onChange={(event) => setCalls(Number(event.currentTarget.value))} /></label><label>输入预算（估算 tokens）<input aria-label="输入预算" type="number" min={3000} max={24000} step={1000} value={tokens} onChange={(event) => setTokens(Number(event.currentTarget.value))} /></label></div>
      <p className="org-muted">每轮最多 2 分钟、输出 3000 tokens；未处理完的保留到下轮。失败重试同样计入预算。</p>
      <div className="org-run-actions"><button type="button" className="primary-button" disabled={busy || readOnly || !profile || sources.length === 0 || calls < 1 || calls > 8 || tokens < 3000 || tokens > 24000} onClick={() => void save(true)}>{saved?.automatic ? "保存并开启自动维护" : "确认设置并开启"}</button>{saved?.background ? <button type="button" className="secondary-button" disabled={busy || readOnly} onClick={() => void save(false)}>暂停自动维护</button> : null}</div>
    </section><section className="org-card"><h3>运行条件</h3><p>App 运行且电脑空闲时增量处理。你开始操作时让行；退出 App 或电脑睡眠后暂停，下次运行继续。</p><p>不自动改变任务状态、期限或优先级，不代你发消息，也不把机器推断提升为用户原则。</p></section></div>
    <div className="org-status-col"><section className="org-card"><h3>运行状态</h3>{run === null || run === undefined ? <p>{saved?.background ? "等待空闲和新增内容。" : "完成设置后开始自动维护。"}</p> : <RunCard run={run} busy={busy} onControl={(action) => void work(async () => { await api.controlOrganizationRun({ runId: run.runId, action }); })} />}
      <p className="org-muted">临时失败会在之后重试，已完成的进度保留；没有新证据时不会反复调用模型。</p>
      <details><summary>手动检查一次</summary><p>使用已保存的来源与预算，检查「{scopeText}」。</p><button type="button" className="secondary-button" disabled={busy || readOnly || !saved?.automatic || !saved.backgroundProfileId || query === null || snapshot?.activeRun != null} onClick={() => void work(async () => { if (query === null || !saved?.backgroundProfileId) return; const { source: _source, ...target } = query; const result = await api.runOrganization({ ...target, profileId: saved.backgroundProfileId }); setMessage(runResultText(result.status)); })}>整理一次</button></details>
    </section><section className="org-card"><h3>最近 7 天用量</h3><p>{snapshot === null ? "正在读取…" : `${snapshot.usage7d.runs} 轮 · ${snapshot.usage7d.calls} 次调用`}</p>{snapshot === null ? null : <p className="org-muted">{usageText(snapshot.usage7d)}</p>}</section>{message === null ? null : <p className="org-banner" role="status">{message}</p>}</div>
  </div>;
};
